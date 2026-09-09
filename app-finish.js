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
  if (mode === 'corners') {
    // Every genuine corner of the clicked face's loop takes R; the straight
    // spans between them keep R = 0 and stay on the plane. Anything the engine
    // refuses throws, and the caller leaves the piece unchanged.
    return rawEdgeRoundInPlace(rawTris, axisIdx, plane, keepMin, R, { minTurnDeg: 25 });
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
  let working = null;
  try {
    working = softenSelectedFace(m.rawTris, rawAxisIdx, keepMinFace, R, getEdgeTreat(), pick.rawPlane);
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

  pushUndo({
    type: 'softenReplace',
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
  refreshFacePickHighlight();
  // What actually got built: corners that took R, out of the corners found,
  // and the loop points the face carries. No sealing claim.
  const treat = getEdgeTreat();
  const clamp = (x) => (x.radius < x.requested - 1e-6 ? ' (asked ' + x.requested.toFixed(2) + ', wall clamp)' : '');
  const corner = (typeof rawEdgeRoundInPlace === 'function') ? rawEdgeRoundInPlace.lastBuild : null;
  const perim = (typeof rawPerimeterFilletInPlace === 'function') ? rawPerimeterFilletInPlace.lastBuild : null;
  if (treat === 'corners' && corner && corner.corners != null) {
    setStatus('Soften ok - ' + corner.rounded + '/' + corner.corners + ' corners at R ' + corner.radius.toFixed(2) +
              clamp(corner) + ' - ' + corner.loopPts + ' loop pts');
  } else if (perim && perim.loopPts != null) {
    setStatus('Soften ok - ' + perim.mode + ' on all ' + perim.loopPts + ' loop pts at R ' +
              perim.radius.toFixed(2) + clamp(perim));
  } else {
    setStatus('Soften ok');
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
  refreshFacePickHighlight();
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

// fillet | corners | chamfer. Anything else (a stale saved value, an old
// 'square' option) falls back to fillet — Soften has no square treatment.
function getEdgeTreat() {
  const sel = document.getElementById('sel-edge-treat');
  const v = sel && sel.value ? String(sel.value) : (state.edgeTreat || 'fillet');
  state.edgeTreat = (v === 'chamfer' || v === 'corners') ? v : 'fillet';
  return state.edgeTreat;
}

function softenSelectedModel() {
  const m = getActiveModel();
  if (!m) { setStatus('Select a piece first', true); return; }
  if (state.softenArmed) {
    state.softenArmed = false;
    clearFacePick();
    setStatus('Soften cancelled');
    return;
  }
  state.softenArmed = true;
  clearFacePick();
  const mode = getEdgeTreat();
  const label = mode === 'chamfer' ? 'bevel' : (mode === 'corners' ? 'corners' : 'round');
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
  if (typeof removeFaceHelper === 'function') removeFaceHelper();
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

function clearFacePick() {
  state.facePick = null;
  if (typeof removeFaceHelper === 'function') removeFaceHelper();
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

// The canvas click ray already found a triangle; this turns that triangle
// into the stored plane. Rejects — with a reason — anything it cannot
// describe honestly, and never substitutes a different face.
function storeFacePick(hit) {
  clearFacePick();
  if (!hit || !hit.face || !hit.object || !hit.object.geometry) {
    setStatus('Click a face', true);
    return null;
  }

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

  const mesh = hit.object;
  mesh.updateMatrixWorld();
  // hit.face.normal is already in the mesh's own geometry space, which is
  // display space. The world copy is only for the highlight.
  const nLocal = hit.face.normal.clone().normalize();
  const nWorld = nLocal.clone().transformDirection(mesh.matrixWorld).normalize();
  const pWorld = hit.point.clone();
  const pLocal = mesh.worldToLocal(pWorld.clone());

  const nAbs = [Math.abs(nLocal.x), Math.abs(nLocal.y), Math.abs(nLocal.z)];
  let dispAxis = 0;
  if (nAbs[1] > nAbs[dispAxis]) dispAxis = 1;
  if (nAbs[2] > nAbs[dispAxis]) dispAxis = 2;
  if (nAbs[dispAxis] < FACE_PICK_FLAT) {
    setStatus('Click a flat face - that spot is on a curve', true);
    return null;
  }
  const dispSign = ([nLocal.x, nLocal.y, nLocal.z][dispAxis] >= 0) ? 1 : -1;

  const geo = mesh.geometry;
  if (!geo.boundingBox) geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const bbLo = [bb.min.x, bb.min.y, bb.min.z][dispAxis];
  const bbHi = [bb.max.x, bb.max.y, bb.max.z][dispAxis];
  const localPlane = dispSign > 0 ? bbHi : bbLo;
  const localHit = [pLocal.x, pLocal.y, pLocal.z][dispAxis];
  // The raw engines work on the outer plane of the axis they are given —
  // they cannot cut a recessed pocket wall. If the click is not on that
  // outer plane, say so instead of letting an engine slide the work onto
  // the plane it can reach.
  if (Math.abs(localHit - localPlane) > FACE_PICK_TOL) {
    setStatus('Click an outer face - that one is recessed ' +
              Math.abs(localHit - localPlane).toFixed(2) + 'mm behind the outside', true);
    return null;
  }

  const mapped = rawAxisFromDisplay(dispAxis, dispSign);
  // Cross-check the display->raw mapping against the piece itself: the two
  // axes must measure the same piece. A mismatch means the soup and the
  // display mesh have drifted apart, and every plane below would be
  // fiction.
  const dispSpan = bbHi - bbLo;
  const rawSpan = rawSpanOf(model.rawTris, mapped.rawAxisIdx);
  if (!isFinite(rawSpan) || Math.abs(rawSpan - dispSpan) > Math.max(FACE_PICK_TOL, dispSpan * 0.02)) {
    setStatus('Click a face - raw soup and display mesh disagree on this piece', true);
    return null;
  }

  const rawPlane = rawExtremeOf(model.rawTris, mapped.rawAxisIdx, mapped.rawKeepMin);
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
  const live = rawExtremeOf(model.rawTris, pick.rawAxisIdx, pick.rawKeepMin);
  if (!isFinite(live) || Math.abs(live - pick.rawPlane) > FACE_PICK_TOL) return null;
  // Cap moves the plane inward by its own EPS; track that so a follow-up
  // Soften on the same pick still lands on the face the user clicked.
  pick.rawPlane = live;
  return pick;
}

// After a bake the display mesh is rebuilt and re-centred, so the pick's
// world/local record is stale even though its raw plane is not — raw space
// is uncentred, which is why the pick is stored there. Re-derive the
// highlight (and the stale world fields) on the new mesh so the face stays
// visibly armed for the next treatment.
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
  const hl = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color: 0xfacc15,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.45,
    depthTest: false
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
    color: 0xfacc15,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.85,
    depthTest: false
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
  function nearestExtreme(groups, target, useMax) {
    let best = null, bestD = Infinity;
    for (let i = 0; i < groups.length; i++) {
      const val = useMax ? groups[i].max : groups[i].min;
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
    const wPlus = nearestExtreme(xBand.groups, fb.minx, true);
    xCands.push({ axis: 'x', dir: 1, wall: wPlus, delta: wPlus - fb.minx });
    const wMinus = nearestExtreme(xBand.groups, fb.maxx, false);
    xCands.push({ axis: 'x', dir: -1, wall: wMinus, delta: wMinus - fb.maxx });
  }
  const zCands = [];
  if (zBand.groups.length) {
    const wPlus = nearestExtreme(zBand.groups, fb.minz, true);
    zCands.push({ axis: 'z', dir: 1, wall: wPlus, delta: wPlus - fb.minz });
    const wMinus = nearestExtreme(zBand.groups, fb.maxz, false);
    zCands.push({ axis: 'z', dir: -1, wall: wMinus, delta: wMinus - fb.maxz });
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

  const dx = ((fb.minx + fb.maxx) - (fa.minx + fa.maxx)) / 2;
  const dz = ((fb.minz + fb.maxz) - (fa.minz + fa.maxz)) / 2;
  if (Math.abs(dx) >= Math.abs(dz)) {
    nx = dx >= 0 ? placedB.x + (fa.maxx - fb.minx) : placedB.x + (fa.minx - fb.maxx);
    const toMin = fa.minz - fb.minz;
    const toMax = fa.maxz - fb.maxz;
    nz = placedB.z + (Math.abs(toMin) <= Math.abs(toMax) ? toMin : toMax);
    state.joinSlideAxis = 'z';
  } else {
    nz = dz >= 0 ? placedB.z + (fa.maxz - fb.minz) : placedB.z + (fa.minz - fb.maxz);
    const toMin = fa.minx - fb.minx;
    const toMax = fa.maxx - fb.maxx;
    nx = placedB.x + (Math.abs(toMin) <= Math.abs(toMax) ? toMin : toMax);
    state.joinSlideAxis = 'x';
  }
  applyPlacedXZ(placedB, nx, nz);
  matchPlacedBottoms(placedA, placedB);
  setStatus('Aligned to nearest corner of A');
  return true;
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

