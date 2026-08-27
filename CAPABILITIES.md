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
| `/api/project/me` | GET | Workspaces. `?page=N`, `?query=` (name search), `?sort=`, `?show_trashed=`, `?exclude_shared=` |
| `/api/project/{id}` | GET | Workspace contents via `project_clips`. **20 per page**, `?page=N` |
| `/api/project` | POST | **Create a workspace.** `{name, description}` → the workspace object incl. `id`. Not `/api/project/create` — that path 404s as an unknown `{id}`, then 405s on POST/PUT once you're on the real `/api/project/{id}` route. Captured 2026-08-18 |
| `/api/project/{id}/clips` | POST | Assign clips to a workspace after generation: `{update_type:"add", metadata:{clip_ids:[...]}}` → 204. The web client calls this right after `/api/generate/v2-web/` rather than setting `project_id` alone being sufficient — do both |
| `/api/project/{id}/pinned-clips` | GET | Pinned clips within a workspace (confirmed live, not just seen-in-capture) |
| `/api/playlist/create` | POST | `{name}` |
| `/api/billing/info/` | GET | Subscription |
| `/api/c/check` | POST | `{ctype:"generation"}` → whether verification is required |
| `/api/edit/stems/` | POST | Stem separation. Studio 2.0 (2026-08-13) reportedly ships an updated/improved stem-separation model built into the DAW — unconfirmed whether that's this same endpoint under the hood or a Studio-only path; no capture yet either way |
| `/api/clips/{id}/attribution` | GET | **Lineage.** Returns `source_clips` with a `relationship` code — `EX` for an extend — naming the clip this one derives from. The only way to ask "where did this come from?" without guessing from titles. Note the plural `clips`, where every other clip route is singular |
| `/api/clip/{id}/stems/pages` | GET | How many pages of stems exist. `0` means none separated yet |
| `/api/clip/{id}/stems?page=N` | GET | Paginated stems. **1-indexed** — `page=0` returns "Invalid page number" |
| `/api/lyrics-projects/{id}/flush` | POST | `{lyrics}`. Lyrics are a persisted entity, referenced by `lyrics_project_id` on a generation |
| `/api/gen/bulk_increment_play_counts/v2` | POST | `{gen_ids[], sample_factor}` — telemetry |
| `/api/uploads/audio/` | POST | `{extension, upload_type:"studio_file_upload"}` → presigned S3 fields (`url`, `fields`, `key`) plus an upload `id`. Step 1 of bringing external audio (not AI-generated) into Suno |
| `/api/uploads/audio/{id}/upload-finish/` | POST | `{upload_type, upload_filename, agreed_to_vip_upload_terms}`, called after the raw PUT to the S3 URL above completes |
| `/api/uploads/audio/{id}/initialize-clip/` | POST | Converts the finished upload into a real clip on the account — returns `{clip_id}`. From here it behaves like any other clip (has `set_metadata`, can be dragged into a Studio track) |
| `/api/gen/{id}/set_metadata/` | POST | Sets title/image/ToS-acceptance on a clip — used right after `initialize-clip` to name the upload |
| `/api/gen/{id}/aligned_lyrics/v3` | POST then GET | **A richer replacement for `/api/get_aligned_lyrics`.** POST `{lyrics, enable_augmentation:true}` starts an async alignment job (`{state:"running"}`); poll the same URL with GET until `{state:"complete", alignment:[...]}`. Unlike the old endpoint, you submit the lyrics text explicitly rather than relying on whatever Suno stored — and alignment comes back at phoneme/sub-word granularity with a `p_align` confidence score per token, not just per-word. Same bracket-bundling behavior as the old endpoint (a run of `[Section]`/direction tags collapses onto the next sung word's token) — this independently confirms `verify-coverage.mjs`'s `SECTION_RE` fix was the right diagnosis, not a new bug. Not yet wired into `verify-coverage.mjs`; the async job/poll shape is more integration work than the current one-shot GET for a benefit (confidence scores) this project hasn't needed |

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

## Studio Agent ("Studio Chat") — a conversational editor, not another endpoint

Captured 2026-08-18 from a real Studio session ("Come Back to Me - unHinged",
a 15-track project). This is a different kind of thing from everything else in
this document: not a call you make once, but a **running tool-calling agent
loop** the Studio web client drives, with its own session/websocket state.
Answers the "is Studio something we can use?" question this document didn't
have data for before.

**Confirmed against Suno's own release, 2026-08-19.** The capture landed the
day after Suno shipped **Studio 2.0** (2026-08-13) — what we captured as
internal `/api/agent/*` calls is the feature Suno itself calls **Studio
Chat** (still beta): "the bar you used to Cover and Remix stems is now a full
chat bar" — it subsumed those older single-purpose controls, not just added
alongside them. Suno's own framing matches the "not a quick add" read below:
their Studio PM said text prompts are inspiration, "no substitute" for
hands-on work via MIDI or mic. Two adjacent things the raw capture didn't
surface, worth knowing about even though neither was exercised here:

- **Remove FX ("Get Dry")** — a plain right-click action on any clip, not
  part of the chat loop. AI-strips reverb/delay baked into a generated stem
  back to a dry signal. Explicitly **not** stem isolation (won't pull "just
  the vocal" out of a full mix) — only removes effects Suno itself applied
  during generation. A real, single-purpose endpoint-shaped feature this
  fork could plausibly wire up later, unlike the chat loop.
- **MIDI clips as a generation prompt** — play/import/record MIDI on the
  timeline, then use that MIDI (not just text) as the reference for a new
  audio generation. A new generation-input mode alongside the existing
  text/lyrics/style one.

Also officially documented (matching what the capture's project schema
already showed): **Take Lanes** as a first-class concept, and an
**Arrangement Editor** (waveform or piano-roll, opened by double-clicking a
clip) — confirming `takeLanes` and per-clip `warp` markers in the project
schema aren't internal-only, they're the real editing surface.

**Gate worth checking before planning around any of this: Studio —
including Chat, plugins, and unlimited multitrack export — is Premier-tier
only**, same as Studio 1. Worth confirming which plan this account is on
before assuming any of Studio 2.0 is actually reachable.

**From Suno's own help article (help.suno.com/en/articles/13670529, the
primary source — more precise than the press coverage above):**

- **Built-in effects, by name:** Compressor, Convolution, Delay,
  Distortion, EQ, Gate, Reverb. **No VST/AU support** — outside plugins
  can't be loaded, custom ones only come from the chat-built or factory set.
- **MIDI goes further than "record/import":** a piano-roll editor (note
  draw, quantize, velocity), musical typing, hardware controllers via Web
  MIDI, **and audio-to-MIDI transcription** — turning an existing audio stem
  into an editable MIDI part. That transcription direction wasn't visible in
  the raw capture and is a genuinely new capability, not just a UI nicety.
- **Stem separation is two named modes**, both right-click on a clip:
  "Split from Mix" and "Advanced Split" — still no captured endpoint names
  for either, so unconfirmed whether they're `/api/edit/stems/` under a new
  UI or something new.
- **Export:** 32-bit WAV or MP3, for the full song, a selected range, or as
  a multitrack. **Upload accepts WAV, MP3, *and MIDI*** — the raw capture
  only showed us an audio upload (`/api/uploads/audio/`); a MIDI upload path
  exists too but wasn't captured.
- **Practical gate if anyone drives this by hand:** Chrome recommended
  (Safari lacks Web MIDI), 768px minimum width (no mobile), and a
  SIMD-capable CPU (SSE4.1/Neon) with 4GB+ RAM.

**The chat protocol:**

| Endpoint | Method | Notes |
|---|---|---|
| `/api/agent/ably-token` | GET | `?run_id=` → an Ably (websocket) auth token for realtime progress on that run |
| `/api/agent/conversation/{project_id}/entries` | POST | Syncs chat-UI entries. Also carries `backend_messages_snapshot` (the actual LLM tool-call transcript) and `project_fingerprint_snapshot` (a hash-like summary of every track/arrangement at that point — presumably how the agent notices the project changed under it) |
| `/api/agent/step` | POST | The actual agent turn. Body: `run_id`, `studioAgentSessionId`, full `messages` history, `ui_context` (current bpm/track/selection in beats **and** seconds), `available_tools`. Response: `{run_id, status, assistant_message, client_tool_call, usage, context_status, ui_context_block}` |
| `/api/agent/tool-executions` | POST | Telemetry — reports a tool call's outcome back after the client executes it |
| `/api/agent/conversation/{id}/used-actions` | POST | Acks which suggested quick-reply chips were shown/clicked |

`status: "requires_client_tool"` means the step response is asking the *web
client* to actually run a tool (edit a track, render audio, open a view) and
report back — the server-side model doesn't execute anything itself. This is
why nothing here reduces to one clean `curl`: the loop needs a live client
holding project state, not just an HTTP round-trip.

**The tool palette** (`available_tools` on every step): `tracks_list`,
`inspect_track`, `tracks_edit`, `arrangements_edit`, `midi_generate`,
`midi_edit`, `author_plugin`, `add_plugin_to_chain`, `remove_plugin_from_chain`,
`plugins_list`, `inspect_plugin`, `set_plugin_params`, `set_plugin_version`,
`set_default_plugin_version`, `rename_plugin`, `open_view`,
`submit_generation`, `submit_open_task`, `arrange_take`, `timing_inspect`,
`timing_fix`, `lyrics_inspect`, `mix_inspect`, `render_arrangements`,
`stem_split`, `help_search`, `help_show_control`, `ask_question`, `respond`.
This is effectively Suno's own feature map for Studio — plugin chains, MIDI
generation/editing, and timing-fix are all things this fork has never touched.

**The one tool call worth having captured in full — `submit_generation` in
`stem-add-infill` mode**, the mechanism behind prompts like "add deeper bass
and skips" or "16 beat hi hat":

```json
{
  "instrument": "Bass",
  "styles": "deep sub bass, powerful low-end, syncopated electronic groove, ...",
  "mode": "stem-add-infill",
  "target_track_id": "5ebd82a9-aa12-4538-9fd2-2081d70bf5f8",
  "start_beats": -1,
  "end_beats": 791.268,
  "context_start_beats": -1,
  "context_end_beats": 791.268
}
```

Generates 2 alternate takes for one instrument over a beat range on one track,
landing as new entries in that track's `takeLanes` (the existing
per-track alternate-version array already documented in the plain project
schema) rather than replacing anything outright — matches the "audition, then
pick" pattern the web UI shows. `-1` for a start bound reads as "from the top."
This is a **different, narrower mechanism** than `render-state` + `infill`
above: that pair regenerates a whole-project window across every track;
`stem-add-infill` targets one instrument on one track and doesn't need a
manual render-state pre-step. Whether the agent's `submit_generation` calls
through to `render-state`+`infill` internally, or a separate path, wasn't
visible in this capture — only the tool-call request/response was, not
whatever HTTP calls the client fires to execute it.

**Also seen in this capture:**

- **Live mic recording into a Studio track.** One track ("Audio Track", `arm:
  true`) held a clip literally named `[Rec] Aug 19 08:52:46.wav` — Studio
  records from a microphone straight onto the timeline, not just AI stems.
- **Importing outside audio as a track.** The upload pipeline above
  (`/api/uploads/audio/` → `upload-finish` → `initialize-clip` →
  `set_metadata`) is how an already-published song ("Nellie Is Three.mp3") got
  dragged in as a reference/backing track in the same project. Works for any
  local mp3, not just Suno output — a real way to bring in outside recordings
  or reference mixes.
- **`open_in_studio`** as a clip action-config entry, not previously listed
  anywhere in this doc's action inventory — the entry point from a plain clip
  into a Studio project.
- **Per-track EQ and signal chains are real, not placeholders.** Every track
  (including the master) carries a 6-band EQ (`highpass`, `lowshelf`, three
  `peaking`, `highshelf`, `lowpass`) and a `signalChain` array — empty in this
  project, but structurally present per-track, confirming Studio is a genuine
  small DAW and not a thin wrapper.

**Bottom line:** Studio itself (multi-track, EQ, take lanes, live recording,
external-audio import) is usable today the same way any of this document's
other verified endpoints are — a capture-driven integration would work. The
**Agent chat layer is the part that isn't a quick add**: it needs a live
websocket session (`ably-token`), a maintained tool-call transcript, and a
client that can actually execute `tracks_edit`/`render_arrangements`/etc. and
report back — closer in shape to reimplementing Suno's own Studio client than
to adding an endpoint call. Worth revisiting if this catalogue ever needs
surgical single-stem edits ("just the bass, just this 8 bars") that
`render-state`+`infill` can't target cleanly, but not a near-term win for the
scripted single-shot generate pipeline this project runs today.

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
