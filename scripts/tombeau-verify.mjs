// READ-ONLY. Current cover state of every Tombeau clip, against the backup.
import { readFileSync } from 'node:fs';
import { rawGet } from './tombeau-lib.mjs';

const backup = JSON.parse(readFileSync('F:\\Projects\\DaddyWombat\\suno-api\\backups\\tombeau-clips-2026-09-19.json', 'utf8'));
const before = new Map(backup.clips.map(c => [c.id, c]));

for (const c0 of backup.clips) {
  const r = await rawGet(`/api/clip/${c0.id}`);
  const c = r.data;
  const same = c.image_url === c0.image_url;
  const n = (c.title || '').match(/^(\d+)\./)?.[1] ?? '?';
  console.log(`${String(n).padStart(2)}  ${same ? 'UNCHANGED' : 'CHANGED  '}  ${c.image_url}`);
  if (!same) console.log(`      was: ${c0.image_url}`);
  // confirm the text fields the guardrails say must not move
  const tChanged = c.title !== c0.title;
  const lChanged = (c.metadata?.prompt || '') !== (c0.metadata?.prompt || '');
  const sChanged = (c.metadata?.tags || '') !== (c0.metadata?.tags || '');
  if (tChanged || lChanged || sChanged) console.log(`      !! title:${tChanged} lyrics:${lChanged} style:${sChanged}`);
}
