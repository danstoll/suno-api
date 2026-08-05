/**
 * Capture Suno's verification token from YOUR OWN browser — paste into the
 * DevTools console on suno.com.
 *
 * WHY: Suno's verification lives in a `browser-token` header on the generate
 * request. It can only be lifted from a real generation, and the automation's
 * headless-ish browser is the wrong place to get one — that session is
 * challenged harder, a real hCaptcha appears, solving it does not land a token,
 * and it simply reappears. Your normal signed-in tab generates songs without
 * being challenged at all.
 *
 * So take it from here. The token goes straight to the local server on
 * localhost:3060 and is never printed, never copied, and never passes through
 * a chat transcript. The console shows its length only.
 *
 * ── USAGE ─────────────────────────────────────────────────────────────────
 *   1. Open suno.com (signed in), F12, Console.
 *   2. Paste this whole file, Enter. (Chrome may want "allow pasting" first.)
 *   3. Generate ANY song — a one-word prompt is fine. The token rides on it.
 *   4. Watch for:  [token] captured and sent — the local API can now generate.
 *
 *   __sunoToken.status()   ask the local server whether it holds one
 *   __sunoToken.stop()     unhook
 * ──────────────────────────────────────────────────────────────────────────
 */
(() => {
  const LOCAL = 'http://localhost:3060';

  if (window.__sunoToken) {
    console.warn('[token] already armed — call __sunoToken.stop() first.');
    return;
  }

  // Only the generate call carries it. Matching loosely on purpose: the path
  // has been /api/generate/v2/ and /api/generate/v2-web/ at different times,
  // and a glob ending in "/**" never matched the trailing slash.
  const GENERATE = /\/api\/generate\/v2/;

  let sent = false;
  const origFetch = window.fetch;

  /** Normalise the several shapes fetch accepts into a flat lowercase map. */
  function headerMap(input, init) {
    const out = {};
    const absorb = (h) => {
      if (!h) return;
      try {
        if (typeof h.forEach === 'function' && !Array.isArray(h)) h.forEach((v, k) => { out[String(k).toLowerCase()] = String(v); });
        else if (Array.isArray(h)) for (const p of h) { if (p && p.length === 2) out[String(p[0]).toLowerCase()] = String(p[1]); }
        else if (typeof h === 'object') for (const k of Object.keys(h)) out[k.toLowerCase()] = String(h[k]);
      } catch { /* exotic container — skip rather than break the request */ }
    };
    if (input && typeof input === 'object' && input.headers) absorb(input.headers);
    absorb(init && init.headers);
    return out;
  }

  async function deliver(token, provider) {
    try {
      const res = await origFetch(`${LOCAL}/api/browser_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, provider })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.held) {
        sent = true;
        console.log(
          `%c[token] captured and sent — the local API can now generate.%c\n` +
            `  length ${data.length} chars, provider ${data.provider ?? 'none'}\n` +
            `  Nothing was printed or copied. You can close this tab.`,
          'color:#0a0;font-weight:bold', 'color:inherit'
        );
      } else {
        console.warn('[token] local server rejected it:', data.error ?? res.status);
      }
    } catch (err) {
      console.warn(
        `[token] could not reach ${LOCAL} — is the dev server running?`,
        err?.message ?? err
      );
    }
  }

  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input?.url;
    try {
      if (url && GENERATE.test(url) && !sent) {
        const h = headerMap(input, init);
        const token = h['browser-token'];
        if (token) {
          // Read the provider out of the body; Suno rejects one without the other.
          let provider;
          try {
            const raw = typeof init?.body === 'string' ? init.body : null;
            if (raw) provider = JSON.parse(raw)?.token_provider ?? undefined;
          } catch { /* body not JSON — provider stays undefined */ }
          deliver(token, provider);
        } else {
          console.debug('[token] generate request had no browser-token header:', Object.keys(h).join(', '));
        }
      }
    } catch { /* never let capture break a real generation */ }
    return origFetch.apply(this, arguments);
  };

  window.__sunoToken = {
    async status() {
      try {
        const r = await origFetch(`${LOCAL}/api/browser_token`);
        console.log('[token]', await r.json());
      } catch (e) { console.warn('[token] local server unreachable:', e?.message ?? e); }
    },
    stop() {
      window.fetch = origFetch;
      delete window.__sunoToken;
      console.log('[token] unhooked.');
    }
  };

  console.log(
    '%c[token] armed.%c Now generate any song on this page — one word is fine.\n' +
      'The token is sent to localhost:3060 and never displayed.',
    'color:#0a0;font-weight:bold', 'color:inherit'
  );
})();
