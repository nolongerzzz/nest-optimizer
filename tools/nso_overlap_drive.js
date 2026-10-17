#!/usr/bin/env node
/* The overlap guard (nso-helpers.js, nsoOverlap), driven through the real app:
   real index.html, real script tags, every verb that hands a piece to the
   boolean kernel asked with library/box_closed.stl (a tray and a lid slab laid
   over each other: 74 piercing pairs) and again with the same box run through
   tools/nso_fixture_union.mjs (one solid, 0 pairs).
     node tools/nso_overlap_drive.js          exit 0 = every gate held
     npm run overlap:drive

   1. the check itself: 74 pairs for box_closed, 0 for the cleaned box, counted
      once per piece (the checker is not asked again for the same soup), and
      the sentence names the piece and the remedy
   2. Check & Repair does not merge overlapping shells (the reason the sentence
      points at nso_fixture_union and not at Repair)
   3. each verb, box_closed refused in the one sentence and nothing changed,
      the cleaned box accepted:
        Bridge (sheet), Connect (weld), Join, Subtract B from A,
        Crop Circle, Crop Piece
      Close and Extract bit are not in the list: neither calls the kernel
      (nso_close.js closes with its own lid; Extract bit reads a voxel grid). */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, statusOf } = require('./nso_app_harness');
const L = require('./nso_bridge_testlib.js');

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
// A copy under its own name, so the piece the sentence names is not the fixture's.
const BAD = path.join(TMP, 'box_closed.stl');
fs.copyFileSync(BAD_SRC, BAD);
const BIT = L.writeSTL(path.join(TMP, 'bit.stl'), L.box(0, 0, 0, 10, 10, 10));

const SENTENCE = /^box_closed has overlapping shells \((\d+) piercing pairs?\); clean it with tools\/nso_fixture_union first$/;
const mentions = s => /has overlapping shells/.test(s || '');

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
    clear() { document.getElementById('btn-clear').click(); },
    status() { const e = document.getElementById('status'); return e ? e.textContent : ''; }
  };
}

(async () => {
  await withApp(async (page, logs) => {
    await page.evaluate(installHelpers);

    /* ================================================================ 1 */
    console.log('\n=== 1. the check: counted once per piece, the sentence names the piece and the remedy ===');
    {
      const bad = await loadSTL(page, BAD), good = await loadSTL(page, CLEAN);
      const r = await page.evaluate(([bad, good]) => {
        const mb = window.__ov.model(bad), mg = window.__ov.model(good);
        let calls = 0; const real = NSO_Repair._selfIntersectionDetail;
        NSO_Repair._selfIntersectionDetail = function () { calls++; return real.apply(this, arguments); };
        const first = nsoOverlap.pairs(mb.rawTris), again = nsoOverlap.pairs(mb.rawTris), clean = nsoOverlap.pairs(mg.rawTris);
        const callsAfter = calls;
        nsoOverlap.refusalOfModels([mb, mg]);
        NSO_Repair._selfIntersectionDetail = real;
        // a bar with a mark standing on its face: two shells in contact, not overlap
        const bx = (x0, y0, z0, x1, y1, z1) => { const v = [[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]], F = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]], o = []; F.forEach(f => f.forEach(i => o.push(...v[i]))); return o; };
        const marked = new Float32Array(bx(0,0,0,60,10,6).concat(bx(50,7,6,58,10,9)));
        const touching = { pierce: NSO_Repair.inspect(marked).selfIntersections, asked: nsoOverlap.pairs(marked) };
        return { touching, first, again, clean, callsAfter, callsTotal: calls, say: nsoOverlap.refusalOfModels([mg, mb]), none: nsoOverlap.refusalOfModels([mg]),
                 unknown: nsoOverlap.refusal([{ name: 'x', soup: null }]), repairMerges: nsoOverlap.repairMerges };
      }, [bad, good]);
      check('box_closed is 74 piercing pairs, the cleaned box 0', r.first === 74 && r.clean === 0, r.first + ' / ' + r.clean);
      check('the checker ran once per piece, however often asked (3 calls on 2 soups = 2 runs)', r.again === 74 && r.callsAfter === 2 && r.callsTotal === 2,
        'calls ' + r.callsAfter + ' then ' + r.callsTotal);
      check('the sentence names the piece, the count and the remedy', SENTENCE.test(r.say) && /\(74 piercing pairs\)/.test(r.say), r.say);
      check('shells that only touch (a mark standing on a bar: the checker counts ' + r.touching.pierce + ' pairs) are not overlap, not refused', r.touching.pierce > 0 && r.touching.asked === 0, JSON.stringify(r.touching));
      check('a clean piece, and a piece that cannot be asked, are not refused', r.none === '' && r.unknown === '', JSON.stringify([r.none, r.unknown]));
      check('Repair does not merge them, so the sentence says nso_fixture_union', r.repairMerges === false && /nso_fixture_union/.test(r.say));
      await page.evaluate(() => window.__ov.clear());
    }

    /* ================================================================ 2 */
    console.log('\n=== 2. Check & Repair does not merge overlapping shells ===');
    {
      const bad = await loadSTL(page, BAD);
      const r = await page.evaluate(id => {
        const m = window.__ov.model(id), before = NSO_Repair.inspect(m.rawTris).selfIntersections;
        const out = NSO_Repair.commit(m.rawTris, {});
        return { before, after: NSO_Repair.inspect(out.rawTris).selfIntersections, applied: out.report.applied, reason: out.report.reason, tris: [m.rawTris.length / 9, out.rawTris.length / 9] };
      }, bad);
      check('Repair leaves every piercing pair: "' + r.reason + '", ' + r.before + ' -> ' + r.after, r.before === 74 && r.after === 74 && !r.applied, JSON.stringify(r.tris));
      await page.evaluate(() => window.__ov.clear());
    }

    /* Each verb: a fresh plate with two copies of the box 10 mm apart. */
    async function twoBoxes(file) {
      await page.evaluate(() => window.__ov.clear());
      const a = await loadSTL(page, file), b = await loadSTL(page, file);
      // B stands 20 mm further along X than A's far side would be if they touched.
      await page.evaluate(([a, b]) => window.__ov.stand(a, b, 80, 0), [a, b]);
      return [a, b];
    }
    const counts = () => page.evaluate(() => ({ models: state.models.length, placed: state.placed.length, undo: state.undoStack.length }));

    /* ================================================================ 3 */
    console.log('\n=== 3a. Bridge: edge to edge, a sheet ===');
    for (const [label, file] of [['box_closed', BAD], ['the cleaned box', CLEAN]]) {
      const [a, b] = await twoBoxes(file);
      const found = await page.evaluate(([a, b]) => {
        const xA = (p, q) => Math.abs(p[0] - 60 - window.__ov.bounds(window.__ov.up(a)).lo[0]) < 1e-3 && Math.abs(q[0] - p[0]) < 1e-3;
        const xB = (p, q) => Math.abs(p[0] - window.__ov.bounds(window.__ov.up(b)).lo[0]) < 1e-3 && Math.abs(q[0] - p[0]) < 1e-3;
        const f = window.__ov.firstPlan((pieces, x, y) => NSO_Bridge.plan(pieces, { piece: 0, target: x }, { piece: 1, target: y }, { thicknessMm: 0.9 }),
          a, b, 'edge', xA, xB);
        if (!f.a) return f;
        const B = NSO_bridgeUI();
        B.idx = {}; B.a = window.__ov.sel(a, f.a); B.b = window.__ov.sel(b, f.b);
        const p = NSO_bridgePreview();
        return { kind: p.kind, ok: p.ok, reason: p.reason, ghost: !!B.ghost, setOff: !!(document.getElementById('btn-bridge-go') || {}).disabled };
      }, [a, b]);
      console.log('  [' + label + '] preview:', JSON.stringify(found));
      if (label === 'box_closed') {
        check('the preview refuses in words: no plan, no ghost', found.ok === false && SENTENCE.test(found.reason) && !found.ghost, found.reason);
        const before = await counts();
        const r = await page.evaluate(() => NSO_bridgeSet());
        check('Set refuses too, with the same sentence, and nothing changes', r.ok === false && SENTENCE.test(r.reason) &&
          JSON.stringify(await counts()) === JSON.stringify(before), r.reason);
      } else {
        check('the cleaned box plans a sheet', found.ok === true && found.kind === 'sheet', found.reason || found.kind);
        const r = await page.evaluate(() => NSO_bridgeSet());
        check('...and Set welds it into one piece', r.ok === true && (await counts()).models === 1, r.reason || 'ok');
      }
    }

    console.log('\n=== 3b. Connect: a string, welded ===');
    for (const [label, file] of [['box_closed', BAD], ['the cleaned box', CLEAN]]) {
      const [a, b] = await twoBoxes(file);
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
      console.log('  [' + label + '] preview:', JSON.stringify(found));
      if (label === 'box_closed') {
        check('the preview refuses in words: no plan, no ghost', found.ok === false && SENTENCE.test(found.reason) && !found.ghost, found.reason || JSON.stringify(found));
        const before = await counts();
        const r = await page.evaluate(() => NSO_connectSet());
        check('Set refuses too, with the same sentence, and nothing changes', r.ok === false && SENTENCE.test(r.reason) &&
          JSON.stringify(await counts()) === JSON.stringify(before), r.reason);
      } else {
        check('the cleaned box plans a welded string', found.ok === true && found.result === 'weld', found.reason || JSON.stringify(found));
        const r = await page.evaluate(() => NSO_connectSet());
        check('...and Set welds it into one piece', r.ok === true && (await counts()).models === 1, r.reason || 'ok');
      }
    }

    console.log('\n=== 3c. Join ===');
    for (const [label, file] of [['box_closed', BAD], ['the cleaned box', CLEAN]]) {
      const [a, b] = await twoBoxes(file);
      await page.evaluate(([a, b]) => window.__ov.stand(a, b, 60, 0), [a, b]);   // touching, face to face
      await page.evaluate(([a, b]) => { state.editId = a; state.joinPartnerId = b; state.joinSession = true; }, [a, b]);
      const before = await counts();
      await page.evaluate(() => joinSelectedModels());
      const st = await statusOf(page), after = await counts();
      console.log('  [' + label + '] status:', st);
      if (label === 'box_closed') {
        check('Join refuses in the one sentence, A and B unchanged', /^Join refused - box_closed has overlapping shells \(74 piercing pairs\); clean it with tools\/nso_fixture_union first - A and B unchanged$/.test(st) &&
          JSON.stringify(after) === JSON.stringify(before), st);
      } else {
        check('the cleaned box is not refused for its shells', !mentions(st), st);
      }
    }

    console.log('\n=== 3d. Subtract B from A ===');
    for (const [label, file] of [['box_closed', BAD], ['the cleaned box', CLEAN]]) {
      await page.evaluate(() => window.__ov.clear());
      const a = await loadSTL(page, file), b = await loadSTL(page, BIT);
      // the bit's corner pokes into A's far-right top corner from outside
      await page.evaluate(([a, b]) => {
        const A = window.__ov.bounds(window.__ov.up(a));
        window.__ov.stand(a, b, 60 - 3, 20 - 3);
        void A;
      }, [a, b]);
      await page.evaluate(([a, b]) => { state.editId = a; state.joinPartnerId = b; }, [a, b]);
      const before = await counts();
      await page.evaluate(() => subtractBFromA());
      const st = await page.evaluate(() => window.__ov.status());
      const after = await counts();
      console.log('  [' + label + '] status:', st);
      if (label === 'box_closed') {
        check('Subtract refuses in the one sentence, A and B unchanged', /^Subtract refused - box_closed has overlapping shells \(74 piercing pairs\); clean it with tools\/nso_fixture_union first - A and B unchanged$/.test(st) &&
          JSON.stringify(after) === JSON.stringify(before), st);
      } else {
        check('the cleaned box is not refused for its shells', !mentions(st), st);
      }
    }

    console.log('\n=== 3e. Crop Circle and Crop Piece ===');
    for (const [label, file] of [['box_closed', BAD], ['the cleaned box', CLEAN]]) {
      await page.evaluate(() => window.__ov.clear());
      const a = await loadSTL(page, file), t = await loadSTL(page, CLEAN);
      await page.evaluate(([a, t]) => window.__ov.stand(a, t, 80, 0), [a, t]);
      for (const mode of ['circle', 'piece']) {
        await page.evaluate(([a, t, mode]) => {
          state.editId = a;
          const sh = NSO_cropShapeState();
          sh.mode = mode; sh.keep = 'inside'; sh.templateId = mode === 'piece' ? t : null; sh.grow = 0;
          if (mode === 'piece') {   // the template stands over the piece, so its outline cuts it
            window.__ov.stand(a, t, 5, 5);
          }
        }, [a, t, mode]);
        const before = await page.evaluate(id => window.__ov.model(id).rawTris.length, a);
        const r = await page.evaluate(() => NSO_cropShapeSelectedModel());
        const st = await page.evaluate(() => window.__ov.status());
        const after = await page.evaluate(id => window.__ov.model(id).rawTris.length, a);
        console.log('  [' + label + ' ' + mode + '] status:', st);
        if (label === 'box_closed') {
          check('Crop ' + mode + ' refuses in the one sentence, the piece unchanged', r.ok === false && SENTENCE.test(r.reason) && before === after &&
            /^Crop refused - piece unchanged \(box_closed has overlapping shells/.test(st), st);
        } else {
          check('the cleaned box is not refused for its shells (Crop ' + mode + ')', !mentions(st) && !mentions(r.reason), st);
        }
      }
    }

    const errs = logs.filter(l => /\[pageerror\]/.test(l));
    check('no page errors', errs.length === 0, errs.join(' | '));
  });
  console.log(fails ? '\n' + fails + ' check(s) FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
