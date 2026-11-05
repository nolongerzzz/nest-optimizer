// Bundle the viewer into one self-contained HTML file for publishing. The
// page loads nothing from the network except fonts: three.js, manifold-3d
// (JS and wasm) and the model are inlined as plain scripts - no ES modules,
// no import maps - and the default model is pre-built as a fallback for
// browsers that refuse to run WebAssembly.
//   node designs/silent-key-hub/make-artifact.mjs [out.html]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Module from '../../vendor/manifold/manifold.js';
import { build } from './keyhub-model.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || join(here, 'dist', 'silent-key-hub.html');

const wasm = await Module();
wasm.setup();
const m = build(wasm, {});
const d = m.d;
const parts = {
  hub: m.hubNoLeaf(), ret: m.retainer, car: m.carrierLocal, key: m.keyLocal,
  dow: m.dowelLocal, pin: m.keyPinLocal,
  leaf: m.leafLocal.translate([-d.beamRootU, -d.beamBot, 0]),
  tab: m.leafTabLocal.translate([-d.beamRootU, -d.beamBot, 0]),
  eye: m.eye, nut: m.nut, wash: m.washer,
};
const b64 = (ta) => Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength).toString('base64');
const baked = {};
for (const [k, man] of Object.entries(parts)) {
  const mesh = man.getMesh();
  const pos = new Float32Array(mesh.numVert * 3);
  for (let i = 0; i < mesh.numVert; i++) for (let j = 0; j < 3; j++) pos[i * 3 + j] = mesh.vertProperties[i * mesh.numProp + j];
  baked[k] = { v: b64(pos), i: b64(new Uint32Array(mesh.triVerts)) };
}
m.dispose();

// three.js classic build, from the npm tarball (cached in dist/).
const THREE_VER = '0.160.0';
const cache = join(here, 'dist', `three-${THREE_VER}`);
if (!existsSync(join(cache, 'package/build/three.min.js'))) {
  mkdirSync(cache, { recursive: true });
  execSync(`npm pack three@${THREE_VER} --silent && tar xzf three-${THREE_VER}.tgz package/build/three.min.js`, { cwd: cache, stdio: 'ignore' });
}
const threeSrc = readFileSync(join(cache, 'package/build/three.min.js'), 'utf8');

// manifold-3d ships as an ES module; turn it into a plain script.
let manifoldSrc = readFileSync(join(here, '../../vendor/manifold/manifold.js'), 'utf8');
if (!manifoldSrc.includes('export default Module;')) throw new Error('manifold.js layout changed');
manifoldSrc = manifoldSrc.replace('export default Module;', 'window.__KEYHUB_MANIFOLD__ = Module;').replaceAll('import.meta.url', 'location.href');

const modelSrc = readFileSync(join(here, 'keyhub-model.js'), 'utf8').replace(/^export /gm, '');
const wasmB64 = readFileSync(join(here, '../../vendor/manifold/manifold.wasm')).toString('base64');
const safe = (js) => js.replaceAll('</script', '<\\/script');
const inject = `<script>${safe(threeSrc)}</script>
<script>${safe(manifoldSrc)}</script>
<script>
window.__KEYHUB_WASM__ = "${wasmB64}";
window.__KEYHUB_BAKED__ = ${JSON.stringify(baked)};
(function () {
${modelSrc}
window.__KEYHUB_MODEL__ = { PARAMS, DEFAULTS, build, derive, lint, leafLift, sweepCheck };
})();
</script>
`;
let html = readFileSync(join(here, 'index.html'), 'utf8');
const at = html.indexOf('<script>\n(async () => {');
if (at < 0) throw new Error('main script not found');
html = html.slice(0, at) + inject + html.slice(at);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`${out}  ${(html.length / 1024).toFixed(0)} KB`);
