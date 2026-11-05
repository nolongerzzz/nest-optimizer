## Supports Blockers and Slice and Preview
Supports card: a **Supports Blocker** button and a right-click **Add Supports Blocker...** put ghost boxes on the plate
(move, Shift up/down, stretch by a face's handle, many, overlapping = one area); no support is made inside them - spots,
the sheet's surface and the supports' own routes are all kept out. The card's last button, **Slice and Preview**, runs
the Slice card's slice and opens it in G-scope; the Slice card is unchanged. See docs/SUPPORT-BLOCKERS.md. Checks:
`support:blockers` (Node), `support:blockers-drive` (Chromium). `app-print.js`'s `slice()` returns a promise now.
