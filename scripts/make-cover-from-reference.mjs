#!/usr/bin/env node
/**
 * Upload outside audio as a Suno "cover" reference, then generate against it
 * combined with a track's own style prompt + lyrics — the full flow captured
 * live from the Suno web UI on 2026-08-29 (browser capture, "01 Single
 * Thread" upload -> cover generate), reproduced end to end here.
 *
 * Sequence (every field below is captured, not guessed):
 *   1. POST /api/uploads/audio/                     -> presigned S3 upload
 *   2. (upload raw bytes to S3)
 *   3. POST /api/uploads/audio/{id}/upload-finish/
 *   4. POST /api/uploads/audio/{id}/initialize-clip/  {"user_reviewed_tags": true}
 *      -> {clip_id}   <- THE FIX: an empty body 400s here; this field doesn't.
 *   5. POST /api/gen/{clip_id}/set_metadata/
 *   6. POST /api/gen/{clip_id}/set_audio_description
 *   7. POST /api/project/{id}/clips                  {update_type:"add", ...}
 *   8. POST /api/lyrics-projects  -> id, then POST .../flush {lyrics}
 *   9. POST /api/generate/v2-web/  {task:"cover", cover_clip_id, ...}
 *  10. POST /api/project/{id}/clips again, for the new generated clip(s)
 *
 * IMPORTANT, confirmed 2026-08-29: `audio_url` in /api/get responses now
 * always reads "https://studio-api.prod.suno.com/api/forbidden" — that is a
 * benign placeholder, NOT a content block. Use fade-out.mjs (which downloads
 * via increment_action_count + /api/download/clip polling) to actually check
 * a clip, never audio_url directly.
 *
 * KNOWN LIMITATION, also confirmed 2026-08-29: a cover generation's output
 * duration tracks the REFERENCE clip's own length, not the `duration` field
 * sent here — Single Thread's 184.6s reference produced 177.9s/188.2s
 * outputs against a requested 330s. Pass --duration anyway (cheap, may help
 * at the margin) but expect the result to land near the reference's own
 * length, not the target.
 *
 * Usage:
 *   node scripts/make-cover-from-reference.mjs --file <reference.mp3> \
 *     --lyrics-file <track.md> --title "06 Tightest Weave" \
 *     --project 30271698-66e9-4520-ace5-8c2cbf22b47e \
 *     --description "..." [--duration 330] [--audio-weight 0.5] \
 *     [--style-weight 0.65] [--weirdness 0.30] [--fade 6]
 *
 * --lyrics-file reads the same "## Suno Style Prompt" / "## Lyrics" markdown
 * format make-track-oneshot.mjs uses, for `tags` / `prompt`.
 * --description is the required user_corrected_description for the upload's
 * set_audio_description call — write what's actually audible in the
 * reference file; this is not optional (Suno needs it to review the upload).
 *
 * KNOWN BLOCKER, confirmed 2026-08-29: steps 1-4 (upload -> initialize-clip)
 * 400 with an EMPTY body through this fork's /api/raw client — even after
 * fixing a real Device-Id header bug (was double/mis-quoted, see SunoApi.ts),
 * and even on a file proven seconds earlier to upload fine via a real
 * browser. Unlike every other Suno error seen in this project, the body is
 * empty (no detail/error_type), which smells like a WAF/bot check in front
 * of the app on this specific upload-review endpoint rather than a header
 * this client can fix by copying values off a capture.
 *
 * WORKAROUND: do the upload by hand in Suno's web UI (Cover -> pick file),
 * copy the `clip_id` the browser's own initialize-clip response returns
 * (Network tab, or capture-suno-requests.js), then pass it here directly:
 *
 *   node scripts/make-cover-from-reference.mjs --cover-clip-id <id> \
 *     --lyrics-file <track.md> --title "06 Tightest Weave" \
 *     --project 30271698-66e9-4520-ace5-8c2cbf22b47e [--duration 330] ...
 *
 * This skips steps 1-7 entirely (the browser's own upload UI already did
 * set_metadata/set_audio_description/add-to-project) and goes straight to
 * the lyrics-project + generate call, which are confirmed working via
 * /api/raw. --file/--description are not required in this mode.
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

const coverClipIdArg = args['cover-clip-id'] ? String(args['cover-clip-id']) : undefined;

if (!coverClipIdArg && !args.file) { console.error('Need --file <reference-audio> (or --cover-clip-id <id> to skip upload). See header.'); process.exit(1); }
if (!args['lyrics-file']) { console.error('Need --lyrics-file <track.md>. See header.'); process.exit(1); }
if (!args.title) { console.error('Need --title "<name>".'); process.exit(1); }
if (!coverClipIdArg && !args.description) { console.error('Need --description "<what is actually audible in the reference file>" (not required with --cover-clip-id).'); process.exit(1); }
if (!coverClipIdArg && !existsSync(args.file)) { console.error(`Not found: ${args.file}`); process.exit(1); }
if (!existsSync(args['lyrics-file'])) { console.error(`Not found: ${args['lyrics-file']}`); process.exit(1); }

const src = readFileSync(args['lyrics-file'], 'utf8').replace(/\\([[\]~*_`#])/g, '$1');
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
const lyricsText = blocks.map((b) => b.text).join('\n\n') + '\n';

const negativeTags = args.negative ? String(args.negative) : 'vocals, screaming, growls, spoken word, blast beats, chaotic glitch, noise, laughter, crowd noise, applause';
const model = args.model ? String(args.model) : 'chirp-fenix';
const projectId = args.project;
const styleWeight = args['style-weight'] !== undefined ? Number(args['style-weight']) : 0.75;
const weirdness = args.weirdness !== undefined ? Number(args.weirdness) : 0.2;
const audioWeight = args['audio-weight'] !== undefined ? Number(args['audio-weight']) : 0.5;
const duration = parseDuration(args.duration);

console.log(`\n=== ${args.title} (cover from reference) ===`);
console.log(`reference : ${coverClipIdArg ? `(pre-uploaded clip ${coverClipIdArg})` : args.file}`);
console.log(`style     : ${style.slice(0, 90)}...`);
console.log(`sections  : ${blocks.map((b) => b.heading).join(' · ')}`);
console.log(`sliders   : style ${styleWeight} / weirdness ${weirdness} / audio ${audioWeight}`);
if (args.dry) { console.log('\n--dry: nothing uploaded or generated.'); process.exit(0); }

let clipId = coverClipIdArg;

if (clipId) {
  console.log(`\nSkipping upload — using pre-uploaded reference clip ${clipId}`);
} else {
  // ---- 1-4. Upload the reference audio and turn it into a clip -----------

  const filePath = args.file;
  const ext = String(args.extension ?? path.extname(filePath).replace(/^\./, '')).toLowerCase();
  const fileName = path.basename(filePath);

  console.log(`\nUploading "${fileName}" as .${ext} ...`);
  const uploadReq = post('/api/raw', { path: '/api/uploads/audio/', method: 'POST', body: { extension: ext, upload_type: 'file_upload' } });
  if (uploadReq.suno_status !== 200) throw new Error(`upload slot -> suno ${uploadReq.suno_status}: ${JSON.stringify(uploadReq.data).slice(0, 300)}`);
  const { url, fields, id: uploadId } = uploadReq.data ?? {};
  if (!url || !uploadId) throw new Error(`Unexpected upload-slot response: ${JSON.stringify(uploadReq.data)}`);

  const fileBuf = readFileSync(filePath);
  if (fields && Object.keys(fields).length) {
    // Presigned POST straight to S3. `-o /dev/null` isn't reliable from a
    // native Windows curl.exe spawned via execFileSync (curl exit 23, "write
    // error", even though the real HTTP response came through fine) — so
    // capture stdout directly (S3's success body is empty or tiny) with the
    // status code appended on its own line instead, and read err.stdout too
    // since execFileSync still populates it on a non-zero exit.
    const curlArgs = ['-s', '-w', '\n%{http_code}', '-X', 'POST', url,
      ...Object.entries(fields).flatMap(([k, v]) => ['-F', `${k}=${v}`]), '-F', `file=@${filePath}`];
    let out;
    try {
      out = execFileSync('curl', curlArgs, { encoding: 'utf8' });
    } catch (err) {
      out = err.stdout ?? '';
      if (!out) throw err;
    }
    const lines = out.trim().split('\n');
    const code = lines[lines.length - 1];
    console.log(`  S3 POST -> ${code}`);
    if (!code.startsWith('2')) throw new Error(`S3 upload failed: HTTP ${code}: ${lines.slice(0, -1).join('\n').slice(0, 300)}`);
  } else {
    const res = await fetch(url, { method: 'PUT', body: fileBuf });
    if (!res.ok) throw new Error(`S3 upload (PUT) failed: ${res.status}`);
    console.log(`  S3 PUT -> ${res.status}`);
  }

  const finishRes = post('/api/raw', { path: `/api/uploads/audio/${uploadId}/upload-finish/`, method: 'POST',
    body: { upload_type: 'file_upload', upload_filename: fileName, agreed_to_vip_upload_terms: false } });
  if (finishRes.suno_status !== 200) throw new Error(`upload-finish -> suno ${finishRes.suno_status}: ${JSON.stringify(finishRes.data).slice(0, 300)}`);
  console.log(`  upload-finish: ok — ${JSON.stringify(finishRes.data).slice(0, 200)}`);

  // initialize-clip has consistently 400'd with an EMPTY body through this
  // client (see header comment) — retrying doesn't help, this is left in
  // case a future fix (or a Suno-side change) makes it start working again.
  let clipRes;
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (attempt > 1) { console.log(`  initialize-clip attempt ${attempt}, waiting ${(attempt - 1) * 3}s...`); await new Promise((r) => setTimeout(r, (attempt - 1) * 3000)); }
    clipRes = post('/api/raw', { path: `/api/uploads/audio/${uploadId}/initialize-clip/`, method: 'POST',
      body: { user_reviewed_tags: true } });
    if (clipRes.suno_status === 200) { clipId = clipRes.data?.clip_id; break; }
    console.log(`  initialize-clip -> suno ${clipRes.suno_status}: ${JSON.stringify(clipRes.data).slice(0, 300)}`);
  }
  if (!clipId) throw new Error(`initialize-clip failed after retries: ${JSON.stringify(clipRes.data)}. ` +
    `Try the --cover-clip-id workaround described in this script's header comment.`);
  console.log(`  reference clip: ${clipId}`);

  // ---- 5-7. Metadata, description, add to project -------------------------

  post('/api/raw', { path: `/api/gen/${clipId}/set_metadata/`, method: 'POST',
    body: { title: fileName.replace(/\.[^.]+$/, ''), image_url: null, is_audio_upload_tos_accepted: true } });
  console.log('  set_metadata: ok');

  post('/api/raw', { path: `/api/gen/${clipId}/set_audio_description`, method: 'POST',
    body: { gemini_description_accepted: false, user_corrected_description: args.description, audio_content_types: ['Instrument Stem'] } });
  console.log('  set_audio_description: ok');

  if (projectId) {
    const addRef = post('/api/raw', { path: `/api/project/${projectId}/clips`, method: 'POST',
      body: { update_type: 'add', metadata: { clip_ids: [clipId] } } });
    if (addRef.suno_status !== 204) console.warn(`  ! failed to file reference clip into project (suno_status ${addRef.suno_status})`);
    else console.log('  added reference clip to project: ok');
  }
}

// ---- 8. Lyrics project -----------------------------------------------------

const lpRes = post('/api/raw', { path: '/api/lyrics-projects', method: 'POST', body: { title: '' } });
if (lpRes.suno_status !== 200) throw new Error(`lyrics-projects -> suno ${lpRes.suno_status}: ${JSON.stringify(lpRes.data).slice(0, 300)}`);
const lyricsProjectId = lpRes.data?.id;
if (!lyricsProjectId) throw new Error(`lyrics-projects didn't return an id: ${JSON.stringify(lpRes.data)}`);
const flushRes = post('/api/raw', { path: `/api/lyrics-projects/${lyricsProjectId}/flush`, method: 'POST', body: { lyrics: lyricsText } });
if (flushRes.suno_status !== 200 && flushRes.suno_status !== 204) throw new Error(`lyrics flush -> suno ${flushRes.suno_status}`);
console.log(`  lyrics-project: ${lyricsProjectId}`);

// ---- 9. The actual cover generation ---------------------------------------

const genBody = {
  ...(projectId ? { project_id: projectId } : {}),
  token: null,
  task: 'cover',
  generation_type: 'TEXT',
  title: args.title,
  tags: style,
  negative_tags: negativeTags,
  mv: model,
  prompt: lyricsText,
  make_instrumental: false,
  user_uploaded_images_b64: null,
  metadata: {
    web_client_pathname: '/create',
    is_max_mode: false,
    is_mumble: false,
    create_mode: 'custom',
    disable_volume_normalization: false,
    control_sliders: { weirdness_constraint: weirdness, style_weight: styleWeight, audio_weight: audioWeight },
    is_remix: true
  },
  override_fields: [],
  cover_clip_id: clipId,
  persona_id: null,
  artist_clip_id: null, artist_start_s: null, artist_end_s: null,
  continue_clip_id: null, continued_aligned_prompt: null, continue_at: null,
  transaction_uuid: randomUUID(),
  token_provider: null,
  lyrics_project_id: lyricsProjectId,
  ...(duration !== undefined ? { duration } : {})
};

console.log('\nGenerating cover...');
const raw1 = post('/api/raw', { path: '/api/generate/v2-web/', method: 'POST', body: genBody });
if (raw1.suno_status !== 200) {
  throw new Error(`generate/v2-web -> suno ${raw1.suno_status}: ${JSON.stringify(raw1.data).slice(0, 300)}\n` +
    `  If this looks auth/challenge-shaped (401/403), see CLAUDE.md's captcha-wall section.`);
}
const clips = raw1.data?.clips;
if (!Array.isArray(clips) || !clips.length) throw new Error(`generate/v2-web -> no clips in response: ${JSON.stringify(raw1.data).slice(0, 300)}`);
console.log(`  submitted: ${clips.map((c) => c.id).join(', ')}`);

if (projectId) {
  const raw2 = post('/api/raw', { path: `/api/project/${projectId}/clips`, method: 'POST',
    body: { update_type: 'add', metadata: { clip_ids: clips.map((c) => c.id) } } });
  if (raw2.suno_status !== 204) {
    console.warn(`! Failed to file clip(s) into project ${projectId} (suno_status ${raw2.suno_status})`);
  }
}

const finalClip = await settle(clips.map((c) => c.id), 'generate', duration);
const mins = `${Math.floor(finalClip.duration / 60)}:${String(Math.round(finalClip.duration % 60)).padStart(2, '0')}`;
console.log(`\nFINAL: ${finalClip.duration}s (${mins})  ${finalClip.id}`);
console.log('  (audio_url may read "forbidden" — that is a benign placeholder; fade-out.mjs downloads via the real path)');

if (FADE > 0) {
  console.log(`\napplying ${FADE}s fade...`);
  execFileSync('node', [path.join(path.dirname(process.argv[1]), 'fade-out.mjs'),
    '--clip', finalClip.id, '--seconds', String(FADE)], { stdio: 'inherit' });
}

// ---------------------------------------------------------------- helpers

function post(route, body) {
  const tmp = path.join(os.tmpdir(), `suno-cover-post-${process.pid}-${postSeq++}.json`);
  writeFileSync(tmp, JSON.stringify(body));
  try {
    const out = execFileSync('curl', [
      '-s', '--max-time', '1500', '-X', 'POST', `${API}${route}`,
      '-H', 'Content-Type: application/json', '--data-binary', `@${tmp}`
    ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    let parsed;
    try { parsed = JSON.parse(out); }
    catch { throw new Error(`${route} -> unparseable response: ${out.slice(0, 300)}`); }
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

function parseDuration(v) {
  if (v === undefined || v === true) return undefined;
  const s = String(v).trim();
  let seconds;
  if (s.includes(':')) {
    const parts = s.split(':');
    if (parts.length !== 2) throw new Error(`--duration "${s}": expected mm:ss.`);
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
