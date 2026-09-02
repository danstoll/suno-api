#!/usr/bin/env node
/**
 * List the clips in a Suno workspace, newest first, so a reference clip
 * uploaded by hand in the web UI can be found by its title.
 *
 *   node scripts/list-project-clips.mjs --project <workspace-id> [--prefix "REF "] [--json]
 *
 * Reads GET /api/project/{id}?page=N through this fork's /api/raw (20 clips
 * per page, per CAPABILITIES.md). --prefix keeps only titles starting with it.
 * --json prints a {title: id} map for scripting.
 */
const args = parseArgs(process.argv.slice(2));
const API = args.api ?? 'http://localhost:3060';
if (!args.project) { console.error('Need --project <workspace-id>.'); process.exit(1); }
const prefix = typeof args.prefix === 'string' ? args.prefix : null;

const rows = [];
for (let page = 1; page < 50; page++) {
  const data = await rawGet(`/api/project/${args.project}?page=${page}`);
  const entries = data?.project_clips ?? [];
  for (const e of entries) {
    const c = pick(e);
    if (!c?.id) continue;
    if (prefix && !(c.title ?? '').startsWith(prefix)) continue;
    rows.push({ id: c.id, title: c.title ?? '', created: c.created_at ?? '' });
  }
  if (entries.length < 20) break;
}

if (args.json) {
  console.log(JSON.stringify(Object.fromEntries(rows.map((r) => [r.title, r.id])), null, 2));
} else {
  for (const r of rows) console.log(`${r.id}  ${String(r.created).slice(0, 19)}  ${r.title}`);
  console.error(`\n${rows.length} clip(s)${prefix ? ` with prefix "${prefix}"` : ''}`);
}

function pick(entry) { return entry?.clip ?? entry; }   // adapt here if Step 1 showed another shape

async function rawGet(sunoPath) {
  const res = await fetch(`${API}/api/raw?path=${encodeURIComponent(sunoPath)}`);
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
