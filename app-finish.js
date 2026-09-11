// ===================== Soften Selected (post-cut Edit action) =====================
// An independent Edit action on the currently selected library model —
// never wired into Split/splitBothSides, never touches the display mesh
// directly (always rebuilds from rawTris). No model other than the
// selected one is touched.
//
// All three treatments run the one shared cap-plane engine in app-cut.js
// (rawEdgeRoundInPlace), which keeps the cut face on the plane it is
// already on and pulls the wall back only at treated edges. Round and
// Bevel differ by profile; Corners is a per-vertex radius filter on that
// same loop, not a second loop walker.
//
// A model carries no record of which face (if any) was its own cut face,
// and Split is locked from being changed to add that. So the caller picks
// the face; a factory-curved end simply has no meaningful cap/wall
// boundary there and the engine fails safely, before any mesh swap.

// True perimeter fillet on the clicked face's own loop — Round and Bevel.
//
// Corners rolls only the vertices that turn; this rolls the WHOLE loop: every
// loop point carries R, so all four edges of a square face get the radius and
// none of them stays a sharp straight run. Same rules as Corners otherwise —
// the cap plane is read off the mesh and the lid is rebuilt at exactly that
// plane, the wall moves in depth only, and the lid is the original cap
// triangles trimmed back to the ring rather than a re-fan. The lid boundary
// insets by R because that is what a fillet is; the lid itself never pulls
// back off its plane.
//
// opts.profile  'round' (default) quarter circle, or 'chamfer' flat band.
function rawPerimeterFilletInPlace(rawTris, axisIdx, keepMin, requestedR, opts) {
  opts = opts || {};
  const chamfer = opts.profile === 'chamfer';
  const STEPS = chamfer ? 1 : 6;
  const intoBody = keepMin ? 1 : -1;
  const other = [0, 1, 2].filter(a => a !== axisIdx);
  const tol = 1e-4;

  let minV = Infinity, maxV = -Infinity;
  for (let i = axisIdx; i < rawTris.length; i += 3) {
    if (rawTris[i] < minV) minV = rawTris[i];
    if (rawTris[i] > maxV) maxV = rawTris[i];
  }
  const capPlane = keepMin ? minV : maxV;
  const capTol = 1e-3;

  const triCount = rawTris.length / 9;
  const vert = (t, v) => { const i0 = t*9 + v*3; return [rawTris[i0], rawTris[i0+1], rawTris[i0+2]]; };
  const isOnCap = (p) => Math.abs(p[axisIdx] - capPlane) < capTol;

  const capTriIdx = [], wallTriIdx = [];
  for (let t = 0; t < triCount; t++) {
    const v0=vert(t,0), v1=vert(t,1), v2=vert(t,2);
    if (isOnCap(v0) && isOnCap(v1) && isOnCap(v2)) capTriIdx.push(t);
    else wallTriIdx.push(t);
  }
  if (!capTriIdx.length) throw new Error('no cap found on this face');

  const vkey = (p) => Math.round(p[0]/tol)+'|'+Math.round(p[1]/tol)+'|'+Math.round(p[2]/tol);
  const edgeMap = new Map();
  const addEdge = (a, b, isCap) => {
    const ka = vkey(a), kb = vkey(b);
    const ek = ka < kb ? ka+'~'+kb : kb+'~'+ka;
    if (!edgeMap.has(ek)) edgeMap.set(ek, []);
    edgeMap.get(ek).push({ isCap, a, b });
  };
  for (const t of capTriIdx) {
    const v0=vert(t,0), v1=vert(t,1), v2=vert(t,2);
    addEdge(v0,v1,true); addEdge(v1,v2,true); addEdge(v2,v0,true);
  }
  for (const t of wallTriIdx) {
    const v0=vert(t,0), v1=vert(t,1), v2=vert(t,2);
    if (isOnCap(v0) && isOnCap(v1)) addEdge(v0,v1,false);
    if (isOnCap(v1) && isOnCap(v2)) addEdge(v1,v2,false);
    if (isOnCap(v2) && isOnCap(v0)) addEdge(v2,v0,false);
  }
  const boundaryEdges = [];
  for (const entries of edgeMap.values()) {
    if (entries.length === 2 && entries.some(e=>e.isCap) && entries.some(e=>!e.isCap)) {
      const capEntry = entries.find(e => e.isCap);
      boundaryEdges.push([capEntry.a, capEntry.b]);
    }
  }
  if (!boundaryEdges.length) throw new Error('no cap/wall boundary found');

  const adj = new Map(), posOf = new Map();
  const pushAdj = (k, o) => { if (!adj.has(k)) adj.set(k, []); adj.get(k).push(o); };
  for (const [a,b] of boundaryEdges) {
    const ka = vkey(a), kb = vkey(b);
    posOf.set(ka,a); posOf.set(kb,b);
    pushAdj(ka,kb); pushAdj(kb,ka);
  }
  for (const list of adj.values()) if (list.length !== 2) throw new Error('branch point in cap boundary');
  const startKey = vkey(boundaryEdges[0][0]);
  const loopKeys = [startKey];
  let prevKey = null, curKey = startKey;
  do {
    const nbrs = adj.get(curKey);
    const nextKey = nbrs[0] === prevKey ? nbrs[1] : nbrs[0];
    if (nextKey === startKey) break;
    loopKeys.push(nextKey);
    prevKey = curKey; curKey = nextKey;
    if (loopKeys.length > adj.size + 2) throw new Error('cap boundary did not close');
  } while (true);
  const loop3d = loopKeys.map(k => posOf.get(k));
  if (loop3d.length < 3) throw new Error('cap boundary too small to fillet');

  const flat2 = (p3) => [p3[other[0]], p3[other[1]]];
  let poly2d = loop3d.map(flat2);
  poly2d = raw2DWeldLoop(poly2d, 0.08);
  const n = poly2d.length;
  if (n < 3) throw new Error('cap boundary too small after weld');

  // Wall available at a loop point, skipping only the two segments that
  // touch it. rawLocalThickness2 skips everything within two indices, so on a
  // coarse loop it skips the whole loop and falls back to its 4mm default.
  const wallLimitAt = (i) => {
    const curr = poly2d[i];
    const prev = poly2d[(i-1+n)%n], next = poly2d[(i+1)%n];
    const nn = rawEdgeInwardNormal2(prev, next);
    let best = Infinity;
    for (let j = 0; j < n; j++) {
      if (j === i || j === (i-1+n)%n) continue;
      const a = poly2d[j], b = poly2d[(j+1)%n];
      const dx = b[0]-a[0], dy = b[1]-a[1];
      const den = nn[0]*dy - nn[1]*dx;
      if (Math.abs(den) < 1e-10) continue;
      const t = ((a[0]-curr[0])*dy - (a[1]-curr[1])*dx) / den;
      const u = ((a[0]-curr[0])*nn[1] - (a[1]-curr[1])*nn[0]) / -den;
      if (t > 0.1 && t < best && u >= -0.05 && u <= 1.05) best = t;
    }
    for (let j = 0; j < n; j++) {
      if (j === i || j === (i-1+n)%n || j === (i+1)%n) continue;
      const d = Math.hypot(poly2d[j][0]-curr[0], poly2d[j][1]-curr[1]);
      if (d < best) best = d;
    }
    return best === Infinity ? 4 : best;
  };
  // Every loop point carries R — that is the whole difference from Corners.
  const Rs = new Array(n);
  let peakR = 0;
  for (let i = 0; i < n; i++) {
    Rs[i] = Math.min(requestedR, Math.max(0, wallLimitAt(i) * 0.45));
    if (Rs[i] > peakR) peakR = Rs[i];
  }
  if (peakR < 0.02) throw new Error('no safe radius anywhere on this face');

  let area2 = 0;
  for (let i = 0; i < n; i++) { const a=poly2d[i], b=poly2d[(i+1)%n]; area2 += a[0]*b[1]-b[0]*a[1]; }
  const windSign = area2 >= 0 ? 1 : -1;
  const inwardNormal2 = (a, b) => {
    const tx=b[0]-a[0], ty=b[1]-a[1];
    let nx=-ty*windSign, ny=tx*windSign;
    const len = Math.hypot(nx,ny) || 1e-9;
    return [nx/len, ny/len];
  };
  const vertexOffset = (i, radius) => {
    const prev=poly2d[(i-1+n)%n], curr=poly2d[i], next=poly2d[(i+1)%n];
    const n1=inwardNormal2(prev,curr), n2=inwardNormal2(curr,next);
    let bx=n1[0]+n2[0], by=n1[1]+n2[1];
    const blen=Math.hypot(bx,by)||1e-9; bx/=blen; by/=blen;
    const cosHalf = Math.max(bx*n1[0]+by*n1[1], 0.3);
    return [curr[0]+bx*(radius/cosHalf), curr[1]+by*(radius/cosHalf)];
  };
  const from3 = (uv, along) => { const p=[0,0,0]; p[other[0]]=uv[0]; p[other[1]]=uv[1]; p[axisIdx]=along; return p; };
  const ringAt = (s) => {
    const t = s / STEPS;
    const phi = Math.asin(Math.min(1, Math.max(0, t)));
    const ring = [];
    for (let i = 0; i < n; i++) {
      const R = Rs[i];
      const inset = chamfer ? R * t : R * (1 - Math.cos(phi));
      const depth = chamfer ? R * (1 - t) : R * (1 - Math.sin(phi));
      ring.push(from3(vertexOffset(i, inset), capPlane + intoBody * depth));
    }
    return ring;
  };
  const rings = [];
  for (let s = 0; s <= STEPS; s++) rings.push(ringAt(s));
  const ringTop2 = rings[STEPS].map(flat2);
  if (rawRingSelfIntersects2(ringTop2)) throw new Error('R=' + requestedR + ' self-intersects on this face');

  const out = [];
  const polyArea = (p) => {
    let a = 0;
    for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i+1)%p.length]; a += q[0]*r[1] - r[0]*q[1]; }
    return Math.abs(a) * 0.5;
  };
  const clipHalf = (p, px, py, nx, ny) => {
    if (p.length < 3) return [];
    const res = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i+1)%p.length];
      const da = (a[0]-px)*nx + (a[1]-py)*ny;
      const db = (b[0]-px)*nx + (b[1]-py)*ny;
      if (da >= -1e-12) res.push(a);
      if ((da > 1e-12 && db < -1e-12) || (da < -1e-12 && db > 1e-12)) {
        const u = da / (da - db);
        res.push([a[0] + (b[0]-a[0])*u, a[1] + (b[1]-a[1])*u]);
      }
    }
    const cl = [];
    for (const q of res) {
      const last = cl[cl.length-1];
      if (!last || Math.hypot(q[0]-last[0], q[1]-last[1]) > 1e-9) cl.push(q);
    }
    while (cl.length > 1 && Math.hypot(cl[0][0]-cl[cl.length-1][0], cl[0][1]-cl[cl.length-1][1]) < 1e-9) cl.pop();
    return cl.length >= 3 ? cl : [];
  };

  // ---------- lid: original cap triangles trimmed back to the ring ----------
  const capPolys = capTriIdx.map(t => [flat2(vert(t,0)), flat2(vert(t,1)), flat2(vert(t,2))]);
  let lidBefore = 0;
  for (const p of capPolys) lidBefore += polyArea(p);
  let convexRing = true, csign = 0;
  for (let i = 0; i < n && convexRing; i++) {
    const a = ringTop2[i], b = ringTop2[(i+1)%n], c = ringTop2[(i+2)%n];
    const cr = (b[0]-a[0])*(c[1]-b[1]) - (b[1]-a[1])*(c[0]-b[0]);
    if (Math.abs(cr) < 1e-12) continue;
    const sg = cr > 0 ? 1 : -1;
    if (csign === 0) csign = sg; else if (sg !== csign) convexRing = false;
  }
  if (csign === 0) convexRing = false;
  let lidPieces = [];
  if (convexRing) {
    let ra = 0;
    for (let i = 0; i < n; i++) { const a=ringTop2[i], b=ringTop2[(i+1)%n]; ra += a[0]*b[1]-b[0]*a[1]; }
    const w = ra >= 0 ? 1 : -1;
    for (const cp of capPolys) {
      let piece = cp;
      for (let i = 0; i < n && piece.length; i++) {
        const a = ringTop2[i], b = ringTop2[(i+1)%n];
        piece = clipHalf(piece, a[0], a[1], -(b[1]-a[1])*w, (b[0]-a[0])*w);
      }
      if (piece.length >= 3) lidPieces.push(piece);
    }
  } else {
    // Non-convex face: take the band off quad by quad instead of assuming the
    // ring can be used as a set of half planes.
    lidPieces = capPolys.slice();
    for (let i = 0; i < n; i++) {
      const i1 = (i+1)%n;
      const q = [poly2d[i], poly2d[i1], ringTop2[i1], ringTop2[i]];
      if (polyArea(q) < 1e-12) continue;
      let bx0=Infinity, by0=Infinity, bx1=-Infinity, by1=-Infinity;
      for (const v of q) {
        if (v[0] < bx0) bx0 = v[0];
        if (v[0] > bx1) bx1 = v[0];
        if (v[1] < by0) by0 = v[1];
        if (v[1] > by1) by1 = v[1];
      }
      const cen = [0, 0];
      for (const v of q) { cen[0] += v[0]/q.length; cen[1] += v[1]/q.length; }
      const next = [];
      for (const p of lidPieces) {
        let px0=Infinity, py0=Infinity, px1=-Infinity, py1=-Infinity;
        for (const v of p) {
          if (v[0] < px0) px0 = v[0];
          if (v[0] > px1) px1 = v[0];
          if (v[1] < py0) py0 = v[1];
          if (v[1] > py1) py1 = v[1];
        }
        if (px1 < bx0-1e-9 || px0 > bx1+1e-9 || py1 < by0-1e-9 || py0 > by1+1e-9) { next.push(p); continue; }
        let inside = p;
        for (let e = 0; e < q.length && inside.length; e++) {
          const a = q[e], b = q[(e+1)%q.length];
          let nx = -(b[1]-a[1]), ny = b[0]-a[0];
          if ((cen[0]-a[0])*nx + (cen[1]-a[1])*ny < 0) { nx = -nx; ny = -ny; }
          const outer = clipHalf(inside, a[0], a[1], -nx, -ny);
          if (outer.length >= 3) next.push(outer);
          inside = clipHalf(inside, a[0], a[1], nx, ny);
        }
      }
      lidPieces = next;
      if (lidPieces.length > 4096) throw new Error('lid trim did not converge');
    }
  }
  // The trimmed lid must come out as exactly the ring polygon.
  let lidAfter = 0;
  for (const p of lidPieces) lidAfter += polyArea(p);
  let ringArea = 0;
  for (let i = 0; i < n; i++) { const a=ringTop2[i], b=ringTop2[(i+1)%n]; ringArea += a[0]*b[1]-b[0]*a[1]; }
  ringArea = Math.abs(ringArea) * 0.5;
  if (!(ringArea > 1e-9) || Math.abs(ringArea - lidAfter) > Math.max(1e-6, lidBefore * 1e-5)) {
    throw new Error('R=' + requestedR + ' too large for this face - left unchanged');
  }

  // T-junction repair on the lid, then the splits the band has to follow.
  const cpts = [], cseen = new Set();
  const addC = (p) => {
    const k = Math.round(p[0]*1e4) + '|' + Math.round(p[1]*1e4);
    if (cseen.has(k)) return;
    cseen.add(k);
    cpts.push(p);
  };
  for (const p of lidPieces) for (const v of p) addC(v);
  for (const v of poly2d) addC(v);
  for (const v of loop3d) addC(flat2(v));
  for (const v of ringTop2) addC(v);
  for (let idx = 0; idx < lidPieces.length; idx++) {
    const p = lidPieces[idx], grown = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i+1)%p.length];
      grown.push(a);
      const ex = b[0]-a[0], ey = b[1]-a[1], len2 = ex*ex + ey*ey;
      if (!(len2 > 1e-18)) continue;
      const inv = 1 / Math.sqrt(len2);
      const mids = [];
      for (const q of cpts) {
        const u = ((q[0]-a[0])*ex + (q[1]-a[1])*ey) / len2;
        if (u <= 1e-6 || u >= 1-1e-6) continue;
        if (Math.abs((q[0]-a[0])*ey - (q[1]-a[1])*ex) * inv > 1e-6) continue;
        mids.push({ u, q });
      }
      mids.sort((x, y) => x.u - y.u);
      for (const md of mids) grown.push(md.q);
    }
    lidPieces[idx] = grown;
  }
  const ringSplits = new Map();
  for (const p of lidPieces) {
    for (const v of p) {
      for (let i = 0; i < n; i++) {
        const P = ringTop2[i], Q = ringTop2[(i+1)%n];
        const ex = Q[0]-P[0], ey = Q[1]-P[1], len2 = ex*ex + ey*ey;
        if (!(len2 > 1e-18)) continue;
        const u = ((v[0]-P[0])*ex + (v[1]-P[1])*ey) / len2;
        if (u <= 1e-6 || u >= 1-1e-6) continue;
        if (Math.abs((v[0]-P[0])*ey - (v[1]-P[1])*ex) / Math.sqrt(len2) > 1e-3) continue;
        if (!ringSplits.has(i)) ringSplits.set(i, []);
        const list = ringSplits.get(i);
        if (!list.some(w => Math.abs(w - u) < 1e-6)) list.push(u);
      }
    }
  }

  const emitLid = (A, B, C) => {
    let a = from3(A, capPlane), b = from3(B, capPlane), c = from3(C, capPlane);
    const ux=b[0]-a[0], uy=b[1]-a[1], uz=b[2]-a[2];
    const vx=c[0]-a[0], vy=c[1]-a[1], vz=c[2]-a[2];
    const nrm = [uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx];
    if (!(Math.hypot(nrm[0], nrm[1], nrm[2]) > 1e-10)) return;
    const wantSign = keepMin ? -1 : 1;
    if (Math.sign(nrm[axisIdx] || 1) !== wantSign) { const tmp=b; b=c; c=tmp; }
    out.push(a[0],a[1],a[2], b[0],b[1],b[2], c[0],c[1],c[2]);
  };
  for (const p of lidPieces) {
    const m = p.length;
    let apexAt = -1;
    for (let a = 0; a < m && apexAt < 0; a++) {
      let clean = true;
      for (let k = 1; k + 1 < m && clean; k++) {
        const P0 = p[a], P1 = p[(a+k)%m], P2 = p[(a+k+1)%m];
        const cr = (P1[0]-P0[0])*(P2[1]-P0[1]) - (P1[1]-P0[1])*(P2[0]-P0[0]);
        if (Math.abs(cr) * 0.5 < 1e-12) clean = false;
      }
      if (clean) apexAt = a;
    }
    if (apexAt < 0) {
      for (const t of rawEarClip2D(p)) emitLid(p[t[0]], p[t[1]], p[t[2]]);
      continue;
    }
    for (let k = 1; k + 1 < m; k++) emitLid(p[apexAt], p[(apexAt+k)%m], p[(apexAt+k+1)%m]);
  }

  // ---------- wall: depth only, split at every loop vertex ----------
  const depthOf = (uv) => {
    let bestD = Infinity, bestR = 0;
    for (let i = 0; i < n; i++) {
      const a = poly2d[i], b = poly2d[(i+1)%n];
      const ex = b[0]-a[0], ey = b[1]-a[1];
      const len2 = ex*ex + ey*ey;
      let u = len2 > 1e-18 ? ((uv[0]-a[0])*ex + (uv[1]-a[1])*ey) / len2 : 0;
      u = Math.max(0, Math.min(1, u));
      const d = Math.hypot(uv[0] - (a[0]+ex*u), uv[1] - (a[1]+ey*u));
      if (d < bestD) { bestD = d; bestR = Rs[i] + (Rs[(i+1)%n] - Rs[i]) * u; }
    }
    return capPlane + intoBody * bestR;
  };
  const dropTo = (p3) => { const q = p3.slice(); q[axisIdx] = depthOf(flat2(p3)); return q; };
  const splitTol = 1e-3;
  const capEdgeChain = (A, B) => {
    const ax = A[other[0]], ay = A[other[1]];
    const ex = B[other[0]] - ax, ey = B[other[1]] - ay;
    const len2 = ex*ex + ey*ey;
    if (!(len2 > 1e-18)) return [A, B];
    const inv = 1 / Math.sqrt(len2);
    const mids = [];
    for (let i = 0; i < n; i++) {
      const px = poly2d[i][0] - ax, py = poly2d[i][1] - ay;
      const u = (px*ex + py*ey) / len2;
      if (u <= 1e-6 || u >= 1-1e-6) continue;
      if (Math.abs(px*ey - py*ex) * inv > splitTol) continue;
      const q = [0,0,0];
      q[other[0]] = ax + ex*u;
      q[other[1]] = ay + ey*u;
      q[axisIdx] = capPlane;
      mids.push({ u, q });
    }
    if (!mids.length) return [A, B];
    mids.sort((x, y) => x.u - y.u);
    const chain = [A];
    const near = (p, q) => Math.hypot(p[other[0]]-q[other[0]], p[other[1]]-q[other[1]]) < 1e-9;
    for (const md of mids) if (!near(md.q, chain[chain.length-1])) chain.push(md.q);
    if (!near(B, chain[chain.length-1])) chain.push(B);
    return chain;
  };
  const pushTri = (a, b, c) => {
    const ux=b[0]-a[0], uy=b[1]-a[1], uz=b[2]-a[2];
    const vx=c[0]-a[0], vy=c[1]-a[1], vz=c[2]-a[2];
    const nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx;
    if (0.5*Math.hypot(nx,ny,nz) < 1e-12) return;
    out.push(a[0],a[1],a[2], b[0],b[1],b[2], c[0],c[1],c[2]);
  };
  for (const t of wallTriIdx) {
    const tri = [vert(t,0), vert(t,1), vert(t,2)];
    let capEdge = -1;
    for (let v = 0; v < 3; v++) if (isOnCap(tri[v]) && isOnCap(tri[(v+1)%3])) { capEdge = v; break; }
    if (capEdge < 0) {
      let moved = false;
      for (let v = 0; v < 3; v++) {
        if (!isOnCap(tri[v])) continue;
        const q = dropTo(tri[v]);
        if (q[axisIdx] !== tri[v][axisIdx]) moved = true;
        tri[v] = q;
      }
      // Every wall triangle the input had is kept, area test and all. The
      // split leaves zero-area seam triangles behind that bridge a T-junction
      // on the piece's OTHER face; drop one and the edge it bridged is left
      // odd. Only triangles this pass invents are area tested.
      out.push(tri[0][0],tri[0][1],tri[0][2], tri[1][0],tri[1][1],tri[1][2], tri[2][0],tri[2][1],tri[2][2]);
      continue;
    }
    const A = tri[capEdge], B = tri[(capEdge+1)%3], C = tri[(capEdge+2)%3];
    const rawChain = capEdgeChain(A, B);
    const chain = rawChain.map(dropTo);
    const Cp = isOnCap(C) ? dropTo(C) : C;
    if (rawChain.length === 2) {
      out.push(chain[0][0],chain[0][1],chain[0][2], chain[1][0],chain[1][1],chain[1][2], Cp[0],Cp[1],Cp[2]);
      continue;
    }
    for (let k = 0; k + 1 < chain.length; k++) pushTri(chain[k], chain[k+1], Cp);
  }

  // ---------- band ----------
  const same = (p, q) => Math.hypot(p[0]-q[0], p[1]-q[1], p[2]-q[2]) < 1e-9;
  const pushBand = (A, B, C) => {
    if (same(A,B) || same(B,C) || same(C,A)) return;
    out.push(A[0],A[1],A[2], B[0],B[1],B[2], C[0],C[1],C[2]);
  };
  for (let s = 0; s < STEPS; s++) {
    const a = rings[s], b = rings[s+1];
    for (let i = 0; i < n; i++) {
      const i1 = (i+1)%n;
      const A0=a[i], A1=a[i1], B0=b[i], B1=b[i1];
      if (s === STEPS-1 && ringSplits.has(i) && !same(B0, B1)) {
        const P = ringTop2[i], Q = ringTop2[i1];
        const chain = [B0];
        for (const u of ringSplits.get(i).slice().sort((x,y)=>x-y)) {
          chain.push(from3([P[0] + (Q[0]-P[0])*u, P[1] + (Q[1]-P[1])*u], capPlane));
        }
        chain.push(B1);
        pushBand(A0, A1, chain[chain.length-1]);
        for (let k = chain.length-1; k > 0; k--) pushBand(A0, chain[k], chain[k-1]);
        continue;
      }
      pushBand(A0, A1, B1);
      pushBand(A0, B1, B0);
    }
  }

  if (out.length < 9) throw new Error('perimeter fillet produced no geometry');
  rawPerimeterFilletInPlace.lastBuild = {
    mode: chamfer ? 'bevel' : 'fillet',
    loopPts: n,
    radius: peakR,
    requested: requestedR
  };
  return new Float32Array(out);
}
// Corners, vertex only. Restored verbatim from the corners6 bake, which is
// what this mode has always been: a spherical octant at each vertex of the
// clicked face and nothing else. Radius Rc*sqrt(2) centred Rc in from all
// three planes, so the cut circle on the face and on both walls is exactly
// Rc. Mid-edges stay a knife, there is no edge cylinder and no shelf.
//
// Corners+edges is the other engine, rawVertexBallCorners below, and the two
// do not share code on purpose: this one must not drift when that one moves.
function rawVertexBallOnly(rawTris, axisIdx, keepMin, requestedR, opts) {
  opts = opts || {};
  const minTurn = (opts.minTurnDeg == null ? 25 : opts.minTurnDeg) * Math.PI / 180;
  const ARCN = 12;                       // samples per boundary arc
  const PATCHN = 6;                      // subdivision across the patch
  const SQUARE_TOL = 12 * Math.PI / 180; // how far from 90deg a corner may be
  const intoBody = keepMin ? 1 : -1;
  const other = [0, 1, 2].filter(a => a !== axisIdx);
  const tol = 1e-4;

  let minV = Infinity, maxV = -Infinity;
  for (let i = axisIdx; i < rawTris.length; i += 3) {
    if (rawTris[i] < minV) minV = rawTris[i];
    if (rawTris[i] > maxV) maxV = rawTris[i];
  }
  const capPlane = keepMin ? minV : maxV;
  const capTol = 1e-3;

  const triCount = rawTris.length / 9;
  const vert = (t, v) => { const i0 = t*9 + v*3; return [rawTris[i0], rawTris[i0+1], rawTris[i0+2]]; };
  const isOnCap = (p) => Math.abs(p[axisIdx] - capPlane) < capTol;
  const flat2 = (p3) => [p3[other[0]], p3[other[1]]];
  const from3 = (uv, along) => { const p=[0,0,0]; p[other[0]]=uv[0]; p[other[1]]=uv[1]; p[axisIdx]=along; return p; };

  const capTriIdx = [], wallTriIdx = [];
  for (let t = 0; t < triCount; t++) {
    const v0=vert(t,0), v1=vert(t,1), v2=vert(t,2);
    if (isOnCap(v0) && isOnCap(v1) && isOnCap(v2)) capTriIdx.push(t);
    else wallTriIdx.push(t);
  }
  if (!capTriIdx.length) throw new Error('no cap found on this face');

  // ---- the clicked face's boundary loop ----
  const vkey = (p) => Math.round(p[0]/tol)+'|'+Math.round(p[1]/tol)+'|'+Math.round(p[2]/tol);
  const edgeMap = new Map();
  const addEdge = (a, b, isCap) => {
    const ka = vkey(a), kb = vkey(b);
    const ek = ka < kb ? ka+'~'+kb : kb+'~'+ka;
    if (!edgeMap.has(ek)) edgeMap.set(ek, []);
    edgeMap.get(ek).push({ isCap, a, b });
  };
  for (const t of capTriIdx) {
    const v0=vert(t,0), v1=vert(t,1), v2=vert(t,2);
    addEdge(v0,v1,true); addEdge(v1,v2,true); addEdge(v2,v0,true);
  }
  for (const t of wallTriIdx) {
    const v0=vert(t,0), v1=vert(t,1), v2=vert(t,2);
    if (isOnCap(v0) && isOnCap(v1)) addEdge(v0,v1,false);
    if (isOnCap(v1) && isOnCap(v2)) addEdge(v1,v2,false);
    if (isOnCap(v2) && isOnCap(v0)) addEdge(v2,v0,false);
  }
  const boundaryEdges = [];
  for (const entries of edgeMap.values()) {
    if (entries.length === 2 && entries.some(e=>e.isCap) && entries.some(e=>!e.isCap)) {
      const capEntry = entries.find(e => e.isCap);
      boundaryEdges.push([capEntry.a, capEntry.b]);
    }
  }
  if (!boundaryEdges.length) throw new Error('no cap/wall boundary found');
  const adj = new Map(), posOf = new Map();
  const pushAdj = (k, o) => { if (!adj.has(k)) adj.set(k, []); adj.get(k).push(o); };
  for (const [a,b] of boundaryEdges) {
    const ka = vkey(a), kb = vkey(b);
    posOf.set(ka,a); posOf.set(kb,b);
    pushAdj(ka,kb); pushAdj(kb,ka);
  }
  for (const list of adj.values()) if (list.length !== 2) throw new Error('branch point in cap boundary');
  const startKey = vkey(boundaryEdges[0][0]);
  const loopKeys = [startKey];
  let prevKey = null, curKey = startKey;
  do {
    const nbrs = adj.get(curKey);
    const nextKey = nbrs[0] === prevKey ? nbrs[1] : nbrs[0];
    if (nextKey === startKey) break;
    loopKeys.push(nextKey);
    prevKey = curKey; curKey = nextKey;
    if (loopKeys.length > adj.size + 2) throw new Error('cap boundary did not close');
  } while (true);
  const loop3d = loopKeys.map(k => posOf.get(k));
  if (loop3d.length < 3) throw new Error('cap boundary too small for corners');
  let poly = loop3d.map(flat2);
  poly = raw2DWeldLoop(poly, 0.08);
  const nL = poly.length;
  if (nL < 3) throw new Error('cap boundary too small after weld');

  let area2 = 0;
  for (let i = 0; i < nL; i++) { const a=poly[i], b=poly[(i+1)%nL]; area2 += a[0]*b[1]-b[0]*a[1]; }
  const wind = area2 >= 0 ? 1 : -1;

  // ---- corners of that loop ----
  const seg = new Array(nL), cum = new Array(nL+1);
  cum[0] = 0;
  for (let i = 0; i < nL; i++) {
    const a = poly[i], b = poly[(i+1)%nL];
    seg[i] = Math.hypot(b[0]-a[0], b[1]-a[1]);
    cum[i+1] = cum[i] + seg[i];
  }
  const total = cum[nL];
  if (!(total > 1e-6)) throw new Error('cap boundary has no length');
  const atArc = (s) => {
    let x = s % total; if (x < 0) x += total;
    let lo = 0, hi = nL;
    while (lo + 1 < hi) { const mid = (lo+hi)>>1; if (cum[mid] <= x) lo = mid; else hi = mid; }
    const u = seg[lo] > 1e-12 ? (x - cum[lo]) / seg[lo] : 0;
    const a = poly[lo], b = poly[(lo+1)%nL];
    return [a[0] + (b[0]-a[0])*u, a[1] + (b[1]-a[1])*u];
  };
  const win = Math.max(total/200, 0.25, Math.min(requestedR*1.5, total/16));
  const turn = new Array(nL);
  for (let i = 0; i < nL; i++) {
    const back = atArc(cum[i]-win), fwd = atArc(cum[i]+win);
    const a1 = Math.atan2(poly[i][1]-back[1], poly[i][0]-back[0]);
    const a2 = Math.atan2(fwd[1]-poly[i][1], fwd[0]-poly[i][0]);
    let d = a2 - a1;
    while (d > Math.PI) d -= 2*Math.PI;
    while (d < -Math.PI) d += 2*Math.PI;
    turn[i] = d;
  }
  const hot = [];
  for (let i = 0; i < nL; i++) if (Math.abs(turn[i]) > minTurn) hot.push(i);
  if (!hot.length) throw new Error('no corners over ' + Math.round(minTurn*180/Math.PI) + 'deg on this face');
  const groups = [];
  let cur = [hot[0]];
  for (let q = 1; q < hot.length; q++) {
    if (cum[hot[q]] - cum[hot[q-1]] <= win) cur.push(hot[q]);
    else { groups.push(cur); cur = [hot[q]]; }
  }
  groups.push(cur);
  if (groups.length > 1) {
    const f = groups[0], l = groups[groups.length-1];
    if (total - cum[l[l.length-1]] + cum[f[0]] <= win) { groups[0] = l.concat(f); groups.pop(); }
  }
  const apex = groups.map(g => g.reduce((best,i) => Math.abs(turn[i]) > Math.abs(turn[best]) ? i : best, g[0]));
  const cornerCount = apex.length;

  const COLL = Math.cos(3 * Math.PI / 180);
  const runFrom = (i, dir) => {
    let j = i, run = 0, d0 = null, guard = 0;
    while (guard++ < nL) {
      const k = dir < 0 ? (j-1+nL)%nL : (j+1)%nL;
      const a = dir < 0 ? poly[k] : poly[j], b = dir < 0 ? poly[j] : poly[k];
      const L = Math.hypot(b[0]-a[0], b[1]-a[1]);
      if (L > 1e-9) {
        const d = [(b[0]-a[0])/L, (b[1]-a[1])/L];
        if (d0 === null) d0 = d;
        else if (d0[0]*d[0] + d0[1]*d[1] < COLL) break;
        run += L;
      }
      j = k;
      if (j === i) break;
    }
    return { d: d0, run: run };
  };
  const wallLimitAt = (i) => {
    const curr = poly[i];
    const prev = poly[(i-1+nL)%nL], next = poly[(i+1)%nL];
    const nn = rawEdgeInwardNormal2(prev, next);
    let best = Infinity;
    for (let j = 0; j < nL; j++) {
      if (j === i || j === (i-1+nL)%nL) continue;
      const a = poly[j], b = poly[(j+1)%nL];
      const dx = b[0]-a[0], dy = b[1]-a[1];
      const den = nn[0]*dy - nn[1]*dx;
      if (Math.abs(den) < 1e-10) continue;
      const t = ((a[0]-curr[0])*dy - (a[1]-curr[1])*dx) / den;
      const u = ((a[0]-curr[0])*nn[1] - (a[1]-curr[1])*nn[0]) / -den;
      if (t > 0.1 && t < best && u >= -0.05 && u <= 1.05) best = t;
    }
    for (let j = 0; j < nL; j++) {
      if (j === i || j === (i-1+nL)%nL || j === (i+1)%nL) continue;
      const d = Math.hypot(poly[j][0]-curr[0], poly[j][1]-curr[1]);
      if (d < best) best = d;
    }
    return best === Infinity ? 4 : best;
  };
  const gapFwd = (t) => {
    if (cornerCount === 1) return total;
    let g = cum[apex[(t+1)%cornerCount]] - cum[apex[t]];
    if (g <= 0) g += total;
    return g;
  };

  // ---- one ball per usable vertex ----
  const depth = (r) => capPlane + intoBody * r;
  // A wall is only a wall if the mesh actually has one. Once another face has
  // been softened, one of this face's boundary edges can back onto that face's
  // fillet band instead of a flat plane - there is nothing there to cut, and
  // cutting anyway punches a hole nothing closes. Corners whose walls are not
  // both really there are skipped and left sharp, same as a non-square one.
  const wallPlanes = new Map();
  for (const t of wallTriIdx) {
    const v0 = vert(t,0), v1 = vert(t,1), v2 = vert(t,2);
    const ax = v1[0]-v0[0], ay = v1[1]-v0[1], az = v1[2]-v0[2];
    const bx = v2[0]-v0[0], by = v2[1]-v0[1], bz = v2[2]-v0[2];
    let nx = ay*bz-az*by, ny = az*bx-ax*bz, nz = ax*by-ay*bx;
    const L = Math.hypot(nx, ny, nz);
    if (!(L > 1e-12)) continue;
    nx /= L; ny /= L; nz /= L;
    const d = nx*v0[0] + ny*v0[1] + nz*v0[2];
    const k = Math.round(nx*1e3)+','+Math.round(ny*1e3)+','+Math.round(nz*1e3)+'|'+Math.round(d*1e3);
    if (!wallPlanes.has(k)) wallPlanes.set(k, []);
    wallPlanes.get(k).push([v0, v1, v2]);
  }
  const wallThere = (out2d, V2at, reach) => {
    const n3 = [0,0,0]; n3[other[0]] = out2d[0]; n3[other[1]] = out2d[1];
    const V3at = from3(V2at, capPlane);
    const d = n3[0]*V3at[0] + n3[1]*V3at[1] + n3[2]*V3at[2];
    for (const sgn of [1, -1]) {
      const k = Math.round(sgn*n3[0]*1e3)+','+Math.round(sgn*n3[1]*1e3)+','+Math.round(sgn*n3[2]*1e3)+'|'+Math.round(sgn*d*1e3);
      const tris = wallPlanes.get(k);
      if (!tris) continue;
      for (const tr of tris) {
        for (const p of tr) {
          if (Math.hypot(p[0]-V3at[0], p[1]-V3at[1], p[2]-V3at[2]) <= reach) return true;
        }
      }
    }
    return false;
  };

  const balls = [];
  let skipped = 0;
  for (let t = 0; t < cornerCount; t++) {
    const ai = apex[t];
    if (turn[ai] * wind <= 0) { skipped++; continue; }
    const back = runFrom(ai, -1), fwd = runFrom(ai, +1);
    if (!back.d || !fwd.d) { skipped++; continue; }
    const dIn = back.d, dOut = fwd.d;
    const ext = Math.atan2(dIn[0]*dOut[1]-dIn[1]*dOut[0], dIn[0]*dOut[0]+dIn[1]*dOut[1]);
    if (ext * wind <= 0) { skipped++; continue; }
    const theta = Math.PI - Math.abs(ext);
    // Square vertices only: the ball's three cut circles all come out at Rc
    // because C sits at Rc from all three planes, and the wall arcs only
    // reach the wall edge when the face corner is a right angle.
    if (Math.abs(theta - Math.PI/2) > SQUARE_TOL) { skipped++; continue; }
    let Rc = Math.min(requestedR, Math.max(0, wallLimitAt(ai) * 0.45));
    const room = Math.min(back.run, fwd.run, gapFwd((t-1+cornerCount)%cornerCount), gapFwd(t));
    Rc = Math.min(Rc, room * 0.45);
    if (!(Rc > 0.02)) { skipped++; continue; }

    // In-face frame at the vertex: u1 out along one edge, u2 along the other.
    const u1 = [-dIn[0], -dIn[1]], u2 = [dOut[0], dOut[1]];
    const V2 = poly[ai];
    const n1 = [-u1[1]*wind*-1, u1[0]*wind*-1];   // inward normal of the u1 edge
    const n2 = [-u2[1]*wind, u2[0]*wind];         // inward normal of the u2 edge
    if (!wallThere([-n1[0], -n1[1]], V2, Rc * 4) ||
        !wallThere([-n2[0], -n2[1]], V2, Rc * 4)) { skipped++; continue; }
    const M = [V2[0] + (n1[0]+n2[0])*Rc, V2[1] + (n1[1]+n2[1])*Rc];
    balls.push({
      ai: ai, Rc: Rc, V2: V2, u1: u1, u2: u2, n1: n1, n2: n2, M: M,
      T1: [V2[0] + u1[0]*Rc, V2[1] + u1[1]*Rc],
      T2: [V2[0] + u2[0]*Rc, V2[1] + u2[1]*Rc]
    });
  }
  if (!balls.length) {
    // Distinguish "cannot" from "already done": on a repeat pass over a piece
    // whose faces have been softened already, every corner of this face can be
    // rounded by an earlier face's bake. The caller decides which it is.
    const e = new Error('no square vertex takes R=' + requestedR + ' on this face');
    e.softenSkippable = true;
    throw e;
  }

  // ---- shared geometry per vertex ----
  const axisIn = [0,0,0]; axisIn[axisIdx] = intoBody;
  const lift = (uv) => from3(uv, capPlane);
  const N = ARCN;
  const arcPts = (cx, cy, ax, ay, bx, by) => {
    const a0 = Math.atan2(ay-cy, ax-cx);
    let d = Math.atan2(by-cy, bx-cx) - a0;
    while (d > Math.PI) d -= 2*Math.PI;
    while (d < -Math.PI) d += 2*Math.PI;
    const r = Math.hypot(ax-cx, ay-cy);
    const out = [];
    for (let q = 0; q <= N; q++) {
      const an = a0 + d*(q/N);
      out.push([cx + r*Math.cos(an), cy + r*Math.sin(an)]);
    }
    return out;
  };
  for (const b of balls) {
    const Rc = b.Rc;
    b.C3 = from3(b.M, depth(Rc));
    b.Rs = Rc * Math.SQRT2;
    b.V3 = lift(b.V2);
    b.T1_3 = lift(b.T1);
    b.T2_3 = lift(b.T2);
    b.P3_3 = [b.V3[0] + axisIn[0]*Rc, b.V3[1] + axisIn[1]*Rc, b.V3[2] + axisIn[2]*Rc];
    // face arc, in the face's own 2D
    b.capArc2 = arcPts(b.M[0], b.M[1], b.T1[0], b.T1[1], b.T2[0], b.T2[1]);
    b.capArc3 = b.capArc2.map(lift);
    // the two wall planes, each as (origin, u, v) with v = into the body
    b.walls = [
      { u2: b.u1, out2: [-b.n1[0], -b.n1[1]], from: b.T1_3 },
      { u2: b.u2, out2: [-b.n2[0], -b.n2[1]], from: b.T2_3 }
    ];
    for (const w of b.walls) {
      w.u3 = [0,0,0]; w.u3[other[0]] = w.u2[0]; w.u3[other[1]] = w.u2[1];
      w.n3 = [0,0,0]; w.n3[other[0]] = w.out2[0]; w.n3[other[1]] = w.out2[1];
      w.org = b.V3;
      w.to2 = (p) => {
        const dx = p[0]-w.org[0], dy = p[1]-w.org[1], dz = p[2]-w.org[2];
        return [dx*w.u3[0] + dy*w.u3[1] + dz*w.u3[2],
                dx*axisIn[0] + dy*axisIn[1] + dz*axisIn[2]];
      };
      w.to3 = (uv) => [w.org[0] + w.u3[0]*uv[0] + axisIn[0]*uv[1],
                       w.org[1] + w.u3[1]*uv[0] + axisIn[1]*uv[1],
                       w.org[2] + w.u3[2]*uv[0] + axisIn[2]*uv[1]];
      w.M2 = [Rc, Rc];
      w.arc2 = arcPts(Rc, Rc, Rc, 0, 0, Rc);   // tangent on the face -> tangent down the wall edge
      w.arc3 = w.arc2.map(w.to3);
      w.planeD = w.n3[0]*w.org[0] + w.n3[1]*w.org[1] + w.n3[2]*w.org[2];
    }
  }

  // ---- trim one plane's triangles by the corner sectors that bite it ----
  const polyArea = (p) => {
    let a = 0;
    for (let i = 0; i < p.length; i++) { const q=p[i], r=p[(i+1)%p.length]; a += q[0]*r[1]-r[0]*q[1]; }
    return Math.abs(a)*0.5;
  };
  const clipHalf = (p, px, py, nx, ny) => {
    if (p.length < 3) return [];
    const res = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i+1)%p.length];
      const da = (a[0]-px)*nx + (a[1]-py)*ny;
      const db = (b[0]-px)*nx + (b[1]-py)*ny;
      if (da >= -1e-12) res.push(a);
      if ((da > 1e-12 && db < -1e-12) || (da < -1e-12 && db > 1e-12)) {
        const u = da/(da-db);
        res.push([a[0]+(b[0]-a[0])*u, a[1]+(b[1]-a[1])*u]);
      }
    }
    const cl = [];
    for (const q of res) {
      const last = cl[cl.length-1];
      if (!last || Math.hypot(q[0]-last[0], q[1]-last[1]) > 1e-9) cl.push(q);
    }
    while (cl.length > 1 && Math.hypot(cl[0][0]-cl[cl.length-1][0], cl[0][1]-cl[cl.length-1][1]) < 1e-9) cl.pop();
    return cl.length >= 3 ? cl : [];
  };
  // keep = outside the sector, or inside it and inside the arc. Every slice
  // convex, so a triangle can never explode into slivers.
  const cutByArc = (pieces, C2, arc) => {
    const uIn = [arc[0][0]-C2[0], arc[0][1]-C2[1]];
    const uOut = [arc[arc.length-1][0]-C2[0], arc[arc.length-1][1]-C2[1]];
    const li = Math.hypot(uIn[0],uIn[1])||1e-9, lo = Math.hypot(uOut[0],uOut[1])||1e-9;
    const a = [uIn[0]/li, uIn[1]/li], b = [uOut[0]/lo, uOut[1]/lo];
    const rot = (a[0]*b[1]-a[1]*b[0]) >= 0 ? 1 : -1;
    const inN = [-a[1]*rot, a[0]*rot];
    const outN = [b[1]*rot, -b[0]*rot];
    const next = [];
    for (const p of pieces) {
      const before = clipHalf(p, C2[0], C2[1], -inN[0], -inN[1]);
      if (before.length) next.push(before);
      const side = clipHalf(p, C2[0], C2[1], inN[0], inN[1]);
      if (!side.length) continue;
      const after = clipHalf(side, C2[0], C2[1], -outN[0], -outN[1]);
      if (after.length) next.push(after);
      let core = clipHalf(side, C2[0], C2[1], outN[0], outN[1]);
      for (let k = 0; core.length && k+1 < arc.length; k++) {
        const P = arc[k], Q = arc[k+1];
        let nx = -(Q[1]-P[1]), ny = Q[0]-P[0];
        if ((C2[0]-P[0])*nx + (C2[1]-P[1])*ny < 0) { nx = -nx; ny = -ny; }
        core = clipHalf(core, P[0], P[1], nx, ny);
      }
      if (core.length) next.push(core);
    }
    return next;
  };
  // Split every piece edge at any point of this plane that lies on it, then
  // fan from a vertex that leaves no degenerate triangle - and if there is
  // none, ear clip and KEEP the zero-area triangles, which carry the boundary.
  const emitPlane = (pieces, extraPts, to3, wantOut) => {
    const cpts = [], seen = new Set();
    const addC = (q) => {
      const k = Math.round(q[0]*1e4)+'|'+Math.round(q[1]*1e4);
      if (seen.has(k)) return;
      seen.add(k); cpts.push(q);
    };
    for (const p of pieces) for (const v of p) addC(v);
    for (const q of extraPts) addC(q);
    for (let idx = 0; idx < pieces.length; idx++) {
      const p = pieces[idx], grown = [];
      for (let i = 0; i < p.length; i++) {
        const a = p[i], b = p[(i+1)%p.length];
        grown.push(a);
        const ex = b[0]-a[0], ey = b[1]-a[1], len2 = ex*ex+ey*ey;
        if (!(len2 > 1e-18)) continue;
        const inv = 1/Math.sqrt(len2);
        const mids = [];
        for (const q of cpts) {
          const u = ((q[0]-a[0])*ex + (q[1]-a[1])*ey)/len2;
          if (u <= 1e-6 || u >= 1-1e-6) continue;
          if (Math.abs((q[0]-a[0])*ey - (q[1]-a[1])*ex)*inv > 1e-6) continue;
          mids.push({u:u, q:q});
        }
        mids.sort((x,y) => x.u - y.u);
        for (const m of mids) grown.push(m.q);
      }
      pieces[idx] = grown;
    }
    const put = (A, B, C) => {
      const a = to3(A), b = to3(B), c = to3(C);
      const ux=b[0]-a[0], uy=b[1]-a[1], uz=b[2]-a[2];
      const vx=c[0]-a[0], vy=c[1]-a[1], vz=c[2]-a[2];
      const nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx;
      if (nx*wantOut[0] + ny*wantOut[1] + nz*wantOut[2] < 0)
        out.push(a[0],a[1],a[2], c[0],c[1],c[2], b[0],b[1],b[2]);
      else
        out.push(a[0],a[1],a[2], b[0],b[1],b[2], c[0],c[1],c[2]);
    };
    for (const p of pieces) {
      const m = p.length;
      let apexAt = -1;
      for (let a = 0; a < m && apexAt < 0; a++) {
        let clean = true;
        for (let k = 1; k+1 < m && clean; k++) {
          const P0=p[a], P1=p[(a+k)%m], P2=p[(a+k+1)%m];
          const cr = (P1[0]-P0[0])*(P2[1]-P0[1]) - (P1[1]-P0[1])*(P2[0]-P0[0]);
          if (Math.abs(cr)*0.5 < 1e-12) clean = false;
        }
        if (clean) apexAt = a;
      }
      if (apexAt < 0) {
        for (const t of rawEarClip2D(p)) put(p[t[0]], p[t[1]], p[t[2]]);
        continue;
      }
      for (let k = 1; k+1 < m; k++) put(p[apexAt], p[(apexAt+k)%m], p[(apexAt+k+1)%m]);
    }
  };

  const out = [];

  // ---- the clicked face ----
  {
    let pieces = capTriIdx.map(t => [flat2(vert(t,0)), flat2(vert(t,1)), flat2(vert(t,2))]);
    let before = 0;
    for (const p of pieces) before += polyArea(p);
    for (const b of balls) pieces = cutByArc(pieces, b.M, b.capArc2);
    let after = 0;
    for (const p of pieces) after += polyArea(p);
    let bite = 0;
    for (const b of balls) {
      // corner square minus the quarter disc
      bite += b.Rc*b.Rc - Math.PI*b.Rc*b.Rc/4;
    }
    if (Math.abs((before - bite) - after) > Math.max(1e-4, before*2e-3)) {
      throw new Error('vertex ball took the wrong bite out of the face - left unchanged');
    }
    const extra = [];
    for (const b of balls) for (const q of b.capArc2) extra.push(q);
    for (const v of poly) extra.push(v);
    const wantOut = [0,0,0]; wantOut[axisIdx] = -intoBody;
    emitPlane(pieces, extra, (uv) => from3(uv, capPlane), wantOut);
  }

  // ---- the two walls at each vertex ----
  const wallJobs = new Map();
  for (const b of balls) {
    for (const w of b.walls) {
      const key = w.n3.map(x => Math.round(x*1e3)).join(',') + '|' + Math.round(w.planeD*1e3);
      if (!wallJobs.has(key)) wallJobs.set(key, { w: w, cuts: [] });
      wallJobs.get(key).cuts.push({ C2: w.M2map ? w.M2map : null, w: w });
    }
  }
  const onPlane = (p, n3, d) => Math.abs(p[0]*n3[0] + p[1]*n3[1] + p[2]*n3[2] - d) < 1e-3;
  const usedWallTri = new Set();
  for (const job of wallJobs.values()) {
    const w0 = job.w;
    const mine = [];
    for (const t of wallTriIdx) {
      const v0=vert(t,0), v1=vert(t,1), v2=vert(t,2);
      if (onPlane(v0, w0.n3, w0.planeD) && onPlane(v1, w0.n3, w0.planeD) && onPlane(v2, w0.n3, w0.planeD)) {
        mine.push(t);
        usedWallTri.add(t);
      }
    }
    if (!mine.length) continue;
    // every cut that lands on THIS plane, expressed in this plane's frame
    const cuts = [];
    for (const b of balls) {
      for (const w of b.walls) {
        const key = w.n3.map(x => Math.round(x*1e3)).join(',') + '|' + Math.round(w.planeD*1e3);
        const k0 = w0.n3.map(x => Math.round(x*1e3)).join(',') + '|' + Math.round(w0.planeD*1e3);
        if (key !== k0) continue;
        cuts.push({ C2: w0.to2(w.to3(w.M2)), arc: w.arc3.map(w0.to2) });
      }
    }
    let pieces = mine.map(t => [w0.to2(vert(t,0)), w0.to2(vert(t,1)), w0.to2(vert(t,2))]);
    let before = 0;
    for (const p of pieces) before += polyArea(p);
    for (const c of cuts) pieces = cutByArc(pieces, c.C2, c.arc);
    let after = 0;
    for (const p of pieces) after += polyArea(p);
    let bite = 0;
    for (const b of balls) {
      for (const w of b.walls) {
        const key = w.n3.map(x => Math.round(x*1e3)).join(',') + '|' + Math.round(w.planeD*1e3);
        const k0 = w0.n3.map(x => Math.round(x*1e3)).join(',') + '|' + Math.round(w0.planeD*1e3);
        if (key === k0) bite += b.Rc*b.Rc - Math.PI*b.Rc*b.Rc/4;
      }
    }
    if (Math.abs((before - bite) - after) > Math.max(1e-4, before*2e-3)) {
      throw new Error('vertex ball took the wrong bite out of a wall - left unchanged');
    }
    const extra = [];
    for (const c of cuts) for (const q of c.arc) extra.push(q);
    emitPlane(pieces, extra, w0.to3, w0.n3);
  }
  for (const t of wallTriIdx) {
    if (usedWallTri.has(t)) continue;
    const a = vert(t,0), b = vert(t,1), c = vert(t,2);
    out.push(a[0],a[1],a[2], b[0],b[1],b[2], c[0],c[1],c[2]);
  }

  // ---- the ball patch at each vertex ----
  // A spherical triangle on the three shared arcs: interior points are
  // barycentric on the three corner directions and projected onto the sphere,
  // the three boundary rows ARE the arcs, so the patch and the three flat
  // faces meet on exactly the same points.
  let patchTris = 0;
  for (const b of balls) {
    const C3 = b.C3, Rs = b.Rs;
    const dirOf = (p) => {
      const d = [p[0]-C3[0], p[1]-C3[1], p[2]-C3[2]];
      const l = Math.hypot(d[0],d[1],d[2]) || 1e-9;
      return [d[0]/l, d[1]/l, d[2]/l];
    };
    // The patch lives on the sphere AND inside all three planes: every
    // direction has component <= Rc/Rs = 1/sqrt(2) on each outward normal, and
    // that is exactly where the three boundary arcs are. A barycentric mix of
    // the corner directions does not respect that - normalising pushes it past
    // a plane and the ball pokes out through the face, 0.17mm on a 20mm cube
    // at R=2. Anything over is put back on the plane it crossed, still on the
    // sphere.
    // A hair inside the plane, not exactly on it: clamping onto the boundary
    // lands interior grid points on top of the arc points and the seam picks
    // up edges shared by more than two triangles.
    const LIM = (1 / Math.SQRT2) * (1 - 2e-3);
    const nrm3 = [[0,0,0], b.walls[0].n3, b.walls[1].n3];
    nrm3[0][axisIdx] = -intoBody;
    const clampInside = (d) => {
      for (let pass = 0; pass < 3; pass++) {
        let worst = -1, wc = LIM;
        for (let q = 0; q < 3; q++) {
          const c = d[0]*nrm3[q][0] + d[1]*nrm3[q][1] + d[2]*nrm3[q][2];
          if (c > wc) { wc = c; worst = q; }
        }
        if (worst < 0) break;
        const nq = nrm3[worst];
        const c = d[0]*nq[0] + d[1]*nq[1] + d[2]*nq[2];
        const rx = d[0] - c*nq[0], ry = d[1] - c*nq[1], rz = d[2] - c*nq[2];
        const rl = Math.hypot(rx, ry, rz);
        if (!(rl > 1e-9)) break;
        const keep = Math.sqrt(Math.max(0, 1 - LIM*LIM)) / rl;
        d = [rx*keep + LIM*nq[0], ry*keep + LIM*nq[1], rz*keep + LIM*nq[2]];
      }
      return d;
    };
    const eCap = b.capArc3.map(dirOf);                 // T1 -> T2
    const eB   = b.walls[1].arc3.map(dirOf);           // T2 -> P3
    const eA   = b.walls[0].arc3.map(dirOf);           // T1 -> P3
    const grid = [];
    for (let i = 0; i <= N; i++) {
      const row = [];
      for (let j = 0; j <= N - i; j++) {
        const k = N - i - j;
        let d;
        if (k === 0) d = eCap[j];                      // the T1..T2 edge
        else if (j === 0) d = eA[k];                   // the T1..P3 edge
        else if (i === 0) d = eB[k];                   // the T2..P3 edge
        else {
          const x = i*eCap[0][0] + j*eCap[N][0] + k*eA[N][0];
          const y = i*eCap[0][1] + j*eCap[N][1] + k*eA[N][1];
          const z = i*eCap[0][2] + j*eCap[N][2] + k*eA[N][2];
          const l = Math.hypot(x,y,z) || 1e-9;
          d = clampInside([x/l, y/l, z/l]);
        }
        row.push([C3[0]+d[0]*Rs, C3[1]+d[1]*Rs, C3[2]+d[2]*Rs]);
      }
      grid.push(row);
    }
    const put = (A, B, Cc) => {
      const ux=B[0]-A[0], uy=B[1]-A[1], uz=B[2]-A[2];
      const vx=Cc[0]-A[0], vy=Cc[1]-A[1], vz=Cc[2]-A[2];
      const nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx;
      if (0.5*Math.hypot(nx,ny,nz) < 1e-12) return;
      const mx=(A[0]+B[0]+Cc[0])/3 - C3[0], my=(A[1]+B[1]+Cc[1])/3 - C3[1], mz=(A[2]+B[2]+Cc[2])/3 - C3[2];
      if (nx*mx + ny*my + nz*mz < 0) out.push(A[0],A[1],A[2], Cc[0],Cc[1],Cc[2], B[0],B[1],B[2]);
      else out.push(A[0],A[1],A[2], B[0],B[1],B[2], Cc[0],Cc[1],Cc[2]);
      patchTris++;
    };
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N - i; j++) {
        put(grid[i][j], grid[i+1][j], grid[i][j+1]);
        if (j + 1 < N - i) put(grid[i+1][j], grid[i+1][j+1], grid[i][j+1]);
      }
    }
  }

  if (out.length < 9) throw new Error('vertex ball produced no geometry');

  // Global T-junction repair. Each plane is trimmed in its own frame, so a cut
  // that crosses an edge two planes share leaves a vertex on one side and not
  // the other - and the piece's far end, which this pass never touches, ends
  // up with long edges the trimmed walls have split. Split any triangle edge
  // another vertex sits on. One sweep only splits one edge per triangle, so
  // sweep until nothing moves.
  for (let pass = 0; pass < 8; pass++) {
    let splits = 0;
    const q = 1e4;
    const vk = (x, y, z) => Math.round(x*q)+'|'+Math.round(y*q)+'|'+Math.round(z*q);
    const pts = new Map();
    for (let i = 0; i < out.length; i += 3) {
      const k = vk(out[i], out[i+1], out[i+2]);
      if (!pts.has(k)) pts.set(k, [out[i], out[i+1], out[i+2]]);
    }
    const all = [...pts.values()];
    const grid = new Map();
    const CELL = 1.0;
    const cell = (p) => Math.floor(p[0]/CELL)+'|'+Math.floor(p[1]/CELL)+'|'+Math.floor(p[2]/CELL);
    for (const p of all) {
      const k = cell(p);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(p);
    }
    const near = (a, b) => {
      const seen = new Set(), res = [];
      const x0 = Math.floor(Math.min(a[0],b[0])/CELL)-1, x1 = Math.floor(Math.max(a[0],b[0])/CELL)+1;
      const y0 = Math.floor(Math.min(a[1],b[1])/CELL)-1, y1 = Math.floor(Math.max(a[1],b[1])/CELL)+1;
      const z0 = Math.floor(Math.min(a[2],b[2])/CELL)-1, z1 = Math.floor(Math.max(a[2],b[2])/CELL)+1;
      if ((x1-x0)*(y1-y0)*(z1-z0) > 4096) return all;
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
        const g = grid.get(x+'|'+y+'|'+z);
        if (!g) continue;
        for (const p of g) { const k = vk(p[0],p[1],p[2]); if (!seen.has(k)) { seen.add(k); res.push(p); } }
      }
      return res;
    };
    const fixed = [];
    for (let t = 0; t + 8 < out.length; t += 9) {
      const V = [[out[t],out[t+1],out[t+2]], [out[t+3],out[t+4],out[t+5]], [out[t+6],out[t+7],out[t+8]]];
      let split = -1, mids = null;
      for (let e = 0; e < 3; e++) {
        const a = V[e], b = V[(e+1)%3];
        const ex = b[0]-a[0], ey = b[1]-a[1], ez = b[2]-a[2];
        const len2 = ex*ex + ey*ey + ez*ez;
        if (!(len2 > 1e-12)) continue;
        const inv = 1/Math.sqrt(len2);
        const hits = [];
        for (const p of near(a, b)) {
          const u = ((p[0]-a[0])*ex + (p[1]-a[1])*ey + (p[2]-a[2])*ez)/len2;
          if (u <= 1e-6 || u >= 1-1e-6) continue;
          const cx = (p[1]-a[1])*ez - (p[2]-a[2])*ey;
          const cy = (p[2]-a[2])*ex - (p[0]-a[0])*ez;
          const cz = (p[0]-a[0])*ey - (p[1]-a[1])*ex;
          if (Math.hypot(cx,cy,cz)*inv > 1e-4) continue;
          hits.push({ u: u, p: p });
        }
        if (hits.length) { split = e; mids = hits.sort((x,y) => x.u - y.u); break; }
      }
      if (split < 0) {
        fixed.push(V[0][0],V[0][1],V[0][2], V[1][0],V[1][1],V[1][2], V[2][0],V[2][1],V[2][2]);
        continue;
      }
      splits++;
      const A = V[split], B = V[(split+1)%3], C = V[(split+2)%3];
      const chain = [A];
      for (const m of mids) chain.push(m.p);
      chain.push(B);
      for (let k = 0; k + 1 < chain.length; k++) {
        fixed.push(chain[k][0],chain[k][1],chain[k][2],
                   chain[k+1][0],chain[k+1][1],chain[k+1][2],
                   C[0],C[1],C[2]);
      }
    }
    out.length = 0;
    for (const v of fixed) out.push(v);
    if (!splits) break;
  }

  const result = new Float32Array(out);
  rawVertexBallOnly.lastBuild = {
    vertices: balls.length,
    corners: cornerCount,
    skipped: skipped,
    radius: balls.reduce((m, b) => Math.max(m, b.Rc), 0),
    requested: requestedR,
    ballR: balls.reduce((m, b) => Math.max(m, b.Rs), 0),
    patchTris: patchTris
  };
  return result;
}



// ===================== Corners: a ball at the VERTEX =====================
//
// Not a face-loop arc. Each of the clicked face's four corners is a trihedral
// vertex - the face and two walls - and it is cut by a SPHERE tangent to
// nothing and cutting all three:
//
//   C   the sphere centre, the one point at inward distance Rc from all three
//       planes: the face's mitre point at inset Rc, pushed Rc into the body.
//   Rs  the sphere radius, Rc * sqrt(2). That is the radius that makes the
//       circle the sphere cuts in EACH of the three planes come out at exactly
//       Rc: sqrt(Rs^2 - Rc^2) = Rc. Same R on the face and on both walls.
//
// Each of those three circles is tangent to that plane's own two edges, so the
// cut dies exactly at the tangent points and the mid-edges are untouched
// square. The three tangent points - Rc along each face edge and Rc down the
// wall edge - are shared, so the three arcs close into one spherical triangle
// and the patch that fills it is the rounded vertex. Side on, that vertex is a
// ball, not a knife: the old path only ever moved the clicked plane.
//
// The construction needs the vertex to be trihedral and square (a prism's
// corner). A corner that is not is skipped rather than approximated.
function rawVertexBallCorners(rawTris, axisIdx, keepMin, requestedR, opts) {
  opts = opts || {};
  const minTurn = (opts.minTurnDeg == null ? 25 : opts.minTurnDeg) * Math.PI / 180;
  const SQUARE_TOL = 12 * Math.PI / 180; // how far from 90deg a corner may be
  const intoBody = keepMin ? 1 : -1;
  const other = [0, 1, 2].filter(a => a !== axisIdx);
  const tol = 1e-4;

  let minV = Infinity, maxV = -Infinity;
  for (let i = axisIdx; i < rawTris.length; i += 3) {
    if (rawTris[i] < minV) minV = rawTris[i];
    if (rawTris[i] > maxV) maxV = rawTris[i];
  }
  const capPlane = keepMin ? minV : maxV;
  const capTol = 1e-3;

  const triCount = rawTris.length / 9;
  const vert = (t, v) => { const i0 = t*9 + v*3; return [rawTris[i0], rawTris[i0+1], rawTris[i0+2]]; };
  const isOnCap = (p) => Math.abs(p[axisIdx] - capPlane) < capTol;
  const flat2 = (p3) => [p3[other[0]], p3[other[1]]];
  const from3 = (uv, along) => { const p=[0,0,0]; p[other[0]]=uv[0]; p[other[1]]=uv[1]; p[axisIdx]=along; return p; };

  const capTriIdx = [], wallTriIdx = [];
  for (let t = 0; t < triCount; t++) {
    const v0=vert(t,0), v1=vert(t,1), v2=vert(t,2);
    if (isOnCap(v0) && isOnCap(v1) && isOnCap(v2)) capTriIdx.push(t);
    else wallTriIdx.push(t);
  }
  if (!capTriIdx.length) throw new Error('no cap found on this face');

  // ---- the clicked face's boundary loop ----
  const vkey = (p) => Math.round(p[0]/tol)+'|'+Math.round(p[1]/tol)+'|'+Math.round(p[2]/tol);
  const edgeMap = new Map();
  const addEdge = (a, b, isCap) => {
    const ka = vkey(a), kb = vkey(b);
    const ek = ka < kb ? ka+'~'+kb : kb+'~'+ka;
    if (!edgeMap.has(ek)) edgeMap.set(ek, []);
    edgeMap.get(ek).push({ isCap, a, b });
  };
  for (const t of capTriIdx) {
    const v0=vert(t,0), v1=vert(t,1), v2=vert(t,2);
    addEdge(v0,v1,true); addEdge(v1,v2,true); addEdge(v2,v0,true);
  }
  for (const t of wallTriIdx) {
    const v0=vert(t,0), v1=vert(t,1), v2=vert(t,2);
    if (isOnCap(v0) && isOnCap(v1)) addEdge(v0,v1,false);
    if (isOnCap(v1) && isOnCap(v2)) addEdge(v1,v2,false);
    if (isOnCap(v2) && isOnCap(v0)) addEdge(v2,v0,false);
  }
  const boundaryEdges = [];
  for (const entries of edgeMap.values()) {
    if (entries.length === 2 && entries.some(e=>e.isCap) && entries.some(e=>!e.isCap)) {
      const capEntry = entries.find(e => e.isCap);
      boundaryEdges.push([capEntry.a, capEntry.b]);
    }
  }
  if (!boundaryEdges.length) throw new Error('no cap/wall boundary found');
  const adj = new Map(), posOf = new Map();
  const pushAdj = (k, o) => { if (!adj.has(k)) adj.set(k, []); adj.get(k).push(o); };
  for (const [a,b] of boundaryEdges) {
    const ka = vkey(a), kb = vkey(b);
    posOf.set(ka,a); posOf.set(kb,b);
    pushAdj(ka,kb); pushAdj(kb,ka);
  }
  for (const list of adj.values()) if (list.length !== 2) throw new Error('branch point in cap boundary');
  const startKey = vkey(boundaryEdges[0][0]);
  const loopKeys = [startKey];
  let prevKey = null, curKey = startKey;
  do {
    const nbrs = adj.get(curKey);
    const nextKey = nbrs[0] === prevKey ? nbrs[1] : nbrs[0];
    if (nextKey === startKey) break;
    loopKeys.push(nextKey);
    prevKey = curKey; curKey = nextKey;
    if (loopKeys.length > adj.size + 2) throw new Error('cap boundary did not close');
  } while (true);
  const loop3d = loopKeys.map(k => posOf.get(k));
  if (loop3d.length < 3) throw new Error('cap boundary too small for corners');
  let poly = loop3d.map(flat2);
  poly = raw2DWeldLoop(poly, 0.08);
  const nL = poly.length;
  if (nL < 3) throw new Error('cap boundary too small after weld');

  let area2 = 0;
  for (let i = 0; i < nL; i++) { const a=poly[i], b=poly[(i+1)%nL]; area2 += a[0]*b[1]-b[0]*a[1]; }
  const wind = area2 >= 0 ? 1 : -1;

  // ---- corners of that loop ----
  const seg = new Array(nL), cum = new Array(nL+1);
  cum[0] = 0;
  for (let i = 0; i < nL; i++) {
    const a = poly[i], b = poly[(i+1)%nL];
    seg[i] = Math.hypot(b[0]-a[0], b[1]-a[1]);
    cum[i+1] = cum[i] + seg[i];
  }
  const total = cum[nL];
  if (!(total > 1e-6)) throw new Error('cap boundary has no length');
  const atArc = (s) => {
    let x = s % total; if (x < 0) x += total;
    let lo = 0, hi = nL;
    while (lo + 1 < hi) { const mid = (lo+hi)>>1; if (cum[mid] <= x) lo = mid; else hi = mid; }
    const u = seg[lo] > 1e-12 ? (x - cum[lo]) / seg[lo] : 0;
    const a = poly[lo], b = poly[(lo+1)%nL];
    return [a[0] + (b[0]-a[0])*u, a[1] + (b[1]-a[1])*u];
  };
  const win = Math.max(total/200, 0.25, Math.min(requestedR*1.5, total/16));
  const turn = new Array(nL);
  for (let i = 0; i < nL; i++) {
    const back = atArc(cum[i]-win), fwd = atArc(cum[i]+win);
    const a1 = Math.atan2(poly[i][1]-back[1], poly[i][0]-back[0]);
    const a2 = Math.atan2(fwd[1]-poly[i][1], fwd[0]-poly[i][0]);
    let d = a2 - a1;
    while (d > Math.PI) d -= 2*Math.PI;
    while (d < -Math.PI) d += 2*Math.PI;
    turn[i] = d;
  }
  const hot = [];
  for (let i = 0; i < nL; i++) if (Math.abs(turn[i]) > minTurn) hot.push(i);
  if (!hot.length) throw new Error('no corners over ' + Math.round(minTurn*180/Math.PI) + 'deg on this face');
  const groups = [];
  let cur = [hot[0]];
  for (let q = 1; q < hot.length; q++) {
    if (cum[hot[q]] - cum[hot[q-1]] <= win) cur.push(hot[q]);
    else { groups.push(cur); cur = [hot[q]]; }
  }
  groups.push(cur);
  if (groups.length > 1) {
    const f = groups[0], l = groups[groups.length-1];
    if (total - cum[l[l.length-1]] + cum[f[0]] <= win) { groups[0] = l.concat(f); groups.pop(); }
  }
  const apex = groups.map(g => g.reduce((best,i) => Math.abs(turn[i]) > Math.abs(turn[best]) ? i : best, g[0]));
  const cornerCount = apex.length;

  const COLL = Math.cos(3 * Math.PI / 180);
  const runFrom = (i, dir) => {
    let j = i, run = 0, d0 = null, guard = 0;
    while (guard++ < nL) {
      const k = dir < 0 ? (j-1+nL)%nL : (j+1)%nL;
      const a = dir < 0 ? poly[k] : poly[j], b = dir < 0 ? poly[j] : poly[k];
      const L = Math.hypot(b[0]-a[0], b[1]-a[1]);
      if (L > 1e-9) {
        const d = [(b[0]-a[0])/L, (b[1]-a[1])/L];
        if (d0 === null) d0 = d;
        else if (d0[0]*d[0] + d0[1]*d[1] < COLL) break;
        run += L;
      }
      j = k;
      if (j === i) break;
    }
    return { d: d0, run: run };
  };
  const wallLimitAt = (i) => {
    const curr = poly[i];
    const prev = poly[(i-1+nL)%nL], next = poly[(i+1)%nL];
    const nn = rawEdgeInwardNormal2(prev, next);
    let best = Infinity;
    for (let j = 0; j < nL; j++) {
      if (j === i || j === (i-1+nL)%nL) continue;
      const a = poly[j], b = poly[(j+1)%nL];
      const dx = b[0]-a[0], dy = b[1]-a[1];
      const den = nn[0]*dy - nn[1]*dx;
      if (Math.abs(den) < 1e-10) continue;
      const t = ((a[0]-curr[0])*dy - (a[1]-curr[1])*dx) / den;
      const u = ((a[0]-curr[0])*nn[1] - (a[1]-curr[1])*nn[0]) / -den;
      if (t > 0.1 && t < best && u >= -0.05 && u <= 1.05) best = t;
    }
    for (let j = 0; j < nL; j++) {
      if (j === i || j === (i-1+nL)%nL || j === (i+1)%nL) continue;
      const d = Math.hypot(poly[j][0]-curr[0], poly[j][1]-curr[1]);
      if (d < best) best = d;
    }
    return best === Infinity ? 4 : best;
  };
  const gapFwd = (t) => {
    if (cornerCount === 1) return total;
    let g = cum[apex[(t+1)%cornerCount]] - cum[apex[t]];
    if (g <= 0) g += total;
    return g;
  };

  // ---- one ball per usable vertex ----
  const depth = (r) => capPlane + intoBody * r;
  // A wall is only a wall if the mesh actually has one. Once another face has
  // been softened, one of this face's boundary edges can back onto that face's
  // fillet band instead of a flat plane - there is nothing there to cut, and
  // cutting anyway punches a hole nothing closes. Corners whose walls are not
  // both really there are skipped and left sharp, same as a non-square one.
  const wallPlanes = new Map();
  for (const t of wallTriIdx) {
    const v0 = vert(t,0), v1 = vert(t,1), v2 = vert(t,2);
    const ax = v1[0]-v0[0], ay = v1[1]-v0[1], az = v1[2]-v0[2];
    const bx = v2[0]-v0[0], by = v2[1]-v0[1], bz = v2[2]-v0[2];
    let nx = ay*bz-az*by, ny = az*bx-ax*bz, nz = ax*by-ay*bx;
    const L = Math.hypot(nx, ny, nz);
    if (!(L > 1e-12)) continue;
    nx /= L; ny /= L; nz /= L;
    const d = nx*v0[0] + ny*v0[1] + nz*v0[2];
    const k = Math.round(nx*1e3)+','+Math.round(ny*1e3)+','+Math.round(nz*1e3)+'|'+Math.round(d*1e3);
    if (!wallPlanes.has(k)) wallPlanes.set(k, []);
    wallPlanes.get(k).push([v0, v1, v2]);
  }
  const wallThere = (out2d, V2at, reach) => {
    const n3 = [0,0,0]; n3[other[0]] = out2d[0]; n3[other[1]] = out2d[1];
    const V3at = from3(V2at, capPlane);
    const d = n3[0]*V3at[0] + n3[1]*V3at[1] + n3[2]*V3at[2];
    for (const sgn of [1, -1]) {
      const k = Math.round(sgn*n3[0]*1e3)+','+Math.round(sgn*n3[1]*1e3)+','+Math.round(sgn*n3[2]*1e3)+'|'+Math.round(sgn*d*1e3);
      const tris = wallPlanes.get(k);
      if (!tris) continue;
      for (const tr of tris) {
        for (const p of tr) {
          if (Math.hypot(p[0]-V3at[0], p[1]-V3at[1], p[2]-V3at[2]) <= reach) return true;
        }
      }
    }
    return false;
  };

  const balls = [];
  let skipped = 0;
  for (let t = 0; t < cornerCount; t++) {
    const ai = apex[t];
    if (turn[ai] * wind <= 0) { skipped++; continue; }
    const back = runFrom(ai, -1), fwd = runFrom(ai, +1);
    if (!back.d || !fwd.d) { skipped++; continue; }
    const dIn = back.d, dOut = fwd.d;
    const ext = Math.atan2(dIn[0]*dOut[1]-dIn[1]*dOut[0], dIn[0]*dOut[0]+dIn[1]*dOut[1]);
    if (ext * wind <= 0) { skipped++; continue; }
    const theta = Math.PI - Math.abs(ext);
    // Square vertices only: the ball's three cut circles all come out at Rc
    // because C sits at Rc from all three planes, and the wall arcs only
    // reach the wall edge when the face corner is a right angle.
    if (Math.abs(theta - Math.PI/2) > SQUARE_TOL) { skipped++; continue; }
    let Rc = Math.min(requestedR, Math.max(0, wallLimitAt(ai) * 0.45));
    const room = Math.min(back.run, fwd.run, gapFwd((t-1+cornerCount)%cornerCount), gapFwd(t));
    Rc = Math.min(Rc, room * 0.45);
    if (!(Rc > 0.02)) { skipped++; continue; }

    // In-face frame at the vertex: u1 out along one edge, u2 along the other.
    const u1 = [-dIn[0], -dIn[1]], u2 = [dOut[0], dOut[1]];
    const V2 = poly[ai];
    const n1 = [-u1[1]*wind*-1, u1[0]*wind*-1];   // inward normal of the u1 edge
    const n2 = [-u2[1]*wind, u2[0]*wind];         // inward normal of the u2 edge
    if (!wallThere([-n1[0], -n1[1]], V2, Rc * 4) ||
        !wallThere([-n2[0], -n2[1]], V2, Rc * 4)) { skipped++; continue; }
    const M = [V2[0] + (n1[0]+n2[0])*Rc, V2[1] + (n1[1]+n2[1])*Rc];
    balls.push({
      ai: ai, Rc: Rc, V2: V2, u1: u1, u2: u2, n1: n1, n2: n2, M: M,
      T1: [V2[0] + u1[0]*Rc, V2[1] + u1[1]*Rc],
      T2: [V2[0] + u2[0]*Rc, V2[1] + u2[1]*Rc]
    });
  }
  // All four corners, or none. Every band ends on a corner blend at each end,
  // and every blend is bounded by its two bands, so on a closed loop the
  // treated set is either the whole loop or empty - a partial one would inset
  // the face along edges that carry no band and leave the gap open. Refuse
  // rather than ship that.
  if (skipped) {
    // Some corners free and some not: a real refusal, never a quiet no-op.
    throw new Error('Corners+edges needs all ' + cornerCount + ' corners of this face free - ' +
                    skipped + ' back onto something already softened');
  }
  if (!balls.length) {
    const e = new Error('no square vertex takes R=' + requestedR + ' on this face');
    e.softenSkippable = true;
    throw e;
  }

  // ---- one radius for the whole face ----
  // Every seam below is shared point for point between the corner blend and
  // the two bands that leave it, so all four corners and all four edges have
  // to run the same Rc. Take the tightest clamp on the face.
  const Runi = balls.reduce((m, b) => Math.min(m, b.Rc), Infinity);
  for (const b of balls) b.Rc = Runi;

  // ---- shared geometry per vertex ----
  //
  // corners7 put a sphere of radius Rc at the inward corner and closed the
  // rest with a flat shelf at depth Rc. That shelf is the stub: its outer
  // point, on the depth edge, stands sqrt(2)*Rc from the sphere centre, so it
  // poked 0.41*Rc proud of the ball as a flat knife. No sphere can fix it -
  // a ball tangent to both walls is always sqrt(2) times its radius from the
  // knife they make, so it can never reach the depth edge.
  //
  // The setback drops the sphere and blends the corner cross-section instead.
  // Slice the corner with planes parallel to the clicked face. At depth a the
  // two edge cylinders show up as two straight lines, inset R - w from their
  // walls with w = sqrt(2*R*a - a*a), and they cross at a sharp corner. Round
  // THAT corner, in that slice, with a radius r(a) that vanishes at both ends:
  //
  //   a = 0    (the face)       w = 0, r = 0  -> the mitre corner M, a point
  //   a = R    (the depth edge) w = R, r = 0  -> the knife, a point
  //
  // so the blend tapers to nothing at both ends and there is nothing left to
  // stand proud. In between it is a real fillet of the slice corner, which is
  // why the join to each band is exactly tangent: the slice arc meets the
  // band's slice line tangentially, and the band's own normal in that slice is
  // the same normal, for any r(a) at all.
  //
  // Written on the band's own profile angle phi (a = R(1-sin phi),
  // w = R cos phi) the choice r = R sin phi cos phi gives
  //
  //   inset  = R(1 - cos phi)                  <- the band profile, unchanged
  //   centre = R(1 - cos phi (1 - sin phi))    <- where the band now stops
  //
  // and r peaks at R/2 halfway down. Both bands and the blend read those two
  // numbers out of the same function, so the seams cannot drift apart.
  const axisIn = [0,0,0]; axisIn[axisIdx] = intoBody;
  const lift = (uv) => from3(uv, capPlane);
  const PROFN = 12;                       // slices down the blend / band profile
  const ARCN = 12;                        // samples across a slice arc
  for (const b of balls) {
    const R = b.Rc;
    // m1 = inset from the u1 edge's wall, m2 = inset from the u2 edge's wall
    b.at = (m1, m2, a) => from3(
      [b.V2[0] + b.n1[0]*m1 + b.n2[0]*m2, b.V2[1] + b.n1[1]*m1 + b.n2[1]*m2],
      depth(a));
    b.slice = (k) => {
      const phi = (Math.PI/2) * (k/PROFN);
      const c = Math.cos(phi), sn = Math.sin(phi);
      return { a: R*(1-sn), inset: R*(1-c), mc: R*(1 - c*(1-sn)), r: R*sn*c };
    };
    b.M = [b.V2[0] + (b.n1[0]+b.n2[0])*R, b.V2[1] + (b.n1[1]+b.n2[1])*R];
    b.M3 = lift(b.M);
    b.V3 = lift(b.V2);
    b.tip3 = b.at(0, 0, R);               // Rc down the depth edge: the knife end
    // the two wall planes, each as (origin, u, v) with v = into the body
    b.walls = [
      { u2: b.u1, out2: [-b.n1[0], -b.n1[1]] },
      { u2: b.u2, out2: [-b.n2[0], -b.n2[1]] }
    ];
    for (const w of b.walls) {
      w.u3 = [0,0,0]; w.u3[other[0]] = w.u2[0]; w.u3[other[1]] = w.u2[1];
      w.n3 = [0,0,0]; w.n3[other[0]] = w.out2[0]; w.n3[other[1]] = w.out2[1];
      w.org = b.V3;
      w.to2 = (p) => {
        const dx = p[0]-w.org[0], dy = p[1]-w.org[1], dz = p[2]-w.org[2];
        return [dx*w.u3[0] + dy*w.u3[1] + dz*w.u3[2],
                dx*axisIn[0] + dy*axisIn[1] + dz*axisIn[2]];
      };
      w.to3 = (uv) => [w.org[0] + w.u3[0]*uv[0] + axisIn[0]*uv[1],
                       w.org[1] + w.u3[1]*uv[0] + axisIn[1]*uv[1],
                       w.org[2] + w.u3[2]*uv[0] + axisIn[2]*uv[1]];
      w.planeD = w.n3[0]*w.org[0] + w.n3[1]*w.org[1] + w.n3[2]*w.org[2];
    }
    // the blend grid, and with it the two seams the bands must start on
    b.grid = [];
    b.seam1 = [];                          // psi = 0     -> the u1 edge's band
    b.seam2 = [];                          // psi = pi/2  -> the u2 edge's band
    for (let k = 0; k <= PROFN; k++) {
      const sl = b.slice(k), row = [];
      for (let q = 0; q <= ARCN; q++) {
        const psi = (Math.PI/2) * (q/ARCN);
        row.push(b.at(sl.mc - sl.r*Math.cos(psi), sl.mc - sl.r*Math.sin(psi), sl.a));
      }
      b.grid.push(row);
      b.seam1.push(row[0]);
      b.seam2.push(row[ARCN]);
    }
  }

  // ---- trim one plane's triangles by the corner sectors that bite it ----
  const polyArea = (p) => {
    let a = 0;
    for (let i = 0; i < p.length; i++) { const q=p[i], r=p[(i+1)%p.length]; a += q[0]*r[1]-r[0]*q[1]; }
    return Math.abs(a)*0.5;
  };
  const clipHalf = (p, px, py, nx, ny) => {
    if (p.length < 3) return [];
    const res = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i+1)%p.length];
      const da = (a[0]-px)*nx + (a[1]-py)*ny;
      const db = (b[0]-px)*nx + (b[1]-py)*ny;
      if (da >= -1e-12) res.push(a);
      if ((da > 1e-12 && db < -1e-12) || (da < -1e-12 && db > 1e-12)) {
        const u = da/(da-db);
        res.push([a[0]+(b[0]-a[0])*u, a[1]+(b[1]-a[1])*u]);
      }
    }
    const cl = [];
    for (const q of res) {
      const last = cl[cl.length-1];
      if (!last || Math.hypot(q[0]-last[0], q[1]-last[1]) > 1e-9) cl.push(q);
    }
    while (cl.length > 1 && Math.hypot(cl[0][0]-cl[cl.length-1][0], cl[0][1]-cl[cl.length-1][1]) < 1e-9) cl.pop();
    return cl.length >= 3 ? cl : [];
  };
  // Split every piece edge at any point of this plane that lies on it, then
  // fan from a vertex that leaves no degenerate triangle - and if there is
  // none, ear clip and KEEP the zero-area triangles, which carry the boundary.
  const emitPlane = (pieces, extraPts, to3, wantOut) => {
    const cpts = [], seen = new Set();
    const addC = (q) => {
      const k = Math.round(q[0]*1e4)+'|'+Math.round(q[1]*1e4);
      if (seen.has(k)) return;
      seen.add(k); cpts.push(q);
    };
    for (const p of pieces) for (const v of p) addC(v);
    for (const q of extraPts) addC(q);
    for (let idx = 0; idx < pieces.length; idx++) {
      const p = pieces[idx], grown = [];
      for (let i = 0; i < p.length; i++) {
        const a = p[i], b = p[(i+1)%p.length];
        grown.push(a);
        const ex = b[0]-a[0], ey = b[1]-a[1], len2 = ex*ex+ey*ey;
        if (!(len2 > 1e-18)) continue;
        const inv = 1/Math.sqrt(len2);
        const mids = [];
        for (const q of cpts) {
          const u = ((q[0]-a[0])*ex + (q[1]-a[1])*ey)/len2;
          if (u <= 1e-6 || u >= 1-1e-6) continue;
          if (Math.abs((q[0]-a[0])*ey - (q[1]-a[1])*ex)*inv > 1e-6) continue;
          mids.push({u:u, q:q});
        }
        mids.sort((x,y) => x.u - y.u);
        for (const m of mids) grown.push(m.q);
      }
      pieces[idx] = grown;
    }
    const put = (A, B, C) => {
      const a = to3(A), b = to3(B), c = to3(C);
      const ux=b[0]-a[0], uy=b[1]-a[1], uz=b[2]-a[2];
      const vx=c[0]-a[0], vy=c[1]-a[1], vz=c[2]-a[2];
      const nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx;
      if (nx*wantOut[0] + ny*wantOut[1] + nz*wantOut[2] < 0)
        out.push(a[0],a[1],a[2], c[0],c[1],c[2], b[0],b[1],b[2]);
      else
        out.push(a[0],a[1],a[2], b[0],b[1],b[2], c[0],c[1],c[2]);
    };
    for (const p of pieces) {
      const m = p.length;
      let apexAt = -1;
      for (let a = 0; a < m && apexAt < 0; a++) {
        let clean = true;
        for (let k = 1; k+1 < m && clean; k++) {
          const P0=p[a], P1=p[(a+k)%m], P2=p[(a+k+1)%m];
          const cr = (P1[0]-P0[0])*(P2[1]-P0[1]) - (P1[1]-P0[1])*(P2[0]-P0[0]);
          if (Math.abs(cr)*0.5 < 1e-12) clean = false;
        }
        if (clean) apexAt = a;
      }
      if (apexAt < 0) {
        for (const t of rawEarClip2D(p)) put(p[t[0]], p[t[1]], p[t[2]]);
        continue;
      }
      for (let k = 1; k+1 < m; k++) put(p[apexAt], p[(apexAt+k)%m], p[(apexAt+k+1)%m]);
    }
  };

  const out = [];

  // ---- the four edges of the clicked face: a radius-Rc cylinder each ----
  // The band runs between the two stations, so it stops exactly where the
  // ball takes over, and its end cross-section IS the circle the ball and the
  // cylinder share. Only the clicked face's own edges: the depth edges and
  // the opposite face are never touched.
  const byApex = new Map();
  for (const b of balls) byApex.set(b.ai, b);
  const edgeJobs = [];
  // One band per loop EDGE, and only where both of that edge's own corners took
  // a blend. Walking on to the next treated apex instead would bridge a skipped
  // corner and lay the band along a straight line that leaves the piece.
  for (let t = 0; t < cornerCount; t++) {
    const ai = apex[t], aj = apex[(t + 1) % cornerCount];
    if (ai === aj) continue;
    const b = byApex.get(ai), b2 = byApex.get(aj);
    if (!b || !b2) continue;
    let run = 0;
    for (let j = ai, guard = 0; guard < nL; guard++) {
      const k = (j + 1) % nL;
      run += Math.hypot(poly[k][0]-poly[j][0], poly[k][1]-poly[j][1]);
      j = k;
      if (j === aj) break;
    }
    if (!(run > 1e-9)) continue;
    edgeJobs.push({ a: b, b2: b2, dir: b.u2, nrm: b.n2, len: run });
  }
  // The band no longer ends on a flat station. Its two end columns ARE the
  // corner blends' seams, taken verbatim: the corner that owns the seam hands
  // it over, and the band only slides along the edge between them. Every row
  // has the same inset and the same depth at both ends, so a straight slide
  // stays exactly on the cylinder.
  for (const job of edgeJobs) {
    const startCol = job.a.seam2;          // leaving corner a along its u2 edge
    const endCol = job.b2.seam1;           // arriving at corner b2 along its u1
    if (startCol.length !== endCol.length) continue;
    const R = job.a.Rc;
    const span = job.len - 2*R;
    if (!(span > 1e-6)) continue;
    // Cap the station count: a tiny R on a long edge would otherwise put tens
    // of thousands of rows through the T-junction sweep and hang the tab.
    const steps = Math.max(2, Math.min(160, Math.ceil(span / Math.max(R/2, 1e-3))));
    job.rows = [];
    for (let k = 0; k <= PROFN; k++) {
      const P = startCol[k], Q = endCol[k], row = [];
      for (let q = 0; q <= steps; q++) {
        const t = q/steps;
        row.push([P[0] + (Q[0]-P[0])*t, P[1] + (Q[1]-P[1])*t, P[2] + (Q[2]-P[2])*t]);
      }
      job.rows.push(row);
    }
    job.steps = steps;
    job.tris = [];
    for (let k = 0; k < PROFN; k++) {
      for (let q = 0; q < steps; q++) {
        job.tris.push([job.rows[k][q], job.rows[k+1][q], job.rows[k][q+1]]);
        job.tris.push([job.rows[k+1][q], job.rows[k+1][q+1], job.rows[k][q+1]]);
      }
    }
  }
  // ---- the clicked face ----
  {
    let pieces = capTriIdx.map(t => [flat2(vert(t,0)), flat2(vert(t,1)), flat2(vert(t,2))]);
    let before = 0;
    for (const p of pieces) before += polyArea(p);
    // The four edge cylinders inset the face by Rc: clip it to that ring
    // first, mitre corners and all, then let each ball scallop its corner.
    const ringR = balls.reduce((m, b) => Math.max(m, b.Rc), 0);
    for (let i2 = 0; i2 < nL; i2++) {
      const a = poly[i2], b2 = poly[(i2+1)%nL];
      const ex = b2[0]-a[0], ey = b2[1]-a[1];
      const l = Math.hypot(ex, ey) || 1e-9;
      const nx = -ey/l*wind, ny = ex/l*wind;
      const px = a[0] + nx*ringR, py = a[1] + ny*ringR;
      const next = [];
      for (const pc of pieces) {
        const q = clipHalf(pc, px, py, nx, ny);
        if (q.length >= 3) next.push(q);
      }
      pieces = next;
    }
    // Nothing else comes off the face. The blend tapers to nothing at depth 0,
    // so it meets this plane at the mitre corner M and takes no area: the face
    // stays a flat inset ring with sharp mitre corners, which is what a
    // filleted box face looks like.
    let ringArea = 0;
    for (const p of pieces) ringArea += polyArea(p);
    if (!(ringArea > 1e-9)) {
      throw new Error('R=' + requestedR + ' leaves no face - left unchanged');
    }
    const extra = [];
    for (const b of balls) extra.push(b.M);
    for (const v of poly) extra.push(v);
    const wantOut = [0,0,0]; wantOut[axisIdx] = -intoBody;
    emitPlane(pieces, extra, (uv) => from3(uv, capPlane), wantOut);
  }

  // ---- the two walls at each vertex ----
  const wallJobs = new Map();
  for (const b of balls) {
    for (const w of b.walls) {
      const key = w.n3.map(x => Math.round(x*1e3)).join(',') + '|' + Math.round(w.planeD*1e3);
      if (!wallJobs.has(key)) wallJobs.set(key, { w: w });
    }
  }
  const onPlane = (p, n3, d) => Math.abs(p[0]*n3[0] + p[1]*n3[1] + p[2]*n3[2] - d) < 1e-3;
  const usedWallTri = new Set();
  for (const job of wallJobs.values()) {
    const w0 = job.w;
    const mine = [];
    for (const t of wallTriIdx) {
      const v0=vert(t,0), v1=vert(t,1), v2=vert(t,2);
      if (onPlane(v0, w0.n3, w0.planeD) && onPlane(v1, w0.n3, w0.planeD) && onPlane(v2, w0.n3, w0.planeD)) {
        mine.push(t);
        usedWallTri.add(t);
      }
    }
    if (!mine.length) continue;
    // every point this plane must carry a vertex at: the blend runs to the
    // knife end of each depth edge, which sits on this wall's trimmed edge.
    const marks = [];
    for (const b of balls) {
      for (const w of b.walls) {
        const key = w.n3.map(x => Math.round(x*1e3)).join(',') + '|' + Math.round(w.planeD*1e3);
        const k0 = w0.n3.map(x => Math.round(x*1e3)).join(',') + '|' + Math.round(w0.planeD*1e3);
        if (key !== k0) continue;
        marks.push(w0.to2(b.tip3));
      }
    }
    let pieces = mine.map(t => [w0.to2(vert(t,0)), w0.to2(vert(t,1)), w0.to2(vert(t,2))]);
    // The edge cylinder has taken the top strip of this wall down to depth Rc.
    const stripR = balls.reduce((m, b) => Math.max(m, b.Rc), 0);
    const stripped = [];
    for (const pc of pieces) {
      const q = clipHalf(pc, 0, stripR, 0, 1);
      if (q.length >= 3) stripped.push(q);
    }
    pieces = stripped;
    // Nothing else comes off this wall. The blend runs down the cylinder to
    // this wall's own trim line and ends on it, so it takes no wall area.
    let after = 0;
    for (const p of pieces) after += polyArea(p);
    if (!(after > 1e-9)) {
      throw new Error('R=' + requestedR + ' leaves no wall - left unchanged');
    }
    emitPlane(pieces, marks, w0.to3, w0.n3);
  }
  for (const t of wallTriIdx) {
    if (usedWallTri.has(t)) continue;
    const a = vert(t,0), b = vert(t,1), c = vert(t,2);
    out.push(a[0],a[1],a[2], b[0],b[1],b[2], c[0],c[1],c[2]);
  }

  // ---- the four edge cylinders, emitted ----
  for (const job of edgeJobs) {
    const R = Math.min(job.a.Rc, job.b2.Rc);
    const V2 = job.a.V2, u = job.dir, nrm = job.nrm;
    for (const tri of job.tris || []) {
      const A3 = tri[0], B3 = tri[1], C3t = tri[2];
      const mid = [(A3[0]+B3[0]+C3t[0])/3, (A3[1]+B3[1]+C3t[1])/3, (A3[2]+B3[2]+C3t[2])/3];
      const m2 = [mid[other[0]], mid[other[1]]];
      const t = (m2[0]-V2[0])*u[0] + (m2[1]-V2[1])*u[1];
      const ax = from3([V2[0] + u[0]*t + nrm[0]*R, V2[1] + u[1]*t + nrm[1]*R], depth(R));
      const ref = [mid[0]-ax[0], mid[1]-ax[1], mid[2]-ax[2]];
      const ux=B3[0]-A3[0], uy=B3[1]-A3[1], uz=B3[2]-A3[2];
      const vx=C3t[0]-A3[0], vy=C3t[1]-A3[1], vz=C3t[2]-A3[2];
      const nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx;
      if (0.5*Math.hypot(nx,ny,nz) < 1e-12) continue;
      if (nx*ref[0] + ny*ref[1] + nz*ref[2] < 0)
        out.push(A3[0],A3[1],A3[2], C3t[0],C3t[1],C3t[2], B3[0],B3[1],B3[2]);
      else
        out.push(A3[0],A3[1],A3[2], B3[0],B3[1],B3[2], C3t[0],C3t[1],C3t[2]);
    }
  }

  // ---- the corner: the setback blend ----
  //
  // One grid, (PROFN+1) slices down by (ARCN+1) across. Column 0 is seam1 and
  // column ARCN is seam2 - the very arrays the two bands were built from - so
  // both seams are shared point for point and are tangent by construction.
  // Slice PROFN collapses onto the mitre corner M on the face, slice 0 onto
  // the knife end of the depth edge, so the blend closes to a point at both
  // ends and leaves nothing standing proud. No shelf, no stub.
  let patchTris = 0;
  for (const b of balls) {
    const R = b.Rc;
    const ref = b.at(R, R, R);            // strictly inside; the blend wraps it
    const g = b.grid;
    const tri = [];
    for (let k = 0; k < PROFN; k++) {
      for (let q = 0; q < ARCN; q++) {
        tri.push([g[k][q], g[k+1][q], g[k+1][q+1]]);
        tri.push([g[k][q], g[k+1][q+1], g[k][q+1]]);
      }
    }
    // One orientation test on a healthy triangle in the middle of the grid,
    // then the same winding everywhere: the rows at either end are degenerate
    // and cannot be trusted to vote.
    let flip = false;
    let bestA = 0;
    for (const t of tri) {
      const ux=t[1][0]-t[0][0], uy=t[1][1]-t[0][1], uz=t[1][2]-t[0][2];
      const vx=t[2][0]-t[0][0], vy=t[2][1]-t[0][1], vz=t[2][2]-t[0][2];
      const nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx;
      const ar = 0.5*Math.hypot(nx,ny,nz);
      if (ar <= bestA) continue;
      const mx=(t[0][0]+t[1][0]+t[2][0])/3 - ref[0];
      const my=(t[0][1]+t[1][1]+t[2][1])/3 - ref[1];
      const mz=(t[0][2]+t[1][2]+t[2][2])/3 - ref[2];
      bestA = ar;
      flip = (nx*mx + ny*my + nz*mz) < 0;
    }
    if (!(bestA > 0)) throw new Error('corner blend produced no area - left unchanged');
    for (const t of tri) {
      const ux=t[1][0]-t[0][0], uy=t[1][1]-t[0][1], uz=t[1][2]-t[0][2];
      const vx=t[2][0]-t[0][0], vy=t[2][1]-t[0][1], vz=t[2][2]-t[0][2];
      const nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx;
      if (0.5*Math.hypot(nx,ny,nz) < 1e-12) continue;
      if (flip) out.push(t[0][0],t[0][1],t[0][2], t[2][0],t[2][1],t[2][2], t[1][0],t[1][1],t[1][2]);
      else out.push(t[0][0],t[0][1],t[0][2], t[1][0],t[1][1],t[1][2], t[2][0],t[2][1],t[2][2]);
      patchTris++;
    }
  }

  if (out.length < 9) throw new Error('vertex ball produced no geometry');

  // Global T-junction repair. Each plane is trimmed in its own frame, so a cut
  // that crosses an edge two planes share leaves a vertex on one side and not
  // the other - and the piece's far end, which this pass never touches, ends
  // up with long edges the trimmed walls have split. Split any triangle edge
  // another vertex sits on. One sweep only splits one edge per triangle, so
  // sweep until nothing moves.
  let sweepSplits = 0, sweepPasses = 0;
  for (let pass = 0; pass < 8; pass++) {
    let splits = 0;
    const q = 1e4;
    const vk = (x, y, z) => Math.round(x*q)+'|'+Math.round(y*q)+'|'+Math.round(z*q);
    const pts = new Map();
    for (let i = 0; i < out.length; i += 3) {
      const k = vk(out[i], out[i+1], out[i+2]);
      if (!pts.has(k)) pts.set(k, [out[i], out[i+1], out[i+2]]);
    }
    const grid = new Map();
    const CELL = 1.0;
    const cell = (p) => Math.floor(p[0]/CELL)+'|'+Math.floor(p[1]/CELL)+'|'+Math.floor(p[2]/CELL);
    for (const p of pts.values()) {
      const k = cell(p);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(p);
    }
    // Walk the cells the segment actually passes through, not the whole box it
    // spans. A long edge across the piece used to blow the box budget and fall
    // back to scanning every point, which is what made this sweep the slowest
    // thing in the bake.
    const near = (a, b) => {
      const seen = new Set(), res = [];
      const len = Math.hypot(b[0]-a[0], b[1]-a[1], b[2]-a[2]);
      const steps = Math.max(1, Math.ceil(len / (CELL*0.5)));
      const cells = new Set();
      for (let q = 0; q <= steps; q++) {
        const t = q/steps;
        const cx = Math.floor((a[0] + (b[0]-a[0])*t)/CELL);
        const cy = Math.floor((a[1] + (b[1]-a[1])*t)/CELL);
        const cz = Math.floor((a[2] + (b[2]-a[2])*t)/CELL);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++)
          cells.add((cx+dx)+'|'+(cy+dy)+'|'+(cz+dz));
      }
      for (const ck of cells) {
        const g = grid.get(ck);
        if (!g) continue;
        for (const p of g) { const k = vk(p[0],p[1],p[2]); if (!seen.has(k)) { seen.add(k); res.push(p); } }
      }
      return res;
    };
    // Only unmatched edges can be T-junctions, and on a nearly sealed bake
    // that is a handful out of thousands. Counting edge uses first turns the
    // whole sweep from "search every edge" into "search the few that are open".
    const useCount = new Map();
    for (let t = 0; t + 8 < out.length; t += 9) {
      const K = [vk(out[t],out[t+1],out[t+2]), vk(out[t+3],out[t+4],out[t+5]), vk(out[t+6],out[t+7],out[t+8])];
      for (let e = 0; e < 3; e++) {
        const a = K[e], b = K[(e+1)%3];
        const k = a < b ? a+'~'+b : b+'~'+a;
        useCount.set(k, (useCount.get(k) || 0) + 1);
      }
    }
    const openEdge = (ka, kb) => {
      const k = ka < kb ? ka+'~'+kb : kb+'~'+ka;
      return useCount.get(k) !== 2;
    };
    const fixed = [];
    for (let t = 0; t + 8 < out.length; t += 9) {
      const V = [[out[t],out[t+1],out[t+2]], [out[t+3],out[t+4],out[t+5]], [out[t+6],out[t+7],out[t+8]]];
      const VK = [vk(V[0][0],V[0][1],V[0][2]), vk(V[1][0],V[1][1],V[1][2]), vk(V[2][0],V[2][1],V[2][2])];
      let split = -1, mids = null;
      for (let e = 0; e < 3; e++) {
        if (!openEdge(VK[e], VK[(e+1)%3])) continue;
        const a = V[e], b = V[(e+1)%3];
        const ex = b[0]-a[0], ey = b[1]-a[1], ez = b[2]-a[2];
        const len2 = ex*ex + ey*ey + ez*ez;
        if (!(len2 > 1e-12)) continue;
        const inv = 1/Math.sqrt(len2);
        const hits = [];
        for (const p of near(a, b)) {
          const u = ((p[0]-a[0])*ex + (p[1]-a[1])*ey + (p[2]-a[2])*ez)/len2;
          if (u <= 1e-6 || u >= 1-1e-6) continue;
          const cx = (p[1]-a[1])*ez - (p[2]-a[2])*ey;
          const cy = (p[2]-a[2])*ex - (p[0]-a[0])*ez;
          const cz = (p[0]-a[0])*ey - (p[1]-a[1])*ex;
          if (Math.hypot(cx,cy,cz)*inv > 1e-4) continue;
          hits.push({ u: u, p: p });
        }
        if (hits.length) { split = e; mids = hits.sort((x,y) => x.u - y.u); break; }
      }
      if (split < 0) {
        fixed.push(V[0][0],V[0][1],V[0][2], V[1][0],V[1][1],V[1][2], V[2][0],V[2][1],V[2][2]);
        continue;
      }
      splits++;
      const A = V[split], B = V[(split+1)%3], C = V[(split+2)%3];
      const chain = [A];
      for (const m of mids) chain.push(m.p);
      chain.push(B);
      for (let k = 0; k + 1 < chain.length; k++) {
        fixed.push(chain[k][0],chain[k][1],chain[k][2],
                   chain[k+1][0],chain[k+1][1],chain[k+1][2],
                   C[0],C[1],C[2]);
      }
    }
    out.length = 0;
    for (const v of fixed) out.push(v);
    sweepSplits += splits;
    sweepPasses = pass + 1;
    if (!splits) break;
  }

  const result = new Float32Array(out);
  rawVertexBallCorners.lastBuild = {
    vertices: balls.length,
    corners: cornerCount,
    skipped: skipped,
    radius: balls.reduce((m, b) => Math.min(m, b.Rc), Infinity),
    requested: requestedR,
    patchTris: patchTris,
    sweepSplits: sweepSplits,
    sweepPasses: sweepPasses,
    bands: edgeJobs.length
  };
  return result;
}

// Bevel. Same loop and the same untouched cap plane as Round, with the
// quarter circle replaced by a single flat band.
//
// This used to build its own body by re-clipping at
// marginPlane = plane + outward * Rmax, which retracts the WHOLE lid by R
// rather than just the treated edge. That is the bug that killed the
// earlier passes; the margin clip is gone and must not come back.
function rawChamferCut(rawTris, axisIdx, plane, keepMin, R) {
  // rawEdgeRoundInPlace is the CORNERS engine and has no profile option — it
  // silently ignored 'chamfer' and gave Bevel a four-corner round. The flat
  // band belongs on the perimeter path, which is where it is now.
  return rawPerimeterFilletInPlace(rawTris, axisIdx, keepMin, R, { profile: 'chamfer' });
}

// Corners only. Round and Bevel are still one exclusive choice on the same
// engine; this ticket does not add a full-loop edge round. The clicked face's
// own plane is read off the mesh inside the engine — `plane` below is only
// the EPS-nudged value the older call sites expect and is not what the lid
// is built on.
function softenSelectedFace(rawTris, axisIdx, keepMinFace, R, mode, pickPlane) {
  mode = mode || getEdgeTreat();

  // The plane is the stored pick's plane. This used to scan rawTris for its
  // own min/max on the axis and use that — the bbox remap that let a click
  // land on one face while the radius landed on another. The scan survives
  // only as an ASSERTION: rawEdgeRoundInPlace builds on the outer plane of
  // the axis it is handed, so if the picked plane is not that plane the
  // engine physically cannot honour the click, and we refuse rather than
  // treat whatever face it can reach.
  const extreme = rawExtremeOf(rawTris, axisIdx, keepMinFace);
  if (pickPlane == null || !isFinite(pickPlane) || !isFinite(extreme) ||
      Math.abs(pickPlane - extreme) > FACE_PICK_TOL) {
    throw new Error('clicked face is not the outer plane on that axis');
  }
  // Clipping exactly AT the picked plane finds nothing to cross — every
  // vertex already satisfies the boundary, so no cut edges exist to build a
  // loop from. Nudge slightly inward so the clip actually crosses the
  // clicked face's own triangles and recovers its true boundary shape.
  const EPS = 0.02;
  const plane = keepMinFace ? pickPlane + EPS : pickPlane - EPS;
  // keepMin=true keeps coord >= plane (the upper/max side) in this
  // engine's convention — confirmed directly, opposite of the name's
  // surface reading. To soften the MAX face and keep the rest of the
  // piece, keep coord <= plane, i.e. keepMin=false; to soften the MIN
  // face and keep the rest, keep coord >= plane, i.e. keepMin=true.
  const keepMin = keepMinFace;
  if (mode === 'square') {
    throw new Error('square edge - use Cap / Seal, Soften not needed');
  }
  if (mode === 'chamfer' && typeof rawChamferCut === 'function') {
    return rawChamferCut(rawTris, axisIdx, plane, keepMin, R);
  }
  if (mode === 'cornersedges') {
    // Corners+edges: the setback bake. Four vertex blends, four edge bands,
    // no shelf. Its maths is not touched by the split into two modes.
    return rawVertexBallCorners(rawTris, axisIdx, keepMin, R, { minTurnDeg: 25 });
  }
  if (mode === 'corners') {
    // Corners: a ball at each VERTEX and nothing else. The face and both walls
    // get the same R, the mid-edges stay square, no band, no shelf.
    return rawVertexBallOnly(rawTris, axisIdx, keepMin, R, { minTurnDeg: 25 });
  }
  // Round / fillet: a TRUE perimeter fillet — every point of the loop carries
  // R, so all four edges of a square face get the radius and none stays a
  // sharp straight run. Same cap plane, same depth-only wall.
  return rawPerimeterFilletInPlace(rawTris, axisIdx, keepMin, R, { profile: 'round' });
}

function dropZeroAreaTriangles(soup, epsArea) {
  epsArea = epsArea == null ? 1e-6 : epsArea;
  const triCount = (soup.length / 9) | 0;
  const out = [];
  for (let t = 0; t < triCount; t++) {
    const i0 = t * 9;
    const ax = soup[i0], ay = soup[i0 + 1], az = soup[i0 + 2];
    const bx = soup[i0 + 3], by = soup[i0 + 4], bz = soup[i0 + 5];
    const cx = soup[i0 + 6], cy = soup[i0 + 7], cz = soup[i0 + 8];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const area = 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (area > epsArea) out.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  }
  return out.length >= 9 ? new Float32Array(out) : soup;
}

function flipInconsistentWindings(soup) {
  const triCount = (soup.length / 9) | 0;
  if (triCount < 2) return soup;

  function keyv(x, y, z) { return Math.round(x * 2000) + ':' + Math.round(y * 2000) + ':' + Math.round(z * 2000); }
  const vidMap = new Map();
  function vid(x, y, z) {
    const k = keyv(x, y, z);
    let id = vidMap.get(k);
    if (id === undefined) { id = vidMap.size; vidMap.set(k, id); }
    return id;
  }
  const triV = new Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const i0 = t * 9;
    triV[t] = [
      vid(soup[i0], soup[i0 + 1], soup[i0 + 2]),
      vid(soup[i0 + 3], soup[i0 + 4], soup[i0 + 5]),
      vid(soup[i0 + 6], soup[i0 + 7], soup[i0 + 8])
    ];
  }

  const dirEdge = new Map();
  function dk(a, b) { return a + '_' + b; }
  for (let t = 0; t < triCount; t++) {
    const tv = triV[t];
    [[tv[0], tv[1]], [tv[1], tv[2]], [tv[2], tv[0]]].forEach(function (e) {
      const k = dk(e[0], e[1]);
      if (!dirEdge.has(k)) dirEdge.set(k, []);
      dirEdge.get(k).push(t);
    });
  }

  const flip = new Uint8Array(triCount);
  const visited = new Uint8Array(triCount);
  let flippedCount = 0;

  for (let s = 0; s < triCount; s++) {
    if (visited[s]) continue;
    visited[s] = 1;
    const stack = [s];
    while (stack.length) {
      const t = stack.pop();
      const tv = triV[t];
      [[tv[0], tv[1]], [tv[1], tv[2]], [tv[2], tv[0]]].forEach(function (e) {
        const a0 = e[0], b0 = e[1];
        const fwd = flip[t] ? [b0, a0] : [a0, b0];
        const sameDirPeers = dirEdge.get(dk(a0, b0)) || [];
        const oppDirPeers = dirEdge.get(dk(b0, a0)) || [];
        sameDirPeers.concat(oppDirPeers).forEach(function (o) {
          if (o === t || visited[o]) return;
          const oOrigFwd = sameDirPeers.indexOf(o) !== -1 ? [a0, b0] : [b0, a0];
          flip[o] = (oOrigFwd[0] === fwd[0]) ? 1 : 0;
          if (flip[o]) flippedCount++;
          visited[o] = 1;
          stack.push(o);
        });
      });
    }
  }

  if (!flippedCount || flippedCount > triCount * 0.15) return soup;

  const out = new Float32Array(soup.length);
  for (let t = 0; t < triCount; t++) {
    const i0 = t * 9;
    if (flip[t]) {
      out[i0] = soup[i0]; out[i0 + 1] = soup[i0 + 1]; out[i0 + 2] = soup[i0 + 2];
      out[i0 + 3] = soup[i0 + 6]; out[i0 + 4] = soup[i0 + 7]; out[i0 + 5] = soup[i0 + 8];
      out[i0 + 6] = soup[i0 + 3]; out[i0 + 7] = soup[i0 + 4]; out[i0 + 8] = soup[i0 + 5];
    } else {
      for (let k = 0; k < 9; k++) out[i0 + k] = soup[i0 + k];
    }
  }
  return out;
}

function pruneDustShells(soup) {
  const triCount = (soup.length / 9) | 0;
  if (triCount < 2) return soup;
  function keyv(x, y, z) { return Math.round(x * 2000) + ':' + Math.round(y * 2000) + ':' + Math.round(z * 2000); }
  const vidMap = new Map();
  function vid(x, y, z) {
    const k = keyv(x, y, z);
    let id = vidMap.get(k);
    if (id === undefined) { id = vidMap.size; vidMap.set(k, id); }
    return id;
  }
  const triV = new Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const i0 = t * 9;
    triV[t] = [
      vid(soup[i0], soup[i0 + 1], soup[i0 + 2]),
      vid(soup[i0 + 3], soup[i0 + 4], soup[i0 + 5]),
      vid(soup[i0 + 6], soup[i0 + 7], soup[i0 + 8])
    ];
  }
  const parent = new Array(triCount);
  for (let t = 0; t < triCount; t++) parent[t] = t;
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
  const edgeMap = new Map();
  function ek(a, b) { return a < b ? a + '_' + b : b + '_' + a; }
  for (let t = 0; t < triCount; t++) {
    const tv = triV[t];
    [ek(tv[0], tv[1]), ek(tv[1], tv[2]), ek(tv[2], tv[0])].forEach(function (k) {
      if (!edgeMap.has(k)) edgeMap.set(k, []);
      edgeMap.get(k).push(t);
    });
  }
  edgeMap.forEach(function (list) { for (let i = 1; i < list.length; i++) union(list[0], list[i]); });

  const compTris = new Map();
  for (let t = 0; t < triCount; t++) {
    const r = find(t);
    if (!compTris.has(r)) compTris.set(r, []);
    compTris.get(r).push(t);
  }
  if (compTris.size < 2) return soup;

  let totalVol = 0;
  const compInfo = [];
  compTris.forEach(function (tris) {
    let vol = 0;
    for (let k = 0; k < tris.length; k++) {
      const i0 = tris[k] * 9;
      const ax = soup[i0], ay = soup[i0 + 1], az = soup[i0 + 2];
      const bx = soup[i0 + 3], by = soup[i0 + 4], bz = soup[i0 + 5];
      const cx = soup[i0 + 6], cy = soup[i0 + 7], cz = soup[i0 + 8];
      vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    }
    vol = Math.abs(vol);
    totalVol += vol;
    compInfo.push({ tris: tris, vol: vol });
  });
  compInfo.sort(function (a, b) {
    if (Math.abs(a.vol - b.vol) > 1e-9) return b.vol - a.vol;
    return b.tris.length - a.tris.length;
  });
  const keepTriIdx = new Set();
  for (let i = 0; i < compInfo.length; i++) {
    const c = compInfo[i];
    const share = totalVol > 0 ? c.vol / totalVol : 0;
    const keep = (i === 0) || (c.tris.length >= 20 && share >= 0.02);
    if (keep) for (let k = 0; k < c.tris.length; k++) keepTriIdx.add(c.tris[k]);
  }
  const filtered = [];
  for (let t = 0; t < triCount; t++) {
    if (!keepTriIdx.has(t)) continue;
    const i0 = t * 9;
    for (let k = 0; k < 9; k++) filtered.push(soup[i0 + k]);
  }
  return filtered.length >= 9 ? new Float32Array(filtered) : soup;
}

function countNonManifoldEdges(soup) {
  try {
    const triCount = (soup.length / 9) | 0;
    function keyv(x, y, z) { return Math.round(x * 2000) + ':' + Math.round(y * 2000) + ':' + Math.round(z * 2000); }
    const vidMap = new Map();
    function vid(x, y, z) {
      const k = keyv(x, y, z);
      let id = vidMap.get(k);
      if (id === undefined) { id = vidMap.size; vidMap.set(k, id); }
      return id;
    }
    const edgeCount = new Map();
    function ek(a, b) { return a < b ? a + '_' + b : b + '_' + a; }
    for (let t = 0; t < triCount; t++) {
      const i0 = t * 9;
      const a = vid(soup[i0], soup[i0 + 1], soup[i0 + 2]);
      const b = vid(soup[i0 + 3], soup[i0 + 4], soup[i0 + 5]);
      const c = vid(soup[i0 + 6], soup[i0 + 7], soup[i0 + 8]);
      [ek(a, b), ek(b, c), ek(c, a)].forEach(function (k) {
        edgeCount.set(k, (edgeCount.get(k) || 0) + 1);
      });
    }
    let nm = 0;
    edgeCount.forEach(function (n) { if (n > 2) nm++; });
    return nm;
  } catch (e) {
    return null;
  }
}

function repairForPrint(soup) {
  if (!soup || soup.length < 9) return { soup: null, ok: false, reason: 'empty input' };

  function bboxVolume(s) {
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < s.length; i += 3) {
      const x = s[i], y = s[i + 1], z = s[i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    return Math.max(0, maxX - minX) * Math.max(0, maxY - minY) * Math.max(0, maxZ - minZ);
  }

  const volBefore = bboxVolume(soup);
  let working = soup;
  try {
    working = dropZeroAreaTriangles(working, 1e-6);
    working = weldSoupVerts(working, 0.05);
    if (!working || working.length < 9) return { soup: null, ok: false, reason: 'weld collapsed mesh' };

    working = flipInconsistentWindings(working);
    working = pruneDustShells(working);
    if (typeof capSmallOpenLoops === 'function') {
      working = capSmallOpenLoops(working, 3);
    }
  } catch (e) {
    return { soup: null, ok: false, reason: 'repair pass threw: ' + (e && e.message || e) };
  }

  if (!working || working.length < 9) {
    return { soup: null, ok: false, reason: 'repair pass produced empty mesh' };
  }
  const volAfter = bboxVolume(working);
  if (volBefore > 0 && volAfter < volBefore * 0.85) {
    return { soup: null, ok: false, reason: 'bbox shrank >15% - possible bad flip/prune' };
  }
  return { soup: working, ok: true, reason: null };
}

function sealSelectedModel() {
  const m = getActiveModel();
  if (!m) { setStatus('Select a piece in the list first', true); return; }

  function localSoupFromGeometry(geo) {
    if (!geo || !geo.attributes || !geo.attributes.position) return null;
    const pos = geo.attributes.position;
    const index = geo.index;
    const out = [];
    if (index) {
      for (let i = 0; i < index.count; i++) {
        const vi = index.getX(i);
        out.push(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
      }
    } else {
      for (let i = 0; i < pos.count; i++) {
        out.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      }
    }
    return out.length >= 9 ? new Float32Array(out) : null;
  }

  const usingRaw = !!(m.rawTris && m.rawAxis === 'zup');
  const soupIn = usingRaw ? m.rawTris : localSoupFromGeometry(m.geometry);
  if (!soupIn || soupIn.length < 9) {
    setStatus('Seal failed - piece unchanged', true);
    return;
  }

  const repairChk = document.getElementById('chk-seal-repair');
  const repairMode = !!(repairChk && repairChk.checked);

  let openBefore = null, nmBefore = null;
  try { openBefore = openBoundaryEdges(soupIn).length; } catch (e) {}
  if (repairMode) { try { nmBefore = countNonManifoldEdges(soupIn); } catch (e) {} }

  let working = soupIn;
  let ok = true;
  let failReason = null;

  if (repairMode) {
    const result = repairForPrint(soupIn);
    ok = result.ok;
    working = result.soup;
    failReason = result.reason;
  } else {
    try {
      working = weldSoupVerts(working);
      if (typeof capSmallOpenLoops === 'function') {
        working = capSmallOpenLoops(working, 3);
      }
      working = capAllOuterHoles(working);
      if (typeof repairJoinedSoup === 'function') {
        working = repairJoinedSoup(working);
      }
    } catch (e) {
      ok = false;
    }
  }

  if (!ok || !working || working.length < 9) {
    setStatus(repairMode ? ('Repair failed - piece unchanged (' + (failReason || 'unknown') + ')') : 'Seal failed - piece unchanged', true);
    return;
  }

  pushUndo({
    type: 'sealReplace',
    modelId: m.id,
    prevGeometry: m.geometry.clone(),
    prevRawTris: m.rawTris,
    prevRawAxis: m.rawAxis,
    prevCenterOffset: m.centerOffset,
    prevSize: { x: m.size.x, y: m.size.y, z: m.size.z }
  });

  let newGeo;
  if (usingRaw) {
    newGeo = rawResultToDisplayGeometry(working);
  } else {
    newGeo = soupToCenteredGeo(working);
  }
  newGeo.computeBoundingBox();
  const size2 = new THREE.Vector3();
  newGeo.boundingBox.getSize(size2);

  m.geometry = newGeo;
  if (usingRaw) {
    m.rawTris = working;
    m.rawAxis = 'zup';
    m.centerOffset = computeCenterOffsetFromRaw(working);
  }
  m.size = { x: size2.x, y: size2.y, z: size2.z };

  const placedEntry = state.placed.find(p => p && p.sourceId === m.id);
  if (placedEntry) {
    const px = placedEntry.x, pz = placedEntry.z;
    if (placedEntry.mesh && state.modelGroup) {
      state.modelGroup.remove(placedEntry.mesh);
      if (placedEntry.mesh.material) {
        if (Array.isArray(placedEntry.mesh.material)) placedEntry.mesh.material.forEach(mt => mt.dispose());
        else placedEntry.mesh.material.dispose();
      }
    }
    const mat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8, metalness: 0.05, roughness: 0.4,
      emissive: 0x0a3a5c, emissiveIntensity: 0.25
    });
    const mesh = new THREE.Mesh(m.geometry, mat);
    mesh.position.set(px, m.size.y / 2 + 0.3, pz);
    mesh.userData.sourceId = m.id;
    mesh.userData.placedIndex = state.placed.indexOf(placedEntry);
    state.modelGroup.add(mesh);
    placedEntry.mesh = mesh;
    placedEntry.geometry = m.geometry;
    placedEntry.width = m.size.x;
    placedEntry.depth = m.size.z;
    settlePlacedOnBed(placedEntry);
  }

  let openAfter = null;
  try { openAfter = openBoundaryEdges(working).length; } catch (e) {}

  if (repairMode) {
    let nmAfter = null;
    try { nmAfter = countNonManifoldEdges(working); } catch (e) {}
    const openStr = (openBefore != null && openAfter != null) ? (openBefore + '\u2192' + openAfter) : '?';
    const nmStr = (nmBefore != null && nmAfter != null) ? (nmBefore + '\u2192' + nmAfter) : '?';
    setStatus('Repair done - open edges ' + openStr + ', non-manifold ' + nmStr);
  } else {
    if (openBefore != null && openAfter != null) {
      setStatus('Seal ok - open edges ' + openBefore + '\u2192' + openAfter);
    } else {
      setStatus('Seal ok');
    }
  }
}


function solidifySelectedModel() {
  const m = getActiveModel();
  if (!m) { setStatus('Select a piece first', true); return; }
  function localSoupFromGeometry(geo) {
    if (!geo || !geo.attributes || !geo.attributes.position) return null;
    const pos = geo.attributes.position;
    const index = geo.index;
    const out = [];
    if (index) {
      for (let i = 0; i < index.count; i++) {
        const vi = index.getX(i);
        out.push(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
      }
    } else {
      for (let i = 0; i < pos.count; i++) {
        out.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      }
    }
    return out.length >= 9 ? new Float32Array(out) : null;
  }
  const usingRaw = !!(m.rawTris && m.rawAxis === 'zup');
  const soupIn = usingRaw ? m.rawTris : localSoupFromGeometry(m.geometry);
  if (!soupIn || soupIn.length < 9) {
    setStatus('Solidify failed - piece unchanged', true);
    return;
  }
  let openBefore = null, nmBefore = null;
  try { openBefore = openBoundaryEdges(soupIn).length; } catch (e) {}
  try { if (typeof countNonManifoldEdges === 'function') nmBefore = countNonManifoldEdges(soupIn); } catch (e) {}
  let working = soupIn;
  try {
    working = weldSoupVerts(working);
    if (typeof capSmallOpenLoops === 'function') working = capSmallOpenLoops(working, 28);
    working = capAllOuterHoles(working);
    if (typeof repairJoinedSoup === 'function') working = repairJoinedSoup(working);
    working = weldSoupVerts(working);
  } catch (e) {
    setStatus('Solidify failed - piece unchanged', true);
    return;
  }
  if (!working || working.length < 9) {
    setStatus('Solidify failed - piece unchanged', true);
    return;
  }
  pushUndo({
    type: 'solidifyReplace',
    modelId: m.id,
    prevGeometry: m.geometry.clone(),
    prevRawTris: m.rawTris,
    prevRawAxis: m.rawAxis,
    prevCenterOffset: m.centerOffset,
    prevSize: { x: m.size.x, y: m.size.y, z: m.size.z }
  });
  let newGeo;
  if (usingRaw) newGeo = rawResultToDisplayGeometry(working);
  else newGeo = soupToCenteredGeo(working);
  newGeo.computeBoundingBox();
  const size2 = new THREE.Vector3();
  newGeo.boundingBox.getSize(size2);
  m.geometry = newGeo;
  if (usingRaw) {
    m.rawTris = working;
    m.rawAxis = 'zup';
    m.centerOffset = computeCenterOffsetFromRaw(working);
  }
  m.size = { x: size2.x, y: size2.y, z: size2.z };
  const placedEntry = state.placed.find(p => p && p.sourceId === m.id);
  if (placedEntry) {
    const px = placedEntry.x, pz = placedEntry.z;
    if (placedEntry.mesh && state.modelGroup) {
      state.modelGroup.remove(placedEntry.mesh);
      if (placedEntry.mesh.material) {
        if (Array.isArray(placedEntry.mesh.material)) placedEntry.mesh.material.forEach(mt => mt.dispose());
        else placedEntry.mesh.material.dispose();
      }
    }
    const mat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8, metalness: 0.05, roughness: 0.4,
      emissive: 0x0a3a5c, emissiveIntensity: 0.25
    });
    const mesh = new THREE.Mesh(m.geometry, mat);
    mesh.position.set(px, m.size.y / 2 + 0.3, pz);
    mesh.userData.sourceId = m.id;
    mesh.userData.placedIndex = state.placed.indexOf(placedEntry);
    state.modelGroup.add(mesh);
    placedEntry.mesh = mesh;
    placedEntry.geometry = m.geometry;
    placedEntry.width = m.size.x;
    placedEntry.depth = m.size.z;
    placedEntry.height = m.size.y;
    settlePlacedOnBed(placedEntry);
  }
  let openAfter = null, nmAfter = null;
  try { openAfter = openBoundaryEdges(working).length; } catch (e) {}
  try { if (typeof countNonManifoldEdges === 'function') nmAfter = countNonManifoldEdges(working); } catch (e) {}
  if (openBefore != null && openAfter != null) {
    let msg = 'Solidify ok - open ' + openBefore + '\u2192' + openAfter;
    if (nmBefore != null && nmAfter != null) msg += ', NM ' + nmBefore + '\u2192' + nmAfter;
    setStatus(msg);
  } else {
    setStatus('Solidify ok');
  }
}

// ---- Thicken: voxel dilate/erode helpers (new, not used by Solidify) ----

const THICKEN_MAX_DIM = 110;
const THICKEN_TARGET_STEPS = 4;
const THICKEN_PAD_VOX = 3;

function _thickenBBoxOfSoup(soup) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < soup.length; i += 3) {
    const x = soup[i], y = soup[i + 1], z = soup[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

function _thickenChoosePitch(bb, offsetMm) {
  const spanX = Math.max(1e-3, bb.maxX - bb.minX);
  const spanY = Math.max(1e-3, bb.maxY - bb.minY);
  const spanZ = Math.max(1e-3, bb.maxZ - bb.minZ);
  let pitch = Math.max(offsetMm / THICKEN_TARGET_STEPS, 0.05);
  function dims(p) {
    return [
      Math.ceil(spanX / p) + THICKEN_PAD_VOX * 2,
      Math.ceil(spanY / p) + THICKEN_PAD_VOX * 2,
      Math.ceil(spanZ / p) + THICKEN_PAD_VOX * 2
    ];
  }
  let [nx, ny, nz] = dims(pitch);
  let guard = 0;
  while ((nx > THICKEN_MAX_DIM || ny > THICKEN_MAX_DIM || nz > THICKEN_MAX_DIM) && guard < 60) {
    pitch *= 1.25;
    [nx, ny, nz] = dims(pitch);
    guard++;
  }
  return pitch;
}

function _thickenPointInTri2D(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(hasNeg && hasPos);
}

function _thickenVoxelize(soup, pitch) {
  const bb = _thickenBBoxOfSoup(soup);
  const pad = THICKEN_PAD_VOX * pitch;
  const ox = bb.minX - pad, oy = bb.minY - pad, oz = bb.minZ - pad;
  const nx = Math.max(1, Math.ceil((bb.maxX - bb.minX) / pitch) + THICKEN_PAD_VOX * 2);
  const ny = Math.max(1, Math.ceil((bb.maxY - bb.minY) / pitch) + THICKEN_PAD_VOX * 2);
  const nz = Math.max(1, Math.ceil((bb.maxZ - bb.minZ) / pitch) + THICKEN_PAD_VOX * 2);

  const grid = new Uint8Array(nx * ny * nz);
  const idx = (ix, iy, iz) => (ix * ny + iy) * nz + iz;

  const buckets = new Array(nx * ny);
  const triCount = (soup.length / 9) | 0;
  for (let t = 0; t < triCount; t++) {
    const i = t * 9;
    const ax = soup[i], ay = soup[i + 1];
    const bx = soup[i + 3], by = soup[i + 4];
    const cxp = soup[i + 6], cyp = soup[i + 7];
    const minXt = Math.min(ax, bx, cxp), maxXt = Math.max(ax, bx, cxp);
    const minYt = Math.min(ay, by, cyp), maxYt = Math.max(ay, by, cyp);
    const ix0 = Math.max(0, Math.floor((minXt - ox) / pitch) - 1);
    const ix1 = Math.min(nx - 1, Math.ceil((maxXt - ox) / pitch) + 1);
    const iy0 = Math.max(0, Math.floor((minYt - oy) / pitch) - 1);
    const iy1 = Math.min(ny - 1, Math.ceil((maxYt - oy) / pitch) + 1);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        const bi = ix * ny + iy;
        if (!buckets[bi]) buckets[bi] = [];
        buckets[bi].push(t);
      }
    }
  }

  const EPS = 1e-6;
  for (let ix = 0; ix < nx; ix++) {
    const cx = ox + (ix + 0.5) * pitch;
    for (let iy = 0; iy < ny; iy++) {
      const list = buckets[ix * ny + iy];
      if (!list || !list.length) continue;
      const cy = oy + (iy + 0.5) * pitch;
      const zs = [];
      for (let li = 0; li < list.length; li++) {
        const i = list[li] * 9;
        const ax = soup[i], ay = soup[i + 1], az = soup[i + 2];
        const bx = soup[i + 3], by = soup[i + 4], bz = soup[i + 5];
        const cxp = soup[i + 6], cyp = soup[i + 7], cz = soup[i + 8];
        if (!_thickenPointInTri2D(cx, cy, ax, ay, bx, by, cxp, cyp)) continue;
        const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
        const e2x = cxp - ax, e2y = cyp - ay, e2z = cz - az;
        const nX = e1y * e2z - e1z * e2y;
        const nY = e1z * e2x - e1x * e2z;
        const nZ = e1x * e2y - e1y * e2x;
        if (Math.abs(nZ) < EPS) continue;
        zs.push(az - (nX * (cx - ax) + nY * (cy - ay)) / nZ);
      }
      if (zs.length < 2) continue;
      zs.sort((a, b) => a - b);
      const uniq = [];
      for (let k = 0; k < zs.length; k++) {
        if (k === 0 || zs[k] - uniq[uniq.length - 1] > pitch * 0.1) uniq.push(zs[k]);
        else uniq[uniq.length - 1] = zs[k];
      }
      const pairCount = uniq.length - (uniq.length % 2);
      for (let k = 0; k < pairCount; k += 2) {
        const z0 = uniq[k], z1 = uniq[k + 1];
        const iz0 = Math.max(0, Math.ceil((z0 - oz) / pitch - 0.5));
        const iz1 = Math.min(nz - 1, Math.floor((z1 - oz) / pitch - 0.5));
        for (let iz = iz0; iz <= iz1; iz++) grid[idx(ix, iy, iz)] = 1;
      }
    }
  }
  return { grid, nx, ny, nz, ox, oy, oz, pitch, idx };
}

function _thickenClassifyExterior(vox) {
  const { grid, nx, ny, nz, idx } = vox;
  const exterior = new Uint8Array(nx * ny * nz);
  const total = nx * ny * nz;
  const qx = new Int32Array(total), qy = new Int32Array(total), qz = new Int32Array(total);
  let qh = 0, qt = 0;
  function tryPush(ix, iy, iz) {
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return;
    const id = idx(ix, iy, iz);
    if (grid[id] === 1 || exterior[id] === 1) return;
    exterior[id] = 1;
    qx[qt] = ix; qy[qt] = iy; qz[qt] = iz; qt++;
  }
  for (let ix = 0; ix < nx; ix++) for (let iy = 0; iy < ny; iy++) { tryPush(ix, iy, 0); tryPush(ix, iy, nz - 1); }
  for (let ix = 0; ix < nx; ix++) for (let iz = 0; iz < nz; iz++) { tryPush(ix, 0, iz); tryPush(ix, ny - 1, iz); }
  for (let iy = 0; iy < ny; iy++) for (let iz = 0; iz < nz; iz++) { tryPush(0, iy, iz); tryPush(nx - 1, iy, iz); }
  while (qh < qt) {
    const ix = qx[qh], iy = qy[qh], iz = qz[qh]; qh++;
    tryPush(ix + 1, iy, iz); tryPush(ix - 1, iy, iz);
    tryPush(ix, iy + 1, iz); tryPush(ix, iy - 1, iz);
    tryPush(ix, iy, iz + 1); tryPush(ix, iy, iz - 1);
  }
  return exterior;
}

function _thickenDilateInto(vox, allowMask, steps) {
  const { grid, nx, ny, nz, idx } = vox;
  let frontier = [];
  for (let ix = 0; ix < nx; ix++) for (let iy = 0; iy < ny; iy++) for (let iz = 0; iz < nz; iz++) {
    const id = idx(ix, iy, iz);
    if (grid[id] !== 1) continue;
    if (
      (ix + 1 < nx && grid[idx(ix + 1, iy, iz)] === 0 && allowMask[idx(ix + 1, iy, iz)]) ||
      (ix - 1 >= 0 && grid[idx(ix - 1, iy, iz)] === 0 && allowMask[idx(ix - 1, iy, iz)]) ||
      (iy + 1 < ny && grid[idx(ix, iy + 1, iz)] === 0 && allowMask[idx(ix, iy + 1, iz)]) ||
      (iy - 1 >= 0 && grid[idx(ix, iy - 1, iz)] === 0 && allowMask[idx(ix, iy - 1, iz)]) ||
      (iz + 1 < nz && grid[idx(ix, iy, iz + 1)] === 0 && allowMask[idx(ix, iy, iz + 1)]) ||
      (iz - 1 >= 0 && grid[idx(ix, iy, iz - 1)] === 0 && allowMask[idx(ix, iy, iz - 1)])
    ) frontier.push(id);
  }
  for (let s = 0; s < steps && frontier.length; s++) {
    const next = [];
    const seen = new Set();
    for (let fi = 0; fi < frontier.length; fi++) {
      const id = frontier[fi];
      const iz = id % nz;
      const iy = ((id - iz) / nz) % ny;
      const ix = (id - iz - iy * nz) / (nz * ny);
      const nb = [[ix + 1, iy, iz], [ix - 1, iy, iz], [ix, iy + 1, iz], [ix, iy - 1, iz], [ix, iy, iz + 1], [ix, iy, iz - 1]];
      for (let k = 0; k < 6; k++) {
        const nxp = nb[k][0], nyp = nb[k][1], nzp = nb[k][2];
        if (nxp < 0 || nyp < 0 || nzp < 0 || nxp >= nx || nyp >= ny || nzp >= nz) continue;
        const nid = idx(nxp, nyp, nzp);
        if (grid[nid] === 1 || !allowMask[nid] || seen.has(nid)) continue;
        seen.add(nid);
        grid[nid] = 1;
        next.push(nid);
      }
    }
    frontier = next;
  }
}

function _thickenSoupFromVoxels(vox) {
  const { grid, nx, ny, nz, ox, oy, oz, pitch, idx } = vox;
  const out = [];
  function solidAt(ix, iy, iz) {
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return 0;
    return grid[idx(ix, iy, iz)];
  }
  function push6(v0, v1, v2, v3) {
    out.push(v0[0], v0[1], v0[2], v1[0], v1[1], v1[2], v2[0], v2[1], v2[2]);
    out.push(v0[0], v0[1], v0[2], v2[0], v2[1], v2[2], v3[0], v3[1], v3[2]);
  }
  for (let ix = 0; ix < nx; ix++) for (let iy = 0; iy < ny; iy++) for (let iz = 0; iz < nz; iz++) {
    if (!solidAt(ix, iy, iz)) continue;
    const x0 = ox + ix * pitch, x1 = x0 + pitch;
    const y0 = oy + iy * pitch, y1 = y0 + pitch;
    const z0 = oz + iz * pitch, z1 = z0 + pitch;
    if (!solidAt(ix + 1, iy, iz)) push6([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
    if (!solidAt(ix - 1, iy, iz)) push6([x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]);
    if (!solidAt(ix, iy + 1, iz)) push6([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]);
    if (!solidAt(ix, iy - 1, iz)) push6([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
    if (!solidAt(ix, iy, iz + 1)) push6([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
    if (!solidAt(ix, iy, iz - 1)) push6([x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]);
  }
  return out.length >= 9 ? new Float32Array(out) : null;
}

// ---- main entry ----

function thickenSelectedModel(mode, offsetMm) {
  const m = getActiveModel();
  if (!m) { setStatus('Select a piece first', true); return; }
  if (!(offsetMm > 0)) { setStatus('Thicken failed - enter a positive mm value', true); return; }

  function localSoupFromGeometry(geo) {
    if (!geo || !geo.attributes || !geo.attributes.position) return null;
    const pos = geo.attributes.position;
    const index = geo.index;
    const out = [];
    if (index) {
      for (let i = 0; i < index.count; i++) {
        const vi = index.getX(i);
        out.push(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
      }
    } else {
      for (let i = 0; i < pos.count; i++) out.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    }
    return out.length >= 9 ? new Float32Array(out) : null;
  }

  const usingRaw = !!(m.rawTris && m.rawAxis === 'zup');
  const soupIn = usingRaw ? m.rawTris : localSoupFromGeometry(m.geometry);
  if (!soupIn || soupIn.length < 9) { setStatus('Thicken failed - piece unchanged', true); return; }

  let openBefore = null, nmBefore = null;
  try { openBefore = openBoundaryEdges(soupIn).length; } catch (e) {}
  try { if (typeof countNonManifoldEdges === 'function') nmBefore = countNonManifoldEdges(soupIn); } catch (e) {}

  let closedSoup = soupIn;
  try { closedSoup = weldSoupVerts(closedSoup); } catch (e) {}
  try { if (typeof capSmallOpenLoops === 'function') closedSoup = capSmallOpenLoops(closedSoup, 28); } catch (e) {}

  let openCheck = null;
  try { openCheck = openBoundaryEdges(closedSoup).length; } catch (e) {}
  // Slots (cups, USB) are leftover open loops on purpose. Only refuse
  // a shredded soup (no triangles) — not a bar that still has holes.
  if (!closedSoup || closedSoup.length < 9) {
    setStatus('Thicken ' + mode + ' ' + offsetMm + ' failed - piece unchanged', true);
    return;
  }

  let working = null;
  try {
    const bb = _thickenBBoxOfSoup(closedSoup);
    const pitch = _thickenChoosePitch(bb, offsetMm);
    const vox = _thickenVoxelize(closedSoup, pitch);
    const exterior = _thickenClassifyExterior(vox);
    const steps = Math.max(1, Math.round(offsetMm / pitch));
    if (mode === 'out') {
      _thickenDilateInto(vox, exterior, steps);
    } else {
      const interior = new Uint8Array(exterior.length);
      for (let i = 0; i < interior.length; i++) interior[i] = (vox.grid[i] === 0 && exterior[i] === 0) ? 1 : 0;
      _thickenDilateInto(vox, interior, steps);
    }
    working = _thickenSoupFromVoxels(vox);
    if (working) { try { working = weldSoupVerts(working); } catch (e) {} }
  } catch (e) {
    working = null;
  }

  if (!working || working.length < 9) {
    setStatus('Thicken ' + mode + ' ' + offsetMm + ' failed - piece unchanged', true);
    return;
  }

  pushUndo({
    type: 'thickenReplace',
    modelId: m.id,
    prevGeometry: m.geometry.clone(),
    prevRawTris: m.rawTris,
    prevRawAxis: m.rawAxis,
    prevCenterOffset: m.centerOffset,
    prevSize: { x: m.size.x, y: m.size.y, z: m.size.z }
  });

  let newGeo;
  if (usingRaw) newGeo = rawResultToDisplayGeometry(working);
  else newGeo = soupToCenteredGeo(working);
  newGeo.computeBoundingBox();
  const size2 = new THREE.Vector3();
  newGeo.boundingBox.getSize(size2);
  m.geometry = newGeo;
  if (usingRaw) {
    m.rawTris = working;
    m.rawAxis = 'zup';
    m.centerOffset = computeCenterOffsetFromRaw(working);
  }
  m.size = { x: size2.x, y: size2.y, z: size2.z };

  const placedEntry = state.placed.find(p => p && p.sourceId === m.id);
  if (placedEntry) {
    const px = placedEntry.x, pz = placedEntry.z;
    if (placedEntry.mesh && state.modelGroup) {
      state.modelGroup.remove(placedEntry.mesh);
      if (placedEntry.mesh.material) {
        if (Array.isArray(placedEntry.mesh.material)) placedEntry.mesh.material.forEach(mt => mt.dispose());
        else placedEntry.mesh.material.dispose();
      }
    }
    const mat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8, metalness: 0.05, roughness: 0.4,
      emissive: 0x0a3a5c, emissiveIntensity: 0.25
    });
    const mesh = new THREE.Mesh(m.geometry, mat);
    mesh.position.set(px, m.size.y / 2 + 0.3, pz);
    mesh.userData.sourceId = m.id;
    mesh.userData.placedIndex = state.placed.indexOf(placedEntry);
    state.modelGroup.add(mesh);
    placedEntry.mesh = mesh;
    placedEntry.geometry = m.geometry;
    placedEntry.width = m.size.x;
    placedEntry.depth = m.size.z;
    placedEntry.height = m.size.y;
    settlePlacedOnBed(placedEntry);
  }

  let openAfter = null, nmAfter = null;
  try { openAfter = openBoundaryEdges(working).length; } catch (e) {}
  try { if (typeof countNonManifoldEdges === 'function') nmAfter = countNonManifoldEdges(working); } catch (e) {}
  let msg = 'Thicken ' + mode + ' ' + offsetMm + ' - open ' + (openBefore == null ? '?' : openBefore) + '\u2192' + (openAfter == null ? '?' : openAfter);
  if (nmBefore != null && nmAfter != null) msg += ', NM ' + nmBefore + '\u2192' + nmAfter;
  setStatus(msg);
}

function thickenOutSelectedModel() {
  const inp = document.getElementById('inp-thicken-mm');
  const v = inp ? parseFloat(inp.value) : NaN;
  thickenSelectedModel('out', isFinite(v) && v > 0 ? v : 1.5);
}

function thickenInSelectedModel() {
  const inp = document.getElementById('inp-thicken-in') || document.getElementById('inp-thicken-mm');
  const v = inp ? parseFloat(inp.value) : NaN;
  thickenSelectedModel('in', isFinite(v) && v > 0 ? v : 1.5);
}

// ===================== Whole-solid wrap =====================
//
// One bake, every edge and corner of the piece at once. The per-face path
// walks one face after another, so the third face of a cube arrives at an edge
// the first two already rounded and has nothing left to build against. This
// path never meets that problem: it throws the old surface away and rebuilds
// the solid from its own box, so shared edges and three-edge vertices are
// solved once for the whole solid rather than negotiated face by face.
//
// A box wrapped at radius R is the offset of the box shrunk by R:
//
//   6 flat faces  on the original planes, inset R all round
//   12 cylinders  radius R along the shrunk box's edges
//   8 octants     radius R at the shrunk box's corners
//
// tangent to one another everywhere, by construction rather than by fitting.
// Bevel is the SAME surface with one arc sample: a quarter circle sampled once
// is its chord, which is the 45 degree chamfer, and the spherical octant
// collapses to the corner facet. Corners is the odd one out - vertices only,
// every edge left a knife - so it gets its own face and octant shapes.
//
// Every point of every patch comes out of one generator per mode, so the seams
// are the same numbers on both sides and cannot drift.

// A plain box, or null. Every triangle has to lie flat on one of the six bbox
// planes AND the six faces have to add up to the box's own surface area - a
// shell with a hole fails the area test, a dented one fails the flatness test.
function rawSolidBox(rawTris, tol) {
  tol = tol || 1e-3;
  if (!rawTris || rawTris.length < 9 * 12) return null;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < rawTris.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (rawTris[i+k] < lo[k]) lo[k] = rawTris[i+k];
      if (rawTris[i+k] > hi[k]) hi[k] = rawTris[i+k];
    }
  }
  const ext = [hi[0]-lo[0], hi[1]-lo[1], hi[2]-lo[2]];
  if (!(ext[0] > tol && ext[1] > tol && ext[2] > tol)) return null;
  const area = [0, 0, 0, 0, 0, 0];
  const n = rawTris.length / 9;
  for (let t = 0; t < n; t++) {
    const i = t * 9;
    let f = -1;
    for (let g = 0; g < 6 && f < 0; g++) {
      const ax = g >> 1, v = (g & 1) ? hi[ax] : lo[ax];
      if (Math.abs(rawTris[i+ax] - v) < tol &&
          Math.abs(rawTris[i+3+ax] - v) < tol &&
          Math.abs(rawTris[i+6+ax] - v) < tol) f = g;
    }
    if (f < 0) return null;
    const ux = rawTris[i+3]-rawTris[i], uy = rawTris[i+4]-rawTris[i+1], uz = rawTris[i+5]-rawTris[i+2];
    const vx = rawTris[i+6]-rawTris[i], vy = rawTris[i+7]-rawTris[i+1], vz = rawTris[i+8]-rawTris[i+2];
    area[f] += 0.5 * Math.hypot(uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx);
  }
  for (let g = 0; g < 6; g++) {
    const ax = g >> 1, o = [0,1,2].filter(a => a !== ax);
    const want = ext[o[0]] * ext[o[1]];
    if (Math.abs(area[g] - want) > Math.max(tol, want * 1e-4)) return null;
  }
  return { lo: lo, hi: hi, ext: ext };
}

// Every axis-aligned box-shaped pocket in a soup, whichever shape the piece
// around them is. This is what lets a Subtract into a real part be wrapped:
// the hull is never re-generated, only cut, so whatever the piece is outside
// the pocket comes through untouched and a painted face cannot move.
//
// A pocket is a cluster of faces that bound a box, with one side open - the
// side it breaks the surface on - and every side it does carry a full
// rectangle. Anything less exact is not returned: a cluster that is only
// nearly a box is some other shape, and cutting a box out of it would take
// away material the owner did not ask for.
function rawBoxPockets(rawTris, skip) {
  const tol = 1e-3;
  if (!rawTris || rawTris.length < 9 * 12) return [];
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < rawTris.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (rawTris[i+k] < lo[k]) lo[k] = rawTris[i+k];
      if (rawTris[i+k] > hi[k]) hi[k] = rawTris[i+k];
    }
  }
  // one entry per plane, with the area it carries and the box it spans
  const planes = new Map();
  for (let t = 0; t + 8 < rawTris.length; t += 9) {
    const ux = rawTris[t+3]-rawTris[t], uy = rawTris[t+4]-rawTris[t+1], uz = rawTris[t+5]-rawTris[t+2];
    const vx = rawTris[t+6]-rawTris[t], vy = rawTris[t+7]-rawTris[t+1], vz = rawTris[t+8]-rawTris[t+2];
    let nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
    const L = Math.hypot(nx, ny, nz);
    if (!(L > 1e-12)) continue;
    const n = [nx/L, ny/L, nz/L], na = [Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])];
    let a = 0;
    if (na[1] > na[a]) a = 1;
    if (na[2] > na[a]) a = 2;
    if (na[a] < 0.999) return [];            // a curve anywhere: not this shape
    const sg = n[a] >= 0 ? 1 : -1, at = rawTris[t+a];
    const key = a + ':' + sg + ':' + Math.round(at / tol);
    let g = planes.get(key);
    if (!g) {
      g = { a: a, sg: sg, at: at, area: 0,
            lo: [Infinity,Infinity,Infinity], hi: [-Infinity,-Infinity,-Infinity] };
      planes.set(key, g);
    }
    g.area += 0.5 * L;
    for (let v = 0; v < 3; v++) for (let k = 0; k < 3; k++) {
      const c = rawTris[t + v*3 + k];
      if (c < g.lo[k]) g.lo[k] = c;
      if (c > g.hi[k]) g.hi[k] = c;
    }
  }
  // only faces inside the piece, and only ones the paint has left alone
  const inner = [];
  planes.forEach(function (g) {
    if (Math.abs(g.at - (g.sg > 0 ? hi[g.a] : lo[g.a])) < tol) return;   // an outer face
    if (skip && skip(g.a, g.sg < 0, g.at)) return;                       // painted out
    inner.push(g);
  });
  if (!inner.length) return [];

  // clusters of faces that touch: one pocket's faces all bound the same box,
  // and two pockets on opposite sides of a part do not reach each other
  const seen = new Array(inner.length).fill(-1);
  const touch = function (p, q) {
    for (let k = 0; k < 3; k++) if (!(p.lo[k] <= q.hi[k] + tol && q.lo[k] <= p.hi[k] + tol)) return false;
    return true;
  };
  const out = [];
  for (let i = 0; i < inner.length; i++) {
    if (seen[i] >= 0) continue;
    const grp = [], stack = [i];
    seen[i] = out.length;
    while (stack.length) {
      const x = stack.pop();
      grp.push(inner[x]);
      for (let j = 0; j < inner.length; j++)
        if (seen[j] < 0 && touch(inner[x], inner[j])) { seen[j] = out.length; stack.push(j); }
    }
    const blo = [Infinity,Infinity,Infinity], bhi = [-Infinity,-Infinity,-Infinity];
    for (let g = 0; g < grp.length; g++) for (let k = 0; k < 3; k++) {
      if (grp[g].lo[k] < blo[k]) blo[k] = grp[g].lo[k];
      if (grp[g].hi[k] > bhi[k]) bhi[k] = grp[g].hi[k];
    }
    // every side this cluster carries has to be the whole side of that box,
    // and exactly one side has to be missing - the one it opens through
    let openAxis = -1, openSide = -1, good = true, sides = 0;
    const faces = [];
    for (let a = 0; a < 3 && good; a++) for (let sd = 0; sd < 2 && good; sd++) {
      const plane = sd ? bhi[a] : blo[a], want = sd ? -1 : 1;
      const o = [0,1,2].filter(function (k) { return k !== a; });
      const area = (bhi[o[0]] - blo[o[0]]) * (bhi[o[1]] - blo[o[1]]);
      let f = null;
      for (let g = 0; g < grp.length; g++)
        if (grp[g].a === a && grp[g].sg === want && Math.abs(grp[g].at - plane) < tol) f = grp[g];
      if (!f) {
        if (openAxis >= 0) { good = false; break; }     // two open sides: not a pocket
        openAxis = a; openSide = sd;
      } else {
        if (Math.abs(f.area - area) > Math.max(tol, area * 1e-4)) { good = false; break; }
        sides++;
        faces.push({ axisIdx: a, keepMin: want < 0, at: plane });
      }
    }
    if (!good || openAxis < 0 || sides !== 5) continue;
    if (!(bhi[0]-blo[0] > tol && bhi[1]-blo[1] > tol && bhi[2]-blo[2] > tol)) continue;
    out.push({ lo: blo, hi: bhi, openAxis: openAxis, openSide: openSide, faces: faces });
  }
  return out;
}

// A plain box with ONE axis-aligned pocket cut through one of its faces, or
// null. This is the shape a Subtract with a box bit leaves, and it is the only
// non-box the wrap will touch: everything it returns is checked back against
// the soup's own measured face areas, so a piece that is nearly this shape but
// not quite is refused rather than guessed at. Returns the hull box, the
// pocket box, and which hull face the pocket opens through.
function rawPocketBrick(rawTris, tol) {
  tol = tol || 1e-3;
  if (!rawTris || rawTris.length < 9 * 12) return null;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < rawTris.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (rawTris[i+k] < lo[k]) lo[k] = rawTris[i+k];
      if (rawTris[i+k] > hi[k]) hi[k] = rawTris[i+k];
    }
  }
  const ext = [hi[0]-lo[0], hi[1]-lo[1], hi[2]-lo[2]];
  if (!(ext[0] > tol && ext[1] > tol && ext[2] > tol)) return null;
  // group every triangle by the plane it lies on; a single triangle that is
  // not axis aligned means this is not the shape
  const planes = new Map();
  const n = rawTris.length / 9;
  for (let t = 0; t < n; t++) {
    const i = t * 9;
    const ux = rawTris[i+3]-rawTris[i], uy = rawTris[i+4]-rawTris[i+1], uz = rawTris[i+5]-rawTris[i+2];
    const vx = rawTris[i+6]-rawTris[i], vy = rawTris[i+7]-rawTris[i+1], vz = rawTris[i+8]-rawTris[i+2];
    let nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
    const L = Math.hypot(nx, ny, nz);
    if (!(L > 1e-12)) continue;               // slivers carry no face
    nx /= L; ny /= L; nz /= L;
    const na = [Math.abs(nx), Math.abs(ny), Math.abs(nz)];
    let a = 0;
    if (na[1] > na[a]) a = 1;
    if (na[2] > na[a]) a = 2;
    if (na[a] < 0.999) return null;
    const sg = ([nx, ny, nz][a] >= 0) ? 1 : -1;
    const at = rawTris[i+a];
    if (Math.abs(rawTris[i+3+a] - at) > tol || Math.abs(rawTris[i+6+a] - at) > tol) return null;
    const key = a + ':' + sg + ':' + Math.round(at / tol);
    let g = planes.get(key);
    if (!g) { g = { a: a, sg: sg, at: at, area: 0 }; planes.set(key, g); }
    g.area += 0.5 * L;
  }
  // the outer six, and whatever is left inside
  const outer = {}, inner = [];
  planes.forEach(function (g) {
    const face = (g.sg > 0) ? hi[g.a] : lo[g.a];
    if (Math.abs(g.at - face) < tol) outer[g.a + ':' + g.sg] = g;
    else inner.push(g);
  });
  for (let a = 0; a < 3; a++) for (const sg of [-1, 1]) if (!outer[a + ':' + sg]) return null;
  if (!inner.length) return null;             // a plain box - not this shape
  if (inner.length !== 5) return null;        // one box pocket has five faces

  // four walls on two axes, one floor on the third: that third axis is the
  // one the pocket opens along
  const byAxis = [[], [], []];
  for (const g of inner) byAxis[g.a].push(g);
  let mouthAxis = -1;
  for (let a = 0; a < 3; a++) {
    if (byAxis[a].length === 1) { if (mouthAxis >= 0) return null; mouthAxis = a; }
    else if (byAxis[a].length !== 2) return null;
  }
  if (mouthAxis < 0) return null;

  const plo = [0, 0, 0], phi = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    if (a === mouthAxis) continue;
    const g = byAxis[a];
    // the pocket is between them: the low wall faces up the axis, the high
    // wall faces down it
    const up = g.find(function (q) { return q.sg > 0; });
    const dn = g.find(function (q) { return q.sg < 0; });
    if (!up || !dn) return null;
    plo[a] = up.at; phi[a] = dn.at;
    if (!(phi[a] - plo[a] > tol)) return null;
    if (!(plo[a] > lo[a] + tol && phi[a] < hi[a] - tol)) return null;   // must not break the side walls
  }
  const floor = byAxis[mouthAxis][0];
  const mouthSide = (floor.sg > 0) ? 1 : 0;   // floor faces the way the pocket opens
  if (mouthSide) { plo[mouthAxis] = floor.at; phi[mouthAxis] = hi[mouthAxis]; }
  else { plo[mouthAxis] = lo[mouthAxis]; phi[mouthAxis] = floor.at; }
  if (!(phi[mouthAxis] - plo[mouthAxis] > tol)) return null;

  // now prove it: every face area the soup actually carries has to be the
  // area this hull and this pocket would give. Anything else and the piece is
  // some other shape that happens to have eleven flat faces.
  const pext = [phi[0]-plo[0], phi[1]-plo[1], phi[2]-plo[2]];
  const other = function (a) { return [0,1,2].filter(function (x) { return x !== a; }); };
  const mouthKey = mouthAxis + ':' + (mouthSide ? 1 : -1);
  for (let a = 0; a < 3; a++) for (const sg of [-1, 1]) {
    const o = other(a);
    let want = ext[o[0]] * ext[o[1]];
    if (a + ':' + sg === mouthKey) want -= pext[o[0]] * pext[o[1]];
    const g = outer[a + ':' + sg];
    if (Math.abs(g.area - want) > Math.max(tol, want * 1e-4)) return null;
  }
  for (const g of inner) {
    const o = other(g.a);
    const want = pext[o[0]] * pext[o[1]];
    if (Math.abs(g.area - want) > Math.max(tol, want * 1e-4)) return null;
  }
  return {
    lo: lo, hi: hi, ext: ext,
    plo: plo, phi: phi, pext: pext,
    mouthAxis: mouthAxis, mouthSide: mouthSide
  };
}

// How well sealed a soup is: unmatched edges AND edges used more than twice.
// openBoundaryEdges alone is not enough here - it welds at 1e-3, only reports
// count exactly 1, and counts the zero-length edge a sliver triangle leaves
// as a hole. Those slivers are harmless and some are emitted on purpose, so
// they are skipped; a face that clashes with an already softened one shows up
// as extra open edges, extra non-manifold ones, or both. Lifted out of the
// Soften click so the pocket-brick wrap is gated on exactly the same number.
function nsoSealScore(soup) {
  const q = 1e4;
  const vk = (i) => Math.round(soup[i]*q)+'|'+Math.round(soup[i+1]*q)+'|'+Math.round(soup[i+2]*q);
  const use = new Map();
  for (let t = 0; t + 8 < soup.length; t += 9) {
    const K = [vk(t), vk(t+3), vk(t+6)];
    for (let e = 0; e < 3; e++) {
      const a = K[e], b = K[(e+1)%3];
      if (a === b) continue;
      const k = a < b ? a+'~'+b : b+'~'+a;
      use.set(k, (use.get(k) || 0) + 1);
    }
  }
  let open = 0, nm = 0;
  use.forEach(function (c) { if (c % 2) open++; if (c > 2) nm++; });
  return { open: open, nm: nm };
}

// A box as soup, 12 triangles, outward wound. Feeds the wrap generator the
// hull and the pocket as the plain boxes they are.
function rawBoxSoup(lo, hi) {
  const V = [[lo[0],lo[1],lo[2]],[hi[0],lo[1],lo[2]],[hi[0],hi[1],lo[2]],[lo[0],hi[1],lo[2]],
             [lo[0],lo[1],hi[2]],[hi[0],lo[1],hi[2]],[hi[0],hi[1],hi[2]],[lo[0],hi[1],hi[2]]];
  const F = [[0,3,2],[0,2,1],[4,5,6],[4,6,7],[0,1,5],[0,5,4],
             [1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
  const out = new Float32Array(F.length * 9);
  for (let f = 0; f < F.length; f++) for (let v = 0; v < 3; v++) for (let k = 0; k < 3; k++)
    out[f*9 + v*3 + k] = V[F[f][v]][k];
  return out;
}

// The skip list sorted onto the two boxes the brick is made of. Every painted
// face has to land on one of them; one that lands on neither means the paint
// and the piece have drifted apart - an undone Subtract, say - and the caller
// leaves the mesh alone and says so rather than wrapping the wrong thing.
function brickSkipLists(brick, faceList, soup) {
  // Wide enough that float drift between the display span the click was
  // measured against and the raw span it was converted to can never decide
  // this, tight enough that it can only ever land on the face it means: the
  // hull plane and the pocket plane on one axis and side are the pocket's
  // depth apart, which is millimetres.
  const span = Math.max(brick.ext[0], brick.ext[1], brick.ext[2]);
  const tol = Math.max(0.05, 0.005 * span);
  const hull = [[false,false],[false,false],[false,false]];
  const pocket = [[false,false],[false,false],[false,false]];
  let nHull = 0, nPocket = 0;
  for (let i = 0; i < faceList.length; i++) {
    const e = faceList[i], a = e.axisIdx, k = !!e.keepMin;
    const at = k ? -e.d : e.d;
    const dHull = Math.abs(at - (k ? brick.lo[a] : brick.hi[a]));
    const dPocket = Math.abs(at - (k ? brick.phi[a] : brick.plo[a]));
    if (dHull <= dPocket && dHull < tol) { hull[a][k ? 0 : 1] = true; nHull++; continue; }
    // Not the outer plane on this axis and side, so on a piece this shape it
    // is the pocket's - there is exactly one of each. The question the piece
    // gets asked is the owner's: is that plane still on the soup? If it is,
    // it is a face they really did paint and the wrap skips it. Only a plane
    // the soup no longer carries stops the wrap.
    if (rawHasPlane(soup, a, k, at)) {
      // a wall the material faces across: normal up the axis means the pocket
      // is above it, so it is the pocket box's low face on that axis
      pocket[a][k ? 1 : 0] = true; nPocket++;
      if (dPocket > tol) {
        console.log('[soften] painted plane ' + at.toFixed(4) + ' on axis ' + a +
                    ' is live but ' + dPocket.toFixed(4) + 'mm off the pocket box - skipping it anyway');
      }
      continue;
    }
    return { bad: e, at: at };
  }
  return { hull: hull, pocket: pocket, nHull: nHull, nPocket: nPocket };
}

// Add one soup to another with the kernel the app already carries.
async function nsoUnionSoups(aSoup, bSoup) {
  if (typeof NSO_CSG === 'undefined') return { ok: false, reason: 'no CSG kernel in this build' };
  let wasm;
  try { wasm = await NSO_CSG.load(); }
  catch (err) { return { ok: false, reason: 'CSG kernel failed to load: ' + (err && err.message ? err.message : err) }; }
  let A = null, B = null, out = null;
  try {
    A = NSO_CSG.soupToManifold(wasm, aSoup);
    B = NSO_CSG.soupToManifold(wasm, bSoup);
    out = A.add(B);
    if (out.status() !== 'NoError') throw new Error('kernel refused the fill: ' + out.status());
    if (out.isEmpty()) throw new Error('the fill produced nothing');
    return { ok: true, soup: NSO_CSG.manifoldToSoup(out) };
  } catch (err) {
    return { ok: false, reason: (err && err.message ? err.message : String(err)) };
  } finally {
    if (A) A.delete();
    if (B) B.delete();
    if (out) out.delete();
  }
}

// Subtract one soup from another with the kernel the app already carries.
// Nothing here reaches into the kernel; it is the same adapter Subtract and
// Join use, called on two boxes this file generated.
async function nsoSubtractSoups(aSoup, bSoup) {
  if (typeof NSO_CSG === 'undefined') return { ok: false, reason: 'no CSG kernel in this build' };
  let wasm;
  try { wasm = await NSO_CSG.load(); }
  catch (err) { return { ok: false, reason: 'CSG kernel failed to load: ' + (err && err.message ? err.message : err) }; }
  let A = null, B = null, out = null;
  try {
    A = NSO_CSG.soupToManifold(wasm, aSoup);
    if (A.status && A.status() !== 'NoError') throw new Error('hull rejected: ' + A.status());
    B = NSO_CSG.soupToManifold(wasm, bSoup);
    if (B.status && B.status() !== 'NoError') throw new Error('pocket rejected: ' + B.status());
    out = A.subtract(B);
    if (out.status() !== 'NoError') throw new Error('kernel refused the cut: ' + out.status());
    if (out.isEmpty()) throw new Error('the cut left nothing');
    return { ok: true, soup: NSO_CSG.manifoldToSoup(out) };
  } catch (err) {
    return { ok: false, reason: (err && err.message ? err.message : String(err)) };
  } finally {
    if (A) A.delete();
    if (B) B.delete();
    if (out) out.delete();
  }
}

// The whole-solid wrap for a brick: the hull wrapped by the same generator a
// plain box uses, with the pocket - wrapped by that same generator - taken
// back out of it. No new surface is invented and the wrap modes are not
// touched; the skip list is simply read twice, once per box. The pocket is
// pushed out past the mouth so the generator's rounding on that end lands
// outside the hull and the rim stays the edge the hull face makes with the
// wall.
async function nsoWrapBrick(brick, R, mode, skip) {
  const hullSoup = rawWrapSolid(rawBoxSoup(brick.lo, brick.hi), R, mode, skip.hull);
  const hullBuild = rawWrapSolid.lastBuild;
  const plo = brick.plo.slice(), phi = brick.phi.slice();
  const over = 2 * R + 1;
  if (brick.mouthSide) phi[brick.mouthAxis] += over; else plo[brick.mouthAxis] -= over;
  const pSkip = [skip.pocket[0].slice(), skip.pocket[1].slice(), skip.pocket[2].slice()];
  pSkip[brick.mouthAxis][brick.mouthSide ? 1 : 0] = true;   // the end outside the hull
  const pocketSoup = rawWrapSolid(rawBoxSoup(plo, phi), R, mode, pSkip);
  const pocketBuild = rawWrapSolid.lastBuild;
  const cut = await nsoSubtractSoups(hullSoup, pocketSoup);
  if (!cut.ok) return cut;
  return { ok: true, soup: cut.soup, hullBuild: hullBuild, pocketBuild: pocketBuild };
}

// The paint, read as box faces: [axis][side] with side 0 the low plane. This
// is a read, not a derivation - nsoMaskFaces hands back the raw axis and side
// each paint click recorded at the moment it was made, the same numbers the
// same click would have given the Soften pick. Nothing here works out which
// face was meant from a plane and a bounding box, because that is the second
// mapping that put the yellow on the side and the exclude on the top.
// Null when a painted face is a recessed wall, which has no axis and side to
// name; the caller then leaves the whole-solid wrap alone.
function maskedBoxFaces(m) {
  return (typeof nsoMaskFaces === 'function') ? nsoMaskFaces(m)
                                              : [[false,false],[false,false],[false,false]];
}

// `squareFaces` is that same paint: [axis][side], true where a face has been
// painted out. Those faces come out exactly as they went in - flat, full size,
// on their own plane - and every other face, edge and corner wraps as usual.
function rawWrapSolid(rawTris, requestedR, mode, squareFaces) {
  const box = rawSolidBox(rawTris);
  if (!box) throw new Error('wrap needs a plain box - this piece is not one, left unchanged');
  const lo = box.lo, hi = box.hi, ext = box.ext;
  const R = Math.min(requestedR, 0.45 * Math.min(ext[0], ext[1], ext[2]));
  if (!(R > 1e-3)) throw new Error('R=' + requestedR + ' leaves nothing to wrap - left unchanged');

  const NA = (mode === 'chamfer') ? 1 : 12;   // arc samples per 90 degrees
  // A painted face is not a second code path: it is a radius of zero toward
  // that face. RR[a][s] is how far this solid rolls off toward face (a, s),
  // so the shrunk box IN meets the outer plane OUT flush on a painted side,
  // and the ball, the cylinder and the face patch there each degenerate on
  // their own into the flat piece of that face. One generator still, and the
  // seams stay the same numbers on both sides because they always were.
  const SQ = [[0,0],[0,0],[0,0]];
  if (squareFaces) {
    for (let a = 0; a < 3; a++) for (let s = 0; s < 2; s++)
      SQ[a][s] = (squareFaces[a] && squareFaces[a][s]) ? 1 : 0;
  }
  const RR = [[SQ[0][0] ? 0 : R, SQ[0][1] ? 0 : R],
              [SQ[1][0] ? 0 : R, SQ[1][1] ? 0 : R],
              [SQ[2][0] ? 0 : R, SQ[2][1] ? 0 : R]];
  const IN  = [[lo[0]+RR[0][0], hi[0]-RR[0][1]],
               [lo[1]+RR[1][0], hi[1]-RR[1][1]],
               [lo[2]+RR[2][0], hi[2]-RR[2][1]]];
  const OUT = [[lo[0], hi[0]], [lo[1], hi[1]], [lo[2], hi[2]]];
  const S = [-1, 1];
  // A ball only exists where all three of its faces wrap. Where one of them
  // is painted out the vertex stays a box corner and the faces meeting there
  // run full width into it.
  const ball = (i, j, k) => !SQ[0][i] && !SQ[1][j] && !SQ[2][k];
  const mid = [(lo[0]+hi[0])/2, (lo[1]+hi[1])/2, (lo[2]+hi[2])/2];
  const out = [];
  let tri = 0;
  // The wrapped box is convex, so "away from the centre" is outward everywhere.
  const put = (A, B, C) => {
    const ux=B[0]-A[0], uy=B[1]-A[1], uz=B[2]-A[2];
    const vx=C[0]-A[0], vy=C[1]-A[1], vz=C[2]-A[2];
    const nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx;
    if (0.5 * Math.hypot(nx, ny, nz) < 1e-12) return;
    const mx=(A[0]+B[0]+C[0])/3-mid[0], my=(A[1]+B[1]+C[1])/3-mid[1], mz=(A[2]+B[2]+C[2])/3-mid[2];
    if (nx*mx + ny*my + nz*mz < 0) out.push(A[0],A[1],A[2], C[0],C[1],C[2], B[0],B[1],B[2]);
    else out.push(A[0],A[1],A[2], B[0],B[1],B[2], C[0],C[1],C[2]);
    tri++;
  };
  const quad = (A, B, C, D) => { put(A, B, C); put(A, C, D); };

  if (mode === 'corners') {
    // ---- vertices only: a ball at each of the 8 corners, edges left square ----
    // Sphere centre Rc in from all three planes, radius Rc*sqrt(2), so the
    // circle it cuts in each of the three faces comes out at exactly Rc and
    // dies on the tangent points Rc along each edge. Same construction the
    // per-face Corners mode uses, run on all 8 vertices at once.
    //
    // The patch is the piece of that sphere still inside the box: in the ball's
    // own frame, every direction component at most c = 1/sqrt(2). Walk it in
    // rows of constant third component w, from w = 0 (the tangent point on the
    // third edge, a single point) up to w = c (the whole arc in the third
    // face). On each row the two limits n1 <= c and n2 <= c give the exact
    // angle range, so all three boundaries come out ON their face circles.
    // Blending the corners barycentrically instead would bulge the surface
    // OUT through the faces - a great circle between two points of a small
    // circle leaves it - which is what the bbox catches.
    const Rs = R * Math.SQRT2;
    const c = 1 / Math.SQRT2;
    const bp = (i, j, k, m, s) => {
      const w = c * (m / NA);
      const rho = Math.sqrt(Math.max(0, 1 - w*w));
      const t = Math.max(-1, Math.min(1, c / (rho || 1e-12)));
      const a0 = Math.acos(t), a1 = Math.asin(t);
      const al = m > 0 ? a0 + (a1 - a0) * (s / m) : a0;
      return [IN[0][i] + S[i] * Rs * rho * Math.cos(al),
              IN[1][j] + S[j] * Rs * rho * Math.sin(al),
              IN[2][k] + S[k] * Rs * w];
    };
    // the ball's arc in face `a`, the one the face has to share with it
    const ballArc = (a, i, j, k, q) => (a === 0 ? bp(i,j,k,q,0)
                                     : a === 1 ? bp(i,j,k,q,q)
                                               : bp(i,j,k,NA,q));
    // ---- the 8 balls ----
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) {
      if (!ball(i, j, k)) continue;
      for (let m = 0; m < NA; m++) {
        for (let s = 0; s <= m; s++) put(bp(i,j,k,m,s), bp(i,j,k,m+1,s), bp(i,j,k,m+1,s+1));
        for (let s = 0; s + 1 <= m; s++) put(bp(i,j,k,m,s), bp(i,j,k,m+1,s+1), bp(i,j,k,m,s+1));
      }
    }
    // ---- the 6 faces: a rectangle with a quarter disc bitten out of each corner ----
    for (let a = 0; a < 3; a++) {
      const o = [0,1,2].filter(x => x !== a);
      const b = o[0], cc = o[1];
      for (let sa = 0; sa < 2; sa++) {
        const P = (vb, vc) => { const p = [0,0,0]; p[a] = OUT[a][sa]; p[b] = vb; p[cc] = vc; return p; };
        quad(P(IN[b][0], IN[cc][0]), P(IN[b][1], IN[cc][0]), P(IN[b][1], IN[cc][1]), P(IN[b][0], IN[cc][1]));
        for (let sb = 0; sb < 2; sb++)
          quad(P(IN[b][sb], IN[cc][0]), P(OUT[b][sb], IN[cc][0]), P(OUT[b][sb], IN[cc][1]), P(IN[b][sb], IN[cc][1]));
        for (let sc = 0; sc < 2; sc++)
          quad(P(IN[b][0], IN[cc][sc]), P(IN[b][0], OUT[cc][sc]), P(IN[b][1], OUT[cc][sc]), P(IN[b][1], IN[cc][sc]));
        for (let sb = 0; sb < 2; sb++) for (let sc = 0; sc < 2; sc++) {
          const sg = [0,0,0]; sg[a] = sa; sg[b] = sb; sg[cc] = sc;
          const cen = P(IN[b][sb], IN[cc][sc]);
          // No ball at this vertex means nothing bit into the corner, so the
          // corner square is solid face instead of the quarter disc plus a
          // bite. Degenerate where the paint has already collapsed the inset.
          if (!ball(sg[0], sg[1], sg[2])) {
            quad(cen, P(OUT[b][sb], IN[cc][sc]), P(OUT[b][sb], OUT[cc][sc]), P(IN[b][sb], OUT[cc][sc]));
            continue;
          }
          for (let q = 0; q < NA; q++)
            put(cen, ballArc(a, sg[0], sg[1], sg[2], q), ballArc(a, sg[0], sg[1], sg[2], q+1));
        }
      }
    }
  } else {
    // ---- every edge and every corner: the offset of the shrunk box ----
    // One generator for the lot. oct(i,j,k, fi, ti) walks the ball at the
    // shrunk box's (i,j,k) corner in spherical coordinates poled on x:
    //   fi = NA  -> the X cylinder's profile      ti = 0   -> the Z cylinder's
    //   fi = 0   -> the face corner (the pole)    ti = NA  -> the Y cylinder's
    // so every cylinder rail and every face corner below is read out of the
    // same call the ball uses, and the seams are identical numbers.
    const oct = (i, j, k, fi, ti) => {
      const phi = (Math.PI/2) * (fi/NA), th = (Math.PI/2) * (ti/NA);
      const sp = Math.sin(phi);
      return [IN[0][i] + S[i] * RR[0][i] * Math.cos(phi),
              IN[1][j] + S[j] * RR[1][j] * sp * Math.cos(th),
              IN[2][k] + S[k] * RR[2][k] * sp * Math.sin(th)];
    };
    // 8 balls
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++)
      for (let fi = 0; fi < NA; fi++) for (let ti = 0; ti < NA; ti++)
        quad(oct(i,j,k,fi,ti), oct(i,j,k,fi+1,ti), oct(i,j,k,fi+1,ti+1), oct(i,j,k,fi,ti+1));
    // 12 cylinders, four along each axis
    for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++)
      for (let q = 0; q < NA; q++)
        quad(oct(0,j,k,NA,q), oct(1,j,k,NA,q), oct(1,j,k,NA,q+1), oct(0,j,k,NA,q+1));
    for (let i = 0; i < 2; i++) for (let k = 0; k < 2; k++)
      for (let q = 0; q < NA; q++)
        quad(oct(i,0,k,q,NA), oct(i,1,k,q,NA), oct(i,1,k,q+1,NA), oct(i,0,k,q+1,NA));
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++)
      for (let q = 0; q < NA; q++)
        quad(oct(i,j,0,q,0), oct(i,j,1,q,0), oct(i,j,1,q+1,0), oct(i,j,0,q+1,0));
    // 6 faces, each one flat quad on its own original plane
    for (let i = 0; i < 2; i++)
      quad(oct(i,0,0,0,0), oct(i,1,0,0,0), oct(i,1,1,0,0), oct(i,0,1,0,0));
    for (let j = 0; j < 2; j++)
      quad(oct(0,j,0,NA,0), oct(1,j,0,NA,0), oct(1,j,1,NA,0), oct(0,j,1,NA,0));
    for (let k = 0; k < 2; k++)
      quad(oct(0,0,k,NA,NA), oct(1,0,k,NA,NA), oct(1,1,k,NA,NA), oct(0,1,k,NA,NA));
  }

  if (out.length < 9 * 4) throw new Error('wrap produced no geometry - left unchanged');
  // What was actually wrapped, not what a full box would have been: an edge
  // rounds only when both faces along it wrap, a corner only when all three
  // do. The status line reads these, so a painted-out face can never be
  // reported as baked.
  let square = 0;
  for (let a = 0; a < 3; a++) for (let s = 0; s < 2; s++) if (SQ[a][s]) square++;
  let edges = 0;
  if (mode !== 'corners') {
    for (let a = 0; a < 3; a++) {
      const o = [0,1,2].filter(x => x !== a);
      for (let sb = 0; sb < 2; sb++) for (let sc = 0; sc < 2; sc++)
        if (!SQ[o[0]][sb] && !SQ[o[1]][sc]) edges++;
    }
  }
  let corners = 0;
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++)
    if (ball(i, j, k)) corners++;
  rawWrapSolid.lastBuild = {
    mode: mode, radius: R, requested: requestedR,
    faces: 6 - square, square: square, edges: edges, corners: corners, tris: tri
  };
  return new Float32Array(out);
}

// Which engine's lastBuild belongs to a mode. The replay runs several jobs, so
// the status has to read the one the user just clicked, not whichever ran last.
function lastBuildFor(mode) {
  if (mode === 'cornersedges') return (typeof rawVertexBallCorners === 'function') ? rawVertexBallCorners.lastBuild : null;
  if (mode === 'corners') return (typeof rawVertexBallOnly === 'function') ? rawVertexBallOnly.lastBuild : null;
  return (typeof rawPerimeterFilletInPlace === 'function') ? rawPerimeterFilletInPlace.lastBuild : null;
}

// What a wrap actually built. Names the mode, so a photo of the HUD says which
// of the four it was, and the face / edge / corner counts so a partial can
// never read as a wrap.
function wrapStatus(mode, b) {
  if (!b) return 'Soften ok';
  const name = mode === 'chamfer' ? 'Bevel'
             : mode === 'cornersedges' ? 'corners+edges'
             : mode === 'corners' ? 'Corners' : 'Round';
  const clamp = b.radius < b.requested - 1e-6
    ? ' (asked ' + b.requested.toFixed(2) + ', clamped to the box)' : '';
  const what = mode === 'corners'
    ? b.faces + ' faces baked, ' + b.corners + ' corners, edges left square'
    : b.faces + ' faces baked, ' + b.edges + ' edges, ' + b.corners + ' corners';
  const painted = b.square ? ', ' + b.square + ' painted out and left square' : '';
  return name + ' wrap R ' + b.radius.toFixed(2) + clamp + ' - ' + what + painted +
         ' (' + b.tris + ' tris, one bake from source)';
}

// Wrap the pockets of a piece that is not a plain box and not a plain box
// with one pocket - a Subtract into a real part. The hull is not
// re-generated: the piece's own soup goes in and only the pockets are cut
// out of it, so every painted face comes through exactly as it was and the
// wrap cannot tear a hull it does not understand.
//
// Returns true when it has taken the click.
function wrapPocketsInPlace(m, run, R, firstOfRun, jobs) {
  const painted = (typeof nsoMaskFaceList === 'function') ? nsoMaskFaceList(m) : [];
  if (!painted) {
    if (typeof removeFaceHelper === 'function') removeFaceHelper();
    setStatus('Wrap needs faces it can name - a painted patch here is not a flat face. Piece unchanged', true);
    return true;
  }
  const isPainted = function (a, keepMin, at) {
    for (let i = 0; i < painted.length; i++) {
      const e = painted[i];
      if (e.axisIdx !== a || !!e.keepMin !== !!keepMin) continue;
      if (Math.abs((e.keepMin ? -e.d : e.d) - at) < 0.05) return true;
    }
    return false;
  };
  const pockets = rawBoxPockets(run.base, isPainted);
  if (!pockets.length) return false;                  // nothing here this can do
  if (state.nsoWrapBusy) {
    setStatus('Still wrapping the last click', true);
    return true;
  }
  const wrapMode = getEdgeTreat();
  state.nsoWrapBusy = true;
  setStatus('Wrapping ' + pockets.length + ' pocket' + (pockets.length === 1 ? '' : 's') +
            ', ' + painted.length + ' face(s) painted out\u2026');
  console.log('[soften] ' + pockets.length + ' box pocket(s) to wrap, hull left as it is');

  // Each pocket is pushed out past its own mouth so the generator's rounding
  // on that end lands outside the piece and the mouth is cut by the hull
  // rather than by the tool.
  // The pocket is already cut, so a rounded tool dropped into it touches
  // nothing - it is strictly inside the hole that is there. Fill the pocket
  // back flush first, then cut it again with the rounded tool. The fill is
  // the pocket's own box, so it can only ever put back what that pocket took
  // out and cannot reach the rest of the piece.
  let cutters = [], fills = [];
  try {
    for (let i = 0; i < pockets.length; i++) {
      const p = pockets[i];
      fills.push(rawBoxSoup(p.lo, p.hi));
      const plo = p.lo.slice(), phi = p.hi.slice();
      const over = 2 * R + 1;
      if (p.openSide) phi[p.openAxis] += over; else plo[p.openAxis] -= over;
      const pSkip = [[false,false],[false,false],[false,false]];
      // a painted wall of this pocket keeps its radius at zero
      for (let f = 0; f < p.faces.length; f++) {
        const fc = p.faces[f];
        if (isPainted(fc.axisIdx, fc.keepMin, fc.at)) pSkip[fc.axisIdx][fc.keepMin ? 1 : 0] = true;
      }
      pSkip[p.openAxis][p.openSide ? 1 : 0] = true;    // the end outside the piece
      cutters.push(rawWrapSolid(rawBoxSoup(plo, phi), R, wrapMode, pSkip));
    }
  } catch (e) {
    state.nsoWrapBusy = false;
    if (typeof removeFaceHelper === 'function') removeFaceHelper();
    setStatus('Wrap failed - ' + (e && e.message ? e.message : e) + '. Piece unchanged', true);
    return true;
  }

  const cutAll = function (soup, i) {
    if (i >= cutters.length) return Promise.resolve({ ok: true, soup: soup });
    return nsoUnionSoups(soup, fills[i]).then(function (filled) {
      if (!filled.ok) return filled;
      return nsoSubtractSoups(filled.soup, cutters[i]);
    }).then(function (res) {
      if (!res.ok) return res;
      return cutAll(res.soup, i + 1);
    });
  };
  cutAll(run.base, 0).then(function (res) {
    state.nsoWrapBusy = false;
    if (!res.ok) {
      if (typeof removeFaceHelper === 'function') removeFaceHelper();
      setStatus('Wrap failed - ' + res.reason + '. Piece unchanged', true);
      return;
    }
    const sB = nsoSealScore(run.base), sW = nsoSealScore(res.soup);
    if (sW.open > sB.open || sW.nm > sB.nm) {
      if (typeof removeFaceHelper === 'function') removeFaceHelper();
      setStatus('Wrap failed - the cut did not close (open ' + sB.open + '\u2192' + sW.open +
                ', non-manifold ' + sB.nm + '\u2192' + sW.nm + '). Piece unchanged', true);
      return;
    }
    const name = wrapMode === 'chamfer' ? 'Bevel'
               : wrapMode === 'cornersedges' ? 'corners+edges'
               : wrapMode === 'corners' ? 'Corners' : 'Round';
    commitSoften(m, run, res.soup, firstOfRun,
                 [{ wrap: true, R: R, mode: wrapMode, pockets: pockets.length }],
                 name + ' wrap R ' + R.toFixed(2) + ' inside - ' + pockets.length + ' pocket' +
                 (pockets.length === 1 ? '' : 's') + ' wrapped, ' + painted.length +
                 ' face(s) painted out and left square, hull untouched (' +
                 (res.soup.length / 9) + ' tris, one bake from source)');
  }, function (err) {
    state.nsoWrapBusy = false;
    if (typeof removeFaceHelper === 'function') removeFaceHelper();
    setStatus('Wrap failed - ' + (err && err.message ? err.message : err) + '. Piece unchanged', true);
  });
  return true;
}

// The brick wrap, driven from a Soften click. Returns true when it has taken
// the click - either it is baking, or it has refused with a reason and the
// mesh is untouched. Returns false when this piece is not a brick at all and
// the per-face path should have it.
//
// The kernel call is a promise, so this hands the click back straight away and
// commits when the cut lands. Nothing is written to the piece until then, so a
// refusal anywhere leaves it exactly as it was.
function wrapPocketBrickRun(m, run, R, firstOfRun, jobs) {
  const brick = rawPocketBrick(run.base);
  if (!brick) return false;
  const faceList = (typeof nsoMaskFaceList === 'function') ? nsoMaskFaceList(m) : [];
  if (!faceList) {
    if (typeof removeFaceHelper === 'function') removeFaceHelper();
    setStatus('Wrap needs faces it can name - a painted patch here is not a flat face. Piece unchanged', true);
    return true;
  }
  const skip = brickSkipLists(brick, faceList, run.base);
  if (!skip || skip.bad) {
    if (typeof removeFaceHelper === 'function') removeFaceHelper();
    const where = skip && skip.bad
      ? ('the ' + 'XYZ'.charAt(skip.bad.axisIdx) + (skip.bad.keepMin ? '-' : '+') +
         ' face at ' + skip.at.toFixed(2))
      : 'a painted face';
    setStatus('Wrap stopped - ' + where + ' is gone from this piece; the soup has no face on ' +
              'that plane any more. Clear paint and paint it again. Piece unchanged', true);
    return true;
  }
  if (skip.nHull + skip.nPocket >= 11) {
    if (typeof removeFaceHelper === 'function') removeFaceHelper();
    setStatus('Every face is painted out - nothing left to wrap. Piece unchanged', true);
    return true;
  }
  if (state.nsoWrapBusy) {
    setStatus('Still wrapping the last click', true);
    return true;
  }
  const wrapMode = getEdgeTreat();
  state.nsoWrapBusy = true;
  setStatus('Wrapping ' + (11 - skip.nHull - skip.nPocket) + ' face(s), ' +
            (skip.nHull + skip.nPocket) + ' painted out\u2026');
  console.log('[soften] pocket brick - hull ' + (6 - skip.nHull) + '/6, pocket ' +
              (5 - skip.nPocket) + '/5 wrapping');
  nsoWrapBrick(brick, R, wrapMode, skip).then(function (res) {
    state.nsoWrapBusy = false;
    if (!res.ok) {
      if (typeof removeFaceHelper === 'function') removeFaceHelper();
      setStatus('Wrap failed - ' + res.reason + '. Piece unchanged', true);
      return;
    }
    // the same seal gate the plain-box wrap uses: a wrap that opens the piece
    // up is refused and the piece is left as it was
    const sB = nsoSealScore(run.base), sW = nsoSealScore(res.soup);
    if (sW.open > sB.open || sW.nm > sB.nm) {
      if (typeof removeFaceHelper === 'function') removeFaceHelper();
      setStatus('Wrap failed - the cut did not close (open ' + sB.open + '\u2192' + sW.open +
                ', non-manifold ' + sB.nm + '\u2192' + sW.nm + '). Piece unchanged', true);
      return;
    }
    const name = wrapMode === 'chamfer' ? 'Bevel'
               : wrapMode === 'cornersedges' ? 'corners+edges'
               : wrapMode === 'corners' ? 'Corners' : 'Round';
    const baked = 11 - skip.nHull - skip.nPocket;
    commitSoften(m, run, res.soup, firstOfRun,
                 [{ wrap: true, R: R, mode: wrapMode, brick: true }],
                 name + ' wrap R ' + R.toFixed(2) + ' on a pocket piece - ' +
                 baked + ' of 11 faces baked (hull ' + (6 - skip.nHull) + '/6, pocket ' +
                 (5 - skip.nPocket) + '/5), ' + (skip.nHull + skip.nPocket) +
                 ' painted out and left square (' + (res.soup.length / 9) +
                 ' tris, one bake from source)');
  }, function (err) {
    state.nsoWrapBusy = false;
    if (typeof removeFaceHelper === 'function') removeFaceHelper();
    setStatus('Wrap failed - ' + (err && err.message ? err.message : err) + '. Piece unchanged', true);
  });
  return true;
}

// Install a finished bake on the piece: one undo step per run landing on the
// piece as it was before the FIRST bake, the new geometry, the placed mesh,
// and the pick cleanup. Shared by the per-face path and the whole-solid wrap
// so neither can drift from the other on any of that.
function commitSoften(m, run, working, firstOfRun, jobs, statusText) {
  // One undo step per run, and it lands on the piece as it was before the
  // FIRST face was softened - not on the previous face's bake.
  if (firstOfRun) {
    pushUndo({
      type: 'softenReplace',
      modelId: m.id,
      prevGeometry: run.geometry.clone(),
      prevRawTris: run.base,
      prevRawAxis: run.axis,
      prevCenterOffset: run.offset,
      prevSize: { x: run.size.x, y: run.size.y, z: run.size.z }
    });
  }

  const newGeo = rawResultToDisplayGeometry(working);
  newGeo.computeBoundingBox();
  const size2 = new THREE.Vector3();
  newGeo.boundingBox.getSize(size2);

  m.geometry = newGeo;
  m.rawTris = working;
  run.jobs = jobs.filter(j => !j.dead);
  run.result = working;
  m.softenRun = run;
  m.softenBaseRaw = run.base;   // the outline script's view of the same base
  m.rawAxis = 'zup';
  m.centerOffset = computeCenterOffsetFromRaw(working);
  m.size = { x: size2.x, y: size2.y, z: size2.z };

  const placedEntry = state.placed.find(p => p && p.sourceId === m.id);
  if (placedEntry) {
    const px = placedEntry.x, pz = placedEntry.z;
    if (placedEntry.mesh && state.modelGroup) {
      state.modelGroup.remove(placedEntry.mesh);
      if (placedEntry.mesh.material) {
        if (Array.isArray(placedEntry.mesh.material)) placedEntry.mesh.material.forEach(mt => mt.dispose());
        else placedEntry.mesh.material.dispose();
      }
    }
    const mat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8, metalness: 0.05, roughness: 0.4,
      emissive: 0x0a3a5c, emissiveIntensity: 0.25
    });
    const mesh = new THREE.Mesh(m.geometry, mat);
    mesh.position.set(px, m.size.y / 2 + 0.3, pz);
    mesh.userData.sourceId = m.id;
    mesh.userData.placedIndex = state.placed.indexOf(placedEntry);
    state.modelGroup.add(mesh);
    placedEntry.mesh = mesh;
    placedEntry.geometry = m.geometry;
    placedEntry.width = m.size.x;
    placedEntry.depth = m.size.z;
    placedEntry.height = m.size.y;
  } else if (state.cutterOpen) {
    showEditPreview();
  }

  updateEditSize();
  renderModelList();
  updateUndoBtn();
  // Bake done: drop the pick and its overlay. The highlight is NOT re-derived
  // on the baked mesh — the face the user clicked is gone, and a yellow patch
  // left on the new geometry reads as still armed when it is not. The thin
  // cage goes on instead, and lasts until the next pick or selection.
  clearFacePick();
  showInspectCage(m);
  // The paint is a different thing and it does survive: it is stored as
  // planes, so it still names the same faces on the baked piece. Rebuild it
  // against the new mesh, or the yellow keeps the shape of the face before
  // the bake and hangs over the corners the wrap has just rounded off.
  if (typeof nsoMaskRepaint === 'function') nsoMaskRepaint();
  if (statusText) setStatus(statusText);
}

/* The one description of "this piece does not need a face picked".

   Full wrap on, at least one painted face, and a pocket on the piece: the
   paint already says which faces to leave square and the pocket already
   says where the work is, so there is nothing left for a click to name.
   Read by the Soften button, which bakes instead of arming when it is
   true, and by the click resolver, for a piece that became ready while
   Soften was already armed. */
function nsoWrapAllReady(m) {
  if (!m || !m.rawTris || m.rawAxis !== 'zup') return false;
  if (!((typeof getFullWrap === 'function') && getFullWrap())) return false;
  if (!((typeof nsoMaskCount === 'function') && nsoMaskCount(m) > 0)) return false;
  return rawBoxPockets(m.rawTris).length > 0;
}

/* The wrap-the-pockets bake, with no face pick anywhere in it.

   Same order the ordinary path uses, so this is only skipping the pick and
   nothing else: the box-and-one-pocket wrap first, which is the one that
   can also rebuild the hull, then the cut-the-pockets wrap for a hull it
   cannot. Whatever those two decide - including their refusals - is the
   answer, and the last line is only reached if both of them looked and
   found nothing. */
function softenWrapAllPockets(m) {
  const inpR = document.getElementById('inp-soften-r');
  const Rv = inpR ? parseFloat(inpR.value) : NaN;
  const R = (isFinite(Rv) && Rv > 0) ? Rv : 0.5;
  const run = (m.softenRun && m.rawTris === m.softenRun.result) ? m.softenRun : {
    base: (m.rawTris.slice ? m.rawTris.slice() : new Float32Array(m.rawTris)),
    axis: m.rawAxis,
    offset: m.centerOffset,
    geometry: m.geometry,
    size: { x: m.size.x, y: m.size.y, z: m.size.z },
    jobs: [],
    result: null
  };
  if (wrapPocketBrickRun(m, run, R, !run.result, [])) return;
  if (wrapPocketsInPlace(m, run, R, !run.result, [])) return;
  setStatus('Wrap found no pocket to work on. Piece unchanged', true);
}

// Round / Corners / Bevel. Reads the stored pick and nothing else — the
// `face` argument is ignored and kept only so the app-sel-outline reapply
// wrapper keeps working. No stored pick means no bake.
function applySoftenOnFace(face) {
  const m = getActiveModel();
  if (!m) {
    setStatus('Select a piece first', true);
    return;
  }
  if (!m.rawTris || m.rawAxis !== 'zup') {
    setStatus('Soften needs a Square-split or loaded raw piece', true);
    return;
  }
  /* A click that landed while Soften was armed on a piece that needs no
     face picked - armed before Full wrap went on, say. The pick is skipped
     the same way the button skips it, because asking this click to name a
     face is what produced the two dead ends: the face under the cursor was
     either one of the painted ones ("that face is painted out") or a wall
     deep inside the part ("click an outer face, that one is recessed
     38mm"), and neither has anything to do with the job.

     Full wrap off is still click-a-face, and a piece with no pocket is
     still click-a-face, so the painted-out refusal stands everywhere it
     stood before. */
  if (state.nsoWrapAll === m.id) {
    state.nsoWrapAll = null;
    softenWrapAllPockets(m);
    return;
  }

  const pick = getFacePick(m);
  if (!pick) {
    clearFacePick();
    setStatus('Click a face', true);
    return;
  }
  const inpR = document.getElementById('inp-soften-r');
  const Rv = inpR ? parseFloat(inpR.value) : NaN;
  const R = (isFinite(Rv) && Rv > 0) ? Rv : 0.5;
  const rawAxisIdx = pick.rawAxisIdx;
  const keepMinFace = pick.rawKeepMin;

  // A painted-out face is not baked, whatever mode is selected. Refused here,
  // before the run is touched, so the piece and the paint both stay put.
  if (typeof nsoMaskIsExcludedPick === 'function' &&
      nsoMaskIsExcludedPick(m, rawAxisIdx, keepMinFace, pick.rawPlane, pick.recessed)) {
    if (typeof removeFaceHelper === 'function') removeFaceHelper();
    setStatus('That face is painted out - include it first, or pick another face', true);
    return;
  }

  // ---- the accumulation run ----
  // A second face must not cost you the first. Every clicked face is recorded
  // against the piece's pre-Soften raw, and one bake replays the whole list
  // from that base. Nothing is ever stacked mesh on mesh: the base is the only
  // input, the previous result is thrown away and rebuilt from scratch.
  //
  // The run belongs to one unbroken sequence of Soften clicks. `result` is the
  // exact array the last bake put on the piece, so if anything else has since
  // touched it - Undo, a cut, a join, a thicken - the identity check fails and
  // the next click starts a fresh run off whatever the piece is now.
  const run = (m.softenRun && m.rawTris === m.softenRun.result) ? m.softenRun : {
    base: (m.rawTris.slice ? m.rawTris.slice() : new Float32Array(m.rawTris)),
    axis: m.rawAxis,
    offset: m.centerOffset,
    geometry: m.geometry,
    size: { x: m.size.x, y: m.size.y, z: m.size.z },
    jobs: [],
    result: null
  };
  const firstOfRun = !run.result;
  // Clicking the same face again re-bakes that face at the new R and mode
  // rather than treating it twice.
  const jobs = run.jobs.filter(j => !(j.axisIdx === rawAxisIdx && j.keepMin === keepMinFace));
  jobs.push({ axisIdx: rawAxisIdx, keepMin: keepMinFace, plane: pick.rawPlane,
              R: R, mode: getEdgeTreat() });

  const sealScore = nsoSealScore;
  // ---- whole-solid wrap ----
  // A box does not go through the per-face path at all. Clicking any face of
  // one wraps every face, every edge and every corner in a single bake off the
  // raw source, so a shared edge is never met twice and a three-edge vertex is
  // solved once instead of negotiated face by face. A new R just re-wraps from
  // the same source - it cannot stack.
  const fullWrap = getFullWrap();
  const boxBase = rawSolidBox(run.base);
  // Paint does not veto the wrap - it names the faces the wrap leaves alone,
  // and it names them with the axis and side the click itself recorded. The
  // one thing that still sends this back to the per-face path is a painted
  // recessed wall, which has no axis and side to name; and a piece with all
  // six faces painted out, where there is nothing left to wrap.
  const wrapSquare = (boxBase && fullWrap) ? maskedBoxFaces(m) : null;
  let squareCount = 0;
  if (wrapSquare) for (let a = 0; a < 3; a++) for (let sd = 0; sd < 2; sd++) if (wrapSquare[a][sd]) squareCount++;
  const asBox = (fullWrap && boxBase && wrapSquare && squareCount < 6) ? boxBase : null;
  if (boxBase && !asBox) {
    if (!fullWrap) console.log('[soften] Full wrap off - baking the clicked face only');
    else if (!wrapSquare) console.log('[soften] a painted face has no axis and side to name - per-face bake');
    else console.log('[soften] all six faces painted out - nothing left to wrap');
  } else if (!boxBase && fullWrap) {
    console.log('[soften] not a plain box - trying the one-pocket wrap');
  }
  // A piece with one box pocket in it is still a piece the wrap can do: the
  // hull and the pocket are each a box, and the skip list says which faces of
  // each keep their radius. Everything below this is the plain-box path,
  // unchanged.
  if (!asBox && fullWrap && !boxBase) {
    if (wrapPocketBrickRun(m, run, R, firstOfRun, jobs)) return;
    // Not one box with one box pocket, so the hull is a shape the wrap
    // cannot rebuild. It does not have to: cut the pockets out of the piece
    // as it stands and leave everything else alone.
    if (wrapPocketsInPlace(m, run, R, firstOfRun, jobs)) return;
    console.log('[soften] no box pocket to wrap here - per-face bake on the clicked face');
  }
  if (asBox) {
    const wrapMode = getEdgeTreat();
    if (squareCount) console.log('[soften] ' + squareCount + ' face(s) painted out - wrapping the other ' + (6 - squareCount));
    let wrapped = null;
    try {
      wrapped = rawWrapSolid(run.base, R, wrapMode, wrapSquare);
    } catch (e) {
      if (typeof removeFaceHelper === 'function') removeFaceHelper();
      setStatus('Soften failed - ' + (e && e.message ? e.message : e), true);
      return;
    }
    if (!wrapped || wrapped.length < 9) {
      if (typeof removeFaceHelper === 'function') removeFaceHelper();
      setStatus('Soften failed - wrap empty. Piece unchanged', true);
      return;
    }
    const sB = sealScore(run.base), sW = sealScore(wrapped);
    if (sW.open > sB.open || sW.nm > sB.nm) {
      if (typeof removeFaceHelper === 'function') removeFaceHelper();
      setStatus('Soften failed - wrap did not close (open ' + sB.open + '\u2192' + sW.open +
                ', non-manifold ' + sB.nm + '\u2192' + sW.nm + '). Piece unchanged', true);
      return;
    }
    commitSoften(m, run, wrapped, firstOfRun,
                 [{ wrap: true, R: R, mode: wrapMode }],
                 wrapStatus(wrapMode, rawWrapSolid.lastBuild));
    return;
  }

  if (pick.recessed) {
    if (typeof removeFaceHelper === 'function') removeFaceHelper();
    setStatus('That face is inside the piece - only a Full wrap can reach it, and this piece is not one ' +
              'the wrap can name. Piece unchanged', true);
    return;
  }

  // Replay order is not click order. The engines are not symmetric: a face loop
  // that already carries a ball's arc cannot be offset by the perimeter engine,
  // but a face next to a finished band is fine for the ball engines. Bands
  // first, then Round and Bevel, then Corners. Same set of treatments either
  // way - replaying from the base means the order is ours to choose.
  const rank = (mode) => (mode === 'cornersedges' ? 0 : (mode === 'corners' ? 2 : 1));
  const order = jobs.map((j, i) => ({ j: j, i: i }))
                    .sort((a, b) => (rank(a.j.mode) - rank(b.j.mode)) || (a.i - b.i))
                    .map(x => x.j);
  const newJob = jobs[jobs.length - 1];
  let nothingToAdd = null;
  let working = null;
  try {
    working = run.base;
    for (const j of order) {
      try {
        if (typeof nsoMaskIsExcludedPick === 'function' &&
            nsoMaskIsExcludedPick(m, j.axisIdx, j.keepMin, j.plane)) { j.dead = true; continue; }
        working = softenSelectedFace(working, j.axisIdx, j.keepMin, j.R, j.mode, j.plane);
        j.build = lastBuildFor(j.mode);
      } catch (err) {
        // "Every corner is already rounded" is a no-op, not a failure - but
        // only when some other face is doing the work. On its own it is the
        // honest refusal it has always been.
        if (err && err.softenSkippable && jobs.length > 1) {
          if (j === newJob) nothingToAdd = (err.message || 'nothing left to round');
          j.dead = true;
          continue;
        }
        throw err;
      }
    }
    if (working === run.base) throw new Error('nothing to soften on this piece');
    // Two treatments on faces that share an edge can fight: the second face
    // reads its boundary loop off a wall the first one has already carved.
    // If replaying the list leaves the piece worse sealed than it started,
    // this face is refused and the faces already baked are kept - never a
    // shredded rim.
    const s0 = sealScore(run.base), s1 = sealScore(working);
    if (s1.open > s0.open || s1.nm > s0.nm) {
      throw new Error('this face fights one already softened (open ' +
                      s0.open + '\u2192' + s1.open + ', non-manifold ' +
                      s0.nm + '\u2192' + s1.nm + ') - ' +
                      (jobs.length > 1 ? 'kept the ' + (jobs.length - 1) + ' already baked'
                                       : 'piece unchanged'));
    }
  } catch (e) {
    working = null;
    if (typeof removeFaceHelper === 'function') removeFaceHelper();
    setStatus('Soften failed - ' + (e && e.message ? e.message : e), true);
    return;
  }
  if (!working || working.length < 9) {
    if (typeof removeFaceHelper === 'function') removeFaceHelper();
    setStatus('Soften failed - fillet empty. Piece unchanged', true);
    return;
  }

  commitSoften(m, run, working, firstOfRun, jobs.filter(j => !j.dead), null);

  // What actually got built: corners that took R, out of the corners found,
  // and the loop points the face carries. No sealing claim.
  const treat = getEdgeTreat();
  const clamp = (x) => (x.radius < x.requested - 1e-6 ? ' (asked ' + x.requested.toFixed(2) + ', wall clamp)' : '');
  // Says how many faces this piece is carrying once there is more than one,
  // so a second click reads as "kept the first" rather than "moved it".
  const faces = run.jobs.length > 1 ? ' [' + run.jobs.length + ' faces baked]'
              : (getFullWrap() ? '' : ' [full wrap off - this face only]');
  const built = newJob.build || null;
  const ball = treat === 'cornersedges' ? built : null;
  const only = treat === 'corners' ? built : null;
  const perim = (treat === 'fillet' || treat === 'chamfer') ? built : null;
  if (nothingToAdd) {
    setStatus('Soften ok - nothing to add on this face (' + nothingToAdd + ')' + faces);
    return;
  }
  if (treat === 'cornersedges' && ball && ball.vertices != null) {
    setStatus('corners+edges setback R ' + ball.radius.toFixed(2) + clamp(ball) +
              ' (' + ball.vertices + ' corners + ' + ball.bands + ' edges, ' +
              ball.patchTris + ' blend tris, no shelf)' +
              (ball.skipped ? ' - ' + ball.skipped + ' not square, left sharp' : '') + faces);
  } else if (treat === 'corners' && only && only.vertices != null) {
    setStatus('Corners R ' + only.radius.toFixed(2) + clamp(only) +
              ' - ' + only.vertices + ' vertices, mid-edges square' +
              (only.skipped ? ' - ' + only.skipped + ' not square, left sharp' : '') + faces);
  } else if (perim && perim.loopPts != null) {
    setStatus('Soften ok - ' + perim.mode + ' on all ' + perim.loopPts + ' loop pts at R ' +
              perim.radius.toFixed(2) + clamp(perim) + faces);
  } else {
    setStatus('Soften ok' + faces);
  }
}


// ===== Cap: raw engine — flat lid via existing clip+cap (rawCut), R=0 =====
// Same extreme-finding + EPS nudge as softenSelectedFace, same keepMin
// convention (direct passthrough — confirmed there against
// rawClipTrianglesAtPlane, not re-derived here). Just skips the fillet band:
// rawCut already does clip -> loop -> rawFlatCapLoop, which is exactly a
// legal flat raw lid, fillet-ready input for softenSelectedFace later.
function capSelectedFace(rawTris, axisIdx, keepMinFace, pickPlane) {
  // Same change as softenSelectedFace: the plane comes from the stored
  // pick, and the old bbox min/max scan is now only the check that the
  // pick still describes this axis's outer plane.
  const extreme = rawExtremeOf(rawTris, axisIdx, keepMinFace);
  if (pickPlane == null || !isFinite(pickPlane) || !isFinite(extreme) ||
      Math.abs(pickPlane - extreme) > FACE_PICK_TOL) {
    throw new Error('clicked face is not the outer plane on that axis');
  }
  const EPS = 0.02;
  const plane = keepMinFace ? pickPlane + EPS : pickPlane - EPS;
  const keepMin = keepMinFace;
  return rawCut(rawTris, axisIdx, plane, keepMin);
}

function applyCapOnFace(face) {
  const m = getActiveModel();
  if (!m) {
    setStatus('Select a piece first', true);
    return;
  }
  if (!m.rawTris || m.rawAxis !== 'zup') {
    setStatus('Cap needs a Square-split or loaded raw piece', true);
    return;
  }
  const pick = getFacePick(m);
  if (!pick) {
    clearFacePick();
    setStatus('Click a face', true);
    return;
  }
  // The clicked face's OWN raw axis and side. This used to pass the DISPLAY
  // axisIdx (0 or 2) and face.sign straight into the raw engine, so a
  // display-Z wall went to raw axis 2 — the top of the piece — exactly the
  // miss that was fixed for Soften and left standing here.
  let working = null;
  try {
    working = capSelectedFace(m.rawTris, pick.rawAxisIdx, pick.rawKeepMin, pick.rawPlane);
  } catch (e) {
    working = null;
  }
  if (!working || !rawCheckWatertightQuick(working)) {
    setStatus('Cap failed - piece unchanged', true);
    return;
  }

  // Same Undo shape as Soften's softenReplace, new type for clarity.
  pushUndo({
    type: 'capReplace',
    modelId: m.id,
    prevGeometry: m.geometry.clone(),
    prevRawTris: m.rawTris,
    prevRawAxis: m.rawAxis,
    prevCenterOffset: m.centerOffset,
    prevSize: { x: m.size.x, y: m.size.y, z: m.size.z }
  });

  const newGeo = rawResultToDisplayGeometry(working);
  newGeo.computeBoundingBox();
  const size2 = new THREE.Vector3();
  newGeo.boundingBox.getSize(size2);

  m.geometry = newGeo;
  m.rawTris = working;
  m.rawAxis = 'zup';
  m.centerOffset = computeCenterOffsetFromRaw(working);
  m.size = { x: size2.x, y: size2.y, z: size2.z };

  const placedEntry = state.placed.find(p => p && p.sourceId === m.id);
  if (placedEntry) {
    const px = placedEntry.x, pz = placedEntry.z;
    if (placedEntry.mesh && state.modelGroup) {
      state.modelGroup.remove(placedEntry.mesh);
      if (placedEntry.mesh.material) {
        if (Array.isArray(placedEntry.mesh.material)) placedEntry.mesh.material.forEach(mt => mt.dispose());
        else placedEntry.mesh.material.dispose();
      }
    }
    const mat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8, metalness: 0.05, roughness: 0.4,
      emissive: 0x0a3a5c, emissiveIntensity: 0.25
    });
    const mesh = new THREE.Mesh(m.geometry, mat);
    mesh.position.set(px, m.size.y / 2 + 0.3, pz);
    mesh.userData.sourceId = m.id;
    mesh.userData.placedIndex = state.placed.indexOf(placedEntry);
    state.modelGroup.add(mesh);
    placedEntry.mesh = mesh;
    placedEntry.geometry = m.geometry;
    placedEntry.width = m.size.x;
    placedEntry.depth = m.size.z;
    placedEntry.height = m.size.y;
  } else if (state.cutterOpen) {
    showEditPreview();
  }

  updateEditSize();
  renderModelList();
  updateUndoBtn();
  // Bake done: drop the pick and its overlay, same as Soften.
  clearFacePick();
  showInspectCage(m);
  setStatus('Cap ok');
}

function capSelectedModel() {
  const m = getActiveModel();
  if (!m) { setStatus('Select a piece first', true); return; }
  if (state.capArmed) {
    state.capArmed = false;
    clearFacePick();
    setStatus('Cap cancelled');
    return;
  }
  state.capArmed = true;
  clearFacePick();
  setStatus('Cap: click a face');
}

// Full wrap on (the default, and what a missing checkbox means) is wrap1: one
// click wraps every face, edge and corner of a box. Off sends the same four
// modes down the per-face path instead, so a click bakes only the face that
// was picked. There is no third engine either way - the box wrap and the
// per-face engines are exactly the ones already shipped.
function getFullWrap() {
  const el = document.getElementById('chk-full-wrap');
  return el ? !!el.checked : true;
}

// fillet | corners | cornersedges | chamfer. Anything else (a stale saved
// value, an old 'square' option) falls back to fillet — Soften has no square
// treatment. 'corners' is vertices only; 'cornersedges' is the setback bake.
function getEdgeTreat() {
  const sel = document.getElementById('sel-edge-treat');
  const v = sel && sel.value ? String(sel.value) : (state.edgeTreat || 'fillet');
  state.edgeTreat = (v === 'chamfer' || v === 'corners' || v === 'cornersedges') ? v : 'fillet';
  return state.edgeTreat;
}

function softenSelectedModel() {
  const m = getActiveModel();
  if (!m) { setStatus('Select a piece first', true); return; }

  /* A piece that needs no face picked is baked by this button, not armed by
     it. Arming was the whole of the bug: the button said "click a face", the
     only faces on screen were the painted ones and the pocket walls, so the
     click was refused and pressing Soften again only cancelled the arm. The
     press is the job, so it does the job.

     Before the armed check on purpose, so a piece that became ready while
     Soften was armed - Full wrap switched on after the arm - bakes on the
     next press instead of cancelling. Arming is dropped first either way,
     because after this there is nothing left for a click to do. */
  if (nsoWrapAllReady(m)) {
    state.softenArmed = false;
    state.nsoWrapAll = null;
    clearFacePick();
    softenWrapAllPockets(m);
    return;
  }

  if (state.softenArmed) {
    state.softenArmed = false;
    clearFacePick();
    setStatus('Soften cancelled');
    return;
  }
  state.softenArmed = true;
  clearFacePick();
  const mode = getEdgeTreat();
  const label = mode === 'chamfer' ? 'bevel'
              : mode === 'cornersedges' ? 'corners+edges'
              : mode === 'corners' ? 'corners' : 'round';
  setStatus('Soften (' + label + '): click a face');
}

function capSelectedOpenFaces() {
  const m = getActiveModel();
  if (!m || !m.geometry) {
    setStatus('Select a piece to cap', true);
    return;
  }
  const placed = state.placed.find(function (p) { return p && p.sourceId === m.id; });
  const prevGeo = m.geometry.clone();
  const prevRaw = m.rawTris;
  const prevAxis = m.rawAxis;
  const prevOff = m.centerOffset;
  const prevSize = { x: m.size.x, y: m.size.y, z: m.size.z };
  let capped;
  try {
    capped = capOpenFacesOnGeometry(m.geometry);
  } catch (err) {
    setStatus('Cap failed - ' + (err && err.message ? err.message : 'unchanged'), true);
    return;
  }
  if (!capped) {
    setStatus('No open face to cap');
    return;
  }
  pushUndo({
    type: 'softenReplace',
    id: m.id,
    prevGeometry: prevGeo,
    prevRawTris: prevRaw,
    prevRawAxis: prevAxis,
    prevCenterOffset: prevOff,
    prevSize: prevSize
  });
  capped.computeBoundingBox();
  const size2 = new THREE.Vector3();
  capped.boundingBox.getSize(size2);
  m.geometry = capped;
  m.rawTris = displayGeometryToRawSoup(capped);
  m.rawAxis = 'zup';
  m.centerOffset = computeCenterOffsetFromRaw(m.rawTris);
  m.size = { x: size2.x, y: size2.y, z: size2.z };
  if (placed && placed.mesh && state.modelGroup) {
    const px = placed.x, pz = placed.z;
    state.modelGroup.remove(placed.mesh);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8, metalness: 0.05, roughness: 0.4,
      emissive: 0x0a3a5c, emissiveIntensity: 0.25
    });
    const mesh = new THREE.Mesh(m.geometry, mat);
    mesh.position.set(px, m.size.y / 2 + 0.3, pz);
    mesh.userData.sourceId = m.id;
    mesh.userData.placedIndex = state.placed.indexOf(placed);
    state.modelGroup.add(mesh);
    placed.mesh = mesh;
    placed.geometry = m.geometry;
    placed.width = m.size.x;
    placed.depth = m.size.z;
    placed.height = m.size.y;
  }
  updateEditSize();
  renderModelList();
  updateUndoBtn();
  clearFacePick();
  setStatus('Cap ok');
}

// ===================== Join Selected (post-cut Edit action) =====================
// Not general boolean CSG — a scoped, tractable union for the actual use
// case (chopped ends stored and rejoined onto bars): detect the flat
// interface where two pieces touch, remove both matching caps (they
// become internal surfaces after union), translate to close any kerf gap,
// merge the remaining shells. Verified directly against real split
// geometry, including a simulated kerf gap. Never runs during Split;
// never touches any piece other than the two explicitly selected.

function rawJoinBboxOf(tris, axisIdx) {
  let minV = Infinity, maxV = -Infinity;
  for (let i = axisIdx; i < tris.length; i += 3) {
    if (tris[i] < minV) minV = tris[i];
    if (tris[i] > maxV) maxV = tris[i];
  }
  return { minV, maxV };
}

function rawJoinTranslateAxis(tris, axisIdx, delta) {
  const out = new Float32Array(tris.length);
  for (let i = 0; i < tris.length; i++) out[i] = tris[i];
  for (let i = axisIdx; i < out.length; i += 3) out[i] += delta;
  return out;
}

function soupWorldWin(soup) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < soup.length; i += 3) {
    const x = soup[i], y = soup[i + 1], z = soup[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { minX: minX, maxX: maxX, minY: minY, maxY: maxY, minZ: minZ, maxZ: maxZ };
}

function rawJoinStripCapAtPlane(tris, axisIdx, planeVal, tol, win) {
  tol = (tol == null) ? 0.45 : tol;
  const out = [];
  const triCount = tris.length / 9;
  let stripped = 0;
  for (let t = 0; t < triCount; t++) {
    const i0 = t * 9;
    const c0 = tris[i0+axisIdx], c1 = tris[i0+3+axisIdx], c2 = tris[i0+6+axisIdx];
    const onPlane = Math.abs(c0-planeVal)<tol && Math.abs(c1-planeVal)<tol && Math.abs(c2-planeVal)<tol;
    if (onPlane) {
      if (win) {
        const cx = (tris[i0] + tris[i0 + 3] + tris[i0 + 6]) / 3;
        const cy = (tris[i0 + 1] + tris[i0 + 4] + tris[i0 + 7]) / 3;
        const cz = (tris[i0 + 2] + tris[i0 + 5] + tris[i0 + 8]) / 3;
        const pad = 1.2;
        const inWin =
          (axisIdx === 0 || (cx >= win.minX - pad && cx <= win.maxX + pad)) &&
          (axisIdx === 1 || (cy >= win.minY - pad && cy <= win.maxY + pad)) &&
          (axisIdx === 2 || (cz >= win.minZ - pad && cz <= win.maxZ + pad));
        if (!inWin) {
          for (let k = 0; k < 9; k++) out.push(tris[i0 + k]);
          continue;
        }
      }
      stripped++;
      continue;
    }
    for (let k = 0; k < 9; k++) out.push(tris[i0+k]);
  }
  return { tris: new Float32Array(out), stripped };
}

// rawJoinPieces(rawMin, rawMax, axisIdx) — rawMin is the piece on the
// lower side, rawMax on the upper side; their facing boundaries are
// brought together and merged. Throws on any failure — caller must keep
// both pieces unchanged in that case.
function rawJoinPieces(rawMin, rawMax, axisIdx) {
  const bbMin = rawJoinBboxOf(rawMin, axisIdx);
  const bbMax = rawJoinBboxOf(rawMax, axisIdx);
  const joinPlane = bbMin.maxV;
  const delta = joinPlane - bbMax.minV;
  const maxMoved = rawJoinTranslateAxis(rawMax, axisIdx, delta);

  let sMin = 0, sMax = 0, minStripped, maxStripped;
  const tols = [0.45, 0.9, 1.2, 2.0];
  for (let i = 0; i < tols.length; i++) {
    const a = rawJoinStripCapAtPlane(rawMin, axisIdx, joinPlane, tols[i]);
    const b = rawJoinStripCapAtPlane(maxMoved, axisIdx, joinPlane, tols[i]);
    minStripped = a.tris; maxStripped = b.tris; sMin = a.stripped; sMax = b.stripped;
    if (sMin > 0 && sMax > 0) break;
  }
  if (sMin === 0 || sMax === 0) {
    throw new Error('no flat mate face (stripped ' + sMin + '+' + sMax + ')');
  }

  const merged = new Float32Array(minStripped.length + maxStripped.length);
  merged.set(minStripped, 0);
  merged.set(maxStripped, minStripped.length);

  if (!rawCheckWatertightQuick(merged)) {
    console.warn('[join] merged not watertight; keeping cap-stripped union');
  }
  return merged;
}

function meshLocalBox3(mesh) {
  if (!mesh || !mesh.geometry) return new THREE.Box3();
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  mesh.updateMatrixWorld(true);
  return mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
}

function geomToWorldSoup(geometry, px, py, pz) {
  const geo = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = geo.attributes.position;
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    out[i * 3] = pos.getX(i) + px;
    out[i * 3 + 1] = pos.getY(i) + py;
    out[i * 3 + 2] = pos.getZ(i) + pz;
  }
  return out;
}

function soupToCenteredGeo(soup) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(soup, 3));
  if (THREE.BufferGeometryUtils && typeof THREE.BufferGeometryUtils.mergeVertices === 'function') {
    const merged = THREE.BufferGeometryUtils.mergeVertices(geo, 0.3);
    merged.computeVertexNormals();
    merged.center();
    merged.computeBoundingBox();
    return merged;
  }
  geo.computeVertexNormals();
  geo.center();
  geo.computeBoundingBox();
  return geo;
}

function stripFacingInBand(soup, axisIdx, plane, band, win) {
  const out = [];
  const triCount = soup.length / 9;
  let stripped = 0;
  for (let t = 0; t < triCount; t++) {
    const i0 = t * 9;
    const ax = soup[i0], ay = soup[i0 + 1], az = soup[i0 + 2];
    const bx = soup[i0 + 3], by = soup[i0 + 4], bz = soup[i0 + 5];
    const cx = soup[i0 + 6], cy = soup[i0 + 7], cz = soup[i0 + 8];
    const avg = ((ax + bx + cx) / 3 * (axisIdx === 0 ? 1 : 0)) +
      ((ay + by + cy) / 3 * (axisIdx === 1 ? 1 : 0)) +
      ((az + bz + cz) / 3 * (axisIdx === 2 ? 1 : 0));
    const coord = axisIdx === 0 ? (ax + bx + cx) / 3 : axisIdx === 1 ? (ay + by + cy) / 3 : (az + bz + cz) / 3;
    if (Math.abs(coord - plane) <= band) {
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      const nAxis = axisIdx === 0 ? nx : axisIdx === 1 ? ny : nz;
      if (Math.abs(nAxis / len) >= 0.72) {
        if (win) {
          const tcx = (ax + bx + cx) / 3;
          const tcy = (ay + by + cy) / 3;
          const tcz = (az + bz + cz) / 3;
          const pad = 1.2;
          const inWin =
            (axisIdx === 0 || (tcx >= win.minX - pad && tcx <= win.maxX + pad)) &&
            (axisIdx === 1 || (tcy >= win.minY - pad && tcy <= win.maxY + pad)) &&
            (axisIdx === 2 || (tcz >= win.minZ - pad && tcz <= win.maxZ + pad));
          if (!inWin) {
            for (let k = 0; k < 9; k++) out.push(soup[i0 + k]);
            continue;
          }
        }
        stripped++;
        continue;
      }
    }
    for (let k = 0; k < 9; k++) out.push(soup[i0 + k]);
  }
  return { tris: new Float32Array(out), stripped };
}

function weldSoupVerts(soup, eps) {
  eps = eps || 0.2;
  const inv = 1 / eps;
  const map = new Map();
  const verts = [];
  function key(x, y, z) {
    return (Math.round(x * inv)) + ',' + (Math.round(y * inv)) + ',' + (Math.round(z * inv));
  }
  function vid(x, y, z) {
    const k = key(x, y, z);
    if (map.has(k)) return map.get(k);
    const id = verts.length / 3;
    verts.push(x, y, z);
    map.set(k, id);
    return id;
  }
  const out = [];
  const triCount = soup.length / 9;
  for (let t = 0; t < triCount; t++) {
    const i0 = t * 9;
    const a = vid(soup[i0], soup[i0 + 1], soup[i0 + 2]);
    const b = vid(soup[i0 + 3], soup[i0 + 4], soup[i0 + 5]);
    const c = vid(soup[i0 + 6], soup[i0 + 7], soup[i0 + 8]);
    if (a === b || b === c || c === a) continue;
    out.push(verts[a * 3], verts[a * 3 + 1], verts[a * 3 + 2]);
    out.push(verts[b * 3], verts[b * 3 + 1], verts[b * 3 + 2]);
    out.push(verts[c * 3], verts[c * 3 + 1], verts[c * 3 + 2]);
  }
  return new Float32Array(out);
}

function openBoundaryEdges(soup) {
  const edges = new Map();
  function key(ax, ay, az, bx, by, bz) {
    const a = ax.toFixed(3) + ',' + ay.toFixed(3) + ',' + az.toFixed(3);
    const b = bx.toFixed(3) + ',' + by.toFixed(3) + ',' + bz.toFixed(3);
    return a < b ? a + '~' + b : b + '~' + a;
  }
  const n = soup.length / 9;
  for (let t = 0; t < n; t++) {
    const i = t * 9;
    const pts = [
      [soup[i], soup[i + 1], soup[i + 2]],
      [soup[i + 3], soup[i + 4], soup[i + 5]],
      [soup[i + 6], soup[i + 7], soup[i + 8]]
    ];
    for (let e = 0; e < 3; e++) {
      const p = pts[e], q = pts[(e + 1) % 3];
      const k = key(p[0], p[1], p[2], q[0], q[1], q[2]);
      if (!edges.has(k)) edges.set(k, { count: 0, a: p, b: q });
      edges.get(k).count++;
    }
  }
  const out = [];
  edges.forEach(function (val) {
    if (val.count === 1) out.push([val.a, val.b]);
  });
  return out;
}

function capSoupNearPlane(soup, axisIdx, plane, band) {
  band = band == null ? 0.8 : band;
  const axis = axisIdx === 0 ? 'x' : axisIdx === 1 ? 'y' : 'z';
  const raw = openBoundaryEdges(soup);
  const near = raw.filter(function (pair) {
    const ca = pair[0][axisIdx], cb = pair[1][axisIdx];
    return Math.abs(ca - plane) <= band && Math.abs(cb - plane) <= band;
  });
  if (near.length < 3) return soup;
  const cap = capFromEdges(near, axis, plane, true);
  if (!cap || cap.length < 9) return soup;
  const out = new Float32Array(soup.length + cap.length);
  out.set(soup, 0);
  out.set(Float32Array.from(cap), soup.length);
  return out;
}

function capOpenFacesOnGeometry(geometry) {
  const soup = geomToWorldSoup(geometry, 0, 0, 0);
  const edges = openBoundaryEdges(soup);
  if (edges.length < 3) return null;
  let sx = 0, sz = 0, cx = 0, cz = 0, n = 0;
  edges.forEach(function (pair) {
    sx += Math.abs(pair[0][0] - pair[1][0]);
    sz += Math.abs(pair[0][2] - pair[1][2]);
    cx += pair[0][0] + pair[1][0];
    cz += pair[0][2] + pair[1][2];
    n += 2;
  });
  const axis = sx < sz ? 'x' : 'z';
  const axisIdx = axis === 'x' ? 0 : 2;
  const plane = n ? ((axis === 'x' ? cx : cz) / n) : 0;
  const capped = capSoupNearPlane(soup, axisIdx, plane, 1.2);
  if (capped.length <= soup.length) return null;
  return soupToCenteredGeo(capped);
}

function unionKissedSoups(soupA, soupB) {
  function bboxOf(s) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < s.length; i += 3) {
      const x = s[i], y = s[i + 1], z = s[i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    return { minX: minX, minY: minY, minZ: minZ, maxX: maxX, maxY: maxY, maxZ: maxZ };
  }
  function inflate(bb, pad) {
    return {
      minX: bb.minX - pad, minY: bb.minY - pad, minZ: bb.minZ - pad,
      maxX: bb.maxX + pad, maxY: bb.maxY + pad, maxZ: bb.maxZ + pad
    };
  }
  function inBox(bb, x, y, z) {
    return x >= bb.minX && x <= bb.maxX && y >= bb.minY && y <= bb.maxY && z >= bb.minZ && z <= bb.maxZ;
  }

  const DX = 0.5257311, DY = 0.6881910, DZ = 0.4998877;

  function rayHitsTriangle(ox, oy, oz, ax, ay, az, bx, by, bz, cx, cy, cz) {
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const hx = DY * e2z - DZ * e2y;
    const hy = DZ * e2x - DX * e2z;
    const hz = DX * e2y - DY * e2x;
    const det = e1x * hx + e1y * hy + e1z * hz;
    if (det > -1e-9 && det < 1e-9) return false;
    const inv = 1 / det;
    const sx = ox - ax, sy = oy - ay, sz = oz - az;
    const u = inv * (sx * hx + sy * hy + sz * hz);
    if (u < -1e-9 || u > 1 + 1e-9) return false;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = inv * (DX * qx + DY * qy + DZ * qz);
    if (v < -1e-9 || u + v > 1 + 1e-9) return false;
    const t = inv * (e2x * qx + e2y * qy + e2z * qz);
    return t > 1e-6;
  }

  function isInsideSolid(soup, bbInflated, px, py, pz) {
    if (!inBox(bbInflated, px, py, pz)) return false;
    let hits = 0;
    const n = soup.length / 9;
    for (let t = 0; t < n; t++) {
      const i0 = t * 9;
      if (rayHitsTriangle(px, py, pz,
        soup[i0], soup[i0 + 1], soup[i0 + 2],
        soup[i0 + 3], soup[i0 + 4], soup[i0 + 5],
        soup[i0 + 6], soup[i0 + 7], soup[i0 + 8])) hits++;
    }
    return (hits % 2) === 1;
  }

  function clipAgainst(source, other) {
    const bb = inflate(bboxOf(other), 0.5);
    const out = [];
    const n = source.length / 9;
    for (let t = 0; t < n; t++) {
      const i0 = t * 9;
      const cx = (source[i0] + source[i0 + 3] + source[i0 + 6]) / 3;
      const cy = (source[i0 + 1] + source[i0 + 4] + source[i0 + 7]) / 3;
      const cz = (source[i0 + 2] + source[i0 + 5] + source[i0 + 8]) / 3;
      if (isInsideSolid(other, bb, cx, cy, cz)) continue;
      for (let k = 0; k < 9; k++) out.push(source[i0 + k]);
    }
    return out;
  }

  if (!soupA || soupA.length < 9) return soupB && soupB.length >= 9 ? new Float32Array(soupB) : new Float32Array(0);
  if (!soupB || soupB.length < 9) return new Float32Array(soupA);

  const keptA = clipAgainst(soupA, soupB);
  const keptB = clipAgainst(soupB, soupA);
  if (!keptA.length && !keptB.length) return new Float32Array(0);

  const merged = new Float32Array(keptA.length + keptB.length);
  merged.set(keptA, 0);
  merged.set(keptB, keptA.length);
  return weldSoupVerts(merged, 0.3);
}

/** Plate-space weld along X (0) or Z (2). */
function joinHalvesOnPlate(modelA, placedA, modelB, placedB, axisIdx) {
  axisIdx = (axisIdx === 2) ? 2 : 0;
  matchPlacedBottoms(placedA, placedB);
  const pyA = placedA.mesh ? placedA.mesh.position.y : (modelA.size.y / 2 + 0.3);
  const pyB = placedB.mesh ? placedB.mesh.position.y : (modelB.size.y / 2 + 0.3);
  const soupA = geomToWorldSoup(modelA.geometry, placedA.x, pyA, placedA.z);
  const soupB = geomToWorldSoup(modelB.geometry, placedB.x, pyB, placedB.z);
  const key = axisIdx === 0 ? 'x' : 'z';
  const aIsMin = placedA[key] <= placedB[key];
  const left = aIsMin ? soupA : soupB;
  const right = aIsMin ? soupB : soupA;
  const bbL = rawJoinBboxOf(left, axisIdx);
  const bbR = rawJoinBboxOf(right, axisIdx);
  const planeL = bbL.maxV;
  const planeR = bbR.minV;
  const winR = soupWorldWin(right);
  const winL = soupWorldWin(left);
  const t0 = axisIdx === 0 ? 2 : 0;
  const spanL = (t0 === 0 ? (winL.maxX - winL.minX) : (winL.maxZ - winL.minZ)) || 1;
  const spanR = (t0 === 0 ? (winR.maxX - winR.minX) : (winR.maxZ - winR.minZ)) || 1;
  const ov0 = Math.min(t0 === 0 ? winL.maxX : winL.maxZ, t0 === 0 ? winR.maxX : winR.maxZ);
  const ov1 = Math.max(t0 === 0 ? winL.minX : winL.minZ, t0 === 0 ? winR.minX : winR.minZ);
  const overlapT = Math.max(0, ov0 - ov1);
  const isLJoin = overlapT < Math.max(spanL, spanR) * 0.8;
  let leftKept = left;
  let rightKept = right;
  if (!isLJoin) {
    const extraL = rawJoinStripCapAtPlane(left, axisIdx, planeL, 0.55, winR);
    const extraR = rawJoinStripCapAtPlane(right, axisIdx, planeR, 0.55, winL);
    leftKept = extraL.tris;
    rightKept = extraR.tris;
    if (extraL.stripped === 0) {
      const band = stripFacingInBand(left, axisIdx, planeL, 0.35, winR);
      if (band.stripped > 0) leftKept = band.tris;
    }
    if (extraR.stripped === 0) {
      const band = stripFacingInBand(right, axisIdx, planeR, 0.35, winL);
      if (band.stripped > 0) rightKept = band.tris;
    }
  }
  if (leftKept.length < 9 || rightKept.length < 9) {
    throw new Error('join stripped a half empty');
  }
  const closed = isLJoin
    ? rightKept
    : rawJoinTranslateAxis(rightKept, axisIdx, planeL - planeR);

  function bboxVolumeOf(s) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < s.length; i += 3) {
      const x = s[i], y = s[i + 1], z = s[i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    return Math.max(0, maxX - minX) * Math.max(0, maxY - minY) * Math.max(0, maxZ - minZ);
  }

  const kissed = new Float32Array(leftKept.length + closed.length);
  kissed.set(leftKept, 0);
  kissed.set(closed, leftKept.length);
  const volKissed = bboxVolumeOf(kissed);

  // The old fail-safe path, kept byte-for-byte in spirit: concatenate,
  // weld, flat-cap the seam and the outer walls, weld again. This is the
  // fallback whenever the real union can't be trusted.
  function fallbackConcatWeldRepair() {
    let m = weldSoupVerts(kissed, 0.18);
    if (!isLJoin) {
      m = capSoupNearPlane(m, axisIdx, planeL, 0.8);
      m = flattenOuterWalls(m, 0.28, ['x', 'z']);
      m = capAllOuterHoles(m);
    }
    m = weldSoupVerts(m, 0.35);
    return m;
  }

  let merged;
  if (isLJoin) {
    merged = fallbackConcatWeldRepair();
  } else {
    try {
      const unioned = unionKissedSoups(leftKept, closed);
      const volUnion = (unioned && unioned.length >= 9) ? bboxVolumeOf(unioned) : 0;
      const shrunkTooMuch = volKissed > 0 && volUnion < volKissed * 0.85;
      if (unioned && unioned.length >= 9 && !shrunkTooMuch) {
        merged = flattenOuterWalls(unioned, 0.28, ['x', 'z']);
      } else {
        merged = fallbackConcatWeldRepair();
      }
    } catch (err) {
      merged = fallbackConcatWeldRepair();
    }
  }
  if (merged.length < 9) throw new Error('join weld empty');
  if (!isLJoin) {
    merged = repairJoinedSoup(merged);
    if (merged.length < 9) throw new Error('join weld empty');
  }
  return soupToCenteredGeo(merged);
}

function repairJoinedSoup(soup) {
  try {
    if (!soup || soup.length < 9) return soup;
    const original = soup;

    function bboxOf(s) {
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let i = 0; i < s.length; i += 3) {
        const x = s[i], y = s[i + 1], z = s[i + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      return { minX: minX, minY: minY, minZ: minZ, maxX: maxX, maxY: maxY, maxZ: maxZ };
    }
    function bboxVolume(bb) {
      return Math.max(0, bb.maxX - bb.minX) *
        Math.max(0, bb.maxY - bb.minY) *
        Math.max(0, bb.maxZ - bb.minZ);
    }

    const volBefore = bboxVolume(bboxOf(soup));

    // 1) Drop degenerate triangles (area < 1e-6) and exact/near-exact duplicate faces.
    function pk(x, y, z) {
      return Math.round(x * 1000) + ':' + Math.round(y * 1000) + ':' + Math.round(z * 1000);
    }
    const seenTri = new Set();
    const work = [];
    const triCount0 = soup.length / 9;
    for (let t = 0; t < triCount0; t++) {
      const i0 = t * 9;
      const ax = soup[i0], ay = soup[i0 + 1], az = soup[i0 + 2];
      const bx = soup[i0 + 3], by = soup[i0 + 4], bz = soup[i0 + 5];
      const cx = soup[i0 + 6], cy = soup[i0 + 7], cz = soup[i0 + 8];
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const area = 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (!(area > 1e-6)) continue;

      const keys = [pk(ax, ay, az), pk(bx, by, bz), pk(cx, cy, cz)].sort();
      const triKey = keys.join('|');
      if (seenTri.has(triKey)) continue;
      seenTri.add(triKey);

      work.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    }
    if (!work.length) return original;

    // 2) Weld vertices (reuse existing welder; also re-drops any triangles
    //    that collapse to zero area once shared verts snap together).
    let soupW = weldSoupVerts(new Float32Array(work), 0.3);
    if (soupW.length < 9) return original;

    // 3) Cap any remaining planar open loops with the existing capper
    //    (no new ear-clipper). Only run it while real boundary edges remain,
    //    up to 3 passes — one pass can leave a residual sliver on complex,
    //    multi-loop boundaries, and re-running on an already-watertight
    //    region just risks a fresh seam from weld-tolerance rounding.
    let soupC = soupW;
    for (let pass = 0; pass < 3; pass++) {
      if (!(typeof openBoundaryEdges === 'function' && openBoundaryEdges(soupC).length > 0)) break;
      const capped = capAllOuterHoles(soupC);
      const reWelded = weldSoupVerts(capped, 0.3);
      if (reWelded.length < 9) break;
      if (reWelded.length === soupC.length) { soupC = reWelded; break; }
      soupC = reWelded;
    }

    if (typeof capSmallOpenLoops === 'function') {
      soupC = capSmallOpenLoops(soupC, 3);
    }

    // 4) Drop small disjoint shells (<20 tris or <2% of total volume);
    //    always keep the largest shell.
    function keyv(x, y, z) {
      return Math.round(x * 2000) + ':' + Math.round(y * 2000) + ':' + Math.round(z * 2000);
    }
    const triCount2 = soupC.length / 9;
    const vidMap = new Map();
    const vpos = [];
    function vid(x, y, z) {
      const k = keyv(x, y, z);
      let id = vidMap.get(k);
      if (id === undefined) {
        id = vpos.length / 3;
        vpos.push(x, y, z);
        vidMap.set(k, id);
      }
      return id;
    }
    const triA = new Int32Array(triCount2);
    const triB = new Int32Array(triCount2);
    const triCc = new Int32Array(triCount2);
    for (let t = 0; t < triCount2; t++) {
      const i0 = t * 9;
      triA[t] = vid(soupC[i0], soupC[i0 + 1], soupC[i0 + 2]);
      triB[t] = vid(soupC[i0 + 3], soupC[i0 + 4], soupC[i0 + 5]);
      triCc[t] = vid(soupC[i0 + 6], soupC[i0 + 7], soupC[i0 + 8]);
    }
    const parent = new Array(triCount2);
    for (let t = 0; t < triCount2; t++) parent[t] = t;
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
    const edgeMap = new Map();
    function ek(a, b) { return a < b ? a + '_' + b : b + '_' + a; }
    for (let t = 0; t < triCount2; t++) {
      const a = triA[t], b = triB[t], c = triCc[t];
      const es = [ek(a, b), ek(b, c), ek(c, a)];
      for (let e = 0; e < 3; e++) {
        const k = es[e];
        if (!edgeMap.has(k)) edgeMap.set(k, []);
        edgeMap.get(k).push(t);
      }
    }
    edgeMap.forEach(function (list) {
      for (let i = 1; i < list.length; i++) union(list[0], list[i]);
    });

    const compTris = new Map();
    for (let t = 0; t < triCount2; t++) {
      const r = find(t);
      if (!compTris.has(r)) compTris.set(r, []);
      compTris.get(r).push(t);
    }

    if (compTris.size > 1) {
      let totalVol = 0;
      const compInfo = [];
      compTris.forEach(function (tris) {
        let vol = 0;
        for (let k = 0; k < tris.length; k++) {
          const i0 = tris[k] * 9;
          const ax = soupC[i0], ay = soupC[i0 + 1], az = soupC[i0 + 2];
          const bx = soupC[i0 + 3], by = soupC[i0 + 4], bz = soupC[i0 + 5];
          const cx = soupC[i0 + 6], cy = soupC[i0 + 7], cz = soupC[i0 + 8];
          vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
        }
        vol = Math.abs(vol);
        totalVol += vol;
        compInfo.push({ tris: tris, vol: vol });
      });

      compInfo.sort(function (a, b) {
        if (Math.abs(a.vol - b.vol) > 1e-9) return b.vol - a.vol;
        return b.tris.length - a.tris.length;
      });

      const keepTriIdx = new Set();
      for (let i = 0; i < compInfo.length; i++) {
        const c = compInfo[i];
        const share = totalVol > 0 ? c.vol / totalVol : 0;
        const keep = (i === 0) || (c.tris.length >= 20 && share >= 0.02);
        if (keep) for (let k = 0; k < c.tris.length; k++) keepTriIdx.add(c.tris[k]);
      }

      const filtered = [];
      for (let t = 0; t < triCount2; t++) {
        if (!keepTriIdx.has(t)) continue;
        const i0 = t * 9;
        for (let k = 0; k < 9; k++) filtered.push(soupC[i0 + k]);
      }
      if (filtered.length >= 9) soupC = new Float32Array(filtered);
    }

    // 5) Do not flip-by-bbox-center. Slot interiors sit closer to the
    //    center than the outer wall, so that pass inverted hundreds of
    //    good faces (Formware 207 → 1088). Leave winding as-is.

    // 6) Safety net: never emit an empty mesh or a heavily shrunk bbox.
    if (!soupC || soupC.length < 9) return original;
    const volAfter = bboxVolume(bboxOf(soupC));
    if (volBefore > 0 && volAfter < volBefore * 0.85) return original;

    return soupC;
  } catch (err) {
    return soup;
  }
}

function flattenOuterWalls(soup, tol, axes) {
  if (!soup || soup.length < 9) return soup;
  const doX = !axes || axes.indexOf('x') !== -1;
  const doY = !axes || axes.indexOf('y') !== -1;
  const doZ = !axes || axes.indexOf('z') !== -1;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < soup.length; i += 3) {
    const x = soup[i], y = soup[i + 1], z = soup[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const out = new Float32Array(soup);
  for (let i = 0; i < out.length; i += 3) {
    if (doX) {
      if (Math.abs(out[i] - minX) <= tol) out[i] = minX;
      else if (Math.abs(out[i] - maxX) <= tol) out[i] = maxX;
    }
    if (doY) {
      if (Math.abs(out[i + 1] - minY) <= tol) out[i + 1] = minY;
      else if (Math.abs(out[i + 1] - maxY) <= tol) out[i + 1] = maxY;
    }
    if (doZ) {
      if (Math.abs(out[i + 2] - minZ) <= tol) out[i + 2] = minZ;
      else if (Math.abs(out[i + 2] - maxZ) <= tol) out[i + 2] = maxZ;
    }
  }
  return out;
}

function capSmallOpenLoops(soup, maxSpanMm) {
  maxSpanMm = (maxSpanMm == null) ? 3 : maxSpanMm;
  try {
    if (!soup || soup.length < 9) return soup;
    if (typeof openBoundaryEdges !== 'function' || typeof capFromEdges !== 'function') return soup;

    const rawEdges = openBoundaryEdges(soup);
    if (!rawEdges || rawEdges.length < 3) return soup;

    let meshMinX = Infinity, meshMinY = Infinity, meshMinZ = Infinity;
    let meshMaxX = -Infinity, meshMaxY = -Infinity, meshMaxZ = -Infinity;
    for (let i = 0; i < soup.length; i += 3) {
      const x = soup[i], y = soup[i + 1], z = soup[i + 2];
      if (x < meshMinX) meshMinX = x; if (x > meshMaxX) meshMaxX = x;
      if (y < meshMinY) meshMinY = y; if (y > meshMaxY) meshMaxY = y;
      if (z < meshMinZ) meshMinZ = z; if (z > meshMaxZ) meshMaxZ = z;
    }
    function bboxVolume(minX, minY, minZ, maxX, maxY, maxZ) {
      return Math.max(0, maxX - minX) * Math.max(0, maxY - minY) * Math.max(0, maxZ - minZ);
    }
    const volBefore = bboxVolume(meshMinX, meshMinY, meshMinZ, meshMaxX, meshMaxY, meshMaxZ);

    // Build the boundary graph the same way capFromEdges does internally,
    // so we can find which open loops are small, clean (simple) cycles --
    // never touching a branch point (degree != 2) and never touching a
    // loop whose span says it's a real opening, not a defect.
    const TOL = 1e-4;
    function keyOf(p) {
      return (Math.round(p[0] / TOL) * TOL) + '|' + (Math.round(p[1] / TOL) * TOL) + '|' + (Math.round(p[2] / TOL) * TOL);
    }
    function proj2(ax, p) {
      if (ax === 'x') return [p[1], p[2]];
      if (ax === 'y') return [p[0], p[2]];
      return [p[0], p[1]];
    }
    const nodePos = new Map();
    const adj = new Map();
    function addNode(p) {
      const k = keyOf(p);
      if (!nodePos.has(k)) nodePos.set(k, p);
      if (!adj.has(k)) adj.set(k, new Set());
      return k;
    }
    rawEdges.forEach(function (pair) {
      const k0 = addNode(pair[0]);
      const k1 = addNode(pair[1]);
      if (k0 === k1) return;
      adj.get(k0).add(k1);
      adj.get(k1).add(k0);
    });

    const visited = new Set();
    const extraPatches = [];

    for (const start of adj.keys()) {
      if (visited.has(start)) continue;
      if (adj.get(start).size !== 2) { visited.add(start); continue; }

      const loopKeys = [start];
      let prev = start;
      let cur = Array.from(adj.get(start))[0];
      let clean = true;
      let guard = 0;
      while (cur !== start && guard++ < 5000) {
        if (!adj.has(cur) || adj.get(cur).size !== 2) { clean = false; break; }
        loopKeys.push(cur);
        const nbs = Array.from(adj.get(cur));
        const next = (nbs[0] === prev) ? nbs[1] : nbs[0];
        prev = cur;
        cur = next;
      }
      loopKeys.forEach(function (k) { visited.add(k); });
      visited.add(start);
      if (!clean || cur !== start || loopKeys.length < 3) continue;

      const pts = loopKeys.map(function (k) { return nodePos.get(k); });
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      pts.forEach(function (p) {
        if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
        if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
        if (p[2] < minZ) minZ = p[2]; if (p[2] > maxZ) maxZ = p[2];
      });
      const spanX = maxX - minX, spanY = maxY - minY, spanZ = maxZ - minZ;
      const span = Math.sqrt(spanX * spanX + spanY * spanY + spanZ * spanZ);

      // Cap with whichever axis this specific loop is flattest along (a
      // deck pinhole is flat in Y; a seam sliver off the side walls is
      // flat in X or Z) -- reuses capFromEdges, no new triangulator.
      let axis = 'x', planeVal = (minX + maxX) / 2, flatSpan = spanX;
      if (spanY < flatSpan) { axis = 'y'; planeVal = (minY + maxY) / 2; flatSpan = spanY; }
      if (spanZ < flatSpan) { axis = 'z'; planeVal = (minZ + maxZ) / 2; flatSpan = spanZ; }

      let shouldCap;
      if (span <= maxSpanMm) {
        // Small enough to be a pinhole / seam-tessellation sliver -- always cap.
        shouldCap = true;
      } else {
        // Large loop. This is where "missing wall" vs "real slot" gets
        // decided -- by SHAPE, not size. Isoperimetric quotient
        // Q = 4*pi*Area / Perimeter^2 is 1.0 for a perfect circle and
        // drops well below ~0.7 for anything rectangular or irregular.
        // A genuine circular/oval slot the user cut on purpose stays
        // open no matter how big; a missing wall's rectangle-ish
        // outline gets filled. Axis/face is never part of the test, so
        // a slot sitting on the same face as a missing wall is never
        // mistaken for one.
        const pts2 = pts.map(function (p) { return proj2(axis, p); });
        let area2 = 0, perim = 0;
        for (let i = 0; i < pts2.length; i++) {
          const a = pts2[i], b = pts2[(i + 1) % pts2.length];
          area2 += a[0] * b[1] - b[0] * a[1];
          perim += Math.hypot(b[0] - a[0], b[1] - a[1]);
        }
        const area = Math.abs(area2) / 2;
        const Q = perim > 1e-6 ? (4 * Math.PI * area) / (perim * perim) : 0;
        const CIRCULARITY_MIN = 0.72;
        shouldCap = Q < CIRCULARITY_MIN;
      }
      if (!shouldCap) continue;

      const meshMin = axis === 'x' ? meshMinX : axis === 'y' ? meshMinY : meshMinZ;
      const meshMax = axis === 'x' ? meshMaxX : axis === 'y' ? meshMaxY : meshMaxZ;
      const keepMin = Math.abs(planeVal - meshMax) < Math.abs(planeVal - meshMin);

      const edgePairs = [];
      for (let i = 0; i < pts.length; i++) {
        edgePairs.push([pts[i], pts[(i + 1) % pts.length]]);
      }
      const cap = capFromEdges(edgePairs, axis, planeVal, keepMin);
      if (cap && cap.length >= 9) {
        for (let i = 0; i < cap.length; i++) extraPatches.push(cap[i]);
      }
    }

    if (!extraPatches.length) return soup;

    const out = new Float32Array(soup.length + extraPatches.length);
    out.set(soup, 0);
    out.set(Float32Array.from(extraPatches), soup.length);

    let outMinX = Infinity, outMinY = Infinity, outMinZ = Infinity;
    let outMaxX = -Infinity, outMaxY = -Infinity, outMaxZ = -Infinity;
    for (let i = 0; i < out.length; i += 3) {
      const x = out[i], y = out[i + 1], z = out[i + 2];
      if (x < outMinX) outMinX = x; if (x > outMaxX) outMaxX = x;
      if (y < outMinY) outMinY = y; if (y > outMaxY) outMaxY = y;
      if (z < outMinZ) outMinZ = z; if (z > outMaxZ) outMaxZ = z;
    }
    const volAfter = bboxVolume(outMinX, outMinY, outMinZ, outMaxX, outMaxY, outMaxZ);
    if (volBefore > 0 && volAfter < volBefore * 0.85) return soup;

    return out;
  } catch (err) {
    return soup;
  }
}

function capAllOuterHoles(soup) {
  if (!soup || soup.length < 9) return soup;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < soup.length; i += 3) {
    const x = soup[i], y = soup[i + 1], z = soup[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  let out = soup;
  const faces = [
    [0, minX], [0, maxX],
    [2, minZ], [2, maxZ]
  ];
  for (let i = 0; i < faces.length; i++) {
    out = capSoupNearPlane(out, faces[i][0], faces[i][1], 0.55);
  }
  return out;
}

// ===================== Durable face pick =====================
// One click stores one plane, and every finish action downstream reads
// that stored plane and nothing else. This exists because the bug class it
// closes kept coming back in a new disguise: a click captured a face, then
// some engine further down re-derived "which face was meant" from the
// piece's own bounding box (min/max on an axis), from the largest flat
// patch, or from the display Y-max, and the radius landed on the lid while
// the clicked wall never moved. There is now exactly one place where a
// face is chosen — storeFacePick — and the engines are handed the answer.
//
// The pick is durable on purpose: it survives a bake, so Round then
// Corners then Cap all hit the same face without re-clicking. It is
// re-validated against the live raw soup on every read, so a pick that no
// longer describes a real plane on the live piece is dropped rather than
// silently snapped onto a neighbouring face.

// Tolerance for "the click landed on this plane" and for "the stored plane
// is still this piece's plane", in mm. Wide enough for a tessellated wall,
// far tighter than the gap between two faces of any printable piece.
const FACE_PICK_TOL = 0.35;
// A face has to actually be flat under the cursor. Below this the hit is on
// a fillet or a curved end, which has no cap/wall boundary to work with.
const FACE_PICK_FLAT = 0.92;

// The display mesh is the raw soup rotated -90deg about X
// (rawResultToDisplayGeometry): dispX = rawX, dispY = rawZ, dispZ = -rawY.
// So a display-Z wall is raw axis 1 with the sign flipped, and the display
// top is raw axis 2. Passing a display index straight into a raw engine is
// what sent Soften to the top of the piece; this is the only place the
// mapping is written down.
function rawAxisFromDisplay(dispAxis, dispSign) {
  if (dispAxis === 0) return { rawAxisIdx: 0, rawKeepMin: dispSign < 0 };
  if (dispAxis === 1) return { rawAxisIdx: 2, rawKeepMin: dispSign < 0 };
  return { rawAxisIdx: 1, rawKeepMin: dispSign > 0 };
}

// Does the piece still carry a flat face on this axis, facing this way, on
// this plane? The outer-plane check cannot answer that for a pocket wall.
function rawHasPlane(rawTris, axisIdx, keepMin, at) {
  const want = keepMin ? -1 : 1;
  for (let t = 0; t + 8 < rawTris.length; t += 9) {
    const ux = rawTris[t+3]-rawTris[t], uy = rawTris[t+4]-rawTris[t+1], uz = rawTris[t+5]-rawTris[t+2];
    const vx = rawTris[t+6]-rawTris[t], vy = rawTris[t+7]-rawTris[t+1], vz = rawTris[t+8]-rawTris[t+2];
    let nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
    const L = Math.hypot(nx, ny, nz);
    if (!(L > 1e-12)) continue;
    const n = [nx/L, ny/L, nz/L];
    if (Math.abs(n[axisIdx]) < 0.999 || (n[axisIdx] >= 0 ? 1 : -1) !== want) continue;
    if (Math.abs(rawTris[t+axisIdx] - at) < FACE_PICK_TOL) return true;
  }
  return false;
}

// The coordinate of the outer plane on one raw axis. Used to express the
// clicked plane in raw units and to re-validate a stored pick — never to
// decide which face the user meant.
function rawExtremeOf(rawTris, axisIdx, keepMin) {
  let minV = Infinity, maxV = -Infinity;
  for (let i = axisIdx; i < rawTris.length; i += 3) {
    if (rawTris[i] < minV) minV = rawTris[i];
    if (rawTris[i] > maxV) maxV = rawTris[i];
  }
  if (!isFinite(minV) || !isFinite(maxV)) return NaN;
  return keepMin ? minV : maxV;
}

function rawSpanOf(rawTris, axisIdx) {
  let minV = Infinity, maxV = -Infinity;
  for (let i = axisIdx; i < rawTris.length; i += 3) {
    if (rawTris[i] < minV) minV = rawTris[i];
    if (rawTris[i] > maxV) maxV = rawTris[i];
  }
  return (isFinite(minV) && isFinite(maxV)) ? (maxV - minV) : NaN;
}

// A thin edge cage on the piece a bake just produced, so the new corners can
// be inspected without the yellow face patch pretending the pick is still
// armed. Purely additive: a LineSegments child on the placed mesh, never a
// material change, so nothing about the library colours moves - and it dies
// with the mesh on Undo.
function clearInspectCage() {
  const cage = state.inspectCage;
  if (cage) {
    if (cage.parent) cage.parent.remove(cage);
    if (cage.geometry) cage.geometry.dispose();
    if (cage.material) cage.material.dispose();
  }
  state.inspectCage = null;
}

function showInspectCage(model) {
  clearInspectCage();
  if (!model || !state.placed) return;
  const placed = state.placed.find(function (p) { return p && p.sourceId === model.id; });
  const mesh = placed ? placed.mesh : null;
  if (!mesh || !mesh.geometry) return;
  try {
    // 1 degree, not the 15 the selection outline uses: at 15 a fillet's own
    // facets are invisible and the cage shows nothing worth inspecting.
    const edges = new THREE.EdgesGeometry(mesh.geometry, 1);
    const mat = new THREE.LineBasicMaterial({
      color: 0x7dd3fc, transparent: true, opacity: 0.55,
      depthTest: false, depthWrite: false
    });
    const cage = new THREE.LineSegments(edges, mat);
    cage.renderOrder = 16;
    cage.name = 'inspectCage';
    cage.raycast = function () {};
    mesh.add(cage);
    state.inspectCage = cage;
  } catch (e) {
    state.inspectCage = null;
  }
}

function clearFacePick() {
  state.facePick = null;
  if (typeof removeFaceHelper === 'function') removeFaceHelper();
  clearInspectCage();
}

// Gather the clicked face's own coplanar patch, in world space, for the
// highlight. Purely visual: nothing reads these triangles to decide a
// plane.
function facePatchWorldTris(mesh, nWorld, planeW) {
  const geo = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
  const pos = geo.attributes.position;
  const kept = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const tn = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    mesh.localToWorld(a); mesh.localToWorld(b); mesh.localToWorld(c);
    tn.crossVectors(b.clone().sub(a), c.clone().sub(a)).normalize();
    if (tn.dot(nWorld) < FACE_PICK_FLAT) continue;
    const mx = (a.x + b.x + c.x) / 3, my = (a.y + b.y + c.y) / 3, mz = (a.z + b.z + c.z) / 3;
    if (Math.abs(nWorld.x * mx + nWorld.y * my + nWorld.z * mz - planeW) > FACE_PICK_TOL) continue;
    kept.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  }
  return kept;
}

// One click, one answer to "which face is this?", shared by the Soften pick
// and the paint. Reads hit.face.normal - three.js's own local normal for the
// triangle under the cursor, correct on indexed and non-indexed geometry
// alike - and runs it through rawAxisFromDisplay, the one place the display
// to raw mapping is written down. Anything that wants the face a click named
// asks this and stores what it says. Nothing re-derives it later from a
// plane, a bounding box or a second copy of the mapping: that is the bug
// class where the yellow lands on the side and the exclude lands on the top.
//
// Returns null with a reason when the click cannot be described honestly.
// `outer` is false for a recessed wall - a pocket floor after a boolean -
// which is a real face for the paint but not one the whole-solid wrap can
// name, and the caller is told so rather than being handed a guess.
function nsoFaceFromHit(model, mesh, hit) {
  if (!model || !model.rawTris || model.rawAxis !== 'zup') return null;
  if (!mesh || !mesh.geometry || !hit || !hit.face) return null;
  const nLocal = hit.face.normal.clone().normalize();
  const nAbs = [Math.abs(nLocal.x), Math.abs(nLocal.y), Math.abs(nLocal.z)];
  let dispAxis = 0;
  if (nAbs[1] > nAbs[dispAxis]) dispAxis = 1;
  if (nAbs[2] > nAbs[dispAxis]) dispAxis = 2;
  if (nAbs[dispAxis] < FACE_PICK_FLAT) return { flat: false };
  const dispSign = ([nLocal.x, nLocal.y, nLocal.z][dispAxis] >= 0) ? 1 : -1;

  const geo = mesh.geometry;
  if (!geo.boundingBox) geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const bbLo = [bb.min.x, bb.min.y, bb.min.z][dispAxis];
  const bbHi = [bb.max.x, bb.max.y, bb.max.z][dispAxis];
  const localPlane = dispSign > 0 ? bbHi : bbLo;
  mesh.updateMatrixWorld();
  const pLocal = mesh.worldToLocal(hit.point.clone());
  const localHit = [pLocal.x, pLocal.y, pLocal.z][dispAxis];

  const mapped = rawAxisFromDisplay(dispAxis, dispSign);
  const rawPlane = rawExtremeOf(model.rawTris, mapped.rawAxisIdx, mapped.rawKeepMin);
  // Where a recessed face sits, in raw units. A pocket wall is a real face of
  // the piece and has to be nameable, but it is not the outer plane, so
  // rawExtremeOf does not reach it. This measures the piece against itself:
  // the display span on this axis and the raw span on the axis it maps to are
  // the same piece, and rawAxisFromDisplay already said which end matches
  // which. No centring constant, no second copy of the mapping.
  const rawLo = rawExtremeOf(model.rawTris, mapped.rawAxisIdx, true);
  const rawHi = rawExtremeOf(model.rawTris, mapped.rawAxisIdx, false);
  let rawAt = rawPlane;
  const dSpan = bbHi - bbLo, rSpan = rawHi - rawLo;
  if (dSpan > 1e-9 && isFinite(rSpan)) {
    // Which way this display axis runs against the raw one it maps to is a
    // property of the AXIS, so it is read at a fixed sign - the display-max
    // end of it, and whether that is the raw min end. Reading it off the
    // clicked face's own normal instead makes the answer depend on which way
    // that face happens to look: correct for a face whose normal points the
    // way the axis runs, mirrored for one that points back down it. Outer
    // faces never noticed, because they do not use this - they take their
    // plane from rawExtremeOf. A pocket has two walls per axis, one of each,
    // and the second was landing on the mirror of its own plane.
    const axisFlip = rawAxisFromDisplay(dispAxis, 1).rawKeepMin;
    const t = (localHit - bbLo) / dSpan;
    rawAt = axisFlip ? (rawHi - t * rSpan) : (rawLo + t * rSpan);
  }
  return {
    flat: true,
    outer: Math.abs(localHit - localPlane) <= FACE_PICK_TOL,
    recessedBy: Math.abs(localHit - localPlane),
    rawAt: rawAt,
    localHit: localHit,
    dispAxis: dispAxis,
    dispSign: dispSign,
    localPlane: localPlane,
    localNormal: nLocal,
    localPoint: pLocal,
    bbSpan: bbHi - bbLo,
    rawAxisIdx: mapped.rawAxisIdx,
    rawKeepMin: mapped.rawKeepMin,
    rawPlane: rawPlane
  };
}
window.nsoFaceFromHit = nsoFaceFromHit;

// The canvas click ray already found a triangle; this turns that triangle
// into the stored plane. Rejects — with a reason — anything it cannot
// describe honestly, and never substitutes a different face.
function storeFacePick(hit) {
  clearFacePick();
  if (!hit || !hit.face || !hit.object || !hit.object.geometry) {
    setStatus('Click a face', true);
    return null;
  }
  state.nsoWrapAll = null;

  let owner = hit.object;
  while (owner && (!owner.userData || owner.userData.sourceId == null) && owner.parent) owner = owner.parent;
  const modelId = (owner && owner.userData) ? owner.userData.sourceId : null;
  const model = (modelId != null && state.models)
    ? state.models.find(function (m) { return m && m.id === modelId; })
    : null;
  if (!model) {
    setStatus('Click a face on a placed piece', true);
    return null;
  }
  if (!model.rawTris || model.rawAxis !== 'zup') {
    setStatus('Click a face - this piece has no raw soup (Square-split or load it first)', true);
    return null;
  }

  // Before anything is asked of the triangle: if this is a Full wrap on a
  // painted piece that has a pocket, the click is the whole job and no face
  // needs naming. Marked here rather than answered here, so applySoftenOnFace
  // runs it through the same run bookkeeping every other bake uses.
  // Only for a Soften click: this same resolver serves the Cap tool, which
  // has its own use for the clicked face and nothing to do with Full wrap.
  if (state.softenArmed && nsoWrapAllReady(model)) {
    state.nsoWrapAll = model.id;
    return { wrapAll: true, modelId: model.id };
  }

  const mesh = hit.object;
  mesh.updateMatrixWorld();
  // Which face the click named is nsoFaceFromHit's answer and only its
  // answer - the same call the paint makes, so a pick and a paint on the
  // same triangle can never name two different faces.
  const face = nsoFaceFromHit(model, mesh, hit);
  if (!face) {
    setStatus('Click a face', true);
    return null;
  }
  if (!face.flat) {
    setStatus('Click a flat face - that spot is on a curve', true);
    return null;
  }
  // The raw engines work on the outer plane of the axis they are given —
  // they cannot cut a recessed pocket wall. If the click is not on that
  // outer plane, say so instead of letting an engine slide the work onto
  // the plane it can reach.
  //
  // The one exception is a Full wrap on a pocket piece. There the click is
  // only "go" - the wrap does the whole solid and reads the skip list, not
  // this pick - and with the hull painted out a pocket wall is the only face
  // left to click. The pick is marked recessed so the per-face path, which
  // really cannot use it, still refuses.
  const wrapWhole = (typeof getFullWrap === 'function') && getFullWrap() &&
                    (!!rawPocketBrick(model.rawTris) ||
                     rawBoxPockets(model.rawTris).length > 0);
  if (!face.outer && !wrapWhole) {
    setStatus('Click an outer face - that one is recessed ' +
              face.recessedBy.toFixed(2) + 'mm behind the outside', true);
    return null;
  }
  const nLocal = face.localNormal;
  const nWorld = nLocal.clone().transformDirection(mesh.matrixWorld).normalize();
  const pWorld = hit.point.clone();
  const pLocal = face.localPoint;
  const dispAxis = face.dispAxis, dispSign = face.dispSign;
  const localPlane = face.localPlane;
  const mapped = { rawAxisIdx: face.rawAxisIdx, rawKeepMin: face.rawKeepMin };
  // Cross-check the display->raw mapping against the piece itself: the two
  // axes must measure the same piece. A mismatch means the soup and the
  // display mesh have drifted apart, and every plane below would be
  // fiction.
  const dispSpan = face.bbSpan;
  const rawSpan = rawSpanOf(model.rawTris, mapped.rawAxisIdx);
  if (!isFinite(rawSpan) || Math.abs(rawSpan - dispSpan) > Math.max(FACE_PICK_TOL, dispSpan * 0.02)) {
    setStatus('Click a face - raw soup and display mesh disagree on this piece', true);
    return null;
  }

  const rawPlane = face.outer ? face.rawPlane : face.rawAt;
  if (!isFinite(rawPlane)) {
    setStatus('Click a face - piece has no geometry on that axis', true);
    return null;
  }

  const planeW = nWorld.dot(pWorld);
  const worldTris = facePatchWorldTris(mesh, nWorld, planeW);
  if (worldTris.length < 9) {
    setStatus('Click a face - no flat patch found there', true);
    return null;
  }

  const pick = {
    modelId: model.id,
    // world plane, as clicked
    worldPoint: pWorld,
    worldNormal: nWorld,
    worldPlane: planeW,
    // local (display-geometry) plane
    localPoint: pLocal,
    localNormal: nLocal,
    localPlane: localPlane,
    dispAxis: dispAxis,
    dispSign: dispSign,
    // the same plane in the piece's own raw 'zup' space - what the engines eat
    rawAxisIdx: mapped.rawAxisIdx,
    rawKeepMin: mapped.rawKeepMin,
    rawPlane: rawPlane,
    recessed: !face.outer,
    // display-space aliases Join's existing readers expect
    axis: dispAxis === 0 ? 'x' : (dispAxis === 1 ? 'y' : 'z'),
    axisIdx: dispAxis,
    sign: dispSign,
    point: pWorld.clone(),
    worldTris: worldTris
  };
  state.facePick = pick;
  showPlanarHighlight(mesh, pick);
  return pick;
}

// Read the stored pick for a model, re-validated against that model's live
// raw soup. Returns null if there is no pick, it belongs to another piece,
// or the piece has moved on under it — callers treat null as "click a
// face" and leave the mesh alone.
function getFacePick(model) {
  const pick = state.facePick;
  if (!pick || !model || pick.modelId !== model.id) return null;
  if (!model.rawTris || model.rawAxis !== 'zup') return null;
  // A recessed pick names a plane inside the piece, so the outer plane is not
  // what it should be re-validated against. It is only ever a "go" for the
  // whole-solid wrap, which reads the skip list and not this plane, so the
  // check is that the piece still has that face at all.
  if (pick.recessed) {
    return rawHasPlane(model.rawTris, pick.rawAxisIdx, pick.rawKeepMin, pick.rawPlane) ? pick : null;
  }
  const live = rawExtremeOf(model.rawTris, pick.rawAxisIdx, pick.rawKeepMin);
  if (!isFinite(live) || Math.abs(live - pick.rawPlane) > FACE_PICK_TOL) return null;
  // Cap moves the plane inward by its own EPS; track that so a follow-up
  // Soften on the same pick still lands on the face the user clicked.
  pick.rawPlane = live;
  return pick;
}

// Re-derive the highlight and the pick's stale world/local fields against a
// rebuilt display mesh. NOT called after a bake any more: a bake ends with
// clearFacePick(), so the overlay goes and the face has to be clicked again.
// Kept for a caller that rebuilds the mesh without consuming the pick.
function refreshFacePickHighlight() {
  const pick = state.facePick;
  if (!pick) { if (typeof removeFaceHelper === 'function') removeFaceHelper(); return; }
  const placed = state.placed
    ? state.placed.find(function (p) { return p && p.sourceId === pick.modelId; })
    : null;
  const mesh = placed ? placed.mesh : null;
  if (!mesh || !mesh.geometry) { if (typeof removeFaceHelper === 'function') removeFaceHelper(); return; }
  mesh.updateMatrixWorld();
  const geo = mesh.geometry;
  if (!geo.boundingBox) geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const lo = [bb.min.x, bb.min.y, bb.min.z][pick.dispAxis];
  const hi = [bb.max.x, bb.max.y, bb.max.z][pick.dispAxis];
  pick.localPlane = pick.dispSign > 0 ? hi : lo;
  const nLocal = new THREE.Vector3(
    pick.dispAxis === 0 ? pick.dispSign : 0,
    pick.dispAxis === 1 ? pick.dispSign : 0,
    pick.dispAxis === 2 ? pick.dispSign : 0
  );
  const pLocal = new THREE.Vector3(
    pick.dispAxis === 0 ? pick.localPlane : (bb.min.x + bb.max.x) / 2,
    pick.dispAxis === 1 ? pick.localPlane : (bb.min.y + bb.max.y) / 2,
    pick.dispAxis === 2 ? pick.localPlane : (bb.min.z + bb.max.z) / 2
  );
  pick.localNormal = nLocal;
  pick.localPoint = pLocal.clone();
  const nWorld = nLocal.clone().transformDirection(mesh.matrixWorld).normalize();
  const pWorld = mesh.localToWorld(pLocal.clone());
  pick.worldNormal = nWorld;
  pick.worldPoint = pWorld;
  pick.point = pWorld.clone();
  pick.worldPlane = nWorld.dot(pWorld);
  const tris = facePatchWorldTris(mesh, nWorld, pick.worldPlane);
  if (typeof removeFaceHelper === 'function') removeFaceHelper();
  if (tris.length < 9) return;
  pick.worldTris = tris;
  showPlanarHighlight(mesh, pick);
}

function captureJoinFace(hit) {
  return capturePlanarFace(hit);
}

function capturePlanarFace(hit) {
  if (!hit || !hit.face || !hit.object || !hit.object.geometry) return null;
  const mesh = hit.object;
  const nHit = hit.face.normal.clone().transformDirection(mesh.matrixWorld).normalize();
  if (Math.abs(nHit.y) >= Math.abs(nHit.x) && Math.abs(nHit.y) >= Math.abs(nHit.z)) {
    setStatus('Click a side wall, not the top');
    return null;
  }
  const planeW = nHit.dot(hit.point);
  const geo = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
  const pos = geo.attributes.position;
  const kept = [];
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();
  const tn = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    tmpA.fromBufferAttribute(pos, i);
    tmpB.fromBufferAttribute(pos, i + 1);
    tmpC.fromBufferAttribute(pos, i + 2);
    mesh.localToWorld(tmpA);
    mesh.localToWorld(tmpB);
    mesh.localToWorld(tmpC);
    tn.crossVectors(tmpB.clone().sub(tmpA), tmpC.clone().sub(tmpA)).normalize();
    if (tn.dot(nHit) < 0.92) continue;
    const mid = tmpA.clone().add(tmpB).add(tmpC).multiplyScalar(1 / 3);
    if (Math.abs(nHit.dot(mid) - planeW) > 0.35) continue;
    kept.push(tmpA.x, tmpA.y, tmpA.z, tmpB.x, tmpB.y, tmpB.z, tmpC.x, tmpC.y, tmpC.z);
  }
  if (kept.length < 9) return null;
  const axis = Math.abs(nHit.x) >= Math.abs(nHit.z) ? 'x' : 'z';
  const sign = axis === 'x' ? (nHit.x >= 0 ? 1 : -1) : (nHit.z >= 0 ? 1 : -1);
  // axis/axisIdx/sign stay DISPLAY space - Cap and Join read them and are not
  // being changed here. rawAxisIdx/rawKeepMin are the same face expressed in
  // the piece's own raw 'zup' space, which is what the soften engine works in.
  // The display mesh is the raw soup rotated -90deg about X
  // (rawResultToDisplayGeometry), so dispX = rawX, dispY = rawZ and
  // dispZ = -rawY. A display-Z wall is therefore raw axis 1 with the sign
  // flipped; passing the display index straight through sends the engine to
  // raw axis 2, which is the TOP of the piece - the clicked face never moves
  // and the radius lands on the lid instead.
  const rawAxisIdx = axis === 'x' ? 0 : 1;
  const rawKeepMin = axis === 'x' ? (nHit.x < 0) : (nHit.z > 0);
  return {
    axis: axis,
    axisIdx: axis === 'x' ? 0 : 2,
    sign: sign,
    rawAxisIdx: rawAxisIdx,
    rawKeepMin: rawKeepMin,
    point: hit.point.clone(),
    worldTris: kept
  };
}

function showPlanarHighlight(mesh, face) {
  removeFaceHelper();
  if (!face || !face.worldTris || !state.scene) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(face.worldTris, 3));
  // Cyan, not the amber this used to be. Amber next to the paint's yellow is
  // two signals that look like one: an armed face read as a painted face, and
  // this one is drawn through the solid, so it looked like paint on a face
  // the cursor was nowhere near. depthWrite off for the same reason the
  // outline has it off - it must not leave depth in front of the paint.
  const hl = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color: 0x38bdf8,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.45,
    depthTest: false,
    depthWrite: false
  }));
  hl.renderOrder = 20;
  state.scene.add(hl);
  state.faceHelper = hl;
}

function removeFaceHelper() {
  if (state.faceHelper && state.faceHelper.parent) {
    state.faceHelper.parent.remove(state.faceHelper);
  }
  if (state.faceHelper) {
    if (state.faceHelper.geometry) state.faceHelper.geometry.dispose();
    if (state.faceHelper.material) state.faceHelper.material.dispose();
  }
  state.faceHelper = null;
}

function showFaceHighlight(hit) {
  removeFaceHelper();
  if (!hit || !hit.face || !state.scene) return;
  const geo = new THREE.BufferGeometry();
  const pos = hit.object.geometry.attributes.position;
  const ia = hit.face.a, ib = hit.face.b, ic = hit.face.c;
  const a = new THREE.Vector3().fromBufferAttribute(pos, ia);
  const b = new THREE.Vector3().fromBufferAttribute(pos, ib);
  const c = new THREE.Vector3().fromBufferAttribute(pos, ic);
  hit.object.localToWorld(a);
  hit.object.localToWorld(b);
  hit.object.localToWorld(c);
  const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
  a.addScaledVector(n, 0.25);
  b.addScaledVector(n, 0.25);
  c.addScaledVector(n, 0.25);
  geo.setAttribute('position', new THREE.Float32BufferAttribute([
    a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z
  ], 3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color: 0x38bdf8,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.85,
    depthTest: false,
    depthWrite: false
  }));
  mesh.renderOrder = 20;
  state.scene.add(mesh);
  state.faceHelper = mesh;
}

function detectMateAxis(placedA, placedB) {
  if (!placedA || !placedB || !placedA.mesh || !placedB.mesh) return 'x';
  const bbA = meshLocalBox3(placedA.mesh);
  const bbB = meshLocalBox3(placedB.mesh);
  const sepX = bbA.max.x < bbB.min.x ? bbB.min.x - bbA.max.x
    : bbB.max.x < bbA.min.x ? bbA.min.x - bbB.max.x : 0;
  const sepZ = bbA.max.z < bbB.min.z ? bbB.min.z - bbA.max.z
    : bbB.max.z < bbA.min.z ? bbA.min.z - bbB.max.z : 0;
  if (sepZ > 0.2 && sepZ >= sepX) return 'z';
  if (sepX > 0.2) return 'x';
  const dx = Math.abs(((bbA.min.x + bbA.max.x) - (bbB.min.x + bbB.max.x)) / 2);
  const dz = Math.abs(((bbA.min.z + bbA.max.z) - (bbB.min.z + bbB.max.z)) / 2);
  return dz >= dx ? 'z' : 'x';
}

function autoKissOnFaces(placedA, faceA, placedB, faceB) {
  if (!placedA || !placedB) return faceA && faceA.axisIdx === 2 ? 2 : 0;
  const fa = placedFootprint(placedA);
  const fb = placedFootprint(placedB);
  const dx = ((fb.minx + fb.maxx) - (fa.minx + fa.maxx)) / 2;
  const dz = ((fb.minz + fb.maxz) - (fa.minz + fa.maxz)) / 2;
  if (Math.abs(dx) >= Math.abs(dz)) {
    applyPlacedXZ(placedB, dx >= 0 ? placedB.x + (fa.maxx - fb.minx) : placedB.x + (fa.minx - fb.maxx), placedB.z);
    return 0;
  }
  applyPlacedXZ(placedB, placedB.x, dz >= 0 ? placedB.z + (fa.maxz - fb.minz) : placedB.z + (fa.minz - fb.maxz));
  return 2;
}

function meshBandExtent(mesh, axis, tMin, tMax, pad) {
  const out = { min: Infinity, max: -Infinity, hits: false, groups: [] };
  if (!mesh || !mesh.geometry) return out;
  const posAttr = mesh.geometry.attributes && mesh.geometry.attributes.position;
  if (!posAttr) return out;
  mesh.updateMatrixWorld(true);
  const m = mesh.matrixWorld.elements;
  const p = pad == null ? 0.05 : pad;
  const lo = Math.min(tMin, tMax) - p;
  const hi = Math.max(tMin, tMax) + p;
  const wantX = axis === 'x';
  const index = mesh.geometry.index;
  const triCount = index ? (index.count / 3) : (posAttr.count / 3);
  const WALL_FLATNESS_TOL = 0.6; // mm -- a real wall barely varies in its own normal coord

  function vertAt(vi) {
    const i = index ? index.getX(vi) : vi;
    const lx = posAttr.getX(i), ly = posAttr.getY(i), lz = posAttr.getZ(i);
    const wx = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
    const wz = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
    return { t: wantX ? wz : wx, n: wantX ? wx : wz };
  }
  function clipHalf(poly, bound, side) {
    if (!poly.length) return poly;
    const res = [];
    for (let i = 0; i < poly.length; i++) {
      const cur = poly[i], nxt = poly[(i + 1) % poly.length];
      const curIn = side > 0 ? cur.t >= bound : cur.t <= bound;
      const nxtIn = side > 0 ? nxt.t >= bound : nxt.t <= bound;
      if (curIn) res.push(cur);
      if (curIn !== nxtIn) {
        const dt = nxt.t - cur.t;
        const f = dt !== 0 ? (bound - cur.t) / dt : 0;
        res.push({ t: bound, n: cur.n + (nxt.n - cur.n) * f });
      }
    }
    return res;
  }
  // Distinct wall FACES in this band, each kept as its own [min,max] envelope
  // (not collapsed to one shared value) -- a real STL wall isn't perfectly
  // flat (triangulation/export noise of a few tenths of a mm), and averaging
  // that noise away from the true outer surface is what left a persistent
  // sliver gap after Join. Keeping the envelope lets us use the correct
  // outward extreme per direction instead of a blurred average.
  const groups = [];
  for (let ti = 0; ti < triCount; ti++) {
    let poly = [vertAt(ti * 3), vertAt(ti * 3 + 1), vertAt(ti * 3 + 2)];
    poly = clipHalf(poly, lo, 1);
    if (!poly.length) continue;
    poly = clipHalf(poly, hi, -1);
    if (!poly.length) continue;
    let nMin = Infinity, nMax = -Infinity;
    for (let k = 0; k < poly.length; k++) {
      if (poly[k].n < nMin) nMin = poly[k].n;
      if (poly[k].n > nMax) nMax = poly[k].n;
    }
    // Skip cap/floor-like faces that aren't roughly perpendicular to this
    // axis (their "n" coordinate sweeps across the whole face instead of
    // staying flat) -- these aren't real walls and pollute the result.
    if (nMax - nMin > WALL_FLATNESS_TOL) continue;
    out.hits = true;
    if (nMin < out.min) out.min = nMin;
    if (nMax > out.max) out.max = nMax;

    let g = null;
    for (let gi = 0; gi < groups.length; gi++) {
      const gg = groups[gi];
      // Same wall face if this triangle's range overlaps the group's
      // envelope once padded by the flatness tolerance.
      if (nMin <= gg.max + WALL_FLATNESS_TOL && nMax >= gg.min - WALL_FLATNESS_TOL) { g = gg; break; }
    }
    if (!g) { groups.push({ min: nMin, max: nMax }); }
    else { if (nMin < g.min) g.min = nMin; if (nMax > g.max) g.max = nMax; }
  }
  out.groups = groups;
  return out;
}

function alignJoinForSlide() {
  const idA = state.editId;
  const idB = state.joinPartnerId;
  if (!state.joinSession || idA == null || idB == null || idA === idB) {
    setStatus('Pick A and B first', true);
    return false;
  }
  const placedA = state.placed.find(function (p) { return p && p.sourceId === idA && p.mesh; });
  const placedB = state.placed.find(function (p) { return p && p.sourceId === idB && p.mesh; });
  if (!placedA || !placedB) {
    setStatus('Both pieces must be on the plate', true);
    return false;
  }
  const fa = placedFootprint(placedA);
  const fb = placedFootprint(placedB);
  const CONCAVE_TOL = 1.0; // mm

  const xBand = meshBandExtent(placedA.mesh, 'x', fb.minz, fb.maxz);
  const zBand = meshBandExtent(placedA.mesh, 'z', fb.minx, fb.maxx);

  // Pick, among A's distinct wall faces in the band, the one whose relevant
  // OUTWARD extreme (max for a "+" facing candidate, min for "-") is nearest
  // B's corresponding edge -- both which wall (an L/step-shaped A can have
  // several) and which value to actually snap to (the true outer surface,
  // not an average of its own noise).
  // A painted-out wall of A is not a mating face, so Align never lands B on
  // one. The pocket the user painted out is skipped; the flats around it are
  // still offered, which is why an excluded pocket cannot veto a side Join.
  const modelA = state.models.find(function (mm) { return mm.id === idA; });
  function wallPainted(axisName, dir, value) {
    if (typeof nsoMaskIsExcludedWorld !== 'function' || !modelA) return false;
    const ax = axisName === 'x' ? 0 : 2;
    const wp = [0, 0, 0];
    wp[ax] = value;
    // meshBandExtent keeps any triangle roughly perpendicular to the axis and
    // does not record which way it faces, so a wall found while probing from
    // one side can be a face pointing the other way - a pocket floor read as a
    // "-X" wall, say. Test both facings or a painted face slips through.
    for (let sgn = -1; sgn <= 1; sgn += 2) {
      const wn = [0, 0, 0];
      wn[ax] = sgn;
      if (nsoMaskIsExcludedWorld(modelA, placedA.mesh, wn, wp)) return true;
    }
    return false;
  }
  function nearestExtreme(groups, target, useMax, axisName, dir) {
    let best = null, bestD = Infinity;
    for (let i = 0; i < groups.length; i++) {
      const val = useMax ? groups[i].max : groups[i].min;
      if (axisName && wallPainted(axisName, dir, val)) continue;
      const d = Math.abs(val - target);
      if (d < bestD) { bestD = d; best = val; }
    }
    return best;
  }
  function pickBest(cands) {
    if (!cands.length) return null;
    cands.sort(function (c1, c2) { return Math.abs(c1.delta) - Math.abs(c2.delta); });
    return cands[0];
  }
  function isConcave(best) {
    if (!best) return false;
    const globalWall = best.axis === 'x'
      ? (best.dir > 0 ? fa.maxx : fa.minx)
      : (best.dir > 0 ? fa.maxz : fa.minz);
    return Math.abs(best.wall - globalWall) > CONCAVE_TOL;
  }

  const xCands = [];
  if (xBand.groups.length) {
    const wPlus = nearestExtreme(xBand.groups, fb.minx, true, 'x', 1);
    if (wPlus != null) xCands.push({ axis: 'x', dir: 1, wall: wPlus, delta: wPlus - fb.minx });
    const wMinus = nearestExtreme(xBand.groups, fb.maxx, false, 'x', -1);
    if (wMinus != null) xCands.push({ axis: 'x', dir: -1, wall: wMinus, delta: wMinus - fb.maxx });
  }
  const zCands = [];
  if (zBand.groups.length) {
    const wPlus = nearestExtreme(zBand.groups, fb.minz, true, 'z', 1);
    if (wPlus != null) zCands.push({ axis: 'z', dir: 1, wall: wPlus, delta: wPlus - fb.minz });
    const wMinus = nearestExtreme(zBand.groups, fb.maxz, false, 'z', -1);
    if (wMinus != null) zCands.push({ axis: 'z', dir: -1, wall: wMinus, delta: wMinus - fb.maxz });
  }

  const bestX = pickBest(xCands);
  const bestZ = pickBest(zCands);
  const xConcave = isConcave(bestX);
  const zConcave = isConcave(bestZ);
  const SNAP_DIST = 6; // mm -- tune if your hand-drag placements are looser
  const bothClose = bestX && bestZ
    && Math.abs(bestX.delta) <= SNAP_DIST
    && Math.abs(bestZ.delta) <= SNAP_DIST;

  let nx = placedB.x;
  let nz = placedB.z;

  if (bothClose && xConcave && zConcave) {
    nx = placedB.x + bestX.delta;
    nz = placedB.z + bestZ.delta;
    applyPlacedXZ(placedB, nx, nz);
    matchPlacedBottoms(placedA, placedB);
    setStatus("Aligned into A's inner corner");
    return true;
  }

  const candidates = xCands.concat(zCands);
  if (candidates.length) {
    const best = pickBest(candidates);
    const concaveHere = isConcave(best);

    if (best.axis === 'x') {
      nx = placedB.x + best.delta;
      if (concaveHere) {
        nz = placedB.z;
      } else {
        const toMin = fa.minz - fb.minz;
        const toMax = fa.maxz - fb.maxz;
        nz = placedB.z + (Math.abs(toMin) <= Math.abs(toMax) ? toMin : toMax);
      }
      state.joinSlideAxis = 'z';
    } else {
      nz = placedB.z + best.delta;
      if (concaveHere) {
        nx = placedB.x;
      } else {
        const toMin = fa.minx - fb.minx;
        const toMax = fa.maxx - fb.maxx;
        nx = placedB.x + (Math.abs(toMin) <= Math.abs(toMax) ? toMin : toMax);
      }
      state.joinSlideAxis = 'x';
    }
    applyPlacedXZ(placedB, nx, nz);
    matchPlacedBottoms(placedA, placedB);
    setStatus(concaveHere ? "Aligned to A's inner wall" : 'Aligned to nearest corner of A');
    return true;
  }

  // Nothing above found a wall face on A facing B, so there is no remaining
  // flat to sit against - A is round on this side, or the two footprints
  // never overlap in either band. Snapping to the bounding box here used to
  // teleport B onto a corner that is not a surface, which then reads as a
  // bad join. Say so and leave both poses alone.
  setStatus('Align failed - no flat face on A facing B. Move B beside a flat side first', true);
  return false;
}

function displayGeometryToRawSoup(geometry) {
  const geo = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = geo.attributes.position;
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    out[i*3] = x; out[i*3+1] = -z; out[i*3+2] = y;
  }
  return out;
}

function getModelRawSoup(model) {
  if (model.rawTris && model.rawAxis === 'zup') return model.rawTris;
  return displayGeometryToRawSoup(model.geometry);
}



function modelNameById(id) {
  const m = state.models.find(function (x) { return x.id === id; });
  return m && m.name ? m.name : '';
}

function paintJoinHighlights() {
  (state.placed || []).forEach(function (pl) {
    if (!pl || !pl.mesh || !pl.mesh.material || !pl.mesh.material.color) return;
    const selected = pl.sourceId === state.editId;
    pl.mesh.material.color.setHex(selected ? SELECT_COLOR : PIECE_COLOR);
    if (pl.mesh.material.emissive) {
      pl.mesh.material.emissive.setHex(selected ? 0x9f1239 : 0x0a3a5c);
      pl.mesh.material.emissiveIntensity = selected ? 0.4 : 0.2;
    }
  });
}

// Selecting anything drops the inspect cage: it belongs to the bake that was
// just made, not to whatever the user clicks next.
(function () {
  const prevSelect = window.selectPlaced;
  window.selectPlaced = function () {
    if (typeof clearInspectCage === 'function') clearInspectCage();
    if (typeof prevSelect === 'function') return prevSelect.apply(this, arguments);
  };
})();
