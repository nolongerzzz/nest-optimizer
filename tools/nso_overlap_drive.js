#!/usr/bin/env node
/* Work as is: overlapping shells, driven through the real app (nso-helpers.js, nsoOverlap): real index.html, real
   script tags. library/box_closed.stl is a tray and a lid slab laid over each other (2 shells, 74 piercing pairs).
   No verb refuses it for that any more: the verbs whose kernel needs a solid merge its shells into one, for that
   operation, and say so. This is the inverse of what it gated before (#213's refusal).
     node tools/nso_overlap_drive.js          exit 0 = every gate held
     npm run overlap:drive

   1. the measure and the merge: box_closed is 2 overlapping shells and the cleaned box (tools/nso_fixture_union.mjs)
      none; shells that only touch are not overlap; each runs ONCE per piece however often a verb asks
   2. CHECK & REPAIR: Check lists "2 overlapping shells" with a MERGE SHELLS button; pressing it makes the piece one
      closed solid (mesh_validate), and one Undo puts the shells back byte for byte
   3. every verb that needs a solid ACCEPTS box_closed, says "box_closed had 2 overlapping shells - merged for this
      operation", and its result is closed to the canonical checker (tools/mesh_validate.py):
        Bridge (sheet), Connect (weld), Join, Subtract B from A, Crop (the card's copy: a sphere and a piece cutter;
        the original byte-identical after), Extract bit, Carve, Attach; and Reattach, on the clamp bar with a block
        pushed through it (a flange is too long and box_closed too hollow to seat one on, overlap or not)
   4. a deliberately unmendable piece - box_closed with one triangle of the lid gone, so a shell is open and no
      closed solid can come of a merge - is still refused, in words, and nothing changes (Crop, Join)
   5. verbs that never needed a solid have no check at all: only the files of the verbs above name nsoOverlap, and
      Detach runs without asking it
   6. the user's big 3MF (tools/fixtures-local/boolean-vase.3mf, or NSO_BOOLEAN_3MF; not in the repo): CROP takes a
      copy of it; skipped, with a notice, when the file is absent */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, statusOf } = require('./nso_app_harness');
const L = require('./nso_bridge_testlib.js');
const { canonical } = require('./nso_repair_loop_lib.js');
const { readSTL, writeSTL } = require('./nso_stl_io.js');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-overlap-drive-'));
const BAD_SRC = path.join(ROOT, 'library', 'box_closed.stl');
const CLEAN = path.join(TMP, 'box_clean.stl');
execFileSync('node', ['--no-warnings', path.join(__dirname, 'nso_fixture_union.mjs'), BAD_SRC, CLEAN], { stdio: 'pipe' });
// A copy under its own name, so the piece the readout names is not the fixture's.
const BAD = path.join(TMP, 'box_closed.stl');
fs.copyFileSync(BAD_SRC, BAD);
// Unmendable: the last triangle of the file gone, so a shell is open and no closed solid can come of the merge.
const OPEN = path.join(TMP, 'box_lid_open.stl');
{ const s = readSTL(BAD_SRC); writeSTL(OPEN, s.slice(0, s.length - 9), 'box_lid_open'); }
const BIT = L.writeSTL(path.join(TMP, 'bit.stl'), L.box(0, 0, 0, 10, 10, 10));
const BIG3MF = path.resolve(process.env.NSO_BOOLEAN_3MF || path.join(__dirname, 'fixtures-local', 'boolean-vase.3mf'));

const NOTE = 'box_closed had 2 overlapping shells - merged for this operation';
const noted = s => String(s || '').indexOf(NOTE) >= 0;
const refusedForShells = s => /has overlapping shells|overlapping shells that cannot/.test(s || '');
// closed to the canonical checker: no open or non-manifold edge, nothing piercing, wound one way
function closed(soup, name) {
  const c = canonical(Float32Array.from(soup), name);
  return { ok: c.open === 0 && c.nm === 0 && c.pierce === 0 && c.winding === 0 && c.degenerate === 0, c };
}
const said = c => 'open ' + c.open + ', nm ' + c.nm + ', piercing ' + c.pierce + ', mis-wound ' + c.winding + ', ' + c.triangles + ' tris, ' + c.verdict;

/* ---- in-page helpers, installed once ---- */
function installHelpers() {
  window.__ov = {
    placed(id) { return state.placed.find(p => p && p.sourceId === id); },
    model(id) { return state.models.find(m => m.id === id); },
    up(id) {
      const p = this.placed(id); p.mesh.updateMatrixWorld(true);
      const s = meshToWorldSoup(p.mesh), o = new Float32Array(s.length);
      for (let i = 0; i < s.length; i += 3) { o[i] = s[i]; o[i + 1] = -s[i + 2]; o[i + 2] = s[i + 1]; }
      return o;
    },
    upArr(id) { return Array.from(this.up(id)); },
    raw(id) { return Array.from(getModelRawSoup(this.model(id))); },
    bounds(s) {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < s.length; i++) { const k = i % 3; if (s[i] < lo[k]) lo[k] = s[i]; if (s[i] > hi[k]) hi[k] = s[i]; }
      return { lo, hi };
    },
    // Put B where A is, shifted by (dx, dy) in the plate's Z-up frame, level with it.
    stand(idA, idB, dx, dy) {
      const a = this.bounds(this.up(idA)), b = this.bounds(this.up(idB)), pb = this.placed(idB);
      const mx = (a.lo[0] - b.lo[0]) + dx, mz = -((a.lo[1] - b.lo[1]) + dy);
      pb.x += mx; pb.z += mz; pb.mesh.position.x += mx; pb.mesh.position.z += mz;
      pb.mesh.updateMatrixWorld(true);
    },
    sel(id, target) { const p = this.placed(id); return { sourceId: id, placed: p, cache: NSO_bridgeIndexFor(p), target, world: new THREE.Vector3() }; },
    // Targets on a piece: edges (bridge) or anything (connect) near triangle centroids, filtered by x.
    targets(id, want, xOk) {
      const c = NSO_bridgeIndexFor(this.placed(id)), s = c.soup, out = [], seen = new Set();
      for (let t = 0; t < s.length / 9; t++) for (let e = 0; e < 3; e++) {
        const o = t * 9, k = (e + 1) % 3;
        const a = [0, 1, 2].map(i => s[o + e * 3 + i]), b = [0, 1, 2].map(i => s[o + k * 3 + i]);
        const g = [0, 1, 2].map(i => (s[o + i] + s[o + 3 + i] + s[o + 6 + i]) / 3);
        const p = [0, 1, 2].map(i => (a[i] + b[i]) / 2 + (g[i] - (a[i] + b[i]) / 2) * 0.02);
        const tg = NSO_Bridge.pick(c.T, t, p);
        if (!tg || tg.kind !== want) continue;
        const key = tg.kind === 'edge' ? [tg.a, tg.b].map(q => q.map(v => v.toFixed(2)).join()).sort().join('|') : tg.kind + t;
        if (seen.has(key)) continue; seen.add(key);
        if (xOk(tg.kind === 'edge' ? tg.a : tg.point, tg.kind === 'edge' ? tg.b : tg.point)) out.push(tg);
      }
      return out;
    },
    // The first pair of targets one on each piece that plans ok.
    firstPlan(planFn, idA, idB, want, xA, xB) {
      const ta = this.targets(idA, want, xA), tb = this.targets(idB, want, xB);
      const upA = this.up(idA), upB = this.up(idB);
      for (const x of ta) for (const y of tb) {
        const p = planFn([upA, upB], x, y);
        if (p && p.ok) return { a: x, b: y, kind: p.kind, result: p.result };
      }
      return { reason: 'no plannable pair among ' + ta.length + ' x ' + tb.length };
    },
    // CLEAR PLATE keeps the library's models (#224 took the header's Clear); drop them too, as Clear did.
    clear() { document.getElementById('btn-clear-plate').click(); state.models = []; state.editId = null; },
    status() { const e = document.getElementById('status'); return e ? e.textContent : ''; },
    // how often the measure and the merge really ran (not how often they were asked)
    count() {
      if (window.__calls) return;
      window.__calls = { measure: 0, merge: 0 };
      const m = window.NSO_overlapMeasure, g = window.NSO_shellMergeCore;
      window.NSO_overlapMeasure = function () { window.__calls.measure++; return m.apply(this, arguments); };
      window.NSO_shellMergeCore = function () { window.__calls.merge++; return g.apply(this, arguments); };
    }
  };
}

(async () => {
  await withApp(async (page, logs) => {
    await page.evaluate(installHelpers);
    await page.evaluate(() => window.__ov.count());
    const calls = () => page.evaluate(() => Object.assign({}, window.__calls));

    /* ================================================================ 1 */
    console.log('\n=== 1. the measure and the merge, each once per piece ===');
    {
      const bad = await loadSTL(page, BAD), good = await loadSTL(page, CLEAN);
      const c0 = await calls();
      const r = await page.evaluate(async ([bad, good]) => {
        const mb = window.__ov.model(bad), mg = window.__ov.model(good);
        const first = nsoOverlap.shells(mb.rawTris), again = nsoOverlap.shells(mb.rawTris), clean = nsoOverlap.shells(mg.rawTris);
        const s1 = await nsoOverlap.solid(mb), s2 = await nsoOverlap.solid(mb), s3 = await nsoOverlap.solid(mg);
        const ran = Object.assign({}, window.__calls);
        // a bar with a mark standing on its face: two shells in contact, not overlap
        const bx = (x0, y0, z0, x1, y1, z1) => { const v = [[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]], F = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]], o = []; F.forEach(f => f.forEach(i => o.push(...v[i]))); return o; };
        const marked = new Float32Array(bx(0,0,0,60,10,6).concat(bx(50,7,6,58,10,9)));
        const touching = { pierce: NSO_Repair.inspect(marked).selfIntersections, shells: nsoOverlap.shells(marked) };
        return { first, again, clean, touching, ran,
                 s1: { ok: s1.ok, merged: s1.merged, note: s1.note, same: s1.soup === s2.soup, tris: s1.soup ? s1.soup.length / 9 : 0 },
                 s3: { ok: s3.ok, merged: s3.merged },
                 soup: s1.soup ? Array.from(s1.soup) : null };
      }, [bad, good]);
      const c1 = r.ran;
      check('box_closed is 2 overlapping shells, the cleaned box none', r.first === 2 && r.clean === 0, r.first + ' / ' + r.clean);
      check('box_closed merges, with the readout\'s words', r.s1.ok && r.s1.merged && r.s1.note === NOTE, r.s1.note);
      check('the cleaned box is not merged: it goes to the kernel as it is', r.s3.ok && r.s3.merged === false);
      check('measured once per piece (5 asks on 2 pieces, 2 runs) and merged once (2 asks, 1 run, the same solid back)',
        c1.measure - c0.measure === 2 && c1.merge - c0.merge === 1 && r.s1.same, JSON.stringify([c0, c1]));
      check('shells that only touch (a mark on a bar: the checker counts ' + r.touching.pierce + ' pairs) are not overlap', r.touching.pierce > 0 && r.touching.shells === 0, JSON.stringify(r.touching));
      const cl = closed(r.soup, 'merged');
      check('the merged solid is closed to the canonical checker', cl.ok && cl.c.verdict === 'PASS', said(cl.c));
      await page.evaluate(() => window.__ov.clear());
    }

    /* ================================================================ 2 */
    console.log('\n=== 2. CHECK & REPAIR: the finding and MERGE SHELLS ===');
    {
      const id = await loadSTL(page, BAD);
      await page.evaluate(i => { const idx = state.placed.findIndex(p => p && p.sourceId === i); selectPlaced(idx); }, id);
      const before = await page.evaluate(i => window.__ov.raw(i), id);
      await page.click('#btn-check-defects');
      await page.waitForFunction(i => window.nsoDefectsShownFor() === i && nsoFindingsState().modelId === i, id, { timeout: 60000 });
      const st = await page.evaluate(() => nsoFindingsState());
      const row = st.rows.find(x => x.kind === 'pierce') || {};
      const it = (row.items || []).find(x => x.fix === 'mergeShells');
      check('Check lists "2 overlapping shells" as a finding', /^2 overlapping shells, 74 piercing pairs/.test(row.title || ''), row.title);
      check('...with a MERGE SHELLS button, whole piece', !!it && it.fixLabel === 'MERGE SHELLS' && it.scope === 'whole piece', JSON.stringify(row.items));
      const undo0 = await page.evaluate(() => state.undoStack.length);
      await page.click('#findings-rows .findings-fix[data-fix=mergeShells]');
      await page.waitForFunction(() => { const s = nsoFindingsState(); return s.result && /Merge shells/.test(s.result.action); }, null, { timeout: 120000 });
      const after = await page.evaluate(() => ({ st: nsoFindingsState(), status: window.__ov.status(), undo: state.undoStack.length }));
      const merged = await page.evaluate(i => window.__ov.raw(i), id);
      const cl = closed(merged, 'merge-shells');
      check('MERGE SHELLS made the piece itself one closed solid', cl.ok && cl.c.verdict === 'PASS', said(cl.c));
      check('...said so, with one Undo step', /^Merge shells: box_closed’s 2 overlapping shells are one solid now/.test(after.status) && after.undo === undo0 + 1, after.status);
      check('...and the card re-read it: no overlapping shells, no MERGE SHELLS', !after.st.rows.some(x => x.items.some(i => i.fix === 'mergeShells')) &&
        /Before: 74 piercing pairs\. Now: 0\./.test(after.st.result.text), after.st.result.text);
      await page.evaluate(() => undoLast());
      const back = await page.evaluate(i => window.__ov.raw(i), id);
      check('one Undo puts the shells back byte for byte', back.length === before.length && back.every((v, i) => Object.is(v, before[i])), back.length / 9 + ' tris');
      await page.evaluate(() => { if (window.nsoDefectsShownFor() != null) window.nsoDefectsHide(); window.__ov.clear(); });
    }

    /* Each verb: a fresh plate with two copies of the box. */
    async function twoBoxes(file, dx) {
      await page.evaluate(() => window.__ov.clear());
      const a = await loadSTL(page, file), b = await loadSTL(page, file);
      await page.evaluate(([a, b, dx]) => window.__ov.stand(a, b, dx, 0), [a, b, dx == null ? 80 : dx]);
      return [a, b];
    }
    const counts = () => page.evaluate(() => ({ models: state.models.length, placed: state.placed.length, undo: state.undoStack.length }));
    /* One piece of the box on the plate, selected. */
    async function oneBox(file) {
      await page.evaluate(() => window.__ov.clear());
      const id = await loadSTL(page, file);
      await page.evaluate(id => { state.editId = id; state.selectedIndex = state.placed.findIndex(p => p && p.sourceId === id); }, id);
      return id;
    }

    /* ================================================================ 3 */
    console.log('\n=== 3a. Bridge: edge to edge, a sheet ===');
    {
      const [a, b] = await twoBoxes(BAD);
      const found = await page.evaluate(([a, b]) => {
        const xA = (p, q) => Math.abs(p[0] - 60 - window.__ov.bounds(window.__ov.up(a)).lo[0]) < 1e-3 && Math.abs(q[0] - p[0]) < 1e-3;
        const xB = (p, q) => Math.abs(p[0] - window.__ov.bounds(window.__ov.up(b)).lo[0]) < 1e-3 && Math.abs(q[0] - p[0]) < 1e-3;
        const f = window.__ov.firstPlan((pieces, x, y) => NSO_Bridge.plan(pieces, { piece: 0, target: x }, { piece: 1, target: y }, { thicknessMm: 0.9 }),
          a, b, 'edge', xA, xB);
        if (!f.a) return f;
        const B = NSO_bridgeUI();
        B.idx = {}; B.a = window.__ov.sel(a, f.a); B.b = window.__ov.sel(b, f.b);
        const p = NSO_bridgePreview();
        return { kind: p.kind, ok: p.ok, reason: p.reason, ghost: !!B.ghost };
      }, [a, b]);
      check('the preview plans a sheet on box_closed, with its ghost - no refusal', found.ok === true && found.kind === 'sheet' && found.ghost, found.reason || found.kind);
      const r = await page.evaluate(() => NSO_bridgeSet().then(r => ({ ok: r.ok, reason: r.reason, merged: r.merged, id: r.newId })));
      const ro = await page.evaluate(() => document.getElementById('bridge-readout').textContent);
      console.log('  status: ' + (await page.evaluate(() => window.__ov.status())));
      check('Set welds it into one piece and the readout names the merge', r.ok && (await counts()).models === 1 && noted(ro) && /; box_closed had 2/.test(r.merged), ro);
      if (r.ok) { const cl = closed(await page.evaluate(i => window.__ov.upArr(i), r.id), 'bridge'); check('...closed (mesh_validate)', cl.ok, said(cl.c)); }
    }

    console.log('\n=== 3b. Connect: a string, welded ===');
    {
      const [a, b] = await twoBoxes(BAD);
      const found = await page.evaluate(([a, b]) => {
        const lo = id => window.__ov.bounds(window.__ov.up(id)).lo[0], hi = id => window.__ov.bounds(window.__ov.up(id)).hi[0];
        const xA = p => Math.abs(p[0] - hi(a)) < 1e-3, xB = p => Math.abs(p[0] - lo(b)) < 1e-3;
        const f = window.__ov.firstPlan((pieces, x, y) => NSO_Connect.plan(pieces, { piece: 0, target: x }, { piece: 1, target: y }, { shape: 'string', result: 'weld' }),
          a, b, 'face', xA, xB);
        if (!f.a) return f;
        const C = NSO_connectUI();
        C.a = window.__ov.sel(a, f.a); C.b = window.__ov.sel(b, f.b);
        const p = NSO_connectPreview();
        return { ok: p.ok, reason: p.reason, result: p.result, ghost: !!C.ghost };
      }, [a, b]);
      check('the preview plans a welded string on box_closed - no refusal', found.ok === true && found.result === 'weld' && found.ghost, found.reason || JSON.stringify(found));
      const r = await page.evaluate(() => NSO_connectSet().then(r => ({ ok: r.ok, reason: r.reason, merged: r.merged, id: r.newId })));
      const ro = await page.evaluate(() => document.getElementById('connect-readout').textContent);
      console.log('  status: ' + (await page.evaluate(() => window.__ov.status())));
      check('Set welds it into one piece and the readout names the merge', r.ok && (await counts()).models === 1 && noted(ro), ro + (r.reason ? ' | ' + r.reason : ''));
      if (r.ok) { const cl = closed(await page.evaluate(i => window.__ov.upArr(i), r.id), 'connect'); check('...closed (mesh_validate)', cl.ok, said(cl.c)); }
    }

    console.log('\n=== 3c. Join ===');
    {
      const [a, b] = await twoBoxes(BAD, 60);   // touching, face to face
      await page.evaluate(([a, b]) => { state.editId = a; state.joinPartnerId = b; state.joinSession = true; }, [a, b]);
      await page.evaluate(() => joinSelectedModels());
      const st = await statusOf(page);
      console.log('  status: ' + st);
      check('Join welds box_closed through the kernel and names the merge', /^Join ok \(kernel union\)/.test(st) && noted(st) && (await counts()).models === 1, st);
      const cl = closed(await page.evaluate(i => window.__ov.upArr(i), a), 'join');
      check('...closed (mesh_validate)', cl.ok, said(cl.c));
    }

    console.log('\n=== 3d. Subtract B from A ===');
    {
      await page.evaluate(() => window.__ov.clear());
      const a = await loadSTL(page, BAD), b = await loadSTL(page, BIT);
      // the bit's corner pokes into A's far-right top corner from outside
      await page.evaluate(([a, b]) => window.__ov.stand(a, b, 60 - 3, 20 - 3), [a, b]);
      await page.evaluate(([a, b]) => { state.editId = a; state.joinPartnerId = b; }, [a, b]);
      await page.evaluate(() => subtractBFromA());
      const st = await page.evaluate(() => window.__ov.status());
      console.log('  status: ' + st);
      check('Subtract cuts box_closed and names the merge', /^Subtract ok/.test(st) && noted(st), st);
      const cl = closed(await page.evaluate(i => window.__ov.upArr(i), a), 'subtract');
      check('...closed (mesh_validate)', cl.ok, said(cl.c));
    }

    console.log('\n=== 3e. Crop (the card\'s copy) ===');
    {
      await page.evaluate(() => window.__ov.clear());
      const a = await loadSTL(page, BAD), t = await loadSTL(page, CLEAN);
      await page.evaluate(([a, t]) => window.__ov.stand(a, t, 80, 0), [a, t]);
      const orig = await page.evaluate(id => window.__ov.raw(id), a);
      const ref = await page.evaluate(id => { window.__origRaw = window.__ov.model(id).rawTris; return true; }, a);
      void ref;
      for (const mode of ['sphere', 'piece']) {
        if (mode === 'piece') await page.evaluate(([a, t]) => window.__ov.stand(a, t, 5, 5), [a, t]);   // the cutter stands over the piece
        const r = await page.evaluate(([a, t, mode]) => NSO_Crop.copy(state.models.find(x => x.id === a),
          mode === 'piece' ? { kind: 'piece', pieceId: t } : { kind: 'sphere', c: [0, 0, 0], r: 1000 }).then(r => ({ ok: r.ok, reason: r.reason, id: r.id, text: r.text })), [a, t, mode]);
        const st = await page.evaluate(() => window.__ov.status());
        console.log('  [' + mode + '] status: ' + st);
        check('Crop (' + mode + ') takes a copy of box_closed and names the merge', r.ok && noted(st) && noted(r.text), r.reason || st);
        if (r.ok) { const cl = closed(await page.evaluate(i => window.__ov.raw(i), r.id), 'crop-' + mode); check('...the copy is closed (mesh_validate)', cl.ok, said(cl.c)); }
        const now = await page.evaluate(id => ({ raw: window.__ov.raw(id), same: window.__ov.model(id).rawTris === window.__origRaw }), a);
        check('...and the original on the plate is byte-identical', now.same && now.raw.length === orig.length && now.raw.every((v, i) => Object.is(v, orig[i])), now.raw.length / 9 + ' tris');
      }
    }

    const sameCounts = async (f) => { const b = JSON.stringify(await counts()); const r = await f(); return { r, same: JSON.stringify(await counts()) === b }; };

    console.log('\n=== 3f. Extract bit ===');
    {
      const id = await oneBox(BAD);
      const orig = await page.evaluate(i => window.__ov.raw(i), id);
      await page.evaluate(() => extractBitFromSelected());
      const st = await page.evaluate(() => window.__ov.status());
      console.log('  status: ' + st);
      const made = await page.evaluate(i => state.models.filter(m => m.id !== i).map(m => m.id), id);
      check('Extract bit finds the bit in box_closed\'s cavity and names the merge', /^Extract bit ok/.test(st) && noted(st) && made.length === 1, st);
      const now = await page.evaluate(i => window.__ov.raw(i), id);
      check('...and the piece is untouched', now.length === orig.length && now.every((v, i) => Object.is(v, orig[i])));
    }

    console.log('\n=== 3g. Carve ===');
    {
      const id = await oneBox(BAD);
      const top = await page.evaluate(id => { const b = window.__ov.bounds(window.__ov.up(id)); return [(b.lo[0] + b.hi[0]) / 2, b.hi[1] - 6, b.hi[2]]; }, id);
      // world is Y up: the top of the lid, a little in from the +Y rim
      const wp = await page.evaluate(([id, top]) => [top[0], top[2], -top[1]], [id, top]);
      const r = await page.evaluate(([id, wp]) => nsoCarveAtPoint(id, wp).then(r => ({ ok: r && r.ok, reason: r && r.reason, status: r && r.status })), [id, wp]);
      const st = await page.evaluate(() => window.__ov.status());
      console.log('  status: ' + st);
      check('Carve cuts box_closed and names the merge', r.ok && noted(r.status), r.reason || st);
      if (r.ok) { const cl = closed(await page.evaluate(i => window.__ov.upArr(i), id), 'carve'); check('...closed (mesh_validate)', cl.ok, said(cl.c)); }
    }

    console.log('\n=== 3i. Attach, Reattach ===');
    {
      const id = await oneBox(BAD);
      // a real point on the lid and the face normal there, found the way the click finds them
      const hit = await page.evaluate(id => {
        const p = window.__ov.placed(id); p.mesh.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(p.mesh), c = box.getCenter(new THREE.Vector3()), r = box.getSize(new THREE.Vector3()).length();
        const hits = new THREE.Raycaster(c.clone().add(new THREE.Vector3(0, r * 2, 0)), new THREE.Vector3(0, -1, 0)).intersectObject(p.mesh, true).filter(h => h.face);
        return { point: hits[0].point.toArray(), normal: hits[0].face.normal.toArray() };
      }, id);
      await page.evaluate(() => {
        const set = (i, v) => { const el = document.getElementById(i); if (el) { if (el.type === 'checkbox') el.checked = !!v; else el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); } };
        set('sel-stock-shape', 'cylinder'); set('inp-stock-height', 16); set('inp-stock-radius', 4); set('inp-stock-wall', 3);
        set('inp-stock-waste', 0); set('inp-stock-prop', 3); set('chk-stock-match', false); set('chk-stock-oversize', false);
      });
      const a = await page.evaluate(([id, h]) => nsoAttachAt(window.__ov.placed(id), h.point, h.normal, null), [id, hit]);
      console.log('  attach: ' + String(a.reason).slice(0, 220));
      check('Attach welds a blank onto box_closed and names the merge', a.ok === true && noted(a.reason), a.reason);
      if (a.ok) { const cl = closed(await page.evaluate(i => window.__ov.raw(i), id), 'attach'); check('...closed (mesh_validate)', cl.ok, said(cl.c)); }

      /* Reattach. A flange is a long flat plate, and box_closed is too small and too hollow to seat one on (the
         cleaned box refuses it the same way: "the two pieces do not touch"). So the piece with overlapping shells is
         the clamp bar the flange came off, with a block pushed through its top - two shells crossing - and the
         flange goes back where tools/nso_wire_detach_test.js puts it, at the mirror-opposite place. */
      await page.evaluate(() => window.__ov.clear());
      const v9 = await loadSTL(page, path.join(ROOT, 'library', 'v9_mirror_factory.stl'));
      const det = await page.evaluate(v9 => nsoDetachRun(v9), v9);
      check('a flange detached from the clamp bar is on the plate for Reattach', det.ok === true, det.reason || 'ok');
      const built = await page.evaluate(id => {
        const m = window.__ov.model(id), h = m.rawTris, b = window.__ov.bounds(h);
        // a 6 mm block through the bar's back face (raw +Y), off the end of where the flange goes back (raw +Z)
        const x0 = b.lo[0] + 43.5, y0 = b.hi[1] - 3, z0 = -3;
        const v = [[x0, y0, z0], [x0 + 6, y0, z0], [x0 + 6, y0 + 6, z0], [x0, y0 + 6, z0],
                   [x0, y0, z0 + 6], [x0 + 6, y0, z0 + 6], [x0 + 6, y0 + 6, z0 + 6], [x0, y0 + 6, z0 + 6]];
        const F = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]], blk = [];
        F.forEach(f => f.forEach(i => blk.push(...v[i])));
        const both = new Float32Array(h.length + blk.length); both.set(h, 0); both.set(blk, h.length);
        NSO_sculptCommitRaw(m, both, 'sculptReplace', 'block pushed through');
        return { name: m.name, shells: nsoOverlap.shells(m.rawTris) };
      }, v9);
      check('the bar with a block pushed through it is 2 overlapping shells', built.shells === 2, JSON.stringify(built));
      const re = await page.evaluate(id => {
        const m = window.__ov.model(id), p = window.__ov.placed(id), fl = state.models.find(x => x.detached);
        const o = fl.detached.piece.frame.origin, mir = [o[0], -o[1], o[2]];
        const t = NSO_SupportAim._nearestHit([m.rawTris], mir, [0, -1, 0], 0, 20);
        const raw = [mir[0], mir[1] - t, mir[2]], f = nsoRawFrameOf(m);
        const lp = nsoLocalPointFromRaw(f, raw), ld = nsoLocalDirFromRaw([0, 1, 0]);
        p.mesh.updateMatrixWorld(true);
        const W = p.mesh.localToWorld(new THREE.Vector3(lp[0], lp[1], lp[2]));
        return nsoReattachAt(p, W.toArray(), ld, {}).then(r => ({ ok: r.ok, reason: r.reason }));
      }, v9);
      console.log('  reattach: ' + String(re.reason).slice(0, 260));
      check('Reattach seats the flange on it and names the merge', re.ok === true &&
        String(re.reason).indexOf(built.name + ' had 2 overlapping shells - merged for this operation') >= 0, re.reason);
      if (re.ok) { const cl = closed(await page.evaluate(i => window.__ov.raw(i), v9), 'reattach'); check('...closed (mesh_validate)', cl.ok, said(cl.c)); }
    }

    /* ================================================================ 4 */
    console.log('\n=== 4. unmendable: a shell that is open cannot be merged, and says so ===');
    {
      const CANNOT = /box_lid_open has 2 overlapping shells that cannot be merged into one closed solid: a shell is not closed, so there is no solid to merge/;
      await page.evaluate(() => window.__ov.clear());
      const a = await loadSTL(page, OPEN);
      const before = await counts(), raw0 = await page.evaluate(i => window.__ov.raw(i), a);
      const r = await page.evaluate(a => NSO_Crop.copy(state.models.find(x => x.id === a), { kind: 'sphere', c: [0, 0, 0], r: 1000 }).then(r => ({ ok: r.ok, reason: r.reason })), a);
      const st = await page.evaluate(() => window.__ov.status());
      console.log('  crop: ' + st);
      const raw1 = await page.evaluate(i => window.__ov.raw(i), a);
      check('Crop refuses it in words, nothing changed', r.ok === false && CANNOT.test(r.reason) && /^Crop refused - nothing changed \(/.test(st) &&
        JSON.stringify(await counts()) === JSON.stringify(before) && raw1.length === raw0.length, r.reason);
      const [ja, jb] = await twoBoxes(OPEN, 60);
      const jb0 = await counts();
      await page.evaluate(([a, b]) => { state.editId = a; state.joinPartnerId = b; state.joinSession = true; }, [ja, jb]);
      await page.evaluate(() => joinSelectedModels());
      const js = await statusOf(page);
      console.log('  join: ' + js);
      check('Join refuses it in words, A and B unchanged', /^Join refused - /.test(js) && CANNOT.test(js) && / - A and B unchanged$/.test(js) &&
        JSON.stringify(await counts()) === JSON.stringify(jb0), js);
    }

    /* ================================================================ 5 */
    console.log('\n=== 5. verbs that never needed a solid have no check at all ===');
    {
      const ALLOW = ['nso_csg.js', 'nso-helpers.js', 'nso_crop.js', 'app-join.js', 'app-bridge.js', 'app-connect.js', 'app-carve.js', 'app-assemble.js',
                     'app-detach.js', 'app-findings.js', 'app-punch.js',    // Punch: one subtract, its piece merged first (docs/PUNCH.md)
                     'nso_foam.js'];   // foamBox: a piece whose shells overlap is merged for the operation first (docs/FOAM.md section 10)
      const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
      const loaded = [...html.matchAll(/<script src="([^"?]+)/g)].map(m => m[1]).filter(f => !/^https?:/.test(f) && fs.existsSync(path.join(ROOT, f)));
      const asks = loaded.filter(f => /\bnsoOverlap\b/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
      const extra = asks.filter(f => ALLOW.indexOf(f) < 0);
      check('of the ' + loaded.length + ' scripts the page loads, only the solid verbs\' name nsoOverlap', extra.length === 0, asks.join(', ') + (extra.length ? ' | NOT ALLOWED: ' + extra.join(', ') : ''));
      const det = fs.readFileSync(path.join(ROOT, 'app-detach.js'), 'utf8');
      const detachBody = det.slice(det.indexOf('window.nsoDetachRun'), det.indexOf('/* ---------------------------------------------------------- Reattach */'));
      check('Detach (no kernel) does not ask it; only Reattach in app-detach.js does', detachBody.length > 0 && !/nsoOverlap/.test(detachBody));
      const id = await oneBox(BAD);
      const c0 = await calls();
      await page.evaluate(() => { window.__asked = 0; const s = nsoOverlap.solid, m = nsoOverlap.measureAsync; nsoOverlap.solid = function () { window.__asked++; return s.apply(this, arguments); }; nsoOverlap.measureAsync = function () { window.__asked++; return m.apply(this, arguments); }; window.__unwrap = () => { nsoOverlap.solid = s; nsoOverlap.measureAsync = m; }; });
      const d = await page.evaluate(id => nsoDetachRun(id), id);
      const asked = await page.evaluate(() => { const n = window.__asked; window.__unwrap(); return n; });
      const c1 = await calls();
      console.log('  detach: ' + d.reason);
      check('Detach on box_closed is not refused for its shells, and never asked', !refusedForShells(d.reason) && asked === 0 && c1.measure === c0.measure && c1.merge === c0.merge, d.reason);
    }

    /* ================================================================ 6 */
    console.log('\n=== 6. the user\'s big 3MF ===');
    if (!fs.existsSync(BIG3MF)) {
      console.log('  SKIPPED: no 3MF at ' + BIG3MF + ' (it is not in the repo; put it at tools/fixtures-local/boolean-vase.3mf or set NSO_BOOLEAN_3MF)');
    } else {
      await page.evaluate(() => window.__ov.clear());
      await page.setInputFiles('#file-input', BIG3MF);
      await page.waitForFunction(() => state.models.length > 0 && state.placed.some(p => p && p.mesh), null, { timeout: 600000, polling: 200 });
      let last = -1, steady = 0;
      for (let i = 0; i < 120 && steady < 6; i++) {
        await new Promise(r => setTimeout(r, 500));
        const n = await page.evaluate(() => state.models.length * 1000 + state.placed.filter(p => p && p.mesh).length);
        if (n === last) steady++; else steady = 0;
        last = n;
      }
      const big = await page.evaluate(() => { const m = state.models.reduce((a, b) => ((b.rawTris || []).length > (a.rawTris || []).length ? b : a)); return { id: m.id, name: m.name, tris: m.rawTris.length / 9 }; });
      console.log('  ' + big.name + ': ' + big.tris.toLocaleString() + ' triangles');
      const raw0 = await page.evaluate(id => { window.__bigRaw = window.__ov.model(id).rawTris; return window.__bigRaw.length; }, big.id);
      // a box over the +X wall, as bool:3mf puts it
      const t0 = Date.now();
      const r = await page.evaluate(id => {
        const p = state.placed.find(q => q.sourceId === id && q.mesh);
        const b = new THREE.Box3().setFromObject(p.mesh);
        const lo = [b.min.x, -b.max.z, b.min.y], hi = [b.max.x, -b.min.z, b.max.y];
        const h = [Math.max(6, (hi[0] - lo[0]) / 10), Math.max(6, (hi[1] - lo[1]) / 8), Math.max(6, (hi[2] - lo[2]) / 8)];
        const c = [hi[0] - h[0] * 0.6, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
        return NSO_Crop.copy(state.models.find(m => m.id === id), { kind: 'box', c: c, h: h, yaw: 0 })
          .then(r => ({ ok: r.ok, reason: r.reason, faces: r.faces, text: r.text, id: r.id }));
      }, big.id);
      console.log('  CROP took ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s: ' + (r.ok ? r.text : r.reason));
      check('CROP takes a copy of the big 3MF', r.ok && r.faces > 0, r.reason || r.faces + ' faces');
      const same = await page.evaluate(([id, n]) => window.__ov.model(id).rawTris === window.__bigRaw && window.__bigRaw.length === n, [big.id, raw0]);
      check('...and the original on the plate is untouched', same);
      if (r.ok) { const cl = closed(await page.evaluate(i => window.__ov.raw(i), r.id), 'big-crop'); check('...the copy is closed (mesh_validate)', cl.ok, said(cl.c)); }
    }

    const errs = logs.filter(l => /\[pageerror\]/.test(l));
    check('no page errors', errs.length === 0, errs.join(' | '));
  });
  console.log(fails ? '\n' + fails + ' check(s) FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
