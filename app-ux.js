/* ux overlay — look lock + HUD stamp */
(function () {
  function stampHud() {
    var el = document.getElementById('adjust-status');
    if (el) el.textContent = 'HUD mask3';
    if (typeof setStatus === 'function') setStatus('HUD mask3');
  }

  function pickIdx(event) {
    if (!state.renderer || !state.camera || !state.modelGroup) return -1;
    setPointerFromEvent(event);
    state.raycaster.setFromCamera(state.pointer, state.camera);
    const hits = state.raycaster.intersectObjects(state.modelGroup.children, true);
    if (!hits.length) return -1;
    let obj = hits[0].object;
    while (obj && obj.userData.placedIndex == null && obj.parent) obj = obj.parent;
    const idx = obj && obj.userData ? obj.userData.placedIndex : undefined;
    return typeof idx === 'number' ? idx : -1;
  }

  function lookAtHit(event) {
    if (!state.renderer || !state.camera || !state.controls || !state.modelGroup) return false;
    if (typeof setPointerFromEvent === 'function') setPointerFromEvent(event);
    state.raycaster.setFromCamera(state.pointer, state.camera);
    const hits = state.raycaster.intersectObjects(state.modelGroup.children, true);
    if (!hits.length) return false;
    state.controls.target.copy(hits[0].point);
    state.controls.minDistance = 3;
    state.controls.update();
    if (typeof setStatus === 'function') setStatus('Look locked — orbit/pan around point');
    return true;
  }

  function bind() {
    stampHud();
    setTimeout(stampHud, 0);
    setTimeout(stampHud, 200);
    if (state.renderer && state.renderer.domElement) {
      state.renderer.domElement.addEventListener('dblclick', function (event) {
        if (!state.cutterOpen) return;
        const idx = pickIdx(event);
        if (idx < 0) return;
        event.preventDefault();
        event.stopPropagation();
        if (typeof closeCutter === 'function') closeCutter(false);
      });
      state.renderer.domElement.addEventListener('pointerdown', function (event) {
        if (event.button !== 0) return;
        if (!event.altKey) return;
        if (state.softenArmed || state.capArmed || state.joinSession) return;
        if (lookAtHit(event)) {
          event.preventDefault();
          event.stopPropagation();
        }
      }, true);
    }
    if (state.controls) state.controls.minDistance = 3;
    const ctxExport = document.getElementById('ctx-export');
    if (ctxExport) {
      ctxExport.addEventListener('click', function () {
        if (typeof hideCtxMenu === 'function') hideCtxMenu();
        if (typeof exportActiveModel === 'function') exportActiveModel();
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
