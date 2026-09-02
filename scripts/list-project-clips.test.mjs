import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClipMap } from './list-project-clips.mjs';

test('two rows, same title, different dates -> map holds the NEWER id', () => {
  const rows = [
    { id: 'new', title: 'REF 01 Thing', created: '2026-08-29T22:05:06.000Z' },
    { id: 'old', title: 'REF 01 Thing', created: '2026-08-28T22:34:07.000Z' },
  ];
  const { map, collisions } = buildClipMap(rows);
  assert.equal(map['REF 01 Thing'], 'new');
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].keptId, 'new');
  assert.deepEqual(collisions[0].dropped.map((d) => d.id), ['old']);
});

test('reversed input order -> same result (does not depend on input order)', () => {
  const rows = [
    { id: 'old', title: 'REF 01 Thing', created: '2026-08-28T22:34:07.000Z' },
    { id: 'new', title: 'REF 01 Thing', created: '2026-08-29T22:05:06.000Z' },
  ];
  const { map } = buildClipMap(rows);
  assert.equal(map['REF 01 Thing'], 'new');
});

test('a row with a missing created alongside a dated row of the same title -> the dated one wins', () => {
  const rows = [
    { id: 'dated', title: 'REF 02 Other', created: '2026-08-20T00:00:00.000Z' },
    { id: 'undated', title: 'REF 02 Other', created: '' },
  ];
  const { map, collisions } = buildClipMap(rows);
  assert.equal(map['REF 02 Other'], 'dated');
  assert.equal(collisions.length, 1);
  assert.deepEqual(collisions[0].dropped.map((d) => d.id), ['undated']);
});

test('no duplicates -> no collisions reported', () => {
  const rows = [
    { id: 'a', title: 'REF 01 Thing', created: '2026-08-29T00:00:00.000Z' },
    { id: 'b', title: 'REF 02 Other', created: '2026-08-28T00:00:00.000Z' },
  ];
  const { map, collisions } = buildClipMap(rows);
  assert.equal(collisions.length, 0);
  assert.equal(Object.keys(map).length, 2);
  assert.equal(map['REF 01 Thing'], 'a');
  assert.equal(map['REF 02 Other'], 'b');
});

test('three rows sharing a title -> one kept, two reported dropped', () => {
  const rows = [
    { id: 'newest', title: 'REF 03 Thread', created: '2026-08-29T00:00:00.000Z' },
    { id: 'middle', title: 'REF 03 Thread', created: '2026-08-28T00:00:00.000Z' },
    { id: 'oldest', title: 'REF 03 Thread', created: '2026-08-27T00:00:00.000Z' },
  ];
  const { map, collisions } = buildClipMap(rows);
  assert.equal(map['REF 03 Thread'], 'newest');
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].dropped.length, 2);
  assert.deepEqual(collisions[0].dropped.map((d) => d.id).sort(), ['middle', 'oldest']);
});
