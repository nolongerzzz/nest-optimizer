/* ux overlay — look lock + HUD stamp */
(function () {
  /* The build marker. Writes the HUD element, and on the FIRST stamp only,
     the status line too - so opening the page says which build it is.

     The re-stamps below used to call setStatus as well, and that is a real
     bug rather than a cosmetic one: they land 0ms and 200ms after bind, so
     any action taken in that window had its status line overwritten with the
     build tag. It cost a drive check a status assertion - Stock reported
     "HUD inside7" where it had just written what it made - and it would have
     done the same to a person who clicked fast. The tag is a stamp, not a
     result, and it stops speaking over results. */
  function stampHud(alsoStatus) {
    var el = document.getElementById('adjust-status');
    if (el) el.textContent = 'HUD inside7';
    if (alsoStatus && typeof setStatus === 'function') setStatus('HUD inside7');
  }

  // nsoMaskHudRefresh writes HUD_TAG at rest. Until that const moves with
  // the named tag, retag its line so a selection cannot snap the stamp back.
  function alignMaskHudTag() {
    var fn = window.nsoMaskHudRefresh;
    if (typeof fn !== 'function' || fn._hudInside7) return;
    window.nsoMaskHudRefresh = function () {
      fn.apply(this, arguments);
      var el = document.getElementById('adjust-status');
      if (el && el.textContent) {
        el.textContent = el.textContent.replace(/HUD inside[456]/g, 'HUD inside7');
      }
    };
    window.nsoMaskHudRefresh._hudInside7 = true;
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

  // The Thicken mm box hides its native spin buttons so the number can sit on
  // top and the arrows underneath, inside one border the same height as the
  // Thicken buttons. These two drive it instead - same min, max and step the
  // field already declares, and an input event so anything listening still
  // hears it. Nothing else about Thicken changed.
  function bindThickenArrows() {
    var arrows = document.querySelectorAll('.thick-arrow[data-thick-step]');
    for (var i = 0; i < arrows.length; i++) {
      var a = arrows[i];
      if (a._thickBound) continue;
      a._thickBound = true;
      a.addEventListener('click', function (ev) {
        var box = document.getElementById('inp-thicken-mm');
        if (!box) return;
        var step = parseFloat(box.step) || 0.1;
        var min = box.min === '' ? -Infinity : parseFloat(box.min);
        var max = box.max === '' ? Infinity : parseFloat(box.max);
        var dir = parseFloat(ev.currentTarget.getAttribute('data-thick-step')) || 0;
        var now = parseFloat(box.value);
        if (!isFinite(now)) now = isFinite(min) ? min : 0;
        var next = now + dir * step;
        // step can be fractional, so round to the step's own precision
        var dp = (String(step).split('.')[1] || '').length;
        next = parseFloat(next.toFixed(dp));
        if (next < min) next = min;
        if (next > max) next = max;
        box.value = String(next);
        box.dispatchEvent(new Event('input', { bubbles: true }));
        box.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
  }

  function bind() {
    stampHud(true);
    alignMaskHudTag();
    bindThickenArrows();
    // HUD only: these exist to put the tag back after other code rewrites the
    // HUD element, not to say the build tag again over whatever the user did.
    setTimeout(function () { stampHud(false); alignMaskHudTag(); }, 0);
    setTimeout(function () { stampHud(false); alignMaskHudTag(); }, 200);
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
        if (state.softenArmed || state.capArmed || state.centerLockArmed || state.joinSession) return;
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
        if (typeof exportSelected === 'function') exportSelected();
        else if (typeof exportActiveModel === 'function') exportActiveModel();
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
