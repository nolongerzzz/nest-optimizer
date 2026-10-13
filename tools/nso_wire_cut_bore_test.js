/* Cut keeps a tube's bore open, driven through the real app.
   node tools/nso_wire_cut_bore_test.js        exit 0 = every gate held

   The headless proofs are tools/nso_cut_bore_test.js. This file proves the
   same thing on the path a user takes: real index.html, real file input, the
   real Split button (#btn-cut -> cutActiveModel -> splitBothSides), with the
   ring standing on its end, lying along X, lying along Z, and rolled onto its
   side with the Roll Z control so the cut runs along the piece's own Y - the
   case that used to fall back to the old engine and lid the bore. Then the
   same after the real Extend button, on a piece with no raw data, on a closed
   box with a sealed cavity, and a cut that cannot be made, which must be
   refused in the status line. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, selectModel, statusOf, openFinishMenu, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

/* Ø20 / Ø18 x 8 tube, 128 segments, bore along file axis k (0 X, 1 Y, 2 Z). */
const SEG = 128, R_OUT = 10, R_IN = 9, H = 8;
const ANNULUS = SEG / 2 * Math.sin(2 * Math.PI / SEG) * (R_OUT * R_OUT - R_IN * R_IN);   // 59.67 (59.69 for a true circle)
function ring(k) {
  const o = [];
  const place = (u, v, w) => k === 2 ? [u, v, w] : k === 0 ? [w, u, v] : [v, w, u];
  const P = (r, t, w) => place(r * Math.cos(t), r * Math.sin(t), w);
  const q = (A, B, C, D) => o.push(...A, ...B, ...C, ...A, ...C, ...D);
  for (let i = 0; i < SEG; i++) {
    const a = 2 * Math.PI * i / SEG, b = 2 * Math.PI * (i + 1) / SEG;
    q(P(R_OUT, a, 0), P(R_OUT, b, 0), P(R_OUT, b, H), P(R_OUT, a, H));
    q(P(R_IN, b, 0), P(R_IN, a, 0), P(R_IN, a, H), P(R_IN, b, H));
    q(P(R_IN, a, H), P(R_OUT, a, H), P(R_OUT, b, H), P(R_IN, b, H));
    q(P(R_IN, b, 0), P(R_OUT, b, 0), P(R_OUT, a, 0), P(R_IN, a, 0));
  }
  return o;
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-wire-cut-bore-'));
function writeSTL(name, soup) {
  const file = path.join(TMP, name), n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(file, b);
  return file;
}

/* Loads with the cutter shut, as a fresh upload lands on the plate; with the
   cutter open the app shows the new piece alone as an edit preview instead. */
async function load(page, name, soup) {
  await page.evaluate(() => { if (state.cutterOpen) closeCutter(true); });
  return loadSTL(page, writeSTL(name, soup));
}

const openCutter = async page => {
  await page.evaluate(() => {
    const e = document.getElementById('btn-cutter-open');
    for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
  });
  if (!(await page.evaluate(() => state.cutterOpen))) await page.click('#btn-cutter-open');
};

/* Puts the red line on piece `id` the way a click on it does (selectPlaced),
   optionally rolls it 90 degrees about Z first (the Roll Z control), picks the
   plate axis, then clicks Split. Returns the axis the cut ran on in the
   piece's own frame, the status line, and both halves' geometry. */
async function cutPiece(page, id, plateAxis, roll) {
  await openCutter(page);
  return page.evaluate(([id, plateAxis, roll]) => {
    const idx = state.placed.findIndex(p => p && p.sourceId === id);
    if (idx < 0) return { axis: null, status: 'piece ' + id + ' is not on the plate', models: state.models.length,
                          sourceStill: true, halves: [] };
    selectPlaced(idx);
    if (roll) { rollSelected(); selectPlaced(idx); }
    state.cutAxis = plateAxis;
    buildCutHelper();
    const info = getCutPlaneForSplit(getActiveModel());
    const before = state.models.map(m => m.id);
    document.getElementById('btn-cut').click();
    const fresh = state.models.filter(m => !before.includes(m.id));
    return {
      axis: info && info.axis,
      status: document.getElementById('status').textContent,
      models: state.models.length,
      sourceStill: state.models.some(m => m.id === id),
      halves: fresh.map(m => {
        const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry;
        return { name: m.name, raw: !!m.rawTris, pos: Array.from(g.attributes.position.array) };
      })
    };
  }, [id, plateAxis, roll]);
}

/* Both ends of a half along the cut axis are the ring's section: one the cut
   face, the other the end it already had. Each must be one open annulus. */
async function judgeHalves(page, label, r, wantEngine) {
  check(label + ': Split ran along display ' + String(r.axis).toUpperCase(), !!r.axis, r.status);
  check(label + ': status names the ' + wantEngine + ' engine', r.status.indexOf('[' + wantEngine + ']') >= 0, r.status);
  check(label + ': two pieces', r.halves.length === 2, r.halves.length + ' new piece(s)');
  const ai = { x: 0, y: 1, z: 2 }[r.axis];
  for (const h of r.halves) {
    const m = await page.evaluate(([pos, ai]) => {
      let lo = Infinity, hi = -Infinity;
      for (let i = ai; i < pos.length; i += 3) { lo = Math.min(lo, pos[i]); hi = Math.max(hi, pos[i]); }
      return { T: topo(pos), ends: [capOf(pos, ai, lo, [0, 0]), capOf(pos, ai, hi, [0, 0])] };
    }, [h.pos, ai]);
    const tag = label + ' ' + h.name;
    m.ends.forEach((c, e) => {
      check(tag + (e ? ' high' : ' low') + ' end: one open annulus, ' + c.area.toFixed(2) + ' mm²',
        Math.abs(c.area - ANNULUS) < 1e-3 * ANNULUS && c.comps === 1 && c.loops === 2 && c.chi === 0 && !c.coversProbe,
        'pieces ' + c.comps + ', loops ' + c.loops + ', chi ' + c.chi + (c.coversProbe ? ', COVERS THE BORE' : ''));
    });
    check(tag + ': no duplicate faces, every edge on exactly two faces, winding agrees',
      m.T.dupFaces === 0 && m.T.badEdge === 0 && m.T.badWinding === 0,
      'dup ' + m.T.dupFaces + ', bad edges ' + m.T.badEdge + ', bad winding ' + m.T.badWinding);
    check(tag + ': Euler characteristic 0 (a ring)', m.T.chi === 0, 'chi ' + m.T.chi);
  }
}

// Bore along file X -> display X (cut X); file Y -> display Z (cut Z);
// file Z -> display Y, which only a rolled piece is cut along.
const CASES = [
  { k: 0, plate: 'x', roll: false, want: 'x' },
  { k: 1, plate: 'z', roll: false, want: 'z' },
  { k: 2, plate: 'x', roll: true, want: 'y' }
];

withApp(async (page, logs) => {
  await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, 'nso_cut_bore_measure.js'), 'utf8') });

  console.log('\n=== 1. the ring, cut across its bore on X, Z and (rolled) Y ===');
  for (const c of CASES) {
    const id = await load(page, 'ring' + c.k + '.stl', ring(c.k));
    const r = await cutPiece(page, id, c.plate, c.roll);
    check('ring ' + c.want.toUpperCase() + ': the cut ran along display ' + c.want.toUpperCase(), r.axis === c.want, 'axis ' + r.axis);
    await judgeHalves(page, 'ring ' + c.want.toUpperCase(), r, 'raw');
  }

  console.log('\n=== 2. the ring after the real Extend button (8 -> 20 mm), on X, Z and (rolled) Y ===');
  for (const c of CASES) {
    const id = await load(page, 'ext' + c.k + '.stl', ring(c.k));
    await selectModel(page, id);
    await openFinishMenu(page);
    await page.fill('#inp-extend-mm', '20');
    await page.click('#btn-extend');
    await page.waitForFunction(() => /Extend (done|refused)|Extend needs/.test(document.getElementById('status').textContent),
      null, { timeout: 30000 });
    const st = await statusOf(page);
    check('Extend ran: ' + st, /Extend done/.test(st) && /20\.000/.test(st));
    const r = await cutPiece(page, id, c.plate, c.roll);
    check('extended ' + c.want.toUpperCase() + ': the cut ran along display ' + c.want.toUpperCase(), r.axis === c.want, 'axis ' + r.axis);
    await judgeHalves(page, 'extended ' + c.want.toUpperCase(), r, 'raw');
  }

  console.log('\n=== 3. a piece with no raw data (cut on its display mesh, same engine) ===');
  for (const c of CASES) {
    const id = await load(page, 'noraw' + c.k + '.stl', ring(c.k));
    await page.evaluate(id => {
      const m = state.models.find(x => x.id === id);
      m.rawTris = null; m.rawAxis = null; m.centerOffset = null;
    }, id);
    const r = await cutPiece(page, id, c.plate, c.roll);
    check('no-raw ' + c.want.toUpperCase() + ': the cut ran along display ' + c.want.toUpperCase(), r.axis === c.want, 'axis ' + r.axis);
    await judgeHalves(page, 'no-raw ' + c.want.toUpperCase(), r, 'display');
  }

  console.log('\n=== 4. the closed box (fixtures/box_cavity_30.stl), through its sealed cavity, on X, Z and (rolled) Y ===');
  for (const c of CASES) {
    await page.evaluate(() => { if (state.cutterOpen) closeCutter(true); });
    const id = await loadSTL(page, path.join(ROOT, 'fixtures', 'box_cavity_30.stl'));
    const r = await cutPiece(page, id, c.plate, c.roll);
    const tag = 'box ' + c.want.toUpperCase();
    check(tag + ': the cut ran along display ' + c.want.toUpperCase(), r.axis === c.want, 'axis ' + r.axis);
    check(tag + ': two pieces, raw engine', r.halves.length === 2 && r.status.indexOf('[raw]') >= 0, r.status);
    const ai = { x: 0, y: 1, z: 2 }[r.axis];
    for (const h of r.halves) {
      const m = await page.evaluate(([pos, ai]) => {
        let lo = Infinity, hi = -Infinity;
        for (let i = ai; i < pos.length; i += 3) { lo = Math.min(lo, pos[i]); hi = Math.max(hi, pos[i]); }
        return { T: topo(pos), ends: [capOf(pos, ai, lo, [0, 0]), capOf(pos, ai, hi, [0, 0])] };
      }, [h.pos, ai]);
      // One end is the cut face, the other the box's own outer face.
      const ring = m.ends.filter(e => Math.abs(e.area - 224) < 1e-3 && e.comps === 1 && e.loops === 2 && e.chi === 0 && !e.coversProbe);
      const full = m.ends.filter(e => Math.abs(e.area - 900) < 1e-3 && e.comps === 1 && e.loops === 1 && e.chi === 1);
      check(tag + ' ' + h.name + ': cut face is one open 2 mm square ring (224 mm²), the far end the 900 mm² outer face',
        ring.length === 1 && full.length === 1,
        m.ends.map(e => e.area.toFixed(2) + ' mm² / ' + e.comps + ' piece / ' + e.loops + ' loop' + (e.coversProbe ? ' / covers the centre' : '')).join('  |  '));
      check(tag + ' ' + h.name + ': no duplicate faces, every edge on exactly two faces, winding agrees, chi 2',
        m.T.dupFaces === 0 && m.T.badEdge === 0 && m.T.badWinding === 0 && m.T.chi === 2,
        'dup ' + m.T.dupFaces + ', bad edges ' + m.T.badEdge + ', bad winding ' + m.T.badWinding + ', chi ' + m.T.chi);
    }
  }

  console.log('\n=== 5. a cut that cannot be made is refused, in the status line ===');
  {
    // The ring with one outer-wall quad missing: where the plane crosses it
    // the section is open, so no cut face can close it.
    const id = await load(page, 'torn.stl', ring(2).slice(18));
    const n0 = await page.evaluate(() => state.models.length);
    const r = await cutPiece(page, id, 'x', true);
    check('Split ran along display Y', r.axis === 'y', 'axis ' + r.axis);
    check('status says the cut was not made, in plain words', /^Cut not made: /.test(r.status) &&
      /piece is unchanged/.test(r.status) && !/rawCut|branch point|clipGeometrySide/.test(r.status), r.status);
    const isErr = await page.evaluate(() => {
      const el = document.getElementById('status');
      return el.classList.contains('error') || el.classList.contains('err') || /err/i.test(el.className) || el.style.color !== '';
    });
    check('status is shown as an error', isErr);
    check('no new pieces, the torn ring is still there', r.halves.length === 0 && r.models === n0 && r.sourceStill);
  }

  const fallbacks = logs.filter(l => /falling back|fallback to display clip|clipGeometrySide/.test(l));
  check('nothing fell back to the old engine', fallbacks.length === 0, fallbacks.join(' | '));
  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
