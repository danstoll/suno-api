#!/usr/bin/env node
/**
 * Verify a recording actually sang every section of its lyrics file.
 *
 * Marker timings are NOT a reliable signal — a marker with a tiny duration
 * sometimes means a dropped section and sometimes means nothing at all. It has
 * produced false alarms and missed a genuinely absent verse. The only check
 * that has been right every time is: did the WORDS of each section appear in
 * the transcript?
 *
 * Builds a probe from each section's own opening words, so it works on any
 * lyrics file without hand-written phrases. Prints section names and times
 * only — never the lyrics themselves.
 *
 * Usage:
 *   node scripts/verify-coverage.mjs --clip <id> --file <lyrics.md>
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const args = parseArgs(process.argv.slice(2));
const API = args.api ?? 'http://localhost:3060';
if (!args.clip || !args.file) { console.error('Need --clip <id> --file <lyrics.md>'); process.exit(1); }
if (!existsSync(args.file)) { console.error(`Not found: ${args.file}`); process.exit(1); }

const src = readFileSync(args.file, 'utf8').replace(/\\([[\]~*_`#])/g, '$1');
const lyr = (src.match(/##\s*Lyrics\s*\n([\s\S]*?)(?=\n##\s|\n*$)/) ?? [])[1]?.trim();
if (!lyr) { console.error('No "## Lyrics" section found.'); process.exit(1); }

// One probe per section: its first handful of real words, normalised.
const sections = [];
for (const part of lyr.split(/\n(?=\[)/)) {
  const m = part.match(/^\[([^\]]+)\]\s*([\s\S]*)$/);
  if (!m) continue;
  const name = m[1].split(/\s+[—–-]\s+/)[0].trim();
  const body = m[2].replace(/\*\(NEW\)\*/gi, '').replace(/\([^)]*\)/g, ' ');
  // Score by distinctive WORDS present, not by an exact contiguous phrase.
  // Exact-substring matching gave a false "chorus never sang" on a chorus whose
  // every word was in the transcript — stripping the call-and-response asides
  // left a fragment that never appears as a run. Suno also re-orders and
  // elides on repeats, so a phrase match is too brittle to trust.
  const words = [...new Set(norm(body).split(' ').filter((x) => x.length > 3))];
  if (words.length >= 3) sections.push({ name, words });
}
if (!sections.length) { console.error('Parsed no sections.'); process.exit(1); }

const words = JSON.parse(execFileSync('curl',
  ['-s', '--max-time', '120', `${API}/api/get_aligned_lyrics?song_id=${args.clip}`],
  { encoding: 'utf8', maxBuffer: 32e6 }));
if (!Array.isArray(words)) { console.error('No alignment data — it may still be processing.'); process.exit(1); }

const transcript = norm(words.map((w) => w.word ?? '').join(' '));
// Character offset -> word index, so a hit can be reported as a timestamp.
const offsets = [];
let run = 0;
for (const w of words) { offsets.push(run); run += norm(w.word ?? '').length + 1; }

// A section counts as sung if most of its distinctive words are present.
// Not all — Suno drops the odd word, and a single miss should not condemn a
// verse that is plainly there.
const THRESHOLD = 0.6;
let missing = 0;
for (const s of sections) {
  const hits = s.words.filter((w) => transcript.includes(w));
  const ratio = hits.length / s.words.length;
  if (ratio < THRESHOLD) {
    console.log(`  MISSING  ${s.name.padEnd(20)} only ${hits.length}/${s.words.length} words present`);
    missing++;
    continue;
  }
  // Timestamp from the earliest distinctive word we can locate.
  let at = 0;
  for (const w of s.words) {
    const idx = transcript.indexOf(w);
    if (idx < 0) continue;
    let i = offsets.findIndex((o) => o > idx);
    i = i < 1 ? 0 : i - 1;
    at = at ? Math.min(at, i) : i;
  }
  const pct = Math.round(ratio * 100);
  console.log(`  ok       ${s.name.padEnd(20)} @ ${fmt(words[at].start_s)}   (${pct}% of words)`);
}

const end = words[words.length - 1]?.end_s ?? 0;
console.log(`\n  ${sections.length - missing}/${sections.length} sections sung, audio ends ${fmt(end)}`);
process.exit(missing ? 1 : 0);

function norm(s) { return String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function fmt(t) { return `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`; }

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const n = argv[i + 1];
    if (n === undefined || n.startsWith('--')) out[a.slice(2)] = true;
    else { out[a.slice(2)] = n; i++; }
  }
  return out;
}
