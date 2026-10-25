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
//      and flare may spill past the line); a zone out
//      of reach reported, nothing forced into it; a merge that lands in no
//      zone undone, so every tip a zone takes alone is held
//   4b. the stair (the arc): its own trunks have member ids; every tip it
//      holds is carried by one of them
//   5. excluded trunk (the coupon): the rebuild has no member with its id; its
//      tips are carried by other trunks or reported unsupported; an excluded
//      tip is not supported and not reported unsupported
//   6. members: the same ids, in the same order, from two builds of the same
//      inputs; every held tip in exactly one trunk's carries
//   7. knobs (feed.knobs { trunkTipMm, trunkAngleDeg, leanDeg, nodeMm }): none
//      given = today's plan, and all four at their defaults builds the same
//      bytes as none (the arc, the tilted box, the coupon); a value that is
//      not a number > 0 is refused by name; trunkTipMm 1.2 thins the top of
//      every trunk, trunkAngleDeg 0 makes a straight one; leanDeg and nodeMm
//      move what they say; all four reach the re-landing; what a value
//      breaks is in plan.knobs.problems; the export names the non-default ones

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const { readSTL } = require('./nso_stl_io.js');

const NSO3MF = require(path.join(ROOT, 'nso-3mf.js'));
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
    check('shelf: the zone out of reach is reported empty, nothing forced into it; a tip in reach of no zone is reported, not built',
      p.zonesEmpty.length === 1 && p.zonesEmpty[0] === 1 && p.zones[1].trunks.length === 0 && p.zones[0].trunks.length === feet.length &&
      p.offZone.length > 0 && p.offZone.every(id => zoned.sh.unsupported.indexOf(GP.tipId(p.beacons[id].p, true)) >= 0) &&
      p.held + p.unreachable.length + p.inside.length === shelfTips.length,
      `zones ${p.zones.map((z, i) => i + ': ' + z.trunks.length + ' trunk(s)').join(', ')}; empty ${JSON.stringify(p.zonesEmpty)}; ` +
      `${p.offZone.length} in reach of no zone; ${p.reason}`);
    /* no tip is dropped by the zone rule that a zone takes alone: a merge (or
       a pickup) that lands in no zone is undone and its branches land alone */
    const alone = [];
    for (const t of shelfTips) {
      const a1 = GP.plan(SHELF, Object.assign({}, CARD, { feed: { mode: 'custom', tips: [t], landingZones: [ZA, ZB] } }));
      alone.push(a1.ok && a1.held === 1);
    }
    const heldIds = new Set(byKind(zoned.sh, 'trunk').flatMap(x => x.carries));
    const lost = shelfTips.filter((t, i) => alone[i] && !heldIds.has(GP.tipId([t.x, t.y, t.z], true)));
    check('shelf: a merge that lands in no zone is undone and its branches land alone - every tip a zone takes alone is held',
      p.unmerged.length > 0 && !lost.length && alone.some(x => x) && alone.some(x => !x),
      `${alone.filter(x => x).length} of ${shelfTips.length} land alone, ${heldIds.size} held together; ${p.unmerged.length} merge(s) undone` +
      (lost.length ? '; lost ' + lost.map(t => JSON.stringify(t)).join(' ') : ''));
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


  /* ---- 7. knobs ---- */
  console.log('\n=== 7. knobs: trunkTipMm, trunkAngleDeg, leanDeg, nodeMm ===');
  let tiltedPiece = null, tiltedNone = null;
  const kfeed = knobs => ({ mode: 'assisted', knobs });
  const kb = (piece, knobs) => build(piece, kfeed(knobs));
  const DEF4 = { trunkTipMm: 2, trunkAngleDeg: 5.5, leanDeg: 30, nodeMm: 5 };
  /* the plan, less what a fed plan adds to its answer (feed, zones, the knobs' echo): what the planner decided */
  const CORE = ['members', 'stubs', 'merges', 'pickups', 'steered', 'nudged', 'tight', 'unreachable', 'resting', 'inside', 'held', 'trunks',
                'beacons', 'stations', 'branchTiltDeg', 'latticeMm', 'plateZ', 'pitchMm', 'reason'];
  /* less what a fed plan adds to a beacon (tid), and what parts() writes into the plan's members and stubs (points, soup: where a trunk was re-landed) */
  const planCore = p => JSON.stringify(CORE.map(k => p[k]), (k, v) => (k === 'tid' || k === 'points' || k === 'soup') ? undefined : v);
  /* the built trunks: a knobs plan's feet also carry the law they were built by (grow.law) */
  const builtKey = a => JSON.stringify([a.tp.feet, a.tp.relanded, a.tp.stairTrunks], (k, v) => k === 'law' ? undefined : v);
  const lean = p => {
    let w = 0;
    for (const m of p.members) {
      if (m.dead) continue;
      for (let i = 0; i + 1 < m.path.length; i++) {
        if (m.kind === 'side' && i === 0) continue;
        const a = m.path[i], b = m.path[i + 1], h = Math.hypot(b[0] - a[0], b[1] - a[1]), dz = Math.abs(b[2] - a[2]);
        if (h + dz > 1e-9) w = Math.max(w, Math.atan2(h, dz) * 180 / Math.PI);
      }
    }
    for (const t of p.stubs) w = Math.max(w, Math.atan2(Math.hypot(t.to[0] - t.from[0], t.to[1] - t.from[1]), t.to[2] - t.from[2]) * 180 / Math.PI);
    return w;
  };
  /* the trunks as built, against the law the plan says it builds by */
  const cosN = Math.cos(Math.PI / GP.TRUNK.sides), tanDeg = d => Math.tan(d * Math.PI / 180);
  function lawCheck(a) {
    const law = GP.trunkLaw(a.p), recs = (a.tp.trunkShells || []).filter(r => r.rings);
    let worst = 0, bound = 0, narrowed = 0;
    for (const r of recs) {
      for (const [z, R] of r.rings) {
        const want = law.tipMm / 2 + tanDeg(law.angleDeg) * Math.max(0, r.H - z) +
          (z < a.p.plateZ + law.flareMm ? tanDeg(law.flareAngleDeg) * (a.p.plateZ + law.flareMm - z) : 0);
        if (r.narrowed) { narrowed++; if (R * cosN > want + 1e-9) bound++; } else worst = Math.max(worst, Math.abs(R * cosN - want));
      }
    }
    return { recs, worst, bound, narrowed, n: recs.length - recs.filter(r => r.narrowed).length };
  }
  const topR = r => r.rings[r.rings.length - 1][1];
  const atFoot = (list, r) => list.find(x => x.rings && Math.abs(x.c[0] - r.c[0]) < 1e-6 && Math.abs(x.c[1] - r.c[1]) < 1e-6);

  /* 7a. none given: no knobs on the plan; all four at their defaults is the same build, byte for byte */
  console.log('  -- none given, and all four at their defaults');
  {
    const TILT = (() => {
      const T = 30 * Math.PI / 180, b = box([0, 0, 0], [40, 30, 10]), r = new Float32Array(b.length);
      for (let i = 0; i < b.length; i += 3) { r[i] = b[i] * Math.cos(T) - b[i + 2] * Math.sin(T); r[i + 1] = b[i + 1]; r[i + 2] = b[i] * Math.sin(T) + b[i + 2] * Math.cos(T); }
      let mz = Infinity;
      for (let i = 2; i < r.length; i += 3) mz = Math.min(mz, r[i]);
      for (let i = 2; i < r.length; i += 3) r[i] -= mz;
      return r;
    })();
    const none = { coupon: base, arc, 'tilted box': await build(TILT) };
    tiltedPiece = TILT; tiltedNone = none['tilted box'];
    for (const [name, piece] of [['coupon', COUPON], ['arc', ARC], ['tilted box', TILT]]) {
      const a = none[name], d = await kb(piece, DEF4);
      if (!a.ok || !d.ok) { check(name + ': builds with and without knobs', false, (a.reason || '') + ' / ' + (d.reason || '')); continue; }
      check(name + ': no knobs given - plan.knobs is absent' + (name === 'coupon' ? ', and a feed that gives knobs {} plans the same' : ''),
        a.p.knobs === undefined && (name !== 'coupon' || (() => { const e = GP.plan(piece, Object.assign({}, CARD, { feed: kfeed({}) })); return e.ok && e.knobs === undefined && planCore(e) === planCore(a.p); })()),
        'plan.knobs ' + typeof a.p.knobs);
      check(name + ': all four at their defaults - the same plan, the same trunks, the same shells, the same members, to the bit',
        planCore(a.p) === planCore(d.p) && builtKey(a) === builtKey(d) && sha(a.sh.soup) === sha(d.sh.soup) &&
        JSON.stringify(a.sh.members) === JSON.stringify(d.sh.members) && a.sh.solids.length === d.sh.solids.length,
        `${a.p.trunks.length} trunks, ${a.p.held} held, ${a.tp.relanded.length} re-landed; ${sha(d.sh.soup)} = ${sha(a.sh.soup)}`);
      const k = d.p.knobs;
      check(name + ': plan.knobs echoes the defaults, names nothing for the export, reports no problem',
        k && ['trunkTipMm', 'trunkAngleDeg', 'leanDeg', 'nodeMm'].every(key => k[key] === DEF4[key]) && !Object.keys(k.nonDefault).length && !k.problems.length &&
        d.p.branchTiltDeg === 30 && d.p.latticeMm === 5, JSON.stringify(k && { tip: k.trunkTipMm, angle: k.trunkAngleDeg, lean: k.leanDeg, node: k.nodeMm, nonDefault: k.nonDefault, problems: k.problems.length }));
    }
    check('the TRUNK descriptor is the shipped law; trunkLaw(plan) is the law a plan builds by',
      GP.TRUNK.tipMm === 2 && GP.TRUNK.angleDeg === 5.5 && JSON.stringify(GP.trunkLaw(base.p)) === JSON.stringify({ tipMm: 2, angleDeg: 5.5, flareMm: GP.TRUNK.flareMm, flareAngleDeg: GP.TRUNK.flareAngleDeg }));
  }

  /* 7b. what is refused: a value that is not a number > 0 (trunkAngleDeg: >= 0), a knob there is not, knobs on Auto */
  console.log('  -- refused by name');
  {
    const bad = [[{ trunkTipMm: 0 }, 'trunkTipMm'], [{ trunkTipMm: -1 }, 'trunkTipMm'], [{ trunkAngleDeg: -0.5 }, 'trunkAngleDeg'], [{ leanDeg: 0 }, 'leanDeg'],
                 [{ leanDeg: NaN }, 'leanDeg'], [{ nodeMm: Infinity }, 'nodeMm'], [{ nodeMm: '4' }, 'nodeMm'], [{ lean: 20 }, '"lean"']];
    const refused = bad.map(([kn, word]) => { const p = GP.plan(COUPON, Object.assign({}, CARD, { feed: kfeed(kn) })); return !p.ok && p.stage === 'feed' && p.reason.indexOf(word) >= 0; });
    const auto = GP.plan(COUPON, Object.assign({}, CARD, { feed: { mode: 'auto', knobs: { leanDeg: 20 } } }));
    check('a value that is not a finite number > 0, a knob that is not one of the four, knobs on Auto: refused, the reason names it',
      refused.every(Boolean) && !auto.ok && auto.stage === 'feed' && /knobs/.test(auto.reason), refused.map(x => x ? 'ok' : 'NO').join(' ') + '; ' + auto.reason);
    const a0 = GP.plan(COUPON, Object.assign({}, CARD, { feed: kfeed({ trunkAngleDeg: 0 }) }));
    check('trunkAngleDeg 0 is a number the planner takes (a straight trunk)', a0.ok && a0.knobs.trunkAngleDeg === 0 && a0.knobs.nonDefault.trunkAngleDeg === 0, a0.reason);
  }

  /* 7c. trunkTipMm 1.2: a thinner top on every trunk, the plan unchanged */
  console.log('  -- trunkTipMm 1.2');
  const t12 = await kb(COUPON, { trunkTipMm: 1.2 }), t12a = await kb(ARC, { trunkTipMm: 1.2 }), ang0 = await kb(COUPON, { trunkAngleDeg: 0 });
  for (const [name, a, ref] of [['coupon', t12, base], ['arc', t12a, arc]]) {
    if (!a.ok) { check(name + ', trunkTipMm 1.2: builds', false, a.reason); continue; }
    const L = lawCheck(a), L0 = lawCheck(ref);
    const thinner = L.recs.filter(r => { const q = atFoot(L0.recs, r); return q && topR(r) < topR(q) - 1e-9; }).length;
    const same = L.recs.filter(r => { const q = atFoot(L0.recs, r); return q && Math.abs(topR(r) - topR(q)) < 1e-9; });
    const moved = L.recs.filter(r => !atFoot(L0.recs, r)).length;
    check(name + ', trunkTipMm 1.2: the top of every trunk is thinner than the default\'s (or the same, where the piece narrows both) and every ring is the law\'s (or the piece\'s room)',
      L.n > 0 && L.worst < 1e-9 && !L.bound && thinner + same.length + moved === L.recs.length && thinner > 0 && same.every(r => r.narrowed),
      `${L.recs.length} trunks: ${thinner} thinner at the top, ${same.length} the same (narrowed by the piece), ${moved} stand elsewhere (re-landed); law off by ${L.worst.toExponential(1)}; ` +
      `top diameters ${Math.min(...L.recs.map(r => topR(r) * cosN * 2)).toFixed(2)} - ${Math.max(...L.recs.map(r => topR(r) * cosN * 2)).toFixed(2)} mm`);
    check(name + ', trunkTipMm 1.2: the plan is the plan - the law is the trunk\'s, not the planner\'s; plan.knobs and trunkLaw say 1.2',
      planCore(a.p) === planCore(ref.p) && a.p.knobs.trunkTipMm === 1.2 && GP.trunkLaw(a.p).tipMm === 1.2 && JSON.stringify(a.p.knobs.nonDefault) === '{"trunkTipMm":1.2}',
      JSON.stringify(a.p.knobs.nonDefault));
  }

  /* 7d. trunkAngleDeg 0: a straight trunk */
  console.log('  -- trunkAngleDeg 0');
  {
    const a = ang0, L = lawCheck(a), L0 = lawCheck(base);
    const straight = r => Math.abs(r.rings[1][1] - topR(r)) < 1e-9, free = L.recs.filter(r => !r.narrowed && r.rings.length >= 3);
    check('coupon, trunkAngleDeg 0: every trunk the piece does not narrow stands as wide at its top as above its flare - straight; at the default none does',
      a.ok && free.length > 0 && free.every(straight) && L.worst < 1e-9 && !L.bound &&
      L0.recs.filter(r => !r.narrowed && r.rings.length >= 3).every(r => !straight(r)),
      a.ok ? `${free.length} straight trunk(s), ${L.recs.length - free.length} narrowed or short; law off by ${L.worst.toExponential(1)}` : a.reason);
    check('coupon, trunkAngleDeg 0: the plan is the plan', a.ok && planCore(a.p) === planCore(base.p) && GP.trunkLaw(a.p).angleDeg === 0);
  }

  /* 7e. leanDeg, nodeMm: what they say */
  console.log('  -- leanDeg, nodeMm');
  const l15 = await kb(COUPON, { leanDeg: 15 }), l45 = await kb(COUPON, { leanDeg: 45 }), n10 = await kb(COUPON, { nodeMm: 10 }), n4 = await kb(COUPON, { nodeMm: 4 });
  {
    const w0 = lean(base.p);
    check('coupon, leanDeg 15 / 45: no leg leans past it, the plan says so; a shallower lean needs more trunks, a steeper one fewer',
      l15.ok && l45.ok && lean(l15.p) <= 15 + 1e-6 && lean(l45.p) <= 45 + 1e-6 && lean(l45.p) > 30 + 1e-6 && w0 <= 30 + 1e-6 &&
      l15.p.branchTiltDeg === 15 && l45.p.branchTiltDeg === 45 && l15.p.knobs.leanDeg === 15 &&
      l15.p.trunks.length > base.p.trunks.length && l45.p.trunks.length < base.p.trunks.length,
      l15.ok && l45.ok ? `worst leg ${lean(l15.p).toFixed(2)} / ${lean(l45.p).toFixed(2)} deg (default ${w0.toFixed(2)}); trunks ${l15.p.trunks.length} / ${l45.p.trunks.length} (default ${base.p.trunks.length})` : l15.reason);
    const onLattice = (p, L) => p.merges.length > 0 && p.merges.every(m => m.node.slice(0, 2).every(v => Math.abs(v / (L / 2) - Math.round(v / (L / 2))) < 1e-9));
    check('coupon, nodeMm 10 / 4: every merge node on that lattice (default 5), the plan says so, and the merges are not the default\'s',
      n10.ok && n4.ok && onLattice(n10.p, 10) && onLattice(n4.p, 4) && n10.p.latticeMm === 10 && n4.p.knobs.nodeMm === 4 &&
      JSON.stringify(n10.p.merges) !== JSON.stringify(base.p.merges) && n10.p.trunks.length !== base.p.trunks.length,
      n10.ok && n4.ok ? `trunks ${n10.p.trunks.length} / ${n4.p.trunks.length} (default ${base.p.trunks.length}); merges ${n10.p.merges.length} / ${n4.p.merges.length} (default ${base.p.merges.length})` : n10.reason);
  }

  /* 7f. the re-landing reads all four */
  console.log('  -- the re-landing path');
  {
    const rl = a => JSON.stringify(a.tp.relanded.map(r => [r.trunk, r.mm, r.to]));
    const a0 = ang0, reach = (a, r) => { const m = a.p.members[a.p.trunks[r.trunk].root], f = m.path[m.path.length - 2]; return (f[2] - a.p.plateZ) * tanDeg(a.p.branchTiltDeg); };
    const def = base;
    check('coupon: the law reaches the re-landing - trunkTipMm 1.2 and trunkAngleDeg 0 re-land other trunks, the plan being the same',
      t12.ok && a0.ok && rl(t12) !== rl(def) && rl(a0) !== rl(def) && planCore(t12.p) === planCore(def.p) && planCore(a0.p) === planCore(def.p),
      `re-landed trunks: default ${def.tp.relanded.map(r => r.trunk)}; tip 1.2 ${t12.tp.relanded.map(r => r.trunk)}; angle 0 ${a0.tp.relanded.map(r => r.trunk)}`);
    const worst = a => Math.max(0, ...a.tp.relanded.map(r => r.mm - reach(a, r)));
    check('coupon: the lean reaches the re-landing - no trunk moves further than its lean allows from where it falls; at 45 deg some move past what 30 would allow',
      l45.ok && l15.ok && worst(l45) <= 1e-9 && worst(def) <= 1e-9 && l45.tp.relanded.some(r => r.mm > (reach(l45, r) * tanDeg(30) / tanDeg(45)) + 1e-9) && l45.tp.relanded.length > 0,
      `re-landed: lean 15 ${l15.tp.relanded.length}, 30 ${def.tp.relanded.length}, 45 ${l45.tp.relanded.length} (${l45.tp.relanded.map(r => r.mm + '/' + reach(l45, r).toFixed(1)).join(' ')} mm moved/allowed)`);
    check('coupon: nodeMm reaches the re-landing through the plan it lands - other trunks, other trunks re-landed',
      n10.ok && n4.ok && rl(n10) !== rl(def) && rl(n4) !== rl(def) && n10.tp.relanded.length > 0,
      `re-landed trunks: default ${def.tp.relanded.map(r => r.trunk)}; node 10 ${n10.tp.relanded.map(r => r.trunk)}; node 4 ${n4.tp.relanded.map(r => r.trunk)}`);
    const arcRl = a => a.tp.relanded.length + ':' + rl(a);
    check('arc (a stair\'s own trunks too): the law reaches the re-landing - trunkTipMm 1.2 re-lands what the default does not (or elsewhere)',
      t12a.ok && arc.ok && arc.tp.relanded.length > 0 && planCore(t12a.p) === planCore(arc.p) && arcRl(t12a) !== arcRl(arc),
      `re-landed: default ${arc.tp.relanded.map(r => r.trunk + '@' + r.mm)}; tip 1.2 ${t12a.tp.relanded.map(r => r.trunk + '@' + r.mm)}`);
  }

  /* 7g. all four at once: every place agrees with itself */
  console.log('  -- all four');
  {
    const K4 = { trunkTipMm: 1.2, trunkAngleDeg: 3, leanDeg: 20, nodeMm: 4 }, a = await kb(COUPON, K4);
    if (!a.ok) check('coupon, all four: builds', false, a.reason);
    else {
      const L = lawCheck(a), k = a.p.knobs, law = GP.trunkLaw(a.p);
      const onLattice = a.p.merges.length > 0 && a.p.merges.every(m => m.node.slice(0, 2).every(v => Math.abs(v / 2 - Math.round(v / 2)) < 1e-9));
      const reachOk = a.tp.relanded.length > 0 && a.tp.relanded.every(r => { const m = a.p.members[a.p.trunks[r.trunk].root], f = m.path[m.path.length - 2]; return r.mm <= (f[2] - a.p.plateZ) * tanDeg(20) + 1e-9; });
      check('coupon, all four given: plan.knobs echoes them; the trunks are built by that law, the legs lean no more, the nodes are on that lattice, the re-landing keeps to the lean',
        k.trunkTipMm === 1.2 && k.trunkAngleDeg === 3 && k.leanDeg === 20 && k.nodeMm === 4 && law.tipMm === 1.2 && law.angleDeg === 3 &&
        L.n > 0 && L.worst < 1e-9 && !L.bound && lean(a.p) <= 20 + 1e-6 && onLattice && reachOk && a.sh.ok && !k.problems.length,
        `trunk ${law.tipMm} mm top at ${law.angleDeg} deg: law off by ${L.worst.toExponential(1)} over ${L.n} trunks; lean ${lean(a.p).toFixed(2)} deg; ${a.p.merges.length} merges on the 4 mm lattice; ${a.tp.relanded.length} re-landed; ${a.p.trunks.length} trunks`);
      check('coupon, all four: the same inputs build the same bytes twice',
        sha((await kb(COUPON, K4)).sh.soup) === sha(a.sh.soup), sha(a.sh.soup));
    }
  }

  /* 7h. what a value breaks is reported, never clamped */
  console.log('  -- what a value breaks');
  {
    const l95 = GP.plan(COUPON, Object.assign({}, CARD, { feed: kfeed({ leanDeg: 95 }) }));
    const a90 = GP.plan(COUPON, Object.assign({}, CARD, { feed: kfeed({ trunkAngleDeg: 90 }) }));
    check('leanDeg 95 and trunkAngleDeg 90 are used as given and reported (kind lean / angle) - not clamped',
      l95.ok && l95.branchTiltDeg === 95 && l95.knobs.leanDeg === 95 && l95.knobs.problems.some(x => x.kind === 'lean') &&
      a90.ok && a90.knobs.trunkAngleDeg === 90 && a90.knobs.problems.some(x => x.kind === 'angle'),
      (l95.knobs ? l95.knobs.problems : []).concat(a90.knobs ? a90.knobs.problems : []).map(x => x.what).join(' | '));
    const l05 = await kb(COUPON, { leanDeg: 0.5 });
    const miss = l05.ok ? l05.p.knobs.problems.filter(x => x.kind === 'trunk') : [];
    check('leanDeg 0.5: it plans, a tower to each tip, and the trunks that find no room beside the piece are reported - not built, not moved',
      l05.ok && l05.p.branchTiltDeg === 0.5 && l05.p.trunks.length === l05.p.beacons.length && miss.length > 0 &&
      miss.length === 1 && miss[0].count === (l05.tp.trunkShells || []).filter(r => r.why).length && !base.p.knobs,
      l05.ok ? `${l05.p.trunks.length} trunks; ${miss.length ? miss[0].what : 'none reported'}` : l05.reason);
    /* the tilted box leaves most of its trunks unbuilt at the defaults (no height under its tips): not a problem of the knobs */
    const tdef = await kb(tiltedPiece, DEF4), t6 = await kb(tiltedPiece, { trunkTipMm: 6 });
    const unb = a => (a.tp.trunkShells || []).filter(r => r.why).length, prob = a => a.p.knobs.problems.find(x => x.kind === 'trunk');
    check('the tilted box leaves trunks unbuilt at the defaults - reported by none of the defaults\' knobs; a trunkTipMm 6 that unbuilds more reports just those',
      tdef.ok && t6.ok && unb(tdef) > 0 && !prob(tdef) && prob(t6) && prob(t6).count > 0 && prob(t6).count < unb(t6) && unb(t6) - prob(t6).count >= unb(tdef) - 20,
      tdef.ok && t6.ok ? `unbuilt: ${unb(tdef)} at the defaults, ${unb(t6)} at 6 mm; reported ${prob(t6) ? prob(t6).count : 0}: ${prob(t6) ? prob(t6).what.slice(0, 150) : ''}` : tdef.reason);
    check('every shell of a knobs build is closed (they would slice open if not): none reported at 1.2 / 0 / 15 / 45 / 10',
      [t12, l15, l45, n10, ang0].every(a => a.ok && !a.p.knobs.problems.some(x => x.kind === 'shell')),
      'thin values leave closed shells; the weld and the slice were run by hand on the same builds (docs/handoff/supports-knobs-1.md)');
  }

  /* 7i. the export names a support by its non-default knobs */
  console.log('  -- the export name');
  {
    const k = { trunkTipMm: 1.2, trunkAngleDeg: 3, leanDeg: 30 }, a = await kb(COUPON, k);
    const nd = a.ok ? a.p.knobs.nonDefault : null;
    check('plan.knobs.nonDefault is the values that differ from the defaults (lean 30 is one), and the name carries them in that order',
      a.ok && JSON.stringify(nd) === '{"trunkTipMm":1.2,"trunkAngleDeg":3}' &&
      NSO3MF.objectName({ name: 'supports', supportKnobs: nd }, 0) === 'supports trunk1.2 angle3' &&
      NSO3MF.objectName({ name: 'supports', supportKnobs: { trunkTipMm: 1.2, trunkAngleDeg: 3, leanDeg: 20, nodeMm: 4.25 } }, 0) === 'supports trunk1.2 angle3 lean20 node4.25',
      JSON.stringify(nd));
    const card = 'top_clip_x2 - support 1.1 (Tree)';
    check('the card\'s name keeps its shape (inside the bracket); no knobs, or only defaults, is the name as it was',
      NSO3MF.objectName({ name: card, supportKnobs: nd }, 0) === 'top_clip_x2 - support 1.1 (Tree trunk1.2 angle3)' &&
      NSO3MF.objectName({ name: card }, 0) === card && NSO3MF.objectName({ name: card, supportKnobs: {} }, 0) === card &&
      NSO3MF.objectName({ name: card, supportKnobs: (await kb(COUPON, DEF4)).p.knobs.nonDefault }, 0) === card &&
      / - support \d+\.\d+ \(/.test(NSO3MF.objectName({ name: card, supportKnobs: nd }, 0)));
    const idx = NSO3MF.indexTriangleSoup(Array.from(a.sh.solids[0].soup));
    const built = await NSO3MF.build3MF({ objects: [{ name: card, vertices: idx.vertices, triangles: idx.triangles, supportKnobs: nd }], plateName: 'Bambu A1 Mini' });
    const back = await R3.parse3MF(built.bytes, { name: 'knobs.3mf' });
    const plain = await NSO3MF.build3MF({ objects: [{ name: card, vertices: idx.vertices, triangles: idx.triangles }], plateName: 'Bambu A1 Mini' });
    const backPlain = await R3.parse3MF(plain.bytes, { name: 'plain.3mf' });
    check('the 3MF written for it reads back under that name; with no knobs, under the name as it was',
      back.objects[0].name === 'top_clip_x2 - support 1.1 (Tree trunk1.2 angle3)' && backPlain.objects[0].name === card,
      back.objects[0].name);
  }

  console.log('\n' + (fail ? `FAILED  ${fail} of ${pass + fail}` : `PASSED  all ${pass}`));
  if (fail) { console.log('  ' + FAILS.join('\n  ')); process.exit(1); }
})().catch(err => { console.error(err); process.exit(1); });
