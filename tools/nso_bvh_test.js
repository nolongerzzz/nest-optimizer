#!/usr/bin/env node
/* The shared tree (nso_bvh.js), held to what it replaces. No browser.
     node tools/nso_bvh_test.js          exit 0 = every gate held
     npm run bvh:test

   1. THE TREE IS THE PLANNER'S. nso_bvh.js's build and the one nso_support_aim.js
      still carries for the contexts that load it alone make the same tree, array
      for array, on a sphere, a noisy sphere and a soup with a degenerate sliver in it;
      and the planner, handed the shared module, answers every ray as the brute walk does.
   2. THE RAYCAST IS THREE'S. For a mesh of any pose and scale, with each material
      side, Mesh.raycast through the tree returns the very hits the walk returns, in the
      same order - distance, point, faceIndex, face a b c and normal - on rays aimed at
      random places, at vertices, along edges and at the silhouette.
   3. A MESH THE TREE DOES NOT COVER IS LEFT ALONE. A small mesh, an indexed one, one with
      a UV set, takes three's own raycast (it is the very function, called).
   4. STALE IS NOT TRUSTED. An edit in place that bumps the attribute's version outdates the
      tree: a click falls back to the walk and is still right, a hover answers nothing and
      asks for a new tree, and once that is built the tree answers again - for the edited mesh.
   5. ensure() without a Worker builds in place, once, and says so with the same arrays. */

const path = require('path');
const THREE = require('three');
const BVH = require('../nso_bvh.js');
const Aim = require('../nso_support_aim.js');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

// ---- fixtures: deterministic -------------------------------------------------
let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

function sphere(nu, nv, r, noise) {
  const P = (i, j) => {
    const th = Math.PI * j / nv, ph = 2 * Math.PI * (i % nu) / nu;
    const k = noise ? 1 + noise * Math.sin(5 * th) * Math.cos(7 * ph) : 1;
    return [r * k * Math.sin(th) * Math.cos(ph), r * k * Math.sin(th) * Math.sin(ph), r * k * Math.cos(th)];
  };
  const out = [];
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
    if (j > 0) out.push(...a, ...b, ...c);
    if (j < nv - 1) out.push(...a, ...c, ...d);
  }
  return new Float32Array(out);
}
const meshOf = (soup, side, extra) => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(soup, 3));
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: side == null ? THREE.FrontSide : side }));
  if (extra) extra(m, g);
  m.updateMatrixWorld(true);
  return m;
};

// ================================================================== 1
console.log('\n=== 1. the tree is the planner\'s ===');
{
  const sliver = sphere(30, 15, 20, 0);
  const withDegenerate = new Float32Array(sliver.length + 9); withDegenerate.set(sliver); // an all-zero triangle at the end
  const fields = ['box', 'left', 'right', 'start', 'count', 'order', 'tb'];
  for (const [name, soup] of [['sphere', sphere(60, 30, 40, 0)], ['noisy sphere', sphere(70, 35, 40, 0.15)], ['with a zero-area triangle', withDegenerate]]) {
    const a = BVH.build(soup);
    // the planner's own copy, as a context that does not load nso_bvh.js sees it
    const savedRoot = globalThis.NSO_BVH; delete globalThis.NSO_BVH;
    delete require.cache[require.resolve('../nso_support_aim.js')];
    const Alone = require('../nso_support_aim.js');
    const b = Alone._indexFor(soup);
    globalThis.NSO_BVH = savedRoot;
    // the planner's copy is allocated for the worst tree; the shared one is trimmed to the nodes used
    const used = { box: a.nodes * 6, left: a.nodes, right: a.nodes, start: a.nodes, count: a.nodes, order: a.n, tb: a.n * 6 };
    const same = a.nodes === b.nodes && a.n === b.n &&
      fields.every(f => a[f].length === used[f] && a[f].every((v, i) => v === b[f][i]));
    check(name + ': the shared tree and the planner\'s own are the same arrays (' + a.nodes + ' nodes)', same);
    check(name + ': fingerprints match the planner\'s', a.sample === b.sample && a.full === b.full);
  }
  const s = sphere(80, 40, 50, 0.1);
  let bad = 0;
  for (let k = 0; k < 400; k++) {
    const o = [Math.sin(k) * 12, Math.cos(k * 1.3) * 12, 120], d = [Math.sin(k * 0.7) * 0.05, Math.cos(k * 0.3) * 0.05, -1];
    if (Aim._nearestHit([s], o, d, 0, 1e9) !== Aim._nearestHitBrute([s], o, d, 0, 1e9)) bad++;
  }
  check('the planner, on the shared tree, answers 400 rays as the brute walk does', bad === 0 && Aim._indexFor(s) === BVH.peek(s), bad + ' differ');
}

// ================================================================== 2
console.log('\n=== 2. the raycast is three\'s ===');
const orig = THREE.Mesh.prototype.raycast;
BVH.installThree(THREE, { minTris: 100 });
{
  check('installThree replaces Mesh.prototype.raycast, once', THREE.Mesh.prototype.raycast !== orig && BVH.installThree(THREE) === false);
  const nativeRaycast = THREE.Mesh.prototype.raycast._orig;
  check('and keeps three\'s own function to hand', nativeRaycast === orig);

  const hitsOf = (mesh, rc, viaTree) => {
    const out = [];
    (viaTree ? THREE.Mesh.prototype.raycast : nativeRaycast).call(mesh, rc, out);
    out.sort((a, b) => a.distance - b.distance);
    return out;
  };
  const dump = h => h.map(x => [x.distance, x.point.x, x.point.y, x.point.z, x.faceIndex, x.face.a, x.face.b, x.face.c,
                               x.face.normal.x, x.face.normal.y, x.face.normal.z, x.face.materialIndex, x.object === undefined].join('|')).join(';');

  // all three sides below, once the trees are in
  (async () => {
    for (const [label, side] of [['front', THREE.FrontSide], ['back', THREE.BackSide], ['double', THREE.DoubleSide]]) {
      const soup = sphere(90, 45, 40, 0.12);
      const mesh = meshOf(soup, side, (m) => { m.position.set(3, -2, 5); m.rotation.set(0.4, 1.1, -0.3); m.scale.set(1.3, 0.8, 1.1); });
      await BVH.ensureGeometry(mesh.geometry);
      const rc = new THREE.Raycaster();
      let diff = 0, withHits = 0, total = 0;
      const aim = (target, from) => { rc.set(from, target.clone().sub(from).normalize()); };
      const pos = mesh.geometry.attributes.position;
      const tri = (i) => [0, 1, 2].map(k => new THREE.Vector3().fromBufferAttribute(pos, i * 3 + k).applyMatrix4(mesh.matrixWorld));
      const nTri = pos.count / 3;
      for (let k = 0; k < 1500; k++) {
        const from = new THREE.Vector3(rnd() * 200 - 100, rnd() * 200 - 100, rnd() * 200 - 100).setLength(150);
        let target;
        const mode = k % 5;
        if (mode === 0) target = new THREE.Vector3(rnd() * 60 - 30, rnd() * 60 - 30, rnd() * 60 - 30);       // anywhere near
        else if (mode === 1) target = tri((rnd() * nTri) | 0)[(rnd() * 3) | 0];                                // a vertex
        else if (mode === 2) { const t = tri((rnd() * nTri) | 0); target = t[0].clone().lerp(t[1], 0.5); }      // an edge midpoint
        else if (mode === 3) { const t = tri((rnd() * nTri) | 0); target = t[0].clone().add(t[1]).add(t[2]).multiplyScalar(1 / 3); } // a face centre
        else target = new THREE.Vector3(rnd() * 120 - 60, rnd() * 120 - 60, 0).setLength(45 + rnd() * 3);        // the silhouette
        aim(target, from);
        const a = hitsOf(mesh, rc, false), b = hitsOf(mesh, rc, true);
        total++; if (a.length) withHits++;
        if (dump(a) !== dump(b)) diff++;
        // the order they come back in, before any sort, is three's too
        const ua = [], ub = []; nativeRaycast.call(mesh, rc, ua); THREE.Mesh.prototype.raycast.call(mesh, rc, ub);
        if (ua.map(h => h.faceIndex).join() !== ub.map(h => h.faceIndex).join()) diff++;
      }
      check(label + ' side, moved/turned/scaled: ' + total + ' rays, ' + withHits + ' with hits, every hit identical to the walk and in its order', diff === 0 && withHits > 300, diff + ' differ');
    }

    // ============================================================ 3
    console.log('\n=== 3. a mesh the tree does not cover is left alone ===');
    {
      let walked = 0;
      const spy = function (rc, out) { walked++; return orig.call(this, rc, out); };
      THREE.Mesh.prototype.raycast._orig = spy;       // what the replacement falls back to
      const rc = new THREE.Raycaster(new THREE.Vector3(0, 0, 100), new THREE.Vector3(0, 0, -1));
      const small = meshOf(sphere(6, 4, 10, 0));
      small.raycast(rc, []); small.raycast(rc, []);
      check('a small mesh takes three\'s own raycast', walked === 2);
      walked = 0;
      const idx = meshOf(sphere(90, 45, 40, 0));
      idx.geometry = idx.geometry.clone(); idx.geometry.setIndex([...Array(idx.geometry.attributes.position.count).keys()]);
      idx.raycast(rc, []);
      check('an indexed mesh takes three\'s own raycast', walked === 1);
      walked = 0;
      const uv = meshOf(sphere(90, 45, 40, 0));
      uv.geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv.geometry.attributes.position.count * 2), 2));
      uv.raycast(rc, []);
      check('a mesh with a UV set takes three\'s own raycast', walked === 1);
      THREE.Mesh.prototype.raycast._orig = orig;
    }

    // ============================================================ 4
    console.log('\n=== 4. stale is not trusted ===');
    {
      const soup = sphere(90, 45, 40, 0);
      const mesh = meshOf(soup, THREE.DoubleSide);       // (this sphere is wound inward: double-sided, so the near wall is what a click finds)
      const rcDown = new THREE.Raycaster(new THREE.Vector3(0.37, 0.21, 100), new THREE.Vector3(0, 0, -1));
      const rcHover = new THREE.Raycaster(new THREE.Vector3(0.37, 0.21, 100), new THREE.Vector3(0, 0, -1)); rcHover.nsoHover = true;
      const cold = [], cold2 = [];
      mesh.raycast(rcHover, cold);
      check('no tree yet: a hover answers nothing (and has asked for one)', cold.length === 0);
      mesh.raycast(rcDown, cold2);
      check('no tree yet: a click is answered by the walk, as before', cold2.length === 2 && Math.abs(cold2[0].distance - 60) < 0.2, cold2.length + ' hits');
      await new Promise(r => setTimeout(r, 50));
      const warm = []; mesh.raycast(rcHover, warm);
      check('once built, the hover is answered', warm.length === 2 && Math.abs(warm[0].distance - 60) < 0.2);

      // an edit in place: the whole mesh moves up by 10, and says so
      const p = mesh.geometry.attributes.position;
      for (let i = 2; i < p.array.length; i += 3) p.array[i] += 10;
      p.needsUpdate = true; mesh.geometry.computeBoundingBox(); mesh.geometry.computeBoundingSphere();
      const stale = []; mesh.raycast(rcHover, stale);
      check('after an edit in place the old tree is not used: a hover answers nothing', stale.length === 0);
      const stale2 = []; mesh.raycast(rcDown, stale2);
      check('and a click is answered by the walk, for the edited mesh (top now at z = 50)', stale2.length === 2 && Math.abs(stale2[0].distance - 50) < 0.2, stale2[0] && stale2[0].distance.toFixed(2));
      await new Promise(r => setTimeout(r, BVH._rebuildDelay ? BVH._rebuildDelay() + 100 : 450));
      const fresh = []; mesh.raycast(rcHover, fresh);
      check('when the new tree is built the hover answers again, for the edited mesh', fresh.length === 2 && Math.abs(fresh[0].distance - 50) < 0.2, fresh[0] && fresh[0].distance.toFixed(2));
    }

    // ============================================================ 5
    console.log('\n=== 5. ensure() without a Worker ===');
    {
      const soup = sphere(70, 35, 30, 0.1);
      const a = await BVH.ensure(soup);
      const b = BVH.build(sphere(70, 35, 30, 0.1));
      check('builds in place, once, and resolves the same arrays as build()', a && a.nodes === b.nodes && a.box.every((v, i) => v === b.box[i]));
      check('asked again it is the same object', (await BVH.ensure(soup)) === a && BVH.peek(soup) === a);
      check('a soup too small to index resolves null', (await BVH.ensure(new Float32Array(9 * 4))) === null);
      check('a soup with a non-finite coordinate resolves null, not a crash', (await BVH.ensure(new Float32Array([0, 0, 0, 1, 0, 0, NaN, 1, 0].concat(new Array(9 * 20).fill(1))))) === null);
    }

    console.log('\n' + (fails ? 'FAILED: ' + fails : 'all held'));
    process.exit(fails ? 1 : 0);
  })();
}
