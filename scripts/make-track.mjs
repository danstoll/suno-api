#!/usr/bin/env node
/**
 * Record a full-length track from a lyrics markdown file.
 *
 * WHY: Suno silently DROPS sections when a lyric sheet is too long for one
 * pass — it does not truncate, so you get a plausible-sounding song missing a
 * verse and two choruses. Verified repeatedly: markers land with sub-0.1s
 * durations where the audio should be. The only reliable fix is to split the
 * song across generate + extend, which is what this does.
 *
 * Pipeline:  custom_generate (front half)
 *         -> extend_audio    (back half, from the end of the front)
 *         -> concat          (single continuous track)
 *         -> fade-out        (Suno endings cut abruptly)
 *   and verifies section coverage from word alignment at each stage.
 *
 * Usage:
 *   node scripts/make-track.mjs --file <lyrics.md> --title "01 Waffle Wednesday" \
 *     [--project <workspace-id>] [--split "Verse 3"] [--fade 6] [--dry]
 *
 *   --split TEXT   section heading that starts the BACK half (default: the
 *                  section at roughly the midpoint by character count)
 *   --dry          parse and print the plan, generate nothing
 *   --fade N       fade-out seconds (default 6; 0 to skip)
 *
 * Lyrics file format: a "## Lyrics" heading, then [Section] blocks. The style
 * prompt is read from the "## Suno Style Prompt" blockquote.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const API = args.api ?? 'http://localhost:3060';
const FADE = Number(args.fade ?? 6);
/**
 * Seconds to pause before each generate/extend call.
 *
 * Suno throttles by pacing, not by quota — a captcha wall appeared today after
 * ~15 back-to-back generations while the account was only 3.5% through its
 * monthly credits. Firing three calls per track with no gap is what triggers
 * it. Spacing them out is free and prevents the challenge rather than solving
 * it after the fact. --pace 0 to disable.
 */
const PACE_S = Number(args.pace ?? 30);
// Declared up here, not beside post(): it is read on the first post() call,
// which happens before a `let` further down the file would leave its TDZ.
let postSeq = 0;

if (!args.file) { console.error('Need --file <lyrics.md>. See header.'); process.exit(1); }
if (!existsSync(args.file)) { console.error(`Not found: ${args.file}`); process.exit(1); }

// Some lyric files are written with markdown escapes ("\[Verse 1]", "\~95 BPM")
// depending on which editor produced them. Unescape before parsing, or the
// section splitter sees no "[" at the start of a line and treats the whole
// song as one block.
const src = readFileSync(args.file, 'utf8').replace(/\\([[\]~*_`#])/g, '$1');
const title = args.title ?? (src.match(/^#\s+(.+)$/m)?.[1] ?? path.basename(args.file, '.md'));

// ---- parse the lyrics file -------------------------------------------------
const styleMatch = src.match(/##\s*Suno Style Prompt\s*\n>\s*([\s\S]*?)(?=\n##|\n$)/);
const style = (styleMatch?.[1] ?? '').replace(/\n>\s?/g, ' ').replace(/\s+/g, ' ').trim();
if (!style) { console.error('No "## Suno Style Prompt" blockquote found.'); process.exit(1); }

const lyricsMatch = src.match(/##\s*Lyrics\s*\n([\s\S]*?)(?=\n##\s|\n*$)/);
if (!lyricsMatch) { console.error('No "## Lyrics" section found.'); process.exit(1); }

// Split into [Section] blocks. Strip the prose out of headings — Suno treats
// "[Bridge — beat drops to just bass]" as tokens to place, not as a direction;
// production notes belong in the style prompt where they steer the mix.
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

// ---- choose the split point ------------------------------------------------
let splitIdx;
if (args.split) {
  splitIdx = blocks.findIndex((b) => b.heading.toLowerCase().includes(String(args.split).toLowerCase()));
  if (splitIdx < 1) { console.error(`--split "${args.split}" not found (or is the first section).`); process.exit(1); }
} else {
  const total = blocks.reduce((n, b) => n + b.text.length, 0);
  let run = 0;
  splitIdx = blocks.findIndex((b) => (run += b.text.length) > total / 2);
  if (splitIdx < 1) splitIdx = Math.max(1, Math.floor(blocks.length / 2));
}

const front = blocks.slice(0, splitIdx);
const back = blocks.slice(splitIdx);

console.log(`\n=== ${title} ===`);
console.log(`style : ${style.slice(0, 90)}...`);
console.log(`front : ${front.map((b) => b.heading).join(' · ')}`);
console.log(`back  : ${back.map((b) => b.heading).join(' · ')}`);
if (args.dry) { console.log('\n--dry: nothing generated.'); process.exit(0); }

// ---- run ------------------------------------------------------------------
const projectId = args.project;
// Persona ("Voice" in the UI) pins the singer. Without it every regeneration
// rolls a new voice, so fixing one wrong word in a lyric hands back a track
// sung by a stranger. Must be passed to BOTH halves or the song changes
// singer at the join.
const personaId = args.persona;

await pace('front half');
const p1 = post('/api/custom_generate', {
  prompt: front.map((b) => b.text).join('\n\n') + '\n',
  tags: style, title, make_instrumental: false, wait_audio: false,
  ...(projectId ? { project_id: projectId } : {}),
  ...(personaId ? { persona_id: personaId } : {})
});
const frontClip = await settle(p1.map((c) => c.id), 'front half');
await report(frontClip.id, front.length, 'front');

const cut = Math.max(1, (frontClip.duration ?? 0) - 3);
console.log(`\nextending from ${cut.toFixed(1)}s ...`);

await pace('back half');
const p2 = post('/api/extend_audio', {
  audio_id: frontClip.id, continue_at: cut,
  prompt: back.map((b) => b.text).join('\n\n') + '\n',
  tags: style, title, wait_audio: false,
  ...(projectId ? { project_id: projectId } : {}),
  ...(personaId ? { persona_id: personaId } : {})
});
const backClip = await settle(p2.map((c) => c.id), 'back half');
await report(backClip.id, back.length, 'back');

const cc = post('/api/concat', { clip_id: backClip.id, ...(projectId ? { project_id: projectId } : {}),
  ...(personaId ? { persona_id: personaId } : {}) });
const concatId = Array.isArray(cc) ? cc[0].id : cc.id;
const finalClip = await settle([concatId], 'concat');

const mins = `${Math.floor(finalClip.duration / 60)}:${String(Math.round(finalClip.duration % 60)).padStart(2, '0')}`;
console.log(`\nFINAL: ${finalClip.duration}s (${mins})  ${finalClip.id}`);
console.log(`  ${finalClip.audio_url}`);

if (FADE > 0) {
  console.log(`\napplying ${FADE}s fade...`);
  execFileSync('node', [path.join(path.dirname(process.argv[1]), 'fade-out.mjs'),
    '--clip', finalClip.id, '--seconds', String(FADE)], { stdio: 'inherit' });
}
if (finalClip.duration < 170) {
  console.warn(`\n! ${mins} is under 3:00 — consider a wider --split, or more material.`);
}

/** Space out generate calls so Suno does not raise a captcha challenge. */
async function pace(label) {
  if (!(PACE_S > 0)) return;
  console.log(`pacing ${PACE_S}s before ${label}...`);
  await new Promise((r) => setTimeout(r, PACE_S * 1000));
}

// ---------------------------------------------------------------- helpers

/**
 * POST via curl rather than fetch.
 *
 * Node's fetch (undici) enforces a headers timeout that fires long before Suno
 * answers a generate call, killing the run with UND_ERR_HEADERS_TIMEOUT while
 * the request is still perfectly healthy server-side. curl has no such limit.
 * The body goes via a temp file so long lyric sheets can't hit the command-line
 * length cap on Windows.
 *
 * max-time must comfortably EXCEED CAPTCHA_WAIT_MAX_S on the server (default
 * 600s). If they are equal, curl gives up at the exact moment the server is
 * still waiting out a rate limit, and a healthy request dies for nothing.
 */
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


/** GET via curl, same reasoning as post(). */
function get(route) {
  const out = execFileSync('curl', ['-s', '--max-time', '120', `${API}${route}`],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  try { return JSON.parse(out); } catch { return null; }
}

/** Poll until every id is terminal; return the LONGEST completed take. */
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

/**
 * Confirm every section actually got sung. A marker with a sub-0.15s duration
 * means Suno placed the heading but generated no audio for it — the silent
 * drop this whole script exists to avoid.
 */
async function report(id, expected, label) {
  try {
    const words = get(`/api/get_aligned_lyrics?song_id=${id}`);
    if (!Array.isArray(words)) { console.log(`  (${label}: no alignment yet)`); return; }
    const marks = words.filter((w) => /verse|chorus|bridge|intro|outro|drop|pre/i.test(w.word ?? ''));
    const dropped = marks.filter((w) => w.end_s - w.start_s < 0.15);
    console.log(`  ${label}: ${marks.length} markers found, expected ~${expected}`);
    if (dropped.length) {
      console.warn(`  ! ${dropped.length} look DROPPED (sub-0.15s): ` +
        dropped.map((w) => JSON.stringify((w.word ?? '').trim().slice(0, 18))).join(', '));
      console.warn('    Split the song further — that section produced no audio.');
    }
  } catch { console.log(`  (${label}: alignment unavailable)`); }
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
