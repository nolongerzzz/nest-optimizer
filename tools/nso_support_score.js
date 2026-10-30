#!/usr/bin/env node
/* THE PLATE SCORE: every piece of the six-part supp_ref, generated and sliced here, against Bambu's own slice of it, by the same diff
   G-scope's Compare > Measure reads (nso-gscope-diff.js). One table, so a change that mends one piece shows what it did to the others.

     NSO_SCORE_REF=supp_ref.gcode.3mf node tools/nso_support_score.js [--json out.json] [--vs before.json] [--piece Oblique]

   Per piece, for the interface + transition (the plate that touches the model and has to break away) and for the tree:
     IoU   material both have / (both + only ours + only theirs), summed over the layers, 0 - 1; higher is better
     len   our line length / theirs                       (1.00 = the same amount of line)
     mv    our move count / theirs                        (1.00 = lines as long as theirs; high = chopped up)
     z0    first layer, ours / theirs                     (a plate that starts late or early)
   The two are put in one frame by the centre of the part's outer wall.
   No reference given: nothing to score, exit 0. */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const lib = require('./nso_support_plate_lib.js');
const SL = require(path.join(ROOT, 'nso_slicer.js'));
const G = require(path.join(ROOT, 'nso-gcode-lines.js'));
const R3 = require(path.join(ROOT, 'nso-3mf-read.js'));
const AUDIT = require('./nso_slicer_audit.js');
const D = require(path.join(ROOT, 'nso-gscope-diff.js'));

const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const REF = process.env.NSO_SCORE_REF;
const PLATE = ['interface', 'transition'];

function centre(moves) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  moves.forEach(m => { if (m.feature !== 'Outer wall') return; x0 = Math.min(x0, m.x0, m.x1); x1 = Math.max(x1, m.x0, m.x1); y0 = Math.min(y0, m.y0, m.y1); y1 = Math.max(y1, m.y0, m.y1); });
  return isFinite(x0) ? [(x0 + x1) / 2, (y0 + y1) / 2] : null;
}


/* The plate as a volume, independent of how either slicer cut it into layers: every plate line drawn FAT_MM wide, over the height of its layer
   (z - h .. z), into cells of CELL_MM x CELL_MM x ZBIN_MM; the IoU of the two volumes. A plate on another layer grid is not penalised for the grid. */
const CELL = 0.2, ZBIN = 0.05, FAT = 1.0;
function volumeIoU(a, b) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, zMax = 0;
  const keep = (ms) => ms.filter(m => /^Support (interface|transition)$/.test(m.feature));
  const A = keep(a), B = keep(b);
  A.concat(B).forEach(m => { x0 = Math.min(x0, m.x0, m.x1); x1 = Math.max(x1, m.x0, m.x1); y0 = Math.min(y0, m.y0, m.y1); y1 = Math.max(y1, m.y0, m.y1); zMax = Math.max(zMax, m.z); });
  if (!isFinite(x0)) return null;
  x0 -= FAT; y0 -= FAT; x1 += FAT; y1 += FAT;
  const nx = Math.ceil((x1 - x0) / CELL) + 1, ny = Math.ceil((y1 - y0) / CELL) + 1, nz = Math.ceil(zMax / ZBIN) + 2;
  const paint = (ms) => {
    const V = new Uint8Array(nx * ny * nz), r = FAT / 2;
    ms.forEach(m => {
      const h = m.height || 0.2, k0 = Math.max(0, Math.round((m.z - h) / ZBIN)), k1 = Math.min(nz - 1, Math.round(m.z / ZBIN) - 1);
      const i0 = Math.max(0, Math.floor((Math.min(m.x0, m.x1) - r - x0) / CELL)), i1 = Math.min(nx - 1, Math.ceil((Math.max(m.x0, m.x1) + r - x0) / CELL));
      const j0 = Math.max(0, Math.floor((Math.min(m.y0, m.y1) - r - y0) / CELL)), j1 = Math.min(ny - 1, Math.ceil((Math.max(m.y0, m.y1) + r - y0) / CELL));
      const dx = m.x1 - m.x0, dy = m.y1 - m.y0, L2 = dx * dx + dy * dy;
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const px = x0 + (i + 0.5) * CELL, py = y0 + (j + 0.5) * CELL;
        let t = L2 > 0 ? ((px - m.x0) * dx + (py - m.y0) * dy) / L2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = px - (m.x0 + t * dx), qy = py - (m.y0 + t * dy);
        if (qx * qx + qy * qy > r * r) continue;
        for (let k = k0; k <= k1; k++) V[(k * ny + j) * nx + i] = 1;
      }
    });
    return V;
  };
  const VA = paint(A), VB = paint(B);
  let both = 0, oa = 0, ob = 0;
  for (let q = 0; q < VA.length; q++) { if (VA[q] && VB[q]) both++; else if (VA[q]) oa++; else if (VB[q]) ob++; }
  const c3 = CELL * CELL * ZBIN;
  return { iou: both + oa + ob ? both / (both + oa + ob) : null, bothMm3: both * c3, onlyOursMm3: oa * c3, onlyTheirsMm3: ob * c3 };
}

function movesOf(result) {
  const out = [];
  result.objects.forEach(ob => (ob.layers || []).forEach(L => (L.paths || []).forEach(p => {
    const pts = p.pts.slice();
    if (p.closed && pts.length > 2) pts.push(pts[0]);
    for (let q = 1; q < pts.length; q++) {
      out.push({ feature: p.feature, z: L.printZ, x0: pts[q - 1][0], y0: pts[q - 1][1], x1: pts[q][0], y1: pts[q][1], width: p.width || 0.42, height: L.h || 0.2,
                 length: Math.hypot(pts[q][0] - pts[q - 1][0], pts[q][1] - pts[q - 1][1]) });
    }
  })));
  return out;
}

function scoreOf(rep) {
  const sum = (f) => PLATE.reduce((a, c) => a + f(rep.classes[c]), 0);
  const both = sum(c => c.bothMm2), oa = sum(c => c.onlyAMm2), ob = sum(c => c.onlyBMm2);
  const lenA = sum(c => c.A.lengthMm), lenB = sum(c => c.B.lengthMm), mvA = sum(c => c.A.moves), mvB = sum(c => c.B.moves);
  const z0 = (side) => { const v = PLATE.map(c => rep.classes[c][side].firstZ).filter(v => v != null); return v.length ? Math.min.apply(null, v) : null; };
  const T = rep.classes.support;
  return {
    plateIoU: both + oa + ob ? both / (both + oa + ob) : null, plateBothMm2: both, plateOnlyOursMm2: oa, plateOnlyTheirsMm2: ob,
    lenRatio: lenB ? lenA / lenB : null, mvRatio: mvB && lenB && lenA ? (mvA / lenA) / (mvB / lenB) : null,    // moves per mm of line, ours over theirs
    z0Ours: z0('A'), z0Theirs: z0('B'),
    treeIoU: T.bothMm2 + T.onlyAMm2 + T.onlyBMm2 ? T.bothMm2 / (T.bothMm2 + T.onlyAMm2 + T.onlyBMm2) : null,
    treeLenRatio: T.B.lengthMm ? T.A.lengthMm / T.B.lengthMm : null
  };
}

(async () => {
  if (!REF || !fs.existsSync(REF)) { console.log('nso_support_score: set NSO_SCORE_REF to supp_ref.gcode.3mf (Bambu\'s slice of the six pieces) - nothing to score.'); return; }
  const only = arg('--piece');
  const objs = await lib.readFixture(path.join(ROOT, 'fixtures', 'supports', 'supp_ref.3mf'));
  const bytes = new Uint8Array(fs.readFileSync(REF));
  const ref = await G.readSlicedGcode3MF(bytes, { name: 'ref' });
  const zip = R3.openZip(bytes);
  const names = AUDIT.sliceNames(new TextDecoder().decode(await zip.read('Metadata/slice_info.config')));
  const app = lib.makeApp(); const ids = app.load(objs); app.openCard(); app.setPlateBox(true);
  app.click('btn-sup-all'); await app.until(() => app.card.busy()); await app.until(() => !app.card.busy());
  const WASM = await SL.loadKernel({});
  const rows = {};
  for (let i = 0; i < objs.length; i++) {
    const nm = objs[i].name.replace(/\.stl$/i, '');
    if (only && !nm.includes(only)) continue;
    const sups = app.supportsOf(ids[i]).map(m => Array.from(app.soupOf(m.id)));
    const objl = [{ name: 'part', soup: Float32Array.from(app.soupOf(ids[i])), key: 101, role: 'part' }]
      .concat(sups.map((s, k) => ({ name: 's' + k, soup: Float32Array.from(s), key: 201 + k, role: 'support', hostKey: 101 })));
    const ours = movesOf(SL.sliceObjects(objl, SL.defaultsFor(0.4, { supportInterfaceLayers: 3, supportLayerMaxMm: process.env.NSO_SCORE_FLAT ? 0 : 0.28 }), WASM));
    const rid = Object.keys(names).filter(k => names[k] === objs[i].name).map(Number);
    const theirs = ref.parsed.moves.filter(m => rid.includes(+m.objectId));
    const ca = centre(ours), cb = centre(theirs);
    if (!ca || !cb || !theirs.length) { console.log(nm.padEnd(22) + 'no reference object found'); continue; }
    const shifted = theirs.map(m => Object.assign({}, m, { x0: m.x0 - cb[0] + ca[0], x1: m.x1 - cb[0] + ca[0], y0: m.y0 - cb[1] + ca[1], y1: m.y1 - cb[1] + ca[1] }));
    if (arg('--dump')) { fs.mkdirSync(arg('--dump'), { recursive: true }); fs.writeFileSync(path.join(arg('--dump'), nm.replace(/\W+/g, '_') + '.json'), JSON.stringify({ ours: ours, theirs: shifted })); }
    const rep = D.compute(ours, shifted, {});
    rows[nm] = scoreOf(rep);
    // the footprint: every line of the plate drawn 1.6 mm wide, so lines 0.46 apart are one sheet, and a different zig-zag in the same ribbon is the same ribbon
    const fat = (ms) => ms.filter(m => /^Support (interface|transition)$/.test(m.feature)).map(m => Object.assign({}, m, { width: 1.6 }));
    const rf = D.compute(fat(ours), fat(shifted), {});
    const fb = PLATE.reduce((a, c) => a + rf.classes[c].bothMm2, 0), fa = PLATE.reduce((a, c) => a + rf.classes[c].onlyAMm2, 0), fo = PLATE.reduce((a, c) => a + rf.classes[c].onlyBMm2, 0);
    const vi = volumeIoU(ours, shifted); rows[nm].volIoU = vi && vi.iou; rows[nm].volOnlyOursMm3 = vi && vi.onlyOursMm3; rows[nm].volOnlyTheirsMm3 = vi && vi.onlyTheirsMm3;
    rows[nm].footIoU = fb + fa + fo ? fb / (fb + fa + fo) : null; rows[nm].footOnlyOursMm2 = fa; rows[nm].footOnlyTheirsMm2 = fo;
    rows[nm].gaps = { oursLacks: rep.gaps.aLacks.slice(0, 4), theirsLacks: rep.gaps.bLacks.slice(0, 2) };
  }
  const f = (v, d) => v == null ? '   -  ' : v.toFixed(d == null ? 2 : d).padStart(6);
  const before = arg('--vs') && fs.existsSync(arg('--vs')) ? JSON.parse(fs.readFileSync(arg('--vs'), 'utf8')) : null;
  console.log('piece                  vol IoU  foot IoU  line IoU  len   mv/mm   z0 ours/theirs   tree IoU  tree len' + (before ? '    foot IoU was' : ''));
  Object.keys(rows).forEach(nm => {
    const r = rows[nm], b = before && before[nm];
    console.log(nm.padEnd(22) + f(r.volIoU) + '  ' + f(r.footIoU) + '  ' + f(r.plateIoU) + '    ' + f(r.lenRatio) + ' ' + f(r.mvRatio) + '   ' + f(r.z0Ours) + '/' + f(r.z0Theirs).trim().padEnd(6) + '   ' + f(r.treeIoU) + '   ' + f(r.treeLenRatio) +
                (b ? '      ' + f(b.footIoU) + (b.footIoU != null && r.footIoU != null ? (r.footIoU - b.footIoU >= 0 ? '  +' : '  ') + (r.footIoU - b.footIoU).toFixed(2) : '') : ''));
  });
  const out = arg('--json');
  if (out) fs.writeFileSync(out, JSON.stringify(rows, null, 1));
})().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
