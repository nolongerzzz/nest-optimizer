/* ============================================================
   tools/nso_support_gate_lib.js - THE PRINTABILITY GATE's measuring core (docs/SUPPORT-GATE.md).

   What a support interface has to do to print and break away, measured on the G-code itself (whoever sliced it:
   NSO, or Bambu Studio slicing NSO's support meshes, or Bambu's own supports), one head at a time:

     touch     support lines with no air under the part's next layer (gap < 0.05 mm): they weld
     thin      gap 0.05 - 0.15 mm (Bambu's own independent support layers leave a few of these in a cavity)
     one       the share of the contact area with one layer of air (0.15 - 0.25 mm): what releases cleanly
     two       the share with two layers of air (0.35 - 0.6 mm): the part's underside sags into it
     floating  support islands (>= FLOAT_MIN_MM2) with nothing under them in the layers just below: printed in the air
     empty     a support with no line on a layer between two layers it prints (Bambu's "empty layer" warning)
     carried   (labelled slices) the share of each sheet's lowest layer within CARRY_MM of support in the layer below
     depth     (labelled slices) the share of contact columns whose top support layers are interface x3 then transition x2
     specks    (info) support islands under 0.8 mm2 in the two layers under a sheet: tips too thin to hold it

   Everything is a raster of CELL_MM cells: each extrusion drawn at its own width (0.42 when the G-code does not say),
   so no geometry kernel is needed and Bambu's arcs (G2/G3, read as points by nso_slicer_audit.extrusions) count.

   Moves in: [{ head, role: 'part' | 'support', feat, z, h, x0, y0, x1, y1, w?, pts? }]
     measureHead(moves) -> { touchMm2, thinMm2, contactMm2, share: { touch, thin, one, mid, two }, floating: [...],
                             empty: [...], carried, depth, specks, labelled }
     movesFromGcode(gcode, sliceInfoXml) -> moves with head / role from the objects' names ('X', 'X - support ...',
                             'X - brim': the brim is left out) and the features ('Support*' inside a part is support)
     gate(test, ref) -> [{ head, check, ok, ours, ref, rule }]
   ============================================================ */
'use strict';
const AUDIT = require('./nso_slicer_audit.js');

const CELL_MM = 0.1;
const LINE_MM = 0.42;
const TOUCH_MM = 0.05, THIN_MM = 0.15, ONE_MM = 0.25, MID_MM = 0.35, CONTACT_MM = 0.6;
const FLOAT_MIN_MM2 = 0.3;      /* an island smaller than this is a speck, counted under specks, not floating */
const FLOAT_LOOK_MM = 0.35;     /* "just below": any layer of the head (part or support) within this under the island's layer */
const EMPTY_STEP_MM = 0.45;     /* two support layers further apart than this have an empty layer between them */
const CARRY_MM = 1.0;
const SPECK_MM2 = 0.8;
const IS_SUPPORT = /^Support( interface| transition)?$/;

function headOf(name) {
  const n = String(name || '').replace(/\.stl$/i, '');
  const k = n.indexOf(' - ');
  if (k < 0) return { head: n, kind: 'part' };
  const rest = n.slice(k + 3).toLowerCase();
  return { head: n.slice(0, k), kind: rest.startsWith('brim') ? 'brim' : 'support' };
}

function movesFromGcode(gcode, sliceInfoXml) {
  const names = AUDIT.sliceNames(sliceInfoXml || '');
  const out = [];
  for (const m of AUDIT.extrusions(gcode)) {
    const nm = names[m.obj];
    if (nm == null) continue;
    const ho = headOf(nm);
    if (ho.kind === 'brim' || m.feat === 'Brim' || m.feat === 'Custom') continue;
    const role = ho.kind === 'support' || IS_SUPPORT.test(m.feat || '') ? 'support' : 'part';
    out.push({ head: ho.head, role, feat: m.feat, z: Math.round(m.z * 1000) / 1000, h: m.h, x0: m.x0, y0: m.y0, x1: m.x1, y1: m.y1, pts: m.pts });
  }
  return out;
}

/* ---- the raster ---- */
function frame(moves) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const m of moves) {
    const P = m.pts || [[m.x0, m.y0], [m.x1, m.y1]];
    for (const p of P) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
  }
  x0 -= 1.5; y0 -= 1.5; x1 += 1.5; y1 += 1.5;
  const nx = Math.ceil((x1 - x0) / CELL_MM) + 1, ny = Math.ceil((y1 - y0) / CELL_MM) + 1;
  return { x0, y0, nx, ny, n: nx * ny };
}
function draw(F, bm, m) {
  const r = (m.w || LINE_MM) / 2, r2 = r * r;
  const P = m.pts || [[m.x0, m.y0], [m.x1, m.y1]];
  for (let q = 1; q < P.length; q++) {
    const ax = P[q - 1][0], ay = P[q - 1][1], bx = P[q][0], by = P[q][1];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - r - F.x0) / CELL_MM)), i1 = Math.min(F.nx - 1, Math.ceil((Math.max(ax, bx) + r - F.x0) / CELL_MM));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - r - F.y0) / CELL_MM)), j1 = Math.min(F.ny - 1, Math.ceil((Math.max(ay, by) + r - F.y0) / CELL_MM));
    for (let j = j0; j <= j1; j++) {
      const py = F.y0 + (j + 0.5) * CELL_MM;
      for (let i = i0; i <= i1; i++) {
        const px = F.x0 + (i + 0.5) * CELL_MM;
        let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = px - ax - t * dx, qy = py - ay - t * dy;
        if (qx * qx + qy * qy <= r2) bm[j * F.nx + i] = 1;
      }
    }
  }
}
function dilate(F, bm, rMm) {
  const k = Math.round(rMm / CELL_MM), out = new Uint8Array(F.n);
  if (k <= 0) { out.set(bm); return out; }
  /* separable square dilation, then trimmed to a disc by a second pass would cost more than it is worth: the square is within 1.41 x */
  const tmp = new Uint8Array(F.n);
  for (let j = 0; j < F.ny; j++) {
    let last = -1e9;
    for (let i = 0; i < F.nx; i++) { if (bm[j * F.nx + i]) last = i; if (i - last <= k) tmp[j * F.nx + i] = 1; }
    last = 1e9;
    for (let i = F.nx - 1; i >= 0; i--) { if (bm[j * F.nx + i]) last = i; if (last - i <= k) tmp[j * F.nx + i] = 1; }
  }
  for (let i = 0; i < F.nx; i++) {
    let last = -1e9;
    for (let j = 0; j < F.ny; j++) { if (tmp[j * F.nx + i]) last = j; if (j - last <= k) out[j * F.nx + i] = 1; }
    last = 1e9;
    for (let j = F.ny - 1; j >= 0; j--) { if (tmp[j * F.nx + i]) last = j; if (last - j <= k) out[j * F.nx + i] = 1; }
  }
  return out;
}
function islands(F, bm) {
  const lab = new Int32Array(F.n).fill(-1), out = [], stack = [];
  for (let s = 0; s < F.n; s++) {
    if (!bm[s] || lab[s] >= 0) continue;
    const cells = []; lab[s] = out.length; stack.push(s);
    while (stack.length) {
      const c = stack.pop(); cells.push(c);
      const i = c % F.nx, j = (c - i) / F.nx;
      const nb = [i > 0 ? c - 1 : -1, i < F.nx - 1 ? c + 1 : -1, j > 0 ? c - F.nx : -1, j < F.ny - 1 ? c + F.nx : -1];
      for (const d of nb) if (d >= 0 && bm[d] && lab[d] < 0) { lab[d] = out.length; stack.push(d); }
    }
    out.push(cells);
  }
  return out;
}
const cellXY = (F, c) => { const i = c % F.nx, j = (c - i) / F.nx; return [F.x0 + (i + 0.5) * CELL_MM, F.y0 + (j + 0.5) * CELL_MM]; };

function measureHead(moves) {
  const F = frame(moves), A = CELL_MM * CELL_MM;
  const L = new Map();   /* z -> { h, part, sup, I, T } */
  const lay = (z, h) => { let o = L.get(z); if (!o) { o = { z, h: h || 0.2, part: null, sup: null, I: null, T: null }; L.set(z, o); } if (h && h < o.h) o.h = h; return o; };
  let labelled = false;
  for (const m of moves) {
    const o = lay(m.z, m.h);
    const key = m.role === 'part' ? 'part' : 'sup';
    if (!o[key]) o[key] = new Uint8Array(F.n);
    draw(F, o[key], m);
    if (m.role === 'support' && (m.feat === 'Support interface' || m.feat === 'Support transition')) {
      labelled = true;
      const k2 = m.feat === 'Support interface' ? 'I' : 'T';
      if (!o[k2]) o[k2] = new Uint8Array(F.n);
      draw(F, o[k2], m);
    }
  }
  const zs = [...L.keys()].sort((a, b) => a - b);
  const supZ = zs.filter(z => L.get(z).sup), partZ = zs.filter(z => L.get(z).part);
  const z0 = supZ.length ? supZ[0] : 0;

  /* 1. touch / thin: a support layer's lines under a part layer whose underside is that close above */
  let touch = 0, thin = 0; const touchAt = [];
  for (const zs_ of supZ) {
    const S = L.get(zs_).sup;
    for (const zp of partZ) {
      const P = L.get(zp), b = zp - P.h, gap = b - zs_;
      if (gap < -0.01 || gap >= THIN_MM) continue;
      let n = 0, sx = 0, sy = 0; for (let c = 0; c < F.n; c++) if (S[c] && P.part[c]) { n++; const p = cellXY(F, c); sx += p[0]; sy += p[1]; }
      if (gap < TOUCH_MM) { touch += n * A; if (n) touchAt.push({ z: zs_, partZ: zp, areaMm2: +(n * A).toFixed(2), x: +(sx / n).toFixed(1), y: +(sy / n).toFixed(1) }); } else thin += n * A;
    }
  }

  /* 2. the air gap at every contact column: the column's highest support, and the lowest part underside over it */
  const top = new Float32Array(F.n).fill(-1);
  for (const z of supZ) { if (z < z0 + 0.3) continue; const S = L.get(z).sup; for (let c = 0; c < F.n; c++) if (S[c]) top[c] = z; }
  const bottom = new Float32Array(F.n).fill(1e9);
  for (let q = partZ.length - 1; q >= 0; q--) {
    const P = L.get(partZ[q]), b = partZ[q] - P.h;
    for (let c = 0; c < F.n; c++) if (P.part[c] && top[c] >= 0 && b >= top[c] - 0.01) bottom[c] = b;
  }
  const share = { touch: 0, thin: 0, one: 0, mid: 0, two: 0 }; let contact = 0;
  for (let c = 0; c < F.n; c++) {
    if (top[c] < 0 || bottom[c] > 1e8) continue;
    const g = bottom[c] - top[c];
    if (g > CONTACT_MM) continue;
    contact++;
    share[g < TOUCH_MM ? 'touch' : g < THIN_MM ? 'thin' : g <= ONE_MM ? 'one' : g <= MID_MM ? 'mid' : 'two']++;
  }
  Object.keys(share).forEach(k => { share[k] = contact ? share[k] / contact : 0; });

  /* 3. floating islands, and 7. specks under a sheet */
  const floating = [];
  const below = (z) => { const u = new Uint8Array(F.n); let any = false; for (const z2 of zs) { if (z2 >= z - 1e-6 || z2 < z - FLOAT_LOOK_MM) continue; const o = L.get(z2); for (const k of ['sup', 'part']) if (o[k]) { any = true; for (let c = 0; c < F.n; c++) if (o[k][c]) u[c] = 1; } } return any ? u : null; };
  for (const z of supZ) {
    if (z <= z0 + 1e-6) continue;
    const S = L.get(z).sup, U = below(z);
    for (const cells of islands(F, S)) {
      const a = cells.length * A;
      if (a < FLOAT_MIN_MM2) continue;
      if (U && cells.some(c => U[c])) continue;
      const p = cellXY(F, cells[cells.length >> 1]);
      floating.push({ z, areaMm2: +a.toFixed(2), x: +p[0].toFixed(1), y: +p[1].toFixed(1) });
    }
  }

  /* 4. empty layers between support layers */
  const empty = [];
  for (let q = 1; q < supZ.length; q++) if (supZ[q] - supZ[q - 1] > EMPTY_STEP_MM) empty.push({ from: supZ[q - 1], to: supZ[q] });

  /* 5. carried, 6. depth, 7. specks: labelled slices only */
  let carried = null, depth = null, specks = null;
  if (labelled) {
    let base = 0, held = 0, nSpeck = 0;
    const sheetZ = supZ.filter(z => L.get(z).I || L.get(z).T);
    for (let q = 0; q < supZ.length; q++) {
      const o = L.get(supZ[q]); if (!o.I && !o.T) continue;
      const prev = q > 0 ? L.get(supZ[q - 1]) : null;
      const under = prev && prev.sup ? dilate(F, prev.sup, CARRY_MM) : null;
      let thisBase = 0;
      for (let c = 0; c < F.n; c++) {
        if (!((o.I && o.I[c]) || (o.T && o.T[c]))) continue;
        if (prev && ((prev.I && prev.I[c]) || (prev.T && prev.T[c]))) continue;
        base++; thisBase++;
        if (under && under[c]) held++;
      }
      if (thisBase && q > 0) {   /* the islands of the two layers under this sheet bottom, under it */
        const sheetHere = new Uint8Array(F.n); for (let c = 0; c < F.n; c++) if ((o.I && o.I[c]) || (o.T && o.T[c])) sheetHere[c] = 1;
        for (const q2 of [q - 1, q - 2]) {
          if (q2 < 0) continue; const o2 = L.get(supZ[q2]); if (!o2.sup) continue;
          const plain = new Uint8Array(F.n); for (let c = 0; c < F.n; c++) if (o2.sup[c] && !(o2.I && o2.I[c]) && !(o2.T && o2.T[c])) plain[c] = 1;
          for (const cells of islands(F, plain)) if (cells.length * A < SPECK_MM2 && cells.some(c => sheetHere[c])) nSpeck++;
        }
      }
    }
    carried = base ? held / base : null; specks = nSpeck;
    /* depth: every contact column, its support layers top down */
    let cols = 0, good = 0;
    for (let c = 0; c < F.n; c++) {
      if (top[c] < 0 || bottom[c] > 1e8 || bottom[c] - top[c] > CONTACT_MM) continue;
      let seq = '';
      for (let q = supZ.length - 1; q >= 0 && seq.length < 5; q--) {
        const z = supZ[q]; if (z > top[c] + 1e-6) continue;
        const o = L.get(z); if (!o.sup[c]) break;
        seq += o.I && o.I[c] ? 'I' : o.T && o.T[c] ? 'T' : 'S';
      }
      if (!seq.length) continue;
      cols++; if (seq === 'IIITT') good++;
    }
    depth = cols ? good / cols : null;
    void sheetZ;
  }
  touchAt.sort((a, b) => b.areaMm2 - a.areaMm2);
  return { touchAt, touchMm2: +touch.toFixed(2), thinMm2: +thin.toFixed(2), contactMm2: +(contact * A).toFixed(1), share, floating, empty, carried, depth, specks, labelled };
}

function byHead(moves) {
  const H = new Map();
  for (const m of moves) { if (!H.has(m.head)) H.set(m.head, []); H.get(m.head).push(m); }
  return H;
}
function measureAll(moves) {
  const out = {};
  for (const [h, ms] of byHead(moves)) if (ms.some(m => m.role === 'support')) out[h] = measureHead(ms);
  return out;
}

/* the rules: each against the reference's own number for the same head */
const RULES = [
  { check: 'contact area',     get: r => r.contactMm2,        ok: (o, r) => o >= 0.9 * r,          rule: '>= 0.9 x ref' },
  { check: 'touch mm2',        get: r => r.touchMm2,          ok: (o, r) => o <= r + 0.5,          rule: '<= ref + 0.5' },
  { check: 'one-layer gap',    get: r => r.share.one,         ok: (o, r) => o >= r - 0.10,         rule: '>= ref - 0.10', pct: true },
  { check: 'two-layer gap',    get: r => r.share.two,         ok: (o, r) => o <= r + 0.15,         rule: '<= ref + 0.15', pct: true },
  { check: 'floating islands', get: r => r.floating.length,   ok: (o, r) => o <= r,                rule: '<= ref' },
  { check: 'empty layers',     get: r => r.empty.length,      ok: (o, r) => o <= r,                rule: '<= ref' },
  { check: 'sheet carried',    get: r => r.carried,           ok: (o, r) => o >= r - 0.10,         rule: '>= ref - 0.10', pct: true, labelled: true },
  { check: 'IIITT depth',      get: r => r.depth,             ok: (o, r) => o >= r - 0.15,         rule: '>= ref - 0.15', pct: true, labelled: true }
];
function gate(test, ref) {
  const rows = [];
  for (const h of Object.keys(ref)) {
    const t = test[h], r = ref[h];
    for (const R of RULES) {
      if (!t) { rows.push({ head: h, check: R.check, ok: false, ours: null, ref: R.get(r), rule: 'no support for this head' }); continue; }
      if (R.labelled && (!t.labelled || !r.labelled)) continue;
      const o = R.get(t), rv = R.get(r);
      if (o == null || rv == null) continue;
      rows.push({ head: h, check: R.check, ok: R.ok(o, rv), ours: o, ref: rv, rule: R.rule, pct: !!R.pct });
    }
  }
  return rows;
}

module.exports = { movesFromGcode, measureHead, measureAll, gate, headOf, RULES, CELL_MM };
