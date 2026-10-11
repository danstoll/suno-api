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
 *     [--project <workspace-id>] [--fade 6] [--duration 4:30] [--dry]
 *
 *   --dry          parse and print the plan, generate nothing
 *   --fade N       fade-out seconds (default 6; 0 to skip)
 *   --duration D   target length — seconds ("270") or mm:ss ("4:30"). Sent as
 *                  the real `duration` field Suno's Custom Mode "Duration"
 *                  slider uses. Omit to let material decide (usually undershoots
 *                  a stated target — confirmed 2026-08-28: a 5:00-worth-of-material
 *                  track came back at 2:28 with no duration set).
 *   --style-weight, --weirdness   0-1 floats (default 0.9 / 0.2)
 *   --audio-weight N   0-1 float. Suno's "Audio Influence" slider. Only sent
 *                  when set — omit it for a track with nothing to steer from.
 *   --max-mode     Suno's "Max Mode" toggle. Sends metadata.is_max_mode: true.
 *                  Off by default, matching this fork's old behaviour. v6
 *                  tracks that need to run past ~2 minutes want this ON —
 *                  see CLAUDE.md's "Default model" section.
 *   --negative "a, b, c"          negative tags
 *   --model M      mv value (default chirp-hawk — Suno v6, "v6 Pro". Was
 *                  chirp-fenix (v5.5) before the 2026-09-13 v6 cutover; see
 *                  CLAUDE.md.)
 *
 * Lyrics file format: a "## Lyrics" heading, then [Section] blocks. The style
 * prompt is read from the "## Suno Style Prompt" blockquote. Same format as
 * make-track.mjs.
 *
 * WHY THIS POSTS TO /api/raw + /api/generate/v2-web/ INSTEAD OF THIS FORK'S
 * OWN /api/custom_generate: two bugs found 2026-08-28 via a live browser
 * capture (scripts/capture-suno-requests.js) made that wrapper untrustworthy
 * for this. (1) /api/custom_generate's route handler destructures
 * `style_weight`/`weirdness` off the request body and then never passes them
 * into custom_generate() — read but silently discarded, so every prior
 * one-shot render used Suno's defaults regardless of what was requested here.
 * (2) That wrapper's underlying generateSongs() targets the older
 * /api/generate/v2/ and has no `duration` field at all. The capture showed
 * the real web client posting to /api/generate/v2-web/ with a top-level
 * `duration` (seconds) that produced an exact-length render — going straight
 * at that proven shape beats guessing whether v2 (non-web) honors duration
 * too. Also replicates the web client's follow-up
 * POST /api/project/{id}/clips call, which CAPABILITIES.md notes is required
 * in addition to `project_id` on the generate call itself.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
const audioWeight = args["audio-weight"] !== undefined ? Number(args["audio-weight"]) : undefined;
const maxMode = Boolean(args["max-mode"]);
const negativeTags = args.negative ? String(args.negative) : undefined;
const model = args.model ? String(args.model) : 'chirp-hawk';
const duration = parseDuration(args.duration);

const genBody = {
  token: null,
  generation_type: 'TEXT',
  title,
  tags: style,
  negative_tags: negativeTags ?? '',
  mv: model,
  prompt: blocks.map((b) => b.text).join('\n\n') + '\n',
  make_instrumental: false,
  user_uploaded_images_b64: null,
  metadata: {
    create_mode: 'custom',
    is_max_mode: maxMode,
    control_sliders: {
      style_weight: styleWeight,
      weirdness_constraint: weirdness,
      ...(audioWeight !== undefined ? { audio_weight: audioWeight } : {})
    }
  },
  override_fields: [],
  cover_clip_id: null, cover_start_s: null, cover_end_s: null,
  persona_id: personaId ?? null,
  artist_clip_id: null, artist_start_s: null, artist_end_s: null,
  continue_clip_id: null, continued_aligned_prompt: null, continue_at: null,
  transaction_uuid: randomUUID(),
  token_provider: null,
  ...(projectId ? { project_id: projectId } : {}),
  ...(duration !== undefined ? { duration } : {})
};

const raw1 = post('/api/raw', { path: '/api/generate/v2-web/', method: 'POST', body: genBody });
if (raw1.suno_status !== 200) {
  // This raw path sends token/token_provider as null, bypassing this fork's
  // own getCaptcha()/keepAlive() flow that /api/custom_generate uses. If
  // Suno's /api/c/check is currently requiring a challenge, this is where it
  // shows up — a 400/403 here, not a hang. The fix is still the one in
  // CLAUDE.md ("Rate limiting, and how to clear it"): generate one song by
  // hand in the web UI, then re-run. This script has no automatic fallback.
  throw new Error(`generate/v2-web -> suno ${raw1.suno_status}: ${JSON.stringify(raw1.data).slice(0, 300)}\n` +
    `  If this looks auth/challenge-shaped (401/403), see CLAUDE.md's captcha-wall section — this path can't self-heal it.`);
}
const clips = raw1.data?.clips;
if (!Array.isArray(clips) || !clips.length) {
  throw new Error(`generate/v2-web -> no clips in response: ${JSON.stringify(raw1.data).slice(0, 300)}`);
}

// Matches the web client's own sequence (confirmed via capture): project_id
// on the generate call alone is not sufficient to file the clip. Suno
// returns 204 on success here — /api/raw always wraps with local HTTP 200,
// so `suno_status` is the field that actually says whether this worked; an
// unchecked call would let a 400/403 here pass as silent success while the
// (already-paid-for) clips land outside the intended workspace.
if (projectId) {
  const raw2 = post('/api/raw', {
    path: `/api/project/${projectId}/clips`, method: 'POST',
    body: { update_type: 'add', metadata: { clip_ids: clips.map((c) => c.id) } }
  });
  if (raw2.suno_status !== 204) {
    console.warn(`! Failed to file clip(s) into project ${projectId} (suno_status ${raw2.suno_status}): ` +
      `${JSON.stringify(raw2.data).slice(0, 200)}`);
    console.warn(`  Clip(s) generated fine but may be sitting in the default workspace — check manually: ` +
      clips.map((c) => c.id).join(', '));
  }
}

const finalClip = await settle(clips.map((c) => c.id), 'generate', duration);
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

/**
 * @param targetDuration  seconds, if a --duration was requested. `duration`
 *   the field turns out NOT to reliably constrain length — confirmed
 *   2026-08-28 across 4 live generations with it set: 330s target -> 329.8s,
 *   570s -> 242.3s, 360s -> 479.2s, 390s -> 204.8s. No correlation found with
 *   style_weight/weirdness or section count; looks like inherent per-take
 *   variance in how strictly the model honours it. Given that, "pick the
 *   longer of the 2 candidates" (the old default, still used when no target
 *   was given) is the wrong tiebreak once a duration WAS requested — picking
 *   whichever candidate actually landed closer to it is strictly more useful.
 */
async function settle(ids, label, targetDuration) {
  process.stdout.write(`${label}: `);
  for (let i = 0; i < 40; i++) {
    const clips = get(`/api/get?ids=${ids.join(',')}`) ?? [];
    const done = clips.filter((c) => c.status === 'complete');
    const failed = clips.filter((c) => c.status === 'error');
    if (done.length + failed.length >= clips.length && clips.length) {
      if (!done.length) throw new Error(`${label}: all takes errored — ${failed[0]?.error_message ?? 'no message'}`);
      const best = targetDuration
        ? done.sort((a, b) => Math.abs((a.duration ?? 0) - targetDuration) - Math.abs((b.duration ?? 0) - targetDuration))[0]
        : done.sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))[0];
      const all = done.map((c) => `${c.duration}s${c === best ? ' *' : ''}`).join(', ');
      console.log(`ok — candidates: ${all} (${done.length}/${clips.length} usable)`);
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

/**
 * "270" or "4:30" -> seconds. Throws rather than silently sending a bad
 * value — a NaN here JSON.stringifies to `null`, which would look to Suno
 * like "no duration set" and waste a full paid generation testing something
 * that was never actually going to hit the intended length.
 */
function parseDuration(v) {
  if (v === undefined || v === true) return undefined;
  const s = String(v).trim();
  let seconds;
  if (s.includes(':')) {
    const parts = s.split(':');
    if (parts.length !== 2) throw new Error(`--duration "${s}": expected mm:ss (one colon), not ${parts.length - 1}.`);
    const [m, sec] = parts.map(Number);
    if (!Number.isFinite(m) || !Number.isFinite(sec)) throw new Error(`--duration "${s}": not a valid mm:ss.`);
    seconds = m * 60 + sec;
  } else {
    seconds = Number(s);
    if (!Number.isFinite(seconds)) throw new Error(`--duration "${s}": not a number or mm:ss.`);
  }
  if (seconds <= 0) throw new Error(`--duration "${s}": must be positive (got ${seconds}s).`);
  return seconds;
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
