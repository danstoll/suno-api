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
import { downloadClipWav } from './wav-download.mjs';

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

  // MP3 downloads are gone (2026-09-18); the WAV flow lives in wav-download.mjs
  // so archive-track.mjs shares it.
  input = path.join(outDir, `${label}.src.wav`);
  console.log(`Downloading "${clip.title}" (${clip.duration}s)...`);
  await downloadClipWav(API, args.clip, input);
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
