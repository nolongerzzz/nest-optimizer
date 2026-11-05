// Build the Silent Key Hub at its default parameters (or overrides given as
// key=value arguments), run the clearance sweep, and write print-oriented
// STLs to ./stl.
//   node designs/silent-key-hub/build-stl.mjs [stations=8] [hubDiameter=64] ...
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Module from '../../vendor/manifold/manifold.js';
import { build, derive, lint, sweepCheck, printParts, toSTL } from './keyhub-model.js';

const here = dirname(fileURLToPath(import.meta.url));
const params = {};
for (const a of process.argv.slice(2)) {
  const [k, v] = a.split('=');
  params[k] = Number(v);
}
const wasm = await Module();
wasm.setup();
const { d } = derive(params);
const model = build(wasm, params);

console.log('Derived:');
for (const k of ['slotW', 'camCorner', 'detentTravel', 'beamLen', 'wallAtRoot', 'wallAtCam', 'hoodDepth', 'dowelLen', 'overallDrop'])
  console.log(`  ${k.padEnd(14)} ${d[k].toFixed(2)} mm`);
console.log(`  beamStrain     ${(d.beamStrain * 100).toFixed(2)} %`);
console.log(`  leaf force     ${d.beamPreloadForce.toFixed(2)} N preload, ${d.beamPeakForce.toFixed(2)} N peak`);
const issues = lint(params);
console.log(issues.length ? issues.map(([l, m]) => `  [${l}] ${m}`).join('\n') : '  lint: clean');

const sw = sweepCheck(wasm, model, 0, 5);
console.log('Sweep (overlap mm^3 by angle):', sw.rows.map((r) => `${r.angle}:${r.volume.toFixed(3)}`).join(' '));
console.log(`  worst overlap ${sw.worst.toFixed(4)} mm^3`);

const parts = printParts(wasm, model);
mkdirSync(join(here, 'stl'), { recursive: true });
for (const [name, m] of Object.entries(parts)) {
  const st = m.status ? m.status() : 0;
  const bb = m.boundingBox();
  const size = [0, 1, 2].map((i) => (bb.max[i] - bb.min[i]).toFixed(1)).join(' x ');
  console.log(`${name.padEnd(9)} genus ${m.genus()}  vol ${(m.volume() / 1000).toFixed(2)} cm^3  ${size} mm  status ${st}`);
  writeFileSync(join(here, 'stl', `keyhub-${name}.stl`), toSTL(m.getMesh(), name));
}
model.dispose();
if (sw.worst > 0.01 || issues.some(([l]) => l === 'bad')) process.exitCode = 1;
