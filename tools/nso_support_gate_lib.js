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
const AIR_MM = 0.42;          /* a tree's line further than a line's width from what is under it is printed over air */
const SPECK_MM2 = 0.8;
const IS_SUPPORT = /^Support( interface| transition)?$/;

function headOf(name) {
  const n = String(name || '').replace(/\.stl$/i, '');
  const m = / - (support\b.*|brim\b.*)$/i.exec(n);       /* 'X - support 1.1 (Tree)', 'X - brim'; a piece's own name may hold ' - ' ('supp_ref - 6 objects') */
  if (!m) return { head: n, kind: 'part' };
  return { head: n.slice(0, m.index), kind: /^brim/i.test(m[1]) ? 'brim' : 'support' };
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
        let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
        if (m.flat && (t < 0 || t > 1)) continue;                 /* flat ends: a line is as long as it is printed, not half a width past its end */
        t = t < 0 ? 0 : t > 1 ? 1 : t;
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

  /* 3b. the tree over air (the owner's gate 3: printable angles): Support (the tree, not the plate) cells further than AIR_MM from any support or
     part of the layers just below - a branch leaning more than a layer's step per layer, or an arm run out flat */
  let airMm2 = 0; const airAt = [];
  {
    const r = Math.round(AIR_MM / CELL_MM);
    for (const z of supZ) {
      if (z <= z0 + 1e-6) continue;
      const o = L.get(z); if (!o.sup) continue;
      const U = below(z); if (!U) continue;
      const Ud = dilate(F, U, AIR_MM);
      let n = 0, sx = 0, sy = 0;
      for (let c = 0; c < F.n; c++) {
        if (!o.sup[c] || (o.I && o.I[c]) || (o.T && o.T[c]) || Ud[c]) continue;
        n++; const p = cellXY(F, c); sx += p[0]; sy += p[1];
      }
      if (n) { airMm2 += n * A; airAt.push({ z, areaMm2: +(n * A).toFixed(2), x: +(sx / n).toFixed(1), y: +(sy / n).toFixed(1) }); }
    }
    airAt.sort((a, b) => b.areaMm2 - a.areaMm2);
  }

  /* 4. empty layers between support layers */
  const empty = [];
  for (let q = 1; q < supZ.length; q++) if (supZ[q] - supZ[q - 1] > EMPTY_STEP_MM) empty.push({ from: supZ[q - 1], to: supZ[q] });

  /* 5. carried, 6. depth, 7. specks: labelled slices only */
  let carried = null, depth = null, specks = null, depthSeqs = null;
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
    let cols = 0, good = 0; const seqs = new Map();
    for (let c = 0; c < F.n; c++) {
      if (top[c] < 0 || bottom[c] > 1e8 || bottom[c] - top[c] > CONTACT_MM) continue;
      let seq = '';
      for (let q = supZ.length - 1; q >= 0 && seq.length < 5; q--) {
        const z = supZ[q]; if (z > top[c] + 1e-6) continue;
        const o = L.get(z); if (!o.sup[c]) break;
        seq += o.I && o.I[c] ? 'I' : o.T && o.T[c] ? 'T' : 'S';
      }
      if (!seq.length) continue;
      cols++; if (/^I{3,}T/.test(seq)) good++; seqs.set(seq, (seqs.get(seq) || 0) + 1);
    }
    depth = cols ? good / cols : null;
    depthSeqs = [...seqs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(e => e[0] + ' ' + (100 * e[1] / cols).toFixed(0) + '%');
    void sheetZ;
  }
  touchAt.sort((a, b) => b.areaMm2 - a.areaMm2);
  return { airMm2: +airMm2.toFixed(2), airAt, touchAt, touchMm2: +touch.toFixed(2), thinMm2: +thin.toFixed(2), contactMm2: +(contact * A).toFixed(1), share, floating, empty, carried, depth, depthSeqs, specks, labelled };
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
  { check: 'tree over air mm2', get: r => r.airMm2,           ok: (o, r) => o <= Math.max(1.5 * r, r + 2), rule: '<= max(1.5 x ref, ref + 2)' },
  { check: 'floating islands', get: r => r.floating.length,   ok: (o, r) => o <= r,                rule: '<= ref' },
  { check: 'empty layers',     get: r => r.empty.length,      ok: (o, r) => o <= r,                rule: '<= ref' },
  { check: 'sheet carried',    get: r => r.carried,           ok: (o, r) => o >= r - 0.10,         rule: '>= ref - 0.10', pct: true, labelled: true },
  { check: 'depth III+T',      get: r => r.depth,             ok: (o, r) => o >= r - 0.15,         rule: '>= ref - 0.15', pct: true, labelled: true }
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

/* PARITY: how far our interface and transition look like Bambu's, layer by layer - what G-scope's Compare overlays. The two heads are put in
   one frame by the centres of their parts; each of the reference's interface / transition layers is set against ours on the same height (within
   PARITY_Z_MM), lines drawn PARITY_FAT_MM wide with flat ends (round ones ran a quarter of a mm past every hatch line's end: past a hole's
   edge, where Bambu's lines stop) so lines a pitch apart are one plate.
     iou    plate both have / plate either has, over all the reference's sheet layers (a layer ours lacks counts all theirs as missed)
     role   the same with the type matched: interface on interface, transition on transition
     grid   the share of the reference's sheet layers ours has a layer at, within PARITY_GRID_MM
     worst  the five layers that differ most: { z, refMm2, oursMm2, iou } */
const PARITY_Z_MM = 0.1, PARITY_GRID_MM = 0.03, PARITY_FAT_MM = 0.5;
function parity(testMs, refMs) {
  const ctr = (ms) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; ms.forEach(m => { if (m.role !== 'part' || m.feat !== 'Outer wall') return; x0 = Math.min(x0, m.x0, m.x1); y0 = Math.min(y0, m.y0, m.y1); x1 = Math.max(x1, m.x0, m.x1); y1 = Math.max(y1, m.y0, m.y1); }); return isFinite(x0) ? [(x0 + x1) / 2, (y0 + y1) / 2] : null; };
  const ca = ctr(refMs), cb = ctr(testMs);
  if (!ca || !cb) return null;
  const dx = ca[0] - cb[0], dy = ca[1] - cb[1];
  const sheet = (m) => m.role === 'support' && (m.feat === 'Support interface' || m.feat === 'Support transition');
  const R = refMs.filter(sheet), T = testMs.filter(sheet).map(m => Object.assign({}, m, { x0: m.x0 + dx, x1: m.x1 + dx, y0: m.y0 + dy, y1: m.y1 + dy, pts: m.pts ? m.pts.map(p => [p[0] + dx, p[1] + dy]) : undefined }));
  if (!R.length) return null;
  const F = frame(R.concat(T)), A = CELL_MM * CELL_MM;
  const byZ = (ms) => { const L = new Map(); ms.forEach(m => { if (!L.has(m.z)) L.set(m.z, []); L.get(m.z).push(m); }); return L; };
  const LR = byZ(R), LT = byZ(T), tz = [...LT.keys()];
  let both = 0, either = 0, roleBoth = 0, gridHit = 0, n = 0; const rows = [];
  for (const z of [...LR.keys()].sort((a, b) => a - b)) {
    n++;
    let best = null, bd = Infinity; for (const q of tz) { const d = Math.abs(q - z); if (d < bd) { bd = d; best = q; } }
    if (bd <= PARITY_GRID_MM) gridHit++;
    const paint = (ms, feat) => { const bm = new Uint8Array(F.n); ms.forEach(m => { if (!feat || m.feat === feat) draw(F, bm, Object.assign({}, m, { w: PARITY_FAT_MM, flat: true })); }); return bm; };
    const rI = paint(LR.get(z), 'Support interface'), rT = paint(LR.get(z), 'Support transition');
    const tm = best != null && bd <= PARITY_Z_MM ? LT.get(best) : [];
    const oI = paint(tm, 'Support interface'), oT = paint(tm, 'Support transition');
    let b = 0, e = 0, rb = 0, ra = 0, oa = 0;
    for (let c = 0; c < F.n; c++) {
      const r = rI[c] || rT[c], o = oI[c] || oT[c];
      if (r) ra++; if (o) oa++;
      if (r && o) b++; if (r || o) e++;
      if ((rI[c] && oI[c]) || (rT[c] && oT[c] && !rI[c] && !oI[c])) rb++;
    }
    both += b; either += e; roleBoth += rb;
    rows.push({ z, oursZ: tm.length ? best : null, refMm2: +(ra * A).toFixed(1), oursMm2: +(oa * A).toFixed(1), iou: e ? +(b / e).toFixed(2) : null });
  }
  rows.sort((a, b) => (a.iou == null ? -1 : a.iou) - (b.iou == null ? -1 : b.iou));
  return { iou: either ? both / either : null, role: either ? roleBoth / either : null, grid: n ? gridHit / n : null, worst: rows.slice(0, 5) };
}
function parityAll(testMoves, refMoves) {
  const T = byHead(testMoves), R = byHead(refMoves), out = {};
  for (const [h, rm] of R) { const tm = T.get(h); if (tm) { const p = parity(tm, rm); if (p) out[h] = p; } }
  return out;
}

module.exports = { parity, parityAll, movesFromGcode, measureHead, measureAll, gate, headOf, RULES, CELL_MM };
