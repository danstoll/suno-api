#!/usr/bin/env node
/**
 * Splice an infill (Replace Section) result back into its source track.
 *
 * WHY THIS IS NEEDED: /api/replace_section returns ONLY the regenerated window,
 * not the finished song. A 11s replacement comes back as ~15s of audio — the
 * window plus the 2s of lead-in and lead-out requested via include_history_s /
 * include_future_s. Suno's own web client does the reassembly on the client
 * side, so an API caller has to do the same.
 *
 * Those 2s margins are the point: they overlap the original either side, giving
 * real material to crossfade against so the joins are inaudible.
 *
 * Usage:
 *   node scripts/splice-infill.mjs \
 *     --source <original-clip-id> --infill <infill-clip-id> \
 *     --start 29 --end 40 [--lead 2] [--crossfade 0.35]
 *
 *   --lead N        include_history_s used for the infill (default 2)
 *   --crossfade N   join length in seconds (default 0.35); 0 for hard cuts
 *   --api URL       suno-api base (default http://localhost:3060)
 *
 * Requires ffmpeg on PATH.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const API = args.api ?? 'http://localhost:3060';
const START = Number(args.start);
const END = Number(args.end);
const LEAD = Number(args.lead ?? 2);
const XF = Number(args.crossfade ?? 0.35);

if (!args.source || !args.infill || !Number.isFinite(START) || !Number.isFinite(END)) {
  console.error('Need --source <id> --infill <id> --start <s> --end <s>. See header.');
  process.exit(1);
}
if (END <= START) { console.error(`--end (${END}) must be greater than --start (${START})`); process.exit(1); }
if (START < 0 || LEAD < 0 || XF < 0) { console.error('--start, --lead and --crossfade must be >= 0'); process.exit(1); }

const outDir = path.resolve('spliced');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const srcFile = await fetchClip(args.source, 'source');
const infFile = await fetchClip(args.infill, 'infill');

const srcDur = probeDuration(srcFile);
const infDur = probeDuration(infFile);
const window = END - START;

console.log(`\nsource ${srcDur.toFixed(2)}s   infill ${infDur.toFixed(2)}s   window ${window.toFixed(2)}s @ ${START}-${END}s`);

if (END > srcDur) { console.error(`--end ${END}s is past the end of the source (${srcDur.toFixed(2)}s).`); process.exit(1); }

// The infill payload is [lead][window][tail]. Trim to just the window, unless
// the returned clip is too short for the lead we were told to expect.
let take = LEAD;
if (infDur < window + LEAD) {
  take = Math.max(0, (infDur - window) / 2);
  console.warn(`! infill is ${infDur.toFixed(2)}s, shorter than window+lead (${(window + LEAD).toFixed(2)}s).`);
  console.warn(`  Falling back to a ${take.toFixed(2)}s lead. Check --lead matches include_history_s.`);
}

const tmp = path.join(outDir, '.tmp');
if (!existsSync(tmp)) mkdirSync(tmp, { recursive: true });
const A = path.join(tmp, 'a.wav'); // original, up to the cut
const B = path.join(tmp, 'b.wav'); // regenerated window
const C = path.join(tmp, 'c.wav'); // original, after the cut

// Decode to wav so the concat/crossfade is sample-accurate rather than
// snapping to MP3 frame boundaries.
ff(['-v', 'error', '-y', '-i', srcFile, '-t', String(START + XF), '-c:a', 'pcm_s16le', A]);
ff(['-v', 'error', '-y', '-ss', String(take), '-i', infFile, '-t', String(window + XF), '-c:a', 'pcm_s16le', B]);
ff(['-v', 'error', '-y', '-ss', String(END), '-i', srcFile, '-c:a', 'pcm_s16le', C]);

const out = args.out ?? path.join(outDir, `${args.source.slice(0, 8)}-spliced.mp3`);
const srcBitrate = probeBitrate(srcFile);

if (XF > 0) {
  // acrossfade consumes the overlap, so A and B were each cut XF long.
  ff([
    '-v', 'error', '-y', '-i', A, '-i', B, '-i', C,
    '-filter_complex',
    `[0:a][1:a]acrossfade=d=${XF}:c1=tri:c2=tri[ab];[ab][2:a]acrossfade=d=${XF}:c1=tri:c2=tri[out]`,
    '-map', '[out]', '-c:a', 'libmp3lame', '-b:a', String(srcBitrate), out
  ]);
} else {
  const list = path.join(tmp, 'list.txt');
  writeFileSync(list, [A, B, C].map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
  ff(['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c:a', 'libmp3lame', '-b:a', String(srcBitrate), out]);
}

rmSync(tmp, { recursive: true, force: true });

const newDur = probeDuration(out);
console.log(`\nWrote: ${out}`);
console.log(`  ${newDur.toFixed(2)}s   (source was ${srcDur.toFixed(2)}s — expect within ~${(XF * 2).toFixed(2)}s)`);
console.log(`  replaced ${START}-${END}s, ${XF > 0 ? `${XF}s crossfades` : 'hard cuts'}`);
console.log(`\nListen around ${START}s and ${END}s — those are the joins.`);

// ---------------------------------------------------------------- helpers

async function fetchClip(id, label) {
  const file = path.join(outDir, `${id.slice(0, 8)}.${label}.mp3`);
  if (existsSync(file)) { console.log(`${label}: cached ${file}`); return file; }
  const res = await fetch(`${API}/api/get?ids=${id}`);
  if (!res.ok) throw new Error(`${API} returned ${res.status} — is the dev server running?`);
  const clip = (await res.json())?.[0];
  if (!clip?.audio_url) throw new Error(`No audio_url for ${label} clip ${id} (status: ${clip?.status ?? 'unknown'})`);
  console.log(`${label}: downloading "${clip.title}" (${clip.duration}s)`);
  const audio = await fetch(clip.audio_url);
  if (!audio.ok) throw new Error(`Download failed for ${label}: ${audio.status}`);
  writeFileSync(file, Buffer.from(await audio.arrayBuffer()));
  return file;
}

function ff(a) { execFileSync('ffmpeg', a, { stdio: 'inherit' }); }

function probeDuration(f) {
  return Number(execFileSync('ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim());
}

function probeBitrate(f) {
  const v = Number(execFileSync('ffprobe',
    ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=bit_rate', '-of', 'csv=p=0', f],
    { encoding: 'utf8' }).trim());
  return Number.isFinite(v) && v > 0 ? v : 192000;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
    else { out[a.slice(2)] = next; i++; }
  }
  return out;
}
