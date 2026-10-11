# Suno cover art — findings and working pipeline

**Status:** per-track cover replacement is **confirmed working end to end** — one
track done live, real payloads captured, artwork verified by eye. Album covers
on the playlist are mapped but the PATCH is still untested.

**Supersedes the premise of** [`COVER-ART-EXPLORATION-SCRIPT.md`](./COVER-ART-EXPLORATION-SCRIPT.md),
which asked whether Suno exposes cover replacement at all. It does. That script
is now history; this file is the procedure.

Run date: 2026-09-19. Account: `daddywombat` (Premier). Driven through the
`claude-in-chrome` MCP against a normal signed-in tab — **in Microsoft Edge, not
Chrome**. See "Check which browser you are actually on" below before diagnosing
anything.

---

## Short answer

Yes. Suno has a first-class cover-art system with its own library tab
(`/me/cover-art`), a user upload path, and a "set this image as the cover of
that clip" call. The plate images can go on the songs inside Suno.

Three separate things share one dialog, and only the first is free:

| Affordance | What it does | Cost |
|---|---|---|
| **Upload** | pushes your own file to S3, attaches it to a clip | no credits — but it is a *write* on a published track |
| **Create** | generates cover art from a prompt | `POST /api/video_gen/cost/image` quotes it first |
| **Animate** | generates a 5s/10s video cover | `POST /api/video_gen/cost/video` quotes it first |

---

# Verified — observed in the live UI

## The UI path

Cover art is **not** in the track's `…` menu directly. It is two levels down,
and the menu items the old exploration script recorded (`Cover, Reuse Prompt,
Mashup, Sample this song, Use as Inspiration, Voice`) are the **Remix**
submenu, not the top level. That mislabelling is why the feature looked absent.

The real top-level `…` menu on a song row:

```
Remix ▸    Edit ▸    Publish    Share ▸    Download    Manage ▸
Add to Queue    Add to Playlist    Song Radio    Report    Move to Trash
```

The three submenus:

- **Remix ▸** — Cover · Reuse Prompt · Mashup · Sample this song · Use as
  Inspiration (Pro) · Voice (Pro)
- **Edit ▸** — Extend · Crop · Remove Section · Reverse · Adjust Speed ·
  Fade In (Pro) · Fade Out (Pro) · Replace Section (Pro) · Get Stems / MIDI
  (Pro) · Remaster (Pro) · Open in Studio (New) · Open in Editor (Pro).
  **All audio. No artwork here.** Every item on this submenu is a
  generate/render that costs credits.
- **Manage ▸** — **Song Details** · **Create Cover Art** · Allow Remixes
  (toggle) · Allow Comments (toggle) · Pin to Profile (toggle) · Move to
  Workspace

**`Manage → Song Details` is the one you want.** It opens a dialog with the
artwork at the top and three buttons under it: `Upload` · `Create` ·
`Animate`, then the three toggles, then `Edit caption, lyrics and styles ›`,
then Cancel / Save (Save stays disabled until something changes).

`Edit caption, lyrics and styles ›` opens a second dialog — Style summary,
Caption, Lyrics. Text only, no artwork. Not the path.

### Gotchas in the UI path

- The three submenus render **on hover**, not on click, and the accessibility
  tree does not contain them until they do. `find` will not see "Song Details"
  until you have hovered `Manage`.
- `find` labelled the Song Details dialog "Publish Song dialog". That is the
  tool guessing, not Suno. The bundle keeps `EDIT_SONG_DETAILS`,
  `UPDATE_CLIP_METADATA`, `PUBLISH_SONG` and `UNPUBLISH_SONG` as four distinct
  modal ids, so **saving song details does not publish**.
- The hidden `<input type=file>` in the Song Details dialog accepts
  `image/jpeg, image/jpg, image/png, image/webp, image/bmp, video/mp4,
  video/quicktime`, `multiple=false`. Video is accepted here because Animate
  covers are real video.

## The Cover Art library — `/me/cover-art`

Tabs All / Favorites / Images / Videos. It is backed by `video_gen`, not by
anything named "cover":

| Call | Body | Notes |
|---|---|---|
| `GET /api/video_gen/model-configs` | — | Basic vs Advanced tiers, allowed durations `[5,10]`, resolutions `["720p"]`, aspect ratios `["9:16","1:1"]`, `max_quantity: 2` |
| `POST /api/video_gen/history` | `{clip_id, created_at_offset, favorites_only, limit, media_type}` | the listing |
| `GET /api/cms/cover-art-suggestions` | — | the prompt chips ("Neon synthwave city" etc.) |
| `POST /api/video_gen/cost/image` | `{image_gen_category, prompt}` → `{cost}` | quotes credits **before** generating |
| `GET /api/video/hooks/suggested_clips` | — | |

`history` returns `{history: [...batches], has_more}`. A batch:

```jsonc
{
  "batch_id": "...",
  "origin": "generated" | "upload",
  "gen_category": "Basic" | "Advanced" | "Upload",
  "type": "image" | "video",
  "status": "complete",
  "prompt": "...",                 // empty string for uploads
  "items": [{
    "id": "...",                   // this is the generated_image_id
    "clip_id": "...",              // ABSENT on origin:"upload"
    "url": "https://cdn1.suno.ai/image_<uuid>.png",
    "thumbnail_url": "...",
    "display_order": 0,
    "is_liked": false,
    "type": "image",
    "origin": "upload",
    "reference_image_urls": []
  }]
}
```

An `origin: "upload"` batch already exists on this account
(`image_6201fc8a-b0bd-4979-a12d-1e8c437bdecb.png`, 2026-08-05), so the upload
path has been exercised before by hand. Uploaded batches get a **v5** UUID
(deterministic); generated ones get v4.

Per-item `…` menu in this library: **Share · Download · Delete**. There is no
"apply to song" from this side — attachment only runs from the song's dialog.

## Headers — the prior note does not hold here

Earlier work recorded that Suno injects auth in a service worker *below*
`window.fetch`, so a `window.fetch` hook sees only `content-type`. **That is
not true for these calls.** The captured `POST /api/video_gen/history`
carried, at the `window.fetch` layer:

```
authorization:  <present>          (Clerk bearer, set by the page)
browser-token:  <present>          (the verification header)
device-id:      <present, 36 chars>
content-type:   application/json
accept-language: en
```

So for `/api/video_gen/*` a page-context `fetch` is enough and the bearer is
visible to the hook. Do not assume the service-worker behaviour applies
everywhere; check per endpoint family.

## Persona / Voice images — no

`Voices ▸ <persona> ▸ ⋮ ▸ Edit` opens "Edit Voice": source clip, waveform
range selector, name, styles, description, Public toggle, Save. The persona's
picture is shown next to the name field but **there is no `input[type=file]`
anywhere in that dialog** — the avatar is inherited from the source clip's
cover art. Section 3 of the exploration script hoped this would reveal the
generic upload endpoint; it does not, and it was not needed, because the song
dialog does.

`image_s3_id` does exist on personas in Suno's response schema, but the web UI
offers no write path to it. Changing a persona's picture therefore means
changing the source clip's cover.

## Studio project images — yes, separately

`Library ▸ Studio Projects ▸ <card> ▸ … ▸ Details` opens "Project Details":
**Add Image** · Title · Notes · Cancel / Save. Its hidden file input accepts
plain `image/*` (not the song dialog's explicit list), which suggests a
different handler. Saves via `POST /api/studio/project/{project_id}/metadata`.

## Account settings — no

`/settings` has Email, Birthday, Connected accounts, Phone number, Subscription
/ Restrictions links, Privacy Choices. **No profile-picture upload.** Section 5
of the exploration script comes back empty.

---

# CONFIRMED — observed end to end, 2026-09-19

Run live against clip `0abf0078-7b96-4331-8d85-af33c1b16b45`
(*1. Harbour, Before Dawn*), uploading `01-harbour-before-dawn-plate.png`. Every
payload below is a real captured round trip, not read off the bundle.

**It is three calls, not four.** The inferred four-step version in earlier
drafts of this file was wrong in three specific ways, all corrected below.

## 1. Initiate — `POST /api/uploads/image/`

```jsonc
// headers
{ "authorization": "Bearer <clerk>", "browser-token": "<…>",
  "device-id": "9ddf7eb8-013c-4717-afec-5719f6c8db08",
  "content-type": "application/json", "accept-language": "en" }

// body — the ONLY field
{ "extension": "jpeg" }
```

```jsonc
// 200 response
{
  "id": "e843bb48-519b-43b8-8542-f302629e234b",     // ← this is image_s3_id
  "url": "https://suno-uploads.s3.amazonaws.com/",
  "is_file_uploaded": false,
  "fields": {
    "Content-Type": "image/jpeg",
    "key": "raw_uploads/e843bb48-519b-43b8-8542-f302629e234b.jpeg",
    "AWSAccessKeyId": "<…>",
    "policy": "<base64>",
    "signature": "<…>"
  }
}
```

`device-id` is a plain UUID, stable across calls, and is not a credential.

## 2. Push the bytes — `POST https://suno-uploads.s3.amazonaws.com/`

A standard S3 presigned POST. `multipart/form-data`, **every entry from
`fields` first, in the order given, and `file` LAST** — S3 ignores anything
after the file part, so ordering is not optional:

```
Content-Type    = image/jpeg
key             = raw_uploads/e843bb48-….jpeg
AWSAccessKeyId  = …
policy          = <base64>
signature       = …
file            = <bytes>          ← must be last
```

No Suno auth header — this goes to AWS, not Suno.

```
→ 204 No Content
   etag:     "8d1ceee1670e8bbca6eb66764e88c020"
   location: https://suno-uploads.s3.amazonaws.com/raw_uploads%2Fe843bb48-….jpeg
```

## 3. Attach — `POST /api/gen/{clip_id}/set_metadata/`

```jsonc
{ "image_s3_id": "e843bb48-519b-43b8-8542-f302629e234b" }
```

```jsonc
// 200 response
{
  "id": "0abf0078-7b96-4331-8d85-af33c1b16b45",
  "image_s3_id": "e843bb48-519b-43b8-8542-f302629e234b",
  "image_url": "https://cdn2.suno.ai/e843bb48-519b-43b8-8542-f302629e234b.jpeg",
  "title": "1. Harbour, Before Dawn",
  "prompt": "…",
  "video_is_stale": true,
  "opt_out_video_cover_hook": false
}
```

**The field mapping, settled:** `image_s3_id` is *verbatim the `id` returned by
step 1*. Not the URL, not the S3 key, not anything derived. The same UUID is
also embedded in the S3 `key` and becomes the CDN filename, so one value
threads the whole flow.

Note the path: `/api/gen/` singular, trailing slash.

## Three corrections to the earlier inferred version

1. **There is no `upload-finish` call.** `POST /api/uploads/image/{id}/upload-finish/`
   exists in the bundle but this flow never touches it — the capture recorded
   zero matches. Consequently **no `moderation_status` is returned anywhere in
   the cover path**, and the `moderationRejected` error is unreachable here. The
   S3 `204` is the whole confirmation. (`is_file_uploaded: false` in step 1's
   response presumably flips server-side on the S3 event.)
2. **`set_metadata` takes only `image_s3_id`.** No `type: "cover_image"`, no
   `image_url`, no `generated_image_id`, no `cover_art_session_id`. Those
   belong to `useSaveAsCover`, which is the *Cover Art library* path (applying
   an already-generated image); the Song Details upload path is the bare
   one-field call above. Reading a hook's arguments told us what a payload
   *could* carry, not what this one does.
3. **The dialog saves in two separate POSTs to the same endpoint.** The artwork
   call fires first, then a second `set_metadata` with the text fields:
   ```jsonc
   { "title": "1. Harbour, Before Dawn", "lyrics": "…", "caption": "",
     "caption_mentions": { "user_mentions": [] },
     "remove_image_cover": false, "remove_video_cover": false }
   ```
   `remove_image_cover` / `remove_video_cover` are how a cover gets cleared.

## The client transcodes to JPEG — mind this for the batch run

The `extension` in step 1 is chosen by the **crop widget, not by the file**. The
Song Details dialog renders the chosen image to a canvas (that is what the
slider under the preview is for) and exports JPEG regardless of input. Measured
on this run:

| | |
|---|---|
| sent to the input | `01-harbour-before-dawn-plate.png`, **2,068,011 bytes**, PNG |
| what actually reached S3 | `cover_0abf0078-…_1789865826097`, **359,273 bytes**, `image/jpeg` |

That is an 83% size reduction and a lossy re-encode of an old-master oil plate.
Acceptable for one track; **not** what you want across 48.

**Scripting the pipeline avoids this entirely** — call
`POST /api/uploads/image/` with `{"extension": "png"}`, push the original bytes
with `Content-Type: image/png`, and the plate lands untouched. The browser path
is only needed to *learn* the flow, not to run it.

### Client-side validation the script should still mirror

- `MAX_IMAGE_SIZE_BYTES = 0xa00000` = **10,485,760 bytes (10 MB)**
- extension allow-list plus a content sniff (`contentMismatch`), so renaming a
  file will not get it past
- remaining error codes: `fileTooLarge`, `unsupportedExtension`,
  `contentMismatch`, `initiateFailed`, `uploadFailed`

## Album covers — the playlist is the album

The playlist **is** the album artefact in this catalogue, not the workspace and
not a folder, so album art is a first-class step of this pipeline rather than a
footnote. It is a different endpoint from the per-track one, but it reuses
**steps 1–3 above unchanged** — the upload half is shared; only the attach call
differs.

| | per-track plate | album cover |
|---|---|---|
| target | clip | playlist |
| attach call | `POST /api/gen/{clip_id}/set_metadata/` | `PATCH /api/playlist/v2/{playlist_id}` |
| id field | `image_s3_id` | `cover_image_s3_id` |
| discriminator | `type: "cover_image"` | none — it's a field on the playlist record |

The playlist mutation's arguments are `{playlistId, name, description, imageUrl,
coverImageS3Id, isPublic, albumType}`, serialised to:

```jsonc
{
  "name": "...",
  "description": "...",
  "image_url": "https://cdn1.suno.ai/image_<uuid>.png",
  "cover_image_s3_id": "<s3 id from step 3>",
  "is_public": true,
  "bio": "...",
  "album_type": "..."
}
```

There is also a dedicated `/api/playlist/v2/{playlist_id}/cover-image` route and
a legacy `POST /api/playlist/set_metadata`, the latter gated behind an
`enableV2Endpoint` flag. Which of the three the UI actually fires has not been
observed.

**Confirmed vs inferred, plainly:**

- *Confirmed:* the endpoints exist and are reachable from this account's bundle;
  the field is named `cover_image_s3_id`, not `image_s3_id`; the mutation is a
  `PATCH`, not a `POST`, on the v2 route.
- *Much stronger now, but still inferred:* that `cover_image_s3_id` takes the
  same value as the clip's `image_s3_id`. The track test settled what that value
  actually is — the bare `id` from `POST /api/uploads/image/`,
  `e843bb48-519b-43b8-8542-f302629e234b`. Crucially **that id is not
  clip-specific in any way**: it identifies the upload, not the thing it was
  attached to, and the upload endpoint is generic (`/api/uploads/image/`, no
  clip or playlist in the request). There is one image-upload flow on the site
  and it produces one kind of id. So the same id should satisfy the playlist's
  `cover_image_s3_id`. What is *not* proven is only that the playlist route
  accepts it without some extra step. **Steps 1 and 2 are now de-risked for the
  album call; only the PATCH itself is untested.**
- *Inferred:* that a `PATCH` with only `cover_image_s3_id` and `image_url` set
  is safe. The hook passes name, description, `is_public`, bio and `album_type`
  together, so a partial PATCH may blank them. **Send the existing values back
  unchanged alongside the new cover** unless a live test shows otherwise — and
  note `is_public` is in that body, which makes a careless call a publish-state
  change.

> Not run. The nine Daddy Wombat and three Vombatus album playlists are
> verified and public; none were touched in this pass.

Dead Reckoning, for when this does run:
`playlist 04e9c9a1-c039-4f1d-a001-3354db733477`, tracks 1–10 =
`0abf0078-7b96-4331-8d85-af33c1b16b45`, `fa95963c-9622-4936-a576-5b9fc5e675ee`,
`6081cb03-24a3-4da5-85c9-77dbdaa8a872`, `5c3f9d8c-cf5d-4063-b275-856b29147d4d`,
`28b7d42c-3c8a-4c0b-933d-6204a5e2f2ef`, `280f05ef-0095-445c-a19b-2b83e5cf140a`,
`4b00a307-580d-4d60-a560-70bf99f2a808`, `3a6e2fd2-af9c-4e05-a37e-2b016ce27e74`,
`08738b7d-d9e5-4fcc-9db3-4aed8cfa525c`, `284b47c8-98d2-4a29-9db4-fe863bf989db`.

## Adjacent write paths found in the same sweep

| Endpoint | Method | Body / notes |
|---|---|---|
| `/api/playlist/v2/{playlist_id}` | PATCH | `{name, description, image_url, cover_image_s3_id, is_public, bio, album_type}` — **album covers**, i.e. the Dead Reckoning playlist itself |
| `/api/playlist/v2/{playlist_id}/cover-image` | — | dedicated cover route |
| `/api/playlist/set_metadata` | POST | legacy path, gated behind `enableV2Endpoint` |
| `/api/studio/project/{project_id}/metadata` | POST | Studio project Add Image |
| `/api/video_gen/favorite` | PUT | `{entity_type: "image"\|"video", entity_id, is_favorite}` |
| `/api/video_gen/delete` | POST | |
| `/api/video_gen/image/generate` | POST | **costs credits** |
| `/api/video_gen/video/generate` | POST | **costs credits** |
| `/api/video_gen/action` | POST | `{batch_id, clip_id, watch_ms, cover_art_session_id}` — telemetry, *not* "apply cover". Easy to misread as the attach call; it isn't. |
| `/api/uploads/video/`, `/api/uploads/audio/` | POST | same 3-step presigned pattern |
| `/api/download/clip/{clip_id}/cover` | GET | pulls an existing cover |

---

# How to re-run the capture with Claude in Chrome

The exploration script assumes a human pastes `capture-suno-requests.js` into
DevTools. Driving it from Claude in Chrome instead works and is faster, with
three traps.

1. **Inject the capture with `javascript_tool`, not DevTools.** It runs in the
   **main world** — verified by `/origFetch/.test(window.fetch.toString())`
   returning `true` from a *separate* call, and by the hook catching the page's
   own `GET /api/clips/parent`. Confirm with:
   ```js
   ({ armed: !!window.__sunoCapture, hooked: /origFetch/.test(window.fetch.toString()) })
   ```
2. **A hard `navigate` wipes the capture.** In-app clicks (SPA routing) keep it;
   `mcp__claude-in-chrome__navigate` reloads the JS context and
   `window.__sunoCapture` comes back `undefined`, silently losing everything
   recorded so far. This cost one full pass here — the `/me/cover-art` load was
   captured only on the second attempt. **Arm after the last hard navigation,
   then click.**
3. **`__sunoCapture.copy()` / `.save()` are useless over MCP** — no clipboard,
   and `.save()` triggers a browser download. Use `.dump()`, or better, read
   selected entries: the helper here adds `.get(i)` and `.find(regex)` so you
   can pull one request's body without hauling the whole JSON through the
   context window.

Additional friction worth knowing:

- The Chrome MCP **blocks raw minified JS** in tool output as
  "Cookie/query string data" or "Base64 encoded data". Dumping a 600-char slice
  of a bundle gets refused. The way through is to regex the segment down to
  identifiers before returning it, e.g.
  `seg.match(/[a-z][a-z0-9]*(?:_[a-z0-9]+)+|"[a-z_]{3,30}"/g)` — that returns
  the payload keys in order, which is all you actually need.
- One `computer:screenshot` timed out with "CDP sendCommand timed out", and the
  Chrome window silently resized itself to 496×113, after which every
  coordinate click landed in the wrong place while reporting success. If clicks
  stop navigating for no reason, screenshot and check the reported coordinate
  frame, then `resize_window` back to something sane.
- Prefer `ref_N` from `find` over pixel coordinates, but note `find` mis-mapped
  the first submenu hover (returned the Remix submenu when asked to hover Edit);
  hovering by coordinate was more reliable for the nested menus.

### Check which browser you are actually on — first, before anything

**The MCP is called `claude-in-chrome`. That does not mean it is driving
Chrome.** The extension runs in any Chromium browser, every tool and error
message says "Chrome" regardless, and `list_connected_browsers` labels whatever
it finds `Browser 1` on `Windows`. On this machine it is **Edge**.

That naming cost a full round of misdiagnosis here: a hidden-window fault was
reported as "Chrome is minimised", which sent the human to front a Chrome window
that was never in play, while the actual hidden window was Edge's.

Settle it in one call, from the page rather than from the tool:

```js
({ ua: navigator.userAgent,
   brands: navigator.userAgentData?.brands.map(b => b.brand + ' ' + b.version) })
// → "… Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0"
// → ["Chromium 154", "Microsoft Edge 154", "Not A(Brand 99"]
```

The `Edg/` suffix and the `Microsoft Edge` brand are the tell — the UA string
contains `Chrome/154` either way, so reading only the first half tells you
nothing. Do this **before** reporting any browser-level fault, and name the real
browser when you do.

`list_connected_browsers` is still worth a look, but note what it does and does
not tell you: it returns `deviceId`, `name`, `osPlatform`, `isLocal` and
`inUse` — and **no browser brand at all**. One entry with `inUse: true` means
there is nothing to switch to; `select_browser` on that same id is a no-op and
`switch_browser` only re-broadcasts a pairing request to the same instance.

### The blocker that stopped the first upload attempt

**If the Chrome window is minimised or otherwise not visible, the whole
`computer` half of the extension stops working — and it does not say so.** The
symptoms, in the order they appear and none of which name the cause:

```
computer:screenshot → "Script injection timed out after 5000ms — the page is busy
                       or mid-navigation"
computer:left_click → "Coordinate (568, 224) is outside the coordinate frame
                       (496x113)"
find               → "Page still loading (executeScript waited 45000ms for
                      document_idle)"
javascript_tool    → works perfectly throughout
```

That last line is the trap: `javascript_tool` keeps answering, `readyState` is
`"complete"`, and the tab is `selectedTabId` in `tabs_context_mcp`, so
everything looks healthy. The coordinate frame goes stale at whatever it was
when the last screenshot succeeded (`496x113` here) and never refreshes, because
it only refreshes *on* a screenshot — which is the thing that is failing. Clicks
then either fail out-of-bounds or land somewhere arbitrary while reporting
success.

**The one-line diagnostic:**

```js
({ hidden: document.hidden, visibility: document.visibilityState,
   inner: [innerWidth, innerHeight], outer: [outerWidth, outerHeight] })
```

`document.hidden: true` means the window is minimised or occluded — stop and get
it fronted. `resize_window` reports success and changes nothing in that state.
Pair this with the browser check above, or you will ask for the wrong window to
be brought forward.

**Three recovery routes, all tried, none worked** (2026-09-19):

1. *Look for a Suno tab in another window.* `tabs_context_mcp` only ever returns
   tabs in **its own tab group**, not every tab the browser has open. It cannot
   see, let alone reach, a tab in a different window. Dead end by design.
2. *Open a fresh tab and hope it lands in the focused window.* `tabs_create_mcp`
   creates inside the **same MCP tab group**, so it inherits that group's window
   and its visibility. The new tab came back `hidden: true` too. It also opens in
   the background, and there is **no tab-select/front tool** in this MCP, so a
   background tab reports `hidden` regardless — which makes this test ambiguous
   even when it fails. Judge visibility on the tab that `tabs_context_mcp`
   reports as `selectedTabId`; that one is unambiguous.
3. *Front the browser with computer-use.* `request_access` for a browser first
   returns a one-time refusal explaining browsers are read-tier only; calling it
   again **in the same turn** grants it (stop to reply and you get the refusal
   again). The grant succeeded and reported a window on the primary display —
   but `open_application` runs in *background app mode*, which by its own
   description "does NOT bring it to the front". Visibility was unchanged.
   Fronting needs display scope, which raises a separate screen-takeover consent
   card — not worth it unattended.

**Synthetic events are not a workaround.** Neither `el.click()` nor a full
hand-rolled `pointerover → pointerenter → mouseover → pointerdown → mousedown →
pointerup → mouseup → click` sequence with correct `clientX/clientY`,
`pointerType: 'mouse'` and `isPrimary` will open Suno's row menus or its cover
Edit overlay. The components ignore untrusted events. Anything that needs a menu
or a dialog needs a real, visible window; only reading and `fetch` work headless.

## The bundle-scraping trick

The most productive single step was not clicking anything:

```js
const srcs = Array.from(document.querySelectorAll('script[src]')).map(s => s.src);
const found = new Set();
for (const s of srcs) {
  try { const t = await (await fetch(s)).text();
    for (const m of t.matchAll(/["'`](\/api\/[a-zA-Z0-9_\-\/\.\$\{\}]{2,60})["'`]/g)) found.add(m[1]);
  } catch (e) {}
}
Array.from(found).sort()
```

313 distinct `/api/` paths, templated (`/api/gen/{clip_id}/comment`), in one
call. This is strictly better than guessing endpoint names — the failure mode
CAPABILITIES.md warns about, where eight plausible "list personas" paths all
404'd. **Scrape the bundle first, then confirm the payload at the call site,
then drive the UI once to watch it fire.**

To read a call site, grab ±600 chars around the needle and reduce to
identifiers (see the MCP-blocking note above).

---

# What is NOT done

- **Exactly one track has been changed:** `0abf0078-…` (*1. Harbour, Before
  Dawn*) now carries `cdn2.suno.ai/e843bb48-…jpeg`, its own plate. Nothing else
  on the account was touched in any pass.
- Album-level covers (`PATCH /api/playlist/v2/{id}` with `cover_image_s3_id`)
  remain untested — steps 1 and 2 are now shared and proven, only the PATCH is
  unrun. No playlist was modified.
- The scripted, non-transcoding variant (`{"extension":"png"}` + original bytes)
  is reasoned from the observed flow but has not itself been run. First batch
  track should be treated as a test and the resulting `image_url` checked for a
  `.png` suffix.
- Whether a second upload for the same clip orphans the previous S3 object, or
  whether old covers are reaped, is unknown.
- `cover_art_session_id` — client-minted UUID, purpose assumed telemetry. Not
  known whether `set_metadata` rejects a request without it.

## The first live test — RUN, and what it proved

Completed 2026-09-19 on the fourth attempt; the first three were all blocked by
the hidden-window fault above, not by anything to do with Suno. Result: the
cover changed, verified by looking at it, and nothing else about the track moved.

**Publish state untouched**, checked two ways: neither captured payload contains
`is_public` or any publish field, and the `…` menu still reads `Publish` exactly
as it did before the edit (the item would read `Unpublish` had the state
flipped). Title and lyrics came back identical in the response. `EDIT_SONG_DETAILS`
and `PUBLISH_SONG` really are separate modals doing separate things.

One side effect worth knowing: the response set `video_is_stale: true`. Changing
the cover invalidates any generated video cover. Nothing regenerates on its own.

Below is the procedure as run, for repeating it by hand.

**Track:** `1. Harbour, Before Dawn`, clip
`0abf0078-7b96-4331-8d85-af33c1b16b45` — track 1 of Dead Reckoning, already
published, and the track the original exploration script itself nominated.

**File:** the plate embedded in that track's own MP3, so that even if the run
stops after one track the visible result on a published song is *correct*
rather than an arbitrary test image.

The embedded art and the plate on disk are **byte-identical** — extracted the
`APIC` frame from `R:\Music\Vombatus\Dead Reckoning\01 Harbour, Before Dawn.mp3`
and hashed both:

```
ID3v2.3, APIC mime image/png, picture type 3 (front cover), 2,068,011 bytes
sha256 ed30cb28d93d2908db88838bbe5c27c20ba0492a8de6d49ef37a8a8f7f748b38

F:\...\artwork\plates\dead-reckoning\01-harbour-before-dawn-plate.png
sha256 ED30CB28D93D2908DB88838BBE5C27C20BA0492A8DE6D49EF37A8A8F7F748B38   2,068,011 bytes
```

So either path gives the same bytes, and at 1.97 MB it clears Suno's 10 MB cap
comfortably. (`scripts/extract-cover.mjs` does the extraction — pure Node, no
ffmpeg.)

**Sequence, as actually run:**

1. Hard-navigate to the song page *first*, then arm the capture — never the
   other way round (a `navigate` wipes it, see above).
2. `…` → hover `Manage` → click `Song Details`. The submenus render on hover
   only. The menu items do **not** carry `role="menuitem"`, so `find` and
   `querySelectorAll('[role=menuitem]')` both come back empty even with the menu
   plainly open on screen — take a screenshot and click by coordinate instead.
3. Do **not** click the `Upload` button — that opens a native file picker no
   tool can see. Use `file_upload` against the dialog's hidden
   `input[type=file]` (there is exactly one on the page when the dialog is open,
   `accept="image/jpeg,image/jpg,image/png,image/webp,image/bmp,video/mp4,video/quicktime"`).
   The path must be one the session may read, so copy the plate into the outputs
   folder first.
4. **Nothing is sent at this point.** The file is read locally, the preview
   swaps to the new image and a crop slider appears. `Save` becomes enabled.
   All three network calls fire on `Save`.
5. Click `Save`, wait ~10s, read the capture.
6. Verify by looking, not by trusting the response.

Coordinate note: the tool's frame and the page's CSS pixels differ when the
browser is zoomed — here `innerWidth` was 2552 against a 1568-wide frame, a
factor of 0.6144. Get element rects in page context and scale them
(`frameWidth / window.innerWidth`) rather than eyeballing from the screenshot.

Once that round trip is recorded, the whole plate run is scriptable against
`/api/uploads/image/` + `/api/gen/{id}/set_metadata/` with no browser at all —
and with `extension: "png"` it avoids the JPEG transcode the UI forces.
