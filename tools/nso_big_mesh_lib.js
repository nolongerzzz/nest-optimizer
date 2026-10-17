/* Shared measuring kit for the big-mesh checks (tools/nso_big_mesh_profile.js,
   tools/nso_big_mesh_test.js): what the main thread ran, where, and for how long.

   TWO NUMBERS, KEPT APART ON PURPOSE
     longTasks   the browser's own Long Task entries (>50 ms): the whole task,
                 whatever it was spent on.
     jsRuns      stretches where JS was on the main thread's stack, read from the
                 DevTools sampling profiler (0.5 ms sampling). A run opens at the
                 first sample with JS on the stack and ends when the stack is empty
                 for more than a sample or two.

   They differ by the renderer. The headless page draws with software GL
   (swiftshader), where a frame costs ~0.4 s per million triangles on the main
   thread's own time ("(program)" in the profile) however little JS runs - the
   same 0.4 s with the app idle and nothing selected, and it scales with the
   triangles drawn, not the canvas. That is the machine, not this app, so the
   gates read jsRuns (the app's own time) and the tables print both, with the
   idle frame beside them so the difference is on the page. */

const NATIVE = new Set(['(program)', '(idle)', '(root)']);

/* In-page recorder for Long Task entries. Installed once per page. */
function installRecorder() {
  window.__bm = window.__bm || { lt: [] };
  if (window.__bm.obs) return;
  window.__bm.obs = new PerformanceObserver(l => {
    l.getEntries().forEach(e => window.__bm.lt.push({ start: e.startTime, dur: e.duration }));
  });
  window.__bm.obs.observe({ type: 'longtask', buffered: true });
}

function frameKey(cf) {
  const file = (cf.url || '').split('/').pop().split('?')[0];
  return (cf.functionName || '(anonymous)') + ' @ ' + (file || '(native)') + ':' + (cf.lineNumber + 1);
}
const isApp = cf => /^http:\/\/127\.0\.0\.1/.test(cf.url || '') && !/three\.min|OrbitControls|STLLoader/.test(cf.url);

/* A profile -> its JS runs of at least `minMs`, each with the frames that held it. */
function jsRunsOf(profile, minMs) {
  const byId = new Map(profile.nodes.map(n => [n.id, n]));
  const parent = new Map();
  profile.nodes.forEach(n => (n.children || []).forEach(c => parent.set(c, n.id)));
  const GAP = 3000;                        // µs of empty stack that still counts as one run
  const runs = [];
  let t = profile.startTime, cur = null;
  const flush = () => { if (cur) { runs.push(cur); cur = null; } };
  for (let i = 0; i < profile.samples.length; i++) {
    const dt = profile.timeDeltas[i] || 0;
    t += dt;
    const id = profile.samples[i], node = byId.get(id);
    const native = NATIVE.has(node.callFrame.functionName);
    if (native) { if (cur && t - cur.last > GAP) flush(); continue; }
    if (!cur) cur = { t0: t - dt, last: t, nodes: new Map() };
    cur.last = t;
    cur.nodes.set(id, (cur.nodes.get(id) || 0) + dt);
  }
  flush();
  return runs.map(r => {
    const dur = (r.last - r.t0) / 1000;
    const incl = new Map(), self = new Map();
    for (const [id, us] of r.nodes) {
      const n = byId.get(id);
      const sk = frameKey(n.callFrame);
      self.set(sk, (self.get(sk) || 0) + us);
      const seen = new Set();
      for (let k = id; k != null; k = parent.get(k)) {
        const cf = byId.get(k).callFrame;
        if (NATIVE.has(cf.functionName)) continue;
        const key = frameKey(cf);
        if (seen.has(key)) continue;       // recursion counts once
        seen.add(key);
        incl.set(key, (incl.get(key) || 0) + us);
      }
    }
    const rank = m => [...m].sort((a, b) => b[1] - a[1]);
    const appIncl = rank(incl).filter(([k]) => !/@ (three\.min|OrbitControls|STLLoader|\(native\))/.test(k));
    return {
      startMs: (r.t0 - profile.startTime) / 1000, ms: dur,
      incl: appIncl.slice(0, 6).map(([k, us]) => [k, us / 1000]),
      self: rank(self).slice(0, 4).map(([k, us]) => [k, us / 1000])
    };
  }).filter(r => r.ms >= minMs);
}

/* Run fn(), profiled. Returns what the main thread did while it ran. */
async function measure(page, cdp, name, fn) {
  await page.evaluate(() => { window.__bm.obs.takeRecords(); window.__bm.mark = performance.now(); window.__bm.lt.length = 0; });
  await cdp.send('Profiler.start');
  const t0 = Date.now();
  let value, error = null;
  try { value = await fn(); } catch (e) { error = e; }
  const wallMs = Date.now() - t0;
  const { profile } = await cdp.send('Profiler.stop');
  const lt = await page.evaluate(() => { window.__bm.obs.takeRecords(); return window.__bm.lt.slice(); });
  const runs = jsRunsOf(profile, 50);
  const all = jsRunsOf(profile, 0);
  const jsMs = all.reduce((s, r) => s + r.ms, 0);
  return {
    name, wallMs, value, error: error && String(error.message || error),
    longTasks: lt.map(e => Math.round(e.dur)),
    jsRuns: runs,
    maxJsMs: all.reduce((m, r) => Math.max(m, r.ms), 0),
    jsMs
  };
}

async function openProfiler(page) {
  await page.evaluate(installRecorder);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  return cdp;
}

/* Where on the canvas a world point lands, in client pixels. In-page. */
function installProjector() {
  window.__bm.proj = function (x, y, z) {
    const v = new THREE.Vector3(x, y, z).project(state.camera);
    const r = state.renderer.domElement.getBoundingClientRect();
    return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
  };
  window.__bm.box = function (i) {
    const p = state.placed[i]; p.mesh.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(p.mesh);
    return { lo: b.min.toArray(), hi: b.max.toArray() };
  };
}

/* N points across the piece's silhouette body, on its mid-height columns. */
async function hoverPoints(page, index, n) {
  return page.evaluate(([i, n]) => {
    const b = window.__bm.box(i), cx = (b.lo[0] + b.hi[0]) / 2, cz = (b.lo[2] + b.hi[2]) / 2;
    const hw = (b.hi[0] - b.lo[0]) / 2, h = b.hi[1] - b.lo[1];
    const out = [];
    const cols = 4, rows = Math.ceil(n / cols);
    for (let k = 0; k < n; k++) {
      const r = Math.floor(k / cols), c = k % cols;
      const fy = 0.18 + 0.64 * (r / Math.max(1, rows - 1));
      const fx = -0.45 + 0.9 * (c / (cols - 1));
      const p = window.__bm.proj(cx + fx * hw, b.lo[1] + fy * h, cz + hw * 0.0);
      out.push(p);
    }
    return out;
  }, [index, n]);
}

const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };

module.exports = { installRecorder, installProjector, openProfiler, measure, hoverPoints, jsRunsOf, frameKey, isApp, q };
