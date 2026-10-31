#!/usr/bin/env node
/* The SUBTRACT card, laid out as a plain run of buttons - one per tool, like the
   other cards - and Hollow's live cavity.
     node tools/nso_subtract_card_drive_check.js          exit 0 = every gate held
     node tools/nso_subtract_card_drive_check.js dir      ...and the screenshots, into dir
                                                          (tools/subtract-card-out/)

   UI only: no tool's behaviour changes, and every control keeps its id. The card
   holds no <details> of its own: every tool's button is showing as soon as the
   card opens.

   GATES
     1. The card opens with its tools in order - Subtract B from A, Extract bit
        (with Carve), Punch, Hollow, Lift (with Detach flange), Split to parts -
        each button showing, no collapsing section anywhere on it.
     2. Every control the card had is still on it, under the id it had; Detach
        flange is with Lift, after its panel.
     3. Every control can be hit (no heading to open first); the ones a tool
        hides until it is armed are skipped.
     4. Shutting the card and opening it again leaves it as it was.
     5. Hollow's wall box is a box a person can read and type in (it was a 24 px
        square), and the slider and the box are one number.
     6. Moving the slider draws the cavity live inside a ghost of the piece;
        a different wall draws a different cavity; Hollow cuts what was
        previewed's wall, once, with one Undo, and the ghost is gone.
     7. The preview goes away, and the piece comes back opaque, when the card
        shuts, on leave-tool, on a different piece, and on a refusal; a wall
        under the nozzle floor is refused in the readout, not the status line.
     8. Lift still arms, Detach flange still runs, and Punch's card still opens. */

const fs = require('fs');
const path = require('path');
const { withApp, loadSTL, selectModel, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const SHOTS = process.argv[2] || null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

/* The tools, in order, with what each holds. Every id is the one the control had. */
const SECTIONS = [
  [null, 'Subtract B from A', ['btn-subtract']],
  [null, 'Extract bit',
    ['btn-extract-bit', 'btn-carve', 'carve-blade', 'carve-depth-label', 'carve-depth', 'carve-a-label', 'carve-a',
     'carve-b-label', 'carve-b', 'carve-roll-label', 'carve-roll', 'carve-readout']],
  [null, 'Punch',
    ['btn-punch', 'punch-card', 'inp-punch-dia', 'sel-punch-depth', 'punch-depth-mm-row', 'inp-punch-depth',
     'punch-pattern-row', 'punch-grid-rows', 'inp-punch-rows', 'inp-punch-cols', 'btn-punch-pitch-xy', 'punch-pitch-label',
     'inp-punch-pitch', 'punch-pitch-y-row', 'inp-punch-pitch-y', 'punch-anchor-row', 'punch-radial-rows',
     'inp-punch-count', 'inp-punch-radius', 'punch-readout', 'btn-punch-go', 'btn-punch-cancel']],
  [null, 'Hollow',
    ['btn-hollow', 'inp-hollow-mm', 'inp-hollow-slider', 'hollow-slider-read', 'hollow-readout', 'btn-hollow-safe']],
  [null, 'Lift',
    ['btn-lift', 'lift-count', 'lift-panel', 'lift-height-read', 'lift-height', 'btn-lift-strip', 'lift-strip',
     'lift-strip-rows', 'lift-strip-sum', 'btn-lift-strip-go', 'btn-lift-strip-cancel', 'lift-readout',
     'detach-tools', 'btn-detach', 'detach-readout']],
  [null, 'Split to parts', ['btn-split-parts', 'split-count', 'split-readout']]
];
/* ids that are hidden by their own state until a tool arms them (hit-test skips them):
   Carve's L for a blade with no length, Punch's card until Punch is armed, Lift's panel until Lift is */
const OWN_STATE = new Set(['carve-b-label', 'carve-b', 'punch-card', 'punch-depth-mm-row', 'punch-grid-rows', 'punch-pitch-y-row', 'punch-radial-rows',
  'inp-punch-depth', 'inp-punch-rows', 'inp-punch-cols', 'inp-punch-pitch', 'inp-punch-pitch-y', 'btn-punch-pitch-xy',
  'punch-pitch-label', 'punch-anchor-row', 'inp-punch-count', 'inp-punch-radius', 'punch-readout', 'btn-punch-go',
  'btn-punch-cancel', 'inp-punch-dia', 'sel-punch-depth', 'punch-pattern-row',
  'lift-panel', 'lift-height-read', 'lift-height', 'btn-lift-strip', 'lift-strip', 'lift-strip-rows', 'lift-strip-sum',
  'btn-lift-strip-go', 'btn-lift-strip-cancel', 'lift-readout']);

const BOX = path.join(ROOT, 'fixtures', 'box_hull_80x40x20-2.stl');
const BALL = path.join(ROOT, 'fixtures', 'fixture_sphere_curved.stl');

const sleep = (page, ms) => page.waitForTimeout(ms);
const open = (page, id) => page.evaluate(i => document.getElementById(i).open, id);
const previewOn = page => page.evaluate(() => window.nsoHollowPreview.on());
const waitPreview = (page, want, ms) => page.waitForFunction(w => window.nsoHollowPreview.on() === w, want, { timeout: ms || 15000 })
  .then(() => true, () => false);
const matState = page => page.evaluate(() => {
  const m = getActiveModel(), p = state.placed.find(q => q.sourceId === m.id), mt = p.mesh.material;
  const a = Array.isArray(mt) ? mt[0] : mt;
  return { transparent: a.transparent, opacity: a.opacity, depthWrite: a.depthWrite };
});
const cavityTris = page => page.evaluate(() => {
  const o = window.nsoHollowPreview.objects();
  return o && o.cavity ? o.cavity.geometry.attributes.position.count / 3 : 0;
});
const setSlider = (page, v) => page.evaluate(v => {
  const s = document.getElementById('inp-hollow-slider');
  s.value = String(v);
  s.dispatchEvent(new Event('input', { bubbles: true }));
}, v);
const setBox = (page, v) => page.evaluate(v => {
  const s = document.getElementById('inp-hollow-mm');
  s.value = String(v);
  s.dispatchEvent(new Event('input', { bubbles: true }));
}, v);
const cardBox = page => page.evaluate(() => {
  const b = document.querySelector('#menu-bit > .vp-menu-body').getBoundingClientRect();
  return { x: b.left, y: b.top, w: b.width, h: b.height };
});
async function shot(page, name) {
  if (!SHOTS) return;
  const b = await cardBox(page);
  const vp = page.viewportSize();
  const y0 = Math.max(0, b.y - 46), x0 = Math.max(0, b.x - 6);
  await page.screenshot({ path: path.join(SHOTS, name + '.png'),
    clip: { x: x0, y: y0, width: Math.min(b.w + 12, vp.width - x0), height: Math.min(b.h + 52, vp.height - y0) } });
}

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const id = await loadSTL(page, BOX);
  await selectModel(page, id);

  /* ---------------------------------------------------------------- 1 */
  console.log('1. a plain run of buttons');
  await page.click('#menu-bit > summary');
  await sleep(page, 200);
  const lead = await page.evaluate(ids => ({
    sections: document.querySelectorAll('#menu-bit details, #menu-bit .vp-sec').length,
    shown: ids.map(i => { const e = document.getElementById(i); const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && e.checkVisibility({ contentVisibilityAuto: true }); }) }), SECTIONS.map(s => s[2][0]));
  check('no collapsing section on the card', lead.sections === 0, String(lead.sections));
  check('each tool\'s button is showing as soon as the card opens', lead.shown.every(Boolean), JSON.stringify(lead.shown));
  const order = await page.evaluate(ids => ids.map(i => document.getElementById(i)).every((e, k, a) =>
    k === 0 || !!(a[k - 1].compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING)), SECTIONS.map(s => s[2][0]));
  check('...in the order Subtract, Extract bit, Punch, Hollow, Lift, Split to parts', order);
  await shot(page, '1-card');

  /* ---------------------------------------------------------------- 2 */
  console.log('2. every control is on the card');
  const missing = await page.evaluate(secs => secs.flatMap(([, , ids]) =>
    ids.filter(i => { const e = document.getElementById(i); return !e || !e.closest('#menu-bit'); })), SECTIONS);
  check('every id the card had is on it', missing.length === 0, missing.join(', ') || 'all');
  const all = SECTIONS.flatMap(s => s[2]);
  check('no id is listed twice', new Set(all).size === all.length, all.length + ' ids');
  const detach = await page.evaluate(() => ({
    afterLiftPanel: !!(document.getElementById('lift-panel').compareDocumentPosition(document.getElementById('detach-tools')) & Node.DOCUMENT_POSITION_FOLLOWING),
    beforeSplit: !!(document.getElementById('detach-tools').compareDocumentPosition(document.getElementById('btn-split-parts')) & Node.DOCUMENT_POSITION_FOLLOWING) }));
  check('Detach flange is with Lift, under its panel and above Split to parts', detach.afterLiftPanel && detach.beforeSplit, JSON.stringify(detach));

  /* ---------------------------------------------------------------- 3, 4 */
  console.log('3. what is on the card can be hit');
  for (const [, label, ids] of SECTIONS) {
    const hit = await page.evaluate(([ids, own]) => ids.map(i => {
      const e = document.getElementById(i);
      let hidden = false;
      for (let n = e; n && n.id !== 'menu-bit'; n = n.parentElement) {
        if (n.hidden || getComputedStyle(n).display === 'none') hidden = true;
      }
      if (hidden) return { i, ok: own.includes(i), own: true };
      e.scrollIntoView({ block: 'nearest' });
      const r = e.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return { i, ok: false, why: 'no box' };
      const h = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 10));
      const lab = e.closest('label');
      return { i, ok: !!h && (h === e || e.contains(h) || (lab && (h === lab || lab.contains(h)))), why: h && (h.id || h.className) };
    }), [ids, [...OWN_STATE]]);
    const bad = hit.filter(x => !x.ok).map(x => x.i + (x.why ? ' (' + x.why + ')' : ''));
    check(label + ': every control can be hit', bad.length === 0,
      bad.join(', ') || ids.length + ' controls, ' + hit.filter(x => x.own).length + ' hidden by their own state');
  }
  await page.click('#menu-bit > summary');
  await sleep(page, 120);
  await page.click('#menu-bit > summary');
  await sleep(page, 120);
  check('shutting the card and opening it again finds it as it was',
    await page.evaluate(() => document.getElementById('btn-hollow').checkVisibility({ contentVisibilityAuto: true })));

  /* ---------------------------------------------------------------- 5 */
  console.log('5. the wall box');
  const wall = await page.evaluate(() => {
    const i = document.getElementById('inp-hollow-mm').getBoundingClientRect();
    const b = document.getElementById('btn-hollow').getBoundingClientRect();
    const sf = document.getElementById('btn-hollow-safe').getBoundingClientRect();
    return { w: i.width, h: i.height, btn: b.width, safe: sf.width, safeText: document.getElementById('btn-hollow-safe').scrollWidth <= sf.width + 1,
             level: Math.abs(i.top - b.top) < 4, row: document.getElementById('btn-hollow').parentElement.getBoundingClientRect().width };
  });
  check('the box is wide enough to read (>= 56 px) and as tall as the button beside it', wall.w >= 56 && Math.abs(wall.h - 33) < 12 && wall.level, JSON.stringify(wall));
  check('"Hollow to safe min" has the whole row and its label is not cut', wall.safe >= wall.row - 2 && wall.safeText, JSON.stringify(wall));
  await page.click('#inp-hollow-mm');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('3.5');
  const typed = await page.evaluate(() => ({ box: document.getElementById('inp-hollow-mm').value, slider: document.getElementById('inp-hollow-slider').value,
                                             read: document.getElementById('hollow-slider-read').textContent }));
  check('typing in the box moves the slider and its read-out', typed.box === '3.5' && parseFloat(typed.slider) === 3.5 && /3\.5/.test(typed.read), JSON.stringify(typed));
  await page.focus('#inp-hollow-slider');
  await page.keyboard.press('ArrowRight');
  const nudged = await page.evaluate(() => ({ box: document.getElementById('inp-hollow-mm').value, slider: document.getElementById('inp-hollow-slider').value }));
  check('the slider moves the box (a real key press on it)', parseFloat(nudged.box) > 3.5 && parseFloat(nudged.box) === parseFloat(nudged.slider), JSON.stringify(nudged));
  await page.click('#inp-hollow-mm');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('15');
  const past = await page.evaluate(() => ({ box: document.getElementById('inp-hollow-mm').value, slider: document.getElementById('inp-hollow-slider').value }));
  check('a number past the slider\'s end stays in the box (the slider stops at its end)', past.box === '15' && parseFloat(past.slider) === 10, JSON.stringify(past));
  await waitPreview(page, false, 4000);
  await page.evaluate(() => { nsoHollowPreview.close(); });

  /* ---------------------------------------------------------------- 6 */
  console.log('6. the cavity, live');
  const opaque = await matState(page);
  check('before any preview the piece is opaque', !opaque.transparent && opaque.opacity === 1, JSON.stringify(opaque));
  const status0 = await page.evaluate(() => document.getElementById('status').textContent);
  await setSlider(page, 3);
  check('moving the slider draws a preview', await waitPreview(page, true));
  const t3 = await cavityTris(page);
  const ghost = await matState(page);
  check('the piece is a ghost, and the cavity is drawn inside it', ghost.transparent && ghost.opacity < 0.5 && !ghost.depthWrite && t3 > 0, JSON.stringify(ghost) + ' cavity ' + t3 + ' tris');
  const ro = await page.evaluate(() => document.getElementById('hollow-readout').textContent);
  check('the readout says it is a preview, with the wall and the volume', /Preview/.test(ro) && /3 mm wall/.test(ro) && /mm³/.test(ro), ro);
  const helper = await page.evaluate(() => { const o = nsoHollowPreview.objects(); return { tagged: nsoHelpers.isHelper(o.group), inScene: !!o.group.parent }; });
  check('it is a helper (never exported, never selectable), riding the piece', helper.tagged && helper.inScene, JSON.stringify(helper));
  await shot(page, '3-hollow-live-3mm');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '3-hollow-live-3mm-view.png') });
  await setSlider(page, 5);
  await page.waitForFunction(t => { const o = nsoHollowPreview.objects(); return o && o.cavity && o.cavity.geometry.attributes.position.count / 3 !== t; }, t3, { timeout: 15000 });
  const t5 = await cavityTris(page);
  const ro5 = await page.evaluate(() => document.getElementById('hollow-readout').textContent);
  check('a different wall draws a different cavity', t5 > 0 && t5 !== t3 && /5 mm wall/.test(ro5), t3 + ' -> ' + t5 + ' tris; ' + ro5);
  await shot(page, '4-hollow-live-5mm');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '4-hollow-live-5mm-view.png') });
  // many moves in a row: only the last is drawn
  for (const v of [1.2, 1.6, 2.4, 2]) await setSlider(page, v);
  await page.waitForFunction(() => /2 mm wall/.test(document.getElementById('hollow-readout').textContent), null, { timeout: 15000 });
  check('a run of moves ends on the last one', true);
  const status1 = await page.evaluate(() => document.getElementById('status').textContent);
  check('the preview leaves the status line alone', status1 === status0, status1);

  const u0 = await page.evaluate(() => state.undoStack.length);
  const tri0 = await page.evaluate(() => getActiveModel().rawTris.length / 9);
  await page.click('#btn-hollow');
  await page.waitForFunction(n => getActiveModel().rawTris.length / 9 > n, tri0, { timeout: 30000 });
  const after = await page.evaluate(() => ({ u: state.undoStack.length, on: nsoHollowPreview.on(), tris: getActiveModel().rawTris.length / 9,
                                              status: document.getElementById('status').textContent }));
  check('Hollow cuts the piece once, with one Undo, and the preview is gone', after.u === u0 + 1 && !after.on, JSON.stringify(after).slice(0, 220));
  check('...and the piece is opaque again', JSON.stringify(await matState(page)) === JSON.stringify(opaque), JSON.stringify(await matState(page)));
  check('...at the wall in the box (2 mm)', /2 mm wall|Hollowed to a 2 mm/.test(after.status), after.status.slice(0, 120));
  await page.evaluate(() => document.getElementById('btn-undo').click());
  await sleep(page, 300);
  check('one Undo puts the piece back', await page.evaluate(n => getActiveModel().rawTris.length / 9 === n, tri0));

  /* ---------------------------------------------------------------- 7 */
  console.log('7. the preview goes away');
  await setSlider(page, 3);
  await waitPreview(page, true);
  await page.click('#menu-bit > summary');
  await sleep(page, 200);
  check('shutting the Subtract card puts the preview away and the piece back', !(await previewOn(page)) && !(await matState(page)).transparent);
  await page.click('#menu-bit > summary');
  await sleep(page, 150);
  await setSlider(page, 3);
  await waitPreview(page, true);
  const left = await page.evaluate(() => window.leaveTool());
  check('leave-tool closes it', !(await previewOn(page)) && !(await matState(page)).transparent, JSON.stringify(left));
  await setSlider(page, 3);
  await waitPreview(page, true);
  await page.evaluate(() => nsoHelpers.teardown('clear'));
  check('Clear / Clear plate (the helpers\' teardown) closes it', !(await previewOn(page)) && !(await matState(page)).transparent);
  await setSlider(page, 3);
  await waitPreview(page, true);
  const id2 = await loadSTL(page, BALL);
  await selectModel(page, id2);
  await sleep(page, 400);
  check('choosing a different piece closes it, and the first piece is opaque',
    !(await previewOn(page)) && await page.evaluate(([a]) => {
      const p = state.placed.find(q => q.sourceId === a), mt = Array.isArray(p.mesh.material) ? p.mesh.material[0] : p.mesh.material;
      return !mt.transparent && mt.opacity === 1;
    }, [id]));
  await setSlider(page, 3);
  check('...and the new piece previews its own cavity', await waitPreview(page, true) && (await cavityTris(page)) > 0);
  await selectModel(page, id);
  await sleep(page, 300);
  const statusR = await page.evaluate(() => document.getElementById('status').textContent);
  await setBox(page, 0.2);
  await sleep(page, 400);
  const refused = await page.evaluate(() => ({ on: nsoHollowPreview.on(), ro: document.getElementById('hollow-readout').textContent,
                                               bad: document.getElementById('hollow-readout').classList.contains('carve-bad'),
                                               status: document.getElementById('status').textContent }));
  check('a wall under the nozzle floor is refused in the readout, not the status line, with no preview',
    !refused.on && /floor/.test(refused.ro) && refused.bad && refused.status === statusR, JSON.stringify(refused).slice(0, 240));
  await setBox(page, 2);
  await page.evaluate(() => { nsoHollowPreview.close(); });
  await setBox(page, 40);
  await sleep(page, 1500);
  const thick = await page.evaluate(() => ({ on: nsoHollowPreview.on(), ro: document.getElementById('hollow-readout').textContent }));
  check('a wall too thick to leave any cavity says so, with no preview', !thick.on && /no interior left|no cavity/.test(thick.ro), JSON.stringify(thick).slice(0, 200));
  await setBox(page, 2);
  await page.evaluate(() => { nsoHollowPreview.close(); });

  /* ---------------------------------------------------------------- 8 */
  console.log('8. the other tools still run from the card');
  await page.evaluate(() => window.leaveTool());
  await page.click('#btn-lift');
  await sleep(page, 400);
  const lift = await page.evaluate(() => ({ armed: NSO_LIFT_PLATE.isArmed(), pressed: document.getElementById('btn-lift').getAttribute('aria-pressed') }));
  check('Lift arms from the card', lift.armed && lift.pressed === 'true', JSON.stringify(lift));
  const panelShown = await page.evaluate(() => !document.getElementById('lift-panel').hidden);
  await shot(page, '5-lift-armed');
  await page.click('#btn-lift');
  check('...and a second click puts it away (its panel opens with it)', panelShown && !(await page.evaluate(() => NSO_LIFT_PLATE.isArmed())));
  await page.click('#btn-punch');
  await sleep(page, 300);
  const punch = await page.evaluate(() => ({ card: !document.getElementById('punch-card').hidden, inCard: !!document.getElementById('punch-card').closest('#menu-bit') }));
  check('Punch opens its card on the card', punch.card && punch.inCard, JSON.stringify(punch));
  await shot(page, '6-punch-armed');
  await page.click('#btn-punch-cancel');
  await page.evaluate(() => window.leaveTool());
  await page.click('#btn-detach');
  await sleep(page, 400);
  const det = await page.evaluate(() => document.getElementById('detach-readout').textContent);
  check('Detach flange runs from the card and answers in its readout', det && det !== '—', det.slice(0, 120));

  const errs = logs.filter(l => /pageerror/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');
}).then(() => {
  console.log(fails ? '\n' + fails + ' check(s) FAILED' : '\nevery check held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error(e); process.exit(1); });
