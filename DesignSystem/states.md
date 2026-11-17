# Component states

The design standard asks for 7 states: default, hover, focus, active, disabled, loading, error.
`done` = drawn on tokens. `n/a` = the component cannot be in that state, and why.
`states-preview.html` draws the Header and Footer link states by hand (a mock-up, not the live components). It follows the phone theme. Logo, Section and Swagger have nothing of their own to draw.

| Component | default | hover | focus | active | disabled | loading | error |
|---|---|---|---|---|---|---|---|
| Header | done | done: `accent` fill (desktop only, a touch has no hover) | done: 2 px `ring` outline | done: `accent` fill while pressed (new) | n/a: links are never off | n/a: no data | n/a: no data |
| Logo | done | n/a: not a control; the link around it has the states | n/a: same | n/a: same | n/a: same | n/a: no data | n/a: no data |
| Section | done | n/a: layout only | n/a: layout only | n/a: layout only | n/a: layout only | n/a: layout only | n/a: layout only |
| Footer | done | done: underline, desktop only (new; was a text colour change on the box, not the link) | done: 2 px `primary-ink` outline (new; `ring` is the same colour as the footer, so it cannot be seen there) | n/a: a press looks like hover on desktop; a touch has no hover and the page changes on release | n/a: links are never off | n/a: no data | n/a: no data |
| Swagger | done: stock light, dark in `swagger-dark.css` | done: Swagger's own | done: Swagger's own | done: Swagger's own | done: Swagger's own (not re-checked in this PR) | done: Swagger's own (not re-checked in this PR) | done: Swagger's own (raw hex in dark, see gap 1 in README; not re-checked in this PR) |

The `/status` page buttons (`BUTTON` in `status/page.tsx`) are not one of the 5 base components. They already have hover, active and focus.
