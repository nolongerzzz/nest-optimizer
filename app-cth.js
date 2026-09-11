/* CTH host — pull the plug: delete this file, cth/, expose, and the script tags. */

function cthMode() {
  const v = new URLSearchParams(String(location.search || '')).get('cth');
  if (v == null) return null;
  const s = String(v).toLowerCase();
  if (s === 'finish') return 'finish';
  if (s === '' || s === '1' || s === 'true' || s === 'yes' || s === 'on') return 'plate';
  return null;
}

function banner(text, bad) {
  let el = document.getElementById('cth-fallback');
  if (!el) {
    el = document.createElement('div');
    el.id = 'cth-fallback';
    el.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483000;max-width:280px;padding:8px 10px;background:#14171b;color:#e7e5e1;border:1px solid #e8a33d;border-radius:8px;font:12px/1.4 ui-monospace,monospace;';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.borderColor = bad ? '#d2694f' : '#e8a33d';
}

function nameMesh(p) {
  if (!p || !p.mesh || p.sourceId == null) return;
  p.mesh.name = 'm-' + p.sourceId;
}

function collectRaycastables(into) {
  const list = into || [];
  if (into) list.length = 0;
  const placed = window.state && window.state.placed ? window.state.placed : [];
  placed.forEach(function (p) {
    nameMesh(p);
    if (p && p.mesh && p.mesh.isMesh) list.push(p.mesh);
  });
  return list;
}

function wrapRefresh() {
  const prev = window.refreshOutline;
  if (typeof prev !== 'function' || prev._cthWrapped) return;
  function wrapped(p) {
    prev(p);
    nameMesh(p);
    if (typeof window.__CTH_REBUILD__ === 'function') window.__CTH_REBUILD__();
  }
  wrapped._cthWrapped = true;
  window.refreshOutline = wrapped;
}

async function boot() {
  wrapRefresh();
  const mode = cthMode();
  if (!mode) return;
  banner('CTH loading');
  const st = window.state;
  if (!window.THREE || !st || !st.scene || !st.camera) {
    setTimeout(boot, 80);
    return;
  }
  const renderer = st.renderer || window.renderer;
  const canvas = (renderer && renderer.domElement) || document.querySelector('#viewport canvas');
  if (!canvas) {
    setTimeout(boot, 80);
    return;
  }
  if (window.__CTH_HARNESS__) {
    banner('CTH on');
    return;
  }
  try {
    const live = await import('./cth/cth-live.js?v=cth8');
    const specPath = mode === 'finish'
      ? './cth/nest-finish-first-batch.js?v=cth8'
      : './cth/nest-plate-first-batch.js?v=cth8';
    const spec = await import(specPath);
    const tests = spec.NEST_FINISH_FIRST_BATCH || spec.NEST_PLATE_FIRST_BATCH || spec.default;
    live.mountLiveHarness({
      THREE: window.THREE,
      scene: st.scene,
      camera: st.camera,
      renderer: renderer,
      container: canvas,
      raycastables: function () { return collectRaycastables(); },
      tests: tests,
      title: mode === 'finish' ? 'Nest finish first batch' : 'Nest plate first batch'
    });
    const fb = document.getElementById('cth-fallback');
    if (fb && window.__CTH_OVERLAY__) fb.remove();
    else banner('CTH on');
  } catch (err) {
    console.error('[cth]', err);
    banner('CTH mount failed: ' + (err && err.message ? err.message : String(err)), true);
    return;
  }
  window.__CTH_REBUILD__ = function () { collectRaycastables(); };
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
