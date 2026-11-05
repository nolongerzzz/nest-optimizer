/* Measurements on a cut piece, shared by tools/nso_cut_bore_test.js (Node)
   and tools/nso_wire_cut_bore_test.js (injected into the page as a script).
   Plain functions over a flat xyz triangle soup; no dependencies. Positions
   are compared exactly: rawCut welds, so equal means the same vertex.

     topo(soup)                  V, E, F, chi, duplicate faces, edges not
                                 shared by exactly two faces, directed edges
                                 used other than once (winding), volume
     capOf(soup, ai, plane, pt)  the faces lying on the plane coordinate
                                 `plane` of axis ai (within 1e-4): area,
                                 connected pieces, boundary loops, chi, and
                                 whether any of them covers 2D point pt     */

function pk(s, o) { return s[o] + ',' + s[o + 1] + ',' + s[o + 2]; }

// Whole-piece topology on exact positions (rawCut welds, so equal means same).
function topo(s) {
  const verts = new Set(), directed = new Map(), faces = new Set();
  let dupFaces = 0, vol = 0;
  for (let t = 0; t < s.length; t += 9) {
    const k = [pk(s, t), pk(s, t + 3), pk(s, t + 6)];
    k.forEach(x => verts.add(x));
    const fk = k.slice().sort().join('|');
    if (faces.has(fk)) dupFaces++; else faces.add(fk);
    for (let e = 0; e < 3; e++) {
      const d = k[e] + '>' + k[(e + 1) % 3];
      directed.set(d, (directed.get(d) || 0) + 1);
    }
    vol += s[t] * (s[t+4] * s[t+8] - s[t+5] * s[t+7]) - s[t+1] * (s[t+3] * s[t+8] - s[t+5] * s[t+6])
         + s[t+2] * (s[t+3] * s[t+7] - s[t+4] * s[t+6]);
  }
  let badEdge = 0, badWinding = 0, edges = 0;
  for (const [d, n] of directed) {
    const [a, b] = d.split('>');
    const r = directed.get(b + '>' + a) || 0;
    if (n !== 1) badWinding++;
    if (n + r !== 2) badEdge++;
    if (a < b || !directed.has(b + '>' + a)) edges++;
  }
  return { V: verts.size, E: edges, F: s.length / 9, chi: verts.size - edges + s.length / 9,
           dupFaces, badEdge, badWinding, volume: vol / 6 };
}

// The cut face: triangles lying on the plane (display coordinate within 1e-4
// of it). Area, connected pieces, boundary loops, Euler characteristic, and
// whether any of it covers a given point (a bore's centre).
function capOf(s, ai, plane, probe) {
  const o1 = (ai + 1) % 3, o2 = (ai + 2) % 3;
  const tris = [];
  for (let t = 0; t < s.length; t += 9) {
    if (Math.abs(s[t+ai] - plane) < 1e-4 && Math.abs(s[t+3+ai] - plane) < 1e-4 && Math.abs(s[t+6+ai] - plane) < 1e-4) tris.push(t);
  }
  let area = 0, coversProbe = false;
  const parent = new Map();
  const find = x => { while (parent.get(x) !== x) x = parent.get(x); return x; };
  const unite = (a, b) => { a = find(a); b = find(b); if (a !== b) parent.set(a, b); };
  const verts = new Set(), und = new Map();
  for (const t of tris) {
    const A = [s[t+o1], s[t+o2]], B = [s[t+3+o1], s[t+3+o2]], C = [s[t+6+o1], s[t+6+o2]];
    area += Math.abs((B[0]-A[0]) * (C[1]-A[1]) - (B[1]-A[1]) * (C[0]-A[0])) / 2;
    if (probe) {
      const sg = (p, q, r) => (p[0]-r[0]) * (q[1]-r[1]) - (q[0]-r[0]) * (p[1]-r[1]);
      const d1 = sg(probe, A, B), d2 = sg(probe, B, C), d3 = sg(probe, C, A);
      if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) coversProbe = true;
    }
    const k = [pk(s, t), pk(s, t + 3), pk(s, t + 6)];
    k.forEach(x => { verts.add(x); if (!parent.has(x)) parent.set(x, x); });
    unite(k[0], k[1]); unite(k[1], k[2]);
    for (let e = 0; e < 3; e++) {
      const a = k[e], b = k[(e + 1) % 3], u = a < b ? a + '~' + b : b + '~' + a;
      und.set(u, (und.get(u) || 0) + 1);
    }
  }
  const comps = new Set([...verts].map(find)).size;
  // Boundary edges (used once in the cap) walked into loops.
  const adj = new Map();
  for (const [u, n] of und) {
    if (n !== 1) continue;
    const [a, b] = u.split('~');
    (adj.get(a) || adj.set(a, []).get(a)).push(b);
    (adj.get(b) || adj.set(b, []).get(b)).push(a);
  }
  let loops = 0, branchy = false;
  const seen = new Set();
  for (const [v, nb] of adj) {
    if (nb.length !== 2) branchy = true;
    if (seen.has(v)) continue;
    loops++;
    const stack = [v];
    while (stack.length) { const x = stack.pop(); if (seen.has(x)) continue; seen.add(x); adj.get(x).forEach(y => stack.push(y)); }
  }
  return { tris: tris.length, area, comps, loops: branchy ? -1 : loops, chi: verts.size - und.size + tris.length, coversProbe };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { pk, topo, capOf };
