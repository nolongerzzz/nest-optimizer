/* Skin wrap (several faces at once) and the double skin (layer 2, composed or
   free), every mesh through the canonical checker.
     node tools/nso_skin_wrap_test.js       exit 0 = every gate held

   Part 1 - the wrap
     a. the seam a wrap stands on: two ADJACENT faces of the cube close.
        Before this feature the same two passes left 28 open and 28
        non-manifold edges and 28 degenerate triangles - a side param
        recomputed from the float32 soup no longer matched the exact one that
        placed it, so the same seam point registered twice and the fan over
        it emitted a zero-length edge. Two opposite faces (no shared edge)
        always worked, which is why one face at a time never showed it.
     b. all six faces of the cube: ONE closed shell, Euler 2, 0 piercing,
        volume = cube + 6 x the single-face relief, bbox grown by 2 x height
        on every axis.
     c. refusals: a sphere stands the whole wrap down with the soup returned
        untouched; the hull's pocket face is named and skipped with
        skipUnskinnable, and the rest still closes.
   Part 2 - layer 2, composed (one shell)
     Two patterns in one pass, layer 2 on layer 1's tips: closed shell,
     tips at h1 + h2, volume analytic, and the contact measured against
     layer 1 alone - including the case where a second layer whose features
     line up with layer 1's changes nothing but the height.
     Also: the sequential route is refused, which is why composition happens
     in the height field.
   Part 3 - layer 2, free (its own shell)
     A sheet resting on layer 1's tips: two edge-connected shells, each
     closed on its own, sheet underside == layer 1's tips bit for bit,
     nonSolid reported. Control: gap 0.3 -> 0 piercing, 0 coplanar, shells
     0.3 apart.
   Part 4 - the two together: a wrapped, layered cube still closes. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const NSO_Skin = require('../nso_skin.js');
const { readSTL, writeSTL } = require('./nso_stl_io.js');

const ROOT = path.resolve(__dirname, '..');
const fx = f => path.join(ROOT, 'fixtures', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-skinwrap-'));

function meshValidate(file) {
  return JSON.parse(execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'],
    { encoding: 'utf8', maxBuffer: 64 << 20 }));
}
function validate(soup, tag) {
  const f = path.join(tmp, tag + '.stl');
  writeSTL(f, soup, tag);
  return meshValidate(f);
}
const summary = v => 'tris ' + v.triangles + ', open ' + v.open_edges + ', nm ' + v.nonmanifold_edges +
  ', euler ' + v.euler_characteristic + ', degen ' + v.degenerate_tris + ', vol ' + v.signed_volume.toFixed(3) +
  ', pierce ' + v.self_intersection.pierce + ', coplanar ' + v.self_intersection.coplanar +
  ', bbox ' + JSON.stringify(v.bbox_size);

/* Shells by shared EDGES (welded at 1e-4): two solids touching face to face
   share no edge, so this cannot glue them together by accident. */
function edgeShells(soup) {
  const n = soup.length / 9;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  const key = o => Math.round(soup[o] * 1e4) + '_' + Math.round(soup[o + 1] * 1e4) + '_' + Math.round(soup[o + 2] * 1e4);
  const owner = new Map();
  for (let t = 0; t < n; t++) {
    const k = [key(t * 9), key(t * 9 + 3), key(t * 9 + 6)];
    for (let e = 0; e < 3; e++) {
      const a = k[e], b = k[(e + 1) % 3];
      const ek = a < b ? a + '|' + b : b + '|' + a;
      if (owner.has(ek)) union(owner.get(ek), t); else owner.set(ek, t);
    }
  }
  const groups = new Map();
  for (let t = 0; t < n; t++) {
    const r = find(t);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(t);
  }
  return [...groups.values()].map(list => {
    let zmin = Infinity, zmax = -Infinity;
    const out = new Float32Array(list.length * 9);
    list.forEach((t, i) => {
      for (let k = 0; k < 9; k++) out[i * 9 + k] = soup[t * 9 + k];
      for (let k = 2; k < 9; k += 3) {
        if (soup[t * 9 + k] < zmin) zmin = soup[t * 9 + k];
        if (soup[t * 9 + k] > zmax) zmax = soup[t * 9 + k];
      }
    });
    return { tris: list.length, zmin, zmax, soup: out };
  }).sort((a, b) => a.zmin - b.zmin);
}
/* edges used a number of times other than twice, and triangles with a repeated
   vertex - the two symptoms the seam used to show */
function seamDefects(soup) {
  const n = soup.length / 9, cnt = new Map();
  const key = (t, k) => {
    const o = t * 9 + k * 3;
    return Math.round(soup[o] * 1e4) + '_' + Math.round(soup[o + 1] * 1e4) + '_' + Math.round(soup[o + 2] * 1e4);
  };
  let degenerate = 0;
  for (let t = 0; t < n; t++) {
    const k = [key(t, 0), key(t, 1), key(t, 2)];
    if (k[0] === k[1] || k[1] === k[2] || k[0] === k[2]) degenerate++;
    for (let e = 0; e < 3; e++) {
      const a = k[e], b = k[(e + 1) % 3];
      const ek = a < b ? a + '|' + b : b + '|' + a;
      cnt.set(ek, (cnt.get(ek) || 0) + 1);
    }
  }
  let odd = 0;
  cnt.forEach(c => { if (c !== 2) odd++; });
  return { odd, degenerate };
}

const cube = readSTL(fx('box-20mm.stl'));
const cubeV = meshValidate(fx('box-20mm.stl')).signed_volume;

/* ===================== Part 1: the wrap ===================== */
console.log('=== 1. Skin wrap - several faces of one piece ===');
console.log('\n--- the seam between two skinned faces ---');
{
  const one = NSO_Skin.applySkinToFace(cube, { dir: [0, 0, 1], pattern: 'crosshatch' });
  check('+Z alone still closes (the single-face contract is untouched)', one.ok, one.reason);
  const opp = NSO_Skin.applySkinToFace(one.tris, { dir: [0, 0, -1], pattern: 'crosshatch' });
  const vOpp = validate(opp.tris, 'opposite');
  check('two OPPOSITE faces: no shared edge, closed shell', opp.ok && vOpp.open_edges === 0 && vOpp.nonmanifold_edges === 0 && vOpp.euler_characteristic === 2, summary(vOpp));

  const adj = NSO_Skin.applySkinToFace(one.tris, { dir: [1, 0, 0], pattern: 'crosshatch' });
  check('+X after +Z applies', adj.ok, adj.reason);
  const dAdj = seamDefects(adj.tris);
  const vAdj = validate(adj.tris, 'adjacent');
  console.log('    ' + summary(vAdj));
  check('two ADJACENT faces: 0 edges used other than twice (was 56)', dAdj.odd === 0, dAdj.odd);
  check('two ADJACENT faces: 0 degenerate triangles (was 28)', dAdj.degenerate === 0 && vAdj.degenerate_tris === 0, dAdj.degenerate);
  check('two ADJACENT faces: 0 open, 0 non-manifold (was 28 and 28), Euler 2',
    vAdj.open_edges === 0 && vAdj.nonmanifold_edges === 0 && vAdj.euler_characteristic === 2);
  check('two ADJACENT faces: 0 piercing, 0 coplanar, consistent winding',
    vAdj.self_intersection.pierce === 0 && vAdj.self_intersection.coplanar === 0 && vAdj.inconsistent_winding_edges === 0);
  check('a face skinned on its own inserts nothing into its own relief', one.reliefTrisFanned === 0, one.reliefTrisFanned);
  check('two faces with the SAME pattern land their seam points together, so nothing is inserted',
    adj.reliefTrisFanned === 0, adj.reliefTrisFanned);

  /* The other half of the seam. Two faces with the same pattern on a cube
     break their shared edge at the same params, so the relief perimeters
     already meet. Two DIFFERENT patterns do not, and then the second face's
     relief has to be subdivided at the first's points: without that pass the
     same pair leaves 82 edges used other than twice, measured. */
  const mixed = NSO_Skin.applySkinToFace(one.tris, { dir: [1, 0, 0], pattern: 'zigzag' });
  check('+X zigzag after +Z crosshatch applies', mixed.ok, mixed.reason);
  check('the +Z relief was re-fanned where the +X seam runs through it', mixed.reliefTrisFanned > 0, mixed.reliefTrisFanned);
  const dMix = seamDefects(mixed.tris);
  const vMix = validate(mixed.tris, 'adjacentMixed');
  console.log('    ' + summary(vMix));
  check('two adjacent faces, DIFFERENT patterns: 0 odd edges (was 82), 0 degenerate', dMix.odd === 0 && dMix.degenerate === 0, JSON.stringify(dMix));
  check('two adjacent faces, DIFFERENT patterns: closed shell, 0 piercing',
    vMix.open_edges === 0 && vMix.nonmanifold_edges === 0 && vMix.euler_characteristic === 2 && vMix.self_intersection.pierce === 0);

  /* and on a piece whose faces are not the same size either */
  const hull = readSTL(fx('box_hull_80x40x20-2.stl'));
  const h1 = NSO_Skin.applySkinToFace(hull, { dir: [0, 0, 1], pattern: 'crosshatch' });
  const h2 = h1.ok ? NSO_Skin.applySkinToFace(h1.tris, { dir: [0, 1, 0], pattern: 'zigzag' }) : { ok: false };
  const dH = h2.ok ? seamDefects(h2.tris) : null;
  check('the hull, +Z crosshatch then +Y zigzag: 0 odd edges over a 115-point seam',
    h2.ok && dH.odd === 0 && dH.degenerate === 0 && h2.reliefTrisFanned > 100,
    h2.ok ? (JSON.stringify(dH) + ', relief re-fanned ' + h2.reliefTrisFanned) : h2.reason);
}

console.log('\n--- all six faces of the cube ---');
{
  const one = NSO_Skin.applySkinToFace(cube, { dir: [0, 0, 1], pattern: 'crosshatch' });
  const reliefV = one.tipArea * one.tipHeight;
  const w = NSO_Skin.applySkinWrap(cube, { pattern: 'crosshatch' });
  check('wrap applies to all six faces', w.ok && w.count === 6 && w.asked === 6, w.reason || (w.count + ' of ' + w.asked));
  check('the six faces are named in order', w.faces.map(f => f.name).join(',') === '+Z,-Z,+X,-X,+Y,-Y', w.faces.map(f => f.name).join(','));
  const v = validate(w.tris, 'wrap6');
  console.log('    ' + summary(v));
  check('one closed shell (0 open, 0 non-manifold, Euler 2)', v.open_edges === 0 && v.nonmanifold_edges === 0 && v.euler_characteristic === 2);
  check('0 piercing, 0 coplanar, 0 degenerate, consistent winding',
    v.self_intersection.pierce === 0 && v.self_intersection.coplanar === 0 && v.degenerate_tris === 0 && v.inconsistent_winding_edges === 0);
  check('volume = cube + 6 x the single-face relief (1e-3)', near(v.signed_volume, cubeV + 6 * reliefV, 1e-3),
    v.signed_volume.toFixed(4) + ' vs ' + (cubeV + 6 * reliefV).toFixed(4));
  check('bbox grew by the skin height on BOTH ends of every axis (20 -> 21.2)',
    v.bbox_size.every(s => near(s, 20 + 2 * 0.6, 1e-5)), JSON.stringify(v.bbox_size));
  check('total contact = 6 x one face\'s', near(w.tipArea, 6 * one.tipArea, 1e-3), w.tipArea.toFixed(3));
  check('every face reports its own tips 0.6 above its own base',
    w.faces.every(f => near(f.tipsPlane - f.basePlane, 0.6, 1e-9)), w.faces.map(f => (f.tipsPlane - f.basePlane).toFixed(3)).join(','));
  check('the wrap is still one shell, not six', w.shells === 1 && !w.nonSolid);
}

console.log('\n--- a subset of faces, and the other patterns ---');
{
  const two = NSO_Skin.applySkinWrap(cube, { pattern: 'zigzag', faces: [{ dir: [0, 0, 1] }, { dir: [0, 0, -1] }] });
  const v = validate(two.tris, 'wrap2zig');
  check('an explicit two-face list, zigzag: applies and closes', two.ok && two.count === 2 && v.open_edges === 0 && v.euler_characteristic === 2, two.reason || summary(v));
  const ring = NSO_Skin.applySkinWrap(cube, { pattern: 'ring', faces: [{ dir: [0, 0, 1] }, { dir: [1, 0, 0] }] });
  const vr = validate(ring.tris, 'wrap2ring');
  check('ring on two adjacent faces: applies and closes', ring.ok && vr.open_edges === 0 && vr.nonmanifold_edges === 0 && vr.euler_characteristic === 2, ring.reason || summary(vr));
  const rec = NSO_Skin.applySkinWrap(cube, { pattern: 'crosshatch', mode: 'recess' });
  const vrec = rec.ok ? validate(rec.tris, 'wrap6recess') : null;
  check('recess wraps all six faces and stays closed, bbox unchanged',
    rec.ok && vrec.open_edges === 0 && vrec.euler_characteristic === 2 && vrec.bbox_size.every(s => near(s, 20, 1e-5)),
    rec.reason || summary(vrec));
}

console.log('\n--- refusals: never a half-wrap ---');
{
  const sphere = readSTL(fx('fixture_sphere_curved.stl'));
  const ws = NSO_Skin.applySkinWrap(sphere, { pattern: 'crosshatch' });
  check('a curved piece stands the wrap down, soup returned as is', !ws.ok && ws.tris === sphere, ws.reason);
  check('the refusal names the face that refused', /^the \+Z face refused: /.test(ws.reason) && ws.faceRefused === '+Z', ws.reason);
  const wsSkip = NSO_Skin.applySkinWrap(sphere, { pattern: 'crosshatch', skipUnskinnable: true });
  check('skipUnskinnable on a sphere: nothing to wrap, soup returned as is', !wsSkip.ok && wsSkip.tris === sphere && wsSkip.skipped.length === 6, wsSkip.reason);

  const hull = readSTL(fx('box_hull_80x40x20-2.stl'));
  const wh = NSO_Skin.applySkinWrap(hull, { pattern: 'crosshatch' });
  check('the hull\'s pocket face stands a strict wrap down, hull untouched', !wh.ok && wh.tris === hull, wh.reason);
  const whs = NSO_Skin.applySkinWrap(hull, { pattern: 'crosshatch', skipUnskinnable: true });
  check('with skipUnskinnable the other five faces wrap', whs.ok && whs.count === 5 && whs.skipped.length === 1, whs.reason || (whs.count + ', skipped ' + JSON.stringify(whs.skipped.map(x => x.name))));
  check('the skipped face is named with its reason', whs.ok && whs.skipped[0].name === '-X' && /not a single loop|not a rectangle/.test(whs.skipped[0].reason), whs.ok && (whs.skipped[0].name + ': ' + whs.skipped[0].reason));
  if (whs.ok) {
    const v = validate(whs.tris, 'wrapHull');
    console.log('    ' + summary(v));
    check('the five-face hull wrap is one closed shell, 0 piercing', v.open_edges === 0 && v.nonmanifold_edges === 0 && v.euler_characteristic === 2 && v.self_intersection.pierce === 0);
  }
  const wnone = NSO_Skin.applySkinWrap(cube, { pattern: 'crosshatch', faces: [] });
  check('an empty face list is refused', !wnone.ok && wnone.tris === cube, wnone.reason);
}

/* ============== Part 2: layer 2, composed into one shell ============== */
console.log('\n=== 2. Double skin - layer 2 composed onto layer 1\'s tips ===');
console.log('\n--- the sequential route, which is why composition is a height field ---');
{
  const one = NSO_Skin.applySkinToFace(cube, { dir: [0, 0, 1], pattern: 'crosshatch' });
  const again = NSO_Skin.applySkinToFace(one.tris, { dir: [0, 0, 1], pattern: 'zigzag' });
  check('skinning an already-skinned face is refused, soup returned as is', !again.ok && again.tris === one.tris, again.reason);
  check('the reason is the one the architecture gives: the tips are not one loop',
    /face boundary is not a single loop/.test(again.reason), again.reason);
  const atTips = NSO_Skin.applySkinToFace(one.tris, { dir: [0, 0, 1], plane: one.tipsPlane, pattern: 'zigzag' });
  check('naming the tips plane explicitly does not help either', !atTips.ok, atTips.reason);
}

console.log('\n--- composed: one shell, tips at h1 + h2 ---');
{
  const r = NSO_Skin.applySkinToFace(cube, { dir: [0, 0, 1], pattern: 'crosshatch', layer2: { pattern: 'zigzag' } });
  check('crosshatch + zigzag applies', r.ok, r.reason);
  check('it reports two layers, one shell, and no non-solid claim', r.layers === 2 && r.shells === 1 && !r.nonSolid);
  const v = validate(r.tris, 'composed');
  console.log('    ' + summary(v));
  check('one closed shell (0 open, 0 non-manifold, Euler 2)', v.open_edges === 0 && v.nonmanifold_edges === 0 && v.euler_characteristic === 2);
  check('0 piercing, 0 coplanar, 0 degenerate', v.self_intersection.pierce === 0 && v.self_intersection.coplanar === 0 && v.degenerate_tris === 0);
  check('tips stand at h1 + h2 = 0.9 above the face', near(r.tipHeight, 0.9, 1e-9) && near(r.tipsPlane, 10.9, 1e-9), r.tipHeight);
  check('bbox grew by 0.9, not 0.6', near(v.bbox_size[2], 20.9, 1e-5), v.bbox_size[2]);
  /* A zigzag layer 2 is a trapezoid, so it adds MORE than its crests x h2
     (the flanks) and less than filling every layer-1 tip cell to h2. Bounds,
     not an identity - the identity is the flat-prism pair below. */
  const added = v.signed_volume - (cubeV + r.layer1TipArea * 0.6);
  check('the trapezoid layer 2 adds more than its crests and less than a full fill',
    added > r.tipArea * 0.3 && added < r.layer1TipArea * 0.3,
    added.toFixed(3) + ' in (' + (r.tipArea * 0.3).toFixed(3) + ', ' + (r.layer1TipArea * 0.3).toFixed(3) + ')');
  const flat = NSO_Skin.applySkinToFace(cube, { dir: [0, 0, 1], pattern: 'crosshatch', layer2: { pattern: 'crosshatch' } });
  const vFlat = validate(flat.tris, 'composedFlat');
  const expect = cubeV + flat.layer1TipArea * 0.6 + flat.tipArea * 0.3;
  check('two flat-prism layers: volume = cube + layer1 x h1 + composite x h2 (analytic, 1e-3)',
    near(vFlat.signed_volume, expect, 1e-3), vFlat.signed_volume.toFixed(4) + ' vs ' + expect.toFixed(4));
  check('the contact shrank: composite < layer 1 alone', r.tipArea < r.layer1TipArea,
    r.tipArea.toFixed(2) + ' of ' + r.layer1TipArea.toFixed(2) + ' mm² (' + (r.layer2.contactRatio * 100).toFixed(1) + '%)');
  check('a zigzag second layer cuts the contact to under 40%', r.layer2.contactRatio < 0.4, (r.layer2.contactRatio * 100).toFixed(1) + '%');
}

console.log('\n--- what a second layer does NOT do, stated as a gate ---');
{
  /* layer 2 at layer 1's own parameters lands on layer 1's own features */
  const same = NSO_Skin.applySkinToFace(cube, { dir: [0, 0, 1], pattern: 'crosshatch',
    layer2: { pattern: 'crosshatch', params: { pitch: 1.2, rib: 0.42, height: 0.3, margin: 1.2 } } });
  check('layer 2 at layer 1\'s parameters leaves the contact EXACTLY where it was', same.ok && near(same.layer2.contactRatio, 1, 1e-9),
    same.ok && (same.layer1TipArea.toFixed(2) + ' -> ' + same.tipArea.toFixed(2) + ' mm²'));
  check('...and only makes the relief taller, which the result says out loud', same.ok && near(same.tipHeight, 0.9, 1e-9), same.ok && same.tipHeight);
  const v = validate(same.tris, 'composedSame');
  check('that case is still a closed shell', v.open_edges === 0 && v.euler_characteristic === 2, summary(v));
  const dflt = NSO_Skin.applySkinToFace(cube, { dir: [0, 0, 1], pattern: 'crosshatch', layer2: { pattern: 'crosshatch' } });
  check('the stated crosshatch layer-2 default does shrink it, but only to ~84%',
    dflt.ok && dflt.layer2.contactRatio > 0.75 && dflt.layer2.contactRatio < 0.9, dflt.ok && (dflt.layer2.contactRatio * 100).toFixed(1) + '%');
}

console.log('\n--- composed refusals ---');
{
  const ring1 = NSO_Skin.applySkinToFace(cube, { dir: [0, 0, 1], pattern: 'ring', layer2: { pattern: 'crosshatch' } });
  check('ring as layer 1 of a composed pair is refused and says why', !ring1.ok && /two grid patterns/.test(ring1.reason) && ring1.tris === cube, ring1.reason);
  const ring2 = NSO_Skin.applySkinToFace(cube, { dir: [0, 0, 1], pattern: 'crosshatch', layer2: { pattern: 'ring' } });
  check('ring as a composed layer 2 is refused too', !ring2.ok && /two grid patterns/.test(ring2.reason), ring2.reason);
  const rec = NSO_Skin.applySkinToFace(cube, { dir: [0, 0, 1], pattern: 'crosshatch', mode: 'recess', params: { margin: 1.2 }, layer2: { pattern: 'zigzag' } });
  check('a composed layer 2 in recess mode is refused (it is built on the tips)', !rec.ok && /raise-only/.test(rec.reason), rec.reason);
  const bad = NSO_Skin.applySkinToFace(cube, { dir: [0, 0, 1], pattern: 'crosshatch', layer2: { pattern: 'nope' } });
  check('an unknown layer-2 pattern is refused', !bad.ok && bad.tris === cube, bad.reason);
  const off = NSO_Skin.applySkinToFace(cube, { dir: [0, 0, 1], pattern: 'crosshatch', layer2: { pattern: 'off' } });
  check('layer2 "off" is one layer, as if it had not been passed', off.ok && off.layers === 1 && !off.layer2);
}

/* ============== Part 3: layer 2, free - its own shell ============== */
console.log('\n=== 3. Double skin - a FREE layer 2, its own shell ===');
{
  const r = NSO_Skin.applySkinToFace(cube, { dir: [0, 0, 1], pattern: 'crosshatch', layer2: { pattern: 'crosshatch', free: true } });
  check('a free layer 2 applies', r.ok, r.reason);
  check('it reports two shells and asks for the non-solid flag', r.shells === 2 && r.nonSolid === true && r.freeLayer.nonSolid === true);
  const v = validate(r.tris, 'free');
  console.log('    ' + summary(v));
  check('0 open, 0 non-manifold, Euler 4 - two closed shells', v.open_edges === 0 && v.nonmanifold_edges === 0 && v.euler_characteristic === 4, summary(v));
  const shells = edgeShells(r.tris);
  check('exactly two edge-connected shells', shells.length === 2, shells.length);
  if (shells.length === 2) {
    const vPiece = validate(shells[0].soup, 'freePiece');
    const vSheet = validate(shells[1].soup, 'freeSheet');
    check('the piece alone is closed (Euler 2, 0 piercing)', vPiece.open_edges === 0 && vPiece.euler_characteristic === 2 && vPiece.self_intersection.pierce === 0, summary(vPiece));
    check('the free layer alone is closed (Euler 2, 0 piercing)', vSheet.open_edges === 0 && vSheet.euler_characteristic === 2 && vSheet.self_intersection.pierce === 0, summary(vSheet));
    check('the sheet\'s underside sits on layer 1\'s tips, bit for bit', shells[1].zmin === shells[0].zmax, shells[1].zmin + ' vs ' + shells[0].zmax);
    check('layer 1\'s tips are 0.6 above the face, as they were alone', near(r.layer1TipsPlane, 10.6, 1e-9), r.layer1TipsPlane);
    check('the piece shell is 20.6 tall, the free layer 1.2 (0.6 sheet + 0.6 relief)',
      near(shells[0].zmax - shells[0].zmin, 20.6, 1e-5) && near(shells[1].zmax - shells[1].zmin, 1.2, 1e-5),
      (shells[0].zmax - shells[0].zmin).toFixed(4) + ' / ' + (shells[1].zmax - shells[1].zmin).toFixed(4));
  }
  check('tipsPlane now reports the OUTERMOST contact - the free layer\'s tips', near(r.tipsPlane, 11.8, 1e-5), r.tipsPlane);
  check('layer 1\'s own tips stay on the result for the record', near(r.layer1TipsPlane, 10.6, 1e-9) && r.layer1TipArea > 0);
  /* the free layer's volume: the sheet plus its own relief */
  const fl = r.freeLayer;
  check('the sheet is inset to layer 1\'s margin, so its walls stay out of the piece\'s face planes',
    near(fl.inset, 1.2, 1e-9), fl.inset);
  const span = 20 - 2 * fl.inset;
  const sheetV = span * span * fl.sheet + fl.tipArea * fl.params.height;
  const oneV = cubeV + r.layer1TipArea * 0.6;
  check('volume = the skinned piece + the sheet + the sheet\'s relief (1e-3)', near(v.signed_volume, oneV + sheetV, 1e-3),
    v.signed_volume.toFixed(4) + ' vs ' + (oneV + sheetV).toFixed(4));
}

console.log('\n--- the free layer lifted clear: the control ---');
{
  const r = NSO_Skin.applySkinToFace(cube, { dir: [0, 0, 1], pattern: 'crosshatch', layer2: { pattern: 'crosshatch', free: true, gap: 0.3 } });
  const v = validate(r.tris, 'freeGap');
  console.log('    ' + summary(v));
  check('gap 0.3: 0 piercing, 0 coplanar - nothing touches', r.ok && v.self_intersection.pierce === 0 && v.self_intersection.coplanar === 0, summary(v));
  const shells = edgeShells(r.tris);
  check('gap 0.3: the shells stand 0.3 apart, measured tips to sheet', shells.length === 2 && near(shells[1].zmin - shells[0].zmax, 0.3, 1e-5),
    shells.length === 2 ? (shells[1].zmin - shells[0].zmax).toFixed(6) : shells.length);
  check('gap 0.3: still Euler 4, two closed shells', v.euler_characteristic === 4 && v.open_edges === 0);
  const neg = NSO_Skin.applySkinToFace(cube, { dir: [0, 0, 1], pattern: 'crosshatch', layer2: { pattern: 'crosshatch', free: true, gap: -0.1 } });
  check('a negative gap is refused - it would sink the sheet into layer 1', !neg.ok && neg.tris === cube, neg.reason);
  const ring = NSO_Skin.applySkinToFace(cube, { dir: [0, 0, 1], pattern: 'ring', layer2: { pattern: 'ring', free: true } });
  check('ring carries a free layer, which composition cannot do', ring.ok && ring.shells === 2, ring.reason);
  const rec = NSO_Skin.applySkinToFace(cube, { dir: [0, 0, 1], pattern: 'crosshatch', mode: 'recess', params: { margin: 1.2 }, layer2: { pattern: 'crosshatch', free: true } });
  check('a free layer in recess mode is refused', !rec.ok && /raise-only/.test(rec.reason), rec.reason);
  const big = NSO_Skin.applySkinToFace(cube, { dir: [0, 0, 1], pattern: 'crosshatch', layer2: { pattern: 'crosshatch', free: true, inset: 10 } });
  check('an inset that leaves no sheet is refused', !big.ok && /leaves no sheet/.test(big.reason), big.reason);
}

/* ============== Part 4: both at once ============== */
console.log('\n=== 4. A wrapped, layered cube ===');
{
  const w = NSO_Skin.applySkinWrap(cube, { pattern: 'crosshatch', layer2: { pattern: 'zigzag' } });
  check('six faces, each with a composed layer 2', w.ok && w.count === 6 && w.layers === 2, w.reason);
  const v = validate(w.tris, 'wrapLayered');
  console.log('    ' + summary(v));
  check('still ONE closed shell (0 open, 0 non-manifold, Euler 2)', v.open_edges === 0 && v.nonmanifold_edges === 0 && v.euler_characteristic === 2);
  check('0 piercing, 0 coplanar, 0 degenerate', v.self_intersection.pierce === 0 && v.self_intersection.coplanar === 0 && v.degenerate_tris === 0);
  check('bbox grew by 0.9 on both ends of every axis', v.bbox_size.every(s => near(s, 21.8, 1e-5)), JSON.stringify(v.bbox_size));

  const wf = NSO_Skin.applySkinWrap(cube, { pattern: 'crosshatch', faces: [{ dir: [0, 0, 1] }, { dir: [1, 0, 0] }], layer2: { pattern: 'crosshatch', free: true } });
  check('two faces with a free layer each: three shells, non-solid', wf.ok && wf.shells === 3 && wf.nonSolid === true, wf.reason || wf.shells);
  const vf = validate(wf.tris, 'wrapFree');
  check('three closed shells (Euler 6), 0 open', vf.open_edges === 0 && vf.nonmanifold_edges === 0 && vf.euler_characteristic === 6, summary(vf));
  check('exactly three edge-connected shells', edgeShells(wf.tris).length === 3, edgeShells(wf.tris).length);
}

console.log('\nfiles: ' + tmp);
console.log(fails ? '\nFAIL ' + fails : '\nall gates held');
process.exit(fails ? 1 : 0);
