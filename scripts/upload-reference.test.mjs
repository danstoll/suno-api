// Unit tests for the pure content-match predicate in upload-reference.mjs.
// No network, no Suno, no browser -- run with:
//
//   node --test scripts/upload-reference.test.mjs
//
// Importing upload-reference.mjs must NOT run the CLI (argv validation,
// main()) -- it is guarded behind an `isMain` check so these tests can pull
// in detectContentMatch/extractMessage safely. detectContentMatch itself is
// the pure predicate: it returns a message string or null, and never calls
// console.log/process.exit -- unlike the CLI's checkContentMatch wrapper,
// which is intentionally not exported (it exits the process on a hit, which
// would kill a test run rather than let it assert on the result).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { detectContentMatch, extractMessage, CONTENT_MATCH_RE } from './upload-reference.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('./upload-reference.mjs', import.meta.url));

test('CONTENT_MATCH_RE sanity: matches the vocabulary it exists to catch', () => {
  assert.ok(CONTENT_MATCH_RE.test('copyright'));
  assert.ok(CONTENT_MATCH_RE.test('This audio matches an existing recording in our catalog.'));
});

test('detects a real Suno content-match rejection shape', () => {
  // RED (pre-fix) would have passed too, since extractMessage already had
  // `detail` in its allowlist -- this one was never the bug. Included as a
  // baseline: the fix must not regress the actual case it exists to catch.
  const data = { detail: 'This audio matches an existing recording in our catalog.' };
  assert.equal(detectContentMatch(data), 'This audio matches an existing recording in our catalog.');
});

test('detects the real error_type/error_message shape from GET /api/uploads/audio/{id}/', () => {
  const data = {
    id: 'abc123', status: 'error',
    error_type: 'upload_failure_match_acrcloud',
    error_message: 'This audio matches an existing recording in our catalog.',
    title: '', copyright_muted: false
  };
  assert.equal(detectContentMatch(data), 'This audio matches an existing recording in our catalog.');
});

test('does NOT flag a benign field whose KEY happens to contain "copyright" (the bug this predicate exists to fix)', () => {
  // RED before the fix: the original implementation stringified the WHOLE
  // object and regex-tested that, so `"copyright_muted":false` alone
  // (present on every upload-status response, including a totally benign
  // "processing" poll) tripped CONTENT_MATCH_RE on the field NAME and
  // false-flagged every single run. GREEN after the fix: detectContentMatch
  // only ever inspects extractMessage's fixed allowlist of VALUE fields, so
  // a key named copyright_muted is never even looked at.
  const data = { id: 'abc123', status: 'processing', title: '', copyright_muted: false };
  assert.equal(detectContentMatch(data), null);
  assert.equal(extractMessage(data), null);
});

test('does NOT flag a benign field whose KEY contains "copyright" even when the value is true', () => {
  const data = { id: 'abc123', status: 'complete', copyright_muted: true };
  assert.equal(detectContentMatch(data), null);
});

test('does NOT flag a benign VALUE containing "match" in a field outside the message allowlist', () => {
  const data = {
    id: 'abc123', status: 'complete',
    display_tags: 'Baroque, chamber music, a perfect match for solo cello',
    inferred_description: 'A close match to Baroque chamber style, cello and harpsichord.'
  };
  assert.equal(detectContentMatch(data), null);
});

test('does NOT flag a raw AWS SignatureDoesNotMatch XML string (an S3 infrastructure error, not a Suno content decision)', () => {
  const xml = '<?xml version="1.0" encoding="UTF-8"?><Error><Code>SignatureDoesNotMatch</Code>' +
    '<Message>The request signature we calculated does not match the signature you provided. ' +
    'Check your key and signing method.</Message></Error>';
  // A raw string is not a structured Suno response object -- extractMessage
  // only ever reads named fields off an object, so a bare string can never
  // reach the regex test, no matter what words it contains. This is what
  // makes it safe for uploadViaApi to never even call this predicate on an
  // S3 response (see the static check below): even if it accidentally did,
  // a plain string input is inert.
  assert.equal(extractMessage(xml), null);
  assert.equal(detectContentMatch(xml), null);
});

test('does NOT flag the user-supplied --description echoed back in a non-message field', () => {
  const description = 'Solo piano rendering of a slow four-bar Baroque adagio, played twice, then ' +
    'a quicker figure; cello on the bass line. Synthesised from a public-domain MIDI score, not a recording.';
  // "recording" appears in the real description text used for this task's
  // proof run. If it were echoed back by Suno in some unrelated field (e.g.
  // `title`, which set_metadata could plausibly mirror), it must not be
  // mistaken for a rejection just because the word shows up somewhere.
  const data = { id: 'abc123', status: 'complete', title: description };
  assert.equal(detectContentMatch(data), null);
});

test('does NOT flag a malformed upload-slot response missing url/id, even though the sanitized report mentions "fields"', () => {
  // Mirrors what uploadViaApi/uploadViaBrowser now report on a missing
  // url/id (finding 4): presence flags only, never the raw fields object
  // (which would carry S3 credentials) or the url itself.
  const data = { missing: 'url', has_url: false, has_id: true, has_fields: true };
  assert.equal(detectContentMatch(data), null);
});

test('null/undefined/non-object input is always safe', () => {
  assert.equal(detectContentMatch(null), null);
  assert.equal(detectContentMatch(undefined), null);
  assert.equal(detectContentMatch(42), null);
  assert.equal(detectContentMatch([]), null);
  assert.equal(extractMessage(null), null);
});

test('static check: the API-path S3 upload block never calls the content-match predicate', () => {
  // Finding 1's fix is a call-site removal, not a predicate change (a raw S3
  // body is already inert against detectContentMatch, proven above) -- so
  // the only way to actually prove "the S3 path can no longer reach the
  // predicate at all" without a network call is to check the source itself.
  const src = readFileSync(SCRIPT_PATH, 'utf8');
  const start = src.indexOf('// Step 2: push the raw bytes straight to S3');
  const end = src.indexOf('// Step 3: tell Suno the upload finished.');
  assert.ok(start !== -1 && end !== -1 && start < end, 'could not locate the API S3 upload block by its comments');
  const block = src.slice(start, end);
  assert.doesNotMatch(block, /checkContentMatch\(|detectContentMatch\(/,
    'the API S3 upload block must never call the content-match predicate on an S3 response');
});

test('static check: the browser-fallback S3 upload block never calls the content-match predicate', () => {
  const src = readFileSync(SCRIPT_PATH, 'utf8');
  const start = src.indexOf('const blob = b64ToBlob(fileB64);');
  const end = src.indexOf('const step3 = await call(');
  assert.ok(start !== -1 && end !== -1 && start < end, 'could not locate the browser S3 upload block by its markers');
  const block = src.slice(start, end);
  assert.doesNotMatch(block, /checkContentMatch\(|detectContentMatch\(/,
    'the browser S3 upload block must never call the content-match predicate on an S3 response');
});
