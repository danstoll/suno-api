#!/usr/bin/env node
/**
 * Download every song in a Suno playlist, in playlist order.
 *
 * Usage:
 *   node scripts/download-playlist.mjs --playlist <url-or-id> [--out dir] [--format wav|mp3|both]
 *
 * Options:
 *   --playlist X  a suno.com/playlist/<id> link or the bare id
 *   --out DIR     output folder; default playlists/<playlist name>
 *   --format F    wav (default), mp3 (320k, tagged), or both
 *   --only N      download only track N (for a test)
 *   --api URL     suno-api base; default http://localhost:3060
 *
 * The script reads the playlist from Suno's public playlist endpoint. That
 * endpoint needs no login. It gives the title, Style, Exclude and lyrics of
 * each clip.
 *
 * The audio comes from Suno's own WAV export through /api/raw:
 * POST /api/gen/{id}/convert_wav/, then poll GET /api/gen/{id}/wav_file/ for
 * wav_file_url. This path uses your Suno login, so it works only for clips
 * that your account can export. A Pro or Premier plan is necessary.
 *
 * For each track the script writes:
 *   NN Title.wav and/or NN Title.mp3
 *   NN Title.txt   Style, Exclude, lyrics, clip id and model
 * It also writes playlist.json with the raw playlist data.
 *
 * The script skips a track when its output file exists. Run it again to
 * continue after a failure.
 *
 * Requires ffmpeg on PATH for --format mp3 or both.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PUBLIC_API = 'https://studio-api-prod.suno.com';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const args = parseArgs(process.argv.slice(2));
const API = args.api ?? 'http://localhost:3060';
const FORMAT = typeof args.format === 'string' ? args.format : 'wav';
const ONLY = args.only === undefined ? null : Number(args.only);

const playlistId = String(args.playlist ?? '').match(UUID_RE)?.[0]?.toLowerCase();
if (!playlistId) {
  console.error('Need --playlist <suno.com/playlist/... link or id>. See header for usage.');
  process.exit(1);
}
if (!['wav', 'mp3', 'both'].includes(FORMAT)) {
  console.error(`--format must be wav, mp3 or both, got '${args.format}'`);
  process.exit(1);
}
if (ONLY !== null && !Number.isInteger(ONLY)) {
  console.error(`--only must be a track number, got '${args.only}'`);
  process.exit(1);
}

const playlist = await fetchPlaylist(playlistId);
const clips = playlist.clips;
const outDir = path.resolve(args.out ?? path.join('playlists', cleanName(playlist.name)));
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'playlist.json'), JSON.stringify(playlist, null, 2));

console.log(`Playlist "${playlist.name}": ${clips.length} tracks -> ${outDir}\n`);

const pad = String(clips.length).length < 2 ? 2 : String(clips.length).length;
const failed = [];

for (const [i, clip] of clips.entries()) {
  const number = i + 1;
  if (ONLY !== null && number !== ONLY) continue;

  const base = `${String(number).padStart(pad, '0')} ${cleanName(clip.title || clip.id)}`;
  const wavPath = path.join(outDir, `${base}.wav`);
  const mp3Path = path.join(outDir, `${base}.mp3`);
  writeFileSync(path.join(outDir, `${base}.txt`), promptSheet(clip));

  const wantWav = FORMAT !== 'mp3';
  const wantMp3 = FORMAT !== 'wav';
  if ((!wantWav || existsSync(wavPath)) && (!wantMp3 || existsSync(mp3Path))) {
    console.log(`[${number}] skip, already here: ${base}`);
    continue;
  }

  try {
    console.log(`[${number}] ${clip.title} (${clip.id})`);
    if (!existsSync(wavPath)) {
      const url = await wavUrl(clip.id);
      await download(url, wavPath);
    }
    if (wantMp3 && !existsSync(mp3Path)) {
      toMp3(wavPath, mp3Path, clip, number, clips.length, playlist.name);
    }
    // The WAV is only a step to the MP3 when the user did not ask for it.
    if (!wantWav) rmSync(wavPath, { force: true });
    console.log(`     done`);
  } catch (err) {
    console.error(`     FAILED: ${err.message}`);
    failed.push(`${number} ${clip.title}: ${err.message}`);
  }
}

if (failed.length) {
  console.error(`\n${failed.length} track(s) failed. Run the same command again to retry:`);
  for (const f of failed) console.error(`  ${f}`);
  process.exit(1);
}
console.log('\nAll tracks done.');

// ---------------------------------------------------------------- helpers

/**
 * Read all pages of the playlist. The public endpoint is tried first. If it
 * fails (for example, a private playlist), the script asks again through
 * /api/raw with your login.
 */
async function fetchPlaylist(id) {
  const clips = [];
  let name = '';
  for (let page = 1; page <= 50; page++) {
    const sunoPath = `/api/playlist/${id}/?page=${page}`;
    let data;
    const res = await fetch(`${PUBLIC_API}${sunoPath}`).catch(() => null);
    if (res?.ok) data = await res.json();
    else data = await rawGet(sunoPath);

    name ||= data.name || `Playlist ${id.slice(0, 8)}`;
    const items = data.playlist_clips ?? [];
    for (const item of items) if (item?.clip?.id) clips.push(item.clip);

    const total = data.num_total_results ?? clips.length;
    if (!items.length || clips.length >= total) break;
  }
  if (!clips.length) throw new Error(`Playlist ${id} has no clips, or Suno did not return them.`);
  return { id, name, clips };
}

/** Ask Suno to make the WAV, then wait for its download URL. */
async function wavUrl(clipId) {
  try {
    await rawPost(`/api/gen/${clipId}/convert_wav/`, null);
  } catch (err) {
    if (/\b402\b/.test(err.message)) throw new Error(`WAV requires Suno Pro or Premier: ${err.message}`);
    if (/\b403\b/.test(err.message)) throw new Error(`Clip ${clipId} is not WAV-convertible (not your clip?): ${err.message}`);
    console.warn(`     (convert_wav trigger failed, polling anyway: ${err.message})`);
  }

  let lastError;
  for (let i = 0; i < 40; i++) {
    try {
      const d = await rawGet(`/api/gen/${clipId}/wav_file/`);
      if (d?.wav_file_url) return d.wav_file_url;
    } catch (err) {
      lastError = err;
    }
    await sleep(3000);
  }
  const suffix = lastError ? ` (last poll error: ${lastError.message})` : '';
  throw new Error(`WAV conversion did not finish after 120s${suffix}`);
}

async function download(url, file) {
  const res = await fetch(url);
  // The URL holds temporary AWS keys. Do not put the query in the error text.
  if (!res.ok) throw new Error(`Download failed: ${res.status} (${url.split('?')[0]})`);
  const part = `${file}.part`;
  writeFileSync(part, Buffer.from(await res.arrayBuffer()));
  execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', part]);
  rmSync(file, { force: true });
  // Rename only after ffprobe reads the file, so a broken download is never kept.
  renameSync(part, file);
}

function toMp3(wav, mp3, clip, number, total, album) {
  const meta = clip.metadata ?? {};
  const tags = {
    title: clip.title ?? '',
    track: `${number}/${total}`,
    album,
    artist: clip.display_name ?? '',
    comment: `Suno ${clip.id}`,
    lyrics: meta.prompt ?? ''
  };
  const cmd = ['-v', 'error', '-y', '-i', wav, '-c:a', 'libmp3lame', '-b:a', '320k', '-id3v2_version', '3'];
  for (const [k, v] of Object.entries(tags)) if (v) cmd.push('-metadata', `${k}=${v}`);
  cmd.push(mp3);
  execFileSync('ffmpeg', cmd, { stdio: 'inherit' });
}

function promptSheet(clip) {
  const meta = clip.metadata ?? {};
  return [
    `Title: ${clip.title ?? ''}`,
    `Clip: https://suno.com/song/${clip.id}`,
    `Model: ${clip.major_model_version ?? ''} (${clip.model_name ?? ''})`,
    `Duration: ${meta.duration ?? ''}s`,
    '',
    '## Style',
    meta.tags ?? '',
    '',
    '## Exclude',
    meta.negative_tags ?? '',
    '',
    '## Lyrics',
    meta.prompt ?? '',
    ''
  ].join('\n');
}

async function rawGet(sunoPath) {
  const res = await fetch(`${API}/api/raw?path=${encodeURIComponent(sunoPath)}`).catch((err) => {
    throw new Error(`${API} is not reachable (${err.message}). Start it with: npm run dev -- -p 3060`);
  });
  const json = await parseRawResponse(res, sunoPath);
  if (json?.suno_status !== 200) {
    throw new Error(`${sunoPath} -> suno ${json?.suno_status}: ${JSON.stringify(json?.data ?? null).slice(0, 200)}`);
  }
  return json.data;
}

async function rawPost(sunoPath, body) {
  const res = await fetch(`${API}/api/raw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: sunoPath, method: 'POST', body })
  }).catch((err) => {
    throw new Error(`${API} is not reachable (${err.message}). Start it with: npm run dev -- -p 3060`);
  });
  const json = await parseRawResponse(res, sunoPath);
  if (json?.suno_status !== 200 && json?.suno_status !== 204) {
    throw new Error(`${sunoPath} -> suno ${json?.suno_status}: ${JSON.stringify(json?.data ?? null).slice(0, 200)}`);
  }
  return json.data;
}

async function parseRawResponse(res, sunoPath) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${sunoPath} -> /api/raw returned non-JSON (local HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
}

/** Keep spaces and case. Remove only the characters that Windows forbids. */
function cleanName(s) {
  return String(s).replace(/[<>:"/\\|?*\x00-\x1f]+/g, '').replace(/\s+/g, ' ').trim().replace(/\.+$/, '').slice(0, 100) || 'track';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
