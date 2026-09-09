/* Selected-piece white edge overlay. Loaded after app-core.js. */
(function () {
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
    const edges = new THREE.EdgesGeometry(p.mesh.geometry, 20);
    const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({
      color: 0xffffff,
      depthTest: false,
      transparent: true,
      opacity: 1
    }));
    line.renderOrder = 9;
    line.name = 'selOutline';
    line.raycast = function () {};
    p.mesh.add(line);
    p.outline = line;
  };

  const prevSelect = window.selectPlaced;
  window.selectPlaced = function (idx) {
    if (typeof prevSelect === 'function') prevSelect(idx);
    const p = state && state.placed && state.placed[idx];
    if (p) window.refreshOutline(p);
  };
})();
