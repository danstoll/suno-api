// Compare the repo's plate PNGs against the art embedded in each library MP3.
// If they are byte-identical the repo copy is authoritative and we can upload
// it directly rather than round-tripping through the MP3.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { extractFromFile } from './extract-cover.mjs';

const MP3DIR = 'R:\\Music\\Vombatus\\Tombeau';
const PLATEDIR = 'F:\\Projects\\DaddyWombat\\daddy-wombat-tunes\\artwork\\plates\\tombeau';

const plates = readdirSync(PLATEDIR).filter(f => f.endsWith('.png')).sort();
const mp3s = readdirSync(MP3DIR).filter(f => f.toLowerCase().endsWith('.mp3')).sort();

const sha = b => createHash('sha256').update(b).digest('hex');

for (let i = 0; i < 10; i++) {
  const plateFile = plates[i];
  const mp3File = mp3s[i];
  const pBuf = readFileSync(path.join(PLATEDIR, plateFile));
  const r = extractFromFile(path.join(MP3DIR, mp3File));
  const pHash = sha(pBuf);
  const aHash = r.apic ? r.apic.sha256 : '(none)';
  const nPlate = plateFile.match(/^(\d+)/)?.[1];
  const nMp3 = mp3File.match(/^(\d+)/)?.[1];
  console.log(
    `${nPlate}/${nMp3} ${pHash === aHash ? 'MATCH  ' : 'DIFFER '} ` +
    `plate ${String(pBuf.length).padStart(8)}B  apic ${String(r.apic?.bytes ?? 0).padStart(8)}B  ${plateFile}`
  );
  if (pHash !== aHash) console.log(`        plate ${pHash}\n        apic  ${aHash}`);
}

// Album cover candidate
const cover = 'F:\\Projects\\DaddyWombat\\daddy-wombat-tunes\\artwork\\tombeau-cover.png';
const cBuf = readFileSync(cover);
console.log(`\nalbum cover: ${cBuf.length} bytes  sha256=${sha(cBuf)}`);
console.log(`PNG magic ok: ${cBuf.slice(1, 4).toString('latin1') === 'PNG'}`);
// IHDR width/height live at bytes 16..24 of a PNG
console.log(`dimensions: ${cBuf.readUInt32BE(16)} x ${cBuf.readUInt32BE(20)}`);
