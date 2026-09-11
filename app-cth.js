/* CTH host — pull the plug: delete this file + its script tag in index.html.
   Mesh names (m-{model.id}) stay; they do not change Soften/Split. */
import { mountLiveHarness } from 'https://cdn.jsdelivr.net/gh/nolongerzzz/click-test@2a44fa17c16184e04fce3327ec94b4187ba8286e/src/cth-live.js';
import { NEST_PLATE_FIRST_BATCH } from 'https://cdn.jsdelivr.net/gh/nolongerzzz/click-test@2a44fa17c16184e04fce3327ec94b4187ba8286e/specs/nest-plate-first-batch.js';

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
  const raycastables = collectRaycastables();
  if (!cthOn()) return;
  if (!window.THREE || !window.state || !state.scene || !state.camera) {
    setTimeout(boot, 80);
    return;
  }
  const renderer = state.renderer || window.renderer;
  const canvas = (renderer && renderer.domElement) || document.querySelector('#viewport canvas');
  if (!canvas) {
    setTimeout(boot, 80);
    return;
  }
  if (window.__CTH_HARNESS__) return;
  try {
    mountLiveHarness({
      THREE: window.THREE,
      scene: state.scene,
      camera: state.camera,
      renderer: renderer,
      container: canvas,
      raycastables: raycastables,
      tests: NEST_PLATE_FIRST_BATCH,
      title: 'Nest plate first batch'
    });
  } catch (err) {
    console.error('[cth]', err);
    if (typeof setStatus === 'function') setStatus('CTH mount failed');
    return;
  }
  window.__CTH_REBUILD__ = function () {
    collectRaycastables(raycastables);
  };
  if (typeof setStatus === 'function') setStatus('CTH on');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
