import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const tool = path.join(here, 'master-album.mjs');
const ff = (a) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...a]);
const probe = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim());
const ebur = (f) => {
  // the ebur128 summary is printed on stderr, so capture both streams
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', f, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' });
  const out = r.stderr + r.stdout;
  // anchor to the one-time Summary labels -- a plain /I:\s+.../ match grabs the periodic
  // per-frame line instead, which reads a bogus -70.0 LUFS for the first ~300ms of any file
  return { I: Number(/Integrated loudness:[\s\S]*?I:\s+(-?[\d.]+) LUFS/.exec(out)[1]), TP: Number(/True peak:[\s\S]*?Peak:\s+(-?[\d.]+) dBFS/.exec(out)[1]) };
};

test('master-album: crossfades, cuts, loudness, cue', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'master-'));
  const mk = (name, hz, secs, db) => { const f = path.join(dir, name); ff(['-f', 'lavfi', '-i', `sine=frequency=${hz}:sample_rate=44100:duration=${secs}`, '-af', `volume=${db}dB`, '-ac', '2', f]); return f; };
  const a = mk('a.wav', 440, 6, -20), b = mk('b.wav', 660, 5, -6), c = mk('c.wav', 220, 4, -36);
  const manifest = {
    album: 'Test Album', artist: 'Tester', year: 2026, genre: 'Test', outDir: path.join(dir, 'out'),
    leadInSeconds: 0.5, tailSeconds: 1.0, partCrossfade: 2, maxSpreadLU: 14, truePeakDb: -1,
    tracks: [
      { num: '01', title: 'Alpha', files: [a], clipIds: ['x1'], fadeIntoNext: 1 },
      { num: '02', title: 'Beta', files: [b], clipIds: ['x2'], fadeIntoNext: 1 },
      { num: '03', title: 'Gamma', files: [c], clipIds: ['x3'] }]
  };
  const mf = path.join(dir, 'm.json'); writeFileSync(mf, JSON.stringify(manifest));
  execFileSync('node', [tool, '--manifest', mf], { stdio: 'inherit' });

  const out = manifest.outDir;
  const flacs = ['01 Alpha.flac', '02 Beta.flac', '03 Gamma.flac'].map((n) => path.join(out, n));
  for (const f of flacs) assert.ok(existsSync(f), `${f} missing`);
  // timeline: 01 = 0.5 lead + 6 = 6.5; join1 = 1 s → cut at 6.0; 02 = 5 → cut at 10.0; 03 = 4 + 1 tail → end 14.5
  assert.ok(Math.abs(probe(path.join(out, 'master.wav')) - 14.5) < 0.05);
  const durs = flacs.map(probe);
  assert.ok(Math.abs(durs[0] - 6.0) < 0.05, `01 ${durs[0]}`);
  assert.ok(Math.abs(durs[1] - 4.0) < 0.05, `02 ${durs[1]}`);
  assert.ok(Math.abs(durs[2] - 4.5) < 0.05, `03 ${durs[2]}`);
  // loudness: every file under -1 dBTP; the quiet track was lifted to within 14 LU of the loudest
  const L = flacs.map(ebur);
  for (const l of L) assert.ok(l.TP <= -0.9, `true peak ${l.TP}`);
  const loudest = Math.max(...L.map((l) => l.I));
  assert.ok(loudest - L[2].I <= 14.5, `spread ${loudest - L[2].I}`);
  // cue + sidecars + report
  const cue = readFileSync(path.join(out, 'Test Album.cue'), 'utf8');
  assert.equal((cue.match(/TRACK \d\d AUDIO/g) ?? []).length, 3);
  assert.match(readFileSync(path.join(out, '02 Beta.txt'), 'utf8'), /clip_id:\s+x2/);
  const report = JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8'));
  assert.equal(report.tracks.length, 3);
});
