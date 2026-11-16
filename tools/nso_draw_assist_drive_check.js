/* Draw editor: Line assist (app-draw-editor.js, NSO_Sketch.assist; docs/DRAW.md "Line assist") through the
   real editor, with real pointer strokes.
     node tools/nso_draw_assist_drive_check.js        exit 0 = every gate held
   Pinned:
   1. Assist Straight: a wobbly L drawn with the pencil is two straight walls - three points, one level side,
      one upright side - and the readout says "2 straight".
   2. Assist Off: the same stroke stays as drawn (many points); with Shift held on release it is Straight
      for that one stroke.
   3. Clean up on a rough half circle drawn with assist Off: Auto makes it one true arc; Ctrl+Z puts the
      stroke back as it was.
   4. The choice is kept in this browser. */
const fs = require('fs');
const path = require('path');
const { withApp } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => { console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : '')); if (!cond) fails++; };
const near = (a, b, t) => Number.isFinite(a) && Math.abs(a - b) <= (t == null ? 1e-6 : t);
const OUT = path.join(__dirname, 'draw-out');

withApp(async (page) => {
  await page.evaluate(() => { try { localStorage.removeItem('nso.sketch.v1'); localStorage.removeItem('nso.sketch.assist'); } catch (e) {} NSO_DrawEditor.setSketch({ height: 1.5, objects: [] }); });
  await page.click('#menu-connect > summary');
  await page.click('#btn-draw-editor');
  await page.waitForTimeout(300);
  const sp = p => page.evaluate(q => NSO_DrawEditor.screenOf(q), p);
  const last = () => page.evaluate(() => { const k = NSO_DrawEditor.sketch(); return k.objects[k.objects.length - 1]; });
  async function stroke(pts, shift) {
    let s = await sp(pts[0]);
    await page.mouse.move(s[0], s[1]); await page.mouse.down();
    for (const p of pts.slice(1)) { s = await sp(p); await page.mouse.move(s[0], s[1]); }
    if (shift) await page.keyboard.down('Shift');
    await page.mouse.up();
    if (shift) await page.keyboard.up('Shift');
    await page.waitForTimeout(120);
  }
  const wobblyL = [];
  for (let i = 0; i <= 40; i++) wobblyL.push([-20 + i * 0.75, -10 + Math.sin(i * 0.9) * 0.35]);
  for (let i = 1; i <= 25; i++) wobblyL.push([10 + Math.sin(i * 1.1) * 0.35, -10 + i * 0.8]);

  console.log('1. Straight');
  check('assist starts Off', await page.evaluate(() => NSO_DrawEditor.assist()) === 'off' && await page.getAttribute('#dr-assist-off', 'aria-pressed') === 'true');
  await page.click('#dr-assist-straight');
  await stroke(wobblyL);
  let o = await last();
  check('a wobbly L is two straight walls: three points', o.pts.length === 3, JSON.stringify(o.pts));
  check('...one exactly level, one exactly upright', near(o.pts[0][1], o.pts[1][1]) && near(o.pts[1][0], o.pts[2][0]), JSON.stringify(o.pts));
  check('...and the hint says so', /2 straight/.test(await page.textContent('#dr-hint')), await page.textContent('#dr-hint'));
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, '7-assist-straight.png') });

  console.log('2. Off, and Shift for one stroke');
  await page.click('#dr-assist-off');
  await stroke(wobblyL.map(p => [p[0], p[1] + 25]));
  o = await last();
  check('Off: the stroke keeps its wobble (many points)', o.pts.length > 6, o.pts.length);
  await stroke(wobblyL.map(p => [p[0], p[1] + 45]), true);
  o = await last();
  check('Shift held on release: Straight for that stroke', o.pts.length === 3 && near(o.pts[0][1], o.pts[1][1]), JSON.stringify(o.pts));

  console.log('3. Clean up');
  const arc = [];
  for (let i = 0; i <= 50; i++) { const t = i / 50 * Math.PI; arc.push([40 + 12 * Math.cos(t) + Math.sin(i * 2.7) * 0.25, 12 * Math.sin(t) + Math.cos(i * 1.9) * 0.25]); }
  await stroke(arc);
  const before = await last();
  check('drawn with assist Off: picked', await page.evaluate(() => NSO_DrawEditor.info().sel.length) === 1);
  await page.click('#dr-cleanup');
  o = await last();
  const cx = 40, rr = o.pts.map(p => Math.hypot(p[0] - cx, p[1]));
  const mean = rr.reduce((a, b) => a + b, 0) / rr.length;
  check('Clean up (Auto): one true arc - every point the same distance from one centre', /1 arc/.test(await page.textContent('#dr-hint')) && Math.max(...rr) - Math.min(...rr) < 0.4, await page.textContent('#dr-hint'));
  check('...its radius the drawn one (12 to 0.3)', near(mean, 12, 0.3), mean.toFixed(3));
  await page.focus('#dr-canvas');
  await page.keyboard.press('Control+z');
  o = await last();
  check('Ctrl+Z puts the stroke back as it was', JSON.stringify(o.pts) === JSON.stringify(before.pts));
  await page.screenshot({ path: path.join(OUT, '8-assist-cleanup.png') });

  console.log('4. kept');
  await page.click('#dr-assist-auto');
  check('the choice is kept in this browser', await page.evaluate(() => localStorage.getItem('nso.sketch.assist')) === 'auto');
}).then(() => {
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(err => { console.error(err); process.exit(1); });
