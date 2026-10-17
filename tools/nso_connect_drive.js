#!/usr/bin/env node
/* Connect, driven through the real app: real index.html, real script tags, the
   real Connect button, real mouse clicks on the canvas, real Set and real Undo.
     node tools/nso_connect_drive.js          exit 0 = every gate held
     npm run connect:drive
   Screenshots go to tools/connect-out/ (git-ignored, never committed).

   The geometry is proven headless in tools/nso_connect_test.js. What this file
   proves is the card on it:
     1. the drop-down sits between Crop and Join; its button is wired, its card shut
     2. two clicks, not a drag: hover lights the target; a click on a sphere is
        anchor A and it STAYS marked; a line from A follows the pointer; the
        camera is orbited by a real mouse drag, zoomed by the wheel, and turned
        90 degrees - A is unchanged, nothing captured the pointer; the click on
        the second sphere is anchor B and the connector is previewed
     3. Shape: String, Ribbon, Tube, Tapered each re-plan and re-draw the ghost
        (amber, 0.75, the very soup Set would commit); typing in a field redraws it
     4. Set both ways, for every shape: Weld (two spheres become one closed solid,
        one Undo gives both back bit for bit) and Keep separate (a third closed
        piece, listed on the plate, the spheres untouched, one Undo removes it)
     5. clearing: clicking A again, a click on nothing, Escape; a click on a new
        place with both set replaces B (an orbit drag does not clear)
     6. a third piece in the way is refused in words, no ghost, Set off
     7. Cancel drops the picks and keeps the card; again, closes it
     8. Attach (app-assemble.js), the button under Set / Cancel: it refuses to
        arm until a shape has been clicked on the Stock shelf; armed, it drops
        Connect's picks and the click on a piece is Attach's (the blank of the
        shelf's last shape is seated and unioned, Connect takes no anchor);
        Escape, Cancel and closing the card each turn it off, and Connect's
        clicks are Connect's again */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');
const L = require('./nso_bridge_testlib.js');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const OUT = path.join(ROOT, 'tools', 'connect-out');
fs.mkdirSync(OUT, { recursive: true });
const shot = async (page, name) => { await page.screenshot({ path: path.join(OUT, name + '.png') }); };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-connect-drive-'));

/* ---- in-page helpers, installed once ---- */
function installHelpers() {
  window.__cn = {
    placed(id) { return state.placed.find(p => p && p.sourceId === id); },
    up(id) {
      const p = this.placed(id); p.mesh.updateMatrixWorld(true);
      const s = meshToWorldSoup(p.mesh), o = new Float32Array(s.length);
      for (let i = 0; i < s.length; i += 3) { o[i] = s[i]; o[i + 1] = -s[i + 2]; o[i + 2] = s[i + 1]; }
      return o;
    },
    bounds(s) {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < s.length; i++) { const k = i % 3; if (s[i] < lo[k]) lo[k] = s[i]; if (s[i] > hi[k]) hi[k] = s[i]; }
      return { lo, hi };
    },
    nudge(id, dx, dz) {
      const p = this.placed(id);
      p.x += dx; p.z += dz; p.mesh.position.x += dx; p.mesh.position.z += dz;
      p.mesh.updateMatrixWorld(true);
    },
    look(from, at) {
      state.controls.target.set(at[0], at[1], at[2]);
      state.camera.position.set(from[0], from[1], from[2]);
      state.controls.update();
      state.camera.updateMatrixWorld(true);
    },
    screen(q) {
      const w = new THREE.Vector3(q[0], q[2], -q[1]).project(state.camera);
      const r = state.renderer.domElement.getBoundingClientRect();
      return { x: r.left + (w.x + 1) / 2 * r.width, y: r.top + (1 - w.y) / 2 * r.height };
    },
    /* Put the camera where every point lands on bare canvas (the open drop-down
       hangs over the left of it) and reads as the kind wanted. */
    frame(pts, kinds, from, at) {
      const r = state.renderer.domElement.getBoundingClientRect();
      for (const k of [0, 4, 8, 12, 16, 20, 26, 32, 40]) for (const back of [1, 1.4, 1.9, 2.5]) {
        const f = [at[0] + (from[0] - at[0]) * back, at[1] + (from[1] - at[1]) * back, at[2] + (from[2] - at[2]) * back];
        this.look(f, at);
        const right = new THREE.Vector3().setFromMatrixColumn(state.camera.matrixWorld, 0).multiplyScalar(-k);
        this.look([f[0] + right.x, f[1] + right.y, f[2] + right.z], [at[0] + right.x, at[1] + right.y, at[2] + right.z]);
        const ok = pts.every((q, i) => {
          const s = this.screen(q);
          if (s.x < r.left + 380 || s.x > r.right - 20 || s.y < r.top + 60 || s.y > r.bottom - 20) return false;
          if (document.elementFromPoint(s.x, s.y) !== state.renderer.domElement) return false;
          const t = NSO_bridgeTargetAt({ clientX: s.x, clientY: s.y });
          // the kind wanted, and the very place: within 0.6 mm of the point asked for
          return t && t.target.kind === kinds[i] && Math.hypot(t.world.x - q[0], t.world.y - q[2], t.world.z + q[1]) < 0.6;
        });
        if (ok) return { k, back, from: state.camera.position.toArray(), at: state.controls.target.toArray() };
      }
      return null;
    },
    azimuth() {
      const d = state.camera.position.clone().sub(state.controls.target);
      return Math.atan2(d.x, d.z) * 180 / Math.PI;
    },
    // A bare canvas pixel: nothing of Connect's under it, and (plate) the plate itself, for a real orbit drag.
    barePixel(onPlate) {
      const r = state.renderer.domElement.getBoundingClientRect();
      for (let y = r.bottom - 30; y > r.top + 100; y -= 25) for (let x = r.right - 40; x > r.left + 400; x -= 25) {
        if (document.elementFromPoint(x, y) !== state.renderer.domElement) continue;
        if (NSO_bridgeTargetAt({ clientX: x, clientY: y })) continue;
        if (onPlate && !hitPlateSurface({ clientX: x, clientY: y })) continue;
        return { x, y };
      }
      return null;
    },
    panel() {
      const C = state.connect || {}, el = id => document.getElementById(id);
      const kids = C.overlay ? C.overlay.children.map(c => c.userData.role + ':' + c.userData.kind) : [];
      const vis = id => !el(id).hidden;
      return {
        open: !!C.open, hidden: el('connect-panel').hidden, readout: el('connect-readout').textContent,
        bad: el('connect-readout').classList.contains('is-bad'), goDisabled: el('btn-connect-go').disabled,
        aText: el('connect-a-text').textContent, bText: el('connect-b-text').textContent,
        rows: { string: vis('connect-string-rows'), ribbon: vis('connect-ribbon-rows'), tube: vis('connect-tube-rows'), tapered: vis('connect-tapered-rows') },
        overlay: kids, line: !!(C.line && C.line.parent), ghost: !!(C.ghost && C.ghost.parent),
        ghostTris: C.ghost ? C.ghost.geometry.attributes.position.count / 3 : 0,
        planTris: C.plan && C.plan.ok ? C.plan.web.length / 9 : 0, planOk: !!(C.plan && C.plan.ok),
        reason: C.plan && !C.plan.ok ? C.plan.reason : '', length: C.plan && C.plan.ok ? C.plan.lengthMm : null,
        a: C.a ? C.a.target.kind : null, b: C.b ? C.b.target.kind : null,
        aPoint: C.a ? C.a.target.point.slice() : null, aObj: C.a ? C.a.sourceId : null,
        pressNull: !C.press, controlsOn: state.controls.enabled,
        ghostMat: C.ghost ? { color: C.ghost.material.color.getHex(), opacity: C.ghost.material.opacity } : null
      };
    },
    topo(id) { return NSO_Bridge.topology(this.up(id)); },
    snapshot() {
      return state.placed.filter(p => p && p.mesh).map(p => {
        const m = state.models.find(x => x.id === p.sourceId);
        return { id: p.sourceId, x: p.x, z: p.z, pos: [p.mesh.position.x, p.mesh.position.y, p.mesh.position.z],
                 raw: m && m.rawTris ? Array.from(m.rawTris).join(',') : null };
      });
    }
  };
}

const SP = (page, q) => page.evaluate(q => window.__cn.screen(q), q);
const P = page => page.evaluate(() => window.__cn.panel());
async function clickAt(page, q) {
  const s = await SP(page, q);
  await page.mouse.move(s.x, s.y);
  await page.mouse.click(s.x, s.y);
  await page.waitForTimeout(40);
}
async function setAndWait(page) {
  const before = await page.evaluate(() => state.undoStack.length);
  await page.click('#btn-connect-go');
  await page.waitForFunction(n => state.undoStack.length > n || (state.connect && !state.connect.busy &&
    document.getElementById('connect-readout').classList.contains('is-bad')), before, { timeout: 60000 });
  return page.evaluate(n => state.undoStack.length > n, before);
}
const undo = page => page.evaluate(() => undoLast());
const sameSnap = (a, b) => a.length === b.length && a.every(x => b.some(y => y.id === x.id && y.raw === x.raw && y.x === x.x && y.z === x.z && y.pos.every((v, k) => v === x.pos[k])));

withApp(async (page, logs) => {
  await page.evaluate(installHelpers);

  console.log('\n=== 1. the drop-down: between Crop and Join ===');
  const ui = await page.evaluate(() => {
    const m = document.getElementById('menu-connect'), crop = document.getElementById('menu-crop'), join = document.getElementById('menu-joins');
    const kids = [...m.parentElement.children];
    const b = document.getElementById('btn-connect');
    return { menu: !!m, between: kids.indexOf(m) === kids.indexOf(crop) + 2 && kids.indexOf(m) + 2 === kids.indexOf(join) ||
                                 (kids.filter(k => k.tagName === 'DETAILS').indexOf(m) === kids.filter(k => k.tagName === 'DETAILS').indexOf(crop) + 1 &&
                                  kids.filter(k => k.tagName === 'DETAILS').indexOf(join) === kids.filter(k => k.tagName === 'DETAILS').indexOf(m) + 1),
             title: m.querySelector('summary').textContent.trim(), wired: b && b.dataset.nsoWired === '1', hidden: document.getElementById('connect-panel').hidden,
             sameLook: document.getElementById('connect-panel').className === document.getElementById('bridge-panel').className };
  });
  check('#menu-connect is a column drop-down named Connect, right after Crop and right before Join', ui.menu && ui.between && ui.title === 'Connect', ui.title);
  check('...its button is wired, its card shut, and the card has Bridge\'s look', ui.wired && ui.hidden && ui.sameLook);

  console.log('\n=== 2. two clicks, not a drag: A stays marked through an orbit ===');
  const ids = [];
  for (const nm of ['sphA', 'sphB']) ids.push(await loadSTL(page, L.writeSTL(path.join(TMP, nm + '.stl'), L.sphere([0, 0, 8], 8, 32, 16))));
  await page.evaluate(ids => {
    const b = ids.map(id => window.__cn.bounds(window.__cn.up(id)));
    window.__cn.nudge(ids[1], (b[0].lo[0] + 34) - b[1].lo[0], -(b[0].lo[1] - b[1].lo[1]));
  }, ids);
  await page.click('#btn-connect');
  await page.waitForFunction(() => state.connect && state.connect.open, null, { timeout: 5000 });
  let C = await P(page);
  check('Connect opens its card; the readout says what to do', C.open && !C.hidden && /Click anchor A on a piece, orbit as you like, then click anchor B/.test(C.readout), C.readout);
  check('...Set is off, the String row shows (the default shape), Weld is chosen',
    C.goDisabled && C.rows.string && !C.rows.ribbon && !C.rows.tube && !C.rows.tapered &&
    await page.evaluate(() => document.querySelector('input[name="connect-result"]:checked').value === 'weld'));
  const cen = await page.evaluate(ids => ids.map(id => { const b = window.__cn.bounds(window.__cn.up(id)); return [(b.lo[0] + b.hi[0]) / 2, (b.lo[1] + b.hi[1]) / 2, (b.lo[2] + b.hi[2]) / 2]; }), ids);
  // On the sides that face each other and tip upward (50° up), so both are in sight from the front AND from the end.
  const cp = Math.cos(50 * Math.PI / 180), sp = Math.sin(50 * Math.PI / 180);
  const pa = [cen[0][0] + 8 * cp, cen[0][1] + 0.3, cen[0][2] + 8 * sp], pb = [cen[1][0] - 8 * cp, cen[1][1] + 0.3, cen[1][2] + 8 * sp];
  const mid = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2];
  const V1 = [mid[0], mid[2] + 45, -mid[1] + 25], AT = [mid[0], mid[2], -mid[1]];
  let fr = await page.evaluate(([m, pa, pb, V1, AT]) => window.__cn.frame([pa, pb], ['point', 'point'], V1, AT), [mid, pa, pb, V1, AT]);
  check('a view with both sphere points on bare canvas', !!fr, JSON.stringify(fr && { k: fr.k, back: fr.back }));
  const az0 = await page.evaluate(() => window.__cn.azimuth());

  // hover
  const sA = await SP(page, pa);
  await page.mouse.move(sA.x, sA.y);
  await page.waitForTimeout(40);
  C = await P(page);
  check('hovering a sphere lights the point and names it', C.overlay.includes('hover:point') && /Under the pointer: point - click to make it anchor A/.test(C.readout), C.overlay.join(',') + ' | ' + C.readout);
  await shot(page, '01-hover');

  // click A
  await page.mouse.click(sA.x, sA.y);
  await page.waitForTimeout(40);
  C = await P(page);
  const aPicked = C;
  check('one click is anchor A: it is marked, named on the card, and nothing is held', C.a === 'point' && !C.b && C.overlay.includes('a:point') &&
    /Anchor A: point/.test(C.aText) && /Anchor B: — click a piece/.test(C.bText) && C.pressNull && C.controlsOn && !C.planOk, C.aText + ' | ' + C.readout);
  check('...the piece was not selected or moved by the click (the press was Connect\'s)', await page.evaluate(ids => {
    const b = ids.map(id => window.__cn.bounds(window.__cn.up(id)));
    return Math.abs((b[1].lo[0] - b[0].lo[0]) - 34) < 1e-4;
  }, ids));
  // the line from A follows the pointer
  const sB0 = await SP(page, pb);
  await page.mouse.move(sB0.x - 30, sB0.y);
  await page.mouse.move(sB0.x, sB0.y, { steps: 4 });
  await page.waitForTimeout(40);
  C = await P(page);
  check('a line from A follows the pointer (nothing held down)', C.line && C.a === 'point' && !C.b, 'line ' + C.line);
  await shot(page, '02-anchor-a-line');

  // a real mouse orbit drag from the plate, and the wheel
  const bare = await page.evaluate(() => window.__cn.barePixel(true));
  check('a bare spot on the plate to orbit from', !!bare, JSON.stringify(bare));
  const camBefore = await page.evaluate(() => state.camera.position.toArray());
  await page.mouse.move(bare.x, bare.y);
  await page.mouse.down();
  await page.mouse.move(bare.x - 120, bare.y - 20, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const camAfter = await page.evaluate(() => state.camera.position.toArray());
  C = await P(page);
  check('a real mouse drag from the plate orbits the camera, and A is unchanged', Math.hypot(...camAfter.map((v, i) => v - camBefore[i])) > 1 &&
    C.a === 'point' && C.aObj === aPicked.aObj && C.aPoint.every((v, i) => v === aPicked.aPoint[i]) && !C.b, 'camera moved ' + Math.hypot(...camAfter.map((v, i) => v - camBefore[i])).toFixed(1));
  await page.mouse.move(bare.x, bare.y);
  const dBefore = await page.evaluate(() => state.camera.position.distanceTo(state.controls.target));
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(80);
  const dAfter = await page.evaluate(() => state.camera.position.distanceTo(state.controls.target));
  C = await P(page);
  check('the wheel zooms, and A is unchanged', Math.abs(dAfter - dBefore) > 0.5 && C.a === 'point' && C.aPoint.every((v, i) => v === aPicked.aPoint[i]), dBefore.toFixed(1) + ' -> ' + dAfter.toFixed(1));

  // 90 degrees about the target, then a view where B can be clicked
  const V2 = await page.evaluate(([V1, AT]) => {
    const d = [V1[0] - AT[0], V1[1] - AT[1], V1[2] - AT[2]];
    // 90 degrees about the vertical (display Y): x -> z, z -> -x
    return [AT[0] + d[2], AT[1] + d[1], AT[2] - d[0]];
  }, [V1, AT]);
  fr = await page.evaluate(([pa, pb, V2, AT]) => window.__cn.frame([pa, pb], ['point', 'point'], V2, AT), [pa, pb, V2, AT]);
  const az1 = await page.evaluate(() => window.__cn.azimuth());
  let turn = ((az1 - az0) % 360 + 540) % 360 - 180;
  check('the camera is turned 90° round the pair', !!fr && Math.abs(Math.abs(turn) - 90) < 2, 'azimuth ' + az0.toFixed(1) + '° -> ' + az1.toFixed(1) + '°');
  C = await P(page);
  check('A is unchanged after the 90° orbit: same piece, same point, still marked, B not set', C.a === 'point' && C.aObj === aPicked.aObj &&
    C.aPoint.every((v, i) => v === aPicked.aPoint[i]) && C.overlay.includes('a:point') && !C.b, JSON.stringify(C.aPoint));
  await shot(page, '03-after-orbit');

  // click B
  await clickAt(page, pb);
  C = await P(page);
  check('the second click is anchor B: a String is previewed, Set is on', C.a === 'point' && C.b === 'point' && C.planOk && !C.goDisabled && !C.bad &&
    new RegExp('^String Ø2\\.0, ' + (C.length || 0).toFixed(1) + ' mm between the anchors · welds into A and B · Set welds it$').test(C.readout), C.readout);
  check('...the ghost is the very soup Set commits, drawn as Bridge\'s (amber, 0.75)', C.ghost && C.ghostTris === C.planTris && C.planTris > 0 &&
    C.ghostMat.color === 0xf59e0b && C.ghostMat.opacity === 0.75 && !C.line, C.ghostTris + ' triangles');
  const geomL = Math.hypot(...[0, 1, 2].map(k => pa[k] - pb[k]));
  check('...the length is the anchors\' distance (' + (C.length || 0).toFixed(2) + ' mm, the clicks were ' + geomL.toFixed(2) + ' apart)', Math.abs(C.length - geomL) < 0.5);
  await shot(page, '04-string-ghost');

  console.log('\n=== 3. Shape: each re-plans and re-draws the ghost; a typed field redraws it ===');
  const SHAPES = [
    ['ribbon', /^Ribbon 6\.0 × 1\.2 mm, /, 'ribbon'], ['tube', /^Tube Ø4\.0 × 0\.8 wall, /, 'tube'], ['tapered', /^Tapered Ø4\.0 → Ø1\.5, /, 'tapered'], ['string', /^String Ø2\.0, /, 'string']
  ];
  for (const [shape, re, rows] of SHAPES) {
    await page.selectOption('#sel-connect-shape', shape);
    await page.waitForTimeout(60);
    C = await P(page);
    check(shape + ': the card shows its own fields only, the ghost is its soup, the readout names it', C.planOk && re.test(C.readout) && C.ghost && C.ghostTris === C.planTris &&
      Object.keys(C.rows).every(k => C.rows[k] === (k === rows)), C.readout + ' | ' + C.ghostTris + ' tris');
    if (shape !== 'string') await shot(page, '05-' + shape + '-ghost');
  }
  await page.fill('#inp-connect-dia', '3');
  await page.waitForFunction(() => /^String Ø3\.0/.test(document.getElementById('connect-readout').textContent), null, { timeout: 3000 }).catch(() => {});
  C = await P(page);
  check('typing a new Ø redraws the ghost with no further click', C.planOk && /^String Ø3\.0, /.test(C.readout), C.readout);
  await page.fill('#inp-connect-dia', '2');
  await page.waitForTimeout(250);
  await page.selectOption('#sel-connect-shape', 'ribbon');
  await page.fill('#inp-connect-width', '4');
  await page.waitForFunction(() => /^Ribbon 4\.0 /.test(document.getElementById('connect-readout').textContent), null, { timeout: 3000 }).catch(() => {});
  C = await P(page);
  check('a Ribbon\'s width field redraws it too', /^Ribbon 4\.0 × 1\.2 mm, /.test(C.readout), C.readout);
  await page.fill('#inp-connect-width', '6');
  await page.waitForTimeout(250);
  await page.selectOption('#sel-connect-shape', 'tube');
  await page.fill('#inp-connect-wall', '2');
  await page.waitForFunction(() => /leaves no bore/.test(document.getElementById('connect-readout').textContent), null, { timeout: 3000 }).catch(() => {});
  C = await P(page);
  check('a Tube whose wall is half its Ø is refused in words, no ghost, Set off', !C.planOk && C.bad && !C.ghost && C.goDisabled && /leaves no bore in a Ø4\.0 tube/.test(C.readout), C.readout);
  await page.fill('#inp-connect-wall', '0.8');
  await page.waitForTimeout(250);
  await page.selectOption('#sel-connect-shape', 'string');
  await page.waitForTimeout(60);

  console.log('\n=== 4. Set both ways, every shape, one Undo each ===');
  const spheres = await page.evaluate(() => window.__cn.snapshot());
  const WORDS = { string: 'String', ribbon: 'Ribbon', tube: 'Tube', tapered: 'Tapered' };
  for (const result of ['weld', 'separate']) {
    await page.check('input[name="connect-result"][value="' + result + '"]');
    for (const shape of ['string', 'ribbon', 'tube', 'tapered']) {
      await page.selectOption('#sel-connect-shape', shape);
      await page.waitForTimeout(60);
      C = await P(page);
      const planned = C.planOk && new RegExp(result === 'weld' ? 'welds into A and B · Set welds it$' : 'kept as its own piece · Set adds it$').test(C.readout);
      const depth = await page.evaluate(() => state.undoStack.length);
      const did = planned && await setAndWait(page);
      const after = await page.evaluate(() => {
        const e = state.placed[state.placed.length - 1];
        return { models: state.models.length, placed: state.placed.length, id: e.sourceId, name: state.models.find(m => m.id === e.sourceId).name,
                 status: document.getElementById('status').textContent, open: state.connect.open, ghost: !!state.connect.ghost, a: !!state.connect.a,
                 sel: state.editId === e.sourceId, listed: document.getElementById('model-list').textContent,
                 undo: state.undoStack.length, label: state.undoStack.length ? state.undoStack[state.undoStack.length - 1].label : '' };
      });
      const topo = await page.evaluate(id => window.__cn.topo(id), after.id);
      if (result === 'weld') {
        check(WORDS[shape] + ' · Weld: Set makes two spheres one closed solid, ONE undo step', did && after.models === 1 && after.placed === 1 && after.undo === depth + 1 &&
          /Connect done/.test(after.status) && topo.open === 0 && topo.nm === 0 && topo.badWinding === 0 && topo.shells === (shape === 'tube' ? 2 : 1),
          (shape === 'tube' ? '2 shells = the solid and its sealed bore; ' : '') + JSON.stringify(topo));
        check('...named for what it is, selected; the card stays open for the next one, the picks and ghost gone', /\(connected\)$/.test(after.name) && after.sel && after.open && !after.ghost && !after.a, after.name);
        if (shape === 'string' || shape === 'tube') await shot(page, '06-weld-' + shape);
      } else {
        check(WORDS[shape] + ' · Keep separate: Set adds a third piece, ONE undo step', did && after.models === 3 && after.placed === 3 && after.undo === depth + 1 && /Connect done/.test(after.status) &&
          topo.open === 0 && topo.nm === 0 && topo.badWinding === 0 && topo.shells === (shape === 'tube' ? 2 : 1), JSON.stringify(topo));
        check('...closed, listed in PLATE & PIECES by name, selected and on the plate to grab; the spheres untouched', after.name === 'Connector (' + shape + ')' &&
          after.listed.indexOf('Connector (' + shape + ')') >= 0 && after.sel && sameSnap(spheres, (await page.evaluate(() => window.__cn.snapshot())).filter(s => spheres.some(x => x.id === s.id))), after.name);
        if (shape === 'string' || shape === 'tube') await shot(page, '07-separate-' + shape);
      }
      await undo(page);
      const back = await page.evaluate(() => ({ snap: window.__cn.snapshot(), status: document.getElementById('status').textContent, models: state.models.length }));
      check('  Undo: ' + (result === 'weld' ? 'both spheres back, bit for bit' : 'the connector is off the plate, the spheres as they were'),
        back.models === 2 && sameSnap(spheres, back.snap) && /Undo: Connect reverted/.test(back.status), back.status);
      // Re-pick: a Set clears the picks and an Undo drops them.
      fr = await page.evaluate(([pa, pb, V2, AT]) => window.__cn.frame([pa, pb], ['point', 'point'], V2, AT), [pa, pb, V2, AT]);
      await clickAt(page, pa);
      await clickAt(page, pb);
      C = await P(page);
      if (!C.planOk) check('  re-picked A and B after the Undo', false, C.readout);
    }
  }

  console.log('\n=== 5. clearing: A again, a click on nothing, Escape; a new place replaces B ===');
  await page.selectOption('#sel-connect-shape', 'string');
  await page.check('input[name="connect-result"][value="weld"]');
  C = await P(page);
  check('both anchors set, the String previewed', C.a === 'point' && C.b === 'point' && C.planOk);
  await clickAt(page, pb);
  C = await P(page);
  check('clicking B again clears B (the ghost goes, A stays)', !C.b && C.a === 'point' && !C.ghost && C.goDisabled && /Anchor B: — click a piece/.test(C.bText));
  await clickAt(page, pb);
  const pb2 = [pb[0], pb[1] + 1.4, pb[2] + 0.6];
  await clickAt(page, pb2);
  C = await P(page);
  check('with both set, a click on a new place replaces B', C.a === 'point' && C.b === 'point' && C.planOk, C.readout);
  await clickAt(page, pa);
  C = await P(page);
  check('clicking A again clears A (B stays, the ghost goes)', !C.a && C.b === 'point' && !C.ghost && C.goDisabled && /Anchor A: — click a piece/.test(C.aText));
  await clickAt(page, pa);
  C = await P(page);
  check('...and the next click fills the empty anchor', C.a === 'point' && C.b === 'point' && C.planOk);
  const bare2 = await page.evaluate(() => window.__cn.barePixel(false));
  await page.mouse.click(bare2.x, bare2.y);
  await page.waitForTimeout(40);
  C = await P(page);
  check('a click on nothing clears the picks', !C.a && !C.b && !C.ghost && C.goDisabled && /Click anchor A on a piece/.test(C.readout), C.readout);
  await clickAt(page, pa);
  const bare3 = await page.evaluate(() => window.__cn.barePixel(true));
  await page.mouse.move(bare3.x, bare3.y);
  await page.mouse.down();
  await page.mouse.move(bare3.x + 60, bare3.y + 10, { steps: 5 });
  await page.mouse.up();
  C = await P(page);
  check('...an orbit drag from nothing does not', C.a === 'point');
  await page.keyboard.press('Escape');
  C = await P(page);
  check('Escape clears them', !C.a && !C.b && !C.line && C.open, C.readout);
  fr = await page.evaluate(([pa, pb, V2, AT]) => window.__cn.frame([pa, pb], ['point', 'point'], V2, AT), [pa, pb, V2, AT]);

  console.log('\n=== 6. a third piece in the way ===');
  await clickAt(page, pa);
  await clickAt(page, pb);
  const boxId = await loadSTL(page, L.writeSTL(path.join(TMP, 'wall.stl'), L.box(0, 0, 0, 4, 14, 14)));
  await page.evaluate(([id, m]) => {
    const b = window.__cn.bounds(window.__cn.up(id));
    window.__cn.nudge(id, m[0] - (b.lo[0] + b.hi[0]) / 2, -(m[1] - (b.lo[1] + b.hi[1]) / 2));
  }, [boxId, mid]);
  await page.evaluate(() => { const e = document.getElementById('sel-connect-shape'); e.dispatchEvent(new Event('change')); });
  await page.waitForTimeout(80);
  C = await P(page);
  check('the straight connector through a piece standing between is refused in words, no ghost, Set off', !C.planOk && C.bad && !C.ghost && C.goDisabled &&
    /passes through a third piece \(/.test(C.readout), C.readout);
  await shot(page, '08-third-piece-refused');
  await page.evaluate(id => {
    const i = state.placed.findIndex(p => p && p.sourceId === id);
    state.placed[i].mesh.parent.remove(state.placed[i].mesh);
    state.placed.splice(i, 1); state.models = state.models.filter(m => m.id !== id);
    state.placed.forEach((p, j) => { if (p.mesh) p.mesh.userData.placedIndex = j; });
  }, boxId);
  await page.evaluate(() => { const e = document.getElementById('sel-connect-shape'); e.dispatchEvent(new Event('change')); });
  C = await P(page);
  check('...taken away, it plans again', C.planOk && !C.bad, C.readout);

  console.log('\n=== 7. Cancel ===');
  await page.click('#btn-connect-cancel');
  C = await P(page);
  check('Cancel drops the picks and keeps the card', C.open && !C.a && !C.b && !C.ghost && C.goDisabled);
  await page.click('#btn-connect-cancel');
  C = await P(page);
  check('...pressed again with nothing picked, it closes the card', !C.open && C.hidden && C.overlay.length === 0);

  console.log('\n=== 8. Attach, under Set / Cancel ===');
  {
    const bigId = await loadSTL(page, L.writeSTL(path.join(TMP, 'big.stl'), L.sphere([0, 0, 30], 30, 48, 24)));
    await page.evaluate(id => {
      const b = window.__cn.bounds(window.__cn.up(id));
      window.__cn.nudge(id, 0 - (b.lo[0] + b.hi[0]) / 2, 0 - (b.lo[1] + b.hi[1]) / 2);
    }, bigId);
    const attachState = () => page.evaluate(() => {
      const b = document.getElementById('btn-stock-attach');
      return { pressed: b.getAttribute('aria-pressed'), lit: b.classList.contains('is-armed'), flag: !!state.attachArmed,
               status: document.getElementById('status').textContent };
    });
    const where = await page.evaluate(() => {
      const b = document.getElementById('btn-stock-attach'), set = document.getElementById('btn-connect-go'),
            cancel = document.getElementById('btn-connect-cancel'), panel = document.getElementById('connect-panel');
      const rb = b.getBoundingClientRect();
      return { inCard: panel.contains(b), hiddenWithCard: getComputedStyle(b).display === 'none' || !!b.closest('[hidden]'),
               rowAfterPair: b.parentElement.previousElementSibling === cancel.parentElement,
               cancelPeers: cancel.parentElement.contains(set), id: b.id, label: b.textContent.trim(), rb: [rb.width, rb.height] };
    });
    check('Attach is in the Connect card, in a row of its own right after the Set / Cancel row, labelled Attach, id btn-stock-attach',
      where.inCard && where.rowAfterPair && where.cancelPeers && where.label === 'Attach' && where.id === 'btn-stock-attach', JSON.stringify(where));
    check('...and it is out of sight while the card is shut', where.hiddenWithCard);

    // The card, with the shelf not yet clicked.
    await page.click('#menu-connect > summary');
    await page.click('#btn-connect');
    await page.waitForFunction(() => state.connect && state.connect.open, null, { timeout: 5000 });
    const geo = await page.evaluate(() => {
      const cancel = document.getElementById('btn-connect-cancel').getBoundingClientRect(), a = document.getElementById('btn-stock-attach').getBoundingClientRect();
      return { below: a.top >= cancel.bottom - 0.5, visible: a.width > 20 && a.height > 10 };
    });
    check('open, it is visible and sits BELOW Set / Cancel', geo.below && geo.visible, JSON.stringify(geo));
    await page.click('#btn-stock-attach');
    let A = await attachState();
    check('with no shape clicked on the shelf yet it does not arm, and says where to click',
      A.pressed === 'false' && !A.lit && !A.flag && /Attach needs a shape - click one on the Stock shelf/.test(A.status), A.status);

    // A real click on a shelf tile; the dropped piece is not the target, so it goes.
    await page.click('#menu-gen > summary');
    await page.click('#menu-gen .vp-stock-menu > summary');
    await page.click('#btn-stock-cylinder');
    const droppedId = await page.evaluate(() => state.models[state.models.length - 1].id);
    check('the shelf remembers the shape last clicked', await page.evaluate(() => nsoStockShelf.lastShape()) === 'cylinder');
    await page.evaluate(id => {
      const i = state.placed.findIndex(p => p && p.sourceId === id);
      state.placed[i].mesh.parent.remove(state.placed[i].mesh);
      state.placed.splice(i, 1); state.models = state.models.filter(m => m.id !== id);
      state.placed.forEach((p, j) => { if (p.mesh) p.mesh.userData.placedIndex = j; });
      state.selectedIndex = -1;
    }, droppedId);

    // Back to Connect: a point on the big sphere, bare canvas.
    await page.click('#menu-connect > summary');
    const open = await page.evaluate(() => !!(state.connect && state.connect.open));
    if (!open) await page.click('#btn-connect');
    await page.waitForFunction(() => state.connect && state.connect.open, null, { timeout: 5000 });
    const big = await page.evaluate(id => { const b = window.__cn.bounds(window.__cn.up(id)); return [(b.lo[0] + b.hi[0]) / 2, (b.lo[1] + b.hi[1]) / 2, (b.lo[2] + b.hi[2]) / 2]; }, bigId);
    const pt = [big[0] + 30 * cp, big[1], big[2] + 30 * sp];
    const V3 = [big[0] + 70, big[2] + 70, -big[1] + 70], AT3 = [big[0], big[2], -big[1]];
    const fr3 = await page.evaluate(([pt, V3, AT3]) => window.__cn.frame([pt], ['point'], V3, AT3), [pt, V3, AT3]);
    check('a view with a point on the big sphere on bare canvas', !!fr3);

    await clickAt(page, pt);
    C = await P(page);
    check('Connect takes the click as anchor A while Attach is off', C.a === 'point' && !!C.aObj, C.aText);
    await page.click('#btn-stock-attach');
    A = await attachState();
    C = await P(page);
    check('Attach arms (pressed, lit), names the shape, and drops Connect\'s anchor',
      A.pressed === 'true' && A.lit && A.flag && /Attach armed/.test(A.status) && /cylinder blank/.test(A.status) && !C.a && !C.b && C.goDisabled, A.status);
    const s0 = await SP(page, pt);
    await page.mouse.move(s0.x, s0.y);
    await page.waitForTimeout(60);
    C = await P(page);
    check('...and Connect lights nothing under the pointer while it is armed', !C.overlay.some(o => /^hover/.test(o)), C.overlay.join(','));

    // The click is Attach's.
    const before = await page.evaluate(id => ({ models: state.models.length, tris: state.models.find(m => m.id === id).rawTris.length / 9,
      undo: state.undoStack.length }), bigId);
    await page.mouse.click(s0.x, s0.y);
    await page.waitForFunction(() => /^Attach(ed| refused| failed| stood)/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
    A = await attachState();
    C = await P(page);
    const after = await page.evaluate(id => ({ models: state.models.length, tris: state.models.find(m => m.id === id).rawTris.length / 9,
      undo: state.undoStack.length }), bigId);
    console.log('   status: ' + A.status.slice(0, 170));
    check('a click on a piece while armed is Attach\'s: the blank is seated and unioned into that piece, same readout',
      /^Attached cylinder /.test(A.status) && /seated/.test(A.status) && after.tris > before.tris && after.models === before.models && after.undo === before.undo + 1,
      before.tris + ' -> ' + after.tris + ' tris, models ' + before.models + ' -> ' + after.models);
    check('...and Connect took no anchor from it', !C.a && !C.b, C.aText + ' | ' + C.bText);
    check('...Attach stays armed for the next click', A.flag && A.pressed === 'true');
    await page.evaluate(() => undoLast());

    // Escape.
    await page.keyboard.press('Escape');
    A = await attachState();
    check('Escape turns Attach off', !A.flag && A.pressed === 'false' && !A.lit && /Attach off/.test(A.status), A.status);
    await clickAt(page, pt);
    C = await P(page);
    check('...and Connect\'s clicks are Connect\'s again', C.a === 'point', C.aText);
    await page.keyboard.press('Escape');

    // Cancel.
    await page.click('#btn-stock-attach');
    check('armed again', (await attachState()).flag);
    await page.click('#btn-connect-cancel');
    A = await attachState();
    C = await P(page);
    check('Cancel turns Attach off and leaves the card open', !A.flag && A.pressed === 'false' && C.open && !C.hidden, A.status);

    // Closing the card.
    await page.click('#btn-stock-attach');
    check('armed once more', (await attachState()).flag);
    await page.click('#btn-connect');
    A = await attachState();
    C = await P(page);
    check('closing the card turns Attach off - it is not left lit where it cannot be seen', !A.flag && A.pressed === 'false' && !C.open && C.hidden, A.status);
    await shot(page, '09-attach');
  }

  const errs = logs.filter(l => /\[pageerror\]|\[error\]/.test(l) && !/favicon/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log('\n' + (fails ? fails + ' FAILED' : 'all gates held') + '   (screenshots in tools/connect-out/)');
  process.exitCode = fails ? 1 : 0;
}).catch(e => { console.error(e); process.exit(1); });
