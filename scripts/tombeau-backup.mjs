// READ-ONLY. Snapshot every Tombeau clip's full metadata (style prompt, lyrics,
// cover ids) plus the playlist record, before anything is written.
//
// Uses /api/clip/{id} rather than the feed: only that route returns
// image_large_url, and it carries the full prompt/lyric text.
import { writeFileSync, mkdirSync } from 'node:fs';
import { rawGet } from './tombeau-lib.mjs';

const PLAYLIST = '0cee9fe6-91fc-4d1e-bfae-e7035ad99ebc';
const GIGUE = '93b3ed5e-912d-490e-8698-7262b8021944'; // track 9, not on the playlist

const pl = await rawGet(`/api/playlist/${PLAYLIST}/?page=0`);
const plV2 = await rawGet(`/api/playlist/v2/${PLAYLIST}`);

const ids = (pl.data.playlist_clips || []).map(pc => pc.clip.id);
if (!ids.includes(GIGUE)) ids.push(GIGUE);

const clips = [];
for (const id of ids) {
  const r = await rawGet(`/api/clip/${id}`);
  if (r.suno_status !== 200) { console.log(`!! ${id} -> ${r.suno_status}`); continue; }
  clips.push(r.data);
  const d = r.data;
  const trackNo = (d.title || '').match(/^(\d+)\./)?.[1] ?? '?';
  console.log(
    `${String(trackNo).padStart(2)}  ${d.id}  ${d.status.padEnd(9)} ` +
    `lyrics=${(d.metadata?.prompt || '').length}ch style=${(d.metadata?.tags || '').length}ch  ${d.title}`
  );
}

const out = {
  captured_at: new Date().toISOString(),
  note: 'Read-only snapshot taken before the cover-art batch run. Includes track 9 (Gigue), which is not on the playlist.',
  playlist_v1: pl.data,
  playlist_v2: plV2.data,
  clips
};

mkdirSync('F:\\Projects\\DaddyWombat\\suno-api\\backups', { recursive: true });
const path = 'F:\\Projects\\DaddyWombat\\suno-api\\backups\\tombeau-clips-2026-09-19.json';
writeFileSync(path, JSON.stringify(out, null, 2));
console.log(`\nclips captured: ${clips.length}`);
console.log(`written: ${path}`);
