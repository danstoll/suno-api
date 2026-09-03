#!/usr/bin/env node
/**
 * Upload a reference audio file into a Suno workspace as a real clip —
 * automating what an older script's header claimed was blocked by a bot wall.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * `make-cover-from-reference.mjs`'s header says steps 1-4 (upload ->
 * initialize-clip) 400 with an EMPTY body and reads like a WAF/bot wall.
 * Live testing here (2026-09-02) found the real shape of it:
 *
 *   1. POST /api/uploads/audio/                      {extension, upload_type}
 *      -> presigned S3 fields. `suno_status: 200` for BOTH "studio_file_upload"
 *      (the captured web-client value, tried first) and "file_upload" (what
 *      upload-external-audio.mjs sends) — steps 1-3 were never blocked.
 *   2. (raw bytes -> S3, straight to AWS, never through /api/raw)
 *   3. POST /api/uploads/audio/{id}/upload-finish/    {upload_type, upload_filename, agreed_to_vip_upload_terms}
 *   3b. GET  /api/uploads/audio/{id}/  — poll this. THE REAL DISCOVERY: Suno
 *      runs an async content-review job after upload-finish. Its `status`
 *      moves processing -> passed_audio_processing -> passed_artist_moderation
 *      -> complete (confirmed by timing: ~70-90s on a clean file), or lands on
 *      status:"error" with `error_type`/`error_message` — e.g.
 *      `upload_failure_match_acrcloud` / "This audio matches an existing
 *      recording in our catalog." THIS is where a genuine content-match
 *      rejection actually shows up. `initialize-clip` 400s with a
 *      completely EMPTY body (no detail/error_type at all) for as long as
 *      this review is unfinished, REGARDLESS of body shape — {} and
 *      {user_reviewed_tags:true} fail identically until the review lands.
 *      That symmetry is exactly what made the older script's header read as
 *      a WAF: it never polled this endpoint, so it never saw the real
 *      reason. Skipping this poll doesn't just lose information — it makes
 *      this script's whole exit-2-vs-exit-1 job impossible to do correctly.
 *   4. POST /api/uploads/audio/{id}/initialize-clip/  {user_reviewed_tags: true}
 *      -> {clip_id}. Confirmed working (suno_status 200) once 3b reports
 *      "complete". The captured body is used regardless (not re-tested
 *      against {} once complete, since the captured value is the authority
 *      per this task's brief) but note the wait in 3b is the necessary part.
 *   5. POST /api/gen/{clip_id}/set_metadata/          {title}
 *   6. POST /api/gen/{clip_id}/set_audio_description  {user_corrected_description}
 *      (retries once with {description} if the first field name 400s)
 *   7. POST /api/project/{id}/clips                   {update_type:"add", metadata:{clip_ids:[clip_id]}}
 *      -> expects suno_status 204 (same call make-track-oneshot.mjs makes)
 *
 * ── Content-match rejections are not generic errors ─────────────────────
 * If any step's response body (this includes the 3b poll's terminal
 * "error" status) matches /match|copyright|existing recording|not allowed|
 * rights/i, this prints `FLAGGED: <message>` to STDOUT and exits 2
 * immediately — never retried, never treated as a bot-wall failure. Every
 * other failure exits 1. A caller's fallback ladder branches on that exit
 * code, so getting this distinction right matters more than anything else
 * in this file.
 *
 * ── The pacing/captcha gate ──────────────────────────────────────────────
 * `--reset-gate` asks Suno first (`POST /api/c/check {ctype:"generation"}`)
 * whether it is currently challenging. If not, this is a no-op. If so, it
 * shells out to `profile-capture.mjs`, which drives the warm persistent
 * browser profile through one throwaway generation — the same call that
 * clears the pacing wall in `batch-tracks.mjs` — then re-checks once. Still
 * required after that -> exit 1. `--reset-gate-only` runs just that sequence
 * (no upload) and exits. NOTE this is a DIFFERENT gate from the 3b content
 * review above — `/api/c/check` never flagged this session (checked
 * `required: false` throughout), so a clear c/check does not mean the
 * upload pipeline's own async review is clear too.
 *
 * ── The browser fallback ──────────────────────────────────────────────────
 * `--via browser` (or `--via auto` after the API path 400s/403s on
 * something that is not a content match) re-issues the same calls from
 * inside the warm profile via `rebrowser-playwright-core`, using
 * `page.evaluate` to `fetch(..., {credentials:'include'})` against
 * `https://studio-api.prod.suno.com` — same origin, same cookies, same
 * trust as the tab that works by hand (see profile-capture.mjs's header for
 * why an ephemeral automated browser is challenged harder than a warm one).
 * It runs the same 3b poll in-page before calling initialize-clip.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *   node scripts/upload-reference.mjs --file <ref.mp3> --title "REF NN Title" \
 *     --project <workspace-id> --description "<what is audible>" \
 *     [--reset-gate] [--via api|browser|auto] [--extension mp3] [--api URL]
 *
 *   node scripts/upload-reference.mjs --reset-gate-only
 *
 * On success: exactly one line on stdout, `clip_id: <uuid>`, exit 0.
 * On a content-match rejection: `FLAGGED: <reason>` on stdout, exit 2.
 * Any other failure: message on stderr, exit 1. All progress goes to stderr
 * so stdout stays parseable by a caller.
 *
 * Never prints the file's bytes, a cookie, a token, or a presigned URL's
 * query string — only the S3 host.
 */

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const API = args.api ?? 'http://localhost:3060';
const VIA = String(args.via ?? 'api').toLowerCase();

export const CONTENT_MATCH_RE = /match|copyright|existing recording|not allowed|rights/i;

// How long to wait for Suno's async post-upload content review (3b above) to
// land on a terminal status before giving up. Measured once at ~90s for a
// clean file and ~18s for a rejected one — this leaves real headroom.
const UPLOAD_REVIEW_MAX_MS = 5 * 60 * 1000;
const UPLOAD_REVIEW_POLL_MS = 3000;

/** A definitive, non-retryable failure: print the message and exit 1. */
class FatalError extends Error {}

/** One upload-chain call came back with an unexpected suno_status. Carries
 *  the status so the caller can decide whether it is fallback-shaped. */
class StepError extends Error {
  constructor(stepPath, status, bodyText) {
    super(`${stepPath} -> suno ${status}: ${bodyText}`);
    this.stepPath = stepPath;
    this.status = status;
  }
}

// Only run the CLI when this file is executed directly (`node
// upload-reference.mjs ...`), never when it is imported as a module -- the
// test file imports pure predicates (detectContentMatch, extractMessage)
// from this same file and must not trigger argv validation or main().
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (!['api', 'browser', 'auto'].includes(VIA)) {
    console.error(`--via must be api|browser|auto, got "${VIA}".`);
    process.exit(1);
  }

  main().catch((err) => {
    if (err instanceof FatalError) {
      console.error(err.message);
      process.exit(1);
    }
    console.error(err?.stack ?? err?.message ?? String(err));
    process.exit(1);
  });
}

async function main() {
  if (args['reset-gate-only']) {
    await resetGateIfNeeded();
    console.error('Gate check complete.');
    process.exit(0);
  }

  if (!args.file) fail('Need --file <path>. See header.');
  if (!args.title) fail('Need --title "<name>". See header.');
  if (!args.project) fail('Need --project <workspace-id>. See header.');
  if (!args.description) fail('Need --description "<what is actually audible in the reference file>". See header.');
  if (!existsSync(args.file)) fail(`Not found: ${args.file}`);

  if (args['reset-gate']) {
    await resetGateIfNeeded();
  }

  const uploadArgs = {
    filePath: String(args.file),
    title: String(args.title),
    projectId: String(args.project),
    description: String(args.description),
    extension: String(args.extension ?? path.extname(args.file).replace(/^\./, '')).toLowerCase()
  };

  let clipId;
  if (VIA === 'browser') {
    clipId = await uploadViaBrowser(uploadArgs);
  } else {
    try {
      clipId = await uploadViaApi(uploadArgs);
    } catch (err) {
      const fallbackShaped = err instanceof StepError && (err.status === 400 || err.status === 403);
      if (VIA === 'auto' && fallbackShaped) {
        console.error(`\n[api] failed at ${err.stepPath} (suno_status ${err.status}), falling back to --via browser...`);
        clipId = await uploadViaBrowser(uploadArgs);
      } else {
        throw err;
      }
    }
  }

  if (!clipId) throw new FatalError('Upload chain finished without a clip_id — this is a bug in this script.');
  console.log(`clip_id: ${clipId}`);
  process.exit(0);
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

// ---------------------------------------------------------------- gate reset

async function isChallenged() {
  const data = await rawPost('/api/c/check', { ctype: 'generation' });
  return data?.required === true;
}

/** No-op when Suno is not challenging. Otherwise clears it via a throwaway
 *  generation from the warm profile, then re-checks once. */
async function resetGateIfNeeded() {
  console.error('Checking Suno challenge gate (/api/c/check)...');
  let required = await isChallenged();
  if (!required) {
    console.error('  gate is clear — nothing to reset.');
    return false;
  }
  console.error('  gate is UP. Running profile-capture.mjs to clear it (costs one throwaway generation)...');
  // profile-capture.mjs logs its own progress via console.log at a dozen+
  // sites. None of that may reach THIS process's stdout, which a caller
  // parses as exactly one clip_id/FLAGGED line -- so its stdout is piped,
  // not inherited, and re-emitted on stderr instead.
  const res = spawnSync(process.execPath, [path.join(SCRIPT_DIR, 'profile-capture.mjs')], {
    stdio: ['inherit', 'pipe', 'inherit']
  });
  if (res.stdout && res.stdout.length) {
    console.error(res.stdout.toString('utf8').replace(/\n+$/, ''));
  }
  if (res.error) throw new FatalError(`Could not run profile-capture.mjs: ${res.error.message}`);
  if (res.status !== 0) {
    throw new FatalError(`profile-capture.mjs exited ${res.status} — gate reset failed. See its output above.`);
  }

  console.error('  re-checking gate...');
  required = await isChallenged();
  if (required) {
    throw new FatalError('Suno is still challenging after profile-capture.mjs — gate reset failed. ' +
      'Try generating one song by hand in the Suno web UI, then re-run.');
  }
  console.error('  gate cleared.');
  return true;
}

// ------------------------------------------------------------ content match

export function extractMessage(dataObj) {
  if (dataObj && typeof dataObj === 'object') {
    // Empirically observed from live Suno responses (2026-09-02) -- not
    // documented anywhere, and not guaranteed exhaustive.
    for (const key of ['error_message', 'detail', 'message', 'error', 'reason', 'error_type']) {
      if (typeof dataObj[key] === 'string') return dataObj[key];
    }
  }
  return null;
}

/**
 * Pure predicate, no side effects: does this Suno response object carry
 * content-match language in one of its known message-shaped fields? Returns
 * the matched message (trimmed to 200 chars), or null.
 *
 * Deliberately does NOT scan a whole stringified object and does NOT accept
 * a raw string -- only a structured object via extractMessage's fixed field
 * allowlist. That is what keeps a routine field like the upload-status
 * endpoint's `copyright_muted` boolean (whose NAME contains "copyright")
 * from ever being mistaken for a rejection, and what keeps an S3
 * infrastructure error's raw body (which commonly contains the literal word
 * "match", e.g. AWS's `SignatureDoesNotMatch`) from ever reaching this
 * check at all -- a bare string is not a structured object, so
 * extractMessage returns null for it unconditionally, no matter what words
 * it contains.
 */
export function detectContentMatch(data) {
  const target = extractMessage(data);
  if (!target || !CONTENT_MATCH_RE.test(target)) return null;
  return String(target).slice(0, 200);
}

/** Side-effecting wrapper used throughout the CLI: prints FLAGGED to stdout
 *  and exits 2 immediately when detectContentMatch finds something. A
 *  content-match rejection is a valid, final result, never a generic error
 *  and never worth retrying via the browser fallback. */
function checkContentMatch(data) {
  const message = detectContentMatch(data);
  if (message === null) return;
  console.log(`FLAGGED: ${message}`);
  process.exit(2);
}

// --------------------------------------------------------------- /api/raw

/** POST through this fork's /api/raw passthrough. Logs the suno_status to
 *  stderr, checks the response for a content-match rejection before doing
 *  anything else, then throws StepError if the status is not one of
 *  `expectStatuses`. */
async function rawPost(sunoPath, body, expectStatuses = [200]) {
  const res = await fetch(`${API}/api/raw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: sunoPath, method: 'POST', body })
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new FatalError(`${sunoPath} -> local /api/raw returned non-JSON (local HTTP ${res.status}): ${text.slice(0, 200)}`); }
  if (json?.error) throw new FatalError(`${sunoPath} -> local /api/raw error: ${json.error}`);

  const status = json.suno_status;
  console.error(`  POST ${sunoPath} -> suno_status ${status}`);
  checkContentMatch(json.data);
  if (!expectStatuses.includes(status)) {
    throw new StepError(sunoPath, status, JSON.stringify(json.data ?? null).slice(0, 300));
  }
  return json.data;
}

/** GET through /api/raw. Same content-match/status-check contract as rawPost. */
async function rawGet(sunoPath, expectStatuses = [200]) {
  const res = await fetch(`${API}/api/raw?path=${encodeURIComponent(sunoPath)}`);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new FatalError(`${sunoPath} -> local /api/raw returned non-JSON (local HTTP ${res.status}): ${text.slice(0, 200)}`); }
  if (json?.error) throw new FatalError(`${sunoPath} -> local /api/raw error: ${json.error}`);

  const status = json.suno_status;
  checkContentMatch(json.data);
  if (!expectStatuses.includes(status)) {
    throw new StepError(sunoPath, status, JSON.stringify(json.data ?? null).slice(0, 300));
  }
  return json.data;
}

/**
 * Step 3b: poll Suno's async post-upload content review until it lands on a
 * terminal status. Only "complete" and "error" are treated as terminal —
 * any other string (the three seen live are "processing",
 * "passed_audio_processing", "passed_artist_moderation", in that order, but
 * Suno can add more without notice) is treated as "still working" so an
 * unrecognised future stage can't be mistaken for done, which is exactly the
 * bug this poll exists to avoid.
 *
 * Returns the terminal status object on success. Never throws for a
 * content-match "error" — that goes through checkContentMatch (exit 2) same
 * as everywhere else; an "error" status whose text does NOT match
 * content-match language is surfaced as a StepError (generic failure,
 * exit 1) since Suno's error_type set beyond the ACR match case is
 * undocumented.
 */
async function waitForUploadReady(uploadId) {
  const deadline = Date.now() + UPLOAD_REVIEW_MAX_MS;
  let last = null;
  while (Date.now() < deadline) {
    const data = await rawGet(`/api/uploads/audio/${uploadId}/`);
    if (data?.status !== last) {
      console.error(`  content review: ${data?.status}`);
      last = data?.status;
    }
    if (data?.status === 'complete') return data;
    if (data?.status === 'error') {
      checkContentMatch(data); // exits(2) if this is a content-match rejection
      throw new StepError(`/api/uploads/audio/${uploadId}/`, 0,
        `upload failed content review (non-content-match): ${JSON.stringify(data).slice(0, 300)}`);
    }
    await sleep(UPLOAD_REVIEW_POLL_MS);
  }
  throw new StepError(`/api/uploads/audio/${uploadId}/`, 0,
    `content review still "${last}" after ${Math.round(UPLOAD_REVIEW_MAX_MS / 1000)}s — timed out.`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// -------------------------------------------------------------- API upload

async function uploadViaApi({ filePath, title, projectId, description, extension }) {
  const fileName = path.basename(filePath);
  const fileBuf = readFileSync(filePath);

  console.error(`\n[api] uploading "${fileName}" as .${extension} ...`);

  // Step 1: presigned upload slot. Captured web-client value first; the old
  // "file_upload" value as a fallback, since one earlier script sends that.
  let uploadType = 'studio_file_upload';
  let uploadReq;
  try {
    uploadReq = await rawPost('/api/uploads/audio/', { extension, upload_type: uploadType });
  } catch (err) {
    if (!(err instanceof StepError)) throw err;
    console.error(`  upload_type "studio_file_upload" rejected (${err.status}) — retrying with "file_upload"...`);
    uploadType = 'file_upload';
    uploadReq = await rawPost('/api/uploads/audio/', { extension, upload_type: uploadType });
  }
  console.error(`  accepted upload_type: "${uploadType}"`);

  const { url, fields, id: uploadId } = uploadReq ?? {};
  if (!url || !uploadId) {
    // Never stringify the whole response here -- it normally carries
    // `fields` with real S3 credentials (AWSAccessKeyId/policy/signature).
    // Report only which required key is missing plus presence/type of the
    // rest.
    throw new FatalError(`/api/uploads/audio/ response missing ${!url ? 'url' : 'id'} ` +
      `(has_url=${!!url}, has_id=${!!uploadId}, has_fields=${!!(fields && Object.keys(fields).length)}).`);
  }

  // Step 2: push the raw bytes straight to S3 — never through /api/raw,
  // which is pinned to Suno's own API host. S3 has no part in Suno's
  // content decision, so its response body is NEVER passed through
  // checkContentMatch -- a routine AWS failure (e.g. "SignatureDoesNotMatch"
  // from clock skew or an expired policy) contains the literal word "match"
  // and would otherwise be misread as a content-match rejection. Only the
  // S3 host and HTTP status are ever surfaced; the presigned fields/query
  // string and the response body never are.
  const s3Host = new URL(url).host;
  let s3res;
  if (fields && Object.keys(fields).length) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
    form.append('file', new Blob([fileBuf]), fileName);
    s3res = await fetch(url, { method: 'POST', body: form });
    console.error(`  S3 POST -> ${s3res.status} (${s3Host})`);
  } else {
    s3res = await fetch(url, { method: 'PUT', body: fileBuf });
    console.error(`  S3 PUT -> ${s3res.status} (${s3Host})`);
  }
  if (!s3res.ok) {
    throw new StepError(`S3 upload (${s3Host})`, s3res.status,
      'S3 rejected the upload -- a tooling/infrastructure failure, not a Suno content decision.');
  }

  // Step 3: tell Suno the upload finished.
  await rawPost(`/api/uploads/audio/${uploadId}/upload-finish/`, {
    upload_type: uploadType, upload_filename: fileName, agreed_to_vip_upload_terms: false
  });
  console.error('  upload-finish: ok');

  // Step 3b: wait for Suno's async content review to land. See header —
  // this is the step that actually surfaces a content-match rejection, and
  // skipping it makes initialize-clip's own (always-empty) 400 body
  // impossible to interpret correctly.
  console.error('  waiting for content review...');
  await waitForUploadReady(uploadId);
  console.error('  content review: complete');

  // Step 4: turn it into a real clip. The captured web-client body — an
  // empty body is what 400'd for the older script this one replaces, but
  // (per 3b) so does this exact body while the review is still pending.
  const clipData = await rawPost(`/api/uploads/audio/${uploadId}/initialize-clip/`, { user_reviewed_tags: true });
  const clipId = clipData?.clip_id;
  if (!clipId) throw new FatalError(`initialize-clip returned no clip_id: ${JSON.stringify(clipData).slice(0, 200)}`);
  console.error(`  clip created: ${clipId}`);

  // Step 5: name it.
  await rawPost(`/api/gen/${clipId}/set_metadata/`, { title });
  console.error('  set_metadata: ok');

  // Step 6: describe it. Captured field name first, fall back once.
  let descField = 'user_corrected_description';
  try {
    await rawPost(`/api/gen/${clipId}/set_audio_description`, { user_corrected_description: description });
  } catch (err) {
    if (!(err instanceof StepError)) throw err;
    console.error(`  field "user_corrected_description" rejected (${err.status}) — retrying with "description"...`);
    descField = 'description';
    await rawPost(`/api/gen/${clipId}/set_audio_description`, { description });
  }
  console.error(`  set_audio_description: ok (field: ${descField})`);

  // Step 7: file it into the workspace.
  await rawPost(`/api/project/${projectId}/clips`, { update_type: 'add', metadata: { clip_ids: [clipId] } }, [204]);
  console.error('  added reference clip to workspace: ok');

  return clipId;
}

// ---------------------------------------------------------- browser upload

/**
 * Re-issue the same calls from inside the warm persistent browser profile,
 * so they carry the same cookies and trust as a tab that works by hand.
 * Written to the same contract as uploadViaApi (returns a clip_id or
 * throws), including the same 3b content-review poll run in-page. See this
 * script's task report for whether this path was actually exercised live on
 * a given run, versus written but unexercised.
 *
 * Every in-page failure returns a STRUCTURED { error: { step, status, data } }
 * object rather than a pre-formatted string. Node then runs the exact same
 * extractMessage-based detectContentMatch predicate on `data` that every
 * other step in this script uses (via checkContentMatch below) -- never a
 * whole-object text dump, which is what let a routine field name
 * (`copyright_muted`) reintroduce the false-positive class already fixed on
 * the API path. `data` is also never allowed to carry the upload-slot's
 * raw `fields` (S3 credentials) or a presigned URL -- see the "upload slot"
 * and "S3 upload" branches below.
 */
async function uploadViaBrowser({ filePath, title, projectId, description, extension }) {
  console.error('\n[browser] uploading via the warm persistent profile ...');
  const pwNS = await import('rebrowser-playwright-core');
  const chromium = pwNS.chromium ?? pwNS.default?.chromium;
  if (!chromium) throw new FatalError('Could not load chromium from rebrowser-playwright-core.');

  const profileDir = path.resolve(args.profile ?? process.env.BROWSER_PROFILE_DIR ?? path.join(SCRIPT_DIR, '..', '.suno-profile'));
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    viewport: null,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-features=site-per-process',
      '--disable-features=IsolateOrigins',
      '--disable-extensions',
      '--disable-infobars'
    ]
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    console.error('  loading suno.com/create ...');
    await page.goto('https://suno.com/create', { waitUntil: 'domcontentloaded', timeout: 60_000 });

    const fileName = path.basename(filePath);
    const fileB64 = readFileSync(filePath).toString('base64');

    // Everything below runs IN the page's own JS context, so it shares the
    // tab's cookies (`credentials:'include'`) — same-origin, same trust as a
    // human dragging the file into the Suno UI.
    const result = await page.evaluate(async ({ extension, fileName, fileB64, title, description, projectId, reviewMaxMs, reviewPollMs }) => {
      const HOST = 'https://studio-api.prod.suno.com';

      function fail(step, status, data, extra) {
        return { error: { step, status, data }, ...extra };
      }

      async function call(apiPath, body, method = 'POST') {
        const res = await fetch(`${HOST}${apiPath}`, {
          method,
          credentials: 'include',
          headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
          body: method === 'GET' ? undefined : JSON.stringify(body)
        });
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        return { status: res.status, data };
      }

      function b64ToBlob(b64) {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes]);
      }

      let uploadType = 'studio_file_upload';
      let step1 = await call('/api/uploads/audio/', { extension, upload_type: uploadType });
      if (step1.status !== 200) {
        uploadType = 'file_upload';
        step1 = await call('/api/uploads/audio/', { extension, upload_type: uploadType });
      }
      if (step1.status !== 200) return fail('upload slot', step1.status, step1.data);
      const { url, fields, id: uploadId } = step1.data ?? {};
      if (!url || !uploadId) {
        // Never surface the whole response -- it normally carries S3
        // credentials in `fields` (AWSAccessKeyId/policy/signature).
        return fail('upload slot', step1.status, {
          missing: !url ? 'url' : 'id',
          has_url: !!url, has_id: !!uploadId,
          has_fields: !!(fields && Object.keys(fields).length)
        });
      }

      // S3 has no part in Suno's content decision. Its response is reduced
      // to a bare host + HTTP status before ever leaving this function --
      // never a body, never the presigned fields/query string -- and that
      // sanitized {s3Host} object carries no message-shaped field, so it
      // can never reach detectContentMatch's allowlist back in Node either.
      const blob = b64ToBlob(fileB64);
      const s3Host = new URL(url).host;
      let s3res;
      if (fields && Object.keys(fields).length) {
        const form = new FormData();
        for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
        form.append('file', blob, fileName);
        s3res = await fetch(url, { method: 'POST', body: form });
      } else {
        s3res = await fetch(url, { method: 'PUT', body: blob });
      }
      if (!s3res.ok) return fail('S3 upload', s3res.status, { s3Host });

      const step3 = await call(`/api/uploads/audio/${uploadId}/upload-finish/`,
        { upload_type: uploadType, upload_filename: fileName, agreed_to_vip_upload_terms: false });
      if (step3.status !== 200) return fail('upload-finish', step3.status, step3.data);

      // Step 3b: same content-review poll as the API path — see this
      // script's top-level header for why this is not optional.
      const deadline = Date.now() + reviewMaxMs;
      let reviewData = null;
      while (Date.now() < deadline) {
        const st = await call(`/api/uploads/audio/${uploadId}/`, undefined, 'GET');
        if (st.status !== 200) return fail('content review poll', st.status, st.data);
        if (st.data?.status === 'complete') { reviewData = st.data; break; }
        if (st.data?.status === 'error') return fail('content review', st.status, st.data);
        await new Promise((r) => setTimeout(r, reviewPollMs));
      }
      if (!reviewData) return fail('content review', 0, { timed_out_after_ms: reviewMaxMs });

      const step4 = await call(`/api/uploads/audio/${uploadId}/initialize-clip/`, { user_reviewed_tags: true });
      if (step4.status !== 200) return fail('initialize-clip', step4.status, step4.data);
      const clipId = step4.data?.clip_id;
      if (!clipId) return fail('initialize-clip', step4.status, step4.data);

      const step5 = await call(`/api/gen/${clipId}/set_metadata/`, { title });
      if (step5.status !== 200) return fail('set_metadata', step5.status, step5.data, { clipId });

      let descField = 'user_corrected_description';
      let step6 = await call(`/api/gen/${clipId}/set_audio_description`, { user_corrected_description: description });
      if (step6.status !== 200) {
        descField = 'description';
        step6 = await call(`/api/gen/${clipId}/set_audio_description`, { description });
      }
      if (step6.status !== 200) return fail('set_audio_description', step6.status, step6.data, { clipId });

      const step7 = await call(`/api/project/${projectId}/clips`, { update_type: 'add', metadata: { clip_ids: [clipId] } });
      if (step7.status !== 204) return fail('project/clips', step7.status, step7.data, { clipId });

      return { clipId, uploadType, descField };
    }, { extension, fileName, fileB64, title, description, projectId, reviewMaxMs: UPLOAD_REVIEW_MAX_MS, reviewPollMs: UPLOAD_REVIEW_POLL_MS });

    if (result?.error) {
      const { step, status, data } = result.error;
      // Structural fix, not payload discipline: short-circuit S3 failures
      // BEFORE classification, so a future diagnostic addition to `data`
      // (e.g. the S3 body) can never reach checkContentMatch -- S3 has no
      // part in Suno's content decision, matching the API path's equivalent
      // S3 error below.
      if (step === 'S3 upload') {
        throw new FatalError(`[browser] S3 upload -> ${status} (${data?.s3Host ?? 'unknown host'}) — S3 rejected the upload: a tooling/infrastructure failure, not a Suno content decision.`);
      }
      checkContentMatch(data); // exits(2) if this is a genuine content-match rejection
      throw new FatalError(`[browser] ${step} -> ${status}: ${JSON.stringify(data).slice(0, 300)}`);
    }
    if (!result?.clipId) throw new FatalError(`[browser] upload chain returned no clip_id: ${JSON.stringify(result).slice(0, 200)}`);

    console.error(`  [browser] accepted upload_type: "${result.uploadType}", description field: "${result.descField}"`);
    console.error(`  [browser] clip created and filed: ${result.clipId}`);
    return result.clipId;
  } finally {
    try { await context.close(); } catch { /* already gone */ }
  }
}

// -------------------------------------------------------------------- misc

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}
