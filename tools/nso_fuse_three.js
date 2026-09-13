/* Locate three r147 for the drift tests. The browser app loads it from a CDN;
   in node, point THREE_PATH at a build or npm i three@0.147.0 somewhere on the
   usual paths. Only the tolerance/drift tests need it - the chain test and the
   module itself have no dependency. */
const fs = require('fs');
const path = require('path');
const cands = [
  process.env.THREE_PATH,
  path.join(__dirname, '..', 'node_modules', 'three', 'build', 'three.cjs'),
  path.join(process.env.HOME || '', 'node_modules', 'three', 'build', 'three.cjs'),
].filter(Boolean);
for (const c of cands) { if (fs.existsSync(c)) { module.exports = require(c); return; } }
console.error('three r147 not found. Set THREE_PATH=/path/to/three/build/three.cjs');
console.error('or run: npm install three@0.147.0');
process.exit(2);
