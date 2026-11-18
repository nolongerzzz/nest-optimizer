/* ============================================================
   Cut card, Plane blade - shave an end off a piece, flat.

   The Plane button on the Blade row (beside Chop, Dice and Notch) uses the same blade as Chop - slider, mm box, mitre, bevel - but
   throws one side away instead of keeping two pieces: the NEARER end comes off, all the way across, and the cut face is capped flat
   (a mitre or a bevel slants it). Two things differ from Chop:

     - There is no 1 mm minimum. Chop keeps 1 mm on each side of the blade (MIN_CUT_SIDE_MM, app-core.js) because it makes two
       pieces and neither may be a sliver. Plane makes one, so the blade may stand CUT_PLANE_END_MM (0.1 mm, the grid step) from
       either end: it can take off the 0.16 mm a thicken left standing on an end face and nothing more.
     - One piece comes out, in the place the piece stood, with its pose; no gap opens and no second piece is made.

   It is the same engine as Chop (cutSplitAt -> rawCut: weld, clip at the plane, cap flat), so a Plane leaves a closed piece the way a
   Chop does. The half that goes is computed and dropped. One Undo (the Cut card's own splitReplace) puts the piece back.
   After app-cut.js (cutSplitAt) and before it is used: app-cut.js reads cutPlaneOn / CUT_PLANE_END_MM at call time.
   ============================================================ */

const CUT_PLANE_END_MM = 0.1;

/** Is the Plane blade the live one? */
function cutPlaneOn() {
  return !!(typeof state !== 'undefined' && state.cutterOpen && (state.cutTool || 'cut') === 'cut' &&
    state.cutBlade && state.cutBlade.mode === 'plane');
}

/** Which end comes off a piece `span` mm long with the blade `mm` from its low end: the nearer one (the low end at the middle). */
function cutPlaneTakesLow(mm, span) { return mm <= span - mm + 1e-9; }

/** Every piece's pose on the plate, and the snapshots Undo puts back (the same ones Cut takes, app-join.js cutActiveModel). */
function cutPlaneSnapshots(m) {
  const poseById = {};
  (state.placed || []).forEach(function (pl) {
    if (pl && pl.sourceId != null) {
      poseById[pl.sourceId] = { x: pl.x, z: pl.z, rotY: pl.rotY || 0, flipX: !!pl.flipX, tipX: pl.tipX || 0, tipZ: pl.tipZ || 0,
                                tiltX: pl.tiltX || 0, tiltZ: pl.tiltZ || 0, liftY: pl.liftY || 0 };
    }
  });
  const sourcePose = poseById[m.id] || { x: 0, z: 0 };
  const source = {
    id: m.id, name: m.name, geometry: m.geometry.clone(), quantity: m.quantity || 1,
    size: { x: m.size.x, y: m.size.y, z: m.size.z }, orientedGeometry: null,
    rawTris: m.rawTris || null, rawAxis: m.rawAxis || null, centerOffset: m.centerOffset || null,
    plateX: sourcePose.x, plateZ: sourcePose.z
  };
  const siblings = state.models.filter(function (x) { return x.id !== m.id; }).map(function (sib) {
    const pose = poseById[sib.id] || { x: 0, z: 0 };
    return {
      id: sib.id, name: sib.name, geometry: sib.geometry, quantity: sib.quantity || 1,
      size: sib.size ? { x: sib.size.x, y: sib.size.y, z: sib.size.z } : { x: 1, y: 1, z: 1 }, orientedGeometry: null,
      rawTris: sib.rawTris || null, rawAxis: sib.rawAxis || null, centerOffset: sib.centerOffset || null,
      plateX: pose.x, plateZ: pose.z
    };
  });
  return { poseById: poseById, sourcePose: sourcePose, source: source, siblings: siblings };
}

/** The Cut press with the Plane blade on (app-join.js cutActiveModel hands it here): take the nearer end of `m` off at `info`
    (getCutPlaneForSplit) and keep the rest, in place. Returns what happened, for the checks: { ok, keptMm, tookMm, end } or { ok:false, why }. */
function cutPlaneRun(m, info) {
  const fail = function (why) { setStatus(why, true); return { ok: false, why: why }; };
  const span = info.span, axis = info.axis, plateAxis = info.plateAxis || axis;
  const mm = info.mm != null ? info.mm : (info.plane - info.origin);
  const end = CUT_PLANE_END_MM;
  if (span < end * 2) return fail('Piece too short to plane');
  if (mm < end - 1e-6 || mm > span - end + 1e-6) return fail('Plane: keep at least ' + end + ' mm on each side of the red plane');
  const takeLow = cutPlaneTakesLow(mm, span);
  let pair;
  try {
    pair = cutSplitAt(m, info);
  } catch (err) {
    if (err && err.name === 'CutRefused') return fail('Plane not made: ' + err.message + '. The piece is unchanged - move the red plane and try again.');
    throw err;
  }
  const keep = takeLow ? pair.right : pair.left;
  if (!keep) return fail('Plane produced an empty piece - move the red plane');
  keep.computeBoundingBox();
  const bb = keep.boundingBox, sz = bb.getSize(new THREE.Vector3());
  if (!(sz.x >= 0.4 && sz.y >= 0.4 && sz.z >= 0.4)) return fail('Plane would leave a speck - move the red plane');
  const along = axis === 'x' ? sz.x : axis === 'y' ? sz.y : sz.z;

  const stay = bb.getCenter(new THREE.Vector3());          // where the kept piece's middle was, so it stays put
  keep.center();
  keep.computeBoundingBox();
  const snap = cutPlaneSnapshots(m);
  const prevEditId = state.editId, prevCutT = state.cutT, sourceId = m.id;

  state.models = state.models.filter(function (x) { return x.id !== sourceId; });   // the original goes first, as Cut does
  state.editId = null;
  const opts = pair.engine === 'raw'
    ? { keepSelection: true, silent: true, rawTris: takeLow ? pair.rawB : pair.rawA, rawAxis: 'zup', centerOffset: takeLow ? pair.centerOffsetB : pair.centerOffsetA }
    : { keepSelection: true, silent: true };
  const id = addModel(m.name, keep, opts);
  if (id == null) {
    state.models.push(snap.source);
    state.editId = snap.source.id;
    return fail('Plane failed to make the piece - original restored');
  }
  pushUndo({ type: 'splitReplace', source: snap.source, newIds: [id], siblings: snap.siblings, editId: prevEditId, cutT: prevCutT });

  const made = state.models.find(function (x) { return x.id === id; });
  state.selectedIndex = -1;
  state.joinPartnerId = null; state.joinThirdId = null; state.joinFaceC = null; state.joinSession = false; state.joinArmed = null;
  state.cutT = 0.5;
  renderModelList();
  updateEditSize();
  updateOptimizeButton();
  state.cutterOpen = true;
  removeCutHelper();
  state.previewMesh = null;
  layoutAfterSplit(snap.sourcePose, snap.poseById, sourceId, made, null, plateAxis, stay, stay, null, true);   // true: no gap opens
  state.cutterOpen = true;
  state.editId = null;
  removeCutHelper();
  state.previewMesh = null;
  if (typeof clearSelectionOutline === 'function') clearSelectionOutline();
  if (typeof paintJoinHighlights === 'function') paintJoinHighlights();
  updateCutterUI();
  updateUndoBtn();

  const took = takeLow ? mm : span - mm;
  setStatus('Plane @ ' + mm.toFixed(1) + ' mm' + (info.deg ? ', mitre ' + info.deg + '°' : '') + (info.bevel ? ', bevel ' + info.bevel + '°' : '') +
    ': took ' + took.toFixed(1) + ' mm off the ' + (takeLow ? 'low' : 'high') + ' end, ' + m.name + ' is now ' + along.toFixed(1) + ' mm. Undo: ' + state.undoStack.length + '.');
  return { ok: true, tookMm: took, keptMm: along, end: takeLow ? 'low' : 'high', id: id };
}
