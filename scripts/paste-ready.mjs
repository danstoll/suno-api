#!/usr/bin/env node
/**
 * Split a lyrics .md into two paste-ready plain-text files for the Suno web UI.
 *
 * Exists because of a specific failure: The Long Way Home was recorded from a
 * partial lyric with no section markers at all — 1,680 characters against the
 * file's 2,132, and 21 lines that were never submitted. The take came back
 * short and structureless, and it looked exactly like Suno compressing a long
 * song. It wasn't. The material had never been sent.
 *
 * Copying by hand out of a markdown file is where that goes wrong: the header,
 * the style block and the notes are all in the way, and it is easy to grab a
 * partial selection. These two files contain only what belongs in each Suno
 * field, so a copy is all-or-nothing.
 *
 * Usage:
 *   node scripts/paste-ready.mjs --file <lyrics.md>
 *
 * Writes <name>.LYRICS.txt and <name>.STYLE.txt beside the source, and prints
 * a section count so a short paste is obvious before you generate.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
if (!args.file) { console.error('Need --file <lyrics.md>'); process.exit(1); }

// Unescape the markdown escaping that editors add to [Section] markers.
const src = readFileSync(args.file, 'utf8').replace(/\\([\[\]~*_`#])/g, '$1');

const lyrics = (src.match(/##\s*Lyrics\s*\n([\s\S]*?)(?=\n##\s|\n*$)/) ?? [])[1]?.trim();
if (!lyrics) { console.error('No "## Lyrics" section found.'); process.exit(1); }

const styleBlock = (src.match(/##\s*Suno Style Prompt\s*\n([\s\S]*?)(?=\n##\s)/) ?? [])[1] ?? '';
const style = styleBlock
  .split('\n')
  .filter((l) => l.trim().startsWith('>'))
  .map((l) => l.replace(/^\s*>\s?/, ''))
  .join(' ')
  .trim();

const base = args.file.replace(/\.md$/i, '');
const lyricsPath = `${base}.LYRICS.txt`;
const stylePath = `${base}.STYLE.txt`;
writeFileSync(lyricsPath, `${lyrics}\n`);
writeFileSync(stylePath, `${style}\n`);

const sections = (lyrics.match(/^\[/gm) ?? []).length;
const lines = lyrics.split('\n').filter((l) => l.trim() && !l.trim().startsWith('[')).length;

console.log(`  ${path.basename(lyricsPath)}`);
console.log(`    ${lyrics.length} chars · ${sections} sections · ${lines} sung lines`);
console.log(`  ${path.basename(stylePath)}`);
console.log(`    ${style.length} chars`);
if (/~?\d+:\d\d/.test(style)) {
  console.log('\n  NOTE: the style prompt names a duration. That pushes Suno to pad or');
  console.log('  truncate to hit it, which mangles written endings. Consider removing it.');
}

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
