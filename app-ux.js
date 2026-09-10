/* ux overlay — look lock + HUD stamp */
(function () {
  function stampHud() {
    var el = document.getElementById('adjust-status');
    if (el) el.textContent = 'HUD mask4';
    if (typeof setStatus === 'function') setStatus('HUD mask4');
  }

  function soupFromGeo(geo) {
    if (!geo || !geo.attributes || !geo.attributes.position) return null;
    var pos = geo.attributes.position;
    var index = geo.index;
    var out = [];
    if (index) {
      for (var i = 0; i < index.count; i++) {
        var vi = index.getX(i);
        out.push(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
      }
    } else {
      for (var i = 0; i < pos.count; i++) {
        out.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      }
    }
    return out.length >= 9 ? out : null;
  }

  function countDegenerateTris(soup) {
    if (!soup || soup.length < 9) return 0;
    var n = 0;
    for (var t = 0; t < soup.length; t += 9) {
      var ax = soup[t+3]-soup[t], ay = soup[t+4]-soup[t+1], az = soup[t+5]-soup[t+2];
      var bx = soup[t+6]-soup[t], by = soup[t+7]-soup[t+1], bz = soup[t+8]-soup[t+2];
      var cx = ay*bz - az*by, cy = az*bx - ax*bz, cz = ax*by - ay*bx;
      if ((cx*cx + cy*cy + cz*cz) < 1e-12) n++;
    }
    return n;
  }

  function statLine(label, found, remain) {
    if (found == null || remain == null) return label + ': found ?, fixed ?, remaining ?';
    var fix = found - remain;
    if (fix < 0) fix = 0;
    return label + ': found ' + found + ', fixed ' + fix + ', remaining ' + remain;
  }

  function wrapSealReadout() {
    if (typeof sealSelectedModel !== 'function' || sealSelectedModel._statWrap) return;
    var orig = sealSelectedModel;
    function wrapped() {
      var repairChk = document.getElementById('chk-seal-repair');
      var repairMode = !!(repairChk && repairChk.checked);
      var m = typeof getActiveModel === 'function' ? getActiveModel() : null;
      var soupIn = null;
      if (m) {
        if (m.rawTris && m.rawAxis === 'zup') soupIn = m.rawTris;
        else soupIn = soupFromGeo(m.geometry);
      }
      var openB = null, nmB = null, degB = null, triB = 0;
      if (soupIn && soupIn.length >= 9) {
        try { if (typeof openBoundaryEdges === 'function') openB = openBoundaryEdges(soupIn).length; } catch (e) {}
        try { if (typeof countNonManifoldEdges === 'function') nmB = countNonManifoldEdges(soupIn); } catch (e) {}
        try { degB = countDegenerateTris(soupIn); } catch (e) {}
        triB = (soupIn.length / 9) | 0;
      }
      orig.apply(this, arguments);
      if (!repairMode) return;
      var m2 = typeof getActiveModel === 'function' ? getActiveModel() : null;
      var soupOut = null;
      if (m2) {
        if (m2.rawTris && m2.rawAxis === 'zup') soupOut = m2.rawTris;
        else soupOut = soupFromGeo(m2.geometry);
      }
      if (!soupOut || soupOut.length < 9) return;
      var openA = null, nmA = null, degA = null;
      try { if (typeof openBoundaryEdges === 'function') openA = openBoundaryEdges(soupOut).length; } catch (e) {}
      try { if (typeof countNonManifoldEdges === 'function') nmA = countNonManifoldEdges(soupOut); } catch (e) {}
      try { degA = countDegenerateTris(soupOut); } catch (e) {}
      var triA = (soupOut.length / 9) | 0;
      var tight = (openA === 0 && nmA === 0) ? 'YES' : 'NO';
      if (typeof setStatus === 'function') {
        setStatus(
          statLine('Open edges', openB, openA) + ' | ' +
          statLine('Non-manifold', nmB, nmA) + ' | ' +
          statLine('Degenerate tris', degB, degA) + ' | ' +
          'Triangle count: ' + triB + ' \u2192 ' + triA + ' | ' +
          'Watertight: ' + tight
        );
      }
    }
    wrapped._statWrap = true;
    sealSelectedModel = wrapped;
    var btn = document.getElementById('btn-seal');
    if (btn && btn.parentNode) {
      var clone = btn.cloneNode(true);
      btn.parentNode.replaceChild(clone, btn);
      clone.addEventListener('click', wrapped);
    }
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
    stampHud();
    bindThickenArrows();
    wrapSealReadout();
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
