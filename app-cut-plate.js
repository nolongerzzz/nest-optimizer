/* ============================================================
   Cut plate - the Cut card's WHOLE-PLATE blade (docs/CUT-PLATE.md).

   One horizontal blade across the plate, on a height slider: Cut applies it to
   EVERY piece it crosses, at the same height, in one step. KEEP ABOVE cuts away
   what is under the blade and sets the rest back on the bed (every piece comes
   out that much shorter - a long pillar shortened once, on the whole plate, to
   print-test faster); KEEP BELOW cuts away what is above it.

   The planning is nso_cut_plate.js (THREE-free, node-tested). The cut is the
   app's own: cutOneSide (app-cut.js: rawCut and its closed-section check), so
   every cut face is the section, capped once. The piece is replaced IN PLACE
   (NSO_sculptCommitRaw, app-sculpt.js - the commit Crop uses), so its name,
   id, quantity and place on the plate stay, and the material that is kept
   stays where it was in x and z. The whole press is ONE Undo (a stepGroup).

   Everything is checked BEFORE anything is changed: if any piece the blade
   crosses cannot be cut (its cut face will not close, it carries paint) the
   press changes nothing and names the piece.

   Hooks in other files, each a line or two: app-cut.js (the Blade row's fourth
   button, the card's controls, the per-piece blade standing down),
   app-join.js (cutActiveModel hands the press here), app-core.js (a click on
   a piece does not drop the per-piece blade; the undo label).
   ============================================================ */

const CUT_PLATE_BED_Y = 0.2;            // where a piece's lowest point stands (applyMeshRotation)
const CUT_PLATE_MARGIN_MM = 4;          // the blade overhangs the plate and the pieces by this much
const CUT_PLATE_NAME = 'cutPlateBlade';

/** Is the Whole plate blade the live one? */
function cutPlateOn() {
  return !!(typeof state !== 'undefined' && state.cutterOpen && (state.cutTool || 'cut') === 'cut' &&
    state.cutBlade && state.cutBlade.mode === 'plate');
}

function cutPlateState() {
  if (!state.cutPlate) state.cutPlate = { height: null, keep: 'above' };
  return state.cutPlate;
}

// ---------------------------------------------------------------- the pieces

/* The piece's raw soup (Z up), or one made from its drawn geometry when it has no raw triple (an Array copy, a
   half of an old display cut): display is (x, z, -y) of raw, so raw is (x, -z, y). The soup is only built on Cut. */
function cutPlateRawOf(m) {
  if (m.rawTris && m.rawAxis === 'zup' && m.rawTris.length >= 9) return m.rawTris;
  const g = m.geometry && (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry);
  const pos = g && g.attributes && g.attributes.position;
  if (!pos) return null;
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    out[i * 3] = pos.getX(i);
    out[i * 3 + 1] = -pos.getZ(i);
    out[i * 3 + 2] = pos.getY(i);
  }
  return out;
}

const cutPlateRangeCache = new WeakMap();

/* The piece's z range without building a soup: cached on the raw array (every edit replaces it) or read off the
   drawn geometry's box (its y is raw z). */
function cutPlateRangeOf(m) {
  if (m.rawTris && m.rawAxis === 'zup' && m.rawTris.length >= 9) {
    let r = cutPlateRangeCache.get(m.rawTris);
    if (!r) { r = NSO_CutPlate.zRange(m.rawTris); cutPlateRangeCache.set(m.rawTris, r); }
    return r;
  }
  const g = m.geometry;
  if (!g || !g.attributes || !g.attributes.position) return null;
  if (!g.boundingBox) g.computeBoundingBox();
  return { lo: g.boundingBox.min.y, hi: g.boundingBox.max.y };
}

/** Every piece on the plate that can be cut: { m, pl, name, range, liftY }. */
function cutPlatePieces() {
  const out = [];
  (state.placed || []).forEach(function (pl) {
    if (!pl || pl.sourceId == null || !pl.mesh) return;
    const m = (state.models || []).find(function (x) { return x && x.id === pl.sourceId; });
    if (!m) return;
    const range = cutPlateRangeOf(m);
    if (!range) return;
    out.push({ m: m, pl: pl, id: m.id, name: m.name || ('piece ' + m.id), range: range, liftY: pl.liftY || 0 });
  });
  return out;
}

/** The plan for the plate as it is now, for the blade at `height`. */
function cutPlatePlan(pieces, height, keep) {
  const list = pieces.map(function (p) {
    return { id: p.id, name: p.name, raw: null, range: p.range, liftY: p.liftY };
  });
  return NSO_CutPlate.planPlate(list, { height: height, keep: keep });
}

// ----------------------------------------------------------------- the blade

function cutPlateRemoveHelper() {
  const live = state.modelGroup ? state.modelGroup.children.filter(function (c) { return c && c.name === CUT_PLATE_NAME; }) : [];
  live.forEach(function (g) {
    if (g.parent) g.parent.remove(g);
    g.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  });
  state.cutPlateHelper = null;
}

/** The area the blade spreads over: the plate and every piece, with a margin. */
function cutPlateFootprint(pieces) {
  const plate = (typeof getCurrentPlate === 'function' && getCurrentPlate()) || { w: 180, d: 180 };
  const box = new THREE.Box3(
    new THREE.Vector3(-(plate.w || 180) / 2, 0, -(plate.d || 180) / 2),
    new THREE.Vector3((plate.w || 180) / 2, 0, (plate.d || 180) / 2));
  pieces.forEach(function (p) {
    p.pl.mesh.updateMatrixWorld(true);
    box.union(new THREE.Box3().setFromObject(p.pl.mesh));
  });
  box.min.subScalar(CUT_PLATE_MARGIN_MM); box.max.addScalar(CUT_PLATE_MARGIN_MM);
  return box;
}

/* The blade: a thin translucent sheet and a solid edge frame, neither depth-tested - drawn through the pieces, as
   the per-piece blade is (app-cut.js), so the pieces cannot hide the part of it that is buried in them. */
function cutPlateBuildHelper(pieces) {
  cutPlateRemoveHelper();
  if (!state.modelGroup || typeof THREE === 'undefined') return null;
  const box = cutPlateFootprint(pieces || cutPlatePieces());
  const w = box.max.x - box.min.x, d = box.max.z - box.min.z;
  const group = new THREE.Group();
  group.name = CUT_PLATE_NAME;
  const sheet = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    new THREE.MeshBasicMaterial({ color: CUT_BLADE_COLOR, transparent: true, opacity: 0.14, side: THREE.DoubleSide,
                                  depthWrite: false, depthTest: false }));
  sheet.rotation.x = -Math.PI / 2;
  const x0 = -w / 2, x1 = w / 2, z0 = -d / 2, z1 = d / 2;
  const fg = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(x0, 0, z0), new THREE.Vector3(x1, 0, z0), new THREE.Vector3(x1, 0, z1), new THREE.Vector3(x0, 0, z1)]);
  const frame = new THREE.LineLoop(fg, new THREE.LineBasicMaterial({ color: CUT_BLADE_COLOR, depthTest: false }));
  [sheet, frame].forEach(function (o) { cutOverlay(o, false); group.add(o); });
  group.position.set((box.min.x + box.max.x) / 2, CUT_PLATE_BED_Y, (box.min.z + box.max.z) / 2);
  nsoHelpers.attach(state.modelGroup, group, 'cutplate');
  state.cutPlateHelper = group;
  return group;
}

function cutPlatePlaceHelper(height) {
  const g = state.cutPlateHelper;
  if (g && g.parent) g.position.y = CUT_PLATE_BED_Y + height;
}

/* Where the blade meets each piece it will cut: the section's outline, in the blade's colour, so the height can be
   judged against the pillars (the sheet tints everything the same). It is the cut face itself - the piece's triangles
   sliced at that piece's own plane (its foot + Height - liftY, as the cut makes it). The segments are the blade
   group's children, in its frame, redrawn at every step of the slider. */
function cutPlateSectionSegments(pieces, plan, group) {
  const out = [];
  pieces.forEach(function (p, i) {
    const pp = plan.plans[i] && plan.plans[i].plan;
    if (!pp || !pp.cut) return;
    const mesh = p.pl.mesh, geo = mesh.geometry, pos = geo && geo.attributes && geo.attributes.position;
    if (!pos) return;
    mesh.updateMatrixWorld(true);
    const e = mesh.matrixWorld.elements;
    const foot = new THREE.Box3().setFromObject(mesh).min.y;
    const y0 = foot + (pp.height - p.liftY);                         // this piece's plane, in the world
    const idx = geo.index, n = idx ? idx.count : pos.count;
    const wx = [0, 0, 0], wy = [0, 0, 0], wz = [0, 0, 0];
    for (let t = 0; t + 2 < n; t += 3) {
      for (let k = 0; k < 3; k++) {
        const v = idx ? idx.getX(t + k) : t + k, x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
        wx[k] = e[0] * x + e[4] * y + e[8] * z + e[12];
        wy[k] = e[1] * x + e[5] * y + e[9] * z + e[13];
        wz[k] = e[2] * x + e[6] * y + e[10] * z + e[14];
      }
      const up = [wy[0] >= y0, wy[1] >= y0, wy[2] >= y0];
      if (up[0] === up[1] && up[1] === up[2]) continue;               // wholly on one side: no section here
      const hits = [];
      for (let k = 0; k < 3; k++) {
        const a = k, b = (k + 1) % 3;
        if (up[a] === up[b]) continue;
        const f = (y0 - wy[a]) / (wy[b] - wy[a]);
        hits.push(wx[a] + f * (wx[b] - wx[a]) - group.position.x, 0, wz[a] + f * (wz[b] - wz[a]) - group.position.z);
      }
      if (hits.length === 6) out.push.apply(out, hits);
    }
  });
  return out;
}

function cutPlateUpdateSection(pieces, plan) {
  const g = state.cutPlateHelper;
  if (!g || !g.parent) return;
  let line = g.children.find(function (c) { return c.userData && c.userData.cutPlateSection; });
  const segs = cutPlateSectionSegments(pieces, plan, g);
  if (!line) {
    line = cutOverlay(new THREE.LineSegments(new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: CUT_BLADE_COLOR, depthTest: false })), false);
    line.userData.cutPlateSection = true;
    line.renderOrder = CUT_BLADE_RENDER_ORDER + 1;
    g.add(line);
    nsoHelpers.tag(g, 'cutplate');                                    // the new child is a helper too
  }
  line.geometry.dispose();
  line.geometry = new THREE.BufferGeometry();
  line.geometry.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3));
}

// ------------------------------------------------------------------ the card

function cutPlateShortList(list) {
  const names = list.map(function (u) { return u.name; });
  return names.length > 3 ? names.slice(0, 3).join(', ') + ' and ' + (names.length - 3) + ' more' : names.join(', ');
}

/** The readout line for a plan, and what the card needs of it. */
function cutPlateReadout(height, keep, plan, pieces) {
  const f1 = function (v) { return v.toFixed(1); };
  if (!pieces.length) return 'WHOLE PLATE - there are no pieces on the plate';
  let text = 'WHOLE PLATE @ ' + f1(height) + ' mm - keep ' + keep + ': ';
  if (!plan.cut) {
    text += 'the blade crosses no piece (' + (plan.untouched[0] ? plan.untouched[0].why : 'nothing to cut') + ')';
    return text;
  }
  const rm = plan.removedMin === plan.removedMax ? f1(plan.removedMin) : f1(plan.removedMin) + '-' + f1(plan.removedMax);
  let tallestAfter = 0;
  plan.plans.forEach(function (p, i) {
    const t = (p.plan.cut ? p.plan.after : p.plan.tall) + (pieces[i] ? pieces[i].liftY : 0);
    if (t > tallestAfter) tallestAfter = t;
  });
  text += plan.cut + ' of ' + plan.total + ' pieces cut, ' + rm + ' mm ' + (keep === 'above' ? 'shorter' : 'off the top') +
    ' (tallest ' + f1(plan.tallest) + ' -> ' + f1(tallestAfter) + ' mm)';
  if (plan.untouched.length) text += '. Left as they are: ' + cutPlateShortList(plan.untouched);
  return text;
}

/** The card's Whole plate fields, the readout, the Cut button and the blade, read off state. */
function cutPlateSync() {
  if (typeof document === 'undefined') return;
  const on = cutPlateOn();
  const tools = document.getElementById('cutter-tools');
  if (tools) tools.classList.toggle('is-plate', on);
  const fields = document.getElementById('cut-plate-fields');
  if (fields) fields.hidden = !on;
  if (!on) return;
  const st = cutPlateState();
  const pieces = cutPlatePieces();
  const range = NSO_CutPlate.heightRange(pieces.map(function (p) { return { range: p.range, liftY: p.liftY }; }));
  // the first time, a third of the way up the tallest piece; always inside the slider
  if (st.height == null || !isFinite(st.height)) st.height = Math.min(range.hi, Math.max(range.lo, Math.round(range.tallest / 3 * 2) / 2));
  st.height = Math.min(Math.max(NSO_CutPlate.snap(st.height), range.lo), range.hi);
  const sl = document.getElementById('cut-plate-height-s'), num = document.getElementById('cut-plate-height');
  if (sl) {
    sl.min = String(range.lo); sl.max = String(range.hi); sl.step = '0.1';
    if (document.activeElement !== sl) sl.value = String(st.height);
  }
  if (num) {
    num.min = String(range.lo); num.max = String(range.hi);
    if (document.activeElement !== num) num.value = String(st.height);
  }
  [['btn-cut-plate-above', 'above'], ['btn-cut-plate-below', 'below']].forEach(function (p) {
    const el = document.getElementById(p[0]);
    if (el) el.setAttribute('aria-pressed', st.keep === p[1] ? 'true' : 'false');
  });
  const plan = cutPlatePlan(pieces, st.height, st.keep);
  const readout = document.getElementById('cut-plate-readout');
  if (readout) readout.textContent = cutPlateReadout(st.height, st.keep, plan, pieces);
  const btn = document.getElementById('btn-cut');
  if (btn) btn.disabled = !plan.cut;
  if (!state.cutPlateHelper || !state.cutPlateHelper.parent) cutPlateBuildHelper(pieces);
  cutPlatePlaceHelper(st.height);
  cutPlateUpdateSection(pieces, plan);
  return plan;
}

/** The Blade row's Whole plate button was pressed (cutSetBladeMode, app-cut.js): the per-piece blade stands down, the
    plate's takes over. Leaving it (another blade) puts the per-piece one back if a piece is picked. */
function cutPlateModeChanged() {
  if (cutPlateOn()) {
    if (typeof removeCutHelper === 'function') removeCutHelper();      // the per-piece blade stands down
    state.previewMesh = null;
    cutPlateSync();
    if (typeof updateCutterUI === 'function') updateCutterUI();
    setStatus('Whole plate: one blade across every piece. Set its height, then Cut.');
  } else {
    cutPlateRemoveHelper();
    const m = typeof getActiveModel === 'function' ? getActiveModel() : null;
    const mesh = m && typeof cutMeshOf === 'function' ? cutMeshOf(m) : null;
    if (state.cutterOpen && mesh) { state.previewMesh = mesh; buildCutHelper(); }
    cutPlateSync();
    if (typeof updateCutterUI === 'function') updateCutterUI();       // the Cut button is the per-piece blade's again
  }
}

function cutPlateWire() {
  if (typeof document === 'undefined') return;
  const num = document.getElementById('cut-plate-height');
  if (!num || num.dataset.nsoWired === '1') return;
  num.dataset.nsoWired = '1';
  const sl = document.getElementById('cut-plate-height-s');
  function set(v, from) {
    if (!isFinite(v)) return;                       // mid-typing: keep the last good height
    const st = cutPlateState();
    st.height = v;
    if (from !== num) num.value = String(v);
    if (sl && from !== sl) sl.value = String(v);
    cutPlateSync();
  }
  num.addEventListener('input', function () { set(Number(num.value), num); });
  if (sl) sl.addEventListener('input', function () { set(Number(sl.value), sl); });
  // a blade the card shows is the blade that cuts: leaving the box snaps it into the slider's range
  num.addEventListener('change', function () {
    cutPlateSync();
    num.value = String(cutPlateState().height);
  });
  [['btn-cut-plate-above', 'above'], ['btn-cut-plate-below', 'below']].forEach(function (p) {
    const el = document.getElementById(p[0]);
    if (el) el.addEventListener('click', function () { cutPlateState().keep = p[1]; cutPlateSync(); });
  });
}

// ------------------------------------------------------------------- the cut

function cutPlateRefused(why, extra) {
  setStatus('Whole-plate cut not made: ' + why + '. Nothing changed.' + (extra || ''), true);
  return { ok: false, reason: why };
}

/**
 * Cut every piece the blade crosses. The press: plan, check, cut all in memory, then commit all as one Undo step.
 * Returns { ok, cut, untouched, reason } for the checks.
 */
function cutPlateRun() {
  if (!cutPlateOn()) return { ok: false, reason: 'not armed' };
  const st = cutPlateState();
  let pieces = cutPlatePieces();
  if (!pieces.length) return cutPlateRefused('there are no pieces on the plate');
  let baked = 0;
  // One press, one Undo: what the press pushes (a pose set first, a piece's new geometry) is collected on a stack of its
  // own and put back as one step - the way the Join card's presses do (app-join-triple.js asOneStep).
  const outer = state.undoStack;
  state.undoStack = [];

  try {
    // A piece still carrying a turn (a scene file's pose, or one mid-gesture) has its turn written into its geometry
    // first - the blade is level in the WORLD, and the cut is made in the piece's own frame - as every pose action does
    // when it ends. These are steps of the same press.
    pieces.forEach(function (p) {
      if (typeof nsoPlacedIsTurned === 'function' && nsoPlacedIsTurned(p.pl) &&
          typeof nsoBakePlacedPose === 'function' && nsoBakePlacedPose(p.pl)) baked++;
    });
    if (baked) pieces = cutPlatePieces();

    const plan = cutPlatePlan(pieces, st.height, st.keep);
    if (!plan.cut) {
      return cutPlateRefused('the blade at ' + st.height.toFixed(1) + ' mm crosses no piece' +
        (plan.untouched[0] ? ' (' + plan.untouched[0].why + ')' : ''));
    }
    const byId = new Map(plan.plans.map(function (x) { return [x.id, x.plan]; }));

    // 1. Everything the blade crosses must be cuttable, before anything is touched.
    const crossed = pieces.filter(function (p) { return byId.get(p.id).cut; });
    const painted = crossed.filter(function (p) { return typeof nsoMaskCount === 'function' && nsoMaskCount(p.m) > 0; });
    if (painted.length) {
      return cutPlateRefused(cutPlateShortList(painted) + (painted.length > 1 ? ' carry' : ' carries') +
        ' painted faces, and a cut renumbers every face - clear the paint, or move the blade clear of ' +
        (painted.length > 1 ? 'them' : 'it'));
    }

    // 2. Every cut made in memory. One refusal stops the press with the plate as it was.
    const done = [];
    for (let i = 0; i < crossed.length; i++) {
      const p = crossed[i], pp = byId.get(p.id);
      const raw = cutPlateRawOf(p.m);
      if (!raw) return cutPlateRefused(p.name + ' has no mesh');
      let kept;
      try {
        kept = NSO_CutPlate.apply(raw, pp, cutOneSide);
      } catch (err) {
        const why = err && err.name === 'CutRefused' ? err.message : String((err && err.message) || err);
        return cutPlateRefused(p.name + ': ' + why);
      }
      const bb = NSO_CutPlate.zRange(kept);
      if (!(bb.hi - bb.lo >= 0.4)) return cutPlateRefused(p.name + ' would be left a sliver');
      done.push({ p: p, plan: pp, kept: kept });
    }

    // 3. Commit. Each piece keeps its place: what is kept stays where it was in x and z (the drawn geometry is centred on
    //    the kept part's box, so x and z move by what the centring moved), and its undo entry carries the old pose.
    done.forEach(function (d) {
      const m = d.p.m, pl = d.p.pl;
      const idx = state.placed.indexOf(pl);
      const before = typeof snapshotPlacedPose === 'function' ? snapshotPlacedPose(idx) : null;
      const oldOff = m.centerOffset ? { x: m.centerOffset.x, z: m.centerOffset.z } : null;
      NSO_sculptCommitRaw(m, d.kept, 'plateCutReplace', null);
      const dx = oldOff && m.centerOffset ? m.centerOffset.x - oldOff.x : 0;
      const dz = oldOff && m.centerOffset ? m.centerOffset.z - oldOff.z : 0;
      // A piece the cut leaves the same footprint (the usual case) is not moved at all: its Undo is the plain geometry
      // swap, as Crop's. One whose footprint changed has its place carried by exactly that, and its Undo puts the old
      // pose back with the geometry.
      if (Math.abs(dx) > 1e-6 || Math.abs(dz) > 1e-6) {
        const entry = state.undoStack[state.undoStack.length - 1];
        if (entry && entry.type === 'plateCutReplace' && before) entry.prevPose = before;
        applyPlacedXZ(pl, pl.x + dx, pl.z + dz);
        if (typeof refreshOutline === 'function') refreshOutline(pl);
      }
    });

    const msg = 'Whole-plate cut @ ' + st.height.toFixed(1) + ' mm, keep ' + st.keep + ': ' + done.length + ' of ' +
      pieces.length + ' pieces ' + (st.keep === 'above' ? 'shortened by ' : 'cut off ') +
      (plan.removedMin === plan.removedMax ? plan.removedMin.toFixed(1) : plan.removedMin.toFixed(1) + '-' + plan.removedMax.toFixed(1)) +
      ' mm' + (plan.untouched.length ? '; left as they are: ' + cutPlateShortList(plan.untouched) : '') +
      (baked ? ' (' + baked + ' turned piece' + (baked > 1 ? 's' : '') + ' set first)' : '') + '. One Undo puts the plate back.';
    return { ok: true, cut: done.length, untouched: plan.untouched, baked: baked, message: msg };
  } finally {
    // everything this press did, even a refusal after a turned piece was set, is one Undo
    const steps = state.undoStack;
    state.undoStack = outer;
    if (steps.length > 1) {
      pushUndo({ type: 'stepGroup', steps: steps, label: 'Undo: whole-plate cut reverted', redoLabel: 'whole-plate cut re-applied' });
    } else if (steps.length === 1) {
      pushUndo(steps[0]);
    } else if (typeof updateUndoBtn === 'function') updateUndoBtn();
    if (cutPlateOn()) {
      cutPlateBuildHelper();
      cutPlateSync();
    }
  }
}

/** The press of Cut while the Whole plate blade is live (app-join.js cutActiveModel). */
function cutPlateActiveRun() {
  const r = cutPlateRun();
  if (r && r.ok && r.message) setStatus(r.message);
  return r;
}

if (typeof nsoHelpers !== 'undefined') nsoHelpers.owner('cutplate', {
  live: cutPlateOn,
  close: function () { closeCutter(false); },
  clear: cutPlateRemoveHelper,
  refresh: function () { if (cutPlateOn()) { cutPlateBuildHelper(); cutPlateSync(); } }
});

if (typeof document !== 'undefined') cutPlateWire();
