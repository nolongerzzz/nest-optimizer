#!/usr/bin/env node
/* The SUBTRACT card, laid out as collapsing sections - one per tool - and
   Hollow's live cavity.
     node tools/nso_subtract_card_drive_check.js          exit 0 = every gate held
     node tools/nso_subtract_card_drive_check.js dir      ...and the screenshots, into dir
                                                          (tools/subtract-card-out/)

   UI only: no tool's behaviour changes, and every control keeps its id. The
   sections are <details class="vp-sec"> inside the card's body (the groups the
   Finish menu had, styles.css .vp-sec); they are not .vp-menu, so app-join's
   one-panel rule leaves them alone and several can be open at once.

   GATES
     1. The card opens with six sections, in the ticket's order - Subtract B
        from A, Extract bit (with Carve), Punch, Hollow, Lift (with Detach
        flange), Split to parts - all shut, each showing only its heading.
     2. Every control the card had is still on it, under the id it had, in the
        section the ticket names; Detach flange is in Lift, no longer a group
        of its own under Split to parts.
     3. A heading opens and shuts its section; sections open independently;
        shutting the card and opening it again finds them as left.
     4. Opening a section reveals its controls and they can be hit (a shut one
        hides them): each control is hit-testable once its section is open.
     5. Hollow's wall box is a box a person can read and type in (it was a 24 px
        square), and the slider and the box are one number.
     6. Moving the slider draws the cavity live inside a ghost of the piece;
        a different wall draws a different cavity; Hollow cuts what was
        previewed's wall, once, with one Undo, and the ghost is gone.
     7. The preview goes away, and the piece comes back opaque, when the section
        shuts, on leave-tool, on a different piece, and on a refusal; a wall
        under the nozzle floor is refused in the readout, not the status line.
     8. Lift still arms from inside its section, Detach flange still runs from
        it, and Punch's card still opens in its section. */

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

/* The ticket: sections, in order, with what each holds. The id on each heading's
   <details> is new; every other id is the one the control had. */
const SECTIONS = [
  ['sub-sec-subtract', 'Subtract B from A', ['btn-subtract']],
  ['sub-sec-extract', 'Extract bit',
    ['btn-extract-bit', 'btn-carve', 'carve-blade', 'carve-depth-label', 'carve-depth', 'carve-a-label', 'carve-a',
     'carve-b-label', 'carve-b', 'carve-roll-label', 'carve-roll', 'carve-readout']],
  ['sub-sec-punch', 'Punch',
    ['btn-punch', 'punch-card', 'inp-punch-dia', 'sel-punch-depth', 'punch-depth-mm-row', 'inp-punch-depth',
     'punch-pattern-row', 'punch-grid-rows', 'inp-punch-rows', 'inp-punch-cols', 'btn-punch-pitch-xy', 'punch-pitch-label',
     'inp-punch-pitch', 'punch-pitch-y-row', 'inp-punch-pitch-y', 'punch-anchor-row', 'punch-radial-rows',
     'inp-punch-count', 'inp-punch-radius', 'punch-readout', 'btn-punch-go', 'btn-punch-cancel']],
  ['sub-sec-hollow', 'Hollow',
    ['btn-hollow', 'inp-hollow-mm', 'inp-hollow-slider', 'hollow-slider-read', 'hollow-readout', 'btn-hollow-safe']],
  ['sub-sec-lift', 'Lift',
    ['btn-lift', 'lift-count', 'lift-panel', 'lift-height-read', 'lift-height', 'btn-lift-strip', 'lift-strip',
     'lift-strip-rows', 'lift-strip-sum', 'btn-lift-strip-go', 'btn-lift-strip-cancel', 'lift-readout',
     'detach-tools', 'btn-detach', 'detach-readout']],
  ['sub-sec-split', 'Split to parts', ['btn-split-parts', 'split-count', 'split-readout']]
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
async function shutAll(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.vp-sec').forEach(d => { d.open = false; });
  });
}

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const id = await loadSTL(page, BOX);
  await selectModel(page, id);

  /* ---------------------------------------------------------------- 1 */
  console.log('1. six sections, shut');
  await page.click('#menu-bit > summary');
  await sleep(page, 200);
  const heads = await page.evaluate(() => [...document.querySelectorAll('#menu-bit > .vp-menu-body > .vp-sec')].map(d => ({
    id: d.id, open: d.open, label: d.querySelector(':scope > summary').textContent.trim(),
    shown: d.querySelector(':scope > summary').getBoundingClientRect().height > 0,
    bodyShown: d.querySelector(':scope > .vp-sec-body').checkVisibility({ contentVisibilityAuto: true }) })));
  check('the card holds six sections, in the ticket\'s order',
    JSON.stringify(heads.map(h => h.id)) === JSON.stringify(SECTIONS.map(s => s[0])), heads.map(h => h.id).join(' '));
  check('each is headed by its tool\'s name', heads.every((h, i) => h.label === SECTIONS[i][1]), heads.map(h => h.label).join(' | '));
  check('all six open shut: a heading each, no body showing',
    heads.every(h => !h.open && h.shown && !h.bodyShown), JSON.stringify(heads.map(h => [h.open, h.shown, h.bodyShown])));
  const strays = await page.evaluate(() => [...document.querySelectorAll('#menu-bit > .vp-menu-body > *')].filter(e => !e.classList.contains('vp-sec')).map(e => e.tagName + '#' + e.id));
  check('nothing sits in the card outside a section', strays.length === 0, strays.join(', ') || 'none');
  await shot(page, '1-collapsed');

  /* ---------------------------------------------------------------- 2 */
  console.log('2. every control is on the card, in its section');
  const where = await page.evaluate(secs => secs.map(([sid, , ids]) => ({
    sid, missing: ids.filter(i => { const e = document.getElementById(i); return !e || !e.closest('#' + sid); }),
    elsewhere: ids.filter(i => { const e = document.getElementById(i); return e && !e.closest('#' + sid); }) })), SECTIONS);
  check('every id the card had is in the section the ticket names', where.every(w => w.missing.length === 0),
    where.map(w => w.sid + ': ' + (w.missing.join(',') || 'all')).join('; '));
  const all = SECTIONS.flatMap(s => s[2]);
  check('no id is listed twice', new Set(all).size === all.length, all.length + ' ids');
  const detach = await page.evaluate(() => ({
    inLift: !!document.getElementById('btn-detach').closest('#sub-sec-lift'),
    afterLiftPanel: !!(document.getElementById('lift-panel').compareDocumentPosition(document.getElementById('detach-tools')) & Node.DOCUMENT_POSITION_FOLLOWING),
    inSplit: !!document.getElementById('btn-detach').closest('#sub-sec-split') }));
  check('Detach flange is in Lift, under its panel, and not in Split to parts', detach.inLift && detach.afterLiftPanel && !detach.inSplit, JSON.stringify(detach));

  /* ---------------------------------------------------------------- 3, 4 */
  console.log('3. headings open and shut their sections; 4. what is inside can be hit');
  for (const [sid, label, ids] of SECTIONS) {
    await page.click('#' + sid + ' > summary');
    await sleep(page, 80);
    const o = await open(page, sid);
    const hit = await page.evaluate(([ids, own]) => ids.map(i => {
      const e = document.getElementById(i);
      let hidden = false;
      for (let n = e; n && !n.classList.contains('vp-sec-body'); n = n.parentElement) {
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
    check(label + ': opens on its heading, and every control in it can be hit', o && bad.length === 0,
      bad.join(', ') || ids.length + ' controls, ' + hit.filter(x => x.own).length + ' hidden by their own state');
    await shot(page, '2-open-' + sid.replace('sub-sec-', ''));
    await page.click('#' + sid + ' > summary');
    await sleep(page, 80);
    check(label + ': shuts on its heading', !(await open(page, sid)));
  }
  await page.click('#sub-sec-hollow > summary');
  await page.click('#sub-sec-lift > summary');
  await sleep(page, 80);
  check('sections open independently (Hollow and Lift together)', (await open(page, 'sub-sec-hollow')) && (await open(page, 'sub-sec-lift')) &&
    !(await open(page, 'sub-sec-punch')));
  await page.click('#menu-bit > summary');
  await sleep(page, 120);
  await page.click('#menu-bit > summary');
  await sleep(page, 120);
  check('shutting the card and opening it again finds the sections as left',
    (await open(page, 'sub-sec-hollow')) && (await open(page, 'sub-sec-lift')) && !(await open(page, 'sub-sec-punch')));
  await shutAll(page);

  /* ---------------------------------------------------------------- 5 */
  console.log('5. the wall box');
  await page.click('#sub-sec-hollow > summary');
  await sleep(page, 80);
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
  await page.click('#sub-sec-hollow > summary');
  await sleep(page, 150);
  check('shutting the Hollow section puts the preview away and the piece back', !(await previewOn(page)) && !(await matState(page)).transparent);
  await page.click('#sub-sec-hollow > summary');
  await sleep(page, 100);
  await setSlider(page, 3);
  await waitPreview(page, true);
  await page.click('#menu-bit > summary');
  await sleep(page, 200);
  check('shutting the Subtract card (the section stays open, out of sight) puts it away too', !(await previewOn(page)) && !(await matState(page)).transparent);
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
  console.log('8. the other tools still run from their sections');
  await page.evaluate(() => window.leaveTool());
  await page.click('#btn-lift');
  await sleep(page, 400);
  const lift = await page.evaluate(() => ({ armed: NSO_LIFT_PLATE.isArmed(), pressed: document.getElementById('btn-lift').getAttribute('aria-pressed') }));
  check('Lift arms from inside its section', lift.armed && lift.pressed === 'true', JSON.stringify(lift));
  const panelShown = await page.evaluate(() => !document.getElementById('lift-panel').hidden);
  await shot(page, '5-lift-armed');
  await page.click('#btn-lift');
  check('...and a second click puts it away (its panel opens with it)', panelShown && !(await page.evaluate(() => NSO_LIFT_PLATE.isArmed())));
  await page.click('#btn-punch');
  await sleep(page, 300);
  const punch = await page.evaluate(() => ({ card: !document.getElementById('punch-card').hidden, inSec: !!document.getElementById('punch-card').closest('#sub-sec-punch') }));
  check('Punch opens its card inside its section', punch.card && punch.inSec, JSON.stringify(punch));
  await shot(page, '6-punch-armed');
  await page.click('#btn-punch-cancel');
  await page.evaluate(() => window.leaveTool());
  await page.click('#btn-detach');
  await sleep(page, 400);
  const det = await page.evaluate(() => document.getElementById('detach-readout').textContent);
  check('Detach flange runs from inside Lift and answers in its readout', det && det !== '—', det.slice(0, 120));

  await shutAll(page);
  const errs = logs.filter(l => /pageerror/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');
}).then(() => {
  console.log(fails ? '\n' + fails + ' check(s) FAILED' : '\nevery check held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error(e); process.exit(1); });
