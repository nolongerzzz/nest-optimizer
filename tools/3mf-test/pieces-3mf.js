/*
 * pieces3MF(file): a 3MF's pieces as plate-space vertex lists, taken apart with
 * `unzip`, for the checks that read an export without NSO's own reader.
 *
 * Reads both shapes nso-3mf.js writes:
 *   - Bambu Studio's project envelope (docs/BAMBU-PROJECT-EXPORT.md): a
 *     wrapper object per piece in 3D/3dmodel.model, one <component> on its
 *     mesh in 3D/Objects/object_N.model, placed by the build item;
 *   - the geometry-only envelope: each piece's mesh inline in 3D/3dmodel.model.
 *
 * One entry per build item, in build order: { id, verts: [[x, y, z], ...],
 * tris }. The item's and component's 3MF transforms (row-vector 3 x 4) are
 * applied.
 */
'use strict';

const { execFileSync } = require('child_process');

const part = (file, name) => execFileSync('unzip', ['-p', file, name], { encoding: 'utf8', maxBuffer: 256 << 20 });

function parseT(s) { return s ? s.trim().split(/\s+/).map(Number) : [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]; }
function apply(t, v) {
  return [v[0] * t[0] + v[1] * t[3] + v[2] * t[6] + t[9],
          v[0] * t[1] + v[1] * t[4] + v[2] * t[7] + t[10],
          v[0] * t[2] + v[1] * t[5] + v[2] * t[8] + t[11]];
}
function objectsIn(xml) {
  const out = new Map();
  for (const m of xml.matchAll(/<object id="(\d+)"[^>]*>([\s\S]*?)<\/object>/g)) out.set(m[1], m[2]);
  return out;
}

function pieces3MF(file) {
  const root = part(file, '3D/3dmodel.model');
  const objs = objectsIn(root);
  const cache = new Map();
  const items = [...root.matchAll(/<item ([^>]*)\/>/g)].map((m) => ({
    id: (m[1].match(/objectid="(\d+)"/) || [])[1],
    t: parseT((m[1].match(/transform="([^"]*)"/) || [])[1])
  }));
  return items.map((it) => {
    let body = objs.get(it.id) || '';
    let t = it.t;
    const comp = body.match(/<component p:path="\/([^"]*)" objectid="(\d+)"[^>]*?(?:transform="([^"]*)")?[^>]*\/>/);
    if (comp) {
      if (!cache.has(comp[1])) cache.set(comp[1], objectsIn(part(file, comp[1])));
      const c = parseT(comp[3]);
      // component then item: v * C * T
      t = [0, 1, 2, 3].flatMap((r) => [0, 1, 2].map((k) =>
        (r < 3 ? 0 : t[9 + k]) + [0, 1, 2].reduce((s, j) => s + (r < 3 ? c[3 * r + j] : c[9 + j]) * t[3 * j + k], 0)));
      body = cache.get(comp[1]).get(comp[2]) || '';
    }
    const verts = [...body.matchAll(/<vertex x="([-\d.eE+]+)" y="([-\d.eE+]+)" z="([-\d.eE+]+)"/g)]
      .map((v) => apply(t, v.slice(1).map(Number)));
    return { id: Number(it.id), verts, tris: (body.match(/<triangle /g) || []).length };
  });
}

module.exports = { pieces3MF };
