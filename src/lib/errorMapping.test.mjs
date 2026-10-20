import test from 'node:test';
import assert from 'node:assert/strict';
import { mapError } from './errorMapping.mjs';

test('402 keeps status and Suno detail', () => {
  const r = mapError({ response: { status: 402, data: { detail: 'Out of credits' } } });
  assert.deepEqual(r, { status: 402, body: { error: 'Out of credits' } });
});

test('402 without detail falls back', () => {
  assert.equal(mapError({ response: { status: 402 } }).body.error, 'Payment required');
});

test('axios response error keeps Suno status', () => {
  const r = mapError({ response: { status: 422, data: { detail: 'bad tags' }, statusText: 'Unprocessable' } });
  assert.deepEqual(r, { status: 422, body: { error: 'API Error: bad tags' } });
});

test('axios response error uses statusText, then Unknown', () => {
  assert.equal(mapError({ response: { status: 500, statusText: 'Oops' } }).body.error, 'API Error: Oops');
  assert.equal(mapError({ response: { status: 500 } }).body.error, 'API Error: Unknown error');
});

test('network error is 503', () => {
  const r = mapError({ request: {}, message: 'ECONNRESET' });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /^Network error/);
});

test('plain Error is 500', () => {
  assert.deepEqual(mapError(new Error('boom')), { status: 500, body: { error: 'Internal error: boom' } });
});

test('non-Error throw is 500', () => {
  assert.equal(mapError(undefined).status, 500);
  assert.equal(mapError('x').body.error, 'Internal error: Unknown error occurred');
});
