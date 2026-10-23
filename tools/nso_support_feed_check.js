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

  console.log('\n' + (fail ? `FAILED  ${fail} of ${pass + fail}` : `PASSED  all ${pass}`));
  if (fail) { console.log('  ' + FAILS.join('\n  ')); process.exit(1); }
})().catch(err => { console.error(err); process.exit(1); });
