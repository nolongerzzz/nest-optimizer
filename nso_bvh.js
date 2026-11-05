/* ============================================================
   nso_bvh.js - ONE acceleration structure per piece, shared by everything that
   asks a piece a spatial question.

   Loads as a classic script (window.NSO_BVH) and as a Node module
   (require('./nso_bvh.js')). No DOM. THREE is only touched by installThree(),
   which the page calls once, and by nothing else here.

   ---------------------------------------------------------------------------
   WHY THIS FILE EXISTS
   ---------------------------------------------------------------------------
   A 947,000-triangle piece froze the page on load, hover, select and most
   verbs, and the cause was the same thing under a dozen names: a question put
   to a piece was answered by walking all of its triangles. three.js's own
   Mesh.raycast walks every one for every ray (a hover is a ray; so is a click,
   a wheel zoom, a Lift outline, a ghost); the support planner (#216) had
   already earned an index of its own and kept it to itself.

   This is that index, moved out so the planner and the viewer ask the same
   one: a BVH over the triangles - axis-aligned boxes, a binned
   surface-area-heuristic split, four triangles to a leaf - built once per
   soup, cached on the soup's array (a WeakMap, so it goes when the array
   does), and used for the ray, the nearest point and the "anything within tol"
   questions. The build moved here WITHOUT a change to the tree: the same
   triangles end up in the same boxes, so nothing the planner reports moves.

   ---------------------------------------------------------------------------
   OFF THE MAIN THREAD
   ---------------------------------------------------------------------------
   Building the tree for a million triangles is 2-3 s of JS. ensure(soup) does
   it in a Web Worker (the build function is serialised into the worker's
   source, so there is no second file to serve), copies the soup in, and gets
   the arrays back by transfer. The page awaits it where it can show a progress
   line (import) and starts it ahead of need where it cannot (a geometry
   rewrite). Without Worker (Node, a sandbox) ensure() builds in place and
   resolves - same tree, same answers.

   ---------------------------------------------------------------------------
   THE VIEWER'S RAYCAST
   ---------------------------------------------------------------------------
   installThree(THREE) replaces Mesh.prototype.raycast with one that, for a
   plain non-indexed mesh of at least MIN_TRIS triangles whose tree is ready,
   asks the tree which triangles the (infinite, local-space) ray's boxes can
   reach and runs three's OWN per-triangle test on those and on nothing else -
   the same Ray.intersectTriangle, the same side culling, the same distance,
   near and far checks, the same face and normal, the hits pushed in the same
   (ascending triangle) order. So a hit it reports is the hit the walk reported,
   to the bit; only the triangles that could not have been hit are not asked.
   tools/nso_bvh_test.js holds it to the walk on random rays.

   Anything else - a small mesh, an indexed one, a morph target, a material
   array, a UV set - takes three's own raycast, untouched. So does a big mesh
   whose tree is not ready, EXCEPT for a hover (raycaster.nsoHover = true) over
   a BIG piece (BIG_TRIS, 300k): a hover that finds no tree answers "nothing"
   and asks for one, rather than walking a million triangles to repaint an
   outline. Between MIN_TRIS and BIG_TRIS the walk is a few tens of ms and a
   hover keeps it.

   ---------------------------------------------------------------------------
   WHAT IS READ AS IMMUTABLE
   ---------------------------------------------------------------------------
   A tree belongs to one position array. It is valid while the array, the
   attribute's version and the vertex count are what they were at the build
   and a 48-value sample still adds up; any edit that is drawn bumps the
   version, and the next question finds the tree stale, falls back as above
   and asks the worker for a new one.
   ============================================================ */
(function (root) {
  'use strict';

  /* A cheap fingerprint of a soup: its length and 48 values spread along it. */
  function sampleOf(soup) {
    var L = soup.length, step = Math.max(1, Math.floor(L / 48)), h = 0, k = 1;
    for (var i = 0; i < L; i += step, k++) h += soup[i] * k;
    return h + soup[L - 1] * 7919;
  }
  /* A fingerprint of every value. One pass; used once per plan, not per query. */
  function fullOf(soup) {
    var a = 0, b = 0;
    for (var i = 0, L = soup.length; i < L; i++) { var v = soup[i]; a += v; b += v * ((i % 1021) + 1); }
    return a + '|' + b;
  }

  /* ---- the build: self-contained (with the two fingerprints above), because it is also the worker's source ---- */
  function buildCore(soup) {
    var mMin = Math.min, mMax = Math.max, mFloor = Math.floor;
    var LEAF_TRIS = 4, SAH_DEPTH = 40;
    var n = (soup && soup.length) ? (soup.length / 9) | 0 : 0, i, k;
    if (!n) return null;
    var tb = new Float64Array(n * 6), tc = new Float64Array(n * 3);
    for (i = 0; i < n; i++) {
      var o = i * 9;
      for (k = 0; k < 3; k++) {
        var a = soup[o + k], b = soup[o + 3 + k], c = soup[o + 6 + k];
        if (!(isFinite(a) && isFinite(b) && isFinite(c))) return null;
        var lo = mMin(a, b, c), hi = mMax(a, b, c);
        tb[i * 6 + k] = lo; tb[i * 6 + 3 + k] = hi; tc[i * 3 + k] = (lo + hi) * 0.5;
      }
    }
    var order = new Int32Array(n);
    for (i = 0; i < n; i++) order[i] = i;
    var cap = 2 * n + 1;
    var box = new Float64Array(cap * 6), left = new Int32Array(cap), right = new Int32Array(cap);
    var start = new Int32Array(cap), count = new Int32Array(cap);
    var nodes = 0;
    var BINS = 12, binN = new Int32Array(BINS), binLo = new Float64Array(BINS * 3), binHi = new Float64Array(BINS * 3);
    var leftCost = new Float64Array(BINS), leftN = new Int32Array(BINS);
    function make(s, e, dep) {
      var id = nodes++;
      start[id] = s; count[id] = e - s;
      var b0 = id * 6;
      if (e - s <= LEAF_TRIS) {
        left[id] = -1; right[id] = -1;
        for (k = 0; k < 3; k++) { box[b0 + k] = Infinity; box[b0 + 3 + k] = -Infinity; }
        for (var q = s; q < e; q++) {
          var t = order[q];
          for (k = 0; k < 3; k++) {
            if (tb[t * 6 + k] < box[b0 + k]) box[b0 + k] = tb[t * 6 + k];
            if (tb[t * 6 + 3 + k] > box[b0 + 3 + k]) box[b0 + 3 + k] = tb[t * 6 + 3 + k];
          }
        }
        return id;
      }
      var cmn = [Infinity, Infinity, Infinity], cmx = [-Infinity, -Infinity, -Infinity];
      for (var r = s; r < e; r++) {
        var tt = order[r];
        for (k = 0; k < 3; k++) {
          var cv = tc[tt * 3 + k];
          if (cv < cmn[k]) cmn[k] = cv;
          if (cv > cmx[k]) cmx[k] = cv;
        }
      }
      /* The split: a binned surface-area heuristic over the three axes (the
         plane that makes the cheapest pair of boxes to be tested), and the
         median of the longest axis when no plane separates anything. */
      var bestCost = Infinity, bestAx = -1, bestBin = -1, ax, bi;
      /* (past SAH_DEPTH it is the median alone, so the tree is never deeper than
         the traversal stack: SAH on a strange mesh can peel one triangle a level) */
      for (ax = 0; ax < (dep < SAH_DEPTH ? 3 : 0); ax++) {
        var ext = cmx[ax] - cmn[ax];
        if (!(ext > 0)) continue;
        for (bi = 0; bi < BINS; bi++) {
          binN[bi] = 0;
          for (k = 0; k < 3; k++) { binLo[bi * 3 + k] = Infinity; binHi[bi * 3 + k] = -Infinity; }
        }
        for (r = s; r < e; r++) {
          tt = order[r];
          bi = mMin(BINS - 1, mFloor((tc[tt * 3 + ax] - cmn[ax]) / ext * BINS));
          binN[bi]++;
          for (k = 0; k < 3; k++) {
            if (tb[tt * 6 + k] < binLo[bi * 3 + k]) binLo[bi * 3 + k] = tb[tt * 6 + k];
            if (tb[tt * 6 + 3 + k] > binHi[bi * 3 + k]) binHi[bi * 3 + k] = tb[tt * 6 + 3 + k];
          }
        }
        /* area of the boxes of bins [0..i] and [i+1..], swept */
        var cnt = 0, lx0 = Infinity, ly0 = Infinity, lz0 = Infinity, lx1 = -Infinity, ly1 = -Infinity, lz1 = -Infinity;
        for (bi = 0; bi < BINS - 1; bi++) {
          if (binN[bi]) {
            cnt += binN[bi];
            lx0 = mMin(lx0, binLo[bi * 3]); ly0 = mMin(ly0, binLo[bi * 3 + 1]); lz0 = mMin(lz0, binLo[bi * 3 + 2]);
            lx1 = mMax(lx1, binHi[bi * 3]); ly1 = mMax(ly1, binHi[bi * 3 + 1]); lz1 = mMax(lz1, binHi[bi * 3 + 2]);
          }
          leftCost[bi] = cnt ? cnt * ((lx1 - lx0) * (ly1 - ly0) + (ly1 - ly0) * (lz1 - lz0) + (lz1 - lz0) * (lx1 - lx0)) : 0;
          leftN[bi] = cnt;
        }
        cnt = 0; lx0 = ly0 = lz0 = Infinity; lx1 = ly1 = lz1 = -Infinity;
        for (bi = BINS - 1; bi > 0; bi--) {
          if (binN[bi]) {
            cnt += binN[bi];
            lx0 = mMin(lx0, binLo[bi * 3]); ly0 = mMin(ly0, binLo[bi * 3 + 1]); lz0 = mMin(lz0, binLo[bi * 3 + 2]);
            lx1 = mMax(lx1, binHi[bi * 3]); ly1 = mMax(ly1, binHi[bi * 3 + 1]); lz1 = mMax(lz1, binHi[bi * 3 + 2]);
          }
          if (leftN[bi - 1] > 0 && cnt > 0) {
            var cost = leftCost[bi - 1] + cnt * ((lx1 - lx0) * (ly1 - ly0) + (ly1 - ly0) * (lz1 - lz0) + (lz1 - lz0) * (lx1 - lx0));
            if (cost < bestCost) { bestCost = cost; bestAx = ax; bestBin = bi - 1; }
          }
        }
      }
      var mid = -1;
      if (bestAx >= 0) {
        var ex = cmx[bestAx] - cmn[bestAx], i0 = s, i1 = e - 1;
        while (i0 <= i1) {
          var tl = order[i0];
          if (mMin(BINS - 1, mFloor((tc[tl * 3 + bestAx] - cmn[bestAx]) / ex * BINS)) <= bestBin) i0++;
          else { order[i0] = order[i1]; order[i1] = tl; i1--; }
        }
        mid = i0;
        if (mid === s || mid === e) mid = -1;
      }
      if (mid < 0) {
        ax = 0;
        if (cmx[1] - cmn[1] > cmx[ax] - cmn[ax]) ax = 1;
        if (cmx[2] - cmn[2] > cmx[ax] - cmn[ax]) ax = 2;
        if (cmx[ax] > cmn[ax]) {
          order.subarray(s, e).sort(function (p, q2) { return (tc[p * 3 + ax] - tc[q2 * 3 + ax]) || (p - q2); });
        }
        mid = (s + e) >> 1;
      }
      var l = make(s, mid, dep + 1), rr = make(mid, e, dep + 1);
      left[id] = l; right[id] = rr;
      for (k = 0; k < 3; k++) {
        box[b0 + k] = mMin(box[l * 6 + k], box[rr * 6 + k]);
        box[b0 + 3 + k] = mMax(box[l * 6 + 3 + k], box[rr * 6 + 3 + k]);
      }
      return id;
    }
    make(0, n, 0);
    /* The soup's own box, before the pad: the "first bounds" of a piece, free
       from the root. */
    var bounds = { min: [box[0], box[1], box[2]], max: [box[3], box[4], box[5]] };
    /* Pad every box. rayTri accepts a hit up to 1e-9 of an edge outside its
       triangle, so a box that is exact would be able to miss a hit the walk
       reports; the pad is two orders over that at plate scale. */
    var span = 0;
    for (k = 0; k < 3; k++) span = mMax(span, box[3 + k] - box[k]);
    var pad = 1e-6 + 1e-8 * span;
    for (i = 0; i < nodes; i++) for (k = 0; k < 3; k++) { box[i * 6 + k] -= pad; box[i * 6 + 3 + k] += pad; }
    /* Trim to the nodes used: the arrays were sized for the worst tree. */
    return { n: n, nodes: nodes, bounds: bounds, len: soup.length, sample: sampleOf(soup), full: fullOf(soup),
             box: box.slice(0, nodes * 6), left: left.slice(0, nodes), right: right.slice(0, nodes),
             start: start.slice(0, nodes), count: count.slice(0, nodes), order: order, tb: tb };
  }

  /* The index object the planner has always held: the build's arrays plus the
     fingerprints it is checked against and two slots the planner fills in. */
  function seal(soup, core) {
    if (!core) return null;
    return { n: core.n, len: core.len, sample: core.sample, full: core.full, nodes: core.nodes,
             box: core.box, left: core.left, right: core.right, start: core.start, count: core.count,
             order: core.order, tb: core.tb, bounds: core.bounds, wind: null, cross: undefined };
  }

  function buildBVH(soup) { return seal(soup, buildCore(soup)); }

  var INDEX_MIN_TRIS = 16;
  var indexCache = typeof WeakMap === 'function' ? new WeakMap() : null;

  /* The soup's index, or null for a soup too small (or too broken - a
     non-finite coordinate - to index). `verify` reads every value instead of
     a sample, once, and rebuilds if the soup changed under its index. */
  function indexFor(soup, verify, minTris) {
    var min = minTris == null ? INDEX_MIN_TRIS : minTris;
    if (!indexCache || !soup || soup.length < min * 9) return null;
    var ix = indexCache.get(soup);
    if (ix === undefined || (ix && (ix.len !== soup.length || ix.sample !== sampleOf(soup)))) ix = undefined;
    if (ix && verify && ix.full !== fullOf(soup)) ix = undefined;
    if (ix === undefined) {
      ix = buildBVH(soup);
      indexCache.set(soup, ix);
    }
    return ix;
  }

  /* ---- the questions ---- */
  var mSqrt = Math.sqrt, mAbs = Math.abs, mMax = Math.max;
  var STACK = new Int32Array(256);

  /* Distance along the ray at which it enters box `b` of the index, within
     [0, limit]; Infinity when it does not. The origin inside is 0. `ix_` and
     friends are 1/d per axis, with 1e300 standing for 1/0: a slab the ray
     runs parallel to then spans (-huge, +huge) when the origin is between its
     faces and is empty when it is not, with no NaN to catch (the boxes are
     padded, so an origin ON a face is not a case). */
  function boxEntry(box, b, ox, oy, oz, ix_, iy_, iz_, limit) {
    var a = (box[b] - ox) * ix_, c = (box[b + 3] - ox) * ix_;
    var t0 = a < c ? a : c, t1 = a < c ? c : a;
    a = (box[b + 1] - oy) * iy_; c = (box[b + 4] - oy) * iy_;
    if (a > c) { var tmp = a; a = c; c = tmp; }
    if (a > t0) t0 = a;
    if (c < t1) t1 = c;
    a = (box[b + 2] - oz) * iz_; c = (box[b + 5] - oz) * iz_;
    if (a > c) { tmp = a; a = c; c = tmp; }
    if (a > t0) t0 = a;
    if (c < t1) t1 = c;
    if (t1 > limit) t1 = limit;
    if (t0 < 0) t0 = 0;
    return t0 <= t1 ? t0 : Infinity;
  }

  /* Distance from p to box `b` (0 inside). A lower bound on the distance to
     any triangle in it - the box is padded, so it is a safe one. */
  function boxDist(box, b, px, py, pz) {
    var gx = mMax(box[b] - px, 0, px - box[b + 3]);
    var gy = mMax(box[b + 1] - py, 0, py - box[b + 4]);
    var gz = mMax(box[b + 2] - pz, 0, pz - box[b + 5]);
    return mSqrt(gx * gx + gy * gy + gz * gz);
  }

  /* Every triangle in a leaf whose box the ray (o, d), t in [0, limit], enters,
     ascending by triangle number, handed to emit(tri). A superset of the
     triangles the ray can hit; the caller's own test decides which it does. */
  function rayCandidates(ix, ox, oy, oz, dx, dy, dz, limit, out) {
    var ix_ = mAbs(dx) < 1e-300 ? 1e300 : 1 / dx, iy_ = mAbs(dy) < 1e-300 ? 1e300 : 1 / dy, iz_ = mAbs(dz) < 1e-300 ? 1e300 : 1 / dz;
    var box = ix.box, left = ix.left, right = ix.right, start = ix.start, count = ix.count, order = ix.order;
    var sp = 0, node, l, r;
    out.length = 0;
    if (boxEntry(box, 0, ox, oy, oz, ix_, iy_, iz_, limit) === Infinity) return out;
    STACK[sp++] = 0;
    while (sp > 0) {
      node = STACK[--sp];
      if (left[node] < 0) {
        var e = start[node] + count[node];
        for (var q = start[node]; q < e; q++) out.push(order[q]);
        continue;
      }
      l = left[node]; r = right[node];
      if (boxEntry(box, l * 6, ox, oy, oz, ix_, iy_, iz_, limit) !== Infinity) STACK[sp++] = l;
      if (boxEntry(box, r * 6, ox, oy, oz, ix_, iy_, iz_, limit) !== Infinity) STACK[sp++] = r;
    }
    out.sort(function (p, q2) { return p - q2; });
    return out;
  }

  /* ---- off the main thread ---- */
  var workerSrc = null, worker = null, jobs = Object.create(null), jobSeq = 0, queue = [], busy = false;
  var canWorker = typeof Worker === 'function' && typeof Blob === 'function' && typeof URL === 'function' && URL.createObjectURL;

  function startWorker() {
    if (worker) return worker;
    if (!canWorker) return null;
    try {
      workerSrc = sampleOf.toString() + ';' + fullOf.toString() + ';' + buildCore.toString() +
        ';self.onmessage=function(e){var m=e.data,r=null,err=null;try{r=buildCore(m.soup);}catch(x){err=String(x&&x.message||x);}' +
        'var t=[];if(r){t=[r.box.buffer,r.left.buffer,r.right.buffer,r.start.buffer,r.count.buffer,r.order.buffer,r.tb.buffer];}' +
        'self.postMessage({id:m.id,core:r,error:err},t);};';
      worker = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' })));
      worker.onmessage = function (e) {
        var j = jobs[e.data.id]; delete jobs[e.data.id]; busy = false;
        if (j) j(e.data.error ? null : e.data.core);
        pump();
      };
      worker.onerror = function () {
        /* the worker could not run: finish what is waiting in place, and stay in place */
        worker = null; canWorker = false; busy = false;
        var ids = Object.keys(jobs); ids.forEach(function (id) { var j = jobs[id]; delete jobs[id]; j(undefined); });
        var waiting = queue.splice(0); waiting.forEach(function (job) { job.done(undefined); });
      };
    } catch (err) { worker = null; canWorker = false; }
    return worker;
  }

  function pump() {
    if (busy || !queue.length) return;
    var job = queue.shift();
    busy = true;
    jobs[job.id] = job.done;
    /* the soup is COPIED in (the page still owns its array); the arrays come back by transfer */
    worker.postMessage({ id: job.id, soup: job.soup });
  }

  /* Build the tree for `soup` in the worker; resolves with the index (or null for a soup too small or
     too broken to index). Cached: the same array asked again resolves at once. */
  var pending = typeof WeakMap === 'function' ? new WeakMap() : null;
  function ensure(soup, minTris) {
    var min = minTris == null ? INDEX_MIN_TRIS : minTris;
    if (!soup || soup.length < min * 9) return Promise.resolve(null);
    var have = peek(soup);
    if (have) return Promise.resolve(have);
    var inflight = pending && pending.get(soup);
    if (inflight) return inflight;
    var p = new Promise(function (resolve) {
      function finish(core) {
        if (pending) pending.delete(soup);
        var ix = seal(soup, core);
        if (indexCache) indexCache.set(soup, ix);
        resolve(ix);
      }
      if (startWorker()) {
        queue.push({ id: ++jobSeq, soup: soup, done: function (core) {
          /* undefined = the worker died under us: build here, once */
          finish(core === undefined ? buildCore(soup) : core);
        } });
        pump();
      } else {
        setTimeout(function () { finish(buildCore(soup)); }, 0);
      }
    });
    if (pending) pending.set(soup, p);
    return p;
  }

  /* The index if it is built and still describes `soup`; never builds. */
  function peek(soup) {
    if (!indexCache || !soup) return null;
    var ix = indexCache.get(soup);
    if (!ix || ix.len !== soup.length || ix.sample !== sampleOf(soup)) return null;
    return ix;
  }

  /* Forget the tree held for `soup`: its array was edited in place. */
  function forget(soup) { if (indexCache && soup) indexCache.delete(soup); }

  /* ---- the viewer: three's Mesh.raycast, asked only about triangles the ray can reach ---- */
  var MIN_TRIS = 50000;           // below this three's own walk is cheaper than a tree it would never earn back
  var geomState = typeof WeakMap === 'function' ? new WeakMap() : null;
  var REBUILD_DELAY_MS = 250;

  /* A position attribute that reads as a plain soup: non-indexed triples of xyz. */
  function soupOfGeometry(g) {
    if (!g || !g.attributes || g.index) return null;
    var pos = g.attributes.position;
    if (!pos || pos.isInterleavedBufferAttribute || pos.itemSize !== 3 || !pos.array) return null;
    if (pos.count % 3 !== 0 || pos.array.length !== pos.count * 3) return null;
    return pos.array;
  }

  /* The geometry's tree if it is built and still describes it. Never builds;
     when there is none (or it is stale) asks the worker for one, once. */
  function treeOf(g) {
    var arr = soupOfGeometry(g);
    if (!arr) return null;
    var pos = g.attributes.position;
    var st = geomState.get(g);
    if (st && st.arr === arr && st.version === pos.version && st.count === pos.count && st.ix &&
        st.ix.sample === sampleOf(arr)) return st.ix;
    request(g);
    return null;
  }

  function request(g) {
    var arr = soupOfGeometry(g);
    if (!arr) return;
    var st = geomState.get(g);
    if (!st) { st = { arr: null, version: -1, count: -1, ix: null, asked: false, timer: null }; geomState.set(g, st); }
    if (st.asked) return;
    st.asked = true;
    var run = function () {
      st.timer = null;
      var pos = g.attributes.position, a = soupOfGeometry(g);
      if (!a) { st.asked = false; return; }
      var ver = pos.version, cnt = pos.count;
      forget(a);                          // an edit in place leaves the array the same object
      ensure(a, 0).then(function (ix) {
        var now = soupOfGeometry(g);
        st.asked = false;
        if (now !== a || g.attributes.position.version !== ver || g.attributes.position.count !== cnt) {
          request(g);                     // edited again while it was being built
          return;
        }
        st.arr = a; st.version = ver; st.count = cnt; st.ix = ix;
      });
    };
    st.timer = setTimeout(run, st.ix ? REBUILD_DELAY_MS : 0);
  }

  /* Resolves once `geometry` has a tree that describes it (a big piece being
     imported waits here, with a progress line). Resolves null if it cannot have one. */
  function ensureGeometry(g) {
    var arr = soupOfGeometry(g);
    if (!arr) return Promise.resolve(null);
    var pos = g.attributes.position, ver = pos.version, cnt = pos.count;
    var st = geomState.get(g);
    if (!st) { st = { arr: null, version: -1, count: -1, ix: null, asked: false, timer: null }; geomState.set(g, st); }
    forget(arr);
    st.asked = true;
    return ensure(arr, 0).then(function (ix) {
      st.asked = false;
      if (ix && soupOfGeometry(g) === arr && g.attributes.position.version === ver && g.attributes.position.count === cnt) {
        st.arr = arr; st.version = ver; st.count = cnt; st.ix = ix;
      }
      return ix;
    });
  }

  /* A geometry was rewritten (nso-bounds.js's one invalidation calls this): if
     it is one a tree is kept for, ask for the new one now rather than at the
     next hover. Costs nothing for a geometry that was never asked about. */
  function touch(g) {
    if (geomState && g && geomState.has(g)) treeOf(g);
  }

  function installThree(T, opts) {
    if (!T || !T.Mesh || !T.Ray || !T.Triangle || T.Mesh.prototype.raycast._nsoBvh) return false;
    if (opts && opts.minTris != null) MIN_TRIS = opts.minTris;
    var orig = T.Mesh.prototype.raycast;
    var Sphere = T.Sphere, Matrix4 = T.Matrix4, Ray = T.Ray, Vector3 = T.Vector3, Triangle = T.Triangle;
    var _sphere = new Sphere(), _inverse = new Matrix4(), _ray = new Ray();
    var _vA = new Vector3(), _vB = new Vector3(), _vC = new Vector3(), _hit = new Vector3(), _world = new Vector3();
    var cands = [];

    function eligible(mesh, g) {
      if (!g || mesh.isSkinnedMesh) return false;
      var mat = mesh.material;
      if (mat === undefined || Array.isArray(mat)) return false;
      var a = g.attributes;
      if (!a || !a.position || a.uv || a.uv2 || g.index) return false;
      if (g.morphAttributes && g.morphAttributes.position) return false;
      if (a.position.count < MIN_TRIS * 3) return false;
      var dr = g.drawRange;
      if (dr && (dr.start !== 0 || dr.count < a.position.count)) return false;
      return !!soupOfGeometry(g);
    }

    function raycast(raycaster, intersects) {
      var g = this.geometry;
      if (!eligible(this, g)) return raycast._orig.call(this, raycaster, intersects);
      var ix = treeOf(g);
      if (!ix) {
        /* No tree yet (or an edit just outdated it). A hover over a BIG piece
           (300k triangles and up, where a walk is tens of ms) answers "nothing"
           and waits for one; anything else keeps three's walk, as before. */
        if (raycaster.nsoHover && g.attributes.position.count / 3 >= api.BIG_TRIS) return;
        return raycast._orig.call(this, raycaster, intersects);
      }
      var material = this.material, matrixWorld = this.matrixWorld;
      if (g.boundingSphere === null) g.computeBoundingSphere();
      _sphere.copy(g.boundingSphere);
      _sphere.applyMatrix4(matrixWorld);
      if (raycaster.ray.intersectsSphere(_sphere) === false) return;
      _inverse.copy(matrixWorld).invert();
      _ray.copy(raycaster.ray).applyMatrix4(_inverse);
      if (g.boundingBox !== null) { if (_ray.intersectsBox(g.boundingBox) === false) return; }

      var position = g.attributes.position, side = material.side;
      var list = rayCandidates(ix, _ray.origin.x, _ray.origin.y, _ray.origin.z,
                               _ray.direction.x, _ray.direction.y, _ray.direction.z, Infinity, cands);
      for (var k = 0; k < list.length; k++) {
        var t = list[k], a = t * 3, b = a + 1, c = a + 2, hit;
        _vA.fromBufferAttribute(position, a);
        _vB.fromBufferAttribute(position, b);
        _vC.fromBufferAttribute(position, c);
        if (side === T.BackSide) hit = _ray.intersectTriangle(_vC, _vB, _vA, true, _hit);
        else hit = _ray.intersectTriangle(_vA, _vB, _vC, side !== T.DoubleSide, _hit);
        if (hit === null) continue;
        _world.copy(_hit);
        _world.applyMatrix4(this.matrixWorld);
        var distance = raycaster.ray.origin.distanceTo(_world);
        if (distance < raycaster.near || distance > raycaster.far) continue;
        var intersection = { distance: distance, point: _world.clone(), object: this };
        var face = { a: a, b: b, c: c, normal: new Vector3(), materialIndex: 0 };
        Triangle.getNormal(_vA, _vB, _vC, face.normal);
        intersection.face = face;
        intersection.faceIndex = t;
        intersects.push(intersection);
      }
    }
    raycast._nsoBvh = true;
    raycast._orig = orig;
    T.Mesh.prototype.raycast = raycast;
    return true;
  }

  var api = {
    INDEX_MIN_TRIS: INDEX_MIN_TRIS,
    installThree: installThree,
    treeOf: treeOf,
    touch: touch,
    BIG_TRIS: 300000,
    isBig: function (trisOrGeometry) {
      var n = typeof trisOrGeometry === 'number' ? trisOrGeometry :
        (trisOrGeometry && trisOrGeometry.attributes && trisOrGeometry.attributes.position ? trisOrGeometry.attributes.position.count / 3 : 0);
      return n >= api.BIG_TRIS;
    },
    ensureGeometry: ensureGeometry,
    forget: forget,
    minTris: function () { return MIN_TRIS; },
    _setMinTris: function (n) { var was = MIN_TRIS; MIN_TRIS = n; return was; },
    _setBigTris: function (n) { var was = api.BIG_TRIS; api.BIG_TRIS = n; return was; },
    _rebuildDelay: function () { return REBUILD_DELAY_MS; },
    buildCore: buildCore,
    build: buildBVH,
    indexFor: indexFor,
    peek: peek,
    ensure: ensure,
    sampleOf: sampleOf,
    fullOf: fullOf,
    boxEntry: boxEntry,
    boxDist: boxDist,
    rayCandidates: rayCandidates,
    _setIndexMinTris: function (n) { var was = INDEX_MIN_TRIS; INDEX_MIN_TRIS = n; api.INDEX_MIN_TRIS = n; return was; },
    _cache: function () { return indexCache; },
    _useWorker: function (on) { if (!on) { canWorker = false; } return canWorker; }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_BVH = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
