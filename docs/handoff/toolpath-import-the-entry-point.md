## Toolpath import - the entry point (2026-09-20)
Branch `claude/gcode-microscope-entry`, off `claude-wip`. One rail button, under
X-ray in the viewport's bottom-left column:

> **G**🔬  `#btn-gcode`, with `#gcode-input` beside it

It opens a file chooser, and a picked `*.gcode.3mf` goes straight to
`NSO_TOOLPATH.importSliced3MF()` - the same call `handleFiles()` has made since
the importer landed, with the same bytes. The card opens and takes the keyboard
so its arrow keys scrub from the first press, and the button stays lit while a
session is open. Dropping a sliced project on the Library file box still works
and still does exactly the same thing; nothing was moved or replaced.

**What was actually missing, because it is worth being precise about.** Nothing
in the pipeline. The importer, the Z filter and Extract Line were all landed,
wired and green. What was missing was any way to find out they existed: the
Toolpath card is `hidden` until an import succeeds, so the only route in was to
already know that a `*.gcode.3mf` dropped on the Library box behaves differently
from a model - and nothing on screen, anywhere, said so. The audit found no
second gap. This change adds no capability.

**How that survived three green suites.** `gcode:drive` gets its file in by
calling `handleFiles()` from page script. That is the right shape for testing an
importer, and it is exactly why a finished feature could be unreachable and fully
checked at the same time: no check had ever touched a control a user can see. So
the new suite does not get to use page script at all.

`npm run gcode:entry` (`tools/gcode-test/entry-drive-check.mjs`, 55 checks, in
`npm test`). It asserts the button's place from the **rendered boxes** - same
left edge as X-ray, 8px below it by the rail's own gap, the same 44px square,
both glyphs inside the box, and the rail painting top-to-bottom as
undo / frame / X-ray / G / watch (now with the Microscope view's own 🔬 between
G and watch - see that entry below) - then clicks it, answers the file chooser
Chromium really opens, and drives the rest through the DOM: scrub, `Isolate Z`,
Extract, Undo, uncheck. It never calls `handleFiles()` or `importSliced3MF()`.
Both files are real Bambu slices: `supportwithinsupport.gcode.3mf` for the full
flow, then `tabletop.gcode.3mf` on a fresh page - 202,877 moves, 73 layers,
imported in ~7s, Z filter handler 48 ms, isolated layer out at 50,028 triangles.

It also pins the two things a door can get wrong. A plain `.3mf` picked here is
**refused by name** and nothing is imported - `accept=".3mf"` is as narrow as a
file input goes (`.gcode.3mf` is not a single extension), so the handler is what
says no, rather than a model arriving silently from the G-code button. And the
box already on the plate stays visible while the Z filter hides the import's own
models, so the filter still only touches what it brought in.

**`?v=` NOT bumped** - rule 4, Grok owns those. `app-toolpath.js` is still at
`?v=toolpath1`, so a browser holding the old copy gets the button's markup and
none of its wiring, and the button does nothing. **It needs a bump at merge.**
