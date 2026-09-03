#!/usr/bin/env node
/**
 * Apply a proper fade-out to a Suno track.
 *
 * Suno's endings frequently truncate rather than resolve — full level right up
 * to the last couple of seconds, then a steep drop. Regenerating rarely fixes
 * it (a "fades gentle" note in the lyrics is treated as text, not as a mix
 * instruction), and every attempt costs credits for a different song.
 *
 * Doing it here is deterministic, free, and repeatable across a back catalogue.
 *
 * Usage:
 *   node scripts/fade-out.mjs --clip <clip-id> [--seconds 6] [--out path.mp3]
 *   node scripts/fade-out.mjs --file <in.mp3>  [--seconds 6] [--out path.mp3]
 *   node scripts/fade-out.mjs --file <in.mp3>  --analyze      # measure only
 *
 * Options:
 *   --seconds N   fade length; default 6. Ballads want 6-8, upbeat 3-4.
 *   --curve NAME  ffmpeg fade curve; default qsin. See note below.
 *   --tail N      also trim N seconds of dead air off the end first
 *   --api URL     suno-api base; default http://localhost:3060
 *   --format wav|mp3  download format; default mp3
 *
 * On the curve: measured per-second RMS across a 7s fade on a real track --
 *   qsin  holds level ~3s then eases out, silent exactly at the end   <- default
 *   tri   audibly starts pulling down almost immediately
 *   losi  similar to qsin but drops harder at the very end
 *   cub   too fast; leaves ~2s of dead air
 *   exp   far too fast; effectively silent 4s early, so the song just
 *         stops sooner. Do not use it for a musical fade.
 *
 * Requires ffmpeg on PATH.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const API = args.api ?? 'http://localhost:3060';
const FADE = Number(args.seconds ?? 6);
const TRIM_TAIL = Number(args.tail ?? 0);
const CURVE = typeof args.curve === 'string' ? args.curve : 'qsin';
const FORMAT = args.format === 'wav' ? 'wav' : 'mp3';   // Suno's download endpoint; WAV availability is probed in The Long Line v2 Task 15

if (!args.clip && !args.file) {
  console.error('Need --clip <id> or --file <path>. See header for usage.');
  process.exit(1);
}
if (!Number.isFinite(FADE) || FADE <= 0) {
  console.error(`--seconds must be a positive number, got '${args.seconds}'`);
  process.exit(1);
}

const outDir = path.resolve('faded');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

let input = args.file;
let label = args.file ? path.basename(args.file, path.extname(args.file)) : args.clip;

if (args.clip) {
  // The dev server has been observed dropping requests with a transient 500
  // under concurrent batch load (2026-08-28: a fade catch-up batch running
  // alongside a generation batch took out several tracks in a row this way).
  // A few retries with a short pause turns that into a non-event instead of
  // a hard failure partway through an otherwise-fine batch.
  let clips;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${API}/api/get?ids=${args.clip}`).catch((err) => ({ ok: false, status: `network error: ${err.message}` }));
    if (res.ok) { clips = await res.json(); break; }
    if (attempt >= 4) throw new Error(`${API} returned ${res.status} after ${attempt} attempts — is the dev server running?`);
    console.warn(`  (/api/get returned ${res.status}, retrying in 3s — attempt ${attempt}/4)`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  const clip = clips?.[0];
  if (!clip) throw new Error(`No clip found for ${args.clip} (status: ${clip?.status ?? 'unknown'})`);
  label = sanitise(clip.title || args.clip);

  // Both of Suno's obvious download fields are dead ends as of 2026-08-28:
  // `audio_url` now returns a literal `.../api/forbidden` placeholder for
  // API-originated requests, and `media_urls[]`'s cdn1.suno.ai entry 403s
  // with a CloudFront "MissingKey" error (needs a signed cookie we don't
  // have); its *.cloudfront.net entry 200s but the bytes are encrypted
  // garbage. The real mechanism, found via a live capture of the web UI's
  // actual Download button (scripts/capture-suno-requests.js):
  //   1. POST /api/gen/{id}/increment_action_count/  {action:"download_audio",
  //      download_source:"clip_page"} — appears to kick off server-side
  //      rendering (best-effort here; a fresh clip may need it, an
  //      already-downloaded one may not, so failure here isn't fatal).
  //   2. GET /api/download/clip/{id}?format=mp3 — poll until the body's
  //      `status` flips from "processing" to "ready", at which point it
  //      carries a `download_url`: a normal, temporary, presigned S3 URL
  //      (AWSAccessKeyId/Signature/Expires query params) good for a few
  //      minutes and fetchable with a plain unauthenticated request.
  // Both calls go through /api/raw since neither is wrapped. Verified
  // end-to-end same day: downloaded and ffprobe'd a real, valid mp3 this way.
  try {
    await rawPost(`/api/gen/${args.clip}/increment_action_count/`,
      { action: 'download_audio', download_source: 'clip_page' });
  } catch (err) {
    console.warn(`  (increment_action_count failed, continuing anyway: ${err.message})`);
  }

  let downloadUrl;
  let lastPollError;
  for (let i = 0; i < 30; i++) {
    let d;
    try {
      d = await rawGet(`/api/download/clip/${args.clip}?format=${FORMAT}`);
    } catch (err) {
      // A single flaky poll (dev-server hiccup, transient network blip)
      // shouldn't kill the whole 60s budget — note it and keep polling.
      lastPollError = err;
      console.warn(`  (poll ${i + 1}/30 failed, retrying: ${err.message})`);
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    if (d?.status === 'ready' && d?.download_url) { downloadUrl = d.download_url; break; }
    // Only "processing" is a known in-progress state (per the live capture).
    // Anything else — an error status, ok:false, ready-without-a-url — is
    // not something more waiting will fix, so surface it immediately rather
    // than burning the full 60s to report the same unhelpful timeout.
    if (d?.status && d.status !== 'processing') {
      throw new Error(`Unexpected download status for clip ${args.clip}: ${JSON.stringify(d).slice(0, 300)}`);
    }
    if (d && d.ok === false) {
      throw new Error(`Download request rejected for clip ${args.clip}: ${JSON.stringify(d).slice(0, 300)}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!downloadUrl) {
    const suffix = lastPollError ? ` (last poll error: ${lastPollError.message})` : '';
    throw new Error(`Download never became ready for clip ${args.clip} after 60s${suffix}`);
  }

  input = path.join(outDir, `${label}.src.${FORMAT}`);
  console.log(`Downloading "${clip.title}" (${clip.duration}s)...`);
  const audio = await fetch(downloadUrl);
  // The URL carries temporary AWS SigV2 query params — drop them from any
  // error text so a shared/logged batch output doesn't include credentials,
  // even short-lived ones.
  if (!audio.ok) throw new Error(`Download failed: ${audio.status} (${downloadUrl.split('?')[0]})`);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(input, Buffer.from(await audio.arrayBuffer()));
}

if (!existsSync(input)) throw new Error(`Input not found: ${input}`);

const duration = Number(
  ffprobe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', input]).trim()
);
// Preserve the source bitrate; re-encoding at a lower rate to apply a fade
// would be a silly way to lose quality.
const srcBitrate = Number(
  ffprobe(['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=bit_rate', '-of', 'csv=p=0', input]).trim()
) || 192000;

console.log(`\nSource: ${input}`);
console.log(`  duration ${duration.toFixed(2)}s | bitrate ${Math.round(srcBitrate / 1000)}k`);

console.log('\nTail envelope BEFORE:');
printTail(input, duration);

if (args.analyze) process.exit(0);

const endAt = duration - TRIM_TAIL;
const fadeStart = endAt - FADE;
if (fadeStart <= 0) throw new Error(`Fade of ${FADE}s does not fit in a ${duration.toFixed(1)}s track.`);

const out = args.out ?? path.join(outDir, `${label}.faded.mp3`);

const filter = `afade=t=out:st=${fadeStart.toFixed(3)}:d=${FADE}:curve=${CURVE}`;
const cmd = ['-v', 'error', '-y', '-i', input];
if (TRIM_TAIL > 0) cmd.push('-t', endAt.toFixed(3));
cmd.push('-af', filter, '-c:a', 'libmp3lame', '-b:a', String(srcBitrate), '-map_metadata', '0', out);

console.log(`\nApplying ${FADE}s '${CURVE}' fade from ${fadeStart.toFixed(2)}s...`);
execFileSync('ffmpeg', cmd, { stdio: 'inherit' });

const newDur = Number(
  ffprobe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).trim()
);
console.log(`\nWrote: ${out}  (${newDur.toFixed(2)}s)`);
console.log('\nTail envelope AFTER:');
printTail(out, newDur);

// ---------------------------------------------------------------- helpers

function ffprobe(a) {
  return execFileSync('ffprobe', a, { encoding: 'utf8' });
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

/**
 * /api/raw always wraps with local HTTP 200 on a real Suno response, but our
 * own dev server can still fail before reaching that point (a 500 from a
 * crash/overload, a Next.js HTML error page, a proxy timeout page) — none of
 * which are JSON. Surfacing the wrapper's own HTTP status and a snippet of
 * whatever it actually returned beats a bare, path-less `SyntaxError:
 * Unexpected token '<'...` when triaging a failed batch run later.
 */
async function parseRawResponse(res, sunoPath) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${sunoPath} -> /api/raw returned non-JSON (local HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
}

/** Print a per-second RMS bar chart of the final 12s, so the fade is visible. */
function printTail(file, dur) {
  const window = Math.min(12, Math.floor(dur));
  const start = Math.max(0, dur - window);
  let raw;
  try {
    raw = execFileSync(
      'ffmpeg',
      ['-v', 'error', '-ss', String(start.toFixed(2)), '-i', file,
       '-af', 'asetnsamples=44100,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
       '-f', 'null', '-'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch {
    console.log('  (envelope unavailable)');
    return;
  }
  const vals = [...raw.matchAll(/=(-?[\d.]+|-inf)/g)].map((m) => m[1]);
  vals.forEach((v, i) => {
    const db = parseFloat(v);
    const bar = Number.isFinite(db) ? '#'.repeat(Math.max(0, Math.round((db + 60) / 1.5))) : '';
    console.log(`  t=${String(Math.round(start + i)).padStart(3)}s ${String(v).padStart(9)} dB  ${bar}`);
  });
}

function sanitise(s) {
  return String(s).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'track';
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
