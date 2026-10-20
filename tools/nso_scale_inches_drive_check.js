/* The Scale card's mm | in toggle, driven through the real app with real
   clicks and a real keyboard. Display and entry only: the engines stay in
   mm, the card converts at its edge. The fields are live - typed, then left
   with Tab, which is what commits a value (there is no Set).
   node tools/nso_scale_inches_drive_check.js               exit 0 = every gate held
   node tools/nso_scale_inches_drive_check.js --shots DIR   also write DIR/*.png
                                                            (a scratch directory -
                                                            no screenshot is committed)

   For a Stock box, a Stock tube and a Stock cylinder (a rod):
     a  inches shown: the readout, every box, its unit label, aria-label and
        min / max / step say inches; nothing on the card says mm but the
        toggle's own "mm" segment; Whole x is untouched
     b  an inch value typed and the field left lands on exactly the soup
        the engine gives for value x 25.4 mm, run headless on the same piece
     c  toggling in -> mm -> in -> mm leaves the soup, its size and the
        undo stack exactly as they were, and the mm card exactly as it was
     d  refusals name their limit in inches - the nozzle floor, Shorten's
        most, a rod's zero, "a positive number of inches" - and leave the
        piece unchanged
   then
     e  Fit to plate's message and the build-volume verdict in inches
     f  the choice survives a reload; with localStorage unavailable the card
        comes up in mm and the toggle still works
   and the three Scale polish items, with inches shown:
     -  the upright tube's axis row is Height, and Height typed in inches
        lands on the engine's soup for value x 25.4
     -  the Offset row's sentence reads its lid strap in inches
     -  Longest on a bar turned 90° about Z and tipped, baked into its
        geometry, says the long edge before, in inches

   Every number is printed; the PR quotes them. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, statusOf, openMenuFor, ROOT } = require('./nso_app_harness');
const { writeSTL } = require('./nso_stl_io.js');
const BOX = require('./nso_box_fixtures.js');

const SHOTS = (() => {
  const i = process.argv.indexOf('--shots');
  if (i < 0) return null;
  const dir = process.argv[i + 1];
  if (!dir || dir.startsWith('--')) { console.error('--shots needs a directory (a scratch one: no PNG goes in the repo)'); process.exit(2); }
  return path.resolve(dir);
})();
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

const IN = 25.4;
const inch = mm => (mm / IN).toFixed(3);
/* The test's own mm -> in rewrite of an engine sentence, written apart from
   app-scale.js's so the two can disagree: every "N mm" figure, and every
   "A × B mm" / "A of B mm" run, to 3 places. */
const toInches = s => s.replace(/(-?\d+(?:\.\d+)?)((?:\s*(?:×|→)\s*|\s+of(?:\s+its)?\s+)(-?\d+(?:\.\d+)?))*\s?mm\b/g,
  m => m.replace(/-?\d+(?:\.\d+)?/g, n => inch(+n)).replace(/\s?mm$/, ' in'));

const select = (page, id) => page.evaluate(i => {
  const idx = state.placed.findIndex(p => p.sourceId === i);
  selectPlaced(idx);
}, id);

const ROWS = ['length', 'width', 'height', 'ring-outer', 'ring-bore', 'ring-wall', 'rod-diameter', 'offset', 'factor', 'longest'];

const card = async page => {
  await openMenuFor(page, '#scale-readout');
  await page.waitForFunction(() => document.getElementById('scale-readout').dataset.stale === '0', null, { timeout: 30000 });
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  return page.evaluate(rows => {
    const m = getActiveModel();
    const shown = {}, val = {}, unit = {}, aria = {}, lim = {};
    for (const r of rows) {
      const row = document.getElementById('scale-' + r + '-row');
      shown[r] = !!row && getComputedStyle(row).display !== 'none';
      const inp = row && row.querySelector('input');
      val[r] = inp ? inp.value : null;
      aria[r] = inp ? inp.getAttribute('aria-label') : null;
      lim[r] = inp ? [inp.min, inp.max, inp.step].join(' / ') : null;
      const h = row && row.querySelector('.hint');
      unit[r] = h ? h.textContent : null;
    }
    const pressed = ['mm', 'in'].filter(u => document.getElementById('btn-scale-unit-' + u).getAttribute('aria-pressed') === 'true');
    const titles = Array.from(document.querySelectorAll('#scale-card button[title], #scale-rows input[title]')).map(b => b.title);
    // The section rows' own titles: a shape row (#186) is never shown on a
    // ring, rod or box, and its capsule Diameter says "the overall length".
    const sectionTitles = Array.from(document.querySelectorAll('#scale-card button[title], #scale-rows input[title]'))
      .filter(b => !/^scale-(cap|ell|torus)-/.test(b.id)).map(b => b.title);
    // everything the card says, the toggle aside: its text, aria-labels and titles
    const c = document.getElementById('scale-card').cloneNode(true);
    c.querySelector('.scale-unit').remove();
    const said = [c.textContent].concat(Array.from(c.querySelectorAll('[aria-label]')).map(e => e.getAttribute('aria-label')),
      Array.from(c.querySelectorAll('[title]')).map(e => e.title)).join(' | ');
    return {
      readout: document.getElementById('scale-readout').textContent,
      note: document.getElementById('scale-offset-note').textContent,
      shown, val, unit, aria, lim, titles, sectionTitles, said, pressed: pressed.join(),
      rows: rows.filter(r => shown[r]).join(','),
      size: m ? { x: m.size.x, y: m.size.y, z: m.size.z } : null,
      soup: m ? Array.from(m.rawTris).join(',') : '',
      undo: state.undoStack.length
    };
  }, ROWS);
};

const setFields = (page, vals) => page.evaluate(v => {
  for (const id of Object.keys(v)) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.value = v[id] === null ? '' : String(v[id]);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}, vals);

async function makeStock(page, shape) {
  const n = await page.evaluate(() => state.models.length);
  await openMenuFor(page, '#btn-stock-' + shape);
  await page.click('#btn-stock-' + shape);
  await page.waitForFunction(k => state.models.length > k, n, { timeout: 30000 });
  const id = await page.evaluate(() => state.models[state.models.length - 1].id);
  await select(page, id);
  return id;
}

async function unit(page, u) {
  await openMenuFor(page, '#btn-scale-unit-' + u);
  await page.click('#btn-scale-unit-' + u);
  return card(page);
}

async function clickScale(page, sel, waitRe) {
  await openMenuFor(page, sel);
  await page.evaluate(() => { document.getElementById('status').textContent = ''; });
  await page.click(sel);
  await page.waitForFunction(re => new RegExp(re).test(document.getElementById('status').textContent),
    waitRe, { timeout: 60000 });
  return statusOf(page);
}
/* Type into a field as a person does, without leaving it. */
async function type(page, input, value) {
  await openMenuFor(page, '#' + input);
  await page.focus('#' + input);
  await page.keyboard.press('Control+A');
  if (String(value) === '') await page.keyboard.press('Backspace');
  else await page.keyboard.type(String(value));
}
/* Type, then leave the field with Tab - which is what commits it. */
async function typeAndLeave(page, input, value, waitRe) {
  await type(page, input, value);
  await page.evaluate(() => { document.getElementById('status').textContent = ''; });
  await page.keyboard.press('Tab');
  await page.waitForFunction(re => new RegExp(re).test(document.getElementById('status').textContent),
    waitRe, { timeout: 60000 });
  return statusOf(page);
}
async function undo(page) {
  await page.evaluate(() => { document.getElementById('status').textContent = ''; });
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
}
async function shot(page, name) {
  if (!SHOTS) return;
  await openMenuFor(page, '#scale-readout');
  await page.screenshot({ path: path.join(SHOTS, name + '.png') });
  console.log('   screenshot ' + path.join(SHOTS, name + '.png'));
}

/* Keep the selected piece's soup as it stands, for the headless replay. */
const keepSoup = page => page.evaluate(() => { window.__nsoBefore = getActiveModel().rawTris; });
/* Did the card's field land on exactly the soup the engine gives for `run`
   on the kept soup? run is a string - evaluated in the page. */
const sameAsEngine = (page, run) => page.evaluate(src => {
  const soup = window.__nsoBefore, m = getActiveModel();
  const r = (new Function('soup', 'm', 'return ' + src))(soup, m);
  const got = m.rawTris;
  if (!r || !r.ok) return { ok: false, why: 'engine refused: ' + (r && r.reason) };
  if (got === soup) return { ok: false, why: 'the piece did not change' };
  if (r.tris.length !== got.length) return { ok: false, why: 'length ' + r.tris.length + ' vs ' + got.length };
  for (let i = 0; i < got.length; i++) if (r.tris[i] !== got[i]) return { ok: false, why: 'float ' + i + ': ' + r.tris[i] + ' vs ' + got[i] };
  return { ok: true, floats: got.length };
}, run);
const unchanged = page => page.evaluate(() => getActiveModel().rawTris === window.__nsoBefore);

/* (a) and (c) for one piece. `expect` is the inch readout and the visible
   rows' inch values, built here from the reading's own mm numbers. */
async function unitsHold(page, label, expect) {
  const mm = await unit(page, 'mm');
  console.log('   mm card:  ' + mm.readout + '   ' + JSON.stringify(mm.val));
  check(label + ': mm pressed, the mm card', mm.pressed === 'mm' && mm.unit.length === 'mm', mm.pressed);
  const c = await unit(page, 'in');
  console.log('   in card:  ' + c.readout + '   ' + JSON.stringify(c.val));
  console.log('   in units: ' + JSON.stringify(c.unit));
  console.log('   in limits ' + JSON.stringify(c.lim));
  check('(a) ' + label + ': readout in inches, figure for figure', c.readout === expect.readout, 'want "' + expect.readout + '"');
  const vis = Object.keys(expect.val);
  check('(a) ' + label + ': every box shown is the reading / 25.4, to 3 places (' + vis.join(', ') + ')',
    c.rows === mm.rows && vis.every(r => c.val[r] === expect.val[r]) && c.rows.split(',').every(r => r === 'factor' || r in expect.val),
    JSON.stringify(expect.val));
  check('(a) ' + label + ': Whole × untouched - 1, its own limits and label',
    c.val.factor === '1' && c.lim.factor === mm.lim.factor && c.aria.factor === mm.aria.factor, c.lim.factor + ' ' + c.aria.factor);
  const lengths = ROWS.filter(r => r !== 'factor');
  check('(a) ' + label + ': every box\'s aria-label says inches, none says mm',
    lengths.every(r => /\binches\b/.test(c.aria[r]) && !/\bmm\b/.test(c.aria[r])), JSON.stringify(c.aria));
  // A ring's or rod's axis goes by its row's name: stood up, "height kept"
  // and "the height is held" - in either unit.
  const held = expect.axisWord || 'length';
  check('(a) ' + label + ': unit labels "in" and "in, wall kept"; the holds without a unit unchanged but for the axis word (' + held + ')',
    ['length', 'width', 'height', 'longest'].every(r => c.unit[r] === 'in') && c.unit.offset === 'in, wall kept' &&
    c.unit['ring-outer'] === 'bore kept' && c.unit['ring-bore'] === 'outer kept' && c.unit['ring-wall'] === 'outer kept' &&
    c.unit['rod-diameter'] === held + ' kept' &&
    mm.unit['rod-diameter'] === held + ' kept',
    JSON.stringify(c.unit));
  const heldTitles = t => t.filter(x => /\b(length|height|width) is held\b/.test(x));
  check('(a) ' + label + ': Outer Ø, Bore Ø and Diameter say "the ' + held + ' is held", in mm and in inches',
    heldTitles(c.sectionTitles).length === 3 && heldTitles(c.sectionTitles).every(x => x.indexOf('the ' + held + ' is held') >= 0) &&
    heldTitles(mm.sectionTitles).every(x => x.indexOf('the ' + held + ' is held') >= 0), heldTitles(c.sectionTitles).join(' | '));
  check('(a) ' + label + ': step 0.1 mm -> 0.005 in; limits converted onto that grid',
    ['length', 'width', 'height', 'ring-outer', 'ring-bore', 'ring-wall', 'rod-diameter'].every(r => c.lim[r] === '0.005 / 78.74 / 0.005') &&
    c.lim.offset === '-0.785 / 0.785 / 0.005' && c.lim.longest === '0.005 / 39.37 / 0.005', JSON.stringify(c.lim));
  check('(a) ' + label + ': nothing the card says - text, aria-labels, titles - names mm', !/\bmm\b/.test(c.said),
    (c.said.match(/.{0,30}\bmm\b.{0,10}/g) || []).join(' | '));

  // (c) toggling is display only
  await unit(page, 'mm');
  await unit(page, 'in');
  const back = await unit(page, 'mm');
  const same = ['readout', 'rows', 'soup', 'said'].every(k => back[k] === mm[k]) &&
    ['val', 'unit', 'aria', 'lim', 'size'].every(k => JSON.stringify(back[k]) === JSON.stringify(mm[k])) && back.undo === mm.undo;
  check('(c) ' + label + ': in -> mm -> in -> mm: soup, size and undo stack untouched, the mm card exactly as it was',
    same && back.soup === mm.soup && c.soup === mm.soup && c.undo === mm.undo, 'undo ' + mm.undo + ' -> ' + c.undo + ' -> ' + back.undo);
  await unit(page, 'in');
  return mm;
}

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const reading = () => page.evaluate(() => {
    const s = NSO_scaleSectionOf(getActiveModel());
    const v = s.verbs;
    return { shape: s.shape, hollow: s.hollow, sizes: s.sizes, lengthMm: s.lengthMm, wallMm: s.wallMm,
             outer: s.outer && s.outer.diameterMm, bore: s.bore && s.bore.diameterMm,
             L: v.length && v.length.mm, W: v.width && v.width.mm, H: v.height && v.height.mm, axisL: v.length && v.length.axisIdx,
             axisH: v.height && v.height.axisIdx };
  });

  console.log('\n=== Box (Stock box) ===');
  await makeStock(page, 'box');
  const b = await reading();
  const bL = Math.max(b.sizes.w, b.sizes.d), bW = Math.min(b.sizes.w, b.sizes.d);
  const bmm = await unitsHold(page, 'box', {
    readout: 'Bar ' + inch(bL) + ' L × ' + inch(bW) + ' W × ' + inch(b.sizes.h) + ' H · fits A1 Mini',
    val: { length: inch(b.L), width: inch(b.W), height: inch(b.H), offset: '' }
  });
  await shot(page, '01-box-inches');
  // The Offset row's sentence, figure by figure in the unit shown.
  const bin = await card(page);
  console.log('   Offset sentence: "' + bmm.note + '" / "' + bin.note + '"');
  check('(a) box: the Offset sentence in mm, then in inches - 0.6 mm -> 0.024 in',
    bmm.note === 'Thin features keep their thickness: a 0.6 mm lid strap stays 0.6 mm.' &&
    bin.note === 'Thin features keep their thickness: a 0.024 in lid strap stays 0.024 in.', bin.note);
  // A number typed and the toggle clicked: the click leaves the field, so
  // the value is kept, then read in the new unit.
  await type(page, 'scale-length', '1.5');
  const t1 = await unit(page, 'mm'), t2 = await unit(page, 'in');
  check('(c) 1.5 in typed, then the toggle clicked: the edit is kept, as one step - 38.1 mm, 1.500 in on the way back; the other boxes re-read',
    t1.val.length === '38.1' && t2.val.length === '1.500' && t1.val.width === bmm.val.width && t2.val.width === inch(b.W) &&
    t1.undo === bmm.undo + 1 && t2.undo === t1.undo, t1.val.length + ' / ' + t2.val.length + ', undo ' + bmm.undo + ' -> ' + t2.undo);
  await undo(page);
  // (b) Length 1.25 in: exactly NSO_extendRaw at 1.25 x 25.4 mm on the same soup
  await keepSoup(page);
  let st = await typeAndLeave(page, 'scale-length', '1.25', 'Length (done|refused)|stood down');
  console.log('   Length 1.25 in: ' + st);
  let eq = await sameAsEngine(page, 'NSO_extendRaw(soup, { axis: ' + b.axisL + ', length: 1.25 * 25.4 })');
  check('(b) box Length 1.25 in = NSO_extendRaw(length 31.75 mm) on the same soup, float for float', eq.ok, eq.why || eq.floats + ' floats');
  check('(b) ...and says so in inches: ' + inch(b.L) + ' → 1.250 in, no mm', st.indexOf(inch(b.L) + ' → 1.250 in') > 0 && !/\bmm\b/.test(st), st);
  let c = await card(page);
  check('(b) ...the Length box re-reads 1.250', c.val.length === '1.250', c.val.length);
  await undo(page);
  await keepSoup(page);
  st = await typeAndLeave(page, 'scale-offset', '0.0625', 'Offset (done|refused)|stood down');
  console.log('   Offset 0.0625 in: ' + st);
  eq = await sameAsEngine(page, 'NSO_scaleOffsetRaw(soup, 0.0625 * 25.4, { innerWord: "bore or pocket" })');
  check('(b) box Offset 0.0625 in = NSO_scaleOffsetRaw(1.5875 mm), float for float', eq.ok, eq.why || eq.floats + ' floats');
  check('(b) ...echoed as typed, not cut to 3 places: "outward 0.0625 in"', /^Offset done - outward 0\.0625 in, /.test(st) && !/\bmm\b/.test(st), st);
  await undo(page);
  await keepSoup(page);
  st = await typeAndLeave(page, 'scale-factor', '2', 'Scale done|refused|stood down');
  console.log('   Whole × 2: ' + st);
  eq = await sameAsEngine(page, 'NSO_scaleSoup(soup, { factor: 2 })');
  check('(b) Whole × 2 is a plain factor in either unit', eq.ok && /, size [\d.]+ x [\d.]+ x [\d.]+ in, open 0/.test(st), eq.why || st);
  await undo(page);
  // (d) refusals
  await keepSoup(page);
  st = await typeAndLeave(page, 'scale-offset', '-1', 'Offset (done|refused)|stood down');
  console.log('   Offset -1 in: ' + st);
  check('(d) box Offset -1 in refused at the nozzle floor: 0.42 mm -> 0.017 in, 0.4 mm nozzle -> 0.016 in',
    st === 'Offset refused - piece unchanged (its ' + 'XYZ'[[b.sizes.w, b.sizes.d, b.sizes.h].indexOf(Math.min(b.sizes.w, b.sizes.d, b.sizes.h))] +
      ' size of ' + inch(Math.min(b.sizes.w, b.sizes.d, b.sizes.h)) + ' in would go through zero, under the 0.017 in floor for a 0.016 in nozzle' +
      ' - the most it can shrink is ' + inch(Math.floor((Math.min(b.sizes.w, b.sizes.d, b.sizes.h) - 0.42) / 2 * 100) / 100) + ' in)' && !/\bmm\b/.test(st) && await unchanged(page), st);
  st = await typeAndLeave(page, 'scale-width', '-1', 'Width (done|refused)|stood down');
  console.log('   Width -1 in: ' + st);
  check('(d) box Width -1 in: "must be a positive number of inches"', st === 'Width refused - piece unchanged (Width must be a positive number of inches)' && await unchanged(page), st);
  const u0 = await card(page);
  await type(page, 'scale-offset', '');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(300);
  const u1 = await card(page);
  check('(d) an empty Offset left: nothing committed, the piece and the undo stack as they were',
    u1.undo === u0.undo && await unchanged(page) && u1.val.offset === '', 'undo ' + u0.undo + ' -> ' + u1.undo);

  // Shorten's refusal needs a piece with walls: the 100 x 40 x 25 tray of
  // tools/nso_scale_card_drive_check.js, 2 mm walls and floor.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-scale-inches-'));
  const trayFile = path.join(tmp, 'tray_100x40x25.stl');
  writeSTL(trayFile, BOX.tray(100, 40, 25, 2, 2), 'tray 100 x 40 x 25, 2 mm walls and floor (tools/nso_box_fixtures.js)');
  await select(page, await loadSTL(page, trayFile));
  c = await card(page);
  console.log('   tray:    ' + c.readout);
  await keepSoup(page);
  const hMm = await page.evaluate(() => NSO_extendRaw(window.__nsoBefore, { axis: 2, length: 0.06 * 25.4 }).reason);
  st = await typeAndLeave(page, 'scale-height', '0.06', 'Height (done|refused)|stood down');
  console.log('   Height 0.06 in: ' + st);
  console.log('     engine in mm: ' + hMm);
  check('(d) tray Height 0.06 in refused, Shorten\'s most and the asked-for in inches, piece unchanged',
    st === 'Height refused - piece unchanged (' + toInches(hMm) + ')' && /can remove up to 0\.902 in here - asked for 0\.925 in;/.test(st) &&
    !/\bmm\b/.test(st) && await unchanged(page), st);

  console.log('\n=== Tube (Stock tube) ===');
  await makeStock(page, 'tube');
  const t = await reading();
  await unitsHold(page, 'tube', {
    readout: 'Ring Ø' + inch(t.outer) + ' outer · Ø' + inch(t.bore) + ' bore · wall ' + inch(t.wallMm) + ' · height ' + inch(t.lengthMm) + ' · fits A1 Mini',
    val: { height: inch(t.lengthMm), 'ring-outer': inch(t.outer), 'ring-bore': inch(t.bore), 'ring-wall': inch(t.wallMm) }, axisWord: 'height'
  });
  await shot(page, '02-tube-inches');
  // Stood up, the ring's axis is its own Z: the Height row, in inches.
  await keepSoup(page);
  st = await typeAndLeave(page, 'scale-height', '1.25', 'Height (done|refused)|stood down');
  console.log('   Height 1.25 in: ' + st);
  eq = await sameAsEngine(page, 'NSO_extendRaw(soup, { axis: ' + t.axisH + ', length: 1.25 * 25.4 })');
  check('(b) tube Height 1.25 in = NSO_extendRaw(Z, 31.75 mm), float for float', t.axisH === 2 && eq.ok, eq.why || eq.floats + ' floats');
  check('(b) ...and says so in inches: Z ' + inch(t.lengthMm) + ' → 1.250 in', st.indexOf('Height done - Z ' + inch(t.lengthMm) + ' → 1.250 in') === 0 &&
    !/\bmm\b/.test(st), st);
  await undo(page);
  await keepSoup(page);
  st = await typeAndLeave(page, 'scale-ring-outer', '2', 'Outer Ø (done|refused)|stood down');
  console.log('   Outer Ø 2 in: ' + st);
  eq = await sameAsEngine(page, 'NSO_ringApplyRaw(soup, "outer", 2 * 25.4)');
  check('(b) tube Outer Ø 2 in = NSO_ringApplyRaw(outer, 50.8 mm), float for float', eq.ok, eq.why || eq.floats + ' floats');
  check('(b) ...and says so in inches: the three figures after the move, the bore held',
    st === 'Outer Ø done - Ø2.000 in / bore Ø' + inch(t.bore) + ' in · wall ' + inch((50.8 - t.bore) / 2) + ' in · height held', st);
  await undo(page);
  await keepSoup(page);
  st = await typeAndLeave(page, 'scale-ring-bore', '1', 'Bore Ø (done|refused)|stood down');
  console.log('   Bore Ø 1 in: ' + st);
  eq = await sameAsEngine(page, 'NSO_ringApplyRaw(soup, "bore", 25.4)');
  check('(b) tube Bore Ø 1 in = NSO_ringApplyRaw(bore, 25.4 mm), float for float', eq.ok, eq.why || eq.floats + ' floats');
  check('(b) ...and says so in inches, the outer held',
    st === 'Bore Ø done - Ø' + inch(t.outer) + ' in / bore Ø1.000 in · wall ' + inch((t.outer - 25.4) / 2) + ' in · height held', st);
  await undo(page);
  await keepSoup(page);
  st = await typeAndLeave(page, 'scale-ring-wall', '0.01', 'Wall (done|refused)|stood down');
  console.log('   Wall 0.01 in: ' + st);
  check('(d) tube Wall 0.01 in refused under the floor, both in inches: 0.254 mm -> 0.010 in, 0.42 mm -> 0.017 in',
    st === 'Wall refused - piece unchanged (wall would be 0.010 in, under the 0.017 in floor)' && await unchanged(page), st);
  st = await typeAndLeave(page, 'scale-ring-outer', '0.1', 'Outer Ø (done|refused)|stood down');
  console.log('   Outer Ø 0.1 in: ' + st);
  check('(d) tube Outer Ø 0.1 in: it would reach the held bore, both Ø named in inches',
    st === 'Outer Ø refused - piece unchanged (outer would reach the bore - Ø0.100 outer against a Ø' + inch(t.bore) + ' bore)' &&
    await unchanged(page), st);

  console.log('\n=== Rod (Stock cylinder) ===');
  await makeStock(page, 'cylinder');
  const r = await reading();
  await unitsHold(page, 'rod', {
    readout: 'Rod Ø' + inch(r.outer) + ' · height ' + inch(r.lengthMm) + ' · fits A1 Mini',
    val: { height: inch(r.lengthMm), 'rod-diameter': inch(r.outer) }, axisWord: 'height'
  });
  await shot(page, '03-rod-inches');
  await keepSoup(page);
  st = await typeAndLeave(page, 'scale-rod-diameter', '1.1', 'Diameter (done|refused)|stood down');
  console.log('   Diameter 1.1 in: ' + st);
  eq = await sameAsEngine(page, 'NSO_ringApplyRaw(soup, "diameter", 1.1 * 25.4)');
  check('(b) rod Diameter 1.1 in = NSO_ringApplyRaw(diameter, 27.94 mm), float for float', eq.ok, eq.why || eq.floats + ' floats');
  check('(b) ...and says so in inches', /^Diameter done - Diameter Ø[\d.]+ in → Ø1\.100 in, height held$/.test(st), st);
  await undo(page);
  await keepSoup(page);
  st = await typeAndLeave(page, 'scale-height', '2', 'Height (done|refused)|stood down');
  eq = await sameAsEngine(page, 'NSO_extendRaw(soup, { axis: ' + r.axisH + ', length: 2 * 25.4 })');
  console.log('   Height 2 in: ' + st);
  check('(b) rod stood up: Height 2 in = NSO_extendRaw(Z, 50.8 mm), float for float', r.axisH === 2 && eq.ok, eq.why || eq.floats + ' floats');
  await undo(page);
  await keepSoup(page);
  st = await typeAndLeave(page, 'scale-rod-diameter', '-0.5', 'Diameter (done|refused)|stood down');
  console.log('   Diameter -0.5 in: ' + st);
  check('(d) rod Diameter -0.5 in refused, its zero named in inches',
    st === 'Diameter refused - piece unchanged (diameter would be -0.500 in - a rod needs more than zero)' && await unchanged(page), st);

  console.log('\n=== e. Fit to plate and the verdict, in inches ===');
  const tape = await loadSTL(page, path.join(ROOT, 'library', 'tape_on-edge-single.stl'));
  await select(page, tape);
  c = await card(page);
  console.log('   readout: ' + c.readout);
  check('the verdict: 5.0 mm too wide -> 0.197 in too wide for A1 Mini', / · 0\.197 in too wide for A1 Mini$/.test(c.readout), c.readout);
  await keepSoup(page);
  st = await typeAndLeave(page, 'scale-target', '7.0625', 'Scale (done|refused)|stood down');
  console.log('   Longest 7.0625 in: ' + st);
  eq = await sameAsEngine(page, 'NSO_scaleSoup(soup, { axis: "longest", targetMm: 7.0625 * 25.4 })');
  check('(b) Longest 7.0625 in = NSO_scaleSoup(longest 179.3875 mm), float for float', eq.ok, eq.why || eq.floats + ' floats');
  check('(b) ...lands on 7.0625 in (shown to 3 places), the asked-for echoed as typed', /^Scale done - longest edge 7\.283 → 7\.06[23] in \(asked 7\.0625 in, off by [-\d.e+]+ in\), factor /.test(st) && !/\bmm\b/.test(st), st);
  await undo(page);
  st = await clickScale(page, '#btn-scale-fit', 'Fit to plate|refused|stood down');
  console.log('   status:  ' + st);
  const f = 180 / 185;
  check('Fit to plate says the factor, and every size in inches, no mm',
    st.indexOf('×' + f.toFixed(6)) >= 0 && /width 7\.283 → 7\.087 in, now 7\.087 in wide, [\d.]+ in deep, [\d.]+ in tall; fits A1 Mini( \||$)/.test(st) && !/\bmm\b/.test(st), st);
  st = await clickScale(page, '#btn-scale-fit', 'Fit to plate|refused|stood down');
  console.log('   again:   ' + st);
  check('...and "already fits" in inches, the bed too', /already fits A1 Mini \(7\.087 in wide, [\d.]+ in deep, [\d.]+ in tall in 7\.087 × 7\.087 × 7\.087 in\) - nothing changed$/.test(st), st);

  console.log('\n=== Longest on a bar turned 90° about Z and tipped, in inches ===');
  // Posed with the buttons, then baked by Join's own NSO_rotateRawSoupByPlacedPose
  // (what an exporter writes): the long edge is the bar's own Z, its X 20 mm.
  await select(page, await loadSTL(page, (() => { const f = path.join(tmp, 'bar_120x20x10.stl'); writeSTL(f, BOX.bar(120, 20, 10), 'bar'); return f; })()));
  await page.evaluate(() => { rotateSelected(1); tipSelected(); });
  const turned = await page.evaluate(() => Array.from(NSO_rotateRawSoupByPlacedPose(getActiveModel().rawTris, state.placed[state.selectedIndex])));
  const turnedFile = path.join(tmp, 'bar_turned.stl');
  writeSTL(turnedFile, new Float32Array(turned), 'bar 120 x 20 x 10, turned 90 about Z and tipped, baked');
  await select(page, await loadSTL(page, turnedFile));
  c = await card(page);
  console.log('   readout: ' + c.readout + '   Longest box ' + c.val.longest);
  check('the Longest box reads the long edge, 120 mm -> 4.724 in', c.val.longest === '4.724', c.val.longest);
  await keepSoup(page);
  // The row is hidden (the bar's Height shows the same number), so the value
  // is set from script and the field's change fired, with it not focused.
  await page.evaluate(() => { document.getElementById('status').textContent = ''; });
  await setFields(page, { 'scale-target': '6' });
  await page.waitForFunction(() => /Scale (done|refused)|stood down/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
  st = await statusOf(page);
  console.log('   Longest 6 in: ' + st);
  eq = await sameAsEngine(page, 'NSO_scaleSoup(soup, { axis: "longest", targetMm: 6 * 25.4 })');
  check('Longest 6 in = NSO_scaleSoup(longest 152.4 mm), float for float', eq.ok, eq.why || eq.floats + ' floats');
  check('...says longest edge 4.724 → 6.000 in - the 120 mm edge, not its X (0.787 in)',
    /^Scale done - longest edge 4\.724 → 6\.000 in \(asked 6\.000 in, off by [-\d.e+]+ in\), factor 1\.270000,/.test(st) && !/\bmm\b/.test(st), st);
  await undo(page);

  console.log('\n=== f. The choice survives a reload ===');
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state.ready === true, null, { timeout: 30000 });
  await makeStock(page, 'cylinder');
  c = await card(page);
  console.log('   after reload: ' + c.pressed + ' · ' + c.readout + '   ' + JSON.stringify(c.val));
  check('(e) inches chosen, page reloaded: the card comes up in inches, labels and limits too',
    c.pressed === 'in' && c.readout === 'Rod Ø' + inch(r.outer) + ' · height ' + inch(r.lengthMm) + ' · fits A1 Mini' &&
    c.unit.length === 'in' && c.lim.length === '0.005 / 78.74 / 0.005' && /inches/.test(c.aria.length), JSON.stringify({ unit: c.unit.length, lim: c.lim.length }));
  await unit(page, 'mm');
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state.ready === true, null, { timeout: 30000 });
  await openMenuFor(page, '#scale-readout');
  c = await card(page);
  check('(e) mm chosen, reloaded: mm', c.pressed === 'mm' && c.unit.length === 'mm' && c.lim.length === '0.1 / 2000 / 0.1', c.pressed);
  await unit(page, 'in');
  // localStorage unavailable (a private window, blocked site data): every
  // access throws. The saved "in" is unreachable, so the card is in mm.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('storage blocked'); } });
  });
  const errsBefore = logs.filter(l => l.startsWith('[pageerror]')).length;
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state.ready === true, null, { timeout: 30000 });
  c = await card(page);
  const blocked = await page.evaluate(() => { try { localStorage; return false; } catch (e) { return true; } });
  const c2 = await unit(page, 'in');
  const scaleErrs = logs.slice(errsBefore).filter(l => l.startsWith('[pageerror]') && /scale|NSO_SCALE/i.test(l));
  console.log('   storage blocked: ' + blocked + ', card ' + c.pressed + ', after click ' + c2.pressed);
  check('(e) localStorage unavailable: the card comes up in mm, the toggle still switches, nothing thrown from Scale',
    blocked && c.pressed === 'mm' && c.unit.length === 'mm' && c2.pressed === 'in' && c2.unit.length === 'in' && scaleErrs.length === 0,
    scaleErrs.join(' | '));
  const other = logs.slice(errsBefore).filter(l => l.startsWith('[pageerror]'));
  if (other.length) console.log('   (other page errors with storage blocked, not Scale\'s: ' + other.join(' | ') + ')');

  console.log('\n=== nothing else on the page broke ===');
  const errs = logs.slice(0, errsBefore).filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));

  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
