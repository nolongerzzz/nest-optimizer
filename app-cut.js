// The yaw drag (and the Cut card's yaw buttons, until the mitre wheel
// replaced them) turns the piece itself, not its pose on the plate. They used to turn the display geometry alone: a piece loaded
// from a file is cut from its raw triangles (rawTris, through centerOffset -
// mapPlaneToRaw), which stayed where they were, so Split cut the unturned
// piece with a plane placed on the turned one - at 90 deg a 60 mm bar was
// sliced along its length, at 15 deg it was cut square instead of on the
// slant the blade showed. Now the raw triangles turn with it, about the same
// centre, and centerOffset follows the re-centring, so the raw triple maps
// onto the turned display geometry exactly as it did onto the old one.
//
// Display yaw about Y is a turn about raw Z (display is (x, z, -y) of raw,
// less centerOffset): raw (x, y) -> (x c - y s, x s + y c). Quarter turns use
// exact 0 / +-1, so turning back restores the piece.
//
// The geometry and the soup are replaced, not written in place, as a bake
// replaces them: an undo snapshot holding the old ones keeps a matching
// triple, and whatever is keyed on the old soup (the Scale card's section
// cache, a Soften run) sees a new piece.
function rotateActiveModelY(deg) {
  const m = getActiveModel();
  if (!m || !m.geometry) return;
  const r = (deg * Math.PI) / 180;
  const exact = v => (Math.abs(v) < 1e-12 ? 0 : Math.abs(Math.abs(v) - 1) < 1e-12 ? Math.sign(v) : v);
  const c = exact(Math.cos(r)), s = exact(Math.sin(r));
  const geo = m.geometry.clone();
  geo.applyMatrix4(new THREE.Matrix4().set(c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1));
  geo.computeBoundingBox();
  const shift = geo.boundingBox.getCenter(new THREE.Vector3());
  geo.translate(-shift.x, -shift.y, -shift.z);
  if (m.rawTris && m.rawAxis === 'zup' && m.centerOffset) {
    const off = m.centerOffset;
    const px = off.x, py = -off.z;           // the raw point the display origin is
    const t = new Float32Array(m.rawTris);
    for (let i = 0; i < t.length; i += 3) {
      const x = t[i] - px, y = t[i + 1] - py;
      t[i] = px + x * c - y * s;
      t[i + 1] = py + x * s + y * c;
    }
    m.rawTris = t;
    m.centerOffset = { x: off.x + shift.x, y: off.y + shift.y, z: off.z + shift.z };
  }
  // The old geometry's GPU buffers go (three uploads them again if a
  // snapshot's copy is ever drawn); a yaw drag would otherwise leave one
  // buffer behind per pointer move.
  const old = m.geometry;
  m.geometry = geo;
  old.dispose();
  m.geometry.computeBoundingBox();
  const bb = m.geometry.boundingBox;
  m.size = {
    x: bb.max.x - bb.min.x,
    y: bb.max.y - bb.min.y,
    z: bb.max.z - bb.min.z
  };
  m.orientedGeometry = null;
  updateEditSize();
  if (state.cutterOpen) showEditPreview();
  else previewModelOnPlate(m.geometry, m.size);
  setStatus('Piece yaw ' + (deg > 0 ? '+' : '') + deg + ' deg (Y only - no free orbit)');
}

/* The box of a geometry's own vertices; kept for a big one (nso-bounds.js). */
function localBox3(geometry) {
  return (window.nsoBounds && window.nsoBounds.localBox ? window.nsoBounds.localBox(geometry) : null) ||
    new THREE.Box3().setFromBufferAttribute(geometry.attributes.position);
}

function getActiveModel() {
  if (state.editId != null) {
    const found = state.models.find(m => m.id === state.editId);
    if (found) return found;
  }
  return null;
}

function updateEditSize() {
  const el = document.getElementById('edit-size');
  const m = getActiveModel();
  if (!el) return;
  if (!m) {
    el.textContent = 'Load an STL to see size.';
    syncCutRightSideOutButton();
    return;
  }
  el.textContent = m.name + ': ' + m.size.x.toFixed(1) + ' x ' + m.size.y.toFixed(1) + ' x ' + m.size.z.toFixed(1) + ' mm (X x H x Z)';
  syncCutUI();
  syncCutRightSideOutButton();
}

// Crop's axis (and Array's): Crop X / Crop Z first (app-crop.js), then the
// programmatic lock and the hidden select, then the longer of X and Z.
function resolveAxis(model) {
  if (state.cropAxis === 'x' || state.cropAxis === 'z') return state.cropAxis;
  if (state.cutAxis === 'x' || state.cutAxis === 'z') return state.cutAxis;
  const sel = (document.getElementById('edit-axis') || {}).value || 'auto';
  if (sel === 'x' || sel === 'z') return sel;
  if (model && model.geometry && model.geometry.attributes && model.geometry.attributes.position) {
    const bb = localBox3(model.geometry);
    const sx = bb.max.x - bb.min.x;
    const sz = bb.max.z - bb.min.z;
    return sx >= sz ? 'x' : 'z';
  }
  return model.size.x >= model.size.z ? 'x' : 'z';
}

// ===================== The cut frame =====================
// One frame for everything the cutter shows or does: the mm readout, the
// slider, the number box, the blade, the plate line and the plane Cut cuts.
//
// THE SQUARE CUT. The blade stands across the piece's LONGEST dimension as it
// lies, so the default cut passes through the short cross-section and
// severs the long way (cut to length). "As it lies" is the piece's frame -
// pieceFrame (nso-bounds.js), the one frame every tool reads: the long side
// of its footprint, or the plate vertical when the piece stands taller than
// it is long. Every pose action is baked when it ends (app-core.js
// nsoBakePlacedPose), so the geometry's own box says nothing about which way
// a turned piece lies; its footprint does. The blade travels along that
// line, so a square blade is plumb on a piece that was leaned, and square to
// the length of one that was turned. `axis` is the local axis nearest it and
// `base` the turn about the vertical from that axis to it (0 for a piece
// lying square, so the frame is the local one bit for bit); `plateAxis`
// names the plate direction it runs along now ('y' for a piece stood on
// end), for the readout and for which way the halves are parted on the
// plate. Ties go x, then z, then y.
//
// A programmatic lock, state.cutAxis = 'x' | 'z', is kept for the checks
// that cut a piece across a chosen plate axis (a tube's bore on every
// axis): with it set, the axis is the piece's own axis that plate axis runs
// along under its pose, as before. No control sets it.
//
// THE MITRE. state.cutMiterDeg turns the cut plane's heading about the plate
// vertical, clockwise seen from above; 0 = square. Everything below works in
// the CUT frame: the piece's own frame turned by `turn` (that heading, about
// the plate vertical as it lies in the piece's frame), where the plane is
// axis-aligned again - #161's yaw, done to a copy. `back` carries the cut
// frame into the piece's own frame. Square, both are null and the cut frame
// is the piece's own frame, bit for bit.
//
// THE BEVEL. state.cutBevelDeg leans the blade off plumb, -90..90; 0 = no
// lean. After the mitre has turned it, the blade is leaned about its own
// horizontal line (in the blade, square to the plate vertical), and a
// positive bevel tips the top of the blade toward the piece's far end (the
// high end of its travel axis). `turn` and `back` then hold the mitre and the
// bevel together; at Bevel 0 the lean is not applied at all, so the cut
// frame is the mitre's own, bit for bit. A blade lying flat (a piece stood
// on end, square) has no horizontal line: it leans about the cut frame's
// next axis, turned by the mitre, so the mitre picks the way it leans.
//
// `mm` is the plane's distance from its low end along the BLADE'S OWN TRAVEL
// AXIS: the plane's normal, which is the long axis when square and the long
// axis turned by the mitre otherwise. The low end is the piece's extreme
// along that normal, and `span` is the piece's whole extent along it (the
// piece's length when square). So one mm is one mm of blade travel at every
// mitre, the slider and the pointer drag keep their full range however the
// plane is turned, and at 90 the plane travels across the piece's width
// where it used to be pinned to the centre line. The plane may come no closer
// than CUT_END_MM to either end: a fixed distance, so a sliver is as
// reachable on a 300 mm piece as on a 30 mm one. It is MIN_CUT_SIDE_MM
// (app-core.js), the distance Cut itself demands, so the end of the slider is
// never a position Cut refuses. Positions sit on a 0.1 mm grid from the low
// end, the readout's resolution, so the number shown is the plane cut.
// (Headless checks load this file without app-core.js; 1 mm is its value.)
const CUT_END_MM = (typeof MIN_CUT_SIDE_MM !== 'undefined') ? MIN_CUT_SIDE_MM : 1;
// What the ← / → buttons step the blade by: one grid step, or 1 mm with Shift.
const CUT_NUDGE_MM = 0.1;
const CUT_NUDGE_SHIFT_MM = 1;
// What the mitre − / + buttons step by: 1 degree, 0.1 with Shift, 5 with Alt
// (Alt wins if both are down). Held, a button repeats after CUT_MITER_HOLD_MS
// at one step every CUT_MITER_REPEAT_MS.
const CUT_MITER_STEP_DEG = 1;
const CUT_MITER_STEP_SHIFT_DEG = 0.1;
const CUT_MITER_STEP_ALT_DEG = 5;
const CUT_MITER_HOLD_MS = 400;
const CUT_MITER_REPEAT_MS = 100;
// The bevel dial's drag (as the rotate rings' since #229): a press is a click
// until the pointer has travelled CUT_BEVEL_CLICK_SLOP_PX, and while dragging
// the bevel sits ON a painted tick (every CUT_BEVEL_DETENT_DEG) inside
// CUT_BEVEL_SNAP_WITHIN_DEG of it. A click on a dart, or an arrow key, is
// 1 degree, 0.1 with Shift.
const CUT_BEVEL_MAX_DEG = 90;
const CUT_BEVEL_DETENT_DEG = 45;
const CUT_BEVEL_SNAP_WITHIN_DEG = 3;
const CUT_BEVEL_CLICK_SLOP_PX = 4;
const CUT_BEVEL_STEP_DEG = 1;
const CUT_BEVEL_STEP_SHIFT_DEG = 0.1;

function cutMeshOf(m) {
  const placed = (state.placed || []).find(function (p) { return p && p.sourceId === m.id && p.mesh; });
  return placed ? placed.mesh : (state.previewMesh || null);
}

// The nearest and farthest allowed plane, in mm from the low end, on the grid.
function cutEndLimits(span) {
  let lo = Math.ceil(CUT_END_MM * 10 - 1e-9) / 10;
  let hi = Math.floor((span - CUT_END_MM) * 10 + 1e-9) / 10;
  if (!(hi >= lo)) lo = hi = Math.round(span * 5) / 10;   // too short to cut: park mid-piece
  return { lo: lo, hi: hi };
}

/** The piece's longest axis in its own frame: 'x', 'z' or 'y' (ties in that order). */
function cutLongAxis(bbox) {
  const s = { x: bbox.max.x - bbox.min.x, y: bbox.max.y - bbox.min.y, z: bbox.max.z - bbox.min.z };
  let a = 'x';
  if (s.z > s[a]) a = 'z';
  if (s.y > s[a]) a = 'y';
  return a;
}

// Exact 0 / +-1 for quarter values, so a turn by a quarter and back is the
// identity bit for bit (#161's rule).
function cutExact(v) {
  return Math.abs(v) < 1e-12 ? 0 : Math.abs(Math.abs(v) - 1) < 1e-12 ? Math.sign(v) : v;
}

/** A turn by `deg` about the unit axis `v` (piece frame), entries snapped. */
function cutTurnMatrix(v, deg) {
  const a = new THREE.Vector3(v.x, v.y, v.z);
  ['x', 'y', 'z'].forEach(k => { if (Math.abs(a[k]) < 1e-9) a[k] = 0; });
  a.normalize();
  const M = new THREE.Matrix4().makeRotationAxis(a, (deg * Math.PI) / 180);
  for (let i = 0; i < 16; i++) M.elements[i] = cutExact(M.elements[i]);
  return M;
}

function cutFrame(model) {
  const m = model || getActiveModel();
  if (!m || !m.geometry || !m.geometry.attributes || !m.geometry.attributes.position) return null;
  const bbox = localBox3(m.geometry);
  const mesh = cutMeshOf(m);
  if (mesh) mesh.updateMatrixWorld(true);
  const toLocal = mesh ? new THREE.Matrix4().copy(mesh.matrixWorld).invert() : null;
  let axis, plateAxis, base = 0;
  if (state.cutAxis === 'x' || state.cutAxis === 'z') {
    plateAxis = state.cutAxis;
    axis = plateAxis;
    if (toLocal) {
      const n = (plateAxis === 'x' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1)).transformDirection(toLocal);
      const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
      axis = (ax >= ay && ax >= az) ? 'x' : (ay >= az ? 'y' : 'z');
    }
  } else {
    const travel = cutTravel(m, mesh, toLocal, bbox);
    axis = travel.axis;
    base = travel.base;
    plateAxis = axis;
    if (mesh) {
      const w = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0)
        .transformDirection(mesh.matrixWorld);
      const ax = Math.abs(w.x), ay = Math.abs(w.y), az = Math.abs(w.z);
      plateAxis = (ay > ax && ay > az) ? 'y' : (ax >= az ? 'x' : 'z');
    }
  }
  const length = bbox.max[axis] - bbox.min[axis];
  if (!(length > 0)) return null;
  const deg = cutMiterDeg(), bevel = cutBevelDeg();
  /* the mitre is measured from the footprint's long side: the normal is the
     local axis turned by the base anticlockwise, then by the mitre clockwise */
  const turnDeg = base ? deg - base : deg;
  let turn = null, back = null;
  // The blade's travel axis in the piece's frame, and the piece's extent
  // along it: `origin` is its low end, `span` its length (the piece's own
  // when square).
  const normal = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
  let origin = bbox.min[axis], span = length;
  // The plate vertical, in the piece's own frame.
  const up = toLocal ? new THREE.Vector3(0, 1, 0).transformDirection(toLocal) : new THREE.Vector3(0, 1, 0);
  if (turnDeg) {
    turn = cutTurnMatrix(up, turnDeg);
    back = cutTurnMatrix(up, -turnDeg);
    normal.applyMatrix4(back);
  }
  if (bevel) {
    const lean = cutLeanBasis(normal, up, axis, back);
    const B = cutTurnMatrix(lean.a, bevel);
    back = back ? B.clone().multiply(back) : B;
    const unB = cutTurnMatrix(lean.a, -bevel);
    turn = turn ? turn.clone().multiply(unB) : unB;
    normal.applyMatrix4(B);
  }
  if (turn) {
    const ext = cutExtentAlong(m.geometry.attributes.position, normal);
    if (ext && ext.hi > ext.lo) { origin = ext.lo; span = ext.hi - ext.lo; }
  }
  const lim = cutEndLimits(span);
  return { plateAxis: plateAxis, axis: axis, bbox: bbox, span: span, origin: origin, normal: normal,
           lo: lim.lo, hi: lim.hi, mesh: mesh, deg: deg, bevel: bevel, up: up, turn: turn, back: back,
           base: base };
}

/* Which way the square blade travels, from the piece's frame (see THE SQUARE
   CUT): { axis: the local axis nearest the travel line, base: the turn about
   the vertical, anticlockwise from above in degrees, from that axis to it -
   the opposite sense to the mitre's, which is why the mitre's turn is the
   mitre less it }. A
   base under 1e-4 degrees is Float32 noise on a piece lying square and is 0,
   so such a piece keeps the local frame bit for bit. With nothing to measure
   (no placed mesh, no nso-bounds), the geometry box decides, as it did. */
function cutTravel(m, mesh, toLocal, bbox) {
  const f = (mesh && typeof nsoBounds !== 'undefined' && nsoBounds.pieceFrame) ? nsoBounds.pieceFrame(mesh) : null;
  if (!f || !toLocal) return { axis: cutLongAxis(bbox), base: 0 };
  const loc = v => v.clone().transformDirection(toLocal);
  const up = loc(new THREE.Vector3(0, 1, 0));
  const AX = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
  if (f.lengths.height > f.lengths.long * (1 + 1e-9)) {
    let best = 'x';
    ['x', 'z', 'y'].forEach(k => { if (Math.abs(AX[k].dot(up)) > Math.abs(AX[best].dot(up)) + 1e-9) best = k; });
    return { axis: best, base: 0 };
  }
  const L = loc(f.long);
  let best = null;
  ['x', 'z', 'y'].forEach(k => {
    if (Math.abs(AX[k].dot(up)) > 0.5) return;               // the vertical is not a level travel line
    if (!best || Math.abs(AX[k].dot(L)) > Math.abs(AX[best].dot(L)) + 1e-9) best = k;
  });
  if (!best) return { axis: cutLongAxis(bbox), base: 0 };
  const a = AX[best].clone().projectOnPlane(up).normalize();
  const l = L.clone().projectOnPlane(up).normalize();
  if (a.dot(l) < 0) l.negate();                              // a line, either sense
  // right-handed about the plate vertical (anticlockwise from above), a to l
  let base = Math.atan2(a.clone().cross(l).dot(up), a.dot(l)) * 180 / Math.PI;
  if (Math.abs(base) < 1e-4) base = 0;
  return { axis: best, base: base };
}

/** The blade's lean, for the travel axis `n` (piece frame, after the mitre)
    and the plate vertical `up` there: `u`, the blade's top (the vertical
    seen in the blade), and `a = u x n`, its horizontal line. A turn by +b
    about `a` carries u toward n: the top toward the far end. `s` is n.up and
    `c` is u.up, so a bevel of atan2(s, c) stands the blade plumb. Flat (n
    along up), `u` is the cut frame's next axis turned by the mitre `back`. */
function cutLeanBasis(n, up, axis, back) {
  const s = n.dot(up);
  const u = up.clone().addScaledVector(n, -s);
  let c = u.length();
  if (c > 1e-6) u.divideScalar(c);
  else {
    const k = ['x', 'y', 'z'].indexOf(axis), j = (k + 1) % 3;
    u.set(j === 0 ? 1 : 0, j === 1 ? 1 : 0, j === 2 ? 1 : 0);
    if (back) u.applyMatrix4(back);
    c = 0;
  }
  return { u: u, a: new THREE.Vector3().crossVectors(u, n).normalize(), s: s, c: c };
}

/** The lowest and highest n.v over the position attribute's vertices: the
    piece's extent along the unit vector `n`. Null for an empty attribute. */
function cutExtentAlong(attr, n) {
  if (!attr || !(attr.count > 0)) return null;
  let lo = Infinity, hi = -Infinity;
  const nx = n.x, ny = n.y, nz = n.z;
  if (attr.array && attr.itemSize === 3 && !attr.isInterleavedBufferAttribute) {
    const a = attr.array;
    for (let i = 0, e = attr.count * 3; i < e; i += 3) {
      const d = nx * a[i] + ny * a[i + 1] + nz * a[i + 2];
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
  } else {
    for (let i = 0; i < attr.count; i++) {
      const d = nx * attr.getX(i) + ny * attr.getY(i) + nz * attr.getZ(i);
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
  }
  return { lo: lo, hi: hi };
}

/** The mitre in degrees on a 0.1 grid, 0..359.9; 0 = square. Kept in tenths
    while it is rounded and wrapped, so steps of 0.1 never drift. */
function cutMiterDeg() {
  const t = Math.round((Number(state.cutMiterDeg) || 0) * 10);
  return (((t % 3600) + 3600) % 3600) / 10;
}

/** The bevel in degrees on a 0.1 grid, -90..90; 0 = no lean (plumb on a
    piece that lies as it was drawn). Clamped, not wrapped: past 90 the blade
    would be the same plane again, upside down. */
function cutBevelDeg() {
  const t = Math.round((Number(state.cutBevelDeg) || 0) * 10);
  const lim = CUT_BEVEL_MAX_DEG * 10;
  return (Math.min(lim, Math.max(-lim, t)) / 10) || 0;
}

// The plane's distance from the low end for fraction t, on the grid and
// inside the limits.
function cutMmAt(t, span) {
  const lim = cutEndLimits(span);
  const mm = Math.round((Number(t) || 0) * span * 10) / 10;
  return Math.min(lim.hi, Math.max(lim.lo, mm));
}

function getCutSpan(model) {
  const f = cutFrame(model);
  return f ? f.span : 0;
}

function getCutMm() {
  const f = cutFrame(getActiveModel());
  return f ? cutMmAt(state.cutT, f.span) : 0;
}

/** Snap a fraction to the 0.1 mm grid and the end limits; returns a fraction. */
function snapCutT(t, span) {
  if (!(span > 0)) return t;
  return cutMmAt(t, span) / span;
}

/** cutT and the mitre drive the plane. The blade is a display of them.

    In the CUT frame: `axis`, `plane` and `bbox` (the piece's box turned into
    that frame - its eight corners' box, so it holds the whole piece);
    `frame` carries that frame into the piece's own (null when square).
    `localBox` and `origin` are the piece's own box and its low end. */
function getCutPlaneLocal(model) {
  const f = cutFrame(model);
  if (!f) return null;
  const mm = cutMmAt(state.cutT == null ? 0.5 : state.cutT, f.span);
  // The plane is n.x = origin + mm; in the cut frame, whose `axis` runs along
  // n, that is the coordinate `origin + mm` (square: the piece's own).
  const out = { axis: f.axis, plateAxis: f.plateAxis, plane: f.origin + mm, mm: mm, bbox: f.bbox, span: f.span,
                t: mm / f.span, origin: f.origin, lo: f.lo, hi: f.hi, localBox: f.bbox,
                deg: f.deg, bevel: f.bevel, turn: f.turn, frame: f.back, base: f.base || 0,
                /* the travel line in the world, for parting the halves along it */
                normalWorld: f.mesh ? f.normal.clone().transformDirection(f.mesh.matrixWorld) : null };
  if (f.turn) {
    const b = f.bbox, c = new THREE.Vector3(), box = new THREE.Box3();
    for (let i = 0; i < 8; i++) {
      box.expandByPoint(c.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z)
        .applyMatrix4(f.turn));
    }
    out.bbox = box;
  }
  return out;
}

/** For Cut: the plane the blade is drawn at - the same frame, the same number. */
function getCutPlaneForSplit(model) {
  const m = model || getActiveModel();
  if (!m) return null;
  updateCutHelper();
  return getCutPlaneLocal(m);
}

function setCutMm(mm) {
  const m = getActiveModel();
  const f = cutFrame(m);
  if (!f) return;
  state.cutT = snapCutT(Number(mm) / f.span, f.span);
  syncCutUI();
  updateCutHelper();
}

/** The point (in the piece's frame) the plane turns about when the mitre
    changes: where it crosses the piece's centre line, when it does inside
    the piece; else the foot of the perpendicular from the piece's centre (a
    plane at 90, or near it, runs along the centre line, so it has no
    crossing to keep). Position `t` is read in the frame `f`. */
function cutPivotLocal(f, t) {
  const d = f.origin + cutMmAt(t, f.span);               // the plane: n.x = d
  const n = f.normal, C = f.bbox.getCenter(new THREE.Vector3());
  const nd = n.dot(C), na = n[f.axis];
  if (Math.abs(na) > 1e-6) {
    const x = C[f.axis] + (d - nd) / na;
    if (x >= f.bbox.min[f.axis] && x <= f.bbox.max[f.axis]) {
      const P = C.clone();
      P[f.axis] = x;
      return P;
    }
  }
  return C.addScaledVector(n, d - nd);
}

/** Set the mitre (degrees clockwise seen from above; 0 = square), to the
    nearest 0.1. The plane turns about the pivot it had (cutPivotLocal): it
    keeps crossing the centre line where it did, and near 90, where it has no
    crossing, it turns about its foot from the piece's centre. The position
    is held unsnapped through the turn, so a run of 0.1 steps does not walk
    the plane off its pivot; the readout snaps it, as ever. */
function setCutMiter(deg) {
  cutTurnAboutPivot(function () {
    state.cutMiterDeg = Number(deg) || 0;
    state.cutMiterDeg = cutMiterDeg();
  });
}

/** Set the bevel (degrees off plumb, -90..90; positive tips the top of the
    blade toward the piece's far end), to the nearest 0.1. The blade leans
    about the same pivot the mitre turns it about. */
function setCutBevel(deg) {
  cutTurnAboutPivot(function () {
    state.cutBevelDeg = Number(deg) || 0;
    state.cutBevelDeg = cutBevelDeg();
  });
}

// Runs `change` (a new mitre or bevel) with the plane held on its pivot.
function cutTurnAboutPivot(change) {
  const m = getActiveModel();
  const was = cutMiterDeg() + '|' + cutBevelDeg();
  const f0 = m ? cutFrame(m) : null;
  const pivot = f0 ? cutPivotLocal(f0, state.cutT == null ? 0.5 : state.cutT) : null;
  change();
  const f1 = pivot && cutMiterDeg() + '|' + cutBevelDeg() !== was ? cutFrame(m) : null;
  if (f1) state.cutT = Math.min(1, Math.max(0, (f1.normal.dot(pivot) - f1.origin) / f1.span));
  syncCutUI();
  updateCutHelper();
}

/** The bevel that stands the blade plumb - vertical on the plate - at the
    present mitre, whatever pose or frame the piece came with; on the 0.1
    grid. Null with no piece. */
function cutPlumbBevelDeg(model) {
  const m = model || getActiveModel();
  const keep = state.cutBevelDeg;
  state.cutBevelDeg = 0;
  const f = m ? cutFrame(m) : null;
  state.cutBevelDeg = keep;
  if (!f) return null;
  const lean = cutLeanBasis(f.normal, f.up, f.axis, f.back);
  return (Math.round((Math.atan2(lean.s, lean.c) * 180) / Math.PI * 10) / 10) || 0;
}

/** PLUMB: the bevel that stands the blade vertical, applied, and said in the
    readout until the blade is turned or leaned again. */
function cutPlumb() {
  const m = getActiveModel();
  const deg = cutPlumbBevelDeg(m);
  if (deg == null) return null;
  setCutBevel(deg);
  state.cutPlumb = { id: m.id, miter: cutMiterDeg(), bevel: cutBevelDeg() };
  syncCutUI();
  if (typeof setStatus === 'function') setStatus('Plumb: bevel ' + cutBevelDeg() + '° stands the blade vertical.');
  return cutBevelDeg();
}

// Is the blade where PLUMB last put it, on the same piece?
function cutIsPlumbed(m) {
  const p = state.cutPlumb;
  return !!(p && m && p.id === m.id && p.miter === cutMiterDeg() && p.bevel === cutBevelDeg());
}

function syncCutMiterUI() {
  const deg = cutMiterDeg();
  const turn = document.getElementById('cut-dial-turn');
  if (turn) turn.setAttribute('transform', 'rotate(' + deg + ' 50 50)');
  const text = document.getElementById('cut-dial-deg');
  if (text) text.textContent = deg + '°';
  const dial = document.getElementById('cut-miter-dial');
  if (dial) dial.setAttribute('aria-valuenow', String(deg));
  const input = document.getElementById('cut-miter-deg');
  if (input && document.activeElement !== input) input.value = String(deg);
  syncCutBevelUI();
}

/* The bevel dial: the blade, seen end-on along its horizontal line with the
   piece's far end to the right, turned by the bevel; the darts sit on the
   painted tick nearest the blade's top, or ride the drag. */
function syncCutBevelUI() {
  const deg = cutBevelDeg();
  const turn = document.getElementById('cut-bevel-turn');
  if (turn) turn.setAttribute('transform', 'rotate(' + deg + ' 50 50)');
  const darts = document.getElementById('cut-bevel-darts');
  if (darts) {
    const at = cutBevelDial.dragging ? deg : cutBevelTickNear(deg);
    darts.setAttribute('transform', 'rotate(' + at + ' 50 50)');
    darts.dataset.at = String(at);
  }
  const text = document.getElementById('cut-bevel-dial-deg');
  if (text) text.textContent = deg + '°';
  const dial = document.getElementById('cut-bevel-dial');
  if (dial) dial.setAttribute('aria-valuenow', String(deg));
  const input = document.getElementById('cut-bevel-deg');
  if (input && document.activeElement !== input) input.value = String(deg);
}

function syncCutUI() {
  syncCutMiterUI();
  const m = getActiveModel();
  const slider = document.getElementById('cut-slider');
  const input = document.getElementById('cut-mm');
  const readout = document.getElementById('cut-readout');
  const info = m ? getCutPlaneLocal(m) : null;
  if (!info) {
    if (readout) readout.textContent = '-';
    return;
  }
  const span = info.span;
  const axis = info.plateAxis;
  const mm = info.mm;
  // The slider runs in mm over exactly the allowed range, so its thumb, the
  // number box and the blade are the same number at every position.
  if (slider) {
    slider.min = String(info.lo);
    slider.max = String(info.hi);
    slider.step = '0.1';
    slider.value = mm.toFixed(1);
  }
  if (input) {
    input.min = String(info.lo);
    input.max = String(info.hi);
    if (document.activeElement !== input) input.value = mm.toFixed(1);
  }
  // A clean split: the two sides are the plane's distance from each end and
  // add back to the piece. No kerf comes off.
  if (readout) {
    readout.textContent =
      'RED LINE @ ' + mm.toFixed(1) + ' mm (no kerf) -> ' +
      mm.toFixed(1) + ' mm | ' + (span - mm).toFixed(1) + ' mm  (' + axis.toUpperCase() + ')' +
      (info.deg ? ', mitre ' + info.deg + '°' : '') +
      (info.bevel || cutIsPlumbed(m) ? ', bevel ' + info.bevel + '°' + (cutIsPlumbed(m) ? ' (plumb)' : '') : '');
  }
}

function removeCutHelper() {
  if (state.cutHelper && state.cutHelper.parent) {
    state.cutHelper.parent.remove(state.cutHelper);
  }
  if (state.cutHelper) {
    state.cutHelper.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach(mat => mat.dispose());
        else obj.material.dispose();
      }
    });
  }
  state.cutHelper = null;
}

/* No Open / Close: the card IS the switch. Opening the Cut card arms the
   cutter (state.cutterOpen, state.cutTool 'cut'); closing it - by its own
   slab, by opening any other panel (one panel on the page, app-join.js), by
   the leave-tool gesture - disarms it. The Crop card arms the same piece
   selection for Crop (state.cutTool 'crop'), with no blade. The wiring is
   cutWireCards below.

   The other way round, the card closes when the tool goes away without it:
   Undo of a cut, Clear plate and Clear all drop state.cutterOpen and never
   touch the card. Every route ends in updateCutterUI(), which is why the
   closing hangs here - on the transition only, since updateCutterUI() also
   runs on every selection change while the card is open. */
let cutterWasTool = null;

function updateCutterUI() {
  if (cutterWasTool && !state.cutterOpen) {
    const menu = document.getElementById(cutterWasTool === 'crop' ? 'menu-crop' : 'menu-cut');
    if (menu) menu.open = false;
  }
  cutterWasTool = state.cutterOpen ? (state.cutTool || 'cut') : null;
  const cutting = cutterArmed('cut');
  const status = document.getElementById('cutter-status');
  const cutBtn = document.getElementById('btn-cut');
  if (status) {
    status.textContent = cutting
      ? (getActiveModel() && state.cutHelper
        ? 'Click the piece to move the blade; slide, nudge or angle it, then Cut.'
        : 'Click a piece to drop a square blade on it.')
      : 'Cutter off.';
  }
  if (cutBtn) cutBtn.disabled = !cutting || !getActiveModel() || !state.cutHelper;
  const tools = document.getElementById('cutter-tools');
  if (tools) tools.classList.toggle('is-open', cutting);
  syncCutRightSideOutButton();
}

/** Is the cutter live for `tool` ('cut' or 'crop')? */
function cutterArmed(tool) {
  return !!state.cutterOpen && (state.cutTool || 'cut') === tool;
}

/** Mesh on the plate for the active model - used to hang the red plane in place */
function getCutterTargetMesh() {
  const m = getActiveModel();
  if (!m || !state.placed || !state.placed.length) return null;
  const hit = state.placed.find(p => p && p.sourceId === m.id && p.mesh);
  return hit ? hit.mesh : null;
}

/* Arms the cutter for `tool` ('cut' by default, or 'crop'). A piece already
   selected on the plate stays selected and the tool goes live on it at once
   (the blade square, mid-piece); otherwise the next click on a piece does. */
function openCutter(tool) {
  const kind = tool === 'crop' ? 'crop' : 'cut';
  const keep = state.selectedIndex;
  state.cutterOpen = true;
  state.cutTool = kind;
  state.cutRightSideOutOffer = null;
  state.cutDragging = false;
  state.editYawDragging = false;
  state.cutT = 0.5;
  state.cutMiterDeg = 0;
  state.cutBevelDeg = 0;
  state.cutPlumb = null;
  state.editId = null;
  state.selectedIndex = -1;
  if (state.controls) state.controls.enabled = true;
  removeCutHelper();
  state.previewMesh = null;
  if (typeof clearSelectionOutline === 'function') clearSelectionOutline();
  if (typeof paintJoinHighlights === 'function') paintJoinHighlights();
  updateCutterUI();
  updateEditSize();
  const p = keep >= 0 && state.placed ? state.placed[keep] : null;
  if (p && p.mesh && p.sourceId != null && typeof selectPlaced === 'function') {
    selectPlaced(keep);
    return;
  }
  setStatus(kind === 'crop'
    ? 'Crop on - click a piece to put the crop box on it.'
    : 'Cut on - click a piece to drop a square blade on it.');
}

function closeCutter(silent) {
  const was = state.cutterOpen ? (state.cutTool || 'cut') : null;
  state.cutterOpen = false;
  state.cutTool = null;
  state.cutRightSideOutOffer = null;
  state.cutDragging = false;
  state.moveDragging = false;
  state.editYawDragging = false;
  state.editId = null;
  state.selectedIndex = -1;
  if (typeof clearSelectionOutline === 'function') clearSelectionOutline();
  if (typeof paintJoinHighlights === 'function') paintJoinHighlights();
  if (state.controls) state.controls.enabled = true;
  removeCutHelper();
  // Pieces are not cleared or rebuilt: the cutter is the blade only.
  state.previewMesh = null;
  updateCutterUI();
  if (!silent) setStatus((was === 'crop' ? 'Crop' : 'Cut') + ' off - blade gone. Pieces unchanged.');
}

/* The two cards, wired to the tool. A MutationObserver on `open` rather
   than a 'toggle' listener, for the reason app-join.js's one-panel rule
   gives: it sees a programmatic `.open = true` as well as a click, and runs
   before the next event. Opening Crop while Cut is live hands the selection
   machinery over to Crop first; Cut's card then shuts (one panel), and its
   close is a no-op because the live tool is no longer Cut's. Shutting a
   card leaves the selection as it was. */
function cutWireCards() {
  if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return;
  const cards = { 'menu-cut': 'cut', 'menu-crop': 'crop' };
  new MutationObserver(function (records) {
    records.forEach(function (r) {
      const tool = cards[r.target.id];
      if (!tool) return;
      if (r.target.open && !cutterArmed(tool)) {
        openCutter(tool);
      } else if (!r.target.open && cutterArmed(tool)) {
        // The tool goes; the piece stays picked, as the leave-tool gesture
        // keeps it (app-input-mode.js). Shutting the card is not "done with
        // this piece": opening Join or Scale next works on the piece just
        // cut, and Join's A, set before its card opened, survives.
        const keepIndex = state.selectedIndex, keepId = state.editId;
        closeCutter(false);
        if (keepIndex >= 0 && state.placed && state.placed[keepIndex] && typeof selectPlaced === 'function') {
          selectPlaced(keepIndex);
        }
        if (keepId != null && state.editId !== keepId && state.models.some(m => m && m.id === keepId)) {
          state.editId = keepId;
          updateEditSize();
          if (typeof renderModelList === 'function') renderModelList();
          updateCutterUI();
        }
      }
    });
  }).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['open'] });
  Object.keys(cards).forEach(function (id) {
    const d = document.getElementById(id);
    if (d && d.open && !cutterArmed(cards[id])) openCutter(cards[id]);
  });
}

/* The mitre wheel: a 360 degree dial, a rail round it and a handle on the
   rail. Drag the handle (or press anywhere on the rail) round to set the cut
   plane's heading to any whole degree, clockwise seen from above; 0, the
   handle at the top, is square. The typed box, Square and the − / + buttons
   under the wheel (1 degree a press, Shift 0.1, Alt 5) are the other ways in;
   the box and the buttons reach the tenths. It is optional: the square cut
   needs none of it. */
function cutWireMiterDial() {
  const dial = document.getElementById('cut-miter-dial');
  if (!dial || dial.dataset.nsoWired === '1') return;
  dial.dataset.nsoWired = '1';
  let dragging = false;
  function degAt(ev) {
    const r = dial.getBoundingClientRect();
    const dx = ev.clientX - (r.left + r.width / 2), dy = ev.clientY - (r.top + r.height / 2);
    if (Math.hypot(dx, dy) < r.width * 0.18) return null;     // the centre is the readout, not the rail
    return Math.round((Math.atan2(dx, -dy) * 180) / Math.PI);
  }
  dial.addEventListener('pointerdown', function (ev) {
    if (ev.button !== 0) return;
    const d = degAt(ev);
    if (d == null) return;
    dragging = true;
    if (dial.setPointerCapture) { try { dial.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic */ } }
    setCutMiter(d);
    ev.preventDefault();
    ev.stopPropagation();
  });
  dial.addEventListener('pointermove', function (ev) {
    if (!dragging) return;
    const d = degAt(ev);
    if (d != null) setCutMiter(d);
  });
  const stop = function () { dragging = false; };
  dial.addEventListener('pointerup', stop);
  dial.addEventListener('pointercancel', stop);
  dial.addEventListener('keydown', function (ev) {
    const step = ev.shiftKey ? 15 : 1;
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') setCutMiter(cutMiterDeg() + step);
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') setCutMiter(cutMiterDeg() - step);
    else if (ev.key === 'Home' || ev.key === '0') setCutMiter(0);
    else return;
    ev.preventDefault();
    ev.stopPropagation();
  });
  const typed = document.getElementById('cut-miter-deg');
  if (typed) typed.addEventListener('change', function () {
    const v = parseFloat(typed.value);
    setCutMiter(isFinite(v) ? v : 0);
  });
  const square = document.getElementById('btn-cut-square');
  if (square) square.addEventListener('click', function () { setCutMiter(0); });
  cutWireMiterStep('btn-cut-miter-minus', -1);
  cutWireMiterStep('btn-cut-miter-plus', 1);
  cutWireBevelDial();
  syncCutMiterUI();
}

/* The bevel dial, the rotate rings' widget (#229) on the card: a rail with a
   painted tick every 45 degrees (-90..90), the blade's line through the
   centre, and a pair of darts on the rail. At rest the darts sit on the tick
   nearest the blade's top. A press on the rail is a click until the pointer
   has travelled CUT_BEVEL_CLICK_SLOP_PX: released before that, a click on a
   dart leans the blade 1 degree (0.1 with Shift) the way the dart points
   and the darts stay on their tick. Past it, it is a dial: the bevel follows
   the pointer's turn about the centre from where it was, the darts ride it,
   and inside CUT_BEVEL_SNAP_WITHIN_DEG of a painted tick it sits on the
   tick. The arrow keys step it as a dart does; the box, the − / + buttons
   (1 degree, Shift 0.1, Alt 5) and Plumb are the other ways in. */
const cutBevelDial = { dragging: false };

function cutBevelTickNear(deg) {
  return (Math.round(deg / CUT_BEVEL_DETENT_DEG) * CUT_BEVEL_DETENT_DEG) || 0;
}

/** A dragged bevel: on the tick inside the snap, else as the pointer says;
    clamped to the range. */
function cutBevelDetent(deg) {
  const d = Math.min(CUT_BEVEL_MAX_DEG, Math.max(-CUT_BEVEL_MAX_DEG, deg));
  const tick = cutBevelTickNear(d);
  return Math.abs(d - tick) <= CUT_BEVEL_SNAP_WITHIN_DEG ? tick : d;
}

function cutWireBevelDial() {
  const dial = document.getElementById('cut-bevel-dial');
  if (!dial || dial.dataset.nsoWired === '1') return;
  dial.dataset.nsoWired = '1';
  let press = null;
  function angleAt(ev) {
    const r = dial.getBoundingClientRect();
    const dx = ev.clientX - (r.left + r.width / 2), dy = ev.clientY - (r.top + r.height / 2);
    return { a: (Math.atan2(dx, -dy) * 180) / Math.PI, centre: Math.hypot(dx, dy) < r.width * 0.18 };
  }
  dial.addEventListener('pointerdown', function (ev) {
    if (ev.button !== 0) return;
    const at = angleAt(ev);
    if (at.centre) return;                                    // the centre is the readout, not the rail
    const dart = ev.target && ev.target.closest ? ev.target.closest('[data-dir]') : null;
    press = { x: ev.clientX, y: ev.clientY, lastA: at.a, raw: cutBevelDeg(), moved: false,
              dir: dart ? Number(dart.getAttribute('data-dir')) : 0, fine: !!ev.shiftKey };
    if (dial.setPointerCapture) { try { dial.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic */ } }
    if (dial.focus) dial.focus();
    ev.preventDefault();
    ev.stopPropagation();
  });
  dial.addEventListener('pointermove', function (ev) {
    if (!press) return;
    if (!press.moved && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) < CUT_BEVEL_CLICK_SLOP_PX) return;
    press.moved = true;
    cutBevelDial.dragging = true;
    const at = angleAt(ev);
    let d = at.a - press.lastA;
    if (d > 180) d -= 360;
    else if (d < -180) d += 360;
    press.lastA = at.a;
    press.raw = Math.min(CUT_BEVEL_MAX_DEG, Math.max(-CUT_BEVEL_MAX_DEG, press.raw + d));
    setCutBevel(cutBevelDetent(press.raw));
  });
  const stop = function () {
    const p = press;
    press = null;
    cutBevelDial.dragging = false;
    if (p && !p.moved && p.dir) setCutBevel(cutBevelDeg() + p.dir * (p.fine ? CUT_BEVEL_STEP_SHIFT_DEG : CUT_BEVEL_STEP_DEG));
    else syncCutBevelUI();                                     // the darts seat on a tick again
  };
  dial.addEventListener('pointerup', stop);
  dial.addEventListener('pointercancel', stop);
  dial.addEventListener('keydown', function (ev) {
    const step = ev.shiftKey ? CUT_BEVEL_STEP_SHIFT_DEG : CUT_BEVEL_STEP_DEG;
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') setCutBevel(cutBevelDeg() + step);
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') setCutBevel(cutBevelDeg() - step);
    else if (ev.key === 'Home' || ev.key === '0') setCutBevel(0);
    else return;
    ev.preventDefault();
    ev.stopPropagation();
  });
  const typed = document.getElementById('cut-bevel-deg');
  if (typed) typed.addEventListener('change', function () {
    const v = parseFloat(typed.value);
    setCutBevel(isFinite(v) ? v : 0);
  });
  const plumb = document.getElementById('btn-cut-plumb');
  if (plumb) plumb.addEventListener('click', function () { cutPlumb(); });
  cutWireMiterStep('btn-cut-bevel-minus', -1, 'bevel');
  cutWireMiterStep('btn-cut-bevel-plus', 1, 'bevel');
  syncCutBevelUI();
}

/* One − / + button under the wheel. A press steps the mitre through
   setCutMiter - the call the handle's drag makes - so the wheel, the number
   and the blade all follow. The size is read from the press: 1 degree, Shift
   0.1, Alt 5. Held, it repeats at that size after CUT_MITER_HOLD_MS, every
   CUT_MITER_REPEAT_MS. A pointer press steps on pointerdown and the click that
   follows is ignored (detail > 0); a keyboard press (Enter / Space) and a
   scripted .click() arrive as a click with detail 0 and step once. With
   `which` 'bevel' it steps the bevel the same way. */
function cutWireMiterStep(id, sign, which) {
  const bevel = which === 'bevel';
  const btn = document.getElementById(id);
  if (!btn) return;
  let wait = null, rep = null;
  const stop = function () {
    clearTimeout(wait);
    clearInterval(rep);
    wait = rep = null;
  };
  const sizeOf = function (ev) {
    return ev.altKey ? CUT_MITER_STEP_ALT_DEG : ev.shiftKey ? CUT_MITER_STEP_SHIFT_DEG : CUT_MITER_STEP_DEG;
  };
  const step = function (size) {
    if (bevel) setCutBevel(cutBevelDeg() + sign * size);
    else setCutMiter(cutMiterDeg() + sign * size);
  };
  btn.addEventListener('pointerdown', function (ev) {
    if (ev.button !== 0) return;
    stop();
    // A number still being typed commits first. Its change event would
    // otherwise fire when this press takes the focus - after the step - and
    // put the typed angle back over it.
    const typed = document.getElementById(bevel ? 'cut-bevel-deg' : 'cut-miter-deg');
    if (typed && document.activeElement === typed) typed.blur();
    const size = sizeOf(ev);
    step(size);
    const tick = function () {
      if (!btn.offsetParent) stop();         // the card shut under a held button
      else step(size);
    };
    wait = setTimeout(function () {
      tick();
      if (wait !== null) rep = setInterval(tick, CUT_MITER_REPEAT_MS);
    }, CUT_MITER_HOLD_MS);
  });
  ['pointerup', 'pointercancel', 'pointerleave', 'blur'].forEach(function (t) { btn.addEventListener(t, stop); });
  btn.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
  btn.addEventListener('click', function (ev) {
    if (ev.detail === 0) step(sizeOf(ev));
  });
}

function showEditPreview() {
  const m = getActiveModel();
  if (!m || !state.scene || !state.modelGroup) return;

  const cam = freezeCamera();
  removeCutHelper();
  clearDisplayMeshes();
  state.previewMesh = null;
  state.placed = [];
  const exportBtn = document.getElementById('btn-export-stl');
  if (exportBtn) exportBtn.disabled = true;

  const mat = new THREE.MeshStandardMaterial({
    color: 0x38bdf8,
    metalness: 0.05,
    roughness: 0.4,
    emissive: 0x0a3a5c,
    emissiveIntensity: 0.25
  });
  const mesh = new THREE.Mesh(m.geometry, mat);
  mesh.position.set(0, m.size.y / 2 + 0.3, 0);
  mesh.userData.editPreview = true;
  state.modelGroup.add(mesh);
  state.previewMesh = mesh;
  if (state.cutterOpen) buildCutHelper();
  restoreCamera(cam);
  syncCutUI();
}

// ===================== The blade and the plate line =====================
// The blade, drawn in the piece's own frame from the cut frame's box: it
// lies across the local cut axis, overhangs the piece's section by 1 mm all
// round (at least 4 mm across, as before), and stands on the plane Split will
// cut. Its transform follows the piece's mesh, so any pose carries it along.
//
// It is drawn THROUGH the piece, not inside it: a thin translucent sheet and
// a solid edge frame, neither depth-tested, so the piece's own faces cannot
// hide the part of the blade buried in it. (It used to be an opaque 0.7 mm
// black slab, depth-tested: only what stuck out of the piece showed, so on a
// tall or wide piece the blade looked as if it stopped short.)
//
// The plate line marks the same plane where it meets the plate (y = 0): flat
// on the plate, 1 mm wide (a mark, not a kerf), spanning the piece's footprint along the cut.
// It is the plane Split cuts and the box the blade is sized from, carried
// into world space - the same number, the same bounds - so it follows the
// slider and the mm box exactly and cannot disagree with the blade.
//
// Every part is skipped by the x-ray view (which rewrites depth settings on
// whatever it walks), and the plate line is never picked: dragging still
// starts only from the blade, as before.
const CUT_BLADE_COLOR = 0xffc83d;      // the frame and the plate line
const CUT_BLADE_FILL = 0x101010;       // the sheet: a dark tint reads on any piece colour
const CUT_BLADE_FILL_OPACITY = 0.38;
const CUT_BLADE_RENDER_ORDER = 20;     // after the pieces, so the sheet tints them
const CUT_PLATE_LINE_Y = 0.35;         // just above the plate border (0.3) and grid (0.15)
const CUT_OVERHANG_MM = 1;             // the blade's margin past the section, each side
const CUT_MIN_ACROSS_MM = 4;

function cutBladeAcross(bbox) {
  const size = bbox.getSize(new THREE.Vector3());
  return [size.x, size.y, size.z].map(d => Math.max(d, CUT_MIN_ACROSS_MM) + 2 * CUT_OVERHANG_MM);
}

function cutOverlay(obj, pickable) {
  obj.renderOrder = CUT_BLADE_RENDER_ORDER;
  obj.userData.skipXray = true;
  obj.userData.cutHandle = !!pickable;
  if (!pickable) obj.raycast = function () {};
  return obj;
}

function cutBuildBlade(group, f) {
  const AX = ['x', 'y', 'z'];
  const k = AX.indexOf(f.axis);
  const u = (k + 1) % 3, v = (k + 2) % 3;          // the two directions across the cut
  const across = cutBladeAcross(f.bbox);
  const e = i => new THREE.Vector3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0);
  // PlaneGeometry lies in x-y; turn it so its normal is the cut axis, its
  // sides along u and v.
  const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(e(u), e(v), e(k)));

  // Large invisible hit target for easy drag.
  const hit = new THREE.Mesh(new THREE.PlaneGeometry(across[u] + 24, across[v] + 24), new THREE.MeshBasicMaterial({
    visible: false, side: THREE.DoubleSide
  }));
  hit.quaternion.copy(q);
  hit.userData.cutHandle = true;
  hit.userData.skipXray = true;

  // The sheet: the blade's whole extent, seen through the piece.
  const blade = new THREE.Mesh(new THREE.PlaneGeometry(across[u], across[v]), new THREE.MeshBasicMaterial({
    color: CUT_BLADE_FILL, transparent: true, opacity: CUT_BLADE_FILL_OPACITY,
    side: THREE.DoubleSide, depthTest: false, depthWrite: false
  }));
  blade.quaternion.copy(q);
  blade.userData.cutBlade = true;
  cutOverlay(blade, true);

  // Edge frame round the sheet, and a crosshair at its centre, in the u-v plane.
  function pt(du, dv) { const p = [0, 0, 0]; p[u] = du; p[v] = dv; return p; }
  const hu = across[u] / 2, hv = across[v] / 2;
  function lines(pts, opacity) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts.flat()), 3));
    return cutOverlay(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      color: CUT_BLADE_COLOR, transparent: true, opacity: opacity, depthTest: false, depthWrite: false
    })), true);
  }
  const frame = lines([pt(-hu, -hv), pt(hu, -hv), pt(hu, -hv), pt(hu, hv),
                       pt(hu, hv), pt(-hu, hv), pt(-hu, hv), pt(-hu, -hv)], 1);
  frame.userData.cutFrame = true;
  const cross = lines([pt(-hu * 0.9, 0), pt(hu * 0.9, 0), pt(0, -hv * 0.9), pt(0, hv * 0.9)], 0.55);

  group.add(hit);
  group.add(blade);
  group.add(frame);
  group.add(cross);
  group.userData.cutAxis = f.axis;
  group.userData.cutAcross = across;
}

// The plate line's two objects: a flat strip 1 mm wide and its centre
// line (so it still reads as a line when the plate is seen edge-on). Their
// vertices are written in world space by cutPlaceLine on every update.
function cutBuildPlateLine(group) {
  const strip = new THREE.BufferGeometry();
  strip.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
  strip.setIndex([0, 1, 2, 0, 2, 3]);
  const stripMesh = cutOverlay(new THREE.Mesh(strip, new THREE.MeshBasicMaterial({
    color: CUT_BLADE_COLOR, side: THREE.DoubleSide, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95
  })), false);
  const centre = new THREE.BufferGeometry();
  centre.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const centreLine = cutOverlay(new THREE.LineSegments(centre, new THREE.LineBasicMaterial({
    color: CUT_BLADE_COLOR, depthTest: false, depthWrite: false, transparent: true
  })), false);
  stripMesh.frustumCulled = false;
  centreLine.frustumCulled = false;
  stripMesh.userData.cutPlateLine = true;
  centreLine.userData.cutPlateLine = true;
  const g = new THREE.Group();
  g.name = 'cutPlateLine';
  g.add(stripMesh);
  g.add(centreLine);
  group.add(g);
}

/** Where the cut plane meets the plate, from the cut plane `info`
    (getCutPlaneLocal) on the piece's `mesh`: its two ends and the direction
    across it, in world space. Null if the plane is (nearly) parallel to the
    plate, which the cut frame does not produce. */
function cutPlateLineWorld(info, mesh) {
  if (!info || !mesh) return null;
  mesh.updateMatrixWorld(true);
  const Mw = cutWorldMatrix(info, mesh);
  const local = info.bbox.getCenter(new THREE.Vector3());
  local[info.axis] = info.plane;
  const P = local.clone().applyMatrix4(Mw);
  const n = new THREE.Vector3(info.axis === 'x' ? 1 : 0, info.axis === 'y' ? 1 : 0, info.axis === 'z' ? 1 : 0)
    .applyMatrix3(new THREE.Matrix3().getNormalMatrix(Mw)).normalize();
  const nh = new THREE.Vector3(n.x, 0, n.z);
  const nh2 = nh.lengthSq();
  if (nh2 < 1e-6) return null;
  // The plane's trace on y = 0: a point on it, and its direction.
  const Q = new THREE.Vector3(P.x, 0, P.z).addScaledVector(nh, n.y * P.y / nh2);
  const dir = new THREE.Vector3(-n.z, 0, n.x).normalize();
  // Its extent: the cut frame's box, carried into world space, along the line.
  let lo = Infinity, hi = -Infinity;
  const b = info.bbox, c = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    c.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(Mw);
    const s = c.sub(Q).dot(dir);
    if (s < lo) lo = s;
    if (s > hi) hi = s;
  }
  lo -= CUT_OVERHANG_MM;
  hi += CUT_OVERHANG_MM;
  return { a: Q.clone().addScaledVector(dir, lo), b: Q.clone().addScaledVector(dir, hi),
           across: nh.normalize(), point: P, normal: n, mm: info.mm };
}

function cutPlaceLine(group, info, mesh) {
  const g = group.children.find(c => c.name === 'cutPlateLine');
  if (!g) return;
  const w = cutPlateLineWorld(info, mesh);
  g.visible = !!w;
  group.userData.plateLine = w ? { a: w.a.toArray(), b: w.b.toArray(), across: w.across.toArray(), mm: w.mm } : null;
  if (!w) return;
  const toGroup = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const y = CUT_PLATE_LINE_Y;
  const half = (typeof KERF_MM !== 'undefined' ? KERF_MM : 1) / 2;
  const at = (p, s) => new THREE.Vector3(p.x, y, p.z).addScaledVector(w.across, s).applyMatrix4(toGroup);
  const quad = [at(w.a, -half), at(w.b, -half), at(w.b, half), at(w.a, half)];
  const mid = [at(w.a, 0), at(w.b, 0)];
  g.children.forEach(o => {
    const pos = o.geometry.attributes.position;
    const pts = o.isMesh ? quad : mid;
    pts.forEach((p, i) => pos.setXYZ(i, p.x, p.y, p.z));
    pos.needsUpdate = true;
    o.geometry.computeBoundingSphere();
  });
}

function buildCutHelper() {
  const m = getActiveModel();
  if (!m || !state.previewMesh) return;
  if (state.cutHelper) {
    const keep = state.previewMesh;
    removeCutHelper();
    state.previewMesh = keep;
  }
  // Crop's card shares the selection, not the blade.
  if (state.cutTool === 'crop') return;
  const info = getCutPlaneLocal(m);
  if (!info) return;

  const group = new THREE.Group();
  group.name = 'cutHelper';
  cutBuildBlade(group, info);
  cutBuildPlateLine(group);
  // A helper (nso-helpers.js): tagged, never exported, gone on leave / Clear /
  // Undo. Interactive - the grab sheet is how the blade is dragged.
  const parent = state.modelGroup || state.previewMesh;
  if (parent) nsoHelpers.attach(parent, group, 'cut', { interactive: true });
  state.cutHelper = group;
  updateCutHelper();
}

/* Cut's session, for the helper registry: live while the cutter is armed for
   Cut; closed by closeCutter, the path its card's own shutting runs. */
if (typeof nsoHelpers !== 'undefined') nsoHelpers.owner('cut', {
  live: function () { return !!state.cutterOpen && state.cutTool !== 'crop'; },
  close: function () { closeCutter(false); },
  clear: removeCutHelper,
  refresh: function () { if (state.cutterOpen && state.previewMesh) buildCutHelper(); }
});

// The cut frame carried into world space: the piece's mesh transform, after
// the mitre's `frame` (cut frame -> piece frame) when there is one.
function cutWorldMatrix(info, mesh) {
  const M = new THREE.Matrix4().copy(mesh.matrixWorld);
  if (info && info.frame) M.multiply(info.frame);
  return M;
}

// Puts the blade on the plane: the section's centre with the cut coordinate
// replaced by the plane (in the cut frame), carried through the mitre and the
// piece's world transform into the helper's parent; then lays the plate line
// under it. Rebuilds it first if the piece's cut axis or the section's size
// changed under it (a turn, a roll, a bake, a new mitre).
function updateCutHelper() {
  const m = getActiveModel();
  if (!m || !state.cutHelper) return;
  const info = getCutPlaneLocal(m);
  if (!info) return;
  const mesh = cutMeshOf(m);
  if (!mesh) return;
  const want = cutBladeAcross(info.bbox);
  const have = state.cutHelper.userData.cutAcross;
  if (state.cutHelper.userData.cutAxis !== info.axis || !have ||
      want.some((d, i) => Math.abs(d - have[i]) > 1e-6)) {
    state.previewMesh = mesh;
    buildCutHelper();
    return;
  }
  const local = info.bbox.getCenter(new THREE.Vector3());
  local[info.axis] = info.plane;
  mesh.updateMatrixWorld(true);
  const parent = state.cutHelper.parent;
  if (parent) parent.updateMatrixWorld(true);
  const M = new THREE.Matrix4().makeTranslation(local.x, local.y, local.z);
  if (parent === mesh) {
    if (info.frame) M.premultiply(info.frame);
  } else {
    M.premultiply(cutWorldMatrix(info, mesh));
    if (parent) M.premultiply(new THREE.Matrix4().copy(parent.matrixWorld).invert());
  }
  M.decompose(state.cutHelper.position, state.cutHelper.quaternion, state.cutHelper.scale);
  state.cutHelper.updateMatrixWorld(true);
  state.cutHelper.userData.cutDeg = info.deg || 0;
  state.cutHelper.userData.cutBevel = info.bevel || 0;
  cutPlaceLine(state.cutHelper, info, mesh);
}

function axisCoord(ax, x, y, z) {
  return ax === 'x' ? x : ax === 'y' ? y : z;
}

function capFromEdges(edges, axis, plane, keepMin) {
  // Claude-style: boundary graph -> closed loop(s) -> ear-clip cap -> outward normals
  if (!edges || !edges.length) return [];

  const TOL = 1e-4;
  function keyOf(p) {
    // Plane is axis=const; key on the other two coords
    let a, b;
    if (axis === 'x') { a = p[1]; b = p[2]; }
    else if (axis === 'y') { a = p[0]; b = p[2]; }
    else { a = p[0]; b = p[1]; }
    return (Math.round(a / TOL) * TOL) + '|' + (Math.round(b / TOL) * TOL);
  }
  function snap(p) {
    const q = [p[0], p[1], p[2]];
    if (axis === 'x') q[0] = plane;
    else if (axis === 'y') q[1] = plane;
    else q[2] = plane;
    return q;
  }
  function to2(p) {
    if (axis === 'x') return [p[1], p[2]];
    if (axis === 'y') return [p[0], p[2]];
    return [p[0], p[1]];
  }
  function from2(u, v) {
    if (axis === 'x') return [plane, u, v];
    if (axis === 'y') return [u, plane, v];
    return [u, v, plane];
  }
  function dist2(a, b) {
    const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
    return dx * dx + dy * dy + dz * dz;
  }

  // Weld points + filter zero-length segments
  const nodePos = new Map(); // key -> [x,y,z]
  const adj = new Map(); // key -> Set of neighbor keys

  function addNode(p) {
    const s = snap(p);
    const k = keyOf(s);
    if (!nodePos.has(k)) nodePos.set(k, s);
    if (!adj.has(k)) adj.set(k, new Set());
    return k;
  }

  edges.forEach(pair => {
    if (!pair || pair.length < 2) return;
    const k0 = addNode(pair[0]);
    const k1 = addNode(pair[1]);
    if (k0 === k1) return; // degenerate
    if (dist2(nodePos.get(k0), nodePos.get(k1)) < TOL * TOL) return;
    adj.get(k0).add(k1);
    adj.get(k1).add(k0);
  });

  // Walk only clean, non-branching simple cycles (every node degree
  // exactly 2). A node with degree != 2 is a junction where two or more
  // separate boundary loops meet or cross (e.g. a missing-wall opening
  // touching an adjacent slot or rib). Walking blindly through such a
  // point used to stitch unrelated loops into one convoluted polygon --
  // ear-clipping that produced long diagonal slivers fanning across the
  // hole instead of a flat panel. Skipping anything that touches a
  // junction leaves those specific edges open (fail-safe) instead of
  // guessing which branch belongs to which loop.
  const visitedEdge = new Set();
  function ek(a, b) { return a < b ? a + '~' + b : b + '~' + a; }

  const loops = [];
  for (const start of adj.keys()) {
    if (adj.get(start).size !== 2) continue;
    for (const nb of adj.get(start)) {
      const e0 = ek(start, nb);
      if (visitedEdge.has(e0)) continue;
      // Walk loop
      const loopKeys = [start];
      let prev = start;
      let cur = nb;
      visitedEdge.add(e0);
      let guard = 0;
      let clean = true;
      while (cur !== start && guard++ < 100000) {
        if (!adj.has(cur) || adj.get(cur).size !== 2) { clean = false; break; }
        loopKeys.push(cur);
        const nbs = adj.get(cur);
        let next = null;
        for (const cand of nbs) {
          if (cand === prev) continue;
          const e = ek(cur, cand);
          if (visitedEdge.has(e)) continue;
          next = cand;
          visitedEdge.add(e);
          break;
        }
        if (next == null) {
          // try any unused including back (open chain - abort)
          clean = false;
          break;
        }
        prev = cur;
        cur = next;
      }
      if (clean && cur === start && loopKeys.length >= 3) {
        loops.push(loopKeys.map(k => nodePos.get(k)));
      }
    }
  }

  // NOTE: the old convex-hull-of-all-points fallback (used when no clean
  // loop was found) is gone. A "best guess" hull across every leftover
  // point is precisely the kind of guess that spans across a trough --
  // if no clean loop was found, this cap attempt yields nothing and the
  // edges stay open (fail-safe) rather than being closed with a wrong shape.

  function hull2D(pts3) {
    const pts = pts3.map((p, i) => {
      const t = to2(p);
      return { u: t[0], v: t[1], p, i };
    });
    pts.sort((a, b) => a.u === b.u ? a.v - b.v : a.u - b.u);
    function cross(o, a, b) {
      return (a.u - o.u) * (b.v - o.v) - (a.v - o.v) * (b.u - o.u);
    }
    const lower = [];
    for (let i = 0; i < pts.length; i++) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pts[i]) <= 0) lower.pop();
      lower.push(pts[i]);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0) upper.pop();
      upper.push(pts[i]);
    }
    upper.pop(); lower.pop();
    return lower.concat(upper).map(h => h.p);
  }

  // Ear clipping in 2D
  function earClip(loop3) {
    if (loop3.length < 3) return [];
    const poly = loop3.map(p => {
      const t = to2(p);
      return { u: t[0], v: t[1], p: p };
    });
    // Remove near-duplicate consecutive verts
    const clean = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if (Math.abs(a.u - b.u) + Math.abs(a.v - b.v) > TOL) clean.push(a);
    }
    if (clean.length < 3) return [];

    function area2(pts) {
      let a = 0;
      for (let i = 0; i < pts.length; i++) {
        const j = (i + 1) % pts.length;
        a += pts[i].u * pts[j].v - pts[j].u * pts[i].v;
      }
      return a;
    }
    let verts = clean.slice();
    // Ensure CCW for standard ear clip
    if (area2(verts) < 0) verts.reverse();

    function isInside(a, b, c, p) {
      // barycentric
      const v0x = c.u - a.u, v0y = c.v - a.v;
      const v1x = b.u - a.u, v1y = b.v - a.v;
      const v2x = p.u - a.u, v2y = p.v - a.v;
      const dot00 = v0x * v0x + v0y * v0y;
      const dot01 = v0x * v1x + v0y * v1y;
      const dot02 = v0x * v2x + v0y * v2y;
      const dot11 = v1x * v1x + v1y * v1y;
      const dot12 = v1x * v2x + v1y * v2y;
      const inv = 1 / (dot00 * dot11 - dot01 * dot01 + 1e-30);
      const u = (dot11 * dot02 - dot01 * dot12) * inv;
      const v = (dot00 * dot12 - dot01 * dot02) * inv;
      return u >= -1e-9 && v >= -1e-9 && (u + v) <= 1 + 1e-9;
    }
    function isConvex(prev, curr, next) {
      return (curr.u - prev.u) * (next.v - prev.v) - (curr.v - prev.v) * (next.u - prev.u) > 1e-12;
    }

    const tris = [];
    let guard = 0;
    let stuck = false;
    while (verts.length > 3 && guard++ < 10000) {
      let clipped = false;
      const n = verts.length;
      for (let i = 0; i < n; i++) {
        const prev = verts[(i + n - 1) % n];
        const curr = verts[i];
        const next = verts[(i + 1) % n];
        if (!isConvex(prev, curr, next)) continue;
        let empty = true;
        for (let k = 0; k < n; k++) {
          if (k === i || k === (i + n - 1) % n || k === (i + 1) % n) continue;
          if (isInside(prev, curr, next, verts[k])) { empty = false; break; }
        }
        if (!empty) continue;
        tris.push([prev.p, curr.p, next.p]);
        verts.splice(i, 1);
        clipped = true;
        break;
      }
      if (!clipped) {
        // Ear-clipping got stuck on a remaining non-convex/complex
        // polygon. The old behavior fanned every remaining vertex from
        // verts[0], which is exactly what produced long diagonal slivers
        // fanning across a hole instead of a flat panel. Bail out
        // uncapped instead -- fail-safe leaves this loop's edges open.
        stuck = true;
        break;
      }
    }
    if (stuck) return [];
    if (verts.length === 3) {
      tris.push([verts[0].p, verts[1].p, verts[2].p]);
    }
    return tris;
  }

  // Outward normal along cut axis:
  // keepMin (material on min side): outward is +axis
  // keepMax (material on max side): outward is -axis
  const outward = keepMin ? 1 : -1;
  const finish = (document.getElementById('cut-finish') || {}).value || 'match';
  const out = [];
  function pushOriented(a, b, c) {
    const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
    const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    let along = axis === 'x' ? nx : axis === 'y' ? ny : nz;
    if (along * outward < 0) {
      out.push(a[0], a[1], a[2], c[0], c[1], c[2], b[0], b[1], b[2]);
    } else {
      out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    }
  }

  function loopArea2(loop2) {
    let a = 0;
    for (let i = 0; i < loop2.length; i++) {
      const j = (i + 1) % loop2.length;
      a += loop2[i][0] * loop2[j][1] - loop2[j][0] * loop2[i][1];
    }
    return a;
  }

  function resampleLoop2(loop2, spacing) {
    if (loop2.length < 3) return loop2;
    const segs = [];
    let total = 0;
    for (let i = 0; i < loop2.length; i++) {
      const a = loop2[i], b = loop2[(i + 1) % loop2.length];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      segs.push({ a, b, L });
      total += L;
    }
    if (total < spacing * 3) return loop2;
    const n = Math.max(12, Math.round(total / spacing));
    const outL = [];
    let dist = 0, si = 0, acc = 0;
    for (let k = 0; k < n; k++) {
      const target = (k / n) * total;
      while (si < segs.length - 1 && acc + segs[si].L < target) {
        acc += segs[si].L;
        si++;
      }
      const s = segs[si];
      const t = s.L < 1e-9 ? 0 : (target - acc) / s.L;
      outL.push([s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t]);
    }
    return outL;
  }

  function edgeInwardNormal(p1, p2, sign) {
    const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
    const len = Math.hypot(dx, dy) || 1e-12;
    return [sign * (-dy / len), sign * (dx / len)];
  }

  function vertexOffset(loop2, i, radius, sign) {
    const n = loop2.length;
    const prev = loop2[(i - 1 + n) % n], curr = loop2[i], next = loop2[(i + 1) % n];
    const n1 = edgeInwardNormal(prev, curr, sign);
    const n2 = edgeInwardNormal(curr, next, sign);
    let bx = n1[0] + n2[0], by = n1[1] + n2[1];
    const blen = Math.hypot(bx, by) || 1e-9;
    bx /= blen; by /= blen;
    const cosHalf = Math.max(bx * n1[0] + by * n1[1], 0.3);
    const mag = radius / cosHalf;
    return [curr[0] + bx * mag, curr[1] + by * mag];
  }

  function turningAngle(loop2, i) {
    const n = loop2.length;
    const prev = loop2[(i - 1 + n) % n], curr = loop2[i], next = loop2[(i + 1) % n];
    const a1 = Math.atan2(curr[1] - prev[1], curr[0] - prev[0]);
    const a2 = Math.atan2(next[1] - curr[1], next[0] - curr[0]);
    let d = a2 - a1;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  }

  function solveCornerCenter(cornerPt, n1, n2, R) {
    const det = n1[0] * n2[1] - n1[1] * n2[0];
    if (Math.abs(det) < 1e-10) return null;
    const nx = (n2[1] - n1[1]) / det;
    const ny = (n1[0] - n2[0]) / det;
    return [cornerPt[0] + R * nx, cornerPt[1] + R * ny];
  }

  function slerp2D(a, b, t) {
    const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1]));
    const theta = Math.acos(dot);
    if (theta < 1e-8) return a.slice();
    const s = Math.sin(theta);
    const wa = Math.sin((1 - t) * theta) / s, wb = Math.sin(t * theta) / s;
    return [wa * a[0] + wb * b[0], wa * a[1] + wb * b[1]];
  }

  function smoothstep(x) {
    x = Math.max(0, Math.min(1, x));
    return x * x * (3 - 2 * x);
  }

  function ringSelfIntersectsDetail(ring) {
    // Same as the original ringSelfIntersects, but returns the offending
    // index pairs instead of just a boolean - needed for local repair (BUG 3).
    function segX(p1, p2, p3, p4) {
      const d1x = p2[0] - p1[0], d1y = p2[1] - p1[1];
      const d2x = p4[0] - p3[0], d2y = p4[1] - p3[1];
      const denom = d1x * d2y - d1y * d2x;
      if (Math.abs(denom) < 1e-12) return false;
      const t = ((p3[0] - p1[0]) * d2y - (p3[1] - p1[1]) * d2x) / denom;
      const u = ((p3[0] - p1[0]) * d1y - (p3[1] - p1[1]) * d1x) / denom;
      return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6;
    }
    const m = ring.length;
    const bad = [];
    for (let i = 0; i < m; i++) {
      const a = ring[i], b = ring[(i + 1) % m];
      for (let j = i + 2; j < m; j++) {
        if (i === 0 && j === m - 1) continue;
        if ((j + 1) % m === i) continue;
        if (segX(a, b, ring[j], ring[(j + 1) % m])) bad.push([i, j]);
      }
    }
    return bad;
  }

  function ringSelfIntersects(ring) {
    return ringSelfIntersectsDetail(ring).length > 0;
  }

  function from2At(u, v, along) {
    if (axis === 'x') return [along, u, v];
    if (axis === 'y') return [u, along, v];
    return [u, v, along];
  }

  // DEAD: filletLoop is never called (see the LIVE GATE below). Left as-is
  // rather than retrofitted, but do not copy it - the canonical probe is
  // NSO_Thickness.cornerWall / .bandWall in nso_thickness.js, which is what
  // every live clamp in this file and app-finish.js now calls.
  function localThickness(loop2, i, sign) {
    const n = loop2.length;
    const curr = loop2[i];
    const prev = loop2[(i - 1 + n) % n], next = loop2[(i + 1) % n];
    const nn = edgeInwardNormal(prev, next, sign);
    let minD = 1e9;
    for (let j = 0; j < n; j++) {
      if (Math.abs(j - i) < 2 || Math.abs(j - i) > n - 2) continue;
      const a = loop2[j], b = loop2[(j + 1) % n];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const den = nn[0] * dy - nn[1] * dx;
      if (Math.abs(den) < 1e-10) continue;
      const t = ((a[0] - curr[0]) * dy - (a[1] - curr[1]) * dx) / den;
      const u = ((a[0] - curr[0]) * nn[1] - (a[1] - curr[1]) * nn[0]) / -den;
      if (t > 0.15 && t < minD && u >= -0.05 && u <= 1.05) minD = t;
    }
    return minD === 1e9 ? 4 : minD;
  }

  function targetRadius() {
    if (finish === 'square') return 0;
    if (finish === 'soft') return 0.8;
    return 2.0; // match piece - factory-scale default, locally clamped
  }

  // ---- min-filter (not mean-filter) smoothing for the radius array. ----
  function minFilterCircular(arr, window) {
    const n = arr.length;
    const out = new Array(n);
    const half = Math.floor(window / 2);
    for (let i = 0; i < n; i++) {
      let m = Infinity;
      for (let k = -half; k <= half; k++) m = Math.min(m, arr[(i + k + n) % n]);
      out[i] = m;
    }
    return out;
  }

  function smoothRadiusSafely(arr, window) {
    const n = arr.length;
    const half = Math.floor(window / 2);
    const mean = new Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = -half; k <= half; k++) s += arr[(i + k + n) % n];
      mean[i] = s / window;
    }
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.min(mean[i], arr[i] * 1.15);
    return out;
  }

  function repairSelfIntersections(loop2, Rs, computeRing) {
    const n = loop2.length;
    let R = Rs.slice();
    for (let iter = 0; iter < 40; iter++) {
      const ring = computeRing(R);
      const bad = ringSelfIntersectsDetail(ring);
      if (bad.length === 0) return R;
      const touched = new Set();
      for (const [i, j] of bad) {
        touched.add(i); touched.add((i + 1) % n);
        touched.add(j); touched.add((j + 1) % n);
      }
      touched.forEach(idx => { R[idx] *= 0.9; });
    }
    return R;
  }

  function buildStitchStrip(trueLoop2, resampledLoop2) {
    function cumlen(poly) {
      const n = poly.length;
      const seg = [];
      let total = 0;
      for (let i = 0; i < n; i++) {
        const a = poly[i], b = poly[(i + 1) % n];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        seg.push(L);
        total += L;
      }
      const t = [0];
      for (let i = 0; i < n - 1; i++) t.push(t[i] + seg[i]);
      return { t, total };
    }

    const T = trueLoop2, R = resampledLoop2;
    const nT = T.length, nR = R.length;
    const { t: tT, total: totalT } = cumlen(T);
    const { t: tRraw, total: totalR } = cumlen(R);
    const tR = tRraw.map(v => v * (totalT / totalR));

    const strip = [];
    let i = 0, j = 0, guard = 0;
    while ((i < nT || j < nR) && guard++ < 20000) {
      const iNext = (i + 1) % nT;
      const jNext = (j + 1) % nR;
      const tiNext = iNext !== 0 ? tT[iNext] : totalT;
      const tjNext = jNext !== 0 ? tR[jNext] : totalT;
      if (iNext === 0 && jNext === 0) break;

      const advanceTrue = (tiNext <= tjNext && iNext !== 0) || (jNext === 0 && iNext !== 0);
      const pTcur = T[i], pRcur = R[j];

      if (advanceTrue) {
        strip.push([pTcur, T[iNext], pRcur]);
        i = iNext;
      } else {
        strip.push([pTcur, R[jNext], pRcur]);
        j = jNext;
      }
      if (i === 0 && j === 0) break;
    }
    return strip;
  }

  function nudgeDegenerateTriangles(triangles2D) {
    const MATCH_TOL = 1e-4;
    function area2(a, b, c) {
      return 0.5 * Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]));
    }
    function keyOf2(p) {
      return Math.round(p[0] / MATCH_TOL) + '|' + Math.round(p[1] / MATCH_TOL);
    }
    const candidateMags = [1e-5, 1e-5 / 3, 1e-5 / 10, 1e-5 / 30, 1e-5 / 100];

    for (const tri of triangles2D) {
      if (area2(tri[0], tri[1], tri[2]) > 1e-9) continue;
      const d01 = Math.hypot(tri[1][0] - tri[0][0], tri[1][1] - tri[0][1]);
      const d12 = Math.hypot(tri[2][0] - tri[1][0], tri[2][1] - tri[1][1]);
      const d02 = Math.hypot(tri[2][0] - tri[0][0], tri[2][1] - tri[0][1]);
      const longest = Math.max(d01, d12, d02);
      let midIdx, aIdx, bIdx;
      if (longest === d02) { midIdx = 1; aIdx = 0; bIdx = 2; }
      else if (longest === d01) { midIdx = 2; aIdx = 0; bIdx = 1; }
      else { midIdx = 0; aIdx = 1; bIdx = 2; }
      const a = tri[aIdx], b = tri[bIdx];
      const edx = b[0] - a[0], edy = b[1] - a[1];
      const elen = Math.hypot(edx, edy);
      if (elen < 1e-12) continue;
      const ex = edx / elen, ey = edy / elen;
      const perp = [-ey, ex];
      const origPt = tri[midIdx].slice();
      const origKey = keyOf2(origPt);
      let fixed = false;
      for (const dir of [1, -1]) {
        for (const mag of candidateMags) {
          const cand = [origPt[0] + perp[0] * mag * dir, origPt[1] + perp[1] * mag * dir];
          if (keyOf2(cand) === origKey) {
            tri[midIdx] = cand;
            fixed = true;
            break;
          }
        }
        if (fixed) break;
      }
    }
    return triangles2D;
  }

  function filletLoop(loop3, Rreq) {
    const raw2 = loop3.map(p => to2(p));
    if (raw2.length < 6 || Rreq < 0.15) return null;

    let trueLoop2 = raw2;
    let loop2 = resampleLoop2(raw2, 0.35);

    let areaTrue = loopArea2(trueLoop2);
    let area = loopArea2(loop2);
    const sign = area >= 0 ? 1 : -1;
    if (areaTrue < 0) trueLoop2 = trueLoop2.slice().reverse();
    if (area < 0) { loop2 = loop2.slice().reverse(); area = -area; }
    const n = loop2.length;

    const Rloc = [];
    for (let i = 0; i < n; i++) {
      const thick = localThickness(loop2, i, 1);
      Rloc.push(Math.min(Rreq, Math.max(0.2, thick * 0.3)));
    }
    let Rs = minFilterCircular(Rloc, 9);
    Rs = smoothRadiusSafely(Rs, 7);

    const Rmax = Math.max(...Rs);
    if (Rmax < 0.15) return null;

    const STEPS = 12;
    const cornerThresh = 30 * Math.PI / 180;
    const corners = [];
    for (let i = 0; i < n; i++) {
      if (Math.abs(turningAngle(loop2, i)) > cornerThresh) corners.push(i);
    }
    const windowN = 12;
    const centers = corners.map(ci => {
      const prev = loop2[(ci - 3 + n) % n], curr = loop2[ci], next = loop2[(ci + 3) % n];
      const n1 = edgeInwardNormal(prev, curr, 1);
      const n2 = edgeInwardNormal(curr, next, 1);
      return { i: ci, C: solveCornerCenter(curr, n1, n2, Rs[ci]), n1, n2, R: Rs[ci] };
    });

    function computeRingAtDepth(Rarr, s) {
      const t = s / STEPS;
      const ring = [];
      for (let i = 0; i < n; i++) {
        const R = Rarr[i];
        const u = R * (1 - t);
        const sinPhi = Math.min(1, Math.max(0, 1 - (R < 1e-6 ? 1 : u / R)));
        const phi = Math.asin(sinPhi);
        const inset = R * (1 - Math.cos(phi));
        let uv = vertexOffset(loop2, i, inset, 1);
        for (const c of centers) {
          if (!c.C) continue;
          const signedDist = i - c.i;
          let d = ((signedDist + n) % n);
          if (d > n / 2) d -= n;
          const absD = Math.abs(d);
          if (absD > windowN) continue;
          const w = smoothstep(1 - absD / windowN);
          const negN1 = [-c.n1[0], -c.n1[1]];
          const negN2 = [-c.n2[0], -c.n2[1]];
          const tBlend = (d + windowN) / (2 * windowN);
          const nBlend = slerp2D(negN1, negN2, tBlend);
          const suv = [c.C[0] + c.R * Math.cos(phi) * nBlend[0], c.C[1] + c.R * Math.cos(phi) * nBlend[1]];
          uv = [uv[0] * (1 - w) + suv[0] * w, uv[1] * (1 - w) + suv[1] * w];
        }
        ring.push(uv);
      }
      return ring;
    }

    Rs = repairSelfIntersections(loop2, Rs, (Rarr) => computeRingAtDepth(Rarr, STEPS));
    const finalRmax = Math.max(...Rs);
    if (finalRmax < 0.15) return null;

    const rings = [];
    for (let s = 0; s <= STEPS; s++) rings.push(computeRingAtDepth(Rs, s));

    if (ringSelfIntersects(rings[rings.length - 1])) return null;

    const tris3 = [];

    const stitch2D = nudgeDegenerateTriangles(buildStitchStrip(trueLoop2, rings[0]));
    for (const [p1, p2, p3] of stitch2D) {
      tris3.push([from2At(p1[0], p1[1], plane), from2At(p2[0], p2[1], plane), from2At(p3[0], p3[1], plane)]);
    }

    for (let s = 0; s < rings.length - 1; s++) {
      const a = rings[s], b = rings[s + 1];
      for (let i = 0; i < n; i++) {
        const i1 = (i + 1) % n;
        const A0 = from2At(a[i][0], a[i][1], plane - outward * (s / STEPS) * finalRmax);
        const A1 = from2At(a[i1][0], a[i1][1], plane - outward * (s / STEPS) * finalRmax);
        const B0 = from2At(b[i][0], b[i][1], plane - outward * ((s + 1) / STEPS) * finalRmax);
        const B1 = from2At(b[i1][0], b[i1][1], plane - outward * ((s + 1) / STEPS) * finalRmax);
        tris3.push([A0, A1, B1], [A0, B1, B0]);
      }
    }
    const inner = rings[rings.length - 1].map(uv => from2At(uv[0], uv[1], plane - outward * finalRmax));
    const cap = earClip(inner);
    cap.forEach(t => tris3.push(t));
    return tris3;
  }

  // LIVE GATE: fillet triangles are added ON TOP of walls that still meet
  // the cut plane. Claude's sandbox builds one consistent mesh (clip+round
  // together). Injecting the fillet here self-intersects the body and looks
  // like the old slice-and-dice. Keep sealed flat cap until rounding is a
  // post-pass on an already-capped STL, or walls are retracted by R first.
  loops.forEach(loop => {
    const tris = earClip(loop);
    tris.forEach(t => pushOriented(t[0], t[1], t[2]));
  });

  return out;
}

function rawEarClip2D(poly2d) {
  function signedArea2D(pts) {
    let a = 0; const n = pts.length;
    for (let i = 0; i < n; i++) { const [x1,y1]=pts[i], [x2,y2]=pts[(i+1)%n]; a += x1*y2 - x2*y1; }
    return a * 0.5;
  }
  function isConvex(a, b, c) { return (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0]) > 1e-9; }
  function pointInTri(p, a, b, c, eps) {
    function sign(p1,p2,p3){ return (p1[0]-p3[0])*(p2[1]-p3[1]) - (p2[0]-p3[0])*(p1[1]-p3[1]); }
    const d1=sign(p,a,b), d2=sign(p,b,c), d3=sign(p,c,a);
    if (Math.abs(d1)<eps || Math.abs(d2)<eps || Math.abs(d3)<eps) return false;
    const hasNeg=d1<0||d2<0||d3<0, hasPos=d1>0||d2>0||d3>0;
    return !(hasNeg && hasPos);
  }
  function onOpenSegment(p, a, c, eps) {
    const ex = c[0]-a[0], ey = c[1]-a[1];
    const cr = ex*(p[1]-a[1]) - ey*(p[0]-a[0]);
    if (Math.abs(cr) >= eps) return false;
    const t = ex*(p[0]-a[0]) + ey*(p[1]-a[1]);
    return t > 0 && t < ex*ex + ey*ey;
  }
  let pts = poly2d;
  const area = signedArea2D(pts);
  const ccwIdxs = area >= 0 ? pts.map((_,i)=>i) : pts.map((_,i)=>i).reverse();
  const work = ccwIdxs.slice();
  const tris = [];
  let guard = 0, scanStart = 0;
  while (work.length > 3 && guard++ < 20000) {
    let found = false;
    const n = work.length;
    for (let s = 0; s < n; s++) {
      const i = (scanStart + s) % work.length;
      const ip = work[(i - 1 + work.length) % work.length];
      const ic = work[i];
      const inx = work[(i + 1) % work.length];
      const a = pts[ip], b = pts[ic], c = pts[inx];
      if (!isConvex(a, b, c)) continue;
      let blocked = false;
      for (const j of work) {
        if (j===ip||j===ic||j===inx) continue;
        if (pointInTri(pts[j], a, b, c, 1e-7)) { blocked = true; break; }
        // A loop vertex lying ON the new diagonal a-c must block too: clipping
        // over it strands a run of collinear loop points that can only be
        // closed with zero-area triangles (a straight wall in a cut section).
        if (onOpenSegment(pts[j], a, c, 1e-7)) { blocked = true; break; }
      }
      if (blocked) continue;
      tris.push([ip, ic, inx]);
      work.splice(i, 1);
      scanStart = i > 0 ? i - 1 : 0;
      found = true;
      break;
    }
    if (!found) {
      // Guaranteed-complete fallback for a genuine dead end — see sandbox notes.
      for (let m = 1; m < work.length - 1; m++) {
        const ia = work[0], ib = work[m], ic = work[m+1];
        const a = pts[ia], b = pts[ib], c = pts[ic];
        const cross = (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0]);
        if (cross >= 0) tris.push([ia, ib, ic]); else tris.push([ia, ic, ib]);
      }
      work.length = 0;
      break;
    }
  }
  if (work.length === 3) tris.push([work[0], work[1], work[2]]);
  return tris;
}

function rawClipTrianglesAtPlane(tris, axisIdx, planeVal, keepMin) {
  const kept = [];
  const cutEdges = [];
  const triCount = tris.length / 9;
  for (let t = 0; t < triCount; t++) {
    const i0 = t * 9;
    const v = [
      [tris[i0], tris[i0+1], tris[i0+2]],
      [tris[i0+3], tris[i0+4], tris[i0+5]],
      [tris[i0+6], tris[i0+7], tris[i0+8]],
    ];
    const d = v.map(p => (p[axisIdx] - planeVal) * (keepMin ? 1 : -1));
    const allIn = d[0] >= 0 && d[1] >= 0 && d[2] >= 0;
    const allOut = d[0] < 0 && d[1] < 0 && d[2] < 0;
    if (allIn) { kept.push(...v[0], ...v[1], ...v[2]); continue; }
    if (allOut) continue;

    const poly = [];
    const intersections = [];
    const onPlaneVerts = [];
    for (let e = 0; e < 3; e++) {
      const a = v[e], b = v[(e+1)%3];
      const da = d[e], db = d[(e+1)%3];
      if (da >= 0) poly.push(a);
      if (da === 0) onPlaneVerts.push(a);
      const crosses = (da > 0 && db < 0) || (da < 0 && db > 0);
      if (crosses) {
        const tt = da / (da - db);
        const p = [a[0]+(b[0]-a[0])*tt, a[1]+(b[1]-a[1])*tt, a[2]+(b[2]-a[2])*tt];
        p[axisIdx] = planeVal;
        poly.push(p);
        intersections.push(p);
      }
    }
    if (intersections.length === 1 && onPlaneVerts.length >= 1) intersections.push(onPlaneVerts[0]);
    for (let i = 1; i < poly.length - 1; i++) kept.push(...poly[0], ...poly[i], ...poly[i+1]);
    if (intersections.length === 2) cutEdges.push([intersections[0], intersections[1]]);
  }
  return { kept, cutEdges };
}

function rawBuildLoopsFromCutEdges(cutEdges, axisIdx, weldTol) {
  weldTol = weldTol || 1e-4;
  const otherAxes = [0, 1, 2].filter(a => a !== axisIdx);
  function key(p) {
    const a = p[otherAxes[0]], b = p[otherAxes[1]];
    return Math.round(a/weldTol) + '|' + Math.round(b/weldTol);
  }
  const nodePos = new Map();
  const adj = new Map();
  function addNode(p) {
    const k = key(p);
    if (!nodePos.has(k)) nodePos.set(k, p);
    if (!adj.has(k)) adj.set(k, new Set());
    return k;
  }
  for (const pair of cutEdges) {
    const k1 = addNode(pair[0]), k2 = addNode(pair[1]);
    if (k1 === k2) continue;
    adj.get(k1).add(k2);
    adj.get(k2).add(k1);
  }
  const degreeIssues = [];
  for (const entry of adj) {
    if (entry[1].size !== 2) degreeIssues.push({ key: entry[0], pos: nodePos.get(entry[0]), degree: entry[1].size });
  }
  const visitedEdges = new Set();
  function ek(a, b) { return a < b ? a+'~'+b : b+'~'+a; }
  const loops = [];
  for (const start of adj.keys()) {
    for (const nb of adj.get(start)) {
      const e0 = ek(start, nb);
      if (visitedEdges.has(e0)) continue;
      const loopKeys = [start];
      let prev = start, cur = nb;
      visitedEdges.add(e0);
      let guard = 0;
      while (cur !== start && guard++ < 200000) {
        loopKeys.push(cur);
        const nbrs = adj.get(cur);
        let next = null;
        for (const cand of nbrs) {
          if (cand === prev) continue;
          const e = ek(cur, cand);
          if (visitedEdges.has(e)) continue;
          next = cand; visitedEdges.add(e); break;
        }
        if (next == null) break;
        prev = cur; cur = next;
      }
      if (cur === start && loopKeys.length >= 3) loops.push(loopKeys.map(k => nodePos.get(k)));
    }
  }
  return { loops: loops, degreeIssues: degreeIssues };
}

function rawFlatCapLoop(loop3d, axisIdx, planeVal, keepMin) {
  const other = [0,1,2].filter(a => a !== axisIdx);
  const poly2d = loop3d.map(p => [p[other[0]], p[other[1]]]);
  const triIdx = rawEarClip2D(poly2d);
  const out = [];
  for (const tri of triIdx) {
    let a = loop3d[tri[0]], b = loop3d[tri[1]], c = loop3d[tri[2]];
    const ux=b[0]-a[0], uy=b[1]-a[1], uz=b[2]-a[2];
    const vx=c[0]-a[0], vy=c[1]-a[1], vz=c[2]-a[2];
    const n = [uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx];
    const wantSign = keepMin ? -1 : 1;
    if (Math.sign(n[axisIdx] || 1) !== wantSign) { const t=b; b=c; c=t; }
    out.push(a[0],a[1],a[2], b[0],b[1],b[2], c[0],c[1],c[2]);
  }
  return out;
}

// A section's loops classed by nesting depth: even = an outer boundary, odd =
// a hole in the smallest loop around it. Returns one entry per loop,
// {p3, p2, area, depth, parent, holes}, in the order given. Shared by
// rawFlatCapLoops (which caps them) and nso_section.js (which reads them), so
// "a loop inside a loop" means the same thing to both. The loops come from a
// manifold cut, so they never cross or share a point, which makes one vertex
// enough to decide containment.
function rawNestLoops(loops3d, axisIdx) {
  const other = [0,1,2].filter(a => a !== axisIdx);
  const L = loops3d.map(l => {
    const p2 = l.map(p => [p[other[0]], p[other[1]]]);
    let a = 0;
    for (let i = 0; i < p2.length; i++) { const p = p2[i], q = p2[(i+1) % p2.length]; a += p[0]*q[1] - q[0]*p[1]; }
    return { p3: l, p2: p2, area: a / 2, depth: 0, parent: -1, holes: [] };
  });
  function inside(pt, poly) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < (b[0]-a[0]) * (pt[1]-a[1]) / (b[1]-a[1]) + a[0]) c = !c;
    }
    return c;
  }
  const holders = L.map(() => []);
  for (let i = 0; i < L.length; i++) {
    for (let j = 0; j < L.length; j++) {
      if (i !== j && Math.abs(L[j].area) > Math.abs(L[i].area) && inside(L[i].p2[0], L[j].p2)) holders[i].push(j);
    }
    L[i].depth = holders[i].length;
  }
  for (let i = 0; i < L.length; i++) {
    if (L[i].depth % 2 === 0) continue;
    let best = -1;
    for (const j of holders[i]) if (L[j].depth === L[i].depth - 1 && (best < 0 || Math.abs(L[j].area) < Math.abs(L[best].area))) best = j;
    if (best < 0) throw new Error('cap: a hole in the cut section has no outline around it');
    L[i].parent = best;
    L[best].holes.push(i);
  }
  return L;
}

// Caps ALL of a section's loops together. rawFlatCapLoop fills one simple
// outline; a section through a tube or a hinge knuckle is an outline with a
// bore inside it, and capping each loop on its own fills the bore as a second
// disk (double-covering it, the winding inconsistent against the bore wall).
// Here loops are classed by nesting depth (even = an outer boundary, odd = a
// hole in the smallest loop around it), each hole is joined to its outer
// boundary by a bridge edge walked both ways (the standard hole-to-polygon
// reduction), and the resulting single outline goes to rawFlatCapLoop. The
// section's loops come from a manifold cut, so they never cross or share a
// point (rawBuildLoopsFromCutEdges refuses branch points), which makes one
// vertex enough to decide containment. A loop with no holes is capped exactly
// as before.
function rawFlatCapLoops(loops3d, axisIdx, planeVal, keepMin) {
  const L = rawNestLoops(loops3d, axisIdx);
  const out = [];
  for (let i = 0; i < L.length; i++) {
    if (L[i].depth % 2 !== 0) continue;
    const merged = L[i].holes.length ? rawBridgeHoles(L[i], L[i].holes.map(h => L[h])) : L[i].p3;
    const cap = rawFlatCapLoop(merged, axisIdx, planeVal, keepMin);
    for (let k = 0; k < cap.length; k++) out.push(cap[k]);
  }
  return out;
}

// One outline from an outer loop and the holes inside it: outer counter-
// clockwise, each hole clockwise, spliced in through a bridge from a hole
// vertex M to an outline vertex P that sees it (the open segment M-P crosses
// no edge of the outline built so far or of a hole still waiting, and leaves
// P into the material rather than into another hole or the outside). M and P
// then appear twice, and the bridge is walked once each way, so the fill
// shares exactly the loop points with the walls and adds no vertex. Loop
// entries are {p2, p3, area} as built by rawNestLoops.
function rawBridgeHoles(outer, holes) {
  function oriented(l, ccw) {
    const idx = l.p2.map((_, i) => i);
    if ((l.area > 0) !== ccw) idx.reverse();
    return idx.map(i => ({ p2: l.p2[i], p3: l.p3[i] }));
  }
  function cross(o, a, b) { return (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0]); }
  function same(a, b) { return a[0] === b[0] && a[1] === b[1]; }
  // Open segment p-q against closed segment a-b; touching counts, except at a
  // shared endpoint of the two.
  function hits(p, q, a, b) {
    if ((same(a, p) || same(a, q)) && (same(b, p) || same(b, q))) return true;
    const pShared = same(a, p) || same(b, p), qShared = same(a, q) || same(b, q);
    const d1 = cross(a, b, p), d2 = cross(a, b, q), d3 = cross(p, q, a), d4 = cross(p, q, b);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
    function on(x, s, e) {
      return Math.min(s[0], e[0]) <= x[0] && x[0] <= Math.max(s[0], e[0]) && Math.min(s[1], e[1]) <= x[1] && x[1] <= Math.max(s[1], e[1]);
    }
    if (d3 === 0 && !same(a, p) && !same(a, q) && on(a, p, q)) return true;
    if (d4 === 0 && !same(b, p) && !same(b, q) && on(b, p, q)) return true;
    if (d1 === 0 && !pShared && on(p, a, b)) return true;
    if (d2 === 0 && !qShared && on(q, a, b)) return true;
    return false;
  }
  // Does direction P->m leave P into the material of a CCW outline whose
  // neighbours of P are a (before) and b (after)?
  function inWedge(a, P, b, m) {
    const l1 = cross(a, P, m) > 0, l2 = cross(P, b, m) > 0;
    return cross(a, P, b) >= 0 ? (l1 && l2) : (l1 || l2);
  }
  let poly = oriented(outer, true);
  const pending = holes.map(h => oriented(h, false));
  // Rightmost holes first: their bridges tend to run short and clear.
  pending.sort((A, B) => Math.max(...B.map(v => v.p2[0])) - Math.max(...A.map(v => v.p2[0])));
  while (pending.length) {
    const hole = pending.shift();
    const mOrder = hole.map((_, i) => i).sort((i, j) => hole[j].p2[0] - hole[i].p2[0]);
    let done = false;
    for (const mi of mOrder) {
      const M = hole[mi].p2;
      const cand = poly.map((_, i) => i).sort((i, j) => {
        const a = poly[i].p2, b = poly[j].p2;
        return ((a[0]-M[0])**2 + (a[1]-M[1])**2) - ((b[0]-M[0])**2 + (b[1]-M[1])**2);
      });
      for (const pi of cand) {
        const P = poly[pi].p2;
        if (!inWedge(poly[(pi - 1 + poly.length) % poly.length].p2, P, poly[(pi + 1) % poly.length].p2, M)) continue;
        let blocked = false;
        for (const ring of [poly, hole].concat(pending)) {
          for (let e = 0; e < ring.length && !blocked; e++) {
            if (hits(M, P, ring[e].p2, ring[(e + 1) % ring.length].p2)) blocked = true;
          }
          if (blocked) break;
        }
        if (blocked) continue;
        const h = hole.slice(mi).concat(hole.slice(0, mi + 1));
        poly = poly.slice(0, pi + 1).concat(h, poly.slice(pi));
        done = true;
        break;
      }
      if (done) break;
    }
    if (!done) throw new Error('cap: no clear bridge from a hole in the cut section to its outline');
  }
  return poly.map(v => v.p3);
}

// rawCut(rawTris, axisIdx, plane, keepMin)
// rawTris: Float32Array/number[] flat triangle soup, original file axes.
// axisIdx: 0/1/2 in that RAW frame (not the display axis letter).
// plane: coordinate value of the cut plane, in RAW (uncentered) space.
// keepMin: true = keep material where coord <= plane.
// Returns a Float32Array of the resulting watertight, flat-capped half,
// still in raw (uncentered, original-file-axis) coordinates — or null if
// the cut produced nothing.
//
// Seam safety (v9_mirror_factory.stl, tools/nso_rawcut_seam_test.js): a
// Join's boolean re-triangulates the seam region into long slivers running
// seam-to-seam, and can leave vertex pairs (and whole seam rings) within the
// 1e-4 weld radius of each other or of a plane the user cuts at. The old
// clip-and-cap broke on all of it — 372 of 374 pieces in a 1 mm sweep failed
// tools/mesh_validate.py:
//  - the plane slices a sliver where it is narrower than the weld radius, so
//    its two cut points sit < 1e-4 apart. rawBuildLoopsFromCutEdges merged
//    them for the cap while the walls kept both: cap and walls stopped sharing
//    vertices (open edges even at weld 1e-6), and the walls kept a needle the
//    checker collapses into non-manifold edges / inconsistent winding;
//  - the input's own sub-tolerance pairs were passed through verbatim;
//  - edges already ON the plane (a seam ring) never became cap edges, since
//    the cut-edge list came only from edge/plane crossings.
// rawCut therefore: welds the input (rawWeldSoup); puts vertices within the
// weld radius of the plane exactly on it; clips; welds all on-plane points on
// their float32 positions and rewrites the walls to them (rawSnapPlanePoints);
// reads the cap edges off the kept surface's own open boundary
// (rawPlaneBoundaryEdges); and finally splits away any triangle float32 made
// zero-area (rawSplitDegenerates). Every collapse moves geometry by at most
// the weld radius, which is the resolution mesh_validate.py already assumes.
const RAW_CUT_WELD_TOL = 1e-4;

// Transitive radius weld over a flat xyz point list (union-find over a
// tol-sized hash, 27-cell neighbourhood, so pairs straddling a cell boundary
// still merge). Returns, per point, the index of its cluster's first point.
function rawWeldPoints(pts, tol) {
  const n = (pts.length / 3) | 0;
  // A soup repeats every vertex ~6 times; weld the distinct positions only.
  // Numeric sort + integer cell hash: string keys cost ~5x on a 50k-tri part.
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((i, j) => (pts[i*3] - pts[j*3]) || (pts[i*3+1] - pts[j*3+1]) || (pts[i*3+2] - pts[j*3+2]));
  const uid = new Int32Array(n);
  const firstOf = [];
  for (let s = 0; s < n; s++) {
    const i = order[s];
    if (s > 0) {
      const j = order[s - 1];
      if (pts[i*3] === pts[j*3] && pts[i*3+1] === pts[j*3+1] && pts[i*3+2] === pts[j*3+2]) { uid[i] = uid[j]; continue; }
    }
    uid[i] = firstOf.length;
    firstOf.push(i);
  }
  const m = firstOf.length;
  const parent = new Int32Array(m);
  for (let i = 0; i < m; i++) parent[i] = i;
  function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
  // Collisions only lump cells together; the true distance test below decides.
  function cellKey(cx, cy, cz) { return ((cx * 73856093) ^ (cy * 19349663) ^ (cz * 83492791)) | 0; }
  const inv = 1 / tol, tol2 = tol * tol;
  const cells = new Map();
  for (let u = 0; u < m; u++) {
    const o = firstOf[u] * 3;
    const x = pts[o], y = pts[o+1], z = pts[o+2];
    const cx = Math.floor(x * inv), cy = Math.floor(y * inv), cz = Math.floor(z * inv);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      const list = cells.get(cellKey(cx+a, cy+b, cz+c));
      if (!list) continue;
      for (const w of list) {
        const q = firstOf[w] * 3;
        const dx = x - pts[q], dy = y - pts[q+1], dz = z - pts[q+2];
        if (dx*dx + dy*dy + dz*dz > tol2) continue;
        const ru = find(u), rw = find(w);
        if (ru !== rw) { if (ru < rw) parent[rw] = ru; else parent[ru] = rw; }
      }
    }
    const k = cellKey(cx, cy, cz);
    const list = cells.get(k);
    if (list) list.push(u); else cells.set(k, [u]);
  }
  const rep = new Int32Array(n);
  for (let i = 0; i < n; i++) rep[i] = firstOf[find(uid[i])];
  return rep;
}

// Welds a flat triangle soup with rawWeldPoints and drops triangles with two
// equal corners afterwards. Returns a plain number[].
function rawWeldSoup(tris, tol) {
  const rep = rawWeldPoints(tris, tol);
  const out = [];
  for (let t = 0; t < rep.length; t += 3) {
    const a = rep[t], b = rep[t+1], c = rep[t+2];
    if (a === b || b === c || a === c) continue;
    out.push(tris[a*3], tris[a*3+1], tris[a*3+2], tris[b*3], tris[b*3+1], tris[b*3+2], tris[c*3], tris[c*3+1], tris[c*3+2]);
  }
  return out;
}

// Weld every kept vertex lying exactly on the cut plane (clip intersections
// and on-plane corners) with rawWeldPoints and rewrite the walls to the shared
// representatives. Triangles collapsing to a line are dropped, and so is a
// triangle lying IN the plane unless it faces the discarded side (it is then
// already part of the cap; facing the kept side it is the skin of material
// that was cut away and would double the cap). Returns a number[].
function rawSnapPlanePoints(kept, axisIdx, planeVal, keepMin, tol) {
  // Weld and emit float32-rounded positions: rawCut returns a Float32Array,
  // and two points just over tol apart in double can land at or under it
  // after rounding. The 2x radius keeps a margin for the further rounding of
  // rawResultToDisplayGeometry's re-centring on export.
  const pts = [];
  for (let i = 0; i < kept.length; i += 3) {
    if (kept[i + axisIdx] === planeVal) pts.push(kept[i], kept[i+1], kept[i+2]);
  }
  const f32 = pts.map((c, i) => (i % 3 === axisIdx ? c : Math.fround(c)));
  const repIdx = rawWeldPoints(f32, 2 * tol);
  const rep = new Map();
  for (let i = 0; i < repIdx.length; i++) {
    const r = repIdx[i];
    rep.set(pts[i*3] + ',' + pts[i*3+1] + ',' + pts[i*3+2], [f32[r*3], f32[r*3+1], f32[r*3+2]]);
  }
  const capSign = keepMin ? -1 : 1;
  const out = [];
  for (let t = 0; t < kept.length; t += 9) {
    const v = [];
    let onPlane = 0;
    for (let k = 0; k < 3; k++) {
      const o = t + k * 3;
      if (kept[o + axisIdx] === planeVal) { onPlane++; v.push(rep.get(kept[o] + ',' + kept[o+1] + ',' + kept[o+2])); }
      else v.push([kept[o], kept[o+1], kept[o+2]]);
    }
    if (rawSamePt(v[0], v[1]) || rawSamePt(v[1], v[2]) || rawSamePt(v[0], v[2])) continue;
    if (onPlane === 3) {
      const o1 = (axisIdx + 1) % 3, o2 = (axisIdx + 2) % 3;
      const n = (v[1][o1]-v[0][o1])*(v[2][o2]-v[0][o2]) - (v[1][o2]-v[0][o2])*(v[2][o1]-v[0][o1]);
      if (Math.sign(n) !== capSign) continue;
    }
    out.push(...v[0], ...v[1], ...v[2]);
  }
  return out;
}

function rawSamePt(a, b) { return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]; }

// The cap's edges, read off the kept surface itself: every kept edge with no
// reverse twin whose ends both lie on the plane. Unlike the clipper's own
// intersection list this also sees an edge whose two ends were already on the
// plane (a seam ring snapped onto it), and it cannot disagree with the walls.
function rawPlaneBoundaryEdges(kept, axisIdx, planeVal) {
  function k(o) { return kept[o] + ',' + kept[o+1] + ',' + kept[o+2]; }
  const directed = new Map();
  for (let t = 0; t < kept.length; t += 9) {
    for (let e = 0; e < 3; e++) {
      const oa = t + e * 3, ob = t + ((e + 1) % 3) * 3;
      if (kept[oa + axisIdx] !== planeVal || kept[ob + axisIdx] !== planeVal) continue;
      const fwd = k(oa) + '>' + k(ob), rev = k(ob) + '>' + k(oa);
      if (directed.has(rev)) directed.delete(rev);
      else directed.set(fwd, [[kept[oa], kept[oa+1], kept[oa+2]], [kept[ob], kept[ob+1], kept[ob+2]]]);
    }
  }
  return Array.from(directed.values());
}

// Removes zero-area triangles (three distinct but collinear corners, e.g. a
// sliver thinner than float32 resolution near the plane) without opening the
// mesh: the neighbour across the long edge u-v is split at the middle corner c,
// which gives the triangle's two short edges their twins, then the triangle is
// dropped. Works on the float32 output so it sees what a checker will see.
function rawSplitDegenerates(f32) {
  const LIMIT = 4e-20; // |2A|^2 for area 1e-10, well under any real facet
  let any = false;
  for (let t = 0; t < f32.length && !any; t += 9) {
    const ux = f32[t+3]-f32[t], uy = f32[t+4]-f32[t+1], uz = f32[t+5]-f32[t+2];
    const vx = f32[t+6]-f32[t], vy = f32[t+7]-f32[t+1], vz = f32[t+8]-f32[t+2];
    const x = uy*vz-uz*vy, y = uz*vx-ux*vz, z = ux*vy-uy*vx;
    if (x*x + y*y + z*z < LIMIT) any = true;
  }
  if (!any) return f32;
  const tris = [];
  for (let t = 0; t < f32.length; t += 9) tris.push([[f32[t], f32[t+1], f32[t+2]], [f32[t+3], f32[t+4], f32[t+5]], [f32[t+6], f32[t+7], f32[t+8]]]);
  function area2(T) {
    const ux = T[1][0]-T[0][0], uy = T[1][1]-T[0][1], uz = T[1][2]-T[0][2];
    const vx = T[2][0]-T[0][0], vy = T[2][1]-T[0][1], vz = T[2][2]-T[0][2];
    const x = uy*vz-uz*vy, y = uz*vx-ux*vz, z = ux*vy-uy*vx;
    return x*x + y*y + z*z;
  }
  function pk(p) { return p[0] + ',' + p[1] + ',' + p[2]; }
  function d2(a, b) { return (a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2; }
  const owner = new Map();
  function own(i, on) {
    const T = tris[i];
    for (let e = 0; e < 3; e++) {
      const k = pk(T[e]) + '>' + pk(T[(e+1)%3]);
      if (on) owner.set(k, i); else if (owner.get(k) === i) owner.delete(k);
    }
  }
  for (let i = 0; i < tris.length; i++) own(i, true);
  const work = [];
  for (let i = 0; i < tris.length; i++) if (area2(tris[i]) < LIMIT) work.push(i);
  let guard = 0;
  while (work.length && guard++ < 100000) {
    const i = work.pop();
    const T = tris[i];
    if (!T || area2(T) >= LIMIT) continue;
    let e = 0;
    for (let k = 1; k < 3; k++) if (d2(T[k], T[(k+1)%3]) > d2(T[e], T[(e+1)%3])) e = k;
    const u = T[e], v = T[(e+1)%3], c = T[(e+2)%3];
    const j = owner.get(pk(v) + '>' + pk(u));
    if (j == null || j === i || !tris[j]) continue;   // no twin: leave it
    const N = tris[j];
    const ev = N.findIndex(p => pk(p) === pk(v));
    const d = N[(ev+2)%3];
    own(i, false); own(j, false);
    tris[i] = null;
    tris[j] = [v, c, d];
    tris.push([c, u, d]);
    own(j, true); own(tris.length - 1, true);
    // The halves are degenerate only if N was; then they get their own turn.
    if (area2(tris[j]) < LIMIT) work.push(j);
    if (area2(tris[tris.length - 1]) < LIMIT) work.push(tris.length - 1);
  }
  const out = [];
  for (const T of tris) if (T) out.push(...T[0], ...T[1], ...T[2]);
  return new Float32Array(out);
}

// The open half of rawCut: everything up to, but not including, the cap.
// Returns the kept walls (a number[], on-plane points welded and exactly on
// the plane) or null when nothing is kept. Crop (app-crop.js) calls this for
// both of its planes and seals the joint itself; rawCut caps it.
function rawCutOpen(rawTris, axisIdx, plane, keepMin) {
  const soup = rawWeldSoup(rawTris, RAW_CUT_WELD_TOL);
  // A vertex within the weld radius of the plane IS on it as far as any
  // checker is concerned; leave it a hair off and the cap and that vertex
  // collapse into each other downstream. Put it exactly on the plane instead.
  for (let i = axisIdx; i < soup.length; i += 3) {
    if (Math.abs(soup[i] - plane) <= RAW_CUT_WELD_TOL) soup[i] = plane;
  }
  const clipped = rawClipTrianglesAtPlane(soup, axisIdx, plane, keepMin);
  const kept = rawSnapPlanePoints(clipped.kept, axisIdx, plane, keepMin, RAW_CUT_WELD_TOL);
  return kept.length ? kept : null;
}

function rawCut(rawTris, axisIdx, plane, keepMin) {
  const kept = rawCutOpen(rawTris, axisIdx, plane, keepMin);
  if (!kept) return null;
  // Points are already welded and snapped, so walk the loop on exact keys; a
  // second grid round here could re-merge two distinct representatives that
  // share a 1e-4 cell (up to 1.41e-4 apart) and reopen the mismatch.
  const walked = rawBuildLoopsFromCutEdges(rawPlaneBoundaryEdges(kept, axisIdx, plane), axisIdx, 1e-9);
  if (walked.degreeIssues.length > 0) throw new Error(walked.degreeIssues.length + ' branch point(s) in raw cut boundary');
  const out = kept;
  const cap = rawFlatCapLoops(walked.loops, axisIdx, plane, keepMin);
  for (let i = 0; i < cap.length; i++) out.push(cap[i]);
  if (out.length < 9) return null;
  return rawSplitDegenerates(new Float32Array(out));
}

/** Lay out every model in the library on the plate (inspection / multi-piece view). Not a pack. */
function showAllModelsOnPlate() {
  if (!state.modelGroup) return;
  clearDisplayMeshes();
  state.placed = [];
  state.previewMesh = null;
  removeCutHelper();
  state.selectedIndex = -1;

  const models = state.models.slice();
  if (!models.length) {
    const exportBtn = document.getElementById('btn-export-stl');
    if (exportBtn) exportBtn.disabled = true;
    updateAdjustUI();
    return;
  }

  const gap = Math.max(KERF_MM, 3);
  const colors = [0x38bdf8, 0x4ade80, 0xfbbf24, 0xf472b6, 0xa78bfa, 0x22d3ee];
  let cursor = 0;
  const entries = [];

  models.forEach((m, i) => {
    if (!m.geometry) return;
    const mat = new THREE.MeshStandardMaterial({
      color: PIECE_COLOR,
      metalness: 0.05,
      roughness: 0.4,
      emissive: 0x0a3a5c,
      emissiveIntensity: 0.2
    });
    const mesh = new THREE.Mesh(m.geometry, mat);
    const w = m.size.x;
    const d = m.size.z;
    const h = m.size.y;
    const x = cursor + w / 2;
    mesh.position.set(x, h / 2 + 0.3, 0);
    mesh.userData.placedIndex = entries.length;
    mesh.userData.sourceId = m.id;
    state.modelGroup.add(mesh);
    entries.push({
      mesh,
      geometry: m.geometry,
      name: m.name,
      x,
      z: 0,
      width: w,
      depth: d,
      height: h,
      yaw: 0,
      rotY: 0,
      flipX: false,
      tipX: 0,
      overflow: false,
      sourceId: m.id,
      outline: null
    });
    cursor += w + gap;
  });

  // Center the row on the plate origin
  const totalW = cursor - gap;
  const shift = totalW / 2;
  entries.forEach(p => {
    p.x -= shift;
    p.mesh.position.x = p.x;
  });

  state.placed = entries;
  const exportBtn = document.getElementById('btn-export-stl');
  if (exportBtn) exportBtn.disabled = entries.length === 0;
  updateAdjustUI();
}

/** Show both halves on the plate with a visible gap (no Optimize needed) */
function layoutUndoModels(models) {
  if (!state.modelGroup) return;
  clearDisplayMeshes();
  state.placed = [];
  state.previewMesh = null;
  removeCutHelper();
  const colors = [0x38bdf8, 0x4ade80, 0xfbbf24, 0xf472b6, 0xa78bfa, 0x22d3ee];
  models.forEach(function (mod, i) {
    if (!mod || !mod.geometry) return;
    const x = (typeof mod.plateX === 'number') ? mod.plateX : (i * 40);
    const z = (typeof mod.plateZ === 'number') ? mod.plateZ : 0;
    placeModelMovable(mod, x, z);
  });
  state.placed.forEach(function (pl, i) {
    if (pl.mesh && pl.mesh.material && pl.mesh.material.color) {
      pl.mesh.material.color.setHex(PIECE_COLOR);
    }
  });
  const exportBtn = document.getElementById('btn-export-stl');
  if (exportBtn) exportBtn.disabled = state.placed.length === 0;
  updateAdjustUI();
}

/** Which end of a half is the planar cut cap along plate X. 'max' = cap faces +X. */
function cutCapSideX(model) {
  const geo = model && model.geometry;
  if (!geo || !geo.attributes || !geo.attributes.position) return null;
  const pos = geo.attributes.position;
  const n = pos.count;
  if (n < 9) return null;
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const minX = bb.min.x;
  const maxX = bb.max.x;
  const span = maxX - minX;
  if (!(span > 0.5)) return null;
  const band = Math.max(0.35, Math.min(1.2, span * 0.04));
  let nearMin = 0;
  let nearMax = 0;
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i);
    if (Math.abs(x - minX) <= band) nearMin++;
    if (Math.abs(x - maxX) <= band) nearMax++;
  }
  if (nearMax > nearMin * 1.15) return 'max';
  if (nearMin > nearMax * 1.15) return 'min';
  return nearMax >= nearMin ? 'max' : 'min';
}

function layoutAfterSplit(sourcePose, poseById, sourceId, modelA, modelB, axis, stayA, stayB, along) {
  if (!state.modelGroup) return;
  clearDisplayMeshes();
  state.placed = [];
  state.previewMesh = null;
  removeCutHelper();

  state.models.forEach(function (mod) {
    if (!mod || !mod.geometry) return;
    if (modelA && mod.id === modelA.id) return;
    if (modelB && mod.id === modelB.id) return;
    const pose = poseById[mod.id];
    if (!pose) return;
    const e = placeModelMovable(mod, pose.x, pose.z);
    if (e) applyPlacedOrientation(e, pose);
  });

  // Leave halves where they sat. stayA/stayB = bbox center in parent space before .center().
  function stayWorld(stay, ori) {
    const v = new THREE.Vector3(
      stay && typeof stay.x === 'number' ? stay.x : 0,
      stay && typeof stay.y === 'number' ? stay.y : 0,
      stay && typeof stay.z === 'number' ? stay.z : 0
    );
    if (ori) {
      // applyMeshRotation's own composition, flip included: a record with
      // flipX (a scene 3MF puts one back) otherwise parts the halves the
      // wrong way round along a cut it turns over.
      const e = new THREE.Euler(
        ((ori.tipX || 0) * Math.PI / 2) + ((ori.tiltX || 0) * Math.PI / 180) + (ori.flipX ? Math.PI : 0),
        ori.rotY || 0,
        ((ori.tipZ || 0) * Math.PI / 2) + ((ori.tiltZ || 0) * Math.PI / 180),
        'XYZ'
      );
      v.applyEuler(e);
    }
    return { x: (sourcePose.x || 0) + v.x, z: (sourcePose.z || 0) + v.z };
  }
  const srcOri = poseById[sourceId] || sourcePose || {};
  let aOff = stayWorld(stayA, srcOri);
  let bOff = stayWorld(stayB, srcOri);
  let ax = aOff.x, az = aOff.z, bx = bOff.x, bz = bOff.z;
  const pad = SPLIT_VIEW_GAP_MM * 0.5;
  /* `along`: the cut's travel line on the plate, for a square cut across a
     turned piece's length (cutFrame's base turn): the halves part along it,
     away from the blade, as they part along the plate axis a square cut on a
     piece lying square runs on. Null for every other cut, as before. */
  const n = along ? new THREE.Vector3(along.x, 0, along.z) : null;
  if (n && n.lengthSq() > 1e-12) {
    n.normalize();
    const dir = (bx - ax) * n.x + (bz - az) * n.z >= 0 ? 1 : -1;
    ax -= dir * pad * n.x; az -= dir * pad * n.z;
    bx += dir * pad * n.x; bz += dir * pad * n.z;
  } else if (axis === 'z') {
    const dir = bz >= az ? 1 : -1;
    az -= dir * pad;
    bz += dir * pad;
  } else {
    const dir = bx >= ax ? 1 : -1;
    ax -= dir * pad;
    bx += dir * pad;
  }
  if (modelA) {
    const eA = placeModelMovable(modelA, ax, az);
    if (eA) applyPlacedOrientation(eA, srcOri);
  }
  if (modelB) {
    const eB = placeModelMovable(modelB, bx, bz);
    if (eB) applyPlacedOrientation(eB, srcOri);
  }

  /* Join slots stay empty until Start Join → Pick A → Pick B */

  state.placed.forEach(function (pl, i) {
    if (pl.mesh && pl.mesh.material && pl.mesh.material.color) {
      pl.mesh.material.color.setHex(PIECE_COLOR);
    }
  });
  if (typeof updateJoinUI === 'function') updateJoinUI();
  const exportBtn = document.getElementById('btn-export-stl');
  if (exportBtn) exportBtn.disabled = state.placed.length === 0;
  updateAdjustUI();
}

function placeHalvesOnPlate(modelA, modelB, axis) {
  // Prefer full library layout so 2nd cuts / multi pieces stay consistent
  if (state.models.length >= 1) {
    showAllModelsOnPlate();
    return;
  }
  if (!state.modelGroup || !modelA || !modelB) return;
  clearDisplayMeshes();
  state.placed = [];
  state.previewMesh = null;
  removeCutHelper();

  const gap = Math.max(KERF_MM, 2);
  const matA = new THREE.MeshStandardMaterial({
    color: 0x38bdf8, metalness: 0.05, roughness: 0.4,
    emissive: 0x0a3a5c, emissiveIntensity: 0.25
  });
  const matB = new THREE.MeshStandardMaterial({
    color: 0x4ade80, metalness: 0.05, roughness: 0.4,
    emissive: 0x14532d, emissiveIntensity: 0.2
  });

  const meshA = new THREE.Mesh(modelA.geometry, matA);
  const meshB = new THREE.Mesh(modelB.geometry, matB);
  const hA = modelA.size.y / 2 + 0.3;
  const hB = modelB.size.y / 2 + 0.3;

  // Place along X with gap between them
  const wA = modelA.size.x;
  const wB = modelB.size.x;
  const xA = -((wA + wB + gap) / 2) + wA / 2;
  const xB = xA + wA / 2 + gap + wB / 2;
  meshA.position.set(xA, hA, 0);
  meshB.position.set(xB, hB, 0);
  meshA.userData.placedIndex = 0;
  meshB.userData.placedIndex = 1;
  state.modelGroup.add(meshA);
  state.modelGroup.add(meshB);

  state.placed = [
    {
      mesh: meshA, geometry: modelA.geometry, name: modelA.name,
      x: xA, z: 0, width: modelA.size.x, depth: modelA.size.z, height: modelA.size.y,
      yaw: 0, rotY: 0, flipX: false, tipX: 0, overflow: false, sourceId: modelA.id, outline: null
    },
    {
      mesh: meshB, geometry: modelB.geometry, name: modelB.name,
      x: xB, z: 0, width: modelB.size.x, depth: modelB.size.z, height: modelB.size.y,
      yaw: 0, rotY: 0, flipX: false, tipX: 0, overflow: false, sourceId: modelB.id, outline: null
    }
  ];
  const exportBtn = document.getElementById('btn-export-stl');
  if (exportBtn) exportBtn.disabled = false;
  updateAdjustUI();
}


// Map a Split plane from display-local space (Y-up, centered — what
// getCutPlaneForSplit returns) back into the raw, untranslated,
// original-file-axis space that rawTris/rawCut operate on. Inverts, in
// order: geometry.center() (via the stored centerOffset), then
// rotateX(-PI/2) (via the fixed axis/sign remap below). The display frame
// is (x, z, -y) of the raw one, less centerOffset. Returns null if the model
// has no raw triple (rawTris, rawAxis 'zup', centerOffset); splitBothSides
// then cuts the display mesh with the same engine.
function mapPlaneToRaw(model, displayAxis, displayPlane, keepMin) {
  if (!model.rawTris || !model.centerOffset || model.rawAxis !== 'zup') return null;
  const off = model.centerOffset;
  if (displayAxis === 'x') {
    // raw x0 = dispX + centerOffset.x — axis and sign unaffected by rotateX(-90deg)
    return { axisIdx: 0, plane: displayPlane + off.x, keepMin: keepMin };
  }
  if (displayAxis === 'y') {
    // dispY = z0 - centerOffset.y  =>  z0 = dispY + centerOffset.y
    // Increasing dispY is increasing raw z0, as on X — keepMin unchanged.
    return { axisIdx: 2, plane: displayPlane + off.y, keepMin: keepMin };
  }
  if (displayAxis === 'z') {
    // dispZ = -y0 - centerOffset.z  =>  y0 = -dispZ - centerOffset.z
    // Increasing dispZ means DECREASING raw y0 — keepMin flips.
    return { axisIdx: 1, plane: -displayPlane - off.z, keepMin: !keepMin };
  }
  return null;
}

// Convert a raw-space Float32Array (from rawCut, original file axes,
// untranslated) into a Y-up, centered BufferGeometry matching what the
// rest of the app expects on the plate — i.e. re-apply the SAME
// rotateX(-PI/2) + center() transform used at load time, so a Split
// result looks identical in the viewport to a freshly-loaded piece.
function rawResultToDisplayGeometry(rawFlatTris, parentOffset) {
  const arr = new Float32Array(rawFlatTris);
  const cos = Math.cos(-Math.PI/2), sin = Math.sin(-Math.PI/2);
  for (let i = 0; i < arr.length; i += 3) {
    const y = arr[i+1], z = arr[i+2];
    arr[i+1] = y*cos - z*sin;
    arr[i+2] = y*sin + z*cos;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
  geo.computeVertexNormals();
  if (parentOffset) {
    geo.translate(-parentOffset.x, -parentOffset.y, -parentOffset.z);
  } else {
    geo.center();
  }
  geo.computeBoundingBox();
  return geo;
}

// ===================== Split: one engine, no fallback =====================
// Every Cut goes through rawCut, whose cap (rawFlatCapLoops) nests the
// section's loops, so a tube's cut face is one annulus with its bore open.
// A piece with a raw triple is cut in the raw frame (mapPlaneToRaw); any
// other piece (an Array copy, a half of an earlier display cut) is cut on its
// display mesh, handed to rawCut as a triangle soup - rawCut does not care
// which frame a soup is in.
//
// There is no second engine to fall back to. The old one (clipGeometrySide
// -> capFromEdges) ear-clipped every loop on its own, so a bore was lidded
// and the lid sat on top of the annulus: two sets of faces on one plane. If
// rawCut cannot close the cut face, the Cut is refused with a CutRefused
// error whose message says why in plain words, and the piece is left alone.
//
// A clean split. Both sides are cut at the ONE plane, so the two halves meet
// there exactly - no kerf band between them, no overlap - and add back to
// the piece. `left` is the low side along the cut axis on both routes (rawCut's
// keepMin = true keeps coord >= plane; mapPlaneToRaw carries the side into
// the raw frame, flipping it where display Z runs against raw Y). The two
// routes used to disagree: the display route took a kerf band out between
// the halves, and the raw route gave each half the band (an 8 mm ring cut at
// 4 came out 4.5 + 4.5). Now an 8 mm piece cut at 4 is 4 + 4 on either.
const CUT_DISPLAY_AXIS_IDX = { x: 0, y: 1, z: 2 };

function cutRefused(message) {
  const err = new Error(message);
  err.name = 'CutRefused';
  return err;
}

// rawCut's own errors, said the way the status line should say them.
function cutPlainReason(err) {
  const m = String((err && err.message) || err);
  if (/branch point/.test(m)) {
    return 'where the red plane crosses the piece its surface is open or touches itself, so the cut face cannot be closed';
  }
  if (/no outline around it/.test(m)) return 'a hole in the cut face has no outline around it';
  if (/no clear bridge/.test(m)) return 'a hole in the cut face could not be joined to the outline around it';
  return 'the cut face could not be closed (' + m + ')';
}

const CUT_INSIDE_OUT_REASON =
  'the piece\'s faces point inward (it is inside-out), so a cut face cannot be wound to match them';

// The cut face must be exactly the section: every wall edge left open on the
// plane closed by a cap edge running the other way, and the cap's faces
// covering the section once (their total area equals the section's net area,
// so no face sits on top of another). Returns null when it holds, else a
// plain-words reason.
function cutFaceProblem(soup, axisIdx, planeVal) {
  const plane = Math.fround(planeVal);   // rawCut's output is float32
  const o1 = (axisIdx + 1) % 3, o2 = (axisIdx + 2) % 3;
  function key(o) { return soup[o] + ',' + soup[o+1] + ',' + soup[o+2]; }
  const wall = new Map(), cap = new Map();
  let capArea = 0;
  for (let t = 0; t < soup.length; t += 9) {
    const onPlane = soup[t + axisIdx] === plane && soup[t + 3 + axisIdx] === plane && soup[t + 6 + axisIdx] === plane;
    if (onPlane) {
      capArea += Math.abs((soup[t+3+o1]-soup[t+o1]) * (soup[t+6+o2]-soup[t+o2]) -
                          (soup[t+3+o2]-soup[t+o2]) * (soup[t+6+o1]-soup[t+o1])) / 2;
    }
    const into = onPlane ? cap : wall;
    for (let e = 0; e < 3; e++) {
      const a = t + e * 3, b = t + ((e + 1) % 3) * 3;
      const k = key(a) + '>' + key(b);
      into.set(k, (into.get(k) || 0) + 1);
    }
  }
  // Wall edges on the plane with no twin among the walls: the section's
  // outline, directed. Their shoelace sum is the section's net area.
  // A cap edge running the SAME way as its wall edge means the cap faces out
  // while the walls face in: the piece is inside-out (negative volume).
  let open = 0, against = 0, net = 0;
  for (let t = 0; t < soup.length; t += 9) {
    if (soup[t + axisIdx] === plane && soup[t + 3 + axisIdx] === plane && soup[t + 6 + axisIdx] === plane) continue;
    for (let e = 0; e < 3; e++) {
      const a = t + e * 3, b = t + ((e + 1) % 3) * 3;
      if (soup[a + axisIdx] !== plane || soup[b + axisIdx] !== plane) continue;
      if (wall.has(key(b) + '>' + key(a))) continue;
      if (cap.has(key(b) + '>' + key(a))) { /* closed, and the winding agrees */ }
      else if (cap.has(key(a) + '>' + key(b))) against++;
      else open++;
      net += (soup[a+o1] * soup[b+o2] - soup[b+o1] * soup[a+o2]) / 2;
    }
  }
  if (against) return CUT_INSIDE_OUT_REASON;
  if (open) return open + ' edge(s) of the cut face were left open';
  if (Math.abs(capArea - Math.abs(net)) > 1e-4 * Math.max(1, Math.abs(net))) {
    return 'the cut face came out ' + capArea.toFixed(2) + ' mm² for a section of ' +
      Math.abs(net).toFixed(2) + ' mm², so part of it would be covered twice';
  }
  return null;
}

// One side: rawCut, then the cut-face check, in the frame rawCut ran in.
function cutOneSide(soup, axisIdx, plane, keepMin) {
  let out;
  try {
    out = rawCut(soup, axisIdx, plane, keepMin);
  } catch (err) {
    throw cutRefused(cutPlainReason(err));
  }
  if (!out || out.length < 9) throw cutRefused('nothing is left on one side of the red plane');
  const problem = cutFaceProblem(out, axisIdx, plane);
  if (problem) {
    const err = cutRefused(problem);
    if (problem === CUT_INSIDE_OUT_REASON) err.insideOut = true;
    throw err;
  }
  return out;
}

function displaySoupOf(geometry) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  return new Float32Array(g.attributes.position.array);
}

function splitBothSides(model, axis, leftPlane, rightPlane) {
  const mapL = mapPlaneToRaw(model, axis, leftPlane, false);
  const mapR = mapPlaneToRaw(model, axis, rightPlane, true);
  if (mapL && mapR) {
    const rawL = cutOneSide(model.rawTris, mapL.axisIdx, mapL.plane, mapL.keepMin);
    const rawR = cutOneSide(model.rawTris, mapR.axisIdx, mapR.plane, mapR.keepMin);
    return {
      left: rawResultToDisplayGeometry(rawL, model.centerOffset),
      right: rawResultToDisplayGeometry(rawR, model.centerOffset),
      engine: 'raw',
      rawA: rawL,
      centerOffsetA: computeCenterOffsetFromRaw(rawL),
      rawB: rawR,
      centerOffsetB: computeCenterOffsetFromRaw(rawR)
    };
  }
  const axisIdx = CUT_DISPLAY_AXIS_IDX[axis];
  if (axisIdx == null) throw cutRefused('the cut axis "' + axis + '" is not X, Y or Z');
  const soup = displaySoupOf(model.geometry);
  return {
    left: cutDisplayGeometry(cutOneSide(soup, axisIdx, leftPlane, false)),
    right: cutDisplayGeometry(cutOneSide(soup, axisIdx, rightPlane, true)),
    engine: 'display'
  };
}

function cutDisplayGeometry(tris) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(tris, 3));
  g.computeVertexNormals();
  g.computeBoundingBox();
  return g;
}

// ===================== The mitred cut =====================
// The plane at the mitre is axis-aligned in the cut frame (getCutPlaneLocal),
// so the cut is #161's yaw done to a COPY: turn the piece's triangles into
// the cut frame (info.turn), cut on the axis there with the one engine, and
// turn both halves back (info.frame). The piece itself never turns - its
// halves come back in its own frame, lying exactly as it lay - and only the
// cut face is on the slant. Both halves' cut-face vertices are the same
// numbers turned back by the same matrix, so the halves still meet exactly.
//
// A raw piece turns its raw triangles about the raw point its display origin
// is (as rotateActiveModelY does): display is (x, z, -y) of raw, less
// centerOffset, so a display turn T about the origin is, on raw,
//   r' = p + Minv T M (r - p),  M (x, y, z) = (x, z, -y),  p = Minv centerOffset.
// The display origin stays where it was, so centerOffset holds for the copy.

/** A soup turned by the rotation Matrix4 `T` about the display origin. */
function cutTurnDisplaySoup(soup, T) {
  const e = T.elements, out = new Float32Array(soup.length);
  for (let i = 0; i < soup.length; i += 3) {
    const x = soup[i], y = soup[i + 1], z = soup[i + 2];
    out[i] = e[0] * x + e[4] * y + e[8] * z;
    out[i + 1] = e[1] * x + e[5] * y + e[9] * z;
    out[i + 2] = e[2] * x + e[6] * y + e[10] * z;
  }
  return out;
}

/** A raw soup turned by the display rotation `T` about the display origin. */
function cutTurnRawSoup(raw, off, T) {
  const e = T.elements, out = new Float32Array(raw.length);
  const px = off.x, py = -off.z, pz = off.y;          // the raw point the display origin is
  for (let i = 0; i < raw.length; i += 3) {
    // into display axes, about the origin: (x, z, -y)
    const dx = raw[i] - px, dy = raw[i + 2] - pz, dz = -(raw[i + 1] - py);
    const ex = e[0] * dx + e[4] * dy + e[8] * dz;
    const ey = e[1] * dx + e[5] * dy + e[9] * dz;
    const ez = e[2] * dx + e[6] * dy + e[10] * dz;
    // and back to raw: display (a, b, c) is raw (a, -c, b)
    out[i] = px + ex;
    out[i + 1] = py - ez;
    out[i + 2] = pz + ey;
  }
  return out;
}

/** Cut `model` at `info` (getCutPlaneForSplit): the clean split, square or
    mitred. Same result shape as splitBothSides. */
function cutSplitAt(model, info) {
  if (!info.turn) return splitBothSides(model, info.axis, info.plane, info.plane);
  const raw = !!(model.rawTris && model.centerOffset && model.rawAxis === 'zup');
  const copy = raw
    ? { rawTris: cutTurnRawSoup(model.rawTris, model.centerOffset, info.turn), rawAxis: 'zup',
        centerOffset: model.centerOffset, geometry: model.geometry }
    : { geometry: cutDisplayGeometry(cutTurnDisplaySoup(displaySoupOf(model.geometry), info.turn)) };
  const pair = splitBothSides(copy, info.axis, info.plane, info.plane);
  if (pair.engine === 'raw') {
    const rawA = cutTurnRawSoup(pair.rawA, model.centerOffset, info.frame);
    const rawB = cutTurnRawSoup(pair.rawB, model.centerOffset, info.frame);
    return {
      left: rawResultToDisplayGeometry(rawA, model.centerOffset),
      right: rawResultToDisplayGeometry(rawB, model.centerOffset),
      engine: 'raw', rawA: rawA, centerOffsetA: computeCenterOffsetFromRaw(rawA),
      rawB: rawB, centerOffsetB: computeCenterOffsetFromRaw(rawB)
    };
  }
  const back = g => cutDisplayGeometry(cutTurnDisplaySoup(displaySoupOf(g), info.frame));
  return { left: back(pair.left), right: back(pair.right), engine: 'display' };
}

// ===================== Cut on an inside-out piece =====================
// A piece whose faces all point inward (negative volume; USB_bit.stl is one)
// cannot be cut as it is: cutFaceProblem refuses it, since no cut face can be
// wound to match faces that point the wrong way. The refusal offers one
// button, CUT_RIGHT_SIDE_OUT_LABEL. Its click runs the same Cut on a copy of
// the piece with every triangle's vertex order reversed, and the piece the
// Cut replaces (its splitReplace source) is the original, untouched: so the
// turn and the cut are one Undo step, and that Undo puts the original back
// bit for bit. Nothing is turned without the click.
//
// Only a piece that is inside-out AS A WHOLE qualifies. Its shells (the
// separate closed surfaces in it) are judged one by one: a shell should
// enclose positive volume when it sits inside an even number of the others
// (a body) and negative when inside an odd number (a cavity). Every shell
// wrong -> turn them all. Some wrong and some right -> turning the whole
// piece would turn the right ones inside-out, so the Cut is refused and the
// wrong shells are named.
const CUT_RIGHT_SIDE_OUT_LABEL = 'Turn it right-side-out, then cut';

// The same soup with every triangle's vertex order reversed (a b c -> a c b).
// Values are moved, never recomputed, so turning twice gives the soup back
// bit for bit.
function cutReverseWinding(soup) {
  const out = new Float32Array(soup.length);
  for (let t = 0; t + 8 < soup.length; t += 9) {
    out[t] = soup[t]; out[t + 1] = soup[t + 1]; out[t + 2] = soup[t + 2];
    out[t + 3] = soup[t + 6]; out[t + 4] = soup[t + 7]; out[t + 5] = soup[t + 8];
    out[t + 6] = soup[t + 3]; out[t + 7] = soup[t + 4]; out[t + 8] = soup[t + 5];
  }
  return out;
}

// The soup's shells, in the order their first triangle appears: triangles
// joined through shared vertices, each with its signed volume, its box, how
// many other shells it sits inside, and whether it faces the wrong way.
function cutShellsOf(soup) {
  const nt = Math.floor(soup.length / 9);
  const parent = new Int32Array(nt);
  for (let i = 0; i < nt; i++) parent[i] = i;
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const seen = new Map();
  for (let t = 0; t < nt; t++) {
    for (let v = 0; v < 3; v++) {
      const o = t * 9 + v * 3;
      const k = soup[o] + ',' + soup[o + 1] + ',' + soup[o + 2];
      const u = seen.get(k);
      if (u === undefined) seen.set(k, t);
      else { const a = find(u), b = find(t); if (a !== b) parent[b] = a; }
    }
  }
  const byRoot = new Map(), shells = [];
  for (let t = 0; t < nt; t++) {
    const r = find(t);
    let s = byRoot.get(r);
    if (!s) {
      s = { tris: [], volume: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity],
            depth: 0, wrong: false };
      byRoot.set(r, s);
      shells.push(s);
    }
    s.tris.push(t);
  }
  for (const s of shells) {
    // About the shell's first vertex, so a piece far from the origin does not
    // lose its volume to cancellation.
    const o0 = s.tris[0] * 9, rx = soup[o0], ry = soup[o0 + 1], rz = soup[o0 + 2];
    let v6 = 0;
    for (const t of s.tris) {
      const o = t * 9;
      for (let v = 0; v < 9; v += 3) {
        for (let a = 0; a < 3; a++) {
          const c = soup[o + v + a];
          if (c < s.min[a]) s.min[a] = c;
          if (c > s.max[a]) s.max[a] = c;
        }
      }
      const ax = soup[o] - rx, ay = soup[o + 1] - ry, az = soup[o + 2] - rz;
      const bx = soup[o + 3] - rx, by = soup[o + 4] - ry, bz = soup[o + 5] - rz;
      const cx = soup[o + 6] - rx, cy = soup[o + 7] - ry, cz = soup[o + 8] - rz;
      v6 += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    }
    s.volume = v6 / 6;
  }
  // Is point p inside shell s? Crossings of a ray, counted on three skew
  // directions and taken by majority, so a ray that grazes an edge is
  // outvoted rather than trusted.
  const DIRS = [[0.5299, 0.6831, 0.5028], [-0.6113, 0.3917, 0.6877], [0.2741, -0.8423, 0.4641]];
  function inside(p, s) {
    for (let a = 0; a < 3; a++) if (p[a] < s.min[a] || p[a] > s.max[a]) return false;
    let votes = 0;
    for (const d of DIRS) {
      let hits = 0;
      for (const t of s.tris) {
        const o = t * 9;
        const e1x = soup[o + 3] - soup[o], e1y = soup[o + 4] - soup[o + 1], e1z = soup[o + 5] - soup[o + 2];
        const e2x = soup[o + 6] - soup[o], e2y = soup[o + 7] - soup[o + 1], e2z = soup[o + 8] - soup[o + 2];
        const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12) continue;
        const tx = p[0] - soup[o], ty = p[1] - soup[o + 1], tz = p[2] - soup[o + 2];
        const u = (tx * px + ty * py + tz * pz) / det;
        if (u < 0 || u > 1) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const w = (d[0] * qx + d[1] * qy + d[2] * qz) / det;
        if (w < 0 || u + w > 1) continue;
        if ((e2x * qx + e2y * qy + e2z * qz) / det > 1e-9) hits++;
      }
      if (hits & 1) votes++;
    }
    return votes >= 2;
  }
  for (const s of shells) {
    const o = s.tris[0] * 9, p = [soup[o], soup[o + 1], soup[o + 2]];
    for (const other of shells) if (other !== s && inside(p, other)) s.depth++;
    const span = Math.max(s.max[0] - s.min[0], s.max[1] - s.min[1], s.max[2] - s.min[2]);
    const flat = !(Math.abs(s.volume) > 1e-9 * span * span * span);   // open or flat: no side to face
    s.wrong = !flat && (s.depth % 2 === 0 ? s.volume < 0 : s.volume > 0);
  }
  return shells;
}

// The soup a Cut on this model runs on: the raw one when splitBothSides takes
// the raw route, else the display mesh. sizeOrder maps that soup's axes to
// display X, Y (up), Z, for naming a shell by its size.
function cutSoupOf(model) {
  if (model.rawTris && model.centerOffset && model.rawAxis === 'zup') {
    return { soup: model.rawTris, sizeOrder: [0, 2, 1] };
  }
  return { soup: displaySoupOf(model.geometry), sizeOrder: [0, 1, 2] };
}

// { whole, shells, wrong, sizeOrder }: whole is true when every shell faces
// the wrong way, i.e. reversing every triangle puts the piece right.
function cutInsideOutVerdict(model) {
  const src = cutSoupOf(model);
  const shells = cutShellsOf(src.soup);
  const wrong = [];
  shells.forEach((s, i) => { if (s.wrong) wrong.push(i); });
  return { whole: shells.length > 0 && wrong.length === shells.length, shells, wrong, sizeOrder: src.sizeOrder };
}

// "shell 2 of 2 (12 triangles, 20.0 x 10.0 x 6.0 mm) is inside-out, while
// shell 1 is not" - which shells, in words a person can find on the piece.
// Shells are numbered in the order the file lists them; sizes are display
// X x Y (up) x Z.
function cutPartlyInsideOutReason(v) {
  const n = v.shells.length;
  const and = (xs) => xs.length < 2 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1];
  const desc = v.wrong.map(i => {
    const s = v.shells[i];
    const dims = v.sizeOrder.map(a => (s.max[a] - s.min[a]).toFixed(1)).join(' x ');
    return 'shell ' + (i + 1) + ' of ' + n + ' (' + s.tris.length + ' triangles, ' + dims + ' mm)';
  });
  const right = [];
  for (let i = 0; i < n; i++) if (v.wrong.indexOf(i) < 0) right.push(i + 1);
  const others = (right.length === 1 ? 'shell ' : 'shells ') + and(right.map(String));
  return 'the piece is only partly inside-out: ' + and(desc) + (v.wrong.length === 1 ? ' is' : ' are') +
    ' inside-out, while ' + others + (right.length === 1 ? ' is' : ' are') + ' not, so turning the whole piece' +
    ' would turn ' + others + ' inside-out instead; nothing was turned';
}

// A copy of the model, every triangle reversed, for splitBothSides to cut.
// The model itself is not touched.
function cutRightSideOutCopy(model) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(cutReverseWinding(displaySoupOf(model.geometry)), 3));
  g.computeVertexNormals();
  g.computeBoundingBox();
  return {
    id: model.id, name: model.name, size: model.size, geometry: g,
    rawTris: model.rawTris ? cutReverseWinding(model.rawTris) : null,
    rawAxis: model.rawAxis || null,
    centerOffset: model.centerOffset || null
  };
}

// The offer: one button in the status line and the same one in the Cut panel,
// both for the piece that was refused (state.cutRightSideOutOffer.id).
function cutOfferRightSideOut(model, message) {
  state.cutRightSideOutOffer = { id: model.id };
  setStatus(message, true);
  const el = document.getElementById('status');
  if (el && typeof el.appendChild === 'function') {
    el.appendChild(document.createTextNode(' '));
    const b = document.createElement('button');
    b.type = 'button';
    b.id = 'status-cut-right-side-out';
    b.className = 'btn btn-secondary status-action';
    b.textContent = CUT_RIGHT_SIDE_OUT_LABEL;
    b.addEventListener('click', cutRightSideOutClicked);
    el.appendChild(b);
  }
  syncCutRightSideOutButton();
}

function cutClearRightSideOutOffer() {
  state.cutRightSideOutOffer = null;
  syncCutRightSideOutButton();
}

function syncCutRightSideOutButton() {
  const b = document.getElementById('btn-cut-right-side-out');
  if (!b) return;
  const offer = state.cutRightSideOutOffer, m = getActiveModel();
  b.hidden = !(offer && state.cutterOpen && m && m.id === offer.id);
}

function cutRightSideOutClicked() {
  cutActiveModel({ rightSideOut: true });
}

// Compute a half's centerOffset directly from its own raw bounding box,
// without an actual rotate step. handleFiles measures centerOffset AFTER
// rotateX(-PI/2) - i.e. in (x, z, -y) space. rotateX(-90deg) maps
// (x,y,z) -> (x, z, -y), so that same value is just {x: cx, y: cz, z: -cy}
// computed straight from the raw (x,y,z) bounding box. No second mapping.
function computeCenterOffsetFromRaw(rawFlat) {
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity,minZ=Infinity,maxZ=-Infinity;
  for (let i=0;i<rawFlat.length;i+=3){
    const x=rawFlat[i], y=rawFlat[i+1], z=rawFlat[i+2];
    if(x<minX)minX=x; if(x>maxX)maxX=x;
    if(y<minY)minY=y; if(y>maxY)maxY=y;
    if(z<minZ)minZ=z; if(z>maxZ)maxZ=z;
  }
  const cx=(minX+maxX)/2, cy=(minY+maxY)/2, cz=(minZ+maxZ)/2;
  return { x: cx, y: cz, z: -cy };
}


// ===================== Raw-Mesh Fillet Post-Pass (Soft finish only) =====================
// Runs AFTER rawCut has already produced a sealed, flat-capped half — that
// flat result is the permanent safety net and is always computed first.
// This is an OPTIONAL alternate result: same corner-sphere-solved,
// margin-retraction fillet architecture validated earlier against real
// factory-part geometry, ported here as a small, self-contained addition.
// Small requested radius (0.4-0.6mm default) makes self-intersection rare
// by construction rather than requiring repair logic. Reuses the existing
// raw clip/loop/earclip functions — no duplicate boundary math.

function rawEdgeInwardNormal2(p1, p2) {
  const dx = p2[0]-p1[0], dy = p2[1]-p1[1];
  const len = Math.hypot(dx, dy) || 1e-12;
  return [-dy/len, dx/len];
}
function rawTurningAngle2(loop2, i) {
  const n = loop2.length;
  const prev = loop2[(i-1+n)%n], curr = loop2[i], next = loop2[(i+1)%n];
  const a1 = Math.atan2(curr[1]-prev[1], curr[0]-prev[0]);
  const a2 = Math.atan2(next[1]-curr[1], next[0]-curr[0]);
  let d = a2 - a1;
  while (d > Math.PI) d -= 2*Math.PI;
  while (d < -Math.PI) d += 2*Math.PI;
  return d;
}
function rawSolveCornerCenter2(cornerPt, n1, n2, R) {
  const det = n1[0]*n2[1] - n1[1]*n2[0];
  if (Math.abs(det) < 1e-10) return null;
  const nx = (n2[1]-n1[1])/det, ny = (n1[0]-n2[0])/det;
  return [cornerPt[0]+R*nx, cornerPt[1]+R*ny];
}
function rawSlerp2D2(a, b, t) {
  const dot = Math.max(-1, Math.min(1, a[0]*b[0]+a[1]*b[1]));
  const theta = Math.acos(dot);
  if (theta < 1e-8) return a.slice();
  const s = Math.sin(theta);
  const wa = Math.sin((1-t)*theta)/s, wb = Math.sin(t*theta)/s;
  return [wa*a[0]+wb*b[0], wa*a[1]+wb*b[1]];
}
function rawSmoothstep2(x) { x = Math.max(0, Math.min(1, x)); return x*x*(3-2*x); }

// Local wall thickness at loop point i: the canonical loop probe, BAND rule
// (nso_thickness.js). Was an inline bisector ray plus a nearest-point safety
// net — the ray looks along ONE direction and can miss a genuinely close point
// that is not roughly in that direction (confirmed directly: two boundary
// points 0.52 mm apart where the ray reported no nearby wall at all), so both
// signals are taken and the tighter one wins. That is unchanged; what moved is
// WHERE it lives, so the six copies of this measurement across app-cut.js and
// app-finish.js are now one function with one floor.
//
// The historical `4` for "found nothing" is kept verbatim as
// NSO_Thickness.LEGACY_FALLBACK_MM so no geometry moves. Note it is a CAP
// here, not a fallback: BAND computes min(ray ?? 4, nearest ?? 4), so a miss
// on the ray pins this to 4 mm however much wall is really there. Callers that
// need to tell a measured 4 from a guessed one read `.measured`.
function rawLocalThickness2(loop2, i) {
  return NSO_Thickness.bandWall(loop2, i).mm;
}

function rawRingSelfIntersects2(ring) {
  function segX(p1,p2,p3,p4) {
    const d1x=p2[0]-p1[0], d1y=p2[1]-p1[1], d2x=p4[0]-p3[0], d2y=p4[1]-p3[1];
    const denom = d1x*d2y - d1y*d2x;
    if (Math.abs(denom) < 1e-12) return false;
    const t = ((p3[0]-p1[0])*d2y - (p3[1]-p1[1])*d2x)/denom;
    const u = ((p3[0]-p1[0])*d1y - (p3[1]-p1[1])*d1x)/denom;
    return t > 1e-6 && t < 1-1e-6 && u > 1e-6 && u < 1-1e-6;
  }
  const m = ring.length;
  for (let i = 0; i < m; i++) {
    const a = ring[i], b = ring[(i+1)%m];
    for (let j = i+2; j < m; j++) {
      if (i === 0 && j === m-1) continue;
      if ((j+1)%m === i) continue;
      if (segX(a, b, ring[j], ring[(j+1)%m])) return true;
    }
  }
  return false;
}

// Rotate loopB's array so its index 0 is the point nearest loopA's index 0
// — buildLoopsFromCutEdges' walk can start at a different physical point
// for two separate clips (order depends on Map insertion order, which
// differs between planes), so raw index correspondence between two
// same-length loops is NOT guaranteed aligned. Confirmed directly: two
// loops of identical length had corresponding indices up to 10mm apart in
// space before this fix, versus an expected ~0.5mm.
function rawAlignLoopStart2(loopA, loopB) {
  let bestJ = 0, bestD = Infinity;
  for (let j = 0; j < loopB.length; j++) {
    const d = Math.hypot(loopB[j][0]-loopA[0][0], loopB[j][1]-loopA[0][1]);
    if (d < bestD) { bestD = d; bestJ = j; }
  }
  let rotated = bestJ === 0 ? loopB : loopB.slice(bestJ).concat(loopB.slice(0, bestJ));

  // marginLoop2d and ring0 are walked independently (different clip
  // plane) — nothing guarantees they run the same rotational direction.
  // If rotated[] runs opposite loopA near the aligned start, the
  // arc-length zipper tears open as it moves away from that point.
  // Compare first-edge direction; flip if opposed, keeping index 0 fixed.
  if (loopA.length >= 2 && rotated.length >= 2) {
    const aDx = loopA[1][0]-loopA[0][0], aDy = loopA[1][1]-loopA[0][1];
    const bDx = rotated[1][0]-rotated[0][0], bDy = rotated[1][1]-rotated[0][1];
    if (aDx*bDx + aDy*bDy < 0) {
      rotated = [rotated[0]].concat(rotated.slice(1).reverse());
    }
  }
  return rotated;
}

function rawBuildStitchStrip2(loopA, loopBIn) {
  const loopB = rawAlignLoopStart2(loopA, loopBIn);
  const nA = loopA.length, nB = loopB.length;
  if (nA === nB) {
    const n = nA;
    const strip = [];
    for (let i = 0; i < n; i++) {
      const i1 = (i + 1) % n;
      strip.push([loopA[i], loopA[i1], loopB[i1]]);
      strip.push([loopA[i], loopB[i1], loopB[i]]);
    }
    return strip;
  }
  function cumlen(poly) {
    const n = poly.length; let total = 0; const t = [0];
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      total += Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (i < n - 1) t.push(total);
    }
    return { t, total };
  }
  const A = loopA, B = loopB;
  const nAedges = A.length, nBedges = B.length;
  const { t: tA, total: totalA } = cumlen(A);
  const { t: tBraw, total: totalB } = cumlen(B);
  const tB = tBraw.map(v => v * (totalA / Math.max(totalB, 1e-9)));
  const strip = [];
  let i = 0, j = 0;
  let stepsA = 0, stepsB = 0;
  const guardMax = (nAedges + nBedges) * 2 + 64;
  let guard = 0;
  while ((stepsA < nAedges || stepsB < nBedges) && guard++ < guardMax) {
    const iDone = stepsA >= nAedges;
    const jDone = stepsB >= nBedges;
    if (iDone && jDone) break;
    const iNext = (i + 1) % nAedges;
    const jNext = (j + 1) % nBedges;
    const tiNext = iDone ? Infinity : (iNext === 0 ? totalA : tA[iNext]);
    const tjNext = jDone ? Infinity : (jNext === 0 ? totalA : tB[jNext]);
    const advanceA = iDone ? false : (jDone ? true : tiNext <= tjNext);
    if (advanceA) {
      strip.push([A[i], A[iNext], B[j]]);
      i = iNext; stepsA++;
    } else {
      strip.push([A[i], B[jNext], B[j]]);
      j = jNext; stepsB++;
    }
  }
  return strip;
}

function raw2DWeldLoop(poly2d, tol) {
  const snapped = poly2d.map(p => p.slice());
  for (let i = 0; i < snapped.length; i++) {
    for (let j = 0; j < i; j++) {
      const dx = snapped[i][0]-snapped[j][0], dy = snapped[i][1]-snapped[j][1];
      if (Math.hypot(dx, dy) < tol) { snapped[i][0] = snapped[j][0]; snapped[i][1] = snapped[j][1]; break; }
    }
  }
  const out = [];
  for (let i = 0; i < snapped.length; i++) {
    const p = snapped[i];
    const prev = out[out.length-1];
    if (prev && Math.hypot(p[0]-prev[0], p[1]-prev[1]) < 1e-9) continue;
    out.push(p);
  }
  while (out.length > 2 && Math.hypot(out[0][0]-out[out.length-1][0], out[0][1]-out[out.length-1][1]) < 1e-9) {
    out.pop();
  }
  return out;
}

function simplifyCollinear2D(loop, eps) {
  eps = (eps == null) ? 1e-3 : eps;
  const n = loop.length;
  if (n <= 3) return loop;
  const out = [];
  for (let i = 0; i < n; i++) {
    const prev = loop[(i - 1 + n) % n], curr = loop[i], next = loop[(i + 1) % n];
    const ux = curr[0]-prev[0], uy = curr[1]-prev[1];
    const vx = next[0]-curr[0], vy = next[1]-curr[1];
    const ul = Math.hypot(ux,uy) || 1e-9, vl = Math.hypot(vx,vy) || 1e-9;
    const cross = (ux/ul)*(vy/vl) - (uy/ul)*(vx/vl);
    if (Math.abs(cross) > eps) out.push(curr);
  }
  return out.length >= 3 ? out : loop;
}

function matchToRing0(marginLoop, ring0) {
  return ring0.map(rp => {
    let best = marginLoop[0], bestD = Infinity;
    for (const mp of marginLoop) {
      const d = Math.hypot(mp[0] - rp[0], mp[1] - rp[1]);
      if (d < bestD) { bestD = d; best = mp; }
    }
    return best;
  });
}

// Corner filter for the shared soften engine (Corners treatment).
//
// Finds the loop vertices that are genuine corners and hands back a
// radius PER VERTEX that is full at the corner and zero everywhere else,
// so the engine rounds the corner and leaves the straight runs as an
// untouched sharp cap/wall edge.
//
// Turn angle is measured across a window of ARC LENGTH, not against the
// immediate neighbours: a 90deg corner then reads ~90deg no matter how
// finely the wall happens to be tessellated, and a gently curved end
// reads small instead of being chopped into a ring of fake corners.
//
// A pair of R=0 transition points is inserted at +/- the blend distance
// around each corner, so the taper always dies out within ~2R of the
// corner even when a long wall carries no intermediate vertices at all.
function rawCornerRadiiOnLoop2(loop2, requestedR, minTurn) {
  const n = loop2.length;
  if (n < 3) throw new Error('cap boundary too small for corners');

  const seg = new Array(n), cum = new Array(n + 1);
  cum[0] = 0;
  for (let i = 0; i < n; i++) {
    const a = loop2[i], b = loop2[(i + 1) % n];
    seg[i] = Math.hypot(b[0] - a[0], b[1] - a[1]);
    cum[i + 1] = cum[i] + seg[i];
  }
  const total = cum[n];
  if (!(total > 1e-6)) throw new Error('cap boundary has no length');

  const pointAtArc = (s) => {
    let x = s % total; if (x < 0) x += total;
    let lo = 0, hi = n;
    while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (cum[mid] <= x) lo = mid; else hi = mid; }
    const t = seg[lo] > 1e-12 ? (x - cum[lo]) / seg[lo] : 0;
    const a = loop2[lo], b = loop2[(lo + 1) % n];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };

  // Wide enough to read a corner across the tessellation, never so wide
  // that it reaches past the next feature. Unbounded, a large R makes the
  // window span whole edges, every mid-edge vertex reads as a turn, and all
  // four corners of a square merge into one group - one corner treated,
  // three left sharp.
  const win = Math.max(total / 200, 0.25, Math.min(requestedR * 1.5, total / 16));
  const turn = new Array(n);
  for (let i = 0; i < n; i++) {
    const back = pointAtArc(cum[i] - win);
    const fwd = pointAtArc(cum[i] + win);
    const a1 = Math.atan2(loop2[i][1] - back[1], loop2[i][0] - back[0]);
    const a2 = Math.atan2(fwd[1] - loop2[i][1], fwd[0] - loop2[i][0]);
    let d = a2 - a1;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    turn[i] = d;
  }

  const hotIdx = [];
  for (let i = 0; i < n; i++) if (Math.abs(turn[i]) > minTurn) hotIdx.push(i);
  if (!hotIdx.length) throw new Error('no corners over ' + Math.round(minTurn * 180 / Math.PI) + 'deg on this edge');

  // Group by ARC distance, not by index adjacency: hot vertices within one
  // detection window of each other are one physical corner smeared across
  // that window, and the sharpest of them is its apex. Vertices further
  // apart than the window are separate corners — a plain 4-vertex
  // rectangle is four hot vertices and must stay four corners, which
  // index-adjacency grouping would have collapsed into one.
  const groups = [];
  let cur = [hotIdx[0]];
  for (let q = 1; q < hotIdx.length; q++) {
    if (cum[hotIdx[q]] - cum[hotIdx[q - 1]] <= win) cur.push(hotIdx[q]);
    else { groups.push(cur); cur = [hotIdx[q]]; }
  }
  groups.push(cur);
  if (groups.length > 1) {
    const first = groups[0], last = groups[groups.length - 1];
    if (total - cum[last[last.length - 1]] + cum[first[0]] <= win) {
      groups[0] = last.concat(first);
      groups.pop();
    }
  }
  const apex = groups.map(g => g.reduce((best, i) => Math.abs(turn[i]) > Math.abs(turn[best]) ? i : best, g[0]));

  const A = apex.length;
  // rawCornerWallLimit2, not rawLocalThickness2: the latter skips every
  // segment within two indices of the vertex, so on a 4-vertex loop - the
  // plain Square-split case - it skips the whole loop and falls back to its
  // 4mm default, pinning every corner at R=1.8 whatever R was asked.
  const apexR = apex.map(i => Math.min(requestedR, Math.max(0, rawCornerWallLimit2(loop2, i) * 0.45)));
  const gapFwd = (t) => {
    if (A === 1) return total;
    let g = cum[apex[(t + 1) % A]] - cum[apex[t]];
    if (g <= 0) g += total;
    return g;
  };
  // Blend never eats more than 45% of the run to either neighbour, so two
  // close corners taper out cleanly instead of fighting over the wall.
  const blend = apex.map((a, t) => Math.max(0, Math.min(apexR[t] * 2, gapFwd((t - 1 + A) % A) * 0.45, gapFwd(t) * 0.45)));

  const circDist = (s1, s2) => { const d = Math.abs(s1 - s2) % total; return Math.min(d, total - d); };
  const radiusAt = (s) => {
    let r = 0;
    for (let t = 0; t < A; t++) {
      if (!(blend[t] > 1e-9)) continue;
      const d = circDist(s, cum[apex[t]]);
      if (d >= blend[t]) continue;
      const v = apexR[t] * (1 - d / blend[t]);
      if (v > r) r = v;
    }
    return r;
  };

  const samples = [];
  for (let i = 0; i < n; i++) samples.push({ s: cum[i], uv: loop2[i] });
  for (let t = 0; t < A; t++) {
    if (!(blend[t] > 1e-9)) continue;
    const sa = cum[apex[t]];
    for (const raw of [sa - blend[t], sa + blend[t]]) {
      let x = raw % total; if (x < 0) x += total;
      samples.push({ s: x, uv: pointAtArc(x) });
    }
  }
  samples.sort((p, q) => p.s - q.s);

  const outLoop = [], outR = [];
  for (const smp of samples) {
    const prev = outLoop[outLoop.length - 1];
    if (prev && Math.hypot(smp.uv[0] - prev[0], smp.uv[1] - prev[1]) < 1e-6) continue;
    outLoop.push([smp.uv[0], smp.uv[1]]);
    outR.push(radiusAt(smp.s));
  }
  while (outLoop.length > 3 &&
         Math.hypot(outLoop[0][0] - outLoop[outLoop.length - 1][0], outLoop[0][1] - outLoop[outLoop.length - 1][1]) < 1e-6) {
    outLoop.pop(); outR.pop();
  }
  if (outLoop.length < 3) throw new Error('corner loop too small after build');
  let maxR = 0;
  for (const r of outR) if (r > maxR) maxR = r;
  if (maxR < 0.02) throw new Error('no safe radius at any corner');
  return { loop: outLoop, radii: outR };
}

// Cap-face extraction shared by every soften path. Reads the true cap plane
// off the mesh itself (never the EPS-nudged `plane` arg), sorts triangles
// into cap and wall, and chains the cap/wall boundary into one ordered loop.
// Lifted out of rawEdgeRoundInPlace unchanged so the Corners path can walk
// the same boundary instead of carrying a second loop walker.
function rawCapFaceContext(rawTris, axisIdx, keepMin) {
  const tol = 1e-4;
  // true cap plane, derived from the mesh itself — ignores the EPS-nudged `plane` arg
  let minV = Infinity, maxV = -Infinity;
  for (let i = axisIdx; i < rawTris.length; i += 3) {
    if (rawTris[i] < minV) minV = rawTris[i];
    if (rawTris[i] > maxV) maxV = rawTris[i];
  }
  const capPlane = keepMin ? minV : maxV;
  const capTol = 1e-3;

  const triCount = rawTris.length / 9;
  const vert = (t, v) => { const i0 = t*9 + v*3; return [rawTris[i0], rawTris[i0+1], rawTris[i0+2]]; };
  const isOnCap = (p) => Math.abs(p[axisIdx] - capPlane) < capTol;

  const capTriIdx = [], wallTriIdx = [];
  for (let t = 0; t < triCount; t++) {
    const v0=vert(t,0), v1=vert(t,1), v2=vert(t,2);
    if (isOnCap(v0) && isOnCap(v1) && isOnCap(v2)) capTriIdx.push(t);
    else wallTriIdx.push(t);
  }
  if (!capTriIdx.length) throw new Error('no cap found on this face');

  // boundary edges: shared by exactly one cap triangle and one wall triangle
  const vkey = (p) => Math.round(p[0]/tol)+'|'+Math.round(p[1]/tol)+'|'+Math.round(p[2]/tol);
  const edgeMap = new Map();
  const addEdge = (a, b, isCap) => {
    const ka = vkey(a), kb = vkey(b);
    const ek = ka < kb ? ka+'~'+kb : kb+'~'+ka;
    if (!edgeMap.has(ek)) edgeMap.set(ek, []);
    edgeMap.get(ek).push({ isCap, a, b });
  };
  for (const t of capTriIdx) {
    const v0=vert(t,0), v1=vert(t,1), v2=vert(t,2);
    addEdge(v0,v1,true); addEdge(v1,v2,true); addEdge(v2,v0,true);
  }
  for (const t of wallTriIdx) {
    const v0=vert(t,0), v1=vert(t,1), v2=vert(t,2);
    if (isOnCap(v0) && isOnCap(v1)) addEdge(v0,v1,false);
    if (isOnCap(v1) && isOnCap(v2)) addEdge(v1,v2,false);
    if (isOnCap(v2) && isOnCap(v0)) addEdge(v2,v0,false);
  }
  const boundaryEdges = [];
  for (const entries of edgeMap.values()) {
    if (entries.length === 2 && entries.some(e=>e.isCap) && entries.some(e=>!e.isCap)) {
      const capEntry = entries.find(e => e.isCap);
      boundaryEdges.push([capEntry.a, capEntry.b]);
    }
  }
  if (!boundaryEdges.length) throw new Error('no cap/wall boundary found');

  // chain into ordered loops - EVERY loop the face has, not just the first.
  // A face with a hole (a tube end, a washer, a bored plate) has one outer
  // loop and one loop per hole; walking only the first one is what made Soften
  // refuse every such face at any R.
  const adj = new Map(), posOf = new Map();
  const pushAdj = (k, o) => { if (!adj.has(k)) adj.set(k, []); adj.get(k).push(o); };
  for (const [a,b] of boundaryEdges) {
    const ka = vkey(a), kb = vkey(b);
    posOf.set(ka,a); posOf.set(kb,b);
    pushAdj(ka,kb); pushAdj(kb,ka);
  }
  for (const list of adj.values()) if (list.length !== 2) throw new Error('branch point in cap boundary');
  // Each walk leaves its start along that edge's own cap-triangle direction,
  // so every loop runs with the lid on the same side of it - which is what
  // keeps the band wound the same way round a hole as round the outer edge.
  // For the first loop this is exactly the walk this function always did.
  const seen = new Set(), walked = [];
  for (const [a, b] of boundaryEdges) {
    const startKey = vkey(a);
    if (seen.has(startKey)) continue;
    const loopKeys = [startKey];
    seen.add(startKey);
    let prevKey = startKey, curKey = vkey(b);
    while (curKey !== startKey) {
      loopKeys.push(curKey);
      seen.add(curKey);
      if (loopKeys.length > adj.size + 2) throw new Error('cap boundary did not close');
      const nbrs = adj.get(curKey);
      const nextKey = nbrs[0] === prevKey ? nbrs[1] : nbrs[0];
      prevKey = curKey; curKey = nextKey;
    }
    walked.push(loopKeys.map(k => posOf.get(k)));
  }
  // Outer edge or hole: a loop is a hole when an odd number of the face's
  // other loops enclose it. Outer loops come first, largest first, so
  // loops[0] is the face's own outline and a one-loop face is unchanged.
  const other = [0, 1, 2].filter(a => a !== axisIdx);
  const flat = (L) => L.map(p => [p[other[0]], p[other[1]]]);
  const flats = walked.map(flat);
  const area = flats.map(rawSignedArea2);
  const loops = walked.map((pts, i) => {
    let enclosed = 0;
    for (let j = 0; j < flats.length; j++) {
      if (j !== i && rawPointInPoly2(flats[i][0], flats[j])) enclosed++;
    }
    return { pts, hole: (enclosed % 2) === 1, area: Math.abs(area[i]), at: i };
  });
  loops.sort((p, q) => (p.hole - q.hole) || (q.area - p.area) || (p.at - q.at));
  if (loops[0].hole) throw new Error('cap boundary has no outer loop');
  const loop3d = loops[0].pts;
  if (loop3d.length < 3) throw new Error('cap boundary too small to round');
  return { capPlane, capTol, tol, triCount, vert, isOnCap, capTriIdx, wallTriIdx, loop3d,
           loops: loops.map(L => ({ pts: L.pts, hole: L.hole })) };
}

function rawSignedArea2(poly) {
  let a2 = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a2 += p[0] * q[1] - q[0] * p[1];
  }
  return a2 * 0.5;
}

function rawPointInPoly2(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > pt[1]) !== (b[1] > pt[1]) &&
        pt[0] < (b[0] - a[0]) * (pt[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function rawIsConvexPoly2(poly) {
  const n = poly.length;
  if (n < 3) return false;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n], c = poly[(i + 2) % n];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cr) < 1e-12) continue;
    const sg = cr > 0 ? 1 : -1;
    if (sign === 0) sign = sg;
    else if (sg !== sign) return false;
  }
  return sign !== 0;
}

// ===================== the shared cap-plane rebuild =====================
//
// Both cap-plane engines - the perimeter fillet behind Round and Bevel
// (rawPerimeterFilletInPlace, app-finish.js) and the corner round below
// (rawEdgeRoundInPlace) - build their own rings and hand them here. The lid
// trim, the lid check, the T-junction repair, the depth-only wall and the
// band used to be two copies of the same block, one per engine, and both
// copies only ever knew one boundary loop. They are this one now, and it
// takes every loop the face has.
//
// A loop entry is
//   pts    the loop as rawCapFaceContext walked it (3D)
//   poly   the welded 2D loop the rings were built on
//   Rs     R at each poly point (0 = this point stays a sharp edge)
//   rings  STEPS+1 rows of 3D points, row 0 down on the wall, the last row
//          on the lid plane, one point per poly point
//   hole   true for a hole loop
// An outer loop's rings inset into the face; a hole's grow out from the hole,
// into the same material - so a tube end gets its outer edge and its bore
// edge treated alike, by the same R.

// Every pair of loops that face each other across material - an outer edge
// and a hole, or two holes - eats R into the strip between them from both
// sides, so the strip has to be wider than both rounds. Throws with the strip
// and the R it allows when it is not. Two outer loops (islands of one face)
// inset away from each other and are never a pair.
function rawSoftenLoopRoom(loops, requestedR) {
  // Everything is measured at R AS ASKED, not as clamped: an outline's own
  // per-point clamp is about the outline's shape, while the strip between two
  // loops is a refusal, never a quiet clamp. A point's offset is scaled from
  // the R its ring was built with to the R asked for; a point at R 0 is a
  // sharp edge and reaches nowhere.
  const scaleAt = (L, i) => (L.Rs[i] > 0 ? requestedR / L.Rs[i] : 0);
  for (const L of loops) {
    const top = L.rings[L.rings.length - 1], n = L.poly.length;
    // How far each point's round reaches across the face (a mitred corner
    // reaches further than R)...
    L.reachPt = L.poly.map((p, i) => Math.hypot(top[i][L.u] - p[0], top[i][L.v] - p[1]) * scaleAt(L, i));
    // ...and how deep each segment's band runs square to the segment, at
    // either end. A straight edge between two mitred corners is R deep all
    // the way along, not as deep as the mitres.
    L.depthSeg = [];
    for (let j = 0; j < n; j++) {
      const a = L.poly[j], b = L.poly[(j+1)%n];
      const ex = b[0]-a[0], ey = b[1]-a[1], len = Math.hypot(ex, ey) || 1e-12;
      const perp = (k) => Math.abs(((top[k][L.u] - a[0]) * ey - (top[k][L.v] - a[1]) * ex) / len) * scaleAt(L, k);
      L.depthSeg.push([perp(j), perp((j+1)%n)]);
    }
  }
  // Each point of P against the nearest segment of Q: the two rounds meet
  // there when P's reach and Q's band depth add up to the gap.
  const scan = (P, Q, best) => {
    const m = Q.poly.length;
    for (let i = 0; i < P.poly.length; i++) {
      const p = P.poly[i];
      let d = Infinity, depth = 0;
      for (let j = 0; j < m; j++) {
        const a = Q.poly[j], b = Q.poly[(j+1)%m];
        const ex = b[0]-a[0], ey = b[1]-a[1], len2 = ex*ex + ey*ey;
        let u = len2 > 1e-18 ? ((p[0]-a[0])*ex + (p[1]-a[1])*ey) / len2 : 0;
        u = Math.max(0, Math.min(1, u));
        const t = Math.hypot(p[0] - (a[0] + ex*u), p[1] - (a[1] + ey*u));
        if (t < d) { d = t; depth = Q.depthSeg[j][0] + (Q.depthSeg[j][1] - Q.depthSeg[j][0]) * u; }
      }
      if (P.hole && d > best.dMax) best.dMax = d;
      if (P.hole && d < best.dMin) best.dMin = d;
      const s = P.reachPt[i] + depth;
      if (s > 1e-12 && d / s < best.ratio) { best.ratio = d / s; best.d = d; }
    }
  };
  const mm = (d) => (d >= 1 ? d.toFixed(1) : d.toFixed(2));
  const under = rawSoftenUnder;
  for (let i = 0; i < loops.length; i++) {
    for (let j = i + 1; j < loops.length; j++) {
      const A = loops[i], B = loops[j];
      if (!A.hole && !B.hole) continue;
      const best = { ratio: Infinity, d: Infinity, dMin: Infinity, dMax: 0 };
      scan(A, B, best);
      scan(B, A, best);
      if (best.ratio > 1 + 1e-9) continue;
      // Both rounds scale with R, so the R at which they just touch is the
      // asked R times the ratio of the gap to what they reach into it.
      const lim = requestedR * best.ratio;
      if (A.hole && B.hole) {
        throw new Error('two holes on this face are ' + mm(best.d) + ' mm apart, too close for R=' +
                        requestedR + '; R must be under ' + under(lim) + ' - left unchanged');
      }
      // A hole that sits the same distance from the outline all the way
      // round is a tube's or a washer's wall; anything else is a hole that
      // comes close to the edge at one place.
      if (best.dMax <= 1.5 * best.dMin) {
        throw new Error('the wall here is ' + mm(best.dMin) + ' mm; R must be under ' + under(lim) +
                        ' - left unchanged');
      }
      throw new Error('this face\'s hole is too close to its edge for R=' + requestedR + ' - ' +
                      mm(best.d) + ' mm of material there; R must be under ' + under(lim) +
                      ' - left unchanged');
    }
  }
}

// Take one loop's band [poly[i], poly[i+1], ring[i+1], ring[i]] off the lid,
// quad by quad. Loop-agnostic: an outer loop's quads lie inside its edge, a
// hole's lie around it, and either way what is left is the lid that rings
// the treated edge. Pieces the band does not reach come through untouched.
function rawLidSubtractBand2(pieces, poly, ring, limit) {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const i1 = (i+1)%n;
    const q = [poly[i], poly[i1], ring[i1], ring[i]];
    if (rawPolyArea2(q) < 1e-12) continue;
    let bx0=Infinity, by0=Infinity, bx1=-Infinity, by1=-Infinity;
    for (const v of q) {
      if (v[0] < bx0) bx0 = v[0];
      if (v[0] > bx1) bx1 = v[0];
      if (v[1] < by0) by0 = v[1];
      if (v[1] > by1) by1 = v[1];
    }
    const cen = [0, 0];
    for (const v of q) { cen[0] += v[0]/q.length; cen[1] += v[1]/q.length; }
    const next = [];
    for (const p of pieces) {
      let px0=Infinity, py0=Infinity, px1=-Infinity, py1=-Infinity;
      for (const v of p) {
        if (v[0] < px0) px0 = v[0];
        if (v[0] > px1) px1 = v[0];
        if (v[1] < py0) py0 = v[1];
        if (v[1] > py1) py1 = v[1];
      }
      if (px1 < bx0-1e-9 || px0 > bx1+1e-9 || py1 < by0-1e-9 || py0 > by1+1e-9) { next.push(p); continue; }
      let inside = p;
      for (let e = 0; e < q.length && inside.length; e++) {
        const a = q[e], b = q[(e+1)%q.length];
        let nx = -(b[1]-a[1]), ny = b[0]-a[0];
        if ((cen[0]-a[0])*nx + (cen[1]-a[1])*ny < 0) { nx = -nx; ny = -ny; }
        const outer = rawClipPoly2ByHalfPlane(inside, a[0], a[1], -nx, -ny);
        if (outer.length >= 3) next.push(outer);
        inside = rawClipPoly2ByHalfPlane(inside, a[0], a[1], nx, ny);
      }
    }
    pieces = next;
    if (pieces.length > limit) throw new Error('lid trim did not converge');
  }
  return pieces;
}

// Take a convex ring - a round hole's, grown by R - off the lid. Outside a
// convex ring the plane splits exactly into one wedge per ring edge: beyond
// that edge, between the two rays out from its ends (each ring point's own
// outward direction, away from its loop point). Each piece is cut into the
// wedges it reaches, so the lid is cut only along the ring's own edges and
// along those rays - never along a ring edge's line carried on past its ends,
// which crosses the face anywhere and meets the outline at a shallow angle
// (a thin tube wall). The cap never covered the hole itself, so what is left
// is exactly the lid less the band.
function rawLidSubtractConvex2(pieces, ring, poly, limit) {
  const m = ring.length;
  let a2 = 0;
  for (let i = 0; i < m; i++) { const a = ring[i], b = ring[(i+1)%m]; a2 += a[0]*b[1] - b[0]*a[1]; }
  const w = a2 >= 0 ? 1 : -1;
  // outward ray at each ring point
  const ray = ring.map((q, i) => {
    let dx = q[0] - poly[i][0], dy = q[1] - poly[i][1];
    const l = Math.hypot(dx, dy) || 1e-12;
    return [dx / l, dy / l];
  });
  const next = [];
  for (const p of pieces) {
    // A piece the ring does not reach comes through whole, uncut.
    let touch = p;
    for (let i = 0; i < m && touch.length; i++) {
      const a = ring[i], b = ring[(i+1)%m];
      touch = rawClipPoly2ByHalfPlane(touch, a[0], a[1], -(b[1]-a[1]) * w, (b[0]-a[0]) * w);
    }
    if (!touch.length || rawPolyArea2(touch) < 1e-12) { next.push(p); continue; }
    for (let i = 0; i < m; i++) {
      const a = ring[i], b = ring[(i+1)%m];
      // outside this edge (the inward normal, reversed)
      let piece = rawClipPoly2ByHalfPlane(p, a[0], a[1], (b[1]-a[1]) * w, -(b[0]-a[0]) * w);
      if (!piece.length) continue;
      // on b's side of the ray at a, and on a's side of the ray at b
      let nx = -ray[i][1], ny = ray[i][0];
      if ((b[0]-a[0]) * nx + (b[1]-a[1]) * ny < 0) { nx = -nx; ny = -ny; }
      piece = rawClipPoly2ByHalfPlane(piece, a[0], a[1], nx, ny);
      if (!piece.length) continue;
      const i1 = (i+1)%m;
      nx = -ray[i1][1]; ny = ray[i1][0];
      if ((a[0]-b[0]) * nx + (a[1]-b[1]) * ny < 0) { nx = -nx; ny = -ny; }
      piece = rawClipPoly2ByHalfPlane(piece, b[0], b[1], nx, ny);
      if (piece.length) next.push(piece);
    }
    if (next.length > limit) throw new Error('lid trim did not converge');
  }
  return next;
}

// The lid, without ever re-fanning it: the original cap triangles trimmed
// back to every loop's ring. One convex outline (a plain cut face, every
// rectangle, a tube end's outer edge) takes the direct intersection - one
// clip per triangle, no growth; any other outline has its band taken off
// quad by quad. Holes always go quad by quad.
//
// The check that the trim took what it should and nothing else: the lid
// that is left must be exactly the outer rings' area less the holes' rings'
// area. Anything off, and the face is left unchanged.
function rawLidTrimToRings2(capPolys, loops, requestedR) {
  let before = 0;
  for (const p of capPolys) before += rawPolyArea2(p);
  const limit = Math.max(4096, capPolys.length * 16);
  const outers = loops.filter(L => !L.hole), holes = loops.filter(L => L.hole);
  let pieces = [];
  if (outers.length === 1 && rawIsConvexPoly2(outers[0].ring2)) {
    const ring = outers[0].ring2, m = ring.length;
    let ra = 0;
    for (let i = 0; i < m; i++) { const a=ring[i], b=ring[(i+1)%m]; ra += a[0]*b[1]-b[0]*a[1]; }
    const w = ra >= 0 ? 1 : -1;
    for (const cp of capPolys) {
      let piece = cp;
      for (let i = 0; i < m && piece.length; i++) {
        const a = ring[i], b = ring[(i+1)%m];
        piece = rawClipPoly2ByHalfPlane(piece, a[0], a[1], -(b[1]-a[1])*w, (b[0]-a[0])*w);
      }
      if (piece.length >= 3) pieces.push(piece);
    }
  } else {
    pieces = capPolys.slice();
    for (const L of outers) pieces = rawLidSubtractBand2(pieces, L.poly, L.ring2, limit);
  }
  for (const L of holes) {
    pieces = rawIsConvexPoly2(L.ring2) ? rawLidSubtractConvex2(pieces, L.ring2, L.poly, limit)
                                        : rawLidSubtractBand2(pieces, L.poly, L.ring2, limit);
  }

  let after = 0;
  for (const p of pieces) after += rawPolyArea2(p);
  let want = 0;
  for (const L of loops) want += (L.hole ? -1 : 1) * rawPolyArea2(L.ring2);
  if (!(want > 1e-9) || Math.abs(want - after) > Math.max(1e-6, before * 1e-5)) {
    const e = new Error('the lid did not trim cleanly to the rounded edge at R=' + requestedR +
                        ' (' + after.toFixed(3) + ' of ' + want.toFixed(3) + ' mm2 kept) - left unchanged');
    e.softenTooLarge = true;
    throw e;
  }
  return pieces;
}

// A limit, worded so "R must be under it" is true: one decimal when that is
// at most a hair over the real limit (a 96-gon tube wall's 0.9997 reads 1.0),
// otherwise two decimals rounded down (1.55, not a 1.6 that would fail).
function rawSoftenUnder(lim) {
  const s = lim.toFixed(1);
  if (+s > 0 && +s - lim <= 0.005) return s;
  return (Math.floor(lim * 100) / 100).toFixed(2);
}

// Run a cap-plane build at R; if it fails because R is more than the face
// takes - the lid trim came out wrong, or a ring crossed itself - find the R
// it does take and say so. "Too large for this face" is never said without
// that number. `build(R)` is the engine; `fn` carries its lastBuild, which the
// probe builds must not leave behind.
function rawSoftenWithLimit(build, requestedR, fn) {
  try {
    return build(requestedR);
  } catch (e) {
    if (!e || !e.softenTooLarge) throw e;
    const keep = fn ? fn.lastBuild : undefined;
    let lo = 0, hi = requestedR;
    for (let k = 0; k < 16 && hi - lo > Math.max(0.005, requestedR * 1e-3); k++) {
      const mid = (lo + hi) / 2;
      try { build(mid); lo = mid; } catch (e2) { hi = mid; }
    }
    if (fn) fn.lastBuild = keep;
    if (!(lo > 0.02)) throw e;
    throw new Error('R=' + requestedR + ' too large for this face - R must be under ' +
                    rawSoftenUnder(lo) + ' here - left unchanged');
  }
}

// Planar pieces from a clip carry a point that should sit ON a known point -
// a ring vertex, a ball centre - only to within rounding: the cap is float32
// and the ring is not, and two clips can land two points a hair apart on the
// same vertex (1e-8 on a stock cylinder's fan, 2e-5 where a long cap
// triangle runs straight through a ring corner). Left in, every fan apex of
// that piece reads as degenerate, the ear clip emits slivers between the
// twins, and at the mesh's 1e-4 weld their edges come out non-manifold - a
// plain stock cylinder end did this on every Round and Bevel. Two pieces can
// also carry one crossing twice, and the lid's T-junction pass then stitches
// one twin in beside the other.
//
// So every point closer than `tol` (half the weld) to another - through any
// chain of them - is one cluster, and the whole cluster goes to one point: a
// target if it holds one, else the first seen. Then consecutive twins are
// dropped. A point already on its cluster's point is left byte for byte, so a
// face with no near twins comes out exactly as it went in. In place.
function rawSnapPieces2(pieces, targets, tol) {
  tol = tol || 5e-5;
  // Every point, targets first, clustered: any two closer than `tol` are one
  // cluster, through any chain of neighbours.
  const nodes = [], idOf = new Map();
  const node = (v, isTarget) => {
    if (idOf.has(v)) return;
    idOf.set(v, nodes.length);
    nodes.push({ v, t: isTarget });
  };
  for (const q of targets) node(q, true);
  for (const piece of pieces) for (const v of piece) node(v, false);
  const up = nodes.map((_, n) => n);
  const find = (n) => { while (up[n] !== n) { up[n] = up[up[n]]; n = up[n]; } return n; };
  const cell = tol, grid = new Map();
  nodes.forEach((o, n) => {
    const cx = Math.floor(o.v[0] / cell), cy = Math.floor(o.v[1] / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const m of (grid.get((cx + dx) + '|' + (cy + dy)) || [])) {
          if (Math.hypot(nodes[m].v[0] - o.v[0], nodes[m].v[1] - o.v[1]) < tol) up[find(n)] = find(m);
        }
      }
    }
    const k = cx + '|' + cy;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(n);
  });
  // One point stands for each cluster: a target if it has one, else the
  // first seen.
  const rep = new Map();
  nodes.forEach((o, n) => {
    const c = find(n), b = rep.get(c);
    if (b === undefined || (o.t && !nodes[b].t)) rep.set(c, n);
  });
  for (let idx = 0; idx < pieces.length; idx++) {
    pieces[idx] = pieces[idx].map(v => {
      const q = nodes[rep.get(find(idOf.get(v)))].v;
      return Math.hypot(q[0] - v[0], q[1] - v[1]) >= 1e-9 ? q : v;
    });
  }
  for (let idx = pieces.length - 1; idx >= 0; idx--) {
    const kept = [];
    let changed = false;
    for (const s of pieces[idx]) {
      const last = kept[kept.length - 1];
      if (!last || Math.hypot(s[0] - last[0], s[1] - last[1]) >= tol) kept.push(s);
      else changed = true;
    }
    while (kept.length > 1 && Math.hypot(kept[0][0] - kept[kept.length-1][0], kept[0][1] - kept[kept.length-1][1]) < tol) {
      kept.pop(); changed = true;
    }
    if (!changed) continue;
    if (kept.length >= 3) pieces[idx] = kept;
    else pieces.splice(idx, 1);
  }
  return pieces;
}

// Lid, wall and band for a face whose rings are built. `fc` is the
// rawCapFaceContext the loops came from. Returns the triangle soup as a
// plain array; the caller wraps it.
function rawCapRebuildFromRings(fc, axisIdx, keepMin, loops, requestedR) {
  const other = [0, 1, 2].filter(a => a !== axisIdx);
  const capPlane = fc.capPlane, vert = fc.vert, isOnCap = fc.isOnCap;
  const flat2 = (p3) => [p3[other[0]], p3[other[1]]];
  const from3 = (uv, along) => { const p=[0,0,0]; p[other[0]]=uv[0]; p[other[1]]=uv[1]; p[axisIdx]=along; return p; };
  for (const L of loops) {
    L.u = other[0]; L.v = other[1];
    L.ring2 = L.rings[L.rings.length - 1].map(flat2);
  }
  const STEPS = loops[0].rings.length - 1;

  // ---------- room: no two loops' rounds may meet, no ring may cross itself ----------
  // The loops first, so a tube wall too thin for R is refused as that and
  // not as whatever it happens to break further down.
  rawSoftenLoopRoom(loops, requestedR);
  for (const L of loops) {
    if (rawRingSelfIntersects2(L.ring2)) {
      const e = new Error('R=' + requestedR + ' self-intersects on this face');
      e.softenTooLarge = true;
      throw e;
    }
    // A ring inset past the middle of a narrow face turns inside out without
    // crossing itself - a 3 mm strip at R 2 - and a convex inside-out ring
    // still passes the lid's area test. Every treated edge of the ring must
    // run the way its loop edge runs.
    const n = L.poly.length;
    for (let i = 0; i < n; i++) {
      const i1 = (i + 1) % n;
      if (!(L.Rs[i] > 0 || L.Rs[i1] > 0)) continue;
      const ex = L.poly[i1][0] - L.poly[i][0], ey = L.poly[i1][1] - L.poly[i][1];
      const fx = L.ring2[i1][0] - L.ring2[i][0], fy = L.ring2[i1][1] - L.ring2[i][1];
      if (ex * fx + ey * fy < -1e-12) {
        const e = new Error('R=' + requestedR + ' turns this face inside out');
        e.softenTooLarge = true;
        throw e;
      }
    }
  }

  const out = [];

  // ---------- lid: original cap triangles trimmed back to the rings ----------
  const capPolys = fc.capTriIdx.map(t => [flat2(vert(t,0)), flat2(vert(t,1)), flat2(vert(t,2))]);
  const lidPieces = rawLidTrimToRings2(capPolys, loops, requestedR);

  // Lid points that two clips landed a hair apart, or a hair off a ring or
  // loop point, become one point (rawSnapPieces2).
  {
    const targets = [];
    for (const L of loops) { for (const q of L.ring2) targets.push(q); for (const q of L.poly) targets.push(q); }
    rawSnapPieces2(lidPieces, targets);
  }

  // Two lid triangles clipped by the same ring do not pick up the same points
  // along an edge they share, and a lid edge can run past several wall
  // vertices. Split every lid edge at any lid point lying on it.
  const cpts = [], cseen = new Set();
  const addC = (p) => {
    const k = Math.round(p[0]*1e4) + '|' + Math.round(p[1]*1e4);
    if (cseen.has(k)) return;
    cseen.add(k);
    cpts.push(p);
  };
  for (const p of lidPieces) for (const v of p) addC(v);
  for (const L of loops) for (const v of L.poly) addC(v);
  for (const L of loops) for (const v of L.pts) addC(flat2(v));
  for (const L of loops) for (const v of L.ring2) addC(v);
  for (let idx = 0; idx < lidPieces.length; idx++) {
    const p = lidPieces[idx], grown = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i+1)%p.length];
      grown.push(a);
      const ex = b[0]-a[0], ey = b[1]-a[1], len2 = ex*ex + ey*ey;
      if (!(len2 > 1e-18)) continue;
      const inv = 1 / Math.sqrt(len2);
      const mids = [];
      for (const q of cpts) {
        const u = ((q[0]-a[0])*ex + (q[1]-a[1])*ey) / len2;
        if (u <= 1e-6 || u >= 1-1e-6) continue;
        if (Math.abs((q[0]-a[0])*ey - (q[1]-a[1])*ex) * inv > 1e-6) continue;
        mids.push({ u, q });
      }
      mids.sort((x, y) => x.u - y.u);
      for (const md of mids) grown.push(md.q);
    }
    lidPieces[idx] = grown;
  }

  // Splits the band has to follow, or every crossing is a T-junction.
  for (const L of loops) {
    const ring2 = L.ring2, n = ring2.length;
    L.splits = new Map();
    for (const p of lidPieces) {
      for (const v of p) {
        for (let i = 0; i < n; i++) {
          const P = ring2[i], Q = ring2[(i+1)%n];
          const ex = Q[0]-P[0], ey = Q[1]-P[1], len2 = ex*ex + ey*ey;
          if (!(len2 > 1e-18)) continue;
          const u = ((v[0]-P[0])*ex + (v[1]-P[1])*ey) / len2;
          if (u <= 1e-6 || u >= 1-1e-6) continue;
          if (Math.abs((v[0]-P[0])*ey - (v[1]-P[1])*ex) / Math.sqrt(len2) > 1e-3) continue;
          if (!L.splits.has(i)) L.splits.set(i, []);
          const list = L.splits.get(i);
          if (!list.some(w => Math.abs(w - u) < 1e-6)) list.push(u);
        }
      }
    }
  }

  const wantSign = keepMin ? -1 : 1;
  const emitLid = (A, B, C) => {
    let a = from3(A, capPlane), b = from3(B, capPlane), c = from3(C, capPlane);
    const ux=b[0]-a[0], uy=b[1]-a[1], uz=b[2]-a[2];
    const vx=c[0]-a[0], vy=c[1]-a[1], vz=c[2]-a[2];
    const nrm = [uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx];
    if (!(Math.hypot(nrm[0], nrm[1], nrm[2]) > 1e-10)) return;
    if (Math.sign(nrm[axisIdx] || 1) !== wantSign) { const tmp=b; b=c; c=tmp; }
    out.push(a[0],a[1],a[2], b[0],b[1],b[2], c[0],c[1],c[2]);
  };
  for (const p of lidPieces) {
    const m = p.length;
    // Fan from a vertex that is not collinear with any of its own fan edges.
    // Fanning blindly from vertex 0 leaves holes: a lid edge carrying a wall
    // vertex puts three points on one line, that triangle has no area, and
    // dropping it orphans the boundary edge underneath.
    let apexAt = -1;
    for (let a = 0; a < m && apexAt < 0; a++) {
      let clean = true;
      for (let k = 1; k + 1 < m && clean; k++) {
        const P0 = p[a], P1 = p[(a+k)%m], P2 = p[(a+k+1)%m];
        const cr = (P1[0]-P0[0])*(P2[1]-P0[1]) - (P1[1]-P0[1])*(P2[0]-P0[0]);
        if (Math.abs(cr) * 0.5 < 1e-12) clean = false;
      }
      if (clean) apexAt = a;
    }
    if (apexAt < 0) {
      // A dense lid piece has no clean fan apex - every vertex sits on a
      // straight run with other points on it - so ear clip it, and KEEP the
      // zero-area triangles: they carry the boundary edges lying along the
      // apex's own run, and dropping them leaves the lid open against the
      // band. Winding comes from the first triangle that has one.
      const ears = rawEarClip2D(p);
      let flip = null;
      for (const t of ears) {
        const A = p[t[0]], B = p[t[1]], C = p[t[2]];
        const cr = (B[0]-A[0])*(C[1]-A[1]) - (B[1]-A[1])*(C[0]-A[0]);
        if (Math.abs(cr) * 0.5 < 1e-12) continue;
        const a3 = from3(A, capPlane), b3 = from3(B, capPlane), c3 = from3(C, capPlane);
        const ux=b3[0]-a3[0], uy=b3[1]-a3[1], uz=b3[2]-a3[2];
        const vx=c3[0]-a3[0], vy=c3[1]-a3[1], vz=c3[2]-a3[2];
        const nrm = [uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx];
        flip = Math.sign(nrm[axisIdx] || 1) !== wantSign;
        break;
      }
      if (flip === null) continue;
      for (const t of ears) {
        const A = from3(p[t[0]], capPlane), B = from3(p[t[1]], capPlane), C = from3(p[t[2]], capPlane);
        if (flip) out.push(A[0],A[1],A[2], C[0],C[1],C[2], B[0],B[1],B[2]);
        else out.push(A[0],A[1],A[2], B[0],B[1],B[2], C[0],C[1],C[2]);
      }
      continue;
    }
    for (let k = 1; k + 1 < m; k++) emitLid(p[apexAt], p[(apexAt+k)%m], p[(apexAt+k+1)%m]);
  }

  // ---------- wall ----------
  // Depth only, never sideways. Snapping a wall vertex onto the nearest loop
  // vertex drags the wall across the face and leaves the chip; project onto
  // the nearest loop SEGMENT - of whichever loop it belongs to - and
  // interpolate R along it, so an untreated run stays exactly on the cut
  // plane and stays sharp.
  const intoBody = keepMin ? 1 : -1;
  const depthOf = (uv) => {
    let bestD = Infinity, bestR = 0;
    for (const L of loops) {
      const poly = L.poly, Rs = L.Rs, n = poly.length;
      for (let i = 0; i < n; i++) {
        const a = poly[i], b = poly[(i+1)%n];
        const ex = b[0]-a[0], ey = b[1]-a[1];
        const len2 = ex*ex + ey*ey;
        let u = len2 > 1e-18 ? ((uv[0]-a[0])*ex + (uv[1]-a[1])*ey) / len2 : 0;
        u = Math.max(0, Math.min(1, u));
        const d = Math.hypot(uv[0] - (a[0]+ex*u), uv[1] - (a[1]+ey*u));
        if (d < bestD) { bestD = d; bestR = Rs[i] + (Rs[(i+1)%n] - Rs[i]) * u; }
      }
    }
    return capPlane + intoBody * bestR;
  };
  const dropTo = (p3) => { const q = p3.slice(); q[axisIdx] = depthOf(flat2(p3)); return q; };
  // A wall triangle's cap-plane edge is split at every loop vertex lying on
  // it first: the rebuilt loop carries points the original wall edge knows
  // nothing about, and without the split the ring's outer row and the wall's
  // top edge share no vertices at all.
  const splitTol = 1e-3;
  const capEdgeChain = (A, B) => {
    const ax = A[other[0]], ay = A[other[1]];
    const ex = B[other[0]] - ax, ey = B[other[1]] - ay;
    const len2 = ex*ex + ey*ey;
    if (!(len2 > 1e-18)) return [A, B];
    const inv = 1 / Math.sqrt(len2);
    const mids = [];
    for (const L of loops) {
      for (const pt of L.poly) {
        const px = pt[0] - ax, py = pt[1] - ay;
        const u = (px*ex + py*ey) / len2;
        if (u <= 1e-6 || u >= 1-1e-6) continue;
        if (Math.abs(px*ey - py*ex) * inv > splitTol) continue;
        const q = [0,0,0];
        q[other[0]] = ax + ex*u;
        q[other[1]] = ay + ey*u;
        q[axisIdx] = capPlane;
        mids.push({ u, q });
      }
    }
    if (!mids.length) return [A, B];
    mids.sort((x, y) => x.u - y.u);
    const chain = [A];
    const near = (p, q) => Math.hypot(p[other[0]]-q[other[0]], p[other[1]]-q[other[1]]) < 1e-9;
    for (const md of mids) if (!near(md.q, chain[chain.length-1])) chain.push(md.q);
    if (!near(B, chain[chain.length-1])) chain.push(B);
    return chain;
  };
  const pushTri = (a, b, c) => {
    const ux=b[0]-a[0], uy=b[1]-a[1], uz=b[2]-a[2];
    const vx=c[0]-a[0], vy=c[1]-a[1], vz=c[2]-a[2];
    const nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx;
    if (0.5*Math.hypot(nx,ny,nz) < 1e-12) return;
    out.push(a[0],a[1],a[2], b[0],b[1],b[2], c[0],c[1],c[2]);
  };
  for (const t of fc.wallTriIdx) {
    const tri = [vert(t,0), vert(t,1), vert(t,2)];
    let capEdge = -1;
    for (let v = 0; v < 3; v++) if (isOnCap(tri[v]) && isOnCap(tri[(v+1)%3])) { capEdge = v; break; }
    if (capEdge < 0) {
      for (let v = 0; v < 3; v++) if (isOnCap(tri[v])) tri[v] = dropTo(tri[v]);
      // Every wall triangle the input had is kept, area test and all: the
      // split leaves zero-area seam triangles that bridge a T-junction on the
      // piece's OTHER face, and dropping one leaves that edge odd. Only
      // triangles this pass invents are area tested.
      out.push(tri[0][0],tri[0][1],tri[0][2], tri[1][0],tri[1][1],tri[1][2], tri[2][0],tri[2][1],tri[2][2]);
      continue;
    }
    const A = tri[capEdge], B = tri[(capEdge+1)%3], C = tri[(capEdge+2)%3];
    const rawChain = capEdgeChain(A, B);
    const chain = rawChain.map(dropTo);
    const Cp = isOnCap(C) ? dropTo(C) : C;
    if (rawChain.length === 2) {
      out.push(chain[0][0],chain[0][1],chain[0][2], chain[1][0],chain[1][1],chain[1][2], Cp[0],Cp[1],Cp[2]);
      continue;
    }
    for (let k = 0; k + 1 < chain.length; k++) pushTri(chain[k], chain[k+1], Cp);
  }

  // ---------- band, one per loop ----------
  // An untreated (R=0) run collapses the strip to a line; those degenerate
  // triangles are dropped, leaving the original sharp edge.
  const same = (p, q) => Math.hypot(p[0]-q[0], p[1]-q[1], p[2]-q[2]) < 1e-9;
  const pushBand = (A, B, C) => {
    if (same(A,B) || same(B,C) || same(C,A)) return;
    out.push(A[0],A[1],A[2], B[0],B[1],B[2], C[0],C[1],C[2]);
  };
  for (const L of loops) {
    const rings = L.rings, ring2 = L.ring2, n = ring2.length;
    for (let s = 0; s < STEPS; s++) {
      const a = rings[s], b = rings[s+1];
      for (let i = 0; i < n; i++) {
        const i1 = (i+1)%n;
        const A0=a[i], A1=a[i1], B0=b[i], B1=b[i1];
        if (s === STEPS-1 && L.splits.has(i) && !same(B0, B1)) {
          const P = ring2[i], Q = ring2[i1];
          const chain = [B0];
          for (const u of L.splits.get(i).slice().sort((x,y)=>x-y)) {
            chain.push(from3([P[0] + (Q[0]-P[0])*u, P[1] + (Q[1]-P[1])*u], capPlane));
          }
          chain.push(B1);
          pushBand(A0, A1, chain[chain.length-1]);
          for (let k = chain.length-1; k > 0; k--) pushBand(A0, chain[k], chain[k-1]);
          continue;
        }
        pushBand(A0, A1, B1);
        pushBand(A0, B1, B0);
      }
    }
  }
  return out;
}

// Corners. The clicked face does not move: capPlane is read off the mesh,
// the lid is rebuilt at exactly that plane, and only the corners of the face
// loop are rolled. No second-plane re-clip, no full-loop offset.
//
// Per genuine corner (windowed turn > minTurnDeg), interior angle t:
//   R      clamped to 0.45 x the wall available at that corner, and to
//          0.45 x the straight run either side so the blend fits.
//   ring   the loop offset inward by R(1-cos phi) with the wall dropped by
//          R(1-sin phi) - a true quarter circle normal to each edge.
//   taper  R dies to 0 at +/- blend along each edge, with an explicit R=0
//          transition point inserted there, so the span between corners
//          keeps R=0 and stays a straight sharp edge sitting on the plane.
// The lid is the ORIGINAL cap triangles trimmed back to the ring - never a
// centroid fan, so the face interior is not re-triangulated.
//
// opts.minTurnDeg  corner threshold, default 25
// `plane` is accepted for call-site compatibility and deliberately unused:
// the true cap plane comes from the mesh, not the EPS-nudged value.
function rawEdgeRoundInPlace(rawTris, axisIdx, plane, keepMin, requestedR, opts) {
  opts = opts || {};
  return rawSoftenWithLimit(R => rawEdgeRoundBuild(rawTris, axisIdx, keepMin, R, opts),
                            requestedR, rawEdgeRoundInPlace);
}

function rawEdgeRoundBuild(rawTris, axisIdx, keepMin, requestedR, opts) {
  const minTurn = (opts.minTurnDeg == null ? 25 : opts.minTurnDeg) * Math.PI / 180;
  const STEPS = 6;
  const intoBody = keepMin ? 1 : -1;
  const other = [0, 1, 2].filter(a => a !== axisIdx);
  // The face and every loop it has (rawCapFaceContext). Corners are rolled on
  // the outline only; a hole's corners are reflex in the material, which this
  // engine leaves sharp wherever it meets one, so holes pass through at R 0.
  const fc = rawCapFaceContext(rawTris, axisIdx, keepMin);
  const capPlane = fc.capPlane;
  const loop3d = fc.loop3d;

  const flat2 = (p3) => [p3[other[0]], p3[other[1]]];
  let poly2d = loop3d.map(flat2);
  poly2d = raw2DWeldLoop(poly2d, 0.08);
  if (poly2d.length < 3) throw new Error('cap boundary too small after weld');

  // ---------- corner detection ----------
  const arcTable = (loop) => {
    const m = loop.length;
    const seg = new Array(m), cum = new Array(m + 1);
    cum[0] = 0;
    for (let i = 0; i < m; i++) {
      const a = loop[i], b = loop[(i+1)%m];
      seg[i] = Math.hypot(b[0]-a[0], b[1]-a[1]);
      cum[i+1] = cum[i] + seg[i];
    }
    const total = cum[m];
    if (!(total > 1e-6)) throw new Error('cap boundary has no length');
    const at = (s) => {
      let x = s % total; if (x < 0) x += total;
      let lo = 0, hi = m;
      while (lo + 1 < hi) { const mid = (lo+hi) >> 1; if (cum[mid] <= x) lo = mid; else hi = mid; }
      const u = seg[lo] > 1e-12 ? (x - cum[lo]) / seg[lo] : 0;
      const a = loop[lo], b = loop[(lo+1)%m];
      return [a[0] + (b[0]-a[0])*u, a[1] + (b[1]-a[1])*u];
    };
    return { seg, cum, total, at };
  };
  const tab = arcTable(poly2d);
  const nLoop = poly2d.length;
  // Turn read across a window of ARC LENGTH, so a 90deg corner reads 90deg
  // however finely the wall is tessellated. Bounded to total/16: unbounded,
  // a large R makes the window span whole edges, every mid-edge vertex reads
  // as a turn and all four corners of a square merge into one.
  const win = Math.max(tab.total / 200, 0.25, Math.min(requestedR * 1.5, tab.total / 16));
  const turn = new Array(nLoop);
  for (let i = 0; i < nLoop; i++) {
    const back = tab.at(tab.cum[i] - win), fwd = tab.at(tab.cum[i] + win);
    const a1 = Math.atan2(poly2d[i][1] - back[1], poly2d[i][0] - back[0]);
    const a2 = Math.atan2(fwd[1] - poly2d[i][1], fwd[0] - poly2d[i][0]);
    let d = a2 - a1;
    while (d > Math.PI) d -= 2*Math.PI;
    while (d < -Math.PI) d += 2*Math.PI;
    turn[i] = d;
  }
  const hot = [];
  for (let i = 0; i < nLoop; i++) if (Math.abs(turn[i]) > minTurn) hot.push(i);
  if (!hot.length) throw new Error('no corners over ' + Math.round(minTurn*180/Math.PI) + 'deg on this face');
  const groups = [];
  let cur = [hot[0]];
  for (let q = 1; q < hot.length; q++) {
    if (tab.cum[hot[q]] - tab.cum[hot[q-1]] <= win) cur.push(hot[q]);
    else { groups.push(cur); cur = [hot[q]]; }
  }
  groups.push(cur);
  if (groups.length > 1) {
    const first = groups[0], last = groups[groups.length-1];
    if (tab.total - tab.cum[last[last.length-1]] + tab.cum[first[0]] <= win) {
      groups[0] = last.concat(first);
      groups.pop();
    }
  }
  const apex = groups.map(g => g.reduce((best,i) => Math.abs(turn[i]) > Math.abs(turn[best]) ? i : best, g[0]));
  const cornerCount = apex.length;

  const gapFwd = (t) => {
    if (cornerCount === 1) return tab.total;
    let g = tab.cum[apex[(t+1)%cornerCount]] - tab.cum[apex[t]];
    if (g <= 0) g += tab.total;
    return g;
  };
  let coarseArea = 0;
  for (let i = 0; i < nLoop; i++) { const a=poly2d[i], b=poly2d[(i+1)%nLoop]; coarseArea += a[0]*b[1]-b[0]*a[1]; }
  const wind0 = coarseArea >= 0 ? 1 : -1;
  const inNormal = (ax, ay) => {
    const l = Math.hypot(ax, ay) || 1e-9;
    return [-ay/l*wind0, ax/l*wind0];
  };
  // The straight run either side of an apex, and the direction it leaves on.
  const COLL = Math.cos(3 * Math.PI / 180);
  const runFrom = (i, dir) => {
    let j = i, run = 0, d0 = null, guard = 0;
    while (guard++ < nLoop) {
      const k = dir < 0 ? (j-1+nLoop)%nLoop : (j+1)%nLoop;
      const a = dir < 0 ? poly2d[k] : poly2d[j], b = dir < 0 ? poly2d[j] : poly2d[k];
      const L = Math.hypot(b[0]-a[0], b[1]-a[1]);
      if (L > 1e-9) {
        const d = [(b[0]-a[0])/L, (b[1]-a[1])/L];
        if (d0 === null) d0 = d;
        else if (d0[0]*d[0] + d0[1]*d[1] < COLL) break;
        run += L;
      }
      j = k;
      if (j === i) break;
    }
    return { d: d0, run: run };
  };

  // A VERTEX RADIUS, not a mitre. At each corner the face boundary is cut by
  // an arc of radius Rc tangent to both edges: tangent points at
  // L = Rc/tan(t/2) from the apex, centred on the inward mitre point. A sample
  // on an edge at distance d from the apex carries the perpendicular inset
  // that puts it ON that arc,
  //     r(d) = Rc - sqrt(Rc^2 - (d - L)^2),
  // zero at the tangent point, growing to Rc(1 - sin(t/2)) at the middle of
  // the arc. Past the middle the far edge's own samples take over, so
  // everything closer to the apex than dMid - the apex included - is dropped.
  // That is what the old three-point corner could not be: an apex offset along
  // the bisector plus two transition points is a chamfer with a rounded
  // section however fine the profile underneath.
  const SPAN_MIN = 8, SPAN_MAX = 64;
  const cornerArcs = [];
  // Nozzle-safety bookkeeping for this build; published on lastBuild below so
  // the UI and the checks can see it instead of it being silently absent.
  const wallThin = [];
  let wallUnmeasured = 0;
  for (let t = 0; t < cornerCount; t++) {
    const ai = apex[t];
    if (turn[ai] * wind0 <= 0) continue;
    const back = runFrom(ai, -1), fwd = runFrom(ai, +1);
    if (!back.d || !fwd.d) continue;
    const dIn = back.d, dOut = fwd.d;
    const ext = Math.atan2(dIn[0]*dOut[1] - dIn[1]*dOut[0], dIn[0]*dOut[0] + dIn[1]*dOut[1]);
    if (ext * wind0 <= 0) continue;
    const theta = Math.PI - Math.abs(ext);
    if (!(theta > 1e-3 && theta < Math.PI - 1e-3)) continue;
    const half = theta / 2;
    const tanH = Math.tan(half), cosH = Math.cos(half);
    // The wall available at this corner, on the CORNER rule: only the two
    // segments touching the apex are skipped. The BAND rule (bandWall) skips
    // every segment within two indices of the vertex, so on a 4-vertex loop -
    // the plain square face - it skips the whole loop and falls back to its
    // default, pinning every corner at a radius the user never asked for.
    //
    // And - new - whether the fillet we are about to cut leaves a PRINTABLE
    // wall behind it. safeRadius's `.r` is exactly the old
    // Math.min(requestedR, max(0, wall * 0.45)), so the geometry is unchanged;
    // what it adds is the floor check that never existed here, and whether the
    // wall figure was measured at all or is the legacy 4 mm fallback.
    const wallAt = NSO_Thickness.cornerWall(poly2d, ai);
    const safe = NSO_Thickness.safeRadius(requestedR, wallAt.mm, { ratio: 0.45 });
    if (!wallAt.measured) wallUnmeasured++;
    if (safe.floored) wallThin.push({ at: ai, wall: wallAt.mm, leaves: safe.residualMM });
    let Rc = safe.r;
    const room = Math.min(back.run, fwd.run,
                          gapFwd((t-1+cornerCount)%cornerCount), gapFwd(t)) * 0.45;
    Rc = Math.min(Rc, Math.max(0, room * tanH));
    if (!(Rc > 0.02)) continue;
    const L = Rc / tanH;
    const dMid = Math.max(0, L - Rc * cosH);
    if (!(L - dMid > 1e-9)) continue;
    cornerArcs.push({
      s: tab.cum[ai], Rc: Rc, L: L, dMid: dMid,
      rMid: Rc * (1 - Math.sin(half)),
      nIn: inNormal(dIn[0], dIn[1]), nOut: inNormal(dOut[0], dOut[1])
    });
  }
  let peakR = 0;
  const tookR = cornerArcs.length;
  for (const c of cornerArcs) if (c.Rc > peakR) peakR = c.Rc;
  if (!tookR) throw new Error('no corner takes R=' + requestedR + ' on this face');

  const circDist = (s1, s2) => { const d = Math.abs(s1 - s2) % tab.total; return Math.min(d, tab.total - d); };
  const samples = [];
  for (let i = 0; i < nLoop; i++) {
    let inZone = false;
    for (const c of cornerArcs) if (circDist(tab.cum[i], c.s) < c.L - 1e-9) { inZone = true; break; }
    if (!inZone) samples.push({ s: tab.cum[i], uv: poly2d[i], r: 0, nrm: null });
  }
  let ptsPerCorner = 0;
  for (const c of cornerArcs) {
    const span = c.L - c.dMid;
    let k = Math.ceil(span / Math.max(c.Rc / 6, 1e-4));
    if (!isFinite(k) || k < 1) k = 1;
    k = Math.min(SPAN_MAX, Math.max(SPAN_MIN, k));
    for (const side of [-1, 1]) {
      const nrm = side < 0 ? c.nIn : c.nOut;
      for (let q = 1; q <= k; q++) {
        const d = c.dMid + span * (q / k);
        const r = Math.max(0, c.Rc - Math.sqrt(Math.max(0, c.Rc*c.Rc - (d - c.L)*(d - c.L))));
        let x = (c.s + side * d) % tab.total; if (x < 0) x += tab.total;
        samples.push({ s: x, uv: tab.at(x), r: r, nrm: nrm });
      }
    }
    // The apex itself IS the middle of the arc, and it has to stay in the loop:
    // the wall carries a vertex there and dropping it leaves the band with no
    // column to meet it. Offset along the bisector by its own radius over
    // cos(t/2) it lands exactly on the arc midpoint, and its depth then
    // matches the samples either side of it.
    samples.push({ s: c.s, uv: tab.at(c.s), r: c.rMid, nrm: null });
    if (2*k + 1 > ptsPerCorner) ptsPerCorner = 2*k + 1;
  }
  samples.sort((p, q) => p.s - q.s);
  const builtLoop = [], Rs = [], fixedNrm = [];
  for (const smp of samples) {
    const prev = builtLoop[builtLoop.length-1];
    if (prev && Math.hypot(smp.uv[0]-prev[0], smp.uv[1]-prev[1]) < 1e-9) continue;
    builtLoop.push([smp.uv[0], smp.uv[1]]);
    Rs.push(smp.r);
    fixedNrm.push(smp.nrm);
  }
  while (builtLoop.length > 3 &&
         Math.hypot(builtLoop[0][0]-builtLoop[builtLoop.length-1][0],
                    builtLoop[0][1]-builtLoop[builtLoop.length-1][1]) < 1e-9) {
    builtLoop.pop(); Rs.pop(); fixedNrm.pop();
  }
  poly2d = builtLoop;
  const n = poly2d.length;
  if (n < 3) throw new Error('corner loop too small after build');

  // ---------- ring ----------
  let area2 = 0;
  for (let i = 0; i < n; i++) { const a=poly2d[i], b=poly2d[(i+1)%n]; area2 += a[0]*b[1]-b[0]*a[1]; }
  const windSign = area2 >= 0 ? 1 : -1;
  const inwardNormal2 = (a, b) => {
    const tx=b[0]-a[0], ty=b[1]-a[1];
    let nx=-ty*windSign, ny=tx*windSign;
    const len = Math.hypot(nx,ny) || 1e-9;
    return [nx/len, ny/len];
  };
  // A corner sample offsets along ITS OWN edge normal, not the local bisector:
  // its neighbour across the dropped apex belongs to the other edge, and a
  // bisector built from that skews the sample off the arc it was placed on.
  const offDir = new Array(n), offMag = new Array(n);
  for (let i = 0; i < n; i++) {
    if (fixedNrm[i]) { offDir[i] = fixedNrm[i]; offMag[i] = 1; continue; }
    const prev=poly2d[(i-1+n)%n], curr=poly2d[i], next=poly2d[(i+1)%n];
    const n1=inwardNormal2(prev,curr), n2=inwardNormal2(curr,next);
    let bx=n1[0]+n2[0], by=n1[1]+n2[1];
    const blen=Math.hypot(bx,by)||1e-9; bx/=blen; by/=blen;
    offDir[i] = [bx, by];
    offMag[i] = 1 / Math.max(bx*n1[0]+by*n1[1], 0.3);
  }
  const vertexOffset = (i, radius) => {
    const m = radius * offMag[i];
    return [poly2d[i][0] + offDir[i][0]*m, poly2d[i][1] + offDir[i][1]*m];
  };
  const from3 = (uv, along) => { const p=[0,0,0]; p[other[0]]=uv[0]; p[other[1]]=uv[1]; p[axisIdx]=along; return p; };
  const ringAt = (s) => {
    const phi = Math.asin(Math.min(1, Math.max(0, s / STEPS)));
    const ring = [];
    for (let i = 0; i < n; i++) {
      const R = Rs[i];
      ring.push(from3(vertexOffset(i, R * (1 - Math.cos(phi))),
                      capPlane + intoBody * R * (1 - Math.sin(phi))));
    }
    return ring;
  };
  const rings = [];
  for (let s = 0; s <= STEPS; s++) rings.push(ringAt(s));
  // Lid, wall and band - the one rebuild both cap-plane engines share
  // (rawCapRebuildFromRings, above). Holes ride along untreated.
  const loops = [{ pts: loop3d, poly: poly2d, Rs: Rs, rings: rings, hole: false }];
  for (const F of fc.loops) {
    if (F.pts === loop3d) continue;
    const hp = raw2DWeldLoop(F.pts.map(flat2), 0.08);
    if (hp.length < 3) throw new Error('cap boundary too small after weld');
    const flatRing = hp.map(uv => from3(uv, capPlane));
    const hr = [];
    for (let s = 0; s <= STEPS; s++) hr.push(flatRing);
    loops.push({ pts: F.pts, poly: hp, Rs: hp.map(() => 0), rings: hr, hole: F.hole });
  }
  const out = rawCapRebuildFromRings(fc, axisIdx, keepMin, loops, requestedR);

  if (out.length < 9) throw new Error('corner round produced no geometry');
  rawEdgeRoundInPlace.lastBuild = {
    corners: cornerCount,
    rounded: tookR,
    loopPts: n,
    ptsPerCorner: ptsPerCorner,
    radius: peakR,
    requested: requestedR,
    // Nozzle safety, from nso_thickness.js. `wall.thin` lists the corners
    // where the clamped fillet still leaves under one extrusion line behind
    // it - geometry this engine has always been willing to cut and has never
    // until now reported. `unmeasured` counts corners whose wall figure is the
    // legacy 4 mm fallback rather than a measurement.
    wall: {
      nozzle_mm: NSO_Thickness.NOZZLE_DEFAULT,
      floor_mm: NSO_Thickness.floorFor(NSO_Thickness.NOZZLE_DEFAULT),
      thin: wallThin,
      unmeasured: wallUnmeasured,
      pass: wallThin.length === 0
    }
  };
  return new Float32Array(out);
}


// Sutherland-Hodgman clip of a convex polygon by one half plane:
// keeps dot(p - (px,py), (nx,ny)) >= 0. Convex in, convex out.
function rawClipPoly2ByHalfPlane(poly, px, py, nx, ny) {
  const m = poly.length;
  if (m < 3) return [];
  const out = [];
  for (let i = 0; i < m; i++) {
    const a = poly[i], b = poly[(i + 1) % m];
    const da = (a[0] - px) * nx + (a[1] - py) * ny;
    const db = (b[0] - px) * nx + (b[1] - py) * ny;
    if (da >= -1e-12) out.push(a);
    if ((da > 1e-12 && db < -1e-12) || (da < -1e-12 && db > 1e-12)) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  const cl = [];
  for (const p of out) {
    const q = cl[cl.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-9) cl.push(p);
  }
  while (cl.length > 1 && Math.hypot(cl[0][0] - cl[cl.length - 1][0], cl[0][1] - cl[cl.length - 1][1]) < 1e-9) cl.pop();
  return cl.length >= 3 ? cl : [];
}

function rawPolyArea2(poly) {
  let a2 = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a2 += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a2) * 0.5;
}

// Wall available at ONE corner. rawLocalThickness2 skips every segment
// within two indices of the vertex, so on a coarse loop - a plain 4-vertex
// rectangle, exactly the Square-split case - it skips the whole loop and
// falls back to its 4mm default, which silently pins any corner at
// R=1.8 however large R is. Here only the two segments actually touching
// the apex are skipped, so a 20mm square reports 28.3mm of wall and R=2
// (or 3, or 6) is the radius that gets built.
function rawCornerWallLimit2(loop2, i) {
  return NSO_Thickness.cornerWall(loop2, i).mm;
}

// Edges used an odd number of times - the cheap seal signal used to refuse
// a corner build that would leave the piece worse than it arrived.
function rawOddEdgeCount(soup) {
  const key = (i) => Math.round(soup[i] * 1e4) + ',' + Math.round(soup[i+1] * 1e4) + ',' + Math.round(soup[i+2] * 1e4);
  const seen = new Map();
  for (let t = 0; t + 8 < soup.length; t += 9) {
    for (let v = 0; v < 3; v++) {
      const a = key(t + v * 3), b = key(t + ((v + 1) % 3) * 3);
      const k = a < b ? a + '~' + b : b + '~' + a;
      seen.set(k, (seen.get(k) || 0) + 1);
    }
  }
  let odd = 0;
  for (const c of seen.values()) if (c % 2) odd++;
  return odd;
}

function rawFilletCut(rawTris, axisIdx, plane, keepMin, requestedR) {
  const outward = keepMin ? 1 : -1;
  const other = [0,1,2].filter(a => a !== axisIdx);

  const { cutEdges: tipEdges } = rawClipTrianglesAtPlane(rawTris, axisIdx, plane, keepMin);
  const { loops: tipLoops, degreeIssues } = rawBuildLoopsFromCutEdges(tipEdges, axisIdx);
  if (degreeIssues.length > 0) throw new Error('branch point in tip boundary');
  if (!tipLoops.length) throw new Error('no tip boundary');
  const tipLoop3d = tipLoops.reduce((a,b) => b.length > a.length ? b : a);
  if (tipLoop3d.length < 8) throw new Error('boundary too small to fillet');
  let poly2d = tipLoop3d.map(p => [p[other[0]], p[other[1]]]);
  poly2d = raw2DWeldLoop(poly2d, 0.08);
  poly2d = simplifyCollinear2D(poly2d);
  if (poly2d.length < 3) throw new Error('boundary too small to fillet after weld');
  const n = poly2d.length;

  // Adaptive per-vertex radius: never more than half the local wall
  // thickness (2R > thickness is explicitly out of bounds), never more
  // than the requested small radius.
  const Rs = new Array(n);
  for (let i = 0; i < n; i++) {
    const thick = rawLocalThickness2(poly2d, i);
    Rs[i] = Math.min(requestedR, Math.max(0, thick * 0.45));
  }
  const Rmax = Math.max(...Rs);
  if (Rmax < 0.1) throw new Error('no safe radius anywhere on this boundary');

  // Corners: shared sphere-center solve, small blend window (matches the
  // validated approach — a real fan, not a frozen 50/50 collapse).
  const cornerThresh = 30 * Math.PI / 180;
  const corners = [];
  for (let i = 0; i < n; i++) if (Math.abs(rawTurningAngle2(poly2d, i)) > cornerThresh) corners.push(i);
  const windowN = 6;
  let __area2 = 0;
  for (let i = 0; i < n; i++) {
    const a = poly2d[i], b = poly2d[(i + 1) % n];
    __area2 += a[0] * b[1] - b[0] * a[1];
  }
  const windSign = __area2 >= 0 ? 1 : -1;
  function inwardNormal2(a, b) {
    const tx = b[0] - a[0], ty = b[1] - a[1];
    let nx = -ty * windSign, ny = tx * windSign;
    const len = Math.hypot(nx, ny) || 1e-9;
    return [nx / len, ny / len];
  }
  const centers = corners.map(ci => {
    const prev = poly2d[(ci-2+n)%n], curr = poly2d[ci], next = poly2d[(ci+2)%n];
    const n1 = inwardNormal2(prev, curr), n2 = inwardNormal2(curr, next);
    return { i: ci, C: rawSolveCornerCenter2(curr, n1, n2, Rs[ci]), n1, n2, R: Rs[ci] };
  });

  function vertexOffset(i, radius) {
    const prev = poly2d[(i-1+n)%n], curr = poly2d[i], next = poly2d[(i+1)%n];
    const n1 = inwardNormal2(prev, curr), n2 = inwardNormal2(curr, next);
    let bx = n1[0]+n2[0], by = n1[1]+n2[1];
    const blen = Math.hypot(bx, by) || 1e-9;
    bx /= blen; by /= blen;
    const cosHalf = Math.max(bx*n1[0]+by*n1[1], 0.3);
    const mag = radius / cosHalf;
    return [curr[0]+bx*mag, curr[1]+by*mag];
  }

  const STEPS = 6;
  function computeRing(s) {
    const t = s / STEPS;
    const ring = [];
    for (let i = 0; i < n; i++) {
      const R = Rs[i];
      const u = R * (1 - t);
      const sinPhi = Math.min(1, Math.max(0, 1 - (R < 1e-6 ? 1 : u/R)));
      const phi = Math.asin(sinPhi);
      const inset = R * (1 - Math.cos(phi));
      let uv = vertexOffset(i, inset);
      if (s > 0) {
        for (const c of centers) {
          if (!c.C) continue;
          let d = ((i - c.i + n) % n); if (d > n/2) d -= n;
          const absD = Math.abs(d);
          if (absD > windowN) continue;
          const distToCorner = Math.hypot(poly2d[i][0]-poly2d[c.i][0], poly2d[i][1]-poly2d[c.i][1]);
          if (distToCorner > c.R * 4) continue;
          const w = rawSmoothstep2(1 - absD/windowN);
          const negN1 = [-c.n1[0], -c.n1[1]], negN2 = [-c.n2[0], -c.n2[1]];
          const tBlend = (d + windowN) / (2*windowN);
          const nBlend = rawSlerp2D2(negN1, negN2, tBlend);
          const suv = [c.C[0]+c.R*Math.cos(phi)*nBlend[0], c.C[1]+c.R*Math.cos(phi)*nBlend[1]];
          uv = [uv[0]*(1-w)+suv[0]*w, uv[1]*(1-w)+suv[1]*w];
        }
      }
      ring.push(uv);
    }
    return ring;
  }

  const innerRing = computeRing(STEPS);
  if (rawRingSelfIntersects2(innerRing)) throw new Error('fillet band self-intersects at this radius');

  // Retract the wall by Rmax FIRST — re-clip the ORIGINAL body at the
  // margin plane, rather than gluing a ring onto a wall still at the
  // original plane. This is the actual fix for the self-intersecting
  // "slice and dice" look the old disabled fillet code produced.
  const marginPlane = plane + outward * Rmax;
  // Body is always the same keepMin as the half. !keepMin is the R-slab — never ship it.
  const { kept: bodyTrimmed, cutEdges: marginEdges } = rawClipTrianglesAtPlane(rawTris, axisIdx, marginPlane, keepMin);
  if (!bodyTrimmed || bodyTrimmed.length < 9) throw new Error('margin trim produced no body');
  const { loops: marginLoops, degreeIssues: marginDegreeIssues } = rawBuildLoopsFromCutEdges(marginEdges, axisIdx);
  if (marginDegreeIssues.length > 0) throw new Error('branch point in margin boundary');
  if (!marginLoops.length) throw new Error('no margin boundary');
  const outerMargin3d = marginLoops.reduce((a,b) => b.length > a.length ? b : a);
  const marginLoop2d = outerMargin3d.map(p => [p[other[0]], p[other[1]]]);

  function from3(uv, along) {
    const p = [0,0,0]; p[other[0]] = uv[0]; p[other[1]] = uv[1]; p[axisIdx] = along; return p;
  }

  const out = bodyTrimmed.slice();

  // Weld bodyTrimmed's own margin-plane vertices to the canonical loop
  // values before stitching. bodyTrimmed and outerMargin3d both come from
  // the same clip, but near different local mesh triangles can each
  // compute a slightly different float32 copy of "the same" physical
  // point — confirmed directly: independent copies close enough to look
  // identical but far enough to break edge pairing at the stitch seam.
  // Skip any snap that would degenerate the triangle it belongs to.
  (function weldMarginPlane() {
    const tol = 1e-4;
    function wkey(p) { return Math.round(p[other[0]]/tol) + '|' + Math.round(p[other[1]]/tol); }
    const canonical = new Map();
    for (const p of outerMargin3d) canonical.set(wkey(p), p);
    const triCount = out.length / 9;
    for (let t = 0; t < triCount; t++) {
      const i0 = t*9;
      const orig = [[out[i0],out[i0+1],out[i0+2]],[out[i0+3],out[i0+4],out[i0+5]],[out[i0+6],out[i0+7],out[i0+8]]];
      const test = orig.map(v => v.slice());
      let anySnap = false;
      for (let v = 0; v < 3; v++) {
        const p = orig[v];
        if (Math.abs(p[axisIdx] - marginPlane) > tol) continue;
        const c = canonical.get(wkey(p));
        if (!c) continue;
        if (Math.abs(c[0]-p[0])<1e-9 && Math.abs(c[1]-p[1])<1e-9 && Math.abs(c[2]-p[2])<1e-9) continue;
        test[v] = c.slice();
        anySnap = true;
      }
      if (!anySnap) continue;
      const ux=test[1][0]-test[0][0], uy=test[1][1]-test[0][1], uz=test[1][2]-test[0][2];
      const vx=test[2][0]-test[0][0], vy=test[2][1]-test[0][1], vz=test[2][2]-test[0][2];
      const nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx;
      if (0.5*Math.hypot(nx,ny,nz) < 1e-9) continue;
      for (let v = 0; v < 3; v++) { out[i0+v*3]=test[v][0]; out[i0+v*3+1]=test[v][1]; out[i0+v*3+2]=test[v][2]; }
    }
  })();

  // Any OTHER margin loop (an internal rib, etc.) gets a flat cap at the
  // margin plane — same treatment the main rawCut engine uses.
  for (const loop of marginLoops) {
    if (loop === outerMargin3d) continue;
    const cap = rawFlatCapLoop(loop, axisIdx, marginPlane, keepMin);
    for (let i = 0; i < cap.length; i++) out.push(cap[i]);
  }

  // Stitch margin boundary to the band's outermost (widest, s=0) ring.
  const ring0 = computeRing(0);
  const stitch = rawBuildStitchStrip2(marginLoop2d, ring0);
  for (const [p1, p2, p3] of stitch) {
    const A = from3(p1, marginPlane), B = from3(p2, marginPlane), C = from3(p3, marginPlane);
    out.push(A[0],A[1],A[2], B[0],B[1],B[2], C[0],C[1],C[2]);
  }

  // Band: ring0 (at depth Rmax, matching wall) down to innerRing (at tip).
  const rings = [];
  for (let s = 0; s <= STEPS; s++) rings.push(computeRing(s));
  for (let s = 0; s < STEPS; s++) {
    const a = rings[s], b = rings[s+1];
    const depthA = plane + outward * (Rmax * (1 - s/STEPS));
    const depthB = plane + outward * (Rmax * (1 - (s+1)/STEPS));
    for (let i = 0; i < n; i++) {
      const i1 = (i+1)%n;
      const A0 = from3(a[i], depthA), A1 = from3(a[i1], depthA);
      const B0 = from3(b[i], depthB), B1 = from3(b[i1], depthB);
      out.push(A0[0],A0[1],A0[2], A1[0],A1[1],A1[2], B1[0],B1[1],B1[2]);
      out.push(A0[0],A0[1],A0[2], B1[0],B1[1],B1[2], B0[0],B0[1],B0[2]);
    }
  }

  // Cap the innermost ring at the true tip plane.
  const capTris = rawEarClip2D(innerRing);
  for (const tri of capTris) {
    let a = from3(innerRing[tri[0]], plane), b = from3(innerRing[tri[1]], plane), c = from3(innerRing[tri[2]], plane);
    const ux=b[0]-a[0], uy=b[1]-a[1], uz=b[2]-a[2];
    const vx=c[0]-a[0], vy=c[1]-a[1], vz=c[2]-a[2];
    const nrm = [uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx];
    const wantSign = keepMin ? -1 : 1;
    if (Math.sign(nrm[axisIdx] || 1) !== wantSign) { const t=b; b=c; c=t; }
    out.push(a[0],a[1],a[2], b[0],b[1],b[2], c[0],c[1],c[2]);
  }

  if (out.length < 9) throw new Error('fillet produced no geometry');
  return new Float32Array(out);
}

// Coarse self-check: edge pairing + winding consistency. Cheap enough to
// run on every Soft attempt before trusting the result over the flat cap.
function rawCheckWatertightQuick(flatTris) {
  function key(x,y,z) { const tol=1e-4; return Math.round(x/tol)+'|'+Math.round(y/tol)+'|'+Math.round(z/tol); }
  const edgeCount = new Map(), dirCount = new Map();
  const triN = flatTris.length / 9;
  for (let t = 0; t < triN; t++) {
    const i0 = t*9;
    const p = [[flatTris[i0],flatTris[i0+1],flatTris[i0+2]],[flatTris[i0+3],flatTris[i0+4],flatTris[i0+5]],[flatTris[i0+6],flatTris[i0+7],flatTris[i0+8]]];
    const k = p.map(v => key(v[0],v[1],v[2]));
    for (let i = 0; i < 3; i++) {
      const a=k[i], b=k[(i+1)%3];
      const uk = a<b ? a+'~'+b : b+'~'+a;
      edgeCount.set(uk, (edgeCount.get(uk)||0)+1);
      const dk = a+'>'+b;
      dirCount.set(dk, (dirCount.get(dk)||0)+1);
    }
  }
  let odd = 0, stacked = 0;
  for (const c of edgeCount.values()) if (c !== 2) odd++;
  for (const c of dirCount.values()) if (c > 1) stacked++;
  // Soften used to require a perfect 2-manifold. Real fillets leave a
  // handful of unpaired edges. Allow that so a usable fillet can ship.
  if (odd > 208 || stacked > 208) return false;
  return true;
}

