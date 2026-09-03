#!/usr/bin/env node
/**
 * master-album.mjs — turn N finished takes into a gapless, crossfaded album.
 *
 *   node scripts/master-album.mjs --manifest the-long-line-master.json
 *
 * Steps (The Long Line v2 spec §10):
 *   1. decode every input to 44.1k stereo WAV; join multi-part tracks with a short crossfade
 *   2. measure integrated loudness + true peak (ebur128); one album gain puts the loudest
 *      track at truePeakDb; any track more than maxSpreadLU below the loudest is lifted to
 *      exactly that spread, then re-measured and limited if it now exceeds truePeakDb
 *   3. chain acrossfade (tri) with per-join seconds; leadInSeconds of silence before track 1,
 *      tailSeconds after the last
 *   4. cut at each crossfade's midpoint; encode FLAC with tags + embedded cover; write a
 *      sidecar .txt per track, a .cue for the whole master, and report.json
 * Requires ffmpeg/ffprobe on PATH. Never touches the network.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
if (!args.manifest) { console.error('Need --manifest <json>.'); process.exit(1); }
const M = JSON.parse(readFileSync(args.manifest, 'utf8'));
const base = path.dirname(path.resolve(args.manifest));
const OUT = path.resolve(base, M.outDir);
const WORK = path.join(OUT, 'work');
mkdirSync(WORK, { recursive: true });
const TP = Number(M.truePeakDb ?? -1);
const SPREAD = Number(M.maxSpreadLU ?? 14);
const LEAD = Number(M.leadInSeconds ?? 0.5);
const TAIL = Number(M.tailSeconds ?? 1.0);
const PART_XF = Number(M.partCrossfade ?? 2);

// ---- 1. decode + join parts ------------------------------------------------
const decoded = M.tracks.map((t, i) => {
  const files = t.files.map((f) => path.resolve(base, f));
  for (const f of files) if (!existsSync(f)) throw new Error(`${t.num}: missing ${f}`);
  const out = path.join(WORK, `${t.num}.wav`);
  if (files.length === 1) {
    ff(['-i', files[0], '-ar', '44100', '-ac', '2', '-c:a', 'pcm_f32le', out]);
  } else {
    const inputs = files.flatMap((f) => ['-i', f]);
    let chain = '', prev = '[0:a]';
    files.slice(1).forEach((_, k) => { const o = `[p${k}]`; chain += `${prev}[${k + 1}:a]acrossfade=d=${PART_XF}:c1=tri:c2=tri${o};`; prev = o; });
    ff([...inputs, '-filter_complex', chain.slice(0, -1), '-map', prev, '-ar', '44100', '-ac', '2', '-c:a', 'pcm_f32le', out]);
  }
  return { ...t, wav: out, index: i };
});

// ---- 2. loudness ------------------------------------------------------------
for (const t of decoded) Object.assign(t, measure(t.wav));
const albumGain = TP - Math.max(...decoded.map((t) => t.TP));
const loudestAfter = Math.max(...decoded.map((t) => t.I)) + albumGain;
for (const t of decoded) {
  let gain = albumGain;
  const after = t.I + albumGain;
  if (loudestAfter - after > SPREAD) gain += (loudestAfter - SPREAD) - after;
  const out = path.join(WORK, `${t.num}.gain.wav`);
  ff(['-i', t.wav, '-af', `volume=${gain.toFixed(3)}dB`, '-c:a', 'pcm_f32le', out]);
  const m = measure(out);
  if (m.TP > TP + 0.05) {
    const lim = path.join(WORK, `${t.num}.lim.wav`);
    ff(['-i', out, '-af', `alimiter=limit=${Math.pow(10, TP / 20).toFixed(4)}:level=false:attack=5:release=50`, '-c:a', 'pcm_f32le', lim]);
    t.gainWav = lim; t.limited = true; Object.assign(t, { Iafter: measure(lim).I, TPafter: measure(lim).TP });
  } else {
    t.gainWav = out; t.limited = false; t.Iafter = m.I; t.TPafter = m.TP;
  }
  t.gainDb = gain;
  t.len = probe(t.gainWav);
}

// ---- 3. crossfade chain -----------------------------------------------------
const n = decoded.length;
const inputs = decoded.flatMap((t) => ['-i', t.gainWav]);
const ms = Math.round(LEAD * 1000);
// declare the padded first and last inputs up front, then chain acrossfade pairs
let chain = `[0:a]adelay=${ms}|${ms}[t0];[${n - 1}:a]apad=pad_dur=${TAIL}[tlast];`;
let prev = '[t0]';
for (let i = 0; i < n - 1; i++) {
  const d = Number(decoded[i].fadeIntoNext ?? 3);
  const nxt = i + 1 === n - 1 ? '[tlast]' : `[${i + 1}:a]`;
  const o = i === n - 2 ? '[mix]' : `[x${i}]`;
  chain += `${prev}${nxt}acrossfade=d=${d}:c1=tri:c2=tri${o};`;
  prev = o;
}
if (n === 1) chain = `[0:a]adelay=${ms}|${ms},apad=pad_dur=${TAIL}[mix];`;
const master = path.join(OUT, 'master.wav');
ff([...inputs, '-filter_complex', chain.slice(0, -1), '-map', '[mix]', '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s24le', master]);
const masterLen = probe(master);

// ---- 4. cut points, FLAC, sidecars, cue, report -----------------------------
const cuts = [];
let start = 0;
for (let i = 0; i < n - 1; i++) {
  const len = decoded[i].len + (i === 0 ? LEAD : 0);
  const xf = Number(decoded[i].fadeIntoNext ?? 3);
  const nextStart = start + len - xf;
  cuts.push(nextStart + xf / 2);
  start = nextStart;
}
const cover = M.cover ? path.resolve(base, M.cover) : null;
const report = { album: M.album, masterSeconds: masterLen, albumGainDb: albumGain, tracks: [] };
let cue = `PERFORMER "${M.artist}"\nTITLE "${M.album}"\nFILE "master.wav" WAVE\n`;
decoded.forEach((t, i) => {
  const from = i === 0 ? 0 : cuts[i - 1];
  const to = i === n - 1 ? masterLen : cuts[i];
  const name = `${t.num} ${sanitise(t.title)}`;
  const flac = path.join(OUT, `${name}.flac`);
  const cmd = ['-ss', from.toFixed(3), '-to', to.toFixed(3), '-i', master];
  if (cover) cmd.push('-i', cover);
  cmd.push('-map', '0:a', '-c:a', 'flac', '-compression_level', '8');
  if (cover) cmd.push('-map', '1:v', '-c:v', 'png', '-disposition:v:0', 'attached_pic', '-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)');
  const meta = { title: t.title, artist: M.artist, album_artist: M.artist, album: M.album, date: String(M.year ?? new Date().getFullYear()), track: String(Number(t.num)), genre: M.genre ?? 'Focus Sessions' };
  for (const [k, v] of Object.entries(meta)) cmd.push('-metadata', `${k}=${v}`);
  cmd.push(flac);
  ff(cmd);
  writeFileSync(path.join(OUT, `${name}.txt`),
    `title:    ${t.title}\nalbum:    ${M.album}\ntrack:    ${t.num}\nclip_id:  ${(t.clipIds ?? []).join(', ')}\nsource:   v2 master cut\n`);
  cue += `  TRACK ${t.num} AUDIO\n    TITLE "${t.title}"\n    PERFORMER "${M.artist}"\n    INDEX 01 ${cueTime(from)}\n`;
  const len = probe(flac);
  report.tracks.push({ num: t.num, title: t.title, from, to, seconds: len, I: t.I, TP: t.TP, gainDb: t.gainDb, limited: t.limited, Iafter: t.Iafter, TPafter: t.TPafter, clipIds: t.clipIds ?? [] });
  console.log(`${t.num} ${t.title.padEnd(18)} ${fmt(len)}  ${from.toFixed(1)}s→${to.toFixed(1)}s  I ${t.I.toFixed(1)}→${t.Iafter.toFixed(1)} LUFS  TP ${t.TPafter.toFixed(1)} dBTP${t.limited ? ' (limited)' : ''}`);
});
writeFileSync(path.join(OUT, `${sanitise(M.album)}.cue`), cue);
writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(`\nmaster ${fmt(masterLen)} → ${OUT}`);

// ---------------------------------------------------------------- helpers
function ff(a) { execFileSync('ffmpeg', ['-v', 'error', '-y', ...a], { stdio: 'inherit' }); }
function probe(f) { return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim()); }
function measure(f) {
  // ffmpeg prints the ebur128 summary on stderr; spawnSync captures both streams
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', f, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg ebur128 failed for ${f}: ${(r.stderr ?? '').slice(-400)}`);
  const out = (r.stderr ?? '') + (r.stdout ?? '');
  // ffmpeg reprints "I: <val> LUFS" on every ~100ms periodic status line while the
  // gate stabilises (always -70.0 for the first ~300ms, regardless of true level), so a
  // plain /I:\s+.../ match grabs that transient instead of the true reading; anchor to the
  // one-time "Integrated loudness:" / "True peak:" Summary labels instead.
  const I = /Integrated loudness:[\s\S]*?I:\s+(-?[\d.]+) LUFS/.exec(out), P = /True peak:[\s\S]*?Peak:\s+(-?[\d.]+) dBFS/.exec(out);
  if (!I || !P) throw new Error(`ebur128 parse failed for ${f}:\n${out.slice(-600)}`);
  return { I: Number(I[1]), TP: Number(P[1]) };
}
function cueTime(s) { const m = Math.floor(s / 60), sec = Math.floor(s % 60), fr = Math.round((s - Math.floor(s)) * 75); return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}:${String(Math.min(fr, 74)).padStart(2, '0')}`; }
function fmt(s) { return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`; }
function sanitise(s) { return String(s).replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim(); }
function parseArgs(argv) { const o = {}; for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (!a.startsWith('--')) continue; const nx = argv[i + 1]; if (nx === undefined || nx.startsWith('--')) o[a.slice(2)] = true; else { o[a.slice(2)] = nx; i++; } } return o; }
