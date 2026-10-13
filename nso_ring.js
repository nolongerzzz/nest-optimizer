// ===================== Ring verbs: Outer, Bore, Wall (and a rod's Diameter) =====================
// Headless: no DOM, no Three.js, no app state. Runs under node for the
// self-test (tools/nso_ring_test.js) and under a classic script tag in the
// browser, where the Scale card's ring fields call it.
//
// THE RULE, decided: a dimension edit MOVES BOUNDARY FACES, it never scales,
// and on a ring the wall is preserved unless the wall is what is being edited.
// Each verb is one sentence about which faces move and by how much:
//
//   Outer Ø -> d   outer faces move out by dr = (d - outer)/2, and the bore
//                  faces move by the same dr. Wall held, length held.
//   Bore Ø -> d    bore faces move by dr = (d - bore)/2. Outer held; the wall
//                  changes by -dr.
//   Wall -> w      bore faces move by -(w - wall). Outer held.
//   Diameter -> d  (a rod: no bore) outer faces by dr, nothing else.
//
// "dr" is in the reader's own terms: the circle the outline's vertices sit on
// (nso_section.js), so the number the card shows after an apply is the number
// that was typed.
//
// WHICH FACES. A face parallel to the axis is a wall - the same per-triangle
// test Fatten uses, NSO_fattenCrossSectionFaces, so "parallel" means exactly
// what it means to Extend and Fatten. A wall faces AWAY from the axis (outer)
// or TOWARD it (bore), decided by its normal against the reader's centre.
// Every other face is held: the end caps are the planes that keep the length.
//
// WHY NOT _thickenOffsetSoup, measured rather than assumed. Fatten composes the
// axis detector with Thicken's offset and a face filter, and that was the
// first thing tried here: outer faces through _thickenOffsetSoup(mode 'out',
// mayMove = outer walls), bore faces through mode 'in'. It moves the right
// faces by the right amount - and the ring stops being an extrusion. One outer
// pass on MINI_TPU_TEST takes Extend's census along Z from 0% to 29.7%
// oblique. The cause is Thicken's vertex solve, which merges facets within 15
// degrees into one area-weighted plane: MINI_TPU_TEST's 48-gon has neighbouring
// facets 7.5 degrees apart, so they merge, and the top and bottom rim vertices of a wall
// quad see different triangle areas (a quad's diagonal gives one of them one
// triangle on a side and the other two), so the two land a hair apart in XY and
// the wall leans. After that the reader, Length and Extend all refuse the piece.
// The same is true of Fatten's output today; nothing re-reads it as an
// extrusion, so it has not shown.
//
// So the move is solved IN THE SECTION PLANE. Every wall face projects to a
// segment of the section; every distinct section point (one XY, shared by the
// top and bottom rims) gets ONE new position - where its neighbouring segments'
// offset lines meet - and every vertex at that XY takes it. Only the two
// section coordinates are ever written. That keeps every wall exactly parallel
// to the axis, every cap exactly planar, and the axial coordinate untouched
// bit for bit, which the gate below proves on every run the way Extend proves
// its cross-section.
//
// PAINT SCOPE is the caller's (app-scale.js): WHOLE-PIECE, for Fatten's reason.

var NSO_RING_PROBES = 3;          // correction passes: apply, re-read, correct
var NSO_RING_LAND_MM = 1e-6;      // stop correcting once this close to the ask

function NSO_ringFmt(x) { return String(+(+x).toFixed(3)); }

/* Per triangle: +1 outer wall, -1 bore wall, 0 held. */
function NSO_ringFaces(soup, axisIdx, center2) {
  var k = axisIdx, o = [0, 1, 2].filter(function (a) { return a !== k; });
  var par = NSO_fattenCrossSectionFaces(soup, k, {});
  var n = (soup.length / 9) | 0, side = new Int8Array(n), outer = 0, bore = 0;
  for (var t = 0; t < n; t++) {
    if (!par.mayMove[t]) continue;
    var q = t * 9;
    var ux = soup[q + 3] - soup[q], uy = soup[q + 4] - soup[q + 1], uz = soup[q + 5] - soup[q + 2];
    var vx = soup[q + 6] - soup[q], vy = soup[q + 7] - soup[q + 1], vz = soup[q + 8] - soup[q + 2];
    var N = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    var mu = (soup[q + o[0]] + soup[q + 3 + o[0]] + soup[q + 6 + o[0]]) / 3 - center2[0];
    var mv = (soup[q + o[1]] + soup[q + 3 + o[1]] + soup[q + 6 + o[1]]) / 3 - center2[1];
    if (N[o[0]] * mu + N[o[1]] * mv > 0) { side[t] = 1; outer++; } else { side[t] = -1; bore++; }
  }
  return { side: side, outer: outer, bore: bore, held: n - outer - bore, untrusted: par.untrusted };
}

/* The offset. tOuter / tBore are face offsets in mm, positive = away from the
   axis (the radius grows), on the outer and bore walls respectively. Returns
   { ok, tris, moved, reason }. On refusal tris is the original soup. */
function NSO_ringOffsetRaw(soup, axisIdx, center2, tOuter, tBore, faces) {
  var res = { ok: false, reason: '', tris: soup };
  var k = axisIdx, o = [0, 1, 2].filter(function (a) { return a !== k; });
  faces = faces || NSO_ringFaces(soup, k, center2);
  var n = (soup.length / 9) | 0;
  // Winding: a soup wound inward still has its outer side outside.
  var vol = 0;
  for (var q0 = 0; q0 < soup.length; q0 += 9) {
    vol += soup[q0] * (soup[q0 + 4] * soup[q0 + 8] - soup[q0 + 5] * soup[q0 + 7]) -
           soup[q0 + 1] * (soup[q0 + 3] * soup[q0 + 8] - soup[q0 + 5] * soup[q0 + 6]) +
           soup[q0 + 2] * (soup[q0 + 3] * soup[q0 + 7] - soup[q0 + 4] * soup[q0 + 6]);
  }
  var sgn = vol < 0 ? -1 : 1;
  function key(i) { return soup[i + o[0]] + ',' + soup[i + o[1]]; }

  // Constraints per section point: one (normal, offset) per wall segment
  // through it. The offset along the face's own outward normal is +t on an
  // outer wall (its normal points away from the axis) and -t on a bore wall
  // (its normal points into the hole, toward the axis).
  var pts = new Map();
  for (var t = 0; t < n; t++) {
    var s = faces.side[t];
    if (!s) continue;
    var tt = s > 0 ? tOuter : -tBore;
    var q = t * 9;
    var ux = soup[q + 3] - soup[q], uy = soup[q + 4] - soup[q + 1], uz = soup[q + 5] - soup[q + 2];
    var vx = soup[q + 6] - soup[q], vy = soup[q + 7] - soup[q + 1], vz = soup[q + 8] - soup[q + 2];
    var N = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    var nu = sgn * N[o[0]], nv = sgn * N[o[1]], L = Math.hypot(nu, nv);
    if (!(L > 0)) continue;
    nu /= L; nv /= L;
    for (var v = 0; v < 3; v++) {
      var kk = key(q + v * 3);
      var P = pts.get(kk);
      if (!P) { P = { u: soup[q + v * 3 + o[0]], v: soup[q + v * 3 + o[1]], c: [], moves: false }; pts.set(kk, P); }
      if (tt !== 0) P.moves = true;
      // one constraint per direction: the two triangles of a wall quad agree
      var dup = false;
      for (var j = 0; j < P.c.length; j++) {
        if (P.c[j].t === tt && P.c[j].nu * nu + P.c[j].nv * nv > 1 - 1e-12) { dup = true; break; }
      }
      if (!dup) P.c.push({ nu: nu, nv: nv, t: tt });
    }
  }

  // Solve each point: where its segments' offset lines meet.
  var moved = 0, worst = 0;
  pts.forEach(function (P) {
    if (!P.moves) { P.du = 0; P.dv = 0; return; }
    var a = 0, b = 0, c = 0, ru = 0, rv = 0;
    for (var j = 0; j < P.c.length; j++) {
      var C = P.c[j];
      a += C.nu * C.nu; b += C.nu * C.nv; c += C.nv * C.nv; ru += C.nu * C.t; rv += C.nv * C.t;
    }
    var det = a * c - b * b;
    if (P.c.length >= 2 && det > 1e-12 * (a + c) * (a + c)) {
      P.du = (c * ru - b * rv) / det; P.dv = (a * rv - b * ru) / det;
    } else {
      // collinear segments (a wall split along its length): one line
      var m = P.c.length || 1;
      P.du = ru / m; P.dv = rv / m;
    }
    moved++;
    var d = Math.hypot(P.du, P.dv);
    if (d > worst) worst = d;
  });

  var out = new Float32Array(soup);
  for (var i = 0; i < soup.length; i += 3) {
    var P2 = pts.get(key(i));
    if (!P2 || !P2.moves) continue;
    out[i + o[0]] = P2.u + P2.du;
    out[i + o[1]] = P2.v + P2.dv;
  }

  // Gate 1, the length: every axial coordinate bit for bit.
  var drift = 0, first = -1;
  for (var a2 = k; a2 < soup.length; a2 += 3) if (!Object.is(out[a2], soup[a2])) { drift++; if (first < 0) first = a2; }
  res.axialDrift = drift;
  if (drift) { res.reason = 'the length moved: ' + drift + ' axial coordinate(s) differ, first at float ' + first; return res; }

  // Gate 2, inversion: a face whose normal turned round has been driven past
  // what it sits against - the same verdict Thicken gives an over-large offset.
  var flipped = 0;
  for (var f = 0; f < n; f++) {
    var b9 = f * 9;
    var nb = NSO_ringNormal(soup, b9), na = NSO_ringNormal(out, b9);
    var lb = Math.hypot(nb[0], nb[1], nb[2]);
    if (!(lb > 1e-9)) continue;
    if (nb[0] * na[0] + nb[1] * na[1] + nb[2] * na[2] <= 0) flipped++;
  }
  res.flipped = flipped;
  if (flipped) {
    res.reason = 'the move is more than the wall it crosses (' + flipped + ' face(s) would turn inside out)';
    return res;
  }

  res.ok = true; res.tris = out; res.moved = moved; res.worstMoveMm = worst; res.faces = faces;
  return res;
}

function NSO_ringNormal(s, q) {
  var ux = s[q + 3] - s[q], uy = s[q + 4] - s[q + 1], uz = s[q + 5] - s[q + 2];
  var vx = s[q + 6] - s[q], vy = s[q + 7] - s[q + 1], vz = s[q + 8] - s[q + 2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

/* What a verb asks for, from a reading: target outer and bore radii (the
   vertex circles) and the refusal, if any, in millimetres. */
function NSO_ringPlan(reading, verb, value, opts) {
  opts = opts || {};
  var out = { ok: false, reason: '' };
  var v = +value;
  if (!reading || reading.shape !== 'round') {
    out.reason = 'not round - ' + ((reading && reading.reason) || 'no reading');
    return out;
  }
  if (!isFinite(v)) { out.reason = 'enter a number of mm'; return out; }
  var R = reading.outer.diameterMm / 2;
  var hollow = !!reading.hollow, r = hollow ? reading.bore.diameterMm / 2 : 0;
  var R2 = R, r2 = r;
  if (!hollow) {
    if (verb !== 'diameter') { out.reason = 'a rod has no bore - only Diameter applies'; return out; }
    if (!(v > 0)) { out.reason = 'diameter would be ' + NSO_ringFmt(v) + ' mm - a rod needs more than zero'; return out; }
    R2 = v / 2;
  } else if (verb === 'outer') {
    if (!(v > 0)) { out.reason = 'outer Ø would be ' + NSO_ringFmt(v) + ' mm - it needs more than zero'; return out; }
    R2 = v / 2; r2 = r + (R2 - R);
  } else if (verb === 'bore') {
    r2 = v / 2;
  } else if (verb === 'wall') {
    r2 = R - v;
  } else if (verb === 'diameter') {
    out.reason = 'a ring is edited by Outer, Bore or Wall, not Diameter'; return out;
  } else { out.reason = 'unknown verb "' + verb + '"'; return out; }

  if (hollow) {
    if (r2 >= R2) {
      out.reason = 'bore would reach the outer - Ø' + NSO_ringFmt(2 * r2) + ' bore against a Ø' +
        NSO_ringFmt(2 * R2) + ' outer';
      return out;
    }
    if (!(r2 > 0)) {
      out.reason = 'bore would close up - Ø' + NSO_ringFmt(2 * r2) + ' mm is at or below zero';
      return out;
    }
    var floor = NSO_ringWallFloor(opts);
    if (floor != null && R2 - r2 < floor) {
      out.reason = 'wall would be ' + NSO_ringFmt(R2 - r2) + ' mm, under the ' + NSO_ringFmt(floor) + ' mm floor';
      out.floorMm = floor;
      return out;
    }
    out.floorMm = floor;
  }
  out.ok = true;
  out.R = R; out.r = r; out.R2 = R2; out.r2 = r2;
  out.dOuter = R2 - R; out.dBore = hollow ? r2 - r : 0;
  return out;
}

/* The wall floor: NSO_Thickness.floorFor(nozzle), the one place this repo
   keeps it (nozzle x 1.05; 0.42 mm at the default 0.4 nozzle). opts.floor
   overrides it, opts.nozzle picks the nozzle. */
function NSO_ringWallFloor(opts) {
  opts = opts || {};
  if (typeof opts.floor === 'number') return opts.floor;
  var T = (typeof NSO_Thickness !== 'undefined') ? NSO_Thickness : null;
  if (!T || typeof T.floorFor !== 'function') return null;
  return T.floorFor(opts.nozzle);
}

/* Headless end to end: read, plan, offset, re-read, correct, gate.
   verb: 'outer' | 'bore' | 'wall' | 'diameter'. Returns { ok, reason, tris,
   before, after, plan, ... }; on refusal tris is the original soup. */
function NSO_ringApplyRaw(soup, verb, value, opts) {
  opts = opts || {};
  var res = { ok: false, reason: '', tris: soup, verb: verb, value: +value };
  if (typeof NSO_sectionRead !== 'function' || typeof NSO_fattenCrossSectionFaces !== 'function') {
    res.reason = 'nso_section.js and app-fatten.js must be loaded - the ring verbs read the shape ' +
      'with the one and filter faces with the other';
    return res;
  }
  var before = NSO_sectionRead(soup, opts.read);
  res.before = before;
  var plan = NSO_ringPlan(before, verb, value, opts);
  res.plan = plan;
  if (!plan.ok) { res.reason = plan.reason; return res; }
  if (plan.dOuter === 0 && plan.dBore === 0) { res.reason = 'nothing to change - that is the size it already is'; return res; }

  var k = before.axisIdx, c = before.outer.center;
  var faces = NSO_ringFaces(soup, k, c);
  res.faces = faces;
  if ((plan.dOuter !== 0 && !faces.outer) || (plan.dBore !== 0 && !faces.bore)) {
    res.reason = 'no ' + (plan.dOuter !== 0 && !faces.outer ? 'outer' : 'bore') + ' wall faces parallel to ' +
      before.axis + ' to move';
    return res;
  }

  // dr is a change in the VERTEX circle; a face offset t moves a polygon's
  // vertices out by t / cos(half its corner angle). So start from t = dr x
  // (apothem / vertex radius) and let the reader say how close that landed,
  // correcting from the ORIGINAL soup each time (Scale's discipline: the pass
  // count is a budget for finding the offset, not a chain of approximations).
  var kOut = before.fit.outer.circle.rMin / before.fit.outer.circle.rMax;
  var kIn = before.hollow ? before.fit.bore.circle.rMin / before.fit.bore.circle.rMax : 1;
  var tO = plan.dOuter * kOut, tB = plan.dBore * kIn, best = null;
  for (var p = 0; p < NSO_RING_PROBES; p++) {
    var off = NSO_ringOffsetRaw(soup, k, c, tO, tB, faces);
    if (!off.ok) { if (!best) { res.reason = off.reason; res.offset = off; return res; } break; }
    var after = NSO_sectionRead(off.tris, opts.read);
    if (after.shape !== 'round' || after.hollow !== before.hollow) {
      if (!best) { res.reason = 'the result no longer reads as a ' + (before.hollow ? 'ring' : 'rod') + ': ' + after.reason; return res; }
      break;
    }
    var gotR = after.outer.diameterMm / 2, gotr = after.hollow ? after.bore.diameterMm / 2 : 0;
    var err = Math.max(Math.abs(gotR - plan.R2), Math.abs(gotr - plan.r2));
    if (!best || err < best.err) best = { err: err, off: off, after: after, tO: tO, tB: tB, passes: p + 1 };
    if (err <= NSO_RING_LAND_MM) break;
    var dO = gotR - plan.R, dB = gotr - plan.r;
    if (plan.dOuter !== 0 && dO !== 0) tO *= plan.dOuter / dO;
    if (plan.dBore !== 0 && dB !== 0) tB *= plan.dBore / dB;
  }

  // Held faces really held: on Bore and Wall the outer wall does not move.
  if (plan.dOuter === 0 && best.after.outer.diameterMm !== before.outer.diameterMm) {
    res.reason = 'the outer moved (' + before.outer.diameterMm + ' -> ' + best.after.outer.diameterMm + ')';
    return res;
  }
  res.ok = true;
  res.tris = best.off.tris;
  res.after = best.after;
  res.landedMm = best.err;
  res.passes = best.passes;
  res.offsetOuterMm = best.tO; res.offsetBoreMm = best.tB;
  res.axialDrift = best.off.axialDrift;
  res.moved = best.off.moved;
  return res;
}

/* One line for the status bar: the verb, before -> after, what was held.
   fmt formats a length in mm for display (the Scale card's unit edge,
   app-scale.js); it defaults to the bare millimetres this has always shown. */
function NSO_ringDescribe(r, fmt) {
  var a = r.before, b = r.after, f = fmt || function (x) { return (+x).toFixed(3); };
  // what is held is the axis, by the name its row has ("height held" stood up)
  var held = ', ' + NSO_sectionAxisWord(a, a.axisIdx) + ' held';
  if (!a.hollow) return 'Diameter Ø' + f(a.outer.diameterMm) + ' → Ø' + f(b.outer.diameterMm) + held;
  return 'Ø' + f(a.outer.diameterMm) + ' / Ø' + f(a.bore.diameterMm) + ' wall ' + f(a.wallMm) + ' → Ø' +
    f(b.outer.diameterMm) + ' / Ø' + f(b.bore.diameterMm) + ' wall ' + f(b.wallMm) +
    (r.verb === 'outer' ? ', wall kept' : ', outer kept') + held;
}
