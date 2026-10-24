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
     (writes tools/supports-stair-out/simple_overhang_supports.3mf, the arc
      with its supports as the card exports it, to slice with Bambu's own
      supports off and print)

   1. THE STAIR. One stair under the arc; a strip on every layer from the
      first it holds to the top, each a layer over the one below; nothing
      above the top: the top strip within two layers of the highest point
      of the underside less the gap, and no strip past it.
   2. EACH STRIP, measured on the parts built (a cut at each layer's
      middle): ONE region; the sheet's lines (0.40 at 0.84) - two a loop
      alone, three or more a loop and one serpentine inside, tied at one
      point; at least the part's step over it (its section's up-slope edge
      at the layer over the strip and the next, along the strip, the median)
      and one line (0.42) wide (supports-stair-body); the part over it 0.18 -
      0.55 mm across its width wherever the support's own next layer is not
      over it, median 0.35 or less.
   3. THE GAP: the whole support (stair, caps, trees) against the arc with
      the exact triangle distance: 0.18 mm or more.
   4. WHAT HOLDS EACH STRIP: every strip whose leading part (not over the
      strip below by half a line or more) is half a line or wider has a tip
      under it every 5 mm or nearer along it, each one built - a column top
      found under the strip, at its underside - grown as a tree with the
      stair (its own trunks, merged); the stair's lean is never what holds
      it. The lowest strip stands on its transition, the transition on caps
      and tips. The plan's own tips on the curve are held by the stair and
      not built.
   5. AGAINST BAMBU: every layer of Bambu's interface up to our top has a
      strip of ours at that z, over the same stretch of the curve.
   6. NSO's SLICE of the export (the card's own slicer, detect_thin_wall on):
      every layer of the stair - its transition to its top - has its strip
      typed Support interface or Support transition; the support's lines
      are support lines only; NO STRIP SPAN over air LONGER THAN THE TIP
      PITCH (5 mm), as typeSupports reads a wall's overhang (the layer under,
      closed, grown half a line) - a strip spans between its tips; each
      strip as wide as the part's step and a line in the slice; the
      support's toolpath over the stair's start at most 1.5 x Bambu's there
      - the whole part's ratio and the tables by Bambu's layers and by
      height printed, a finding the trunk-thinning follow-up owns.
   7. FLAT CEILINGS UNCHANGED: the 2026-10-20 coupon (top_clip_x2_coupon.stl)
      as the card builds it is byte for byte the build before the stair
      (sha-256 of each object's soup, recorded at claude-wip 6f3354f at 60 deg
      and the same at a4ae142, the card's 35), and
      no stair forms on it. Built with trunkGrowth off: since supports-foot
      every trunk gets a round trunk and its pad grows with it, which
      support:foot holds - every part before, byte for byte, then the trunks
      and the pads.
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
const OUT = path.join(ROOT, 'tools', 'supports-stair-out');
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
/* the coupon as the card built it at claude-wip 6f3354f (60 deg) and a4ae142 (35), before the stair:
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
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function joinAll(list) {
  const n = list.reduce((a, x) => a + x.length, 0), out = new Float32Array(n);
  let w = 0;
  list.forEach(x => { out.set(x, w); w += x.length; });
  return out;
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
  const BEAD = TH.floorFor(0.4);
  const nStrip = L.layers.length;
  const secs = L.layers.map((Ly, i) => {
    const sec = loopsOf(sliceAt(soups[i], (Ly.z0 + Ly.z1) / 2)), reg = regionsOf(sec);
    const us = reg.length ? reg[0].map(uOf) : [0], vs = reg.length ? reg[0].map(vOf) : [0];
    /* its width across the slope, line by line along it (the front follows the curve): the median */
    const ws = [];
    if (reg.length) for (let v = Math.min(...vs) + 0.5; v <= Math.max(...vs) - 0.5; v += 0.25) {
      const cr = [];
      reg[0].forEach((a, k) => { const c = reg[0][(k + 1) % reg[0].length], va = vOf(a), vc = vOf(c);
        if ((va - v) * (vc - v) <= 0 && va !== vc) cr.push(uOf(a) + (uOf(c) - uOf(a)) * (v - va) / (vc - va)); });
      if (cr.length >= 2) ws.push(Math.max(...cr) - Math.min(...cr));
    }
    ws.sort((x, y) => x - y);
    return { Ly, sec, reg, u: [Math.min(...us), Math.max(...us)], v: [Math.min(...vs), Math.max(...vs)], w: ws.length ? ws[ws.length >> 1] : 0 };
  });
  const badReg = secs.filter(s => s.reg.length !== 1 || s.sec.open);
  check('every strip is ONE region, no chain left open', !badReg.length,
    badReg.length ? badReg.map(s => `z ${f2(s.Ly.z1)}: ${s.reg.length} regions, ${s.sec.open} open`).join('; ') : `${secs.length} layers`);
  /* the sheet contract: two lines a loop alone; three or more a loop, then one serpentine inside, tied to it at one point */
  const contract = [];
  strips.forEach(Ly => {
    const loop = Ly.paths[0], sn = Ly.paths[1] || null;
    const dLoop = q => Math.min(...loop.slice(1).map((a, k) => segDist(q, loop[k], a)));
    if (Ly.beads < 2) contract.push(`${f2(Ly.z1)}: ${Ly.beads} line(s)`);
    else if (Ly.beads === 2 && sn) contract.push(`${f2(Ly.z1)}: a serpentine in a two-line strip`);
    else if (Ly.beads >= 3 && (!sn || dLoop(sn[0]) > 1e-6 || sn.slice(2).some(q => dLoop(q) < Ly.pitchMm - 0.02))) contract.push(`${f2(Ly.z1)}: serpentine not tied at one point`);
    if (Ly.pitchMm < PITCH - 1e-9 || Math.abs(Ly.widthMm - ((Ly.beads - 1) * Ly.pitchMm + S.widthMm)) > 1e-6) contract.push(`${f2(Ly.z1)}: ${f2(Ly.widthMm)} mm for ${Ly.beads} lines`);
  });
  const nb = {};
  strips.forEach(x => { nb[x.beads] = (nb[x.beads] || 0) + 1; });
  const spread = strips.filter(x => x.pitchMm > PITCH + 1e-9);
  check(`each strip is the sheet's lines (${S.widthMm} at ${PITCH}): two a loop alone, three or more a loop and one serpentine inside it, tied at one point`,
    !contract.length && secs.every((s, i) => Math.abs(s.w - L.layers[i].widthMm) < 0.02),
    Object.keys(nb).map(k => `${k} lines x ${nb[k]}`).join(', ') + (spread.length ? `; spread to the outline at ${spread.map(x => `${f2(x.z1)} (${x.beads} lines at ${f2(x.pitchMm)})`).join(', ')}` : '') +
      (contract.length ? '; ' + contract.slice(0, 4).join('; ') : '') + secs.filter((s, i) => Math.abs(s.w - L.layers[i].widthMm) >= 0.02).slice(0, 3).map(s => `; ${f2(s.Ly.z1)}: ${f2(s.w)} across, built ${f2(s.Ly.widthMm)}`).join(''));
  check('...and as long as the arc is wide, near enough (Bambu\'s lines: 10.32 mm)', secs.every(s => s.v[1] - s.v[0] >= 8.0),
    `${f2(Math.min(...secs.map(s => s.v[1] - s.v[0])))} - ${f2(Math.max(...secs.map(s => s.v[1] - s.v[0])))} mm`);
  check('the transition is the lowest strip again, one layer under it', trans.length === 1 && Math.abs(trans[0].z1 - strips[0].z0) < 1e-6 &&
    Math.abs(secs[0].u[0] - secs[1].u[0]) < 1e-3 && Math.abs(secs[0].u[1] - secs[1].u[1]) < 1e-3, `${f2(trans[0].z0)} - ${f2(trans[0].z1)}`);
  /* THE PART'S STEP over each strip: its section's up-slope edge (the part's own slice, over the strip's stretch)
     at the layer over the strip and the next - the next layer's overhang advance */
  /* the part's section's up-slope edge along the line v (its last crossing of the section's outline) */
  const edgesAt = z => {
    const segs = sliceAt(piece, z);
    return v => {
      let e = null;
      segs.forEach(([a, c]) => {
        const va = vOf(a), vc = vOf(c);
        if ((va - v) * (vc - v) > 0 || va === vc) return;
        const t = (v - va) / (vc - va), u = uOf(a) + (uOf(c) - uOf(a)) * t;
        if (e == null || u > e) e = u;
      });
      return e;
    };
  };
  /* the step, every 0.25 mm along the strip: the median (the arc's engraved labels are steps of their own) */
  const stepOf = Ly => {
    const sv = secs[L.layers.indexOf(Ly)], e1 = edgesAt(Ly.z1 + LAYER + LAYER / 2), e0 = edgesAt(Ly.z1 + LAYER / 2), d = [];
    for (let v = sv.v[0] + 0.5; v <= sv.v[1] - 0.5; v += 0.25) { const a = e0(v), c = e1(v); if (a != null && c != null) d.push(Math.max(0, c - a)); }
    d.sort((x, y) => x - y);
    return d.length ? d[d.length >> 1] : 0;
  };
  const steps2 = strips.map(Ly => ({ z: Ly.z1, need: stepOf(Ly) + BEAD, w: secs[L.layers.indexOf(Ly)].w }));
  const narrow = steps2.filter(q => q.w < q.need - 1e-3);
  check('every strip is as wide as the part\'s step over it - the next layer\'s overhang advance - and one line (0.42) more, built',
    !narrow.length, `step + line ${f2(Math.min(...steps2.map(q => q.need)))} - ${f2(Math.max(...steps2.map(q => q.need)))} mm, strips ${f2(Math.min(...steps2.map(q => q.w)))} - ${f2(Math.max(...steps2.map(q => q.w)))}; least spare ${f3(Math.min(...steps2.map(q => q.w - q.need)))}` +
      (narrow.length ? '; narrow at ' + narrow.map(q => `${f2(q.z)} (${f2(q.w)} < ${f2(q.need)})`).join(', ') : ''));
  /* THE GAP UNDER EACH STRIP: across its width (every 0.1 mm across, 0.25 along), the part over it - where
     the support's own next layer is not (under the next strip or the body, the part is not what is over it) */
  const footAt = z => regionsOf(loopsOf(sliceAt(joinAll(soups), z)));
  const dists = [], all = [], worst = [];
  let covered = 0;
  strips.forEach((Ly, si) => {
    const sv = secs[L.layers.indexOf(Ly)], nxt = footAt(Ly.z1 + LAYER / 2), mine = [];
    const u0 = sv.u[0], u1 = sv.u[1];
    for (let v = sv.v[0] + 0.25; v <= sv.v[1] - 0.25; v += 0.25) for (let u = u0 + 0.02; u <= u1 - 0.02 + 1e-9; u += 0.1) {
      const x = u * nrm[0] + v * dir[0], y = u * nrm[1] + v * dir[1];
      if (!sv.reg.some(R => inPoly([x, y], R))) continue;
      const h = P.hitsAlong([x, y, Ly.z1], [0, 0, 1], 5);
      if (!h.length) continue;
      all.push(h[0]);
      if (nxt.some(R => inPoly([x, y], R))) { covered++; continue; }
      mine.push(h[0]);
    }
    dists.push(...mine);
    if (mine.length) worst.push({ z: Ly.z1, lo: Math.min(...mine), hi: Math.max(...mine) });
  });
  dists.sort((x, y) => x - y); all.sort((x, y) => x - y);
  const med = dists[dists.length >> 1], out = worst.filter(w2 => w2.lo < GAP - 0.005 || w2.hi > 0.55 + 1e-3);
  check('the part over every strip lies 0.18 - 0.55 mm over it across its width, median 0.35 or less (where the next layer\'s support is not over it)',
    !out.length && med <= 0.35 && worst.length === strips.length, `${f3(dists[0])} - ${f3(dists[dists.length - 1])} mm over ${dists.length} points, median ${f3(med)}; ` +
      `${covered} more under the next layer (the strip's whole width, part over it: ${f3(all[0])} - ${f3(all[all.length - 1])}, median ${f3(all[all.length >> 1])})` +
      (out.length ? '; out at ' + out.map(w2 => `${f2(w2.z)} (${f2(w2.lo)}-${f2(w2.hi)})`).join(', ') : ''));
  const rests = strips.slice(1).map(x => x.overlapMm || 0);
  console.log(`        each strip over the one below: ${f2(Math.min(...rests))} - ${f2(Math.max(...rests))} mm along the slope (median ${f2(rests.slice().sort((x, y) => x - y)[rests.length >> 1])}); the rest of it its tips hold`);

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
  console.log('\n=== 4. what holds each strip ===');
  {
    const want = L.stair.tips, tree = (S.stairTrees || []).find(t => t.level === L.id) || {};
    const per = {};
    want.forEach(w => { per[w.strip] = (per[w.strip] || 0) + 1; });
    const lacking = [];
    L.layers.forEach((Ly, i) => {
      if (Ly.role !== 'interface') return;
      const len = secs[i].v[1] - secs[i].v[0], need = Math.ceil(len / 5 - 1e-9);
      const lead = i === 1 ? Infinity : Ly.widthMm - (Ly.overlapMm || 0);
      if (lead >= S.widthMm / 2 && (per[i - 1] || 0) < need && !(i === 1 && L.caps.length)) lacking.push(f2(Ly.z1));
    });
    check('every strip whose leading part is half a line or wider has a tip every 5 mm or nearer along it - the stair\'s lean holds nothing',
      !lacking.length, `${want.length} tips for ${strips.length} strips (${Math.min(...Object.values(per))} - ${Math.max(...Object.values(per))} a strip)` + (lacking.length ? '; short at ' + lacking.join(', ') : ''));
    /* each one built: a column top under the strip, found in the parts at its underside */
    const treeSoups = arc.tp.trunks.filter(t => t.sheet == null && t.trunk >= arc.p.trunks.length).map(t => t.parts.map(q => q.soup));
    const flat = [].concat(...treeSoups);
    let found = 0;
    want.forEach(w => {
      const z = w.p[2] - 0.05;
      if (flat.some(sp => loopsOf(sliceAt(sp, z)).polys.some(Pl => inPoly([w.p[0], w.p[1]], Pl)))) found++;
    });
    check('...each one built: a column top under the strip\'s underside, as planned', found === want.length && tree.unreachable === 0,
      `${found} of ${want.length} found; the stair's tree: ${tree.trunks} trunk(s), ${tree.members} members, ${tree.unreachable} unreachable`);
    check('...grown as a tree with the stair, not a strut a tip: its tips merge on the way down', tree.trunks >= 1 && tree.trunks <= Math.ceil(want.length / 8),
      `${want.length} tips onto ${tree.trunks} trunk(s) to the plate`);
    const tips = S.tips, held = tips.filter(t => t.mode === 'drop'), carriers = tips.filter(t => t.mode === 'sheet' && t.level === L.id);
    check('the lowest strip stands on its transition, the transition on caps over the plan\'s tips under it (and tips of its own)',
      carriers.length >= 1 && L.caps.length >= 1, `${carriers.length} carrier(s), caps ${L.caps.map(c => f2(c.w)).join(' / ')} mm at z_cap ${f2(L.zCap)}; ${per[0] || 0} tip(s) of its own`);
    check('the plan\'s other tips on the curve are held by the stair, not built', held.length >= 20 && carriers.length + held.length === arc.n,
      `${held.length} held, ${tips.filter(t => t.mode === 'gap').length} cut at the gap`);
    check('...and the stair is one support with its trees (the spots it holds are its)', arc.sh.solids.filter(x => x.sheets.length).length === 1 &&
      arc.sh.solids.find(x => x.sheets.length).beacons.length === arc.n, `${arc.sh.solids.length} solid(s); it holds ${arc.sh.solids.find(x => x.sheets.length).beacons.length} of ${arc.n} spots`);
  }

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
      const ov = ou ? Math.min(ou[1] + ours.widthMm / 2, bu[1]) - Math.max(ou[0] - ours.widthMm / 2, bu[0]) : -Infinity;
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
      if (!(it + tr)) plain.push(Ly.z1);
    });
    console.log('        moves by layer top:  ' + rows.join(' | '));
    check('every layer of the stair - its transition to its top - has its strip typed Support interface or Support transition (the tree\'s columns beside it are Support)',
      !plain.length, plain.length ? 'plain at ' + plain.map(f2).join(', ') : `${L.layers.length} layers; interface on ${rows.filter(x => /interface/.test(x)).length}, transition on ${rows.filter(x => /transition/.test(x)).length}`);
    /* each strip's own lines in the slice: the paths of the stair's object at the strip's layer that lie on its
       built outline (its loop, half a line and a hair either side) */
    const SO = r.objects[stairObj], ty = SO.support;
    const stripPaths = Ly => {
      const k = r.planes.findIndex(pl => Math.abs(pl.printZ - Ly.z1) < 1e-3), lay = SO.layers[k], loop = Ly.paths[0];
      const onIt = q => inPoly(q, loop) || Math.min(...loop.slice(1).map((a, j) => segDist(q, loop[j], a))) <= S.widthMm / 2 + 0.06;
      return (lay ? lay.paths : []).filter(pa => pa.pts.every(onIt));
    };
    const sp = strips.map(Ly => ({ Ly, paths: stripPaths(Ly) }));
    /* a strip spans between the tips that hold it (round 3 printed that): no span of a strip's line over air
       longer than the tip pitch (STAIR.tipMm, Bambu's branch distance) */
    const PITCH_T = SI.STAIR.tipMm, nPaths = sp.reduce((a, x) => a + x.paths.length, 0);
    const spans = [].concat(...sp.map(x => [].concat(...x.paths.map(pa => (pa.overhangRuns || []).map(l => ({ z: x.Ly.z1, l }))))));
    const long = spans.filter(q => q.l > PITCH_T + 1e-6);
    check(`NO STRIP SPAN LONGER THAN THE TIP PITCH: a strip's line over air (typeSupports' overhang: the layer under, closed, grown half a line) runs ${PITCH_T} mm or less between what holds it`,
      !long.length && sp.every(x => x.paths.length >= 1),
      `${nPaths} strip paths on ${strips.length} strips, ${spans.length} spans over air, longest ${f2(Math.max(0, ...spans.map(q => q.l)))} mm` +
      (long.length ? '; longer at ' + long.map(q => `${f2(q.z)} (${f2(q.l)} mm)`).join(', ') : '') +
      `; the support's lines over air: ${Object.keys(ty.overhangPaths).map(k => `${k} ${ty.overhangPaths[k]} (${ty.overhangMm[k].toFixed(1)} mm)`).join(', ')}`);
    /* each strip, in the slice, against the part's step over it: the extent across the slope of the points of the
       layer's lines that lie on the strip (a tip's column top beside it joins the strip's island in the slice) */
    const onStrip = Ly => {
      const k = r.planes.findIndex(pl => Math.abs(pl.printZ - Ly.z1) < 1e-3), lay = SO.layers[k], loop = Ly.paths[0];
      const onIt = q => inPoly(q, loop) || Math.min(...loop.slice(1).map((a, j) => segDist(q, loop[j], a))) <= S.widthMm / 2 + 0.06;
      return [].concat(...(lay ? lay.paths : []).map(pa => pa.pts.filter(onIt)));
    };
    const thin = sp.map(x => {
      const us = onStrip(x.Ly).map(uOf);
      return { z: x.Ly.z1, w: us.length ? Math.max(...us) - Math.min(...us) + BEAD : 0, need: stepOf(x.Ly) + BEAD };
    });
    const nar = thin.filter(q => q.w < q.need - 1e-3);
    check('...and as wide as the part\'s step over it and one line, in the slice (its lines\' extent across the slope and a line)',
      !nar.length, `least spare ${f3(Math.min(...thin.map(q => q.w - q.need)))} mm` + (nar.length ? '; narrow at ' + nar.map(q => `${f2(q.z)} (${f2(q.w)} < ${f2(q.need)})`).join(', ') : ''));
    /* THE MATERIAL: the support's printed toolpath, layer by layer, NSO's slice of the export against Bambu's
       G-code (every Support feature), and in all */
    const bex = AUD.extrusions(new TextDecoder().decode(await R3.openZip(new Uint8Array(fs.readFileSync(BAMBU))).read('Metadata/plate_1.gcode')))
      .filter(m => /^Support/.test(m.feat || ''));
    const ours = new Map(), theirs = new Map();
    p.moves.forEach(m => { if (m.objectId >= 1 && m.e > 0) { const k = r.planes[m.layer].printZ.toFixed(2); ours.set(k, (ours.get(k) || 0) + m.length); } });
    bex.forEach(m => { const k = m.z.toFixed(2); theirs.set(k, (theirs.get(k) || 0) + m.len); });
    /* layer by layer, Bambu's: Bambu lays 0.27 mm layers low down and 0.2 up top, so each of its layers is set
       against ours over the same height (ours whose tops lie over its last layer's top, to its own) */
    const bz = [...theirs.keys()].map(Number).sort((a, c) => a - c), oz = [...ours.keys()].map(Number).sort((a, c) => a - c);
    const tO = [...ours.values()].reduce((a, c) => a + c, 0), tB = [...theirs.values()].reduce((a, c) => a + c, 0);
    const rowsM = bz.map((z, i) => {
      const lo = i ? bz[i - 1] : -Infinity, hi = i === bz.length - 1 ? Infinity : z;
      return { z, b: theirs.get(z.toFixed(2)), o: oz.filter(q => q > lo + 1e-6 && q <= hi + 1e-6).reduce((a, q) => a + ours.get(q.toFixed(2)), 0) };
    });
    console.log(`        support toolpath a layer, mm, Bambu's layers (z: ours / Bambu; ours summed over the same height):`);
    for (let i = 0; i < rowsM.length; i += 6) console.log('          ' + rowsM.slice(i, i + 6).map(q => `${q.z.toFixed(2).padStart(5)}: ${q.o.toFixed(0).padStart(4)} / ${q.b.toFixed(0).padStart(4)}`).join('   '));
    const bands = [[0, 1], [1, 5], [5, 10], [10, 20], [20, 30], [30, 37], [37, 40], [40, 42], [42, 44], [44, 47]];
    console.log('        by height, m (ours / Bambu):  ' + bands.map(([a, c]) => {
      const x = oz.filter(q => q > a && q <= c).reduce((s2, q) => s2 + ours.get(q.toFixed(2)), 0), y = bz.filter(q => q > a && q <= c).reduce((s2, q) => s2 + theirs.get(q.toFixed(2)), 0);
      return `${a}-${c}: ${(x / 1000).toFixed(2)} / ${(y / 1000).toFixed(2)}`;
    }).join(' | '));
    /* THE GATE covers the stair's zone, every layer whose top lies over the stair's start (its lowest strip's
       top). Under it stand the trunks (#274) and their pad: the whole part's ratio is a FINDING, printed, not
       gated - the trunk-thinning follow-up (docs/SUPPORT-INTERFACE.md section 6: hollow or thin the trunks,
       Bambu's being loops round air) owns it. */
    const z0m = strips[0].z1;
    const bO = oz.filter(q => q > z0m + 1e-6).reduce((a, q) => a + ours.get(q.toFixed(2)), 0);
    const bB = bz.filter(q => q > z0m + 1e-6).reduce((a, q) => a + theirs.get(q.toFixed(2)), 0);
    console.log(`        finding, not a gate (owner: the trunk-thinning follow-up): the whole part, ours ${(tO / 1000).toFixed(2)} m, ` +
      `Bambu's ${(tB / 1000).toFixed(2)} m: ${(tO / tB).toFixed(2)} x`);
    check(`SUPPORT MATERIAL over the stair's start (z ${f2(z0m)}) at most 1.5 x Bambu's there (toolpath, NSO's slice against the fixture's G-code)`,
      bO <= 1.5 * bB, `ours ${(bO / 1000).toFixed(2)} m, Bambu's ${(bB / 1000).toFixed(2)} m: ${(bO / bB).toFixed(2)} x`);
  }

  /* ------------------------------------------------------------------ 7 */
  console.log('\n=== 7. flat ceilings unchanged ===');
  {
    const coupon = readSTL(path.join(ROOT, 'fixtures', 'supports', 'top_clip_x2_coupon.stl'));
    const c = await EXP.build(coupon, { trunkGrowth: false });
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
  {
    /* written through the Bambu project envelope (docs/BAMBU-PROJECT-EXPORT.md): Studio opens it as a project */
    const zip = R3.openZip(new Uint8Array(fs.readFileSync(file))), dec = new TextDecoder();
    const model = dec.decode(await zip.read('3D/3dmodel.model'));
    const ms = zip.names().includes('Metadata/model_settings.config') ? dec.decode(await zip.read('Metadata/model_settings.config')) : '';
    const meshes = zip.names().filter(n => /^3D\/Objects\/object_\d+\.model$/.test(n)).length;
    const tw = (ms.match(/key="detect_thin_wall" value="1"/g) || []).length;
    check('the export is a Bambu project: Studio\'s envelope, a mesh part an object, each support with its thin-wall overrides',
      /<metadata name="Application">BambuStudio-[\d.]+<\/metadata>/.test(model) && meshes === b.objects.length && tw === b.objects.length - 1,
      `${(model.match(/BambuStudio-[\d.]+/) || ['no Studio tag'])[0]}; ${meshes} object parts; detect_thin_wall on ${tw} of ${b.objects.length - 1} support(s)`);
  }
  console.log('\n  wrote ' + path.relative(ROOT, file) + ` (${b.objects.length - 1} support object(s); open it in Bambu Studio as a PROJECT, its own supports off)`);

  console.log('\n' + (fail ? 'FAILED  ' : 'PASSED  ') + pass + ' of ' + (pass + fail) + (fail ? '\n  ' + FAILS.join('\n  ') : ''));
  process.exit(fail ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
