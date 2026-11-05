// Bundle the viewer into one self-contained HTML file for publishing:
// the model source inline, the manifold-3d wasm embedded (so the page fetches
// nothing but three.js and manifold's JS from the CDN), and the default model
// pre-built as a fallback for browsers that refuse to run WebAssembly.
//   node designs/silent-key-hub/make-artifact.mjs [out.html]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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

const modelSrc = readFileSync(join(here, 'keyhub-model.js'), 'utf8').replace(/^export /gm, '');
const wasmB64 = readFileSync(join(here, '../../vendor/manifold/manifold.wasm')).toString('base64');
const inject = `<script>
window.__KEYHUB_WASM__ = "${wasmB64}";
window.__KEYHUB_BAKED__ = ${JSON.stringify(baked)};
(function () {
${modelSrc}
window.__KEYHUB_MODEL__ = { PARAMS, DEFAULTS, build, derive, lint, leafLift, sweepCheck };
})();
</script>
`;
let html = readFileSync(join(here, 'index.html'), 'utf8');
const at = html.indexOf('<script type="importmap">');
if (at < 0) throw new Error('importmap not found');
html = html.slice(0, at) + inject + html.slice(at);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`${out}  ${(html.length / 1024).toFixed(0)} KB`);
