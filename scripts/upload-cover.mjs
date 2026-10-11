#!/usr/bin/env node
/**
 * Put a local image on a Suno clip as its cover, losslessly.
 *
 * Three calls, per COVER-ART-PIPELINE.md:
 *   1. POST /api/uploads/image/   {extension}      -> {id, url, fields}
 *   2. POST <s3 url>              multipart, file LAST, no Suno auth -> 204
 *   3. POST /api/gen/{clip}/set_metadata/ {image_s3_id: id}
 *
 * Steps 1 and 3 go through the local fork's /api/raw passthrough so no
 * credential is handled here. Step 2 goes straight to AWS.
 *
 * Sending extension "png" with the original bytes is the whole point: the web
 * UI renders the image to a canvas and exports JPEG, which cost 83% of the file
 * on the one track done by hand.
 *
 * Usage:
 *   node scripts/upload-cover.mjs --clip <id> --image <path> [--dry-run]
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { rawCall } from './tombeau-lib.mjs';

const MAX_BYTES = 0xa00000; // 10,485,760 — the client's own MAX_IMAGE_SIZE_BYTES
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp' };

/** Sniff the real format; Suno content-checks, so a renamed file will not pass. */
function sniff(buf) {
  if (buf.slice(1, 4).toString('latin1') === 'PNG') return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  if (buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf.slice(0, 2).toString('latin1') === 'BM') return 'bmp';
  return null;
}

export async function uploadCover({ clip, image, dryRun = false, log = console.log }) {
  const buf = readFileSync(image);
  const ext = path.extname(image).toLowerCase();
  const declared = MIME[ext];
  if (!declared) throw new Error(`Unsupported extension ${ext}`);
  const actual = sniff(buf);
  if (!actual) throw new Error('Could not identify image format from its bytes');
  if (declared !== `image/${actual}`) throw new Error(`contentMismatch: named ${ext} but bytes are ${actual}`);
  if (buf.length > MAX_BYTES) throw new Error(`fileTooLarge: ${buf.length} > ${MAX_BYTES}`);

  const extension = actual === 'jpeg' ? 'jpeg' : actual;
  log(`  ${path.basename(image)}  ${buf.length} bytes  ${declared}`);
  if (dryRun) { log('  [dry run] stopping before any write'); return { dryRun: true }; }

  // --- 1. initiate -------------------------------------------------------
  const init = await rawCall('/api/uploads/image/', 'POST', { extension });
  if (init.suno_status !== 200) throw new Error(`initiateFailed: ${init.suno_status} ${JSON.stringify(init.data).slice(0, 300)}`);
  const { id, url, fields } = init.data;
  if (!id || !url || !fields) throw new Error(`initiateFailed: unexpected body ${JSON.stringify(init.data).slice(0, 300)}`);
  log(`  upload id: ${id}`);

  // --- 2. push the bytes to S3 ------------------------------------------
  // Field order is load-bearing: S3 ignores every part after `file`, so the
  // policy/signature entries must all precede it.
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('file', new Blob([buf], { type: declared }), path.basename(image));

  const s3 = await fetch(url, { method: 'POST', body: form });
  if (s3.status !== 204) {
    throw new Error(`uploadFailed: S3 returned ${s3.status} ${(await s3.text()).slice(0, 400)}`);
  }
  log(`  S3 204  etag=${s3.headers.get('etag')}`);

  // --- 3. attach ---------------------------------------------------------
  const set = await rawCall(`/api/gen/${clip}/set_metadata/`, 'POST', { image_s3_id: id });
  if (set.suno_status !== 200) throw new Error(`set_metadata failed: ${set.suno_status} ${JSON.stringify(set.data).slice(0, 400)}`);
  log(`  set_metadata 200  image_url=${set.data.image_url}`);

  return { uploadId: id, response: set.data, bytes: buf.length };
}

async function main() {
  const a = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      a[k] = (!argv[i + 1] || argv[i + 1].startsWith('--')) ? true : argv[++i];
    }
  }
  if (!a.clip || !a.image) { console.error('Need --clip <id> --image <path>'); process.exit(1); }
  const r = await uploadCover({ clip: a.clip, image: a.image, dryRun: !!a['dry-run'] });
  console.log(JSON.stringify(r, null, 2));
}

import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
