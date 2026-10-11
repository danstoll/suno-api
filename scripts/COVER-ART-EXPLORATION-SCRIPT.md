# Suno cover-art exploration script — for Claude Desktop / Claude in Chrome

**Goal:** find out whether Suno's web app lets you replace a track's (or
persona's) picture at all, and if so, capture the real request shape while
`capture-suno-requests.js` is armed in the console — instead of guessing
endpoint paths, which has already failed twice for a different feature (see
`CAPABILITIES.md`'s "Adding a clip to a playlist" section) and risks looking
like scanning behaviour to Suno's anti-bot checks.

**Context:** we have ~48 new cover/track images ready locally (old-master
oil paintings with a locked medallion, one per Vombatus track) and want to
put them on the matching songs inside Suno itself, not just in our own Plex
library. Nobody has confirmed Suno even exposes this to users — the UI's
per-track "..." menu has been observed before (`Cover, Reuse Prompt, Mashup,
Sample this song, Use as Inspiration, Voice`) and "change picture" was not
one of the items seen, so this may come back empty. That's a useful result
too — it means we stop here instead of reverse-engineering something that
doesn't exist.

## Before starting

1. The human has suno.com open, signed in, in a normal tab (not a fresh
   headless/automation profile — Suno challenges those harder).
2. The human has opened DevTools → Console, pasted the whole contents of
   `suno-api/scripts/capture-suno-requests.js`, and pressed Enter. Confirm
   you see `[capture] armed.` printed before doing anything else. If not,
   stop and ask the human to load it.
3. Do not proceed past this point until the human confirms the capture is
   armed — every step below is only useful with it running.

## Rules — read before clicking anything

- **Never click:** Publish, Make Public, Delete (permanent), Cancel
  Subscription, Upgrade/Buy, or anything in account billing that isn't just
  *viewing* a page.
- **Reading/opening a menu is always safe.** Open every menu, every "...",
  every Edit/Settings dialog you find, just to look — none of that costs
  anything or changes state.
- **If you find an actual "change picture" affordance, it's fine to use it
  for real** — this is a metadata change, not a delete or a publish, and
  it's easy to fix again by repeating the same steps with a different file
  if the result looks wrong. Test it on **one already-published Vombatus
  track first** (any one is fine — pick something from Dead Reckoning), not
  the whole catalogue, and tell the human which track you picked before you
  do it.
- Use one of the real new plate images as the test upload, so the test
  doubles as actual progress instead of a throwaway. Good candidates:
  `F:\Projects\DaddyWombat\daddy-wombat-tunes\artwork\plates\dead-reckoning\01-harbour-before-dawn-plate.png`
  or `F:\Projects\DaddyWombat\daddy-wombat-tunes\artwork\vombatus-medallion-locked.png`
  as a smaller/simpler test file if the upload dialog seems finicky about size.
- After each numbered section below, tell the human what you saw (menu
  items, dialogs, anything unexpected) in plain language before moving on.

## Where to look (in priority order)

### 1. A single track's "..." overflow menu
Open it on any Vombatus track. List every item you see, not just the
obviously relevant ones — "Edit", "Edit details", "Details" are the likely
names for anything that bundles title/lyrics/art together.

### 2. Whatever "Edit"/"Details" opens
If step 1 surfaces an edit dialog, check whether the artwork itself is
shown there with any click/hover affordance (a camera icon, an "upload"
overlay on hover, a pencil icon on the image) — many song editors bundle
title + lyrics + art into one dialog rather than a dedicated menu item.

### 3. Persona creation flow
Open wherever "Create a Persona" lives (from a track's menu, or a top-level
nav item) and start creating one, without finishing/saving it if you can
avoid it. Personas have their own image field (`image_s3_id`, confirmed to
exist in Suno's own response schema, but no known write path yet) — if the
creation flow lets you upload a custom picture for the persona, that reveals
the general image-upload endpoint even if it turns out track covers
specifically can't be changed. This is worth checking even if step 1 and 2
come back empty.

### 4. Studio project settings
If you have a Studio project open, check its own settings/cover (separate
from any individual clip inside it) for an image field.

### 5. Account / profile picture (Settings)
Open Account Settings and look for a profile picture upload. Not the actual
goal, but confirms the generic upload pattern if nothing else does — worth
a quick look even if you don't submit a change.

## If you find a working "change picture" feature

1. Say so in plain language before clicking further ("found it — the Edit
   dialog has a camera icon over the artwork").
2. Use it once on your chosen test track, uploading one of the real plate
   files listed above.
3. Confirm in the UI that the picture actually changed.
4. Note whether it warned about anything (credits, a subscription tier, a
   content-review delay before it takes effect).

## Wrapping up

1. Ask the human to run `__sunoCapture.list()` in the console and glance
   over it with you.
2. Ask them to run `__sunoCapture.copy()` (or `.save()` if clipboard access
   is blocked) and paste the JSON back into this chat.
3. Report back plainly: did the feature exist at all, where it lived in the
   UI if so, and the exact request(s) that fired (method, path, body shape)
   so a script can reproduce it — or, if nothing turned up anywhere in
   sections 1-5, say so clearly so we stop here instead of guessing further.
