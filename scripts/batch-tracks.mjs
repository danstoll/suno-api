#!/usr/bin/env node
/**
 * Record several tracks while staying under Suno's rate limit.
 *
 * Suno throttles on PACING, not quota. Measured 2026-08-02: a captcha wall
 * appeared after roughly 12 generation calls, with the account only 3.5% into
 * its monthly credits. A track costs 2 generation calls (generate + extend),
 * so ~3 tracks is the safe run length, with a pause to let the window roll.
 *
 * Once tripped, the flag does NOT clear by waiting (90 minutes proved that),
 * nor by rotating the cookie — it is account-level. So the only winning move
 * is not to trip it. This checks before every batch and stops cleanly rather
 * than feeding attempts into a wall.
 *
 * Usage:
 *   node scripts/batch-tracks.mjs --manifest tracks.json [--size 3] [--gap 20]
 *
 *   --size N     tracks per batch (default 3)
 *   --gap  N     minutes to pause between batches (default 20)
 *   --oneshot    call make-track-oneshot.mjs instead of make-track.mjs — the
 *                default for anything under ~4 minutes per CLAUDE.md; a
 *                manifest entry's "split" field is simply ignored in this
 *                mode rather than erroring, since one-shot has nothing to split
 *   --dry        print the plan and the per-track splits, generate nothing
 *
 * Manifest is a JSON array:
 *   [{ "file": "../tunes/mi-casa/06-bath.md", "title": "06 Bath Time Splash",
 *      "split": "Verse 2", "project": "<workspace-id>", "fade": 6 }]
 *
 * "split" is only used by the default (make-track.mjs) pipeline; --oneshot
 * mode has no split step and ignores it.
 *
 *   Cover route: an entry with "coverClipId" (+ optional "audioWeight"), or
 *   "parts": [{"coverClipId", "duration"}], runs make-cover-from-reference.mjs
 *   instead of the oneshot script. See The Long Line v2 spec §9.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const API = args.api ?? 'http://localhost:3060';
const SIZE = Math.max(1, Number(args.size ?? 3));
const GAP_MIN = Number(args.gap ?? 20);

if (!args.manifest) { console.error('Need --manifest <file.json>. See header.'); process.exit(1); }
if (!existsSync(args.manifest)) { console.error(`Not found: ${args.manifest}`); process.exit(1); }

const tracks = JSON.parse(readFileSync(args.manifest, 'utf8'));
if (!Array.isArray(tracks) || !tracks.length) { console.error('Manifest must be a non-empty array.'); process.exit(1); }

const batches = [];
for (let i = 0; i < tracks.length; i += SIZE) batches.push(tracks.slice(i, i + SIZE));

console.log(`${tracks.length} track(s) in ${batches.length} batch(es) of ${SIZE}, ${GAP_MIN}min between\n`);
batches.forEach((b, i) => console.log(`  batch ${i + 1}: ${b.map((t) => t.title).join(' · ')}`));

if (args.dry) {
  console.log('\n--dry: checking splits only\n');
  for (const t of tracks) runMakeTrack(t, true);
  process.exit(0);
}

const results = [];
for (let bi = 0; bi < batches.length; bi++) {
  if (bi > 0) {
    console.log(`\n=== pausing ${GAP_MIN} min before batch ${bi + 1} ===`);
    await sleepMin(GAP_MIN);
  }

  if (challenged()) {
    console.error(`\n!! Suno is challenging (captcha required) — stopping before batch ${bi + 1}.`);
    console.error('   Generate one song by hand in the Suno web UI to clear it, then re-run');
    console.error('   with a manifest containing only the remaining tracks.');
    break;
  }

  console.log(`\n########## BATCH ${bi + 1} of ${batches.length} ##########`);
  for (const t of batches[bi]) {
    const ok = runMakeTrack(t, false);
    results.push({ title: t.title, ok });
    if (!ok && challenged()) {
      console.error('\n!! Challenged mid-batch — stopping so the rest are not wasted.');
      bi = batches.length; // fall out of the outer loop too
      break;
    }
  }
}

console.log('\n========== SUMMARY ==========');
for (const r of results) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.title}`);
const failed = results.filter((r) => !r.ok).map((r) => r.title);
if (failed.length) console.log(`\n  retry: ${failed.join(', ')}`);
const done = results.filter((r) => r.ok).length;
console.log(`\n  ${done}/${tracks.length} recorded`);

// ---------------------------------------------------------------- helpers

function runMakeTrack(t, dry) {
  if (t.coverClipId || t.parts) return runCover(t, dry);
  const script = path.join(path.dirname(process.argv[1]), args.oneshot ? 'make-track-oneshot.mjs' : 'make-track.mjs');
  const a = ['--file', t.file, '--title', t.title];
  if (t.project) a.push('--project', t.project);
  if (t.fade !== undefined) a.push('--fade', String(t.fade));
  if (args.oneshot) {
    // make-track-oneshot.mjs has no split step (nothing to split) and no
    // --pace (one call, not several) — both are silently inapplicable here.
    if (t.persona) a.push('--persona', t.persona);
    if (t['style-weight'] !== undefined) a.push('--style-weight', String(t['style-weight']));
    if (t.weirdness !== undefined) a.push('--weirdness', String(t.weirdness));
    if (t['audio-weight'] !== undefined) a.push('--audio-weight', String(t['audio-weight']));
    if (t.maxMode) a.push('--max-mode');
    if (t.negative) a.push('--negative', t.negative);
    if (t.duration !== undefined) a.push('--duration', String(t.duration));
    if (t.model) a.push('--model', t.model);
  } else {
    if (t.split) a.push('--split', t.split);
    if (t.pace !== undefined) a.push('--pace', String(t.pace));
  }
  if (dry) a.push('--dry');
  console.log(`\n---------- ${t.title} ----------`);
  const r = spawnSync('node', [script, ...a], { stdio: 'inherit' });
  return r.status === 0;
}

/**
 * Cover route (The Long Line v2): an entry with `coverClipId`, or with
 * `parts: [{coverClipId, duration}]`, generates through
 * make-cover-from-reference.mjs against a reference clip uploaded by hand.
 * Each part becomes its own clip titled "<title> part k"; master-album.mjs
 * joins parts later. Pacing and the captcha probe are the caller's, unchanged.
 */
function runCover(t, dry) {
  const script = path.join(path.dirname(process.argv[1]), 'make-cover-from-reference.mjs');
  const parts = t.parts ?? [{ coverClipId: t.coverClipId, duration: t.duration }];
  let allOk = true;
  parts.forEach((p, i) => {
    const title = parts.length > 1 ? `${t.title} part ${i + 1}` : t.title;
    const a = ['--cover-clip-id', String(p.coverClipId), '--lyrics-file', t.file, '--title', title];
    if (t.project) a.push('--project', t.project);
    a.push('--fade', String(t.fade ?? 0));
    if (t['style-weight'] !== undefined) a.push('--style-weight', String(t['style-weight']));
    if (t.weirdness !== undefined) a.push('--weirdness', String(t.weirdness));
    if (t.audioWeight !== undefined) a.push('--audio-weight', String(t.audioWeight));
    if (t.negative) a.push('--negative', t.negative);
    const dur = p.duration ?? t.duration;
    if (dur !== undefined) a.push('--duration', String(dur));
    if (t.model) a.push('--model', t.model);
    if (dry) a.push('--dry');
    console.log(`\n---------- ${title} (cover) ----------`);
    const r = spawnSync('node', [script, ...a], { stdio: 'inherit' });
    if (r.status !== 0) allOk = false;
  });
  return allOk;
}

/** Ask Suno directly whether it is currently demanding a captcha. */
function challenged() {
  try {
    const out = execFileSync('curl', [
      '-s', '--max-time', '60', '-X', 'POST', `${API}/api/raw`,
      '-H', 'Content-Type: application/json',
      '-d', JSON.stringify({ path: '/api/c/check', method: 'POST', body: { ctype: 'generation' } })
    ], { encoding: 'utf8' });
    return JSON.parse(out)?.data?.required === true;
  } catch {
    return false; // never block the run on a failed check
  }
}

async function sleepMin(min) {
  const end = Date.now() + min * 60_000;
  while (Date.now() < end) {
    const left = Math.ceil((end - Date.now()) / 60_000);
    process.stdout.write(`\r   ${left} min remaining...   `);
    await new Promise((r) => setTimeout(r, 30_000));
  }
  process.stdout.write('\r' + ' '.repeat(30) + '\r');
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
