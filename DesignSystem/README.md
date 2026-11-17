# suno-api design system

A plain, calm page for a tool you run yourself. White page, black text, one deep indigo accent. In dark mode: near-black page, light text, pale indigo accent. There is no logo art and no photo. The page is a status board and a link to the API docs.

## Voice
Short and plain. Say what the page does ("Cookie status", "Refresh"). No marketing words.

## Colour
Light is the stock look. Dark follows the phone (`prefers-color-scheme`). There is no theme switch.

| Token | Use |
|---|---|
| `color-background` | the page |
| `color-ink` | body text |
| `color-ink-muted` | captions and quiet text |
| `color-border` | lines and dividers |
| `color-primary` | the hero card, links, buttons |
| `color-primary-ink` | text drawn on primary |
| `color-accent` | soft hover fill |
| `color-ring` | focus ring |
| `color-ok` / `color-warn` / `color-err` | healthy / pending / broken |

One colour, one meaning. Status colours are only for status. All text colours are at least 4.5:1 on the page in both themes.

## Type
Inter, from `next/font`. Sizes are the Tailwind scale (`text-xs` to `text-3xl`) plus three small sizes for dense status tables: `text-label`, `text-table`, `text-stat`.

## Space, radius, shadow
Space steps are 4 px (`space-1` to `space-8`). Radius is `radius-sm`, `radius-md`, `radius-lg`; the hero card uses `radius-card` and `shadow-card`. Tailwind classes such as `p-4` use Tailwind's own scale, not the `--space-*` names.

## Motion
Tokens `duration-fast` (150 ms), `duration-base` (200 ms) and `ease-standard`. Hover changes use 200 ms. Keep motion small; nothing moves on its own.

## Project names
Tokens that belong only to suno-api carry the `suno` prefix: `color-suno-muted` (heavy rule), `color-suno-card-edge` (hero card edge).

## Files
- `tokens/*.css` is the source. `src/app/globals.css` imports it.
- `tokens.json` is generated: run `npm run tokens`. A test fails when it is stale.
- The app lives in `src/app/`; the Swagger dark theme is `src/app/swagger-dark.css` and still holds a few raw colours (see gaps).

## Known gaps
1. `swagger-dark.css` has its own hex palette for Swagger UI, outside the tokens.
2. No theme switch and no `.dark` class: dark follows the phone only.
3. The 7 component states are listed in `states.md` (picture: `states-preview.html`).
