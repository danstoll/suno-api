// Poll Suno's post-upload check (ACRCloud catalog match) before initialize-clip.
// `getUpload` returns {status, data} for GET /api/uploads/audio/{id}/ and must
// not throw on a non-200. Returns {outcome: 'complete'|'error'|'missing'|'timeout', data}.
export async function waitForUploadCheck(getUpload, { intervalMs = 3000, timeoutMs = 120000, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let waited = 0;
  for (;;) {
    const { status, data } = await getUpload();
    if (status === 404) return { outcome: 'missing', data };
    if (status === 200) {
      if (data?.status === 'complete') return { outcome: 'complete', data };
      if (data?.status === 'error') return { outcome: 'error', data };
    }
    if (waited >= timeoutMs) return { outcome: 'timeout', data };
    await sleep(intervalMs);
    waited += intervalMs;
  }
}
