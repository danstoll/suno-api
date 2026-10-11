/**
 * Shared WAV download for Suno clips (used by fade-out.mjs and archive-track.mjs).
 *
 * Suno discontinued MP3 downloads on 2026-09-18, and `audio_url` is now a
 * placeholder on every clip. The only working path is Suno's WAV export,
 * driven through the /api/raw passthrough since neither call is wrapped:
 *   1. POST /api/gen/{id}/convert_wav/ -- 204 on success; 402 = account needs
 *      Suno Pro/Premier; 403 = clip is not WAV-convertible (not the
 *      logged-in account's own clip, or otherwise ineligible).
 *   2. GET /api/gen/{id}/wav_file/ -- poll; `{}` while converting, then
 *      `wav_file_url`, a presigned S3 URL fetchable without auth.
 * See CAPABILITIES.md, "Known dead".
 */

import { writeFileSync } from 'node:fs';

export async function rawGet(api, sunoPath, fetchImpl = fetch) {
  const res = await fetchImpl(`${api}/api/raw?path=${encodeURIComponent(sunoPath)}`);
  const json = await parseRawResponse(res, sunoPath);
  if (json?.suno_status !== 200) {
    throw new Error(`${sunoPath} -> suno ${json?.suno_status}: ${JSON.stringify(json?.data ?? null).slice(0, 200)}`);
  }
  return json.data;
}

export async function rawPost(api, sunoPath, body, fetchImpl = fetch) {
  const res = await fetchImpl(`${api}/api/raw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: sunoPath, method: 'POST', body })
  });
  const json = await parseRawResponse(res, sunoPath);
  if (json?.suno_status !== 200 && json?.suno_status !== 204) {
    throw new Error(`${sunoPath} -> suno ${json?.suno_status}: ${JSON.stringify(json?.data ?? null).slice(0, 200)}`);
  }
  return json.data;
}

/**
 * /api/raw always wraps with local HTTP 200 on a real Suno response, but our
 * own dev server can still fail before reaching that point (a 500, a Next.js
 * HTML error page, a proxy timeout page) -- none of which are JSON. Surface
 * the wrapper's HTTP status and a snippet instead of a bare SyntaxError.
 */
async function parseRawResponse(res, sunoPath) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${sunoPath} -> /api/raw returned non-JSON (local HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
}

/**
 * Convert a clip to WAV, wait for it, and write it to `dest`.
 * `fetchImpl`, `sleep` and `log` are injectable so tests make no network calls.
 */
export async function downloadClipWav(api, clipId, dest, opts = {}) {
  const {
    fetchImpl = fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    log = console.warn,
    polls = 40,
    pollMs = 3000
  } = opts;

  try {
    await rawPost(api, `/api/gen/${clipId}/convert_wav/`, null, fetchImpl);
  } catch (err) {
    if (/\b402\b/.test(err.message)) throw new Error(`WAV requires Suno Pro or Premier: ${err.message}`);
    if (/\b403\b/.test(err.message)) {
      throw new Error(`Clip ${clipId} is not WAV-convertible. The WAV export needs the clip's owner to be the logged-in account (check SUNO_COOKIE belongs to the account that made it): ${err.message}`);
    }
    log(`  (convert_wav trigger failed, polling anyway in case it's already converted: ${err.message})`);
  }

  let downloadUrl;
  let lastPollError;
  for (let i = 0; i < polls; i++) {
    let d;
    try {
      d = await rawGet(api, `/api/gen/${clipId}/wav_file/`, fetchImpl);
    } catch (err) {
      // One flaky poll should not burn the whole budget.
      lastPollError = err;
      log(`  (poll ${i + 1}/${polls} failed, retrying: ${err.message})`);
      await sleep(pollMs);
      continue;
    }
    if (d?.wav_file_url) { downloadUrl = d.wav_file_url; break; }
    await sleep(pollMs);
  }
  if (!downloadUrl) {
    const suffix = lastPollError ? ` (last poll error: ${lastPollError.message})` : '';
    throw new Error(`WAV conversion never finished for clip ${clipId} after ${Math.round(polls * pollMs / 1000)}s${suffix}`);
  }

  const audio = await fetchImpl(downloadUrl);
  // The URL carries temporary AWS SigV2 query params -- keep them out of
  // error text so shared/logged output holds no credentials.
  if (!audio.ok) throw new Error(`Download failed: ${audio.status} (${downloadUrl.split('?')[0]})`);
  writeFileSync(dest, Buffer.from(await audio.arrayBuffer()));
  return dest;
}
