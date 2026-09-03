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
// mean volume of a narrow band around `hz`, measured only within [start, start+dur) of `file`.
const bandVol = (file, start, dur, hz) => {
  // -ss/-t MUST come before -i (input-side seeking). Placed after -i they still produced a
  // plausible-looking number, but ffmpeg processes the filtergraph cumulatively from the start
  // of the file regardless -- a hard-cut sanity check (900Hz->200Hz, no crossfade) proved this:
  // output-side seeking read a slow multi-second convergence instead of a sharp jump at the cut.
  // Input-side seeking (below) reproduced the exact hard cut, confirming it is the correct form.
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-ss', String(start), '-t', String(dur), '-i', file,
    '-af', `bandpass=f=${hz}:width_type=h:w=20,volumedetect`, '-f', 'null', '-'], { encoding: 'utf8' });
  const out = r.stderr + r.stdout;
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(out);
  if (!m) throw new Error(`volumedetect failed for ${file} @${start}s/${dur}s/${hz}Hz:\n${out.slice(-500)}`);
  return Number(m[1]);
};
// A 20 Hz-wide bandpass separates two well-spaced sine tones by 30-45 dB in a raw file
// (verified empirically against 200/900 Hz sines). But master-album.mjs applies an album gain
// (tens of dB, whatever it takes to hit truePeakDb) to the whole track uniformly, so the
// *absolute* band level after mastering depends on that gain -- only the *relative* separation
// between the present and absent tone in a given window is gain-independent and safe to assert.
const SEP_MIN = 20; // dB the "present" tone's band must exceed the "absent" tone's band by
const assertPresent = (flac, start, dur, presentHz, absentHz, msg) => {
  const p = bandVol(flac, start, dur, presentHz), a = bandVol(flac, start, dur, absentHz);
  assert.ok(p - a > SEP_MIN, `${msg}: present ${presentHz}Hz=${p}dB, absent ${absentHz}Hz=${a}dB, separation ${(p - a).toFixed(1)}dB`);
};
// runs a one-track manifest (body + quote) through the tool; returns the cut FLAC's path.
// leadInSeconds/tailSeconds are zeroed so the FLAC's timeline matches the joined track exactly,
// which is what makes the expected-window arithmetic below exact.
const runQuoteTrack = (dir, quotePosition, bodyHz, bodySecs, quoteHz, quoteSecs) => {
  const mk = (name, hz, secs) => { const f = path.join(dir, name); ff(['-f', 'lavfi', '-i', `sine=frequency=${hz}:sample_rate=44100:duration=${secs}`, '-af', 'volume=-20dB', '-ac', '2', f]); return f; };
  const body = mk('body.wav', bodyHz, bodySecs);
  const quoteFile = mk('quote.wav', quoteHz, quoteSecs);
  const manifest = {
    album: 'Quote Test', artist: 'Tester', year: 2026, genre: 'Test', outDir: path.join(dir, 'out'),
    leadInSeconds: 0, tailSeconds: 0, partCrossfade: 2, maxSpreadLU: 14, truePeakDb: -1,
    tracks: [{ num: '01', title: 'Quoted', files: [body], clipIds: ['q1'], quote: { file: quoteFile, position: quotePosition } }]
  };
  const mf = path.join(dir, 'm.json'); writeFileSync(mf, JSON.stringify(manifest));
  execFileSync('node', [tool, '--manifest', mf], { stdio: 'inherit' });
  return path.join(manifest.outDir, '01 Quoted.flac');
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

test('master-album: quote intro -- quote leads, 2s crossfade into body', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'quote-intro-'));
  // sequence: quote(5s@900Hz) --2s xfade-- body(8s@200Hz); joined length = 5+8-2 = 11s
  // pure quote: [0,3); crossfade: [3,5); pure body: [5,11)
  const flac = runQuoteTrack(dir, 'intro', 200, 8, 900, 5);
  assert.ok(Math.abs(probe(flac) - 11) < 0.1, `joined length ${probe(flac)}`);
  assertPresent(flac, 0.5, 2, 900, 200, 'intro window should hold the quote, not the body');
  assertPresent(flac, 6, 4, 200, 900, 'post-crossfade window should hold the body, not the quote');
});

test('master-album: quote outro -- body crossfades into quote, which ends the track', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'quote-outro-'));
  // sequence: body(8s@200Hz) --2s xfade-- quote(5s@900Hz); joined length = 8+5-2 = 11s
  // pure body: [0,6); crossfade: [6,8); pure quote: [8,11)
  const flac = runQuoteTrack(dir, 'outro', 200, 8, 900, 5);
  assert.ok(Math.abs(probe(flac) - 11) < 0.1, `joined length ${probe(flac)}`);
  assertPresent(flac, 0.5, 5, 200, 900, 'track-start window should hold the body, not the quote');
  assertPresent(flac, 8.5, 2, 900, 200, 'track-end window should hold the quote, not the body');
});

test('master-album: quote bridge -- quote sits at the body\'s own midpoint, 1.5s crossfade each side', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'quote-bridge-'));
  // body(10s@200Hz) split at its own midpoint (5.0s) into two 5s halves; quote is 6s@900Hz
  // sequence: half1(5s) --1.5s xfade-- quote(6s) --1.5s xfade-- half2(5s)
  // joined length = 5+6-1.5 + 5-1.5 = 13 = bodyLen(10) + quoteLen(6) - 2*1.5
  // pure half1: [0,3.5); xfade1: [3.5,5.0); pure quote: [5.0,8.0); xfade2: [8.0,9.5); pure half2: [9.5,13)
  const flac = runQuoteTrack(dir, 'bridge', 200, 10, 900, 6);
  assert.ok(Math.abs(probe(flac) - 13) < 0.1, `joined length ${probe(flac)}`);
  assertPresent(flac, 0.5, 2.5, 200, 900, 'pre-bridge window should hold the body, not the quote');
  assertPresent(flac, 5.5, 2, 900, 200, 'bridge midpoint window should hold the quote, not the body');
  assertPresent(flac, 10, 2.5, 200, 900, 'post-bridge window should hold the body, not the quote');
});

test('master-album: no quote key behaves exactly as before (plain single-file passthrough)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'no-quote-'));
  const mk = (name, hz, secs) => { const f = path.join(dir, name); ff(['-f', 'lavfi', '-i', `sine=frequency=${hz}:sample_rate=44100:duration=${secs}`, '-af', 'volume=-20dB', '-ac', '2', f]); return f; };
  const body = mk('body.wav', 200, 8);
  const manifest = {
    album: 'No Quote Test', artist: 'Tester', year: 2026, genre: 'Test', outDir: path.join(dir, 'out'),
    leadInSeconds: 0, tailSeconds: 0, partCrossfade: 2, maxSpreadLU: 14, truePeakDb: -1,
    tracks: [{ num: '01', title: 'Plain', files: [body], clipIds: ['p1'] }]
  };
  const mf = path.join(dir, 'm.json'); writeFileSync(mf, JSON.stringify(manifest));
  execFileSync('node', [tool, '--manifest', mf], { stdio: 'inherit' });
  const flac = path.join(manifest.outDir, '01 Plain.flac');
  assert.ok(Math.abs(probe(flac) - 8) < 0.05, `plain length ${probe(flac)}`);
  // the body tone should be audible throughout -- no quote key, no crossfade, no missing audio
  assertPresent(flac, 1, 6, 200, 900, 'body tone missing with no quote key present');
});
