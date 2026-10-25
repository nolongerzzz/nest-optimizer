#!/usr/bin/env node
// The planner fed the user's points (nso_support_gridpack.js opts.feed, and
// the members a build answers with). docs/SUPPORT-GRIDPACK.md "Feed".
//
//   node tools/nso_support_feed_check.js        exit 0 = every gate held
//
// Loads the card's build worker's own files (app-supports-card.js ENGINE)
// with vm and builds as the card does: parts({ interface: true, foldSheets:
// false }), then shells().
//
//   1. no inputs: a feed that asks for nothing ({}, { mode: 'auto' },
//      { mode: 'auto', excluded: [] }) builds the coupon's bytes with no feed
//   2. custom, one tip on the clamp: one tree, the tip cut at the gap, its
//      foot on the plate; two tips a beacon pitch apart: one sheet across them
//   3. assisted, every other beacon off on the coupon: no tip at an off
//      beacon; every tip that stayed on is where the auto build has it
//   4. landing zones (the shelf): every trunk's centre inside a zone (its pad
//      and flare may spill past the line); a zone out of reach reported empty,
//      nothing forced into it; no tip dropped - one no circle reaches is built
//      and marked (plan.overLean, plan.suggested)
//   4b. the stair (the arc): its own trunks have member ids; every tip it
//      holds is carried by one of them
//   5. excluded trunk (the coupon): the rebuild has no member with its id; its
//      tips are carried by other trunks or reported unsupported; an excluded
//      tip is not supported and not reported unsupported
//   6. members: the same ids, in the same order, from two builds of the same
//      inputs; every held tip in exactly one trunk's carries
//   7. crowns (supports-thinning-1): one trunk to a circle; the 6-tip tree is
//      1 > 3 > 6; an over-lean tip is built, marked, and given a spot inside the
//      limit; an oval trunk carries a row of tips; every join inside Bambu's
//      measured range (tools/nso_support_bambu_joins.js); the trunk at least
//      Bambu's law at every height; one connected tree per circle; the trees
//      for 1, 2, 3, 6, 12 tips and the arc's are printed

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const { readSTL } = require('./nso_stl_io.js');

const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Promise, Date,
  Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, Uint16Array, Int8Array, ArrayBuffer
};
vm.createContext(ctx);
/* the card's build worker's own list (app-supports-card.js ENGINE) */
for (const f of ['nso_thickness.js', 'nso_support_beacons.js', 'nso_support_aim.js', 'nso_path_sweep.js',
                 'nso_support_tree.js', 'nso_support_gridpack.js', 'nso_raster_lines.js', 'nso_crosshatch.js',
                 'nso_support_interface.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const GP = ctx.NSO_SupportGridpack, SI = ctx.NSO_SupportInterface;
const GAP = SI.DEFAULTS.gapMm;
const CARD = { skipList: [], angleDeg: 35, occluders: [], style: 'tree', restOnModel: false, sideMm: 1.2 };
const PARTS = { interface: true, foldSheets: false };

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const f3 = v => (+v).toFixed(3);

function box(lo, hi) {
  const v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
             [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const out = [];
  for (const t of f) for (const i of t) out.push(...v[i]);
  return out;
}
/* clamp_body standing on its 94 mm axis, as support:interface reads it */
function standing(soup) {
  const r = new Float32Array(soup.length);
  for (let i = 0; i < soup.length; i += 3) { r[i] = soup[i]; r[i + 1] = -soup[i + 2]; r[i + 2] = soup[i + 1]; }
  let mz = Infinity;
  for (let i = 2; i < r.length; i += 3) mz = Math.min(mz, r[i]);
  for (let i = 2; i < r.length; i += 3) r[i] -= mz;
  return r;
}
const COUPON = readSTL(path.join(ROOT, 'fixtures', 'supports', 'top_clip_x2_coupon.stl'));
const CLAMP = standing(readSTL(path.join(ROOT, 'fixtures', 'supports', 'clamp_body.stl')));
const SHELF = new Float32Array([].concat(box([0, 0, 0], [10, 10, 20]), box([10, 0, 16], [22, 10, 20])));

const sha = soup => crypto.createHash('sha256').update(Buffer.from(soup.buffer, soup.byteOffset, soup.byteLength)).digest('hex').slice(0, 16);
async function build(piece, feed, extra) {
  const opts = Object.assign({}, CARD, extra || {});
  if (feed !== undefined) opts.feed = feed;
  const p = GP.plan(piece, opts);
  if (!p.ok) return { p, ok: false, reason: p.reason };
  const tp = await GP.parts(p, PARTS);
  if (!tp.ok) return { p, ok: false, reason: tp.reason };
  const sh = GP.shells(p, tp);
  return { p, tp, sh, ok: sh.ok, reason: sh.reason };
}
const byKind = (sh, k) => sh.members.filter(m => m.kind === k);
/* every held tip in exactly one trunk's carries: { ok, held, twice } */
function oneTrunkEach(sh) {
  const n = {};
  byKind(sh, 'trunk').forEach(t => t.carries.forEach(id => { n[id] = (n[id] || 0) + 1; }));
  const tips = byKind(sh, 'tip').map(t => t.id);
  const twice = Object.keys(n).filter(id => n[id] !== 1);
  const orphan = tips.filter(id => n[id] !== 1);
  const unheldTip = Object.keys(n).filter(id => tips.indexOf(id) < 0);
  const both = sh.unsupported.filter(id => n[id]);
  return { ok: !twice.length && !orphan.length && !unheldTip.length && !both.length, held: Object.keys(n).length, twice, orphan, unheldTip, both };
}

(async () => {
  /* ---- 1. no inputs ---- */
  console.log('\n=== 1. no inputs: today\'s build ===');
  const base = await build(COUPON);
  check('coupon: builds with no feed', base.ok, base.reason);
  const baseHash = sha(base.sh.soup);
  for (const feed of [{}, { mode: 'auto' }, { mode: 'auto', excluded: [] }, null]) {
    const b = await build(COUPON, feed);
    check('coupon: feed ' + JSON.stringify(feed) + ' builds the same bytes as no feed',
      b.ok && sha(b.sh.soup) === baseHash && b.sh.solids.length === base.sh.solids.length,
      b.ok ? sha(b.sh.soup) + ' vs ' + baseHash : b.reason);
  }

  /* ---- 2. custom on the clamp ---- */
  console.log('\n=== 2. custom: the clamp ===');
  const g = GP.gridBeacons(CLAMP, CARD);
  /* a flat ceiling's beacon (the area 1 ceiling at z 80), and its neighbour a pitch along x */
  const flat = g.beacons.filter(b => b.regionId === 1 && b.n[2] < -0.99);
  let pair = null;
  for (const a of flat) {
    const b = flat.find(c => Math.abs(c.p[0] - a.p[0] - g.pitchMm) < 1e-6 && Math.abs(c.p[1] - a.p[1]) < 1e-6 && Math.abs(c.p[2] - a.p[2]) < 1e-3);
    if (b) { pair = [a, b]; break; }
  }
  const tipAt = b => ({ x: b.p[0], y: b.p[1], z: b.p[2] });
  const one = await build(CLAMP, { mode: 'custom', tips: [tipAt(pair[0])] });
  if (!one.ok) check('clamp, one tip: builds', false, one.reason);
  else {
    const p = one.p, root = p.members[p.trunks[0].root], end = root.path[root.path.length - 1];
    const tipLog = one.tp.sheet.tips[0], d = SI.exactDistance(one.sh.soup, CLAMP, { reach: 1 }).mm;
    check('clamp, one custom tip: one tree, holding it', p.trunks.length === 1 && one.sh.solids.length === 1 && p.held === 1 && !p.detect.beacons,
      `${p.trunks.length} trunk(s), ${one.sh.solids.length} solid(s), held ${p.held}; tip ${JSON.stringify(tipAt(pair[0]))}`);
    check(`clamp, one custom tip: the tip at the gap - cut at the gap line, the support ${GAP} mm (+0.02) off the piece`,
      tipLog.mode === 'gap' && d >= GAP - 1e-4 && d <= GAP + 0.02, `${tipLog.mode} (${tipLog.why}); nearest ${f3(d)} mm`);
    check('clamp, one custom tip: its foot on the plate', root.end === 'plate' && Math.abs(end[2] - p.plateZ) < 1e-9 && one.tp.feet.length === 1,
      `end ${end.map(f3).join(', ')}, plate ${p.plateZ}; ${one.tp.feet.length} foot`);
  }
  const two = await build(CLAMP, { mode: 'custom', tips: pair.map(tipAt) });
  if (!two.ok) check('clamp, two tips: builds', false, two.reason);
  else {
    const L = two.tp.sheet.levels;
    check(`clamp, two custom tips ${g.pitchMm} mm apart (the beacon pitch): one sheet across them`,
      L.length === 1 && L[0].tips.length === 2 && byKind(two.sh, 'sheet').length === 1 && byKind(two.sh, 'sheet')[0].carries.length === 2,
      `${L.length} level(s): ${L.map(x => x.tips.length + ' tips at ' + f3(x.zTop)).join('; ')}; modes ${two.tp.sheet.tips.map(t => t.mode).join(', ')}`);
  }

  /* ---- 3. assisted on the coupon ---- */
  console.log('\n=== 3. assisted: the coupon, every other beacon off ===');
  const gc = GP.gridBeacons(COUPON, CARD);
  const ids = gc.beacons.map(b => GP.tipId(b.p));
  const off = ids.filter((id, i) => i % 2 === 1), on = ids.filter((id, i) => i % 2 === 0);
  const half = await build(COUPON, { mode: 'assisted', beaconsOff: off });
  if (!half.ok) check('coupon, half off: builds', false, half.reason);
  else {
    const tipsHalf = byKind(half.sh, 'tip'), at = {};
    tipsHalf.forEach(t => { at[t.id] = t; });
    const offPts = gc.beacons.filter((b, i) => i % 2 === 1).map(b => b.p);
    const nearOff = half.p.stations.filter(s => offPts.some(q => Math.hypot(q[0] - s.contact[0], q[1] - s.contact[1], q[2] - s.contact[2]) < 1e-6));
    check('coupon, half the beacons off: the tree has no tip at an off beacon',
      off.every(id => !at[id]) && !nearOff.length && half.p.feed.off.length === off.length && half.p.beacons.length === on.length,
      `${off.length} off, ${on.length} on; ${tipsHalf.length} tips built, ${nearOff.length} at an off beacon`);
    const baseTips = {};
    byKind(base.sh, 'tip').forEach(t => { baseTips[t.id] = t; });
    const moved = tipsHalf.filter(t => !baseTips[t.id] || JSON.stringify(baseTips[t.id].from) !== JSON.stringify(t.from));
    check('coupon, half off: every tip that stayed on is where the auto build has it (its contact, to the bit)',
      tipsHalf.length > 0 && !moved.length && on.filter(id => baseTips[id]).every(id => at[id] || half.sh.unsupported.indexOf(id) >= 0),
      `${tipsHalf.length - moved.length} of ${tipsHalf.length} identical` + (moved.length ? '; moved: ' + moved.slice(0, 3).map(t => t.id).join(' ') : ''));
  }

  /* ---- 4. landing zones ---- */
  console.log('\n=== 4. landing zones: the shelf ===');
  const shelfTips = [[13, 3, 16], [13, 7, 16], [17, 3, 16], [17, 7, 16], [21, 5, 16]].map(q => ({ x: q[0], y: q[1], z: q[2] }));
  const ZA = { x: 27, y: 5, r: 4 }, ZB = { x: 120, y: 120, r: 5 };
  const free = await build(SHELF, { mode: 'custom', tips: shelfTips });
  const zoned = await build(SHELF, { mode: 'custom', tips: shelfTips, landingZones: [ZA, ZB] });
  if (!zoned.ok || !free.ok) check('shelf with zones: builds', false, (zoned.reason || '') + ' ' + (free.reason || ''));
  else {
    /* a trunk is in a zone when its CENTRE is inside the circle; its pad and
       its flared trunk may spill past the line (reported, not held) */
    const p = zoned.p;
    const feet = p.trunks.filter(t => t.landing === 'plate').map(t => { const m = p.members[t.root]; return { e: m.path[m.path.length - 1] }; });
    const inside = f => Math.hypot(f.e[0] - ZA.x, f.e[1] - ZA.y) <= ZA.r + 1e-6 || Math.hypot(f.e[0] - ZB.x, f.e[1] - ZB.y) <= ZB.r + 1e-6;
    const freeOut = free.p.trunks.filter(t => { const m = free.p.members[t.root]; return !inside({ e: m.path[m.path.length - 1] }); }).length;
    const builtFeet = zoned.tp.feet.every(f => Math.hypot(f.c[0] - ZA.x, f.c[1] - ZA.y) <= ZA.r + 1e-6);
    const spill = Math.max(0, ...zoned.tp.feet.map(f => Math.hypot(f.c[0] - ZA.x, f.c[1] - ZA.y) + f.r - ZA.r));
    check('shelf: every trunk\'s centre inside a landing zone - where, with no zone, they stand outside it',
      feet.length > 0 && feet.every(inside) && builtFeet && freeOut > 0 && p.held > 0,
      `${feet.length} trunk(s), held ${p.held} of ${shelfTips.length}; centres ${feet.map(f => f.e.slice(0, 2).map(f3).join(',')).join(' | ')}; ` +
      `the widest foot spills ${f3(spill)} mm past the line (allowed); with no zone ${freeOut} of ${free.p.trunks.length} stand outside it`);
    check('shelf: the zone out of reach is reported empty, nothing forced into it; no tip is dropped - none unreachable, none off every zone, every one held',
      p.zonesEmpty.length === 1 && p.zonesEmpty[0] === 1 && p.zones[1].trunks.length === 0 && p.zones[0].trunks.length === feet.length &&
      p.offZone.length === 0 && p.unreachable.length === 0 && p.unmerged.length === 0 && p.held === shelfTips.length && zoned.sh.unsupported.length === 0,
      `zones ${p.zones.map((z, i) => i + ': ' + z.trunks.length + ' trunk(s)').join(', ')}; empty ${JSON.stringify(p.zonesEmpty)}; held ${p.held} of ${shelfTips.length}; ${p.reason}`);
    /* a tip no circle reaches within the lean is built, marked, and given a spot on the plate inside the limit */
    const tanL = Math.tan(p.branchTiltDeg * Math.PI / 180), byId = {};
    zoned.sh.members.forEach(m => { byId[m.id] = m; });
    const spotsOk = p.suggested.length > 0 && p.suggested.every(sg => {
      const m = byId[sg.forMember];
      return m && Math.hypot(sg.x - m.from[0], sg.y - m.from[1]) <= (m.from[2] - p.plateZ) * tanL + 1e-6 && sg.leanDeg <= p.branchTiltDeg + 1e-6;
    });
    check('shelf: a tip no circle reaches within the lean is built and listed in plan.overLean; each has a suggested spot on the plate whose drop sits inside the lean limit',
      p.overLean.length > 0 && p.suggested.length === p.overLean.length && p.overLean.every(o => byId[o.member] && o.leanDeg > p.branchTiltDeg) && spotsOk,
      `${p.overLean.length} over the ${p.branchTiltDeg} deg limit (worst ${f3(Math.max(...p.overLean.map(o => o.leanDeg)))}); spots ${p.suggested.slice(0, 2).map(sg => `(${f3(sg.x)}, ${f3(sg.y)}) at ${f3(sg.leanDeg)} deg`).join('; ')}`);
    /* every tip is built alone as well - no zone rule drops one */
    const alone = [];
    for (const t of shelfTips) {
      const a1 = GP.plan(SHELF, Object.assign({}, CARD, { feed: { mode: 'custom', tips: [t], landingZones: [ZA, ZB] } }));
      alone.push(a1.ok && a1.held === 1 && a1.trunks.length === 1);
    }
    check('shelf: every tip, alone with the circles, is built', alone.every(x => x), `${alone.filter(x => x).length} of ${shelfTips.length}`);
  }

  /* ---- 4b. the stair: its own trunks named, the tips it holds carried by them ---- */
  console.log('\n=== 4b. the stair: the arc ===');
  const R3 = require(path.join(ROOT, 'nso-3mf-read.js'));
  const ARC = new Float32Array((await R3.parse3MF(new Uint8Array(fs.readFileSync(path.join(ROOT, 'fixtures', 'supports', 'simple_overhang.3mf'))), { name: 'simple_overhang.3mf' })).objects[0].positions);
  const arc = await build(ARC);
  if (!arc.ok) check('arc: builds', false, arc.reason);
  else {
    const st = arc.tp.stairTrunks || [], held = arc.tp.sheet.tips.filter(t => t.mode === 'drop');
    const nT = arc.p.trunks.length, stairIds = st.map((x, k) => arc.sh.solids.flatMap(sd => sd.feet).find(f => f.member && byKind(arc.sh, 'trunk').some(m => m.id === f.member && m.from.join() === x.path[0].join())));
    const stairMembers = byKind(arc.sh, 'trunk').filter(m => st.some(x => x.path[0].join() === m.from.join() && x.path[x.path.length - 1].join() === m.to.join()));
    const byStair = new Set(stairMembers.flatMap(m => m.carries));
    const heldIds = held.map(t => GP.tipId(arc.p.beacons[t.beacon].p));
    check('arc: the stair\'s own trunks have member ids, and every tip the stair holds is carried by one of them',
      st.length > 0 && stairMembers.length === st.length && heldIds.length > 0 && heldIds.every(id => byStair.has(id)) &&
      stairIds.every(Boolean) && heldIds.every(id => byKind(arc.sh, 'tip').some(t => t.id === id)),
      `${st.length} stair trunk(s) (${stairMembers.map(m => m.id + ': ' + m.carries.length).join(', ')}), ${heldIds.length} tips held by the stair; plan trunks ${nT}, built ${byKind(arc.sh, 'trunk').length - st.length}`);
  }

  /* ---- 5. excluded ---- */
  console.log('\n=== 5. excluded: the coupon ===');
  const trunks0 = byKind(base.sh, 'trunk');
  const victim = trunks0.slice().sort((a, b) => (b.carries.length - a.carries.length) || (a.id < b.id ? -1 : 1))[0];
  const tipGone = byKind(base.sh, 'tip').find(t => victim.carries.indexOf(t.id) < 0).id;
  const ex = await build(COUPON, { mode: 'auto', excluded: [victim.id, tipGone] });
  if (!ex.ok) check('coupon, a trunk excluded: builds', false, ex.reason);
  else {
    const has = {};
    ex.sh.members.forEach(m => { has[m.id] = m; });
    const carriedBy = {};
    byKind(ex.sh, 'trunk').forEach(t => t.carries.forEach(id => { carriedBy[id] = t.id; }));
    const lost = victim.carries.filter(id => !carriedBy[id] && ex.sh.unsupported.indexOf(id) < 0);
    check('coupon: a trunk excluded - the rebuild has no member with its id; its tips carried by other members or reported unsupported',
      !has[victim.id] && !lost.length && victim.carries.every(id => carriedBy[id] !== victim.id) &&
      ex.p.excluded.members.length === 1 && ex.p.excluded.members[0] === victim.id,
      `trunk ${victim.id} carried ${victim.carries.length}: now ${victim.carries.filter(id => carriedBy[id]).length} carried by ` +
      `${new Set(victim.carries.map(id => carriedBy[id]).filter(Boolean)).size} other trunk(s), ` +
      `${victim.carries.filter(id => ex.sh.unsupported.indexOf(id) >= 0).length} unsupported; ${ex.p.reason}`);
    check('coupon: a tip excluded - not supported, not reported unsupported (\'don\'t support here\')',
      !has[tipGone] && !carriedBy[tipGone] && ex.sh.unsupported.indexOf(tipGone) < 0 && ex.p.excluded.tips.indexOf(tipGone) >= 0,
      tipGone);
    /* a member of the rebuild excluded in turn: found in the round after */
    const victim2 = byKind(ex.sh, 'trunk').find(t => !byKind(base.sh, 'trunk').some(u => u.id === t.id));
    if (victim2) {
      const ex2 = await build(COUPON, { mode: 'auto', excluded: [victim.id, tipGone, victim2.id] });
      check('coupon: a member of the rebuild excluded in turn - neither excluded id is built',
        ex2.ok && !ex2.sh.members.some(m => m.id === victim.id || m.id === victim2.id) && ex2.p.excluded.members.length === 2,
        ex2.ok ? `${ex2.p.excluded.members.join(', ')}; unknown ${JSON.stringify(ex2.p.excluded.unknown)}` : ex2.reason);
    }
  }

  /* ---- 6. members ---- */
  console.log('\n=== 6. members ===');
  for (const [label, a, piece, feed] of [['coupon, auto', base, COUPON, undefined],
                                          ['coupon, half off', half, COUPON, { mode: 'assisted', beaconsOff: off }],
                                          ['shelf, zones', zoned, SHELF, { mode: 'custom', tips: shelfTips, landingZones: [ZA, ZB] }],
                                          ['arc, a stair', arc, ARC, undefined]]) {
    if (!a.ok) continue;
    const b = await build(piece, feed);
    const ja = JSON.stringify(a.sh.members), jb = b.ok ? JSON.stringify(b.sh.members) : '';
    const uniq = new Set(a.sh.members.map(m => m.id)).size === a.sh.members.length;
    const kinds = {};
    a.sh.members.forEach(m => { kinds[m.kind] = (kinds[m.kind] || 0) + 1; });
    check(`${label}: two builds of the same inputs name the same members, in the same order; every id once`,
      ja === jb && uniq && a.sh.members.every(m => ['tip', 'branch', 'trunk', 'pad', 'sheet'].indexOf(m.kind) >= 0 && m.from.length === 3 && m.to.length === 3),
      JSON.stringify(kinds));
    const one1 = oneTrunkEach(a.sh);
    check(`${label}: every held tip in exactly one trunk's carries; every other tip reported unsupported`,
      one1.ok && one1.held === a.p.held && a.sh.unsupported.length === a.p.unreachable.length + a.p.inside.length + ((a.p.feed && a.p.feed.refused.length) || 0),
      `${one1.held} held, ${a.sh.unsupported.length} unsupported` + (one1.ok ? '' : ' ' + JSON.stringify(one1).slice(0, 300)));
  }

  /* the card's build: every area planned, built on shared feet, the pads
     drawn over every area at once - shareFeet() names its pads */
  {
    const ST = ctx.NSO_SupportTree, det = ctx.NSO_SupportAim.detectOverhangs(COUPON, { skipList: [], angleDeg: CARD.angleDeg, occluders: [] });
    const builds = [], held = {};
    let plateZ = 0;
    for (const rg of det.beaconRegions) {
      const bs = rg.beacons.map(b => ({ x: b.x, y: b.y, z: b.z, normal: b.normal, regionId: rg.id, key: 'k' }));
      const p = ST.planTree(COUPON, Object.assign({}, CARD, { beacons: bs }));
      if (!p.ok) continue;
      plateZ = p.plateZ;
      const sh = GP.shells(p, await GP.parts(p, Object.assign({ footPads: 'shared' }, PARTS)));
      byKind(sh, 'trunk').forEach(t => t.carries.forEach(id => { held[id] = true; }));
      builds.push({ solids: sh.solids });
    }
    const sf = GP.shareFeet(builds, COUPON, { plateZ });
    const n = {};
    (sf.members || []).forEach(m => m.carries.forEach(id => { n[id] = (n[id] || 0) + 1; }));
    check('coupon, the card\'s build: shareFeet names its pads; every held tip in exactly one pad\'s carries',
      sf.ok && sf.members.length === sf.pads && sf.members.every(m => m.kind === 'pad' && /^pad-/.test(m.id)) &&
      Object.keys(held).length > 0 && Object.keys(held).every(id => n[id] === 1) && Object.keys(n).every(id => held[id]),
      `${sf.pads} pad(s), ${Object.keys(held).length} held tips over ${builds.length} area(s)`);
  }

  /* ---- 7. crowns: one tree to a circle (supports-thinning-1) ---- */
  console.log('\n=== 7. crowns: one trunk to a circle ===');
  const JOINS = GP.JOINS, TR = GP.TRUNK, cosN = Math.cos(Math.PI / TR.sides);
  /* 7a. the joins are Bambu's: the engine's table is the measuring tool's answer on the fixture */
  {
    const BJ = require('./nso_support_bambu_joins.js');
    const m = BJ.summary([BJ.measure(path.join(ROOT, 'fixtures', 'supports', 'simple_overhang_bambu.gcode.3mf'))]);
    const near = (a, b, tol) => Math.abs(a - b) <= tol;
    check('the engine\'s JOINS table is what tools/nso_support_bambu_joins.js measures on simple_overhang_bambu.gcode.3mf (area ratio, branch angle, fan)',
      near(m.ratioTotal.min, JOINS.areaRatio[0], 0.011) && near(m.ratioTotal.max, JOINS.areaRatio[1], 0.011) && near(m.branchAngleDeg.min, JOINS.angleDeg[0], 0.1) &&
      near(m.branchAngleDeg.max, JOINS.angleDeg[1], 0.1) && near(m.fanDeg.min, JOINS.fanDeg[0], 0.1) && near(m.fanDeg.max, JOINS.fanDeg[1], 0.1) && m.joins >= 7,
      `${m.joins} joins: area parent/children ${f3(m.ratioTotal.min)} - ${f3(m.ratioTotal.max)} (median ${f3(m.ratioTotal.median)}); branch angle ${f3(m.branchAngleDeg.min)} - ${f3(m.branchAngleDeg.max)} deg (median ${f3(m.branchAngleDeg.median)}, p90 ${f3(m.branchAngleDeg.p90)}); ` +
      `fan ${f3(m.fanDeg.min)} - ${f3(m.fanDeg.max)}; parent / widest child ${f3(m.ratioWidest.min)} - ${f3(m.ratioWidest.max)}; trunk taper ${f3(m.taperHalfAngleDeg.median)} deg`);
  }
  const LEDGE = (zc, xe) => new Float32Array([].concat(box([0, 0, 0], [10, 10, zc + 4]), box([10, 0, zc], [xe, 10, zc + 4])));
  const LAY = { 1: [[20, 5]], 2: [[18.5, 5], [21.5, 5]], 3: [[18.5, 3.5], [21.5, 3.5], [20, 7]],
    6: [[17, 3.5], [20, 3.5], [23, 3.5], [17, 6.5], [20, 6.5], [23, 6.5]],
    12: [[15.5, 2], [18.5, 2], [21.5, 2], [24.5, 2], [15.5, 5], [18.5, 5], [21.5, 5], [24.5, 5], [15.5, 8], [18.5, 8], [21.5, 8], [24.5, 8]] };
  const SHAPE = { 1: '1>1', 2: '1>2', 3: '1>3', 6: '1>3>6', 12: '1>3>6>12' };
  /* the parts of the tree and trunk, no sheet: one solid? (closed shells joined where they cross) */
  function segTri(p, q, a, b, c) {
    const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const h = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]], det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
    if (Math.abs(det) < 1e-14) return false;
    const f = 1 / det, sv = [p[0] - a[0], p[1] - a[1], p[2] - a[2]], u = f * (sv[0] * h[0] + sv[1] * h[1] + sv[2] * h[2]);
    if (u < 0 || u > 1) return false;
    const qv = [sv[1] * e1[2] - sv[2] * e1[1], sv[2] * e1[0] - sv[0] * e1[2], sv[0] * e1[1] - sv[1] * e1[0]], v = f * (d[0] * qv[0] + d[1] * qv[1] + d[2] * qv[2]);
    if (v < 0 || u + v > 1) return false;
    const t = f * (e2[0] * qv[0] + e2[1] * qv[1] + e2[2] * qv[2]);
    return t >= 0 && t <= 1;
  }
  function boxOf(S) { const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9]; for (let i = 0; i < S.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], S[i + k]); hi[k] = Math.max(hi[k], S[i + k]); } return { lo, hi }; }
  function trisOf(S) { const o = []; for (let i = 0; i < S.length; i += 9) o.push([[S[i], S[i + 1], S[i + 2]], [S[i + 3], S[i + 4], S[i + 5]], [S[i + 6], S[i + 7], S[i + 8]]]); return o; }
  function crosses(A, B, ba, bb) {
    for (let k = 0; k < 3; k++) if (ba.lo[k] > bb.hi[k] + 1e-6 || bb.lo[k] > ba.hi[k] + 1e-6) return false;
    const ta = trisOf(A), tb = trisOf(B), E = [[0, 1], [1, 2], [2, 0]];
    for (const T of ta) for (const [i, j] of E) for (const U of tb) if (segTri(T[i], T[j], U[0], U[1], U[2])) return true;
    for (const U of tb) for (const [i, j] of E) for (const T of ta) if (segTri(U[i], U[j], T[0], T[1], T[2])) return true;
    /* one inside the other: a vertex of A inside B by a +x parity count */
    const inside = (pt, S, bx) => { let n = 0; const far = [bx.hi[0] + 1, pt[1] + 1e-5, pt[2] + 2e-5]; for (const U of trisOf(S)) if (segTri(pt, far, U[0], U[1], U[2])) n++; return n % 2 === 1; };
    return inside(ta[0][0], B, bb) || inside(tb[0][0], A, ba);
  }
  function solidsIn(soups) {
    const bx = soups.map(boxOf), par = soups.map((x, i) => i), find = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    for (let i = 0; i < soups.length; i++) for (let j = i + 1; j < soups.length; j++) if (find(i) !== find(j) && crosses(soups[i], soups[j], bx[i], bx[j])) par[find(j)] = find(i);
    return new Set(soups.map((x, i) => find(i))).size;
  }
  const treePartsOf = b => b.tp.trunks.filter(e => e.sheet == null).flatMap(e => e.parts.map(q => q.soup));
  /* a join's numbers, from the crown's own record */
  function joinsOf(c) {
    const byM = {}; c.nodes.forEach(n => { byM[n.member] = n; });
    const dir = (a, b) => { const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l = Math.hypot(...d); return d.map(v => v / l); };
    const ang = (u, v) => Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]))) * 180 / Math.PI;
    const edge = n => { const pts = [n.pos].concat(n.mid ? [n.mid] : [], [n.to]); return { first: dir(pts[0], pts[1]), last: dir(pts[pts.length - 2], pts[pts.length - 1]) }; };
    return c.nodes.filter(n => n.kind !== 'tip').map(n => {
      const kids = n.kids.map(k => byM[k]), dp = n.kind === 'root' ? [0, 0, -1] : edge(n).first, kd = kids.map(k => edge(k).last);
      const aK = kids.reduce((a, k) => a + (k.kind === 'tip' ? c.tipSide ** 2 : Math.PI * k.rBot * k.rBot), 0);
      let fan = 0; for (let i = 0; i < kd.length; i++) for (let j = i + 1; j < kd.length; j++) fan = Math.max(fan, ang(kd[i], kd[j]));
      return { root: n.kind === 'root', kids: kids.length, angles: kd.map(d => ang(d, dp)), fan, ratio: Math.PI * n.rTop * n.rTop / aK };
    });
  }
  /* the oval's area at each of its rings against Bambu's law (a round trunk's, area for area) */
  const lawR = (z, H, plateZ) => TR.tipMm / 2 + Math.tan(TR.angleDeg * Math.PI / 180) * Math.max(0, H - z) + (z < plateZ + TR.flareMm ? Math.tan(TR.flareAngleDeg * Math.PI / 180) * (plateZ + TR.flareMm - z) : 0);
  function trunkVsLaw(b) {
    let worst = Infinity, n = 0;
    (b.tp.trunkShells || []).forEach(t => {
      if (!t.rings) return;
      t.rings.forEach(r => { const rs = r.length > 2 ? r[2] : r[1], area = Math.PI * r[1] * cosN * rs * cosN, lw = Math.PI * lawR(r[0], t.H, b.p.plateZ) ** 2; worst = Math.min(worst, area / lw); n++; });
    });
    return { worst, n };
  }
  const rows = [];
  for (const N of [1, 2, 3, 6, 12]) {
    const sel = LAY[N].map(q => ({ x: q[0], y: q[1], z: 26 })), ZC = { x: 20, y: 5, r: 4 };
    const b = await build(LEDGE(26, 32), { mode: 'custom', tips: sel, landingZones: [ZC] });
    if (!b.ok) { check(`${N} tip(s) on one circle: builds`, false, b.reason); continue; }
    const p = b.p, c = p.crowns[0], J = joinsOf(c), mine = J.filter(j => !j.root), root = J.find(j => j.root);
    const maxA = Math.max(0, ...J.flatMap(j => j.angles)), lw = trunkVsLaw(b), nTrunk = byKind(b.sh, 'trunk').length;
    const tipsB = byKind(b.sh, 'tip').length, brB = byKind(b.sh, 'branch').length;
    rows.push({ N, shape: c.shape, tips: tipsB, branches: brB, zTop: c.zTop, off: c.offCentreMm, k: c.oval.k, over: p.overLean.length, maxA, root: root && root.ratio });
    const kidsOk = N === 6 ? (() => { const root0 = c.nodes.find(n => n.kind === 'root'); return root0.kids.length === 3 && root0.kids.every(k => c.nodes.find(n => n.member === k).kids.length === 2); })() : true;
    check(`${N} tip(s) on one circle: exactly one trunk, shape ${SHAPE[N]}, every tip built, none left out`,
      nTrunk === 1 && p.trunks.length === 1 && c.shape === SHAPE[N] && kidsOk && p.held === N && tipsB === N && b.sh.unsupported.length === 0 && p.offZone.length === 0 && p.unreachable.length === 0,
      `trunks ${nTrunk}, ${c.shape}, tips ${tipsB}, branch members ${brB}, held ${p.held}`);
    check(`${N} tip(s): every join inside Bambu's measured range - branch angle at most ${JOINS.angleDeg[1]} deg, area parent / children ${JOINS.areaRatio[0]} - ${JOINS.areaRatio[1]} (the root, which Bambu's law holds at least as wide, no less)`,
      p.overLean.length === 0 && maxA <= JOINS.angleDeg[1] + 1e-6 && mine.every(j => j.ratio >= JOINS.areaRatio[0] - 1e-6 && j.ratio <= JOINS.areaRatio[1] + 1e-6) && (!root || root.ratio >= JOINS.areaRatio[0] - 1e-6),
      `${J.length} join(s); widest angle ${f3(maxA)} deg; area ratios ${J.map(j => f3(j.ratio) + (j.root ? ' (root)' : '')).join(' ')}`);
    check(`${N} tip(s): the trunk is at least Bambu's law at every height (area for area), standing on its circle's centre`,
      lw.n > 0 && lw.worst >= 1 - 1e-6 && c.offCentreMm < 1e-9 && !c.tight && p.blocked.length === 0,
      `${lw.n} rings, thinnest ${f3(lw.worst)} x the law; ${f3(c.offCentreMm)} mm off the centre; oval ${f3(c.oval.k)} : 1`);
    const comps = solidsIn(treePartsOf(b));
    check(`${N} tip(s): the tree is one connected solid`, comps === 1, `${comps} piece(s) from ${treePartsOf(b).length} shells`);
  }
  /* 7b. an over-lean tip is built, marked, and has a spot inside the limit; no tip is left out */
  {
    const LD = LEDGE(16, 45), near = [[18, 4], [20, 4], [22, 4], [18, 6], [20, 6], [22, 6]].map(q => ({ x: q[0], y: q[1], z: 16 })), far = { x: 43, y: 5, z: 16 };
    const b = await build(LD, { mode: 'custom', tips: near.concat([far]), landingZones: [{ x: 20, y: 5, r: 3 }] });
    if (!b.ok) check('over-lean case: builds', false, b.reason);
    else {
      const p = b.p, farId = GP.tipId([far.x, far.y, far.z], true), byId = {};
      b.sh.members.forEach(m => { byId[m.id] = m; });
      const tanL = Math.tan(p.branchTiltDeg * Math.PI / 180), mine = p.overLean.filter(o => o.tip === farId);
      const spot = p.suggested.find(sg => mine.some(o => o.member === sg.forMember));
      const m = spot && byId[spot.forMember];
      check('over-lean: a tip far from its circle is built (a member of its own, carried by the circle\'s trunk), listed in plan.overLean, and no tip is left out',
        byKind(b.sh, 'tip').some(t => t.id === farId) && byKind(b.sh, 'trunk').length === 1 && byKind(b.sh, 'trunk')[0].carries.indexOf(farId) >= 0 && mine.length > 0 && mine.every(o => o.leanDeg > p.branchTiltDeg) &&
        p.held === 7 && b.sh.unsupported.length === 0 && p.offZone.length === 0,
        `${p.overLean.length} member(s) over ${p.branchTiltDeg} deg, the far tip's at ${mine.length ? f3(mine[0].leanDeg) : '-'} deg; held ${p.held} of 7`);
      check('over-lean: the engine suggests a spot on the plate whose drop from that member sits inside the lean limit (the engine\'s own reach, z x tan limit)',
        !!spot && !!m && Math.hypot(spot.x - m.from[0], spot.y - m.from[1]) <= (m.from[2] - p.plateZ) * tanL + 1e-6 && spot.leanDeg <= p.branchTiltDeg + 1e-6 && p.suggested.length === p.overLean.length,
        spot ? `(${f3(spot.x)}, ${f3(spot.y)}) for ${spot.forMember}: reach ${f3(Math.hypot(spot.x - m.from[0], spot.y - m.from[1]))} of ${f3((m.from[2] - p.plateZ) * tanL)} mm, ${f3(spot.leanDeg)} deg` : 'none');
    }
  }
  /* 7c. an oval trunk carries a spread-out row of tips */
  {
    const row = [14, 17, 20, 23, 26, 29].map(x => ({ x: x, y: 5, z: 26 })), ZC = { x: 22, y: 5, r: 5 };
    const b = await build(LEDGE(26, 36), { mode: 'custom', tips: row, landingZones: [ZC] });
    if (!b.ok) check('oval: builds', false, b.reason);
    else {
      const c = b.p.crowns[0], t = b.tp.trunkShells[0], ang = ((c.oval.angDeg % 180) + 180) % 180;
      check('oval: a row of tips 15 mm long along x is carried by an oval trunk, its long axis along the row, area kept (the same law as a round trunk)',
        c.oval.k > 1.5 && (ang < 10 || ang > 170) && t && t.rings && t.rings[0][1] > t.rings[0][2] * 1.2 && trunkVsLaw(b).worst >= 1 - 1e-6 && c.offCentreMm < 1e-9,
        `${f3(c.oval.k)} : 1 along ${f3(c.oval.angDeg)} deg (the row's spread ${f3(2 * c.oval.half)} mm); base ${t && t.rings ? f3(t.rings[0][1] * cosN * 2) + ' x ' + f3(t.rings[0][2] * cosN * 2) : '-'} mm; thinnest ${f3(trunkVsLaw(b).worst)} x the law`);
    }
  }
  /* 7d. two circles, two trees; the eraser takes a branch (and the trunk) and the tree is split round it */
  {
    const sel = LAY[6].map(q => ({ x: q[0], y: q[1], z: 26 })), feed = { mode: 'custom', tips: sel, landingZones: [{ x: 20, y: 5, r: 4 }] };
    const b0 = await build(LEDGE(26, 32), feed);
    const pair = byKind(b0.sh, 'branch').find(m => m.carries.length === 2), trunk0 = byKind(b0.sh, 'trunk')[0];
    for (const [label, victim] of [['a pair\'s branch', pair], ['the trunk', trunk0]]) {
      const e = await build(LEDGE(26, 32), Object.assign({}, feed, { excluded: [victim.id] }));
      check(`eraser: ${label} erased - its id is not built, the circle still holds all 6 tips on one trunk, split round it`,
        e.ok && !e.sh.members.some(m => m.id === victim.id) && e.p.held === 6 && byKind(e.sh, 'trunk').length === 1 && e.sh.unsupported.length === 0 && e.p.excluded.members[0] === victim.id,
        e.ok ? `held ${e.p.held}, ${e.p.crowns[0].shape}, trunk at ${e.p.crowns[0].axis.map(f3).join(', ')} (was ${b0.p.crowns[0].axis.map(f3).join(', ')}), ${e.p.blocked.length} blocked` : e.reason);
    }
    const two = await build(LEDGE(26, 44), { mode: 'custom', tips: LAY[6].map(q => ({ x: q[0], y: q[1], z: 26 })).concat(LAY[6].map(q => ({ x: q[0] + 12, y: q[1], z: 26 }))), landingZones: [{ x: 20, y: 5, r: 4 }, { x: 32, y: 5, r: 4 }] });
    check('two circles, twelve tips: one trunk to each circle, each inside its own circle, every tip built',
      two.ok && byKind(two.sh, 'trunk').length === 2 && two.p.crowns.length === 2 && two.p.crowns.every(c => c.shape === '1>3>6') && two.p.held === 12 && two.p.zones.every(z => z.trunks.length === 1),
      two.ok ? two.p.crowns.map(c => `circle ${c.zone}: ${c.shape} at ${c.axis.map(f3).join(', ')} (${f3(c.offCentreMm)} off its centre)`).join('; ') : two.reason);
  }
  /* 7e. the arc: the stair's tips on one circle - one trunk, the stair grafted on it */
  {
    const held = arc.tp.sheet.tips.filter(t => t.mode === 'drop').map(t => { const q = arc.p.beacons[t.beacon].p; return { x: q[0], y: q[1], z: q[2] }; });
    const ZC = { x: 90, y: 100, r: 5 }, b = await build(ARC, { mode: 'custom', tips: held, landingZones: [ZC] });
    if (!b.ok) check('arc: builds', false, b.reason);
    else {
      const c = b.p.crowns[0], J = joinsOf(c), comps = solidsIn(treePartsOf(b)), mine = J.filter(j => !j.root);
      rows.push({ N: held.length, shape: c.shape, tips: byKind(b.sh, 'tip').length, branches: byKind(b.sh, 'branch').length, zTop: c.zTop, off: c.offCentreMm, k: c.oval.k, over: b.p.overLean.length, maxA: Math.max(...J.flatMap(j => j.angles)), root: J.find(j => j.root).ratio, arc: true });
      check(`arc: its ${held.length} stair tips on one circle - one trunk (the stair's own tree grafted on it), every tip built, one connected solid`,
        byKind(b.sh, 'trunk').length === 1 && b.tp.stairTrunks.length === 0 && b.p.held === held.length && b.sh.unsupported.length === 0 && comps === 1 && b.tp.sheet.counts.drop > 0,
        `trunks ${byKind(b.sh, 'trunk').length}, stair trunks ${b.tp.stairTrunks.length}, stair holds ${b.tp.sheet.counts.drop} tips on ${b.tp.sheet.levels.length} stair(s), ${comps} piece`);
      check('arc: every join inside Bambu\'s measured range, the trunk at least its law, standing on the circle\'s centre',
        mine.every(j => j.ratio >= JOINS.areaRatio[0] - 1e-6 && j.ratio <= JOINS.areaRatio[1] + 1e-6) && Math.max(...J.flatMap(j => j.angles)) <= JOINS.angleDeg[1] + 1e-6 && trunkVsLaw(b).worst >= 1 - 1e-6 && c.offCentreMm < 1e-9 && b.p.blocked.length === 0,
        `${J.length} joins, widest ${f3(Math.max(...J.flatMap(j => j.angles)))} deg, area ratios ${f3(Math.min(...J.map(j => j.ratio)))} - ${f3(Math.max(...J.map(j => j.ratio)))}; trunk ${f3(trunkVsLaw(b).worst)} x the law; oval ${f3(c.oval.k)} : 1`);
    }
  }
  /* the tree shapes */
  console.log('\n  tree shapes (tips > per round of joins; the arc\'s are its stair tips):');
  console.log('    tips  shape         tip cols  branches  top of trunk   off centre  oval    over lean  widest angle  root area ratio');
  rows.forEach(r => console.log(`    ${String(r.N).padStart(4)}  ${r.shape.padEnd(12)}  ${String(r.tips).padStart(8)}  ${String(r.branches).padStart(8)}  ${f3(r.zTop).padStart(12)}  ${f3(r.off).padStart(10)}  ${f3(r.k).padStart(6)}  ${String(r.over).padStart(9)}  ${f3(r.maxA).padStart(12)}  ${r.root == null ? '-' : f3(r.root)}`));
  /* the knobs: nothing new is wired in */
  const KN = GP.crownKnobs({ crown: { ovalMax: 5, trunk: { angleDeg: 4 } } });
  check('every crown value is an opts.crown knob with today\'s value as default', GP.crownKnobs({}).ovalMax === GP.CROWN.ovalMax && KN.ovalMax === 5 && KN.trunk.angleDeg === 4 && KN.trunk.tipMm === TR.tipMm && KN.areaRatio === GP.CROWN.areaRatio,
    JSON.stringify(GP.crownKnobs({})).slice(0, 220));

  console.log('\n' + (fail ? `FAILED  ${fail} of ${pass + fail}` : `PASSED  all ${pass}`));
  if (fail) { console.log('  ' + FAILS.join('\n  ')); process.exit(1); }
})().catch(err => { console.error(err); process.exit(1); });
