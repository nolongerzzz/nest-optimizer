/* Binary STL read/write for the NSO_Repair dev tools. Node only — not shipped.
 *
 * Both directions speak the app's raw soup: a Float32Array of 9 floats per
 * triangle. Reading goes through Float32Array on purpose, so a fixture on disk
 * and the same fixture in the browser are bit-identical. */
'use strict';

const fs = require('fs');

function readSTL(path) {
  const buf = fs.readFileSync(path);
  const head = buf.slice(0, 200).toString('latin1').toLowerCase();
  if (head.startsWith('solid') && head.includes('facet')) return readASCII(buf.toString('latin1'));
  return readBinary(buf);
}

function readBinary(buf) {
  if (buf.length < 84) throw new Error('binary STL shorter than its own header');
  const n = buf.readUInt32LE(80);
  if (84 + n * 50 !== buf.length) {
    throw new Error('binary STL length mismatch: header says ' + n +
                    ' tris (' + (84 + n * 50) + ' bytes), file is ' + buf.length);
  }
  const out = new Float32Array(n * 9);
  let off = 84;
  for (let i = 0; i < n; i++) {
    off += 12; // facet normal, recomputed from winding on load
    for (let k = 0; k < 9; k++) { out[i * 9 + k] = buf.readFloatLE(off); off += 4; }
    off += 2; // attribute byte count
  }
  return out;
}

function readASCII(text) {
  const nums = [];
  for (const line of text.split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p[0] === 'vertex' && p.length >= 4) nums.push(+p[1], +p[2], +p[3]);
  }
  if (nums.length % 9 !== 0) throw new Error('ASCII STL vertex count is not a multiple of 3');
  return new Float32Array(nums);
}

function writeSTL(path, rawTris, header) {
  const n = rawTris.length / 9;
  if (!Number.isInteger(n)) throw new Error('raw soup is not a whole number of triangles');
  const buf = Buffer.alloc(84 + n * 50);
  buf.write((header || 'NSO_Repair fixture').slice(0, 79), 0, 'latin1');
  buf.writeUInt32LE(n, 80);
  let off = 84;
  for (let i = 0; i < n; i++) {
    const t = rawTris.subarray(i * 9, i * 9 + 9);
    const ux = t[3] - t[0], uy = t[4] - t[1], uz = t[5] - t[2];
    const vx = t[6] - t[0], vy = t[7] - t[1], vz = t[8] - t[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz);
    if (L > 0) { nx /= L; ny /= L; nz /= L; } else { nx = ny = nz = 0; }
    buf.writeFloatLE(nx, off); buf.writeFloatLE(ny, off + 4); buf.writeFloatLE(nz, off + 8);
    off += 12;
    for (let k = 0; k < 9; k++) { buf.writeFloatLE(t[k], off); off += 4; }
    buf.writeUInt16LE(0, off); off += 2;
  }
  fs.writeFileSync(path, buf);
  return n;
}

/* Load NSO_Repair.js the way a browser would: as a classic script that finds a
 * `window` and hangs itself off it. Nothing node-specific is added to the
 * module for our benefit. */
function loadRepairModule(srcPath) {
  const vm = require('vm');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(srcPath, 'utf8'), sandbox, { filename: srcPath });
  if (!sandbox.window.NSO_Repair) throw new Error('NSO_Repair.js did not attach to window');
  return sandbox.window.NSO_Repair;
}

module.exports = { readSTL, writeSTL, loadRepairModule };
