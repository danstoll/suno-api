import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWriteQueue } from './writeQueue.mjs';

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('two parallel writes run in order, one at a time', async () => {
  const q = createWriteQueue();
  const log = [];
  let active = 0;
  let maxActive = 0;
  const write = (name, ms) => () =>
    (async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      log.push(`start ${name}`);
      await tick(ms);
      log.push(`end ${name}`);
      active--;
      return name;
    })();
  const [a, b] = await Promise.all([q.run(write('A', 30)), q.run(write('B', 1))]);
  assert.deepEqual([a, b], ['A', 'B']);
  assert.deepEqual(log, ['start A', 'end A', 'start B', 'end B']);
  assert.equal(maxActive, 1);
});

test('a failed write does not stall the queue', async () => {
  const q = createWriteQueue();
  const failing = q.run(async () => {
    throw new Error('boom');
  });
  const next = q.run(async () => 'ok');
  await assert.rejects(failing, /boom/);
  assert.equal(await next, 'ok');
  assert.equal(await q.run(async () => 'later'), 'later');
});

test('reads outside the queue are not blocked by a slow write', async () => {
  const q = createWriteQueue();
  let release;
  const slow = q.run(() => new Promise((r) => (release = r)));
  const read = await Promise.resolve('read done');
  assert.equal(read, 'read done');
  release();
  await slow;
});
