## Scale zones in Scale - part of a piece scaled, the rest kept (2026-11-28)
The owner's ask: a scale "blocker / enforcer" to scale one part and keep
another - a shower head on the same threaded fitting, a thumb screw's head on
the same thread, one pillar of a stringing test.
- **Scale zones** (`nso_scale_zones.js`, `app-scale-zones.js`,
  [docs/SCALE-ZONES.md](../SCALE-ZONES.md)): button at the foot of the Scale
  card, under Feature size. + Keep / + Scale then a click fits a zone (a
  cylinder or box along the piece's own axes) round the part under it;
  Shift-click puts a plain box. Zones drag, stretch by handles, or are typed.
  Scale % (or X / Y / Z), Anchor Join | Centre | Base, Blend mm. Green ghost,
  pink pivot dots, Set / Enter = one Undo (`scaleZonesReplace`), Cancel / Esc.
- Keep wins; with no Scale zone everything outside the Keep zones scales.
  Moving vertices split into parts by edges (per Scale zone); each part about
  its own pivot. Same triangles: the faces crossing a zone's skin stretch.
  Folds refused; pierce gate at Set on the triangles near the move (skipped,
  in words, above 120 000).
- Zones are kept on the model (`m.scaleZones`, raw frame); a Scale zone is
  carried with its part after Set.
- Fixtures: `tools/nso_scale_zones_fixture.js` (screw, pillar plate, shower
  head - revolved profiles and a heightfield, all closed).
- Checks: `npm run scale:zones` (node, testSteps), `npm run scale:zones:drive`
  (driveSteps).
