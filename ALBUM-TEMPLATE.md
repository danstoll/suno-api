# Album planning doc — the template

A reusable shape for planning a Suno album before generating a single track.
First proven on Daddy Wombat's *Kitchen Table*, then sharpened by a Figured
Bass album draft ("Dead Reckoning") that added real musical specifics this
doc folds back in. Use it for any artist, any genre — pop duet or
instrumental concept record.

Two hard rules keep a planning doc compatible with this fork's generation
scripts (`scripts/make-track-oneshot.mjs`). Everything else here is
free-form; these two are not:

1. **Every track file needs a `## Suno Style Prompt` heading followed by a
   blockquote** (lines starting with `>`). The script reads the style text
   from there. No other heading name, no plain paragraph — the script's
   regex looks for exactly this.
2. **Every track file needs a `## Lyrics` heading**, followed by
   `[Section]` blocks (or, for an instrumental track, structural tags with
   no sung text under them). The script splits the prompt into sections on
   these brackets.

A Dead Reckoning-style doc that puts the style prompt and structure tags in
plain fenced code blocks under headings like "**Style prompt**" reads
beautifully but is NOT machine-parseable by the current script. Keep the
required headings even when everything else in this template is followed —
add the extra detail alongside them, not instead of them.

## What "more detail" means, concretely

*Kitchen Table*'s first draft got every track's genre and BPM right but left
the key as a vague "major key" on all fifteen tracks — no root note, so
there was nothing for Suno to actually lock onto. Naming a real key
(`C major`, `B minor`, `F# Phrygian`) in the style prompt text is
confirmed to work, the same way naming a real BPM already did. Vague
descriptors are wasted words; specific ones are levers. Prefer:

- A named key, not just "major" or "minor key" — `C major`, `E minor`,
  `Bb major`. Modal names (`C# Dorian`, `F# Phrygian`) work too, for the
  right kind of track.
- A time signature when it is not plain 4/4 — `6/8`, `9/8`, `7/8 ↔ 4/4`.
  Most pop tracks are 4/4 and do not need calling out; anything else does.
- An exact BPM, already standard practice in this catalogue — keep it.
- A one- or two-word lead-voice description — who is actually singing or
  playing the top line, not just "co-lead" restated fifteen times if it
  is not true fifteen times.

## Album-level sections

```
# ALBUM TITLE

**Artist:** ...
**Genre:** one line, the album's overall lean
**Model:** Suno v6 (or whichever is current — see suno-api/CLAUDE.md)
**Runtime:** approx total, track count
**Companion to / Built on:** optional — a prior album, a real classical
  work, a band-profile reference. Omit if there isn't one.

## The concept
What the album is about, in plain terms. For a narrative/concept album,
the story. For a themed record (values, routines, a season), the theme
and its purpose.

## The spine / reference (optional)
If the album is built on a real piece of music, a prior album, or a
specific band's toolbox (see the daddy-wombat-brand skill's "Band
Profiles" pattern), describe it here and say explicitly how it maps onto
the album's structure — which movement/section becomes which track(s),
which voice becomes which instrument or singer.

## Track order
| # | Title | Topic/Story | Genre | Key | Time | BPM | Lead voice |
|---|-------|-------------|-------|-----|------|-----|------------|
| 1 | ...   | ...         | ...   | ... | 4/4  | ... | ...        |

Fill Key/Time/BPM/Lead for every track, even a plain pop album where Time
is 4/4 throughout and Lead is "co-lead, trading" for most rows — stating
the obvious in a table is what makes the one exception (a solo voice, an
odd meter) visible at a glance.

## Sequencing logic
Why the tracks sit in this order — emotional arc, energy curve, paired
tracks, deliberate blocks (e.g. three tracks in a row on one theme).

## Global settings
Model, Max Mode policy, Variety policy, and the RANGE each slider runs
across the album (e.g. "Weirdness 20 to 65 depending on track, listed per
file"). Anything that's the same on every track belongs here once, not
repeated fifteen times.

## Generation order
Which track to generate first (a "sound-bible" track to build a Persona
from, or a reference-audio source), which tracks are diagnostic/stress
tests for how far the Persona can stretch, and what to do with the rest.

## Honest limits / Known risks
What Suno is likely to get wrong for this specific album (odd meters,
real silence, extreme dynamics, sound effects) and the fallback for each
— reroll, exclude a style, or accept the compromise.

## Paired tracks (optional)
Any two tracks that deliberately echo each other — same lesson in two
genres, two halves of one topic, a recurring motif. Worth calling out
explicitly, and worth considering whether they should share a key or a
motif for the listener to feel the connection even half-consciously.
```

## Per-track sections

```
## N. Title

**Sonata link / reference:** optional, only if this track maps onto a
  specific reference work or an earlier track's motif.
**Target runtime:** M:SS
**Story / Topic:** what happens, or what the song teaches, in a
  sentence or two.

## Suno Style Prompt
> Genre, era, KEY, TIME SIGNATURE IF NOT 4/4, BPM, instrumentation,
> vocal/lead description, mood. Four to seven descriptors — see the
> daddy-wombat-brand skill's "Writing a style prompt" section for the
> descriptor cap and why order matters.

## Lyrics
[Intro — ...]
[Verse 1 — lead description]
...structure tags and lyrics, one label per line, per the brand skill's
"brackets vs parentheses" rule if this is a vocal album...

## Suno v6 Settings
- Model: v6 (or the current default — check suno-api/CLAUDE.md, it moves)
- Key: <the specific key used in the style prompt above>
- Time: 4/4 (or whatever it actually is)
- Vocal Gender: as appropriate — LEAVE UNSET for a duet
- Variety: as appropriate
- Weirdness: N (this track's value, not the album range)
- Style Influence: N
- Audio Influence: N, plus what it's referencing if anything
- Exclude styles: comma list

## Notes
Anything a future generation run needs to know: what's fragile about
this track, what a bad take looks like, what to check before accepting
one.
```

## Converting settings to CLI flags

The doc states sliders as 0-100 percentages, matching Suno's own UI. The
generation script wants 0-1 floats. Divide by 100:

| Doc says | Pass to `make-track-oneshot.mjs` |
|---|---|
| Style Influence: 75 | `--style-weight 0.75` |
| Weirdness: 25 | `--weirdness 0.25` |
| Audio Influence: 45 | `--audio-weight 0.45` |
| Max Mode: ON | `--max-mode` |
| Model: v6 | `--model chirp-hawk` (v6 Pro — see suno-api/CLAUDE.md for other v6
  tiers and their codenames, where known) |
| Duration: 3:00 | `--duration 180` or `--duration 3:00` |

`--audio-weight` and `--max-mode` were added to the script on 2026-09-13,
specifically because a planning doc this detailed needed them and the
script didn't have them yet — check `scripts/make-track-oneshot.mjs --help`
(the header comment) for the current flag list before assuming this table
is still complete.

## Why this shape works

Every section here earns its place by answering a question the generation
step will otherwise ask mid-album: which track first, what happens when
the Persona doesn't stretch far enough, what silence needs to survive
generation, which two tracks are supposed to rhyme with each other. Write
the answers down before generating, not while debugging a take that came
back wrong.
