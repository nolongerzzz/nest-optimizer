/* ============================================================
   Hollow / Fill - the app layer over nso_hollow.js.

   Thin on purpose, the way app-carve.js is thin: all the geometry lives in
   nso_hollow.js, which is THREE-free and node-tested, and all the floor lives
   in nso_thickness.js. What is here is the three things that can only be done
   in the app - read the controls, take the piece's raw soup, and commit the
   result the way every other geometry op commits.

   THREE BUTTONS, and the third is not a convenience.

     Hollow              carve the interior out to the wall in the box.
     Fill / Densify      the inverse: fill the cavity solid again.
     Hollow to safe min  hollow out to the SAFEST wall, not to a number.

   The third exists for the thicken -> edit -> hollow back out workflow. Thicken
   in was used to put enough wall under a feature for a cut to bite into; the
   cut is done; the wall should come back down. Back down TO WHAT is the whole
   question, and "to whatever it was before" is the wrong answer whenever the
   piece was not printable before - which is exactly why somebody reached for
   Thicken in the first place. So this stops at the canonical floor even when
   the wall used to be thinner than it. nso_hollow.js safeMinWall() is where
   that rule lives and this button is one call to it.

   PAINT SCOPE: WHOLE-PIECE. Both operations rebuild the piece's interior
   surfaces, and there is no painted sub-region that can be promised untouched -
   a cavity is defined by the whole outer surface, not by the faces under the
   brush. Any painted face stands the operation down, the same test and the
   same wording Thicken and Smooth use. See the scoping rule in docs/HANDOFF.md.
   ============================================================ */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function say(msg, bad) { if (typeof setStatus === 'function') setStatus(msg, !!bad); }
  function round3(x) { return (x === null || x === undefined) ? '?' : Math.round(x * 1000) / 1000; }

  function ready() {
    if (typeof NSO_Hollow === 'undefined' || !NSO_Hollow) {
      say('Hollow needs nso_hollow.js', true);
      return false;
    }
    if (typeof NSO_Thickness === 'undefined' || !NSO_Thickness) {
      say('Hollow needs nso_thickness.js - the floor comes from there, never from a literal', true);
      return false;
    }
    return true;
  }

  /* The piece's raw soup, the same way Thicken reads it. A piece that has no
     raw soup has only a display geometry, which is centred and rotated; the
     cavity would be built in the wrong frame, so it is refused by name. */
  function soupOf(m) {
    if (m && m.rawTris && m.rawAxis === 'zup' && m.rawTris.length >= 9) return m.rawTris;
    return null;
  }

  function standDown(m, what) {
    var painted = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
    if (!painted) return null;
    return what + ' stood down - ' + painted + ' painted face(s); a cavity is defined by the ' +
      'whole outer surface, so no face can be promised untouched. Clear paint to ' +
      what.toLowerCase() + '.';
  }

  function nozzleOpts() {
    /* One place to widen this if a nozzle control ever lands. Until then the
       module's own default is the answer, and it is nso_thickness.js's. */
    return {};
  }

  function run(kind) {
    if (!ready()) return null;
    var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
    if (!m) { say('Select a piece first', true); return null; }

    var label = (kind === 'fill') ? 'Fill' : 'Hollow';
    var stand = standDown(m, label);
    if (stand) { say(stand, true); return null; }

    var soup = soupOf(m);
    if (!soup) {
      say(label + ' needs a raw piece - split, wrap or boolean it first', true);
      return null;
    }

    var res;
    try {
      if (kind === 'fill') {
        res = NSO_Hollow.fill(soup, nozzleOpts());
      } else if (kind === 'safe-min') {
        /* The wall the piece has NOW is what a plain Hollow would restore, and
           it is exactly the number this mode must not blindly take. It is
           passed as `restore` so safeMinWall() can floor it, and the status
           line says which of the two won. */
        var o = nozzleOpts();
        o.mode = 'safe-min';
        o.restore = currentWall(soup);
        res = NSO_Hollow.hollow(soup, o);
      } else {
        var mm = parseFloat(($('inp-hollow-mm') || {}).value);
        var o2 = nozzleOpts();
        o2.wall = mm;
        res = NSO_Hollow.hollow(soup, o2);
      }
    } catch (e) {
      say(label + ' failed - ' + ((e && e.message) || e) + '; piece unchanged', true);
      return null;
    }

    if (!res || !res.ok) {
      say(label + ' refused - ' + ((res && res.reason) || 'piece unchanged'), true);
      return res || null;
    }

    /* Commit exactly as Soften / Smooth / Thicken / Carve commit: one raw soup
       through the shared helper, which pushes the undo entry, swaps the
       geometry, rebuilds the mesh and repaints the mask. */
    var type = (kind === 'fill') ? 'fillReplace' : 'hollowReplace';
    if (typeof NSO_sculptCommitRaw !== 'function') {
      say(label + ': could not commit the result', true);
      return res;
    }
    if (!NSO_sculptCommitRaw(m, res.soup, type, res.reason)) {
      say(label + ': could not commit the result', true);
      return res;
    }
    if (typeof updateAdjustUI === 'function') updateAdjustUI();
    return res;
  }

  /* What wall this piece already has, measured rather than remembered.

     There is no stored "what it was before Thicken" anywhere in this app - the
     undo stack holds geometry, not a wall figure - so the pre-Thicken wall has
     to come off the piece itself. The canonical checker's thinnest MEASURED
     wall is that number, and null when the piece is solid (nothing behind any
     face), which safeMinWall() reads as "no restore target, use the floor". */
  function currentWall(soup) {
    try {
      var rep = NSO_Thickness.measureMesh(soup, {});
      return (rep && typeof rep.min_mm === 'number') ? rep.min_mm : undefined;
    } catch (e) { return undefined; }
  }

  /* data-nso-wired is the repo's own marker that a listener is attached, set
     the same way app-sculpt.js and app-wheel.js set it: the drive checks read
     it instead of guessing from a click that might have been swallowed. Bound
     once, so a second wire() call cannot double-fire the handler. */
  function bind(id, kind) {
    var b = $(id);
    if (!b || b.dataset.nsoWired === '1') return;
    b.dataset.nsoWired = '1';
    b.addEventListener('click', function () { run(kind); });
  }
  function wire() {
    bind('btn-hollow', 'hollow');
    bind('btn-hollow-safe', 'safe-min');
    bind('btn-fill', 'fill');
  }

  /* Exposed for the drive checks, which run the same path the buttons run
     rather than a parallel copy of it. */
  window.nsoHollowRun = run;
  window.nsoHollowCurrentWall = currentWall;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
