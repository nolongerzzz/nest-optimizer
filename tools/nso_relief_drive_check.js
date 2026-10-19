#!/usr/bin/env node
/* Picture -> relief slab, driven through the REAL app in headless Chromium,
 * with screenshots.
 *
 *   node tools/nso_relief_drive_check.js              exit 0 = every gate held
 *   node tools/nso_relief_drive_check.js tools/relief-out  ...and keep the screenshots
 *                                                         (npm run relief:shots;
 *                                                         gitignored, never committed)
 *   With no directory the screenshots go to a temp dir and are thrown away, so
 *   npm test never rewrites the committed ones.
 *
 * Every step is the shipped control: Gen+ is opened by its summary, Picture by
 * its own, the file goes into the real <input type=file> (so the browser's own
 * decoder reads the JPEG and the PNG), the numbers are typed into the card and
 * Make piece is clicked. That opens the slab in G-scope and NOT on the plate;
 * G-scope's own Click to select region, a click on the slab and Export to plate
 * put it there. The piece's triangles are then read back out of the page and
 * judged HERE - the app's own edge count AND tools/mesh_validate.py on the STL
 * the Export button actually downloaded.
 *
 *   1. the card is in Gen+, with every control the ticket names
 *   2. the loop, on a scanned line drawing: Make -> G-scope (plate and Undo
 *      stack untouched) -> Back to Picture (photo and every setting as they
 *      were, no re-pick) -> Make again replaces the slab (no stacking) ->
 *      Undo steps back to the previous one -> Make -> Export to plate: an
 *      ordinary piece named after the file, on free plate, posed flat; one
 *      app Undo takes it off; the piece already on the plate is untouched
 *   3. the same scan at Levels 8
 *   4. a photo at smooth
 *   5. it sculpts: Brush (Emboss - the brush's raising mode) pulls a region up
 *      and the brush's own gate keeps it closed; Smooth runs; Cut splits it
 *      and seals both halves; Export writes it and the canonical checker
 *      passes the file
 *   6. a 4000 x 4000 picture at 0.1 mm/sample is refused with the Detail that
 *      fits, and nothing is made
 *   7. placement: every piece that landed is on the bed and clear of every
 *      other; a slab wider than the bed lands beside it, still clear, and
 *      says so
 *   8. a HEIC the browser cannot read is refused in plain words, and the
 *      picture already on the card stays
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, selectModel, statusOf, ROOT } = require('./nso_app_harness');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-relief-drive-'));
const KEEP = !!process.argv[2];
const OUT = KEEP ? path.resolve(process.argv[2]) : path.join(TMP, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const FX = path.join(ROOT, 'fixtures', 'relief');
const SCAN = path.join(FX, 'line-drawing-scan.jpg');
const PHOTO = path.join(FX, 'camera.png');

let fails = 0, passes = 0;
const FAILED = [];
const NUM = {};
function check(name, cond, detail) {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (cond) passes++; else { fails++; FAILED.push(name); }
}

async function shot(page, name, full) {
  await page.waitForTimeout(200);
  const file = path.join(OUT, name + '.png');
  if (full) await page.screenshot({ path: file });
  else {
    /* the relief in the app's own colours, without the selection tint */
    await page.evaluate(() => { if (typeof clearSelectionOutline === 'function') clearSelectionOutline(); state.renderer.render(state.scene, state.camera); });
    const r = await page.evaluate(() => { const b = state.renderer.domElement.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
    await page.screenshot({ path: file, clip: { x: r.x, y: r.y, width: r.w, height: r.h } });
  }
  console.log('   [screenshot] ' + path.relative(ROOT, file));
}

/* The app's own view of a piece: triangles, open / non-manifold edges, volume, box. */
const measure = (page, id) => page.evaluate(id => {
  const m = state.models.find(q => q.id === id);
  if (!m) return null;
  const s = m.rawTris, st = NSO_edgeStats(s);
  let v = 0;
  for (let o = 0; o < s.length; o += 9) {
    v += s[o] * (s[o + 4] * s[o + 8] - s[o + 5] * s[o + 7])
       - s[o + 1] * (s[o + 3] * s[o + 8] - s[o + 5] * s[o + 6])
       + s[o + 2] * (s[o + 3] * s[o + 7] - s[o + 4] * s[o + 6]);
  }
  let zmax = -Infinity;
  for (let i = 2; i < s.length; i += 3) if (s[i] > zmax) zmax = s[i];
  return { id: m.id, name: m.name, tris: s.length / 9, open: st.open, nm: st.nm, volume: v / 6,
           size: [m.size.x, m.size.y, m.size.z].map(x => +x.toFixed(3)), zmax: zmax };
}, id);

/* Everything about a piece that "untouched" covers: its soup, place and pose. */
const fingerprint = (page, id) => page.evaluate(id => {
  const m = state.models.find(q => q.id === id);
  const p = state.placed.find(q => q && q.sourceId === id);
  let sum = 0;
  for (let i = 0; i < m.rawTris.length; i++) sum += m.rawTris[i] * ((i % 7) + 1);
  return JSON.stringify({ n: m.rawTris.length, sum: sum, name: m.name,
    place: p ? [p.x, p.z, p.rotY || 0, p.tiltX || 0, p.tiltZ || 0, p.lift || 0] : null });
}, id);

async function openCard(page) {
  await page.evaluate(() => {
    const g = document.getElementById('menu-gen');
    if (!g.open) g.querySelector(':scope > summary').click();
  });
  await page.evaluate(() => { const r = document.getElementById('menu-relief'); if (!r.open) r.querySelector(':scope > summary').click(); });
}
async function closeMenus(page) {
  await page.evaluate(() => { document.querySelectorAll('details.vp-top-menu[open], details.vp-finish-menu[open]').forEach(d => { d.open = false; }); });
}
async function setCard(page, v) {
  const ids = { width: 'inp-relief-width', base: 'inp-relief-base', relief: 'inp-relief-relief', detail: 'inp-relief-detail' };
  for (const k of Object.keys(ids)) if (v[k] != null) await page.fill('#' + ids[k], String(v[k]));
  if (v.levels != null) await page.selectOption('#sel-relief-levels', String(v.levels));
  if (v.bright != null) await page.setChecked('#chk-relief-bright', !!v.bright);
}
async function pickFile(page, file) {
  const prev = await page.evaluate(() => (window.nsoReliefPicture() || {}).name || null);
  await page.setInputFiles('#relief-file', file);
  const want = typeof file === 'string' ? path.basename(file) : file.name;
  await page.waitForFunction(([w, p]) => { const q = window.nsoReliefPicture(); return q && q.name === w && (p !== w || true); },
    [want, prev], { timeout: 60000 });
  await page.waitForTimeout(50);
}
const triLine = page => page.evaluate(() => document.getElementById('relief-tris').textContent);
const lineCount = s => { const m = /([\d,]+) triangles/.exec(s); return m ? parseInt(m[1].replace(/,/g, ''), 10) : null; };

/* Make piece: the slab into G-scope. Resolves with what G-scope shows. */
async function make(page) {
  await page.evaluate(() => { document.getElementById('status').textContent = ''; });
  await page.click('#btn-relief-make');
  await page.waitForFunction(() => /in G-scope|refused|failed|could not/i.test(document.getElementById('status').textContent),
    null, { timeout: 120000 });
  return scopeDoc(page);
}

/* What G-scope is showing: its source, the slab's name, count and a checksum. */
const scopeDoc = page => page.evaluate(() => {
  const M = window.NSO_MICROSCOPE, d = M && M.getDoc();
  if (!d) return { open: M ? M.isOpen() : false, doc: null };
  const o = d.objects && d.objects[0];
  let sum = 0;
  if (o) for (let i = 0; i < o.positions.length; i++) sum += o.positions[i] * ((i % 7) + 1);
  const b = document.getElementById('ms-btn-back-producer');
  return { open: M.isOpen(), doc: { source: d.source, name: d.name, objects: d.objects ? d.objects.length : 0,
    object: o ? o.name : null, tris: o ? o.triangles : 0, sum: sum },
    back: b ? { shown: !b.hidden, label: b.textContent.trim() } : null };
});

/* G-scope's own way out: Click to select region, click the slab, Export to plate. */
async function sendToPlate(page) {
  const before = await page.evaluate(() => state.models.length);
  await page.click('#ms-mode-select');
  // the slab's top, in the middle: G-scope opens framed on both of its plates (docs/GSCOPE.md), so the
  // middle of the view is the gap between them, not the slab
  const r = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, b = M.getDoc().objects[0].bounds, v = M.getView(), c = v.renderer.domElement.getBoundingClientRect();
    const p = M.toView((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, b.maxZ).project(v.camera);
    return [c.left + (p.x + 1) / 2 * c.width, c.top + (1 - p.y) / 2 * c.height];
  });
  await page.mouse.click(r[0], r[1]);
  await page.waitForFunction(() => window.NSO_MICROSCOPE.selection().length === 1, null, { timeout: 30000 });
  await page.click('#ms-btn-export-plate');
  await page.waitForFunction(n => state.models.length > n, before, { timeout: 60000 });
  return page.evaluate(n => state.models[state.models.length - 1].id, before);
}

/* Make piece, then onto the plate, for the sections where getting a slab onto
   the plate is the setup and not the thing checked. Section 2 drives every
   control of the loop with real clicks; here Make is still the real button,
   and the selection and Export to plate are the functions G-scope's own
   click and button run - each real click waits on frames that software GL
   draws slowly with G-scope up, and that is most of this check's time. */
async function makePiece(page) {
  const d = await make(page);
  if (!d.doc || d.doc.source !== 'picture') return null;
  return page.evaluate(name => {
    const M = window.NSO_MICROSCOPE;
    if (M.selectObjects([name], 'box').length !== 1) return null;
    return M.exportToPlate();
  }, d.doc.object);
}

/* Every placed piece's footprint as posed, and whether it is on the bed. */
const plateLayout = page => page.evaluate(() => {
  const pl = getCurrentPlate();
  return state.placed.filter(Boolean).map(p => {
    const f = placedFootprint(p);
    return { id: p.sourceId, name: p.name, f: f,
      onBed: f.minx >= -pl.w / 2 - 1e-6 && f.maxx <= pl.w / 2 + 1e-6 && f.minz >= -pl.d / 2 - 1e-6 && f.maxz <= pl.d / 2 + 1e-6 };
  });
});
const overlaps = (a, b) => Math.min(a.maxx, b.maxx) - Math.max(a.minx, b.minx) > 0 && Math.min(a.maxz, b.maxz) - Math.max(a.minz, b.minz) > 0;
const clearOfAll = (lay, id) => { const me = lay.find(q => q.id === id); return !!me && lay.every(q => q.id === id || !overlaps(me.f, q.f)); };

/* The pose of a placed piece: where it is, how it is turned, whether it sits on the bed. */
const poseOf = (page, id) => page.evaluate(id => {
  const p = state.placed.find(q => q && q.sourceId === id);
  if (!p) return null;
  p.mesh.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(p.mesh);
  return { name: p.name, x: p.x, z: p.z, rotY: p.rotY || 0, tipX: p.tipX || 0, tiltX: p.tiltX || 0, tiltZ: p.tiltZ || 0,
    flipX: !!p.flipX, minY: b.min.y };
}, id);

const cardState = page => page.evaluate(() => {
  const v = id => { const e = document.getElementById(id); return e.type === 'checkbox' ? e.checked : e.value; };
  return JSON.stringify({ pic: window.nsoReliefPicture(), file: document.getElementById('relief-file-name').textContent,
    w: v('inp-relief-width'), b: v('inp-relief-base'), r: v('inp-relief-relief'), d: v('inp-relief-detail'),
    l: v('sel-relief-levels'), up: v('chk-relief-bright') });
});

/* Look at a piece from (dx, dy, dz) mm off its centre, or off a point
   (tx, 0, tz) mm from its centre. */
const lookAt = (page, id, off, at) => page.evaluate(([id, o, t]) => {
  const p = state.placed.find(q => q && q.sourceId === id);
  const c = p.mesh.position.clone().add(new THREE.Vector3(t[0], t[1], t[2]));
  state.controls.target.set(c.x, c.y, c.z);
  state.camera.position.set(c.x + o[0], c.y + o[1], c.z + o[2]);
  state.controls.update();
  state.camera.updateMatrixWorld(true);
  if (state.renderer && state.scene) state.renderer.render(state.scene, state.camera);
}, [id, off, at || [0, 0, 0]]);

/* Client pixels for a point on the TOP of the active piece, (dx, dz) mm off centre. */
const topPoint = (page, dx, dz) => page.evaluate(([ox, oz]) => {
  const m = getActiveModel();
  const p = state.placed.find(q => q && q.sourceId === m.id);
  const v = new THREE.Vector3(p.mesh.position.x + ox, p.mesh.position.y + m.size.y / 2 - 0.05, p.mesh.position.z + oz);
  v.project(state.camera);
  const r = state.renderer.domElement.getBoundingClientRect();
  return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
}, [dx, dz]);

const canonical = file => JSON.parse(execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'],
  { encoding: 'utf8', maxBuffer: 1 << 28 }));

function parseBinarySTL(buf) {
  const n = buf.readUInt32LE(80);
  if (buf.length !== 84 + 50 * n) throw new Error('STL declares ' + n + ' triangles, file is ' + buf.length + ' bytes');
  return n;
}

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 900 });

  console.log('=== 1. the card is in Gen+ ===');
  await openCard(page);
  const ui = await page.evaluate(() => {
    const vis = id => { const e = document.getElementById(id); if (!e) return false; const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    return {
      inGen: !!document.querySelector('#menu-gen #menu-relief'),
      summary: document.querySelector('#menu-relief > summary').textContent.trim(),
      accept: document.getElementById('relief-file').getAttribute('accept'),
      visible: ['btn-relief-pick', 'inp-relief-width', 'inp-relief-base', 'inp-relief-relief', 'inp-relief-detail',
                'sel-relief-levels', 'chk-relief-bright', 'relief-tris', 'btn-relief-make', 'btn-relief-undo'].filter(vis),
      levels: Array.from(document.getElementById('sel-relief-levels').options).map(o => o.value),
      level: document.getElementById('sel-relief-levels').value,
      bright: document.getElementById('chk-relief-bright').checked,
      makeDisabled: document.getElementById('btn-relief-make').disabled,
      undoDisabled: document.getElementById('btn-relief-undo').disabled,
      line: document.getElementById('relief-tris').textContent,
      defaults: ['inp-relief-width', 'inp-relief-base', 'inp-relief-relief', 'inp-relief-detail']
        .map(id => document.getElementById(id).value).join(' / ')
    };
  });
  check('Gen+ -> Picture exists', ui.inGen && ui.summary === 'Picture', ui.summary);
  check('the file picker takes image/* and lists HEIC / HEIF', ui.accept === 'image/*,.heic,.heif', ui.accept);
  check('every control is visible: picker, Width, Base, Relief, Detail, Levels, Bright is up, the line, Make piece, Undo',
    ui.visible.length === 10, ui.visible.join(', '));
  check('Levels offers 2 / 4 / 8 / 16 / smooth, 2 by default', JSON.stringify(ui.levels) === '["2","4","8","16","smooth"]' && ui.level === '2',
    ui.levels.join(' '));
  check('Bright is up starts off', ui.bright === false);
  check('the card opens on the ticket\'s defaults: Width 60, Base 2, Relief 2, Detail 0.3',
    ui.defaults === '60 / 2 / 2 / 0.3', ui.defaults);
  check('Make piece waits for a picture', ui.makeDisabled === true, ui.line);
  check('Undo waits for a previous slab', ui.undoDisabled === true);

  /* a piece already on the plate, which nothing below may touch */
  await closeMenus(page);
  const boxId = await loadSTL(page, path.join(ROOT, 'fixtures', 'box-20mm.stl'));
  const boxFp = await fingerprint(page, boxId);

  console.log('\n=== 2. the loop: Make -> G-scope -> Back to Picture -> Make again -> Undo -> Export to plate ===');
  await openCard(page);
  await pickFile(page, SCAN);
  /* 0.5 mm, not finer: the loop is about where the slab goes, and every frame
     G-scope and the plate draw under software GL costs its triangles */
  await setCard(page, { width: 80, base: 1, relief: 1.2, detail: 0.5, levels: 2, bright: false });
  const line2 = await triLine(page);
  const undo0 = await page.evaluate(() => state.undoStack.length);
  const models0 = await page.evaluate(() => state.models.length);
  const placed0 = await page.evaluate(() => state.placed.length);
  await shot(page, '01-card-scan-levels2', true);

  /* Make: into G-scope, not onto the plate */
  const t0 = Date.now();
  const g1 = await make(page);
  const ms2 = Date.now() - t0;
  const st1 = await statusOf(page);
  check('Make piece opens the slab in G-scope', g1.open && g1.doc && g1.doc.source === 'picture' && g1.doc.objects === 1,
    JSON.stringify(g1.doc) + ' | ' + st1.trim().slice(0, 120));
  if (!g1.doc) throw new Error('no slab in G-scope: ' + st1);
  check('...named after the file', g1.doc.object === 'line-drawing-scan' && g1.doc.name === 'line-drawing-scan.jpg', g1.doc.object);
  check('...with the triangle count the live line said', lineCount(line2) === g1.doc.tris, line2 + ' vs ' + g1.doc.tris);
  check('...and nothing went on the plate or the Undo stack',
    await page.evaluate(([m, p, u]) => state.models.length === m && state.placed.length === p && state.undoStack.length === u,
      [models0, placed0, undo0]));
  check('the status says it is in G-scope and not on the plate', /in G-scope, not on the plate/.test(st1) && /closed \(chi 2\)/.test(st1), st1.trim());
  check('G-scope shows Back to Picture', g1.back && g1.back.shown && g1.back.label === 'Back to Picture', JSON.stringify(g1.back));
  check('Undo is still off: there is no previous slab', await page.evaluate(() => document.getElementById('btn-relief-undo').disabled));
  await shot(page, '02-gscope-slab-levels2', true);

  /* Back to Picture: the card, photo and settings as they were */
  const card1 = await cardState(page);
  await page.click('#ms-btn-back-producer');
  await page.waitForTimeout(150);
  const backed = await page.evaluate(() => ({ scope: window.NSO_MICROSCOPE.isOpen(),
    gen: document.getElementById('menu-gen').open, card: document.getElementById('menu-relief').open,
    makeOn: !document.getElementById('btn-relief-make').disabled }));
  check('Back to Picture closes G-scope and opens the Picture card', !backed.scope && backed.gen && backed.card, JSON.stringify(backed));
  check('...with the photo and every setting as they were (Width, Base, Relief, Detail, Levels, Bright is up)',
    await cardState(page) === card1, card1);
  check('...and Make piece ready without choosing the photo again', backed.makeOn);
  await shot(page, '03-back-to-picture', true);

  /* Make again: replaces the slab in G-scope, does not stack */
  await setCard(page, { levels: 8 });
  const card2 = await cardState(page);
  const g2 = await make(page);
  check('Make again replaces the slab G-scope shows - one slab, a different one',
    g2.open && g2.doc && g2.doc.objects === 1 && g2.doc.source === 'picture' && g2.doc.sum !== g1.doc.sum,
    g2.doc && (g2.doc.objects + ' object, checksum ' + g2.doc.sum.toFixed(0) + ' vs ' + g1.doc.sum.toFixed(0)));
  check('...still nothing on the plate or the Undo stack',
    await page.evaluate(([m, p, u]) => state.models.length === m && state.placed.length === p && state.undoStack.length === u,
      [models0, placed0, undo0]));
  check('Undo is on now', await page.evaluate(() => !document.getElementById('btn-relief-undo').disabled));

  /* Undo: one step back to the previous attempt */
  await page.click('#ms-btn-back-producer');
  await page.waitForTimeout(100);
  check('the card shows the second attempt\'s settings', await cardState(page) === card2);
  await page.click('#btn-relief-undo');
  await page.waitForTimeout(150);
  const g3 = await scopeDoc(page);
  check('Undo puts the previous slab back in G-scope', g3.open && g3.doc && g3.doc.sum === g1.doc.sum && g3.doc.objects === 1,
    g3.doc && g3.doc.sum.toFixed(0));
  check('...and its settings back on the card (Levels 2)', await cardState(page) === card1);
  check('...one step only: Undo is off again', await page.evaluate(() => document.getElementById('btn-relief-undo').disabled));
  check('...and the plate and the app\'s Undo stack never moved',
    await page.evaluate(([m, p, u]) => state.models.length === m && state.placed.length === p && state.undoStack.length === u,
      [models0, placed0, undo0]));

  /* Send to plate: G-scope's own Export to plate, on the Levels 2 slab */
  const scan2 = await sendToPlate(page);
  const m2 = await measure(page, scan2);
  const st2 = await statusOf(page);
  check('Export to plate puts the slab on the plate, named after the file', m2 && m2.name === 'line-drawing-scan', m2 ? m2.name : st2);
  if (!m2) throw new Error('no slab: ' + st2);
  check('G-scope closed on the way out', !(await page.evaluate(() => window.NSO_MICROSCOPE.isOpen())));
  check('it is the slab G-scope showed: the live line\'s count', lineCount(line2) === m2.tris, line2 + ' vs ' + m2.tris);
  check('closed in the app\'s own edge count', m2.open === 0 && m2.nm === 0, 'open ' + m2.open + ', nm ' + m2.nm);
  check('80 mm wide, 60 deep, base + relief tall', Math.abs(m2.size[0] - 80) < 1e-3 && Math.abs(m2.size[2] - 60) < 1e-3 &&
    Math.abs(m2.size[1] - 2.2) < 1e-3, m2.size.join(' x ') + ' mm (x, height, depth)');
  check('the status says it went to the plate', /Export to plate ok - "line-drawing-scan"/.test(st2), st2.trim());
  const pose2 = await poseOf(page, scan2);
  check('posed as any new piece: flat, unturned, on the bed', pose2 && pose2.rotY === 0 && pose2.tipX === 0 && pose2.tiltX === 0 &&
    pose2.tiltZ === 0 && !pose2.flipX && Math.abs(pose2.minY) < 0.35, JSON.stringify(pose2));
  const lay2 = await plateLayout(page);
  check('on free plate: wholly on the bed and clear of the piece already there',
    clearOfAll(lay2, scan2) && lay2.find(q => q.id === scan2).onBed,
    lay2.map(q => q.name + ' x ' + q.f.minx.toFixed(1) + '..' + q.f.maxx.toFixed(1) + ' z ' + q.f.minz.toFixed(1) + '..' + q.f.maxz.toFixed(1)).join(' | '));
  check('nothing else on the plate was touched', await fingerprint(page, boxId) === boxFp);
  check('exactly one Undo step was pushed', await page.evaluate(() => state.undoStack.length) === undo0 + 1);
  NUM.scan2 = Object.assign({ line: line2, ms: ms2, pose: pose2 }, m2);
  await closeMenus(page);
  await lookAt(page, scan2, [0, 50, 72]);
  await shot(page, '04-scan-levels2-on-plate');
  await lookAt(page, scan2, [-8, 16, 26], [-14, 0, 2]);
  await shot(page, '05-scan-levels2-close');

  /* it is an ordinary piece: one app Undo takes it off, and only it */
  await page.evaluate(() => undoLast());
  check('one Undo takes the slab off', await page.evaluate(id => !state.models.some(m => m.id === id) &&
    !state.placed.some(p => p && p.sourceId === id), scan2));
  check('...and the piece already there is still exactly as it was', await fingerprint(page, boxId) === boxFp);
  check('...and the Undo stack is back where it started', await page.evaluate(() => state.undoStack.length) === undo0);

  console.log('\n=== 3. the same scan at Levels 8 ===');
  await openCard(page);
  await setCard(page, { levels: 8 });
  const line8 = await triLine(page);
  const scan8 = await makePiece(page);
  const m8 = await measure(page, scan8);
  check('Levels 8: added, closed, the line matches', m8 && m8.open === 0 && m8.nm === 0 && lineCount(line8) === m8.tris,
    line8 + ', open ' + m8.open + ', nm ' + m8.nm);
  check('the piece already there is still untouched', await fingerprint(page, boxId) === boxFp);
  NUM.scan8 = Object.assign({ line: line8 }, m8);
  await closeMenus(page);
  await lookAt(page, scan8, [-8, 16, 26], [-14, 0, 2]);
  await shot(page, '06-scan-levels8');
  await page.evaluate(() => undoLast());               /* light plate for what follows */

  console.log('\n=== 4. a photo at smooth ===');
  await openCard(page);
  await pickFile(page, PHOTO);
  await setCard(page, { width: 60, base: 0.8, relief: 2.4, detail: 0.4, levels: 'smooth', bright: true });
  const lineP = await triLine(page);
  await shot(page, '07-card-photo-smooth', true);
  const photo = await makePiece(page);
  const mP = await measure(page, photo);
  check('photo, smooth, bright is up: added, named after the file, closed', mP && mP.name === 'camera' && mP.open === 0 && mP.nm === 0,
    mP && (mP.name + ', open ' + mP.open + ', nm ' + mP.nm));
  check('the line matches the result', lineCount(lineP) === mP.tris, lineP + ' vs ' + mP.tris);
  NUM.photo = Object.assign({ line: lineP }, mP);
  await closeMenus(page);
  await lookAt(page, photo, [0, 46, 62]);
  await shot(page, '08-photo-smooth');
  await page.evaluate(() => undoLast());

  console.log('\n=== 5. it sculpts - Brush, Smooth, Cut, Export ===');
  /* A slab at the scan's Levels 8, at a Detail the brush's whole-mesh gate
     runs in seconds on, so this check stays in the suite. */
  await openCard(page);
  await pickFile(page, SCAN);
  await setCard(page, { width: 60, base: 1.5, relief: 1.2, detail: 0.5, levels: 8, bright: false });
  const slab = await makePiece(page);
  await closeMenus(page);
  const s0 = await measure(page, slab);
  console.log('   slab: ' + s0.tris + ' triangles, volume ' + s0.volume.toFixed(2) + ' mm^3');
  await selectModel(page, slab);
  await lookAt(page, slab, [0, 70, 45]);

  /* Brush: Emboss is the brush's raising mode; there is no mode named "pull". */
  await page.evaluate(() => {
    const b = document.getElementById('btn-brush');
    for (let n = b; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
    document.querySelectorAll('.vp-finish-menu .vp-sec').forEach(d => { d.open = true; });
  });
  const setCtl = (id, v) => page.evaluate(([i, val]) => {
    const e = document.getElementById(i);
    e.value = String(val);
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
  }, [id, v]);
  await setCtl('inp-brush-size', 10);
  await setCtl('inp-brush-intensity', 0.8);
  await setCtl('sel-brush-mode', 'emboss');
  await page.click('#btn-brush');
  /* One real stroke, (x0, z0) -> (x1, z1) mm off the slab's centre on the
     plate. The slab is centred, so picture y = z + depth / 2. */
  async function brushStroke(x0, z0, x1, z1) {
    const a = await topPoint(page, x0, z0), b = await topPoint(page, x1, z1);
    await page.evaluate(() => { document.getElementById('status').textContent = ''; window.nsoBrushLast = null; });
    const before = await measure(page, slab);
    const t = Date.now();
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    for (let i = 1; i <= 14; i++) await page.mouse.move(a.x + (b.x - a.x) * i / 14, a.y + (b.y - a.y) * i / 14);
    await page.mouse.up();
    await page.waitForFunction(() => /done|refused|reverted|stood down/i.test(document.getElementById('status').textContent),
      null, { timeout: 180000 });
    await page.waitForTimeout(300);
    const ms = Date.now() - t;
    const after = await measure(page, slab);
    const status = (await statusOf(page)).trim();
    const gate = await page.evaluate(() => {
      const L = window.nsoBrushLast;
      const pick = q => q && { tris: q.tris, openPos: q.openPos, nmPos: q.nmPos, tJunctions: q.tJunctions,
                               slivers: q.slivers, pierce: q.pierce, volume: q.volume };
      return L ? { stamps: L.stamps, before: pick(L.before), after: pick(L.after) } : null;
    });
    return { before, after, status, gate, ms };
  }

  /* across the ink: the cottage's walls, window and the tree trunks */
  const across = await brushStroke(-12, 4, 12, 4);
  console.log('   across the ink: ' + across.status.slice(0, 140) + ' (' + across.ms + ' ms)');
  check('a stroke ACROSS the ink lines: whatever the brush decides, the piece stays closed',
    across.after.open === 0 && across.after.nm === 0, 'open ' + across.after.open + ', nm ' + across.after.nm);
  if (/refused/i.test(across.status)) {
    check('...and when its gate refuses, the piece is exactly as it was',
      across.after.tris === across.before.tris && across.after.volume === across.before.volume,
      across.after.tris + ' tris, ' + across.after.volume.toFixed(2) + ' mm^3');
  }
  NUM.brushAcrossInk = across;

  /* over open paper: the sky above the cottage, picture y ~ 7.5 mm */
  const over = await brushStroke(-26, -15, -8, -15);
  const sB = over.after;
  console.log('   over the paper: ' + over.status.slice(0, 140) + ' (' + over.ms + ' ms)');
  check('the Emboss stroke over the paper baked', /Emboss done/.test(over.status), over.status.slice(0, 160));
  check('it raised a region: the slab is taller and holds more material',
    sB.zmax > over.before.zmax + 0.2 && sB.volume > over.before.volume,
    'top ' + over.before.zmax.toFixed(3) + ' -> ' + sB.zmax.toFixed(3) + ' mm, volume ' +
    over.before.volume.toFixed(2) + ' -> ' + sB.volume.toFixed(2) + ' mm^3');
  check('...and the brush\'s own gate kept it closed', sB.open === 0 && sB.nm === 0 && over.gate &&
    over.gate.after.openPos === 0 && over.gate.after.pierce <= over.gate.before.pierce,
    'open ' + sB.open + ', nm ' + sB.nm + (over.gate ? ', gate pierce ' + over.gate.before.pierce + ' -> ' +
    over.gate.after.pierce + ', T-junctions ' + over.gate.before.tJunctions + ' -> ' + over.gate.after.tJunctions : ''));
  NUM.brush = over;
  await page.click('#btn-brush');                         /* disarm */
  await closeMenus(page);
  await lookAt(page, slab, [4, 16, 30], [-17, 0, -12]);
  await shot(page, '09-brush-emboss-on-slab');

  /* Smooth: the whole-piece Laplacian, through its button */
  await page.evaluate(() => { const b = document.getElementById('btn-smooth'); for (let n = b; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
  const ts = Date.now();
  await page.click('#btn-smooth');
  await page.waitForFunction(() => /smooth/i.test(document.getElementById('status').textContent), null, { timeout: 120000 });
  await page.waitForTimeout(300);
  const smMs = Date.now() - ts;
  const sS = await measure(page, slab);
  const smStatus = await statusOf(page);
  check('Smooth ran and the slab is still closed', !/refus|fail|stood down/i.test(smStatus) && sS.open === 0 && sS.nm === 0,
    smStatus.trim().slice(0, 160));
  NUM.smooth = { after: sS, ms: smMs, status: smStatus.trim() };
  await closeMenus(page);

  /* Cut: open the cutter, aim it at the slab, Split */
  await page.evaluate(() => { const e = document.getElementById('cutter-tools'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
  if (!(await page.evaluate(() => cutterArmed('cut')))) await page.evaluate(() => openCutter('cut'));
  /* what a click on the piece does with the cutter open: select it, hang the red line on it */
  await page.evaluate(id => selectPlaced(state.placed.findIndex(p => p && p.sourceId === id)), slab);
  const idsBefore = await page.evaluate(() => state.models.map(m => m.id));
  await page.click('#btn-cut');
  await page.waitForFunction(ids => state.models.filter(m => ids.indexOf(m.id) < 0).length >= 2 ||
    /refus|fail/i.test(document.getElementById('status').textContent), idsBefore, { timeout: 60000 });
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => state.models.map(m => ({ id: m.id, name: m.name })));
  const newHalves = after.filter(x => idsBefore.indexOf(x.id) < 0).map(x => x.id);
  const hs = [];
  for (const id of newHalves) hs.push(await measure(page, id));
  const cutStatus = await statusOf(page);
  check('Cut split the slab into two pieces', hs.length === 2, after.map(x => x.name).join(', ') + ' | ' + cutStatus.trim().slice(0, 120));
  check('...and sealed both halves', hs.length === 2 && hs.every(h => h && h.open === 0 && h.nm === 0),
    hs.map(h => h && (h.name + ' ' + h.tris + ' tris, open ' + h.open + ', nm ' + h.nm + ', ' + h.volume.toFixed(2) + ' mm^3')).join(' | '));
  if (hs.length === 2) {
    /* Not asserted here: Cut is a clean split now (no kerf), so the halves
       should sum to the whole; tools/nso_relief_sculpt_test.js holds rawCut
       itself to the sum. */
    console.log('   halves ' + hs[0].volume.toFixed(2) + ' + ' + hs[1].volume.toFixed(2) + ' = ' +
      (hs[0].volume + hs[1].volume).toFixed(2) + ' mm^3 against ' + sS.volume.toFixed(2) + ' whole');
  }
  NUM.cut = { status: cutStatus.trim(), halves: hs };
  await page.evaluate(() => { if (state.cutterOpen) closeCutter(true); });
  await closeMenus(page);
  if (hs.length === 2) {
    const gap = await page.evaluate(ids => {
      const ps = ids.map(id => state.placed.find(q => q && q.sourceId === id).mesh.position);
      return [(ps[1].x - ps[0].x) / 2, 0, (ps[1].z - ps[0].z) / 2];
    }, [hs[0].id, hs[1].id]);
    await lookAt(page, hs[0].id, [0, 55, 80], gap);
  }
  await shot(page, '10-cut-through-slab');

  /* Export: Download selected STL, then the canonical checker on that file */
  if (hs.length) {
    await selectModel(page, hs[0].id);
    await page.evaluate(() => { const e = document.getElementById('btn-export-model'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
    page.once('dialog', d => d.accept());
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#btn-export-model')]);
    const file = path.join(TMP, dl.suggestedFilename());
    await dl.saveAs(file);
    const n = parseBinarySTL(fs.readFileSync(file));
    const v = canonical(file);
    check('Export wrote the half as an STL with every triangle', n === hs[0].tris, path.basename(file) + ', ' + n + ' triangles, ' + fs.statSync(file).size + ' bytes');
    check('...and the canonical checker passes the file', v.verdict === 'PASS' && v.open_edges === 0 && v.nonmanifold_edges === 0 &&
      v.euler_characteristic === 2 && v.self_intersection.pierce === 0,
      'open ' + v.open_edges + ', nm ' + v.nonmanifold_edges + ', chi ' + v.euler_characteristic + ', pierce ' +
      v.self_intersection.pierce + ', coplanar ' + v.self_intersection.coplanar + ', volume ' + v.signed_volume.toFixed(2) + ', ' + v.verdict);
    NUM.export = { file: path.basename(file), bytes: fs.statSync(file).size, triangles: n, verdict: v.verdict,
      open: v.open_edges, nm: v.nonmanifold_edges, chi: v.euler_characteristic, pierce: v.self_intersection.pierce,
      coplanar: v.self_intersection.coplanar, volume: v.signed_volume, slivers: v.sliver_tris };
    await closeMenus(page);
  }

  console.log('\n=== 6. a 4000 x 4000 picture at 0.1 mm/sample is refused ===');
  const pngB64 = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 4000; c.height = 4000;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 4000, 4000); g.addColorStop(0, '#111'); g.addColorStop(1, '#eee');
    x.fillStyle = g; x.fillRect(0, 0, 4000, 4000);
    x.strokeStyle = '#000'; x.lineWidth = 24;
    for (let r = 200; r < 2000; r += 300) { x.beginPath(); x.arc(2000, 2000, r, 0, 2 * Math.PI); x.stroke(); }
    const blob = await new Promise(res => c.toBlob(res, 'image/png'));
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  });
  await openCard(page);
  await pickFile(page, { name: 'big-4000.png', mimeType: 'image/png', buffer: Buffer.from(pngB64, 'base64') });
  await setCard(page, { width: 60, base: 1, relief: 2, detail: 0.1, levels: 2, bright: false });
  const bigLine = await triLine(page);
  const nBig = await page.evaluate(() => state.models.length);
  const undoBig = await page.evaluate(() => state.undoStack.length);
  await page.click('#btn-relief-make');
  await page.waitForFunction(() => /refused/i.test(document.getElementById('status').textContent), null, { timeout: 60000 });
  const refusal = await statusOf(page);
  const sug = /Detail ([\d.]+) mm\/sample fits/.exec(refusal);
  check('the picture is 4000 x 4000', await page.evaluate(() => { const p = window.nsoReliefPicture(); return p.w === 4000 && p.h === 4000; }));
  check('refused, by name, with the Detail that fits', /Picture refused - nothing made/.test(refusal) && /400,000 budget/.test(refusal) && !!sug,
    refusal.trim());
  check('the card\'s line showed the count it refused', /1,449,612 triangles/.test(bigLine) && /1,449,612 triangles/.test(refusal), bigLine);
  check('nothing was made, added or pushed onto Undo', await page.evaluate(() => state.models.length) === nBig &&
    await page.evaluate(() => state.undoStack.length) === undoBig);
  await shot(page, '11-refused-4000px', true);
  if (sug) {
    await setCard(page, { detail: sug[1] });
    const fitLine = await triLine(page);
    const big = await makePiece(page);
    const mBig = big && await measure(page, big);
    check('at the suggested Detail it builds, inside the budget, closed', mBig && mBig.tris <= 400000 && mBig.open === 0 && mBig.nm === 0 &&
      lineCount(fitLine) === mBig.tris, fitLine + (mBig ? ', open ' + mBig.open : ''));
    NUM.big = { refusal: refusal.trim(), line: bigLine, fitLine: fitLine, tris: mBig && mBig.tris };
    /* 364,812 triangles is the heaviest thing here; off the plate again so
       the rest of the run does not draw it every frame */
    if (big) await page.evaluate(() => undoLast());
  }
  check('...and the piece loaded first is untouched after all of it', await fingerprint(page, boxId) === boxFp);

  console.log('\n=== 7. placement: free plate, never on top of a piece ===');
  const lay = await plateLayout(page);
  const clash = [];
  for (let i = 0; i < lay.length; i++) for (let j = i + 1; j < lay.length; j++) if (overlaps(lay[i].f, lay[j].f)) clash.push(lay[i].name + ' / ' + lay[j].name);
  check('no two pieces on the plate overlap', clash.length === 0, lay.length + ' pieces' + (clash.length ? ' - ' + clash.join(', ') : ''));
  /* a plate that already holds the box, the slabs above and two halves */
  await closeMenus(page);
  await openCard(page);
  await pickFile(page, SCAN);
  await setCard(page, { width: 40, base: 1, relief: 1, detail: 1, levels: 2, bright: false });
  const small = await makePiece(page);
  const lay7 = await plateLayout(page);
  const me7 = lay7.find(q => q.id === small);
  check('a slab sent to a busy plate lands on free plate, on the bed', clearOfAll(lay7, small) && me7 && me7.onBed,
    me7 && ('x ' + me7.f.minx.toFixed(1) + '..' + me7.f.maxx.toFixed(1) + ' z ' + me7.f.minz.toFixed(1) + '..' + me7.f.maxz.toFixed(1)));
  await openCard(page);
  await setCard(page, { width: 400, detail: 2 });
  const wide = await makePiece(page);
  const layW = await plateLayout(page);
  const meW = layW.find(q => q.id === wide);
  const stW = await statusOf(page);
  check('a slab wider than the bed lands beside it, clear of every piece, and says so',
    meW && !meW.onBed && clearOfAll(layW, wide) && /no free room/.test(stW), stW.trim().slice(0, 140));
  NUM.placement = { pieces: layW.map(q => ({ name: q.name, f: q.f, onBed: q.onBed })) };
  await closeMenus(page);
  await page.evaluate(() => framePlateHome());
  await shot(page, '12-plate-placement', true);

  console.log('\n=== 8. HEIC the browser cannot read ===');
  await openCard(page);
  const picBefore = await page.evaluate(() => JSON.stringify(window.nsoReliefPicture()));
  await page.evaluate(() => { document.getElementById('status').textContent = ''; });
  await page.setInputFiles('#relief-file', { name: 'IMG_0001.HEIC', mimeType: 'image/heic',
    buffer: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(512, 7)]) });
  await page.waitForFunction(() => /refused/i.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  const heic = (await statusOf(page)).trim();
  check('a HEIC this browser cannot decode is refused in plain words',
    /this browser can't read HEIC photos; export it as JPEG or use Safari/.test(heic) && !/could not decode/.test(heic), heic);
  check('...and the picture already on the card stays', await page.evaluate(() => JSON.stringify(window.nsoReliefPicture())) === picBefore);
  await shot(page, '13-heic-refused', true);

  const errs = logs.filter(l => /pageerror|\[error\]/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));

  if (KEEP) {
    fs.writeFileSync(path.join(OUT, 'drive-numbers.json'), JSON.stringify(NUM, null, 2) + '\n');
    console.log('\n   numbers: ' + path.relative(ROOT, path.join(OUT, 'drive-numbers.json')));
  }
  console.log('\n' + passes + ' passed, ' + fails + ' failed');
  if (fails) { console.log('failing:'); for (const f of FAILED) console.log('  - ' + f); }
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exitCode = fails ? 1 : 0;
}).catch(e => { console.error(e); process.exit(1); });
