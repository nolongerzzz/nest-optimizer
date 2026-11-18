/* Draw editor: the Line tool follows edges, and Fill area closes small gaps (app-draw-editor.js followPath,
   NSO_Sketch.regionAt gap; docs/DRAW.md "Follow edges") through the real app, with real clicks.
     node tools/nso_draw_follow_drive_check.js        exit 0 = every gate held
   Piece: a channel 30 x 20 x 10, walls 2, its inside corners filleted (radius 3), open at the top.
   Pinned:
   1. Line tool (a Guide): a click on the left wall's inside face and one on the floor are joined ALONG the
      wall - every point of the guide on the traced outline, round the fillet - not by a chord across it.
   2. Alt held on the second click: the straight chord (two points). Corner to corner across the mouth stays a
      straight guide (the way round is far longer); Alt there follows the walls round.
   3. A Drawing Line across the mouth that stops 0.3 mm short of the right wall: Fill area inside still fills
      (the gap closed), and says so; with gaps set to 0 it is refused as open.
   4. Welded at piece height: the channel is solid (its volume the outer box, its 0.02 over the top, the line's
      bead above the mouth), mesh_validate.py clean. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, openMenuFor, ROOT } = require('./nso_app_harness');
const FX = require('./nso_feature_fixture.js');
global.NSO_CDT = require(path.join(ROOT, 'nso_cdt.js'));
const SK = require(path.join(ROOT, 'nso_sketch.js'));

let fails = 0;
const check = (name, cond, detail) => { console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : '')); if (!cond) fails++; };
const near = (a, b, t) => Number.isFinite(a) && Math.abs(a - b) <= (t == null ? 1e-6 : t);
const meshValidate = file => JSON.parse(execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'], { encoding: 'utf8', maxBuffer: 64 << 20 }));

/* the channel, its own frame: x -15..15, y -10..10, the inside x -13..13, y -8..10, inside corners round, r 3 */
function channel() {
  const R = 3, pts = [[-15, -10], [15, -10], [15, 10], [13, 10]];
  for (let i = 0; i <= 12; i++) { const a = i / 12 * Math.PI / 2; pts.push([13 - R + R * Math.cos(a), -8 + R - R * Math.sin(a)]); }
  for (let i = 0; i <= 12; i++) { const a = Math.PI / 2 + i / 12 * Math.PI / 2; pts.push([-13 + R + R * Math.cos(a), -8 + R - R * Math.sin(a)]); }
  pts.push([-13, 10], [-15, 10]);
  return SK.dedupe ? pts : pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 1e-9);
}
const U = channel();

withApp(async (page) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-follow-'));
  fs.writeFileSync(path.join(tmp, 'ch.stl'), FX.stl(SK.solids({ height: 10, objects: [{ kind: 'fill', pts: U }] }).parts[0].soup));
  const id = await loadSTL(page, path.join(tmp, 'ch.stl'));
  await page.evaluate(() => { try { ['nso.sketch.v1', 'nso.sketch.side', 'nso.sketch.assist'].forEach(k => localStorage.removeItem(k)); } catch (e) {} NSO_DrawEditor.setSketch({ height: 1.5, objects: [] }); });
  await page.click('#menu-connect > summary');
  await page.click('#btn-draw-editor');
  await page.waitForTimeout(300);
  const tr = await page.evaluate(i => NSO_DrawEditor.trace(i), id);
  const tb = tr.trace.box, ob = SK.bounds([{ kind: 'fill', pts: U }]);
  const P = q => [q[0] - ob.cx + (tb.x0 + tb.x1) / 2, q[1] - ob.cy + (tb.y0 + tb.y1) / 2];
  const loop = tr.trace.loops[0];
  const offTrace = p => { let best = Infinity; for (let i = 0; i < loop.length; i++) { const a = loop[i], b = loop[(i + 1) % loop.length], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy, t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0; best = Math.min(best, Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t)); } return best; };
  const sp = q => page.evaluate(x => NSO_DrawEditor.screenOf(x), q);
  const last = () => page.evaluate(() => { const k = NSO_DrawEditor.sketch(); return k.objects[k.objects.length - 1]; });
  async function clickAt(q, alt) { const s = await sp(q); await page.mouse.move(s[0], s[1]); if (alt) await page.keyboard.down('Alt'); await page.mouse.click(s[0], s[1]); if (alt) await page.keyboard.up('Alt'); await page.waitForTimeout(60); }

  console.log('1. a guide that follows the wall round its fillet');
  await page.click('#dr-kind-guide');
  await page.click('#dr-tool-line');
  check('Line follows edges is on', await page.isChecked('#dr-follow'));
  await clickAt(P([-13, 2]));                                      // on the left wall's inside face
  await clickAt(P([0, -8]));                                       // on the floor
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  let g = await last();
  const worst = Math.max(...g.pts.map(offTrace));
  if (process.env.DBG) console.log(JSON.stringify(g.pts.map(p => [(p[0] + ob.cx - (tb.x0 + tb.x1) / 2).toFixed(2), (p[1] + ob.cy - (tb.y0 + tb.y1) / 2).toFixed(2)])));
  check('every point of the guide lies on the traced outline (within 0.02)', worst < 0.02, worst.toFixed(4));
  check('...it went round the fillet: many points, its length the wall + the quarter circle + the floor', g.pts.length > 6 && near(SK.pathLength(g.pts), (2 + 5) + Math.PI * 3 / 2 + 10, 0.1), g.pts.length + ' points, ' + SK.pathLength(g.pts).toFixed(3) + ' vs ' + ((2 + 5) + Math.PI * 3 / 2 + 10).toFixed(3));

  console.log('2. Alt: the straight chord');
  await clickAt(P([-13, 2]));
  await clickAt(P([0, -8]), true);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  g = await last();
  check('Alt held on the second click: two points, a straight line', g.pts.length === 2, g.pts.length);
  console.log('2a. across a mouth: straight, not round the channel');
  await clickAt(P([-13, 10]));
  await clickAt(P([13, 10]));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  g = await last();
  check('corner to corner across the mouth: a straight guide (the way round is far longer than across)', g.pts.length === 2, g.pts.length);
  await clickAt(P([-13, 10]));
  await clickAt(P([13, 10]), true);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  g = await last();
  check('...Alt: the other way - round the channel\'s inside, on the outline', g.pts.length > 6 && Math.max(...g.pts.map(offTrace)) < 0.02, g.pts.length);
  await page.evaluate(() => NSO_DrawEditor.setSketch(Object.assign(NSO_DrawEditor.sketch(), { objects: [] })));

  console.log('2b. along drawn edges, every way round');
  const fol = await page.evaluate(() => {
    const k = NSO_DrawEditor.sketch(), keep = k.objects.slice();
    k.objects = [{ kind: 'fill', pts: [[100, 100], [110, 100], [110, 110], [100, 110]] }, { kind: 'line', pts: [[100, 120], [110, 120], [110, 130], [120, 130]], width: 1 }];
    NSO_DrawEditor.setSketch(k);
    const r = (a, b) => (NSO_DrawEditor.followAt(a, b) || []).map(p => p.map(v => Math.round(v * 1000) / 1000));
    const out = { wrapF: r([100, 105], [105, 100]), wrapB: r([105, 100], [100, 105]), openF: r([105, 120], [115, 130]), openB: r([115, 130], [105, 120]) };
    k.objects = keep; NSO_DrawEditor.setSketch(k);
    return out;
  });
  const J = x => JSON.stringify(x);
  check('a closed fill, the short way past its first corner: (100,105) to (105,100) via (100,100)', J(fol.wrapF) === J([[100, 100], [105, 100]]), J(fol.wrapF));
  check('...and back', J(fol.wrapB) === J([[100, 100], [100, 105]]), J(fol.wrapB));
  check('an open line, forward along it', J(fol.openF) === J([[110, 120], [110, 130], [115, 130]]), J(fol.openF));
  check('...and backward along it', J(fol.openB) === J([[110, 130], [110, 120], [105, 120]]), J(fol.openB));

  console.log('3. Fill area closes a small gap');
  await page.click('#dr-kind-line');
  await page.click('#dr-side-centre');
  await page.evaluate(([a, b]) => { const k = NSO_DrawEditor.sketch(); k.objects.push({ kind: 'line', align: 'centre', width: 1.2, pts: [a, b] }); NSO_DrawEditor.setSketch(k); }, [P([-13, 10]), P([12.7, 10])]);
  await page.click('#dr-tool-area');
  await page.fill('#dr-gap', '0'); await page.dispatchEvent('#dr-gap', 'change');
  let s0 = await sp(P([0, 0])); await page.mouse.click(s0[0], s0[1]); await page.waitForTimeout(120);
  check('gaps 0: the space (open 0.3 mm at the line\'s end) is refused as open', /open to the outside/.test(await page.textContent('#dr-hint')) && (await page.evaluate(() => NSO_DrawEditor.sketch().objects.length)) === 1, await page.textContent('#dr-hint'));
  await page.fill('#dr-gap', '0.5'); await page.dispatchEvent('#dr-gap', 'change');
  await page.mouse.click(s0[0], s0[1]); await page.waitForTimeout(150);
  const f = await last();
  check('gaps 0.5: filled, and the hint says the gap was closed', f.kind === 'fill' && /gap under 0.5 mm was closed/.test(await page.textContent('#dr-hint')), await page.textContent('#dr-hint'));
  const own = f.pts.map(q => [q[0] + ob.cx - (tb.x0 + tb.x1) / 2, q[1] + ob.cy - (tb.y0 + tb.y1) / 2]), fb = SK.bounds([{ kind: 'fill', pts: own }]);
  check('...hugging the inside (and 0.3 into the walls), not spilling out of the channel', near(fb.x0, -13.3, 0.06) && near(fb.x1, 13.3, 0.06) && near(fb.y0, -8.3, 0.06) && fb.y1 < 10.7, JSON.stringify([fb.x0, fb.x1, fb.y0, fb.y1].map(v => +v.toFixed(3))));
  await page.click('#dr-done');

  console.log('4. welded');
  await openMenuFor(page, '#btn-draw-connect');
  await page.click('#btn-draw-connect');
  await page.waitForTimeout(400);
  await page.click('#dc-fullh');
  await page.click('#dc-apply');
  await page.waitForFunction(() => !NSO_AsmEditor.info().busy, null, { timeout: 120000 });
  await page.waitForTimeout(200);
  const L = (await page.evaluate(() => NSO_AsmEditor.info())).lock;
  check('it worked', L.last && L.last.ok, JSON.stringify(L.last));
  const soup = new Float32Array(await page.evaluate(i => Array.from(meshToWorldSoup(state.placed.find(p => p.sourceId === i).mesh)), id));
  fs.writeFileSync(path.join(tmp, 's.stl'), FX.stl(soup));
  const mv = meshValidate(path.join(tmp, 's.stl'));
  check('mesh_validate.py clean', mv.open_edges === 0 && mv.nonmanifold_edges === 0 && mv.degenerate_tris === 0 && mv.self_intersection.pierce === 0,
        JSON.stringify({ o: mv.open_edges, nm: mv.nonmanifold_edges, d: mv.degenerate_tris, p: mv.self_intersection && mv.self_intersection.pierce }));
  const v = Math.abs(FX.volume(soup));
  check('the channel is solid: at least the outer box', v >= 30 * 20 * 10 - 0.05, v.toFixed(2) + ' vs ' + (30 * 20 * 10));
}).then(() => {
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(err => { console.error(err); process.exit(1); });
