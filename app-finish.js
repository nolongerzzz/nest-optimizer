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
  const wallLimitAt = (i) => NSO_Thickness.cornerWall(poly2d, i).mm;
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
  const wallLimitAt = (i) => NSO_Thickness.cornerWall(poly, i).mm;
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
  const wallLimitAt = (i) => NSO_Thickness.cornerWall(poly, i).mm;
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

  // NON-SOLID SCOPE (docs/NON-SOLID.md): read through nsoNonSolid, never
  // guessed from open-edge counts. Plain Seal's whole job is to close
  // openings (cap loops, cap outer holes), which is the one requirement the
  // flag lifts, so on a non-solid piece it stands down and says so. Repair
  // still runs: NSO_Repair skips only its three closure-premised stages
  // (flap peel, orphan drop, hole fill) and keeps welding, degenerate and
  // duplicate removal, T-junctions, pinch separation and both final gates.
  // It also re-closes any seam its own earlier stages tore open, which is why
  // a flagged piece with real defects now repairs instead of tripping the
  // odd-edge gate on damage the repair itself did; the piece's own openings
  // are left alone, and the status line below names the two separately.
  const nonSolid = (typeof nsoNonSolid === 'function') && nsoNonSolid(m);
  if (nonSolid && !repairMode) {
    setStatus('Seal stood down - ' + m.name + ' is flagged non-solid and Seal only closes ' +
              'openings. Untick Non-solid to seal, or tick Repair to fix defects without closing.', true);
    return;
  }

  let openBefore = null, nmBefore = null;
  try { openBefore = openBoundaryEdges(soupIn).length; } catch (e) {}
  if (repairMode) { try { nmBefore = countNonManifoldEdges(soupIn); } catch (e) {} }

  let working = soupIn;
  let ok = true;
  let failReason = null;
  let repairReport = null;
  let repairLegacy = false;

  if (repairMode) {
    // Paint wins (docs/HANDOFF.md). NSO_Repair welds, splits vertices, peels
    // flaps and fans holes shut across the whole piece; it takes no skip list
    // and has no notion of a face the user reserved. Rather than let a bake
    // quietly walk over paint, stand down and name what stopped it.
    //
    // PAINT SCOPE: WHOLE-PIECE. Any painted face on the piece stands this
    // down. Repair re-topologises across the whole mesh and cannot promise a
    // named face survives, so nsoMaskCount is the whole test. See the scoping
    // rule in docs/HANDOFF.md.
    const painted = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
    if (painted > 0) {
      setStatus('Repair stood down - ' + painted + ' painted face(s); repair has no skip list. ' +
                'Clear paint to repair.', true);
      return;
    }

    const haveModule = (typeof NSO_Repair !== 'undefined') && NSO_Repair &&
                       typeof NSO_Repair.commit === 'function';
    if (!haveModule) {
      // NSO_Repair.js did not load. Fall back to the heuristic this checkbox
      // used to run, so the control keeps working rather than dying.
      repairLegacy = true;
      const result = repairForPrint(soupIn);
      ok = result.ok;
      working = result.soup;
      failReason = result.reason;
    } else {
      const r = NSO_Repair.commit(soupIn, { nonSolid: nonSolid });
      repairReport = r.report || null;
      console.log('[seal/repair] NSO_Repair', r.ok, repairReport);

      // Three distinct non-success outcomes, kept distinct in the status line.
      // 1. ok:false - the module could not run at all. Its contract hands back
      //    the caller's own array, so nothing has moved.
      if (!r.ok) {
        setStatus('Repair unavailable for this defect - piece unchanged (' +
                  ((repairReport && repairReport.reason) || 'module declined') + ')', true);
        return;
      }
      // 2. ok:true, applied:false. Two very different things wear this shape
      //    and must not share a status line. Either the module found nothing
      //    wrong, or it found a defect and its own safety gate refused the
      //    fix as worse than the disease (every gated case in fixtures/repair
      //    lands here, not on the applied-with-blocks path). Saying "nothing
      //    to repair" to someone staring at a non-manifold readout would be a
      //    silent no-op wearing a success message.
      if (!repairReport || repairReport.applied !== true) {
        const gated = (repairReport && repairReport.gate && repairReport.gate.blockedStages) || [];
        // A piece the flag left alone can still carry a real defect the
        // repair cannot fix (a pierce is not repairable here). Say it, so the
        // flag never turns a defective piece into a clean-sounding no-op.
        const residual = repairReport && repairReport.before ? repairReport.before.selfIntersections : 0;
        const tail = residual > 0
          ? ' - ' + residual + ' self-intersecting pair(s) present, not hidden by the ' +
            (nonSolid ? 'non-solid flag' : 'repair')
          : '';
        const tag = nonSolid ? 'Repair (non-solid) ' : 'Repair ';
        if (gated.length) {
          setStatus(tag + 'unavailable for this defect - ' + gated.length +
                    ' stage(s) gated (' + gated.join(', ') + ') - piece unchanged' + tail, true);
        } else {
          setStatus(nonSolid ? 'Nothing to repair (non-solid) - piece unchanged' + tail
                             : 'Nothing to repair - piece unchanged' + tail, residual > 0);
        }
        return;
      }
      // 3. applied. Gated stages, if any, are reported below.
      working = r.rawTris;
      ok = true;
    }
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
    if (typeof nsoReseatPlacedPose === 'function') nsoReseatPlacedPose(placedEntry);   // bake is in the piece's own frame: its pose still stands
  }

  let openAfter = null;
  try { openAfter = openBoundaryEdges(working).length; } catch (e) {}

  if (repairMode) {
    let nmAfter = null;
    try { nmAfter = countNonManifoldEdges(working); } catch (e) {}
    const openStr = (openBefore != null && openAfter != null) ? (openBefore + '\u2192' + openAfter) : '?';
    const nmStr = (nmBefore != null && nmAfter != null) ? (nmBefore + '\u2192' + nmAfter) : '?';
    // Edge counts alone can read as "nothing happened" on a repair that did
    // real work: thingi10k/40921 is 17 bowtie VERTICES, and an edge-based
    // check scores it 0 open / 0 non-manifold both before and after (the same
    // blind spot docs/HANDOFF.md flags). So name the stages that actually
    // fired, straight off the module's own tally.
    const c = (repairReport && repairReport.counts) || {};
    const did = [];
    if (c.weldedNear) did.push(c.weldedNear + ' vert' + (c.weldedNear > 1 ? 's' : '') + ' welded');
    if (c.degenerateRemoved) did.push(c.degenerateRemoved + ' degenerate');
    if (c.exactDuplicatesRemoved + c.reversedDuplicatesRemoved) {
      did.push((c.exactDuplicatesRemoved + c.reversedDuplicatesRemoved) + ' duplicate face(s)');
    }
    if (c.flapTrisRemoved) did.push(c.flapTrisRemoved + ' flap tri(s)');
    if (c.orphanTrisRemoved) did.push(c.orphanTrisRemoved + ' orphan tri(s)');
    if (c.tJunctionSplits) did.push(c.tJunctionSplits + ' T-junction(s)');
    if (c.pinchVertsSplit) did.push(c.pinchVertsSplit + ' pinch vert(s) split');
    if (c.holesFilled) did.push(c.holesFilled + ' hole(s) filled');
    // Not the same thing as a filled hole, and not shown as one: a seam is
    // boundary an earlier stage of this same repair opened (deleting a
    // degenerate sliver unpairs its neighbours), put back. Only the non-solid
    // path reports these - without the flag hole fill has already covered
    // them - and no opening the piece arrived with is ever counted here.
    if (c.seamsReclosed) did.push(c.seamsReclosed + ' seam(s) re-closed');
    const siAfter = (repairReport && repairReport.after) ? repairReport.after.selfIntersections : 0;
    const counts = 'open edges ' + openStr + ', non-manifold ' + nmStr +
                   (did.length ? '; ' + did.join(', ') : '') +
                   (nonSolid ? '; open edges kept (non-solid)' : '') +
                   (siAfter > 0 ? '; ' + siAfter + ' self-intersecting pair(s) remain' : '');
    const blocked = (repairReport && repairReport.gate && repairReport.gate.blockedStages) || [];
    const tag = nonSolid ? 'Repair (non-solid) ' : 'Repair ';
    if (blocked.length) {
      // A gated stage means the safe passes landed but a risky one was rolled
      // back because it would have made the mesh worse. Say so - "Repair done"
      // would claim more than happened.
      setStatus(tag + 'partial - ' + blocked.length + ' stage(s) gated (' +
                blocked.join(', ') + ') - ' + counts);
    } else {
      setStatus(tag + 'done - ' + counts + (repairLegacy ? ' (fallback repair)' : ''), siAfter > 0);
    }
  } else {
    if (openBefore != null && openAfter != null) {
      setStatus('Seal ok - open edges ' + openBefore + '\u2192' + openAfter);
    } else {
      setStatus('Seal ok');
    }
  }
}


// ---- Solidify ----
//
// weld (0.2 mm grid snap) -> cap small loops -> cap outer holes ->
// repairJoinedSoup (its own 0.3 mm weld) -> weld. The two coarse welds are the
// risky part: a grid snap that size merges every pair of distinct vertices
// sharing a 0.2 mm cell and drops each triangle they collapse, so a finely
// tessellated piece loses real surface. Measured on library/v9_mirror_factory.stl
// - exact-vertex clean, 0 open / 0 non-manifold - the pipeline went 49,026 ->
// 31,199 triangles and the canonical checker (tools/mesh_validate.py) read
// 35 open / 55 non-manifold / 69 degenerate on the result. The hole fill never
// fired: the piece had no holes. The welds did all of it, and the old status
// line still said "Solidify ok".
//
// So two guards, both measured by NSO_Repair.inspect - the in-page
// transcription of the canonical checker's weld (radius 1e-4 mm) and edge
// census - not by the grid-snap counters above, which read that same clean
// piece as 76 non-manifold edges and shift with where the piece sits:
//   1. nothing to do: a piece with no open edge is left exactly as it is.
//      Solidify closes openings; with none, every stage is risk and no
//      reward. Keyed on open edges alone, not on non-manifold too: that
//      factory piece reads NM 2 at the 1e-4 weld (one pair of distinct
//      vertices closer than that) and 0 by exact vertex, and nothing in this
//      pipeline is a non-manifold repair anyway - Repair is.
//   2. result gate: the output is committed only if it has no more open,
//      non-manifold, mis-wound or degenerate edges/faces than the input. Otherwise the
//      piece is unchanged and the status names the count that rose - the
//      same "gate on the result, not the request" rule Hollow uses.
//   3. progress gate: not worse is not enough. If the result has as many
//      open edges as the input, nothing was closed, and Solidify refuses
//      instead of committing an unchanged piece under "Solidify ok" with an
//      Undo entry (driver-testing round 1: "open 16->16", byte-identical).
//      Fewer but not zero commits as "Solidify partial" and names what was
//      left open and why.
// Between the pipeline and the gates, solidifyCloseLoops closes the loops the
// two cappers cannot (pinched loops, loops folded over an edge of the piece).
// tools/nso_wire_solidify_test.js drives all of it through the real button and
// re-measures with mesh_validate.py.
function solidifyCensus(soup) {
  if (typeof NSO_Repair === 'undefined' || !NSO_Repair || typeof NSO_Repair.inspect !== 'function') return null;
  try {
    const r = NSO_Repair.inspect(soup, { selfIntersections: false });
    return { open: r.openEdges, nm: r.nonManifoldEdges, degen: r.degenerateTris, wind: r.flippedEdges, tris: r.tris };
  } catch (e) {
    return null;
  }
}

/* Which canonical counts got worse, as status-line fragments. Empty = none. */
function solidifyRegressions(before, after) {
  const worse = [];
  if (after.nm > before.nm) worse.push('non-manifold ' + before.nm + '\u2192' + after.nm);
  if (after.open > before.open) worse.push('open ' + before.open + '\u2192' + after.open);
  if (after.degen > before.degen) worse.push('degenerate ' + before.degen + '\u2192' + after.degen);
  // Winding too: on shape-sphere_holes-shredded the coarse welds + repairJoinedSoup
  // turned 0 mis-wound edges into 21 (canonical checker) while closing 13 open
  // ones, and without this line that committed as progress.
  if (after.wind != null && before.wind != null && after.wind > before.wind) {
    worse.push('mis-wound ' + before.wind + '\u2192' + after.wind);
  }
  return worse;
}

// ---- Solidify: close the loops the bbox-plane cappers cannot ----
//
// capSmallOpenLoops walks the boundary as an UNDIRECTED graph and gives up on
// any loop that touches a vertex of degree != 2; capAllOuterHoles only caps
// openings lying on one of the piece's outer bounding-box planes. Found by
// driver-testing round 1 (nso_damage.hole on fixtures/quick/shape-cylinder,
// severity light, seed 7 - 16 open edges in 2 loops), the two cases neither
// one closes:
//
//   1. PINCHED LOOP. Two holes in a fan cap that meet at the cap's centre
//      vertex make one boundary component with a degree-4 vertex - a figure
//      eight. Walked as DIRECTED half-edges (each open edge in the direction
//      its one face runs it) the figure eight is two simple cycles that share
//      a vertex; each is split off and closed on its own.
//   2. FOLDED LOOP. Three top-cap faces and the side-wall face below them
//      make one loop that folds 90 degrees over the top rim and reaches down
//      to z = 0 - on no plane at all, let alone a bounding-box one. It is
//      triangulated by solidifyFillLoop, which scores every triangulation of
//      the loop's own vertices by its sharpest fold against the surface
//      around it, and so puts the crease back on the rim.
//
// Only vertices already on the loop are used - nothing is invented - and a
// loop is left open, with a reason, rather than guessed at when:
//   - its walk dead-ends (an open edge whose neighbour is not open-once),
//   - it is longer than SOLIDIFY_LOOP_MAX_EDGES (the same cap NSO_Repair's
//     fillHoles uses: a loop that long is missing geometry, not a hole),
//   - it has no non-degenerate triangulation, or every one of them folds
//     sharper than SOLIDIFY_FOLD_MAX somewhere.
// The result still goes through solidifyRegressions and the progress gate in
// solidifySelectedModel, so a patch that made anything worse never lands.
const SOLIDIFY_LOOP_MAX_EDGES = 64;
// A fill whose worst fold is sharper than this is refused, not committed:
// 150 degrees still admits a real 90-degree crease with room to spare.
const SOLIDIFY_FOLD_MAX = 150 * Math.PI / 180;

function solidifyDirectedLoops(mesh, edges) {
  // Open edges, as directed half-edges u -> v in their one face's winding.
  const out = new Map();
  let total = 0;
  const nf = mesh.faces.length / 3;
  for (let f = 0; f < nf; f++) {
    const a = mesh.faces[f * 3], b = mesh.faces[f * 3 + 1], c = mesh.faces[f * 3 + 2];
    const tri = [[a, b], [b, c], [c, a]];
    for (let e = 0; e < 3; e++) {
      const u = tri[e][0], v = tri[e][1];
      const k = u < v ? u + '_' + v : v + '_' + u;
      if (!edges[k] || edges[k].count !== 1) continue;
      if (!out.has(u)) out.set(u, []);
      out.get(u).push(v);
      total++;
    }
  }
  const loops = [];
  let deadEnds = 0;
  for (const start of Array.from(out.keys())) {
    let path = [start];
    let cur = start;
    while (true) {
      const nexts = out.get(cur);
      if (!nexts || !nexts.length) {
        // Walk stranded mid-path: an open chain, not a closable loop.
        if (path.length > 1) deadEnds++;
        break;
      }
      const nxt = nexts.pop();
      const at = path.indexOf(nxt);
      if (at >= 0) {
        // Closed a cycle. At a pinch the path revisits a vertex; the cycle is
        // the stretch since that visit, and the walk carries on from there.
        const cyc = path.slice(at);
        if (cyc.length >= 3) loops.push(cyc);
        path = path.slice(0, at + 1);
        cur = nxt;
        if (path.length === 1 && !(out.get(cur) || []).length) break;
        continue;
      }
      path.push(nxt);
      cur = nxt;
    }
  }
  return { loops: loops, deadEnds: deadEnds, openHalfEdges: total };
}

// Triangulate one loop with the fewest, flattest folds: Liepa's hole-filling
// weight (P. Liepa, "Filling Holes in Meshes", SGP 2003) - over every
// triangulation that uses only the loop's own vertices, minimise first the
// worst dihedral angle between neighbouring triangles (patch-patch, and
// patch-to-surface across each loop edge), then total area. Exact O(n^3)
// dynamic programme, n <= SOLIDIFY_LOOP_MAX_EDGES.
//
// Why not a flat fill in one best-fit plane: a loop that folds over an edge
// of the piece (round 1's second loop: three top-cap faces and the wall face
// below them) has no plane. Projected onto one, it triangulates into
// chords that cut through the solid - measured on that fixture, checker-clean
// but 1% of the cylinder's volume gone. Scoring folds against the faces
// around the hole puts the crease back where the surface had it.
//
// `loop` is in boundary order; the patch runs the other way, so its edges
// pair with the boundary. `rimNormal(a, b)` gives the unit normal of the one
// face on the open edge a->b. Returns index triples, or a string saying why
// not.
function solidifyFillLoop(pos, loop, rimNormal) {
  const R = loop.slice().reverse();
  const n = R.length;
  const P = R.map(i => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
  function triN(a, b, c) {
    const A = P[a], B = P[b], C = P[c];
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
    const vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    const l = Math.hypot(x, y, z);
    return { n: l > 0 ? [x / l, y / l, z / l] : null, area: l / 2 };
  }
  const ang = (p, q) => Math.acos(Math.max(-1, Math.min(1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2])));
  // The patch edge R[i]->R[i+1] is the boundary edge R[i+1]->R[i] of the mesh.
  const rim = [];
  for (let i = 0; i < n; i++) rim.push(rimNormal(R[(i + 1) % n], R[i]));
  let span = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < 3; j++) span = Math.max(span, Math.abs(P[i][j]));
  const AREA_EPS = 1e-12 * Math.max(1, span * span);
  const ANG_EPS = 1e-9;
  // W[i][j]: best patch over R[i..j], closed by the chord i-j. K: its apex.
  const W = [], K = [];
  for (let i = 0; i < n; i++) { W.push(new Array(n).fill(null)); K.push(new Array(n).fill(-1)); }
  for (let i = 0; i + 1 < n; i++) W[i][i + 1] = { ang: 0, area: 0 };
  const better = (a, b) => !b || a.ang < b.ang - ANG_EPS || (Math.abs(a.ang - b.ang) <= ANG_EPS && a.area < b.area);
  // Normal of the triangle that sits on the chord i-j inside W[i][j], or the
  // rim face when i-j is a loop edge.
  function across(i, j) {
    if (j === i + 1) return rim[i];
    const k = K[i][j];
    return k < 0 ? null : triN(i, k, j).n;
  }
  for (let len = 2; len < n; len++) {
    for (let i = 0; i + len < n; i++) {
      const j = i + len;
      let best = null, bestK = -1;
      for (let k = i + 1; k < j; k++) {
        const L = W[i][k], Rr = W[k][j];
        if (!L || !Rr) continue;
        const t = triN(i, k, j);
        if (!t.n || t.area <= AREA_EPS) continue;
        let a = Math.max(L.ang, Rr.ang);
        const nl = across(i, k), nr = across(k, j);
        if (nl) a = Math.max(a, ang(t.n, nl));
        if (nr) a = Math.max(a, ang(t.n, nr));
        if (i === 0 && j === n - 1 && rim[n - 1]) a = Math.max(a, ang(t.n, rim[n - 1]));
        const cand = { ang: a, area: L.area + Rr.area + t.area };
        if (better(cand, best)) { best = cand; bestK = k; }
      }
      W[i][j] = best;
      K[i][j] = bestK;
    }
  }
  if (!W[0][n - 1]) return 'no non-degenerate triangulation';
  // A patch that has to fold back on itself (a dihedral near 180) is not a
  // hole fill, it is a guess; leave it open.
  if (W[0][n - 1].ang > SOLIDIFY_FOLD_MAX) {
    return 'every fill folds ' + Math.round(W[0][n - 1].ang * 180 / Math.PI) + '° somewhere';
  }
  const tris = [];
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    if (j - i < 2) continue;
    const k = K[i][j];
    tris.push([R[i], R[k], R[j]]);
    stack.push([i, k], [k, j]);
  }
  return tris;
}

// Close every open loop the directed walk finds. Returns the soup with the
// patches appended (the input soup untouched), and what it did and did not do.
function solidifyCloseLoops(soup) {
  const res = { soup: soup, loops: 0, closed: 0, added: 0, left: [] };
  if (typeof NSO_Repair === 'undefined' || !NSO_Repair ||
      typeof NSO_Repair._weldToIndexed !== 'function' || typeof NSO_Repair._buildEdges !== 'function') {
    res.left.push('mesh checker not loaded');
    return res;
  }
  const w = NSO_Repair._weldToIndexed(soup, NSO_Repair.WELD_TOL);
  const mesh = w.mesh;
  const edges = NSO_Repair._buildEdges(mesh);
  const walk = solidifyDirectedLoops(mesh, edges);
  res.loops = walk.loops.length;
  if (walk.deadEnds) res.left.push(walk.deadEnds + ' open chain(s) that do not close');
  // Unit normal of the one face on open edge a-b (either direction).
  function rimNormal(a, b) {
    const e = edges[a < b ? a + '_' + b : b + '_' + a];
    if (!e || !e.faces.length) return null;
    const f = e.faces[0], P = mesh.pos, F = mesh.faces;
    const i0 = F[f * 3] * 3, i1 = F[f * 3 + 1] * 3, i2 = F[f * 3 + 2] * 3;
    const ux = P[i1] - P[i0], uy = P[i1 + 1] - P[i0 + 1], uz = P[i1 + 2] - P[i0 + 2];
    const vx = P[i2] - P[i0], vy = P[i2 + 1] - P[i0 + 1], vz = P[i2 + 2] - P[i0 + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    const l = Math.hypot(x, y, z);
    return l > 0 ? [x / l, y / l, z / l] : null;
  }
  const patch = [];
  for (const loop of walk.loops) {
    if (loop.length > SOLIDIFY_LOOP_MAX_EDGES) {
      res.left.push('a ' + loop.length + '-edge loop (over ' + SOLIDIFY_LOOP_MAX_EDGES + ': missing geometry, not a hole)');
      continue;
    }
    const t = solidifyFillLoop(mesh.pos, loop, rimNormal);
    if (typeof t === 'string') { res.left.push('a ' + loop.length + '-edge loop: ' + t); continue; }
    for (const tri of t) {
      for (const vi of tri) patch.push(mesh.pos[vi * 3], mesh.pos[vi * 3 + 1], mesh.pos[vi * 3 + 2]);
    }
    res.closed++;
    res.added += t.length;
  }
  if (patch.length) {
    const outSoup = new Float32Array(soup.length + patch.length);
    outSoup.set(soup, 0);
    outSoup.set(patch, soup.length);
    res.soup = outSoup;
  }
  return res;
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
  const censusBefore = solidifyCensus(soupIn);
  if (!censusBefore) {
    // No canonical census means no way to prove the result is not worse, and
    // an unprovable Solidify is the one that shipped a broken mesh as "ok".
    setStatus('Solidify unavailable - the mesh checker (NSO_Repair) is not loaded; piece unchanged', true);
    return;
  }
  if (censusBefore.open === 0) {
    setStatus('Solidify: already closed - 0 open edges, nothing to fill; piece unchanged');
    return;
  }
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
  // Whatever the cappers above left open: pinched loops, and loops folded over an edge.
  let closeLoops = null;
  try {
    closeLoops = solidifyCloseLoops(working);
    working = closeLoops.soup;
  } catch (e) {
    closeLoops = null;
  }
  if (!working || working.length < 9) {
    setStatus('Solidify failed - piece unchanged', true);
    return;
  }
  const censusAfter = solidifyCensus(working);
  if (!censusAfter) {
    setStatus('Solidify failed - result could not be measured; piece unchanged', true);
    return;
  }
  const worse = solidifyRegressions(censusBefore, censusAfter);
  if (worse.length) {
    setStatus('Solidify refused - it would make the mesh worse (' + worse.join(', ') +
              '; ' + censusBefore.tris + '\u2192' + censusAfter.tris + ' tris); piece unchanged', true);
    return;
  }
  // Progress gate. Not worse is not enough: Solidify exists to close
  // openings, so a result with as many open edges as the input is a refusal,
  // not an "ok" with an Undo entry for a change that did not happen. Driver
  // testing round 1 caught exactly that: "Solidify ok - open 16->16" on a
  // result byte-identical to its input.
  const leftWhy = (closeLoops && closeLoops.left.length) ? ' - left open: ' + closeLoops.left.join('; ') : '';
  if (censusAfter.open >= censusBefore.open) {
    setStatus('Solidify refused - closed none of the ' + censusBefore.open + ' open edges (open ' +
              censusBefore.open + '\u2192' + censusAfter.open + ')' + leftWhy + '; piece unchanged', true);
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
    if (typeof nsoReseatPlacedPose === 'function') nsoReseatPlacedPose(placedEntry);   // bake is in the piece's own frame: its pose still stands
  }
  // "ok" only when every opening closed; fewer but not zero is "partial" and
  // says what was left and why.
  const closedNote = (closeLoops && closeLoops.closed) ? '; ' + closeLoops.closed + ' loop(s) closed in place' : '';
  setStatus('Solidify ' + (censusAfter.open === 0 ? 'ok' : 'partial') +
            ' - open ' + censusBefore.open + '\u2192' + censusAfter.open +
            ', NM ' + censusBefore.nm + '\u2192' + censusAfter.nm +
            (censusAfter.degen ? ', degenerate ' + censusBefore.degen + '\u2192' + censusAfter.degen : '') +
            closedNote + (censusAfter.open ? leftWhy : ''));
}

// ---- Thicken: one-sided planar offset ----
//
// Thicken out / in moves ONE side of the piece's skin by the asked distance
// and leaves the other side exactly as it was:
//   out - the OUTER faces (the ones the outside world touches) move outward
//   in  - the INNER faces (pocket, slot, cavity, bore) move into their void
// Which side a face is on is a property of the face, not of where air can
// reach. A face whose plane supports the piece's convex hull (no vertex of
// the piece lies beyond it) is OUTER, and so is every face reached from one
// of those across creases shallower than THICKEN_SMOOTH_DEG - the rest of a
// tessellated curve, a rounded edge, a knuckle's far side. Everything else
// is INNER: an open cup's cavity floor and walls are inner even though the
// open top lets air in, because the rim is a sharp crease. That sharp crease
// is also what makes the offset well posed: the moving / held boundary only
// ever sits on an edge where the two planes meet at THICKEN_SMOOTH_DEG or
// more, never on the near-flat step between two facets of one curve. A
// pocket whose rim is rounded therefore reads as outside skin - Thicken in
// wants a sharp rim. The earlier voxel version decided in/out by flood-
// filling from the grid border, so every open cavity read as "exterior":
// Thicken in found nothing to grow into, Thicken out ate the slot as well as
// growing the outside, and both re-sampled the whole piece into cubes,
// which moved the held side too.
//
// The offset itself is the intersection of offset planes. Every vertex moves
// to the point that satisfies n.p' = n.p + d for each incident face on the
// moving side and n.p' = n.p for each face on the held side: exact when up to
// three plane directions meet, an area-weighted normal push when more than
// three all move together (a vertex on a coarse curve; least squares if their
// targets differ), minimum-norm when fewer (a vertex inside a flat face moves
// straight along the normal, a vertex on a box edge slides to the offset edge). Incident faces whose
// normals lie within THICKEN_CLUSTER_DEG of each other and share a target are
// merged into one plane first, so a tessellated curve moves along its vertex
// normal instead of chasing the intersection of near-parallel facets. Planar
// faces stay planar, box corners stay sharp, the triangle count does not
// change, and a held face's vertices that touch no moving face do not move at
// all - the held side is bit-identical to the input.
//
// Refused, piece unchanged: an offset that inverts a face (bigger than the
// slot or wall it grows into), one that raises the piercing self-intersection
// count, or a piece with no face on the asked side (Thicken in on a solid).
// A moving/held crease of only a few degrees (THICKEN_RESOLVE_RATIO; a fillet
// running tangent into a held face) cannot be placed exactly; those vertices move
// along the resolved directions only and are counted in the status line.
//
// PAINT SCOPE: WHOLE-PIECE. Any painted face on the piece stands this down.
// The moving side's rim vertices are shared with the held faces, so a painted
// held face would still change outline; there is no clean sub-region to scope
// to. nsoMaskCount is the whole test, as for Smooth - see the scoping rule in
// docs/HANDOFF.md.
//
// Non-solid flag: not read (docs/NON-SOLID.md section 6). The offset is per
// face and per vertex and never needed closure; open loops stay open and the
// status line still reports open / NM before and after.

const THICKEN_HULL_EPS = 1e-3;       // mm past a face plane a vertex may sit and the face still count as outer
const THICKEN_SMOOTH_DEG = 45;       // creases shallower than this are one surface; sharper ones bound a pocket
const THICKEN_CLUSTER_DEG = 15;      // incident faces this close in normal, same target, share one plane
const THICKEN_RESOLVE_RATIO = 1e-3;  // eigenvalue / largest below which a direction is left unresolved
const THICKEN_MAX_MOVE = 6;          // safety cap on a vertex's move, in offsets
const THICKEN_VOTE_AREA = 1e-3;      // mm2: a face smaller than this is a seam sliver and gets no vote on where a vertex goes
const THICKEN_FLIP_AREA = 1e-2;      // mm2: a face smaller than this (or thinner than THICKEN_SLIVER_WIDTH) may fold without an
const THICKEN_SLIVER_WIDTH = 0.1;    // mm   inversion verdict - it is well under a nozzle width; the piercing check still stands
const THICKEN_MIN_POCKET_AREA = 0.16; // mm2: an inner patch smaller than a nozzle-width square is surface noise, not a pocket

/* Weld the soup for topology only (1e-4 mm cells); positions are kept verbatim. */
function _thickenIndex(soup) {
  const inv = 1e4;
  const map = new Map();
  const pos = [];
  const tri = [];
  for (let i = 0; i < soup.length; i += 3) {
    const x = soup[i], y = soup[i + 1], z = soup[i + 2];
    const k = Math.round(x * inv) + ',' + Math.round(y * inv) + ',' + Math.round(z * inv);
    let id = map.get(k);
    if (id === undefined) { id = pos.length / 3; pos.push(x, y, z); map.set(k, id); }
    tri.push(id);
  }
  return { pos, tri };
}

/* Unit normals and areas per face from an indexed mesh; ok[f] = 0 for degenerate faces. */
function _thickenFaceNormals(pos, tri) {
  const nf = tri.length / 3;
  const n = new Float64Array(nf * 3);
  const area = new Float64Array(nf);
  const alt = new Float64Array(nf); // shortest altitude: the width of a sliver
  const ok = new Uint8Array(nf);
  let vol6 = 0;
  for (let f = 0; f < nf; f++) {
    const a = tri[f * 3] * 3, b = tri[f * 3 + 1] * 3, c = tri[f * 3 + 2] * 3;
    const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
    const e1x = pos[b] - ax, e1y = pos[b + 1] - ay, e1z = pos[b + 2] - az;
    const e2x = pos[c] - ax, e2y = pos[c + 1] - ay, e2z = pos[c + 2] - az;
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    vol6 += ax * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1])
          + ay * (pos[b + 2] * pos[c] - pos[b] * pos[c + 2])
          + az * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
    if (!(len > 1e-12)) continue;
    n[f * 3] = nx / len; n[f * 3 + 1] = ny / len; n[f * 3 + 2] = nz / len;
    area[f] = len / 2;
    const e3x = pos[c] - pos[b], e3y = pos[c + 1] - pos[b + 1], e3z = pos[c + 2] - pos[b + 2];
    const longest = Math.sqrt(Math.max(e1x * e1x + e1y * e1y + e1z * e1z, e2x * e2x + e2y * e2y + e2z * e2z, e3x * e3x + e3y * e3y + e3z * e3z));
    alt[f] = len / longest;
    ok[f] = 1;
  }
  return { n, area, alt, ok, signedVolume: vol6 / 6 };
}

/* outer[f] = 1 when the face plane supports the convex hull (no vertex of the
   piece lies more than THICKEN_HULL_EPS beyond it; coplanar faces share one
   test), or when a chain of creases shallower than THICKEN_SMOOTH_DEG leads
   to such a face. Every other face is inner. */
function _thickenClassifyOuter(pos, tri, fn, sign) {
  const outer = _thickenHullFaces(pos, tri, fn, sign);
  const nf = tri.length / 3, nv = pos.length / 3;
  // faces around each vertex: adjacency through shared vertices, so a
  // T-junction or a non-manifold edge still connects what it touches
  const vertFaces = new Array(nv);
  for (let f = 0; f < nf; f++) {
    if (!fn.ok[f]) continue;
    for (let k = 0; k < 3; k++) {
      const v = tri[f * 3 + k];
      (vertFaces[v] || (vertFaces[v] = [])).push(f);
    }
  }
  const cosSmooth = Math.cos(THICKEN_SMOOTH_DEG * Math.PI / 180);
  const queue = [];
  for (let f = 0; f < nf; f++) if (outer[f]) queue.push(f);
  while (queue.length) {
    const f = queue.pop();
    const nx = fn.n[f * 3], ny = fn.n[f * 3 + 1], nz = fn.n[f * 3 + 2];
    for (let k = 0; k < 3; k++) {
      const list = vertFaces[tri[f * 3 + k]];
      for (let i = 0; i < list.length; i++) {
        const g = list[i];
        if (g === f || outer[g]) continue;
        if (nx * fn.n[g * 3] + ny * fn.n[g * 3 + 1] + nz * fn.n[g * 3 + 2] > cosSmooth) { outer[g] = 1; queue.push(g); }
      }
    }
  }
  // an inner patch smaller than THICKEN_MIN_POCKET_AREA (a hairline ledge or
  // seam sliver left by a CAD export) is not a pocket: it rides with the skin
  const seen = new Uint8Array(nf);
  for (let f0 = 0; f0 < nf; f0++) {
    if (!fn.ok[f0] || outer[f0] || seen[f0]) continue;
    const comp = [f0]; seen[f0] = 1;
    let area = 0;
    for (let qi = 0; qi < comp.length; qi++) {
      const f = comp[qi];
      area += fn.area[f];
      for (let k = 0; k < 3; k++) {
        const list = vertFaces[tri[f * 3 + k]];
        for (let i = 0; i < list.length; i++) {
          const g = list[i];
          if (outer[g] || seen[g]) continue;
          seen[g] = 1; comp.push(g);
        }
      }
    }
    if (area < THICKEN_MIN_POCKET_AREA) for (let i = 0; i < comp.length; i++) outer[comp[i]] = 1;
  }
  return outer;
}

function _thickenHullFaces(pos, tri, fn, sign) {
  const nf = tri.length / 3, nv = pos.length / 3;
  const outer = new Uint8Array(nf);
  const cache = new Map();
  for (let f = 0; f < nf; f++) {
    if (!fn.ok[f]) continue;
    const nx = fn.n[f * 3] * sign, ny = fn.n[f * 3 + 1] * sign, nz = fn.n[f * 3 + 2] * sign;
    const a = tri[f * 3] * 3;
    const d = nx * pos[a] + ny * pos[a + 1] + nz * pos[a + 2];
    const key = Math.round(nx * 1e4) + ',' + Math.round(ny * 1e4) + ',' + Math.round(nz * 1e4) + ',' + Math.round(d * 1e3);
    let r = cache.get(key);
    if (r === undefined) {
      r = 1;
      for (let v = 0; v < nv; v++) {
        if (nx * pos[v * 3] + ny * pos[v * 3 + 1] + nz * pos[v * 3 + 2] - d > THICKEN_HULL_EPS) { r = 0; break; }
      }
      cache.set(key, r);
    }
    outer[f] = r;
  }
  return outer;
}

/* Eigen-decomposition of a symmetric 3x3 (Jacobi). Returns { val: [3], vec: [9] column-major }. */
function _thickenEigSym3(m) {
  const a = [m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]];
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 30; sweep++) {
    const off = Math.abs(a[1]) + Math.abs(a[2]) + Math.abs(a[5]);
    if (off < 1e-15) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      const apq = a[p * 3 + q];
      if (Math.abs(apq) < 1e-18) continue;
      const app = a[p * 3 + p], aqq = a[q * 3 + q];
      const theta = (aqq - app) / (2 * apq);
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k * 3 + p], akq = a[k * 3 + q];
        a[k * 3 + p] = c * akp - s * akq; a[k * 3 + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p * 3 + k], aqk = a[q * 3 + k];
        a[p * 3 + k] = c * apk - s * aqk; a[q * 3 + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k * 3 + p], vkq = v[k * 3 + q];
        v[k * 3 + p] = c * vkp - s * vkq; v[k * 3 + q] = s * vkp + c * vkq;
      }
    }
  }
  return { val: [a[0], a[4], a[8]], vec: v };
}

/* One vertex: cluster its incident planes, solve the offset-plane intersection.
   Returns { d: [dx,dy,dz], approx: 0|1 }. */
function _thickenSolveVertex(planes, offset) {
  const cosTol = Math.cos(THICKEN_CLUSTER_DEG * Math.PI / 180);
  const clusters = [];
  planes.sort((p, q) => q.w - p.w);
  for (const p of planes) {
    let hit = null;
    for (const c of clusters) {
      if (c.t !== p.t) continue;
      const len = Math.sqrt(c.sx * c.sx + c.sy * c.sy + c.sz * c.sz) || 1;
      if ((c.sx * p.nx + c.sy * p.ny + c.sz * p.nz) / len >= cosTol) { hit = c; break; }
    }
    if (hit) { hit.sx += p.w * p.nx; hit.sy += p.w * p.ny; hit.sz += p.w * p.nz; hit.w += p.w; }
    else clusters.push({ t: p.t, sx: p.w * p.nx, sy: p.w * p.ny, sz: p.w * p.nz, w: p.w });
  }
  // more than three plane directions, all moving (a vertex on a coarse
  // curve): the planes meet at no single point, and least squares would let
  // the odd one out drag the vertex sideways - move along the area-weighted
  // normal instead, scaled so the planes are offset by d on average
  if (clusters.length > 3 && clusters.every(c => c.t === clusters[0].t)) {
    let sx = 0, sy = 0, sz = 0;
    for (const c of clusters) { sx += c.sx; sy += c.sy; sz += c.sz; }
    const len = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (len > 1e-12) {
      sx /= len; sy /= len; sz /= len;
      let cosSum = 0, cnt = 0;
      for (const c of clusters) {
        const cl = Math.sqrt(c.sx * c.sx + c.sy * c.sy + c.sz * c.sz);
        if (cl > 1e-12) { cosSum += (c.sx * sx + c.sy * sy + c.sz * sz) / cl; cnt++; }
      }
      const scale = clusters[0].t / Math.max(cosSum / cnt, 0.2);
      return { d: [sx * scale, sy * scale, sz * scale], approx: 0 };
    }
  }
  // area weights average the normal inside a cluster; across clusters every
  // plane is one geometric constraint, so a small chamfer counts like a big face
  const A = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const b = [0, 0, 0];
  for (const c of clusters) {
    const len = Math.sqrt(c.sx * c.sx + c.sy * c.sy + c.sz * c.sz);
    if (!(len > 1e-12)) continue;
    const nx = c.sx / len, ny = c.sy / len, nz = c.sz / len;
    const w = 1 / clusters.length;
    A[0] += w * nx * nx; A[1] += w * nx * ny; A[2] += w * nx * nz;
    A[4] += w * ny * ny; A[5] += w * ny * nz; A[8] += w * nz * nz;
    b[0] += w * nx * c.t; b[1] += w * ny * c.t; b[2] += w * nz * c.t;
  }
  A[3] = A[1]; A[6] = A[2]; A[7] = A[5];
  const e = _thickenEigSym3(A);
  const lmax = Math.max(e.val[0], e.val[1], e.val[2]);
  const d = [0, 0, 0];
  let approx = 0;
  for (let k = 0; k < 3; k++) {
    const lam = e.val[k];
    const ex = e.vec[k], ey = e.vec[3 + k], ez = e.vec[6 + k];
    const proj = ex * b[0] + ey * b[1] + ez * b[2];
    if (lam <= THICKEN_RESOLVE_RATIO * lmax) {
      // no plane pins this direction (flat face, edge line) - stay put along it;
      // if the planes disagreed here it is a tangent crease, count it
      if (Math.abs(proj) > 1e-6 * Math.abs(offset)) approx = 1;
      continue;
    }
    const s = proj / lam;
    d[0] += s * ex; d[1] += s * ey; d[2] += s * ez;
  }
  const mag = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
  const cap = THICKEN_MAX_MOVE * Math.abs(offset);
  if (mag > cap) { const s = cap / mag; d[0] *= s; d[1] *= s; d[2] *= s; approx = 1; }
  return { d, approx };
}

/* The offset. Returns { soup, moved, held, approx } or { reason } when refused.

   opts.mayMove   optional Uint8Array, one entry per INPUT TRIANGLE (face f is
                  triangle f of the soup, because _thickenIndex welds positions
                  only and never reorders or merges faces). A 0 forbids that
                  face from moving; it becomes a HELD plane like any other, so
                  the vertex solve pins it exactly as it pins the far side of a
                  Thicken out. The filter only ever NARROWS: a face still has to
                  be on the asked side first. Omit it and nothing changes -
                  every existing caller passes two arguments and gets the
                  identical whole-surface offset it always got.

                  Added for Fatten (app-fatten.js), which restricts the offset
                  to the faces parallel to a piece's dominant axis so the length
                  stays fixed. The axis is entirely the caller's business: this
                  file offsets surfaces and has no notion of an axis, and giving
                  it one would be the wrong place to put it.

   offsetMm may be NEGATIVE here and always could be: every step below is
   linear in it and the sign simply reverses the push. Only the UI entry point
   gates it positive, which is why that gate is the one that had to learn about
   signed callers rather than this function. A shrink is refused by the same
   inversion check that refuses an over-large grow - a wall thinner than the
   amount taken off it turns inside out and is caught there. */
function _thickenOffsetSoup(soup, mode, offsetMm, opts) {
  opts = opts || {};
  const mayMove = opts.mayMove || null;
  const { pos, tri } = _thickenIndex(soup);
  const nf = tri.length / 3, nv = pos.length / 3;
  const fn = _thickenFaceNormals(pos, tri);
  // STLs wound inward (negative signed volume) still thicken outward
  const sign = fn.signedVolume < 0 ? -1 : 1;
  const outer = _thickenClassifyOuter(pos, tri, fn, sign);
  const moving = new Uint8Array(nf);
  let moved = 0, held = 0, filtered = 0;
  for (let f = 0; f < nf; f++) {
    if (!fn.ok[f]) continue;
    moving[f] = (mode === 'out') ? outer[f] : (outer[f] ? 0 : 1);
    if (moving[f] && mayMove && !mayMove[f]) { moving[f] = 0; filtered++; }
    if (moving[f]) moved++; else held++;
  }
  if (moved === 0) {
    if (filtered > 0) {
      return { reason: 'no face on the asked side survives the caller\'s filter (' + filtered + ' were filtered out)' };
    }
    return { reason: mode === 'out' ? 'no outer face found' : 'no inner face on this piece (every face is on the outside)' };
  }
  const incident = new Array(nv);
  for (let f = 0; f < nf; f++) {
    if (!fn.ok[f]) continue;
    for (let k = 0; k < 3; k++) {
      const v = tri[f * 3 + k];
      (incident[v] || (incident[v] = [])).push(f);
    }
  }
  const out = new Float64Array(pos.length);
  let approx = 0;
  for (let v = 0; v < nv; v++) {
    out[v * 3] = pos[v * 3]; out[v * 3 + 1] = pos[v * 3 + 1]; out[v * 3 + 2] = pos[v * 3 + 2];
    const list = incident[v];
    if (!list) continue;
    // a sliver's normal is noise; where a real face is present, slivers under
    // THICKEN_VOTE_AREA do not get a say in where the vertex goes
    let wmax = 0;
    for (const f of list) if (fn.area[f] > wmax) wmax = fn.area[f];
    const floor = wmax >= THICKEN_VOTE_AREA ? THICKEN_VOTE_AREA : 0;
    let any = 0;
    const planes = [];
    for (const f of list) {
      if (fn.area[f] < floor) continue;
      if (moving[f]) any = 1;
      planes.push({ nx: fn.n[f * 3] * sign, ny: fn.n[f * 3 + 1] * sign, nz: fn.n[f * 3 + 2] * sign,
                    w: fn.area[f], t: moving[f] ? offsetMm : 0 });
    }
    if (!any) continue; // touches no moving face: does not move, by construction
    const r = _thickenSolveVertex(planes, offsetMm);
    out[v * 3] += r.d[0]; out[v * 3 + 1] += r.d[1]; out[v * 3 + 2] += r.d[2];
    approx += r.approx;
  }
  // a face whose normal turned round grew past the feature it sits in
  // (a sliver - under THICKEN_FLIP_AREA, or thinner than THICKEN_SLIVER_WIDTH
  // - is tessellation noise, not a feature; it may fold without a verdict)
  let flipped = 0;
  const flipArea2 = 2 * THICKEN_FLIP_AREA;
  for (let f = 0; f < nf; f++) {
    if (!fn.ok[f] || fn.area[f] < THICKEN_FLIP_AREA || fn.alt[f] < THICKEN_SLIVER_WIDTH) continue;
    const a = tri[f * 3] * 3, b = tri[f * 3 + 1] * 3, c = tri[f * 3 + 2] * 3;
    const e1x = out[b] - out[a], e1y = out[b + 1] - out[a + 1], e1z = out[b + 2] - out[a + 2];
    const e2x = out[c] - out[a], e2y = out[c + 1] - out[a + 1], e2z = out[c + 2] - out[a + 2];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const dot = nx * fn.n[f * 3] + ny * fn.n[f * 3 + 1] + nz * fn.n[f * 3 + 2];
    if (dot <= 0 && Math.sqrt(nx * nx + ny * ny + nz * nz) > flipArea2) flipped++;
  }
  if (flipped > 0) {
    return { reason: offsetMm + ' mm is more than the feature it grows into (' + flipped + ' face(s) would turn inside out)' };
  }
  const res = new Float32Array(tri.length * 3);
  for (let i = 0; i < tri.length; i++) {
    const v = tri[i] * 3;
    res[i * 3] = out[v]; res[i * 3 + 1] = out[v + 1]; res[i * 3 + 2] = out[v + 2];
  }
  return { soup: res, moved, held, approx, filtered, signedVolume: fn.signedVolume };
}

function _thickenSignedVolume(soup) {
  let v6 = 0;
  for (let i = 0; i + 8 < soup.length; i += 9) {
    v6 += soup[i] * (soup[i + 4] * soup[i + 8] - soup[i + 5] * soup[i + 7])
        + soup[i + 1] * (soup[i + 5] * soup[i + 6] - soup[i + 3] * soup[i + 8])
        + soup[i + 2] * (soup[i + 3] * soup[i + 7] - soup[i + 4] * soup[i + 6]);
  }
  return v6 / 6;
}

// ---- main entry ----

/* The UI / commit half.

   opts is optional and every field of it defaults to exactly what the two
   Thicken buttons have always got, so `thickenSelectedModel(mode, mm)` is
   unchanged in behaviour and in the text it writes to the status line:

     opts.mayMove    narrow the moving face set - forwarded to
                     _thickenOffsetSoup, see its comment
     opts.signed     accept a negative offsetMm. The offset maths never cared
                     about the sign; this gate did, because the two Thicken
                     buttons only ever mean "outward" and a negative number in
                     their box is a typo. A caller that means "inward by this
                     much" says so here.
     opts.gate       extra refusal, called as gate(soupIn, working) after the
                     piercing check and before anything is committed. Returns a
                     reason string to refuse, or a falsy value to allow. This is
                     where a caller's own promise is proved - Fatten measures
                     the axial length on `working` here and refuses if it moved.
     opts.label      name for the status line, default 'Thicken'
     opts.modeLabel  the word after the label, default `mode`
     opts.mmLabel    the figure after that, default `offsetMm`. A caller whose
                     direction is already in the mode word ("shrink") says the
                     size as a plain magnitude here rather than printing a
                     minus sign the user never typed.
     opts.sideWord   'outer' / 'inner' in the status line, default from `mode`
     opts.undoType   undo entry type, default 'thickenReplace'. A new type needs
                     its row in UNDO_REPLACE_LABEL (app-core.js) or undo will
                     not handle it - that table is the gate as well as the label.
     opts.note       note(result, working) -> a string appended to the status
                     line after every figure Thicken reports, so a wrapper can
                     add its own without re-composing the whole message.

   Returns { ok, reason, ... } so a wrapper can report; the two buttons ignore
   it, as they always have. */
function thickenSelectedModel(mode, offsetMm, opts) {
  opts = opts || {};
  const label = opts.label || 'Thicken';
  const tag = label + ' ' + (opts.modeLabel || mode) + ' ' + (opts.mmLabel != null ? opts.mmLabel : offsetMm);
  const sideWord = opts.sideWord || (mode === 'out' ? 'outer' : 'inner');
  const m = getActiveModel();
  if (!m) { setStatus('Select a piece first', true); return { ok: false, reason: 'no selection' }; }
  if (!(opts.signed ? (isFinite(offsetMm) && offsetMm !== 0) : offsetMm > 0)) {
    setStatus(label + ' failed - enter a ' + (opts.signed ? 'non-zero' : 'positive') + ' mm value', true);
    return { ok: false, reason: 'offset out of range' };
  }

  const paintedCount = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
  if (paintedCount > 0) {
    setStatus('Thicken stood down - ' + paintedCount + ' painted face(s); the rim of the moving side ' +
              'is shared with the held faces, so no face can be promised untouched. Clear paint to thicken.', true);
    return { ok: false, reason: 'painted faces: ' + paintedCount, painted: paintedCount };
  }

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
  if (!soupIn || soupIn.length < 9) { setStatus(label + ' failed - piece unchanged', true); return { ok: false, reason: 'no soup' }; }

  let openBefore = null, nmBefore = null;
  try { openBefore = openBoundaryEdges(soupIn).length; } catch (e) {}
  try { if (typeof countNonManifoldEdges === 'function') nmBefore = countNonManifoldEdges(soupIn); } catch (e) {}

  // Slots (cups, USB) are leftover open loops on purpose; the offset never
  // needed closure, so nothing is welded or capped first and the held side
  // comes out exactly as it went in.
  let result = null;
  try { result = _thickenOffsetSoup(soupIn, mode, offsetMm, opts); } catch (e) { result = { reason: (e && e.message) || 'error' }; }
  if (!result || !result.soup || result.soup.length < 9) {
    setStatus(tag + ' failed - ' + ((result && result.reason) || 'piece unchanged') + '; piece unchanged', true);
    return { ok: false, reason: (result && result.reason) || 'piece unchanged' };
  }
  const working = result.soup;

  // Piercing self-intersections may not go up: the canonical policy lives in
  // NSO_Repair (held to tools/mesh_validate.py by nso_selfint_equiv_test).
  let pierceBefore = null, pierceAfter = null;
  try {
    if (typeof NSO_Repair !== 'undefined' && NSO_Repair && typeof NSO_Repair.inspect === 'function') {
      pierceBefore = NSO_Repair.inspect(soupIn).selfIntersections;
      pierceAfter = NSO_Repair.inspect(working).selfIntersections;
    }
  } catch (e) { pierceBefore = pierceAfter = null; }
  if (pierceBefore != null && pierceAfter != null && pierceAfter > pierceBefore) {
    setStatus(tag + ' failed - the moved faces would cross the piece (piercing pairs ' +
              pierceBefore + '→' + pierceAfter + '); piece unchanged', true);
    return { ok: false, reason: 'piercing ' + pierceBefore + '->' + pierceAfter };
  }

  // The caller's own promise, proved on the result and before any commit.
  if (typeof opts.gate === 'function') {
    let why = null;
    try { why = opts.gate(soupIn, working, result); } catch (e) { why = (e && e.message) || 'gate threw'; }
    if (why) {
      setStatus(tag + ' failed - ' + why + '; piece unchanged', true);
      return { ok: false, reason: why };
    }
  }

  pushUndo({
    type: opts.undoType || 'thickenReplace',
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
    if (typeof nsoReseatPlacedPose === 'function') nsoReseatPlacedPose(placedEntry);   // bake is in the piece's own frame: its pose still stands
  }

  let openAfter = null, nmAfter = null;
  try { openAfter = openBoundaryEdges(working).length; } catch (e) {}
  try { if (typeof countNonManifoldEdges === 'function') nmAfter = countNonManifoldEdges(working); } catch (e) {}
  let msg = tag + ' - ' + result.moved + ' ' + sideWord +
    ' face(s) moved, ' + result.held + ' held; open ' + (openBefore == null ? '?' : openBefore) + '\u2192' + (openAfter == null ? '?' : openAfter);
  if (nmBefore != null && nmAfter != null) msg += ', NM ' + nmBefore + '\u2192' + nmAfter;
  if (pierceBefore != null && pierceAfter != null) msg += ', piercing ' + pierceBefore + '\u2192' + pierceAfter;
  try {
    const sgn = result.signedVolume < 0 ? -1 : 1;
    msg += ', vol ' + (sgn * result.signedVolume).toFixed(1) + '\u2192' + (sgn * _thickenSignedVolume(working)).toFixed(1) + ' mm\u00b3';
  } catch (e) {}
  if (result.approx > 0) msg += '; ' + result.approx + ' vertex(es) on tangent creases placed approximately';
  if (opts.note) msg += opts.note(result, working);
  setStatus(msg);
  return { ok: true, result, tris: working, status: msg };
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
    if (typeof nsoReseatPlacedPose === 'function') nsoReseatPlacedPose(placedEntry);   // bake is in the piece's own frame: its pose still stands
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
    if (typeof nsoReseatPlacedPose === 'function') nsoReseatPlacedPose(placedEntry);   // bake is in the piece's own frame: its pose still stands
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
    if (typeof nsoReseatPlacedPose === 'function') nsoReseatPlacedPose(placed);   // bake is in the piece's own frame: its pose still stands
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
