/* End-to-end evidence for the Size card, driven through the real app.
   node tools/nso_wire_scale_test.js        exit 0 = every gate held

   Two things are being proved, and they are different claims:

   1. The dimension the user asked for is the dimension the piece has. Not
      "about 50", not "50.0 when printed with two decimals" - the STL on disk
      measures 50 to the last bit float32 can hold. That is checked by reading
      the piece's own soup back out of the page, writing it as a binary STL and
      measuring THAT file, so what is measured is the artefact, not a number the
      app computed about itself.

   2. Nothing was corrupted on the way. tools/stl_watertight_check.py is the
      canonical checker for that (docs/HANDOFF.md, "Output protocol": pass/fail
      is math, `--odd --degen`). It runs on the before file and the after file,
      and both have to come back OK. A scale that opened a seam or flattened a
      triangle would redden the after run while the before run stayed green,
      which is the negative control built into the comparison. */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, selectModel, statusOf, ROOT } = require('./nso_app_harness');
const { writeSTL } = require('./nso_stl_io');

const fx = f => path.join(ROOT, 'fixtures', f);
const CHECKER = path.join(ROOT, 'tools', 'stl_watertight_check.py');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-scale-'));

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

/* Reads the selected piece's raw soup out of the page. Array.from keeps it a
   plain JSON payload across the bridge; Float32Array on this side restores the
   exact float32 values, so no precision is invented or lost in transit. */
const soupOf = page => page.evaluate(() => {
  const m = getActiveModel();
  return { tris: Array.from(m.rawTris), size: { x: m.size.x, y: m.size.y, z: m.size.z } };
}).then(r => ({ tris: new Float32Array(r.tris), size: r.size }));

/* Bounding-box spans of a binary STL on disk, in DISPLAY axes.
   The soup is Z-up; the app shows Y-up. display X = raw X, display Y = raw Z,
   display Z = -raw Y, so a span maps X->0, Y->2, Z->1. */
function spanOfSTL(file) {
  const buf = fs.readFileSync(file);
  const n = buf.readUInt32LE(80);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let off = 84;
  for (let i = 0; i < n; i++) {
    off += 12;
    for (let v = 0; v < 3; v++) {
      for (let k = 0; k < 3; k++) {
        const c = buf.readFloatLE(off); off += 4;
        if (c < min[k]) min[k] = c;
        if (c > max[k]) max[k] = c;
      }
    }
    off += 2;
  }
  return { x: max[0] - min[0], y: max[2] - min[2], z: max[1] - min[1], tris: n };
}

/* The canonical checker, run the way docs/HANDOFF.md names it. */
function canonicalCheck(file) {
  try {
    const out = execFileSync('python3', [CHECKER, file, '--odd', '--degen'], { encoding: 'utf8' });
    return { ok: /\bOK\b/.test(out), out: out.trim() };
  } catch (e) {
    return { ok: false, out: ((e.stdout || '') + (e.stderr || '')).trim() || String(e.message) };
  }
}

/* One line of every number the checker printed, so a red run reads without
   re-running anything. */
const summarise = out => out.split('\n').map(l => l.trim()).filter(Boolean).join('; ');

/* The float32 floor on "exactly". A span is a difference of two float32
   coordinates, so the tightest it can be is about one ULP of the larger
   magnitude, doubled for the two ends. Computed from the target rather than
   hard-coded, so the same assertion holds at 5 mm and at 500 mm. */
const exactTol = mm => 4 * Math.pow(2, Math.ceil(Math.log2(mm)) - 24);

withApp(async (page, logs) => {
  console.log('\n=== 1. the card exists and is wired ===');
  const ui = await page.evaluate(() => {
    const el = i => document.getElementById(i);
    return {
      card: !!el('scale-card'),
      axisMenu: !!el('scale-axis'),
      readout: el('scale-readout') ? el('scale-readout').textContent : '',
      dim: el('btn-scale-dim') ? el('btn-scale-dim').dataset.nsoWired === '1' : false,
      fac: el('btn-scale-factor') ? el('btn-scale-factor').dataset.nsoWired === '1' : false,
      len: el('btn-scale-length') ? el('btn-scale-length').dataset.nsoWired === '1' : false,
      fit: el('btn-scale-fit') ? el('btn-scale-fit').dataset.nsoWired === '1' : false,
      api: typeof NSO_scaleSelectedModel
    };
  });
  check('#scale-card present in the DOM', ui.card);
  // The display-frame axis menu is gone: "Height" was right and "Z" was the
  // bed's depth, so a user asking for a wider ring got a taller one. The
  // solver still takes a display axis underneath (sections 2 and 8 call it
  // directly); the card offers Length, Whole, Longest and Fit to plate.
  check('the X / Height / Z axis menu is gone', !ui.axisMenu);
  check('Longest listener attached at load', ui.dim);
  check('Whole x listener attached at load', ui.fac);
  check('Length and Fit to plate listeners attached at load', ui.len && ui.fit);
  check('NSO_scaleSelectedModel reachable', ui.api === 'function', ui.api);

  console.log('\n=== 2. a real click: 80x40x20 box, height to exactly 50 mm ===');
  const id = await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
  await selectModel(page, id);
  const before = await soupOf(page);
  const beforeFile = path.join(TMP, 'before.stl');
  writeSTL(beforeFile, before.tris, 'nso scale before');
  const beforeSpan = spanOfSTL(beforeFile);
  const beforeCheck = canonicalCheck(beforeFile);
  console.log('   before  ' + JSON.stringify(beforeSpan));
  console.log('   checker ' + summarise(beforeCheck.out));
  check('the fixture is clean before the scale (canonical checker)', beforeCheck.ok,
        summarise(beforeCheck.out));

  // The per-axis target is no longer on the card; the solver underneath is
  // unchanged, so it is driven directly - the same call the old menu made.
  const TARGET = 50;
  await page.evaluate(t => NSO_scaleSelectedModel({ axis: 'y', targetMm: t }), TARGET);
  await page.waitForFunction(() => /Scale/.test(document.getElementById('status').textContent),
    null, { timeout: 30000 });

  const after = await soupOf(page);
  const afterFile = path.join(TMP, 'after.stl');
  writeSTL(afterFile, after.tris, 'nso scale after');
  const afterSpan = spanOfSTL(afterFile);
  const status1 = await statusOf(page);
  console.log('   after   ' + JSON.stringify(afterSpan));
  console.log('   status: ' + status1);

  const tol = exactTol(TARGET);
  const dy = Math.abs(afterSpan.y - TARGET);
  check('status reports a completed scale', /Scale done/.test(status1), status1);
  check('the STL on disk measures exactly ' + TARGET + ' mm tall', dy <= tol,
        afterSpan.y.toPrecision(12) + ', off by ' + dy.toExponential(2) +
        ' mm (float32 floor ' + tol.toExponential(2) + ')');
  check('the app agrees with the file', Math.abs(after.size.y - afterSpan.y) <= tol,
        after.size.y.toPrecision(12) + ' vs ' + afterSpan.y.toPrecision(12));

  console.log('\n=== 3. uniform: the other two axes moved by the same factor ===');
  const f = TARGET / beforeSpan.y;
  check('X scaled by the same factor', Math.abs(afterSpan.x - beforeSpan.x * f) <= exactTol(afterSpan.x),
        beforeSpan.x + ' * ' + f.toFixed(6) + ' = ' + (beforeSpan.x * f).toPrecision(12) +
        ', got ' + afterSpan.x.toPrecision(12));
  check('Z scaled by the same factor', Math.abs(afterSpan.z - beforeSpan.z * f) <= exactTol(afterSpan.z),
        beforeSpan.z + ' * ' + f.toFixed(6) + ' = ' + (beforeSpan.z * f).toPrecision(12) +
        ', got ' + afterSpan.z.toPrecision(12));
  check('aspect ratio held', Math.abs((afterSpan.x / afterSpan.z) - (beforeSpan.x / beforeSpan.z)) < 1e-5,
        (beforeSpan.x / beforeSpan.z).toFixed(8) + ' -> ' + (afterSpan.x / afterSpan.z).toFixed(8));

  console.log('\n=== 4. no geometry corruption (canonical checker on the result) ===');
  const afterCheck = canonicalCheck(afterFile);
  console.log('   checker ' + summarise(afterCheck.out));
  check('scaled STL passes --odd --degen', afterCheck.ok, summarise(afterCheck.out));
  check('triangle count unchanged', afterSpan.tris === beforeSpan.tris,
        beforeSpan.tris + ' -> ' + afterSpan.tris);
  const grab = (out, klabel) => {
    const m = out.match(new RegExp(klabel.replace(/[(){}\[\]|*+?.^$\\]/g, '\\$&') + '\\s+(-?\\d+)'));
    return m ? +m[1] : null;
  };
  for (const label of ['unique_edges', 'open_edges(count=1)', 'nonmanifold_edges(count>2)',
                       'odd_edges(count!=2)', 'degenerate_tris']) {
    const b = grab(beforeCheck.out, label), a = grab(afterCheck.out, label);
    check('checker ' + label + ' unchanged', b !== null && b === a, b + ' -> ' + a);
  }
  console.log('\n=== 4b. negative control: the checker and the gate both bite ===');
  // A green checker run only means something if a red one is reachable on the
  // same file, by the same command. Nudge one vertex of the scaled result far
  // enough to unstitch its two triangles and the canonical checker has to turn
  // red; if it does not, section 4's OK proves nothing.
  const tornFile = path.join(TMP, 'torn.stl');
  const torn = new Float32Array(after.tris);
  torn[0] += 1;                       // one corner of one triangle, 1 mm adrift
  writeSTL(tornFile, torn, 'nso scale torn');
  const tornCheck = canonicalCheck(tornFile);
  console.log('   checker ' + summarise(tornCheck.out));
  check('a deliberately torn copy FAILS the same checker command', tornCheck.ok === false,
        summarise(tornCheck.out));

  // Same for the app's own gate: it is what stands a corrupting scale down
  // before the piece is committed, so prove it refuses a corrupt result rather
  // than trusting that uniform scale can never produce one.
  const gate = await page.evaluate(tornArr => {
    const r = NSO_scaleGate(getActiveModel().rawTris, new Float32Array(tornArr), 1);
    return { ok: r.ok, reason: r.reason };
  }, Array.from(torn));
  check('NSO_scaleGate refuses a corrupt result', gate.ok === false, gate.reason);

  console.log('\n=== 5. volume follows the cube of the factor ===');
  const vols = await page.evaluate(() => ({ v: NSO_scaleVolume(getActiveModel().rawTris) }));
  const volB = (() => {
    let v = 0;
    const s = before.tris;
    for (let t = 0; t < s.length; t += 9) {
      v += (s[t] * (s[t+4] * s[t+8] - s[t+5] * s[t+7])
          - s[t+1] * (s[t+3] * s[t+8] - s[t+5] * s[t+6])
          + s[t+2] * (s[t+3] * s[t+7] - s[t+4] * s[t+6]));
    }
    return v / 6;
  })();
  const expected = volB * f * f * f;
  const volErr = Math.abs(vols.v / expected - 1);
  check('volume is before * factor^3', volErr < 1e-5,
        volB.toFixed(3) + ' * ' + f.toFixed(6) + '^3 = ' + expected.toFixed(3) +
        ', got ' + vols.v.toFixed(3) + ' (' + (volErr * 100).toExponential(2) + '%)');

  console.log('\n=== 6. Undo puts the piece back exactly ===');
  check('undo button enabled after scale',
        await page.evaluate(() => !document.getElementById('btn-undo').disabled));
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo/.test(document.getElementById('status').textContent),
    null, { timeout: 15000 });
  const status2 = await statusOf(page);
  const undone = await soupOf(page);
  console.log('   status: ' + status2);
  check('undo names Scale, not another bake', /Undo: Scale reverted/.test(status2), status2);
  check('soup restored bit for bit',
        undone.tris.length === before.tris.length &&
        undone.tris.every((v, i) => v === before.tris[i]));

  console.log('\n=== 7. the longest-edge target picks the longest edge ===');
  await page.evaluate(() => { document.getElementById('scale-target').value = '120'; });
  // btn-scale-dim moved into the top bar's Scale dropdown; unfold it first.
  await page.evaluate(() => { const e = document.getElementById('btn-scale-dim'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
  await page.click('#btn-scale-dim');
  await page.waitForFunction(() => /Scale done/.test(document.getElementById('status').textContent),
    null, { timeout: 30000 });
  const longSoup = await soupOf(page);
  const longFile = path.join(TMP, 'longest.stl');
  writeSTL(longFile, longSoup.tris, 'nso scale longest');
  const longSpan = spanOfSTL(longFile);
  const longest = Math.max(longSpan.x, longSpan.y, longSpan.z);
  console.log('   after   ' + JSON.stringify(longSpan));
  check('longest edge is exactly 120 mm', Math.abs(longest - 120) <= exactTol(120),
        longest.toPrecision(12));
  check('it was X that was longest, and X is what landed on 120',
        Math.abs(longSpan.x - 120) <= exactTol(120), longSpan.x.toPrecision(12));
  const longCheck = canonicalCheck(longFile);
  check('still clean after the second scale', longCheck.ok, summarise(longCheck.out));
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo: Scale reverted/.test(document.getElementById('status').textContent),
    null, { timeout: 15000 });

  console.log('\n=== 7b. the plain factor button ===');
  const facBefore = await soupOf(page);
  await page.evaluate(() => { document.getElementById('scale-factor').value = '0.5'; });
  // btn-scale-factor moved into the top bar's Scale dropdown; unfold it first.
  await page.evaluate(() => { const e = document.getElementById('btn-scale-factor'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
  await page.click('#btn-scale-factor');
  await page.waitForFunction(() => /Scale done/.test(document.getElementById('status').textContent),
    null, { timeout: 30000 });
  const facAfter = await soupOf(page);
  const facFile = path.join(TMP, 'factor.stl');
  writeSTL(facFile, facAfter.tris, 'nso scale factor');
  const facSpan = spanOfSTL(facFile);
  const facStatus = await statusOf(page);
  console.log('   after   ' + JSON.stringify(facSpan));
  console.log('   status: ' + facStatus);
  check('factor 0.5 halves every axis',
        Math.abs(facSpan.x - facBefore.size.x / 2) <= exactTol(facSpan.x) &&
        Math.abs(facSpan.y - facBefore.size.y / 2) <= exactTol(facSpan.y) &&
        Math.abs(facSpan.z - facBefore.size.z / 2) <= exactTol(facSpan.z),
        JSON.stringify(facBefore.size) + ' -> ' + JSON.stringify(facSpan));
  check('factor status does not claim a target dimension', !/asked/.test(facStatus), facStatus);
  check('factor result passes the canonical checker', canonicalCheck(facFile).ok);
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo: Scale reverted/.test(document.getElementById('status').textContent),
    null, { timeout: 15000 });

  console.log('\n=== 8. a curved mesh, scaled down: fixture_sphere_curved.stl ===');
  const id2 = await loadSTL(page, fx('fixture_sphere_curved.stl'));
  await selectModel(page, id2);
  const curvedBefore = await soupOf(page);
  const cbFile = path.join(TMP, 'curved-before.stl');
  writeSTL(cbFile, curvedBefore.tris, 'curved before');
  const cbCheck = canonicalCheck(cbFile);
  const cbSpan = spanOfSTL(cbFile);
  console.log('   before  ' + JSON.stringify(cbSpan) + '  checker ' + summarise(cbCheck.out));
  await page.evaluate(() => NSO_scaleSelectedModel({ axis: 'z', targetMm: 12.7 }));
  await page.waitForFunction(() => /Scale/.test(document.getElementById('status').textContent),
    null, { timeout: 30000 });
  const curvedAfter = await soupOf(page);
  const caFile = path.join(TMP, 'curved-after.stl');
  writeSTL(caFile, curvedAfter.tris, 'curved after');
  const caSpan = spanOfSTL(caFile);
  const caCheck = canonicalCheck(caFile);
  console.log('   after   ' + JSON.stringify(caSpan) + '  checker ' + summarise(caCheck.out));
  check('curved piece lands on exactly 12.7 mm in Z', Math.abs(caSpan.z - 12.7) <= exactTol(12.7),
        caSpan.z.toPrecision(12) + ', off by ' + Math.abs(caSpan.z - 12.7).toExponential(2) + ' mm');
  check('curved piece still passes the canonical checker', caCheck.ok, summarise(caCheck.out));
  check('curved triangle count unchanged', caSpan.tris === cbSpan.tris,
        cbSpan.tris + ' -> ' + caSpan.tris);
  for (const label of ['open_edges(count=1)', 'nonmanifold_edges(count>2)', 'degenerate_tris']) {
    const b = grab(cbCheck.out, label), a = grab(caCheck.out, label);
    check('curved ' + label + ' unchanged', b !== null && b === a, b + ' -> ' + a);
  }

  console.log('\n=== 8b. the correction pass earns its place ===');
  // f = target / span is the answer in exact arithmetic. The claim the Size
  // card makes is stronger than that - the mm on the file, after float32
  // rounding - so measure both and let the numbers decide whether the
  // correction loop is doing anything. If it ever stops helping on every
  // fixture, this section says so and the loop can go.
  const solver = await page.evaluate(() => {
    const soup = getActiveModel().rawTris;
    const span0 = NSO_scaleDisplaySpan(soup);
    const out = [];
    for (const target of [50, 12.7, 33.333, 7.1, 101.6]) {
      const naiveTris = NSO_scaleRawTris(soup, target / span0.z);
      const naive = Math.abs(NSO_scaleDisplaySpan(naiveTris).z - target);
      const r = NSO_scaleSolve(soup, 'z', target);
      out.push({ target: target, naive: naive, solved: r.errMm, passes: r.passes });
    }
    return out;
  });
  solver.forEach(r => {
    console.log('   target ' + String(r.target).padStart(7) + '  naive err ' + r.naive.toExponential(2) +
                '  solved err ' + r.solved.toExponential(2) + '  passes ' + r.passes);
    check('solved is no worse than naive at ' + r.target + ' mm', r.solved <= r.naive,
          r.naive.toExponential(2) + ' -> ' + r.solved.toExponential(2));
  });

  // On a fixture that sits at the origin the single division is already
  // optimal - the residual above is |float32(target) - target|, which no
  // factor can remove - so "same" is the expected reading there and is not
  // evidence either way. The case the loop exists for is a mesh whose
  // coordinates sit far from the origin, which is any STL exported without
  // recentring: the two ends of the span then round on a much coarser grid
  // and the first quotient misses by many ULPs. Measured over 200,000 random
  // (offset, extent, target) triples: 8,660 improved, 0 worsened, 191,340
  // unchanged, best gain 2.3e-4 mm. One of those is reproduced here.
  const farField = await page.evaluate(() => {
    const min = -4115.81741415832, max = -4087.3058481742773, target = 45.37206178970993;
    const soup = new Float32Array([min, 0, 0, max, 0, 0, max, 1, 0, min, 0, 0, max, 1, 0, min, 1, 0]);
    const span0 = NSO_scaleDisplaySpan(soup).x;
    const naive = Math.abs(NSO_scaleDisplaySpan(NSO_scaleRawTris(soup, target / span0)).x - target);
    const r = NSO_scaleSolve(soup, 'x', target);
    return { naive: naive, solved: r.errMm, passes: r.passes };
  });
  console.log('   far from origin: naive err ' + farField.naive.toExponential(2) +
              '  solved err ' + farField.solved.toExponential(2) + '  passes ' + farField.passes);
  check('on a far-from-origin mesh the correction measurably helps',
        farField.solved < farField.naive,
        farField.naive.toExponential(2) + ' -> ' + farField.solved.toExponential(2) +
        ' (' + (farField.naive / farField.solved).toFixed(1) + 'x closer)');

  console.log('\n=== 9. refusals: the piece is never left half-scaled ===');
  const refusals = await page.evaluate(() => {
    const snap = () => Array.from(getActiveModel().rawTris).join(',');
    const s0 = snap();
    const out = [];
    for (const spec of [{ axis: 'y', targetMm: 0 }, { axis: 'y', targetMm: -5 },
                        { axis: 'y', targetMm: NaN }, { axis: 'q', targetMm: 10 },
                        { factor: 0 }, { factor: -1 }, { factor: 1e6 },
                        { axis: 'y', targetMm: 0.001 }]) {
      const r = NSO_scaleSelectedModel(spec);
      out.push({ spec: JSON.stringify(spec), ok: r.ok, reason: r.reason, same: snap() === s0 });
    }
    return out;
  });
  refusals.forEach(r => {
    check('refused ' + r.spec, r.ok === false, r.reason);
    check('  piece unchanged after ' + r.spec, r.same);
  });

  console.log('\n=== 10. paint wins: a painted piece is a stand-down ===');
  await page.evaluate(() => {
    getActiveModel().faceMask = { exclude: [{ n: [0, 0, 1], d: 0, axisIdx: 2, keepMin: false, inner: false }] };
  });
  const paintRes = await page.evaluate(() => {
    const snap = Array.from(getActiveModel().rawTris).join(',');
    const r = NSO_scaleSelectedModel({ axis: 'y', targetMm: 30 });
    return { ok: r.ok, reason: r.reason, same: Array.from(getActiveModel().rawTris).join(',') === snap };
  });
  const status3 = await statusOf(page);
  console.log('   status: ' + status3);
  check('declined', paintRes.ok === false, 'reason: ' + paintRes.reason);
  check('status names the painted count', /stood down - 1 painted face/.test(status3), status3);
  check('piece is byte-for-byte unchanged', paintRes.same);

  console.log('\n=== 11. nothing else on the page broke ===');
  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));
  const missing = await page.evaluate(() => ['btn-soften', 'btn-smooth', 'btn-seal', 'btn-solidify',
    'btn-join', 'btn-mask-paint', 'btn-cut', 'btn-optimize']
    .filter(i => !document.getElementById(i)));
  check('existing buttons all still present', missing.length === 0, missing.join(','));

  console.log('\n----------------------------------------------------------');
  console.log('artefacts: ' + TMP);
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
