#!/usr/bin/env node
/**
 * Download finished tracks to the local music library.
 *
 * The library on disk — not a Suno workspace — is the album. Workspaces can't
 * be ordered and fill up with generation fragments; playlists can be ordered
 * but still live inside Suno. Numbered files in album folders are ordered,
 * permanent, playable anywhere, and survive anything Suno changes.
 *
 * Layout: <root>\<Artist>\<Album>\NN Title.mp3
 *
 * Usage:
 *   node scripts/archive-track.mjs --clip <id> --album "Mi Casa" --track 01
 *   node scripts/archive-track.mjs --clip <id> --album "Celebration"   # no number
 *   node scripts/archive-track.mjs --faded faded/01-Waffle.faded.mp3 \
 *        --album "Mi Casa" --track 01 --title "Waffle Wednesday"
 *
 * Options:
 *   --root PATH   library root; default \\Storage\Media\Music
 *   --artist NAME artist folder + ID3 artist; default "Daddy Wombat"
 *   --total N     total tracks, for "3/10" style numbering
 *   --genre TEXT  ID3 genre; default "Children's Music"
 *   --year N      ID3 year; default current year
 *   --cover PATH  cover art file or URL; default is the clip's own Suno artwork
 *   --faded PATH  archive a local (faded) file instead of downloading the raw clip
 *   --force       overwrite an existing file rather than refusing
 *
 * Prefer --faded: Suno's raw endings cut abruptly, so the faded render is
 * normally the one worth keeping.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const API = args.api ?? 'http://localhost:3060';
const ROOT = args.root ?? '\\\\Storage\\Media\\Music';

if (!args.clip && !args.faded) {
  console.error('Need --clip <id> or --faded <path>. See header.');
  process.exit(1);
}
if (!args.album) { console.error('Need --album "<name>".'); process.exit(1); }

let title = args.title;
let sourceFile = args.faded;

if (args.clip) {
  const clips = JSON.parse(execFileSync('curl',
    ['-s', '--max-time', '120', `${API}/api/get?ids=${args.clip}`], { encoding: 'utf8', maxBuffer: 32e6 }));
  const clip = clips?.[0];
  if (!clip) throw new Error(`Clip ${args.clip} not found — is the dev server running?`);
  if (clip.status !== 'complete') throw new Error(`Clip is "${clip.status}", not complete.`);
  if (!clip.audio_url) throw new Error('Clip has no audio_url.');
  title = title ?? stripTrackNumber(clip.title);
  if (!sourceFile) {
    const tmp = path.join(process.cwd(), `.archive-${args.clip.slice(0, 8)}.mp3`);
    console.log(`Downloading "${clip.title}" (${clip.duration}s)...`);
    execFileSync('curl', ['-s', '--max-time', '600', '-o', tmp, clip.audio_url], { stdio: 'inherit' });
    sourceFile = tmp;
  }
}

if (!sourceFile || !existsSync(sourceFile)) throw new Error(`Source not found: ${sourceFile}`);
if (!title) title = path.basename(sourceFile).replace(/\.(faded|src)?\.?mp3$/i, '');

// F:\music\<Artist>\<Album>\NN Title.mp3 — the layout every music player and
// media server already expects, so the library is browsable without extra work.
const ARTIST = args.artist ?? 'Daddy Wombat';
// True only when fetchCover downloaded a throwaway file that we should clean up.
let coverIsTemp = true;
const albumDir = path.join(ROOT, sanitise(ARTIST), sanitise(args.album));
mkdirSync(albumDir, { recursive: true });

const prefix = args.track ? `${String(args.track).padStart(2, '0')} ` : '';
const dest = path.join(albumDir, `${prefix}${sanitise(title)}.mp3`);

if (existsSync(dest) && !args.force) {
  console.error(`Refusing to overwrite ${dest} — pass --force if that's intended.`);
  process.exit(1);
}

await writeTagged(sourceFile, dest);
const kb = Math.round(statSync(dest).size / 1024);
console.log(`\nArchived: ${dest}  (${kb} KB)`);

// A sidecar note so a track can be traced back to the clip it came from,
// which matters once there are several takes of the same song.
if (args.clip) {
  writeFileSync(dest.replace(/\.mp3$/, '.txt'),
    `title:    ${title}\nalbum:    ${args.album}\ntrack:    ${args.track ?? '-'}\n` +
    `clip_id:  ${args.clip}\nsource:   ${sourceFile === args.faded ? 'faded render' : 'suno cdn'}\n`);
}

// ---------------------------------------------------------------- helpers

/**
 * Copy to the library with proper ID3 tags and embedded cover art.
 *
 * Suno's MP3s arrive with nothing but a "made with suno" comment — no title,
 * artist, album or track number — so a media server shows them as untitled
 * files that refuse to group into an album. Plex in particular keys off
 * album_artist for grouping, and wants the artwork embedded rather than
 * alongside.
 *
 * ID3v2.3 specifically: it is the version every player agrees on. v2.4 is
 * newer and technically better, and is exactly the sort of thing that makes a
 * track show up blank in one app and fine in another.
 */
async function writeTagged(srcMp3, destMp3) {
  const meta = {
    title,
    artist: ARTIST,
    album_artist: ARTIST,
    album: args.album,
    genre: args.genre ?? "Children's Music",
    date: String(args.year ?? new Date().getFullYear())
  };
  if (args.track) meta.track = args.total ? `${Number(args.track)}/${args.total}` : String(Number(args.track));
  if (args.comment) meta.comment = args.comment;

  const cover = await fetchCover();

  const cmd = ['-v', 'error', '-y', '-i', srcMp3];
  if (cover) cmd.push('-i', cover);
  // Copy the audio untouched — this is a tagging pass, not a re-encode.
  cmd.push('-map', '0:a', '-c:a', 'copy');
  if (cover) cmd.push('-map', '1:v', '-c:v', 'mjpeg', '-disposition:v:0', 'attached_pic',
                      '-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)');
  cmd.push('-id3v2_version', '3', '-write_id3v1', '1');
  for (const [k, v] of Object.entries(meta)) cmd.push('-metadata', `${k}=${v}`);
  cmd.push(destMp3);

  try {
    execFileSync('ffmpeg', cmd, { stdio: 'inherit' });
    console.log(`  tagged: ${meta.artist} — ${meta.album}${meta.track ? ` [${meta.track}]` : ''}${cover ? ' + cover' : ' (no cover)'}`);
  } catch (e) {
    // Never lose the audio because tagging failed.
    console.warn('  ! tagging failed, copying untagged:', e?.message ?? e);
    copyFileSync(srcMp3, destMp3);
  } finally {
    // ONLY delete a cover we downloaded ourselves. An earlier version deleted
    // whatever path fetchCover returned — which for --cover is the user's own
    // artwork file, so the first track consumed it and every later track found
    // nothing. Destroyed two generated album covers before it was spotted.
    if (cover && coverIsTemp) { try { rmSync(cover, { force: true }); } catch { /* best effort */ } }
  }
}

/** Cover art: --cover <file|url> wins, else the clip's own Suno artwork. */
async function fetchCover() {
  let url = args.cover;
  if (url && existsSync(url)) { coverIsTemp = false; return url; } // user file — never delete
  if (!url && args.clip) {
    try {
      // /api/clip, not /api/get — the feed mapping drops image_large_url, so
      // asking the wrong endpoint silently yields the 360x360 version. Large
      // is 1024x1024, which is what a TV or phone actually needs.
      const c = JSON.parse(execFileSync('curl',
        ['-s', '--max-time', '60', `${API}/api/clip?id=${args.clip}`], { encoding: 'utf8', maxBuffer: 32e6 }));
      url = c?.image_large_url || c?.image_url;
    } catch { /* fall through to no cover */ }
  }
  if (!url) return null;
  const tmp = path.join(process.cwd(), `.cover-${process.pid}.jpg`);
  try {
    execFileSync('curl', ['-s', '--max-time', '120', '-o', tmp, url], { stdio: 'ignore' });
    return existsSync(tmp) && statSync(tmp).size > 1000 ? tmp : null;
  } catch { return null; }
}

/** "01 Waffle Wednesday" -> "Waffle Wednesday" (the number comes from --track) */
function stripTrackNumber(s) {
  return String(s ?? '').replace(/^\s*\d{1,2}[\s.\-_]+/, '').trim();
}

/** Windows forbids \ / : * ? " < > | in names. */
function sanitise(s) {
  return String(s).replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
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
