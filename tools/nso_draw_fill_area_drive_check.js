/* Draw: furring a channel solid - a Guide across its mouth, Fill area inside it, welded (docs/DRAW.md,
   "Fill area" and "The Line tool's snaps"), through the real app.
     node tools/nso_draw_fill_area_drive_check.js        exit 0 = every gate held
   Screenshots go to tools/draw-out/ (git-ignored).

   Piece: a U channel 30 x 20 x 15, walls 2, open on one side, turned 10 degrees off the plate's axes - walls a
   hand cannot follow along a grid line, the owner's case.
   Pinned:
   1. Line tool, Guide: a click 3 px off the inner corner of one leg lands on it ("corner"); the pointer 1 mm
      short of the other leg's corner and a degree or two off square: the point is held square to the walls and
      stops exactly where that line meets the other leg ("meets the edge") - the guide runs at exactly 10 degrees.
   2. Fill area: a click inside the channel is a fill whose mouth side lies exactly on the guide, grown 0.1 mm (Fill area grows)
      into the three walls; a click outside the piece, or in the channel with no guide, is refused in words.
   3. The guide is never built: the drawing is one fill.
   4. Connect where drawn, Piece height, Weld: the channel is a solid block - volume the outer box (and the fill's
      0.02 mm over the top, the flush-top rule), mesh_validate.py clean, one Undo. */
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
const OUT = path.join(__dirname, 'draw-out');
const TILT = 10 * Math.PI / 180;
const rot = p => [p[0] * Math.cos(TILT) - p[1] * Math.sin(TILT), p[0] * Math.sin(TILT) + p[1] * Math.cos(TILT)];
/* the channel, its own frame: x -15..15, y -10..10, open at +y; walls 2 */
const U = [[-15, -10], [15, -10], [15, 10], [13, 10], [13, -8], [-13, -8], [-13, 10], [-15, 10]].map(rot);
const channelSoup = () => SK.solids({ height: 15, objects: [{ kind: 'fill', pts: U }] }).parts[0].soup;

withApp(async (page) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-fill-'));
  fs.writeFileSync(path.join(tmp, 'channel.stl'), FX.stl(channelSoup()));
  const id = await loadSTL(page, path.join(tmp, 'channel.stl'));
  await page.evaluate(() => { try { localStorage.removeItem('nso.sketch.v1'); localStorage.removeItem('nso.sketch.assist'); } catch (e) {} NSO_DrawEditor.setSketch({ height: 1.5, objects: [] }); });
  await page.click('#menu-connect > summary');
  await page.click('#btn-draw-editor');
  await page.waitForTimeout(300);
  const tr = await page.evaluate(i => NSO_DrawEditor.trace(i), id);
  /* the plate frame: where the channel's own corners landed (the trace box is the piece's; the channel was built
     centred on its box, so map its own points through the box centre) */
  const tb = tr.trace.box, ob = SK.bounds([{ kind: 'fill', pts: U }]);
  const P = q => { const r = rot(q); return [r[0] - ob.cx + (tb.x0 + tb.x1) / 2, r[1] - ob.cy + (tb.y0 + tb.y1) / 2]; };
  const cL = P([-13, 10]), cR = P([13, 10]);
  const sp = q => page.evaluate(x => NSO_DrawEditor.screenOf(x), q);

  console.log('1. a guide across the mouth, held to the walls');
  await page.click('#dr-kind-guide');
  await page.click('#dr-tool-line');
  let s = await sp(cL);
  await page.mouse.move(s[0] + 3, s[1] + 2); await page.mouse.click(s[0] + 3, s[1] + 2);
  const off = P([12.3, 9]);                                       // short of the far corner, a little off square
  s = await sp(off);
  await page.mouse.move(s[0], s[1]);
  await page.waitForTimeout(80);
  const label = await page.evaluate(([a, b]) => NSO_DrawEditor.snapAt(a, b), [cL, off]);
  check('held square to the walls, the point stops where the line meets the far leg', /meets the edge/.test(label.label) && near(label.p[0], cR[0], 1e-6) && near(label.p[1], cR[1], 1e-6), JSON.stringify(label));
  await page.mouse.click(s[0], s[1]);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  let sk = await page.evaluate(() => NSO_DrawEditor.sketch());
  const g = sk.objects[0];
  check('one Guide, from exactly one inner corner to exactly the other', g && g.kind === 'guide' && g.pts.length === 2 &&
        near(g.pts[0][0], cL[0]) && near(g.pts[0][1], cL[1]) && near(g.pts[1][0], cR[0]) && near(g.pts[1][1], cR[1]), JSON.stringify(g && g.pts));
  const ang = g && Math.atan2(g.pts[1][1] - g.pts[0][1], g.pts[1][0] - g.pts[0][0]) * 180 / Math.PI;
  check('...running at the walls\' own 10 degrees, not a grid line', near(ang, 10, 1e-6), ang);

  console.log('2. Fill area');
  await page.click('#dr-tool-area');
  const out = await sp(P([0, 14]));
  await page.mouse.click(out[0], out[1]);
  check('a click outside the channel is refused in words', /open to the outside|outside everything/.test(await page.textContent('#dr-hint')) && (await page.evaluate(() => NSO_DrawEditor.sketch().objects.length)) === 1, await page.textContent('#dr-hint'));
  const inside = await sp(P([0, 0]));
  await page.mouse.click(inside[0], inside[1]);
  await page.waitForTimeout(150);
  sk = await page.evaluate(() => NSO_DrawEditor.sketch());
  const f = sk.objects[1];
  check('a click inside: a Fill area', f && f.kind === 'fill' && /^Fill area/.test(f.name), f && f.name);
  /* the mouth side: on the guide's line, stood 0.02 past it (a face flush with the wall ends is a seam the weld cannot close) */
  const gd = p => ((p[0] - cL[0]) * (cR[1] - cL[1]) - (p[1] - cL[1]) * (cR[0] - cL[0])) / Math.hypot(cR[0] - cL[0], cR[1] - cL[1]);
  const onGuide = f ? f.pts.filter(p => near(Math.abs(gd(p)), SK.FLUSH_GAP, 1e-6)) : [];
  check('...its mouth side runs along the guide, exactly 0.02 past it (two corners there)', onGuide.length === 2 && Math.max(...f.pts.map(p => Math.sign(gd(onGuide[0])) * gd(p))) <= SK.FLUSH_GAP + 1e-9, onGuide.length);
  /* in the channel's own frame: the inside is x -13..13, y -8..10; grown 0.1 into the three walls */
  const inv = q => { const c = [(tb.x0 + tb.x1) / 2, (tb.y0 + tb.y1) / 2], d = [q[0] - c[0] + ob.cx, q[1] - c[1] + ob.cy]; return [d[0] * Math.cos(-TILT) - d[1] * Math.sin(-TILT), d[0] * Math.sin(-TILT) + d[1] * Math.cos(-TILT)]; };
  const own = f ? f.pts.map(inv) : [];
  const bx = SK.bounds([{ kind: 'fill', pts: own }]);
  check('...grown exactly 0.1 into the side walls and the floor (sharp corners), 0.02 past the mouth', bx && near(bx.x0, -13.1, 1e-6) && near(bx.x1, 13.1, 1e-6) && near(bx.y0, -8.1, 1e-6) && near(bx.y1, 10 + SK.FLUSH_GAP, 1e-6), bx && JSON.stringify([bx.x0, bx.x1, bx.y0, bx.y1].map(v => +v.toFixed(3))));
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, '9-fill-area.png') });

  console.log('3. the guide is not built');
  check('the drawing describes one fill and one guide', /^1 fill, .*\(1 guide\)$/.test(await page.evaluate(() => NSO_Sketch.describe(NSO_DrawEditor.sketch()))), await page.evaluate(() => NSO_Sketch.describe(NSO_DrawEditor.sketch())));
  if (process.env.MOUTH) await page.evaluate(([m, a, b]) => {           // a probe: the mouth side moved m mm out of the channel
    const k = NSO_DrawEditor.sketch(), o = k.objects[1], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy), n = [dy / L, -dx / L];
    o.pts = o.pts.map(p => Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / L < 1e-6 ? [p[0] - n[0] * m, p[1] - n[1] * m] : p);
    NSO_DrawEditor.setSketch(k);
  }, [+process.env.MOUTH, cL, cR]);
  await page.click('#dr-done');

  console.log('4. weld it in');
  const v0 = await page.evaluate(i => { const p = state.placed.find(q => q.sourceId === i); const s0 = meshToWorldSoup(p.mesh); let v = 0; for (let k = 0; k < s0.length; k += 9) v += s0[k] * (s0[k + 4] * s0[k + 8] - s0[k + 5] * s0[k + 7]) - s0[k + 1] * (s0[k + 3] * s0[k + 8] - s0[k + 5] * s0[k + 6]) + s0[k + 2] * (s0[k + 3] * s0[k + 7] - s0[k + 4] * s0[k + 6]); return Math.abs(v / 6); }, id);
  await openMenuFor(page, '#btn-draw-connect');
  await page.click('#btn-draw-connect');
  await page.waitForTimeout(400);
  await page.click('#dc-fullh');
  let L = (await page.evaluate(() => NSO_AsmEditor.info())).lock;
  check('Connect opens where drawn, Piece height', L.step === 'set' && L.host.plate && L.plan && L.plan.ghost, JSON.stringify(L.plan && L.plan.notes));
  await page.evaluate(() => NSO_AsmEditor.view([-120, 160, 200]));
  await page.screenshot({ path: path.join(OUT, '10-fill-area-ghost.png') });
  await page.click('#dc-apply');
  await page.waitForFunction(() => !NSO_AsmEditor.info().busy, null, { timeout: 120000 });
  await page.waitForTimeout(200);
  L = (await page.evaluate(() => NSO_AsmEditor.info())).lock;
  check('it worked', L.last && L.last.ok, JSON.stringify(L.last));
  const soup = await page.evaluate(i => Array.from(meshToWorldSoup(state.placed.find(p => p.sourceId === i).mesh)), id);
  const v1 = Math.abs(FX.volume(new Float32Array(soup)));
  /* the box, and the fill prism (15.02 tall) less what of it lies inside the box: all of it but the 0.02 strip past the mouth */
  const fillArea = SK.signedArea(f.pts), mouth = Math.hypot(onGuide[0][0] - onGuide[1][0], onGuide[0][1] - onGuide[1][1]), strip = mouth * SK.FLUSH_GAP;
  const want = 30 * 20 * 15 + fillArea * 15.02 - (fillArea - strip) * 15;
  check('the channel is now a solid block: the outer box, the fill 0.02 over its top and past its mouth', near(v1, want, 0.05), v1.toFixed(3) + ' vs ' + want.toFixed(3) + ' (was ' + v0.toFixed(1) + ')');
  fs.writeFileSync(path.join(tmp, 'solid.stl'), FX.stl(new Float32Array(soup)));
  const mv = meshValidate(path.join(tmp, 'solid.stl'));
  check('mesh_validate.py: closed, manifold, no degenerate, nothing piercing', mv.open_edges === 0 && mv.nonmanifold_edges === 0 && mv.degenerate_tris === 0 && mv.self_intersection.pierce === 0,
        JSON.stringify({ o: mv.open_edges, nm: mv.nonmanifold_edges, d: mv.degenerate_tris, p: mv.self_intersection && mv.self_intersection.pierce }));
  await page.evaluate(() => NSO_AsmEditor.view([-120, 160, 200]));
  await page.screenshot({ path: path.join(OUT, '11-fill-area-welded.png') });
  await page.click('#asm-undo');
  await page.waitForTimeout(300);
  const v2 = await page.evaluate(i => { const p = state.placed.find(q => q.sourceId === i); const s0 = meshToWorldSoup(p.mesh); let v = 0; for (let k = 0; k < s0.length; k += 9) v += s0[k] * (s0[k + 4] * s0[k + 8] - s0[k + 5] * s0[k + 7]) - s0[k + 1] * (s0[k + 3] * s0[k + 8] - s0[k + 5] * s0[k + 6]) + s0[k + 2] * (s0[k + 3] * s0[k + 7] - s0[k + 4] * s0[k + 6]); return Math.abs(v / 6); }, id);
  check('one Undo puts the channel back', near(v2, v0, 1e-3));
}).then(() => {
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(err => { console.error(err); process.exit(1); });
