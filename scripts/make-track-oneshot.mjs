#!/usr/bin/env node
/**
 * Record a full-length track from a lyrics markdown file in ONE generate call.
 *
 * make-track.mjs's generate+extend+concat split exists to work around older
 * models silently dropping sections on long lyric sheets. The v5.5 model
 * (chirp-fenix) has not shown that problem in practice — every single-shot
 * generation this catalogue has tried (manual web-UI or this script) has come
 * back with full section coverage, while the split pipeline has produced a
 * genuine duplication/runaway-length failure on a track the single-shot
 * version handled cleanly. Prefer this script; reach for make-track.mjs's
 * split only if a single-shot take actually drops a section.
 *
 * Usage:
 *   node scripts/make-track-oneshot.mjs --file <lyrics.md> --title "01 Waffle Wednesday" \
 *     [--project <workspace-id>] [--fade 6] [--dry]
 *
 *   --dry          parse and print the plan, generate nothing
 *   --fade N       fade-out seconds (default 6; 0 to skip)
 *
 * Lyrics file format: a "## Lyrics" heading, then [Section] blocks. The style
 * prompt is read from the "## Suno Style Prompt" blockquote. Same format as
 * make-track.mjs.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const API = args.api ?? 'http://localhost:3060';
const FADE = Number(args.fade ?? 6);
let postSeq = 0;

if (!args.file) { console.error('Need --file <lyrics.md>. See header.'); process.exit(1); }
if (!existsSync(args.file)) { console.error(`Not found: ${args.file}`); process.exit(1); }

const src = readFileSync(args.file, 'utf8').replace(/\\([[\]~*_`#])/g, '$1');
const title = args.title ?? (src.match(/^#\s+(.+)$/m)?.[1] ?? path.basename(args.file, '.md'));

// Only consume the blockquote's own `>` lines — stop at the first line that
// isn't one. The old `(?=\n##|\n$)` lookahead ran to the next heading
// instead, so a plain-paragraph aside after the blockquote (e.g. a
// "**Mix-specific risk:**" note) got swallowed into the style/tags field sent
// to Suno. That pushed 4 Full Burrow tracks' tags past v5+'s 1000-char limit
// (1044-1102 chars measured) and Suno rejected every one of them outright
// with a generic "Something about your request isn't quite right" — found
// 2026-08-27 after they failed identically across two separate batch runs
//
// The `.*\r?\n?` (not just `\n?`) matters: these lyric files are CRLF. `.`
// never matches `\r`, so a bare `\n?` leaves the `\r` unconsumed after the
// first line, the next `>` check lands on that stray `\r` instead, and the
// `+` loop silently stops after exactly one line — under-capturing a
// multi-line blockquote down to just its first line.
// while unrelated tracks in the same batch succeeded.
const styleMatch = src.match(/##\s*Suno Style Prompt\s*\n((?:>.*\r?\n?)+)/);
const style = (styleMatch?.[1] ?? '').replace(/^>\s?/gm, '').replace(/\s+/g, ' ').trim();
if (!style) { console.error('No "## Suno Style Prompt" blockquote found.'); process.exit(1); }

const lyricsMatch = src.match(/##\s*Lyrics\s*\n([\s\S]*?)(?=\n##\s|\n*$)/);
if (!lyricsMatch) { console.error('No "## Lyrics" section found.'); process.exit(1); }

const raw = lyricsMatch[1].trim();
const blocks = [];
for (const part of raw.split(/\n(?=\[)/)) {
  const m = part.match(/^\[([^\]]+)\]\s*([\s\S]*)$/);
  if (!m) continue;
  const heading = m[1].split(/\s+[—–-]\s+/)[0].trim().replace(/\s*\*?\(NEW\)\*?\s*/i, '');
  const body = m[2].replace(/\*\(NEW\)\*/gi, '').trim();
  blocks.push({ heading, body, text: `[${heading}]\n${body}`.trim() });
}
if (blocks.length < 2) { console.error(`Parsed only ${blocks.length} section(s) — check the file format.`); process.exit(1); }

console.log(`\n=== ${title} ===`);
console.log(`style : ${style.slice(0, 90)}...`);
console.log(`sections : ${blocks.map((b) => b.heading).join(' · ')}`);
if (args.dry) { console.log('\n--dry: nothing generated.'); process.exit(0); }

const projectId = args.project;
const personaId = args.persona;
const styleWeight = args["style-weight"] !== undefined ? Number(args["style-weight"]) : 0.9;
const weirdness = args.weirdness !== undefined ? Number(args.weirdness) : 0.2;
const negativeTags = args.negative ? String(args.negative) : undefined;

const p1 = post('/api/custom_generate', {
  prompt: blocks.map((b) => b.text).join('\n\n') + '\n',
  tags: style, title, make_instrumental: false, wait_audio: false,
  ...(projectId ? { project_id: projectId } : {}),
  ...(personaId ? { persona_id: personaId } : {}),
  style_weight: styleWeight, weirdness,
  ...(negativeTags ? { negative_tags: negativeTags } : {})
});
const finalClip = await settle(p1.map((c) => c.id), 'generate');
await report(finalClip.id, blocks.length);

const mins = `${Math.floor(finalClip.duration / 60)}:${String(Math.round(finalClip.duration % 60)).padStart(2, '0')}`;
console.log(`\nFINAL: ${finalClip.duration}s (${mins})  ${finalClip.id}`);
console.log(`  ${finalClip.audio_url}`);

if (FADE > 0) {
  console.log(`\napplying ${FADE}s fade...`);
  execFileSync('node', [path.join(path.dirname(process.argv[1]), 'fade-out.mjs'),
    '--clip', finalClip.id, '--seconds', String(FADE)], { stdio: 'inherit' });
}

// ---------------------------------------------------------------- helpers

function post(route, body) {
  const tmp = path.join(os.tmpdir(), `suno-post-${process.pid}-${postSeq++}.json`);
  writeFileSync(tmp, JSON.stringify(body));
  try {
    const out = execFileSync('curl', [
      '-s', '--max-time', '1500', '-X', 'POST', `${API}${route}`,
      '-H', 'Content-Type: application/json', '--data-binary', `@${tmp}`
    ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    let parsed;
    try { parsed = JSON.parse(out); }
    catch { throw new Error(`${route} -> unparseable response: ${out.slice(0, 300)}`); }
    if (parsed?.error) throw new Error(`${route} -> ${parsed.error}${parsed.detail ? ': ' + JSON.stringify(parsed.detail).slice(0, 200) : ''}`);
    return parsed;
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }
}

function get(route) {
  const out = execFileSync('curl', ['-s', '--max-time', '120', `${API}${route}`],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  try { return JSON.parse(out); } catch { return null; }
}

async function settle(ids, label) {
  process.stdout.write(`${label}: `);
  for (let i = 0; i < 40; i++) {
    const clips = get(`/api/get?ids=${ids.join(',')}`) ?? [];
    const done = clips.filter((c) => c.status === 'complete');
    const failed = clips.filter((c) => c.status === 'error');
    if (done.length + failed.length >= clips.length && clips.length) {
      if (!done.length) throw new Error(`${label}: all takes errored — ${failed[0]?.error_message ?? 'no message'}`);
      const best = done.sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))[0];
      console.log(`ok ${best.duration}s (${done.length}/${clips.length} usable)`);
      return best;
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 15000));
  }
  throw new Error(`${label}: timed out waiting for completion`);
}

async function report(id, expected) {
  try {
    const words = get(`/api/get_aligned_lyrics?song_id=${id}`);
    if (!Array.isArray(words)) { console.log('  (no alignment yet)'); return; }
    const marks = words.filter((w) => /verse|chorus|bridge|intro|outro|drop|pre/i.test(w.word ?? ''));
    const dropped = marks.filter((w) => w.end_s - w.start_s < 0.15);
    console.log(`  ${marks.length} markers found, expected ~${expected}`);
    if (dropped.length) {
      console.warn(`  ! ${dropped.length} look DROPPED (sub-0.15s): ` +
        dropped.map((w) => JSON.stringify((w.word ?? '').trim().slice(0, 18))).join(', '));
      console.warn('    Run verify-coverage.mjs to confirm before trusting this.');
    }
  } catch { console.log('  (alignment unavailable)'); }
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
