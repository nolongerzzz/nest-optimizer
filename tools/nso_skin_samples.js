#!/usr/bin/env node
/* Breakaway skin samples: support block A with a skinned top face, part
   block B seated on the skin's TIPS. Two shells in one STL, never merged.

     node tools/nso_skin_samples.js            -> fixtures/skin-samples/
     node tools/nso_skin_samples.js out/dir

   Per pattern it writes
     skin_<pattern>_block.stl   A + B together (what goes to the slicer; use
                                "split to objects" there, or import the two
                                singles below as separate objects)
     skin_<pattern>_A.stl       the skinned support block alone
     skin_<pattern>_B.stl       the part block alone, already at its seated
                                height (same coordinates as the combined file)
   and one skin-samples.json with every number the checker will be asked
   to confirm: tips plane, base plane, contact area under B, volumes.

   Geometry: Z up, millimetres. A is 30 x 30 x 8 resting on z = 0, skinned on
   +Z. B is 20 x 20 x 6, centred on A. B's bottom face sits at
   supportExtreme(A within B's footprint) + gap, gap 0 by default: the tips
   just touch. The base plane of the skin is 0.6 mm (1.0 for the ring) lower,
   and a seat measured from it would bury B in the relief by that much.

   Nothing here is drawn from the app; the app's Seat uses the same
   NSO_Skin.supportExtreme, and tools/nso_skin_test.js drives the real button
   against the same A and checks the two agree. */
'use strict';

const fs = require('fs');
const path = require('path');
const NSO_Skin = require('../nso_skin.js');
const { writeSTL } = require('./nso_stl_io.js');

const ROOT = path.resolve(__dirname, '..');

/* closed, outward-wound box as a raw soup */
function box(x0, x1, y0, y1, z0, z1) {
  const P = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
             [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const quads = [
    [0, 3, 2, 1], /* bottom, -z */
    [4, 5, 6, 7], /* top, +z */
    [0, 1, 5, 4], /* -y */
    [2, 3, 7, 6], /* +y */
    [1, 2, 6, 5], /* +x */
    [3, 0, 4, 7]  /* -x */
  ];
  const out = [];
  for (const q of quads) {
    const [a, b, c, d] = q.map(i => P[i]);
    out.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  return new Float32Array(out);
}

function translate(soup, dx, dy, dz) {
  const out = new Float32Array(soup.length);
  for (let i = 0; i < soup.length; i += 3) {
    out[i] = soup[i] + dx; out[i + 1] = soup[i + 1] + dy; out[i + 2] = soup[i + 2] + dz;
  }
  return out;
}

function concat(a, b) {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}

function signedVolume(s) {
  let v = 0;
  for (let o = 0; o < s.length; o += 9) {
    v += s[o] * (s[o + 4] * s[o + 8] - s[o + 5] * s[o + 7])
       - s[o + 1] * (s[o + 3] * s[o + 8] - s[o + 5] * s[o + 6])
       + s[o + 2] * (s[o + 3] * s[o + 7] - s[o + 4] * s[o + 6]);
  }
  return v / 6;
}

const SAMPLES = [
  { pattern: 'crosshatch', params: {} },
  { pattern: 'zigzag', params: {} },
  { pattern: 'ring', params: {} }
];

const A_SIZE = { x: 30, y: 30, z: 8 };
const B_SIZE = { x: 20, y: 20, z: 6 };

/* Build one sample. gap in the coupon convention: negative = air, 0 = tips
   touch B's face, positive = B sunk into the relief. */
function buildSample(pattern, opts) {
  opts = opts || {};
  const gap = opts.gap || 0;
  const params = opts.params || {};
  const A0 = box(-A_SIZE.x / 2, A_SIZE.x / 2, -A_SIZE.y / 2, A_SIZE.y / 2, 0, A_SIZE.z);
  const skin = NSO_Skin.applySkinToFace(A0, { dir: [0, 0, 1], pattern, params, mode: opts.mode || 'raise' });
  if (!skin.ok) throw new Error(pattern + ': ' + skin.reason);
  const A = skin.tris;

  /* B's footprint, as the 4 corners of its mating face (height irrelevant) */
  const hx = B_SIZE.x / 2, hy = B_SIZE.y / 2;
  const footprint = [[-hx, -hy, 0], [hx, -hy, 0], [hx, hy, 0], [-hx, hy, 0]];
  const ext = NSO_Skin.supportExtreme(A, footprint, [0, 0, 1], { sMax: 1e9 });
  if (!ext) throw new Error(pattern + ': nothing under B');
  const tips = ext.s;
  const bBottom = tips - gap;
  const B = box(-hx, hx, -hy, hy, bBottom, bBottom + B_SIZE.z);
  const contact = NSO_Skin.tipContactArea(A, footprint, [0, 0, 1], tips, 1e-6);

  return {
    pattern, gap, A, B, combined: concat(A, B), skin,
    meta: {
      pattern, mode: skin.mode, params: skin.params, describe: skin.describe,
      A_size: A_SIZE, B_size: B_SIZE,
      base_plane_z: skin.basePlane, tips_plane_z: skin.tipsPlane, tips_measured_z: tips,
      skin_height: skin.tipHeight,
      B_bottom_z: bBottom, gap_mm: gap,
      tip_area_total_mm2: skin.tipArea, contact_area_under_B_mm2: contact,
      volume_A: signedVolume(A), volume_B: signedVolume(B),
      tris_A: A.length / 9, tris_B: B.length / 9
    }
  };
}

function writeSamples(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = { generated_by: 'tools/nso_skin_samples.js', units: 'mm, Z up', samples: {} };
  for (const s of SAMPLES) {
    const r = buildSample(s.pattern, { params: s.params });
    const base = 'skin_' + s.pattern;
    writeSTL(path.join(outDir, base + '_block.stl'), r.combined, 'NSO skin sample ' + s.pattern + ' A+B');
    writeSTL(path.join(outDir, base + '_A.stl'), r.A, 'NSO skin sample ' + s.pattern + ' A');
    writeSTL(path.join(outDir, base + '_B.stl'), r.B, 'NSO skin sample ' + s.pattern + ' B');
    manifest.samples[s.pattern] = Object.assign({ files: [base + '_block.stl', base + '_A.stl', base + '_B.stl'] }, r.meta);
    console.log(s.pattern.padEnd(11) + ' tips z ' + r.meta.tips_measured_z.toFixed(4) +
      '  base z ' + r.meta.base_plane_z.toFixed(4) +
      '  B bottom z ' + r.meta.B_bottom_z.toFixed(4) +
      '  contact under B ' + r.meta.contact_area_under_B_mm2.toFixed(3) + ' mm^2' +
      '  tris ' + r.meta.tris_A + ' + ' + r.meta.tris_B);
  }
  fs.writeFileSync(path.join(outDir, 'skin-samples.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

module.exports = { buildSample, writeSamples, box, concat, signedVolume, SAMPLES, A_SIZE, B_SIZE };

if (require.main === module) {
  const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'fixtures', 'skin-samples');
  writeSamples(outDir);
  console.log('wrote ' + outDir);
}
