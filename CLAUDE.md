# suno-api (homelab fork) — AI Assistant Context

Maintained fork of [gcui-art/suno-api](https://github.com/gcui-art/suno-api).
Fork: [danstoll/suno-api](https://github.com/danstoll/suno-api).

Unofficial REST wrapper around Suno's internal API. It authenticates as **your
own Suno account** using a browser session cookie — there is no official API key.
Everything below follows from that one fact.

## Why we forked

Upstream's last commit was **2026-03-06** and the project is effectively
unmaintained (see upstream issues [#262](https://github.com/gcui-art/suno-api/issues/262)
"willing to take over this project?" and [#270](https://github.com/gcui-art/suno-api/issues/270)
"still maintaining?"). The published docs site `suno.gcui.art` no longer resolves.
Suno ships breaking changes faster than upstream merges them, so we maintain our own.

## Deployment — native on the Mac, not Docker

**Host:** `10.0.0.70` (Mac, homelab) · **Port:** `3060` · **Process manager:** PM2

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 logs suno-api
```

Register the startup hook as the **logged-in user**, not a system LaunchDaemon:

```bash
pm2 startup   # then run the command it prints
```

### Why not Docker

This app drives a real Chromium (Playwright) to clear Suno's hCaptcha. In a
headless container that flow is a dead end unless `TWOCAPTCHA_KEY` is funded —
and our manual-captcha fallback needs a **visible window**, which a container
(or a system LaunchDaemon) cannot provide.

`docker-compose.yml` is kept working for isolated/throwaway runs and is
correct (2GB cap, `3060:3000`, runtime `env_file`), but it is the secondary path.
If you switch to it, stop the native process first — both want port 3060.

> If a `suno-api` container from the **upstream** image is still running on the
> Mac, stop and remove it before starting the native process. The upstream image
> has the old cookie baked into its layers.

## Configuration

All config lives in `.env` in the repo root (never committed — see `.gitignore`).
On the Mac the existing file is at `~/docker/suno-api/.env`; copy or symlink it
next to the checkout.

| Var | Purpose |
|-----|---------|
| `SUNO_COOKIE` | Suno session cookie. **Rotates** — see below. |
| `SUNO_MODEL` | Overrides the default `mv` model. Blank = `chirp-fenix`. |
| `TWOCAPTCHA_KEY` | 2captcha.com key for automatic captcha solving. **Currently blank.** |
| `MANUAL_CAPTCHA` | `unset`/`false` = auto only · `true` = manual only · `fallback` = auto, then manual on error |
| `BROWSER_HEADLESS` | `true` normally; manual mode forces visible for the request. |

With `TWOCAPTCHA_KEY` blank, set `MANUAL_CAPTCHA=fallback` — otherwise a captcha
challenge simply fails the request.

## Cookie rotation

`SUNO_COOKIE` is a session credential and **will expire**. Rotate it whenever the
API starts returning auth failures — typically `401`/`403`, "Failed to get session
id", or every call erroring after previously working.

1. Open <https://suno.com> in a normal browser and make sure you're **logged in**.
2. Open **DevTools → Network** (F12).
3. Reload, then click any request going to `studio-api.prod.suno.com`
   (filter the list by `suno` to find one quickly).
4. In **Headers → Request Headers**, find the **`Cookie`** header.
5. Copy its **entire** value — the whole string, not just one key. It must
   include the Clerk session entries (`__client`, `__session`, ...).
6. Put it in `.env`, single-quoted, on one line:
   ```
   SUNO_COOKIE='<paste the whole cookie string here>'
   ```
7. Restart: `pm2 restart suno-api`
8. Verify: `curl http://10.0.0.70:3060/api/get_limit` should return your quota.

Notes:
- Quote the value. Cookie strings contain `;` and `=`, which break an unquoted `.env` line.
- Don't wrap it across lines.
- Logging out of suno.com in the browser **invalidates** the cookie you just copied.
- The cookie grants full access to the Suno account. Treat it as a password:
  never commit it, never bake it into an image, never paste it into an issue.

Upstream PR [#282](https://github.com/gcui-art/suno-api/pull/282) adds a Playwright
script to automate this grab. **Not merged** — it is ~680 lines of unreviewed
third-party code that handles account credentials. Read it properly before adopting.

## Default model

Upstream pinned `chirp-v3-5` (Suno v3.5, ~2024) and never moved it. This fork
defaults to **`chirp-fenix`** (Suno v5.5, released 2026-03-26) and makes it
overridable via `SUNO_MODEL` — Suno ships codenames faster than we can track.

Known `mv` values, oldest → newest:

| `mv` | Suno version |
|------|--------------|
| `chirp-v3-0` | v3 |
| `chirp-v3-5` | v3.5 |
| `chirp-v4` | v4 |
| `chirp-auk` | v4.5 |
| `chirp-bluejay` | v4.5+ |
| `chirp-crow` | v5.0 |
| `chirp-fenix` | v5.5 ← default |

Defined at `DEFAULT_MODEL` in [src/lib/SunoApi.ts](src/lib/SunoApi.ts). A
per-request `model` field overrides the default. An unrecognised `mv` is rejected
by Suno rather than silently downgraded — if generation starts failing right
after a Suno release, try setting `SUNO_MODEL` to the previous codename.

## CLI usage (`sunocli.sh`)

Wrapper over the endpoints below. `BASE=http://10.0.0.70:3060`.

| Command | Endpoint | Notes |
|---------|----------|-------|
| `limit` | `GET /api/get_limit` | Remaining quota. Best health check. |
| `generate` | `POST /api/generate` | `{prompt, make_instrumental, model, wait_audio}` |
| | `POST /api/custom_generate` | Adds `{tags, title, negative_tags}` for full control |
| `status` | `GET /api/get?ids=<id,id>` | Omit `ids` for all. Poll until `status` is `complete`. |
| `download` | — | Not an endpoint. Fetch the `audio_url` from `status`. |
| `extend` | `POST /api/extend_audio` | `{audio_id, prompt, continue_at, tags, title, model}` |
| `concat` | `POST /api/concat` | `{clip_id}` — stitches an extended clip into one track |

Typical flow: `generate` → poll `status` until complete → `download` the
`audio_url`. To lengthen a track: `extend` from a clip id, then `concat`.

`wait_audio: true` blocks until generation finishes instead of returning
immediately — convenient for scripts, but long enough to hit client timeouts.
Prefer polling `status`.

Also available, not wrapped by the CLI: `/api/generate_lyrics`,
`/api/generate_stems`, `/api/get_aligned_lyrics`, `/api/clip`, `/api/persona`,
and an OpenAI-compatible `/v1/chat/completions`.

Interactive docs: `http://10.0.0.70:3060/docs` (Swagger UI, served by the app).

## Fork changes vs upstream

- **Cookie no longer baked into the image.** Upstream's `Dockerfile` took
  `SUNO_COOKIE` as a build `ARG` and burned it into an `ENV` layer — that leaks a
  rotating credential into every image layer and forced a rebuild per rotation.
  Now runtime-only via `env_file`.
- **`docker-compose.yml`**: 2GB `mem_limit`, `3060:3000`, `shm_size: 1gb`
  (Chromium SIGBUSes on Docker's default 64MB), `restart: unless-stopped`,
  dropped the obsolete `version:` key.
- **`ecosystem.config.js`** added for the native PM2 run.
- **Default model** `chirp-v3-5` → `chirp-fenix`, env-overridable. Swagger docs updated.
- **Cherry-picked upstream PR [#277](https://github.com/gcui-art/suno-api/pull/277)** —
  `MANUAL_CAPTCHA` mode. Fixes issue [#263](https://github.com/gcui-art/suno-api/issues/263):
  Suno's v5.5 UI dropped the `.custom-textarea` selector the automated captcha
  flow depends on, so `/api/custom_generate` times out. Additive and env-gated;
  default behaviour is unchanged.
- **Fixed stale `clerk.suno.com`** in `getTurnstile()` — upstream migrated to
  `auth.suno.com` but missed this one. Dead code path today, but it would have
  bitten whoever revived it.

### Reviewed and deliberately NOT taken

- **PR [#271](https://github.com/gcui-art/suno-api/pull/271)** (captcha rewrite +
  concurrency). Genuinely valuable — fallback selectors, an async mutex — but
  conflicts with `main` and rewrites ~450 lines of the core client while adding a
  debug dumper that writes page HTML and screenshots to disk. Revisit deliberately.
- **PR [#282](https://github.com/gcui-art/suno-api/pull/282)** (cookie extractor).
  Unreviewed credential-handling code; see cookie rotation above.
- **Issue [#273](https://github.com/gcui-art/suno-api/issues/273)** (deprecated
  `url.parse` breaking Vercel builds). Not applicable — no `url.parse` in `src/`,
  and we don't deploy to Vercel.

## Syncing with upstream

`upstream` remote is configured.

```bash
git fetch upstream
git log --oneline main..upstream/main    # what's new
git merge upstream/main
```

Re-verify after any sync: `npm run build`, then `curl .../api/get_limit`.

## Gotchas

- **Not an official API.** Suno can break it without notice. Treat outages as
  expected, not as bugs in this repo.
- **Generation is slow** (tens of seconds). Poll `status`; don't rely on `wait_audio`.
- **One account.** Concurrent requests share a single Suno session and quota;
  upstream has no request serialisation (that's part of what PR #271 addresses).
- **Playwright browsers are a separate install.** After `npm install`, run
  `npx playwright install chromium` — a missing browser surfaces as
  "Executable doesn't exist", not as an install error.
- **Rate limits / bans.** Hammering the API risks the Suno account itself
  (upstream issue [#236](https://github.com/gcui-art/suno-api/issues/236)). Keep usage human-paced.
- Output is Suno-generated audio tied to your account; check Suno's terms for
  what you may do with it before redistributing.
