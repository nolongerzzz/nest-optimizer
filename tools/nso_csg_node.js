/* The SHIPPED boolean kernel adapter, running under node.
 *
 *   const { csgContext } = require('./nso_csg_node.js');
 *   const csg = csgContext();
 *   const u = await csg.NSO_unionSoups(aSoup, bSoup);
 *
 * NOTHING IS REIMPLEMENTED HERE. nso_csg.js - the NSO_CSG adapter, the weld
 * and edge helpers and the union / subtract / punch booleans the app's
 * Join, Subtract, Connect and Bridge stand on - is the shipped file, run
 * whole in a vm context. A test that retyped the union would only ever
 * prove the copy right; what matters here is that the solid under test went
 * through the same welds, the same pre-checks and the same kernel call the
 * Complete Join button makes. (It used to splice these out of app-join.js
 * and app-finish.js by name; they moved to nso_csg.js so the boolean worker
 * can load them too. There is no worker in a vm context: every boolean here
 * takes the in-thread path, which is the same core the worker runs.)
 *
 * TWO THINGS ARE CHANGED, both of them the loader and neither of them the
 * adapter:
 *
 *   1. NSO_CSG_URL is pointed at vendor/manifold/ instead of jsDelivr, so the
 *      suite needs no network - the same single substitution
 *      tools/csg_bench/run.js already makes, for the same reason.
 *   2. The context is compiled with importModuleDynamically set to node's
 *      default loader, so the adapter's own `import(NSO_CSG_URL)` resolves.
 *      The adapter's source is untouched; only the host's module hook is
 *      supplied.
 *
 * If a function moves or is renamed this throws, instead of quietly testing
 * a stub - the same contract tools/nso_inside_corners_testlib.js has.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');

/* Pull named top-level function declarations out of a classic script, brace
   matched with strings and comments skipped. Same extractor
   tools/nso_inside_corners_testlib.js uses. */
function extractFns(file, names) {
  const src = fs.readFileSync(file, 'utf8');
  const out = {};
  for (const name of names) {
    const m = new RegExp('^(async\\s+)?function\\s+' + name + '\\s*\\(', 'm').exec(src);
    if (!m) throw new Error('cannot find function ' + name + ' in ' + path.basename(file));
    const start = m.index;
    let j = src.indexOf('{', start + m[0].length - 1);
    let depth = 0, inS = null, inLine = false, inBlock = false;
    for (; j < src.length; j++) {
      const c = src[j], n = src[j + 1];
      if (inLine) { if (c === '\n') inLine = false; continue; }
      if (inBlock) { if (c === '*' && n === '/') { inBlock = false; j++; } continue; }
      if (inS) { if (c === '\\') { j++; continue; } if (c === inS) inS = null; continue; }
      if (c === '/' && n === '/') { inLine = true; j++; continue; }
      if (c === '/' && n === '*') { inBlock = true; j++; continue; }
      if (c === '"' || c === "'" || c === '`') { inS = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { j++; break; } }
    }
    out[name] = src.slice(start, j);
  }
  return out;
}

/* nso_csg.js, verbatim, with only NSO_CSG_URL rewritten. */
function csgSource() {
  const local = 'file://' + path.join(REPO, 'vendor', 'manifold', 'manifold.js');
  return fs.readFileSync(path.join(REPO, 'nso_csg.js'), 'utf8')
    .replace(/^var NSO_CSG_URL\s*=.*$/m, 'var NSO_CSG_URL = ' + JSON.stringify(local) + ';');
}

/* Two node warnings, neither of them about the code under test: the dynamic
   import hook is flagged experimental, and vendor/manifold/manifold.js has no
   "type" field to declare itself an ES module. Both are the LOADER's, both are
   printed once per process, and both would otherwise sit in the middle of
   every suite's output pretending to be a finding. Anything else still
   prints. */
function quietLoaderWarnings() {
  if (quietLoaderWarnings.done) return;
  quietLoaderWarnings.done = true;
  const prior = process.listeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', w => {
    if (w.name === 'ExperimentalWarning' && /USE_MAIN_CONTEXT_DEFAULT_LOADER/.test(w.message)) return;
    if (w.code === 'MODULE_TYPELESS_PACKAGE_JSON') return;
    if (prior.length) { for (const fn of prior) fn(w); return; }
    console.error(w.name + ': ' + w.message);
  });
}

function csgContext() {
  quietLoaderWarnings();
  const ctx = {
    Math, Map, Set, console, Array, Object, Number, String, JSON, Error, Promise,
    isFinite, isNaN, Infinity, NaN, setTimeout, clearTimeout,
    Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, ArrayBuffer
  };
  vm.createContext(ctx);
  const opts = { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER };
  vm.runInContext(csgSource(), ctx, Object.assign({ filename: 'nso_csg.js' }, opts));
  return ctx;
}

module.exports = { csgContext, extractFns };

/* Run directly: a one-box self-check that the splice still finds everything
   and the vendored kernel still answers. */
if (require.main === module) {
  const box = (lo, hi) => {
    const v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
               [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
    const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
               [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    const o = [];
    for (const t of f) for (const i of t) o.push(...v[i]);
    return new Float32Array(o);
  };
  csgContext().NSO_unionSoups(box([0, 0, 0], [10, 10, 10]), box([5, 5, 5], [15, 15, 15]))
    .then(u => {
      const ok = u.ok && u.parts === 1 && u.soup.length > 0;
      console.log((ok ? 'PASSED' : 'FAILED') + '  the shipped union runs under node: ok ' +
        u.ok + ', parts ' + u.parts + ', ' + (u.soup ? u.soup.length / 9 : 0) + ' tris');
      process.exit(ok ? 0 : 1);
    });
}
