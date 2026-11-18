/* Draw editor: Bead side - the path drawn is the bead's edge (app-draw-editor.js, NSO_Sketch.edgeOutline;
   docs/DRAW.md "Bead side") through the real app, with real clicks.
     node tools/nso_draw_bead_side_drive_check.js        exit 0 = every gate held
   Piece: a wall 2 x 40 x 30, traced.
   Pinned:
   1. Off wall (the default): the Line tool run down the wall's +x face, corner to corner - the line's bead lies
      wholly outside the wall, its edge exactly on the face (the path drawn), 1.2 mm out; the list says "edge,
      bead left/right".
   2. The same line run the other way round still lays its bead outside the wall (the side is worked out, not
      taken from the direction).
   3. Flip puts the bead on the other side (into the wall); Centre straddles; Ctrl+Z steps back.
   4. Welded at piece height: the wall is exactly 1.2 mm thicker - its +x face moved out by the width, the volume
      the wall plus the bead (and its 0.02 over the top), mesh_validate.py clean. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, openMenuFor, ROOT } = require('./nso_app_harness');
const FX = require('./nso_feature_fixture.js');

let fails = 0;
const check = (name, cond, detail) => { console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : '')); if (!cond) fails++; };
const near = (a, b, t) => Number.isFinite(a) && Math.abs(a - b) <= (t == null ? 1e-6 : t);
const meshValidate = file => JSON.parse(execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'], { encoding: 'utf8', maxBuffer: 64 << 20 }));
function box(sx, sy, sz) {
  const v = [[0, 0, 0], [sx, 0, 0], [sx, sy, 0], [0, sy, 0], [0, 0, sz], [sx, 0, sz], [sx, sy, sz], [0, sy, sz]].map(p => [p[0] - sx / 2, p[1] - sy / 2, p[2]]);
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const out = [];
  f.forEach(t => t.forEach(i => out.push(...v[i])));
  return new Float32Array(out);
}

withApp(async (page) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-bead-'));
  fs.writeFileSync(path.join(tmp, 'wall.stl'), FX.stl(box(2, 40, 30)));
  const id = await loadSTL(page, path.join(tmp, 'wall.stl'));
  await page.evaluate(() => { try { ['nso.sketch.v1', 'nso.sketch.side', 'nso.sketch.assist'].forEach(k => localStorage.removeItem(k)); } catch (e) {} NSO_DrawEditor.setSketch({ height: 1.5, objects: [] }); });
  await page.click('#menu-connect > summary');
  await page.click('#btn-draw-editor');
  await page.waitForTimeout(300);
  const tr = await page.evaluate(i => NSO_DrawEditor.trace(i), id);
  const tb = tr.trace.box, W = 1.2;
  const sp = q => page.evaluate(x => NSO_DrawEditor.screenOf(x), q);
  const last = () => page.evaluate(() => { const k = NSO_DrawEditor.sketch(); return k.objects[k.objects.length - 1]; });
  const outline = o => page.evaluate(x => { const r = NSO_Sketch.outlines(x); return r.ok ? NSO_Sketch.bounds([{ kind: 'fill', pts: r.regions[0][0] }]) : r.reason; }, o);
  async function line(a, b) {
    await page.click('#dr-tool-line');
    let s = await sp(a); await page.mouse.move(s[0] + 2, s[1] + 2); await page.mouse.click(s[0] + 2, s[1] + 2);
    s = await sp(b); await page.mouse.move(s[0] + 2, s[1] - 2); await page.mouse.click(s[0] + 2, s[1] - 2);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);
    return last();
  }

  console.log('1. Off wall, down the +x face');
  check('Bead side starts Off wall', await page.evaluate(() => NSO_DrawEditor.side()) === 'auto' && await page.getAttribute('#dr-side-auto', 'aria-pressed') === 'true');
  let o = await line([tb.x1, tb.y1], [tb.x1, tb.y0]);
  check('the path runs corner to corner on the face', o.pts.length === 2 && near(o.pts[0][0], tb.x1) && near(o.pts[1][0], tb.x1) && near(o.pts[0][1], tb.y1) && near(o.pts[1][1], tb.y0), JSON.stringify(o.pts));
  let b = await outline(o);
  check('its bead lies outside the wall: to 1.2 out from the face (the path), and 0.3 back into the wall so the weld bites', o.bite === 0.3 && near(b.x0, tb.x1 - 0.3, 1e-9) && near(b.x1, tb.x1 + W, 1e-9) && near(b.y0, tb.y0, 1e-9) && near(b.y1, tb.y1, 1e-9), JSON.stringify(b));
  check('...and the list says the path is its edge', /edge, bead (left|right)/.test(await page.textContent('#dr-objects')));
  await page.screenshot({ path: path.join(__dirname, 'draw-out', '14-bead-off-wall.png') });

  console.log('2. the other way round');
  const o2 = await line([tb.x1, tb.y0], [tb.x1, tb.y1]);
  const b2 = await outline(o2);
  check('run up the face instead, the bead is still outside the wall', near(b2.x0, tb.x1 - 0.3, 1e-9) && near(b2.x1, tb.x1 + W, 1e-9) && o2.align !== o.align, o.align + ' / ' + o2.align);
  await page.focus('#dr-canvas'); await page.keyboard.press('Control+z');

  console.log('3. Flip, Centre, Undo');
  await page.click('#dr-tool-select');
  const mid = await sp([tb.x1 + W / 2, (tb.y0 + tb.y1) / 2]);
  await page.mouse.click(mid[0], mid[1]);
  await page.click('#dr-side-flip');
  b = await outline(await last());
  check('Flip: the bead goes into the wall (nothing past the face to bite)', near(b.x0, tb.x1 - W, 1e-9) && near(b.x1, tb.x1, 1e-9), JSON.stringify(b));
  await page.click('#dr-side-centre');
  b = await outline(await last());
  check('Centre: it straddles the face', near(b.x0, tb.x1 - W / 2, 1e-9) && near(b.x1, tb.x1 + W / 2, 1e-9), JSON.stringify(b));
  await page.focus('#dr-canvas'); await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
  b = await outline(await last());
  check('Ctrl+Z twice: back outside the wall', near(b.x0, tb.x1 - 0.3, 1e-9) && near(b.x1, tb.x1 + W, 1e-9), JSON.stringify(b));
  console.log('3b. Left and Right are the screen\'s, whichever way a line is drawn (the owner drew one up, one down)');
  await page.click('#dr-side-right');
  const ox = tb.x1 + 10;                                          // open sheet, clear of the wall
  const up = await line([ox, tb.y0 + 2], [ox, tb.y0 + 12]), down = await line([ox + 6, tb.y0 + 12], [ox + 6, tb.y0 + 2]);
  const bu = await outline(up), bd = await outline(down);
  const ux = up.pts[0][0], dx0 = down.pts[0][0];                 // where the clicks landed (the helper clicks 2 px off)
  check('Right, drawn up and drawn down: both beads on the screen\'s right of their lines', near(bu.x0, ux, 1e-9) && near(bu.x1, ux + W, 1e-9) && near(bd.x0, dx0, 1e-9) && near(bd.x1, dx0 + W, 1e-9),
        JSON.stringify([bu.x0, bu.x1, bd.x0, bd.x1]));
  const lr = await line([ox, tb.y0 + 16], [ox + 8, tb.y0 + 16]), rl = await line([ox + 8, tb.y0 + 20], [ox, tb.y0 + 20]);
  const blr = await outline(lr), brl = await outline(rl);
  check('...level lines drawn either way: Right is below them', near(blr.y1, lr.pts[0][1], 1e-9) && near(blr.y0, lr.pts[0][1] - W, 1e-9) && near(brl.y1, rl.pts[0][1], 1e-9) && near(brl.y0, rl.pts[0][1] - W, 1e-9),
        JSON.stringify([blr.y0, blr.y1, brl.y0, brl.y1]));
  check('...and the list says "bead right" for all four', (await page.evaluate(() => Array.from(document.querySelectorAll('#dr-objects .dr-obj-kind')).slice(0, 4).map(x => x.textContent))).every(t => /bead right/.test(t)));
  await page.click('#dr-tool-line');
  let sx = await sp([ox + 12, tb.y0 + 2]); await page.mouse.move(sx[0], sx[1]); await page.mouse.click(sx[0], sx[1]);
  sx = await sp([ox + 12, tb.y0 + 10]); await page.mouse.move(sx[0], sx[1]); await page.mouse.click(sx[0], sx[1]);
  await page.keyboard.press('x');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  const bx2 = await outline(await last());
  check('X while drawing: that line\'s bead on the other side (left)', near(bx2.x1, ox + 12, 1e-9) && near(bx2.x0, ox + 12 - W, 1e-9), JSON.stringify(bx2));
  await page.evaluate(() => { const k = NSO_DrawEditor.sketch(); k.objects = k.objects.slice(0, 1); NSO_DrawEditor.setSketch(k); });
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
  let xmax = -Infinity;
  for (let i = 0; i < soup.length; i += 3) xmax = Math.max(xmax, soup[i]);
  check('the wall\'s +x face is now exactly 1.2 further out', near(xmax, tb.x1 + W, 1e-4), xmax + ' vs ' + (tb.x1 + W));
  const v = Math.abs(FX.volume(soup)), want = 2 * 40 * 30 + W * 40 * 30.02 + 0.3 * 40 * 0.02;
  check('volume: the wall and the bead (its 0.02 over the top, the 0.3 it reaches into the wall too)', near(v, want, 0.02), v.toFixed(3) + ' vs ' + want.toFixed(3));
  fs.writeFileSync(path.join(tmp, 'w.stl'), FX.stl(soup));
  const mv = meshValidate(path.join(tmp, 'w.stl'));
  check('mesh_validate.py clean', mv.open_edges === 0 && mv.nonmanifold_edges === 0 && mv.degenerate_tris === 0 && mv.self_intersection.pierce === 0,
        JSON.stringify({ o: mv.open_edges, nm: mv.nonmanifold_edges, d: mv.degenerate_tris, p: mv.self_intersection && mv.self_intersection.pierce }));
}).then(() => {
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(err => { console.error(err); process.exit(1); });
