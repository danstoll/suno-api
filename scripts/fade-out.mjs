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
 *
 * Downloads always come from Suno as WAV now (MP3 downloads were
 * discontinued 2026-09) and get re-encoded to mp3 below like everything
 * else in this pipeline expects.
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

  // 2026-09-18: Suno discontinued MP3 downloads and retired the
  // increment_action_count + /api/download/clip flow this script used to
  // use (it now 401s "not_authorized" regardless of format — that is NOT a
  // per-clip permission the account is missing, it's a dead endpoint).
  // Two false leads ruled out first: media_urls[]'s cloudfront.net entry
  // still 200s with plausible headers but the bytes are corrupt ("moov atom
  // not found"); a per-clip `is_download_unlocked` field on GET /api/clip
  // looked like the gate but was a red herring — it has no bearing on the
  // endpoint below.
  //
  // The real current mechanism, read out of the Suno Explorer extension's
  // own source (shared/wav-api.js, shared/wav-queue.js — a real Chrome
  // extension the user pointed at, not observed via network capture this
  // time): WAV only, no MP3 equivalent exists.
  //   1. POST /api/gen/{id}/convert_wav/ — kicks off conversion. 204 on
  //      success; 402 means the account needs Suno Pro/Premier; 403 means
  //      this specific clip isn't WAV-convertible.
  //   2. GET /api/gen/{id}/wav_file/ — poll; body is `{}` while converting,
  //      then gains a `wav_file_url` key: a presigned S3 URL, fetchable with
  //      a plain unauthenticated request. Verified end-to-end 2026-09-18:
  //      real playable 16-bit/48kHz PCM WAV, correct duration, matches
  //      source. (The `_paid_wm` in the S3 key name is not an audible
  //      watermark — checked.)
  // Both calls go through /api/raw since neither is wrapped.
  try {
    await rawPost(`/api/gen/${args.clip}/convert_wav/`, null);
  } catch (err) {
    if (/\b402\b/.test(err.message)) throw new Error(`WAV requires Suno Pro or Premier: ${err.message}`);
    if (/\b403\b/.test(err.message)) throw new Error(`Clip ${args.clip} is not WAV-convertible: ${err.message}`);
    console.warn(`  (convert_wav trigger failed, polling anyway in case it's already converted: ${err.message})`);
  }

  let downloadUrl;
  let lastPollError;
  for (let i = 0; i < 40; i++) {
    let d;
    try {
      d = await rawGet(`/api/gen/${args.clip}/wav_file/`);
    } catch (err) {
      // A single flaky poll (dev-server hiccup, transient network blip)
      // shouldn't kill the whole budget — note it and keep polling.
      lastPollError = err;
      console.warn(`  (poll ${i + 1}/40 failed, retrying: ${err.message})`);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    if (d?.wav_file_url) { downloadUrl = d.wav_file_url; break; }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!downloadUrl) {
    const suffix = lastPollError ? ` (last poll error: ${lastPollError.message})` : '';
    throw new Error(`WAV conversion never finished for clip ${args.clip} after 120s${suffix}`);
  }

  input = path.join(outDir, `${label}.src.wav`);
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
