# Studio exploration — 2026-09-18

Driven via Claude in Chrome with `capture-suno-requests.js` injected into the page.
Test project: "8. Tightest Weave" (clip `6699e8dc-7d9f-4a81-9549-d11c04e6b247`),
Studio project `62428bd2-f475-492e-b536-16aa1e8594df`. Full raw capture was 156
entries / 2.7 MB and was not saved; everything load-bearing is below.

Gotcha: opening Studio (`/studio?for_clip_id=…&create_new=1`) is a full page load
and wipes the capture. Re-inject after landing in Studio. The project-create call
was lost for that reason.

## Answers to open questions in CAPABILITIES.md

**Studio Full Song export is not a download.** Export → Full Song fires
`POST /api/studio/render-state` with `export_mode: "fullsong_export"` and returns
a new queued clip with `metadata.type: "studio_export"`, saved to the library
("Song Saved!"). No format choice, no file. So the fan-guide claim ("Studio exports
don't count against the download quota") is only trivially true — the quota
question moves to *downloading that new clip*. Still to check: quota before/after
downloading a `studio_export` clip as WAV.

**Studio Multitrack export is client-side.** Export → Multitrack started a browser
download immediately (no dialog) and fired **no API call** — the browser renders
it from audio already loaded. Almost certainly quota-free. The file was still a
0-byte `.crdownload` when checked, so the format (zip of per-track WAVs?) is unconfirmed.

**Studio stem split (answers line 88).** It does *not* use `/api/edit/stems/`. It's the
normal generate endpoint:
`POST /api/generate/v2-web/` with `task: "gen_stem"`, `stem_task: "twelve"`,
`stem_type_id: 91`, `stem_type_group_name: "Twelve"`, `continue_clip_id: <source>`,
`mv: "chirp-v3-5-b"`, `make_instrumental: true`. Preceded by
`POST /api/c/check {ctype:"generation"}` → `{required:false, captcha_version:2}`.
Headers: `authorization`, `browser-token` (48 chars), `device-id`.
Results listed via `GET /api/clip/{id}/stems` and `/stems/pages`.
UI modes: Auto split (12), Split from mix (one stem + "everything but"), Advanced
split (pick from 20+ named instruments: Piano, Strings, Organ, Brass, Synth Pad,
Lead Guitar, Rhythm Electric Guitar, Electric Piano, …). Auto split returned 10 stems
in ~60 s. Download dialog: MP3 / WAV / MIDI, tempo "Fixed" or "Follow tempo changes".

## What the Studio Agent actually submits

Agent tool list (from `available_tools`): tracks_list, inspect_track, tracks_edit,
arrangements_edit, midi_generate, midi_edit, author_plugin, add_plugin_to_chain,
remove_plugin_from_chain, plugins_list, inspect_plugin, set_plugin_params,
plugin_manage, open_view, submit_generation, submit_open_task, arrange_take,
takes_edit, project_settings, timing_inspect, timing_fix, lyrics_inspect,
mix_inspect, render_arrangements, stem_split, help_search, ask_question, respond.

Every `submit_generation` is preceded by a `render-state` with
`export_mode: "rendered_context_window"` over the relevant beats; the returned clip
id becomes the conditioning input. All generations return `batch_size: 2` (two takes,
"Commit Take 1 / Audition Take 2").

### 1. Add a new instrument part — `stem-add` → `task: "stem_condition"`
Prompt: "Add a mournful solo cello line … first 16 bars".
Agent: `submit_generation {instrument:"Cello", styles:"…", mode:"stem-add",
target_track_id, start_beats:0, end_beats:64, audio_influence:0.85}`
(its first attempt passed `midi_score:{source:"transcription",mode:"exact"}` and errored).
Wire: `task:"stem_condition"`, `mv:"chirp-hawk"`, `tags:<styles>`,
`stem_condition_clip_id:<rendered context clip>`, `stem_control_tags:"add Cello"`,
`batch_size:2`, `metadata.control_sliders.audio_weight:0.85`,
`metadata.override_history_clip_id/_end_seconds`, `override_future_clip_id/_start_seconds`.

### 2. Rewrite a section in place — `stem-add-infill` → `task: "infill"`
Prompt: "regenerate bars 33–48 … drums drop out … sparse piano + soft strings".
Agent: `mode:"stem-add-infill", start_beats:128, end_beats:192,
context_start_beats:96, context_end_beats:224`.
Wire: `task:"infill"`, `mv:"chirp-hawk"`, `continue_clip_id`,
`infill_start_s/_end_s/_dur_s`, `infill_context_start_s/_end_s`,
`include_history_s`, `include_future_s`. So the agent's infill *is* render-state + infill
(answers line 316–317), with an explicit context window.

### 3. MIDI → real instrument audio — `task: "midi_stem_condition"`  ★
Prompt: "realistic bowed solo cello … plays exactly the notes of the Cello Ground Bass MIDI clip".
Agent: `mode:"stem-add", midi_score:{source:"selection_midi", mode:"exact"}`.
Wire: `task:"midi_stem_condition"`, `mv:"chirp-hawk-wild"`,
`stem_control_tags:"add Cello"`, `stem_condition_clip_id`,
`stem_condition_start_s/_end_s`, `batch_size:2`, `token_provider:2`,
`metadata.model_config:{cfg_coef:1.1}`,
`midi_cond:{midi_b64:<Standard MIDI File, base64>, mode:"exact", crop_start_s, crop_end_s}`.
This is the big one: we can author a melody as a .mid ourselves and have Suno perform
it on a real-sounding instrument, note-exact, against a track's context.

### 4. MIDI tracks and effects
- `midi_generate {generation_source:"direct", notes:[{pitch,start_beats,duration_beats,velocity}…]}`
  — the agent writes notes directly. MIDI tracks play through Studio synths (a Wavetable
  plugin was added, `catalog_plugin_id ba7e7ab1-…-000000000030`), not sampled instruments.
- Caution: asked for "descending four-note ground bass, one note per bar, repeating",
  it held each note for **4 bars** (C C C C, B♭ ×4, A♭ ×4, G ×4). Give it explicit notes.
- Effects: "big cathedral reverb, −3 dB, how's the balance" → Reverb plugin
  (Low/High Cut, Decay, Damping, Mix, Pre, Width), −3 dB on the track, and `mix_inspect`
  reported LUFS per track and peak dBFS (main −14 LUFS, peak −0.6 dBFS).

## Clip right-click menu in Studio
Copy, Paste, Duplicate, Delete, Heal Edits, Split, Rename, Clip Color,
**Get Stems, Download .WAV, Get MIDI, Remove FX**. Download .WAV here is untested for quota.

## Library ⋯ → Edit submenu
Extend, Crop, Remove Section, Reverse, Adjust Speed, Fade In (Pro), Fade Out (Pro),
Replace Section (Pro), Get Stems / MIDI (Pro), Remaster (Pro), Open in Studio (New),
Open in Editor (Pro). Open in Studio → Single-track (full mix, free) or Multi-track
(separate stems, 50 credits).

---

# Part 2 — Album pipeline, Inspo and Remix (same session, later)

Captured while starting the real album **Pavilion** (`daddy-wombat-tunes/pavilion/`).
Workspace `9a55a646-e03f-4415-a133-3d4a5f218b72`, playlist `3d8690e3-4874-4190-aee3-63b0f59c4e86`.

## The scriptable album pipeline

| Step | Call | Body / notes |
|---|---|---|
| 1. Workspace | `POST /api/project` | `{name:"PAVILION", description:""}` → `{id, …}`. The workspace id is what `project_id` means everywhere else. |
| 2. Generate a track (custom mode) | `POST /api/generate/v2-web/` | No `task` field. `project_id`, `title`, `tags` (style), `negative_tags` (exclude), `prompt` (section tags), `mv:"chirp-hawk"` (= v6), `make_instrumental:false`, top-level `duration` in **seconds** (200 = 3:20, max 360), `metadata.is_max_mode`, `metadata.create_mode:"custom"`, `metadata.control_sliders:{weirdness_constraint:0.25, style_weight:0.8, aug_creativity:1}`, `lyrics_project_id`, `token_provider`, `transaction_uuid`. Preceded by `POST /api/c/check {ctype:"generation"}`. Returns 2 clips. |
| 3. File into workspace | `POST /api/project/{id}/clips` | `{update_type:"add", metadata:{clip_ids:[…]}}` → 204. The web client does this itself right after generating. |
| 4. Playlist | `POST /api/playlist/create/` | `{name:"Pavilion"}` → `{id, …}` |
| 5. Add to playlist | `POST /api/playlist/update_clips/` | `{playlist_id, update_type:"add", metadata:{clip_ids:[…]}, recommendation_metadata:{}}` → 204 |
| 6. Pick the take | read `is_liked` | `POST /api/feed/v3` with `filters.workspace.workspaceId` returns clips with `is_liked`, `batch_index`, `metadata.duration`, and `reaction:{play_count, skip_count}`. `filters.liked:"True"` returns only liked. Disliked clips are hidden by default (`disliked:"False"`). |
| 7. Arc track referencing Track 1 | `POST /api/generate/v2-web/` | Same as step 2 plus **`task:"playlist_condition"`, `playlist_id:"inspiration"`, `playlist_clip_ids:[<track 1 clip id>]`**, and `metadata.control_sliders.audio_weight:0.5` (the Audio Influence slider, which appears once an Inspo is attached). |

Workspace pinned strip: `GET /api/project/{id}/pinned-clips` → `{pinned_clips:[…]}`.

## Inspo: three different wire formats

| UI route | Mode | `task` | How the reference is sent |
|---|---|---|---|
| Audio → Inspo → pick a playlist | simple (description) | `playlist_condition` | `playlist_id:<real playlist>` — Suno picks 4 songs from it itself |
| Song ⋯ → Remix → Use as Inspiration, description only | simple | **`agentic_thinking`** | `audio_refs:[{clip_id, style_prompt, lyrics, duration_s}]` (up to 4). Suno also writes its own title and style ("The Interrupted Motif") |
| Song ⋯ → Remix → Use as Inspiration, with Lyrics + Styles filled | **custom** | `playlist_condition` | `playlist_id:"inspiration"`, `playlist_clip_ids:[…]` (up to 4), `control_sliders.audio_weight` |

**For scripting Vombatus, use the third one.** It keeps the full brief (our style prompt, exclude list, section tags, duration, sliders) *and* takes any 1–4 clip ids with an explicit Audio Influence. No playlist needed.

## Remix submenu (song ⋯ → Remix)
Cover, Reuse Prompt, Mashup, Sample this song, Use as Inspiration (Pro), Voice (Pro).
Cover / Mashup / Sample are not yet captured on the wire. `cover_clip_id`, `cover_start_s`, `cover_end_s` and `artist_clip_id` exist on every generate body (null unless used), so Cover is almost certainly `cover_clip_id` + the usual fields.

## Create-form automation notes (for anyone driving the UI instead of the API)
- The lyrics box is a rich-text editor (not a textarea); it only accepts real keystrokes after a click inside its own rect, and sections collapse/reflow when clicked, which moves everything below.
- Sliders are `role=slider` with `aria-label` Duration (seconds, step 5, 10–360), Weirdness, Style Influence, Audio Influence (0–100, step 1), Variety (0–4). Focus + arrow keys works; `End` does not.
- "Personalize style prompt to match your taste" (the wand button under Styles) is a one-shot prompt rewrite, not a setting. The Personalize On/Off toggle lives in Controls and defaults to Off here.

---

# Part 3 — Curation calls and take measurement (Thema Regium run)

## More scriptable calls

| Action | Call | Body |
|---|---|---|
| Like / dislike a take | `POST /api/gen/{clipId}/update_reaction_type/` | `{reaction:"LIKE"}` or `{reaction:"DISLIKE"}`, plus `recommendation_metadata:{}`. Disliked clips are hidden from workspace lists by default |
| Pin to workspace | `POST /api/project/{wid}/clips` | `{update_type:"pinned", metadata:{clip_ids:[…], pinned:true}}` — the pinned strip works as an album tracklist |
| Crop | `POST /api/edit/crop/{clipId}/` | `{crop_start_s, crop_end_s, is_crop_remove:false, project_id, ui_surface:"song_actions"}` → `{action_clip_id}` (the new, cropped clip; lands in `project_id`) |
| Bulk add to playlist | `POST /api/playlist/update_clips/` | one call with all `clip_ids` in order (the UI does this from multi-select → Add to Playlist) |

## Measuring takes without listening

The song Crop dialog (⋯ → Edit → Crop) draws the whole clip's waveform. A screenshot of it, read column by column
(`suno-api/scripts/score-takes-from-waveform.py`; logic: bar height per column → per-section mean vs the sheet's expected
loudness per section; a dip below 40 % of median in the last 40 % that recovers above 75 % = false ending;
level of the last 4 % = clean stop vs cut-off) was enough to reject every padded or cut-off take on Thema Regium.
Resolution is ~1.5–2.5 s per bar, fine for Track-6-style false endings (10 s+). It can't hear key, timbre or melody.

Note: `d2lwuy8qc234o3.cloudfront.net/1/clip/{id}.m4a` (the player's stream) is **encrypted**; don't try to analyse it.

## UI automation notes (Create panel, Sept 2026 layout)

- Lexical lyrics editor: synthetic `beforeinput` events (`insertText` / `insertParagraph`) update its real state; a synthetic paste or `execCommand` only changes the DOM and submits a run-on line.
- Radix sliders take synthetic `keydown` ArrowLeft/ArrowRight on the focused thumb.
- Row menus open with synthetic pointer events; submenus open on hover events; "Use as Inspiration" is occasionally disabled for a moment after a clear — retry.
- Find a clip's row by a container whose only song link is that clip (the pinned strip also links to it).
