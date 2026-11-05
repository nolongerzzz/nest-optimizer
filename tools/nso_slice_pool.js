// Whole-support slices on worker threads (tools/nso_support_shells_check.js).
//
// The shells check slices a support three ways - the shells, the weld, and the
// weld again with its parts unioned in another order - and on the clamp's
// 41-trunk area that is three slices of ~140,000 triangles, ~430 s each on
// the box this was written on, one after the other. They share nothing: each
// takes a soup and answers with the layers' areas, wall counts and extruded
// lengths. So they run side by side, one slice to a worker, and a step that
// was the sum of its slices is the longest of them. The numbers are the
// slicer's own - the same call (SL.sliceObjects, 0.4 mm nozzle, dropToPlate
// off) in the worker as in the main thread - and so the check's are the same.
//
//   const pool = require('./nso_slice_pool.js');
//   const layers = await pool.slice(soup);   // [{ areaMm2, wallCount, extruded }] or null
//   await pool.close();
//
// NSO_SLICE_WORKERS=<n> sets the number of workers (default: the cores, at most 4).

const { Worker, isMainThread, parentPort } = require('worker_threads');

/* what a layer is held to: its area, its wall count, and the mm of toolpath it extrudes */
function extrudedOf(layer) {
  let L = 0;
  (layer.paths || []).forEach((pa) => {
    const pts = pa.points || pa.pts || pa;
    if (!Array.isArray(pts)) return;
    for (let i = 0; i + 1 < pts.length; i++) L += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  });
  return L;
}

if (!isMainThread) {
  const SL = require('../nso_slicer.js');
  const o = Object.assign({}, SL.defaultsFor(0.4), { dropToPlate: false });
  const kernel = SL.loadKernel({});
  parentPort.on('message', async (m) => {
    try {
      const wasm = await kernel;
      const r = SL.sliceObjects([{ soup: m.soup }], o, wasm);
      parentPort.postMessage({ id: m.id, layers: r.ok
        ? r.objects[0].layers.map((ly) => ({ areaMm2: ly.areaMm2, wallCount: ly.wallCount, extruded: extrudedOf(ly) }))
        : null });
    } catch (e) {
      parentPort.postMessage({ id: m.id, error: String(e && e.stack || e) });
    }
  });
} else {
  const workers = [], idle = [], queue = [], pending = new Map();
  let nextId = 0;

  const size = () => {
    const n = Number(process.env.NSO_SLICE_WORKERS);
    if (n >= 1) return Math.floor(n);
    const cores = typeof require('os').availableParallelism === 'function' ? require('os').availableParallelism() : require('os').cpus().length;
    return Math.max(1, Math.min(4, cores));
  };
  const dispatch = () => {
    while (queue.length && (idle.length || workers.length < size())) {
      let w = idle.pop();
      if (!w) {
        w = new Worker(__filename);
        w.on('message', (r) => {
          const p = pending.get(r.id);
          pending.delete(r.id);
          idle.push(w);
          if (r.error) p.reject(new Error('slice worker: ' + r.error)); else p.resolve(r.layers);
          dispatch();
        });
        w.on('error', (e) => { pending.forEach((p) => p.reject(e)); pending.clear(); });
        workers.push(w);
      }
      const job = queue.shift();
      pending.set(job.id, job);
      w.postMessage({ id: job.id, soup: job.soup });
    }
  };

  module.exports = {
    slice(soup) {
      return new Promise((resolve, reject) => { queue.push({ id: nextId++, soup, resolve, reject }); dispatch(); });
    },
    close() { return Promise.all(workers.splice(0).map((w) => w.terminate())); },
    extrudedOf
  };
}
