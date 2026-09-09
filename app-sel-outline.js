/* Selected-piece white edge overlay. After app-core.js. */
(function () {
  const prevUpdatePlate = window.updatePlateInfo;
  window.updatePlateInfo = function () {
    if (!document.getElementById('plate-dims') && !document.getElementById('plate-area')) return;
    if (typeof prevUpdatePlate === 'function') {
      try { prevUpdatePlate(); } catch (e) { console.warn('updatePlateInfo', e); }
    }
  };

  function stripOutline(p) {
    if (!p || !p.outline) return;
    if (p.mesh) p.mesh.remove(p.outline);
    if (p.outline.geometry) p.outline.geometry.dispose();
    if (p.outline.material) p.outline.material.dispose();
    p.outline = null;
  }

  window.refreshOutline = function refreshOutline(p) {
    if (!p) return;
    stripOutline(p);
    if (!p.mesh || !p.mesh.geometry) return;
    if (!state || state.placed[state.selectedIndex] !== p) return;
    try {
      const edges = new THREE.EdgesGeometry(p.mesh.geometry, 15);
      const mat = new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 1 });
      const line = new THREE.LineSegments(edges, mat);
      line.renderOrder = 12;
      line.name = 'selOutline';
      line.raycast = function () {};
      p.mesh.add(line);
      p.outline = line;
    } catch (e) {
      console.warn('refreshOutline', e);
    }
  };

  const prevSelect = window.selectPlaced;
  window.selectPlaced = function (idx) {
    if (typeof prevSelect === 'function') prevSelect(idx);
    const p = state && state.placed && state.placed[idx];
    if (p) window.refreshOutline(p);
  };
})();
