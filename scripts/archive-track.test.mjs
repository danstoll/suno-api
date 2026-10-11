// Tests for the WAV download step and the --faded path of archive-track.mjs.
// No real Suno call: /api/raw is stubbed. Run with:
//   node --test scripts/archive-track.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadClipWav } from './wav-download.mjs';
import { fetchClip } from './archive-track.mjs';

const SCRIPT = fileURLToPath(new URL('./archive-track.mjs', import.meta.url));
const API = 'http://stub';
const WAV_URL = 'https://s3.example/clip.wav?Signature=SECRET';

const json = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body });

/** Stub fetch: records calls; `raw` maps "METHOD path" -> array of replies, consumed in order. */
function stub(raw, audioStatus = 200) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(String(url));
    if (String(url).startsWith(WAV_URL)) {
      return { ok: audioStatus < 400, status: audioStatus, arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer };
    }
    let key;
    if (init.method === 'POST') key = `POST ${JSON.parse(init.body).path}`;
    else key = `GET ${decodeURIComponent(new URL(url).searchParams.get('path'))}`;
    const q = raw[key];
    assert.ok(q, `unexpected call ${key}`);
    return json(q.length > 1 ? q.shift() : q[0]);
  };
  return { fetchImpl, calls };
}
const opts = (fetchImpl) => ({ fetchImpl, sleep: async () => {}, log: () => {}, polls: 5 });

test('downloads the WAV after convert_wav + polling, using only /api/raw', async () => {
  const dest = path.join(mkdtempSync(path.join(tmpdir(), 'wav-')), 'x.wav');
  const { fetchImpl, calls } = stub({
    'POST /api/gen/abc/convert_wav/': [{ suno_status: 204, data: null }],
    'GET /api/gen/abc/wav_file/': [{ suno_status: 200, data: {} }, { suno_status: 200, data: { wav_file_url: WAV_URL } }]
  });
  await downloadClipWav(API, 'abc', dest, opts(fetchImpl));
  assert.deepEqual([...readFileSync(dest)], [1, 2, 3, 4]);
  assert.ok(calls.every((u) => u.startsWith(`${API}/api/raw`) || u.startsWith(WAV_URL)));
  assert.ok(!calls.some((u) => /audio_url|\.mp3/.test(u)));
});

test('403 from convert_wav gives a clear not-your-clip message', async () => {
  const { fetchImpl } = stub({ 'POST /api/gen/abc/convert_wav/': [{ suno_status: 403, data: { detail: 'no' } }] });
  await assert.rejects(downloadClipWav(API, 'abc', 'unused', opts(fetchImpl)), /not WAV-convertible.*owner/s);
});

test('402 from convert_wav says Pro or Premier is needed', async () => {
  const { fetchImpl } = stub({ 'POST /api/gen/abc/convert_wav/': [{ suno_status: 402, data: null }] });
  await assert.rejects(downloadClipWav(API, 'abc', 'unused', opts(fetchImpl)), /Pro or Premier/);
});

test('failed S3 download error hides the presigned query string', async () => {
  const { fetchImpl } = stub({
    'POST /api/gen/abc/convert_wav/': [{ suno_status: 204, data: null }],
    'GET /api/gen/abc/wav_file/': [{ suno_status: 200, data: { wav_file_url: WAV_URL } }]
  }, 500);
  await assert.rejects(downloadClipWav(API, 'abc', 'unused', opts(fetchImpl)),
    (e) => /Download failed: 500/.test(e.message) && !e.message.includes('SECRET'));
});

test('fetchClip rejects a clip that is not complete', async () => {
  const f = async () => json([{ id: 'abc', status: 'streaming' }]);
  await assert.rejects(fetchClip(API, 'abc', f), /not complete/);
});

test('--faded PATH archives with no network call', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => { hits++; res.end('{}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(path.join(tmpdir(), 'arch-'));
  const src = path.join(dir, 'in.faded.mp3');
  writeFileSync(src, Buffer.alloc(2048, 1));
  const root = path.join(dir, 'lib');
  try {
    const out = await new Promise((resolve, reject) => execFile(process.execPath,
      [SCRIPT, '--faded', src, '--album', 'Test Album', '--track', '3', '--title', 'Song',
       '--root', root, '--api', `http://127.0.0.1:${server.address().port}`],
      { cwd: dir }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout))));
    assert.match(out, /Archived:/);
    const albumDir = path.join(root, 'Daddy Wombat', 'Test Album');
    assert.ok(existsSync(path.join(albumDir, '03 Song.mp3')), readdirSync(albumDir).join());
    assert.equal(hits, 0);
  } finally { server.close(); }
});
