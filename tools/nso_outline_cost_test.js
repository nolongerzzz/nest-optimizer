#!/usr/bin/env node
/* outline:cost - turning a piece moves its outline; it is not rebuilt.

     node tools/nso_outline_cost_test.js                  gates, on a generated 191,000-triangle piece
     node tools/nso_outline_cost_test.js --table          the same run, with the per-operation table
     node tools/nso_outline_cost_test.js --file F.3mf     the table (and gates) on a file of your own,
                                                          e.g. tools/fixtures-local/cartoon-hand.3mf
     --profile                                            under each operation over 100 ms, the frames that held it
     --real-split-read                                    leave Split to parts' read of the piece alone (see below)
     exit 0 = every gate held

   WHY. The white outline of the selected piece is an EdgesGeometry(geometry, 15). On a 191,000-triangle
   piece that rebuild is 85-95 % of every select, yaw, tip, tilt and Undo (0.8-1.8 s, sometimes twice per
   operation), on the page's own thread. A turn does not change a piece's edges, only where they are, so
   app-sel-outline.js now keeps the edge set per geometry (nsoOutline), moves it with the bake's matrix
   (nsoOutlineCarry, called by nsoBakePlacedPose / Undo / Redo), builds a big piece's in the worker, and
   draws what it already has when asked twice.

   SPLIT TO PARTS. Its card reads a piece's parts on the main thread when the piece is under 300,000 triangles
   (app-split-parts.js, NSO_SplitParts.analyse: 5-9 s on 191,000), once per soup, after a select and after a Redo.
   It is not the outline and not this ticket, and it would be 80 % of the time in every row it lands in, so the run
   stands it down (analyse answers at once) unless --real-split-read is given. The report says what it costs.

   HOW IT COUNTS. From outside the app, so the same file runs on a tree that has none of this: it wraps
   THREE.EdgesGeometry (the main-thread build), NSO_Edges.edgesOf (the same build, by hand) and NSO_Work.run
   of an NSO_Edges job (the worker build) and counts every call as one FULL EDGE BUILD; it counts every
   object named selOutline added to a mesh as one DRAW. Time is the main thread's JS from the DevTools
   sampling profiler (nso_big_mesh_lib.measure) over the operation and the wait until its outline is on
   screen - headless software GL frames are "(program)" time and are not counted.

   GATES (stand-in, one piece of 191,000 triangles):
     select 1 build, re-select 0; Yaw, Tip on side, Stand, Flip, Tilt, Tilt (bank): 0 builds each, and each
     is ONE outline draw; Undo and Redo of each: 0 builds, one draw; a Rotate-ring drag: 0 builds while it
     is in hand and 0 on release; after every one of those the outline is the freshly built EdgesGeometry
     of the posed piece (same edge count, every vertex within 1e-4 mm); an edit that really changes the
     shape (a bake of the soup) builds once; the cache survives a piece that is deselected, and the
     transform path survives an empty cache (Undo and Redo with the cached edge sets forgotten); and no
     scene holds more than one selOutline per piece after select, deselect, Undo, Redo and Remove. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');
const L = require('./nso_big_mesh_lib');
const NSO_Edges = require('../nso_edges.js');

const argv = process.argv.slice(2);
const opt = n => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : null; };
const FILE = opt('file');
const TABLE = argv.includes('--table') || !!FILE;
const PROFILE = argv.includes('--profile');
const REAL_SPLIT = argv.includes('--real-split-read');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};

/* The stand-in: an ellipsoid with flat caps in place of poles, a smooth swell on it and a checkerboard of raised
   plates. 500 x 190 bands + two 500-triangle caps = 191,000 triangles, outward winding, binary STL. The swell keeps
   its faces within a few degrees of each other, the plates' walls stand at 80 degrees and more, the caps are flat and
   meet the body at 30 and more. So every edge is plainly on one side of the outline's 15 degree threshold: a crease
   a hair either side of it (a pole's slivers, a real scan's thousands) can come out the other way when a turned copy
   is rounded to float32 again, and an edge count that moves by one is not a drift in the carry (see the margin
   gate in the run). */
const PLATE = 6, TH0 = 0.6;
function writeStandIn(file, nu, nv) {
  const tris = nu * (2 * nv - 2);
  const buf = Buffer.alloc(84 + tris * 50);
  buf.write('outline-cost stand-in', 0);
  buf.writeUInt32LE(tris, 80);
  const P = (i, j) => {
    if (j === 0 || j === nv) {
      const s = j === 0 ? 1 : -1;
      return [0, 0, s * 1.1 * 30 * Math.cos(TH0)];
    }
    const th = TH0 + (Math.PI - 2 * TH0) * (j - 1) / (nv - 2), ph = 2 * Math.PI * (i % nu) / nu;
    const plate = j > 3 && j < nv - 3 && ((Math.floor((i % nu) / 10) + Math.floor(j / 8)) % 2 === 0) ? PLATE : 0;
    const r = 30 * (1 + 0.025 * Math.sin(5 * th) * Math.cos(3 * ph) + 0.012 * Math.sin(7 * ph + 2 * th)) + plate;
    return [1.7 * r * Math.sin(th) * Math.cos(ph), 0.8 * r * Math.sin(th) * Math.sin(ph), 1.1 * r * Math.cos(th)];
  };
  let off = 84;
  const put = (a, b, c) => { off += 12; for (const v of [a, b, c]) for (let k = 0; k < 3; k++) { buf.writeFloatLE(v[k], off); off += 4; } off += 2; };
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
    if (j > 0) put(a, c, b);
    if (j < nv - 1) put(a, d, c);
  }
  fs.writeFileSync(file, buf);
  return tris;
}
/* The soup of a binary STL, and how many edges it has at a threshold: edgesOf is three's loop, so the count at
   14.9 and at 15.1 degrees being the same means no crease lies within 0.1 degree of 15. */
function soupOf(file) {
  const b = fs.readFileSync(file), n = b.readUInt32LE(80), a = new Float32Array(n * 9);
  let off = 84;
  for (let t = 0; t < n; t++) { off += 12; for (let k = 0; k < 9; k++) { a[t * 9 + k] = b.readFloatLE(off); off += 4; } off += 2; }
  return a;
}

/* in the page */
function install() {
  const oc = window.__oc = { builds: 0, jobs: 0, draws: 0 };
  const EG = window.__EG = THREE.EdgesGeometry;
  const W = function (g, a) { oc.builds++; return new EG(g, a); };
  W.prototype = EG.prototype;
  THREE.EdgesGeometry = W;
  ['edgesOf', 'edgesOfTransfer'].forEach(k => {
    const f = window.NSO_Edges && window.NSO_Edges[k];
    if (typeof f === 'function') window.NSO_Edges[k] = function () { oc.builds++; return f.apply(this, arguments); };
  });
  const run = window.NSO_Work.run;
  window.NSO_Work.run = function (c, n, p) { if (/NSO_Edges/.test(p)) { oc.builds++; oc.jobs++; } return run.apply(this, arguments); };
  const add = THREE.Object3D.prototype.add;
  THREE.Object3D.prototype.add = function (o) { if (o && o.name === 'selOutline') oc.draws++; return add.apply(this, arguments); };

  window.__counts = () => ({ builds: oc.builds, jobs: oc.jobs, draws: oc.draws });
  /* every selOutline anywhere in the scene, by the mesh that carries it */
  window.__outlines = () => {
    const per = [];
    state.scene.traverse(o => { if (o.name === 'selOutline') per.push(o.parent ? o.parent.uuid : '-'); });
    const by = {};
    per.forEach(u => { by[u] = (by[u] || 0) + 1; });
    return { total: per.length, worst: Math.max(0, ...Object.values(by)) };
  };
  window.__busy = () => {
    const ch = window.NSO_Work._channels().edges;
    return !!(ch && (ch.running || ch.queue.length));
  };
  /* wait until the worker has answered and the outline is where it will stay */
  window.__settle = async (idx, want) => {
    const t0 = performance.now();
    for (;;) {
      const p = state.placed[idx];
      if (!window.__busy() && (!want || (p && p.outline))) break;
      if (performance.now() - t0 > 90000) throw new Error('outline never settled');
      await new Promise(r => setTimeout(r, 20));
    }
    await new Promise(r => setTimeout(r, 80));
  };
  /* the outline on screen against a freshly built EdgesGeometry of the posed piece, in the piece's frame */
  window.__fresh = idx => {
    const p = state.placed[idx];
    const o = p && p.outline;
    if (!o) return { ok: false, why: 'no outline' };
    const g = p.mesh.geometry;
    const fresh = new EG(g, 15).attributes.position.array;
    const a = o.geometry.attributes.position.array, n = a.length;
    if (o.parent !== p.mesh) return { ok: false, why: 'outline is not on the mesh' };
    if (n !== fresh.length) return { ok: false, why: 'edge count', nOutline: n / 6, nFresh: fresh.length / 6 };
    let d = 0;
    for (let i = 0; i < n; i++) { const e = Math.abs(a[i] - fresh[i]); if (e > d) d = e; }
    return { ok: d <= 1e-4, edges: n / 6, maxd: d };
  };
}

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 860 });
  const N = page.evaluate.bind(page);
  await N(install);
  const cdp = await L.openProfiler(page);

  let file = FILE ? path.resolve(FILE) : path.join(os.tmpdir(), 'nso-outline-cost-standin-191k.stl');
  if (!FILE) {
    console.log('stand-in: ' + writeStandIn(file, 500, 192).toLocaleString() + ' triangles');
    const soup = soupOf(file);
    const lo = NSO_Edges.edgesOf(soup, 14.9).length / 6, hi = NSO_Edges.edgesOf(soup, 15.1).length / 6;
    check('the stand-in has no crease within 0.1 degree of the 15 degree threshold', lo === hi, lo.toLocaleString() + ' edges at 14.9, ' + hi.toLocaleString() + ' at 15.1');
  }
  const t0 = Date.now();
  await page.setInputFiles('#file-input', file);
  await page.waitForFunction(() => state.models.length > 0 && state.placed.some(p => p && p.mesh), null, { timeout: 600000, polling: 200 });
  await page.waitForTimeout(FILE ? 4000 : 1500);
  const info = await N(() => ({ tris: state.placed[0].mesh.geometry.attributes.position.count / 3, indexed: !!state.placed[0].mesh.geometry.index,
                                sel: state.selectedIndex, pieces: state.placed.length, worker: NSO_Work.isAvailable() }));
  console.log('loaded in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s: ' + JSON.stringify(info));
  if (!REAL_SPLIT) await N(() => { if (window.NSO_SplitParts) window.NSO_SplitParts.analyse = () => ({ ok: false, parts: [], words: '', reason: 'stood down by outline:cost' }); });
  await N(() => window.__settle(0, false));

  const rows = [];
  /* one operation: counters + main-thread JS time over it and the wait for its outline */
  async function op(name, act, want) {
    await N(() => { window.__c0 = window.__counts(); });
    const m = await L.measure(page, cdp, name, async () => {
      await act();
      await N(w => window.__settle(0, w), want !== false);
    });
    const c = await N(() => { const a = window.__c0, b = window.__counts(); return { builds: b.builds - a.builds, draws: b.draws - a.draws }; });
    const r = { name, ms: Math.round(m.jsMs), wall: m.wallMs, builds: c.builds, draws: c.draws, err: m.error };
    rows.push(r);
    console.log('   ' + name.padEnd(26) + String(r.ms).padStart(6) + ' ms (wall ' + m.wallMs + ')   builds ' + r.builds + '   draws ' + r.draws + (m.error ? '   ERROR ' + m.error : ''));
    if (PROFILE && r.ms > 100) m.jsRuns.forEach(j => console.log('        run ' + Math.round(j.ms) + ' ms: ' + j.incl.slice(0, 5).map(([k, ms]) => k.replace(/ @ /, '@') + ' ' + Math.round(ms)).join(' | ')));
    return r;
  }
  const fresh = async label => {
    const f = await N(() => window.__fresh(0));
    /* a scan has creases a hair either side of 15 degrees, and a turned copy rounded to float32 again can come out
       the other way for a few of them: on a file of the owner's the edge count is reported, not gated, within 0.1 % */
    if (FILE && f.why === 'edge count' && Math.abs(f.nOutline - f.nFresh) <= 0.001 * f.nFresh) {
      console.log('  note ' + label + ': ' + f.nOutline + ' edges carried, ' + f.nFresh + ' rebuilt (knife-edge creases at 15 degrees)');
      return;
    }
    check(label + ': the outline is the posed piece\'s own edges', f.ok, f.ok ? f.edges.toLocaleString() + ' edges, max drift ' + f.maxd.toExponential(2) + ' mm' : JSON.stringify(f));
  };
  const outlines = async label => {
    const o = await N(() => window.__outlines());
    check(label + ': one selOutline at most per piece', o.worst <= 1, o.total + ' in the scene');
    return o;
  };
  /* the button's own click handler, from inside the page: Playwright's click waits for animation frames, and a
     191,000-triangle piece drawn by headless software GL makes each of those seconds long. The handler that runs is
     the same one a click reaches. */
  const click = (menu, id) => N(([m, b]) => {
    const d = m && document.getElementById(m);
    if (d) d.open = true;
    const el = document.getElementById(b);
    if (!el || el.disabled) throw new Error('#' + b + ' is not there to press');
    el.click();
  }, [menu, id]);

  console.log('\n=== select, deselect, re-select ===');
  let r = await op('select', () => N(() => selectPlaced(0)));
  check('select: one full build', r.builds === 1, r.builds + ' builds, ' + r.draws + ' draws');
  await fresh('select');
  await outlines('select');
  r = await op('deselect', () => N(() => selectPlaced(-1)), false);
  check('deselect: nothing built, nothing left on the piece', r.builds === 0 && (await N(() => window.__outlines().total)) === 0);
  r = await op('re-select', () => N(() => selectPlaced(0)));
  check('re-select an unchanged piece: no build', r.builds === 0, r.builds + ' builds, ' + r.draws + ' draws');
  await fresh('re-select');

  console.log('\n=== pose ops, each with its Undo and Redo ===');
  const POSE = [
    ['Yaw', 'menu-rotate', 'btn-rot-right'],
    ['Tip on side', 'menu-tip', 'btn-flip'],
    ['Stand', 'menu-tip', 'btn-tip'],
    ['Flip', 'menu-tip', 'btn-flip-over'],
    ['Tilt', 'menu-tip', 'btn-tilt-up'],
    ['Tilt (bank)', 'menu-tip', 'btn-bank-up']
  ];
  for (const [name, menu, id] of POSE) {
    r = await op(name, () => click(menu, id));
    check(name + ': no edge build', r.builds === 0, r.builds + ' builds');
    check(name + ': one outline update', r.draws === 1, r.draws + ' draws');
    await fresh(name);
    await outlines(name);
    r = await op(name + ' - Undo', () => click(null, 'btn-undo'));
    check(name + ' Undo: no edge build, one update', r.builds === 0 && r.draws === 1, r.builds + ' builds, ' + r.draws + ' draws');
    await fresh(name + ' Undo');
    await outlines(name + ' Undo');
    r = await op(name + ' - Redo', () => click(null, 'btn-redo'));
    check(name + ' Redo: no edge build, one update', r.builds === 0 && r.draws === 1, r.builds + ' builds, ' + r.draws + ' draws');
    await fresh(name + ' Redo');
    await outlines(name + ' Redo');
  }

  console.log('\n=== the carry, with the cache forgotten: Undo and Redo move the outline the bake\'s way ===');
  if (await N(() => !!window.NSO_Outline)) {
    await N(() => { state.undoStack.length = 0; state.redoStack.length = 0; });
    r = await op('Tip on side (again)', () => click('menu-tip', 'btn-flip'));
    await N(() => { window.NSO_Outline.forgetAll(state.placed[0]); });        // every cached edge set of this piece's geometries
    r = await op('Undo, nothing cached', () => click(null, 'btn-undo'));
    check('Undo from the live outline: no build', r.builds === 0, r.builds + ' builds');
    await fresh('Undo, nothing cached');
    await N(() => { window.NSO_Outline.forgetAll(state.placed[0]); });
    r = await op('Redo, nothing cached', () => click(null, 'btn-redo'));
    check('Redo from the live outline: no build', r.builds === 0, r.builds + ' builds');
    await fresh('Redo, nothing cached');
  } else check('NSO_Outline is on the page', false, 'not present');

  console.log('\n=== a Rotate ring drag ===');
  await N(() => { state.undoStack.length = 0; state.redoStack.length = 0; updateUndoBtn(); });
  await N(() => { document.getElementById('menu-rotate').open = true; });
  await N(() => { window.__c0 = window.__counts(); });
  const drag = await L.measure(page, cdp, 'drag', async () => {
    await N(() => {
      const a = nsoRotate, c = a.centreScreen(), R = 160, at = d => ({ x: c.x + Math.cos(d * Math.PI / 180) * R, y: c.y + Math.sin(d * Math.PI / 180) * R });
      const p0 = at(0);
      if (!a.beginDrag({ ring: 'turn', dir: 1 }, p0.x, p0.y, c.x, c.y)) throw new Error('no drag');
      for (let i = 1; i <= 40; i++) { const q = at(a.dialSign('turn') * i); a.moveDrag(q.x, q.y); }
      window.__mid = { c: window.__counts(), dragging: a.dragging(), outline: !!state.placed[0].outline, turned: state.placed[0].mesh.quaternion.toArray() };
    });
  });
  const mid = await N(() => ({ mid: window.__mid, c0: window.__c0 }));
  check('during the drag: no build and no new outline', mid.mid.c.builds === mid.c0.builds && mid.mid.c.draws === mid.c0.draws && mid.mid.dragging,
    (mid.mid.c.builds - mid.c0.builds) + ' builds, ' + (mid.mid.c.draws - mid.c0.draws) + ' draws over 40 moves');
  console.log('   drag (40 moves)           ' + String(Math.round(drag.jsMs)).padStart(6) + ' ms');
  rows.push({ name: 'ring drag (40 moves)', ms: Math.round(drag.jsMs), builds: mid.mid.c.builds - mid.c0.builds, draws: mid.mid.c.draws - mid.c0.draws });
  r = await op('ring drag release', () => N(() => nsoRotate.endDrag()));
  check('release: no build, one update', r.builds === 0 && r.draws === 1, r.builds + ' builds, ' + r.draws + ' draws');
  await fresh('after the drag');
  await outlines('after the drag');
  r = await op('release - Undo', () => click(null, 'btn-undo'));
  check('release Undo: no build', r.builds === 0, r.builds + ' builds');
  await fresh('drag Undo');

  console.log('\n=== an edit that really changes the shape builds once ===');
  /* a real one first: Mirror is a sculpt-style bake of the soup (NSO_sculptCommitRaw) - new geometry, new soup, new
     mesh. Like every commit of its kind it does not ask for an outline itself (the piece shows none until it is
     selected again, and the line it had is left on the discarded mesh); the gate is that asking costs ONE build,
     leaves nothing behind, and that Undo and Redo of it cost none. */
  r = await op('Mirror (a real bake)', () => N(() => { const out = NSO_mirrorSelectedModel({ axis: 'x', plane: 0 }); if (!out || !out.ok) throw new Error('Mirror: ' + String(out && out.reason).slice(0, 200)); }), false);
  check('Mirror: the bake itself builds nothing', r.builds === 0, r.builds + ' builds');
  r = await op('Mirror - select again', () => N(() => selectPlaced(0)));
  check('Mirror: the new shape is built once', r.builds === 1 && r.draws === 1, r.builds + ' builds, ' + r.draws + ' draws');
  await fresh('Mirror');
  await outlines('Mirror');
  /* Undo of a replace-type edit puts the old mesh back and, like the edit, does not ask for an outline: the old
     shape's edges are kept, so the select that follows is a lookup */
  r = await op('Mirror - Undo', () => click(null, 'btn-undo'), false);
  check('Mirror Undo: no build', r.builds === 0, r.builds + ' builds, ' + r.draws + ' draws');
  /* the Undo of a replace-type edit puts back the CLONE the edit took of the old geometry (pushUndo's prevGeometry),
     not the object that was outlined: its edges are built once, in the worker - not a pose op's Undo, and not twice */
  r = await op('Mirror Undo - select again', () => N(() => selectPlaced(0)));
  check('...and the clone it put back costs at most one build', r.builds <= 1 && r.draws === 1, r.builds + ' builds, ' + r.draws + ' draws');
  await fresh('Mirror Undo');
  await outlines('Mirror Undo');
  r = await op('Mirror - Redo', () => click(null, 'btn-redo'));
  check('Mirror Redo: the new shape\'s edges are kept too - no build', r.builds === 0 && r.draws === 1, r.builds + ' builds, ' + r.draws + ' draws');
  await fresh('Mirror Redo');
  await outlines('Mirror Redo');
  r = await op('shape edit (bake of the soup)', () => N(() => {
    const p = state.placed[0], g = p.mesh.geometry, pos = g.attributes.position;
    const ng = g.clone();
    const a = ng.attributes.position.array;
    for (let i = 0; i < a.length; i += 3) a[i + 1] *= 1.1;                // a stretch: really another shape
    ng.attributes.position.needsUpdate = true;
    ng.computeBoundingBox(); ng.computeBoundingSphere();
    p.mesh.geometry = ng; p.geometry = ng;
    nsoInvalidatePlacedBounds(p);
    refreshOutline(p);
    refreshOutline(p);                                                     // a caller that asks twice
  }));
  check('a new shape: exactly one build, asked for twice', r.builds === 1, r.builds + ' builds, ' + r.draws + ' draws');
  await fresh('new shape');

  console.log('\n=== no outline left behind ===');
  await N(() => selectPlaced(-1));
  check('deselected: the scene holds none', (await N(() => window.__outlines().total)) === 0);
  await N(() => selectPlaced(0));
  await N(() => window.__settle(0, true));
  await N(() => deleteSelectedPlaced());
  await page.waitForTimeout(300);
  check('Remove: the scene holds none', (await N(() => window.__outlines().total)) === 0);
  await click(null, 'btn-undo');
  await page.waitForTimeout(500);
  await outlines('Remove, Undo');

  if (TABLE) {
    console.log('\n| operation | main-thread ms | edge builds | outline draws |\n|---|---:|---:|---:|');
    rows.forEach(x => console.log('| ' + x.name + ' | ' + x.ms + ' | ' + x.builds + ' | ' + x.draws + ' |'));
  }
  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(fails ? '\n' + fails + ' gate(s) FAILED' : '\nevery gate held');
  process.exitCode = fails ? 1 : 0;
}).catch(e => { console.error('FAIL', e); process.exit(1); });
