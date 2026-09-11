/* CTH host — pull the plug: delete this file + its script tag in index.html.
   Mesh names (m-{model.id}) stay; they do not change Soften/Split. */
import { createThreeHostAdapter } from 'https://cdn.jsdelivr.net/gh/nolongerzzz/click-test@d0342ed1f72b7ad5031b16cb63cc1dee7f98adac/src/three-adapter.js';

function cthOn() {
  return /(?:^|[?&])cth=1(?:&|$)/.test(String(location.search || ''));
}

function nameMesh(p) {
  if (!p || !p.mesh || p.sourceId == null) return;
  p.mesh.name = 'm-' + p.sourceId;
}

function collectRaycastables(into) {
  const list = into || [];
  if (into) list.length = 0;
  (window.state && state.placed ? state.placed : []).forEach(function (p) {
    nameMesh(p);
    if (p && p.mesh && p.mesh.isMesh) list.push(p.mesh);
  });
  return list;
}

function wrapRefresh() {
  if (typeof refreshOutline !== 'function' || refreshOutline._cthWrapped) return;
  const prev = refreshOutline;
  function wrapped(p) {
    prev(p);
    nameMesh(p);
    if (typeof window.__CTH_REBUILD__ === 'function') window.__CTH_REBUILD__();
  }
  wrapped._cthWrapped = true;
  window.refreshOutline = wrapped;
}

function boot() {
  wrapRefresh();
  collectRaycastables();
  if (!cthOn()) return;
  if (!window.THREE || !window.state || !state.scene || !state.camera) {
    setTimeout(boot, 80);
    return;
  }
  const raycastables = collectRaycastables();
  const host = createThreeHostAdapter({
    THREE: window.THREE,
    scene: state.scene,
    camera: state.camera,
    raycastables: raycastables
  });
  const rawSet = host.setCameraState;
  host.setCameraState = function (s) {
    rawSet(s);
    if (state.controls) state.controls.update();
  };
  window.__CTH_HOST__ = {
    getCameraState: host.getCameraState,
    setCameraState: host.setCameraState,
    raycastAtScreenPoint: host.raycastAtScreenPoint,
    projectToScreen: host.projectToScreen,
    getMarkerPosition: host.getMarkerPosition
  };
  window.__CTH_REBUILD__ = function () {
    collectRaycastables(raycastables);
  };
  if (typeof setStatus === 'function') setStatus('CTH on');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
