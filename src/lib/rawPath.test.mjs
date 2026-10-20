import test from 'node:test';
import assert from 'node:assert/strict';
import { rawPathError } from './rawPath.mjs';

test('accepts normal paths', () => {
  for (const p of ['/api/session/', '/api/project/default', '/api/feed/v3?limit=1', '/api/clip/a.b']) {
    assert.equal(rawPathError(p), null, p);
  }
});

test('rejects .. segments, plain and encoded', () => {
  for (const p of [
    '/api/../x',
    '/api/a/..',
    '/api/%2e%2e/x',
    '/api/%2E%2E/x',
    '/api/.%2e/x',
    '/api/%252e%252e/x',
    '/api/a/..%2fx',
    '/api/a\\..\\x'
  ]) {
    assert.match(rawPathError(p) ?? '', /\.\./, p);
  }
});

test('rejects URLs and protocol-relative paths', () => {
  assert.ok(rawPathError('//evil.com/api/x'));
  assert.ok(rawPathError('/api/x?u=http://evil.com') );
  assert.ok(rawPathError('https://evil.com/api/x'));
});

test('rejects a missing /api/ prefix and non-strings', () => {
  for (const p of ['/x', 'api/x', '/api', '', undefined, null, 5]) {
    assert.ok(rawPathError(p), String(p));
  }
});

test('rejects malformed percent-escapes', () => {
  assert.ok(rawPathError('/api/%zz'));
});

test('allows ".." inside a segment name', () => {
  assert.equal(rawPathError('/api/a..b/c'), null);
});
