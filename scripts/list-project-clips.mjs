#!/usr/bin/env node
/**
 * List the clips in a Suno workspace, newest first, so a reference clip
 * uploaded by hand in the web UI can be found by its title.
 *
 *   node scripts/list-project-clips.mjs --project <workspace-id> [--prefix "REF "] [--json]
 *
 * Reads GET /api/project/{id}?page=N through this fork's /api/raw (20 clips
 * per page, per CAPABILITIES.md). --prefix keeps only titles starting with it.
 * --json keeps the NEWEST clip per title and reports collisions on stderr.
 */
import { pathToFileURL } from 'node:url';

/** Sort key for a `created_at` string: unparseable/missing sorts as oldest. */
function dateKey(created) {
  const t = Date.parse(created ?? '');
  return Number.isNaN(t) ? -Infinity : t;
}

/** Newest-first copy of `rows`, independent of the order they arrived in. */
function sortNewestFirst(rows) {
  return [...rows].sort((a, b) => dateKey(b.created) - dateKey(a.created));
}

/**
 * Build a {title: id} map from clip rows ({id, title, created}), newest
 * clip wins per title. Does not depend on input order: sorts a copy
 * newest-first first, then keeps the first id seen per title. A row with a
 * missing/unparseable `created` sorts as oldest, so it can never displace a
 * dated row of the same title.
 *
 * Returns { map, collisions } — collisions has one entry per title that had
 * more than one row: { title, keptId, keptCreated, dropped: [{id, created}] }.
 */
export function buildClipMap(rows) {
  const sorted = sortNewestFirst(rows);
  const map = {};
  const keptCreated = new Map();
  const collisionByTitle = new Map();
  const collisions = [];
  for (const r of sorted) {
    if (!(r.title in map)) {
      map[r.title] = r.id;
      keptCreated.set(r.title, r.created);
      continue;
    }
    let rec = collisionByTitle.get(r.title);
    if (!rec) {
      rec = { title: r.title, keptId: map[r.title], keptCreated: keptCreated.get(r.title), dropped: [] };
      collisionByTitle.set(r.title, rec);
      collisions.push(rec);
    }
    rec.dropped.push({ id: r.id, created: r.created });
  }
  return { map, collisions };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const API = args.api ?? 'http://localhost:3060';
  if (!args.project) { console.error('Need --project <workspace-id>.'); process.exit(1); }
  const prefix = typeof args.prefix === 'string' ? args.prefix : null;

  const rows = [];
  for (let page = 1; page < 50; page++) {
    const data = await rawGet(`/api/project/${args.project}?page=${page}`, API);
    const entries = data?.project_clips ?? [];
    for (const e of entries) {
      const c = pick(e);
      if (!c?.id) continue;
      if (prefix && !(c.title ?? '').startsWith(prefix)) continue;
      rows.push({ id: c.id, title: c.title ?? '', created: c.created_at ?? '' });
    }
    if (entries.length < 20) break;
  }

  const ordered = sortNewestFirst(rows);

  if (args.json) {
    const { map, collisions } = buildClipMap(ordered);
    for (const c of collisions) {
      const dropped = c.dropped.map((d) => `${d.id} (${String(d.created).slice(0, 19)})`).join(', ');
      console.error(`collision: "${c.title}" kept ${c.keptId} (${String(c.keptCreated).slice(0, 19)}); dropped ${dropped}`);
    }
    if (collisions.length) console.error(`${collisions.length} title(s) collided; newest clip kept for each.`);
    console.log(JSON.stringify(map, null, 2));
  } else {
    for (const r of ordered) console.log(`${r.id}  ${String(r.created).slice(0, 19)}  ${r.title}`);
    console.error(`\n${ordered.length} clip(s)${prefix ? ` with prefix "${prefix}"` : ''}`);
  }
}

function pick(entry) { return entry?.clip ?? entry; }   // adapt here if Step 1 showed another shape

async function rawGet(sunoPath, api) {
  const res = await fetch(`${api}/api/raw?path=${encodeURIComponent(sunoPath)}`);
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { throw new Error(`${sunoPath} -> non-JSON (local HTTP ${res.status}): ${text.slice(0, 200)}`); }
  if (json?.suno_status !== 200) throw new Error(`${sunoPath} -> suno ${json?.suno_status}: ${JSON.stringify(json?.data ?? null).slice(0, 200)}`);
  return json.data;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true; else { out[a.slice(2)] = next; i++; }
  }
  return out;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await main();
}
