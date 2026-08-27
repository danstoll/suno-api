#!/usr/bin/env node
/**
 * Harvest Suno's `browser-token` UNATTENDED, from a warmed persistent profile.
 *
 * ── The problem this solves ────────────────────────────────────────────────
 * Suno's verification is a `browser-token` header on the generate request.
 * SunoApi injects it on every axios call once one is held, so the whole game is
 * getting ONE valid token. The catch, learned the hard way across this repo:
 *
 *   The automation's browser is challenged HARDER than your real tab.
 *
 * `SunoApi.launchBrowser()` opens an *ephemeral* `browser.newContext()` — a cold,
 * automation-flagged session with no history, cookies or trust. Suno throws a
 * real hCaptcha at it, and even solved, the token it mints does not satisfy the
 * API. Meanwhile your normal signed-in tab generates songs and is never
 * challenged at all. That is not luck — it is a warm, trusted, persistent
 * profile. `capture-browser-token.js` exploits exactly that by riding on your
 * real tab, but it needs YOU to paste a snippet and click Create.
 *
 * ── The fix ────────────────────────────────────────────────────────────────
 * Give the automation the same trust. `chromium.launchPersistentContext(dir)`
 * reuses a real on-disk profile. Warm it ONCE (log in, the cookies persist),
 * and every later run is a trusted session that Suno waves through — so a
 * headless "type one word, click Create, lift the header" runs with no human
 * and no 2captcha. The token is POSTed straight to the local server's
 * /api/browser_token; it is never printed, copied, or passed through a
 * transcript. The console shows only its length.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *   node scripts/profile-capture.mjs --warm     # ONCE: visible, you log in
 *   node scripts/profile-capture.mjs --check     # verify the profile, NO generate
 *   node scripts/profile-capture.mjs             # unattended: generate + harvest
 *
 * Options:
 *   --profile DIR  persistent profile dir; default .suno-profile (gitignored)
 *   --api URL      local suno-api base; default http://localhost:3060
 *   --prompt TEXT  throwaway generation prompt; default "la la la"
 *   --headed       run the capture visibly (debugging)
 *   --timeout S    max seconds for the capture flow; default 180
 *
 * Notes:
 *   - Uses rebrowser-playwright-core (the repo's anti-detection Playwright), so
 *     the stealth patches SunoApi relies on apply here too.
 *   - A real generation costs a few credits — it is the price of a token, and
 *     the same request also clears the pacing wall if one was up.
 *   - Requires the browser binary: `npx playwright install chromium` if missing.
 */

import * as pwNS from 'rebrowser-playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// rebrowser-playwright-core is CommonJS; grab chromium whichever way the ESM
// interop exposes it rather than betting on one shape.
const chromium = pwNS.chromium ?? pwNS.default?.chromium;
if (!chromium) {
  console.error('Could not load chromium from rebrowser-playwright-core.');
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) { printHelp(); process.exit(0); }

const API = args.api ?? 'http://localhost:3060';
const PROFILE_DIR = path.resolve(args.profile ?? process.env.BROWSER_PROFILE_DIR ?? '.suno-profile');
const PROMPT = typeof args.prompt === 'string' ? args.prompt : 'la la la';
const FLOW_MAX_S = Number(args.timeout ?? 180);

// Only the generate call carries the token. Match loosely: the path has been
// /api/generate/v2/ and /api/generate/v2-web/ at different times, and a glob
// ending in "/**" never matches the trailing slash.
const GENERATE = /\/api\/generate\/v2/;

// Resilient selectors — Suno redesigns its UI without notice, so try a list
// rather than bet the whole flow on one class name (mirrors SunoApi.firstVisible).
const PROMPT_SELECTORS = [
  '.custom-textarea',
  'textarea[placeholder*="song" i]',
  'textarea[placeholder*="describe" i]',
  'textarea[placeholder*="lyric" i]',
  '[data-testid*="prompt" i] textarea',
  '[contenteditable="true"]',
  'textarea'
];
const CREATE_SELECTORS = [
  'button[aria-label="Create"]',
  'button:has-text("Create")',
  '[data-testid*="create" i]',
  'button[type="submit"]'
];

mkdirSync(PROFILE_DIR, { recursive: true });

try {
  if (args.warm) await warm();
  else if (args.check) await check();
  else await capture();
} catch (e) {
  console.error(`\n✗ ${e?.message ?? e}`);
  process.exit(1);
}

// ──────────────────────────────────────────────────────────────── modes

/** Open the profile VISIBLY so the human logs into suno.com exactly once. */
async function warm() {
  console.log(`Warming profile: ${PROFILE_DIR}`);
  console.log('A browser will open. Log into suno.com. This closes itself once');
  console.log('it sees a signed-in session (or press Ctrl-C when done).');
  const context = await launch({ headless: false });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto('https://suno.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    try { await page.bringToFront(); } catch { /* not fatal */ }

    const deadline = Date.now() + 600_000; // 10 min to log in
    while (Date.now() < deadline) {
      // Cheap shape check while polling every 3s — a full session-endpoint
      // round-trip here would hammer Suno for no reason during a normal wait.
      if (await hasSessionCookie(context)) {
        await sleep(2); // let any final cookies settle to disk
        if (await isLoggedIn(context)) {
          console.log('\n✓ Signed-in session detected. Profile is warmed.');
          return;
        }
        // Cookie appeared but the session endpoint didn't confirm it yet —
        // keep polling rather than declaring victory on shape alone.
      }
      await sleep(3);
    }
    console.warn('\nTimed out waiting for a signed-in session. Re-run --warm and finish logging in.');
  } finally {
    await close(context);
  }
}

/** Headless: report whether the profile is warmed. Launches a browser but does
 *  NOT generate anything — a zero-cost check that the plumbing works. */
async function check() {
  console.log(`Checking profile: ${PROFILE_DIR}`);
  const context = await launch({ headless: !args.headed });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto('https://suno.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await sleep(2);
    const loggedIn = await isLoggedIn(context);
    console.log(loggedIn
      ? '✓ Profile is warmed (session verified live against Suno). Unattended capture will work.'
      : '✗ Profile is NOT logged in (or the session has expired). Run:  node scripts/profile-capture.mjs --warm');
    process.exitCode = loggedIn ? 0 : 2;
  } finally {
    await close(context);
  }
}

/** Headless: generate a throwaway song and lift its browser-token, unattended. */
async function capture() {
  // Fail fast if the local server is unreachable — there is nowhere to deliver.
  if (!(await localReachable())) {
    console.error(`Local server not reachable at ${API}. Start it:  npm run dev -- -p 3060`);
    process.exit(1);
  }

  console.log(`Profile: ${PROFILE_DIR}`);
  const context = await launch({ headless: !args.headed });
  const deadline = Date.now() + FLOW_MAX_S * 1000;

  try {
    const page = context.pages()[0] ?? (await context.newPage());

    let harvested = false;
    const result = new Promise((resolve, reject) => {
      // Server-side interception: read the header off the generate request and
      // LET IT THROUGH. A completed web-UI generation is what clears the pacing
      // wall, so aborting it would defeat half the purpose.
      page.route(GENERATE, async (route) => {
        const req = route.request();
        let token, provider;
        try {
          token = req.headers()['browser-token'];
          const body = req.postDataJSON();
          provider = body?.token_provider;
        } catch { /* body not JSON — provider stays undefined */ }
        try { await route.continue(); } catch { /* page may be closing */ }

        if (harvested) return;
        if (!token) {
          // Suno fires a generate BEFORE the challenge too; that one has no
          // token. Stay armed for the real one.
          console.log('  (a generate request carried no browser-token — waiting for the next)');
          return;
        }
        harvested = true;
        resolve({ token, provider });
      });
    });

    console.log('Loading suno.com/create...');
    await page.goto('https://suno.com/create', { waitUntil: 'domcontentloaded', timeout: 60_000 });

    if (!(await isLoggedIn(context))) {
      throw new Error('Profile is not logged in (or the session has expired). Run --warm first.');
    }

    // Type a throwaway prompt and click Create — a real generation, which both
    // mints the token and clears the wall.
    console.log('Triggering a throwaway generation...');
    try { await firstVisible(page, ['button[aria-label="Close"]', '[aria-label="Close"]'], 'close button', 3000).then(l => l.click()).catch(() => {}); } catch { /* no popup */ }

    const prompt = await firstVisible(page, PROMPT_SELECTORS, 'prompt input', 30_000);
    await prompt.click();
    await prompt.fill(PROMPT).catch(async () => { await prompt.pressSequentially(PROMPT, { delay: 60 }); });

    const create = await firstVisible(page, CREATE_SELECTORS, 'Create button', 20_000);
    const inner = create.locator('div.flex');
    await ((await inner.count()) > 0 ? inner.first() : create).click();

    const timeout = new Promise((_, rej) =>
      setTimeout(() => rej(new Error(
        `No browser-token captured within ${FLOW_MAX_S}s. If a hard hCaptcha appeared, the ` +
        `profile may not be trusted yet — generate a song by hand once in --warm, then retry.`)),
        Math.max(0, deadline - Date.now())));

    const { token, provider } = await Promise.race([result, timeout]);
    // Give the continued generation a moment to reach Suno so the wall clears too.
    await sleep(3);
    console.log(`\n✓ browser-token captured (${token.length} chars, provider=${provider ?? 'none'}).`);

    await deliver(token, provider);
  } finally {
    await close(context);
  }
}

// ──────────────────────────────────────────────────────────────── helpers

/** Launch (or reuse) the persistent profile with the repo's stealth args. */
async function launch({ headless }) {
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
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
}

/**
 * Close a persistent context correctly.
 *
 * For a persistent context `context.browser()` returns null, so the usual
 * `context.browser().close()` is a silent no-op that leaks the Chromium
 * process. Close the context itself.
 */
async function close(context) {
  try { await context.close(); } catch { /* already gone */ }
}

/**
 * A signed-in Clerk session leaves a `__client` cookie — but on
 * `auth.suno.com`, a Clerk-hosted auth subdomain, NOT on `suno.com` itself.
 *
 * `context.cookies('https://suno.com')` filters to cookies that would be
 * sent to that exact host (or a parent domain of it) — a cookie scoped to
 * the sibling subdomain `auth.suno.com` never matches. That one-line bug
 * cost five straight `--warm` attempts here: a human logged in correctly
 * every time, the cookie was genuinely on disk, and this check still
 * reported "not logged in" because it was querying the wrong host. Fetching
 * all cookies with no URL filter and matching by name sidesteps the whole
 * domain-scoping question.
 *
 * Cheap shape check only — used while polling `--warm`'s login wait, where a
 * false negative just means "keep waiting" and a network round-trip every
 * 3s would otherwise hammer Suno for no reason.
 */
async function hasSessionCookie(context) {
  try {
    const cookies = await context.cookies();
    return cookies.some(c => c.name === '__client' && c.value && c.value.length > 40);
  } catch { return false; }
}

/**
 * Confirm the profile's session is actually live, not just shaped like one.
 *
 * The cookie-shape check above passes for an expired or revoked `__client`
 * cookie just as readily as a good one — a stale profile reported "warmed"
 * by `--check`, then `capture()` failed later with a generic "no token
 * captured" timeout that gave no hint the real problem was the login itself.
 * Ask Suno's own session endpoint instead: it requires auth and returns the
 * account's `models`/`flags` lists only when the cookie still holds.
 */
async function isLoggedIn(context) {
  if (!(await hasSessionCookie(context))) return false;
  try {
    const res = await context.request.get('https://studio-api-prod.suno.com/api/session/', {
      timeout: 15_000,
      failOnStatusCode: false
    });
    if (!res.ok()) return false;
    const data = await res.json().catch(() => null);
    return Array.isArray(data?.models) || Array.isArray(data?.flags);
  } catch { return false; }
}

/** Return the first of `selectors` that becomes visible, or throw. */
async function firstVisible(page, selectors, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.isVisible({ timeout: 500 })) return loc;
      } catch (e) { lastErr = e?.message ?? String(e); }
    }
    await sleep(0.5);
  }
  throw new Error(`Could not find the ${label} — tried: ${selectors.join(', ')}. ${lastErr}`);
}

/** POST the token to the local server. Never prints it. */
async function deliver(token, provider) {
  const res = await fetch(`${API}/api/browser_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, provider })
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.held) {
    console.log(`✓ Delivered to ${API} — the local API can now generate unattended.`);
    console.log(`  length ${data.length} chars, provider ${data.provider ?? 'none'}`);
  } else {
    console.error(`✗ Local server rejected it: ${data.error ?? res.status}`);
    process.exitCode = 1;
  }
}

async function localReachable() {
  try {
    const res = await fetch(`${API}/api/browser_token`, { signal: AbortSignal.timeout(10_000) });
    return res.ok;
  } catch { return false; }
}

function sleep(seconds) { return new Promise(r => setTimeout(r, seconds * 1000)); }

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

function printHelp() {
  console.log(`profile-capture.mjs — unattended browser-token capture from a warmed profile

  node scripts/profile-capture.mjs --warm      ONCE: visible browser, you log in
  node scripts/profile-capture.mjs --check      verify the profile (no generate)
  node scripts/profile-capture.mjs              unattended: generate + harvest token

Options:
  --profile DIR   persistent profile dir (default .suno-profile)
  --api URL       local suno-api base (default http://localhost:3060)
  --prompt TEXT   throwaway prompt (default "la la la")
  --headed        run capture/check visibly
  --timeout S     max seconds for capture (default 180)`);
}
