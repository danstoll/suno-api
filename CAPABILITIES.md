# Suno API — observed capabilities

What this fork has actually seen, as opposed to guessed. Everything below was
either captured from Suno's own web client or exercised against the live API.

Guessing endpoint names has a poor record here: `/api/persona/` returns 404
while `/api/persona/create/` works, and eight plausible "list personas" paths
all 404'd while the real one turned out to be
`/api/persona/get-persona-paginated/`. Capture, don't guess.

## The generate payload

Full field list, lifted from a live `/api/generate/v2-web/` request. This is the
most valuable thing in this document — most of Suno's features are *conditions
on a generation*, not separate endpoints, so this list is close to a feature map.

| Field | Used here | What it does |
|---|---|---|
| `prompt` | ✅ | The lyrics, with `[Section]` markers |
| `tags` | ✅ | The style prompt |
| `title` | ✅ | Song title |
| `mv` | ✅ | Model codename (`chirp-fenix` = v5.5) |
| `make_instrumental` | ✅ | No vocals |
| `continue_clip_id` | ✅ | Source clip for extend **and** infill |
| `continue_at` | ✅ | Seconds to continue from — mid-point extend regenerates everything after |
| `task` | ✅ | `extend`, `infill` |
| `persona_id` | ✅ | Sing in a saved voice. **The only way to keep a singer across generations** |
| `project_id` | ✅ | Which workspace the result lands in |
| `token` | ⚠️ | Present but **empty** in live requests — vestigial, see below |
| `token_provider` | ✅ | Names what minted the verification token |
| `generation_type` | ✅ | `TEXT` |
| `negative_tags` | ✅ | Styles to avoid |
| `gpt_description_prompt` | ✅ | Non-custom mode: describe-a-song |
| **`cover_clip_id`** | ❌ | **Unexplored.** Backs Remix → Cover: new lyrics in an existing clip's style |
| **`cover_start_s` / `cover_end_s`** | ❌ | **Unexplored.** Window of the source used as the style reference |
| **`artist_clip_id`** | ❌ | **Unexplored.** Backs Remix → "Use as Inspiration" (Pro) |
| **`artist_start_s` / `artist_end_s`** | ❌ | **Unexplored.** Window used as the artist reference |
| **`user_uploaded_images_b64`** | ❌ | **Unexplored.** Image input — presumably song-from-picture |
| **`override_fields`** | ❌ | **Unexplored.** Selective override of inherited values |
| **`continued_aligned_prompt`** | ❌ | **Unexplored.** Likely the aligned lyric of the source, so an extend knows where it is |
| `control_sliders` | ✅ | `style_weight`, `weirdness_constraint` — see below |
| `transaction_uuid` | ✅ | Idempotency key |
| **`lyrics_project_id`** | ❌ | **Unexplored.** Present on Studio-originated generations — lyrics appear to be their own persisted entity, not just a string on the request |
| `metadata` | ✅ | Nested. Carries `infill_lyrics` / `lyrics_updated` on an infill, and on a Studio generation: `web_client_pathname`, `create_mode` (`custom`), `is_max_mode`, `user_tier`, `create_session_token`, `disable_volume_normalization` |
| `infill_start_s` / `infill_end_s` | ✅ | Top-level, **not** inside metadata |
| `batch_size` | ✅ | Takes per generation (normally 2) |

### control_sliders

**Nested inside `metadata`, not top-level.** A live Studio request carries
`metadata.control_sliders = { style_weight, weirdness_constraint }`. Sending it
at the top level would be silently ignored — the request still succeeds and the
sliders simply do nothing, which is the worst kind of failure to debug.

Observed values on takes that came out well: `style_weight: 0.9`,
`weirdness_constraint: 0.2`. The web UI will go to `style_weight: 1`.

High style weight matters when the style prompt carries section-level
arrangement instructions ("verses have no drums"), because low weight means
Suno ignores them. Low weirdness matters when the structure is already
unusual — weirdness and specificity compete for the same territory.

## Endpoints

### Verified working

| Endpoint | Method | Notes |
|---|---|---|
| `/api/generate/v2-web/` | POST | The real generate path. Note `-web`, and it ends at the trailing slash |
| `/api/generate/concat/v2/` | POST | Stitch an extend back onto its source |
| `/api/generate/lyrics/` | POST | Lyric generation |
| `/api/feed/v2` `?ids=` | GET | Clip status |
| `/api/feed/v3` | POST | Clip fetch by id. **Ignores unknown filters** — a bogus project filter still returns the 5 most recent clips, which looks like success and isn't |
| `/api/clip/{id}` | GET | Single clip. Carries `image_large_url` (1024px); `/api/get` drops it |
| `/api/clip/{id}/vox-stem` | POST | `{vocal_start_s, vocal_end_s}` → isolated vocal, step 1 of persona creation |
| `/api/processed_clip/{id}` | GET | Poll the vox-stem until `status: complete` |
| `/api/persona/create/` | POST | `{root_clip_id, name, persona_type:"vox", vox_audio_id, vocal_start_s, vocal_end_s, user_input_styles, clips[]}` |
| `/api/persona/get-persona/{id}/` | GET | Read one persona |
| `/api/persona/get-persona-paginated/` | GET | List personas |
| `/api/project/me` | GET | Workspaces. `?page=N` |
| `/api/project/{id}` | GET | Workspace contents via `project_clips`. **20 per page**, `?page=N` |
| `/api/playlist/create` | POST | `{name}` |
| `/api/billing/info/` | GET | Subscription |
| `/api/c/check` | POST | `{ctype:"generation"}` → whether verification is required |
| `/api/edit/stems/` | POST | Stem separation |
| `/api/clips/{id}/attribution` | GET | **Lineage.** Returns `source_clips` with a `relationship` code — `EX` for an extend — naming the clip this one derives from. The only way to ask "where did this come from?" without guessing from titles. Note the plural `clips`, where every other clip route is singular |
| `/api/clip/{id}/stems/pages` | GET | How many pages of stems exist. `0` means none separated yet |
| `/api/clip/{id}/stems?page=N` | GET | Paginated stems. **1-indexed** — `page=0` returns "Invalid page number" |
| `/api/lyrics-projects/{id}/flush` | POST | `{lyrics}`. Lyrics are a persisted entity, referenced by `lyrics_project_id` on a generation |
| `/api/gen/bulk_increment_play_counts/v2` | POST | `{gen_ids[], sample_factor}` — telemetry |

### Seen in captures, not yet used

Found by `scripts/capture-diff.mjs` against a persona-creation capture.

| Endpoint | Notes |
|---|---|
| `/api/statsig/experiment/{name}` | **Feature flags.** Statsig gates Suno's experiments, so this is where unreleased features surface before they reach the menus. Worth watching |
| `/api/challenge/progress` | Suno's achievement list — and a useful feature inventory in its own right: `audio_to_midi`, `song_remaster`, `song_voice`, `song_download_wav`, `studio_project_create`, `studio_gen`, `song_stem`, `studio_export`, `song_share` |
| `/api/project/{id}/pinned-clips` | Pinned clips within a workspace |
| `/api/prompts/suggestions` | Prompt, lyric and tag suggestions |
| `/api/notification/v2` | Notifications |
| `/api/notification/v2/badge-count` | Unread count |

Fields seen but unused: `is_public` and `description` on `persona/create`
(Wendy went up public by default — a persona derived from your own track is
discoverable unless you say otherwise), and `filters` / `limit` on `feed/v3`.

### Known 404 — do not retry

`/api/persona/`, `/api/personas/`, `/api/persona/list/`, `/api/artist/`,
`/api/voice/`, `/api/voices/`, `/api/user/voices/`, `/api/feed/voices/`,
`/api/profiles/me/personas/`, `/api/studio/personas/`

### Adding a clip to a playlist

Still unknown. Five endpoint shapes all returned 405. Needs a capture.

## Verification (the `browser-token` header)

Suno moved verification out of the request body. The body still has a `token`
key but it arrives **empty** — a vestige. The live credential is the
**`browser-token` header**, paired with `token_provider` in the body; sending
one without the other is rejected.

Reading the empty body field cost days: it returned something that looked right
and was worthless, which is a nastier failure than a missing field. A request
sent deliberately *without* a token produced Suno's own verdict — "We couldn't
verify your request" — which is what finally settled it.

A token can only be lifted from a real generate request issued **inside the
automation's browser**, because that is where the route interceptor listens. A
generation in your normal browser produces a valid token nothing is watching.
`POST /api/capture_token` opens that browser with no render waiting on it.

2Captcha cannot help with this. The flow fails two steps before a solver is
ever consulted, and no hCaptcha challenge appears to solve.

## Which UI feature maps to which mechanism

Most of Suno's menu is generation *conditions*, not endpoints.

| UI | Mechanism |
|---|---|
| Remix → Cover | `cover_clip_id` + window — **unexplored** |
| Remix → Use as Inspiration | `artist_clip_id` + window — **unexplored** |
| Remix → Voice | vox-stem → `persona/create` → `persona_id` |
| Edit → Extend | `task=extend` + `continue_clip_id` + `continue_at` |
| Edit → Replace Section | `task=infill` + `infill_start_s/_end_s` |
| Edit → Get Stems | `/api/edit/stems/` |
| Edit → Crop / Fade | Local ffmpeg is cheaper and more predictable |

**Extend from a mid-point regenerates everything after that timestamp**, not
just the tail. That makes it a partial re-record that keeps the opening — the
only repair that fixes a broken back half without losing the take.

## The capture-and-diff habit

Suno ships faster than this fork gets updated, and new capabilities appear as
new *fields on the generate payload* before they appear anywhere documented.
`persona_id`, `cover_clip_id` and `artist_clip_id` were all sitting in a
captured request long before we knew what they were for.

Do this whenever Suno's UI changes, or before assuming a thing is impossible:

1. Paste `scripts/capture-suno-requests.js` into DevTools on suno.com
2. Drive the feature you want to understand
3. `__sunoCapture.save()`
4. `node scripts/capture-diff.mjs --capture <file>`

It reports endpoints and request fields not already in this document, and exits
non-zero when it finds any, so a discovery is hard to miss. Add what it finds
here, then work out what it does.

Two notes from building it. It normalises UUIDs to `{id}`, or every clip id
reads as a fresh endpoint. And it treats every identifier inside any backtick
span as documented — an earlier version matched only whole single-word spans,
so a payload written as `{root_clip_id, name, vox_audio_id, …}` made it cry
wolf on its own documentation.

## Worth knowing before trusting a result

- **`/api/feed/v3` ignores filters it doesn't recognise.** Four different bogus
  project filters each returned five clips. Use `/api/project/{id}`.
- **Marker durations don't indicate dropped sections.** Three false alarms,
  zero real catches. Verify by sung words.
- **Word presence isn't coverage.** A chorus written three times scores 100%
  when sung once. `verify-coverage` now counts repeats.
- **Naming a duration in the style prompt** makes Suno pad or truncate to hit
  it, which mangles written endings.
- **Rate limiting is Cloudflare's**, not Suno's quota — a burst of ~50 requests
  in two minutes triggered error 1015 and blocked generation while reads
  continued working.
