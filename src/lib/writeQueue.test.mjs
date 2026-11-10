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
  await tick(0);
  const read = await Promise.resolve('read done');
  assert.equal(read, 'read done');
  release();
  await slow;
});

test('a write that waits too long rejects, never runs, and the queue moves on', async () => {
  const q = createWriteQueue({ maxWaitMs: 30 });
  let release;
  const hung = q.run(() => new Promise((r) => (release = r)));
  let ran = false;
  const stale = q.run(async () => {
    ran = true;
  });
  await assert.rejects(stale, /Write queue timeout/);
  const next = q.run(async () => 'next');
  release('hung done');
  assert.equal(await hung, 'hung done');
  assert.equal(await next, 'next');
  assert.equal(ran, false);
});

test('the wait limit does not cut short a write that is already running', async () => {
  const q = createWriteQueue({ maxWaitMs: 10 });
  assert.equal(
    await q.run(async () => {
      await tick(40);
      return 'slow ok';
    }),
    'slow ok'
  );
});

test('a never-settling write is released at maxRunMs and the next write runs', async () => {
  const q = createWriteQueue({ maxRunMs: 30, maxWaitMs: 1000 });
  const hung = q.run(() => new Promise(() => {}));
  const next = q.run(async () => 'ok');
  await assert.rejects(hung, /ran over 30ms/);
  assert.equal(await next, 'ok');
});

test('default waiter limit is not below the run cap', async () => {
  const q = createWriteQueue({ maxRunMs: 80 });
  const slow = q.run(() => tick(60).then(() => 'slow'));
  const behind = q.run(async () => 'behind');
  assert.equal(await slow, 'slow');
  assert.equal(await behind, 'behind');
});

test('a late settle after the run cap is ignored and does not release the next write early', async () => {
  const q = createWriteQueue({ maxRunMs: 20, maxWaitMs: 1000 });
  const hung = q.run(() => tick(60).then(() => 'late'));
  await assert.rejects(hung, /ran over 20ms/);
  assert.equal(await q.run(async () => 'next'), 'next');
  await tick(60);
});

test('the run cap fires the AbortSignal the task received', async () => {
  const q = createWriteQueue({ maxRunMs: 20, maxWaitMs: 1000 });
  let seen;
  const hung = q.run((signal) => {
    seen = signal;
    return new Promise(() => {});
  });
  await assert.rejects(hung, /released/);
  assert.equal(seen.aborted, true);
  assert.match(String(seen.reason.message), /released/);
});

test('a write that finishes in time is not aborted', async () => {
  const q = createWriteQueue({ maxRunMs: 50, maxWaitMs: 1000 });
  let seen;
  await q.run(async (signal) => {
    seen = signal;
  });
  await tick(80);
  assert.equal(seen.aborted, false);
});
