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

test('object detail is stringified, odd status becomes 500', () => {
  const r = mapError({ response: { status: 302, data: { detail: [{ msg: 'x' }] } } });
  assert.equal(r.status, 500);
  assert.equal(r.body.error, 'API Error: [{"msg":"x"}]');
});

// Error shapes the activity, cookie_status and chat completions routes hit.
test('local failure with no response (activity, cookie_status) is a 500 body', () => {
  assert.deepEqual(mapError(new TypeError('bad url')), { status: 500, body: { error: 'Internal error: bad url' } });
});

test('chat completions: Suno error without detail no longer needs error.response.data', () => {
  assert.deepEqual(mapError({ response: { status: 401, data: {} } }), { status: 401, body: { error: 'API Error: Unknown error' } });
  assert.equal(mapError(new Error('no response')).status, 500);
});
