#!/usr/bin/env node
/* G-scope COMPARE, Pieces, on NSO's own slice: a click on a head, its tree support or its brim takes the head WITH its
   supports and brim - one piece, as a click on Bambu's slice of the same plate does.

   NSO's slice prints every support and brim as an object of its own (its own OBJECT_ID, so Export and the exclude mask
   can name it), where Bambu prints a head's supports under the head's label. The owner's Oblique came out as two pieces,
   depending on where it was clicked. G-scope now reads which head each support / brim id holds - from the Supports
   card's slice (the document's nsoPlateSlice: labels and pieces) or G-scope's Slice switch (pieceHeads) - and Compare
   Pieces takes the head's group, split into islands as before.

   GATES (fixtures/supports/supp_ref.3mf, Generate for plate, Slice / Preview; plate 2 Bambu's supp_ref_v2.gcode.3mf)
     1. The slice has a support and a brim object of their own for the head under test (the case this guards).
     2. A click on the head, on its support and on its brim each sets the same piece on plate 3: the head's lines, its
        support's and its brim's, every one of them.
     3. Outside Compare a click still takes one OBJECT_ID (the support alone): Export and the rest are unchanged.
     4. G-scope's own Slice switch (the plate read, sliced there) hands G-scope the same map: each support and brim
        object -> its head's object.

     node tools/nso_gscope_compare_heads_test.js        exit 0 = every gate held */
'use strict';
const { withApp } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => { console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : '')); if (!cond) fails++; };
const J = JSON.stringify;
const HEAD = 'Support Oblique';

withApp(async (page, logs) => {
  page.on('dialog', (d) => d.accept().catch(() => {}));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(async () => {
    const b = await (await fetch('/fixtures/supports/supp_ref.3mf')).arrayBuffer();
    handleFiles([new File([new Uint8Array(b)], 'supp_ref.3mf')]);
  });
  await page.waitForFunction(() => state.placed.length >= 6, null, { timeout: 60000 });
  await page.waitForTimeout(500);
  await page.evaluate(() => { const m = document.getElementById('menu-supports'); if (m) m.open = true; });
  await page.waitForTimeout(300);
  await page.evaluate(() => { const b = document.getElementById('sup-plate'); if (b && !b.checked) { b.checked = true; b.dispatchEvent(new Event('change')); } });
  /* a head with a support AND a brim: Brim round the foot is off in the card's default view, so this gate turns it on */
  await page.evaluate(() => { const b = document.getElementById('sup-brim'); if (b) b.checked = true; });
  const g = await page.evaluate(() => NSO_SUPPORTS_CARD.generate().then((r) => ({ ok: !!(r && r.ok), reason: r && r.reason })));
  const s = await page.evaluate(() => NSO_SUPPORTS_CARD.sliceAndPreview().then((r) => ({ ok: r.ok, reason: r.reason })));
  await page.waitForFunction(() => { const d = NSO_MICROSCOPE.getDoc(); return d && d.kind === 'toolpath' && d.nsoPlateSlice; }, null, { timeout: 180000 });
  await page.evaluate(() => { NSO_MICROSCOPE.showPlate('lens'); });

  console.log('\n=== 1. the slice ===');
  const ids = await page.evaluate((HEAD) => {
    const d = NSO_MICROSCOPE.getDoc(), rec = d.nsoPlateSlice;
    const of = (pred) => rec.labels.filter((l) => pred(rec.pieces[l.index] || {}, l)).map((l) => String(l.id));
    const head = rec.pieces.find((p) => !p.support && p.name === HEAD);
    const cnt = {}; d.segments.forEach((x) => { cnt[x.obj] = (cnt[x.obj] || 0) + 1; });
    const part = of((p) => p === head)[0];
    const support = of((p) => p.support && !p.brim && p.hostSourceId === head.sourceId)[0];
    const brim = of((p) => p.support && p.brim && p.hostSourceId === head.sourceId)[0];
    const group = of((p) => p === head || (p.support && p.hostSourceId === head.sourceId));
    return { part, support, brim, group, lines: group.reduce((a, id) => a + (cnt[id] || 0), 0), each: group.map((id) => [id, cnt[id] || 0]) };
  }, HEAD);
  check('Generate for plate and Slice / Preview ran', g.ok && s.ok, J([g, s]));
  check(HEAD + ': the part, its support and its brim are objects of their own (' + J(ids.each) + ')', !!(ids.part && ids.support && ids.brim) && new Set([ids.part, ids.support, ids.brim]).size === 3, J(ids));

  await page.evaluate(async () => {
    NSO_MICROSCOPE.showPlate('take');
    const b = await (await fetch('/fixtures/supports/supp_ref_v2.gcode.3mf')).arrayBuffer();
    await NSO_MICROSCOPE.openFile('supp_ref_v2.gcode.3mf', b);
  });
  await page.waitForFunction(() => NSO_MICROSCOPE.plate() === 'take' && NSO_MICROSCOPE.getDoc() && NSO_MICROSCOPE.getDoc().kind === 'toolpath', null, { timeout: 60000 });

  /* a click on a shown line of OBJECT_ID `id` on the active plate, taken as the 3D view takes one (pickSegment: the
     same piece a pointer click takes, without the ray - a click on a plate this size, through its neighbours, is a
     matter for gscope:compare-island) */
  const clickObj = (id) => page.evaluate((id) => {
    const M = NSO_MICROSCOPE, d = M.getDoc();
    const sg = d.segments.find((x) => String(x.obj) === String(id) && x.feature !== 'Travel');
    return sg ? M.pickSegment(sg.id) : 0;
  }, id);

  console.log('\n=== 2. Compare Pieces: the head, its support, its brim ===');
  const got = {};
  for (const [what, id] of [['the part', ids.part], ['its support', ids.support], ['its brim', ids.brim]]) {
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.compareClear(); ['take', 'lens'].forEach((n) => { M.showPlate(n); M.clearBoxes(); M.back(); }); M.showPlate('lens'); });
    await page.evaluate(() => { const b = document.getElementById('ms-compare-body'); if (b && b.hidden) document.getElementById('ms-compare-toggle').click(); document.getElementById('ms-compare-pieces').click(); });
    await page.waitForTimeout(200);
    const c1 = await clickObj(id);
    await page.waitForFunction(() => NSO_MICROSCOPE.comparePicking() === 'take' && NSO_MICROSCOPE.plate() === 'take', null, { timeout: 30000 }).catch(() => {});
    const c2 = await page.evaluate(() => NSO_MICROSCOPE.pickPiece(0).length);   // any piece of Bambu's slice
    await page.waitForFunction(() => !!NSO_MICROSCOPE.plateDoc('cmp'), null, { timeout: 30000 }).catch(() => {});
    const r = await page.evaluate(() => { const d = NSO_MICROSCOPE.plateDoc('cmp'); return d ? d.objects[0].moves.map((m) => m.objectId) : null; });
    const per = {}; (r || []).forEach((o) => { per[o] = (per[o] || 0) + 1; });
    got[what] = per;
    check('a click on ' + what + ' (' + id + ') sets ' + HEAD + ' with its support and brim on plate 3: ' + (r ? r.length : 0) + ' of ' + ids.lines + ' lines',
      c1 > 0 && c2 > 0 && r && r.length === ids.lines && ids.group.every((g2) => per[g2] > 0), J({ per, c1, c2 }));
  }
  check('...the same piece whichever was clicked', J(got['the part']) === J(got['its support']) && J(got['the part']) === J(got['its brim']), J(got));
  await page.evaluate(() => { NSO_MICROSCOPE.compareClear(); });

  console.log('\n=== 3. outside Compare ===');
  const one = await page.evaluate((id) => {
    const M = NSO_MICROSCOPE; M.showPlate('lens'); M.clearBoxes(); M.back();
    const d = M.getDoc(), ids = [...new Set(d.segments.map((x) => x.obj))], k = ids.findIndex((x) => String(x) === String(id));
    const sel = M.pickPiece(k);
    const set = [...new Set(sel.map((x) => String(x.obj)))];
    M.back();
    return set;
  }, ids.support);
  check('a piece click outside Compare still takes one OBJECT_ID (the support alone)', J(one) === J([ids.support]), J(one));

  console.log('\n=== 4. G-scope\'s own Slice switch ===');
  const sw = await page.evaluate(async (HEAD) => {
    const M = NSO_MICROSCOPE;
    M.compareClear(); M.showPlate('lens'); M.clearBoxes(); M.back();
    if (!M.openPlate()) return { err: 'no plate read' };
    const r = await NSO_GSCOPE_SLICE.slice();
    if (!r || !r.ok) return { err: 'slice: ' + (r && r.reason) };
    const d = M.getDoc(), heads = d.pieceHeads, res = r.result;
    const head = res.objects.find((o) => o.role === 'part' && o.name === HEAD);
    const mine = res.objects.filter((o) => o.role !== 'part' && o.hostKey != null && o.hostKey === head.key);
    return { head: String(head.id), mine: mine.map((o) => [String(o.id), o.role, heads ? heads.get(String(o.id)) : null]), size: heads ? heads.size : 0 };
  }, HEAD);
  check('the slice tells G-scope which head each support and brim holds: ' + HEAD + '\'s (' + J(sw.mine) + ') -> ' + sw.head,
    !sw.err && sw.mine && sw.mine.length >= 2 && sw.mine.every((m) => m[2] === sw.head), J(sw));

  check('no page errors', logs.filter((l) => /^\[pageerror\]/.test(l)).length === 0, logs.filter((l) => /^\[pageerror\]/.test(l)).slice(0, 3).join(' | '));
  console.log(fails ? '\nFAILED (' + fails + ')' : '\nall gates held');
  process.exitCode = fails ? 1 : 0;
});
