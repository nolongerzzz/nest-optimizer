#!/usr/bin/env node
/* The big-mesh gate (big:mesh): a generated 1,000,000-triangle piece - a UV
   sphere, 1000 x 501 - through the real app, and the four checks that hold the
   existing engines to their answers.
     node tools/nso_big_mesh_test.js                exit 0 = every gate held
     node tools/nso_big_mesh_test.js --quick        skip the four fixture checks (4 min)
     node tools/nso_big_mesh_test.js --shots dir    screenshots (default tools/big-mesh-out)
     npm run big:mesh

   1. IMPORT under 6 s: from the file given to the page to the piece on the plate,
      its tree built (nso_bvh.js, in a worker), the status line saying so.
   2. NO STRETCH OF JS over 100 ms through 20 hovers across the piece (each a real ray
      through the viewer's raycast, and the pointer moving over it), 20 wheel steps (each one
      a ray, to find what is under the cursor) and a 2 s orbit drag.
   3. SELECTION under 300 ms of JS, the piece clicked for real; and its outline, its split
      count and its supports read in the background without a stall.
   4. TO PLATE under 300 ms of JS, from a piece lifted off the bed.
   5. THE TREE IS RIGHT AT SCALE: the worker's tree is the one the page builds in place, and
      50 rays through the viewer's raycast return what three's own walk returns - faceIndex,
      distance, point, normal.
   6. BYTE-IDENTICAL on their fixtures: lift:any-face, pose:bounds, split:parts, overlap:drive
      (the four existing checks, run as they are and required to pass).

   WHAT "JS" MEANS HERE. The page draws with software GL in this headless browser, which costs
   the main thread ~0.4 s a frame per million triangles whatever the app does (an idle frame
   with nothing selected does it: see nso_big_mesh_lib.js). So the gates read the stretches
   where JS was on the stack (the DevTools sampling profiler, 0.5 ms) - the app's own time -
   and the report prints the browser's raw Long Tasks beside them, with the idle frame, so the
   difference is on the page rather than argued. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { withApp } = require('./nso_app_harness');
const L = require('./nso_big_mesh_lib');
const { writeSphereSTL } = L;

const argv = process.argv.slice(2);
const QUICK = argv.includes('--quick');
const SHOTS = path.resolve(argv.includes('--shots') ? argv[argv.indexOf('--shots') + 1] : path.join(__dirname, 'big-mesh-out'));
fs.mkdirSync(SHOTS, { recursive: true });

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-big-mesh-'));
const SPHERE = path.join(TMP, 'sphere_1M.stl');
const TRIS = writeSphereSTL(SPHERE, 1000, 501, 40);
console.log('piece: ' + TRIS.toLocaleString() + ' triangles, ' + (fs.statSync(SPHERE).size / 1e6).toFixed(1) + ' MB');

const fmt = r => `js ${r.jsMs.toFixed(0)} ms, longest run ${r.maxJsMs.toFixed(0)} ms, browser long tasks ${r.longTasks.length} (max ${Math.max(0, ...r.longTasks)} ms)`;

(async () => {
  await withApp(async (page, logs) => {
    const cdp = await L.openProfiler(page);
    await page.evaluate(L.installProjector);
    await page.evaluate(() => { window.__st = []; const o = window.setStatus; window.setStatus = function (m, b) { window.__st.push(String(m)); return o.apply(this, arguments); }; });

    // ======================================================== 1
    console.log('\n=== 1. import ===');
    const imp = await L.measure(page, cdp, 'import', async () => {
      const t0 = Date.now();
      await page.setInputFiles('#file-input', SPHERE);
      await page.waitForFunction(() => state.placed.length > 0, null, { timeout: 120000, polling: 25 });
      return { ms: Date.now() - t0 };
    });
    check('the piece is on the plate in under 6 s (' + imp.value.ms + ' ms)', imp.value.ms < 6000);
    console.log('  (import: ' + fmt(imp) + ' - the ingest of a piece this size is one task, see the PR)');
    const said = await page.evaluate(() => window.__st);
    check('the status said it was indexing, then that it was loaded and indexed', said.some(s => /^Indexing /.test(s)) && said.some(s => /indexed in [\d.]+ s/.test(s)), said.filter(s => /Index|index/.test(s)).join(' | '));
    check('the tree is in place before the piece is', await page.evaluate(() => !!NSO_BVH.treeOf(state.placed[0].mesh.geometry)));
    await page.waitForTimeout(1500);
    await page.evaluate(L.installProjector);
    const tris = await page.evaluate(() => state.models[0].rawTris.length / 9);
    check('it is the 1,000,000-triangle piece', tris === TRIS, String(tris));
    await page.screenshot({ path: path.join(SHOTS, 'gate-01-imported.png') });

    // the floor the headless renderer sets, for the report
    const idle = await L.measure(page, cdp, 'idle 3 s', () => page.waitForTimeout(3000));
    console.log('  (idle frame for reference: ' + fmt(idle) + ')');

    // ======================================================== 5 (before anything moves)
    console.log('\n=== 5. the tree is right at scale ===');
    const tree = await page.evaluate(() => {
      const g = state.placed[0].mesh.geometry, soup = g.attributes.position.array;
      const got = NSO_BVH.treeOf(g);
      const t0 = performance.now(); const mine = NSO_BVH.build(soup); const buildMs = performance.now() - t0;
      const same = got.nodes === mine.nodes && ['box', 'left', 'right', 'start', 'count', 'order'].every(f => got[f].length === mine[f].length && got[f].every((v, i) => v === mine[f][i]));
      return { same, nodes: got.nodes, buildMs };
    });
    check('the worker\'s tree is the tree the page builds in place (' + tree.nodes + ' nodes; in place it takes ' + tree.buildMs.toFixed(0) + ' ms of the page\'s thread)', tree.same);
    const rays = await page.evaluate(() => {
      const mesh = state.placed[0].mesh; mesh.updateMatrixWorld(true);
      const walk = THREE.Mesh.prototype.raycast._orig, tree = THREE.Mesh.prototype.raycast;
      const rc = new THREE.Raycaster(); let diff = 0, withHits = 0, msTree = 0, msWalk = 0, seed = 99;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      const c = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
      for (let k = 0; k < 50; k++) {
        const from = new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).setLength(200).add(c);
        const to = new THREE.Vector3((rnd() - 0.5) * 70, (rnd() - 0.5) * 70, (rnd() - 0.5) * 70).add(c);
        rc.set(from, to.sub(from).normalize());
        const a = [], b = [];
        let t = performance.now(); walk.call(mesh, rc, a); msWalk += performance.now() - t;
        t = performance.now(); tree.call(mesh, rc, b); msTree += performance.now() - t;
        if (a.length) withHits++;
        const key = h => h.map(x => [x.faceIndex, x.distance, x.point.x, x.point.y, x.point.z, x.face.normal.x, x.face.normal.y, x.face.normal.z].join('|')).join(';');
        if (key(a) !== key(b)) diff++;
      }
      return { diff, withHits, msTree, msWalk };
    });
    check('50 rays: every hit the viewer\'s raycast returns is the walk\'s, in its order (' + rays.withHits + ' with hits)', rays.diff === 0 && rays.withHits > 20, rays.diff + ' differ');
    console.log('  (50 rays: ' + rays.msWalk.toFixed(0) + ' ms by the walk, ' + rays.msTree.toFixed(1) + ' ms by the tree)');
    check('a ray costs under 5 ms through the tree (' + (rays.msTree / 50).toFixed(2) + ' ms)', rays.msTree / 50 < 5);

    // ======================================================== 3
    console.log('\n=== 3. selection ===');
    const centre = await page.evaluate(() => { const b = window.__bm.box(0); return window.__bm.proj((b.lo[0] + b.hi[0]) / 2, (b.lo[1] + b.hi[1]) / 2, (b.lo[2] + b.hi[2]) / 2); });
    const sel = await L.measure(page, cdp, 'select', async () => {
      await page.mouse.move(centre.x, centre.y);
      await page.mouse.down(); await page.mouse.up();
      await page.waitForFunction(() => state.selectedIndex === 0, null, { timeout: 60000, polling: 25 });
      await page.waitForTimeout(6000);        // the outline and the readouts arrive in the background
    });
    check('a click selects the piece in under 300 ms of JS', sel.jsMs < 300, fmt(sel));
    console.log('  (longest single stretch of the selection: ' + sel.maxJsMs.toFixed(0) + ' ms' + (sel.jsRuns[0] ? ' in ' + sel.jsRuns[0].incl[0][0] : '') + ')');
    const after = await page.evaluate(() => ({ outline: !!state.placed[0].outline, segs: state.placed[0].outline && state.placed[0].outline.geometry.attributes.position.count / 2, split: document.getElementById('split-readout').textContent }));
    check('the white outline arrived from the worker', after.outline && after.segs >= 0, JSON.stringify(after.segs));
    await page.screenshot({ path: path.join(SHOTS, 'gate-02-selected.png') });

    // ======================================================== 2
    console.log('\n=== 2. hovers, wheel steps and an orbit ===');
    const pts = await L.hoverPoints(page, 0, 20);
    const hov = await L.measure(page, cdp, '20 hovers', async () => {
      const t0 = await page.evaluate(() => {   // a ray under each pointer position, as every hover tool asks one
        window.__hoverMs = []; return 0;
      });
      for (const p of pts) {
        await page.mouse.move(p.x, p.y, { steps: 2 });
        await page.evaluate(([x, y]) => {
          const r = state.renderer.domElement.getBoundingClientRect(), rc = new THREE.Raycaster(); rc.nsoHover = true;
          rc.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), state.camera);
          const t = performance.now(); const h = rc.intersectObjects(state.modelGroup.children, true); window.__hoverMs.push([performance.now() - t, h.length]);
        }, [p.x, p.y]);
        await page.waitForTimeout(80);
      }
    });
    const hm = await page.evaluate(() => window.__hoverMs);
    check('20 hovers: no stretch of JS over 100 ms', hov.maxJsMs < 100, fmt(hov));
    check('each ray under the pointer answered in under 5 ms (slowest ' + Math.max(...hm.map(a => a[0])).toFixed(2) + ' ms, ' + hm.filter(a => a[1] > 0).length + ' of 20 over the piece)', Math.max(...hm.map(a => a[0])) < 5 && hm.filter(a => a[1] > 0).length >= 10);

    const wheel = await L.measure(page, cdp, '20 wheel steps', async () => {
      await page.mouse.move(centre.x, centre.y);
      for (let i = 0; i < 20; i++) { await page.mouse.wheel(0, i % 2 ? 120 : -120); await page.waitForTimeout(60); }
    });
    check('20 wheel steps (a ray each, for the zoom anchor): no stretch of JS over 100 ms', wheel.maxJsMs < 100, fmt(wheel));

    const orbit = await L.measure(page, cdp, 'orbit', async () => {
      const rect = await page.evaluate(() => { const r = state.renderer.domElement.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; });
      const x0 = rect.l + 40, y0 = rect.t + rect.h - 40;
      await page.mouse.move(x0, y0); await page.mouse.down();
      const t0 = Date.now(); let i = 0;
      while (Date.now() - t0 < 2000) { i++; await page.mouse.move(x0 + i * 6, y0 - i * 2); }
      await page.mouse.up();
    });
    check('a 2 s orbit drag: no stretch of JS over 100 ms', orbit.maxJsMs < 100, fmt(orbit));
    await page.screenshot({ path: path.join(SHOTS, 'gate-03-orbited.png') });
    await page.evaluate(() => { framePlateHome(); state.controls.update(); });
    await page.waitForTimeout(1200);
    await page.evaluate(L.installProjector);

    // ======================================================== 4
    console.log('\n=== 4. To plate ===');
    await page.evaluate(() => { liftSelected(1); liftSelected(1); liftSelected(1); });     // off the bed by 6 mm
    await page.waitForTimeout(1500);
    const lifted = await page.evaluate(() => meshLocalBox3(state.placed[0].mesh).min.y);
    const tp = await L.measure(page, cdp, 'To plate', async () => {
      await page.click('#btn-to-plate');
      await page.waitForTimeout(2500);
    });
    const landed = await page.evaluate(() => meshLocalBox3(state.placed[0].mesh).min.y);
    check('the piece was in the air and is on the bed (' + lifted.toFixed(2) + ' -> ' + landed.toFixed(2) + ')', lifted > 3 && Math.abs(landed - 0.2) < 1e-3);
    check('To plate takes under 300 ms of JS', tp.jsMs < 300, fmt(tp));
    await page.screenshot({ path: path.join(SHOTS, 'gate-04-to-plate.png') });

    // the cards that read the piece: they answer in the background, saying so first
    console.log('\n=== the cards that read the piece ===');
    const sup = await L.measure(page, cdp, 'Supports card', async () => {
      const t0 = Date.now();
      await page.click('#menu-supports > summary');
      const first = await page.evaluate(() => document.getElementById('sup-count').textContent);
      await page.waitForFunction(() => !/measuring/.test(document.getElementById('sup-count').textContent), null, { timeout: 240000, polling: 200 });
      return { first, ms: Date.now() - t0, final: await page.evaluate(() => document.getElementById('sup-count').textContent) };
    });
    check('opening Supports says "measuring…" and does not stall (longest JS ' + sup.maxJsMs.toFixed(0) + ' ms)', sup.value.first === 'measuring…' && sup.maxJsMs < 300, JSON.stringify(sup.value.first));
    console.log('  (answered in ' + sup.value.ms + ' ms: "' + sup.value.final + '")');
    await page.evaluate(() => { document.getElementById('menu-supports').open = false; });
    const spl = await L.measure(page, cdp, 'Split card', async () => {
      await page.click('#menu-bit > summary');
      const first = await page.evaluate(() => document.getElementById('split-readout').textContent);
      await page.waitForFunction(() => document.getElementById('split-count').textContent !== '…', null, { timeout: 240000, polling: 200 });
      return { first, final: await page.evaluate(() => document.getElementById('split-count').textContent) };
    });
    check('opening the Subtract card reads the piece in the background (longest JS ' + spl.maxJsMs.toFixed(0) + ' ms): "' + spl.value.final + '"', spl.maxJsMs < 300 && /part/.test(spl.value.final));

    const errs = logs.filter(l => l.startsWith('[pageerror]'));
    check('no page errors', errs.length === 0, errs.join(' | '));
  });

  // ======================================================== 6
  console.log('\n=== 6. the four fixture checks, as they are ===');
  if (QUICK) console.log('  (skipped: --quick)');
  else {
    for (const script of ['lift:any-face', 'pose:bounds', 'split:parts', 'overlap:drive']) {
      const t0 = Date.now();
      const r = spawnSync('npm', ['run', '--silent', script], { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 1 << 28 });
      const tail = (r.stdout || '').trim().split('\n').slice(-2).join(' / ');
      check(script + ' passes (' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)', r.status === 0, r.status === 0 ? tail : (tail + ' ' + (r.stderr || '').slice(-300)));
    }
  }

  console.log('\n' + (fails ? 'FAILED: ' + fails : 'all held'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('GATE ERROR', e); process.exit(1); });
