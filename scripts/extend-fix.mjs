#!/usr/bin/env node
/**
 * Repair an existing clip by regenerating everything after a timestamp.
 *
 * Suno's extend does not merely append. Given a `continue_at`, everything from
 * that second onward is newly generated and the result is concatenated onto the
 * original — so it is a partial re-record that KEEPS the opening, in the
 * original voice and arrangement.
 *
 * That is the only repair for a take whose back half is wrong or missing while
 * its front is worth keeping. Replace Section cannot help: infill swaps a fixed
 * window of roughly equal length, so it has nowhere to put material that was
 * never sung. A fresh render fixes the song but loses the performance.
 *
 * make-track always generates its own front half, so it cannot do this.
 *
 * Usage:
 *   node scripts/extend-fix.mjs --clip <id> --file <lyrics.md> \
 *        --from "Verse 2" --at 55.3 [--fade 6] [--project <id>]
 *
 *   --from   first section to regenerate; everything from here on is sent
 *   --at     seconds to continue from. Take this from section-map, and pick a
 *            boundary a little BEFORE the first bad section — a seam mid-phrase
 *            is far more audible than a slightly early one.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Declared here, not beside post() at the bottom.
 *
 * `let` is hoisted but not initialised, so a counter declared below the
 * function that reads it throws "Cannot access 'seq' before initialization" the
 * first time that function runs — after the arguments have been parsed and the
 * plan printed, which makes it look like a Suno problem rather than a scoping
 * one. This exact bug killed the first make-track run, and writing the same
 * shape of script reintroduced it.
 */
let seq = 0;

const args = parseArgs(process.argv.slice(2));
const API = args.api ?? 'http://localhost:3060';
for (const need of ['clip', 'file', 'from', 'at']) {
  if (!args[need]) { console.error(`Need --${need}. See header.`); process.exit(1); }
}
if (!existsSync(args.file)) { console.error(`Not found: ${args.file}`); process.exit(1); }

const src = readFileSync(args.file, 'utf8').replace(/\\([\[\]~*_`#])/g, '$1');
const lyrics = (src.match(/##\s*Lyrics\s*\n([\s\S]*?)(?=\n##\s|\n*$)/) ?? [])[1]?.trim();
if (!lyrics) { console.error('No "## Lyrics" section found.'); process.exit(1); }
const styleBlock = (src.match(/##\s*Suno Style Prompt\s*\n([\s\S]*?)(?=\n##\s)/) ?? [])[1] ?? '';
const style = styleBlock.split('\n').filter((l) => l.trim().startsWith('>'))
  .map((l) => l.replace(/^\s*>\s?/, '')).join(' ').trim();
const title = (src.match(/^#\s+(.+)$/m) ?? [])[1]?.trim() ?? 'Untitled';

// Everything from --from onward, markers included.
const blocks = lyrics.split(/\n(?=\[)/);
const startAt = blocks.findIndex((b) => new RegExp(`^\\[${escapeRe(args.from)}`, 'i').test(b.trim()));
if (startAt < 0) {
  console.error(`No section starting "${args.from}". Sections:`);
  for (const b of blocks) console.error('  ' + (b.match(/^\[([^\]]+)\]/) ?? [])[1]);
  process.exit(1);
}
const tail = blocks.slice(startAt).join('\n\n').trim();
const names = blocks.slice(startAt).map((b) => (b.match(/^\[([^\]]+)\]/) ?? [])[1]?.split(/\s+[—–-]\s+/)[0]);

console.log(`\n=== ${title} — extend-fix ===`);
console.log(`source : ${args.clip}`);
console.log(`from   : ${args.at}s`);
console.log(`resend : ${names.join(' · ')}`);
if (args.dry) { console.log('\n--dry: nothing generated.'); process.exit(0); }

const styleWeight = args['style-weight'] !== undefined ? Number(args['style-weight']) : 0.9;
const weirdness = args.weirdness !== undefined ? Number(args.weirdness) : 0.2;

const ext = post('/api/extend_audio', {
  audio_id: args.clip,
  continue_at: Number(args.at),
  prompt: tail + '\n',
  tags: style,
  title,
  wait_audio: false,
  style_weight: styleWeight,
  weirdness,
  ...(args.project ? { project_id: args.project } : {})
});
const extClip = await settle(ext.map((c) => c.id), 'extension');

const cc = post('/api/concat', { clip_id: extClip.id, ...(args.project ? { project_id: args.project } : {}) });
const finalClip = await settle([Array.isArray(cc) ? cc[0].id : cc.id], 'concat');

const mins = `${Math.floor(finalClip.duration / 60)}:${String(Math.round(finalClip.duration % 60)).padStart(2, '0')}`;
console.log(`\nFINAL: ${finalClip.duration.toFixed(2)}s (${mins})  ${finalClip.id}`);
console.log(`  ${finalClip.audio_url}`);

if (args.fade) {
  console.log(`\napplying ${args.fade}s fade...`);
  execFileSync('node', [path.join(import.meta.dirname, 'fade-out.mjs'),
    '--clip', finalClip.id, '--seconds', String(args.fade)], { stdio: 'inherit' });
}

console.log('\nVerify before trusting it:');
console.log(`  node scripts/verify-coverage.mjs --clip ${finalClip.id} --file "${args.file}"`);

// ---------------------------------------------------------------- helpers

function post(route, body) {
  // Node's fetch times out these long generations; curl via a temp file does not.
  const f = path.join(os.tmpdir(), `extend-fix-${process.pid}-${seq++}.json`);
  writeFileSync(f, JSON.stringify(body));
  try {
    const out = execFileSync('curl', ['-s', '--max-time', '1500', '-X', 'POST',
      '-H', 'Content-Type: application/json', '--data-binary', `@${f}`, `${API}${route}`],
      { encoding: 'utf8', maxBuffer: 64e6 });
    const parsed = JSON.parse(out);
    if (parsed?.error) throw new Error(`${route} -> ${parsed.error}`);
    return parsed;
  } finally { try { unlinkSync(f); } catch { /* best effort */ } }
}

async function settle(ids, label) {
  process.stdout.write(`${label}: `);
  for (let i = 0; i < 200; i++) {
    const clips = JSON.parse(execFileSync('curl',
      ['-s', '--max-time', '120', `${API}/api/get?ids=${ids.join(',')}`],
      { encoding: 'utf8', maxBuffer: 32e6 }));
    const done = clips.filter((c) => c.status === 'complete' && c.audio_url);
    if (done.length) {
      // Longest wins: a short take usually means dropped sections.
      done.sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0));
      console.log(`ok ${done[0].duration?.toFixed(2)}s (${done.length}/${clips.length} usable)`);
      return done[0];
    }
    if (clips.every((c) => c.status === 'error')) throw new Error(`${label}: all takes errored`);
    process.stdout.write('.');
    execFileSync('node', ['-e', 'setTimeout(()=>{},15000)'], { timeout: 20000 });
  }
  throw new Error(`${label}: never completed`);
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

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
