#!/usr/bin/env node
/**
 * Bring outside audio (or MIDI) into Suno as a real clip.
 *
 * Suno's own upload pipeline is how the web UI drags an mp3/wav/midi onto a
 * Studio track as a reference. It is NOT the AI-generation path — it just
 * registers a file you already have as a clip on the account, after which it
 * behaves like any other clip: it has a clip_id, can be set_metadata'd, can be
 * dragged into Studio, and (unconfirmed, worth testing) may be usable as a
 * cover_clip_id / audio-conditioning source for a generate call.
 *
 * Four calls, in order (documented in CAPABILITIES.md, "seen in captures" —
 * MIDI specifically was *not* captured, only inferred from the UI's accepted
 * file types, so treat this as exploratory and read the printed response at
 * each step rather than assuming it worked):
 *
 *   1. POST /api/uploads/audio/                       -> presigned S3 upload
 *   2. (upload the raw file bytes to S3 directly)
 *   3. POST /api/uploads/audio/{id}/upload-finish/     -> confirms the S3 part
 *      (then poll GET /api/uploads/audio/{id}/ until the upload check completes)
 *   4. POST /api/uploads/audio/{id}/initialize-clip/   -> {clip_id}
 *   5. POST /api/gen/{clip_id}/set_metadata/           -> names it
 *
 * Usage:
 *   node scripts/upload-external-audio.mjs --file <path> --title "Andante (Stradal)"
 *   node scripts/upload-external-audio.mjs --file <path> --title "..." --extension mid
 *
 * Options:
 *   --extension EXT  overrides the file's own extension (mid/mp3/wav)
 *   --api URL        suno-api base; default http://localhost:3060
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { waitForUploadCheck } from './upload-check.mjs';

const args = parseArgs(process.argv.slice(2));
const API = args.api ?? 'http://localhost:3060';

if (!args.file) { console.error('Need --file <path>. See header.'); process.exit(1); }
if (!args.title) { console.error('Need --title "<name>".'); process.exit(1); }

const filePath = args.file;
const ext = String(args.extension ?? path.extname(filePath).replace(/^\./, '')).toLowerCase();
const fileName = path.basename(filePath);

console.log(`Uploading "${fileName}" as .${ext} ...`);

// 1. Ask Suno for a place to put it.
const uploadReq = await rawPost('/api/uploads/audio/', {
  extension: ext,
  upload_type: 'file_upload'
});
console.log('  upload slot:', JSON.stringify(uploadReq).slice(0, 300));

const { url, fields, id } = uploadReq ?? {};
if (!url || !id) throw new Error(`Unexpected response from /api/uploads/audio/: ${JSON.stringify(uploadReq)}`);

// 2. Push the actual bytes to S3 — this goes straight to AWS, not through
//    /api/raw, which is pinned to Suno's own API host.
const fileBuf = readFileSync(filePath);
if (fields && Object.keys(fields).length) {
  // Presigned POST: form fields first, file field last (S3 requirement).
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  form.append('file', new Blob([fileBuf]), fileName);
  const res = await fetch(url, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`S3 upload (POST) failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  console.log(`  S3 POST -> ${res.status}`);
} else {
  // Presigned PUT: the whole body is the file.
  const res = await fetch(url, { method: 'PUT', body: fileBuf });
  if (!res.ok) throw new Error(`S3 upload (PUT) failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  console.log(`  S3 PUT -> ${res.status}`);
}

// 3. Tell Suno the upload is done.
await rawPost(`/api/uploads/audio/${id}/upload-finish/`, {
  upload_type: 'file_upload',
  upload_filename: fileName,
  agreed_to_vip_upload_terms: false
});
console.log('  upload-finish: ok');

// Suno checks the upload (catalog match) after upload-finish. Wait for it, so a
// refusal shows its reason instead of an empty 400 from initialize-clip.
const check = await waitForUploadCheck(() => getUpload(`/api/uploads/audio/${id}/`));
if (check.outcome === 'error') {
  console.error(`Suno refused the upload: ${check.data?.error_message ?? '(no message)'} [${check.data?.error_type ?? 'unknown type'}]`);
  process.exit(1);
}
if (check.outcome === 'missing') { console.error('Suno no longer has this upload'); process.exit(1); }
console.log(check.outcome === 'complete' ? '  upload check: complete' : '  upload check: timed out after 2 min, trying anyway');

// 4. Turn it into a real clip.
const clipResult = await rawPost(`/api/uploads/audio/${id}/initialize-clip/`, {});
const clipId = clipResult?.clip_id;
if (!clipId) throw new Error(`initialize-clip didn't return a clip_id: ${JSON.stringify(clipResult)}`);
console.log(`  clip created: ${clipId}`);

// 5. Name it.
await rawPost(`/api/gen/${clipId}/set_metadata/`, { title: args.title });

console.log(`\nDone. clip_id: ${clipId}  (title: "${args.title}")`);
console.log('This clip now behaves like any other Suno clip — check /api/get?ids= to confirm status.');

// ---------------------------------------------------------------- helpers

async function getUpload(sunoPath) {
  const res = await fetch(`${API}/api/raw?path=${encodeURIComponent(sunoPath)}`);
  const json = await parseRawResponse(res, sunoPath);
  return { status: json?.suno_status, data: json?.data };
}

async function rawGet(sunoPath) {
  const res = await fetch(`${API}/api/raw?path=${encodeURIComponent(sunoPath)}`);
  const json = await parseRawResponse(res, sunoPath);
  if (json?.suno_status !== 200) {
    throw new Error(`${sunoPath} -> suno ${json?.suno_status}: ${JSON.stringify(json?.data ?? null).slice(0, 200)}`);
  }
  return json.data;
}

async function rawPost(sunoPath, body) {
  const res = await fetch(`${API}/api/raw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: sunoPath, method: 'POST', body })
  });
  const json = await parseRawResponse(res, sunoPath);
  if (json?.suno_status !== 200 && json?.suno_status !== 204) {
    throw new Error(`${sunoPath} -> suno ${json?.suno_status}: ${JSON.stringify(json?.data ?? null).slice(0, 200)}`);
  }
  return json.data;
}

async function parseRawResponse(res, sunoPath) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${sunoPath} -> /api/raw returned non-JSON (local HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}
