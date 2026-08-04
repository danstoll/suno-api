#!/usr/bin/env node
/**
 * Diff a browser capture against CAPABILITIES.md and report what is new.
 *
 * Most of Suno's features are conditions on one generate call rather than
 * separate endpoints, so the payload's field list is close to a feature map.
 * Anything Suno ships shows up there before it shows up anywhere else — the
 * `persona_id`, `cover_clip_id` and `artist_clip_id` fields were all sitting in
 * a captured request long before we knew what they were for.
 *
 * Guessing endpoint names has a poor record here. `/api/persona/` 404s while
 * `/api/persona/create/` works; eight plausible "list personas" paths all 404'd
 * while the real one is `/api/persona/get-persona-paginated/`. Reading a real
 * request costs one browser session and is never wrong.
 *
 * The habit:
 *   1. Paste scripts/capture-suno-requests.js into DevTools on suno.com
 *   2. Drive whatever feature you want to understand
 *   3. __sunoCapture.save()
 *   4. node scripts/capture-diff.mjs --capture <that file>
 *
 * Exits non-zero when something new appears, so it is obvious rather than
 * buried in output.
 *
 * Usage:
 *   node scripts/capture-diff.mjs --capture suno-capture-123.json
 *   node scripts/capture-diff.mjs --capture c.json --doc CAPABILITIES.md
 */

import { readFileSync, existsSync } from 'node:fs';

const args = parseArgs(process.argv.slice(2));
if (!args.capture) { console.error('Need --capture <capture.json>'); process.exit(1); }
const docPath = args.doc ?? 'CAPABILITIES.md';
if (!existsSync(args.capture)) { console.error(`Not found: ${args.capture}`); process.exit(1); }
if (!existsSync(docPath)) { console.error(`Not found: ${docPath}`); process.exit(1); }

const doc = readFileSync(docPath, 'utf8');
let capture;
try { capture = JSON.parse(readFileSync(args.capture, 'utf8')); }
catch (e) { console.error(`Could not parse capture: ${e.message}`); process.exit(1); }
if (!Array.isArray(capture)) { console.error('Capture should be a JSON array of entries.'); process.exit(1); }

/**
 * Collapse the variable parts of a path so `/api/clip/<uuid>` and
 * `/api/clip/<another-uuid>` count as the same endpoint. Without this every
 * clip id looks like a brand new discovery.
 */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const normalise = (p) => String(p).replace(UUID, '{id}').replace(/\/\d+(?=\/|$)/g, '/{n}').replace(/\/+$/, '/');

// Known endpoints: any /api/... path mentioned anywhere in the doc.
const knownPaths = new Set(
  (doc.match(/\/api\/[A-Za-z0-9_{}\/-]*/g) ?? []).map(normalise)
);

/**
 * Documented paths use placeholders — `/api/statsig/experiment/{name}` — and a
 * capture holds the real slug. Normalising the capture only collapses UUIDs and
 * numbers, so `forked-onboarding` and `default` still looked undocumented and
 * the tool kept reporting endpoints it had just been told about.
 *
 * Turn any documented path containing a placeholder into a pattern and match
 * against that as well as by exact string.
 */
const knownPatterns = [...knownPaths]
  .filter((p) => p.includes('{'))
  .map((p) => new RegExp('^' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{[a-z]+\\\}/gi, '[^/]+') + '$', 'i'));

const isKnownPath = (p) => knownPaths.has(p) || knownPatterns.some((re) => re.test(p));

/**
 * Known fields: every identifier-shaped token inside ANY backtick span.
 *
 * Matching only whole single-identifier spans missed anything documented as a
 * payload shape — `{root_clip_id, name, vox_audio_id, ...}` is one span, so all
 * eight fields inside it read as undocumented and the tool cried wolf on its
 * own documentation. Split the span instead of requiring it to be one word.
 *
 * Deliberately broad. A missed discovery is worse than a field wrongly
 * considered known, because the whole point is to notice the unfamiliar.
 */
const knownFields = new Set();
for (const span of doc.match(/`[^`]+`/g) ?? []) {
  for (const tok of span.slice(1, -1).split(/[^A-Za-z0-9_]+/)) {
    if (/^[a-z][a-z0-9_]{2,}$/.test(tok)) knownFields.add(tok);
  }
}
// Table cells are often written without backticks; treat a leading column entry
// that looks like an identifier as documented too.
for (const m of doc.matchAll(/^\|\s*\**`?([a-z][a-z0-9_]{2,})`?\**\s*\|/gm)) knownFields.add(m[1]);

const seenPaths = new Map();   // path -> Set(methods)
const seenFields = new Map();  // field -> Set(paths it appeared on)
const bodyless = new Set();

for (const e of capture) {
  const path = normalise(e.path ?? e.url ?? '');
  if (!path.startsWith('/api/')) continue;
  if (!seenPaths.has(path)) seenPaths.set(path, new Set());
  seenPaths.get(path).add(e.method ?? 'GET');

  const body = e.request;
  if (!body || typeof body !== 'object' || Array.isArray(body)) { bodyless.add(path); continue; }
  for (const k of Object.keys(body)) {
    if (!seenFields.has(k)) seenFields.set(k, new Set());
    seenFields.get(k).add(path);
  }
}

const newPaths = [...seenPaths].filter(([p]) => !isKnownPath(p));
const newFields = [...seenFields].filter(([f]) => !knownFields.has(f));

console.log(`  capture: ${capture.length} entries · ${seenPaths.size} distinct endpoints · ${seenFields.size} request fields`);
console.log(`  doc    : ${knownPaths.size} known paths · ${knownFields.size} known identifiers\n`);

if (newPaths.length) {
  console.log(`  NEW ENDPOINTS (${newPaths.length}) — not in ${docPath}:`);
  for (const [p, methods] of newPaths) console.log(`    ${[...methods].join(',').padEnd(6)} ${p}`);
  console.log('');
}

if (newFields.length) {
  console.log(`  NEW REQUEST FIELDS (${newFields.length}) — not in ${docPath}:`);
  for (const [f, paths] of newFields) console.log(`    ${f.padEnd(28)} seen on ${[...paths].join(', ')}`);
  console.log('');
}

// Documented-but-absent is informational only. A capture of one feature will
// never exercise the rest, so this is not a failure — it is a reminder of what
// this session did not cover.
const unexercised = [...knownPaths].filter((p) => p.includes('/') && !seenPaths.has(p));
if (args.verbose && unexercised.length) {
  console.log(`  documented but not exercised in this capture (${unexercised.length}):`);
  for (const p of unexercised.sort()) console.log(`    ${p}`);
  console.log('');
}

if (!newPaths.length && !newFields.length) {
  console.log('  Nothing new. Everything in this capture is already documented.');
  process.exit(0);
}

console.log('  Add the new items to CAPABILITIES.md, then work out what they do.');
console.log('  A field on the generate payload is usually a whole feature — most of');
console.log('  Suno\'s menu is conditions on one call, not separate endpoints.');
process.exit(1);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const n = argv[i + 1];
    if (n === undefined || n.startsWith('--')) out[a.slice(2)] = true;
    else { out[a.slice(2)] = n; i++; }
  }
  return out;
}
