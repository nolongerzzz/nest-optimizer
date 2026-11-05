#!/usr/bin/env node
/* Rotate rings - the ticket's drive-check, in the real app, with screenshots.

   node tools/nso_rotate_rings_drive_check.js [outDir]     exit 0 = every step held

   Every step is a real mouse or keyboard action on the page; what is read back
   is read from the scene. Screenshots go to outDir (default a fresh
   nso-rotate-rings-* dir under the OS temp dir, outside the repo; the path
   is printed at the end).

   The piece is the 80 x 40 x 20 box hull, so a turn and a lean are visible
   at a glance - a cube looks the same from too many sides.

   Bambu Studio is not on this machine. The export step therefore checks the
   file the way Bambu reads it: every vertex in the downloaded .3mf's mesh,
   against the same vertex as the screen draws it, in Bambu's plate frame. */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

const OUT = process.argv[2] ? path.resolve(process.argv[2])
                            : fs.mkdtempSync(path.join(os.tmpdir(), 'nso-rotate-rings-'));
fs.mkdirSync(OUT, { recursive: true });
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const shot = async (page, name) => {
  await page.waitForTimeout(120);
  await page.screenshot({ path: path.join(OUT, name + '.png'), clip: { x: 300, y: 60, width: 1100, height: 760 } });
  console.log('   [screenshot] ' + name + '.png');
};

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 860 });
  await loadSTL(page, path.join(ROOT, 'fixtures', 'box_hull_80x40x20-2.stl'));
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    selectPlaced(0);
    const H = window.__d = {};
    H.p = () => state.placed[0];
    H.q = () => { const p = H.p(); p.mesh.updateMatrixWorld(true); return p.mesh.quaternion.toArray(); };
    H.angle = (qa, qb) => {
      const a = new THREE.Quaternion().fromArray(qa), b = new THREE.Quaternion().fromArray(qb);
      const d = b.clone().multiply(a.clone().invert());
      return 2 * Math.atan2(Math.hypot(d.x, d.y, d.z), Math.abs(d.w)) * 180 / Math.PI;
    };
    H.cam = (x, y, z) => {
      const c = H.p().mesh.position;
      state.controls.target.copy(c);
      state.camera.position.set(c.x + x, c.y + y, c.z + z);
      state.controls.update();
      state.camera.updateMatrixWorld(true);
      window.nsoRotate.refresh();
    };
    /* the screen angle of a point fixed to the piece, about its centre - a
       point off Z, so it is off both the Turn axis and the lean-X axis */
    H.mark = (ring) => {
      const p = H.p();
      /* off the ring's axis: Turn's is the vertical, front/back's the piece's own X */
      const off = new THREE.Vector3(0, 0, 1);
      const w = p.mesh.position.clone().add(off.multiplyScalar(30));
      return p.mesh.worldToLocal(w).toArray();
    };
    H.markAngle = (local) => {
      const p = H.p(); p.mesh.updateMatrixWorld(true);
      const r = state.renderer.domElement.getBoundingClientRect();
      const s = v => { v = v.clone().project(state.camera);
        return { x: r.left + (v.x * .5 + .5) * r.width, y: r.top + (-v.y * .5 + .5) * r.height }; };
      const a = s(p.mesh.localToWorld(new THREE.Vector3().fromArray(local))), c = s(p.mesh.position);
      return Math.atan2(a.y - c.y, a.x - c.x) * 180 / Math.PI;
    };
    H.heights = () => {
      const p = H.p(); p.mesh.updateMatrixWorld(true);
      const pos = p.mesh.geometry.attributes.position, v = new THREE.Vector3(), out = [];
      for (let i = 0; i < pos.count; i += 7) { v.fromBufferAttribute(pos, i); p.mesh.localToWorld(v); out.push(v.y); }
      return out;
    };
  });
  const N = page.evaluate.bind(page);
  /* A real drag from an arrowhead round the projected centre. */
  const dragRing = async (ring, screenDeg, opts) => {
    opts = opts || {};
    const h = await N(r => window.nsoRotate.handleScreen(r, 1), ring);
    const c = await N(() => window.nsoRotate.centreScreen());
    const a0 = Math.atan2(h.y - c.y, h.x - c.x), R = Math.hypot(h.x - c.x, h.y - c.y);
    await page.mouse.move(h.x, h.y);
    await page.mouse.down();
    const n = Math.abs(screenDeg);
    for (let i = 1; i <= n; i++) {
      const a = a0 + Math.sign(screenDeg) * i * Math.PI / 180;
      await page.mouse.move(c.x + Math.cos(a) * R, c.y + Math.sin(a) * R);
      if (opts.at && opts.at[i]) await opts.at[i]();
    }
    if (opts.back) for (let i = n - 1; i >= n - opts.back; i--) {
      const a = a0 + Math.sign(screenDeg) * i * Math.PI / 180;
      await page.mouse.move(c.x + Math.cos(a) * R, c.y + Math.sin(a) * R);
    }
    if (opts.beforeUp) await opts.beforeUp();
    await page.mouse.up();
    await page.waitForTimeout(60);
  };

  console.log('\n=== 1. open Rotate on a placed piece ===');
  await N(() => window.__d.cam(150, 140, 190));
  await page.click('#menu-rotate > summary');
  await page.waitForTimeout(150);
  let s = await N(() => ({ rings: window.nsoRotate.rings().join(), drawn: window.nsoRotate.ringCount(),
    turn: document.getElementById('chk-rot-ring-turn').checked,
    others: document.getElementById('chk-rot-ring-fb').checked || document.getElementById('chk-rot-ring-ss').checked }));
  check('one ring, Turn checked', s.rings === 'turn' && s.drawn === 1 && s.turn && !s.others, JSON.stringify(s));
  await shot(page, '01-open-turn-only');

  console.log('\n=== 2. click its arrow once ===');
  let q0 = await N(() => window.__d.q());
  const h = await N(() => window.nsoRotate.handleScreen('turn', 1));
  await page.mouse.click(h.x, h.y);
  await page.waitForTimeout(60);
  let r = await N(q => ({ deg: window.__d.angle(q, window.__d.q()), readout: window.nsoRotate.readout() }), q0);
  check('the piece turns exactly 1°', Math.abs(r.deg - 1) < 1e-6, r.deg.toFixed(9) + '°');
  check('the readout says so', /^Turn 1° /.test(r.readout), JSON.stringify(r.readout));
  await shot(page, '02-click-one-degree');
  /* Back to square for the lap, by key: the key that goes the other way on
     screen from what the readout said. */
  await page.keyboard.press(/⟲/.test(r.readout) ? 'ArrowRight' : 'ArrowLeft');
  r = await N(q => ({ deg: window.__d.angle(q, window.__d.q()), readout: window.nsoRotate.readout() }), q0);
  check('the opposite arrow key takes it back to where it was', r.deg < 1e-6, r.readout);

  console.log('\n=== 3. drag the arrow a full lap ===');
  q0 = await N(() => window.__d.q());
  let maxRead = 0;
  const readNow = async () => {
    const t = await N(() => window.nsoRotate.readout());
    const m = /(\d+(?:\.\d)?)°/.exec(t); if (m) maxRead = Math.max(maxRead, +m[1]);
  };
  const at = {};
  for (let i = 30; i <= 370; i += 30) at[i] = readNow;
  at[370] = async () => { await readNow(); await shot(page, '03-lap-readout-past-360'); };
  await dragRing('turn', 370, { at, back: 10, beforeUp: readNow });
  r = await N(q => ({ deg: window.__d.angle(q, window.__d.q()), readout: window.nsoRotate.readout() }), q0);
  check('a full lap puts the piece back where it started', r.deg < 1e-6, r.deg.toExponential(2) + '°');
  check('the readout crossed 360', maxRead > 360, 'max ' + maxRead + '°, ended "' + r.readout + '"');

  console.log('\n=== 4. orbit to the opposite side, drag the same way on screen ===');
  /* Two rings. Turn: orbiting round the plate keeps the camera above it, so
     the same clockwise on screen is the same turn about the vertical from
     both sides - the old dial was right there by luck. Lean front/back: the
     orbit puts the camera on the other side of the plate's X axis, which is
     where a dial with no view term turned the piece the wrong way. */
  const sides = [];
  for (const ring of ['turn', 'fb']) {
    if (ring === 'fb') { await page.click('#chk-rot-ring-fb'); await page.waitForTimeout(60); }
    for (const [label, cam] of [['near', [150, 140, 190]], ['far', [-150, 140, -190]]]) {
      await N(c => window.__d.cam(c[0], c[1], c[2]), cam);
      await N(rg => { const p = window.__d.p(); p.rotY = 0; p.tiltX = 0; p.tiltZ = 0; applyMeshRotation(p);
        window.nsoRotate.turn(rg, 20); }, ring);         // clear of every snap
      const mark = await N(rg => window.__d.mark(rg), ring);
      const before = await N(m => window.__d.markAngle(m), mark);
      q0 = await N(() => window.__d.q());
      await dragRing(ring, 40);                       // clockwise on screen, every time
      const after = await N(m => window.__d.markAngle(m), mark);
      const d = ((after - before + 540) % 360) - 180;
      const world = await N(a => {
        const q = a.q, A = new THREE.Vector3().fromArray(a.axis);
        const qa = new THREE.Quaternion().fromArray(q), qb = new THREE.Quaternion().fromArray(window.__d.q());
        const dq = qb.clone().multiply(qa.clone().invert());
        return Math.sign(new THREE.Vector3(dq.x, dq.y, dq.z).dot(A) * dq.w) * window.__d.angle(q, window.__d.q());
      }, { q: q0, axis: await N(rg => window.nsoRotate.ringAxis(rg), ring) });   // a lean's axis is the piece's own
      sides.push({ ring, label, onScreen: +d.toFixed(2), world: +world.toFixed(3),
                   readout: await N(() => window.nsoRotate.readout()) });
      await shot(page, '04-' + ring + '-' + label + '-side-after-clockwise-drag');
    }
  }
  sides.forEach(x => console.log('   ' + JSON.stringify(x)));
  for (const ring of ['turn', 'fb']) {
    const [n, f] = sides.filter(x => x.ring === ring);
    check(ring + ': dragged clockwise on screen from the near side, the piece turns clockwise on screen',
      n.onScreen > 20 && Math.abs(Math.abs(n.world) - 40) < 1e-3, n.onScreen + '° on screen, ' + n.world + '° about the axis');
    check(ring + ': ...and from the far side, the same: clockwise on screen',
      f.onScreen > 20 && Math.abs(Math.abs(f.world) - 40) < 1e-3, f.onScreen + '° on screen, ' + f.world + '° about the axis');
  }
  const fb = sides.filter(x => x.ring === 'fb');
  check('fb: from opposite sides of its axis the same screen clockwise is opposite turns about it - the view term',
    Math.sign(fb[0].world) === -Math.sign(fb[1].world), fb.map(x => x.world).join(' vs '));
  await page.click('#chk-rot-ring-fb'); await page.waitForTimeout(60);

  console.log('\n=== 5. lean front/back 90°, then Turn: about the plate\'s vertical ===');
  await N(() => { const p = window.__d.p(); p.rotY = 0; p.tiltX = 0; p.tiltZ = 0; applyMeshRotation(p);
    window.__d.cam(150, 140, 190); });
  await page.click('#chk-rot-ring-fb');
  await page.waitForTimeout(80);
  q0 = await N(() => window.__d.q());
  await dragRing('fb', 91);                           // lands on the quarter turn: the snap holds 87..93
  r = await N(q => ({ deg: window.__d.angle(q, window.__d.q()), fields: (p => ({ tiltX: p.tiltX,
    rotY: p.rotY, tiltZ: p.tiltZ }))(window.__d.p()) }), q0);
  check('leaned exactly 90° (the snap caught it)', Math.abs(r.deg - 90) < 1e-6, r.deg + '° ' + JSON.stringify(r.fields));
  const camA = [150, 140, 190], camB = [-200, 90, 60];
  await shot(page, '05a-leaned-90-before-turn-camA');
  await N(c => window.__d.cam(c[0], c[1], c[2]), camB);
  await shot(page, '05b-leaned-90-before-turn-camB');
  await N(c => window.__d.cam(c[0], c[1], c[2]), camA);
  const hBefore = await N(() => window.__d.heights());
  q0 = await N(() => window.__d.q());
  await dragRing('turn', 30);
  const hAfter = await N(() => window.__d.heights());
  const dh = Math.max(...hBefore.map((v, i) => Math.abs(v - hAfter[i])));
  r = await N(q => {
    const a = new THREE.Quaternion().fromArray(q), b = new THREE.Quaternion().fromArray(window.__d.q());
    const d = b.clone().multiply(a.clone().invert());
    const ax = new THREE.Vector3(d.x, d.y, d.z).normalize();
    return { deg: window.__d.angle(q, window.__d.q()), axis: ax.toArray().map(v => +v.toFixed(9)) };
  }, q0);
  check('the Turn drag turned the leaned piece about the plate\'s vertical',
    Math.abs(Math.abs(r.axis[1]) - 1) < 1e-9 && r.deg > 20, r.deg.toFixed(3) + '° about ' + JSON.stringify(r.axis));
  check('...so no point of it changed height', dh < 1e-6, 'max ' + dh.toExponential(2) + ' mm');
  await shot(page, '05c-leaned-then-turned-camA');
  await N(c => window.__d.cam(c[0], c[1], c[2]), camB);
  await shot(page, '05d-leaned-then-turned-camB');
  await N(c => window.__d.cam(c[0], c[1], c[2]), camA);

  console.log('\n=== 6. export the leaned-and-turned piece ===');
  await N(() => { const f = document.getElementById('export-format'); f.value = '3mf'; f.dispatchEvent(new Event('change')); });
  await N(() => { const e = document.getElementById('btn-export-stl'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#btn-export-stl')]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-rot-'));
  const file = path.join(tmp, dl.suggestedFilename());
  await dl.saveAs(file);
  const parts = execFileSync('unzip', ['-Z1', file]).toString().split('\n').filter(n => /\.model$/.test(n));
  let verts = [], tris = [];
  for (const part of parts) {
    const xml = execFileSync('unzip', ['-p', file, part], { maxBuffer: 1 << 28 }).toString();
    const base = verts.length;
    for (const m of xml.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)) verts.push([+m[1], +m[2], +m[3]]);
    for (const m of xml.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)) tris.push([+m[1] + base, +m[2] + base, +m[3] + base]);
  }
  const screen = await N(() => {
    const p = window.__d.p(); p.mesh.updateMatrixWorld(true);
    const plate = getCurrentPlate(), pos = p.mesh.geometry.attributes.position, v = new THREE.Vector3(), out = [];
    // the screen's vertices in Bambu's plate frame, resting where the export rests them
    const lift = p.mesh.position.y - (p.height / 2 + (p.liftY || 0));
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i); p.mesh.localToWorld(v);
      out.push([v.x + plate.w / 2, -v.z + plate.d / 2, v.y - lift]);
    }
    return out;
  });
  const fileSoup = [].concat(...tris.map(t => t.map(i => verts[i])));
  let worst = Infinity;
  if (fileSoup.length === screen.length) {
    worst = 0;
    for (let i = 0; i < screen.length; i++)
      worst = Math.max(worst, Math.hypot(...[0, 1, 2].map(k => fileSoup[i][k] - screen[i][k])));
  }
  const minZ = Math.min(...verts.map(v => v[2]));
  check('the downloaded .3mf holds the piece where the screen shows it, vertex for vertex',
    worst < 1e-3, (worst === Infinity ? 'counts differ ' + fileSoup.length + ' vs ' + screen.length
      : 'worst ' + worst.toExponential(2) + ' mm') + ' over ' + screen.length + ' vertices, ' + parts.join(','));
  check('...resting on the plate (min z = 0)', Math.abs(minZ) < 1e-3, 'min z ' + minZ);
  /* The file's own triangles laid over the piece as a wireframe, for the eye. */
  await N((soup) => {
    const plate = getCurrentPlate();
    const g = new THREE.BufferGeometry();
    const p = window.__d.p(), lift = p.mesh.position.y - (p.height / 2 + (p.liftY || 0));
    g.setAttribute('position', new THREE.Float32BufferAttribute([].concat(...soup.map(v =>
      [v[0] - plate.w / 2, v[2] + lift, -(v[1] - plate.d / 2)])), 3));
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x22ff88, wireframe: true, depthTest: false }));
    m.name = 'nso-export-overlay'; m.renderOrder = 2000;
    state.scene.add(m);
  }, fileSoup);
  await shot(page, '06-exported-file-overlaid-green');
  await N(() => state.scene.remove(state.scene.getObjectByName('nso-export-overlay')));

  console.log('\n=== 7. check all three ===');
  /* The Export dropdown took the bar, so Rotate closed: open it again - Turn
     only, as every opening is - and tick the other two. */
  await page.click('#menu-rotate > summary');
  await page.waitForTimeout(120);
  await page.click('#chk-rot-ring-fb');
  await page.click('#chk-rot-ring-ss');
  await page.waitForTimeout(80);
  s = await N(() => ({ rings: window.nsoRotate.rings().join(), drawn: window.nsoRotate.ringCount(),
    arrows: window.nsoRotate.handleCount() }));
  check('three rings, two arrowheads each', s.drawn === 3 && s.arrows === 6, JSON.stringify(s));
  await shot(page, '07-all-three-rings');

  console.log('\n=== 8. close Rotate, reopen ===');
  await page.click('#menu-rotate > summary');
  await page.waitForTimeout(100);
  const shut = await N(() => state.scene.getObjectByName('nso-rotate-handles').children.length);
  await page.click('#menu-rotate > summary');
  await page.waitForTimeout(150);
  s = await N(() => ({ rings: window.nsoRotate.rings().join(), drawn: window.nsoRotate.ringCount(),
    boxes: ['turn', 'fb', 'ss'].map(k => +document.getElementById('chk-rot-ring-' + k).checked).join('') }));
  check('closed, nothing is left in the scene', shut === 0, shut + ' parts');
  check('reopened: Turn only', s.rings === 'turn' && s.drawn === 1 && s.boxes === '100', JSON.stringify(s));
  await shot(page, '08-reopened-turn-only');

  console.log('\n=== 9. Undo steps back one drag at a time ===');
  /* Every press so far, newest first: Turn 30, lean 90, the far-side and
     near-side drags (after a pose written straight to the record for the
     test, which is not an Undo point), ArrowLeft, the click. */
  const stack = [];
  stack.push(await N(() => window.__d.q()));
  const undos = [];
  for (let i = 0; i < 2; i++) {
    await page.click('#btn-undo');
    await page.waitForTimeout(80);
    undos.push(await N(() => ({ q: window.__d.q(), f: (p => [p.tiltX, +(p.rotY * 180 / Math.PI).toFixed(6), p.tiltZ])(window.__d.p()) })));
  }
  check('one Undo takes back the Turn drag alone: still leaned 90, yaw back',
    (Math.abs(undos[0].f[0]) === 90 || Math.abs(undos[0].f[2]) === 90) && Math.abs(undos[0].f[1]) < 1e-6,
    JSON.stringify(undos[0].f));
  check('the next takes back the lean: flat again', undos[1].f[0] === 0 && undos[1].f[2] === 0,
    JSON.stringify(undos[1].f));

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  if (errs.length) { console.log('\npage errors:\n' + errs.join('\n')); fails++; }
  console.log('\nscreenshots in ' + OUT);
  console.log(fails ? fails + ' FAILED' : 'every step held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
