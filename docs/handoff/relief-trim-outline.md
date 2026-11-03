## Picture -> Trim: clip the flat plate off a relief, keep the item's own edge (2026-11-03)
Branch `claude-wip`. Full write-up: **`docs/RELIEF.md`, section 1b**.

- **What it is:** an option on the Picture (relief) build, `trim: 'off' | 'outer' | 'holes'`
  (card: **Trim** Off / Outline / Outline + holes), default off - off is the slab
  as it was, bit for bit. On, the rectangle of flat base is clipped away and the
  slab's outline becomes the outline of whatever stands above the base.
- **How:** it reads the height grid the slab was built from (so it outlines the
  relief the card would print), marks samples above `trimAbove` (Cut-off, 10% of
  Relief), closes hairline gaps (`trimBridgeMm`, Bridge, 1 mm), drops specks and
  fills holes by `trimSpeckPct` (Speck, 1% of the item), grows a rim
  (`trimMarginMm`, Rim, 0), then clips every top triangle to the blurred mask's
  contour. Cut points are shared per grid edge (no cracks), at 0.1..0.9 along it
  (no slivers), at the top's own height; every kept sample is bit-identical to
  the whole slab's. Floor and walls follow the top.
- **Decided by measurement, not assumed:** the first cut at the blur's one-half
  crossing closed a hairline slit on a key photo and turned a bright pocket into
  a hole, so `Outline` reported a hole. The blur now only places the edge; it
  can never move a sample to the other side, so the solid has exactly the mask's
  holes and bays. `census` carries `shells` / `holes` and closed means
  Euler = 2 shells - 2 holes against an independent count of boundary loops.
- **The card's live line is a ceiling with Trim on** ("<= N triangles before the
  trim"): plan() is the whole slab's closed form, build() reports the real count.
- **Found, not fixed:** it outlines by height. A bright part of the item that
  touches the ground with no dark rim reads as plate; Bridge closes gaps to
  about twice its value, wider stays a bay. On the user's key photo,
  `Outline + holes` at the default Speck keeps three holes - the key-ring eye
  (15.8 mm^2) and two bright blade pockets (~11 mm^2, 1.2% of the item); Speck 1.5
  keeps only the eye, 2 fills that too. The window is narrow, which is why Speck
  is on the card. A picture with real transparency would outline exactly from its
  alpha; the card composites over white and drops alpha, so that is not done.
- **Checks:** `relief:test` 277 -> 370 (section 9: disc, ring, slit, specks, rim,
  item on the edge, cut-off, refusals, camera.png; canonical checker on each,
  Euler 0 where there is a real hole). `relief:drive` has a new 4b: the real card,
  Off / Outline + holes / Outline, the numbers dim with Trim off, Undo (here) puts
  the trim settings back.
- **Tags:** `nso_relief.js`, `app-relief.js`, `index.html` changed; `?v=` tags
  are not picked here - `npm run stamp` before a PR.
