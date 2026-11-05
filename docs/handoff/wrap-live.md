## Wrap, live - pictures for Feature and Layout, a ghost of the wrap on the piece while you work, WRAP bakes what you see (2026-11-03)

New: `app-surftex-live.js` (the layer; `app-soften-live.js` and `app-thicken-live.js` are its models), `tools/nso_surftex_live_drive_check.js`
(`surftex:live`, a drive). `app-surftex.js` splits `NSO_surftexWrap` into `NSO_surftexCompute` + the commit and calls the live layer at five points;
`index.html` (Wrap card: Feature and Layout are tile shelves, their `<select>`s are hidden), `styles.css` (the `surftex-*` shelf rules, on top of Soften's tile
rules), `app-stock.js` (the tile painter's optional `view`), `docs/SURFTEX.md`; `nso_surftex.js` is untouched.

**What you get.** Open Surface & edges > Wrap. Five feature tiles (Spike, Ball, Bump, Dent, Line) and four layout tiles (Grid, Stagger, Hex, Diamond), each
painted once from `NSO_SurfTex.apply` on a 22 mm slab - the same call WRAP makes - with the surface the wrap made lit green (layout tiles are viewed almost
straight down: the pattern is the picture). Touch anything on the card - a tile, a skin, a number, the face - and the piece turns to a ghost with the new
patch drawn on it, redrawn as the numbers move. A click on the piece picks the face under it (a click, not a drag). WRAP installs the preview's own
result; Close drops it.

**The bake installs what is on screen.** `NSO_surftexCompute` is everything Wrap decided (paint stand-down, regions, picks, `apply`, the sentence); WRAP
calls `NSO_surftexWrap({ computed: nsoSurftexLive.fresh() })`, which is the preview's result when its key (faces + every number) and the piece's soup still
match, and a fresh compute otherwise - so every refusal Wrap ever made is made at preview time with its usual words, and there is no second calculation that
could disagree with the ghost. The ghost comes off (`release()`) before the commit, because the commit swaps the piece's mesh. After a bake the preview is off
until something is touched again.

**The patch is the tail of the result.** `apply` returns the kept triangles first and the new patch last (`res.added` of them), so the preview draws only the
patch over the ghost; the face being replaced keeps the amber tint the card already drew.

**Paced.** `apply` is synchronous and its cost is the face's. A redraw waits as long as the last one took (never under 100 ms); only the latest numbers are
drawn; a preview that took over 2 s is redrawn on `change` (a number let go), not on every `input`. If a dense lattice on a big face still feels slow, that
is where to look (a worker, or a coarser preview pass) - nothing here moves the work off the page thread.

Things worth knowing:
- The Feature and Layout `<select>`s are hidden, not gone: `NSO_surftexParams` and the skins read and write them, and a tile sets one and fires its `change`.
  Anything that selected a feature with `selectOption` should click the tile instead (`nso_surftex_drive_check.js` does now).
- Skins are still a drop-down. A picture for each of the eighteen would mean wrapping a bore, a sphere and a contoured face for the tiles; not done.
- Sides, the line's Section and Groove are still selects / a box. A skin or a tile changes which of them show (`NSO_surftexShowFields`), as before.
- The tile pictures are 22 mm slab wraps at fixed sizes (feature tiles 8 mm / 10 mm pitch, layout tiles 2.6 mm / 4 mm); they show the kind of feature and the
  kind of lattice, not the sizes in the boxes.
- Click-to-pick maps the clicked triangle through the region masks, so it only finds the twelve faces the Face list shows, and says so when it hits a smaller one.
- Paint stands the whole card down as before; the preview says so in the readout instead of drawing.
