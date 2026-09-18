# Suno UI exploration script — for Claude Desktop / Claude in Chrome

**Goal:** click through the Suno web app on purpose, feature by feature, while
`capture-suno-requests.js` is armed in the console, so any API endpoint the
app uses shows up in the capture — instead of being found later by reading a
third-party extension's source code, the way the WAV download endpoints were
found on 2026-09-18.

## Priority tests (do these first, before the general walkthrough below)

### Test A — Studio export vs. download quota

A fan guide claims Premier's Studio export doesn't count against the normal
monthly download quota (this account was at 46/60 used, 7 bonus remaining,
as of 2026-09-18 — checked directly via `/api/billing/info/`). This is worth
confirming before relying on it for the remaining Vombatus downloads.

1. Note: don't bother re-checking the current download count yourselves —
   the account may currently be rate-limited from an unrelated bulk check
   (see `suno-api/CAPABILITIES.md`'s "Worth knowing" section, 2026-09-18
   entry) and hammering `/api/billing/info/` again right after a 429 makes
   it worse, not better. Whoever picks this up in chat will check the
   before/after count once the rate limit has had time to clear.
2. Open any track, click `open_in_studio` (or however "Open in Studio" is
   currently labelled) to open it as a Studio project.
3. Use Studio's own **Export** function (not the regular track-level
   Download button) to export the track — try a full-song WAV export first.
4. Report back exactly what export options Studio offered and which one was
   used, so the download count can be checked against the right kind of
   export afterward.

### Test B — find the "add a song to a playlist" endpoint

This is the thing actually blocking the "one public playlist per Plex album"
project. Suno's API has **no known way to add a song to a playlist** — six
live guesses against the real API all failed on 2026-09-18 (see
`suno-api/CAPABILITIES.md`'s "Adding a clip to a playlist" section for why
further guessing is a dead end: most single-segment guesses under
`/api/playlist/` false-positive a 405 because they accidentally hit the
`{id}` route, which only supports GET). The real request shape has to be
read straight off the network tab while a human actually does it.

1. Open your Suno library and find the playlist called **"Vombatus Test
   Delete Me"** — an empty throwaway made via the API earlier today. Safe to
   use; nothing in it matters.
2. Pick any one track. Find wherever "Add to playlist" lives — most likely
   the "..." overflow menu on the track — and add it to that playlist.
3. Open the playlist and confirm the track actually landed in it.
4. **On this test playlist only**, find its Public/visibility toggle
   (probably in the playlist's own menu or a Share dialog) and turn it on.
   This is normally off-limits — see the Rules below — but is explicitly
   approved for this one throwaway playlist so the endpoint can be learned
   safely before it's ever used on a real album. Turn it back off once
   you've confirmed what fired.
5. Add a second, different track to the same playlist the same way, to
   confirm the request shape repeats rather than being a one-off fluke.
6. Report back, in plain language, exactly which menu items and buttons you
   clicked for each step — the click path matters as much as the network
   traffic, since whoever builds the real script next needs to describe it
   to a human doing this manually if scripting still isn't possible.

## Before starting

1. The human has suno.com open, signed in, in a normal tab (not a fresh
   headless/automation profile — Suno challenges those harder).
2. The human has opened DevTools → Console, pasted the whole contents of
   `suno-api/scripts/capture-suno-requests.js`, and pressed Enter. Confirm you
   see `[capture] armed.` printed before doing anything else. If not, stop and
   ask the human to load it.
3. Do not proceed past this point until the human confirms the capture is
   armed — every step below is only useful with it running.

## Rules — read before clicking anything

- **Never click:** Publish, Make Public, Delete (permanent), Cancel
  Subscription, Upgrade/Buy, or anything in account billing that isn't just
  *viewing* a page. These are irreversible or change something outside the
  account's own credit balance — that's a different category of risk from
  spending credits, and stays off-limits. **One narrow, explicit exception:**
  Test B above approves toggling Public/visibility on the "Vombatus Test
  Delete Me" throwaway playlist specifically, and only to learn the endpoint
  — turn it back off once confirmed, and do not make anything else public.
- **Credit-spending actions are approved. Go ahead and use them —
  Generate, Extend, Remix/Cover, Create Video, Get Stems/Whistle, Persona
  creation are all fine to actually click through, not just note.** The
  human's own words: "allow it to use credits, this is the value we are
  looking to get." A generate can use a short throwaway prompt (one word is
  fine) — the point is the API call it fires, not the song it makes.
  **Still mention it in plain language right before you do it** ("about to
  click Generate to see what fires" / "trying Get Stems on this track now")
  so the human can follow along, but don't wait for a yes each time.
- **Reading/opening a menu is always safe.** Opening the "..." menu on a
  track, opening Download's submenu, opening Settings/Account/Billing to
  *look* — none of that costs anything or changes state. Do all of this
  freely.
- **Liking/unliking and trash/restore on a track are low-risk and reversible**
  — fine to do once each on a throwaway or already-liked track, but check
  with the human before doing it on something they clearly care about.
- After each numbered section below, tell the human what you saw (menu items,
  any dialogs, anything unexpected) in plain language before moving to the
  next section — they're watching the console fill up with entries in
  parallel and will want to sanity-check against it.

## The walkthrough

### 1. Library / project browsing
- Open the main song library or a specific project/workspace.
- Scroll to load more songs (pagination often reveals its own endpoint).
- Use the search or filter box if one exists.

### 2. A single track's overflow menu
- Click the "..." (or similar) menu on one track. **List every item you see**
  — don't just click Download. Menu items like "Get Stems", "Create Video",
  "Publish", "Make Instrumental" reveal endpoints even if you never click
  through them.

### 3. Download — the main target
- Click "Download" (or the download icon). **Note every format option
  offered** (MP3, WAV, video, stems, etc.) and whether any option is greyed
  out, locked, or shows an upsell/subscription prompt.
- Click every format option offered, including WAV/convert, even if it warns
  about spending credits — that warning is fine to accept. Watch for a
  follow-up "your file is ready" state. This is exactly the flow that used
  `convert_wav` / `wav_file` under the hood — confirm whether the UI now
  surfaces it directly instead of it being a hidden mechanism.
- If it prompts for a **subscription upgrade or a real-money payment**
  (not a credit spend), stop — note what it said, do not proceed. That's
  the one boundary that stays hard even with credits approved.

### 4. Like / unlike
- Click the heart/like icon on a track. Click it again to unlist.

### 5. Trash / restore
- Move one track to trash, then restore it from the trash view.

### 6. Account, billing, credits (view only)
- Open Account settings, Billing/Subscription, and Credits/Usage pages.
  Just load each one — do not click Upgrade, Cancel, or Buy.

### 7. Persona / voice features, if visible
- Find where a "Persona" or similar reuse-a-voice feature lives in the UI,
  and actually run through creating one on a track. Note what it asks for
  at each step and what fires when you submit it.

### 8. Sharing / links (view only)
- Open a "Share" dialog if one exists, note what link format it generates,
  close it without actually changing visibility.

### 9. Workspace/project switching
- Switch between two projects/workspaces if the account has more than one,
  to see whether that fires its own API call.

## Wrapping up

1. Ask the human to run `__sunoCapture.list()` in the console and glance over
   it with you.
2. Ask them to run `__sunoCapture.copy()` (or `.save()` if clipboard access is
   blocked) and paste the JSON back into this chat, or into whichever Claude
   session is reconciling it against `suno-api/scripts/fade-out.mjs` and the
   other scripts.
3. Flag anything that looked new or different from what's already documented
   in `suno-api/CAPABILITIES.md` (or wherever the endpoint list currently
   lives) — that's the actual payoff of this exercise.
