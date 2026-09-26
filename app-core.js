/* THREE, OrbitControls, STLLoader loaded as globals from index.html */

// ===================== Plate Presets =====================
const PLATES = {
  a1mini: { name: 'Bambu A1 Mini', w: 180, d: 180 },
  a1:     { name: 'Bambu A1 / P1S / X1C', w: 256, d: 256 },
  prusa:  { name: 'Prusa MK4 / MK3S', w: 250, d: 210 },
  ender:  { name: 'Creality Ender 3', w: 220, d: 220 },
  custom: { name: 'Custom', w: 180, d: 180 }
};

// ===================== State =====================
const state = {
  plate: 'a1mini',
  models: [],
  placed: [],
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  plateMesh: null,
  plateGrid: null,
  // Plate grid: 'on' | 'off' | 'auto'. auto = visible only while a piece is
  // actually being positioned. Snap is a separate, off-by-default assist.
  plateGridMode: 'auto',
  plateGridSnap: false,
  plateGridAutoHoldUntil: 0,
  plateBorder: null,
  plateTicks: [],
  modelGroup: null,
  ready: false,
  selectedIndex: -1,
  raycaster: null,
  pointer: null,
  editId: null,
  cutT: 0.5,
  cutDragging: false,
  cutHelper: null,
  previewMesh: null,
  cutterOpen: false,
  moveDragging: false,
  moveIndex: -1,
  moveGrab: { x: 0, z: 0 },
  moveUndoFrom: null,
  undoStack: [],
  cameraFramed: false,
  cutAxis: null,
  // The plate lock (app-poslock.js): one flag for the whole arrangement,
  // deliberately NOT a per-piece m.posLock. Read through nsoPlateLocked().
  plateLock: false,
  joinPartnerId: null,
  joinHullId: null,
  joinPickMode: false,
  joinArmed: null,
  joinSession: false,
  joinFaceA: null,
  joinFaceB: null,
  /* Triple join's third slot. Held here with the rest of the Join slots so
     the one place that clears a Join session clears this too - a stale C is
     exactly the kind of leftover that makes a pair tool act on a piece the
     user thinks they retired. See app-join-triple.js. */
  joinThirdId: null,
  joinFaceC: null,
  joinUseFaces: false,
  faceHelper: null,
  softenArmed: false,
  capArmed: false,
  // Center lock: armed = the next canvas click picks the target point on A;
  // target = the point it picked, tagged with the piece it was picked on.
  centerLockArmed: false,
  centerLockTarget: null,
  // The one stored face pick: set by storeFacePick, read by getFacePick.
  facePick: null,
  edgeTreat: 'fillet',
  xray: false
};

let nextId = 1;
function getSTLLoader() {
  if (typeof THREE === 'undefined') throw new Error('THREE missing');
  const Ctor = THREE.STLLoader;
  if (!Ctor) throw new Error('THREE.STLLoader missing - check script tags');
  return new Ctor();
}
const loader = { parse: function (data) { return getSTLLoader().parse(data); } };

const NUDGE_MM = 2;
const UNDO_MAX = 40;
const MIN_CUT_SIDE_MM = 1; // allow 1 mm steps; still refuse zero-width
const KERF_MM = 1.0; // material removed at the blade — join still kisses this
const SPLIT_VIEW_GAP_MM = 8; // extra plate space after split so edges are readable. Not cut.
const PIECE_COLOR = 0x38bdf8;
const SELECT_COLOR = 0xf43f5e;
const CHAMFER_MM = 0.8; // mild soft edge on cut face (bevel band)
const CHAMFER_MITER = 2.0; // miter limit - sharp corners become bevels

function updateUndoBtn() {
  const btn = document.getElementById('btn-undo');
  if (!btn) return;
  const has = state.undoStack.length > 0;
  btn.disabled = !has;
  btn.classList.toggle('is-ready', has);
  btn.title = has ? ('Undo (' + state.undoStack.length + ') - Ctrl+Z') : 'Nothing to undo yet';
}
function pushUndo(entry) {
  if (!entry || !entry.type) return;
  // A mesh swap and the paint on it belong to the same step: snapshot the
  // paint here so one Undo puts back both without every call site knowing.
  if (entry.prevMask === undefined && entry.modelId != null && typeof nsoMaskSnapshot === 'function') {
    const mm = state.models.find(x => x.id === entry.modelId);
    if (mm) entry.prevMask = nsoMaskSnapshot(mm);
  }
  // The non-solid flag is part of the same step for the same reason: a bake
  // that hands back a piece carrying a second, free-hanging shell sets it
  // (Skin's free layer), so one Undo has to take it off with the geometry.
  if (entry.prevNonSolid === undefined && entry.modelId != null) {
    const mn = state.models.find(x => x.id === entry.modelId);
    if (mn) entry.prevNonSolid = !!mn.nonSolid;
  }
  // And the skin provenance record (app-skin.js), for the third time the same
  // reason: a Skin bake writes it about the geometry it just made, so undoing
  // that geometry has to take the record with it or the piece would claim a
  // relief it no longer has.
  if (entry.prevSkin === undefined && entry.modelId != null) {
    const ms = state.models.find(x => x.id === entry.modelId);
    if (ms) entry.prevSkin = ms.skin || null;
  }
  state.undoStack.push(entry);
  if (state.undoStack.length > UNDO_MAX) state.undoStack.shift();
  updateUndoBtn();
}
function clearUndo() {
  state.undoStack = [];
  updateUndoBtn();
}
/* The ops that undo by putting one piece's geometry back, and what each one
   calls itself on the status line. It is the gate as well as the label: a type
   absent from here is not handled by that branch, so a new op is one row, not a
   condition in two places that can disagree. Read with hasOwnProperty, never as
   a bare truthiness test: an entry type of 'constructor' would otherwise walk
   the prototype chain and enter a branch that expects prevGeometry. */
const UNDO_REPLACE_LABEL = {
  softenReplace: 'Undo: Soften reverted',
  capReplace: 'Undo: Cap reverted',
  sealReplace: 'Undo: Seal reverted',
  solidifyReplace: 'Undo: Solidify reverted',
  thickenReplace: 'Undo: Thicken reverted',
  smoothReplace: 'Undo: Smooth reverted',
  skinReplace: 'Undo: Skin reverted',
  textureReplace: 'Undo: Texture reverted',
  carveReplace: 'Undo: Carve reverted',
  scaleReplace: 'Undo: Scale reverted',
  deleteReplace: 'Undo: Delete reverted',
  brushReplace: 'Undo: Brush reverted',
  seatSurfaceReplace: 'Undo: Seat here reverted',
  extendReplace: 'Undo: Extend reverted',
  mirrorReplace: 'Undo: Mirror reverted',
  cropReplace: 'Undo: Crop reverted',
  cropMove: 'Undo: Move reverted',
  wheelReplace: 'Undo: Pottery Wheel reverted',
  hollowReplace: 'Undo: Hollow reverted',
  fillReplace: 'Undo: Fill reverted',
  fattenReplace: 'Undo: Fatten reverted',
  attachReplace: 'Undo: Attach reverted',
  stockReplace: 'Undo: Stock adjustment reverted'
};

function undoLast() {
  if (typeof removeFaceHelper === 'function') removeFaceHelper();
  const entry = state.undoStack.pop();
  updateUndoBtn();
  if (!entry) { setStatus('Nothing to undo'); return; }
  if (entry.type === 'addModels') {
    const ids = new Set(entry.ids || []);
    state.models = state.models.filter(m => !ids.has(m.id));
    // Remove cloned pieces from the plate too
    const kept = [];
    state.placed.forEach(p => {
      if (p && p.sourceId != null && ids.has(p.sourceId)) {
        if (p.mesh && p.mesh.parent) p.mesh.parent.remove(p.mesh);
        if (p.mesh && p.mesh.material) {
          if (Array.isArray(p.mesh.material)) p.mesh.material.forEach(m => m.dispose());
          else p.mesh.material.dispose();
        }
      } else {
        kept.push(p);
      }
    });
    state.placed = kept;
    state.placed.forEach((p, i) => { if (p.mesh) p.mesh.userData.placedIndex = i; });
    state.selectedIndex = -1;
    if (entry.editId != null && state.models.some(m => m.id === entry.editId)) state.editId = entry.editId;
    else state.editId = state.models.length ? state.models[state.models.length - 1].id : null;
    if (entry.cutT != null) state.cutT = entry.cutT;
    renderModelList(); updateOptimizeButton(); updateCutterUI(); updateEditSize(); updateAdjustUI();
    if (state.cutterOpen && state.editId) showEditPreview();
    else if (!state.models.length) { clearDisplayMeshes(); removeCutHelper(); state.previewMesh = null; }
    setStatus('Undo: removed cloned pieces');
    return;
  }
  if (entry.type === 'supportSwap') {
    // G-scope's individual support edits (app-gscope-support.js): Remove takes
    // one support piece off, Apply replaces it with a regenerated one. Undo
    // takes any piece the step added back off, and puts every removed piece
    // back - its model AND its placed entry, mesh and exact position kept -
    // where it was. One support is one whole piece, so this is the addModels /
    // removePlaced pair folded into one step, and it restores the model list
    // too, which removePlaced does not.
    const added = new Set(entry.addedIds || []);
    state.models = state.models.filter(m => !added.has(m.id));
    const kept = [];
    state.placed.forEach(p => {
      if (p && p.sourceId != null && added.has(p.sourceId)) {
        if (p.mesh && p.mesh.parent) p.mesh.parent.remove(p.mesh);
      } else {
        kept.push(p);
      }
    });
    state.placed = kept;
    (entry.removed || []).slice().reverse().forEach(r => {
      if (r.model && !state.models.some(m => m.id === r.model.id)) {
        state.models.splice(Math.min(r.modelIndex, state.models.length), 0, r.model);
      }
      if (r.placed) {
        state.placed.splice(Math.min(r.placedIndex, state.placed.length), 0, r.placed);
        if (r.placed.mesh && state.modelGroup) state.modelGroup.add(r.placed.mesh);
      }
    });
    state.placed.forEach((p, i) => { if (p.mesh) p.mesh.userData.placedIndex = i; });
    state.selectedIndex = -1;
    renderModelList(); updateOptimizeButton(); updateEditSize(); updateAdjustUI();
    setStatus(entry.label || 'Undo: support edit reverted');
    return;
  }
  if (entry.type === 'splitReplace') {
    // Remove the two halves, restore the single original, clear plate view
    const ids = new Set(entry.newIds || []);
    const keptSiblings = (entry.siblings && entry.siblings.length)
      ? entry.siblings.slice()
      : state.models.filter(m => !ids.has(m.id) && (!entry.source || m.id !== entry.source.id));
    state.models = keptSiblings.slice();
    if (entry.source) {
      state.models.push(entry.source);
      state.editId = entry.source.id;
    } else if (entry.editId != null) {
      state.editId = entry.editId;
    }
    if (entry.cutT != null) state.cutT = entry.cutT;
    state.cutterOpen = false;
    state.previewMesh = null;
    state.selectedIndex = -1;
    removeCutHelper();
    clearPlaced();
    clearDisplayMeshes();
    renderModelList();
    updateOptimizeButton();
    updateCutterUI();
    updateEditSize();
    if (state.models.length >= 1) layoutUndoModels(state.models);
    updateAdjustUI();
    updateUndoBtn();
    setStatus('Undo: ' + state.models.length + ' piece(s) on plate');
    return;
  }
  if (entry.type === 'joinReplace') {
    const mA = state.models.find(x => x.id === entry.aId);
    if (!mA) { setStatus('Undo: piece no longer exists'); return; }
    if (entry.aPrevMask !== undefined && typeof nsoMaskRestore === 'function') nsoMaskRestore(mA, entry.aPrevMask);
    mA.geometry = entry.aPrevGeometry;
    mA.rawTris = entry.aPrevRawTris;
    mA.rawAxis = entry.aPrevRawAxis;
    mA.centerOffset = entry.aPrevCenterOffset;
    mA.size = { x: entry.aPrevSize.x, y: entry.aPrevSize.y, z: entry.aPrevSize.z };

    // Restore B into the library.
    const bIdx = Math.min(entry.bSnapshot ? state.models.length : 0, state.models.length);
    if (entry.bSnapshot) state.models.splice(bIdx, 0, entry.bSnapshot);

    const placedA = state.placed.find(p => p && p.sourceId === mA.id);
    if (placedA) {
      const px = placedA.x, pz = placedA.z;
      if (placedA.mesh && state.modelGroup) {
        state.modelGroup.remove(placedA.mesh);
        if (placedA.mesh.material) {
          if (Array.isArray(placedA.mesh.material)) placedA.mesh.material.forEach(mt => mt.dispose());
          else placedA.mesh.material.dispose();
        }
      }
      const matA = new THREE.MeshStandardMaterial({
        color: 0x38bdf8, metalness: 0.05, roughness: 0.4,
        emissive: 0x0a3a5c, emissiveIntensity: 0.25
      });
      const meshA = new THREE.Mesh(mA.geometry, matA);
      meshA.position.set(px, mA.size.y / 2 + 0.3, pz);
      meshA.userData.sourceId = mA.id;
      state.modelGroup.add(meshA);
      placedA.mesh = meshA;
      placedA.geometry = mA.geometry;
      placedA.width = mA.size.x;
      placedA.depth = mA.size.z;
      placedA.height = mA.size.y;
      // Join/Subtract cleared A's pose when they drew the result at
      // identity. Undo puts the pre-op geometry back, so the pose goes back
      // with it, on the record and on the mesh.
      if (entry.aPrevPose) {
        Object.assign(placedA, entry.aPrevPose);
        nsoReseatPlacedPose(placedA);
      }
    }
    if (entry.bSnapshot && entry.poseB && state.modelGroup) {
      const matB = new THREE.MeshStandardMaterial({
        color: 0x4ade80, metalness: 0.05, roughness: 0.4,
        emissive: 0x14532d, emissiveIntensity: 0.2
      });
      const meshB = new THREE.Mesh(entry.bSnapshot.geometry, matB);
      meshB.position.set(entry.poseB.x, entry.bSnapshot.size.y / 2 + 0.3, entry.poseB.z);
      meshB.userData.sourceId = entry.bSnapshot.id;
      state.modelGroup.add(meshB);
      const insertAt = (entry.placedBIndex >= 0 && entry.placedBIndex <= state.placed.length)
        ? entry.placedBIndex : state.placed.length;
      state.placed.splice(insertAt, 0, {
        mesh: meshB, geometry: entry.bSnapshot.geometry, name: entry.bSnapshot.name,
        x: entry.poseB.x, z: entry.poseB.z,
        width: entry.bSnapshot.size.x, depth: entry.bSnapshot.size.z, height: entry.bSnapshot.size.y,
        yaw: 0, rotY: 0, flipX: false, tipX: 0, overflow: false, sourceId: entry.bSnapshot.id, outline: null
      });
      reindexPlacedMeshes();
    }
    updateEditSize();
    renderModelList();
    updateAdjustUI();
    updateUndoBtn();
    setStatus('Undo: Join reverted - two pieces restored');
    return;
  }
  if (entry.type === 'subtractReplace') {
    const mA = state.models.find(x => x.id === entry.aId);
    if (!mA) { setStatus('Undo: piece no longer exists'); return; }
    if (entry.aPrevMask !== undefined && typeof nsoMaskRestore === 'function') nsoMaskRestore(mA, entry.aPrevMask);
    mA.geometry = entry.aPrevGeometry;
    mA.rawTris = entry.aPrevRawTris;
    mA.rawAxis = entry.aPrevRawAxis;
    mA.centerOffset = entry.aPrevCenterOffset;
    mA.size = { x: entry.aPrevSize.x, y: entry.aPrevSize.y, z: entry.aPrevSize.z };

    const bIdx = Math.min(entry.bSnapshot ? state.models.length : 0, state.models.length);
    if (entry.bSnapshot) state.models.splice(bIdx, 0, entry.bSnapshot);

    const placedA = state.placed.find(p => p && p.sourceId === mA.id);
    if (placedA) {
      const px = placedA.x, pz = placedA.z;
      if (placedA.mesh && state.modelGroup) {
        state.modelGroup.remove(placedA.mesh);
        if (placedA.mesh.material) {
          if (Array.isArray(placedA.mesh.material)) placedA.mesh.material.forEach(mt => mt.dispose());
          else placedA.mesh.material.dispose();
        }
      }
      const matA = new THREE.MeshStandardMaterial({
        color: 0x38bdf8, metalness: 0.05, roughness: 0.4,
        emissive: 0x0a3a5c, emissiveIntensity: 0.25
      });
      const meshA = new THREE.Mesh(mA.geometry, matA);
      meshA.position.set(px, mA.size.y / 2 + 0.3, pz);
      meshA.userData.sourceId = mA.id;
      state.modelGroup.add(meshA);
      placedA.mesh = meshA;
      placedA.geometry = mA.geometry;
      placedA.width = mA.size.x;
      placedA.depth = mA.size.z;
      placedA.height = mA.size.y;
      // Join/Subtract cleared A's pose when they drew the result at
      // identity. Undo puts the pre-op geometry back, so the pose goes back
      // with it, on the record and on the mesh.
      if (entry.aPrevPose) {
        Object.assign(placedA, entry.aPrevPose);
        nsoReseatPlacedPose(placedA);
      }
    }
    if (entry.bSnapshot && entry.poseB && state.modelGroup) {
      const matB = new THREE.MeshStandardMaterial({
        color: 0x4ade80, metalness: 0.05, roughness: 0.4,
        emissive: 0x14532d, emissiveIntensity: 0.2
      });
      const meshB = new THREE.Mesh(entry.bSnapshot.geometry, matB);
      meshB.position.set(entry.poseB.x, entry.bSnapshot.size.y / 2 + 0.3, entry.poseB.z);
      meshB.userData.sourceId = entry.bSnapshot.id;
      state.modelGroup.add(meshB);
      const insertAt = (entry.placedBIndex >= 0 && entry.placedBIndex <= state.placed.length)
        ? entry.placedBIndex : state.placed.length;
      state.placed.splice(insertAt, 0, {
        mesh: meshB, geometry: entry.bSnapshot.geometry, name: entry.bSnapshot.name,
        x: entry.poseB.x, z: entry.poseB.z,
        width: entry.bSnapshot.size.x, depth: entry.bSnapshot.size.z, height: entry.bSnapshot.size.y,
        yaw: 0, rotY: 0, flipX: false, tipX: 0, overflow: false, sourceId: entry.bSnapshot.id, outline: null
      });
      reindexPlacedMeshes();
    }
    updateEditSize();
    renderModelList();
    updateAdjustUI();
    updateUndoBtn();
    setStatus('Undo: Subtract reverted - two pieces restored');
    return;
  }
  if (entry.type === 'nonSolidReplace') {
    const m = state.models.find(x => x.id === entry.modelId);
    if (!m) { setStatus('Undo: piece no longer exists'); return; }
    m.nonSolid = !!entry.prev;
    if (typeof nsoNonSolidRefresh === 'function') nsoNonSolidRefresh();
    updateUndoBtn();
    setStatus('Undo: non-solid flag ' + (m.nonSolid ? 'restored' : 'cleared') + ' on ' + m.name);
    return;
  }
  if (entry.type === 'posLockReplace') {
    const m = state.models.find(x => x.id === entry.modelId);
    if (!m) { setStatus('Undo: piece no longer exists'); return; }
    m.posLock = !!entry.prev;
    updateAdjustUI();
    if (typeof nsoPosLockRefresh === 'function') nsoPosLockRefresh();
    updateUndoBtn();
    setStatus('Undo: position lock ' + (m.posLock ? 'restored' : 'cleared') + ' on ' + m.name);
    return;
  }
  if (entry.type === 'plateLockReplace') {
    state.plateLock = !!entry.prev;
    updateAdjustUI();
    if (typeof nsoPosLockRefresh === 'function') nsoPosLockRefresh();
    updateUndoBtn();
    setStatus('Undo: plate lock ' + (state.plateLock ? 'restored' : 'cleared') +
      ' - the per-piece locks were never touched by it');
    return;
  }
  if (entry.type === 'maskReplace') {
    const m = state.models.find(x => x.id === entry.modelId);
    if (!m) { setStatus('Undo: piece no longer exists'); return; }
    if (typeof nsoMaskRestore === 'function') nsoMaskRestore(m, entry.prevMask);
    else m.faceMask = { exclude: entry.prevMask || [] };
    updateUndoBtn();
    const undoSel = (typeof nsoMaskSelected === 'function') ? nsoMaskSelected(m) : null;
    setStatus('Undo: paint reverted - ' +
      ((m.faceMask && m.faceMask.exclude) ? m.faceMask.exclude.length : 0) + ' face(s) excluded, target ' +
      (undoSel && typeof nsoMaskFaceName === 'function' ? nsoMaskFaceName(undoSel).replace(/^the /, '') : 'none'));
    return;
  }
  /* One branch for every op that swaps a piece's geometry in place. A carve is
     one of them: the blade is never a placed piece, so unlike Subtract there is
     no partner to put back - only this piece's geometry. A brush stroke is
     another: the whole drag is one swap, so one entry puts the whole stroke
     back rather than one dab of it. */
  if (Object.prototype.hasOwnProperty.call(UNDO_REPLACE_LABEL, entry.type)) {
    const m = state.models.find(x => x.id === entry.modelId);
    if (!m) { setStatus('Undo: piece no longer exists'); return; }
    // the paint set is part of the piece's state, so one step puts back both
    if (entry.prevMask !== undefined && typeof nsoMaskRestore === 'function') nsoMaskRestore(m, entry.prevMask);
    if (entry.prevNonSolid !== undefined && !!m.nonSolid !== entry.prevNonSolid) {
      m.nonSolid = entry.prevNonSolid;
      if (typeof nsoNonSolidRefresh === 'function') nsoNonSolidRefresh();
    }
    if (entry.prevSkin !== undefined) m.skin = entry.prevSkin;
    m.geometry = entry.prevGeometry;
    m.rawTris = entry.prevRawTris;
    m.rawAxis = entry.prevRawAxis;
    m.centerOffset = entry.prevCenterOffset;
    m.size = { x: entry.prevSize.x, y: entry.prevSize.y, z: entry.prevSize.z };
    const placedEntry = state.placed.find(p => p && p.sourceId === m.id);
    if (placedEntry) {
      const px = placedEntry.x, pz = placedEntry.z;
      if (placedEntry.mesh && state.modelGroup) {
        state.modelGroup.remove(placedEntry.mesh);
        if (placedEntry.mesh.material) {
          if (Array.isArray(placedEntry.mesh.material)) placedEntry.mesh.material.forEach(mt => mt.dispose());
          else placedEntry.mesh.material.dispose();
        }
      }
      const mat = new THREE.MeshStandardMaterial({
        color: 0x38bdf8, metalness: 0.05, roughness: 0.4,
        emissive: 0x0a3a5c, emissiveIntensity: 0.25
      });
      const mesh = new THREE.Mesh(m.geometry, mat);
      mesh.position.set(px, m.size.y / 2 + 0.3, pz);
      mesh.userData.sourceId = m.id;
      mesh.userData.placedIndex = state.placed.indexOf(placedEntry);
      state.modelGroup.add(mesh);
      placedEntry.mesh = mesh;
      placedEntry.geometry = m.geometry;
      placedEntry.width = m.size.x;
      placedEntry.depth = m.size.z;
      placedEntry.height = m.size.y;
      // The old geometry is back in the piece's own frame and the pose on the
      // record still stands, so put it on the fresh mesh. Without this an
      // Undo of Mirror on a posed piece drew it unposed while the record and
      // the export kept the pose. An op with a prevPose re-seats it below.
      if (!entry.prevPose) nsoReseatPlacedPose(placedEntry);
    } else if (state.cutterOpen && state.editId === m.id) {
      showEditPreview();
    }
    /* The paint was put back at the top of this branch, but nsoMaskRestore
       repaints against whatever mesh was in the scene AT THAT MOMENT - the
       post-op one, which no longer has the faces the restored lists name. The
       overlay it built was therefore empty, and nothing rebuilt it once the
       old mesh went back in below. So the lists came back and the yellow and
       the pink did not, which reads as "undo lost my paint". Repaint here,
       after the placed instance is re-seated, and it lands on the geometry the
       clicks were made against. */
    if (typeof nsoMaskRepaint === 'function') nsoMaskRepaint();
    /* An op that moved the piece as well as reshaping it puts the pose back
       here, in the SAME entry, so it is still one Undo per op. Seat here is
       the first: it bakes a free rotation into the soup (the pose model
       cannot hold one - see app-seat-surface.js) and then re-fits x / z /
       liftY to it, so restoring the geometry alone would leave the piece
       in the seated position with its old shape. */
    if (entry.prevPose && placedEntry) {
      placedEntry.x = entry.prevPose.x; placedEntry.z = entry.prevPose.z;
      placedEntry.rotY = entry.prevPose.rotY || 0;
      placedEntry.flipX = !!entry.prevPose.flipX;
      placedEntry.tipX = entry.prevPose.tipX || 0;
      placedEntry.tipZ = entry.prevPose.tipZ || 0;
      placedEntry.liftY = entry.prevPose.liftY || 0;
      placedEntry.tiltX = entry.prevPose.tiltX || 0;
      placedEntry.tiltZ = entry.prevPose.tiltZ || 0;
      applyMeshRotation(placedEntry);
      if (typeof refreshOutline === 'function') refreshOutline(placedEntry);
      applyPlacedXZ(placedEntry, placedEntry.x, placedEntry.z);
    }
    updateEditSize();
    renderModelList();
    updateUndoBtn();
    setStatus(UNDO_REPLACE_LABEL[entry.type]);
    return;
  }
  if (entry.type === 'removeModel') {
    const m = entry.model;
    if (!m) return;
    const at = Math.min(entry.index ?? state.models.length, state.models.length);
    state.models.splice(at, 0, m);
    if (entry.editId != null) state.editId = entry.editId;
    renderModelList(); updateOptimizeButton(); updateCutterUI(); updateEditSize();
    if (state.cutterOpen && state.editId) showEditPreview();
    setStatus('Undo: restored model ' + (m.name || ''));
    return;
  }
  if (entry.type === 'removePlaced') {
    const p = entry.item;
    if (!p) return;
    const at = Math.min(entry.index ?? state.placed.length, state.placed.length);
    if (!p.mesh && p.geometry) {
      const mat = new THREE.MeshStandardMaterial({
        color: 0x38bdf8, metalness: 0.05, roughness: 0.4,
        emissive: 0x0a3a5c, emissiveIntensity: 0.25
      });
      p.mesh = new THREE.Mesh(p.geometry, mat);
    }
    if (p.mesh && state.modelGroup) {
      p.mesh.position.set(p.x, p.height / 2 + 0.2, p.z);
      state.modelGroup.add(p.mesh);
    }
    state.placed.splice(at, 0, p);
    reindexPlacedMeshes();
    state.selectedIndex = at;
    updateAdjustUI();
    setStatus('Undo: restored piece on plate');
    return;
  }
  if (entry.type === 'movePlaced') {
    const p = state.placed[entry.index];
    if (!p) return;
    applyPlacedXZ(p, entry.x, entry.z);
    restoreMeshY(p, entry.meshY);
    state.selectedIndex = entry.index;
    updateAdjustUI();
    setStatus('Undo: moved piece back');
    return;
  }
  if (entry.type === 'posePlaced') {
    const p = state.placed[entry.index];
    if (!p) return;
    p.x = entry.x; p.z = entry.z;
    p.rotY = entry.rotY || 0;
    p.flipX = !!entry.flipX;
    p.tipX = entry.tipX || 0;
    p.tipZ = entry.tipZ || 0;
    p.liftY = entry.liftY || 0;
    p.tiltX = entry.tiltX || 0;
    p.tiltZ = entry.tiltZ || 0;
    p.width = entry.width; p.depth = entry.depth; p.height = entry.height;
    if (p.mesh) {
      applyMeshRotation(p);
      if (typeof refreshOutline === 'function') refreshOutline(p);
    }
    applyPlacedXZ(p, p.x, p.z);
    restoreMeshY(p, entry.meshY);
    state.selectedIndex = entry.index;
    updateAdjustUI();
    setStatus('Undo: restored pose');
    return;
  }
  setStatus('Undo: unknown action');
}

// ===================== Three.js Setup =====================
function initThree() {
  const container = document.getElementById('viewport');

  // Force a real size even if CSS hasn't fully applied yet
  let width = container.clientWidth || 600;
  let height = container.clientHeight || 400;
  if (height < 100) height = 400;

  state.scene = new THREE.Scene();
  state.scene.background = new THREE.Color(0x0b1a33);

  state.camera = new THREE.PerspectiveCamera(45, width / height, 1, 2000);
  state.camera.position.set(140, 160, 200);

  state.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  state.renderer.setSize(width, height);
  state.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  state.renderer.setClearColor(0x0b1a33, 1);
  container.innerHTML = ''; // clear any previous content
  container.appendChild(state.renderer.domElement);
  const cv = state.renderer.domElement;
  cv.style.display = 'block';
  cv.style.width = '100%';
  cv.style.height = '420px';
  cv.style.background = '#0b1a33';

  state.controls = new THREE.OrbitControls(state.camera, state.renderer.domElement);
  state.controls.enableDamping = true;
  state.controls.target.set(0, 0, 0);
  // Orbit only while left-dragging the plate (toggled in pointer handlers)
  state.controls.enableRotate = true;
  state.controls.enablePan = true;
  // Custom wheel handler below - Orbit zoom disabled so we can invert direction
  state.controls.enableZoom = false;
  state.controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: null
  };

  // Lights
  const ambient = new THREE.AmbientLight(0xffffff, 0.75);
  state.scene.add(ambient);
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(80, 150, 100);
  state.scene.add(dir);

  state.modelGroup = new THREE.Group();
  state.scene.add(state.modelGroup);

  state.raycaster = new THREE.Raycaster();
  state.pointer = new THREE.Vector2();

  buildPlateMesh();
  if (state.camera && state.controls) {
    state.camera.position.set(160, 180, 200);
    state.controls.target.set(0, 0, 0);
    state.controls.update();
  }
  state.ready = true;
  animate();

  window.addEventListener('resize', onResize);
  // Capture phase so we can gate OrbitControls before it sees the event
  state.renderer.domElement.addEventListener('pointerdown', onCanvasPointerDown, true);
  state.renderer.domElement.addEventListener('contextmenu', onCanvasContextMenu);
  // Invert scroll zoom: scroll-in / wheel-up -> closer; scroll-out -> farther
  state.renderer.domElement.addEventListener('wheel', onViewportWheel, { passive: false, capture: true });
  window.addEventListener('pointermove', onCanvasPointerMove);
  window.addEventListener('pointerup', onCanvasPointerUp);
  window.addEventListener('pointercancel', onCanvasPointerUp);
  window.addEventListener('pointerdown', (e) => {
    const menu = document.getElementById('ctx-menu');
    if (!menu || menu.classList.contains('hidden')) return;
    if (menu.contains(e.target)) return;
    hideCtxMenu();
  }, true);

  // Force one more resize after layout settles
  setTimeout(onResize, 150);
  setTimeout(onResize, 500);
}

function freezeCamera() {
  if (!state.camera || !state.controls) return null;
  return {
    px: state.camera.position.x,
    py: state.camera.position.y,
    pz: state.camera.position.z,
    tx: state.controls.target.x,
    ty: state.controls.target.y,
    tz: state.controls.target.z
  };
}

function restoreCamera(snap) {
  if (!snap || !state.camera || !state.controls) return;
  state.camera.position.set(snap.px, snap.py, snap.pz);
  state.controls.target.set(snap.tx, snap.ty, snap.tz);
  state.controls.update();
}

function onViewportWheel(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!state.camera || !state.controls) return;
  const delta = event.deltaY;
  if (!delta) return;
  // Flipped: deltaY < 0 (scroll up / in) -> closer; deltaY > 0 -> farther
  const scale = Math.pow(0.95, Math.min(8, Math.abs(delta) * 0.01));
  const offset = state.camera.position.clone().sub(state.controls.target);
  if (delta < 0) {
    // scroll in -> closer
    offset.multiplyScalar(scale);
  } else {
    // scroll out -> farther
    offset.multiplyScalar(1 / scale);
  }
  // Clamp distance so we never flip through the target
  const dist = offset.length();
  if (dist < 15) offset.setLength(15);
  if (dist > 1200) offset.setLength(1200);
  state.camera.position.copy(state.controls.target).add(offset);
  state.controls.update();
}

function onResize() {
  if (!state.renderer || !state.camera) return;
  const container = document.getElementById('viewport');
  if (!container) return;
  const w = Math.max(1, container.clientWidth || 600);
  const h = Math.max(1, container.clientHeight || 400);
  if (h < 50) return;

  state.camera.aspect = w / h;
  state.camera.updateProjectionMatrix();
  // false = don't let three.js write CSS that can blow past the grid column
  state.renderer.setSize(w, h, false);
  const canvas = state.renderer.domElement;
  if (canvas) {
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.style.maxWidth = '100%';
    canvas.style.maxHeight = '100%';
  }
}

function updatePlateByView() {
  if (!state.plateMesh || !state.camera || !state.plateMesh.material) return;
  const mat = state.plateMesh.material;
  const above = state.camera.position.y > 1.5;
  if (state.xray) {
    mat.opacity = 0.18;
    mat.transparent = true;
    mat.depthWrite = false;
    mat.depthTest = true;
    mat.color.setHex(0x1a2230);
    if ('emissiveIntensity' in mat) mat.emissiveIntensity = 0.04;
  } else if (above) {
    mat.opacity = 0.96;
    mat.transparent = true;
    mat.depthWrite = true;
    mat.depthTest = true;
    mat.color.setHex(0x16181c);
    if ('emissiveIntensity' in mat) mat.emissiveIntensity = 0.08;
  } else {
    mat.opacity = 0.08;
    mat.transparent = true;
    mat.depthWrite = false;
    mat.depthTest = true;
    mat.color.setHex(0x121416);
    if ('emissiveIntensity' in mat) mat.emissiveIntensity = 0.05;
  }
}

function animate() {
  requestAnimationFrame(animate);
  if (state.controls) state.controls.update();
  updatePlateByView();
  applyPlateGridVisibility();
  if (state.renderer && state.scene && state.camera) {
    state.renderer.render(state.scene, state.camera);
  }
}

/* ===================== Plate reference grid =====================
   A flat, world-aligned grid owned by the build plate. It is plate furniture,
   exactly like plateMesh / plateBorder / plateTicks: built by buildPlateMesh,
   added straight to state.scene and never to state.modelGroup, so no piece
   transform can move or rotate it. It sits in the plate's own plane, which is
   why a piece resting flat on the bed shows it on its underside for free - the
   two surfaces coincide.

   The bed is a plane at y = 0 (hitPlateXZ intersects exactly that plane), so
   the grid is a plane too. There is no curvature anywhere on this path and
   nothing here needs to handle any.

   It is drawn but never picked. raycast() is a no-op on both line sets, and
   hitPlateSurface does not list the grid among its targets - plateMesh already
   covers the same footprint, so plate-drag orbit is unaffected. The one and
   only way this grid can move a piece is grid-snap, a separate control that
   is off by default. */
const PLATE_GRID_STEP_MM = 10;        // minor spacing, and the snap lattice pitch
const PLATE_GRID_MAJOR_EVERY = 5;     // a heavier line every 5th minor line (50 mm)
const PLATE_GRID_Y = 0.15;            // above the bed at 0, below the border at 0.3
const PLATE_GRID_AUTO_HOLD_MS = 900;  // how long 'auto' lingers after a nudge

/* Put onto each line set in place of Object3D.prototype.raycast, so no ray
   can ever report a hit on the grid. */
function plateGridNeverRaycast() {}

function buildPlateGrid(p) {
  const hw = p.w / 2;
  const hd = p.d / 2;
  const minor = [];
  const major = [];
  const line = (arr, x1, z1, x2, z2) => arr.push(x1, 0, z1, x2, 0, z2);

  // Lines on the world lattice (multiples of the step from the plate centre),
  // clipped to the real plate - w and d, not a square of max(w, d).
  const kx = Math.floor(hw / PLATE_GRID_STEP_MM);
  for (let k = -kx; k <= kx; k++) {
    const x = k * PLATE_GRID_STEP_MM;
    line(k % PLATE_GRID_MAJOR_EVERY === 0 ? major : minor, x, -hd, x, hd);
  }
  const kz = Math.floor(hd / PLATE_GRID_STEP_MM);
  for (let k = -kz; k <= kz; k++) {
    const z = k * PLATE_GRID_STEP_MM;
    line(k % PLATE_GRID_MAJOR_EVERY === 0 ? major : minor, -hw, z, hw, z);
  }

  const group = new THREE.Group();
  group.position.y = PLATE_GRID_Y;
  group.userData.plateGrid = true;
  const addSet = (verts, color, opacity) => {
    if (!verts.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    const seg = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      color: color, transparent: true, opacity: opacity, depthWrite: false
    }));
    seg.raycast = plateGridNeverRaycast;   // purely visual - invisible to every pick
    seg.userData.skipXray = true;
    group.add(seg);
  };
  addSet(minor, 0x363d49, 0.8);
  addSet(major, 0x5a6578, 0.95);
  return group;
}

function disposePlateGrid(group) {
  if (!group) return;
  group.children.forEach(function (c) {
    if (c.geometry) c.geometry.dispose();
    if (c.material) c.material.dispose();
  });
}

function plateGridNow() {
  return (typeof performance !== 'undefined' && performance.now)
    ? performance.now() : Date.now();
}

/* 'auto' asks one question: is a piece being positioned right now? A pointer
   drag is the clear case; a nudge or a rotate is a positioning act too, but an
   instantaneous one, so those hold the grid up for a beat afterwards. */
function plateGridAutoActive() {
  if (state.moveDragging) return true;
  return plateGridNow() < (state.plateGridAutoHoldUntil || 0);
}

function plateGridWantsVisible() {
  if (state.plateGridMode === 'on') return true;
  if (state.plateGridMode === 'off') return false;
  return plateGridAutoActive();
}

function applyPlateGridVisibility() {
  if (state.plateGrid) state.plateGrid.visible = plateGridWantsVisible();
}

function holdPlateGridAuto(ms) {
  state.plateGridAutoHoldUntil = Math.max(
    state.plateGridAutoHoldUntil || 0,
    plateGridNow() + (ms || PLATE_GRID_AUTO_HOLD_MS)
  );
  applyPlateGridVisibility();
}

function syncPlateGridUI() {
  const sel = document.getElementById('plate-grid-show');
  if (sel && sel.value !== state.plateGridMode) sel.value = state.plateGridMode;
  const chk = document.getElementById('chk-plate-grid-snap');
  if (chk) chk.checked = !!state.plateGridSnap;
}

function setPlateGridMode(mode) {
  if (mode !== 'on' && mode !== 'off' && mode !== 'auto') return;
  state.plateGridMode = mode;
  applyPlateGridVisibility();
  syncPlateGridUI();
}

function setPlateGridSnap(on) {
  state.plateGridSnap = !!on;
  let note = state.plateGridSnap ? 'Grid snap on' : 'Grid snap off';
  /* Snap with the grid switched off is a legal state and stays reachable - the
     two controls are genuinely independent - but it is not one to fall into by
     accident, because the assist would pull pieces toward lines nobody can
     see. So turning snap on while the grid is off promotes the grid to auto,
     once, and says so. Set the grid back to off afterwards and snap keeps
     working: this is a signpost, not a constraint. */
  if (state.plateGridSnap && state.plateGridMode === 'off') {
    setPlateGridMode('auto');
    note += ' - grid shown while positioning so the lattice is visible';
  }
  syncPlateGridUI();
  setStatus(note);
}

/* ---- grid-snap: a soft pull, never a lock ----------------------------------
   Within the pull radius R, the cursor's offset d from the nearest lattice
   line maps to

       f(d) = sign(d) * R * ((1 - S) * u + S * u^2),   u = |d| / R

   Three properties are what make this an assist rather than a constraint:

     f(R) = R    - continuous with the untouched region outside the radius,
                   so nothing jumps as the pull starts or stops.
     f(0) = 0    - the lattice line is exactly reachable, not merely approached.
     f'(d) >= 1 - S > 0 everywhere - strictly increasing. The piece moves
                   whenever the cursor moves, in the same direction, so a drag
                   away from a line can never be blocked or reversed.

   S is how hard the detent bites. At S = 0.8 the piece tracks the cursor at
   20% speed right on the line, and the largest offset the assist can ever
   apply is max(d - f(d)) = S*R/4 = 1 mm. R = half the step, so every point on
   the bed is inside exactly one line's pull and the field has no seams. */
const PLATE_GRID_SNAP_STRENGTH = 0.8;
const PLATE_GRID_SNAP_RADIUS_MM = PLATE_GRID_STEP_MM / 2;

function plateGridSnapAxis(v) {
  const near = Math.round(v / PLATE_GRID_STEP_MM) * PLATE_GRID_STEP_MM;
  const d = v - near;
  const a = Math.abs(d);
  if (a >= PLATE_GRID_SNAP_RADIUS_MM) return v;
  const u = a / PLATE_GRID_SNAP_RADIUS_MM;
  const pulled = PLATE_GRID_SNAP_RADIUS_MM *
    ((1 - PLATE_GRID_SNAP_STRENGTH) * u + PLATE_GRID_SNAP_STRENGTH * u * u);
  return near + (d < 0 ? -pulled : pulled);
}

/* Applied to the piece's own placement origin (p.x / p.z), so the pull is
   toward the nearest grid intersection under the piece's own centre. Returns
   the point untouched when snap is off - this is the whole of the coupling
   between the grid and anything that moves. */
function plateGridSnapXZ(x, z) {
  if (!state.plateGridSnap) return { x: x, z: z };
  return { x: plateGridSnapAxis(x), z: plateGridSnapAxis(z) };
}

function buildPlateMesh() {
  if (state.plateMesh) {
    state.scene.remove(state.plateMesh);
    if (state.plateMesh.geometry) state.plateMesh.geometry.dispose();
  }
  if (state.plateGrid) {
    state.scene.remove(state.plateGrid);
    disposePlateGrid(state.plateGrid);
    state.plateGrid = null;
  }
  if (state.plateBorder) {
    state.scene.remove(state.plateBorder);
    state.plateBorder = null;
  }
  if (state.plateTicks && state.plateTicks.length) {
    state.plateTicks.forEach(t => {
      state.scene.remove(t);
      if (t.geometry) t.geometry.dispose();
      if (t.material) t.material.dispose();
    });
  }
  state.plateTicks = [];

  const p = getCurrentPlate();
  const geo = new THREE.PlaneGeometry(p.w, p.d);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x16181c,
    metalness: 0.05,
    roughness: 0.85,
    emissive: 0x0a0b0d,
    emissiveIntensity: 0.08,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.96,
    depthWrite: true
  });
  state.plateMesh = new THREE.Mesh(geo, mat);
  state.plateMesh.rotation.x = -Math.PI / 2;
  state.plateMesh.position.y = 0;
  state.plateMesh.receiveShadow = true;
  state.scene.add(state.plateMesh);

  // Reference grid on the floor - plate furniture, not a child of any piece
  state.plateGrid = buildPlateGrid(p);
  state.scene.add(state.plateGrid);
  applyPlateGridVisibility();

  // Bright cyan border so plate edge is obvious
  const edges = new THREE.EdgesGeometry(geo);
  const border = new THREE.LineSegments(
    edges,
    new THREE.LineBasicMaterial({ color: 0x38bdf8, linewidth: 2 })
  );
  border.rotation.x = -Math.PI / 2;
  border.position.y = 0.3;
  state.scene.add(border);
  state.plateBorder = border;

  // Corner ticks for orientation
  const tickMat = new THREE.LineBasicMaterial({ color: 0xfbbf24 });
  const tickLen = Math.min(p.w, p.d) * 0.06;
  const hw = p.w / 2;
  const hd = p.d / 2;
  const corners = [
    [[-hw, 0.35, -hd], [-hw + tickLen, 0.35, -hd], [-hw, 0.35, -hd + tickLen]],
    [[hw, 0.35, -hd], [hw - tickLen, 0.35, -hd], [hw, 0.35, -hd + tickLen]],
    [[-hw, 0.35, hd], [-hw + tickLen, 0.35, hd], [-hw, 0.35, hd - tickLen]],
    [[hw, 0.35, hd], [hw - tickLen, 0.35, hd], [hw, 0.35, hd - tickLen]]
  ];
  corners.forEach(pts => {
    const g = new THREE.BufferGeometry().setFromPoints(
      pts.map(v => new THREE.Vector3(v[0], v[1], v[2]))
    );
    const line = new THREE.Line(g, tickMat);
    state.scene.add(line);
    state.plateTicks.push(line);
  });

  // Frame camera only once on first plate build - never on upload/cutter/rebuild
  if (state.controls && !state.cameraFramed) {
    framePlateHome();
    state.cameraFramed = true;
  }
}

function getCurrentPlate() {
  if (state.plate === 'custom') {
    var ch = document.getElementById('custom-h');
    return {
      name: 'Custom',
      w: Number(document.getElementById('custom-w').value) || 180,
      d: Number(document.getElementById('custom-d').value) || 180,
      // Build height. PLATES has never carried one - the packer only ever
      // needed a footprint - and nso_printer.js is the thing that does.
      h: Number(ch && ch.value) || 180
    };
  }
  return PLATES[state.plate];
}

// ===================== Model Loading =====================
// Try to match Bambu (Z-up) in Three.js (Y-up).
// rotateX(-90 deg) is the standard mapping; export inverts it.
function zUpToYUp(geometry) {
  geometry.rotateX(-Math.PI / 2);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

const IMPORT_EXT_RE = /\.(stl|3mf)$/i;

function handleFiles(files) {
  const list = Array.from(files).filter(f => IMPORT_EXT_RE.test(f.name));

  if (!list.length) {
    setStatus('Please use STL or 3MF files', true);
    return;
  }

  list.forEach(file => {
    const reader = new FileReader();
    reader.onerror = () => setStatus(`Could not read ${file.name}`, true);
    reader.onload = (e) => {
      if (/\.3mf$/i.test(file.name)) {
        // A sliced project carries a toolpath (`Metadata/plate_N.gcode`) and
        // no readable model objects. It goes to G-scope - the one G-code tool -
        // and NOT onto the plate: a slice is something you look through, and
        // what leaves G-scope does so through its Export or Crop, by choice.
        // Recognised by CONTENT, never by the name: `.gcode.3mf` is not one
        // extension, and a slice renamed to `plate.3mf` used to fall through
        // to import3MF and fail with "No objects found in this 3MF".
        if (window.NSO_MICROSCOPE && window.NSO_MICROSCOPE.isSliced(e.target.result)) {
          window.NSO_MICROSCOPE.openFile(file.name, e.target.result);
          return;
        }
        import3MF(file.name, e.target.result);
        return;
      }
      try {
        const geometry = loader.parse(e.target.result);
        if (!geometry.attributes || !geometry.attributes.position) {
          throw new Error('Invalid geometry');
        }
        addModelFromZUpGeometry(file.name, geometry);
      } catch (err) {
        console.error(err);
        setStatus(`Failed to load ${file.name}. Try re-exporting as binary STL.`, true);
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

/**
 * The one ingest path for imported geometry. `geometry` is non-indexed, in the
 * file's own axes (Z up, millimetres, untranslated) - what STLLoader hands
 * back for an STL and what the 3MF reader builds per object.
 */
function addModelFromZUpGeometry(name, geometry, opts) {
  // Capture the raw triangle soup BEFORE rotateX/center - original
  // file axes, untranslated. This is what the sandbox cut engine
  // was validated against; the display mesh below is a transformed
  // copy for viewport/UI purposes only and is never read by rawCut.
  const rawTris = new Float32Array(geometry.attributes.position.array);
  geometry = zUpToYUp(geometry);
  geometry.computeVertexNormals();
  // Compute the center offset ourselves (THREE's .center() doesn't
  // return it) so Split can invert it later to map a display-space
  // plane back into raw, untranslated coordinates.
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const centerOffset = {
    x: (bb.min.x + bb.max.x) / 2,
    y: (bb.min.y + bb.max.y) / 2,
    z: (bb.min.z + bb.max.z) / 2
  };
  geometry.center();
  // Extra options ride through untouched, so the scene restore can ingest a
  // piece without the auto-placement and status line a fresh upload wants.
  const options = Object.assign({}, opts || {},
    { rawTris: rawTris, rawAxis: 'zup', centerOffset: centerOffset });
  return addModel(name, geometry, options);
}

/**
 * 3MF import. nso-3mf-read.js pulls one triangle soup per build item out of the
 * archive (millimetres, Z up, transforms applied); each becomes its own model,
 * named from the file's own object names.
 *
 * TWO ROUTES, decided by what the file carries:
 *
 *   an NSO scene block   Metadata/nso_scene.json, written by this app's own
 *                        export. The plate comes back as it was left: pose,
 *                        locks, seat gaps, skin, paint, the non-solid flags.
 *   anything else        geometry only, exactly as before - a file straight
 *                        from Bambu Studio or MakerWorld has no such part and
 *                        nothing here assumes one. A block this build cannot
 *                        read takes the same route, with a console warning.
 *
 * Print settings, materials and everything else in the archive are still
 * ignored on both routes.
 */
function import3MF(filename, arrayBuffer) {
  if (!window.NSO3MFRead) {
    setStatus('3MF reader failed to load - check console', true);
    return Promise.resolve(null);
  }
  setStatus(`Reading ${filename}...`);
  return window.NSO3MFRead.parse3MF(new Uint8Array(arrayBuffer), { name: filename })
    .then(result => {
      result.warnings.forEach(w => console.warn(`${filename}: ${w}`));

      const scene = readSceneBlock(filename, result);
      if (scene) {
        const restored = restoreSceneFrom3MF(filename, result, scene);
        if (restored != null) {
          if (restored) {
            setStatus(`Restored ${restored} piece(s) from ${filename} - ` +
                      (scene.scope === 'plate' ? 'plate, poses and per-piece state as saved'
                                               : 'piece and its state as saved'));
          } else {
            setStatus(`${filename}: the saved scene had nothing this build could rebuild`, true);
          }
          return result;
        }
      }

      let loaded = 0;
      result.objects.forEach(obj => {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(obj.positions, 3));
        if (addModelFromZUpGeometry(obj.name, geometry)) loaded++;
      });
      if (loaded > 1) {
        setStatus(`Loaded ${loaded} objects from ${filename}` +
                  (result.application ? ` (${result.application})` : ''));
      } else if (!loaded) {
        setStatus(`${filename}: no usable geometry found`, true);
      }
      return result;
    })
    .catch(err => {
      console.error(err);
      setStatus(`Failed to load ${filename}: ${err && err.message ? err.message : 'not a readable 3MF'}`, true);
      return null;
    });
}

function addModel(name, geometry, opts) {
  const options = opts || {};
  const id = nextId++;
  const bbox = new THREE.Box3().setFromBufferAttribute(geometry.attributes.position);
  const size = new THREE.Vector3();
  bbox.getSize(size);

  // Sanity check
  if (size.x < 0.1 || size.y < 0.1 || size.z < 0.1) {
    setStatus(`${name} looks empty or invalid`, true);
    return null;
  }

  // Center so red plane and clip share the same origin every time
  geometry.center();
  geometry.computeBoundingBox();
  const size2 = new THREE.Vector3();
  geometry.boundingBox.getSize(size2);

  state.models.push({
    id,
    name: name.replace(/\.stl$/i, ''),
    geometry,
    quantity: 1,
    size: { x: size2.x, y: size2.y, z: size2.z },
    orientedGeometry: null,
    // Raw-mesh cut engine data - original file axes, untranslated. Only
    // present when loaded via handleFiles; absent on programmatically
    // rebuilt models (e.g. after a Split), which fall back to
    // clipGeometrySide automatically since rawTris will be undefined.
    rawTris: options.rawTris || null,
    rawAxis: options.rawAxis || null,
    centerOffset: options.centerOffset || null
  });

  if (!options.keepSelection) {
    state.cutT = 0.5;
  }
  renderModelList();
  updateOptimizeButton();
  updateEditSize();
  if (!options.silent) {
    if (state.cutterOpen && !options.keepSelection) {
      showEditPreview();
      setStatus(`Loaded: ${name} (${size2.x.toFixed(0)}x${size2.y.toFixed(0)}x${size2.z.toFixed(0)} mm) - cutter open, slide red plane`);
    } else if (!options.keepSelection) {
      const model = state.models.find(x => x.id === id);
      // Offset new uploads so they don't stack on existing plate pieces
      let x = 0;
      if (state.placed.length) {
        const maxX = Math.max(...state.placed.map(p => p.x + (p.width || 0) / 2));
        x = maxX + size2.x / 2 + 4;
      }
      if (model) placeModelMovable(model, x, 0);
      setStatus(`Loaded: ${name} (${size2.x.toFixed(0)}x${size2.y.toFixed(0)}x${size2.z.toFixed(0)} mm) - drag to move, Open cutter, or Optimize`);
    }
  }
  return id;
}

// Clear display meshes only - never dispose shared model geometries
function clearDisplayMeshes() {
  if (!state.modelGroup) return;
  const kids = state.modelGroup.children.slice();
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i];
    state.modelGroup.remove(child);
    if (child.material) {
      if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
      else child.material.dispose();
    }
    // Do NOT dispose geometry - it may be shared with state.models
  }
  // Safety: empty group
  while (state.modelGroup.children.length) {
    state.modelGroup.remove(state.modelGroup.children[0]);
  }
}

// Show a single model on the plate so upload has immediate feedback

/** Put a library model on the plate as a movable piece (does not wipe other pieces). */
function applyPlacedOrientation(entry, ori) {
  if (!entry || !ori) return;
  entry.rotY = ori.rotY || 0;
  entry.flipX = !!ori.flipX;
  entry.tipX = ori.tipX || 0;
  entry.tipZ = ori.tipZ || 0;
  entry.tiltX = ori.tiltX || 0;
  entry.tiltZ = ori.tiltZ || 0;
  entry.liftY = ori.liftY || 0;
  if (typeof applyMeshRotation === 'function') applyMeshRotation(entry);
}

function placeModelMovable(model, x, z) {
  if (!model || !model.geometry || !state.modelGroup) return null;
  // Avoid duplicate plate instances of same source unless caller wants clones (clones are new models)
  const mat = new THREE.MeshStandardMaterial({
    color: 0x38bdf8, metalness: 0.05, roughness: 0.4,
    emissive: 0x0a3a5c, emissiveIntensity: 0.25
  });
  const mesh = new THREE.Mesh(model.geometry, mat);
  const h = model.size.y / 2 + 0.3;
  const px = (typeof x === 'number') ? x : 0;
  const pz = (typeof z === 'number') ? z : 0;
  mesh.position.set(px, h, pz);
  mesh.userData.placedIndex = state.placed.length;
  mesh.userData.sourceId = model.id;
  state.modelGroup.add(mesh);
  const entry = {
    mesh,
    geometry: model.geometry,
    name: model.name,
    x: px,
    z: pz,
    width: model.size.x,
    depth: model.size.z,
    height: model.size.y,
    yaw: 0,
    rotY: 0,
    flipX: false,
    tipX: 0,
    overflow: false,
    sourceId: model.id,
    outline: null
  };
  state.placed.push(entry);
  const exportBtn = document.getElementById('btn-export-stl');
  if (exportBtn) exportBtn.disabled = false;
  updateAdjustUI();
  return entry;
}

function framePlateHome() {
  if (!state.camera || !state.controls) return;
  const plate = (typeof getCurrentPlate === 'function') ? getCurrentPlate() : { w: 180, d: 180 };
  const w = plate.w || 180;
  const d = plate.d || 180;
  state.controls.target.set(0, 6, 0);
  state.camera.position.set(w * 1.08, Math.max(w, d) * 0.92, d * 1.18);
  state.controls.update();
}

function frameSelectedPiece() {
  framePlateHome();
  setStatus('Camera: plate view');
}

function clearPlateOnly() {
  clearPlaced();
  removeCutHelper();
  state.previewMesh = null;
  state.selectedIndex = -1;
  state.cutterOpen = false;
  updateCutterUI();
  updateAdjustUI();
  setStatus('Plate cleared - library models kept. Upload or Open cutter still work.');
}

function cloneSelectedModel() {
  const m = getActiveModel();
  if (!m) {
    const p = state.selectedIndex >= 0 ? state.placed[state.selectedIndex] : null;
    if (p && p.sourceId != null) {
      const found = state.models.find(x => x.id === p.sourceId);
      if (found) state.editId = found.id;
    }
  }
  const src = getActiveModel();
  if (!src || !src.geometry) {
    setStatus('Select a model to clone', true);
    return;
  }
  const n = Math.max(1, Math.min(20, Number(document.getElementById('clone-count')?.value) || 1));
  const plate = getCurrentPlate();
  const gap = 3;
  const w = src.size.x;
  const d = src.size.z;
  const cellW = w + gap;
  const cellD = d + gap;
  const cols = Math.max(1, Math.floor((plate.w + gap) / cellW));
  const rows = Math.max(1, Math.floor((plate.d + gap) / cellD));
  // Occupied cell keys from existing plate pieces
  const occupied = new Set();
  state.placed.forEach(p => {
    const col = Math.round((p.x + plate.w / 2 - w / 2) / cellW);
    const row = Math.round((p.z + plate.d / 2 - d / 2) / cellD);
    occupied.add(col + ',' + row);
  });
  function nextFreeCell(start) {
    for (let k = start; k < cols * rows * 4; k++) {
      const col = k % cols;
      const row = Math.floor(k / cols);
      const key = col + ',' + row;
      if (!occupied.has(key)) {
        occupied.add(key);
        const x = -plate.w / 2 + w / 2 + col * cellW;
        const z = -plate.d / 2 + d / 2 + row * cellD;
        return { x, z, k: k + 1 };
      }
    }
    // Overflow: place to the right of plate
    const k = start;
    const x = plate.w / 2 + w / 2 + (k - cols * rows) * cellW;
    return { x, z: 0, k: k + 1 };
  }
  let cursor = 0;
  const newIds = [];
  let firstPlaced = null;
  for (let i = 0; i < n; i++) {
    const geo = src.geometry.clone();
    geo.computeBoundingBox();
    const name = src.name.replace(/-copy\d+$/i, '') + '-copy' + (i + 1);
    /* A CLONE OF A RAW PIECE IS A RAW PIECE.
       addModel() only records rawTris when it is handed them, and this call
       used to hand it the display geometry alone - so every clone arrived
       with rawTris null and every raw tool refused it by name: "Fatten needs
       a raw piece", "Hollow needs a raw piece", "Smooth needs a raw piece".
       Honest refusals about a piece that should never have been in that
       state, because src.rawTris was in hand the whole time.

       The three fields transfer verbatim: the clone's display geometry is
       src.geometry.clone(), addModel() re-centres it and the source was
       already centred, so that is a no-op and the same centerOffset still
       maps the same raw soup onto it. The soup is COPIED rather than shared -
       two models pointing at one buffer is an aliasing bug waiting for the
       first tool that writes in place, and clone already pays the same order
       of memory for geometry.clone(). */
    const id = addModel(name, geo, {
      keepSelection: true,
      silent: true,
      rawTris: (src.rawTris && src.rawTris.length) ? new Float32Array(src.rawTris) : null,
      rawAxis: src.rawAxis || null,
      centerOffset: src.centerOffset
        ? { x: src.centerOffset.x, y: src.centerOffset.y, z: src.centerOffset.z }
        : null
    });
    if (id == null) continue;
    newIds.push(id);
    const model = state.models.find(x => x.id === id);
    if (!model) continue;
    const cell = nextFreeCell(cursor);
    cursor = cell.k;
    const entry = placeModelMovable(model, cell.x, cell.z);
    if (entry && firstPlaced === null) firstPlaced = state.placed.indexOf(entry);
  }
  if (newIds.length) {
    /* The undo entry records the editId as it was BEFORE the selection moves,
       so it must be pushed first - it is what Undo puts back. */
    pushUndo({ type: 'addModels', ids: newIds.slice(), editId: state.editId, cutT: state.cutT });
    /* SELECT THE CLONE THROUGH THE APP'S ONE SELECTION PATH.
       This used to set state.editId = newIds[0] behind selectPlaced's back,
       which left the two halves of "what is selected" naming different
       pieces: the Edit card, the model list and every getActiveModel() tool
       followed the clone, while the red outline in the viewport - and
       state.selectedIndex, which the pose buttons and Attach read - stayed on
       the ORIGINAL. Measured: five tools in a row acted on a piece the user
       could not see was selected. selectPlaced moves both, and clears the
       outline it is taking the selection away from. */
    if (firstPlaced != null && firstPlaced >= 0 && typeof selectPlaced === 'function') {
      selectPlaced(firstPlaced);
    } else {
      state.editId = newIds[0];
    }
  }
  renderModelList();
  updateOptimizeButton();
  updateEditSize();
  updateUndoBtn();
  setStatus('Cloned ' + newIds.length + ' x ' + src.name + ' side-by-side on plate (' + cols + ' across)');
}

function previewModelOnPlate(geometry, size) {
  if (!state.scene || !state.modelGroup) {
    setStatus('3D view not ready - refresh the page', true);
    return;
  }

  clearDisplayMeshes();
  state.placed = []; // preview is not a real pack
  const exportBtn = document.getElementById('btn-export-stl');
  if (exportBtn) exportBtn.disabled = true;

  // Auto-orient for a sensible preview (same logic as Optimize)
  let geo;
  let h = size.y;
  try {
    const best = autoOrient(geometry);
    geo = best.geometry;
    h = best.size.y;
  } catch (e) {
    geo = geometry.clone();
    geo.center();
  }

  const mat = new THREE.MeshStandardMaterial({
    color: 0x38bdf8,
    metalness: 0.05,
    roughness: 0.4,
    emissive: 0x0a3a5c,
    emissiveIntensity: 0.25
  });
  const cam = freezeCamera();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(0, h / 2 + 0.3, 0);
  state.modelGroup.add(mesh);
  restoreCamera(cam);
}

function renderModelList() {
  const el = document.getElementById('model-list');
  el.innerHTML = '';

  state.models.forEach(m => {
    const row = document.createElement('div');
    let cls = 'model-item';
    if (m.id === state.editId) cls += ' active';
    if (m.id === state.joinPartnerId) cls += ' join-partner';
    row.className = cls;
    row.dataset.editId = String(m.id);
    row.innerHTML = `
      <span class="name" title="${m.name}">${m.name}</span>
      <div class="qty">
        <input type="number" min="1" max="30" value="${m.quantity}" data-id="${m.id}" />
      </div>
      <button class="remove" data-id="${m.id}" title="Remove">x</button>
    `;
    el.appendChild(row);
  });
  // The non-solid tag rides on the row it belongs to (app-nonsolid.js).
  if (typeof nsoNonSolidRefresh === 'function') nsoNonSolidRefresh();
  // So does the locked tag, and the outline on the mesh (app-poslock.js) -
  // every bake that swaps a mesh rebuilds the list, so this is where the
  // outline lands on the new mesh.
  if (typeof nsoPosLockRefresh === 'function') nsoPosLockRefresh();
  // And this is where the defect overlay (app-defects.js) notices the swap and
  // drops itself: the marks were children of the mesh the bake replaced, so a
  // stale check can never stay drawn over new geometry.
  if (typeof nsoDefectsRefresh === 'function') nsoDefectsRefresh();

  el.querySelectorAll('.model-item').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.qty') || e.target.closest('.remove')) return;
      const id = Number(row.dataset.editId);
      if (state.joinSession && state.joinArmed) {
        assignJoinClick(id);
        return;
      }
      state.editId = id;
      state.cutT = 0.5;
      const placedIdx = state.placed.findIndex(function (p) { return p && p.sourceId === id; });
      if (placedIdx >= 0) selectPlaced(placedIdx);
      else {
        renderModelList();
        updateEditSize();
        if (state.cutterOpen) {
          const mesh = getCutterTargetMesh();
          if (mesh) {
            removeCutHelper();
            state.previewMesh = mesh;
            buildCutHelper();
          }
        }
        if (typeof updateJoinUI === 'function') updateJoinUI();
      }
      return;
      state.cutT = 0.5;
      renderModelList();
      updateEditSize();
      if (state.cutterOpen) {
        showEditPreview();
        setStatus('Cutter on ' + (getActiveModel() ? getActiveModel().name : ''));
      } else {
        setStatus('Selected ' + (getActiveModel() ? getActiveModel().name : '') + ' - Open cutter to cut, or Optimize to nest');
      }
    });
  });

  el.querySelectorAll('.qty input').forEach(input => {
    input.addEventListener('change', (e) => {
      const id = Number(e.target.dataset.id);
      const model = state.models.find(m => m.id === id);
      if (model) {
        model.quantity = Math.max(1, Math.min(30, Number(e.target.value) || 1));
        e.target.value = model.quantity;
      }
    });
  });

  el.querySelectorAll('.remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = Number(e.target.dataset.id);
      state.models = state.models.filter(m => m.id !== id);
      if (state.editId === id) {
        state.editId = state.models.length ? state.models[state.models.length - 1].id : null;
        state.cutT = 0.5;
      }
      renderModelList();
      updateOptimizeButton();
      if (state.editId) showEditPreview();
      else {
        clearPlaced();
        removeCutHelper();
      }
    });
  });
  if (typeof updateJoinUI === 'function') updateJoinUI();
}

function updateOptimizeButton() {
  const btn = document.getElementById('btn-optimize');
  if (btn) btn.disabled = state.models.length === 0;
}

// ===================== Orientation =====================
// density = pack more, but NEVER on a thin edge
// supports = lowest overhangs
function scoreOrientation(geometry, mode = 'density') {
  const bbox = new THREE.Box3().setFromBufferAttribute(geometry.attributes.position);
  const size = new THREE.Vector3();
  bbox.getSize(size);
  const footprint = size.x * size.z;
  const height = size.y;
  const maxSide = Math.max(size.x, size.z);
  const minSide = Math.min(size.x, size.z);
  const baseAspect = maxSide / Math.max(minSide, 0.1);
  const stability = footprint / Math.max(height * height, 1);

  // Hard ban: thin-edge / tip poses (min base width < 18mm or crazy aspect)
  const MIN_BASE = 18;
  const isThinEdge = minSide < MIN_BASE || baseAspect > 3.2 || stability < 0.18;

  let score;
  if (isThinEdge) {
    score = 1e9; // banned
  } else if (mode === 'density') {
    score = footprint * 0.5 + maxSide * 3 + height * 0.4;
  } else {
    score = height * 3.0 - footprint * 0.01 + maxSide * 0.2;
  }
  return { score, size, footprint, height, maxSide, baseAspect, stability, isThinEdge };
}

function autoOrient(geometry, mode = 'density') {
  const rotations = [
    [0, 0, 0],
    [Math.PI / 2, 0, 0],
    [-Math.PI / 2, 0, 0],
    [0, 0, Math.PI / 2],
    [0, 0, -Math.PI / 2],
    [Math.PI, 0, 0],
    [Math.PI / 2, 0, Math.PI / 2],
    [Math.PI / 2, 0, -Math.PI / 2],
    [-Math.PI / 2, 0, Math.PI / 2],
    [-Math.PI / 2, 0, -Math.PI / 2],
    [0, Math.PI / 2, 0],
    [0, -Math.PI / 2, 0],
    [Math.PI / 2, Math.PI / 2, 0],
    [-Math.PI / 2, Math.PI / 2, 0]
  ];

  let best = null;

  rotations.forEach(([rx, ry, rz]) => {
    const geo = geometry.clone();
    geo.rotateX(rx);
    geo.rotateY(ry);
    geo.rotateZ(rz);
    geo.computeBoundingBox();
    geo.center();
    const result = scoreOrientation(geo, mode);
    if (!best || result.score < best.score) {
      best = { geometry: geo, ...result, rot: [rx, ry, rz] };
    }
  });

  return best;
}

// ===================== Nesting =====================
// Footprints: 0 deg, 90 deg, +/-45 deg yaw. AABB expands at 45 deg.
function footprintsFor(geo, size, allowRotate) {
  const list = [{ geometry: geo, width: size.x, depth: size.z, height: size.y, rotY: 0 }];
  if (!allowRotate) return list;
  list.push({ geometry: geo, width: size.z, depth: size.x, height: size.y, rotY: Math.PI / 2 });
  const w45 = size.x * Math.SQRT1_2 + size.z * Math.SQRT1_2;
  const d45 = w45;
  list.push({ geometry: geo, width: w45, depth: d45, height: size.y, rotY: Math.PI / 4 });
  list.push({ geometry: geo, width: w45, depth: d45, height: size.y, rotY: -Math.PI / 4 });
  return list;
}

/* Cut a rectangle out of a list of free rectangles, keeping the (up to four)
   strips that survive around it. Used to reserve the ground a locked piece is
   already standing on before anything is packed. */
function subtractFreeRect(rects, box) {
  const EPS = 1e-6;
  const out = [];
  for (const r of rects) {
    const ox0 = Math.max(r.x, box.minx);
    const ox1 = Math.min(r.x + r.w, box.maxx);
    const oz0 = Math.max(r.z, box.minz);
    const oz1 = Math.min(r.z + r.d, box.maxz);
    if (!(ox1 > ox0 + EPS && oz1 > oz0 + EPS)) { out.push(r); continue; }   // misses this rect
    if (ox0 > r.x + EPS) out.push({ x: r.x, z: r.z, w: ox0 - r.x, d: r.d });
    if (ox1 < r.x + r.w - EPS) out.push({ x: ox1, z: r.z, w: r.x + r.w - ox1, d: r.d });
    if (oz0 > r.z + EPS) out.push({ x: r.x, z: r.z, w: r.w, d: oz0 - r.z });
    if (oz1 < r.z + r.d - EPS) out.push({ x: r.x, z: oz1, w: r.w, d: r.z + r.d - oz1 });
  }
  return out;
}

/* `blockers` are world-space XZ footprints ({minx,maxx,minz,maxz}) that the
   packer must not place on: the pieces the user locked, which keep the pose
   they already have. They are inflated by `gap` so a packed piece lands the
   same clearance away from a locked neighbour as from a packed one. */
function packModels(instances, plate, gap, allowRotate, blockers) {
  const placed = [];
  let freeRects = [{ x: -plate.w / 2, z: -plate.d / 2, w: plate.w, d: plate.d }];
  if (blockers && blockers.length) {
    for (const b of blockers) {
      freeRects = subtractFreeRect(freeRects, {
        minx: b.minx - gap, maxx: b.maxx + gap, minz: b.minz - gap, maxz: b.maxz + gap
      });
    }
    freeRects.sort((a, b2) => a.z - b2.z || a.x - b2.x);
  }

  // Largest footprint first
  const sorted = [...instances].sort((a, b) => (b.width * b.depth) - (a.width * a.depth));

  for (const inst of sorted) {
    // Candidate footprints: as-is + 90 deg yaw if allowed
    const candidates = footprintsFor(inst.geometry, {
      x: inst.width, y: inst.height, z: inst.depth
    }, allowRotate);

    // Also try other base orientations of the source model if attached
    if (inst.orientOptions && inst.orientOptions.length) {
      for (const opt of inst.orientOptions) {
        for (const fp of footprintsFor(opt.geometry, opt.size, allowRotate)) {
          candidates.push(fp);
        }
      }
    }

    let best = null;

    for (const cand of candidates) {
      for (let i = 0; i < freeRects.length; i++) {
        const r = freeRects[i];
        if (cand.width + gap <= r.w + 0.01 && cand.depth + gap <= r.d + 0.01) {
          // Prefer bottom-left, then minimize leftover strip waste
          const waste = (r.w * r.d) - (cand.width * cand.depth);
          const score = r.z * 5000 + r.x * 10 + waste * 0.01;
          if (!best || score < best.score) {
            best = {
              x: r.x, z: r.z,
              w: cand.width, d: cand.depth,
              score, rectIdx: i,
              geometry: cand.geometry,
              rotY: cand.rotY || 0,
              height: cand.height
            };
          }
        }
      }
    }

    if (!best) {
      const overflowIndex = placed.filter(p => p.overflow).length;
      placed.push({
        ...inst,
        x: 0,
        z: 0,
        width: inst.width,
        depth: inst.depth,
        rotated: false,
        rotY: 0,
        overflow: true,
        meshOffsetY: overflowIndex * (inst.height + 2)
      });
      continue;
    }

    placed.push({
      ...inst,
      geometry: best.geometry,
      x: best.x + best.w / 2,
      z: best.z + best.d / 2,
      width: best.w,
      depth: best.d,
      height: best.height,
      rotated: Math.abs(best.rotY) > 0.1,
      rotY: best.rotY,
      overflow: false
    });

    // Split free rect (guillotine)
    const r = freeRects[best.rectIdx];
    freeRects.splice(best.rectIdx, 1);
    const usedW = best.w + gap;
    const usedD = best.d + gap;

    // Two split heuristics - keep both leftover rects when large enough
    if (r.w - usedW > 1.5) {
      freeRects.push({ x: r.x + usedW, z: r.z, w: r.w - usedW, d: r.d });
    }
    if (r.d - usedD > 1.5) {
      freeRects.push({ x: r.x, z: r.z + usedD, w: Math.min(usedW, r.w), d: r.d - usedD });
    }

    freeRects.sort((a, b) => a.z - b.z || a.x - b.x);
  }

  return placed;
}

// Color mesh faces by overhang: green = OK, red = needs support
function applyOverhangColors(geometry) {
  const geo = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  geo.computeVertexNormals();
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const threshold = Math.cos((45 * Math.PI) / 180); // 45 deg overhang

  for (let i = 0; i < pos.count; i += 3) {
    vA.fromBufferAttribute(pos, i);
    vB.fromBufferAttribute(pos, i + 1);
    vC.fromBufferAttribute(pos, i + 2);
    normal.crossVectors(vB.clone().sub(vA), vC.clone().sub(vA)).normalize();
    // Faces pointing down/sideways past threshold need support
    const dot = normal.dot(up);
    const needsSupport = dot < threshold && dot > -0.95; // skip near-downward bed faces slightly
    // Stronger: any face more than 45 deg from up
    const bad = normal.dot(up) < threshold;
    const r = bad ? 0.95 : 0.25;
    const g = bad ? 0.25 : 0.85;
    const b = bad ? 0.2 : 0.45;
    for (let k = 0; k < 3; k++) {
      colors[(i + k) * 3] = r;
      colors[(i + k) * 3 + 1] = g;
      colors[(i + k) * 3 + 2] = b;
    }
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geo;
}

// ===================== Optimize =====================
function runOptimize() {
  const btn = document.getElementById('btn-optimize');
  /* The plate lock holds the ARRANGEMENT, and a repack is the one operation
     that rebuilds the arrangement wholesale - so it is the one non-move
     operation the plate lock refuses. A per-piece lock does not refuse it;
     it pins that piece and the rest packs around it (below). */
  if (typeof nsoPlateLocked === 'function' && nsoPlateLocked()) {
    setStatus('Plate locked - Optimize refused; the arrangement is held. Press Unlock plate to repack', true);
    return;
  }
  btn.disabled = true;
  setStatus('Optimizing...');
  closeCutter(true);

  try {
    /* These four controls are optional: the Pack card ships only the button,
       so every read has to stand on its own. Defaults are the conservative
       ones - keep the uploaded orientation, do not yaw pieces the user
       placed, 2 mm between neighbours. */
    const optFlag = (id, dflt) => {
      const el = document.getElementById(id);
      return el ? !!el.checked : dflt;
    };
    const autoOrientFace = optFlag('opt-auto-orient', false);
    const preferSupports = optFlag('opt-orient', false);
    const allowRotate = optFlag('opt-rotate', false);
    const gapEl = document.getElementById('gap');
    const gap = Number(gapEl && gapEl.value) || 2;
    const plate = getCurrentPlate();

    /* Locked pieces are not repacked. They keep the pose AND the mesh they
       already have - the ground they stand on is taken out of the packer's
       free space, and only the pieces that are not locked are laid out again
       around them. `nsoPosLockedPlaced` is the same accessor the move gate
       reads; nothing here re-derives a lock. */
    const isHeld = p => typeof nsoPosLockedPlaced === 'function' && nsoPosLockedPlaced(p);
    const held = (state.placed || []).filter(p => p && p.mesh && isHeld(p));
    const heldPerModel = new Map();
    held.forEach(p => heldPerModel.set(p.sourceId, (heldPerModel.get(p.sourceId) || 0) + 1));
    const blockers = held.map(p => placedFootprint(p));

    // Top N orientations so packer can pick per-instance
    function topOrients(geometry, mode, n = 4) {
      const rotations = [
        [0, 0, 0], [Math.PI / 2, 0, 0], [-Math.PI / 2, 0, 0],
        [0, 0, Math.PI / 2], [0, 0, -Math.PI / 2], [Math.PI, 0, 0],
        [Math.PI / 2, 0, Math.PI / 2], [-Math.PI / 2, 0, Math.PI / 2]
      ];
      const scored = [];
      rotations.forEach(([rx, ry, rz]) => {
        const geo = geometry.clone();
        geo.rotateX(rx); geo.rotateY(ry); geo.rotateZ(rz);
        geo.computeBoundingBox(); geo.center();
        const result = scoreOrientation(geo, mode || 'density');
        scored.push({ geometry: geo, size: result.size, score: result.score, isThinEdge: result.isThinEdge });
      });
      scored.sort((a, b) => a.score - b.score);
      // Prefer printable poses only; fall back to all if none pass
      const printable = scored.filter(s => !s.isThinEdge && s.score < 1e8);
      const pool = printable.length ? printable : scored;
      return pool.slice(0, n);
    }

    function buildInstances(mode) {
      const instances = [];
      for (const model of state.models) {
        // Each locked copy of this model is already on the plate and stays
        // there, so the packer is asked for that many fewer.
        const want = Math.max(0, model.quantity - (heldPerModel.get(model.id) || 0));
        if (!want) continue;
        const orients = mode ? topOrients(model.geometry, mode, 5) : [{
          geometry: (() => { const g = model.geometry.clone(); g.center(); return g; })(),
          size: model.size,
          score: 0
        }];
        const primary = orients[0];
        const orientOptions = orients.slice(1).map(o => ({
          geometry: o.geometry,
          size: { x: o.size.x, y: o.size.y, z: o.size.z }
        }));
        for (let i = 0; i < want; i++) {
          instances.push({
            sourceId: model.id,
            name: model.name,
            geometry: primary.geometry,
            width: primary.size.x,
            depth: primary.size.z,
            height: primary.size.y,
            orientOptions
          });
        }
      }
      return instances;
    }

    // Default: keep upload orientation (works for any file).
    // Optional auto-orient when user enables it.
    const candidates = [];
    if (autoOrientFace) {
      candidates.push({ mode: 'density', instances: buildInstances('density') });
      candidates.push({ mode: 'supports', instances: buildInstances('supports') });
    }
    candidates.push({ mode: null, instances: buildInstances(null) }); // as uploaded

    let bestPlaced = null;
    let bestFitted = -1;
    let bestMode = 'as-uploaded';

    for (const c of candidates) {
      const placedTry = packModels(c.instances, plate, gap, allowRotate, blockers);
      const fitted = placedTry.filter(p => !p.overflow).length;
      if (fitted > bestFitted) {
        bestFitted = fitted;
        bestPlaced = placedTry;
        bestMode = c.mode || 'as-uploaded';
      }
    }

    const placed = bestPlaced;

    // Clear only what is being repacked - a held piece keeps the very mesh it
    // has, so a bake (Skin, Soften, Repair) on a locked piece survives a
    // repack of everything around it, and so does its lock outline, which is
    // a child of that mesh.
    const keepMeshes = new Set(held.map(p => p.mesh));
    if (state.modelGroup) {
      state.modelGroup.children.slice().forEach(child => {
        if (keepMeshes.has(child)) return;
        state.modelGroup.remove(child);
        if (child.material) {
          if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
          else child.material.dispose();
        }
        // Do NOT dispose geometry - it may be shared with state.models
      });
    }
    state.placed = held.concat(placed);

    const showSupports = preferSupports; // reuse checkbox: when on, tint overhangs

    placed.forEach((p) => {
      let geo = p.geometry.clone();
      if (showSupports) {
        geo = applyOverhangColors(geo);
      }
      const mat = new THREE.MeshStandardMaterial({
        color: showSupports ? 0xffffff : 0x60a5fa,
        metalness: 0.08,
        roughness: 0.55,
        vertexColors: showSupports
      });
      if (p.overflow) {
        mat.vertexColors = false;
        mat.color.setHSL(0.05, 0.75, 0.55);
      }
      const mesh = new THREE.Mesh(geo, mat);
      const yOff = p.meshOffsetY || 0;
      mesh.position.set(p.x, p.height / 2 + 0.2 + yOff, p.z);
      mesh.rotation.y = p.rotY || (p.rotated ? Math.PI / 2 : 0);
      p.mesh = mesh;
      p.rotY = p.rotY || (p.rotated ? Math.PI / 2 : 0);
      state.modelGroup.add(mesh);
    });
    // Held pieces come first in state.placed, so every index moved; the
    // pick path reads mesh.userData.placedIndex, so restamp them all.
    reindexPlacedMeshes();

    state.selectedIndex = -1;
    renderModelList();
    updateAdjustUI();

    // Keep plate visible - do not reframe camera after packing
    if (!state.plateMesh || !state.plateGrid) buildPlateMesh();

    // The held pieces are on the plate and count towards the plate, so every
    // readout below is over state.placed, not over the pieces just packed.
    const totalRequested = state.models.reduce((s, m) => s + m.quantity, 0);
    const onPlate = state.placed.filter(p => !p.overflow);
    const fitted = onPlate.length;
    const totalArea = plate.w * plate.d;
    const usedArea = onPlate.reduce((sum, p) => sum + (p.width || 0) * (p.depth || 0), 0);
    const fill = totalArea > 0 ? ((usedArea / totalArea) * 100).toFixed(1) : 0;

    /* The stats panel and the results table are optional, the same way the
       four Pack controls above are: the shipped Pack card is the button
       alone. Write to whichever of them is on the page and let the rest be -
       the status line below carries the same numbers either way. */
    const statsEl = document.getElementById('stats');
    if (statsEl) statsEl.classList.remove('hidden');
    const setText = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };
    setText('stat-count', `${fitted} models`);
    setText('stat-fill', `${fill}% fill`);
    setText('stat-time', `${totalRequested - fitted} left`);

    const resultsEl = document.getElementById('results');
    if (resultsEl) {
      resultsEl.innerHTML = `
      <div class="result-row"><span>Placed</span><strong>${fitted} / ${totalRequested}</strong></div>
      <div class="result-row"><span>Plate fill</span><strong>${fill}%</strong></div>
      <div class="result-row"><span>Mode</span><strong>${bestMode}${showSupports ? ' + support tint' : ''}</strong></div>
      <div class="result-row"><span>Gap</span><strong>${gap} mm</strong></div>
      <div class="result-row"><span>Locked, kept</span><strong>${held.length}</strong></div>
    `;
    }

    updateExportButton();

    const overflowCount = state.placed.filter(p => p.overflow).length;
    const around = held.length
      ? ` around ${held.length} locked piece${held.length === 1 ? '' : 's'}, which did not move`
      : '';
    if (overflowCount > 0) {
      setStatus(`${fitted} fitted${around}, ${overflowCount} need manual place - click orange model(s) to rotate/nudge`, true);
    } else {
      setStatus(`Packed ${placed.length} model${placed.length === 1 ? '' : 's'}${around} - ready to export`, false);
    }
  } catch (err) {
    console.error(err);
    setStatus('Optimize failed. Check console.', true);
  }

  btn.disabled = false;
}

function clearPlaced() {
  if (state.placed && state.placed.length) {
    state.placed.forEach(p => {
      if (p && p.mesh) {
        if (p.mesh.parent) p.mesh.parent.remove(p.mesh);
        if (p.mesh.material) {
          if (Array.isArray(p.mesh.material)) p.mesh.material.forEach(m => m.dispose());
          else p.mesh.material.dispose();
        }
      }
      if (p && p.outline && p.outline.parent) p.outline.parent.remove(p.outline);
    });
  }
  state.placed = [];
  clearDisplayMeshes();
  const stats = document.getElementById('stats');
  if (stats) stats.classList.add('hidden');
  const exportBtn = document.getElementById('btn-export-stl');
  if (exportBtn) exportBtn.disabled = true;
  state.selectedIndex = -1;
}

// ===================== Manual Adjust =====================
function setPointerFromEvent(event) {
  const rect = state.renderer.domElement.getBoundingClientRect();
  state.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  state.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}

function hitPlateXZ() {
  if (!state.raycaster || !state.camera) return null;
  state.raycaster.setFromCamera(state.pointer, state.camera);
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();
  if (!state.raycaster.ray.intersectPlane(plane, hit)) return null;
  return hit;
}

function settlePlacedOnBed(p) {
  if (!p || !p.mesh) return;
  if (p.overflow || p.meshOffsetY) {
    p.overflow = false;
    p.meshOffsetY = 0;
    if (p.mesh.material && !p.mesh.material.vertexColors) {
      const hue = 0.55 + ((state.selectedIndex >= 0 ? state.selectedIndex : 0) % 8) * 0.03;
      p.mesh.material.color.setHSL(hue, 0.65, 0.55);
    }
  }
  const yKeep = p.mesh.position.y;
  p.mesh.position.y = 0;
  p.mesh.updateMatrixWorld(true);
  const bb = meshLocalBox3(p.mesh);
  p.mesh.position.y = 0.2 - bb.min.y + (p.liftY || 0);
}

function clearFenceLines() {
  if (!state.fenceGroup || !state.modelGroup) return;
  state.modelGroup.remove(state.fenceGroup);
  state.fenceGroup.traverse(function (c) {
    if (c.geometry) c.geometry.dispose();
    if (c.material) c.material.dispose();
  });
  state.fenceGroup = null;
}

function showFenceLines(skipIdx) {
  clearFenceLines();
  if (!state.modelGroup || !state.placed) return;
  const g = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({ color: 0xff2a2a, depthTest: false });
  const y = 0.35;
  for (let i = 0; i < state.placed.length; i++) {
    if (i === skipIdx) continue;
    const q = state.placed[i];
    if (!q) continue;
    const fp = placedFootprint(q);
    const pts = [
      [fp.minx, fp.minz, fp.maxx, fp.minz],
      [fp.maxx, fp.minz, fp.maxx, fp.maxz],
      [fp.maxx, fp.maxz, fp.minx, fp.maxz],
      [fp.minx, fp.maxz, fp.minx, fp.minz]
    ];
    for (let e = 0; e < 4; e++) {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(pts[e][0], y, pts[e][1]),
        new THREE.Vector3(pts[e][2], y, pts[e][3])
      ]);
      g.add(new THREE.Line(geo, mat));
    }
  }
  state.fenceGroup = g;
  state.modelGroup.add(g);
}

/* Square both pieces onto the bed baseline (world box bottom on 0.2) - the
   Join-side step Align edges and the plate weld share. Each piece keeps its
   own liftY: a piece Seat (support) has stacked 0.18 mm above the other, or
   one the user Raised, stays exactly where settlePlacedOnBed put it. The
   step used to force both bottoms onto 0.2 outright, which dropped a seated
   bit through the hull to the plate while the record still said liftY 20.18
   (scene and export disagreed). An unlifted piece squares as before, bit for
   bit: 0.2 + 0 is 0.2. */
function matchPlacedBottoms(a, b) {
  if (!a || !b || !a.mesh || !b.mesh) return;
  settlePlacedOnBed(a);
  settlePlacedOnBed(b);
  a.mesh.updateMatrixWorld(true);
  b.mesh.updateMatrixWorld(true);
  const ba = meshLocalBox3(a.mesh);
  const bb = meshLocalBox3(b.mesh);
  a.mesh.position.y += 0.2 + (a.liftY || 0) - ba.min.y;
  b.mesh.position.y += 0.2 + (b.liftY || 0) - bb.min.y;
}

/* Undo of a pose or a move: put the mesh back at the height it had, exactly
   (see snapshotPlacedPose's meshY). Entries recorded without it keep the
   re-derived height. */
function restoreMeshY(p, y) {
  if (!p || !p.mesh || typeof y !== 'number' || !isFinite(y)) return;
  p.mesh.position.y = y;
  p.mesh.updateMatrixWorld(true);
  if (typeof refreshOutline === 'function') refreshOutline(p);
}

function applyPlacedXZ(p, x, z) {
  if (!p) return;
  p.x = x;
  p.z = z;
  if (p.mesh) {
    p.mesh.position.x = p.x;
    p.mesh.position.z = p.z;
    settlePlacedOnBed(p);
  }
}

function placedFootprint(p, x, z) {
  const px = (x == null) ? p.x : x;
  const pz = (z == null) ? p.z : z;
  if (p.mesh) {
    const savedX = p.mesh.position.x;
    const savedZ = p.mesh.position.z;
    p.mesh.position.x = px;
    p.mesh.position.z = pz;
    p.mesh.updateMatrixWorld(true);
    const bb = meshLocalBox3(p.mesh);
    p.mesh.position.x = savedX;
    p.mesh.position.z = savedZ;
    p.mesh.updateMatrixWorld(true);
    return { minx: bb.min.x, maxx: bb.max.x, minz: bb.min.z, maxz: bb.max.z };
  }
  const hx = Math.max(1, p.width || 10) / 2;
  const hz = Math.max(1, p.depth || 10) / 2;
  return { minx: px - hx, maxx: px + hx, minz: pz - hz, maxz: pz + hz };
}

function footprintsOverlap(a, b, pad) {
  const g = pad == null ? 0.02 : pad;
  const ox = Math.min(a.maxx, b.maxx) - Math.max(a.minx, b.minx);
  const oz = Math.min(a.maxz, b.maxz) - Math.max(a.minz, b.minz);
  return ox > g && oz > g;
}

function jigBoxesFor(q) {
  return [];
}

function poseOverlapsOthers(p, selfIdx, x, z) {
  const fp = placedFootprint(p, x, z);
  for (let i = 0; i < state.placed.length; i++) {
    if (i === selfIdx) continue;
    const q = state.placed[i];
    if (!q) continue;
    if (footprintsOverlap(fp, placedFootprint(q))) return true;
    const jigs = jigBoxesFor(q);
    for (let j = 0; j < jigs.length; j++) {
      if (footprintsOverlap(fp, jigs[j], 0.02)) return true;
    }
  }
  return false;
}

function magnetTowardNeighbors(p, selfIdx, x, z) {
  const MAG = 12;
  let nx = x;
  let nz = z;
  const fp = placedFootprint(p, x, z);
  for (let i = 0; i < state.placed.length; i++) {
    if (i === selfIdx) continue;
    const q = state.placed[i];
    if (!q) continue;
    const o = placedFootprint(q);
    const overZ = Math.min(fp.maxz, o.maxz) - Math.max(fp.minz, o.minz);
    const overX = Math.min(fp.maxx, o.maxx) - Math.max(fp.minx, o.minx);
    if (overZ > 1) {
      const gapR = o.minx - fp.maxx;
      const gapL = fp.minx - o.maxx;
      if (gapR >= 0 && gapR < MAG) nx += gapR;
      else if (gapL >= 0 && gapL < MAG) nx -= gapL;
    }
    if (overX > 1) {
      const gapF = o.minz - fp.maxz;
      const gapB = fp.minz - o.maxz;
      if (gapF >= 0 && gapF < MAG) nz += gapF;
      else if (gapB >= 0 && gapB < MAG) nz -= gapB;
    }
  }
  return { x: nx, z: nz };
}

function clampToApproachWalls(p, selfIdx, fromX, fromZ, toX, toZ) {
  const from = placedFootprint(p, fromX, fromZ);
  let x = toX;
  let z = toZ;
  for (let i = 0; i < state.placed.length; i++) {
    if (i === selfIdx) continue;
    const q = state.placed[i];
    if (!q) continue;
    const o = placedFootprint(q);
    if (from.minx >= o.maxx - 0.25) {
      const limit = fromX + (o.maxx - from.minx);
      if (x < limit) x = limit;
    } else if (from.maxx <= o.minx + 0.25) {
      const limit = fromX + (o.minx - from.maxx);
      if (x > limit) x = limit;
    }
    if (from.minz >= o.maxz - 0.25) {
      const limit = fromZ + (o.maxz - from.minz);
      if (z < limit) z = limit;
    } else if (from.maxz <= o.minz + 0.25) {
      const limit = fromZ + (o.minz - from.maxz);
      if (z > limit) z = limit;
    }
  }
  return { x: x, z: z };
}

function resolveDragPose(p, selfIdx, fromX, fromZ, toX, toZ) {
  /* Grid first, neighbours last. The neighbour magnet closes a contact gap
     outright, and touching the piece next door is a stronger intent than
     lining up on the bed, so it gets the final word - a piece pulled into
     contact stays in contact even when that lands it off the lattice. */
  const g = plateGridSnapXZ(toX, toZ);
  const mag = magnetTowardNeighbors(p, selfIdx, g.x, g.z);
  applyPlacedXZ(p, mag.x, mag.z);
}

function startMoveDrag(idx, event) {
  if (state.cutterOpen) {
    setStatus('Cutter open - close cutter to move pieces');
    return false;
  }
  /* Vertical placement owns the piece while it is on. A drag on an eye-level
     view moves it in a plane you cannot judge from there, which is the
     opposite of what the mode is for - the arrows and the slider are the
     whole input. Refused here, beside every other reason a drag does not
     start, rather than by unbinding anything. */
  if (state.moveVertical) {
    setStatus('Vertical placement is on - use the arrows or the slider, or clear the box');
    return false;
  }
  const p = state.placed[idx];
  if (!p || !p.mesh) return false;
  // Position lock (app-poslock.js): a locked piece is still selectable, but
  // the drag never starts and nothing is pushed to undo.
  if (typeof nsoPosLockBlocks === 'function' && nsoPosLockBlocks(p, 'drag')) return false;
  setPointerFromEvent(event);
  const hit = hitPlateXZ();
  if (!hit) return false;
  state.moveDragging = true;
  state.moveIndex = idx;
  applyPlateGridVisibility();
  state.moveUndoFrom = { index: idx, x: p.x, z: p.z, meshY: p.mesh ? p.mesh.position.y : null };
  state.moveGrab.x = p.x - hit.x;
  state.moveGrab.z = p.z - hit.z;
  if (state.controls) state.controls.enabled = false;
  if (state.renderer && state.renderer.domElement) {
    state.renderer.domElement.style.cursor = 'grabbing';
  }
  try { event.target.setPointerCapture(event.pointerId); } catch (e) {}
  showFenceLines(idx);
  return true;
}

function dragMovePlaced(event) {
  if (!state.moveDragging) return;
  const p = state.placed[state.moveIndex];
  if (!p) return;
  setPointerFromEvent(event);
  const hit = hitPlateXZ();
  if (!hit) return;
  const fromX = p.x;
  const fromZ = p.z;
  const nx = hit.x + state.moveGrab.x;
  const nz = hit.z + state.moveGrab.z;
  resolveDragPose(p, state.moveIndex, fromX, fromZ, nx, nz);
  reportJoinFlushGap();
}

function endMoveDrag() {
  if (!state.moveDragging) return;
  clearFenceLines();
  const idx = state.moveIndex;
  const from = state.moveUndoFrom;
  state.moveDragging = false;
  state.moveIndex = -1;
  state.moveUndoFrom = null;
  if (state.controls) {
    state.controls.enabled = true;
    state.controls.enableRotate = false;
  }
  if (state.renderer && state.renderer.domElement) {
    state.renderer.domElement.style.cursor = '';
  }
  updateExportButton();
  if (idx >= 0 && state.placed[idx] && from) {
    const p = state.placed[idx];
    if (Math.abs(p.x - from.x) > 0.01 || Math.abs(p.z - from.z) > 0.01) {
      pushUndo({ type: 'movePlaced', index: from.index, x: from.x, z: from.z, meshY: from.meshY });
    }
    if (!reportJoinFlushGap()) setStatus('Moved model #' + (idx + 1));
  }
}

function cutTFromPointer() {
  const m = getActiveModel();
  const placed = (state.placed || []).find(function (p) { return p && p.sourceId === state.editId && p.mesh; });
  const mesh = (placed && placed.mesh) || state.previewMesh;
  if (!m || !mesh) return;
  const axis = resolveAxis(m);
  const worldPos = new THREE.Vector3();
  mesh.getWorldPosition(worldPos);
  const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -worldPos.y);
  const hit = new THREE.Vector3();
  if (state.raycaster && state.camera) state.raycaster.setFromCamera(state.pointer, state.camera);
  if (!state.raycaster.ray.intersectPlane(dragPlane, hit)) return;
  const span = axis === 'x' ? m.size.x : m.size.z;
  if (!(span > 0.5)) return;
  const along = axis === 'x' ? (hit.x - (worldPos.x - span / 2)) : (hit.z - (worldPos.z - span / 2));
  const raw = Math.min(0.98, Math.max(0.02, along / span));
  state.cutT = raw;
  syncCutUI();
  updateCutHelper();
}

function onCanvasPointerMove(event) {
  if (typeof nsoRotate !== 'undefined' && nsoRotate.dragging()) {
    event.preventDefault();
    nsoRotate.moveDrag(event.clientX, event.clientY);
    return;
  }
  if (state.cutDragging) {
    event.preventDefault();
    setPointerFromEvent(event);
    cutTFromPointer();
    return;
  }
  if (state.editYawDragging) {
    event.preventDefault();
    const dx = event.clientX - state.editYawLastX;
    state.editYawLastX = event.clientX;
    // Low sensitivity: ~0.15 deg per pixel - controllable, not gyro
    if (Math.abs(dx) > 0) rotateActiveModelY(dx * 0.15);
    return;
  }
  if (state.moveDragging) {
    event.preventDefault();
    dragMovePlaced(event);
  }
}

function clearPointerState() {
  state.cutDragging = false;
  if (state.moveDragging) endMoveDrag();
  state.moveDragging = false;
  if (state.controls) {
    state.controls.enabled = true;
    state.controls.enableRotate = false;
  }
}

function onCanvasPointerUp() {
  if (typeof nsoRotate !== 'undefined' && nsoRotate.dragging()) nsoRotate.endDrag();
  if (state.cutDragging) {
    state.cutDragging = false;
    if (state.controls) state.controls.enabled = true;
  }
  if (state.editYawDragging) {
    state.editYawDragging = false;
    if (state.controls) state.controls.enabled = true;
  }
  if (state.moveDragging) endMoveDrag();
  // Orbit only while actively dragging the plate
  setOrbitFromPlate(false);
}

function setOrbitFromPlate(allow) {
  if (!state.controls) return;
  state.controls.enableRotate = !!allow;
  // keep zoom; pan stays off
}

function isPlateObject(obj) {
  if (!obj) return false;
  if (obj === state.plateMesh || obj === state.plateGrid || obj === state.plateBorder) return true;
  if (state.plateGrid && obj.parent === state.plateGrid) return true;
  if (state.plateTicks && state.plateTicks.indexOf(obj) >= 0) return true;
  return false;
}

function hitPlateSurface(event) {
  if (!state.renderer || !state.camera) return false;
  setPointerFromEvent(event);
  state.raycaster.setFromCamera(state.pointer, state.camera);
  const targets = [];
  if (state.plateMesh) targets.push(state.plateMesh);
  // plateGrid is deliberately absent: it is purely visual and must not be
  // pickable. plateMesh covers the same footprint, so plate-drag orbit is
  // unchanged by its absence.
  if (state.plateBorder) targets.push(state.plateBorder);
  if (state.plateTicks && state.plateTicks.length) targets.push(...state.plateTicks);
  if (!targets.length) return false;
  const hits = state.raycaster.intersectObjects(targets, false);
  return hits.length > 0;
}

function hideCtxMenu() {
  const menu = document.getElementById('ctx-menu');
  if (menu) menu.classList.add('hidden');
}

function showCtxMenu(clientX, clientY) {
  const menu = document.getElementById('ctx-menu');
  if (!menu) return;
  menu.classList.remove('hidden');
  const pad = 8;
  const w = menu.offsetWidth || 140;
  const h = menu.offsetHeight || 44;
  let x = clientX;
  let y = clientY;
  if (x + w > window.innerWidth - pad) x = window.innerWidth - w - pad;
  if (y + h > window.innerHeight - pad) y = window.innerHeight - h - pad;
  if (x < pad) x = pad;
  if (y < pad) y = pad;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}

function pickPlacedIndexFromEvent(event) {
  if (!state.renderer || !state.camera || !state.modelGroup) return -1;
  setPointerFromEvent(event);
  state.raycaster.setFromCamera(state.pointer, state.camera);
  const hits = state.raycaster.intersectObjects(state.modelGroup.children, false);
  if (!hits.length) return -1;
  const idx = hits[0].object.userData.placedIndex;
  return typeof idx === 'number' ? idx : -1;
}

function onCanvasContextMenu(event) {
  event.preventDefault();
  if (!state.placed.length) {
    hideCtxMenu();
    return;
  }
  const idx = pickPlacedIndexFromEvent(event);
  if (idx < 0) {
    hideCtxMenu();
    return;
  }
  selectPlaced(idx);
  showCtxMenu(event.clientX, event.clientY);
  setStatus('Selected #' + (idx + 1) + ' - Delete piece or press Delete');
}

function onCanvasPointerDown(event) {
  /* The rotation handle is hit-tested first and swallows the event. That is
     the point of the separate grab target: a click on the PIECE still means
     select-and-move, exactly as before, and only the ball rotates.

     ONLY WHILE ROTATE OWNS THE INPUT. Being hit-tested first is a strong
     claim on the pointer, and it used to be made on nothing but the group
     being visible - which it was for as long as anything was selected. A drag
     that landed on the ball rotated the piece from the Tip menu and from the
     Move menu, where the user had asked for neither and the guide had drawn
     itself unbidden. app-rotate-handles now empties the group when it loses
     the menu, so there is nothing here to hit; the check is repeated here
     because this is the code doing the claiming. */
  if (typeof nsoRotate !== 'undefined' && typeof state !== 'undefined' &&
      state.raycaster && state.camera && event.button === 0 &&
      (typeof nsoInputMode === 'undefined' || !nsoInputMode || nsoInputMode.owns('menu-rotate'))) {
    var rotG = state.scene && state.scene.getObjectByName('nso-rotate-handles');
    if (rotG && rotG.visible && rotG.children.length) {
      setPointerFromEvent(event);
      state.raycaster.setFromCamera(state.pointer, state.camera);
      var rh = state.raycaster.intersectObjects(rotG.children, true)
        .find(function (h) { return h.object && h.object.userData.nsoRotateHandle; });
      if (rh) {
        var axis = rh.object.userData.nsoRotateHandle;
        var c = state.renderer.domElement.getBoundingClientRect();
        var o = rotG.position.clone().project(state.camera);
        var cx = c.left + (o.x * 0.5 + 0.5) * c.width;
        var cy = c.top + (-o.y * 0.5 + 0.5) * c.height;
        if (nsoRotate.beginDrag(axis, event.clientX, event.clientY, cx, cy)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
    }
  }
  if (!state.renderer || !state.camera) return;

  // Right-click: highlight only (menu comes from contextmenu event)
  if (event.button === 2) {
    setOrbitFromPlate(false);
    const idx = pickPlacedIndexFromEvent(event);
    if (idx >= 0) selectPlaced(idx);
    return;
  }

  if (event.button !== 0) return;

  setPointerFromEvent(event);
  state.raycaster.setFromCamera(state.pointer, state.camera);
  hideCtxMenu();

  /* Paint mode owns a click that lands on a piece. Stand down so it cannot
     also start a move drag - app-mask.js runs its own handler on this same
     canvas right after this one and does the painting there. Only a click
     that paint would actually take is given up, so orbiting the plate while
     painting still works. */
  if (typeof window.nsoMaskTakesClick === 'function' && window.nsoMaskTakesClick(event)) {
    setOrbitFromPlate(false);
    return;
  }

  /* Carve owns a click that lands on a piece, for the same reason paint does:
     app-core binds this handler inside initThree() while the document is still
     parsing, so it is always the earlier listener and a fall-through here would
     start a move drag under the carve and report "Moved model #N" over its
     status. app-carve.js decides, where its own hit test lives. */
  if (typeof window.nsoCarveTakesClick === 'function' && window.nsoCarveTakesClick(event)) {
    setOrbitFromPlate(false);
    return;
  }

  /* Seat here owns a click that lands on a piece, on the same terms as paint
     and carve: app-seat-surface.js decides, where its own hit test lives, and
     a fall-through would start a move drag under the seat. Asked after carve
     and before measure because it bakes, and a measurement must never
     swallow a click a baking tool would have taken. */
  if (typeof window.nsoSeatHereTakesClick === 'function' && window.nsoSeatHereTakesClick(event)) {
    setOrbitFromPlate(false);
    return;
  }

  /* Attach owns a click that lands on a piece, on the same terms: the click
     names the point a generated blank is seated at, and app-assemble.js
     decides, where its own hit test lives. Asked here for the same reason
     Seat here is - it bakes, so it must be ahead of measure. */
  if (typeof window.nsoAttachTakesClick === 'function' && window.nsoAttachTakesClick(event)) {
    setOrbitFromPlate(false);
    return;
  }

  /* The brush owns a PRESS that lands on a piece, on the same terms again.
     app-brush.js binds its own handler on this canvas after this one, and a
     fall-through here would start a move drag UNDER the stroke and report
     "Moved model #N" over the brush's own status.

     Asked with Carve and Seat here, ahead of Measure, on the same rule they
     cite: the brush bakes, so it wins a contested click over the one tool
     that cannot change the piece. Unlike the other three it owns the whole
     drag, not just the press - the stroke runs until pointerup. */
  if (typeof window.nsoBrushTakesPointer === 'function' && window.nsoBrushTakesPointer(event)) {
    setOrbitFromPlate(false);
    return;
  }

  /* Measure owns a click that lands on a piece, on the same terms again -
     app-measure.js binds its own handler on this canvas after this one and
     takes the measurement there. Measuring changes nothing on the piece, so a
     measure click must not also drag it across the plate.

     It is asked LAST of the five because it is the only one that cannot
     change the piece: if two modes are somehow armed at once, the one that
     bakes should win the click rather than have a measurement swallow it.
     app-measure.js's enter() disarms the others anyway, so this is the
     backstop, not the mechanism. */
  if (typeof window.nsoMeasureTakesClick === 'function' && window.nsoMeasureTakesClick(event)) {
    setOrbitFromPlate(false);
    return;
  }

  if (state.softenArmed && state.modelGroup && event.button === 0) {
    const sHits = state.raycaster.intersectObjects(state.modelGroup.children, true);
    if (sHits.length) {
      let obj = sHits[0].object;
      while (obj && obj.userData.placedIndex == null && obj.parent) obj = obj.parent;
      const idx = obj && obj.userData ? obj.userData.placedIndex : undefined;
      if (typeof idx === 'number' && state.placed[idx]) {
        selectPlaced(idx);
        // Store the clicked plane first; applySoftenOnFace reads only that.
        // storeFacePick highlights the loop and reports its own reason if
        // the click cannot be described as a face.
        const face = storeFacePick(sHits[0]);
        if (face) {
          state.softenArmed = false;
          applySoftenOnFace(face);
        }
        event.stopPropagation();
        return;
      }
    }
  }

  if (state.capArmed && state.modelGroup && event.button === 0) {
    const cHits = state.raycaster.intersectObjects(state.modelGroup.children, true);
    if (cHits.length) {
      let obj = cHits[0].object;
      while (obj && obj.userData.placedIndex == null && obj.parent) obj = obj.parent;
      const idx = obj && obj.userData ? obj.userData.placedIndex : undefined;
      if (typeof idx === 'number' && state.placed[idx]) {
        selectPlaced(idx);
        const face = storeFacePick(cHits[0]);
        if (face) {
          state.capArmed = false;
          applyCapOnFace(face);
        }
        event.stopPropagation();
        return;
      }
    }
  }

  /* Tip on face, armed. Same shape as the Cap and Soften blocks above and
     in the same routing order they established: raycast the model group,
     resolve the hit to a placed piece, select it, act, and swallow the
     click. What differs is only what is done with the hit - the triangle's
     world normal, which is all "put that face on the plate" needs and the
     one thing that works for a curved pick or an edge too. */
  if (state.tipFaceArmed && state.modelGroup && event.button === 0) {
    const tHits = state.raycaster.intersectObjects(state.modelGroup.children, true);
    if (tHits.length) {
      let obj = tHits[0].object;
      while (obj && obj.userData.placedIndex == null && obj.parent) obj = obj.parent;
      const idx = obj && obj.userData ? obj.userData.placedIndex : undefined;
      if (typeof idx === 'number' && state.placed[idx]) {
        selectPlaced(idx);
        if (typeof nsoTipOrient !== 'undefined' && nsoTipOrient.tipOnFaceFromHit(tHits[0]))
          nsoTipOrient.setArmed(false);
        event.stopPropagation();
        return;
      }
    }
  }

  /* Center lock with a target pick armed owns a click that lands on a piece.
     It has to come before the Join block: by the time Center lock is useful A
     and B are both picked, and Join deliberately lets that click fall through
     so B can be dragged. */
  if (state.centerLockArmed && typeof window.nsoCenterLockTakesClick === 'function'
      && window.nsoCenterLockTakesClick(event)) {
    setOrbitFromPlate(false);
    event.stopPropagation();
    return;
  }

  if (state.joinSession && state.modelGroup) {
    const jHits = state.raycaster.intersectObjects(state.modelGroup.children, true);
    if (jHits.length) {
      let obj = jHits[0].object;
      while (obj && obj.userData.placedIndex == null && obj.parent) obj = obj.parent;
      const idx = obj && obj.userData ? obj.userData.placedIndex : undefined;
      if (typeof idx === 'number' && state.placed[idx] && state.placed[idx].sourceId != null) {
        const sid = state.placed[idx].sourceId;
        const planar = capturePlanarFace(jHits[0]);
        if (state.joinArmed) {
          assignJoinClick(sid, planar);
          if (planar) showPlanarHighlight(jHits[0].object, planar);
          event.stopPropagation();
          return;
        }
        // Both picked: do not swallow the click — fall through so B can slide.
      }
    }
  }

  // Cutter open: clicking a DIFFERENT piece moves the red line onto it.
  // Do this BEFORE helper hit-test so the plane cannot trap the other half.
  if (state.cutterOpen && state.modelGroup) {
    const modelHits = state.raycaster.intersectObjects(state.modelGroup.children, true);
    if (modelHits.length) {
      let obj = modelHits[0].object;
      while (obj && obj.userData.placedIndex == null && obj.parent) obj = obj.parent;
      const idx = obj && obj.userData ? obj.userData.placedIndex : undefined;
      if (typeof idx === 'number' && state.placed[idx]) {
        const p = state.placed[idx];
        if (p.sourceId != null) {
          setOrbitFromPlate(false);
          if (state.joinSession && state.joinArmed) {
            const faceHit = modelHits[0];
            const face = captureJoinFace(faceHit);
            assignJoinClick(p.sourceId, face);
            if (state.joinUseFaces && face) showFaceHighlight(faceHit);
            event.stopPropagation();
            return;
          }
          if (p.sourceId !== state.editId) selectPlaced(idx);
          state.cutDragging = true;
          if (state.controls) state.controls.enabled = false;
          cutTFromPointer();
          event.stopPropagation();
          return;
        }
      }
    }
  }

  // Cutter plane drag - never orbit
  if (state.cutHelper) {
    const cutHits = state.raycaster.intersectObject(state.cutHelper, true);
    if (cutHits.length) {
      setOrbitFromPlate(false);
      state.cutDragging = true;
      if (state.controls) state.controls.enabled = false;
      cutTFromPointer();
      event.stopPropagation();
      return;
    }
  }

  // Models / pieces take priority over plate orbit
  if (state.modelGroup) {
    const modelHits = state.raycaster.intersectObjects(state.modelGroup.children, false);
    if (modelHits.length) {
      setOrbitFromPlate(false);
      const idx = modelHits[0].object.userData.placedIndex;
      if (typeof idx === 'number' && state.placed.length) {
        const hit = state.placed[idx];
        if (state.joinSession && state.joinArmed && hit && hit.sourceId != null) {
          const faceHit = modelHits[0];
          const face = captureJoinFace(faceHit);
          assignJoinClick(hit.sourceId, face);
          if (state.joinUseFaces && face) showFaceHighlight(faceHit);
          event.stopPropagation();
          return;
        }
        if (state.cutterOpen && hit && hit.sourceId != null) {
          if (hit.sourceId !== state.editId) selectPlaced(idx);
          state.cutDragging = true;
          if (state.controls) state.controls.enabled = false;
          cutTFromPointer();
          event.stopPropagation();
          return;
        }
        if (hit && hit.sourceId != null) selectPlaced(idx);
        startMoveDrag(idx, event);
        event.stopPropagation();
        return;
      }
      // Cutter open: left-drag on the piece = controlled Yaw only (not free orbit)
      if (state.cutterOpen && modelHits[0].object.userData.editPreview) {
        state.editYawDragging = true;
        state.editYawLastX = event.clientX;
        if (state.controls) state.controls.enabled = false;
        event.stopPropagation();
        return;
      }
      // preview mesh or non-placed - still block orbit
      event.stopPropagation();
      return;
    }
  }

  // Left-drag on plate OR empty background -> orbit (pieces still steal drag above)
  if (hitPlateSurface(event)) {
    setOrbitFromPlate(true);
    return;
  }

  setOrbitFromPlate(true);
}

function clearSelectionOutline() {
  state.placed.forEach((p, i) => {
    if (p.mesh) {
      if (p.outline) {
        p.mesh.remove(p.outline);
        if (p.outline.geometry) p.outline.geometry.dispose();
        if (p.outline.material) p.outline.material.dispose();
        p.outline = null;
      }
      if (p.mesh.material) {
        const hue = p.overflow ? 0.05 : (0.55 + (i % 8) * 0.03);
        p.mesh.material.color.setHSL(hue, 0.7, 0.55);
        p.mesh.material.emissive = new THREE.Color(0x000000);
        p.mesh.material.emissiveIntensity = 0;
      }
    }
  });
}

function selectPlaced(idx) {
  clearSelectionOutline();

  state.selectedIndex = idx;
  /* The open menu's guides belong to whatever is selected, so they move with
     it. Through nsoInputMode rather than by naming a module: this line used
     to call nsoRotate.refresh() alone, so Move's arrows were never told the
     selection had changed and stayed drawn around the piece before - or
     around nothing at all, once it was deselected. Asking the arbiter to
     refresh whoever owns the input covers every tool that draws one, and the
     next one added does not have to remember to edit this line. */
  if (typeof nsoInputMode !== 'undefined' && nsoInputMode)
    setTimeout(function () { nsoInputMode.refresh(); }, 0);
  else if (typeof nsoRotate !== 'undefined') setTimeout(function () { nsoRotate.refresh(); }, 0);
  const p = state.placed[idx];
  if (p && p.mesh) {
    p.mesh.material.emissive = new THREE.Color(0xdc2626);
    p.mesh.material.emissiveIntensity = 0.55;
  }
  // Keep Square-cut / Open cutter in sync with the plate selection
  if (p && p.sourceId != null) {
    const m = state.models.find(x => x.id === p.sourceId);
    if (m) {
      const isJoinBit = !!(state.joinSession && state.joinPartnerId != null && p.sourceId === state.joinPartnerId);
      if (!isJoinBit) {
        state.editId = m.id;
        if (state.joinSession) state.joinHullId = m.id;
      }
      updateEditSize();
      renderModelList();
      if (state.cutterOpen) {
        removeCutHelper();
        state.previewMesh = p.mesh;
        if (state.cutT == null) state.cutT = 0.5;
        buildCutHelper();
        setStatus('Cutter on ' + m.name + ' - drag red line, then Split.');
      }
    }
  }
  updateAdjustUI();
  updateCutterUI();
  if (typeof updateJoinUI === 'function') updateJoinUI();
}

function updateExportButton() {
  // One plate button, whichever format #export-format selects.
  const exportBtn = document.getElementById('btn-export-stl');
  if (exportBtn) exportBtn.disabled = state.placed.length === 0;
}

function updateAdjustUI() {
  if (typeof applyXrayView === 'function') applyXrayView();
  const has = state.selectedIndex >= 0 && state.placed[state.selectedIndex];
  ['btn-rot-left', 'btn-rot-right', 'btn-flip', 'btn-tip', 'btn-flip-over', 'btn-tip-face', 'btn-to-plate', 'btn-tilt-up', 'btn-tilt-dn', 'btn-bank-up', 'btn-bank-dn', 'btn-nudge-left', 'btn-nudge-right', 'btn-nudge-fwd', 'btn-nudge-back', 'btn-delete-placed', 'btn-frame-selected']
    .forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = !has;
    });
  const cloneBtn = document.getElementById('btn-clone');
  if (cloneBtn) cloneBtn.disabled = !(has || getActiveModel());
  const status = document.getElementById('adjust-status');
  if (status) {
    status.textContent = has
      ? `Selected #${state.selectedIndex + 1} - drag to move, right-click to delete`
      : (state.placed.length ? 'Left-drag a piece to move it' : 'No model selected');
  }
  const delModel = document.getElementById('btn-delete-model');
  if (delModel) delModel.disabled = !getActiveModel();
  if (typeof nsoNonSolidRefresh === 'function') nsoNonSolidRefresh();
  updateExportButton();
  // Last, so a locked selection greys the move/pose buttons just enabled above.
  if (typeof nsoPosLockRefresh === 'function') nsoPosLockRefresh();
  // The Check button names the selected piece, so it follows the selection.
  if (typeof nsoDefectsRefresh === 'function') nsoDefectsRefresh();
}

function reindexPlacedMeshes() {
  state.placed.forEach((p, i) => {
    if (p.mesh) p.mesh.userData.placedIndex = i;
  });
}

function deleteSelectedPlaced() {
  hideCtxMenu();
  const idx = state.selectedIndex;
  if (idx < 0 || !state.placed[idx]) {
    setStatus('Click or right-click a piece on the plate first', true);
    return;
  }
  const p = state.placed[idx];
  const name = p.name || ('#' + (idx + 1));
  pushUndo({
    type: 'removePlaced',
    index: idx,
    item: {
      name: p.name, x: p.x, z: p.z, yaw: p.yaw || 0,
      rotY: p.rotY || 0, flipX: !!p.flipX, tipX: p.tipX || 0,
      width: p.width, depth: p.depth, height: p.height,
      overflow: p.overflow, sourceId: p.sourceId,
      geometry: p.geometry, mesh: null, outline: null
    }
  });
  clearSelectionOutline();
  if (p.mesh && state.modelGroup) {
    state.modelGroup.remove(p.mesh);
    if (p.outline) {
      p.outline = null;
    }
    if (p.mesh.geometry && p.mesh.userData && p.mesh.userData.editPreview) {
      /* shared geo - do not dispose */
    } else if (p.mesh.material) {
      if (Array.isArray(p.mesh.material)) p.mesh.material.forEach(m => m.dispose());
      else p.mesh.material.dispose();
    }
  }
  const sourceId = p.sourceId;
  state.placed.splice(idx, 1);
  state.selectedIndex = -1;
  if (sourceId != null && !state.placed.some(function (x) { return x && x.sourceId === sourceId; })) {
    state.models = state.models.filter(function (m) { return m.id !== sourceId; });
    if (state.editId === sourceId) state.editId = null;
    if (state.joinPartnerId === sourceId) state.joinPartnerId = null;
    if (state.joinThirdId === sourceId) { state.joinThirdId = null; state.joinFaceC = null; }
    renderModelList();
  }
  reindexPlacedMeshes();
  updateAdjustUI();
  // refresh fill stats if present
  const stats = document.getElementById('stats');
  if (stats && !stats.classList.contains('hidden')) {
    const fitted = state.placed.filter(x => !x.overflow).length;
    const plate = getCurrentPlate();
    const totalArea = plate.w * plate.d;
    const usedArea = state.placed.filter(x => !x.overflow).reduce((s, x) => s + x.width * x.depth, 0);
    const fill = totalArea > 0 ? ((usedArea / totalArea) * 100).toFixed(1) : 0;
    document.getElementById('stat-count').textContent = fitted + ' models';
    document.getElementById('stat-fill').textContent = fill + '% fill';
  }
  setStatus('Deleted ' + name + ' from plate (' + state.placed.length + ' left)');
}

function deleteActiveModel() {
  const m = getActiveModel();
  if (!m) {
    setStatus('Select a model in the list first', true);
    return;
  }
  const id = m.id;
  const name = m.name;
  const idx = state.models.findIndex(x => x.id === id);
  pushUndo({ type: 'removeModel', model: m, index: idx, editId: state.editId });
  state.models = state.models.filter(x => x.id !== id);
  if (state.editId === id) {
    state.editId = state.models.length ? state.models[state.models.length - 1].id : null;
    state.cutT = 0.5;
  }
  // Also drop any placed instances from this source
  const kept = [];
  state.placed.forEach((p, i) => {
    if (p.sourceId === id) {
      if (p.mesh && state.modelGroup) {
        state.modelGroup.remove(p.mesh);
        if (p.mesh.material) {
          if (Array.isArray(p.mesh.material)) p.mesh.material.forEach(mat => mat.dispose());
          else p.mesh.material.dispose();
        }
      }
    } else {
      kept.push(p);
    }
  });
  state.placed = kept;
  state.selectedIndex = -1;
  if (typeof removeFaceHelper === 'function') removeFaceHelper();
  reindexPlacedMeshes();
  renderModelList();
  updateOptimizeButton();
  updateAdjustUI();
  updateCutterUI();
  if (state.cutterOpen && state.editId) {
    showEditPreview();
  } else if (!state.models.length) {
    clearPlaced();
    removeCutHelper();
    state.previewMesh = null;
  } else if (state.cutterOpen) {
    showEditPreview();
  }
  updateEditSize();
  setStatus('Deleted model ' + name + ' (waste/source removed)');
}

function snapshotPlacedPose(idx) {
  const p = state.placed[idx];
  if (!p) return null;
  return {
    type: 'posePlaced',
    index: idx,
    x: p.x, z: p.z,
    rotY: p.rotY || 0,
    flipX: !!p.flipX,
    tipX: p.tipX || 0,
    tipZ: p.tipZ || 0,
    liftY: p.liftY || 0,
    tiltX: p.tiltX || 0,
    tiltZ: p.tiltZ || 0,
    width: p.width, depth: p.depth, height: p.height,
    yaw: p.yaw || 0,
    /* The mesh's own height, as it was. A piece dropped by ingest rests at
       +0.3 (m.size.y / 2 + 0.3) while every pose/move re-seats it on the
       0.2 baseline (applyMeshRotation, settlePlacedOnBed) - so re-deriving
       y on Undo put a freshly dropped piece back 0.1 mm lower than it was.
       Undo restores this value instead of re-deriving it. */
    meshY: p.mesh ? p.mesh.position.y : null
  };
}

function rotateSelected(dir) {
  const p = state.placed[state.selectedIndex];
  if (!p || !p.mesh) return;
  if (typeof nsoPosLockBlocks === 'function' && nsoPosLockBlocks(p, 'yaw')) return;
  pushUndo(snapshotPlacedPose(state.selectedIndex));

  p.rotY = (p.rotY || 0) + dir * (Math.PI / 2);
  p.rotated = Math.abs(Math.sin(p.rotY)) > 0.5;
  applyMeshRotation(p);
  refreshOutline(p);
  updateExportButton();
  setStatus(`Yaw #${state.selectedIndex + 1}`);
}

function flipSelected() {
  const p = state.placed[state.selectedIndex];
  if (!p || !p.mesh) {
    setStatus('Select a piece first', true);
    return;
  }
  if (typeof nsoPosLockBlocks === 'function' && nsoPosLockBlocks(p, 'edge flip')) return;
  pushUndo(snapshotPlacedPose(state.selectedIndex));
  p.rotY = (p.rotY || 0) + Math.PI;
  applyMeshRotation(p);
  refreshOutline(p);
  updateExportButton();
  setStatus('Edge 180°');
}

// Tip 90 deg around X - cycles which face sits on the bed (any model)
function tipSelected() {
  const p = state.placed[state.selectedIndex];
  if (!p || !p.mesh) return;
  if (typeof nsoPosLockBlocks === 'function' && nsoPosLockBlocks(p, 'tip')) return;
  pushUndo(snapshotPlacedPose(state.selectedIndex));

  p.tipX = ((p.tipX || 0) + 1) % 4; // 0,1,2,3 -> 0,90,180,270 deg
  applyMeshRotation(p);
  refreshOutline(p);
  updateExportButton();
  setStatus('Tip X ' + ((p.tipX || 0) * 90) + '°');
}

function rollSelected() {
  const p = state.placed[state.selectedIndex];
  if (!p || !p.mesh) return;
  if (typeof nsoPosLockBlocks === 'function' && nsoPosLockBlocks(p, 'roll')) return;
  pushUndo(snapshotPlacedPose(state.selectedIndex));
  p.tipZ = ((p.tipZ || 0) + 1) % 4;
  applyMeshRotation(p);
  refreshOutline(p);
  updateExportButton();
  setStatus('Roll Z ' + ((p.tipZ || 0) * 90) + '°');
}

function liftSelected(dir) {
  const p = state.placed[state.selectedIndex];
  if (!p || !p.mesh) return;
  if (typeof nsoPosLockBlocks === 'function' && nsoPosLockBlocks(p, 'raise/lower')) return;
  pushUndo(snapshotPlacedPose(state.selectedIndex));
  const step = 2;
  p.liftY = Math.max(0, Math.min(80, (p.liftY || 0) + dir * step));
  applyMeshRotation(p);
  refreshOutline(p);
  setStatus(p.liftY ? ('Lift ' + p.liftY.toFixed(0) + ' mm') : 'On plate');
}

/* Bring the selected piece down to rest on the plate, in one press.

   The vertical control is a ladder, and a ladder is useless for recovery. It
   was Raise and Lower at 2 mm a press when this was written; those buttons are
   retired and the Move menu's Vertical slider and arrows own the axis now, at
   0.25 mm a press. That made the arithmetic worse, not better: a piece Seat
   (support) has stacked on a 20 mm target comes back with liftY 20.18, which is
   eighty presses of the arrow. The slider can be dragged to zero in one go, but
   only for a piece whose record still agrees with where it is - a piece a seat
   left in the air over a target that has since been deleted or moved has liftY
   0 already and nothing under it at all.

   Which is the second half of it, and the half no vertical control can fix.
   Every one of them - liftSelected, the Vertical arrows, the slider - writes
   liftY and then calls applyMeshRotation, which rebuilds the mesh's rotation
   from the placed record's pose fields: rotY, flipX, tipX, tipZ, tiltX, tiltZ.
   A piece the seat laid on a slope carries a free quaternion none of those
   fields can hold, so the first step throws the angle the seat gave it away,
   and the piece is still in the air. (Undo cannot put it back either:
   snapshotPlacedPose carries the same fields. Both measured in
   tools/nso_bring_to_plate_test.js section 4.)

   This goes through settlePlacedOnBed instead, which measures the piece's own
   world box and only ever writes y: the lowest point of the piece lands on the
   bed baseline from any pose - a tilted piece on its lowest corner, a piece
   pushed out of the build volume back inside it, because settlePlacedOnBed
   clears the overflow flag and the offset with it.

   The vertical half of a move and nothing else - x, z and the piece's own
   rotation are untouched. One Undo, like every other pose button, and a
   locked piece refuses it exactly as it refuses the vertical step: btn-to-plate
   is in app-poslock's ADJUST_IDS and in updateAdjustUI's roster. */
function bringSelectedToPlate() {
  const p = state.placed[state.selectedIndex];
  if (!p || !p.mesh) return;
  if (typeof nsoPosLockBlocks === 'function' && nsoPosLockBlocks(p, 'bring to plate')) return;
  p.mesh.updateMatrixWorld(true);
  const wasAt = meshLocalBox3(p.mesh).min.y;
  /* already resting on it, and the record agrees: say so and touch nothing,
     so the Undo stack does not collect entries that undo nothing */
  if (!(p.liftY || 0) && Math.abs(wasAt - 0.2) <= 1e-6) {
    setStatus('Already on the plate');
    return;
  }
  pushUndo(snapshotPlacedPose(state.selectedIndex));
  p.liftY = 0;
  settlePlacedOnBed(p);
  p.mesh.updateMatrixWorld(true);
  refreshOutline(p);
  updateExportButton();
  const moved = wasAt - 0.2;
  setStatus('On the plate - ' + (moved < 0 ? 'up ' : 'down ') + Math.abs(moved).toFixed(2) + ' mm');
}

function bankSelected(dir) {
  const p = state.placed[state.selectedIndex];
  if (!p || !p.mesh) return;
  if (typeof nsoPosLockBlocks === 'function' && nsoPosLockBlocks(p, 'bank')) return;
  pushUndo(snapshotPlacedPose(state.selectedIndex));
  p.tiltZ = (p.tiltZ || 0) + dir * 15;
  if (p.tiltZ > 180) p.tiltZ -= 360;
  if (p.tiltZ < -180) p.tiltZ += 360;
  applyMeshRotation(p);
  refreshOutline(p);
  updateExportButton();
  setStatus('Bank ' + p.tiltZ + '°');
}

function tiltSelected(dir) {
  const p = state.placed[state.selectedIndex];
  if (!p || !p.mesh) return;
  if (typeof nsoPosLockBlocks === 'function' && nsoPosLockBlocks(p, 'pitch')) return;
  pushUndo(snapshotPlacedPose(state.selectedIndex));
  p.tiltX = (p.tiltX || 0) + dir * 15;
  if (p.tiltX > 180) p.tiltX -= 360;
  if (p.tiltX < -180) p.tiltX += 360;
  applyMeshRotation(p);
  refreshOutline(p);
  updateExportButton();
  setStatus('Tilt ' + p.tiltX + '°');
}

function applyMeshRotation(p) {
  const tip = (p.tipX || 0) * (Math.PI / 2) + ((p.tiltX || 0) * Math.PI / 180);
  const flip = p.flipX ? Math.PI : 0;
  const roll = (p.tipZ || 0) * (Math.PI / 2) + ((p.tiltZ || 0) * Math.PI / 180);
  p.mesh.rotation.set(tip + flip, p.rotY || 0, roll);
  p.mesh.updateMatrixWorld(true);
  const bbox = meshLocalBox3(p.mesh);
  const size = new THREE.Vector3();
  bbox.getSize(size);
  p.width = size.x;
  p.depth = size.z;
  p.height = size.y;
  const lift = p.liftY || 0;
  p.mesh.position.set(p.x, p.height / 2 + 0.2 + lift, p.z);
  if (p.overflow || p.meshOffsetY) {
    p.overflow = false;
    p.meshOffsetY = 0;
  }
}

/* The pose record and the mesh must say the same thing. Every rebuild of a
   placed mesh starts it at identity, so after one there are exactly two
   honest endings:

   - the new geometry is in the piece's own frame (a bake from rawTris or
     model.geometry - Mirror, Soften, Seal, an Undo): the pose still stands,
     so put it back on the mesh. nsoReseatPlacedPose.
   - the new geometry already carries the pose (Join and Subtract build from
     world soups, or rebuild at identity on purpose): the pose was consumed,
     so clear it off the record. nsoClearPlacedPose.

   Leaving the record posed while the mesh sits at identity is the bug these
   exist for. Nothing on screen shows it. The next bake that honours the
   record (NSO_sculptCommitRaw) re-applies the stale pose, and a piece that
   was edge-flipped before a Join comes out of a Mirror turned 180 degrees. */
function nsoPlacedIsPosed(p) {
  return !!(p && (p.rotY || p.tipX || p.tiltX || p.flipX || p.tipZ || p.tiltZ || p.liftY));
}
function nsoReseatPlacedPose(p) {
  if (nsoPlacedIsPosed(p) && p.mesh) applyMeshRotation(p);
}
function nsoPlacedPoseSnapshot(p) {
  return {
    rotY: p.rotY || 0, rotated: !!p.rotated, flipX: !!p.flipX,
    tipX: p.tipX || 0, tipZ: p.tipZ || 0, tiltX: p.tiltX || 0, tiltZ: p.tiltZ || 0,
    liftY: p.liftY || 0
  };
}
function nsoClearPlacedPose(p) {
  if (!p) return;
  p.rotY = 0; p.rotated = false; p.flipX = false;
  p.tipX = 0; p.tipZ = 0; p.tiltX = 0; p.tiltZ = 0;
  p.liftY = 0;
}

function refreshOutline(p) {
  if (!p) return;
  if (p.outline) {
    if (p.mesh) p.mesh.remove(p.outline);
    if (p.outline.geometry) p.outline.geometry.dispose();
    if (p.outline.material) p.outline.material.dispose();
    p.outline = null;
  }
}

function nudgeSelected(dx, dz) {
  const p = state.placed[state.selectedIndex];
  if (!p || !p.mesh) return;
  if (typeof nsoPosLockBlocks === 'function' && nsoPosLockBlocks(p, 'nudge')) return;
  pushUndo({ type: 'movePlaced', index: state.selectedIndex, x: p.x, z: p.z, meshY: p.mesh.position.y });
  applyPlacedXZ(p, p.x + dx, p.z + dz);
  holdPlateGridAuto();
  updateExportButton();
  if (!reportJoinFlushGap()) setStatus(`Moved model #${state.selectedIndex + 1}`);
}

// ===================== Export =====================
// Three.js is Y-up. Bambu / most slicers are Z-up.
// Convert (x, y, z)_three -> (x, z, y)_slicer so the plate lies flat.
function buildCombinedGeometry() {
  const positions = [];
  state.placed.forEach(p => {
    const geo = p.geometry.clone();
    const tip = (p.tipX || 0) * (Math.PI / 2) + ((p.tiltX || 0) * Math.PI / 180);
    const flip = p.flipX ? Math.PI : 0;
    if (tip || flip) geo.rotateX(tip + flip);
    const rotY = p.rotY != null ? p.rotY : (p.rotated ? Math.PI / 2 : 0);
    if (rotY) geo.rotateY(rotY);
    const roll = (p.tipZ || 0) * (Math.PI / 2) + ((p.tiltZ || 0) * Math.PI / 180);
    if (roll) geo.rotateZ(roll);
    // liftY rides along: a piece Seated with a gap, or lifted, exports where
    // the scene shows it, not dropped back onto the plate.
    geo.translate(p.x, p.height / 2 + (p.liftY || 0), p.z);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i); // height in Three.js
      const z = pos.getZ(i);
      // Inverse of import: (x,y,z)_Yup -> (x,-z,y)_Zup for Bambu
      positions.push(x, -z, y);
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geo;
}

// Binary STL is smaller and more reliable than ASCII
function geometryToBinarySTL(geometry) {
  const pos = geometry.attributes.position;
  const numTriangles = Math.floor(pos.count / 3);
  const bufferLength = 84 + numTriangles * 50;
  const buffer = new ArrayBuffer(bufferLength);
  const view = new DataView(buffer);

  // 80-byte header
  const header = 'Nest Optimizer';
  for (let i = 0; i < 80; i++) {
    view.setUint8(i, i < header.length ? header.charCodeAt(i) : 0);
  }
  view.setUint32(80, numTriangles, true);

  let offset = 84;
  for (let i = 0; i < numTriangles; i++) {
    const i3 = i * 3;
    const ax = pos.getX(i3), ay = pos.getY(i3), az = pos.getZ(i3);
    const bx = pos.getX(i3 + 1), by = pos.getY(i3 + 1), bz = pos.getZ(i3 + 1);
    const cx = pos.getX(i3 + 2), cy = pos.getY(i3 + 2), cz = pos.getZ(i3 + 2);

    // Simple normal (not critical for import)
    view.setFloat32(offset, 0, true); offset += 4;
    view.setFloat32(offset, 0, true); offset += 4;
    view.setFloat32(offset, 0, true); offset += 4;

    view.setFloat32(offset, ax, true); offset += 4;
    view.setFloat32(offset, ay, true); offset += 4;
    view.setFloat32(offset, az, true); offset += 4;
    view.setFloat32(offset, bx, true); offset += 4;
    view.setFloat32(offset, by, true); offset += 4;
    view.setFloat32(offset, bz, true); offset += 4;
    view.setFloat32(offset, cx, true); offset += 4;
    view.setFloat32(offset, cy, true); offset += 4;
    view.setFloat32(offset, cz, true); offset += 4;

    view.setUint16(offset, 0, true); offset += 2; // attribute byte count
  }
  return buffer;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.style.display = 'none';
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 200);
}

function exportSTLs() {
  if (!state.placed.length) {
    setStatus('Nothing to export - run Optimize first', true);
    return;
  }

  setStatus('Building STL...');

  try {
    const geo = buildCombinedGeometry();
    const buffer = geometryToBinarySTL(geo);
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const plateName = getCurrentPlate().name.replace(/\s+/g, '_').replace(/[\/\\?%*:|"<>]/g, '');
    const filename = `nest_${plateName}_${state.placed.length}pcs.stl`;

    downloadBlob(blob, filename);
    setStatus(`Downloaded ${filename}`);
  } catch (err) {
    console.error(err);
    setStatus('Export failed - check console', true);
  }
}


// ===================== Export format (STL / 3MF) =====================
// One choice, #export-format, drives both export buttons and the right-click
// Export item: "Download selected" and "Export plate" each write STL or a
// Bambu Studio 3MF project depending on it. The cooling-profile row is only
// shown for 3MF because STL has nowhere to carry those settings.

const EXPORT_FORMAT_STORAGE_KEY = 'nso.exportFormat';
const EXPORT_FORMATS = ['stl', '3mf'];

function getExportFormat() {
  const sel = document.getElementById('export-format');
  const v = sel && sel.value;
  return EXPORT_FORMATS.indexOf(v) !== -1 ? v : 'stl';
}

/** Relabel the buttons and show / hide the cooling row for the current format. */
function updateExportFormatUI() {
  const fmt = getExportFormat();
  const label = fmt === '3mf' ? '3MF' : 'STL';
  const btnModel = document.getElementById('btn-export-model');
  if (btnModel) btnModel.textContent = 'Download selected ' + label;
  const btnPlate = document.getElementById('btn-export-stl');
  if (btnPlate) btnPlate.textContent = 'Export plate ' + label;
  const ctx = document.getElementById('ctx-export');
  if (ctx) ctx.textContent = 'Export ' + label;
  const row = document.getElementById('cooling-profile-row');
  if (row) row.hidden = fmt !== '3mf';
}

function setupExportFormatUI() {
  const sel = document.getElementById('export-format');
  if (!sel) return;

  let saved = null;
  try { saved = localStorage.getItem(EXPORT_FORMAT_STORAGE_KEY); } catch (e) {}
  // 3MF is only offered when its modules actually loaded.
  const can3mf = !!(window.NSO3MF && window.NSOCoolingProfiles);
  if (!can3mf) {
    const opt = sel.querySelector('option[value="3mf"]');
    if (opt) opt.disabled = true;
  }
  sel.value = (EXPORT_FORMATS.indexOf(saved) !== -1 && (saved !== '3mf' || can3mf)) ? saved : 'stl';

  sel.addEventListener('change', () => {
    try { localStorage.setItem(EXPORT_FORMAT_STORAGE_KEY, sel.value); } catch (e) {}
    updateExportFormatUI();
    setStatus(sel.value === '3mf'
      ? 'Export format: 3MF - Bambu Studio project with the selected cooling profile baked in'
      : 'Export format: STL');
  });

  updateExportFormatUI();
}

/** "Export plate" - whole nested plate in the selected format. */
function exportPlate() {
  return getExportFormat() === '3mf' ? export3MF() : exportSTLs();
}

/** "Download selected" and right-click Export - the active model in the selected format. */
function exportSelected() {
  if (getExportFormat() === '3mf') return exportActiveModel3MF();
  // exportActiveModel lives in app-join.js; classic scripts, resolved at click time.
  if (typeof exportActiveModel === 'function') return exportActiveModel();
  setStatus('STL export is not available - check console', true);
}

// ===================== 3MF export (baked cooling settings) =====================
// Writes a Bambu Studio project with the selected cooling profile baked into
// Metadata/project_settings.config. The profile table lives in
// nso-cooling-profiles.js, the archive writer in nso-3mf.js; both are plain
// classic scripts loaded ahead of this one, and both also run under Node so
// tools/3mf-test can exercise the same code.

const COOLING_PROFILE_STORAGE_KEY = 'nso.coolingProfile';

function getCoolingProfileId() {
  const sel = document.getElementById('cooling-profile');
  if (sel && sel.value) return sel.value;
  const Profiles = window.NSOCoolingProfiles;
  return Profiles ? Profiles.DEFAULT_PROFILE_ID : 'default';
}

function updateCoolingProfileNote() {
  const Profiles = window.NSOCoolingProfiles;
  const note = document.getElementById('cooling-profile-note');
  if (!Profiles || !note) return;
  const profile = Profiles.getProfile(getCoolingProfileId());
  if (!profile) { note.textContent = ''; return; }
  note.textContent = profile.tuned
    ? profile.note
    : profile.note + ' Exports identical to Default for now.';
}

function setupCoolingProfileUI() {
  const Profiles = window.NSOCoolingProfiles;
  const sel = document.getElementById('cooling-profile');
  if (!Profiles || !sel) return;

  sel.innerHTML = '';
  Profiles.listProfiles().forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label;
    sel.appendChild(opt);
  });

  let saved = null;
  try { saved = localStorage.getItem(COOLING_PROFILE_STORAGE_KEY); } catch (e) {}
  sel.value = Profiles.hasProfile(saved) ? saved : Profiles.DEFAULT_PROFILE_ID;

  sel.addEventListener('change', () => {
    try { localStorage.setItem(COOLING_PROFILE_STORAGE_KEY, sel.value); } catch (e) {}
    updateCoolingProfileNote();
    const profile = Profiles.getProfile(sel.value);
    setStatus('Cooling profile: ' + (profile ? profile.label : sel.value));
  });

  updateCoolingProfileNote();
}

/**
 * One 3MF object per placed piece, in absolute plate coordinates.
 *
 * The transform chain is buildCombinedGeometry()'s, kept per piece instead of
 * merged so Bambu Studio shows separate objects. The packer works plate-centred
 * with Three.js Y up; Bambu wants Z up with the plate origin at the front-left
 * corner, so the same (x, y, z) -> (x, -z, y) swap applies and then a shift by
 * half the plate.
 */
function buildPlacedObjects3MF() {
  const plate = getCurrentPlate();
  const halfW = plate.w / 2;
  const halfD = plate.d / 2;

  return state.placed.map((p, i) => {
    const geo = p.geometry.clone();
    const tip = (p.tipX || 0) * (Math.PI / 2) + ((p.tiltX || 0) * Math.PI / 180);
    const flip = p.flipX ? Math.PI : 0;
    if (tip || flip) geo.rotateX(tip + flip);
    const rotY = p.rotY != null ? p.rotY : (p.rotated ? Math.PI / 2 : 0);
    if (rotY) geo.rotateY(rotY);
    const roll = (p.tipZ || 0) * (Math.PI / 2) + ((p.tiltZ || 0) * Math.PI / 180);
    if (roll) geo.rotateZ(roll);
    // liftY rides along: a piece Seated with a gap, or lifted, exports where
    // the scene shows it, not dropped back onto the plate.
    geo.translate(p.x, p.height / 2 + (p.liftY || 0), p.z);

    const pos = geo.attributes.position;
    const flat = [];
    for (let v = 0; v < pos.count; v++) {
      flat.push(
        pos.getX(v) + halfW,   // Bambu X
        -pos.getZ(v) + halfD,  // Bambu Y
        pos.getY(v)            // Bambu Z (height, plate at 0)
      );
    }
    const mesh = window.NSO3MF.indexTriangleSoup(flat);
    return {
      name: p.name || ('piece_' + (i + 1)),
      vertices: mesh.vertices,
      triangles: mesh.triangles
    };
  });
}

// ===================== 3MF scene state =====================
// Save and restore the whole working plate through the same archive, in
// Metadata/nso_scene.json. nso-3mf-scene.js owns the schema and the transform
// maths; everything here is the app side of it - reading the live state out on
// export, and putting it back on import.
//
// WHERE EACH VALUE COMES FROM. Nothing below re-derives a value that the app
// already holds; each one is read through the accessor its own module
// publishes, so a change there reaches the file without a second definition
// drifting behind it:
//
//   position / pose   the placed entry's own fields, the ones every exporter
//                     already reads (x, z, liftY, rotY, flipX, tipX, tipZ,
//                     tiltX, tiltZ, yaw, rotated)
//   piece lock        nsoPosLocked(m)          app-poslock.js
//   plate lock        nsoPlateLocked()         app-poslock.js
//   seat gap          p.seat                   app-join.js, recorded by Seat
//   skin              m.skin                   app-skin.js, recorded by a bake
//   paint             nsoMaskSnapshot(m)       app-mask.js
//   non-solid         nsoNonSolid(m)           app-nonsolid.js
//
// A module that is not loaded simply contributes nothing - every read below is
// guarded, so the scene block degrades to "geometry and pose" rather than
// failing the export.

/** The model a placed piece was made from, or null. */
function modelOfPlaced(p) {
  if (!p || p.sourceId == null) return null;
  return state.models.find(m => m.id === p.sourceId) || null;
}

/** The centre of a geometry's own bounding box, without disturbing its cache. */
function geometryCenter(geo) {
  const bb = new THREE.Box3().setFromBufferAttribute(geo.attributes.position);
  const c = new THREE.Vector3();
  bb.getCenter(c);
  return c;
}

/**
 * The transform the export baked into one piece, expressed against the piece's
 * CENTRED geometry - which is what addModel hands back on the way in, so the
 * inverse lands on exactly the geometry a restore can re-ingest.
 *
 * NSO3MFScene.poseBasis() is the one definition of the chain; this only
 * re-anchors its origin onto the geometry's own centre.
 */
function pieceBasis3MF(p, plate) {
  const Scene = window.NSO3MFScene;
  const M = Scene.poseBasis({
    x: p.x, z: p.z,
    rotY: p.rotY, rotated: p.rotated, flipX: p.flipX,
    tipX: p.tipX, tipZ: p.tipZ, tiltX: p.tiltX, tiltZ: p.tiltZ,
    liftY: p.liftY, height: p.height
  }, plate);
  const c = geometryCenter(p.geometry);
  const t = Scene.apply12(M, c.x, c.y, c.z);
  return M.slice(0, 9).concat([t[0], t[1], t[2]]);
}

/** Everything the scene block records for one placed piece. */
function capturePieceState(p, i, plate) {
  const m = modelOfPlaced(p);
  const paint = (m && typeof window.nsoMaskSnapshot === 'function')
    ? window.nsoMaskSnapshot(m) : null;
  return {
    name: p.name || ('piece_' + (i + 1)),
    sourceId: p.sourceId,
    basis: pieceBasis3MF(p, plate),
    centerOffset: (m && m.centerOffset) ? m.centerOffset : null,
    pose: {
      x: p.x, z: p.z, liftY: p.liftY || 0, overflow: !!p.overflow,
      rotY: (p.rotY != null ? p.rotY : (p.rotated ? Math.PI / 2 : 0)),
      yaw: p.yaw || 0, flipX: !!p.flipX,
      tipX: p.tipX || 0, tipZ: p.tipZ || 0,
      tiltX: p.tiltX || 0, tiltZ: p.tiltZ || 0,
      rotated: !!p.rotated,
      width: p.width, depth: p.depth, height: p.height
    },
    locked: !!(m && typeof window.nsoPosLocked === 'function' && window.nsoPosLocked(m)),
    seat: p.seat || null,
    skin: (m && m.skin) ? m.skin : null,
    paint: paint ? { exclude: paint.exclude, select: paint.select } : null,
    nonSolid: !!(m && typeof window.nsoNonSolid === 'function' && window.nsoNonSolid(m))
  };
}

/** The serialized scene block for the current plate, or null if unavailable. */
function buildPlateSceneJson() {
  const Scene = window.NSO3MFScene;
  if (!Scene) return null;
  const plate = getCurrentPlate();
  try {
    const block = Scene.capture({
      scope: 'plate',
      plate: {
        id: state.plate,
        name: plate.name,
        w: plate.w,
        d: plate.d,
        locked: !!(typeof window.nsoPlateLocked === 'function' && window.nsoPlateLocked())
      },
      selection: { placedIndex: state.selectedIndex, editId: state.editId },
      pieces: state.placed.map((p, i) => capturePieceState(p, i, plate))
    });
    return Scene.serialize(block);
  } catch (err) {
    // A scene block is an addition to the export, never a reason to lose it.
    console.error('3MF scene capture failed; exporting geometry only', err);
    return null;
  }
}

/**
 * The scene block for the one-model export route. The piece has no plate pose
 * on this route - buildActiveModelObject3MF centres it on the plate resting on
 * z = 0 - so `basis` is that placement and the pose fields are the identity.
 * Its model state (paint, skin, non-solid, lock) is the real thing.
 */
function buildModelSceneJson(m, basis) {
  const Scene = window.NSO3MFScene;
  if (!Scene || !basis) return null;
  const plate = getCurrentPlate();
  const paint = (typeof window.nsoMaskSnapshot === 'function') ? window.nsoMaskSnapshot(m) : null;
  try {
    const block = Scene.capture({
      scope: 'model',
      plate: { id: state.plate, name: plate.name, w: plate.w, d: plate.d, locked: false },
      selection: { placedIndex: null, editId: m.id },
      pieces: [{
        name: m.name || 'piece',
        sourceId: m.id,
        basis: basis,
        centerOffset: m.centerOffset || null,
        pose: {
          x: 0, z: 0, liftY: 0, overflow: false,
          rotY: 0, yaw: 0, flipX: false, tipX: 0, tipZ: 0, tiltX: 0, tiltZ: 0,
          rotated: false,
          width: m.size.x, depth: m.size.z, height: m.size.y
        },
        locked: !!(typeof window.nsoPosLocked === 'function' && window.nsoPosLocked(m)),
        seat: null,
        skin: m.skin || null,
        paint: paint ? { exclude: paint.exclude, select: paint.select } : null,
        nonSolid: !!(typeof window.nsoNonSolid === 'function' && window.nsoNonSolid(m))
      }]
    });
    return Scene.serialize(block);
  } catch (err) {
    console.error('3MF scene capture failed; exporting geometry only', err);
    return null;
  }
}

/* ---- restore ---- */

/**
 * The per-model half of a scene entry: the flags and lists that belong to the
 * piece itself rather than to where it sits. Each goes back through the setter
 * its own module publishes, so the indicators, the HUD and the undo stack all
 * see it the way a user setting it would.
 *
 * The lock is applied last: it blocks the move surface, and putting a piece
 * where it belongs is exactly what that surface does.
 */
function applyModelSceneState(m, so) {
  // Paint only when there is some: restoring an empty snapshot would leave a
  // piece that was never painted carrying a faceMask, where a fresh import
  // leaves it with none. The same thing to every consumer, but not the same
  // object, and the round-trip check compares objects.
  if (so.paint && (so.paint.exclude.length || so.paint.select.length) &&
      typeof window.nsoMaskRestore === 'function') {
    window.nsoMaskRestore(m, { exclude: so.paint.exclude, select: so.paint.select });
  }
  if (so.skin) m.skin = so.skin;
  if (so.nonSolid && typeof window.nsoNonSolidSet === 'function') {
    window.nsoNonSolidSet(m, true, { noUndo: true, silent: true });
  }
  if (so.locked && typeof window.nsoPosLockSet === 'function') {
    window.nsoPosLockSet(m, true, { noUndo: true, silent: true });
  }
}

/**
 * Rebuild one piece from its imported geometry and its scene entry.
 *
 * The imported soup is in plate coordinates. Inverting `basis` gives the
 * piece's centred display geometry back; adding the model's own centerOffset
 * and swapping Y up -> Z up gives its rawTris back IN THE FRAME IT HAD, which
 * is what makes the raw-space paint planes and the skin record meaningful
 * again rather than approximately right.
 *
 * @returns {object|null} the placed entry
 */
function restoreSceneObject(so, positions) {
  const Scene = window.NSO3MFScene;
  const disp = Scene.transformSoup(so.inverse, positions);
  const C = so.centerOffset || { x: 0, y: 0, z: 0 };
  const raw = new Float32Array(disp.length);
  for (let i = 0; i + 2 < disp.length; i += 3) {
    const a = disp[i] + C.x, b = disp[i + 1] + C.y, c = disp[i + 2] + C.z;
    raw[i] = a;            // zUpToYUp is (x, y, z) -> (x, z, -y); this inverts it
    raw[i + 1] = -c;
    raw[i + 2] = b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(raw, 3));
  const id = addModelFromZUpGeometry(so.name, geometry, { silent: true });
  if (id == null) return null;
  const m = state.models.find(x => x.id === id);
  if (!m) return null;

  // ---- put it on the plate, then pose it ----
  const entry = placeModelMovable(m, so.pose.x, so.pose.z);
  if (!entry) return null;
  entry.name = so.name;
  entry.yaw = so.pose.yaw;
  entry.rotated = so.pose.rotated;
  applyPlacedOrientation(entry, so.pose);
  entry.overflow = !!so.pose.overflow;
  if (so.seat) entry.seat = so.seat;
  applyModelSceneState(m, so);
  return entry;
}

/**
 * Restore a whole plate from a scene block.
 *
 * Replacing the plate is the point of the feature - a half-restore into a
 * plate that already has pieces reproduces nothing - so a populated plate is
 * confirmed first, and a decline falls back to the plain geometry import.
 *
 * @returns {number|null} pieces restored, or null when the caller should do
 *          the ordinary geometry-only import instead
 */
function restoreSceneFrom3MF(filename, result, scene) {
  if (scene.objects.length !== result.objects.length) {
    console.warn(filename + ': scene block lists ' + scene.objects.length +
                 ' object(s) but the model has ' + result.objects.length +
                 ' - importing geometry only');
    return null;
  }

  const replacing = scene.scope === 'plate' && state.placed.length > 0;
  if (replacing) {
    const ok = window.confirm(
      filename + ' carries a saved NSO plate (' + scene.objects.length + ' piece(s)).\n\n' +
      'Restore it? The ' + state.placed.length + ' piece(s) now on the plate are removed. ' +
      'Cancel imports the geometry alongside them instead.');
    if (!ok) return null;
  }
  if (scene.scope === 'plate') {
    clearPlaced();
    restoreScenePlate(scene.plate);
  }

  let restored = 0;
  scene.objects.forEach((so, i) => {
    try {
      if (scene.scope === 'model') {
        // A one-model file has no plate arrangement to rebuild - the geometry
        // IS the model. It takes the ordinary import path, untouched, so this
        // route keeps the placement contract nso_export_roundtrip_test.js pins
        // for it; the block adds the piece's own flags and lists and nothing
        // else.
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(result.objects[i].positions, 3));
        const id = addModelFromZUpGeometry(so.name, geometry);
        if (id == null) return;
        const m = state.models.find(x => x.id === id);
        if (!m) return;
        applyModelSceneState(m, so);
        restored++;
      } else if (restoreSceneObject(so, result.objects[i].positions)) {
        restored++;
      }
    } catch (err) {
      console.error(filename + ': piece "' + so.name + '" could not be restored', err);
    }
  });

  if (scene.scope === 'plate' && typeof window.nsoPlateLockSet === 'function') {
    window.nsoPlateLockSet(!!scene.plate.locked, { noUndo: true, silent: true });
  }
  if (scene.selection.editId != null && restored) {
    // ids are handed out fresh on import, so the saved one cannot be reused;
    // select the piece that held it by its position in the file instead.
    const idx = scene.objects.findIndex(o => o.sourceId === scene.selection.editId);
    if (idx >= 0 && state.placed[idx]) selectPlaced(idx);
  }
  if (typeof updateAdjustUI === 'function') updateAdjustUI();
  if (typeof renderModelList === 'function') renderModelList();
  return restored;
}

/**
 * Put the plate preset back. The piece coordinates in a scene block are
 * plate-centred, so they only mean what they meant on the plate they were
 * saved from. Unknown preset ids are left alone rather than guessed at - the
 * pieces still land where the file says, on whatever plate is selected.
 */
function restoreScenePlate(saved) {
  if (!saved || !saved.id) return;
  const sel = document.getElementById('plate-select');
  if (saved.id === 'custom') {
    const w = document.getElementById('custom-w');
    const d = document.getElementById('custom-d');
    if (w && saved.w) w.value = saved.w;
    if (d && saved.d) d.value = saved.d;
  } else if (!PLATES[saved.id]) {
    return;
  }
  state.plate = saved.id;
  if (sel) sel.value = saved.id;
  const custom = document.getElementById('custom-size');
  if (custom) custom.classList.toggle('hidden', state.plate !== 'custom');
  if (typeof updatePlateInfo === 'function') updatePlateInfo();
}

/** The scene block of an imported 3MF, or null when there is none to use. */
function readSceneBlock(filename, result) {
  if (!result || !result.sceneJson || !window.NSO3MFScene) return null;
  try {
    return window.NSO3MFScene.parse(result.sceneJson);
  } catch (err) {
    // A block this build cannot read is a warning, never a failed import: the
    // geometry in the file is still good.
    console.warn(filename + ': ' + err.message + ' - importing geometry only');
    return null;
  }
}

function export3MF() {
  if (!window.NSO3MF || !window.NSOCoolingProfiles) {
    setStatus('3MF modules failed to load - check console', true);
    return Promise.resolve(null);
  }
  if (!state.placed.length) {
    setStatus('Nothing to export - run Optimize first', true);
    return Promise.resolve(null);
  }

  const profileId = getCoolingProfileId();
  setStatus('Building 3MF...');

  let objects;
  try {
    objects = buildPlacedObjects3MF();
  } catch (err) {
    console.error(err);
    setStatus('Export failed while reading the plate - check console', true);
    return Promise.resolve(null);
  }

  const plate = getCurrentPlate();
  const sceneJson = buildPlateSceneJson();
  return window.NSO3MF.build3MF({ objects, profileId, plateName: plate.name, sceneJson })
    .then(result => {
      const blob = new Blob([result.bytes], { type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml' });
      const plateName = plate.name.replace(/\s+/g, '_').replace(/[\/\\?%*:|"<>]/g, '');
      const filename = `nest_${plateName}_${state.placed.length}pcs.3mf`;
      downloadBlob(blob, filename);
      const profile = window.NSOCoolingProfiles.getProfile(result.profileId);
      setStatus(`Downloaded ${filename} - cooling profile "${profile ? profile.label : result.profileId}" baked in` +
                (result.scene ? ' - scene saved, reopen this file to get the plate back' : ''));
      return result;
    })
    .catch(err => {
      console.error(err);
      setStatus('3MF export failed: ' + (err && err.message ? err.message : 'unknown error'), true);
      return null;
    });
}

/**
 * The active model alone, as a one-object 3MF with the cooling profile baked
 * in - the 3MF counterpart of exportActiveModel() in app-join.js.
 *
 * Same axis swap as the STL path, (x, y, z) -> (x, -z, y), and the same
 * non-finite-triangle filter. Unlike STL, a 3MF project carries placement, so
 * the piece is set down resting on z = 0 at the centre of the current plate
 * rather than left around the model's own origin.
 */
function buildActiveModelObject3MF(m) {
  let geo = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
  if (!geo.attributes || !geo.attributes.position) return null;
  if (geo === m.geometry) geo = geo.clone();
  const pos = geo.attributes.position;
  const flat = [];
  let dropped = 0;
  const triCount = Math.floor(pos.count / 3);
  for (let t = 0; t < triCount; t++) {
    const tri = [];
    let ok = true;
    for (let k = 0; k < 3; k++) {
      const i = t * 3 + k;
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) { ok = false; break; }
      tri.push(x, -z, y);
    }
    if (!ok) { dropped++; continue; }
    for (let k = 0; k < 9; k++) flat.push(tri[k]);
  }
  if (flat.length < 9) return null;

  // Rest on the plate, centred in X/Y.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity;
  for (let i = 0; i < flat.length; i += 3) {
    if (flat[i] < minX) minX = flat[i];
    if (flat[i] > maxX) maxX = flat[i];
    if (flat[i + 1] < minY) minY = flat[i + 1];
    if (flat[i + 1] > maxY) maxY = flat[i + 1];
    if (flat[i + 2] < minZ) minZ = flat[i + 2];
  }
  const plate = getCurrentPlate();
  const dx = plate.w / 2 - (minX + maxX) / 2;
  const dy = plate.d / 2 - (minY + maxY) / 2;
  for (let i = 0; i < flat.length; i += 3) {
    flat[i] += dx;
    flat[i + 1] += dy;
    flat[i + 2] -= minZ;
  }

  const mesh = window.NSO3MF.indexTriangleSoup(flat);
  // The same placement as a 12-number transform, for the scene block: model
  // space (x, y, z) -> file (x + dx, -z + dy, y - minZ), re-anchored onto the
  // geometry's own centre so inverting it lands on what addModel hands back.
  let basis = null;
  if (window.NSO3MFScene) {
    const M = [1, 0, 0, 0, 0, 1, 0, -1, 0, dx, dy, -minZ];
    const c = geometryCenter(geo);
    const t = window.NSO3MFScene.apply12(M, c.x, c.y, c.z);
    basis = M.slice(0, 9).concat([t[0], t[1], t[2]]);
  }
  return {
    name: m.name || 'piece',
    vertices: mesh.vertices,
    triangles: mesh.triangles,
    triCount: mesh.triangles.length / 3,
    dropped: dropped,
    basis: basis
  };
}

function exportActiveModel3MF() {
  if (!window.NSO3MF || !window.NSOCoolingProfiles) {
    setStatus('3MF modules failed to load - check console', true);
    return Promise.resolve(null);
  }
  const m = typeof getActiveModel === 'function' ? getActiveModel() : null;
  if (!m || !m.geometry) {
    setStatus('Select a model in the list first (click its name), then Download selected 3MF', true);
    return Promise.resolve(null);
  }

  let object;
  try {
    object = buildActiveModelObject3MF(m);
  } catch (err) {
    console.error(err);
    setStatus('Export failed while reading the model - check console', true);
    return Promise.resolve(null);
  }
  if (!object) {
    setStatus('Export failed - mesh empty or invalid', true);
    return Promise.resolve(null);
  }

  // Same filename prompt as the STL path, so the two behave alike.
  const safe = String(m.name || 'piece').replace(/\.stl$/i, '').replace(/[\/\\?%*:|"<>]/g, '_');
  let filename = safe + '.3mf';
  try {
    const typed = window.prompt('Export as', filename);
    if (typed == null) {
      setStatus('Export cancelled');
      return Promise.resolve(null);
    }
    filename = String(typed).trim() || filename;
    if (!/\.3mf$/i.test(filename)) filename += '.3mf';
    filename = filename.replace(/[\/\\?%*:|"<>]/g, '_');
  } catch (e) {}

  const profileId = getCoolingProfileId();
  setStatus('Building 3MF...');
  const plate = getCurrentPlate();
  const sceneJson = buildModelSceneJson(m, object.basis);
  return window.NSO3MF.build3MF({ objects: [object], profileId, plateName: plate.name, sceneJson })
    .then(result => {
      const blob = new Blob([result.bytes], { type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml' });
      downloadBlob(blob, filename);
      const profile = window.NSOCoolingProfiles.getProfile(result.profileId);
      setStatus(
        'Downloaded ' + filename + ' (' + object.triCount + ' tris' +
        (object.dropped ? ', skipped ' + object.dropped + ' bad' : '') +
        ') - cooling profile "' + (profile ? profile.label : result.profileId) + '" baked in'
      );
      return result;
    })
    .catch(err => {
      console.error(err);
      setStatus('3MF export failed: ' + (err && err.message ? err.message : 'unknown error'), true);
      return null;
    });
}



// ===================== Edit: square-cut / array =====================
