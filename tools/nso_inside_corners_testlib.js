/* Shared helpers for the inside-corners tests.

   The app is plain classic scripts, so the real engines are pulled out of
   app-cut.js / app-finish.js by name and run in a vm context. Nothing is
   reimplemented here: a test that reimplemented `rawVertexBallCorners`
   would only ever prove the copy right. If a function moves or is renamed,
   this throws instead of quietly testing a stub.

   The Manifold kernel comes from vendor/manifold/, not the CDN, so the
   suite needs no network - same rule the CTH and 3MF browser checks follow. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');

/* ---- pull named top-level function declarations out of a classic script ---- */
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

const CUT_FNS = ['rawEarClip2D', 'rawEdgeInwardNormal2', 'raw2DWeldLoop'];
const FIN_FNS = ['rawVertexBallCorners', 'rawVertexBallOnly', 'rawSolidBox', 'rawBoxPockets',
                 'rawPocketBrick', 'nsoSealScore', 'rawBoxSoup', 'rawWrapSolid',
                 'rawHasPlane', 'rawExtremeOf', 'softenSelectedFace', 'rawChamferCut'];

function loadEngines() {
  const cut = extractFns(path.join(REPO, 'app-cut.js'), CUT_FNS);
  const fin = extractFns(path.join(REPO, 'app-finish.js'), FIN_FNS);
  const src = fs.readFileSync(path.join(REPO, 'app-finish.js'), 'utf8');
  const fp = /FACE_PICK_TOL\s*=\s*([0-9.eE+-]+)/.exec(src);
  const sandbox = {
    console, Math, Number, Array, Float32Array, Uint32Array, Map, Set, JSON, Error,
    Infinity, NaN, isFinite, isNaN, String, Object, Promise,
    FACE_PICK_TOL: fp ? Number(fp[1]) : 0.35,
    state: { edgeTreat: 'fillet' },
    getEdgeTreat() { return sandbox.state.edgeTreat; },
    nsoMaskFaces() { return [[false, false], [false, false], [false, false]]; }
  };
  vm.createContext(sandbox);
  vm.runInContext(Object.values(cut).join('\n\n') + '\n\n' + Object.values(fin).join('\n\n'),
                  sandbox, { filename: 'nso-engines.js' });
  return sandbox;
}

/* ---- Manifold kernel, vendored ---- */
let _wasm = null;
async function kernel() {
  if (_wasm) return _wasm;
  const mod = await import('file://' + path.join(REPO, 'vendor/manifold/manifold.js'));
  const wasm = await (mod.default || mod)();
  wasm.setup();
  _wasm = wasm;
  return wasm;
}
function toManifold(wasm, soup) {
  const n = (soup.length / 9) | 0;
  const vertProperties = (soup instanceof Float32Array) ? soup.slice() : new Float32Array(soup);
  const triVerts = new Uint32Array(n * 3);
  for (let i = 0; i < n * 3; i++) triVerts[i] = i;
  const mesh = new wasm.Mesh({ numProp: 3, vertProperties, triVerts });
  mesh.merge();
  return new wasm.Manifold(mesh);
}
function toSoup(m) {
  const mesh = m.getMesh(), vp = mesh.vertProperties, tv = mesh.triVerts, np = mesh.numProp || 3;
  const out = new Float32Array(tv.length * 3);
  let w = 0;
  for (let t = 0; t < tv.length; t++) { const vi = tv[t] * np; out[w++] = vp[vi]; out[w++] = vp[vi+1]; out[w++] = vp[vi+2]; }
  return out;
}
async function csg(kind, a, b) {
  const wasm = await kernel();
  let A = null, B = null, o = null;
  try {
    A = toManifold(wasm, a); B = toManifold(wasm, b);
    o = kind === 'sub' ? A.subtract(B) : A.add(B);
    if (o.status() !== 'NoError') throw new Error('kernel refused: ' + o.status());
    if (o.isEmpty()) throw new Error('result is empty');
    return { ok: true, soup: toSoup(o) };
  } catch (e) { return { ok: false, reason: e.message }; }
  finally { if (A) A.delete(); if (B) B.delete(); if (o) o.delete(); }
}
const ops = { union: (a, b) => csg('add', a, b), subtract: (a, b) => csg('sub', a, b) };

/* ---- geometry probes ----

   Pass/fail here is a measured distance, never a look at the mesh. Two
   numbers carry the whole ticket:

   biteDepth  - from a sharp CONVEX apex, how far along the into-the-body
                direction before the solid starts. 0 = still sharp.
   fillDepth  - from a sharp CONCAVE apex, how far along the into-the-void
                direction the solid still reaches. 0 = still sharp.

   Both are calibrated against closed forms in the suite itself, so a broken
   probe fails loudly rather than passing everything. */
function rayHits(soup, o, d) {
  let n = 0;
  for (let t = 0; t + 8 < soup.length; t += 9) {
    const ax = soup[t], ay = soup[t+1], az = soup[t+2];
    const e1x = soup[t+3]-ax, e1y = soup[t+4]-ay, e1z = soup[t+5]-az;
    const e2x = soup[t+6]-ax, e2y = soup[t+7]-ay, e2z = soup[t+8]-az;
    const px = d[1]*e2z - d[2]*e2y, py = d[2]*e2x - d[0]*e2z, pz = d[0]*e2y - d[1]*e2x;
    const det = e1x*px + e1y*py + e1z*pz;
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1/det, tx = o[0]-ax, ty = o[1]-ay, tz = o[2]-az;
    const u = (tx*px + ty*py + tz*pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = ty*e1z - tz*e1y, qy = tz*e1x - tx*e1z, qz = tx*e1y - ty*e1x;
    const v = (d[0]*qx + d[1]*qy + d[2]*qz) * inv;
    if (v < 0 || u + v > 1) continue;
    if ((e2x*qx + e2y*qy + e2z*qz) * inv > 1e-7) n++;
  }
  return n;
}
/* Several directions, majority vote: one ray can graze an edge, five cannot
   all graze the same one. */
const DIRS = [[0.5773,0.5774,0.5775], [-0.3251,0.8137,0.4820], [0.7071,-0.1132,0.6981],
              [-0.6124,-0.3536,0.7071], [0.2113,0.9231,-0.3211]];
function inside(soup, p) {
  let yes = 0;
  for (const d of DIRS) if (rayHits(soup, p, d) % 2 === 1) yes++;
  return yes >= 3;
}
function walk(soup, p0, dir, want, tMax, res) {
  tMax = tMax || 12; res = res || 1e-3;
  const L = Math.hypot(dir[0], dir[1], dir[2]), u = dir.map(x => x / L);
  const at = t => [p0[0]+u[0]*t, p0[1]+u[1]*t, p0[2]+u[2]*t];
  if (inside(soup, at(res)) !== want) return 0;
  let lo = res, hi = null;
  for (let t = res; t <= tMax; t *= 1.3) if (inside(soup, at(t)) !== want) { hi = t; break; }
  if (hi === null) return Infinity;
  for (let i = 0; i < 40 && hi - lo > res * 0.25; i++) {
    const mid = (lo + hi) / 2;
    if (inside(soup, at(mid)) === want) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
const biteDepth = (soup, p0, dir, tMax, res) => walk(soup, p0, dir, false, tMax, res);
const fillDepth = (soup, p0, dir, tMax, res) => walk(soup, p0, dir, true, tMax, res);
const norm = v => { const L = Math.hypot(v[0], v[1], v[2]); return [v[0]/L, v[1]/L, v[2]/L]; };

/* ---- ASCII STL out, so tools/mesh_validate.py can be pointed at a result ---- */
function writeSTL(soup, file) {
  const L = ['solid nso'];
  for (let t = 0; t + 8 < soup.length; t += 9) {
    const ux = soup[t+3]-soup[t], uy = soup[t+4]-soup[t+1], uz = soup[t+5]-soup[t+2];
    const vx = soup[t+6]-soup[t], vy = soup[t+7]-soup[t+1], vz = soup[t+8]-soup[t+2];
    let nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    L.push('facet normal ' + (nx/len) + ' ' + (ny/len) + ' ' + (nz/len), '  outer loop');
    for (let v = 0; v < 3; v++)
      L.push('    vertex ' + soup[t+v*3] + ' ' + soup[t+v*3+1] + ' ' + soup[t+v*3+2]);
    L.push('  endloop', 'endfacet');
  }
  L.push('endsolid nso');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, L.join('\n'));
  return file;
}

/* ---- reporting ---- */
let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
function near(name, got, want, tol, unit) {
  const d = Math.abs(got - want);
  check(name, d <= tol, '(got ' + got.toFixed(4) + ', want ' + want.toFixed(4) +
        ' +-' + tol + (unit || 'mm') + ', off by ' + d.toFixed(4) + ')');
}
function summary() {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) { console.log('failing:'); for (const f of FAILS) console.log('  - ' + f); }
  return fail === 0;
}

module.exports = { REPO, extractFns, loadEngines, ops, kernel, inside, biteDepth, fillDepth,
                   norm, writeSTL, check, near, summary };
