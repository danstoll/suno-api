import test from 'node:test';
import assert from 'node:assert/strict';
import { closeOnThrow } from './closeOnThrow.mjs';

test('returns the setup result and does not close', async () => {
  let closed = 0;
  const r = await closeOnThrow(() => { closed++; }, async () => 42);
  assert.equal(r, 42);
  assert.equal(closed, 0);
});

test('closes once and rethrows the original error when setup throws', async () => {
  let closed = 0;
  const err = new Error('goto failed');
  await assert.rejects(
    closeOnThrow(() => { closed++; }, async () => { throw err; }),
    (e) => e === err
  );
  assert.equal(closed, 1);
});

test('a failing close does not hide the setup error', async () => {
  const err = new Error('setup');
  await assert.rejects(
    closeOnThrow(async () => { throw new Error('close'); }, async () => { throw err; }),
    (e) => e === err
  );
});

test('a synchronous throw in setup is also closed', async () => {
  let closed = 0;
  await assert.rejects(closeOnThrow(() => { closed++; }, () => { throw new Error('x'); }));
  assert.equal(closed, 1);
});
