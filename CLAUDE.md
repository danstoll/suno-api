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

## Deployment — local dev on the Windows PC

**Current setup.** Runs on the PC you're sitting at, port `3060`:

```bash
cd F:\Projects\DaddyWombat\suno-api
npm run dev -- -p 3060
```

Verify: `curl http://localhost:3060/api/get_limit` → returns your credit balance.

### Why local, and not the homelab Mac

The deciding constraint is **who clicks the captcha**, not native-vs-container.

This app drives a real Chromium (Playwright) to clear Suno's hCaptcha. Two ways
that resolves: `TWOCAPTCHA_KEY` (currently blank), or a human clicking a visible
browser window. The homelab Mac (`10.0.0.70`) sits in the garage with **Screen
Sharing disabled**, so there is no one to click and no way to reach the screen —
the manual fallback is unreachable there, exactly as it would be in a headless
container. Running on the PC puts the browser in front of a human.

### Moving it back to the Mac later

Two things have to be true first — pick either:

1. **Fund `TWOCAPTCHA_KEY`** (~$3/1000 solves). Fully unattended, no GUI needed.
   This is the right answer for an always-on garage box.
2. **Enable Screen Sharing** on the Mac, then VNC in to solve captchas by hand.
   Free, but you're on the hook whenever one fires.

Then `ecosystem.config.js` (PM2) is ready to go — start it via
`launchctl asuser $(id -u danstoll)` so it lands in the GUI session, not a
system LaunchDaemon, or the manual-captcha window can never appear.
`docker-compose.yml` also still works (2GB cap, `3060:3000`, runtime `env_file`)
but inherits the same captcha dead end.

> The old upstream container on the Mac has been **stopped and removed**. Its
> image (`suno-api-suno-api:latest`, 6.24GB) still exists and has a **cookie
> baked into its layers** — delete it:
> `docker rmi suno-api-suno-api:latest`

### How often does the captcha actually fire?

Rarely, in practice. `captchaRequired()` short-circuits on a warm session, so a
valid cookie usually generates with no browser launch at all. The thing that
actually expires is the **cookie** — and rotating that is a DevTools job done in
a browser, which is a PC task regardless of where the service runs.

## Configuration

All config lives in `.env` in the repo root (never committed — see `.gitignore`).
A copy of the working cookie also lives on the Mac at
`/Users/danstoll/docker/suno-api/.env`, left in place as a fallback. Both copies
go stale together — rotating one means rotating the other.

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
6. Put it in `.env`. Easiest — with the value still on your clipboard, run:

   ```powershell
   .\scripts\rotate-cookie.ps1
   ```

   That writes clipboard → `.env` directly, so the cookie is never echoed into a
   terminal, a shell history, or an AI transcript. It validates the paste, keeps
   one `.env.bak`, and prints only the length.

   To do it by hand instead, single-quoted on one line:

   ```
   SUNO_COOKIE='<paste the whole cookie string here>'
   ```
7. Restart the dev server (Ctrl-C, then `npm run dev -- -p 3060`). Next.js reads
   `.env` at boot, so an edit alone does nothing.
8. Verify: `curl http://localhost:3060/api/get_limit` should return your quota.

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

**Verified against the live API on 2026-08-02**: `POST /api/generate` returned
`"model_name":"chirp-fenix"` echoed back by Suno, ran through
`queued → streaming → complete`, and produced a playable 4.4MB MP3. The codename
came from third-party docs originally; this confirms Suno itself accepts it.

## Endings cut abruptly — fix locally, not with credits

A recurring Suno fault: tracks run at full level to the last second or two and
then stop, instead of resolving. Measured on a real 188s track — steady
−13 to −16 dB until 185s, then −19 → −27 → −33. That is a truncation.

Writing "fades gentle" into a section marker does nothing; markers are treated
as text, not as mix instructions. Regenerating just rolls a different song and
costs credits. Fix it in post:

```bash
node scripts/fade-out.mjs --clip <clip-id> --seconds 7
node scripts/fade-out.mjs --file track.mp3 --analyze   # measure only
```

It downloads the clip, prints a per-second RMS bar chart before and after so
the fade is visible rather than assumed, preserves the source bitrate, and
writes to `faded/` (gitignored).

Curve choice matters more than length — measured across a 7s fade:

| curve | behaviour |
|---|---|
| `qsin` | holds ~3s, eases out, silent exactly at the end — **default** |
| `tri` | audibly starts pulling down almost immediately |
| `losi` | like `qsin`, harder drop at the very end |
| `cub` | too fast, ~2s of dead air |
| `exp` | far too fast — silent 4s early, so the song just stops sooner |

Ballads want 6–8s, upbeat 3–4s.

Suno does have a native fade (`edit-mode-fade` is in the account flags, and
Studio state carries `songFadeInBeats` / `songFadeOutBeats`), but that means
writing a Studio project version. Local post-processing is deterministic, free,
and works on every track including ones already exported.

## Suno's API surface (fork research, 2026-08-02)

Upstream wraps roughly the 2024 clip API. Suno has since grown a second, larger
surface. Mapped live against a Premier account:

### Two surfaces, not one

| | Clip API | Studio API |
|---|---|---|
| Base | `/api/generate/*`, `/api/feed/v2`, `/api/clip/*` | `/api/studio/project/{id}` |
| Model | immutable generated clips | versioned DAW document |
| Units | **seconds** | **beats** (`seconds = beats / timing.bps`) |
| Wrapped here? | yes | read-only, via `/api/studio_project` |

A Studio project's `state` holds `tracks[] → clips[] + takeLanes[]`, warp
markers, per-track EQ and signal chains, `timeSignatureChanges`, and
`metadata.usedReplaceSection`. Any clip with `metadata.type` of `studio_export`
or `edit_v3_export` carries the `studio_project_id` that opens it.

Clip `metadata.type` values seen in the wild: `gen`, `concat`, `upsample`,
`studio_export`, `edit_v3_export`, `rendered_context_window`.

### Capability discovery — start here

`GET /api/session` is authoritative for what the account can do. Do not track
Suno's changelog by hand; ask the API.

- **`models[]`** — every `mv` value with `capabilities`, `features`,
  `allowed_condition_combinations` and `max_lengths`. This is where
  `SUNO_MODEL` values come from.
- **`flags[]`** — 56 feature gates, including the ones that matter here:
  `edit-mode-infill`, `edit-mode-extend`, `edit-mode-fade`, `crop-remove`,
  `under-over-painting`, `song-duration-control`, `control-sliders`,
  `create-projects`, `editing-stems`, `generative-stems`, `vocal-gender-toggle`.

Useful limits it reports: v5+ models accept `prompt` 5000 / `tags` 1000 /
`title` 100 chars; v4 and v3.5 only `prompt` 3000 / `tags` 200.

> **`chirp-goose` (v6) exists** and is listed for this account, but Suno
> describes it as *"Early access model"*. The default stays `chirp-fenix`
> deliberately — early-access models change without notice. Try it with
> `SUNO_MODEL=chirp-goose`; revert if generations get strange.

### Replace Section is a condition, not an endpoint

**`infill` is a generation *condition*, not a separate route** — which is why it
never shows up in a clip's `action_config`. `allowed_condition_combinations`
lists `["infill"]`, `["persona","infill"]`, `["cover","infill"]`, plus
`underpaint`/`overpaint`.

Payload captured from Suno's own web client (`POST /api/generate/v2-web/`),
so the shape below is observed, not inferred:

```jsonc
{
  "task": "stem_condition_infill",   // "infill" for a whole-song replace
  "continue_clip_id": "<clip to edit>",   // NOT clip_id / edited_clip_id
  "mv": "chirp-fenix",
  "infill_start_s": 14.32,           // window to regenerate
  "infill_end_s": 22.96,
  "infill_dur_s": 8.64,
  "infill_context_start_s": 0,       // what the model additionally hears
  "infill_context_end_s": 37.28,
  "include_history_s": 2,            // lead-in / lead-out preserved
  "include_future_s": 2,
  "batch_size": 2,                   // variants returned
  "metadata": {
    "infill_lyrics": "",             // NESTED — not top-level
    "lyrics_updated": true,
    "override_history_clip_id": "<full mix>",   // context either side comes
    "override_history_end_seconds": 88.5,       // from the complete track
    "override_future_clip_id": "<full mix>",
    "override_future_start_seconds": 97.1
  },
  // per-stem only ("add Drums", "add Vocals"):
  "stem_condition_clip_id": "<rendered stem>",
  "stem_control_tags": "add Vocals",
  "stem_condition_start_s": 14.32,
  "stem_condition_end_s": 22.96
}
```

Two things this fork got wrong on the first attempt, both fixed: the source clip
is **`continue_clip_id`** (`edited_clip_id` only comes back on the response),
and **`infill_lyrics`/`lyrics_updated` are nested inside `metadata`** while the
`infill_*_s` fields are top-level.

Exposed as `POST /api/replace_section`. Use it over `extend_audio` when changing
something **in place** — extend regenerates everything past its cut point and
cannot keep the tail.

### Studio's Replace Section is a TWO-step flow

Editing inside Studio is not one call:

1. **`POST /api/studio/render-state`** — posts the entire project state (tracks,
   clips, warp markers, EQ) plus `start_beats`, `end_beats`, a `downbeats` array
   and `export_mode: "rendered_context_window"`. Returns a new clip of type
   `rendered_context_window` covering just that beat range.
2. **`POST /api/generate/v2-web/`** — the infill above, with
   `continue_clip_id` pointing at that rendered clip.

`POST /api/studio/save-project` persists the project and mints a fresh
`version_id` on every save.

### Other generate fields worth knowing

The same payload carries slots this fork does not yet expose: `persona_id`,
`cover_clip_id`/`cover_start_s`/`cover_end_s`,
`artist_clip_id`/`artist_start_s`/`artist_end_s`, `negative_tags`,
`batch_size`, `vocal_gender`, `disable_volume_normalization`,
`user_uploaded_images_b64`. Captcha is checked separately via
`POST /api/c/check {"ctype":"generation"}` → `{"required":false,...}`; when not
required, `token` is simply `null`.

### Capturing a payload yourself

`scripts/capture-suno-requests.js` — paste into the DevTools console, drive the
UI, then `__sunoCapture.save()`. **Arm it before triggering the action**; the
generate call fires immediately and a hook installed afterwards misses it. It
records no headers and redacts credential-shaped values, unlike "Copy as cURL"
which embeds your bearer token and session cookie.

### Reaching what isn't wrapped

`/api/raw` is an authenticated passthrough, added so a new Suno endpoint no
longer requires a code change to reach:

```bash
curl "http://localhost:3060/api/raw?path=/api/session/"
curl -X POST http://localhost:3060/api/raw \
  -H 'Content-Type: application/json' \
  -d '{"path":"/api/...","method":"POST","body":{}}'
```

It reports Suno's status in `suno_status` rather than throwing, so a `404` is a
usable probe result. The host is pinned to `BASE_URL` and the path must begin
with `/api/`, so it cannot be aimed elsewhere — it is not an open proxy. GET
cannot mutate: a non-GET method must be named explicitly in a POST body.

### Confirmed present but still unwrapped

From clip `action_config.actions`: `remaster`, `remix_cover`,
`remix_reuse_style`, `create_hook`, `download_as_video`, `edit_song_details`.
Remaster's shape is already visible in existing clips
(`task: "upsample"`, `upsample_clip_id`, `edited_clip_id`), so it is the
easiest next one to add.

## CLI usage (`sunocli.sh`)

Wrapper over the endpoints below. `BASE=http://localhost:3060`.

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

Interactive docs: `http://localhost:3060/docs` (Swagger UI, served by the app).

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
