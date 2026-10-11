#!/usr/bin/env node
/**
 * Lists every daddy-wombat-tunes path named in the manifests and shows whether it exists.
 *   node scripts/check-manifest-paths.mjs [--root <DaddyWombat checkout>]
 * Default root is the parent of this repo (this repo is the suno-api/ submodule).
 * Exit 1 if any path is missing. Reads files only; never calls Suno.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const i = process.argv.indexOf('--root');
const root = i > 0 ? path.resolve(process.argv[i + 1]) : path.resolve(repo, '..');
const files = [
  ...readdirSync(path.join(repo, 'batches/archive')).filter((f) => f.endsWith('.json')).map((f) => path.join('batches/archive', f)),
  'the-long-line-master.json',
  'scripts/fixtures/cover-batch-dry.json',
];
let missing = 0, total = 0;
for (const f of files) {
  const paths = new Set(readFileSync(path.join(repo, f), 'utf8').match(/\.\.\/daddy-wombat-tunes\/[^"]+/g) ?? []);
  for (const p of [...paths].sort()) {
    // Paths are relative to the working directory the scripts run from: the suno-api/ root.
    const ok = existsSync(path.resolve(root, 'suno-api', p));
    total++; if (!ok) missing++;
    console.log(`${ok ? 'OK     ' : 'MISSING'} ${f}: ${p}`);
  }
}
console.log(`\n${total} path(s), ${missing} missing`);
process.exit(missing ? 1 : 0);
