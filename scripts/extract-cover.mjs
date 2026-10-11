#!/usr/bin/env node
/**
 * Pull the embedded cover art (APIC frame) out of an MP3, and report every
 * other ID3v2 frame while we're in there.
 *
 * COVER-ART-PIPELINE.md refers to this script as though it exists; it did not
 * (only the extraction it describes was done ad hoc). Written 2026-09-19 for
 * the Tombeau batch run.
 *
 * Pure Node, no ffmpeg — the file is read once into a Buffer and the tag is
 * walked frame by frame.
 *
 * Usage:
 *   node scripts/extract-cover.mjs --file "path.mp3"                 # report only
 *   node scripts/extract-cover.mjs --file "path.mp3" --out plate.png # + write art
 *   node scripts/extract-cover.mjs --dir  "folder"  --outdir plates  # whole album
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export function readId3(buf) {
  if (buf.slice(0, 3).toString('latin1') !== 'ID3') return null;
  const major = buf[3];
  // Tag size is a 28-bit "synchsafe" integer: 7 usable bits per byte, so the
  // high bit can never create a false MPEG frame sync in the header.
  const tagSize = synchsafe(buf, 6);
  const flags = buf[5];
  let pos = 10;
  if (flags & 0x40) pos += major === 4 ? synchsafe(buf, pos) : buf.readUInt32BE(pos) + 4; // extended header
  const end = Math.min(10 + tagSize, buf.length);
  const frames = [];

  while (pos + 10 <= end) {
    const id = buf.slice(pos, pos + 4).toString('latin1');
    if (!/^[A-Z0-9]{4}$/.test(id)) break; // padding
    // v2.4 made frame sizes synchsafe too; v2.3 left them plain big-endian.
    const size = major === 4 ? synchsafe(buf, pos + 4) : buf.readUInt32BE(pos + 4);
    if (size <= 0 || pos + 10 + size > end) break;
    frames.push({ id, size, body: buf.slice(pos + 10, pos + 10 + size) });
    pos += 10 + size;
  }
  return { major, tagSize, frames };
}

function synchsafe(buf, off) {
  return (buf[off] << 21) | (buf[off + 1] << 14) | (buf[off + 2] << 7) | buf[off + 3];
}

/** Decode a text frame body, honouring its one-byte encoding marker. */
function decodeText(body) {
  const enc = body[0];
  const raw = body.slice(1);
  if (enc === 0 || enc === 3) return raw.toString(enc === 0 ? 'latin1' : 'utf8').replace(/\0+$/, '');
  if (enc === 1) return raw.toString('utf16le').replace(/^﻿/, '').replace(/\0+$/, '');
  if (enc === 2) return swap16(raw).toString('utf16le').replace(/\0+$/, '');
  return raw.toString('utf8').replace(/\0+$/, '');
}

function swap16(b) {
  const o = Buffer.from(b);
  for (let i = 0; i + 1 < o.length; i += 2) { const t = o[i]; o[i] = o[i + 1]; o[i + 1] = t; }
  return o;
}

/** APIC: enc | mime\0 | picType | description\0 | picture bytes */
export function parseApic(body) {
  const enc = body[0];
  let p = 1;
  const mimeEnd = body.indexOf(0, p);
  const mime = body.slice(p, mimeEnd).toString('latin1');
  p = mimeEnd + 1;
  const picType = body[p]; p += 1;
  // The description uses the frame's encoding, so a UTF-16 description ends on
  // a DOUBLE null — terminating on the first 0x00 would truncate mid-character.
  if (enc === 1 || enc === 2) {
    while (p + 1 < body.length && !(body[p] === 0 && body[p + 1] === 0)) p += 2;
    p += 2;
  } else {
    p = body.indexOf(0, p) + 1;
  }
  return { mime, picType, data: body.slice(p) };
}

export function extractFromFile(file) {
  const buf = readFileSync(file);
  const tag = readId3(buf);
  if (!tag) return { file, error: 'no ID3v2 tag' };
  const out = { file, id3: `v2.${tag.major}`, text: {}, apic: null };
  for (const f of tag.frames) {
    if (f.id === 'APIC') {
      const a = parseApic(f.body);
      out.apic = {
        mime: a.mime, picType: a.picType, bytes: a.data.length,
        sha256: createHash('sha256').update(a.data).digest('hex'),
        data: a.data
      };
    } else if (f.id[0] === 'T' || f.id === 'COMM' || f.id === 'USLT') {
      let v;
      if (f.id === 'COMM' || f.id === 'USLT') {
        // enc | 3-byte language | short descriptor\0 | text
        const enc = f.body[0];
        let p = 4;
        if (enc === 1 || enc === 2) { while (p + 1 < f.body.length && !(f.body[p] === 0 && f.body[p + 1] === 0)) p += 2; p += 2; }
        else p = f.body.indexOf(0, p) + 1;
        v = decodeText(Buffer.concat([Buffer.from([enc]), f.body.slice(p)]));
      } else {
        v = decodeText(f.body);
      }
      out.text[f.id] = (out.text[f.id] ? out.text[f.id] + ' | ' : '') + v;
    } else {
      out.text[f.id] = `<${f.size} bytes>`;
    }
  }
  return out;
}

const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/webp': '.webp' };

function main() {
  const a = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i];

  const files = a.dir
    ? readdirSync(a.dir).filter(f => f.toLowerCase().endsWith('.mp3')).sort().map(f => path.join(a.dir, f))
    : [a.file];
  if (!files[0]) { console.error('Need --file <mp3> or --dir <folder>'); process.exit(1); }
  if (a.outdir && !existsSync(a.outdir)) mkdirSync(a.outdir, { recursive: true });

  const report = [];
  for (const f of files) {
    const r = extractFromFile(f);
    if (r.error) { console.log(`${path.basename(f)}: ${r.error}`); continue; }
    let written = null;
    if (r.apic && (a.out || a.outdir)) {
      const ext = EXT[r.apic.mime] ?? '.bin';
      written = a.outdir
        ? path.join(a.outdir, path.basename(f, '.mp3').replace(/[^\w.-]+/g, '-').toLowerCase() + '-plate' + ext)
        : a.out;
      writeFileSync(written, r.apic.data);
    }
    console.log(`\n=== ${path.basename(f)}  (${r.id3})`);
    for (const [k, v] of Object.entries(r.text)) console.log(`  ${k}: ${String(v).slice(0, 300)}`);
    if (r.apic) console.log(`  APIC: ${r.apic.mime} type=${r.apic.picType} ${r.apic.bytes} bytes sha256=${r.apic.sha256}`);
    else console.log('  APIC: none');
    if (written) console.log(`  -> ${written}`);
    report.push({ file: f, text: r.text, apic: r.apic ? { ...r.apic, data: undefined } : null, written });
  }
  if (a.json) writeFileSync(a.json, JSON.stringify(report, null, 2));
}

// pathToFileURL, not string-building: Windows paths give file:///F:/... (three
// slashes) and a hand-rolled comparison silently never matches, so main() never runs.
import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
