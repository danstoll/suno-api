// node --test scripts/upload-check.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForUploadCheck } from './upload-check.mjs';

const seq = (...responses) => { let i = 0; return async () => responses[Math.min(i++, responses.length - 1)]; };
const opts = { sleep: async () => {} };

test('complete after pending', async () => {
  const r = await waitForUploadCheck(seq({ status: 200, data: { status: 'processing' } }, { status: 200, data: { status: 'complete' } }), opts);
  assert.equal(r.outcome, 'complete');
});

test('error carries message and type', async () => {
  const r = await waitForUploadCheck(seq({ status: 200, data: { status: 'error', error_message: 'match', error_type: 'acr' } }), opts);
  assert.equal(r.outcome, 'error');
  assert.equal(r.data.error_message, 'match');
});

test('404 means missing', async () => {
  const r = await waitForUploadCheck(seq({ status: 404, data: null }), opts);
  assert.equal(r.outcome, 'missing');
});

test('times out after 2 min of 3 s polls', async () => {
  let calls = 0;
  const r = await waitForUploadCheck(async () => { calls++; return { status: 200, data: { status: 'processing' } }; }, opts);
  assert.equal(r.outcome, 'timeout');
  assert.equal(calls, 41);
});
