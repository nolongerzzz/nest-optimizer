/* ux overlay — double-click closes cutter, right-click Export STL */
(function () {
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

  function bind() {
    if (state.renderer && state.renderer.domElement) {
      state.renderer.domElement.addEventListener('dblclick', function (event) {
        if (!state.cutterOpen) return;
        const idx = pickIdx(event);
        if (idx < 0) return;
        event.preventDefault();
        event.stopPropagation();
        if (typeof closeCutter === 'function') closeCutter(false);
      });
    }
    const ctxExport = document.getElementById('ctx-export');
    if (ctxExport) {
      ctxExport.addEventListener('click', function () {
        if (typeof hideCtxMenu === 'function') hideCtxMenu();
        if (typeof exportActiveModel === 'function') exportActiveModel();
      });
    }
    if (typeof setStatus === 'function') setStatus('HUD corners4');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
