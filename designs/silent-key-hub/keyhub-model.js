// Silent Key Hub - parametric model.
//
// One source of truth for the browser viewer (index.html) and the STL
// exporter (build-stl.mjs). Pass in an initialised manifold-3d module.
//
// Frames
//   World: Z up, hub centred on the Z axis, hub bottom at z = 0.
//   Station-local (u, v, w): u = radial (outward), v = up, w = tangential.
//   The origin of the local frame is the pivot axis of that station.
//   Station profiles are drawn in (u, v) and extruded along w.
//
// Mechanism (one station)
//   carrier  - printed part: a rounded-square cam around the pivot plus a
//              fork that clamps the key head with a pin through the key's
//              ring hole. Swings 0 deg (key hanging) to 90 deg (key out).
//   flexure  - leaf spring printed into the hub roof, pressing on the cam.
//              The flat faces of the cam give two stable positions.
//   stops    - 0 deg: fork back face meets the slot's back wall.
//              90 deg: fork top face meets the hood over the slot mouth.
//   pivot    - 3 mm steel dowel. Its ends ride in grooves in the slot walls
//              and are held at the top of the grooves by fingers on the
//              retainer plate, which is clamped on by the centre bolt.

export const PARAMS = [
  // group, key, label, default, min, max, step, unit
  ['Hub', 'stations', 'Key stations', 8, 4, 12, 1, ''],
  ['Hub', 'hubDiameter', 'Hub diameter', 64, 50, 90, 0.5, 'mm'],
  ['Hub', 'hubHeight', 'Hub height', 19, 14, 30, 0.5, 'mm'],
  ['Hub', 'pivotRadius', 'Pivot radius', 22, 14, 40, 0.5, 'mm'],
  ['Hub', 'pivotHeight', 'Pivot height', 11, 7, 20, 0.5, 'mm'],
  ['Hub', 'slotClear', 'Slot side clearance', 0.25, 0.1, 0.6, 0.05, 'mm'],
  ['Hub', 'boltDia', 'Centre bolt hole', 5.3, 3.2, 8.5, 0.1, 'mm'],
  ['Carrier', 'carrierWidth', 'Carrier width', 6, 4.5, 9, 0.1, 'mm'],
  ['Carrier', 'camSize', 'Cam size', 9, 7, 12, 0.1, 'mm'],
  ['Carrier', 'camRound', 'Cam corner radius', 1.5, 0.6, 3, 0.1, 'mm'],
  ['Carrier', 'forkHalf', 'Fork half-length', 3, 2.2, 4.5, 0.1, 'mm'],
  ['Carrier', 'keyPinDrop', 'Pivot to key pin', 17.5, 12, 26, 0.5, 'mm'],
  ['Carrier', 'keyPinDia', 'Key pin hole', 2.2, 1.6, 3.2, 0.1, 'mm'],
  ['Carrier', 'dowelDia', 'Pivot dowel', 3, 2, 4, 0.1, 'mm'],
  ['Flexure', 'beamThick', 'Leaf thickness', 1.4, 0.8, 2.4, 0.1, 'mm'],
  ['Flexure', 'beamRootRadius', 'Leaf root radius', 12, 6, 30, 0.5, 'mm'],
  ['Flexure', 'beamPreload', 'Leaf preload', 0.1, 0, 0.5, 0.05, 'mm'],
  ['Flexure', 'beamSideGap', 'Leaf side gap', 0.4, 0.2, 0.8, 0.05, 'mm'],
  ['Key', 'keyThick', 'Key thickness', 2.3, 1.6, 3.2, 0.05, 'mm'],
  ['Key', 'keyHeadWidth', 'Key head width', 24, 16, 34, 0.5, 'mm'],
  ['Key', 'keyHeadHeight', 'Key head height', 22, 14, 32, 0.5, 'mm'],
  ['Key', 'keyHoleToTop', 'Ring hole to head top', 4, 2.5, 8, 0.25, 'mm'],
  ['Key', 'keyBladeLength', 'Blade length', 30, 15, 50, 0.5, 'mm'],
  ['Retainer', 'retainerThick', 'Retainer thickness', 2, 1.2, 4, 0.1, 'mm'],
];

export const DEFAULTS = Object.fromEntries(PARAMS.map((p) => [p[1], p[3]]));

const SEG = 48;
const BIG = 400;

// Numbers derived from the parameters. Everything here is plain math, so the
// viewer can show it without touching the CSG.
export function derive(p) {
  const P = { ...DEFAULTS, ...p };
  const d = {};
  d.R = P.hubDiameter / 2;
  d.zp = P.pivotHeight;
  d.vTop = P.hubHeight - P.pivotHeight; // hub top, in station frame
  d.vBot = -P.pivotHeight; // hub bottom, in station frame
  d.slotW = P.carrierWidth + 2 * P.slotClear;
  d.camHalf = P.camSize / 2;
  d.camCorner = (d.camHalf - P.camRound) * Math.SQRT2 + P.camRound; // swept radius
  d.camCut = d.camCorner + 0.3;
  d.stopGap = 0.25;
  d.forkBack = -(P.forkHalf + d.stopGap); // slot back wall (0 deg stop)
  d.hoodV = P.forkHalf + d.stopGap; // hood underside (90 deg stop)
  d.uOuter = d.R - P.pivotRadius; // hub rim, in station frame
  d.beamBot = d.camHalf - P.beamPreload;
  d.beamTopV = d.beamBot + P.beamThick;
  d.beamRootU = P.beamRootRadius - P.pivotRadius;
  d.beamTipU = d.camHalf - 1;
  d.beamLen = d.beamTipU - d.beamRootU;
  d.beamRelief = 0.6;
  d.dowelR = P.dowelDia / 2;
  d.grooveHalf = d.dowelR + 0.1;
  d.grooveDepth = 1.75;
  d.dowelLen = d.slotW + 2 * d.grooveDepth - 0.5;
  d.keyPinV = -P.keyPinDrop;
  d.keySlotW = P.keyThick + 0.4;
  d.keyHeadTopV = d.keyPinV + P.keyHoleToTop;
  d.keySlotTopV = d.keyHeadTopV + 0.2;
  d.forkBottomV = d.keyPinV - Math.max(3, P.keyPinDia / 2 + 2);
  d.retBotV = d.vBot - P.retainerThick;
  // Leaf spring: tip deflection when a cam corner passes under it, and the
  // peak bending strain of a cantilever with that tip deflection.
  d.detentTravel = d.camCorner - d.camHalf + P.beamPreload;
  d.beamStrain = (3 * P.beamThick * d.detentTravel) / (2 * d.beamLen * d.beamLen);
  d.beamPreloadForce = beamForce(P, d, P.beamPreload);
  d.beamPeakForce = beamForce(P, d, d.detentTravel);
  // Wall left between neighbouring slots at the leaf root (thinnest place).
  const pitchAt = (r) => 2 * r * Math.sin(Math.PI / P.stations);
  d.wallAtRoot = pitchAt(P.beamRootRadius) - d.slotW;
  d.wallAtCam = pitchAt(P.pivotRadius + d.forkBack) - (d.slotW + 2 * d.grooveDepth);
  d.hoodDepth = d.uOuter - d.camCut;
  d.keySweepR = Math.hypot(P.keyHeadWidth / 2, P.keyPinDrop + P.keyHeadHeight - P.keyHoleToTop);
  d.overallDrop = P.keyPinDrop + (P.keyHeadHeight - P.keyHoleToTop) + P.keyBladeLength - P.pivotHeight;
  return { P, d };
}

// Cantilever end load for tip deflection x (PETG, E ~ 2000 MPa).
function beamForce(P, d, x) {
  const E = 2000;
  const b = d.slotW - 2 * P.beamSideGap;
  const I = (b * P.beamThick ** 3) / 12;
  return (3 * E * I * x) / d.beamLen ** 3; // N
}

// How far the cam pushes the leaf up at carrier angle a (deg). Two flats
// (0 and 90 deg) give zero lift beyond the preload; 45 deg is the peak.
export function leafLift(p, a) {
  const { P, d } = derive(p);
  const t = (a * Math.PI) / 180;
  const top = (d.camHalf - P.camRound) * (Math.abs(Math.cos(t)) + Math.abs(Math.sin(t))) + P.camRound;
  return Math.max(0, top - d.beamBot);
}

// Sanity checks that need no CSG. Each: [level, message].
export function lint(p) {
  const { P, d } = derive(p);
  const out = [];
  const strainPct = d.beamStrain * 100;
  if (strainPct > 3) out.push(['bad', `Leaf strain ${strainPct.toFixed(1)}% - PETG will take a set. Make the leaf longer or thinner.`]);
  else if (strainPct > 2) out.push(['warn', `Leaf strain ${strainPct.toFixed(1)}% - OK in PETG, marginal in PLA.`]);
  if (d.beamLen < 8) out.push(['bad', `Leaf is only ${d.beamLen.toFixed(1)} mm long. Move the root inward.`]);
  if (d.wallAtRoot < 1.2) out.push(['bad', `Wall between leaf windows is ${d.wallAtRoot.toFixed(2)} mm at the root. Fewer stations or a larger root radius.`]);
  if (d.wallAtCam < 1.2) out.push(['bad', `Wall between slots is ${d.wallAtCam.toFixed(2)} mm at the cam. Fewer stations or a larger pivot radius.`]);
  if (d.hoodDepth < 2) out.push(['bad', `Hood over the slot mouth is ${d.hoodDepth.toFixed(1)} mm deep - the 90 deg stop has nothing to land on. Move the pivot inward or grow the hub.`]);
  if (d.beamTopV > d.vTop - 0.4) out.push(['bad', 'Leaf pokes through the hub top. Raise the hub or lower the pivot.']);
  if (d.camCut > P.pivotHeight - 0.8) out.push(['warn', 'Cam pocket nearly breaks through the hub bottom.']);
  if (d.keyHeadTopV > d.retBotV - 0.3) out.push(['bad', 'Key head top is inside the hub/retainer - increase "Pivot to key pin".']);
  if (P.carrierWidth - d.keySlotW < 2.4) out.push(['bad', `Fork cheeks are ${((P.carrierWidth - d.keySlotW) / 2).toFixed(2)} mm - too thin.`]);
  if (P.beamRootRadius < P.boltDia / 2 + 3) out.push(['warn', 'Leaf root is close to the centre bolt.']);
  return out;
}

// --------------------------------------------------------------------------

export function build(wasm, params = {}, opts = {}) {
  const { Manifold, CrossSection } = wasm;
  const { P, d } = derive(params);
  const trash = [];
  const keep = (m) => (trash.push(m), m);

  const rect = (u0, u1, v0, v1) =>
    keep(CrossSection.square([u1 - u0, v1 - v0]).translate([u0, v0]));
  const circ = (r, u = 0, v = 0) => keep(CrossSection.circle(r, SEG).translate([u, v]));
  const roundSq = (s, r) => keep(keep(CrossSection.square([s - 2 * r, s - 2 * r], true)).offset(r, 'Round', 2, SEG));
  const union2 = (xs) => keep(CrossSection.union(xs));
  const ext = (cs, w) => keep(cs.extrude(w, 0, 0, [1, 1], true)); // centred on w = 0
  const box = (u0, u1, v0, v1, w0, w1) =>
    keep(Manifold.cube([u1 - u0, v1 - v0, w1 - w0]).translate([u0, v0, w0]));

  // Station-local -> world. (u,v,w) -> rotate about X by 90 -> (u,-w,v), then
  // move out to the pivot and spin to the station angle.
  const place = (m, i) =>
    keep(keep(keep(m.rotate([90, 0, 0])).translate([P.pivotRadius, 0, d.zp])).rotate([0, 0, (360 * i) / P.stations]));

  // ---- hub ----------------------------------------------------------------
  const slotProfile = union2([
    circ(d.camCut),
    rect(d.forkBack, BIG, -BIG, d.hoodV), // fork sweep + open bottom
    rect(d.beamRootU, d.camCut, d.beamBot, BIG), // leaf window (open to the top)
    rect(d.beamRootU, 0, d.beamBot - d.beamRelief, d.beamBot), // relief under the leaf
  ]);
  const slotCut = ext(slotProfile, d.slotW);
  const grooveCut = ext(union2([circ(d.grooveHalf), rect(-d.grooveHalf, d.grooveHalf, -BIG, 0)]), d.slotW + 2 * d.grooveDepth);
  const leafW = d.slotW - 2 * P.beamSideGap;
  const leaf = box(d.beamRootU - 1, d.beamTipU, d.beamBot, d.beamTopV, -leafW / 2, leafW / 2);
  const stationCut = keep(keep(slotCut.add(grooveCut)).subtract(leaf));

  const cuts = [];
  for (let i = 0; i < P.stations; i++) cuts.push(place(stationCut, i));
  const hubBlank = keep(Manifold.cylinder(P.hubHeight, d.R, d.R, SEG * 3));
  // small chamfer on the top edge
  const chamfer = keep(Manifold.cylinder(1, d.R + 1, d.R, SEG * 3).translate([0, 0, P.hubHeight - 1]));
  const ring = keep(keep(Manifold.cylinder(1, d.R + 5, d.R + 5, SEG * 3).translate([0, 0, P.hubHeight - 1])).subtract(chamfer));
  const bolt = keep(Manifold.cylinder(P.hubHeight * 3, P.boltDia / 2, P.boltDia / 2, SEG, true));
  const hub = keep(Manifold.difference([hubBlank, ring, bolt, ...cuts]));

  // ---- retainer -----------------------------------------------------------
  const retParts = [];
  const retDisc = keep(Manifold.cylinder(P.retainerThick, d.R, d.R, SEG * 3).translate([0, 0, -P.retainerThick]));
  const notches = [];
  const fingers = [];
  const fH = -d.dowelR - 0.1; // finger top, just under the dowel
  for (let i = 0; i < P.stations; i++) {
    const nb = keep(Manifold.cube([BIG, BIG, d.slotW], false).translate([d.forkBack, -BIG / 2, -d.slotW / 2]));
    notches.push(place(nb, i));
    for (const s of [-1, 1]) {
      const w0 = d.slotW / 2 + 0.15;
      const w1 = d.slotW / 2 + d.grooveDepth - 0.15;
      const f = box(-d.grooveHalf + 0.15, d.grooveHalf - 0.15, d.vBot - 0.01, fH, s > 0 ? w0 : -w1, s > 0 ? w1 : -w0);
      fingers.push(place(f, i));
    }
  }
  retParts.push(keep(Manifold.difference([retDisc, ...notches, bolt])));
  const retainer = keep(Manifold.union([...retParts, ...fingers]));

  // ---- carrier (local frame, angle 0 = key hanging) ------------------------
  const carrierProfile = keep(union2([roundSq(P.camSize, P.camRound), rect(-P.forkHalf, P.forkHalf, d.forkBottomV, 0)])
    .subtract(circ(d.dowelR + 0.15))
    .subtract(circ(P.keyPinDia / 2, 0, d.keyPinV)));
  const carrierRaw = ext(carrierProfile, P.carrierWidth);
  const keySlot = box(-BIG, BIG, -BIG, d.keySlotTopV, -d.keySlotW / 2, d.keySlotW / 2);
  const carrierLocal = keep(carrierRaw.subtract(keySlot));

  // ---- key (dummy, for fit and sweep checks) -------------------------------
  const hw = P.keyHeadWidth / 2;
  const headBot = d.keyHeadTopV - P.keyHeadHeight;
  const head = keep(rect(-hw, hw, headBot, d.keyHeadTopV).offset(-2.5, 'Round', 2, 24)).offset(2.5, 'Round', 2, 24);
  keep(head);
  const bw = 4;
  const bladeBot = headBot - P.keyBladeLength;
  let blade = rect(-bw, bw, bladeBot + 3, headBot + 1);
  const tip = keep(CrossSection.ofPolygons([[[-bw, bladeBot + 3], [bw, bladeBot + 3], [bw - 3, bladeBot], [-bw, bladeBot + 1]]]));
  blade = keep(blade.add(tip));
  // bitting
  const cutsK = [];
  for (let k = 0; k < 5; k++) {
    const v = headBot - 5 - k * ((P.keyBladeLength - 9) / 5);
    const depth = [1.2, 2.2, 0.8, 1.8, 1.4][k];
    cutsK.push(keep(CrossSection.ofPolygons([[[bw - depth, v], [bw + 0.1, v + 2.2], [bw + 0.1, v - 2.2]]])));
  }
  blade = keep(blade.subtract(union2(cutsK)));
  const shoulder = rect(-bw - 1.5, bw + 1.5, headBot - 1.5, headBot + 1);
  const keyProfile = keep(union2([head, blade, shoulder]).subtract(circ(2, 0, d.keyPinV)));
  const keyLocal = ext(keyProfile, P.keyThick);

  // ---- hardware -----------------------------------------------------------
  const dowelLocal = keep(Manifold.cylinder(d.dowelLen, d.dowelR, d.dowelR, 24, true));
  const keyPinLocal = keep(Manifold.cylinder(P.carrierWidth, P.keyPinDia / 2 - 0.1, P.keyPinDia / 2 - 0.1, 16, true).translate([0, d.keyPinV, 0]));
  const boltR = P.boltDia / 2 - 0.15;
  const eye = keep(Manifold.union([
    keep(Manifold.cylinder(P.hubHeight + P.retainerThick + 5, boltR, boltR, 24).translate([0, 0, -P.retainerThick - 5])),
    keep(Manifold.cylinder(2, boltR + 2.5, boltR + 2.5, 32).translate([0, 0, P.hubHeight])),
    torus(wasm, keep, 8, 2.4).rotate([90, 0, 0]).translate([0, 0, P.hubHeight + 2 + 8 + 1]),
  ]));
  const nut = keep(keep(Manifold.cylinder(4, (boltR + 2.6) / Math.cos(Math.PI / 6), (boltR + 2.6) / Math.cos(Math.PI / 6), 6)).translate([0, 0, -P.retainerThick - 4.3]));
  const washer = keep(keep(Manifold.cylinder(1, boltR + 4.5, boltR + 4.5, 32).subtract(keep(Manifold.cylinder(3, boltR + 0.3, boltR + 0.3, 24, true)))).translate([0, 0, -P.retainerThick - 1]));

  const res = {
    P, d,
    hub, retainer, eye, nut, washer,
    // Local parts the viewer poses per station (via placeAt below).
    carrierLocal, keyLocal, dowelLocal, keyPinLocal,
    // Flexure tip patches, for colour-coding stations in the viewer.
    leafLocal: leaf,
    // Hub with the leaf springs cut away, so a viewer can draw them flexing.
    hubNoLeaf: () => {
      const boxes = [];
      for (let i = 0; i < P.stations; i++) {
        const b = box(d.beamRootU - 1, d.beamTipU + 0.01, d.beamBot - 0.01, d.beamTopV + 0.01, -leafW / 2 - 0.01, leafW / 2 + 0.01);
        boxes.push(place(b, i));
      }
      return keep(Manifold.difference([hub, ...boxes]));
    },
    leafTabLocal: box(d.beamTipU - 4, d.beamTipU, d.beamTopV - 0.02, d.beamTopV + 0.05, -leafW / 2, leafW / 2),
    placeAt: (m, i, angleDeg = 0) => place(keep(m.rotate([0, 0, angleDeg])), i),
    dispose: () => {
      for (const m of trash) { try { m.delete(); } catch (_) {} }
      trash.length = 0;
    },
  };
  return res;
}

function torus(wasm, keep, R, r) {
  const cs = keep(wasm.CrossSection.circle(r, 20).translate([R, 0]));
  return keep(wasm.Manifold.revolve(cs, 48));
}

// Clearance sweep: swing one station's carrier + key from 0 to 90 deg and
// measure overlap with the hub (leaf springs removed - they are meant to
// touch the cam), the retainer and the neighbouring stations' keys.
// Returns [{angle, volume}] and the worst value.
export function sweepCheck(wasm, model, station = 0, step = 5) {
  const { Manifold } = wasm;
  const { P, d } = model;
  const tmp = [];
  const t = (m) => (tmp.push(m), m);
  // Hub without leaves: subtract leaf volumes by intersecting the hub with
  // everything except the leaf boxes.
  const leafW = d.slotW - 2 * P.beamSideGap;
  const leafBoxes = [];
  for (let i = 0; i < P.stations; i++) {
    const b = t(Manifold.cube([d.beamLen + 1, P.beamThick + 0.02, leafW]).translate([d.beamRootU - 1, d.beamBot - 0.01, -leafW / 2]));
    leafBoxes.push(model.placeAt(b, i, 0));
  }
  const hubNoLeaf = t(Manifold.difference([model.hub, ...leafBoxes]));
  const others = [];
  for (let i = 0; i < P.stations; i++) {
    if (i === station) continue;
    others.push(model.placeAt(model.keyLocal, i, 0), model.placeAt(model.carrierLocal, i, 0));
  }
  const obstacle = t(Manifold.union([hubNoLeaf, model.retainer, ...others]));
  const rows = [];
  let worst = 0;
  for (let a = 0; a <= 90 + 1e-6; a += step) {
    const mover = t(Manifold.union([model.placeAt(model.carrierLocal, station, a), model.placeAt(model.keyLocal, station, a)]));
    const hit = t(mover.intersect(obstacle));
    const vol = hit.isEmpty() ? 0 : hit.volume();
    rows.push({ angle: a, volume: vol });
    worst = Math.max(worst, vol);
  }
  for (const m of tmp) { try { m.delete(); } catch (_) {} }
  return { rows, worst };
}

// Parts laid out the way they print (flat face on the bed, z >= 0).
export function printParts(wasm, model) {
  const { P, d } = model;
  const drop = (m) => {
    const bb = m.boundingBox();
    return m.translate([-(bb.min[0] + bb.max[0]) / 2, -(bb.min[1] + bb.max[1]) / 2, -bb.min[2]]);
  };
  // Hub upside down: the roof and leaf springs print first, slots open upward.
  const hub = drop(model.hub.rotate([180, 0, 0]));
  // Retainer as modelled: plate on the bed, fingers up.
  const retainer = drop(model.retainer);
  // Carrier standing on the cam's top flat, fork pointing up, so both cheeks
  // print as vertical walls and the key slot needs no support.
  const carrier = drop(model.carrierLocal.rotate([180, 0, 0]));
  void d;
  return { hub, retainer, carrier };
}

export function toSTL(mesh, name = 'part') {
  // ASCII is easy to diff; these parts are small.
  const { vertProperties: vp, triVerts: tv, numProp } = mesh;
  const lines = [`solid ${name}`];
  for (let i = 0; i < tv.length; i += 3) {
    const a = tv[i] * numProp, b = tv[i + 1] * numProp, c = tv[i + 2] * numProp;
    const ax = vp[a], ay = vp[a + 1], az = vp[a + 2];
    const bx = vp[b], by = vp[b + 1], bz = vp[b + 2];
    const cx = vp[c], cy = vp[c + 1], cz = vp[c + 2];
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    lines.push(` facet normal ${nx.toExponential(4)} ${ny.toExponential(4)} ${nz.toExponential(4)}`,
      '  outer loop',
      `   vertex ${ax.toFixed(4)} ${ay.toFixed(4)} ${az.toFixed(4)}`,
      `   vertex ${bx.toFixed(4)} ${by.toFixed(4)} ${bz.toFixed(4)}`,
      `   vertex ${cx.toFixed(4)} ${cy.toFixed(4)} ${cz.toFixed(4)}`,
      '  endloop', ' endfacet');
  }
  lines.push(`endsolid ${name}`);
  return lines.join('\n') + '\n';
}
