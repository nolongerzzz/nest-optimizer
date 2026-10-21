#!/usr/bin/env node
/* ============================================================
   tools/nso_support_curved_check.js - THE STAIR: the sheet under a curved
   underside (npm run support:curved; docs/SUPPORT-INTERFACE.md section 7).

   The piece is fixtures/supports/simple_overhang.3mf - the Simple Overhang
   Test: a 10 mm wide arc that leans from upright at its foot to 10 deg off
   level at its top, z 3 - 46.5 - built by the Supports card's own pipeline
   (detectOverhangs, planTree per area, NSO_SupportGridpack.parts with the
   card's PARTS_OPTS, shells) at 35 deg, Tree, 1.2 mm, rest off. The
   reference is Bambu Studio's own tree on the same file
   (fixtures/supports/simple_overhang_bambu.gcode.3mf, tree slim, threshold
   30): a staircase of ribbons, interface at z 41.8 - 46.2, one strip a layer
   across the overhang's width, moving up the curve as the layers rise.

     node tools/nso_support_curved_check.js      exit 0 = every gate held
     (writes tools/supports-curved-out/simple_overhang_supports.3mf, the arc
      with its supports as the card exports it, to slice with Bambu's own
      supports off and print)

   1. THE STAIR. One stair under the arc; a strip on every layer from the
      first it holds to the top, each a layer over the one below; nothing
      above the top: the top strip within two layers of the highest point
      of the underside less the gap, and no strip past it.
   2. EACH STRIP, measured on the parts built (a cut at each layer's middle):
      ONE connected region (its loop and its serpentine, joined at one
      point), no chain left open; its width across the slope (the outline
      less a line) 0.5 - 2.52 mm (two pitches, or three where the next strip
      jumps two: see the report); its overlap with the strip below, along
      the slope, 0.4 mm or more.
   3. THE GAP: the whole support (stair, caps, trunks) against the arc with
      the exact triangle distance: 0.18 mm or more.
   4. WHAT CARRIES IT: the lowest strip stands on caps over a few tips (its
      transition under it); every other tip of the stair is held by the
      stair and not built - a few tips, not trees.
   5. AGAINST BAMBU: every layer of Bambu's interface up to our top has a
      strip of ours at that z, over the same stretch of the curve (their
      ranges along the slope overlap).
   6. NSO's SLICE of the export (the card's own slicer, detect_thin_wall on):
      every layer of the stair, its transition to its top, is typed Support
      interface or Support transition; the support's lines are support lines
      only.
   7. FLAT CEILINGS UNCHANGED: the 2026-10-20 coupon (top_clip_x2_coupon.stl)
      as the card builds it is byte for byte the build before the stair
      (sha-256 of each object's soup, recorded at claude-wip 6f3354f), and
      no stair forms on it.
   8. THE REFUSAL, the card in Chromium at 60 deg (its default until #263): the arc's area
      - its top included - reads held; the three spots at its foot the plate
      cannot reach (over the part's own 2 mm base, past the 30 deg lean) are
      an area of their own, "unreachable · no route to the plate · 3 spots".
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'supports-curved-out');
const FIXTURE = path.join(ROOT, 'fixtures', 'supports', 'simple_overhang.3mf');
const BAMBU = path.join(ROOT, 'fixtures', 'supports', 'simple_overhang_bambu.gcode.3mf');
const R3 = require(path.join(ROOT, 'nso-3mf-read.js'));
const SL = require(path.join(ROOT, 'nso_slicer.js'));
const G = require(path.join(ROOT, 'nso-gcode-lines.js'));
const AUD = require('./nso_slicer_audit.js');
const EXP = require('./nso_supports_print_export.js');
const { readSTL } = require('./nso_stl_io.js');

const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Promise, Date, WeakMap,
  Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, Uint16Array, Int8Array, ArrayBuffer
};
vm.createContext(ctx);
/* the card's build worker's own list (app-supports-card.js ENGINE) */
for (const f of ['nso_thickness.js', 'nso_support_beacons.js', 'nso_support_aim.js', 'nso_path_sweep.js',
                 'nso_support_tree.js', 'nso_support_gridpack.js', 'nso_raster_lines.js', 'nso_crosshatch.js',
                 'nso_support_interface.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const SA = ctx.NSO_SupportAim, ST = ctx.NSO_SupportTree, GP = ctx.NSO_SupportGridpack, SI = ctx.NSO_SupportInterface, TH = ctx.NSO_Thickness;
const GAP = SI.DEFAULTS.gapMm, LAYER = SI.DEFAULTS.layerMm, PITCH = SI.SHEET.pitchMm;
const ANGLE = 35;
const CARD = { skipList: [], angleDeg: ANGLE, occluders: [], style: 'tree', restOnModel: false, sideMm: 1.2 };
const PARTS = { interface: true, foldSheets: false, footPads: 'shared' };
const NAME = 'simple_overhang';
/* the coupon as the card built it at claude-wip 6f3354f, before the stair:
   sha-256 (first 16 hex) of each object's Float32 soup */
const COUPON_BEFORE = { 'top_clip_x2': ['b26160d6312caabd', 58], 'top_clip_x2 - support 1.1 (Tree)': ['6ac271882b107552', 27348] };

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const f2 = v => (+v).toFixed(2), f3 = v => (+v).toFixed(3);
const sha = soup => crypto.createHash('sha256').update(Buffer.from(new Float32Array(soup).buffer)).digest('hex').slice(0, 16);

/* a soup cut by the plane z: its segments */
function sliceAt(soup, z) {
  const segs = [];
  for (let i = 0; i < soup.length; i += 9) {
    const P = [[soup[i], soup[i + 1], soup[i + 2]], [soup[i + 3], soup[i + 4], soup[i + 5]], [soup[i + 6], soup[i + 7], soup[i + 8]]];
    const pts = [];
    for (let k = 0; k < 3; k++) {
      const a = P[k], b = P[(k + 1) % 3];
      if ((a[2] - z) * (b[2] - z) < 0) { const t = (z - a[2]) / (b[2] - a[2]); pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
    }
    if (pts.length === 2) segs.push(pts);
  }
  return segs;
}
/* segments joined into closed loops, and how many chains were left open */
function loopsOf(segs) {
  const key = p => Math.round(p[0] / 1e-5) + ',' + Math.round(p[1] / 1e-5), adj = new Map();
  segs.forEach((sg, i) => [key(sg[0]), key(sg[1])].forEach(k => { if (!adj.has(k)) adj.set(k, []); adj.get(k).push(i); }));
  const used = new Uint8Array(segs.length), polys = [];
  let open = 0;
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const start = key(segs[i][0]), pts = [segs[i][0]];
    let at = key(segs[i][1]), pt = segs[i][1], closed = false;
    for (;;) {
      if (at === start) { closed = true; break; }
      pts.push(pt);
      const nx = (adj.get(at) || []).find(j => !used[j]);
      if (nx == null) break;
      used[nx] = 1;
      pt = key(segs[nx][0]) === at ? segs[nx][1] : segs[nx][0]; at = key(pt);
    }
    if (closed) polys.push(pts); else open++;
  }
  return { polys, open };
}
const areaOf = P => { let a = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
const inPoly = (p, P) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const a = P[i], b = P[j];
  if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
/* a section's regions: its loops that lie in no other loop */
function regionsOf(sec) {
  return sec.polys.filter((P, i) => !sec.polys.some((Q, j) => j !== i && Math.abs(areaOf(Q)) > Math.abs(areaOf(P)) && inPoly(P[0], Q)));
}

async function loadArc() {
  const r = await R3.parse3MF(new Uint8Array(fs.readFileSync(FIXTURE)), { name: 'simple_overhang.3mf' });
  return new Float32Array(r.objects[0].positions);
}

/* the card's build at ANGLE: every area, shells, then shareFeet over them */
async function build(piece) {
  const t0 = Date.now();
  const det = SA.detectOverhangs(piece, { skipList: [], angleDeg: ANGLE, occluders: [] });
  if (!det.ok) throw new Error(det.reason);
  const areas = [];
  let plateZ = 0;
  for (const rg of det.beaconRegions) {
    const bs = rg.beacons.map(b => ({ x: b.x, y: b.y, z: b.z, normal: b.normal, regionId: rg.id, key: 'k' }));
    const p = ST.planTree(piece, Object.assign({}, CARD, { beacons: bs }));
    if (!p.ok || !p.trunks.length) { areas.push({ rid: rg.id, p, tp: null, sh: null, n: rg.beacons.length }); continue; }
    plateZ = p.plateZ;
    const tp = await GP.parts(p, PARTS);
    if (!tp.ok) throw new Error('area ' + (rg.id + 1) + ': ' + tp.reason);
    areas.push({ rid: rg.id, p, tp, sh: GP.shells(p, tp), n: rg.beacons.length });
  }
  const live = areas.filter(a => a.sh);
  const sf = GP.shareFeet(live.map(a => ({ solids: a.sh.solids })), piece, { plateZ });
  if (!sf.ok) throw new Error(sf.reason);
  const objects = [{ name: NAME, soup: piece }];
  let n = 0;
  live.forEach((a, ai) => sf.objects.filter(o => o.from[0][0] === ai).forEach(o => {
    objects.push({ name: `${NAME} - support ${a.rid + 1}.${++n} (Tree)`, soup: o.soup, settings: Object.assign({}, SI.SHEET.slicerSettings) }); }));
  return { areas, live, sf, objects, ms: Date.now() - t0 };
}

/* the card in Chromium at 60 deg: section 8 */
async function cardRun() {
  const { pathToFileURL } = require('url');
  const lib = await import(pathToFileURL(path.join(__dirname, 'cth-test', 'browser-lib.mjs')).href);
  const { chromium } = require('playwright');
  const served = await lib.serveRoot();
  const browser = await chromium.launch(lib.launchOpts());
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    lib.routeCdn(page);
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(served.base + '/index.html', { waitUntil: 'load' });
    await page.waitForFunction('window.state && window.state.ready', null, { timeout: 30000 });
    await page.waitForFunction(() => !!window.NSO_SUPPORTS_CARD, null, { timeout: 30000 });
    const bytes = Array.from(fs.readFileSync(FIXTURE));
    await page.evaluate(a => handleFiles([new File([new Uint8Array(a)], 'Simple_Overhang_Test.3mf')]), bytes);
    await page.waitForFunction(() => state.models.length === 1 && state.placed.length === 1, null, { timeout: 30000 });
    const id = await page.evaluate(() => state.placed[0].sourceId);
    await page.click('#menu-supports > summary');
    /* 60 deg, set, not left to the default: #263 makes the card's default 35 */
    await page.evaluate(id => { NSO_SUPPORTS_CARD.pick(id); NSO_SUPPORTS_CARD.angle(60); }, id);
    await page.waitForFunction(() => NSO_SUPPORTS_CARD.view().areas.length > 0, null, { timeout: 60000 });
    const before = await page.evaluate(() => NSO_SUPPORTS_CARD.view());
    await page.evaluate(() => NSO_SUPPORTS_CARD.generate());
    await page.waitForFunction(() => !window.NSO_SUPPORTS_CARD.busy(), null, { timeout: 600000 });
    const after = await page.evaluate(() => NSO_SUPPORTS_CARD.view());
    return { before, after, errors };
  } finally {
    await browser.close();
    if (served.close) served.close();
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const piece = await loadArc();
  const P = TH.prepare(piece, {});
  const b = await build(piece);
  const arc = b.areas.find(a => a.tp && a.tp.sheet && a.tp.sheet.levels.some(L => L.stair));
  const S = arc ? arc.tp.sheet : null, L = S ? S.levels.find(x => x.stair) : null;
  console.log(`simple_overhang at ${ANGLE} deg: built in ${b.ms} ms - ${b.areas.length} areas; ${S ? S.reason : 'no sheet'}`);

  /* ------------------------------------------------------------------ 1 */
  console.log('\n=== 1. the stair ===');
  check('one stair under the arc', !!L && S.levels.filter(x => x.stair).length === 1,
    L ? `slope ${f2(L.stair.slopeDeg)} deg fitted, lines at ${L.stair.angleDeg} deg, ${L.stair.strips} strips` : 'none');
  if (!L) { console.log('\nFAILED  ' + pass + ' of ' + (pass + fail)); process.exit(1); }
  const strips = L.layers.filter(x => x.role === 'interface'), trans = L.layers.filter(x => x.role === 'transition');
  const steps = strips.slice(1).map((x, i) => x.z1 - strips[i].z1);
  check('a strip on every layer from the first it holds to the top, each a layer over the one below',
    strips.length >= 10 && steps.every(d => Math.abs(d - LAYER) < 1e-6),
    `${strips.length} strips, tops ${f2(strips[0].z1)} - ${f2(strips[strips.length - 1].z1)}, every step ${LAYER} mm`);
  /* the highest point of the arc's underside: the first face up from under it, over its footprint */
  let under = -Infinity;
  for (let x = 85.1; x <= 94.9; x += 0.25) for (let y = 88; y <= 114; y += 0.1) {
    const h = P.hitsAlong([x, y, 30], [0, 0, 1], 25);
    if (h.length) under = Math.max(under, 30 + h[0]);
  }
  const top = strips[strips.length - 1];
  check('nothing above the top: the top strip within two layers of the underside\'s highest point less the gap, and no strip past it',
    top.z1 <= under - GAP + 1e-6 && top.z1 >= under - GAP - 2 * LAYER - 1e-6,
    `underside up to z ${f3(under)}; top strip ${f2(top.z0)} - ${f2(top.z1)} (Bambu's top interface: 46.2)`);

  /* ------------------------------------------------------------------ 2 */
  console.log('\n=== 2. each strip, measured on the parts built ===');
  const entry = arc.tp.trunks.find(t => t.sheet === L.id);
  const soups = entry.parts.map(q => q.soup);
  check('the stair\'s parts are its layers, one each (transition, then the strips)', soups.length === L.layers.length,
    `${soups.length} parts, ${trans.length} transition + ${strips.length} strips`);
  const th = L.stair.angleDeg * Math.PI / 180, nrm = [-Math.sin(th), Math.cos(th)], dir = [Math.cos(th), Math.sin(th)];
  const uOf = q => q[0] * nrm[0] + q[1] * nrm[1], vOf = q => q[0] * dir[0] + q[1] * dir[1];
  const W = S.widthMm;
  const secs = L.layers.map((Ly, i) => {
    const sec = loopsOf(sliceAt(soups[i], (Ly.z0 + Ly.z1) / 2)), reg = regionsOf(sec);
    const us = reg.length ? reg[0].map(uOf) : [0], vs = reg.length ? reg[0].map(vOf) : [0];
    return { Ly, sec, reg, u: [Math.min(...us), Math.max(...us)], v: [Math.min(...vs), Math.max(...vs)] };
  });
  const badReg = secs.filter(s => s.reg.length !== 1 || s.sec.open);
  check('every layer is ONE connected region (its loop and its serpentine, joined at one point), no chain left open',
    !badReg.length, badReg.length ? badReg.map(s => `z ${f2(s.Ly.z1)}: ${s.reg.length} regions, ${s.sec.open} open`).join('; ')
      : `${secs.length} layers, holes a layer ${[...new Set(secs.map(s => s.sec.polys.length - 1))].join(' / ')}`);
  const widths = secs.map(s => s.u[1] - s.u[0] - W);
  const wide = widths.filter(w => w > 2 * PITCH + 0.05).length;
  check('each strip 0.5 - 2.52 mm across the slope (its outline less a line): two pitches, one at the top, three where the next strip jumps two',
    widths.every(w => w >= 0.5 - 1e-3 && w <= 3 * PITCH + 0.05),
    `${f2(Math.min(...widths))} - ${f2(Math.max(...widths))} mm; ${wide} strip(s) of three pitches (over 2.5)`);
  check('...and as long as the arc is wide, near enough (Bambu\'s lines: 10.32 mm)', secs.every(s => s.v[1] - s.v[0] - W >= 8.0),
    `${f2(Math.min(...secs.map(s => s.v[1] - s.v[0] - W)))} - ${f2(Math.max(...secs.map(s => s.v[1] - s.v[0] - W)))} mm of line`);
  const ovs = [];
  for (let i = 1; i < secs.length; i++) {
    if (secs[i].Ly.role !== 'interface' || secs[i - 1].Ly.role !== 'interface') continue;
    ovs.push({ z: secs[i].Ly.z1, mm: Math.min(secs[i].u[1], secs[i - 1].u[1]) - Math.max(secs[i].u[0], secs[i - 1].u[0]) });
  }
  const minOv = ovs.reduce((a, o) => o.mm < a.mm ? o : a, { mm: Infinity });
  check('each strip overlaps the one below by 0.4 mm or more along the slope (it rests on it)', ovs.every(o => o.mm >= 0.4 - 1e-3),
    `least ${f3(minOv.mm)} mm at z ${f2(minOv.z)}; ${ovs.filter(o => o.mm > 2 * PITCH).length} of ${ovs.length} over two pitches`);
  check('the transition is the lowest strip again, one layer under it', trans.length === 1 && Math.abs(trans[0].z1 - strips[0].z0) < 1e-6 &&
    Math.abs(secs[0].u[0] - secs[1].u[0]) < 1e-3 && Math.abs(secs[0].u[1] - secs[1].u[1]) < 1e-3, `${f2(trans[0].z0)} - ${f2(trans[0].z1)}`);
  /* how near each strip lies under the part, over its down-slope line */
  const lifts = strips.map(Ly => {
    const lo = Math.min(...Ly.paths[0].map(uOf)), mid = (Math.min(...Ly.paths[0].map(vOf)) + Math.max(...Ly.paths[0].map(vOf))) / 2;
    const q = [lo * nrm[0] + mid * dir[0], lo * nrm[1] + mid * dir[1]];
    const h = P.hitsAlong([q[0], q[1], Ly.z1], [0, 0, 1], 5);
    return h.length ? h[0] : Infinity;
  }).sort((a, b) => a - b);
  console.log(`        the part over each strip's down-slope line: ${f2(lifts[0])} - ${f2(lifts[lifts.length - 1])} mm over its top, median ${f2(lifts[lifts.length >> 1])} (the grid's pitch: a strip moves a whole pitch or none)`);

  /* ------------------------------------------------------------------ 3 */
  console.log('\n=== 3. the gap ===');
  const sup = b.objects.slice(1);
  let dmin = Infinity, at = null;
  sup.forEach(o => { const d = SI.exactDistance(o.soup, piece, { reach: 1 }); if (d.mm < dmin) { dmin = d.mm; at = d.at; } });
  let dStair = Infinity;
  soups.forEach(s => { dStair = Math.min(dStair, SI.exactDistance(s, piece, { reach: 1 }).mm); });
  check('the whole support keeps the gap: exact triangle distance 0.18 mm or more', dmin >= GAP - 1e-5,
    `${f3(dmin)} mm at ${at ? at.map(f2).join(', ') : '-'}; the stair alone ${f3(dStair)}`);

  /* ------------------------------------------------------------------ 4 */
  console.log('\n=== 4. what carries it ===');
  const tips = S.tips, held = tips.filter(t => t.mode === 'drop'), carriers = tips.filter(t => t.mode === 'sheet' && t.level === L.id);
  check('the lowest strip stands on caps over a few tips; every other tip of the stair is held by the stair, not built',
    carriers.length >= 2 && carriers.length <= 8 && held.length >= 20 && carriers.length + held.length === L.tips.length + (L.held || []).length,
    `${carriers.length} tips carry it (${L.caps.length} caps, ${L.caps.map(c => f2(c.w)).join(' / ')} mm; z_cap ${f2(L.zCap)}), ${held.length} held by it, ${tips.filter(t => t.mode === 'gap').length} cut at the gap`);
  const trunksBuilt = arc.tp.trunks.filter(t => t.sheet == null && t.parts.length).length;
  const membersBuilt = arc.tp.trunks.filter(t => t.sheet == null).reduce((n, t) => n + t.parts.length, 0);
  check('...a few tips, not trees: the members that hold only stair-held tips are left out', trunksBuilt <= arc.p.trunks.length && membersBuilt < arc.p.members.length,
    `${trunksBuilt} of ${arc.p.trunks.length} trunks built, ${membersBuilt} parts for ${arc.p.members.filter(m => !m.dead).length} planned members`);
  check('...and the stair is one support with the trunks it stands on (the spots it holds are its)', arc.sh.solids.filter(x => x.sheets.length).length === 1 &&
    arc.sh.solids.find(x => x.sheets.length).beacons.length === arc.n, `${arc.sh.solids.length} solid(s); the stair's holds ${arc.sh.solids.find(x => x.sheets.length).beacons.length} of ${arc.n} spots`);

  /* ------------------------------------------------------------------ 5 */
  console.log('\n=== 5. against Bambu\'s own (tree slim, threshold 30) ===');
  {
    const zip = R3.openZip(new Uint8Array(fs.readFileSync(BAMBU)));
    const gcode = new TextDecoder().decode(await zip.read('Metadata/plate_1.gcode'));
    const ex = AUD.extrusions(gcode).filter(m => m.feat === 'Support interface');
    const byZ = new Map();
    ex.forEach(m => {
      const k = m.z.toFixed(2), r = byZ.get(k) || [Infinity, -Infinity];
      (m.pts || [[m.x0, m.y0], [m.x1, m.y1]]).forEach(q => { r[0] = Math.min(r[0], uOf(q)); r[1] = Math.max(r[1], uOf(q)); });
      byZ.set(k, r);
    });
    const zs = [...byZ.keys()].map(Number).sort((a, c) => a - c);
    const rows = [], misses = [];
    zs.forEach(z => {
      const ours = strips.find(Ly => Math.abs(Ly.z1 - z) < 1e-3), bu = byZ.get(z.toFixed(2));
      if (z > top.z1 + 1e-6) { rows.push(`${f2(z)}: Bambu ${f2(bu[0])}-${f2(bu[1])}, ours none (past our top)`); return; }
      const ou = ours ? [Math.min(...ours.paths[0].map(uOf)), Math.max(...ours.paths[0].map(uOf))] : null;
      const ov = ou ? Math.min(ou[1] + W / 2, bu[1]) - Math.max(ou[0] - W / 2, bu[0]) : -Infinity;
      if (!(ov > 0)) misses.push(z);
      rows.push(`${f2(z)}: Bambu ${f2(bu[0])}-${f2(bu[1])}, ours ${ou ? f2(ou[0]) + '-' + f2(ou[1]) : 'none'}`);
    });
    console.log('        along the slope (y), interface centrelines, by layer top:\n          ' + rows.join('\n          '));
    check('every layer of Bambu\'s interface up to our top has a strip of ours at that z, over the same stretch of the curve',
      zs.length >= 10 && !misses.length, `${zs.length} Bambu interface layers, ${f2(zs[0])} - ${f2(zs[zs.length - 1])}` + (misses.length ? '; missed at ' + misses.map(f2).join(', ') : ''));
    check('...and ours starts where the card\'s 35 deg says the underside hangs (lower than Bambu\'s 30 deg threshold: 41.8)', strips[0].z1 <= zs[0] + 1e-6,
      `ours from ${f2(strips[0].z1)}`);
  }

  /* ------------------------------------------------------------------ 6 */
  console.log('\n=== 6. NSO\'s slice of the export ===');
  {
    const wasm = await SL.loadKernel({});
    const o = SL.defaultsFor(0.4);
    const objs = [{ name: NAME, soup: piece, key: 101, role: 'part' }]
      .concat(sup.map((s, i) => ({ name: s.name, soup: s.soup, key: 201 + i, role: 'support', hostKey: 101, detectThinWall: true })));
    const r = SL.sliceObjects(objs, o, wasm);
    check('the arc and its supports slice', r.ok && !r.conflicts.length, r.ok ? `${r.planes.length} layers` : r.reason);
    const p = G.parseGcode(r.gcode), by = {};
    const stairObj = 1 + sup.findIndex(s => SI.exactDistance(s.soup, soups[soups.length - 1], { reach: 0.01 }).mm < 1e-6);
    p.moves.forEach(m => { if (m.objectId === stairObj) { const l = by[m.layer] || (by[m.layer] = {}); l[m.feature] = (l[m.feature] || 0) + 1; } });
    const feats = new Set();
    Object.values(by).forEach(l => Object.keys(l).forEach(f => feats.add(f)));
    check('every line of the support is Support, Support transition or Support interface', [...feats].every(f => /^Support/.test(f)), [...feats].join(', '));
    const rows = [], plain = [];
    L.layers.forEach(Ly => {
      const k = r.planes.findIndex(pl => Math.abs(pl.printZ - Ly.z1) < 1e-3);
      const l = by[k] || {}, it = l['Support interface'] || 0, tr = l['Support transition'] || 0, su = l['Support'] || 0;
      rows.push(`${f2(Ly.z1)} ${Ly.role[0].toUpperCase()}: ${it ? 'interface ' + it : ''}${tr ? 'transition ' + tr : ''}${su ? ' Support ' + su : ''}`);
      if (!(it + tr) || su) plain.push(Ly.z1);
    });
    console.log('        moves by layer top:  ' + rows.join(' | '));
    check('every layer of the stair - its transition to its top - is typed Support interface or Support transition, none plain Support',
      !plain.length, plain.length ? 'plain at ' + plain.map(f2).join(', ') : `${L.layers.length} layers; interface on ${rows.filter(x => /interface/.test(x)).length}, transition on ${rows.filter(x => /transition/.test(x)).length}`);
  }

  /* ------------------------------------------------------------------ 7 */
  console.log('\n=== 7. flat ceilings unchanged ===');
  {
    const coupon = readSTL(path.join(ROOT, 'fixtures', 'supports', 'top_clip_x2_coupon.stl'));
    const c = await EXP.build(coupon);
    const got = {};
    c.objects.forEach(o => { got[o.name] = [sha(o.soup), o.soup.length / 9]; });
    check('the 2026-10-20 coupon as the card builds it is byte for byte the build before the stair',
      JSON.stringify(got) === JSON.stringify(COUPON_BEFORE), Object.keys(got).map(k => `${k}: ${got[k][0]} (${got[k][1]} tris)`).join('; '));
    check('...and no stair forms on it: its two ceilings are four-layer sheets', c.areas.every(a => a.tp.sheet && a.tp.sheet.levels.every(x => !x.stair && x.layers.length === 4)),
      c.areas.map(a => a.tp.sheet.reason).join(' / '));
  }

  /* ------------------------------------------------------------------ 8 */
  console.log('\n=== 8. the refusal, the card at 60 deg ===');
  {
    const run = await cardRun();
    const v = run.after, A = v.areas;
    const arcArea = A.reduce((best, a) => (!best || a.count > best.count ? a : best), null);
    check('the card builds at 60 deg, no page errors', v.state === 'built' && !run.errors.length, `${v.count || ''} ${run.errors.join('; ')}`.trim());
    check('the arc\'s area - its top included - reads held: every one of its spots held',
      arcArea && arcArea.kind === 'held' && arcArea.point[2] > 30, arcArea ? `area ${arcArea.id + 1}, ${arcArea.count} spots, its middle at z ${f2(arcArea.point[2])}` : 'none');
    const lostRows = v.rows.filter(r => r.kind === 'unreachable');
    const foot = lostRows.find(r => r.spots === 3);
    const footArea = foot ? A.find(a => a.id === foot.area) : null;
    check('the spots at the arc\'s foot the plate cannot reach are an area of their own, named for what they are',
      !!foot && foot.text === `Area ${foot.area + 1} · unreachable · no route to the plate · 3 spots` && footArea.point[2] < 25,
      foot ? `"${foot.text}", at z ${f2(footArea.point[2])}` : v.rows.map(r => r.text).join(' | '));
    check('...and before the build they were the arc\'s own: the split is what the build found, not what detection said',
      run.before.areas.length === A.length - 1, `${run.before.areas.length} areas before, ${A.length} after; rows: ${v.rows.map(r => r.text).join(' | ')}`);
  }

  /* ---------------------------------------------------------------- export */
  const file = path.join(OUT, NAME + '_supports.3mf');
  await EXP.write(file, b.objects);
  console.log('\n  wrote ' + path.relative(ROOT, file) + ` (${b.objects.length - 1} support object(s); open it in Bambu Studio as a PROJECT, its own supports off)`);

  console.log('\n' + (fail ? 'FAILED  ' : 'PASSED  ') + pass + ' of ' + (pass + fail) + (fail ? '\n  ' + FAILS.join('\n  ') : ''));
  process.exit(fail ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
