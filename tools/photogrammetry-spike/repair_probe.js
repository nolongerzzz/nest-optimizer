#!/usr/bin/env node
/* Feed a mesh through the real NSO_Repair.commit(), both with and without the
 * nonSolid flag, and print the report as JSON. Research probe for the
 * photogrammetry spike - reads the repo's own module, changes nothing. */
'use strict';
const path = require('path');
const ROOT = '/home/user/nest-optimizer';
const { readSTL, writeSTL, loadRepairModule } = require(path.join(ROOT, 'tools', 'nso_stl_io.js'));
const R = loadRepairModule(path.join(ROOT, 'NSO_Repair.js'));

const file = process.argv[2];
const outDir = process.argv[3] || null;
const raw = readSTL(file);
const out = { file, inputTris: raw.length / 9, runs: {} };

for (const mode of ['default', 'nonSolid']) {
  const opts = mode === 'nonSolid' ? { nonSolid: true } : {};
  const t0 = Date.now();
  let res;
  try { res = R.commit(raw, opts); }
  catch (e) { out.runs[mode] = { threw: String(e && e.message) }; continue; }
  const r = res.report || {};
  const rec = {
    ok: res.ok, applied: r.applied, declined: r.declined,
    unchanged: res.rawTris === raw,
    seconds: +((Date.now() - t0) / 1000).toFixed(1),
    triDelta: r.triDelta, volumeDelta: r.volumeDelta,
    before: r.before, after: r.after, rejected: r.rejected,
    gate: r.gate, counts: r.counts,
    stages: (r.stages || []).map(s => ({
      name: s.name, applied: s.applied, skipped: s.skipped,
      blocked: s.blocked, count: s.count, note: s.note
    })),
    reason: r.reason
  };
  out.runs[mode] = rec;
  if (outDir && res.rawTris && res.rawTris.length) {
    const p = path.join(outDir, path.basename(file, '.stl') + '.' + mode + '.stl');
    writeSTL(p, res.rawTris, 'pgspike ' + mode);
    rec.wrote = p;
  }
}
console.log(JSON.stringify(out, null, 2));
