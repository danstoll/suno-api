# Component states

The design standard asks for 7 states: default, hover, focus, active, disabled, loading, error.
`done` = drawn on tokens. `n/a` = the component cannot be in that state, and why.
Picture of every state: `states-preview.html` (follows the phone theme).

| Component | default | hover | focus | active | disabled | loading | error |
|---|---|---|---|---|---|---|---|
| Header | done | done: `accent` fill (desktop only, a touch has no hover) | done: 2 px `ring` outline | done: `accent` fill (new) | n/a: links are never off | n/a: no data | n/a: no data |
| Logo | done | n/a: not a control; the link around it has the states | n/a: same | n/a: same | n/a: same | n/a: no data | n/a: no data |
| Section | done | n/a: layout only | n/a: layout only | n/a: layout only | n/a: layout only | n/a: layout only | n/a: layout only |
| Footer | done | done: underline (new; was on the text box, not the link) | done: 2 px `primary-ink` outline (new; `ring` is the same colour as the footer, so it cannot be seen there) | done: `primary-ink` text and underline (new) | n/a: links are never off | n/a: no data | n/a: no data |
| Swagger | done: stock light, dark in `swagger-dark.css` | done: Swagger's own | done: Swagger's own | done: Swagger's own | done: Swagger's own, buttons grey out while a call runs | done: Swagger's own "Loading" bar | done: Swagger's own red response box (raw hex, see gap 1 in README) |

The `/status` page buttons (`BUTTON` in `status/page.tsx`) are not one of the 5 base components. They already have hover, active and focus.
