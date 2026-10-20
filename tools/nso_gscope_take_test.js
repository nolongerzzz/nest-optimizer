#!/usr/bin/env node
/* G-scope's two plates, side by side - and the same (docs/GSCOPE.md, items
   1-3, 6, 9, 11).

   Both plates stand on one floor, Bambu Studio's multi-plate view: plate 1 on
   the left, plate 2 to its right, the same size, each labelled. A click on a
   plate makes it ACTIVE - its outline lit, the other's dimmed - and every
   control acts on the active plate and works identically on either: Import and
   Read plate load into it, the Features list, the slider, Select, View and
   Export act on it, CLEAR empties it. A thing pressed on one plate and dragged
   over the other is copied there, in one view: nothing flips, and the plate it
   came from never changes. There is no LENS | TAKE toggle, and no plate is
   called either.

   Every drive below is a real mouse - a click on a floor, a press on the
   isolated thing and a drag - not a call.

   GATES
     1. The view: the corner row is BACK . (frame) . CLEAR . EXPORT . CLOSE, no
        toggle and no LENS / TAKE anywhere a user reads; both floors are in the
        scene, the same size, plate 1 left of plate 2 on screen, each with its
        label; plate 1 is active (its outline lit). The framing (the corner
        button) frames both plates.
     2. Click to activate: a click on plate 2's floor makes it active - the
        outlines swap, the legend / header / badge are plate 2's, and NOTHING
        moves on screen; a click on plate 1's floor makes plate 1 active again,
        byte-identical; a drag on the other plate orbits and activates nothing.
     3. Drag across, plate 1 -> 2: five pulls - a capture-box region, a picked
        line, a layer, a legend feature (off a slice) and a whole piece (off
        the plate) - each pressed on plate 1 and let go over plate 2's bed. The
        copy (the ghost) is under the pointer on EVERY move of the drag, the
        floors do not move, after the drop plate 2 is active with one more
        piece where it was let go, and plate 1 is byte-identical.
     4. Refusals and edges: let go over the plate it came from copies nothing;
        Escape mid-drag cancels; a press that never travels is a click; a
        capture box's dots keep their press; a press on bare floor orbits.
     5. Pieces on a plate are grabbable and droppable like the main plate's
        (the same app-grab-drop): onto the bed, onto another piece (seated at
        the Seat gap), into the air; Escape puts one back.
     6. Drag the other way, plate 2 -> 1: a plate 2 piece carried over plate 1
        slides on plate 1's bed under the pointer and, let go, is copied there
        where it was let go (plate 1 a plate read: one more piece; plate 1 a
        slice: its moves join the slice); plate 2 keeps it.
     7. Import and Read plate load into the ACTIVE plate - plate 2 too - and
        leave the other plate as it was.
     8. Export acts on the active plate, the same on either: the same content on
        plate 1 and on plate 2 exports byte-identical files (Selection, as STL;
        Whole plate, as STL); Whole plate to the main plate, one Undo.
     9. CLEAR empties the ACTIVE plate and nothing else - on either plate, from a
        fresh page and mid-session; an emptied plate takes Import / Read plate;
        Shift-CLEAR is CLEAR. CLEAR on plate 1 straight after opening is the
        start-over: the next open reads the plate again.
    10. CLOSE and BACK end the visit whole: the next open is a fresh read of the
        plate (or the imported file, if one is loaded), nothing isolated,
        nothing selected, the slider at All, the default view (the framing of
        both plates), plate 2 empty. Only an imported file survives.
    11. A double-click on the view does nothing, on either plate.
    12. Watch's log docks bottom-right, under the slider's All button.

   Screenshots go to tools/gscope-take-out/ (git-ignored).

     node tools/nso_gscope_take_test.js       exit 0 = every gate held */

const path = require('path');
const fs = require('fs');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const SHOTS = path.join(ROOT, 'tools', 'gscope-take-out');
const SLICE = path.join(ROOT, 'fixtures', '3mf', 'toolpath-ground-truth.gcode.3mf');
const BOX = path.join(ROOT, 'fixtures', 'box-20mm.stl');

const frames = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
const J = JSON.stringify;

/* ------------------------------------------------------------- in the page */
const PAGE_HELPERS = `
  window.__t = (function () {
    const M = () => window.NSO_MICROSCOPE;
    const rect = () => M().getView().renderer.domElement.getBoundingClientRect();
    const toPx = (v) => {
      const p = v.clone().project(M().getView().camera), r = rect();
      return [r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height];
    };
    /* a G-code / Z-up point of the ACTIVE plate's document, as a screen pixel */
    const pxOf = (x, y, z) => { const d = M().getDoc(); return toPx(new THREE.Vector3(x - d.cx, z, -(y - d.cy))); };
    /* a point of plate n's floor, as fractions of its side from its centre (fz + is the front) */
    const floorPx = (n, fx, fz) => { const s = M().plateSide(); return toPx(new THREE.Vector3(M().plateOffset(n) + fx * s, 0, fz * s)); };
    const onCanvas = (p) => !!p && document.elementFromPoint(p[0], p[1]) === M().getView().renderer.domElement;
    return {
      state: (n) => JSON.stringify(M().plateState(n)),
      /* a plate's state without where the camera stands (a load frames the view) */
      content: (n) => { const s = M().plateState(n); if (s) delete s.camera; return JSON.stringify(s); },
      floorPx: floorPx,
      /* a point of plate n's bare floor that the canvas owns, nothing drawn over it */
      bareFloorPx: (n) => {
        const v = M().getView(), rc = new THREE.Raycaster(), r = rect();
        const roots = [v.overviewGroup, v.detailGroup, v.highlightGroup];
        for (const [fx, fz] of [[0.3, -0.3], [-0.3, -0.3], [0.3, 0.2], [-0.3, 0.2], [0.38, 0], [0, -0.38]]) {
          const p = floorPx(n, fx, fz);
          rc.setFromCamera(new THREE.Vector2((p[0] - r.left) / r.width * 2 - 1, -((p[1] - r.top) / r.height * 2 - 1)), v.camera);
          rc.params.Line.threshold = 2;
          if (onCanvas(p) && !rc.intersectObjects(roots, true).length) return p;
        }
        return null;
      },
      /* the four corners and the centre of both floors, rounded to the pixel: "nothing moved on screen" */
      floorsPx: () => ['lens', 'take'].map(n => [[0, 0], [-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(f => floorPx(n, f[0], f[1]).map(Math.round))),
      outlines: () => { const f = M().getView().floors; return ['lens', 'take'].map(n => f[n].outline.material.color.getHex()); },
      /* a selected move of the slice: its midpoint on screen */
      segPx: (pick) => {
        const sel = M().selection();
        const s = pick ? pick(sel) : sel[0];
        return pxOf((s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2, s.z);
      },
      /* the selected piece's top face, in the middle */
      selTopPx: () => { const b = M().selection()[0].bounds; return pxOf((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, b.maxZ); },
      /* a point on a plate 2 piece's own surface: its first triangle's centroid */
      piecePx: (name, tri) => {
        const o = M().getDoc().objects.find(x => x.name === name);
        const k = (tri || 0) * 9, p = o.positions;
        return pxOf((p[k] + p[k + 3] + p[k + 6]) / 3, (p[k + 1] + p[k + 4] + p[k + 7]) / 3, (p[k + 2] + p[k + 5] + p[k + 8]) / 3);
      },
      topPx: (name) => {
        const o = M().getDoc().objects.find(x => x.name === name), b = o.bounds;
        return pxOf((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, b.maxZ);
      },
      /* a point on plate 2's bed, in its own Z-up mm, as a screen pixel - whichever plate is active */
      bedPx: (x, y) => toPx(new THREE.Vector3(M().plateOffset('take') + x, 0, -y)),
      /* a canvas pixel whose ray meets neither floor nor any piece */
      airPx: () => {
        const v = M().getView(), r = rect(), rc = new THREE.Raycaster(), s = M().plateSide();
        const meshes = Object.keys(v.overviewMeshes).map(k => v.overviewMeshes[k]);
        for (let fy = 0.06; fy < 0.5; fy += 0.03) for (let fx = 0.35; fx < 0.9; fx += 0.03) {
          const x = r.left + fx * r.width, y = r.top + fy * r.height;
          rc.setFromCamera(new THREE.Vector2(fx * 2 - 1, -(fy * 2 - 1)), v.camera);
          const b = new THREE.Vector3();
          const hit = rc.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), b);
          const onFloor = hit && ['lens', 'take'].some(n => Math.abs(b.x - M().plateOffset(n)) <= s / 2 + 2 && b.z >= -s / 2 - 2 && b.z <= s / 2 + 16);
          if (!onFloor && !rc.intersectObjects(meshes, false).length && onCanvas([x, y])) return [x, y];
        }
        return null;
      },
      /* a canvas pixel over nothing at all: no piece, no line, no floor */
      emptyPx: () => {
        const v = M().getView(), r = rect(), rc = new THREE.Raycaster(), s = M().plateSide();
        rc.params.Line.threshold = 2;
        const roots = [v.overviewGroup, v.detailGroup, v.highlightGroup];
        for (let fy = 0.1; fy < 0.6; fy += 0.03) for (let fx = 0.3; fx < 0.9; fx += 0.03) {
          const x = r.left + fx * r.width, y = r.top + fy * r.height;
          rc.setFromCamera(new THREE.Vector2(fx * 2 - 1, -(fy * 2 - 1)), v.camera);
          const b = new THREE.Vector3();
          const hit = rc.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), b);
          const onFloor = hit && ['lens', 'take'].some(n => Math.abs(b.x - M().plateOffset(n)) <= s / 2 + 2 && b.z >= -s / 2 - 2 && b.z <= s / 2 + 16);
          if (!onFloor && !rc.intersectObjects(roots, true).length && onCanvas([x, y])) return [x, y];
        }
        return null;
      },
      camera: () => { const v = M().getView(); return v.camera.position.toArray().concat(v.controls.target.toArray()).map(x => +x.toFixed(3)); },
      /* what a drag carries right now - the ghost of a copy, or the piece grabbed - as a screen rectangle; and is (x, y) in it? */
      carried: (x, y) => {
        const v = M().getView(), g = window.nsoGrab && nsoGrab.active() && nsoGrab.world();
        if (!g) return { on: false };
        let m = v.scene.getObjectByName('gscopeGhost');
        const ghost = !!m;
        if (!m && window.__grabbedName) m = v.overviewMeshes[window.__grabbedName];
        if (!m || !m.parent) return { on: false, ghost };
        m.updateMatrixWorld(true);
        const b = new THREE.Box3().setFromObject(m), r = rect();
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const cx of [b.min.x, b.max.x]) for (const cy of [b.min.y, b.max.y]) for (const cz of [b.min.z, b.max.z]) {
          const p = toPx(new THREE.Vector3(cx, cy, cz));
          x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
        }
        const pad = 6;
        return { on: true, ghost, under: x >= x0 - pad && x <= x1 + pad && y >= y0 - pad && y <= y1 + pad,
                 box: [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].map(q => +q.toFixed(3)) };
      },
      /* a plate's piece (by name) as a world box, rounded */
      pieceBox: (name) => {
        const m = M().getView().overviewMeshes[name];
        if (!m) return null;
        m.updateMatrixWorld(true);
        const b = new THREE.Box3().setFromObject(m);
        return [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].map(q => +q.toFixed(3));
      },
      pieces: () => M().takePieces(),
      status: () => document.getElementById('status').textContent
    };
  })();
  window.__dl = [];
  (function () {
    const orig = window.downloadBlob;
    window.downloadBlob = function (blob, name) { window.__dl.push({ name: name, size: blob.size, blob: blob }); };
    window.__dlRestore = function () { window.downloadBlob = orig; };
  })();
`;

const plate = page => page.evaluate(() => NSO_MICROSCOPE.plate());
const lensState = page => page.evaluate(() => window.__t.state('lens'));
const takeN = page => page.evaluate(() => NSO_MICROSCOPE.takePieces().length);
const T = (page, fn, arg) => page.evaluate(fn, arg);

/* a real press-and-drag; leaves the button DOWN when `hold` */
async function drag(page, from, to, hold) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, { steps: 4 });
  await page.mouse.move(to[0], to[1], { steps: 5 });
  if (!hold) await page.mouse.up();
  await frames(page);
}

/* A press and `n` single moves to `to`, the carried thing looked at after every
   one: { carried: moves it was there and under the pointer, of the moves past
   the slop; frames: the moves; last: its world box on the last move }. The
   button is left DOWN. */
async function driveDrag(page, from, to, n) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  let seen = 0, live = 0, last = null, misses = [];
  for (let i = 1; i <= n; i++) {
    const x = from[0] + (to[0] - from[0]) * i / n, y = from[1] + (to[1] - from[1]) * i / n;
    await page.mouse.move(x, y);
    if (Math.hypot(x - from[0], y - from[1]) < 4) continue;     // inside the slop: nothing is carried yet
    live++;
    const c = await page.evaluate(([x, y]) => window.__t.carried(x, y), [x, y]);
    if (c.on && c.under) seen++; else misses.push(i);
    if (c.on) last = c.box;
  }
  return { carried: seen, moves: live, last, misses };
}

/* a real click on a plate's bare floor */
async function clickPlate(page, n) {
  const p = await T(page, n => window.__t.bareFloorPx(n), n);
  if (!p) return false;
  await page.mouse.click(p[0], p[1]);
  await frames(page);
  return (await page.evaluate(() => NSO_MICROSCOPE.plate())) === n;
}

/* Import through the Import button's own file input - emptied first, as the
   button empties it, so the same file picked again is a change */
async function importFile(page, file) {
  await page.evaluate(() => { document.getElementById('ms-input').value = ''; });
  await page.setInputFiles('#ms-input', file);
}

/* plate 1 active, by a click on its floor (the real way) */
async function activateLens(page) {
  if (await plate(page) !== 'lens') await clickPlate(page, 'lens');
}

/* What the panel says, anywhere a user reads it: visible text and titles. */
const panelWords = page => page.evaluate(() => {
  const p = document.getElementById('microscope'), out = [];
  p.querySelectorAll('*').forEach(e => {
    if (e.title) out.push(e.title);
    if (e.children.length === 0 && e.textContent) out.push(e.textContent);
  });
  out.push(document.getElementById('status').textContent);
  return out.join(' | ');
});

/* The clean state every open must start from. */
async function freshness(page) {
  return page.evaluate(() => {
    const M = NSO_MICROSCOPE, s = M.plateState('lens'), d = M.lensDoc(), z = M.zRange();
    return { open: M.isOpen(), plate: M.plate(), doc: d && d.name, source: d && (d.source || null), isolated: s.isolated, sel: s.selection.length,
             boxes: s.boxes.length, cleared: s.cleared.length, hidden: s.hidden.length, featuresOff: s.featuresOff,
             zrAll: !!s.zr && s.zr[0] === 0 && s.zr[1] === s.zr[2] - 1, zr: s.zr, mode: s.mode, render: M.renderMode(),
             take: M.takePieces().length, takeState: M.plateState('take') && M.plateState('take').selection.length,
             detail: M.getView().detailGroup.visible, card: !!document.querySelector('#microscope .ms-card.is-open'),
             zrUI: z && z.full };
  });
}
const isFresh = f => f.open && f.plate === 'lens' && !f.isolated && f.sel === 0 && f.boxes === 0 && f.cleared === 0 && f.hidden === 0 &&
  J(f.featuresOff) === J(['Travel']) && f.zrAll && f.mode === 'piece' && f.render === 'toolpath' && f.take === 0 && !f.detail && !f.card;

/* the camera is the default view: what the framing gives on this very page */
async function defaultView(page) {
  const cam = await T(page, () => window.__t.camera());
  await page.evaluate(() => NSO_MICROSCOPE.frame());
  const framed = await T(page, () => window.__t.camera());
  return { same: cam.every((x, i) => Math.abs(x - framed[i]) < 1e-2), cam, framed };
}

/* One whole pull: pressed on plate 1's selection, let go over plate 2. */
async function pull(page, label, select, pickPx, to) {
  await activateLens(page);
  await page.evaluate(select);
  await page.evaluate(() => NSO_MICROSCOPE.flushView());
  await frames(page);
  const before = await lensState(page);
  const n0 = await takeN(page);
  const floors0 = await T(page, () => window.__t.floorsPx());
  const from = await page.evaluate(pickPx);
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(from[0] + 25, from[1] + 18, { steps: 4 });
  const held = await page.evaluate(() => ({ grab: nsoGrab.active(), live: nsoGrab.live(), world: nsoGrab.world() && nsoGrab.world().name, floors: window.__t.floorsPx(),
                                            n: NSO_MICROSCOPE.takePieces().length }));
  check(label + ': held, the copy (the ghost) is in hand, plate 2 not changed yet - and nothing moved on screen (no view flip)',
    held.grab && held.live && held.world === 'ghost' && held.n === n0 && J(held.floors) === J(floors0), J({ grab: held.grab, live: held.live, world: held.world, n: held.n, moved: J(held.floors) !== J(floors0) }));
  // the rest of the way, one move at a time: the ghost under the pointer on every one
  const at = [from[0] + 25, from[1] + 18];
  let under = 0, last = null;
  for (let i = 1; i <= 12; i++) {
    const x = at[0] + (to[0] - at[0]) * i / 12, y = at[1] + (to[1] - at[1]) * i / 12;
    await page.mouse.move(x, y);
    const c = await page.evaluate(([x, y]) => window.__t.carried(x, y), [x, y]);
    if (c.on && c.ghost && c.under) under++;
    if (c.on) last = c.box;
  }
  check(label + ': the ghost is under the pointer on every move of the drag', under === 12, under + '/12');
  await page.mouse.up();
  await frames(page);
  const after = await page.evaluate(() => ({ plate: NSO_MICROSCOPE.plate(), n: NSO_MICROSCOPE.takePieces().length, grab: nsoGrab.active(), floors: window.__t.floorsPx(), out: window.__t.outlines() }));
  check(label + ': let go over plate 2 - one more piece there, plate 2 active (its outline lit), the floors where they were',
    after.plate === 'take' && after.n === n0 + 1 && !after.grab && J(after.floors) === J(floors0) && after.out[1] !== after.out[0], J({ plate: after.plate, n: after.n, n0 }));
  const landed = await page.evaluate(() => { const ps = NSO_MICROSCOPE.takePieces(); return window.__t.pieceBox(ps[ps.length - 1].name); });
  check(label + ': it landed exactly where it was let go - no jump on release', !!landed && !!last && landed.every((v, i) => Math.abs(v - last[i]) < 1e-3), J({ last, landed }));
  const lens = await lensState(page);
  check(label + ': plate 1 is byte-identical', lens === before, lens === before ? JSON.parse(lens).coords + ' coordinates, selection ' + J(JSON.parse(lens).selection).slice(0, 40) : 'before ' + before + '\n after ' + lens);
  return after;
}

withApp(async (page, logs) => {
  page.on('pageerror', e => console.log('[pageerror stack] ' + (e.stack || e.message).split('\n').slice(0, 6).join(' <- ')));
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(PAGE_HELPERS);
  const shot = name => page.screenshot({ path: path.join(SHOTS, name + '.png') });
  const bytes = Array.from(fs.readFileSync(SLICE));
  await loadSTL(page, BOX);
  await page.waitForTimeout(300);
  const placedAtStart = await page.evaluate(() => state.placed.length);

  /* ------------------------------------------------------------------ 7a */
  console.log('\n=== 7a. CLEAR from a fresh page ===');
  {
    await page.click('#btn-microscope');
    await page.waitForFunction(() => NSO_MICROSCOPE.isOpen() && NSO_MICROSCOPE.getDoc(), null, { timeout: 30000 });
    await frames(page);
    await page.click('#ms-btn-take-clear');
    await frames(page);
    const f = await page.evaluate(() => ({ open: NSO_MICROSCOPE.isOpen(), plate: NSO_MICROSCOPE.plate(), lens: NSO_MICROSCOPE.plateDoc('lens'), take: NSO_MICROSCOPE.plateDoc('take'),
                                           st: window.__t.status(), sub: document.getElementById('ms-sub').textContent }));
    check('CLEAR straight after opening: the start-over - plate 1 (the plate read) empty and active, plate 2 empty, G-scope open',
      f.open && f.plate === 'lens' && f.lens === null && f.take === null && /Plate 1 cleared/.test(f.st) && /^Plate 1 - empty/.test(f.sub), J(f));
    await page.click('#ms-btn-plate');
    await page.waitForFunction(() => NSO_MICROSCOPE.lensDoc() && NSO_MICROSCOPE.lensDoc().source === 'plate', null, { timeout: 30000 });
    await frames(page);
    check('...and Read plate fills it again: a fresh read, nothing kept', isFresh(await freshness(page)));
    check('...and no page error so far', logs.filter(l => /^\[pageerror\]/.test(l)).length === 0, logs.filter(l => /^\[pageerror\]/.test(l)).slice(0, 2).join(' | '));
    await page.evaluate(() => NSO_MICROSCOPE.close());
  }

  /* The slice goes in through the app's own door: plate 1 is an import. */
  await page.evaluate(([b, n]) => NSO_MICROSCOPE.openFile(n, new Uint8Array(b).buffer), [bytes, 'gt.gcode.3mf']);
  await page.waitForFunction(() => NSO_MICROSCOPE.getDoc() && NSO_MICROSCOPE.getDoc().kind === 'toolpath', null, { timeout: 30000 });
  await frames(page);

  /* ------------------------------------------------------------------ 1 */
  console.log('\n=== 1. two plates, side by side, no toggle ===');
  {
    const r = await page.evaluate(() => {
      const c = document.getElementById('ms-corner'), M = NSO_MICROSCOPE, v = M.getView();
      const f = v.floors, s = M.plateSide();
      return { kids: Array.from(c.children).map(e => e.id), text: Array.from(c.children).map(e => e.textContent.trim().toUpperCase()),
               toggle: !!document.getElementById('ms-plate-toggle') || !!document.getElementById('ms-plate-lens') || !!document.getElementById('ms-plate-take'),
               floors: f && ['lens', 'take'].map(n => ({ inScene: f[n].group.parent === v.scene, side: f[n].side, label: !!f[n].label, x: f[n].group.position.x })),
               side: s, off: [M.plateOffset('lens'), M.plateOffset('take')], plate: M.plate(), take: M.takePieces().length,
               left: window.__t.floorPx('lens', 0, 0)[0], right: window.__t.floorPx('take', 0, 0)[0], out: window.__t.outlines() };
    });
    check('the corner row is BACK . (frame) . CLEAR . EXPORT . CLOSE - no LENS | TAKE toggle', J(r.kids) === J(['ms-btn-back-producer', 'ms-btn-frame', 'ms-btn-take-clear', 'ms-nav-export', 'ms-close']) &&
      r.text[0] === 'BACK' && J(r.text.slice(2)) === J(['CLEAR', 'EXPORT', 'CLOSE']) && !r.toggle, J(r.text));
    check('both floors are in the scene, the same size, each with its label', r.floors && r.floors.every(f => f.inScene && f.side === r.side && f.label), J(r.floors));
    check('plate 1 stands left of plate 2, a plate and a gap apart', r.left < r.right && r.off[1] - r.off[0] > r.side, J([r.left, r.right, r.off]));
    check('plate 1 is active, its outline lit and plate 2\'s dimmed; plate 2 is empty', r.plate === 'lens' && r.out[0] !== r.out[1] && r.take === 0, J(r.out));
    const words = await panelWords(page);
    // the plates' old names, as names: LENS / TAKE in capitals, or "Lens" (the toggle's label) - "take" is still an English verb
    const NAMES = /\b(LENS|TAKE)\b|\bLens\b|\bthe Take\b|\bonto Take\b/;
    check('no LENS or TAKE anywhere the user reads', !NAMES.test(words), (words.match(new RegExp('.{0,30}(' + NAMES.source + ').{0,30}')) || [''])[0]);
    // the framing: both plates fill the view
    await page.click('#ms-btn-frame');
    await frames(page);
    const fr = await page.evaluate(() => {
      const r = NSO_MICROSCOPE.getView().renderer.domElement.getBoundingClientRect();
      const pts = ['lens', 'take'].map(n => [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(f => window.__t.floorPx(n, f[0], f[1]))).flat();
      return { inside: pts.every(p => p[0] >= r.left && p[0] <= r.right && p[1] >= r.top && p[1] <= r.bottom), w: Math.max(...pts.map(p => p[0])) - Math.min(...pts.map(p => p[0])), W: r.width };
    });
    check('the framing (corner button) frames both plates: every corner of both floors in view, and they span most of it', fr.inside && fr.w > fr.W * 0.45, J(fr));
    await shot('01-two-plates');
  }

  /* ------------------------------------------------------------------ 2 */
  console.log('\n=== 2. click a plate to make it active ===');
  {
    const before = await lensState(page);
    const floors0 = await T(page, () => window.__t.floorsPx());
    check('plate 2\'s floor is clickable bare floor', await clickPlate(page, 'take'));
    const t = await page.evaluate(() => ({ plate: NSO_MICROSCOPE.plate(), rows: document.querySelectorAll('#ms-legend .ms-legend-item').length,
      sub: document.getElementById('ms-sub').textContent, info: document.getElementById('ms-info').textContent, zr: document.getElementById('ms-zr').hidden,
      badge: document.getElementById('ms-mode-badge').textContent, out: window.__t.outlines(), floors: window.__t.floorsPx(), st: window.__t.status() }));
    check('a click on plate 2: it is active - its outline lit, plate 1\'s dimmed', t.plate === 'take' && t.out[1] !== t.out[0], J(t.out));
    check('...and the Features list, the header, the info and the slider are plate 2\'s (empty)', t.rows === 0 && /^Plate 2/.test(t.sub) && /Plate 2 is empty/.test(t.info) && t.zr && /Plate 2: empty/.test(t.badge), J({ sub: t.sub.slice(0, 30), info: t.info.slice(0, 40), badge: t.badge }));
    check('...and nothing moved on screen: both floors where they were', J(t.floors) === J(floors0));
    await shot('02-plate2-active');
    await clickPlate(page, 'lens');
    check('a click on plate 1\'s floor: plate 1 active again, byte-identical', await plate(page) === 'lens' && await lensState(page) === before && J(await T(page, () => window.__t.floorsPx())) === J(floors0));
    // a drag on the other plate orbits and activates nothing
    const p2 = await T(page, () => window.__t.bareFloorPx('take'));
    const cam0 = await T(page, () => window.__t.camera());
    await drag(page, p2, [p2[0] - 60, p2[1] - 20]);
    check('a drag that starts on plate 2 orbits, and plate 1 stays active', await plate(page) === 'lens' && J(await T(page, () => window.__t.camera())) !== J(cam0));
    await page.click('#ms-btn-frame');
    await frames(page);
  }

  /* ------------------------------------------------------------------ 3 */
  console.log('\n=== 3. drag across: five copies ===');
  const toBed = [[-26, -22], [-6, -22], [14, -22], [-26, 0], [-6, 0]];
  const dest = [];
  for (const [x, y] of toBed) dest.push(await T(page, ([x, y]) => window.__t.bedPx(x, y), [x, y]));
  // a. a capture-box region
  await pull(page, 'region (capture box)',
    () => { const M = NSO_MICROSCOPE; M.setMode('orbit'); M.clearBoxes(); M.addBoxAt(20, 10, 0.4, 6, 0.15); },
    () => window.__t.segPx(), dest[0]);
  // b. a picked line
  await pull(page, 'line (picked)',
    () => { const M = NSO_MICROSCOPE; M.clearBoxes(); const s = M.getDoc().segments.find(g => g.feature === 'Outer wall' && g.layer === 1); M.pickLine(s.mv.index); },
    () => window.__t.segPx(), dest[1]);
  // c. a layer
  await pull(page, 'layer',
    () => { const M = NSO_MICROSCOPE; M.clearBoxes(); M.selectLayer(2); },
    () => window.__t.segPx(sel => sel.find(s => s.feature === 'Outer wall') || sel[0]), dest[2]);
  // d. a feature from the legend
  await pull(page, 'feature (legend "only")',
    () => { const M = NSO_MICROSCOPE; M.clearBoxes(); M.showAll(); M.soloGroup('Support'); },
    () => window.__t.segPx(sel => sel.find(s => s.feature === 'Support')), dest[3]);
  // e. a whole piece: plate 1 is the plate, read with READ PLATE
  await activateLens(page);
  await page.evaluate(() => NSO_MICROSCOPE.showAll());
  await page.click('#ms-btn-plate');
  await page.waitForFunction(() => NSO_MICROSCOPE.lensDoc() && NSO_MICROSCOPE.lensDoc().source === 'plate', null, { timeout: 30000 });
  await frames(page);
  const destE = await T(page, () => window.__t.bedPx(-6, 0));
  await pull(page, 'piece (whole)',
    () => { const M = NSO_MICROSCOPE; M.clearBoxes(); M.selectObjects([M.getDoc().objects[0].name], 'pick'); },
    () => window.__t.selTopPx(), destE);
  {
    const names = await page.evaluate(() => NSO_MICROSCOPE.takePieces().map(p => p.name));
    check('plate 2 has five pieces, each its own copy', names.length === 5 && new Set(names).size === 5, J(names));
    const hd = await page.evaluate(() => ({ sub: document.getElementById('ms-sub').textContent, rows: document.querySelectorAll('#ms-legend .ms-legend-item').length, zr: !document.getElementById('ms-zr').hidden }));
    check('plate 2 active: the header, the Features list and the slider read plate 2', /^Plate 2 - 5 pieces/.test(hd.sub) && hd.rows >= 3 && hd.zr, J(hd));
    await shot('03-five-copies');
  }

  /* ------------------------------------------------------------------ 4 */
  console.log('\n=== 4. let go over plate 1, Escape, a click, the box dots, the orbit ===');
  {
    await activateLens(page);
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.setMode('orbit'); M.clearBoxes(); M.selectObjects([M.getDoc().objects[0].name], 'pick'); });
    await frames(page);
    const before = await lensState(page), n0 = await takeN(page);
    const from = await T(page, () => window.__t.selTopPx());
    // let go back over plate 1: nothing copied
    const back1 = await T(page, () => window.__t.bareFloorPx('lens'));
    await drag(page, from, back1);
    const r1 = await page.evaluate(() => ({ plate: NSO_MICROSCOPE.plate(), n: NSO_MICROSCOPE.takePieces().length, grab: nsoGrab.active(), st: window.__t.status() }));
    check('pressed on plate 1 and let go over plate 1: nothing copied, plate 1 active', r1.plate === 'lens' && r1.n === n0 && !r1.grab && /nothing copied/.test(r1.st), J(r1));
    check('...and plate 1 is byte-identical', await lensState(page) === before);
    // Escape mid-drag
    await page.mouse.move(from[0], from[1]);
    await page.mouse.down();
    await page.mouse.move(from[0] + 40, from[1] + 30, { steps: 5 });
    const mid = await page.evaluate(() => ({ n: NSO_MICROSCOPE.takePieces().length, live: nsoGrab.live(), ghost: !!NSO_MICROSCOPE.getView().scene.getObjectByName('gscopeGhost') }));
    check('mid-drag: the copy is in hand - the ghost - and plate 2 is not changed yet', mid.live && mid.ghost && mid.n === n0, J(mid));
    await page.keyboard.press('Escape');
    await frames(page);
    const esc = await page.evaluate(() => ({ plate: NSO_MICROSCOPE.plate(), n: NSO_MICROSCOPE.takePieces().length, grab: nsoGrab.active(), open: NSO_MICROSCOPE.isOpen() }));
    check('Escape mid-drag: cancelled, plate 1 active, nothing kept, the ghost gone, G-scope still open', esc.plate === 'lens' && esc.n === n0 && !esc.grab && esc.open &&
      await page.evaluate(() => !NSO_MICROSCOPE.getView().scene.getObjectByName('gscopeGhost')), J(esc));
    await page.mouse.move(from[0] + 80, from[1] + 50, { steps: 3 });
    await page.mouse.up();
    await frames(page);
    check('...and letting go afterwards does nothing more; plate 1 byte-identical', await plate(page) === 'lens' && await takeN(page) === n0 && await lensState(page) === before);
    // a press that never travels is a click
    await page.mouse.click(from[0], from[1]);
    await frames(page);
    check('a press that does not travel copies nothing - it is a click, and isolates', await plate(page) === 'lens' && await takeN(page) === n0 &&
      await page.evaluate(() => NSO_MICROSCOPE.getView().detailGroup.visible));
    await page.keyboard.press('Escape');
    await frames(page);
    check('...and Escape makes it whole again', await page.evaluate(() => !NSO_MICROSCOPE.getView().detailGroup.visible && NSO_MICROSCOPE.isOpen()));
    // a press on empty space orbits
    const empty = await T(page, () => window.__t.emptyPx());
    const cam0 = await T(page, () => window.__t.camera());
    await drag(page, empty, [empty[0] - 80, empty[1] - 30]);
    check('a press on empty space orbits, and copies nothing', J(await T(page, () => window.__t.camera())) !== J(cam0) && await plate(page) === 'lens' && await takeN(page) === n0);
    await page.click('#ms-btn-frame');
    await frames(page);
    // a capture box's dots keep their press
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.setMode('select'); M.clearBoxes(); const b = M.getDoc().objects[0].bounds;
      M.addBoxAt((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2, 14, 14); });
    const dot = await page.evaluate(() => {
      const M = NSO_MICROSCOPE, v = M.getView(), r = v.renderer.domElement.getBoundingClientRect();
      const bx = M.boxes()[0], p = M.toView(bx.gx, bx.gy, bx.gz).project(v.camera);
      return { px: [r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height], at: [bx.gx, bx.gy, bx.gz] };
    });
    await drag(page, dot.px, [dot.px[0] + 30, dot.px[1] + 12]);
    const moved = await page.evaluate(() => ({ plate: NSO_MICROSCOPE.plate(), at: (b => [b.gx, b.gy, b.gz])(NSO_MICROSCOPE.boxes()[0]), n: NSO_MICROSCOPE.takePieces().length }));
    const dist = Math.hypot(moved.at[0] - dot.at[0], moved.at[1] - dot.at[1], moved.at[2] - dot.at[2]);
    check('pressing the box\'s centre dot moves the box - it does not copy', moved.plate === 'lens' && dist > 2 && moved.n === n0, J(moved) + ' moved ' + dist.toFixed(1) + ' mm');
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.clearBoxes(); M.setMode('orbit'); });
  }

  /* ------------------------------------------------------------------ 5 */
  console.log('\n=== 5. pieces on plate 2: grab and drop ===');
  let layerPiece, boxPiece;
  {
    await clickPlate(page, 'take');
    await page.evaluate(() => { NSO_MICROSCOPE.showAll(); NSO_MICROSCOPE.setMode('orbit'); NSO_MICROSCOPE.clearBoxes(); });
    const names = await page.evaluate(() => NSO_MICROSCOPE.takePieces().map(p => p.name));
    boxPiece = names[4]; layerPiece = names[2];
    const info = n => page.evaluate(n => { const p = NSO_MICROSCOPE.takePieces().find(x => x.name === n); return p ? { b: p.bounds, tri: p.triangles } : null; }, n);
    const b0 = (await info(layerPiece)).b;
    await drag(page, await T(page, n => window.__t.piecePx(n, 0), layerPiece), await T(page, () => window.__t.bedPx(30, 30)), true);
    const live = await page.evaluate(() => ({ g: nsoGrab.active(), mode: nsoGrab.mode(), w: nsoGrab.world() && nsoGrab.world().name, st: window.__t.status() }));
    check('pressed on a plate 2 piece and carried: the main plate\'s grab, the piece world', live.g && live.w === 'piece' && live.mode === 'plate' && /Over the plate - let go to set/.test(live.st), J(live));
    await page.mouse.up();
    await frames(page);
    const b1 = (await info(layerPiece)).b;
    const st = await page.evaluate(() => ({ s: window.__t.status(), p: NSO_MICROSCOPE.plate(), sel: NSO_MICROSCOPE.selection().map(o => o.name) }));
    check('let go over the bed: set down there (lowest point 0), selected, plate 2 still active', Math.abs(b1.minZ) < 1e-3 && (Math.abs(b1.minX - b0.minX) > 5 || Math.abs(b1.minY - b0.minY) > 5) &&
      /set down on plate 2/.test(st.s) && st.p === 'take' && st.sel.length === 1 && st.sel[0] === layerPiece, J([b1.minX, b1.minY, b1.minZ, st.s.slice(0, 50)]));
    // onto another piece: seated at the Seat gap
    const gap = await page.evaluate(() => readSeatGapInput());
    await drag(page, await T(page, n => window.__t.piecePx(n, 0), layerPiece), await T(page, n => window.__t.topPx(n), boxPiece), true);
    const over = await page.evaluate(() => ({ mode: nsoGrab.mode(), over: nsoGrab.over(), st: window.__t.status() }));
    check('over another piece: "let go to seat"', over.mode === 'piece' && over.over === boxPiece && /let go to seat/.test(over.st), J(over));
    await page.mouse.up();
    await frames(page);
    const b2 = (await info(layerPiece)).b, tb = (await info(boxPiece)).b;
    check('let go: seated onto it at the Seat gap', /Dropped onto .* seated/.test(await T(page, () => window.__t.status())) && Math.abs(b2.minZ - (tb.maxZ - gap)) < 0.05, J([b2.minZ, tb.maxZ, gap]));
    // into the air
    const air = await T(page, () => window.__t.airPx());
    check('there is a patch of canvas over nothing', !!air);
    await drag(page, await T(page, n => window.__t.piecePx(n, 0), layerPiece), air, true);
    check('over nothing: "let go to leave it in the air"', await page.evaluate(() => nsoGrab.mode() === 'air' && /in the air where it is/.test(window.__t.status())));
    await page.mouse.up();
    await frames(page);
    const b3 = (await info(layerPiece)).b;
    check('let go: left in the air', b3.minZ > 1 && /left in the air/.test(await T(page, () => window.__t.status())), 'minZ ' + b3.minZ.toFixed(2));
    await drag(page, await T(page, n => window.__t.piecePx(n, 0), layerPiece), await T(page, () => window.__t.bedPx(30, -30)));
    const b4 = (await info(layerPiece)).b;
    check('still grabbable, and comes down on the bed', Math.abs(b4.minZ) < 1e-3, 'minZ ' + b4.minZ);
    // Escape puts it back
    await drag(page, await T(page, n => window.__t.piecePx(n, 0), layerPiece), await T(page, () => window.__t.bedPx(-30, 30)), true);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await frames(page);
    check('Escape mid-drag: put back exactly, plate 2 still active', J((await info(layerPiece)).b) === J(b4) && await plate(page) === 'take');
    check('each pull was a copy: plate 1 and the main plate are as they were',
      await page.evaluate(() => NSO_MICROSCOPE.lensDoc().objects.length === 1 && state.placed.length) === placedAtStart);
    await shot('05-moved');
  }

  /* ------------------------------------------------------------------ 6 */
  console.log('\n=== 6. the other way: a plate 2 piece dragged onto plate 1 ===');
  {
    await page.evaluate(() => { NSO_MICROSCOPE.setMode('orbit'); NSO_MICROSCOPE.clearBoxes(); });
    const nm = boxPiece;
    const lens0 = await page.evaluate(() => NSO_MICROSCOPE.plateDoc('lens').objects.length);
    const b0 = await T(page, n => NSO_MICROSCOPE.takePieces().find(p => p.name === n).bounds, nm);
    await page.evaluate(n => { window.__grabbedName = n; }, nm);
    const from = await T(page, n => window.__t.piecePx(n, 0), nm);
    const to = await T(page, () => window.__t.floorPx('lens', 0.3, 0.3));
    const dd = await driveDrag(page, from, to, 16);
    const ov = await page.evaluate(() => ({ mode: nsoGrab.mode(), st: window.__t.status() }));
    check('a plate 2 piece carried over plate 1 slides on plate 1\'s bed, under the pointer on every move', dd.carried === dd.moves && ov.mode === 'plate' &&
      /Over plate 1 - let go to copy/.test(ov.st), J({ carried: dd.carried, moves: dd.moves, misses: dd.misses, mode: ov.mode, st: ov.st.slice(0, 60) }));
    const spacing = await page.evaluate(() => -NSO_MICROSCOPE.plateOffset('lens'));     // plate 2 is active: plate 1 stands one spacing left
    await page.mouse.up();
    await frames(page);
    await page.evaluate(() => { window.__grabbedName = null; });
    const after = await page.evaluate(() => { const d = NSO_MICROSCOPE.plateDoc('lens'), o = d.objects[d.objects.length - 1];
      return { plate: NSO_MICROSCOPE.plate(), n: d.objects.length, name: o.name, box: window.__t.pieceBox(o.name), st: window.__t.status() }; });
    check('let go over plate 1: copied there - one more piece on plate 1 (a plate read), plate 1 active', after.plate === 'lens' && after.n === lens0 + 1 && /copied onto plate 1/.test(after.st), J(after));
    // the carried box was in plate 2's frame; plate 1 is at the origin now, one spacing to the right
    const want = dd.last && dd.last.map((v, i) => i % 3 === 0 ? v + spacing : v);
    check('...where it was let go - no jump on release', !!want && after.box.every((v, i) => Math.abs(v - want[i]) < 1e-3), J({ want, got: after.box }));
    const b1 = await page.evaluate(n => { const d = NSO_MICROSCOPE.plateDoc('take'); return d.objects.find(o => o.name === n).bounds; }, nm);
    check('...and plate 2 keeps it, where it was', J(b0) === J(b1));
    await shot('06-copied-back');
  }

  /* ------------------------------------------------------------------ 6b */
  console.log('\n=== 6b. Export acts on the active plate ===');
  {
    await clickPlate(page, 'take');
    const sliced = await page.evaluate(() => NSO_MICROSCOPE.takePieces().filter(p => p.moves > 0).map(p => p.name));
    check('the pieces copied off the slice kept their beads; the plate piece did not', sliced.length === 4, J(sliced));
    await page.evaluate(n => NSO_MICROSCOPE.selectObjects([n], 'pick'), sliced[0]);
    await page.click('#ms-nav-export');
    const g = await page.evaluate(() => Array.from(document.querySelectorAll('#ms-card-export .ms-xgroup')).map(x => ({
      t: x.querySelector('.ms-section-title').textContent.trim(), shown: getComputedStyle(x).display !== 'none' && x.getBoundingClientRect().height > 0,
      btns: Array.from(x.querySelectorAll('button')).filter(b => b.getBoundingClientRect().width > 0).map(b => b.id) })));
    check('plate 2 active: Export is "Selected piece" (lines and solid) and "Whole plate"', g[0].t === 'Selected piece' && g[0].shown && g[0].btns.length === 4 && !g[1].shown && g[2].t === 'Whole plate' && g[2].shown && g[2].btns.length === 2, J(g));
    await page.click('#ms-nav-export');
    await page.evaluate(() => { window.__dl.length = 0; });
    const tris = await page.evaluate(n => NSO_MICROSCOPE.takePieces().find(p => p.name === n).triangles, sliced[0]);
    await page.click('#ms-btn-export-stl');
    const dl1 = await page.evaluate(() => window.__dl.map(d => [d.name, d.size]));
    check('Selected piece as STL (lines): its prisms', dl1.length === 1 && dl1[0][1] === 84 + tris * 50, J(dl1) + ' ' + tris + ' tris');
    await page.click('#ms-btn-export-solid-stl');
    await page.waitForFunction(() => window.__dl.length === 2, null, { timeout: 60000 });
    const dl2 = await page.evaluate(() => window.__dl.map(d => [d.name, d.size]));
    check('Selected piece as STL (solid): the swept shells', /solid/.test(dl2[1][0]) && dl2[1][1] > 84 && dl2[1][1] !== dl1[0][1], J(dl2));
    await page.evaluate(() => { window.__dl.length = 0; });
    await page.click('#ms-btn-take-export-stl');
    const wd = await page.evaluate(() => ({ dl: window.__dl.map(d => [d.name, d.size]), tri: NSO_MICROSCOPE.takePieces().reduce((a, p) => a + p.triangles, 0) }));
    check('Whole plate as STL: one file, every piece of plate 2', wd.dl.length === 1 && wd.dl[0][0] === 'Plate_2.stl' && wd.dl[0][1] === 84 + wd.tri * 50, J(wd));
    // plate 1 active: the Selection, as always
    await clickPlate(page, 'lens');
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.selectObjects([M.getDoc().objects[0].name], 'pick'); });
    if (!(await page.evaluate(() => document.getElementById('ms-card-export').classList.contains('is-open')))) await page.click('#ms-nav-export');
    const lg = await page.evaluate(() => Array.from(document.querySelectorAll('#ms-card-export .ms-xgroup')).map(x => ({
      t: x.querySelector('.ms-section-title').textContent.trim(), shown: getComputedStyle(x).display !== 'none' && x.getBoundingClientRect().height > 0 })));
    check('plate 1 active (a plate read): Export is the Selection, and "Whole plate" - its pieces', lg[0].t === 'Selection' && lg[0].shown && lg[2].shown, J(lg));
    await page.click('#ms-nav-export');
    await page.evaluate(() => { window.__dl.length = 0; });
    await page.click('#ms-btn-export-stl');
    const dl3 = await page.evaluate(() => window.__dl.map(d => [d.name, d.size]));
    check('...and it writes plate 1\'s selection (the box, 12 triangles)', dl3.length === 1 && dl3[0][1] === 84 + 12 * 50, J(dl3));
    // the whole of plate 2 onto the main plate: five pieces, one Undo, G-scope closes
    await clickPlate(page, 'take');
    const before = await page.evaluate(() => ({ placed: state.placed.length, undo: state.undoStack.length }));
    await page.click('#ms-btn-take-export-plate');
    await frames(page);
    const after = await page.evaluate(() => ({ placed: state.placed.length, undo: state.undoStack.length, open: NSO_MICROSCOPE.isOpen() }));
    check('Whole plate -> main plate: five placed pieces, one Undo, G-scope closes', after.placed === before.placed + 5 && after.undo === before.undo + 1 && !after.open, J(after));
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(300);
    check('...and that one Undo takes all five back', await page.evaluate(() => state.placed.length) === before.placed);
  }

  /* ------------------------------------------------------------------ 8 */
  console.log('\n=== 8. CLOSE and BACK end the visit whole ===');
  {
    // the export closed it: the next open is the plate read fresh, plate 2 empty
    await page.click('#btn-microscope');
    await page.waitForFunction(() => NSO_MICROSCOPE.isOpen() && NSO_MICROSCOPE.lensDoc(), null, { timeout: 30000 });
    await frames(page);
    let f = await freshness(page);
    check('opened after an export closed it: a fresh read of the plate, nothing kept', isFresh(f) && f.source === 'plate', J(f));
    // dirty everything, then CLOSE
    const dirty = async () => {
      await page.evaluate(() => { const M = NSO_MICROSCOPE; M.selectObjects([M.getDoc().objects[0].name], 'pick'); });
      await frames(page);
      await drag(page, await T(page, () => window.__t.selTopPx()), await T(page, () => window.__t.bedPx(0, 0)));
      await clickPlate(page, 'lens');
      await page.evaluate(() => {
        const M = NSO_MICROSCOPE;
        M.setZRange(0, 100);
        M.selectObjects([M.getDoc().objects[0].name], 'pick');
        M.isolate();
        M.setMode('select');
        M.setRenderMode('solid');
      });
      await page.click('#ms-nav-view');
      return freshness(page);
    };
    const d1 = await dirty();
    check('dirtied: something isolated on plate 1, the slider narrowed, a piece on plate 2, a card open', d1.take === 1 && d1.isolated && !d1.zrAll && d1.card, J(d1));
    const oldDoc = await page.evaluate(() => { window.__oldDoc = NSO_MICROSCOPE.lensDoc(); return true; });
    await page.click('#ms-close');
    await frames(page);
    check('CLOSE closes', !(await page.evaluate(() => NSO_MICROSCOPE.isOpen())) && oldDoc);
    await page.click('#btn-microscope');
    await page.waitForFunction(() => NSO_MICROSCOPE.isOpen() && NSO_MICROSCOPE.lensDoc(), null, { timeout: 30000 });
    await frames(page);
    f = await freshness(page);
    const dv = await defaultView(page);
    check('CLOSE, then open: a fresh read of the plate - nothing isolated or selected, slider at All, plate 2 empty, no card open', isFresh(f) && f.source === 'plate' &&
      await page.evaluate(() => NSO_MICROSCOPE.lensDoc() !== window.__oldDoc), J(f));
    check('...and the default view: the framing of both plates', dv.same, J(dv));
    await shot('08-reopened');
    // BACK: a producer's document (Picture's seam), its Back button
    await page.evaluate(() => {
      const M = NSO_MICROSCOPE;
      window.__backed = 0;
      M.openObjects('Producer', M.plateObjects(), { source: 'picture', back: () => { window.__backed++; }, backLabel: 'Back' });
      M.selectObjects([M.getDoc().objects[0].name], 'pick');
      M.isolate();
    });
    await frames(page);
    await page.click('#ms-btn-back-producer');
    await frames(page);
    check('BACK closes G-scope and hands back to the producer', await page.evaluate(() => !NSO_MICROSCOPE.isOpen() && window.__backed === 1));
    await page.click('#btn-microscope');
    await page.waitForFunction(() => NSO_MICROSCOPE.isOpen() && NSO_MICROSCOPE.lensDoc(), null, { timeout: 30000 });
    await frames(page);
    f = await freshness(page);
    check('BACK, then open: a fresh read of the plate (not the producer\'s document), all clean', isFresh(f) && f.source === 'plate', J(f));
    check('...the default view', (await defaultView(page)).same);
    // an imported file survives - fresh
    await page.evaluate(([b, n]) => NSO_MICROSCOPE.openFile(n, new Uint8Array(b).buffer), [bytes, 'gt.gcode.3mf']);
    await page.waitForFunction(() => NSO_MICROSCOPE.lensDoc() && NSO_MICROSCOPE.lensDoc().kind === 'toolpath', null, { timeout: 30000 });
    await frames(page);
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.soloGroup('Support'); M.selectLayer(2); M.isolate(); M.setZRange(1, 3); });
    await page.click('#ms-close');
    await page.click('#btn-microscope');
    await page.waitForFunction(() => NSO_MICROSCOPE.isOpen() && NSO_MICROSCOPE.lensDoc(), null, { timeout: 30000 });
    await frames(page);
    f = await freshness(page);
    check('an imported file survives a CLOSE - and comes back fresh: nothing hidden, isolated or selected, slider at All', isFresh(f) && f.doc === 'gt.gcode.3mf', J(f));
    check('...the default view', (await defaultView(page)).same);
  }

  /* ------------------------------------------------------------------ 7b */
  console.log('\n=== 7b. CLEAR empties the active plate and nothing else ===');
  {
    // plate 1 is the import: dirty it, put a piece on plate 2
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.setMode('orbit'); M.clearBoxes(); M.selectLayer(1); });
    await frames(page);
    await drag(page, await T(page, () => window.__t.segPx()), await T(page, () => window.__t.bedPx(0, 0)));
    await activateLens(page);
    await page.evaluate(() => {
      const M = NSO_MICROSCOPE;
      M.addBoxAt(20, 10, 0.4, 6, 0.15);
      M.clearFromView();
      M.soloGroup('Outer wall');
      M.setZRange(1, 4);
      M.selectLayer(2);
      M.isolate();
    });
    await frames(page);
    const dirty = await freshness(page);
    check('mid-session: plate 1 isolated, cleared from view, a line type soloed, the slider narrowed; a piece on plate 2',
      dirty.isolated && dirty.cleared > 0 && dirty.featuresOff.length > 1 && !dirty.zrAll && dirty.take === 1, J(dirty));
    // CLEAR on plate 2: plate 2 empty, plate 1 exactly as it was (still dirty)
    await page.click('#ms-btn-frame');                 // Isolate turned to plate 1's layer: both plates in view again
    await frames(page);
    const lens0 = await lensState(page);
    check('plate 2 is clickable', await clickPlate(page, 'take'));
    await page.click('#ms-btn-take-clear');
    await frames(page);
    const c2 = await page.evaluate(() => ({ plate: NSO_MICROSCOPE.plate(), take: NSO_MICROSCOPE.plateDoc('take'), st: window.__t.status() }));
    check('CLEAR with plate 2 active: plate 2 empty, plate 2 still active', c2.plate === 'take' && c2.take === null && /Plate 2 cleared/.test(c2.st), J(c2));
    check('...and plate 1 not touched - byte-identical, still isolated and narrowed', await lensState(page) === lens0);
    // a piece back on plate 2, then CLEAR on plate 1: plate 1 empty, plate 2 not touched
    await activateLens(page);
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.back(); M.selectLayer(1); });
    await frames(page);
    await drag(page, await T(page, () => window.__t.segPx()), await T(page, () => window.__t.bedPx(0, 0)));
    const take0 = await T(page, () => window.__t.content('take'));
    await activateLens(page);
    await page.click('#ms-btn-take-clear');
    await frames(page);
    const c1 = await page.evaluate(() => ({ plate: NSO_MICROSCOPE.plate(), lens: NSO_MICROSCOPE.plateDoc('lens'), rows: document.querySelectorAll('#ms-legend .ms-legend-item').length,
                                            sub: document.getElementById('ms-sub').textContent, imported: NSO_MICROSCOPE.imported() }));
    check('CLEAR with plate 1 active: plate 1 empty (no document, no Features rows), plate 1 still active', c1.plate === 'lens' && c1.lens === null && c1.rows === 0 && /^Plate 1 - empty/.test(c1.sub), J(c1));
    check('...and plate 2 not touched', await T(page, () => window.__t.content('take')) === take0);
    check('...and the import it showed is forgotten (the start-over)', c1.imported === null);
    // an emptied plate is ready for Import and Read plate
    await page.click('#ms-btn-plate');
    await page.waitForFunction(() => NSO_MICROSCOPE.lensDoc() && NSO_MICROSCOPE.lensDoc().source === 'plate', null, { timeout: 30000 });
    check('Read plate onto the emptied plate 1', await page.evaluate(() => NSO_MICROSCOPE.lensDoc().objects.length === state.placed.length));
    // Shift-CLEAR is CLEAR
    await page.click('#ms-btn-take-clear', { modifiers: ['Shift'] });
    await frames(page);
    const sc = await page.evaluate(() => ({ lens: NSO_MICROSCOPE.plateDoc('lens'), plate: NSO_MICROSCOPE.plate() }));
    check('Shift-CLEAR is CLEAR: plate 1 empty, nothing read again, plate 2 not touched',
      sc.lens === null && sc.plate === 'lens' && await T(page, () => window.__t.content('take')) === take0, J({ lens: sc.lens && sc.lens.name, plate: sc.plate }));
    await importFile(page, SLICE);
    await page.waitForFunction(() => NSO_MICROSCOPE.lensDoc() && NSO_MICROSCOPE.lensDoc().kind === 'toolpath', null, { timeout: 30000 });
    check('Import onto the emptied plate 1', await page.evaluate(() => NSO_MICROSCOPE.lensDoc().name) === 'toolpath-ground-truth.gcode.3mf');
    await page.click('#ms-btn-take-clear');
    await page.click('#ms-close');
    await page.click('#btn-microscope');
    await page.waitForFunction(() => NSO_MICROSCOPE.isOpen() && NSO_MICROSCOPE.lensDoc(), null, { timeout: 30000 });
    check('...CLEAR on it, CLOSE, open: the plate read again (the import went with the CLEAR)', await page.evaluate(() => NSO_MICROSCOPE.lensDoc().source) === 'plate');
  }

  /* ------------------------------------------------------------------ 7 */
  console.log('\n=== 7. Import and Read plate load into the active plate; the same content exports the same from either ===');
  {
    // plate 2 active: Read plate, then Import, land there; plate 1 is not touched
    const lens0 = await lensState(page);
    await clickPlate(page, 'take');
    await page.click('#ms-btn-plate');
    await page.waitForFunction(() => NSO_MICROSCOPE.plateDoc('take') && NSO_MICROSCOPE.plateDoc('take').source === 'plate', null, { timeout: 30000 });
    check('Read plate with plate 2 active: the plate read onto plate 2, plate 2 active', await plate(page) === 'take' &&
      await page.evaluate(() => NSO_MICROSCOPE.plateDoc('take').objects.length === state.placed.length));
    check('...plate 1 not touched', await lensState(page) === lens0);
    await importFile(page, SLICE);
    await page.waitForFunction(() => NSO_MICROSCOPE.plateDoc('take') && NSO_MICROSCOPE.plateDoc('take').kind === 'toolpath', null, { timeout: 30000 });
    await frames(page);
    const t = await page.evaluate(() => ({ plate: NSO_MICROSCOPE.plate(), rows: document.querySelectorAll('#ms-legend .ms-legend-item').length, zr: !document.getElementById('ms-zr').hidden,
                                           layers: NSO_MICROSCOPE.layerCount(), sub: document.getElementById('ms-sub').textContent }));
    check('Import with plate 2 active: the slice on plate 2 - its Features list, slider and layers', t.plate === 'take' && t.rows >= 3 && t.zr && t.layers > 1, J(t));
    check('...plate 1 not touched', await lensState(page) === lens0);
    // the same slice on plate 1 too: Select and Export the same on either plate
    await activateLens(page);
    await importFile(page, SLICE);
    await page.waitForFunction(() => NSO_MICROSCOPE.lensDoc() && NSO_MICROSCOPE.lensDoc().kind === 'toolpath', null, { timeout: 30000 });
    const exportOn = async (n) => {
      if (await plate(page) !== n) await clickPlate(page, n);
      await page.evaluate(() => { const M = NSO_MICROSCOPE; M.clearBoxes(); M.selectLayer(2); window.__dl.length = 0; });
      await page.click('#ms-nav-export');
      await page.click('#ms-btn-export-stl');
      await page.click('#ms-nav-export');
      return page.evaluate(async () => { const d = window.__dl[0]; return d ? { name: d.name, bytes: Array.from(new Uint8Array(await d.blob.arrayBuffer())) } : null; });
    };
    const e1 = await exportOn('lens'), e2 = await exportOn('take');
    check('the same slice on both plates: the same layer exported from plate 1 and from plate 2 - byte-identical STLs', !!e1 && !!e2 && e1.bytes.length > 84 &&
      J(e1.bytes) === J(e2.bytes) && e1.name === e2.name, J({ a: e1 && [e1.name, e1.bytes.length], b: e2 && [e2.name, e2.bytes.length] }));
    // Whole plate: the same STL on both plates
    const whole = async (n) => {
      if (await plate(page) !== n) await clickPlate(page, n);
      await importFile(page, BOX);
      await page.waitForFunction(() => NSO_MICROSCOPE.getDoc() && NSO_MICROSCOPE.getDoc().kind === 'mesh', null, { timeout: 30000 });
      await page.evaluate(() => { window.__dl.length = 0; });
      await page.click('#ms-nav-export');
      await page.click('#ms-btn-take-export-stl');
      await page.click('#ms-nav-export');
      return page.evaluate(async () => { const d = window.__dl[0]; return d ? { name: d.name, bytes: Array.from(new Uint8Array(await d.blob.arrayBuffer())) } : null; });
    };
    const w1 = await whole('lens'), w2 = await whole('take');
    const boxTris = await page.evaluate(() => NSO_MICROSCOPE.getDoc().objects.reduce((a, o) => a + o.triangles, 0));
    check('the same STL on both plates: Whole plate as STL from each - byte-identical (Plate_1.stl, Plate_2.stl)', !!w1 && !!w2 && w1.name === 'Plate_1.stl' && w2.name === 'Plate_2.stl' &&
      J(w1.bytes) === J(w2.bytes) && w1.bytes.length === 84 + 50 * boxTris, J({ a: w1 && [w1.name, w1.bytes.length], b: w2 && [w2.name, w2.bytes.length], tris: boxTris }));
    // a slice on plate 1, pieces of plate 2 go INTO it
    await activateLens(page);
    await importFile(page, SLICE);
    await page.waitForFunction(() => NSO_MICROSCOPE.lensDoc() && NSO_MICROSCOPE.lensDoc().kind === 'toolpath', null, { timeout: 30000 });
    await clickPlate(page, 'take');
    await page.click('#ms-btn-take-clear');
    await activateLens(page);
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.clearBoxes(); M.selectLayer(1); });
    await frames(page);
    await drag(page, await T(page, () => window.__t.segPx()), await T(page, () => window.__t.bedPx(0, 0)));
    check('a layer of the slice on plate 1 copied onto the empty plate 2: one piece', await plate(page) === 'take' && await takeN(page) === 1);
    const n1 = await page.evaluate(() => NSO_MICROSCOPE.lensDoc().segments.length);
    const pc = await page.evaluate(() => NSO_MICROSCOPE.takePieces()[0]);
    await page.evaluate(n => { window.__grabbedName = n; }, pc.name);
    const dd = await driveDrag(page, await T(page, n => window.__t.piecePx(n, 0), pc.name), await T(page, () => window.__t.floorPx('lens', 0.25, -0.25)), 14);
    await page.mouse.up();
    await frames(page);
    await page.evaluate(() => { window.__grabbedName = null; });
    const j = await page.evaluate(() => { const d = NSO_MICROSCOPE.lensDoc(); return { plate: NSO_MICROSCOPE.plate(), n: d.segments.length, sel: NSO_MICROSCOPE.selection().length,
      objs: new Set(d.segments.map(s => s.obj)).size, layers: NSO_MICROSCOPE.layerCount(), st: window.__t.status() }; });
    check('...dragged back onto plate 1, a slice: carried under the pointer every move; its moves JOIN the slice as one more object, selected', dd.carried === dd.moves &&
      j.plate === 'lens' && j.n === n1 + pc.moves && j.sel === pc.moves && /joins the slice/.test(j.st), J({ carried: dd.carried, moves: dd.moves, j, n1, pcMoves: pc.moves }));
    await shot('07-joined-slice');
  }

  /* ------------------------------------------------------------------ 9 */
  console.log('\n=== 9. no exit on a double-click ===');
  {
    for (const which of ['lens', 'take']) {
      if (await plate(page) !== which) await clickPlate(page, which);
      await page.evaluate(() => NSO_MICROSCOPE.setMode('select'));
      const pt = await T(page, () => window.__t.emptyPx());
      const st0 = await T(page, () => window.__t.state(NSO_MICROSCOPE.plate()));
      await page.mouse.dblclick(pt[0], pt[1]);
      await page.waitForTimeout(150);
      const r = await page.evaluate(() => ({ open: NSO_MICROSCOPE.isOpen(), mode: NSO_MICROSCOPE.mode(), plate: NSO_MICROSCOPE.plate() }));
      check('a double-click on the view (plate ' + (which === 'lens' ? 1 : 2) + ' active, region armed) does nothing',
        r.open && r.mode === 'select' && r.plate === which && (await T(page, () => window.__t.state(NSO_MICROSCOPE.plate()))) === st0, J(r));
      await page.evaluate(() => NSO_MICROSCOPE.setMode('orbit'));
    }
  }

  /* ------------------------------------------------------------------ 10 */
  console.log('\n=== 10. Watch\'s log docks bottom-right, under the slider\'s All button ===');
  {
    await clickPlate(page, 'lens');
    const w0 = await page.evaluate(() => !!document.getElementById('nso-watch-panel') && document.getElementById('nso-watch-panel').classList.contains('is-on'));
    if (!w0) await page.evaluate(() => document.getElementById('btn-watch').click());
    await page.waitForFunction(() => { const p = document.getElementById('nso-watch-panel'); return p && p.classList.contains('is-on') && p.classList.contains('in-gscope'); }, null, { timeout: 10000 });
    await page.waitForTimeout(250);
    await frames(page);
    const g = await page.evaluate(() => {
      const R = id => { const e = document.getElementById(id), b = e.getBoundingClientRect(); return { x: b.left, y: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
      return { panel: R('nso-watch-panel'), all: R('ms-zr-all'), zr: document.getElementById('ms-zr').hidden ? null : R('ms-zr'), W: innerWidth, H: innerHeight, corner: R('ms-corner') };
    });
    check('the log is in the bottom-right corner of the view, under the slider\'s All button, clear of the corner row',
      g.panel.r > g.W - 16 && g.panel.b > g.H - 16 && g.zr && g.panel.y >= g.all.b - 0.5 && g.zr.b <= g.panel.y && g.panel.y >= g.corner.b, J([g.panel, g.all.b]));
    await page.evaluate(() => document.getElementById('btn-watch').click());
    await page.waitForTimeout(200);
  }

  /* ------------------------------------------------------------------ 7c */
  console.log('\n=== 7c. Shift-CLEAR from a fresh page is CLEAR ===');
  {
    await page.reload();
    await page.waitForFunction(() => window.NSO_MICROSCOPE && window.state, null, { timeout: 30000 });
    await page.evaluate(PAGE_HELPERS);
    await loadSTL(page, BOX);
    await page.waitForTimeout(300);
    await page.click('#btn-microscope');
    await page.waitForFunction(() => NSO_MICROSCOPE.isOpen() && NSO_MICROSCOPE.getDoc(), null, { timeout: 30000 });
    await frames(page);
    await page.click('#ms-btn-take-clear', { modifiers: ['Shift'] });
    await frames(page);
    check('Shift-CLEAR straight after opening a fresh page: plate 1 empty (nothing read again), plate 2 empty',
      await page.evaluate(() => NSO_MICROSCOPE.plateDoc('lens') === null && NSO_MICROSCOPE.plateDoc('take') === null && NSO_MICROSCOPE.isOpen()));
    // an import there, then CLEAR: the import is forgotten
    await page.evaluate(([b, n]) => NSO_MICROSCOPE.openFile(n, new Uint8Array(b).buffer), [bytes, 'gt.gcode.3mf']);
    await page.waitForFunction(() => NSO_MICROSCOPE.lensDoc() && NSO_MICROSCOPE.lensDoc().kind === 'toolpath', null, { timeout: 30000 });
    await page.click('#ms-btn-take-clear');
    check('...an import there, CLEAR: plate 1 empty and the import forgotten', await page.evaluate(() => NSO_MICROSCOPE.imported() === null && NSO_MICROSCOPE.lensDoc() === null));
  }

  const errs = logs.filter(l => /^\[pageerror\]/.test(l) || /^\[error\]/.test(l)).filter(l => !/Failed to load resource/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('TEST CRASH', e); process.exit(1); });
