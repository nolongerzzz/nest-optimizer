#!/usr/bin/env node
/* Export plate 3MF keeps a 3MF's own vertex indexing: shells that touch stay apart.

   The owner's plate_export.3mf (the A1 mini template) holds six supp_ref heads; in four of them the stem and the head
   are two closed shells meeting at a ring of coincident vertices. The plate export welded vertices by position, so each
   ring edge was shared by four faces and Studio marked those four objects with mesh errors (40 / 40 / 40 / 119
   non-manifold edges). A piece read from a 3MF now carries the file's vertex ids (nso-3mf-read.js vertexIds) and the
   export writes them back while they still line up with its geometry (app-core.js nsoIndexForExport).

   GATES
     1. Import plate_export.3mf and Export plate as 3MF (a real download): every object closed and manifold - every edge
        shared by exactly two faces - with the reference's own vertex and triangle counts.
     2. A piece turned on the plate keeps them (the ids follow the soup, not its position).
     3. A piece whose geometry no longer lines up with its ids (its triangles reordered) is welded by position, as
        before - the stale ids are not trusted.

     node tools/nso_export_touching_shells_test.js        exit 0 = every gate held */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { withApp, ROOT } = require('./nso_app_harness');
const R = require(path.join(ROOT, 'nso-3mf-read.js'));

let fails = 0;
const check = (name, cond, detail) => { console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : '')); if (!cond) fails++; };
const REF = 'fixtures/bambu-templates/a1mini-0.4/plate_export.3mf';

/* Each object of a 3MF's root model, as written: { name, verts, tris, open, over } (the mesh objects, by wrapper name). */
async function meshStats(bytes) {
  const zip = R.openZip(new Uint8Array(bytes));
  const dec = new TextDecoder();
  const model = dec.decode(await zip.read('3D/3dmodel.model'));
  const ms = dec.decode(await zip.read('Metadata/model_settings.config'));
  const names = new Map([...ms.matchAll(/<object id="(\d+)">\s*<metadata key="name" value="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const inner = new Map([...model.matchAll(/<object id="(\d+)" type="model">\s*<components>\s*<component objectid="(\d+)"/g)].map((m) => [m[2], names.get(m[1])]));
  return [...model.matchAll(/<object id="(\d+)" type="model">\s*<mesh>([\s\S]*?)<\/mesh>/g)].map((m) => {
    const verts = (m[2].match(/<vertex /g) || []).length;
    const T = [...m[2].matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)].map((t) => [+t[1], +t[2], +t[3]]);
    const e = new Map();
    T.forEach(([a, b, c]) => [[a, b], [b, c], [c, a]].forEach(([p, q]) => { const k = Math.min(p, q) + ',' + Math.max(p, q); e.set(k, (e.get(k) || 0) + 1); }));
    let open = 0, over = 0;
    e.forEach((n) => { if (n === 1) open++; if (n > 2) over++; });
    return { name: String(inner.get(m[1]) || m[1]).replace(/\.stl$/i, ''), verts, tris: T.length, open, over };
  });
}

withApp(async (page, logs) => {
  page.on('dialog', (d) => d.accept().catch(() => {}));
  const ref = await meshStats(fs.readFileSync(path.join(ROOT, REF)));
  await page.evaluate(async (u) => {
    const b = await (await fetch('/' + u)).arrayBuffer();
    handleFiles([new File([new Uint8Array(b)], 'plate_export.3mf')]);
  }, REF);
  await page.waitForFunction(() => state.placed.length >= 6, null, { timeout: 60000 });
  await page.waitForTimeout(500);

  console.log('\n=== 1. Export plate 3MF, a real download ===');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-shells-'));
  await page.evaluate(() => { const e = document.getElementById('export-format'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
  await page.selectOption('#export-format', '3mf');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#btn-export-stl')]);
  const file = path.join(tmp, dl.suggestedFilename());
  await dl.saveAs(file);
  const got = await meshStats(fs.readFileSync(file));
  const byName = new Map(got.map((o) => [o.name, o]));
  check('six objects, named as the reference', got.length === 6 && ref.every((o) => byName.has(o.name)), got.map((o) => o.name).join(', '));
  ref.forEach((o) => {
    const g = byName.get(o.name) || {};
    check(o.name + ': closed and manifold (open ' + g.open + ', edges on 3+ faces ' + g.over + '), ' + g.verts + ' vertices / ' + g.tris + ' triangles as the reference',
      g.open === 0 && g.over === 0 && g.verts === o.verts && g.tris === o.tris, 'reference ' + o.verts + ' / ' + o.tris);
  });

  /* the in-page build, per piece: what nsoIndexForExport made of it */
  const build = () => page.evaluate(() => buildPlacedObjects3MF().map((o) => {
    const e = new Map();
    for (let t = 0; t < o.triangles.length; t += 3) {
      const a = o.triangles[t], b = o.triangles[t + 1], c = o.triangles[t + 2];
      [[a, b], [b, c], [c, a]].forEach(([p, q]) => { const k = Math.min(p, q) + ',' + Math.max(p, q); e.set(k, (e.get(k) || 0) + 1); });
    }
    let over = 0; e.forEach((n) => { if (n > 2) over++; });
    return { name: o.name, verts: o.vertices.length / 3, over };
  }));

  console.log('\n=== 2. a piece turned on the plate ===');
  await page.evaluate(() => { const p = state.placed.find((q) => q.name === 'Support Oblique'); p.rotY = Math.PI / 3; });
  const turned = (await build()).find((o) => o.name === 'Support Oblique');
  const refOb = ref.find((o) => o.name === 'Support Oblique');
  check('Support Oblique turned 60 deg keeps the file\'s indexing (' + turned.verts + ' vertices, no edge on 3+ faces)', turned.verts === refOb.verts && turned.over === 0, JSON.stringify(turned));
  await page.evaluate(() => { const p = state.placed.find((q) => q.name === 'Support Oblique'); p.rotY = 0; });

  console.log('\n=== 3. ids that no longer line up are not trusted ===');
  const stale = await page.evaluate(() => {
    const p = state.placed.find((q) => q.name === 'Support Circular');
    const m = state.models.find((x) => x.id === p.sourceId);
    const keep = m.srcVertexIds;
    // the same triangles, in reverse order: what a tool that rebuilds the soup leaves behind
    const ids = new Int32Array(keep.length);
    for (let t = 0; t < keep.length; t += 3) for (let k = 0; k < 3; k++) ids[t + k] = keep[keep.length - 3 - t + k];
    m.srcVertexIds = ids;
    const o = buildPlacedObjects3MF().find((x) => x.name === 'Support Circular');
    m.srcVertexIds = keep;
    return { verts: o.vertices.length / 3 };
  });
  const refCirc = ref.find((o) => o.name === 'Support Circular');
  check('reordered ids: welded by position as before (' + stale.verts + ' vertices, fewer than the file\'s ' + refCirc.verts + ')', stale.verts < refCirc.verts, JSON.stringify(stale));

  check('no page errors', logs.filter((l) => /^\[pageerror\]/.test(l)).length === 0, logs.filter((l) => /^\[pageerror\]/.test(l)).slice(0, 3).join(' | '));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fails ? '\nFAILED (' + fails + ')' : '\nall gates held');
  process.exitCode = fails ? 1 : 0;
});
