#!/usr/bin/env node
/**
 * Locate each section of a lyrics file inside a finished recording.
 *
 * Infill needs a start and end second for the window it replaces. Get those
 * wrong and it eats the last word of the previous line or leaves a stub of the
 * old vocal at the seam.
 *
 * Suno's alignment data only sometimes carries section labels — newer renders
 * do, older ones return a single unlabelled run — so the boundaries have to be
 * derived from the words themselves rather than read off.
 *
 * Sections are matched in order, each scan starting where the previous one
 * ended. That handles repeated choruses for free: the second chorus can only
 * match after the first has been consumed.
 *
 * Prints section names and timings only, never the lyrics.
 *
 * Usage:
 *   node scripts/section-map.mjs --clip <id> --file <lyrics.md>
 *   node scripts/section-map.mjs --clip <id> --file <lyrics.md> --section "Verse 2"
 *
 * With --section, prints just that window plus a suggested infill range with a
 * little padding, ready to hand to replace-section.
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

/**
 * A bracketed line is only a SECTION if it names one. Stage directions live in
 * brackets too — [hand claps], [silence — hold it], [the girls] (MOOOO!) — and
 * splitting on "line starts with [" counted every one as a section. That
 * inflated coverage counts with things nobody sings.
 *
 * The section word need not lead the bracket: [Final Chorus — doubled…],
 * [Double Drop]. So match it anywhere inside. A direction that happens to
 * contain one, like [beat drops], will read as a section — an acceptable trade
 * against silently losing a Final Chorus.
 */
const SECTION_RE = /^\[[^\]]*\b(?:intro|verse|pre-?chorus|post-?chorus|chorus|bridge|outro|hook|break|drop|instrumental|refrain|coda|interlude)\b/i;

/** Group lines into section blocks, ignoring inline directions. */
function splitSections(text) {
  return text.split('\n').reduce((acc, line) => {
    if (SECTION_RE.test(line.trim())) acc.push([line]);
    else if (acc.length) acc[acc.length - 1].push(line);
    return acc;
  }, []).map((b) => b.join("\n").trim()).filter(Boolean);
}

const sections = [];
for (const part of splitSections(lyr)) {
  const m = part.match(/^\[([^\]]+)\]\s*([\s\S]*)$/);
  if (!m) continue;
  const name = m[1].split(/\s+[—–-]\s+/)[0].trim();
  // Drop parenthetical asides — they are shouted ad-libs that align unreliably.
  const body = m[2].replace(/\*\(NEW\)\*/gi, '').replace(/\([^)]*\)/g, ' ');
  const words = norm(body).split(' ').filter((x) => x.length > 3);
  if (words.length >= 3) sections.push({ name, words, set: new Set(words) });
}
if (!sections.length) { console.error('Parsed no sections.'); process.exit(1); }

const aligned = JSON.parse(execFileSync('curl',
  ['-s', '--max-time', '120', `${API}/api/get_aligned_lyrics?song_id=${args.clip}`],
  { encoding: 'utf8', maxBuffer: 32e6 }));
if (!Array.isArray(aligned) || !aligned.length) {
  console.error('No alignment data — the clip may still be processing.');
  process.exit(1);
}

const tok = aligned.map((w) => ({ w: norm(w.word ?? ''), a: w.start_s, b: w.end_s })).filter((t) => t.w);

/**
 * Find where each section STARTS. Do not try to find where it ends.
 *
 * A section's opening is sharp — several of its own words arrive together. Its
 * ending is not: the last line trails into an ad-lib, a repeat, or a held note,
 * and the words there are common ones shared with every other section.
 *
 * An earlier version walked forward looking for the end, and on this very track
 * ran Verse 2 six seconds into the following pre-chorus. That pushed the cursor
 * past the next chorus, so four later sections reported MISSING when all four
 * were plainly sung. Ends are now simply where the next section begins.
 */
const score = (i, s) => {
  // How much of this section's opening shows up in the words starting here.
  const n = Math.min(s.words.length, 10);
  let hit = 0;
  for (let k = 0; k < n && i + k < tok.length; k++) if (s.set.has(tok[i + k].w)) hit++;
  return hit / n;
};

const MIN = 0.45;
let cursor = 0;
const found = [];
for (let si = 0; si < sections.length; si++) {
  const s = sections[si];
  // Best-scoring start at or after the previous section's start, not its end —
  // a slightly late previous match must not be able to hide the next section.
  let best = -1, bestScore = 0;
  for (let i = cursor; i < tok.length; i++) {
    const v = score(i, s);
    if (v > bestScore) { bestScore = v; best = i; }
    // Good enough and we are past the obvious candidates: stop early so a
    // repeated chorus matches its own occurrence rather than a later one.
    if (bestScore >= 0.8 && i - best > 12) break;
  }
  if (best < 0 || bestScore < MIN) { found.push({ ...s, missing: true }); continue; }
  found.push({ ...s, start: best, t0: tok[best].a, conf: bestScore });
  cursor = best + 1;
}

// End of each section = start of the next; the last runs to the end of audio.
const lastEnd = tok[tok.length - 1].b;
for (let i = 0; i < found.length; i++) {
  if (found[i].missing) continue;
  const next = found.slice(i + 1).find((x) => !x.missing);
  found[i].t1 = next ? next.t0 : lastEnd;
}

const f = (t) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;

if (args.section) {
  const hit = found.find((x) => x.name.toLowerCase() === String(args.section).toLowerCase());
  if (!hit) { console.error(`No section named "${args.section}". Have: ${found.map((x) => x.name).join(', ')}`); process.exit(1); }
  if (hit.missing) { console.error(`"${hit.name}" was not found in this recording.`); process.exit(1); }
  // A little padding outward so the replaced window starts in the gap between
  // lines rather than on the attack of the first word.
  const pad = Number(args.pad ?? 0.35);
  const a = Math.max(0, hit.t0 - pad);
  const b = Math.min(tok[tok.length - 1].b, hit.t1 + pad);
  console.log(`  ${hit.name}`);
  console.log(`    sung   ${f(hit.t0)} - ${f(hit.t1)}   (${(hit.t1 - hit.t0).toFixed(2)}s)`);
  console.log(`    infill ${a.toFixed(2)} - ${b.toFixed(2)}   (${(b - a).toFixed(2)}s, ${pad}s pad)`);
  process.exit(0);
}

console.log(`  ${sections.length} sections, audio ends ${f(tok[tok.length - 1].b)}\n`);
for (const s of found) {
  if (s.missing) { console.log(`  MISSING  ${s.name}`); continue; }
  console.log(`  ${s.name.padEnd(16)} ${f(s.t0).padStart(6)} - ${f(s.t1).padStart(6)}   ` +
              `${String((s.t1 - s.t0).toFixed(1)).padStart(6)}s   [${s.t0.toFixed(2)} ${s.t1.toFixed(2)}]`);
}

function norm(s) { return String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }

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
