import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRemasterBody, buildRemasterPayload } from './remaster.mjs';

test('accepts clip_id, optional model', () => {
  assert.deepEqual(parseRemasterBody({ clip_id: ' abc ', model: 'chirp-fenix' }), {
    ok: true, clipId: 'abc', model: 'chirp-fenix'
  });
  assert.equal(parseRemasterBody({ audio_id: 'abc' }).clipId, 'abc');
});

test('rejects bad bodies', () => {
  for (const b of [null, [], 'x', {}, { clip_id: '' }, { clip_id: 5 }, { clip_id: 'a', model: 7 }, { clip_id: 'a', model: ' ' }]) {
    assert.equal(parseRemasterBody(b).ok, false, JSON.stringify(b));
  }
});

test('payload carries the upsample fields', () => {
  const p = buildRemasterPayload({ clipId: 'abc', model: 'chirp-fenix', token: null, tokenProvider: null, uuid: 'u' });
  assert.equal(p.task, 'upsample');
  assert.equal(p.upsample_clip_id, 'abc');
  assert.equal(p.mv, 'chirp-fenix');
  assert.equal(p.transaction_uuid, 'u');
});
