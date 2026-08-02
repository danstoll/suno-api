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
 *   --artist NAME artist folder; default "Daddy Wombat"
 *   --faded PATH  archive a local (faded) file instead of downloading the raw clip
 *   --force       overwrite an existing file rather than refusing
 *
 * Prefer --faded: Suno's raw endings cut abruptly, so the faded render is
 * normally the one worth keeping.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, writeFileSync, statSync } from 'node:fs';
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
const albumDir = path.join(ROOT, sanitise(ARTIST), sanitise(args.album));
mkdirSync(albumDir, { recursive: true });

const prefix = args.track ? `${String(args.track).padStart(2, '0')} ` : '';
const dest = path.join(albumDir, `${prefix}${sanitise(title)}.mp3`);

if (existsSync(dest) && !args.force) {
  console.error(`Refusing to overwrite ${dest} — pass --force if that's intended.`);
  process.exit(1);
}

copyFileSync(sourceFile, dest);
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
