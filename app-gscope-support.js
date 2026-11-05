/*
 * G-scope supports - overhang markers, point-click generation, and editing
 * one support at a time. The support-generation phase G-scope's selection
 * seam was left for (docs/GCODE-MICROSCOPE.md, "The selection seam").
 * ----------------------------------------------------------------------------
 *
 * READ docs/GCODE-SUPPORTS.md FIRST.
 *
 * DORMANT SINCE THE G-SCOPE REDO (docs/GSCOPE.md, item 5). G-scope's Overhangs
 * row - the only switch for the markers - is gone: overhang detection lives on
 * the plate SUPPORTS card. This file still loads and still answers setOn().
 *
 * WHAT IS REUSED, AND NOTHING HERE REPLACES
 *   detection   NSO_SupportAim.detectOverhangs, called as it is and read as it
 *               comes back. A marker is one of its `regions`, drawn where the
 *               region says it is: `point` (the aim point, on the surface) and
 *               `tris` (the flagged triangles). Nothing here re-tests an angle
 *               or casts a ray.
 *   generation  one planner for every style: NSO_SupportTree.planTree,
 *               which is nso_support_gridpack.js, then
 *               NSO_SupportGridpack.solid. 'strut' never merges, 'tree'
 *               merges pairwise, 'gecko-hand' is the tree with hands.
 *               Generating again on a region REPLACES its supports.
 *               Each is called with the SAME soup and the SAME options the
 *               marker's detection ran with, plus `regionId` and `sideMm`, so
 *               the region a marker shows is the region the generator plans
 *               for. No geometry is built in this file.
 *   the piece   a support lands as its own plate piece through
 *               addModelFromZUpGeometry + placeModelMovable - the ordinary
 *               ingest - and one `addModels` undo step.
 *   selection   G-scope's own seam: clicking a support selects it with
 *               NSO_MICROSCOPE.selectObjects(), i.e. setSelection().
 *
 * FRAME. Detection and generation run on the piece's WORLD soup in the file's
 * Z-up millimetres - what G-scope's plate document already holds for every
 * piece (meshToWorldSoup, remapped). That is the print orientation: a piece
 * the user has tipped needs supports where it overhangs NOW, not where its
 * file did. The support comes out in the same frame, so it is placed by its
 * own bounding box with no rotation and no guess, and the placement is then
 * READ BACK off the scene and compared to the generator's output before the
 * step is kept.
 *
 * PAINT SCOPE: SUB-REGION (detection) - per docs/HANDOFF.md, "Scoping".
 *   detection   SUB-REGION, inherited from nso_support_aim.js: the piece's
 *               painted faces (nsoMaskFaceList) are passed as skipList, so a
 *               painted face never gets a marker. The list is in the piece's
 *               raw frame; it is shifted into the world frame when the piece
 *               is only translated, and refused by name when the piece is
 *               turned AND painted - a plane cannot be carried through a turn
 *               by a shift.
 *   generate    NONE - it adds a piece and edits none; the host piece is never
 *               written.
 *   remove /    WHOLE-PIECE, on the SUPPORT: a support is one piece, and it is
 *   adjust      selected, removed or replaced whole. No face-level selection
 *               is involved, so there is nothing for paint to scope.
 */
/* global THREE, state, setStatus, addModelFromZUpGeometry, placeModelMovable,
          pushUndo, meshToWorldSoup, nsoMaskCount, nsoMaskFaceList,
          renderModelList, updateOptimizeButton, updateEditSize, updateAdjustUI,
          NSO_edgeStats */
'use strict';

var NSO_GSCOPE_SUPPORT = (function () {
  var STYLES = { strut: 'Straight strut', tree: 'Tree', 'gecko-hand': 'Gecko-hand' };
  var MARK_RED = 0xff2d2d;
  var MARK_GREEN = 0x22c55e;
  // Beacon states (see "Beacons" below): before Generate, then after it.
  var BEACON = { planned: 0xffffff, held: MARK_GREEN, rest: 0xf59e0b, unreachable: MARK_RED };

  var on = false;              // markers shown
  var angleDeg = 45;
  var scan = [];               // [{ host, opts, det, error }] for the current doc
  var markers = [];            // [{ host, region, ping, overlay, supported }]
  var layer = null;            // THREE.Group in G-scope's scene
  var pop = null;              // { kind: 'new'|'edit', marker?, supportId? }
  var popAnchor = null;        // { x, y } client px the open card points at
  var picked = null;           // { hostSourceId, regionId } the card is open on
  var tried = {};              // 'hostSourceId|regionId|style' -> beacons of a refused Generate
  var busy = false;

  function $(id) { return document.getElementById(id); }
  function MS() { return window.NSO_MICROSCOPE; }
  function SA() { return window.NSO_SupportAim; }
  function ST() { return window.NSO_SupportTree; }
  function say(msg, bad) { if (typeof setStatus === 'function') setStatus(msg, !!bad); }

  function modelOf(id) {
    return (state.models || []).find(function (m) { return m && m.id === id; }) || null;
  }
  function isSupportId(id) { var m = modelOf(id); return !!(m && m.nsoSupport); }

  function plateDoc() {
    var d = MS() && MS().getDoc();
    return (d && d.kind === 'mesh' && d.source === 'plate') ? d : null;
  }

  function boundsOf(soup) {
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < soup.length; i++) {
      var k = i % 3;
      if (soup[i] < lo[k]) lo[k] = soup[i];
      if (soup[i] > hi[k]) hi[k] = soup[i];
    }
    return { lo: lo, hi: hi };
  }

  // =========================================================================
  // The options detection and generation share
  // =========================================================================

  /** The pieces that can carry supports: every plate piece that is not one. */
  function hostsOf(d) {
    return (d ? d.objects : []).filter(function (o) { return !isSupportId(o.sourceId); });
  }

  /**
   * The painted faces, in the frame detection runs in. Raw-frame planes are
   * shifted by the piece's translation; a turned piece's cannot be, and that
   * is refused rather than guessed.
   */
  function skipListFor(host) {
    var m = modelOf(host.sourceId);
    var painted = (m && typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
    if (!painted) return { list: [] };
    var p = state.placed[host.placedIndex] || {};
    if (p.rotY || p.flipX || p.tipX || p.tipZ || p.tiltX || p.tiltZ) {
      return { list: null, reason: '"' + host.name + '" is painted and turned: its painted faces are ' +
        'recorded in the file\'s own axes and cannot be carried through a turn, so its overhangs ' +
        'are not scanned. Clear the paint, or turn it back.' };
    }
    var list = (typeof nsoMaskFaceList === 'function') ? nsoMaskFaceList(m) : [];
    if (list === null) return { list: null, reason: '"' + host.name + '" has a painted patch with no ' +
      'axis to name it by, so its overhang scan cannot leave it out' };
    if (!m.rawTris) return { list: null, reason: '"' + host.name + '" is painted but has no raw mesh' };
    var rb = boundsOf(m.rawTris), wb = host.bounds;
    var t = [wb.minX - rb.lo[0], wb.minY - rb.lo[1], wb.minZ - rb.lo[2]];
    return { list: list.map(function (e) {
      return Object.assign({}, e, { d: e.d == null ? null : e.d + t[e.axisIdx] });
    }) };
  }

  /** detectOverhangs' options for one host. The generator gets these too. */
  function optsFor(d, host) {
    var sk = skipListFor(host);
    return {
      opts: {
        skipList: sk.list,
        angleDeg: angleDeg,
        occluders: hostsOf(d).filter(function (o) { return o !== host; })
          .map(function (o) { return o.positions; })
      },
      reason: sk.reason || null
    };
  }

  // =========================================================================
  // Detection -> markers
  // =========================================================================

  function runScan() {
    scan = [];
    var d = plateDoc();
    if (!d || !SA()) return scan;
    hostsOf(d).forEach(function (host) {
      var o = optsFor(d, host);
      if (o.reason) { scan.push({ host: host, opts: o.opts, det: null, error: o.reason }); return; }
      var det = SA().detectOverhangs(host.positions, o.opts);
      scan.push({ host: host, opts: o.opts, det: det, error: det.ok ? null : det.reason });
    });
    return scan;
  }

  /* With a region: G-scope's own supports for that triangle region. The
     Supports card's (meta.card) number their regions on the beacon grid, so
     the same number names a different place; they are never this row's to
     replace or count as standing. Without one: every support on the piece. */
  function supportsFor(hostSourceId, regionId) {
    return (state.models || []).filter(function (m) {
      return m && m.nsoSupport && m.nsoSupport.hostSourceId === hostSourceId &&
        (regionId == null || (m.nsoSupport.regionId === regionId && !m.nsoSupport.card));
    });
  }

  /*
   * DOES IT STILL STAND THERE? A support records the host and region it was
   * built for, but that is a label, not a fact: move, turn or mirror the host
   * (or the support) and the label still matches while the support stands
   * under nothing. So a region is green only when a support labelled for it
   * ALSO touches it where the region is NOW - read off the plate document,
   * both pieces in the same world Z-up frame:
   *
   *   some support vertex lies over one of the region's own flagged
   *   triangles (its closest point on the triangle is its projection, to
   *   within LATERAL_MM), at a signed distance along the triangle's outward
   *   normal between -embedMm (into the piece: tree tips and contact
   *   interfaces sink in) and +GAP_MM (a hair of air below it; float noise).
   *
   * embedMm is the larger of 1 mm and the support's own size. The generators'
   * contacts sit at 0 (a strut's top face is the surface) or up to ~0.5 mm
   * in (a round tree tip); a region that has moved away by a mirror, turn or
   * shift is millimetres off, far outside the band.
   */
  var GAP_MM = 0.02, LATERAL_MM = 0.02;

  function closestOnTri(p, a, b, c) {
    // Ericson, Real-Time Collision Detection 5.1.5.
    function sub(u, v) { return [u[0] - v[0], u[1] - v[1], u[2] - v[2]]; }
    function dot(u, v) { return u[0] * v[0] + u[1] * v[1] + u[2] * v[2]; }
    function at(u, s, v, t) { return [a[0] + u[0] * s + v[0] * t, a[1] + u[1] * s + v[1] * t, a[2] + u[2] * s + v[2] * t]; }
    var ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
    var d1 = dot(ab, ap), d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0) return a.slice();
    var bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) return b.slice();
    var vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) return at(ab, d1 / (d1 - d3), ac, 0);
    var cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6) return c.slice();
    var vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) return at(ab, 0, ac, d2 / (d2 - d6));
    var va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
      var w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
      return [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w];
    }
    var den = 1 / (va + vb + vc);
    return at(ab, vb * den, ac, vc * den);
  }

  /**
   * The vertices of support soup S that touch region `region` of host soup P
   * - over one of its flagged triangles, inside the band above. With `only`
   * (vertex indices), just those are tested. Returns { hit: [indices],
   * tested, nearestMm } - nearestMm the best lateral miss, for the reason.
   */
  function contactsOn(S, P, region, sideMm, only) {
    var embed = Math.max(1, +sideMm || 0);
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    var tris = region.tris.map(function (t) {
      var o = t * 9, a = [P[o], P[o + 1], P[o + 2]], b = [P[o + 3], P[o + 4], P[o + 5]], c = [P[o + 6], P[o + 7], P[o + 8]];
      for (var k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], a[k], b[k], c[k]); hi[k] = Math.max(hi[k], a[k], b[k], c[k]);
      }
      var u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      var n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      var L = Math.hypot(n[0], n[1], n[2]) || 1;
      return { a: a, b: b, c: c, n: [n[0] / L, n[1] / L, n[2] / L] };
    });
    var pad = embed + GAP_MM + LATERAL_MM, hit = [], nearest = Infinity;
    var n = only ? only.length : S.length / 3;
    for (var q = 0; q < n; q++) {
      var vi = only ? only[q] : q, i = vi * 3;
      if (!(i + 2 < S.length)) continue;
      var x = S[i], y = S[i + 1], z = S[i + 2];
      if (x < lo[0] - pad || x > hi[0] + pad || y < lo[1] - pad || y > hi[1] + pad ||
          z < lo[2] - pad || z > hi[2] + pad) continue;
      for (var j = 0; j < tris.length; j++) {
        var T = tris[j];
        var sd = (x - T.a[0]) * T.n[0] + (y - T.a[1]) * T.n[1] + (z - T.a[2]) * T.n[2];
        if (sd > GAP_MM || sd < -embed) continue;
        var pr = [x - T.n[0] * sd, y - T.n[1] * sd, z - T.n[2] * sd];
        var cl = closestOnTri(pr, T.a, T.b, T.c);
        var lat = Math.hypot(cl[0] - pr[0], cl[1] - pr[1], cl[2] - pr[2]);
        if (lat <= LATERAL_MM) { hit.push(vi); break; }
        nearest = Math.min(nearest, lat);
      }
    }
    return { hit: hit, tested: n, nearestMm: nearest };
  }

  /**
   * Whether support piece `sup` (a plate-document object) still stands under
   * `region` of `host` where the region is now: EVERY vertex that touched the
   * region when the support was placed (meta.contacts, recorded by
   * placeSupport) must touch it still. Testing only those - the support's own
   * contacts - keeps a trunk that a moved host happens to pass through from
   * counting as support; requiring all of them keeps a support slid half off
   * its overhang from counting as standing.
   */
  function touches(sup, host, region, meta) {
    var c = meta && meta.contacts;
    if (!c || !c.length) return { ok: false, reason: 'no contacts were recorded when it was placed' };
    var r = contactsOn(sup.positions, host.positions, region, meta.sideMm, c);
    return { ok: r.hit.length === c.length, touching: r.hit.length, contacts: c.length };
  }

  /**
   * The supports that are labelled for this region AND still touch it now.
   * `labelled` is what the label alone says; `standing` what the geometry
   * says; a label whose support no longer touches is `stale`.
   */
  function standingFor(d, host, region) {
    var labelled = supportsFor(host.sourceId, region.id);
    var standing = [], stale = [];
    labelled.forEach(function (m) {
      var o = d && d.objects.find(function (x) { return x.sourceId === m.id; });
      var t = o ? touches(o, host, region, m.nsoSupport) : { ok: false, reason: 'not on the plate' };
      (t.ok ? standing : stale).push({ id: m.id, name: m.name, touch: t });
    });
    return { labelled: labelled.length, standing: standing, stale: stale };
  }

  // =========================================================================
  // Beacons - where a piece needs holding, drawn before and after Generate
  // =========================================================================

  /*
   * THE CONTRACT is nso_support_beacons.js's (docs/SUPPORT-BEACONS.md):
   * detectOverhangs carries region.beacons on every region - the beacons on
   * that region's own triangles - each { x, y, z, normal, need: { angle,
   * gapBelow, kind, ... }, cell, tri }, kind one of face | gap | edge | tip |
   * ridge. This only READS them: the card draws exactly region.beacons, a
   * disc for face / gap / edge / tip and a tick along `normal` (the side
   * approach) for ridge. What is added here is one field, `state`:
   *   'planned' before Generate; after it, read off the plan:
   *   'held' (its support stands on the plate), 'rest' (it stands on a part),
   *   'unreachable' (the plan could not get to it from below)
   * A drawn beacon is a shallow copy of the region's with `state` on it, so
   * the region's own records are never written.
   */
  function readBeacons(region) {
    return (region && region.beacons || []).map(function (b) { return Object.assign({}, b, { state: 'planned' }); });
  }

  function beaconKind(b) { return (b.need && b.need.kind) || 'face'; }

  /** The generator's options for one call: the same object planFor hands it. */
  function genOpts(baseOpts, regionId, style, sideMm) {
    var o = Object.assign({}, baseOpts, { regionId: regionId });
    if (sideMm != null && isFinite(sideMm)) o.sideMm = +sideMm;
    if (style === 'tree' || style === 'gecko-hand') o.branchStyle = style === 'gecko-hand' ? 'gecko-hand' : 'square';
    return o;
  }

  /**
   * The region's beacons after a Generate, with their states, from the plan's
   * own report. The plan holds the region at its own contact points - a
   * tree's contactPoints lattice (branches, the contact the trunk carries,
   * the blocked list), a strut's one aim point - each held / resting /
   * unreachable by what the plan says of it. A beacon takes the state of the
   * nearest contact that covers it: within the lattice's achieved covering
   * radius for a tree, within the beacon's own grid cell (pitch / sqrt 2) for
   * a strut. A beacon no contact covers stays planned - a strut holds one
   * spot, not the region. A refused plan that got as far as finding a way
   * down (base, aim, trunk, branches) marks every beacon unreachable; one
   * refused earlier (the region too wide for one trunk) leaves them planned -
   * nothing was learnt about reaching them.
   */
  function beaconStates(region, style, g, pitch) {
    var plan = (g && g.plan) || {};
    var beacons = readBeacons(region);
    if (Array.isArray(plan.beacons) && Array.isArray(plan.unreachable)) return gridpackStates(beacons, plan, pitch);
    if (!(g && g.ok)) {
      if (/^(base|aim|trunk|branches)$/.test(plan.stage || '')) beacons.forEach(function (b) { b.state = 'unreachable'; });
      return beacons;
    }
    var base = style === 'strut' ? plan.aim && plan.aim.base : plan.base;
    var held = base && base.base && base.base.kind === 'piece' ? 'rest' : 'held';
    var contacts, reach;
    if (style === 'strut' || plan.single) {
      var at = style === 'strut' ? (plan.region || region).point : plan.contacts.points[0].p;
      contacts = [{ p: at, state: held }];
      reach = (pitch > 0 ? pitch : 3) / Math.SQRT2;
    } else {
      contacts = plan.contacts.points.map(function (c) { return { p: c.p, state: 'planned' }; });
      (plan.branches || []).forEach(function (b) { if (contacts[b.contactIndex]) contacts[b.contactIndex].state = held; });
      if (plan.trunkCarriesContact >= 0 && contacts[plan.trunkCarriesContact]) contacts[plan.trunkCarriesContact].state = held;
      (plan.blocked || []).forEach(function (b) { if (contacts[b.index]) contacts[b.index].state = 'unreachable'; });
      reach = (plan.contacts.coverageMm || 0) + 1e-6;
    }
    beacons.forEach(function (b) {
      var best = null, bestD = Infinity;
      contacts.forEach(function (c) {
        var dd = Math.hypot(c.p[0] - b.x, c.p[1] - b.y, c.p[2] - b.z);
        if (dd < bestD) { bestD = dd; best = c; }
      });
      if (best && bestD <= reach) b.state = best.state;
    });
    return beacons;
  }

  /** The beacon grid's pitch for a host: its scan's, else the plan's own detection's. */
  /**
   * The same states from the grid-pack planner's report (#175; every style
   * plans through it). It names its own support points by id: the ones its
   * trunks hold - on the plate, or resting on the part - and the ones it
   * could not reach or found inside the piece. A drawn beacon takes the
   * state of the nearest of its points within one grid cell (pitch / sqrt 2);
   * one no point covers stays planned.
   */
  function gridpackStates(beacons, plan, pitch) {
    var st = {};
    (plan.trunks || []).forEach(function (t) {
      (t.beacons || []).forEach(function (id) { st[id] = t.landing === 'rest' ? 'rest' : 'held'; });
    });
    (plan.unreachable || []).concat(plan.inside || []).forEach(function (id) { st[id] = 'unreachable'; });
    var pts = plan.beacons.map(function (b) { return { p: b.p, state: st[b.id] || 'planned' }; });
    var reach = (pitch > 0 ? pitch : (plan.pitchMm > 0 ? plan.pitchMm : 3)) / Math.SQRT2 + 1e-6;
    beacons.forEach(function (b) {
      var best = null, bestD = Infinity;
      pts.forEach(function (c) {
        var dd = Math.hypot(c.p[0] - b.x, c.p[1] - b.y, c.p[2] - b.z);
        if (dd < bestD) { bestD = dd; best = c; }
      });
      if (best && bestD <= reach) b.state = best.state;
    });
    return beacons;
  }

  function gridPitch(scanEntry, g) {
    var det = (scanEntry && scanEntry.det) || (g && g.plan && g.plan.detect);
    return det && det.grid ? det.grid.pitch : null;
  }

  function countStates(beacons) {
    var c = { held: 0, rest: 0, unreachable: 0, planned: 0 };
    (beacons || []).forEach(function (b) { c[b.state] = (c[b.state] || 0) + 1; });
    return c;
  }

  // =========================================================================
  // Plain words - everything the card says goes through here
  // =========================================================================

  /** A number as people say it: at most one decimal place, none when whole. */
  function num(x) {
    var r = Math.round(+x * 10) / 10;
    return isFinite(r) ? String(r) : '?';
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  function readout(beacons) {
    var c = countStates(beacons);
    return plural(c.held, 'contact', 'contacts') + ' held from the plate · ' +
      c.rest + ' resting on the part · ' + c.unreachable + ' unreachable';
  }

  /** Why a Generate came to nothing, in words a user acts on. */
  function plainWhy(g, restOn) {
    var plan = (g && g.plan) || {}, why = (g && g.reason) || '';
    if (why === 'busy') return 'Still working on the last one - try again in a moment.';
    if (plan.trunksNeeded) return 'This overhang is too wide for one support to reach all of it. ' +
      'Try a straight strut instead.';
    var noneHeld = Array.isArray(plan.unreachable) && plan.unreachable.length > 0 && !plan.held;   // grid-pack (#175)
    if (noneHeld || /^(base|aim)$/.test(plan.stage || '') || /no viable base|no base offers/.test(why)) {
      return 'There is no clear straight path down to the plate from here' +
        (restOn ? ', or onto the part.' : '. Tick "May rest on the part" to let it stand on the part instead.');
    }
    if (plan.stage === 'trunk') return 'The support would run into the part on its way up.';
    if (plan.stage === 'branches') return 'None of the branches could reach the underside without hitting the part.';
    if (plan.stage === 'contacts') return 'This overhang is too big to cover with one support.';
    if (/did not land where it was generated/.test(why)) return 'It did not land where it was built, so nothing was added.';
    if (/painted/.test(why)) return why.replace(/\s+-\s+/g, ' - ');
    return 'It could not be built here.';
  }

  function clearLayer() {
    if (!layer) return;
    for (var i = layer.children.length - 1; i >= 0; i--) {
      var c = layer.children[i];
      layer.remove(c);
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
    }
  }

  function ensureLayer() {
    var v = MS() && MS().getView();
    if (!v) return null;
    if (!layer) {
      layer = new THREE.Group();
      layer.name = 'gscopeSupportMarkers';
      layer.renderOrder = 10;
    }
    // A helper (nso-helpers.js), in G-scope's own scene; interactive - a
    // click on a ping or a tinted region picks it.
    if (layer.parent !== v.scene) nsoHelpers.attach(v.scene, layer, 'gscope-support', { interactive: true });
    return layer;
  }

  /**
   * One marker per region: the region's own flagged triangles, lifted a hair
   * off the surface and tinted, and a ping - a sphere at the region's aim
   * point - to click. Red where no support stands for it yet, green where one
   * does. A region with beacons to show (picked on the card, or held by a
   * support) shows those instead of its ping: see drawBeacons.
   */
  function drawMarkers() {
    markers = [];
    if (!layer) ensureLayer();
    if (!layer) return;
    clearLayer();
    layer.visible = on;
    var d = plateDoc();
    if (!on || !d) { syncPanel(); return; }
    var pingR = markSize(d);

    scan.forEach(function (s) {
      if (!s.det || !s.det.ok) return;
      s.det.regions.forEach(function (r) {
        var st = standingFor(d, s.host, r);
        var supported = st.standing.length > 0;
        var col = supported ? MARK_GREEN : MARK_RED;
        var P = s.host.positions, lift = 0.02;
        var pos = new Float32Array(r.tris.length * 9);
        r.tris.forEach(function (t, i) {
          for (var v = 0; v < 3; v++) {
            var o = t * 9 + v * 3;
            var q = MS().toView(P[o] + r.normal[0] * lift, P[o + 1] + r.normal[1] * lift, P[o + 2] + r.normal[2] * lift);
            pos[i * 9 + v * 3] = q.x; pos[i * 9 + v * 3 + 1] = q.y; pos[i * 9 + v * 3 + 2] = q.z;
          }
        });
        var og = new THREE.BufferGeometry();
        og.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        var overlay = new THREE.Mesh(og, new THREE.MeshBasicMaterial({
          color: col, transparent: true, opacity: 0.55, side: THREE.DoubleSide,
          depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
        }));
        var at = MS().toView(r.point[0], r.point[1], r.point[2]);
        var ping = new THREE.Mesh(new THREE.SphereGeometry(pingR, 20, 14),
          new THREE.MeshBasicMaterial({ color: col, depthTest: false, transparent: true, opacity: 0.95 }));
        ping.position.copy(at);
        ping.renderOrder = 12;
        // The beacons a standing support holds, as its plan left them.
        var held = null;
        st.standing.forEach(function (x) {
          var m = modelOf(x.id);
          if (!held && m && m.nsoSupport && m.nsoSupport.beacons) held = m.nsoSupport.beacons;
        });
        var mk = { host: s.host, region: r, ping: ping, overlay: overlay, supported: supported,
          stale: st.stale.map(function (x) { return x.name; }), heldBeacons: held, beacons: null, beaconMeshes: [] };
        ping.userData.marker = mk; overlay.userData.marker = mk;
        layer.add(overlay); layer.add(ping);
        markers.push(mk);
      });
    });
    if (pop && pop.kind === 'new' && picked) pop.marker = markerOf(picked.hostSourceId, picked.regionId) || pop.marker;
    drawBeacons();
    syncPanel();
  }

  function markSize(d) {
    var span = 0;
    d.objects.forEach(function (o) {
      span = Math.max(span, o.bounds.maxX - o.bounds.minX, o.bounds.maxY - o.bounds.minY, o.bounds.maxZ - o.bounds.minZ);
    });
    return Math.max(0.5, Math.min(3, span * 0.025));
  }

  function markerOf(hostSourceId, regionId) {
    return markers.find(function (m) { return m.host.sourceId === hostSourceId && m.region.id === regionId; }) || null;
  }

  function cardStyle() { var el = $('ms-sp-style'); return el ? el.value : 'strut'; }
  function cardSize() { var el = $('ms-sp-size'); return el ? parseFloat(el.value) : NaN; }
  function cardRest() { var el = $('ms-sp-rest'); return !!(el && el.checked); }

  /** The beacons the picked region shows now: a refused try's, else planned. */
  function pickedBeacons(mk) {
    var key = mk.host.sourceId + '|' + mk.region.id + '|' + cardStyle();
    return tried[key] || readBeacons(mk.region);
  }

  /**
   * The beacons, drawn on the surface: a disc lying in the face for face,
   * gap, edge and tip beacons, a tick along the side approach for ridge
   * beacons (their normal is horizontal, out of the wall), each over a dark
   * backing so a green or red beacon still reads on a tinted region. Drawn
   * over everything, as the pings are: once a support stands there its own
   * tips cover the very points whose state the beacons report. A
   * region showing beacons hides its ping - the single centroid marker goes;
   * the region's own tint stays.
   */
  function drawBeacons() {
    markers.forEach(function (mk) {
      mk.beaconMeshes.forEach(function (o) {
        layer.remove(o);
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      mk.beaconMeshes = [];
      var isPicked = !!(pop && pop.kind === 'new' && picked &&
        picked.hostSourceId === mk.host.sourceId && picked.regionId === mk.region.id);
      mk.beacons = isPicked ? pickedBeacons(mk) : (mk.supported ? mk.heldBeacons : null);
      mk.ping.visible = !(mk.beacons && mk.beacons.length);
      if (!mk.beacons || !mk.beacons.length) return;
      var d = plateDoc();
      var r = markSize(d) * 0.4, nn = Infinity, B = mk.beacons;
      for (var i = 0; i < B.length; i++) for (var j = i + 1; j < B.length; j++) {
        nn = Math.min(nn, Math.hypot(B[i].x - B[j].x, B[i].y - B[j].y, B[i].z - B[j].z));
      }
      if (isFinite(nn)) r = Math.max(0.12, Math.min(r, nn * 0.3));
      var o0 = MS().toView(0, 0, 0), z = new THREE.Vector3(0, 0, 1), y = new THREE.Vector3(0, 1, 0);
      B.forEach(function (b) {
        var n = b.normal || [0, 0, -1];
        var nv = MS().toView(n[0], n[1], n[2]).sub(o0).normalize();
        var col = BEACON[b.state] != null ? BEACON[b.state] : BEACON.planned;
        function put(geo, color, liftMm, order, axis) {
          var m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: color, side: THREE.DoubleSide,
            transparent: true, opacity: 0.98, depthWrite: false, depthTest: false }));
          m.position.copy(MS().toView(b.x + n[0] * liftMm, b.y + n[1] * liftMm, b.z + n[2] * liftMm));
          m.quaternion.setFromUnitVectors(axis, nv);
          m.renderOrder = order;
          m.userData.marker = mk; m.userData.beacon = b;
          layer.add(m); mk.beaconMeshes.push(m);
          return m;
        }
        if (beaconKind(b) === 'ridge') {
          put(new THREE.CylinderGeometry(r * 0.42, r * 0.42, r * 2.6, 8), 0x0b0f17, r * 1.3, 13, y);
          put(new THREE.CylinderGeometry(r * 0.26, r * 0.26, r * 2.6, 8), col, r * 1.3 + 0.01, 14, y);
        } else {
          put(new THREE.CircleGeometry(r * 1.3, 20), 0x0b0f17, 0.04, 13, z);
          put(new THREE.CircleGeometry(r, 20), col, 0.06, 14, z);
        }
      });
    });
  }

  /** Re-scan and redraw, e.g. after the plate changed under G-scope. */
  function refresh() {
    if (!plateDoc()) { scan = []; markers = []; clearLayer(); syncPanel(); return; }
    if (on) runScan();
    drawMarkers();
  }

  /* The overhang beacons, for the helper registry: Overhangs' own off. */
  if (typeof nsoHelpers !== 'undefined') nsoHelpers.owner('gscope-support', {
    live: function () { return on; },
    close: function () { setOn(false); },
    clear: clearLayer,
    refresh: refresh
  });

  function setOn(v) {
    on = !!v;
    if (on && !plateDoc() && MS()) MS().openPlate();
    refresh();
  }

  // =========================================================================
  // Generation - the three proven generators, behind one call
  // =========================================================================

  /**
   * "May rest on the part": the bases the planner may stand a support on.
   * Off (the default) this is undefined and the planner keeps its own, the
   * plate alone. On, every plate piece - the host included - is offered as
   * well, cut down to its upward-facing triangles that lie wholly below the
   * region: the only faces a support could stand on to reach up to it. The
   * planner picks the nearest clear one exactly as it picks the plate
   * (NSO_SupportAim.nearestBase, kind 'piece'); nothing here aims anything.
   */
  var REST_UP = 0.5;                          // upward: its normal within 60 degrees of straight up
  function restBases(d, host, regionId) {
    var s = scan.find(function (x) { return x.host === host; });
    var region = s && s.det && s.det.ok ? s.det.regions.find(function (r) { return r.id === regionId; }) : null;
    var P = host.positions, plateZ = Infinity, i;
    for (i = 2; i < P.length; i += 3) if (P[i] < plateZ) plateZ = P[i];
    var bases = [{ kind: 'plate', z: s && s.det ? s.det.plateZ : plateZ }];
    if (!region) return bases;
    var lowZ = Infinity;
    region.tris.forEach(function (t) { for (var v = 0; v < 3; v++) lowZ = Math.min(lowZ, P[t * 9 + v * 3 + 2]); });
    hostsOf(d).forEach(function (o) {
      var Q = o.positions, keep = [];
      for (var t = 0; t + 8 < Q.length; t += 9) {
        if (Math.max(Q[t + 2], Q[t + 5], Q[t + 8]) >= lowZ) continue;
        var ux = Q[t + 3] - Q[t], uy = Q[t + 4] - Q[t + 1], uz = Q[t + 5] - Q[t + 2];
        var wx = Q[t + 6] - Q[t], wy = Q[t + 7] - Q[t + 1], wz = Q[t + 8] - Q[t + 2];
        var nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
        var L = Math.hypot(nx, ny, nz);
        if (!(L > 0) || nz / L < REST_UP) continue;
        if (Math.max(Q[t + 2], Q[t + 5], Q[t + 8]) <= bases[0].z + 1e-6) continue;   // the piece's own foot is the plate
        for (var k = 0; k < 9; k++) keep.push(Q[t + k]);
      }
      if (keep.length) bases.push({ kind: 'piece', soup: new Float32Array(keep), id: o.name });
    });
    return bases;
  }

  /**
   * The generator's own call for one marker. Returns a Promise of
   * { ok, soup, plan, reason }. Every style is the ONE planner
   * (nso_support_gridpack.js, through NSO_SupportTree.planTree): 'strut'
   * never merges, 'tree' merges pairwise on the node lattice, 'gecko-hand'
   * is the tree with a hand at every point. The soup is exactly what
   * NSO_SupportGridpack.solid handed back - nothing is done to it here. A
   * plan that holds nothing (every point unreachable from the plate) comes
   * back ok with an empty soup and its own plain line; it is not a refusal.
   * `bases` is restBases' list when the card allows resting on the part;
   * the grid-pack planner takes that as restOnModel and finds each trunk's
   * landing itself.
   */
  function planFor(host, regionId, style, sideMm, baseOpts, bases) {
    var o = genOpts(baseOpts, regionId, style, sideMm);
    if (bases) { o.bases = bases; o.restOnModel = true; }
    /* The planner's regionId names a BEACON region (the Supports card's). This
       row's markers are detectOverhangs' triangle regions, so the planner is
       handed this region's own beacons - the ones on its triangles - labelled
       with this row's number, and plans exactly those. */
    var sc = scan.find(function (x) { return x.host === host; });
    var rg = sc && sc.det && sc.det.ok ? sc.det.regions.find(function (r) { return r.id === regionId; }) : null;
    if (!rg) return Promise.resolve({ ok: false, reason: 'there is no overhang ' + (regionId + 1) + ' on this piece' });
    delete o.regionId;
    o.beacons = (rg.beacons || []).map(function (b) { return Object.assign({}, b, { regionId: regionId }); });
    if (!STYLES[style]) {
      return Promise.resolve({ ok: false, reason: 'unknown support style ' + JSON.stringify(style) });
    }
    if (!ST() || !window.NSO_SupportGridpack) {
      return Promise.resolve({ ok: false, reason: 'nso_support_tree.js / nso_support_gridpack.js are not loaded' });
    }
    o.style = style;
    var t = ST().planTree(host.positions, o);
    if (!t.ok) return Promise.resolve({ ok: false, plan: t, reason: t.reason });
    return window.NSO_SupportGridpack.solid(t).then(function (u) {
      return u.ok ? { ok: true, soup: u.soup, plan: t, union: u, reason: t.reason }
                  : { ok: false, plan: t, union: u, reason: u.reason };
    });
  }

  /** The world soup a placed mesh really shows, in Z-up millimetres. */
  function worldZUp(mesh) {
    var s = meshToWorldSoup(mesh), out = new Float32Array(s.length);
    for (var i = 0; i < s.length; i += 3) { out[i] = s[i]; out[i + 1] = -s[i + 2]; out[i + 2] = s[i + 1]; }
    return out;
  }

  /**
   * Put a generated soup on the plate exactly where it was generated. Returns
   * { ok, id, entry, maxErrMm } or a refusal. Not an undo step by itself:
   * the caller pushes the one step the user sees.
   */
  function placeSupport(soup, meta, host, detOpts) {
    var hostPlaced = state.placed[host.placedIndex];
    if (!hostPlaced) return { ok: false, reason: 'the piece is no longer on the plate' };
    var b = boundsOf(soup);
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(soup), 3));
    var name = host.name + ' - support ' + (supportsFor(host.sourceId).length + 1) +
      ' (' + STYLES[meta.style] + ')';
    var id = addModelFromZUpGeometry(name, geo, { keepSelection: true, silent: true });
    if (!id) return { ok: false, reason: 'the support could not be added' };
    var m = modelOf(id);
    m.nsoSupport = meta;
    // x / z from the soup's own box (view z is -y); y so its bottom sits
    // where the generator put it, and the export's liftY carries the same
    // offset from the host's bottom that the scene shows.
    var entry = placeModelMovable(m, (b.lo[0] + b.hi[0]) / 2, -(b.lo[1] + b.hi[1]) / 2);
    entry.mesh.position.y = (b.lo[2] + b.hi[2]) / 2;
    entry.liftY = (hostPlaced.liftY || 0) + (b.lo[2] - host.bounds.minZ);
    entry.mesh.updateMatrixWorld(true);

    // Read it back off the scene: the support must stand exactly where the
    // generator built it. Same triangle order, so compared value for value.
    var back = worldZUp(entry.mesh), err = 0;
    if (back.length !== soup.length) err = Infinity;
    else for (var i = 0; i < soup.length; i++) err = Math.max(err, Math.abs(back[i] - soup[i]));
    if (!(err <= 1e-3)) {
      removePieces([id]);
      return { ok: false, reason: 'the placed support did not land where it was generated (' +
        err.toExponential(2) + ' mm off) - nothing was added' };
    }
    // What it touches, now, on the region it was made for: the contacts
    // standingFor() holds it to from here on (see touches()).
    var reg = regionOf(host, meta, detOpts);
    meta.contacts = reg ? contactsOn(soup, host.positions, reg, meta.sideMm).hit : [];
    return { ok: true, id: id, entry: entry, maxErrMm: err, name: name, contacts: meta.contacts.length };
  }

  /** The host's region a support is labelled for: detection run again on
      the host as it is, with the SAME options generation used (taken before
      any old support came off the plate - read afterwards, the plate
      document still holds the removed piece and would count it as an
      occluder). */
  function regionOf(host, meta, detOpts) {
    var det = (detOpts && SA()) ? SA().detectOverhangs(host.positions, detOpts) : null;
    return det && det.ok ? det.regions.find(function (r) { return r.id === meta.regionId; }) || null : null;
  }

  /** Take pieces off the plate and out of the model list. No undo step. */
  function removePieces(ids) {
    var drop = new Set(ids);
    var removed = [];
    state.placed.forEach(function (p, i) {
      if (p && drop.has(p.sourceId)) removed.push({ placed: p, placedIndex: i });
    });
    removed.forEach(function (r) {
      var m = modelOf(r.placed.sourceId);
      r.model = m;
      r.modelIndex = state.models.indexOf(m);
    });
    state.placed = state.placed.filter(function (p) { return !(p && drop.has(p.sourceId)); });
    state.models = state.models.filter(function (m) { return !drop.has(m.id); });
    removed.forEach(function (r) { if (r.placed.mesh && r.placed.mesh.parent) r.placed.mesh.parent.remove(r.placed.mesh); });
    state.placed.forEach(function (p, i) { if (p.mesh) p.mesh.userData.placedIndex = i; });
    state.selectedIndex = -1;
    if (typeof renderModelList === 'function') renderModelList();
    if (typeof updateOptimizeButton === 'function') updateOptimizeButton();
    if (typeof updateEditSize === 'function') updateEditSize();
    if (typeof updateAdjustUI === 'function') updateAdjustUI();
    return removed;
  }

  /**
   * Read the plate again after a support was added, changed or removed, and
   * leave the camera where the user had it: they were looking under a piece
   * on purpose, and a re-read that snaps back to the overview throws that away.
   */
  function reread() {
    var v = MS().getView();
    var pos = v ? v.camera.position.clone() : null, tgt = v ? v.controls.target.clone() : null;
    MS().openPlate();
    if (v && pos) { v.camera.position.copy(pos); v.controls.target.copy(tgt); v.controls.update(); }
  }

  function hostBySourceId(d, sid) {
    return d ? d.objects.find(function (o) { return o.sourceId === sid; }) || null : null;
  }

  /**
   * Generate a support for one marker: host piece, region id, style, size,
   * and { rest } - may it stand on the part ("May rest on the part", off
   * unless asked). The whole click path runs through here, and so does the
   * drive check. Every result carries the beacons with their states, the
   * readout line, and `plain` - what the card says.
   *
   * IDEMPOTENT: a region that already has supports gets them REPLACED - the
   * old ones come off and the new one goes on as ONE undo step - never a
   * second support stacked inside the first.
   */
  function generateAt(hostName, regionId, style, sideMm, opt) {
    var rest = !!(opt && opt.rest);
    if (busy) return Promise.resolve({ ok: false, reason: 'busy', plain: plainWhy({ reason: 'busy' }) });
    var d = plateDoc();
    if (!d) return Promise.resolve({ ok: false, reason: 'G-scope is not on the plate', plain: 'Read the plate first (IMPORT ▾, Read plate).' });
    var host = d.objects.find(function (o) { return o.name === hostName; });
    if (!host || isSupportId(host.sourceId)) return Promise.resolve({ ok: false, reason: 'no such piece: ' + hostName, plain: 'That piece is not on the plate.' });
    var o = optsFor(d, host);
    if (o.reason) { say('Support refused - ' + o.reason, true); return Promise.resolve({ ok: false, reason: o.reason, plain: o.reason }); }
    var s0 = scan.find(function (x) { return x.host === host; });
    var region = s0 && s0.det && s0.det.ok ? s0.det.regions.find(function (r) { return r.id === regionId; }) : null;
    busy = true;
    say('Generating a ' + STYLES[style] + ' support...');
    return planFor(host, regionId, style, sideMm, o.opts, rest ? restBases(d, host, regionId) : null).then(function (g) {
      var reg = (g.plan && g.plan.region) || region;
      var beacons = reg ? beaconStates(reg, style, g, gridPitch(s0, g)) : [];
      var key = host.sourceId + '|' + regionId + '|' + style;
      if (!g.ok) {
        var why = plainWhy(g, rest);
        tried[key] = beacons;
        drawBeacons();
        say('Support refused - nothing added. ' + why, true);
        return Object.assign({}, g, { plain: why, beacons: beacons, readout: readout(beacons) });
      }
      if (!g.soup.length) {
        var none = plainWhy(g, rest);
        tried[key] = beacons;
        drawBeacons();
        say('Nothing added - ' + none, true);
        return { ok: false, nothing: true, plan: g.plan, reason: g.reason, plain: none, beacons: beacons, readout: readout(beacons) };
      }
      var old = supportsFor(host.sourceId, regionId).map(function (m) { return m.id; });
      var removed = old.length ? removePieces(old) : [];
      var meta = { hostSourceId: host.sourceId, hostName: host.name, regionId: regionId, style: style,
        sideMm: g.plan.sideMm || +sideMm, angleDeg: angleDeg,
        point: reg ? reg.point.slice() : null, rest: rest, beacons: beacons };
      var pl = placeSupport(g.soup, meta, host, o.opts);
      if (!pl.ok) {
        restorePieces(removed);
        var w2 = plainWhy(pl, rest);
        say('Support refused - ' + w2, true);
        return Object.assign({}, pl, { plain: w2 });
      }
      delete tried[key];
      if (typeof pushUndo === 'function') {
        pushUndo(removed.length
          ? { type: 'supportSwap', removed: removed, addedIds: [pl.id], label: 'Undo: the earlier support restored' }
          : { type: 'addModels', ids: [pl.id], editId: state.editId, cutT: state.cutT });
      }
      var line = readout(beacons);
      say('Support added under overhang ' + (regionId + 1) + ' on ' + host.name + ': ' + line +
        (removed.length ? ' (replacing ' + removed.length + ' earlier)' : ''));
      reread();                          // the support is now a piece
      return { ok: true, id: pl.id, soup: g.soup, plan: g.plan, maxErrMm: pl.maxErrMm, name: pl.name,
        beacons: beacons, readout: line, plain: line,
        replaced: removed.map(function (r) { return r.placed.sourceId; }) };
    }).catch(function (err) {
      console.error('[g-scope support]', err);
      say('Support failed - nothing added.', true);
      return { ok: false, reason: (err && err.message) || String(err), plain: 'Something went wrong - nothing was added.' };
    }).then(function (r) { busy = false; return r; });
  }

  /** Put pieces removePieces took back exactly as they were. No undo step. */
  function restorePieces(removed) {
    removed.forEach(function (r) {
      state.models.splice(Math.min(r.modelIndex, state.models.length), 0, r.model);
      state.placed.splice(Math.min(r.placedIndex, state.placed.length), 0, r.placed);
      if (r.placed.mesh && state.modelGroup) state.modelGroup.add(r.placed.mesh);
    });
    state.placed.forEach(function (p, i) { if (p.mesh) p.mesh.userData.placedIndex = i; });
    if (typeof renderModelList === 'function') renderModelList();
  }

  /** One support off the plate, one undo step. */
  function removeSupport(id) {
    var m = modelOf(id);
    if (!m || !m.nsoSupport) return { ok: false, reason: 'that piece is not a G-scope support' };
    var removed = removePieces([id]);
    if (typeof pushUndo === 'function') {
      pushUndo({ type: 'supportSwap', removed: removed, addedIds: [], label: 'Undo: support restored' });
    }
    say('Removed ' + m.name + ' - Undo puts it back');
    closePop();
    if (plateDoc()) reread();
    return { ok: true, removed: id };
  }

  /** Regenerate one support with a new style / size, replacing it: one step. */
  function adjustSupport(id, style, sideMm, opt) {
    var m = modelOf(id);
    if (!m || !m.nsoSupport) return Promise.resolve({ ok: false, reason: 'that piece is not a G-scope support' });
    var rest = opt && opt.rest != null ? !!opt.rest : !!m.nsoSupport.rest;
    var d = plateDoc();
    var host = hostBySourceId(d, m.nsoSupport.hostSourceId);
    if (!host) return Promise.resolve({ ok: false, reason: 'the piece this support holds up is gone', plain: 'The piece this support holds up is gone.' });
    var o = optsFor(d, host);
    if (o.reason) return Promise.resolve({ ok: false, reason: o.reason, plain: o.reason });
    if (busy) return Promise.resolve({ ok: false, reason: 'busy', plain: plainWhy({ reason: 'busy' }) });
    busy = true;
    var regionId = m.nsoSupport.regionId;
    var s0 = scan.find(function (x) { return x.host === host; });
    var region = s0 && s0.det && s0.det.ok ? s0.det.regions.find(function (r) { return r.id === regionId; }) : null;
    return planFor(host, regionId, style, sideMm, o.opts, rest ? restBases(d, host, regionId) : null).then(function (g) {
      if (!g.ok) { var why = plainWhy(g, rest); say('Support change refused - unchanged. ' + why, true); return Object.assign({}, g, { plain: why }); }
      if (!g.soup.length) {
        var none = plainWhy(g, rest);
        say('Support unchanged - ' + none, true);
        return { ok: false, nothing: true, plan: g.plan, reason: g.reason, plain: none };
      }
      var reg = (g.plan && g.plan.region) || region;
      var beacons = reg ? beaconStates(reg, style, g, gridPitch(s0, g)) : [];
      var removed = removePieces([id]);
      var meta = Object.assign({}, m.nsoSupport, { style: style, sideMm: g.plan.sideMm || +sideMm, rest: rest, beacons: beacons });
      var pl = placeSupport(g.soup, meta, host, o.opts);
      if (!pl.ok) {
        // Put the old one back exactly as it was; no step was recorded.
        restorePieces(removed);
        var w2 = plainWhy(pl, rest);
        say('Support change refused - unchanged. ' + w2, true);
        return Object.assign({}, pl, { plain: w2 });
      }
      if (typeof pushUndo === 'function') {
        pushUndo({ type: 'supportSwap', removed: removed, addedIds: [pl.id], label: 'Undo: support change reverted' });
      }
      var line = readout(beacons);
      say('Support changed - ' + pl.name + ': ' + line);
      closePop();
      reread();
      return { ok: true, id: pl.id, replaced: id, soup: g.soup, plan: g.plan, beacons: beacons, readout: line, plain: line };
    }).catch(function (err) {
      console.error('[g-scope support]', err);
      return { ok: false, reason: (err && err.message) || String(err), plain: 'Something went wrong - nothing was changed.' };
    }).then(function (r) { busy = false; return r; });
  }

  // =========================================================================
  // Clicks: a marker opens "generate", a support opens "edit"
  // =========================================================================

  function clickHook(nx, ny, e) {
    var d = plateDoc(), v = MS().getView();
    if (!d || !v) return false;
    var rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(nx, ny), v.camera);
    // Pings sit on top of everything (depthTest off), so a ping under the
    // cursor wins even when the piece is in front of it.
    if (on && markers.length) {
      var pings = rc.intersectObjects(markers.map(function (m) { return m.ping; }), false);
      if (!pings.length) pings = rc.intersectObjects(markers.map(function (m) { return m.overlay; }), false);
      if (pings.length) { openPopNew(pings[0].object.userData.marker, e); return true; }
    }
    var sup = Object.keys(v.overviewMeshes).map(function (k) { return v.overviewMeshes[k]; })
      .filter(function (m) { return m.visible && m.userData.object && isSupportId(m.userData.object.sourceId); });
    if (!sup.length) return false;
    var all = rc.intersectObjects(Object.keys(v.overviewMeshes).map(function (k) { return v.overviewMeshes[k]; })
      .filter(function (m) { return m.visible; }), false);
    if (!all.length) return false;
    var hit = all[0].object.userData.object;
    if (!hit || !isSupportId(hit.sourceId)) return false;
    selectSupport(hit.sourceId, e);
    return true;
  }

  function selectSupport(id, e) {
    var d = plateDoc();
    var o = d && d.objects.find(function (x) { return x.sourceId === id; });
    if (!o) return false;
    MS().selectObjects([o.name], 'support');
    openPopEdit(id, e);
    return true;
  }

  /*
   * WHERE THE CARD GOES. Next to the marker it belongs to - below and to the
   * right of it - and always wholly inside the part of the viewport the
   * window really shows (the viewport can run past the window's edge). No
   * room below: it flips above the marker. No room above either: it pins
   * under G-scope's card, at the left wall (--shell-pad, --ms-card-bottom:
   * the card publishes its bottom edge), measured inside the viewport. Taller than the
   * window shows, it scrolls inside itself rather than running off. And it is
   * placed again whenever what it says changes, so a long message never
   * grows it past the edge after it was placed.
   */
  var POP_GAP = 14, POP_MARGIN = 8, POP_RIGHT = 90;     // the layer slider's strip on the right

  function shellSpot(host) {
    var probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;width:0;height:0;' +
      'left:var(--shell-pad, 8px);top:calc(var(--ms-card-bottom, 140px) + 8px)';
    host.appendChild(probe);
    var at = { x: probe.offsetLeft, y: probe.offsetTop };
    host.removeChild(probe);
    return at;
  }

  function anchorOf(e) {
    if (e && isFinite(e.clientX) && isFinite(e.clientY)) return { x: e.clientX, y: e.clientY };
    return null;
  }

  /** The screen point of a world Z-up point, in client px. */
  function screenOf(p) {
    var v = MS() && MS().getView();
    if (!v) return null;
    var q = MS().toView(p[0], p[1], p[2]).project(v.camera);
    var r = v.renderer.domElement.getBoundingClientRect();
    return { x: r.left + (q.x + 1) / 2 * r.width, y: r.top + (1 - q.y) / 2 * r.height };
  }

  function placePop(anchor) {
    var el = $('ms-support-pop'), host = $('ms-viewport');
    if (!el || !host) return;
    if (anchor !== undefined) popAnchor = anchor;
    el.hidden = false;
    var r = host.getBoundingClientRect();
    var top = Math.max(r.top, 0) + POP_MARGIN, bottom = Math.min(r.bottom, window.innerHeight) - POP_MARGIN;
    var left = Math.max(r.left, 0) + POP_MARGIN, right = Math.min(r.right, window.innerWidth) - POP_MARGIN;
    el.style.maxHeight = Math.max(80, bottom - top) + 'px';
    var w = el.offsetWidth, h = el.offsetHeight, x, y, how;
    var a = popAnchor || { x: left + 72, y: top + 72 };
    if (a.y + POP_GAP + h <= bottom) { x = a.x + POP_GAP; y = a.y + POP_GAP; how = 'below'; }
    else if (a.y - POP_GAP - h >= top) { x = a.x + POP_GAP; y = a.y - POP_GAP - h; how = 'above'; }
    else { var sp = shellSpot(host); x = r.left + sp.x; y = r.top + sp.y; how = 'pinned'; }
    var maxX = right - w - (right - w - POP_RIGHT >= left ? POP_RIGHT : 0);
    x = Math.max(left, Math.min(maxX, x));
    y = Math.max(top, Math.min(bottom - h, y));
    el.style.left = (x - r.left) + 'px';
    el.style.top = (y - r.top) + 'px';
    el.dataset.place = how;
  }

  /** Say something on the card, and keep the card inside the window. */
  function cardSay(text) {
    var el = $('ms-sp-read');
    if (el) el.textContent = text;
    if (pop && !$('ms-support-pop').hidden) placePop();
  }

  function openPopNew(mk, e) {
    pop = { kind: 'new', marker: mk };
    picked = { hostSourceId: mk.host.sourceId, regionId: mk.region.id };
    var r = mk.region;
    $('ms-sp-title').textContent = 'Overhang ' + (r.id + 1) + ' on ' + mk.host.name;
    $('ms-sp-sub').textContent = 'An underside of ' + num(r.areaMm2) + ' mm\u00b2, ' + num(r.dropMm) +
      ' mm above the plate' +
      (mk.supported ? '. It already has a support.' :
        mk.stale && mk.stale.length ? '. ' + mk.stale.join(', ') + ' was made for it but no longer ' +
          'touches it - a piece was moved, turned or mirrored.' : '.');
    var rest = $('ms-sp-rest');
    if (rest) rest.checked = false;
    showButtons('new');
    drawBeacons();
    cardSay(plannedLine(mk));
    placePop(anchorOf(e) || screenOf(r.point));
  }

  /** What the card says before Generate: how many spots need holding. */
  function plannedLine(mk) {
    var n = (mk.beacons || []).length;
    return n ? plural(n, 'spot needs', 'spots need') + ' holding, shown on the part.' : '';
  }

  function openPopEdit(id, e) {
    var m = modelOf(id);
    pop = { kind: 'edit', supportId: id };
    picked = null;
    drawBeacons();
    $('ms-sp-title').textContent = m.name;
    $('ms-sp-sub').textContent = 'Holds up overhang ' + (m.nsoSupport.regionId + 1) + ' on ' +
      m.nsoSupport.hostName + '. Change it, or remove it - one Undo either way.';
    $('ms-sp-style').value = m.nsoSupport.style;
    $('ms-sp-size').value = num(m.nsoSupport.sideMm);
    var rest = $('ms-sp-rest');
    if (rest) rest.checked = !!m.nsoSupport.rest;
    showButtons('edit');
    $('ms-sp-read').textContent = m.nsoSupport.beacons ? readout(m.nsoSupport.beacons) : '';
    placePop(anchorOf(e));
  }

  function showButtons(kind) {
    [['ms-sp-generate', kind === 'new'], ['ms-sp-apply', kind === 'edit'], ['ms-sp-remove', kind === 'edit']]
      .forEach(function (b) { var el = $(b[0]); if (el) el.style.display = b[1] ? '' : 'none'; });
  }

  function closePop() {
    var had = !!picked;
    pop = null;
    picked = null;
    var el = $('ms-support-pop');
    if (el) el.hidden = true;
    if (had && layer) drawBeacons();
  }

  /** The card's own controls changed: the picked region's beacons follow. */
  function cardChanged() {
    if (!pop || pop.kind !== 'new') return;
    drawBeacons();
    cardSay(plannedLine(pop.marker));
  }

  function popGenerate() {
    if (!pop || pop.kind !== 'new') return null;
    var mk = pop.marker, anchor = popAnchor;
    cardSay('Generating...');
    return generateAt(mk.host.name, mk.region.id, cardStyle(), cardSize(), { rest: cardRest() })
      .then(function (r) {
        if (r.ok) {
          // The re-read closed the card; open it again on the support just
          // made, where it was, saying what the plan holds.
          if (modelOf(r.id)) { openPopEdit(r.id, anchor && { clientX: anchor.x, clientY: anchor.y }); cardSay(r.readout); }
        } else {
          var counted = (r.beacons || []).some(function (x) { return x.state !== 'planned'; });
          cardSay((counted ? r.readout + '. ' : '') + 'Not added: ' + r.plain);
        }
        return r;
      });
  }

  function popApply() {
    if (!pop || pop.kind !== 'edit') return null;
    var anchor = popAnchor;
    cardSay('Regenerating...');
    return adjustSupport(pop.supportId, cardStyle(), cardSize(), { rest: cardRest() })
      .then(function (r) {
        if (r.ok) { if (modelOf(r.id)) { openPopEdit(r.id, anchor && { clientX: anchor.x, clientY: anchor.y }); cardSay(r.readout); } }
        else cardSay('Unchanged: ' + r.plain);
        return r;
      });
  }

  // =========================================================================
  // Panel
  // =========================================================================

  /* G-scope's Overhangs row (Show overhangs, the angle, its readout) was
     removed in the G-scope redo, round 1b (docs/GSCOPE.md, item 5): overhang
     detection is the plate SUPPORTS card's. Nothing in G-scope switches the
     markers on now; setOn() is the only way in (the helper registry's checks
     use it), and there is no row left to report into. */
  function syncPanel() {}

  function bind(id, ev, fn) {
    var el = $(id);
    if (el && el.dataset.wired !== '1') { el.dataset.wired = '1'; el.addEventListener(ev, fn); }
  }

  function mount() {
    if (!MS()) return;
    MS().addClickHook(clickHook);
    MS().onDocument(function () { closePop(); ensureLayer(); refresh(); });
    bind('ms-sp-generate', 'click', popGenerate);
    bind('ms-sp-apply', 'click', popApply);
    bind('ms-sp-remove', 'click', function () { if (pop && pop.kind === 'edit') removeSupport(pop.supportId); });
    bind('ms-sp-cancel', 'click', closePop);
    bind('ms-sp-style', 'change', cardChanged);
    bind('ms-sp-size', 'change', cardChanged);
    bind('ms-sp-rest', 'change', function () {
      // A refused try was made with the other setting: its states no longer say anything.
      if (pop && pop.kind === 'new') delete tried[pop.marker.host.sourceId + '|' + pop.marker.region.id + '|' + cardStyle()];
      cardChanged();
    });
    window.addEventListener('resize', function () { if (pop) placePop(); });
    syncPanel();
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
  }

  return {
    STYLES: Object.assign({}, STYLES),
    setOn: setOn,
    isOn: function () { return on; },
    setAngle: function (a) { angleDeg = +a; refresh(); },
    refresh: refresh,
    scan: function () { return scan; },
    markers: function () { return markers; },
    optsFor: function (hostName) {
      var d = plateDoc(), h = d && d.objects.find(function (o) { return o.name === hostName; });
      return h ? optsFor(d, h) : null;
    },
    planFor: function (hostName, regionId, style, sideMm, opt) {
      var d = plateDoc(), h = d && d.objects.find(function (o) { return o.name === hostName; });
      if (!h) return Promise.resolve({ ok: false, reason: 'no such piece' });
      return planFor(h, regionId, style, sideMm, optsFor(d, h).opts,
        opt && opt.rest ? restBases(d, h, regionId) : null);
    },
    /** The beacons a marker shows now (null when it shows its ping). */
    beaconsOf: function (hostName, regionId) {
      var mk = markers.find(function (m) { return m.host.name === hostName && m.region.id === regionId; });
      return mk ? mk.beacons : null;
    },
    readout: readout,
    generateAt: generateAt,
    removeSupport: removeSupport,
    adjustSupport: adjustSupport,
    selectSupport: selectSupport,
    standing: function (hostName, regionId) {
      var d = plateDoc(), s = scan.find(function (x) { return x.host.name === hostName; });
      var r = s && s.det && s.det.ok && s.det.regions.find(function (x) { return x.id === regionId; });
      return r ? standingFor(d, s.host, r) : null;
    },
    supports: function () { return (state.models || []).filter(function (m) { return m && m.nsoSupport; }); },
    popGenerate: popGenerate,
    popApply: popApply,
    closePop: closePop
  };
})();

if (typeof window !== 'undefined') window.NSO_GSCOPE_SUPPORT = NSO_GSCOPE_SUPPORT;
