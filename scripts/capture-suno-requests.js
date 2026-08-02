/**
 * Suno request capture — paste into the browser DevTools console on suno.com.
 *
 * Records every Suno API call (URL, method, request body, response body) while
 * you drive the UI, so a new feature's payload shape can be read off directly
 * instead of guessed at.
 *
 * WHY THIS EXISTS: "Copy as cURL" embeds your Authorization bearer token and
 * full session cookie. This captures no headers at all, and additionally
 * redacts credential-shaped values found inside bodies. What it produces is
 * safe to paste into a chat; a cURL export is not.
 *
 * ── USAGE ─────────────────────────────────────────────────────────────────
 *   1. Open suno.com, press F12, go to Console.
 *   2. Paste this whole file, press Enter.  (Chrome may require you to type
 *      "allow pasting" first.)
 *   3. Do the thing you want captured — Replace Section, Crop, Fade, etc.
 *   4. Run:  __sunoCapture.copy()      // JSON copied to clipboard
 *      or:   __sunoCapture.dump()      // print to console
 *      or:   __sunoCapture.save()      // download as a .json file
 *
 *   __sunoCapture.list()    one-line summary of what's been caught
 *   __sunoCapture.clear()   start over
 *   __sunoCapture.stop()    unhook and restore the originals
 * ──────────────────────────────────────────────────────────────────────────
 */
(() => {
  if (window.__sunoCapture) {
    console.warn('[capture] already running — call __sunoCapture.stop() first to reinstall.');
    return;
  }

  // Only capture Suno's own API. Everything else is analytics noise.
  const INCLUDE = /suno\.(com|ai)\/api\//i;
  const EXCLUDE = /datadoghq|braze|stratovibe|agg-receiver|sentry|segment|posthog|google|intercom/i;

  // Endpoints that fire constantly and carry nothing useful. Several of these
  // are POSTs, so this has to apply regardless of method or the interesting
  // write gets buried under a hundred housekeeping calls.
  const BORING = /\/api\/billing\/|usage-plan|nudge-check|\/status\/$|waveform-aggregates|warmup-audio-features|downbeats_streaming|mango\/rights|\/rum\b/i;

  const SECRET_KEY = /^(authorization|cookie|token|session|jwt|api[_-]?key|secret|password|bearer|access[_-]?token|refresh[_-]?token)$/i;
  const JWT_LIKE = /^ey[A-Za-z0-9_-]{8,}\./;
  const LONG_OPAQUE = /^[A-Za-z0-9_\-]{120,}$/;

  const MAX_STRING = 400; // keep lyrics/prompt blobs from bloating the dump
  const entries = [];

  /** Recursively strip anything credential-shaped. */
  function redact(value, key) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
      if (key && SECRET_KEY.test(key)) return '<redacted>';
      if (JWT_LIKE.test(value)) return '<redacted:jwt>';
      if (LONG_OPAQUE.test(value)) return '<redacted:opaque>';
      return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + `…<+${value.length - MAX_STRING} chars>` : value;
    }
    if (Array.isArray(value)) return value.map((v) => redact(v));
    if (typeof value === 'object') {
      const out = {};
      for (const k of Object.keys(value)) out[k] = redact(value[k], k);
      return out;
    }
    return value;
  }

  function parseMaybeJson(text) {
    if (typeof text !== 'string' || !text) return text ?? null;
    try { return JSON.parse(text); } catch { return text.slice(0, MAX_STRING); }
  }

  function wanted(url, method) {
    if (!url || !INCLUDE.test(url) || EXCLUDE.test(url)) return false;
    return !BORING.test(url);
  }

  function record(e) {
    entries.push(e);
    const tag = e.method === 'GET' ? '' : '  ← BODY';
    console.log(`[capture ${entries.length}] ${e.method} ${e.path}${tag}`);
  }

  // ---- fetch ----------------------------------------------------------
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input?.url;
    const method = (init?.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase();

    // Snapshot the request body BEFORE dispatching. Once fetch() consumes a
    // Request its body is locked and a later clone().text() yields nothing —
    // which is exactly how an earlier version of this script recorded every
    // payload as null.
    let reqBody = null;
    if (wanted(url, method) && method !== 'GET') {
      try {
        const raw = init?.body;
        if (typeof raw === 'string') reqBody = raw;
        else if (raw instanceof URLSearchParams) reqBody = raw.toString();
        else if (raw instanceof Blob) reqBody = await raw.text();
        else if (raw) reqBody = '<non-text body>';
        else if (input && typeof input === 'object' && typeof input.clone === 'function') {
          reqBody = await input.clone().text();
        }
      } catch (err) {
        reqBody = `<unreadable body: ${err?.message}>`;
      }
    }

    const res = await origFetch.apply(this, arguments);

    try {
      if (wanted(url, method)) {
        let resBody = null;
        try {
          const ct = res.headers.get('content-type') || '';
          if (ct.includes('json')) resBody = parseMaybeJson(await res.clone().text());
        } catch { /* body already consumed or opaque */ }

        record({
          method,
          url: String(url).split('?')[0],
          path: new URL(url, location.origin).pathname,
          query: new URL(url, location.origin).search || undefined,
          status: res.status,
          request: redact(parseMaybeJson(reqBody)),
          response: redact(resBody),
          via: 'fetch'
        });
      }
    } catch (err) {
      console.debug('[capture] skipped a fetch:', err?.message);
    }
    return res;
  };

  // ---- XMLHttpRequest -------------------------------------------------
  const OrigOpen = XMLHttpRequest.prototype.open;
  const OrigSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__cap = { method: String(method || 'GET').toUpperCase(), url: String(url) };
    return OrigOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const cap = this.__cap;
    if (cap && wanted(cap.url, cap.method)) {
      this.addEventListener('load', () => {
        try {
          record({
            method: cap.method,
            url: cap.url.split('?')[0],
            path: new URL(cap.url, location.origin).pathname,
            status: this.status,
            request: redact(parseMaybeJson(typeof body === 'string' ? body : null)),
            response: redact(parseMaybeJson(this.responseText)),
            via: 'xhr'
          });
        } catch { /* ignore */ }
      });
    }
    return OrigSend.apply(this, arguments);
  };

  const json = () => JSON.stringify(entries, null, 2);

  window.__sunoCapture = {
    entries,
    count: () => entries.length,
    list() {
      console.table(entries.map((e, i) => ({ '#': i, method: e.method, path: e.path, status: e.status, hasBody: !!e.request })));
    },
    dump() { console.log(json()); return json(); },
    copy() {
      const text = json();
      // The DevTools `copy()` built-in is not always reachable from inside a
      // pasted closure, so fall back rather than silently throwing.
      try {
        // eslint-disable-next-line no-undef
        copy(text);
        console.log(`[capture] ${entries.length} entries copied to clipboard.`);
        return;
      } catch { /* fall through */ }
      navigator.clipboard?.writeText(text).then(
        () => console.log(`[capture] ${entries.length} entries copied to clipboard.`),
        () => { console.warn('[capture] clipboard blocked — use __sunoCapture.save() instead.'); console.log(text); }
      );
    },
    save() {
      const blob = new Blob([json()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `suno-capture-${Date.now()}.json`;
      a.click();
      console.log('[capture] downloaded.');
    },
    clear() { entries.length = 0; console.log('[capture] cleared.'); },
    stop() {
      window.fetch = origFetch;
      XMLHttpRequest.prototype.open = OrigOpen;
      XMLHttpRequest.prototype.send = OrigSend;
      delete window.__sunoCapture;
      console.log('[capture] stopped, originals restored.');
    }
  };

  console.log(
    '%c[capture] armed.%c Drive the UI, then run __sunoCapture.copy()\n' +
      'Headers are never recorded; JWTs and long opaque strings inside bodies are redacted.',
    'color:#0a0;font-weight:bold', 'color:inherit'
  );
})();
