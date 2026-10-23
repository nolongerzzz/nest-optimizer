## New stock - the Pottery Wheel's Ball, generalised (landed, `nso_stock.js`)
`nso_stock.js` + `app-stock.js`, its own **Stock** viewport menu, wired into
`index.html` at `?v=stock1`. Full write-up: `docs/STOCK.md`.

What it is: one step before Carve, Hollow, auto-aim support, Cut or Skin - put
a blank on the plate that is the right size for the piece you mean to make.
Target height/radius/wall -> a Pappus thin-shell estimate -> a tunable waste
margin -> solved for a sphere's radius, a box's scale or a cylinder's radius.
The build volume is checked BEFORE anything is generated, against the machine
the Plate card is pointed at: a target that cannot be printed is a hard
refusal, a stock block that cannot be is a refusal `warnOnly` downgrades.

**It is an extraction, and the Pottery Wheel is unchanged.** The sizing and the
revolve both came out of `app-wheel.js`; `NSO_wheelSizeBall` is one call into
`NSO_Stock.size({ shape: 'sphere' })` and `NSO_wheelRevolve` hands its meridian
to `NSO_Stock.revolve`. The wheel now refuses by name without `nso_stock.js`,
the same contract rim extension has on `app-extend.js`. BALL's numbers and its
status line are pinned character-for-character against the figures
`docs/POTTERY-WHEEL.md` published before the move, and
`tools/nso_wheel_test.js` / `tools/nso_printer_fit_test.js` still pass
unchanged.

The three defaults - 3.0 mm wall, 30% waste, 0.5 aspect - are now stated once,
in `NSO_Stock.DEFAULTS`, instead of once per file.

```
npm run stock              headless: the extraction, three shapes, the gates
npm run stock:canonical    canonical checker over every generated piece
npm run wire:stock         the real app, real clicks, real refusals
```

All three are in `npm test`. Adding the third viewport menu was a
`--vp-menu-count` bump in `styles.css` and nothing else, as the note in
`:root` said it would be.
