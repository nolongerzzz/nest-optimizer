/* Paint's arming against the other click-owning modes, driven through the
   real app.
     node tools/nso_paint_arming_test.js        exit 0 = every gate held

   app-core's onCanvasPointerDown asks the picking modes in a fixed order and
   returns at the first one that claims the click: Paint, Carve, Seat here,
   the brush, Measure, then the Soften and Cap picks. Paint is asked FIRST,
   so a mode still armed when paint goes live does not merely queue behind it
   - it never fires again, and its button sits lit and dead until the user
   works out that paint is on.

   Every other tool in that list carries a disarmOthers(). Paint carried
   three flag writes (soften, cap, center lock) and named none of the four
   tools with a button: Carve, Seat here, the brush and Measure all stayed
   armed. This check is that they do not, from EITHER paint button, that the
   button state goes with the flag rather than being written behind its back,
   and that none of it touches a piece - the canonical checker runs over the
   piece before and after, because arming is not a bake.  */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, selectModel, ROOT } = require('./nso_app_harness');

const fx = f => path.join(ROOT, 'fixtures', f);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-paintarm-'));
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};

function writeBinarySTL(file, soup) {
  const n = soup.length / 9;
  const buf = Buffer.alloc(84 + n * 50);
  buf.writeUInt32LE(n, 80);
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50, s = i * 9;
    const ax = soup[s], ay = soup[s + 1], az = soup[s + 2];
    const ux = soup[s + 3] - ax, uy = soup[s + 4] - ay, uz = soup[s + 5] - az;
    const vx = soup[s + 6] - ax, vy = soup[s + 7] - ay, vz = soup[s + 8] - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz) || 1;
    buf.writeFloatLE(nx / L, o); buf.writeFloatLE(ny / L, o + 4); buf.writeFloatLE(nz / L, o + 8);
    for (let k = 0; k < 9; k++) buf.writeFloatLE(soup[s + k], o + 12 + k * 4);
  }
  fs.writeFileSync(file, buf);
}
function gate(file, extra) {
  const args = [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--gate', '--json'].concat(extra || []);
  let out, code = 0;
  try { out = execFileSync('python3', args, { encoding: 'utf8' }); }
  catch (e) { out = e.stdout || ''; code = e.status == null ? 1 : e.status; }
  let j = null;
  try { j = JSON.parse(out); } catch (e) { /* leave null */ }
  return { code, j };
}
const clean = g => !!(g.j && g.code === 0 && g.j.verdict === 'PASS' &&
  g.j.open_edges === 0 && g.j.nonmanifold_edges === 0 && g.j.odd_edges === 0 &&
  g.j.inconsistent_winding_edges === 0 && g.j.degenerate_tris === 0 &&
  g.j.self_intersection && g.j.self_intersection.pierce === 0);
const gsum = g => g.j ? ('tris ' + g.j.triangles + ', open ' + g.j.open_edges + ', nm ' + g.j.nonmanifold_edges +
  ', odd ' + g.j.odd_edges + ', wind ' + g.j.inconsistent_winding_edges + ', deg ' + g.j.degenerate_tris +
  ', pierce ' + (g.j.self_intersection ? g.j.self_intersection.pierce : '?') + ', ' + g.j.verdict) : 'checker gave no JSON';

/* The four tools with a button, each with the flag app-core routes on and
   the way that flag is read. Kept as data so the roster is one list and a
   tool added later is one row, not another hand-written pair of cases. */
const TOOLS = [
  { name: 'Carve',     btn: 'btn-carve',      read: 'return !!state.carveArmed;' },
  { name: 'Seat here', btn: 'btn-seat-here',  read: 'return !!state.seatHereArmed;' },
  { name: 'Brush',     btn: 'btn-brush',      read: "return typeof window.nsoBrushArmed === 'function' ? !!window.nsoBrushArmed() : null;" },
  { name: 'Measure',   btn: 'btn-measure',    read: 'return !!state.measureOn;' }
];
const PAINT = [
  { name: 'Paint Excluded', btn: 'btn-mask-paint',  mode: 'exclude' },
  { name: 'Paint Selected', btn: 'btn-mask-select', mode: 'select' }
];

/* Reads the flag AND the button, because half the point is that the two
   agree: a flag written behind a button's back leaves it lit and dead. */
const readTool = (page, t) => page.evaluate(a => {
  const armed = new Function(a.read)();
  const b = document.getElementById(a.btn);
  return { armed, lit: b ? b.classList.contains('is-armed') : null,
           pressed: b ? b.getAttribute('aria-pressed') : null };
}, { read: t.read, btn: t.btn });

/* Back to a known state without clicking anything: every later case starts
   from the same place whatever the last one left behind. */
const resetAll = page => page.evaluate(() => {
  if (state.maskPaint) {
    const b = document.getElementById(state.maskPaint === 'select' ? 'btn-mask-select' : 'btn-mask-paint');
    if (b) b.click();
  }
  ['btn-carve', 'btn-seat-here', 'btn-brush', 'btn-measure'].forEach(id => {
    const b = document.getElementById(id);
    const on = id === 'btn-carve' ? state.carveArmed
      : id === 'btn-seat-here' ? state.seatHereArmed
      : id === 'btn-brush' ? (typeof window.nsoBrushArmed === 'function' && window.nsoBrushArmed())
      : state.measureOn;
    if (on && b) b.click();
  });
  state.softenArmed = false; state.capArmed = false; state.centerLockArmed = false;
});

const rawOf = (page, id) => page.evaluate(i =>
  Array.from(state.models.find(x => x.id === i).rawTris), id);

withApp(async (page, logs) => {
  console.log('\n=== 1. a real piece, every tool panel open ===');
  const id = await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
  await selectModel(page, id);
  await page.evaluate(() => { document.querySelectorAll('details').forEach(d => { d.open = true; }); });
  const present = await page.evaluate(ids => ids.filter(i => !document.getElementById(i)),
    TOOLS.map(t => t.btn).concat(PAINT.map(p => p.btn)));
  check('every button in the roster exists on the page', present.length === 0, present.join(','));
  const rawBefore = await rawOf(page, id);
  console.log('   piece: ' + rawBefore.length / 9 + ' raw triangles');

  console.log('\n=== 2. each tool really arms on its own ===');
  for (const t of TOOLS) {
    await resetAll(page);
    await page.click('#' + t.btn);
    const s = await readTool(page, t);
    check(t.name + ' arms from its button', s.armed === true, JSON.stringify(s));
  }

  console.log('\n=== 3. arming either paint mode disarms all four ===');
  for (const p of PAINT) {
    for (const t of TOOLS) {
      await resetAll(page);
      await page.click('#' + t.btn);
      const before = await readTool(page, t);
      await page.click('#' + p.btn);
      const after = await readTool(page, t);
      const paint = await page.evaluate(() => state.maskPaint);
      const detail = t.name + ' ' + JSON.stringify(before) + ' -> ' + JSON.stringify(after) +
                     ', paint=' + paint;
      check(p.name + ' over ' + t.name + ': armed before, disarmed after',
        before.armed === true && after.armed === false, detail);
      check(p.name + ' over ' + t.name + ': the button follows the flag',
        after.lit === false && after.pressed === 'false', JSON.stringify(after));
      check(p.name + ' over ' + t.name + ': paint itself came up in the right mode',
        paint === p.mode, String(paint));
    }
  }

  console.log('\n=== 4. the three flag-only picks go down too ===');
  for (const p of PAINT) {
    await resetAll(page);
    await page.evaluate(() => {
      state.softenArmed = true; state.capArmed = true; state.centerLockArmed = true;
    });
    await page.click('#' + p.btn);
    const flags = await page.evaluate(() => ({
      soften: !!state.softenArmed, cap: !!state.capArmed, clock: !!state.centerLockArmed,
      paint: state.maskPaint }));
    check(p.name + ' clears the Soften, Cap and Center lock picks',
      !flags.soften && !flags.cap && !flags.clock && flags.paint === p.mode, JSON.stringify(flags));
  }

  console.log('\n=== 5. switching between the two paint modes is not a disarm ===');
  /* Paint is deliberately NOT in its own disarm list: Excluded -> Selected is
     a mode change, and clicking the other paint button to "turn paint off"
     would only switch modes again. */
  await resetAll(page);
  await page.click('#btn-mask-paint');
  const m1 = await page.evaluate(() => state.maskPaint);
  await page.click('#btn-mask-select');
  const m2 = await page.evaluate(() => state.maskPaint);
  await page.click('#btn-mask-select');
  const m3 = await page.evaluate(() => state.maskPaint);
  console.log('   ' + JSON.stringify([m1, m2, m3]));
  check('Excluded -> Selected switches mode rather than stopping paint',
    m1 === 'exclude' && m2 === 'select', JSON.stringify([m1, m2]));
  check('and the live button still stops it', m3 === false, String(m3));

  console.log('\n=== 6. the other direction still works - no regression ===');
  /* Seat here, the brush and Measure each disarmed paint on their own way in
     before this change, and must still: the fix gave PAINT a list, it did not
     touch theirs.

     Carve is the exception and it is NOT gated here, because it is not this
     change's doing. app-carve.js's setArmed() opens with the comment "one
     click-owning mode at a time, the way Measure's disarmOthers does it" and
     then disarms Seat here alone - not paint, not Measure, not the brush, not
     the center lock. So arming Carve over live paint leaves Carve lit and
     dead, the same shape as the defect fixed here, in the opposite direction
     and in another file. Measured and printed on every run so it cannot rot
     unnoticed; fixing it is app-carve.js's own scoped pass.

     ARMS-OVER-PAINT ROSTER, as measured today:
       Seat here  disarms paint
       Brush      disarms paint
       Measure    disarms paint
       Carve      DOES NOT - app-carve.js setArmed(), open finding */
  const CARVE_DISARMS_PAINT_TODAY = false;
  for (const p of PAINT) {
    for (const t of TOOLS) {
      await resetAll(page);
      await page.click('#' + p.btn);
      const paintBefore = await page.evaluate(() => state.maskPaint);
      await page.click('#' + t.btn);
      const paintAfter = await page.evaluate(() => state.maskPaint);
      const tool = await readTool(page, t);
      const detail = paintBefore + ' -> ' + paintAfter + ', ' + t.name + ' ' + JSON.stringify(tool);
      if (t.btn === 'btn-carve' && !CARVE_DISARMS_PAINT_TODAY) {
        console.log('  note ' + t.name + ' over ' + p.name + ' leaves paint live (open finding, app-carve.js) - ' + detail);
        check(t.name + ' at least still arms itself over ' + p.name, tool.armed === true, detail);
        continue;
      }
      check(t.name + ' still disarms ' + p.name,
        paintBefore === p.mode && paintAfter === false && tool.armed === true, detail);
    }
  }

  console.log('\n=== 7. none of this touched the piece ===');
  await resetAll(page);
  const rawAfter = await rawOf(page, id);
  check('raw triangle soup byte-for-byte unchanged',
    rawBefore.length === rawAfter.length && rawBefore.every((v, i) => v === rawAfter[i]),
    rawBefore.length / 9 + ' tris -> ' + rawAfter.length / 9);
  check('no paint was applied by any of the arming',
    await page.evaluate(i => nsoMaskCount(state.models.find(x => x.id === i)), id) === 0);

  console.log('\n=== 8. canonical checker, tools/mesh_validate.py ===');
  for (const [label, soup] of [['piece before', rawBefore], ['piece after', rawAfter]]) {
    const f = path.join(tmp, label.replace(/\W+/g, '_') + '.stl');
    writeBinarySTL(f, Float32Array.from(soup));
    const g = gate(f);
    console.log('   ' + label + ': ' + gsum(g));
    check(label + ' gates clean', clean(g), gsum(g));
  }

  console.log('\n=== 9. nothing else on the page broke ===');
  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));
  const missing = await page.evaluate(() => ['btn-mask-paint','btn-mask-select','btn-mask-clear',
    'btn-soften','btn-carve','btn-measure','btn-brush','btn-seat-here'].filter(i => !document.getElementById(i)));
  check('every mode button still present', missing.length === 0, missing.join(','));

  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
