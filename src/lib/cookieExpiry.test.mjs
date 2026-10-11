import test from 'node:test';
import assert from 'node:assert/strict';
import { cookieExpiry } from './cookieExpiry.mjs';

const jwt = (payload) =>
  ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig'].join('.');

test('reads exp from the __client JWT', () => {
  const c = `a=1; __client=${jwt({ exp: 1800000000 })}; b=2`;
  assert.equal(cookieExpiry(c), new Date(1800000000 * 1000).toISOString());
});

test('returns null when __client is missing', () => {
  assert.equal(cookieExpiry('a=1; b=2'), null);
  assert.equal(cookieExpiry(''), null);
  assert.equal(cookieExpiry(undefined), null);
});

test('returns null for a malformed JWT', () => {
  assert.equal(cookieExpiry('__client=notajwt'), null);
  assert.equal(cookieExpiry('__client=a.!!!.c'), null);
});

test('returns null when exp is absent or not a number', () => {
  assert.equal(cookieExpiry(`__client=${jwt({ sub: 'x' })}`), null);
  assert.equal(cookieExpiry(`__client=${jwt({ exp: 'soon' })}`), null);
});

test('output never contains any part of the cookie', () => {
  const token = jwt({ exp: 1800000000, sub: 'secret-user' });
  const out = String(cookieExpiry(`__client=${token}`));
  for (const piece of token.split('.')) assert.ok(!out.includes(piece));
  assert.ok(!out.includes('secret-user'));
});
