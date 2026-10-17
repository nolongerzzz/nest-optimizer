#!/usr/bin/env node
/* Drives a big piece through the real app and records every stretch of JS the
   main thread ran, per gesture: import, first selection, 20 hovers, an orbit
   drag, opening each column card, To plate, a Cut blade appearing, arming Lift.
     node tools/nso_big_mesh_profile.js <file.3mf|file.stl> [--label before|after]
                                        [--out tools/big-mesh-out] [--quick]
   Writes <out>/profile-<label>.json and .md (the table the PR carries).
   APP_URL=http://127.0.0.1:PORT/index.html drives another tree (the baseline
   checkout) in place of this one.

   Reads two things apart, see nso_big_mesh_lib.js: the browser's Long Tasks
   (software GL included) and the JS runs inside them (the app's own time). */

const fs = require('fs');
const path = require('path');
const { withApp } = require('./nso_app_harness');
const L = require('./nso_big_mesh_lib');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const FILE = argv.find(a => !a.startsWith('--') && /\.(3mf|stl)$/i.test(a));
const LABEL = flag('--label', 'run');
const OUT = path.resolve(flag('--out', path.join(__dirname, 'big-mesh-out')));
const QUICK = argv.includes('--quick');
if (!FILE) { console.error('usage: nso_big_mesh_profile.js <file.3mf|file.stl> [--label before|after] [--out dir]'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

const COLUMN_CARDS = ['menu-measure', 'menu-align', 'menu-connect', 'menu-joins', 'menu-seat', 'menu-supports',
                      'menu-add', 'menu-bit', 'menu-shape', 'menu-paint', 'menu-surface', 'menu-sculpt', 'menu-repair'];

const pause = (page, ms) => page.waitForTimeout(ms);

(async () => {
  const results = [];
  const shots = [];
  await withApp(async (page, logs) => {
    const cdp = await L.openProfiler(page);
    await page.evaluate(L.installProjector);
    const run = async (name, fn) => {
      const r = await L.measure(page, cdp, name, fn);
      results.push(r);
      const over = r.jsRuns.length;
      const extra = r.value && r.value.answerMs != null ? '   answered ' + r.value.answerMs + ' ms' : '';
      if (extra) console.log(`  ${name.padEnd(34)}${extra}`);
      console.log(`  ${name.padEnd(34)} wall ${String(r.wallMs).padStart(6)} ms   js ${r.jsMs.toFixed(0).padStart(6)} ms   longest js ${r.maxJsMs.toFixed(0).padStart(6)} ms   runs>50 ${over}   long tasks ${r.longTasks.length} (max ${Math.max(0, ...r.longTasks)})` + (r.error ? '   ERROR ' + r.error : ''));
      return r;
    };
    const shot = async (n) => { const f = path.join(OUT, `${LABEL}-${n}.png`); await page.screenshot({ path: f }); shots.push(f); };

    console.log('\n=== ' + LABEL + ': ' + path.basename(FILE) + ' ===');

    // ---- import ----
    await run('import', async () => {
      await page.setInputFiles('#file-input', FILE);
      await page.waitForFunction(() => state.models.length > 0 && state.placed.length > 0, null, { timeout: 180000, polling: 50 });
      await pause(page, 2500);
      return page.evaluate(() => ({ tris: state.models[0].rawTris.length / 9, status: document.getElementById('status').textContent }));
    });
    const tris = results[0].value && results[0].value.tris;
    await page.evaluate(L.installProjector);
    await shot('01-imported');

    // ---- the floor: an idle frame with the piece on the plate and nothing selected ----
    await run('idle (nothing selected), 3 s', () => pause(page, 3000));

    const centre = await page.evaluate(() => { const b = window.__bm.box(0); return window.__bm.proj((b.lo[0] + b.hi[0]) / 2, (b.lo[1] + b.hi[1]) / 2, (b.lo[2] + b.hi[2]) / 2); });

    // ---- first selection: a real click on the piece ----
    await run('first selection (click)', async () => {
      await page.mouse.move(centre.x, centre.y);
      await page.mouse.down(); await page.mouse.up();
      await page.waitForFunction(() => state.selectedIndex === 0, null, { timeout: 120000, polling: 50 });
      await pause(page, 3000);
    });
    await shot('02-selected');

    // ---- 20 hovers across the piece ----
    const pts = await L.hoverPoints(page, 0, 20);
    await run('20 hovers (selected, no tool)', async () => {
      for (const p of pts) { await page.mouse.move(p.x, p.y, { steps: 2 }); await pause(page, 120); }
    });

    // ---- an orbit drag, 2 s of it, started on the empty background ----
    await run('orbit drag (2 s)', async () => {
      const rect = await page.evaluate(() => { const r = state.renderer.domElement.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; });
      const x0 = rect.l + 40, y0 = rect.t + rect.h - 40;
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      const t0 = Date.now(); let i = 0;
      while (Date.now() - t0 < 2000) { i++; await page.mouse.move(x0 + i * 6, y0 - i * 2); }
      await page.mouse.up();
      await pause(page, 600);
    });
    await shot('03-orbited');
    // back to a framing where the piece is under the pointer for the verbs below
    await page.evaluate(() => { framePlateHome(); state.controls.update(); });
    await pause(page, 1500);
    await page.evaluate(L.installProjector);

    // ---- every column card, opened on the selected piece ----
    if (!QUICK) {
      for (const id of COLUMN_CARDS) {
        await run('open card: ' + id.replace('menu-', ''), async () => {
          await page.evaluate(i => { const d = document.getElementById(i); if (d) d.open = false; }, id);
          const t0 = Date.now();
          await page.click('#' + id + ' > summary');
          /* two cards answer in a worker on the new build ("measuring..." first): wait for the answer */
          const answered = id === 'menu-supports' ? () => { const e = document.getElementById('sup-count'); return !!e && !/measuring/.test(e.textContent); }
            : id === 'menu-bit' ? () => { const e = document.getElementById('split-count'); return !!e && e.textContent !== '\u2026'; } : null;
          if (answered) await page.waitForFunction(answered, null, { timeout: 180000, polling: 100 }).catch(() => {});
          await pause(page, 1500);
          return { answerMs: Date.now() - t0 };
        });
        await page.evaluate(i => { const d = document.getElementById(i); if (d) d.open = false; }, id);
      }
    }

    // ---- To plate ----
    await run('To plate', async () => {
      await page.click('#btn-to-plate');
      await pause(page, 2500);
    });

    // ---- Cut: open the card, then drop the blade with a click ----
    const c2 = await page.evaluate(() => { const b = window.__bm.box(0); return window.__bm.proj((b.lo[0] + b.hi[0]) / 2, (b.lo[1] + b.hi[1]) / 2, (b.lo[2] + b.hi[2]) / 2); });
    await run('open card: cut', async () => {
      await page.click('#menu-cut > summary');
      await pause(page, 2200);
    });
    await run('Cut blade appears (click piece)', async () => {
      await page.mouse.move(c2.x, c2.y);
      await page.mouse.down(); await page.mouse.up();
      await pause(page, 2500);
    });
    await shot('04-cut-blade');
    await run('Cut blade: 20 hovers/drag-free moves', async () => {
      for (const p of pts) { await page.mouse.move(p.x, p.y); await pause(page, 100); }
    });
    await page.evaluate(() => { if (typeof closeCutter === 'function') closeCutter(false); const d = document.getElementById('menu-cut'); if (d) d.open = false; });
    await pause(page, 800);

    // ---- Lift: arm it, then hover ----
    await run('arm Lift', async () => {
      await page.click('#btn-lift');
      if (!(await page.evaluate(() => NSO_LIFT_PLATE.isArmed()))) await page.evaluate(() => NSO_LIFT_PLATE.setArmed(true));
      await page.waitForTimeout(1500);
      return page.evaluate(() => ({ armed: NSO_LIFT_PLATE.isArmed(), target: NSO_LIFT_PLATE.targetId(), read: !!NSO_LIFT_PLATE.detection() }));
    });
    await shot('05-lift-armed');
    await run('Lift armed: 20 hovers', async () => {
      for (const p of pts) { await page.mouse.move(p.x, p.y, { steps: 2 }); await pause(page, 120); }
    });

    console.log('\n  page errors: ' + (logs.filter(l => l.startsWith('[pageerror]')).join(' | ') || 'none'));
    results.tris = tris;
  });

  const out = { label: LABEL, file: path.basename(FILE), tris: results.tris, results };
  fs.writeFileSync(path.join(OUT, `profile-${LABEL}.json`), JSON.stringify(out, null, 1));

  // ---- the table ----
  const md = [];
  md.push(`### ${LABEL}: ${path.basename(FILE)} (${results.tris} triangles)`, '');
  md.push('| gesture | wall ms | JS ms | longest JS run ms | JS runs >50 ms | long tasks (n / max ms) | answered ms |', '|---|--:|--:|--:|--:|--:|--:|');
  for (const r of results) {
    md.push(`| ${r.name} | ${r.wallMs} | ${r.jsMs.toFixed(0)} | ${r.maxJsMs.toFixed(0)} | ${r.jsRuns.length} | ${r.longTasks.length} / ${Math.max(0, ...r.longTasks)} | ${(r.value && r.value.answerMs) || ''} |`);
  }
  md.push('', '#### what ran in each JS run over 50 ms', '');
  for (const r of results) for (const j of r.jsRuns) {
    md.push(`- **${r.name}** @ +${j.startMs.toFixed(0)} ms, **${j.ms.toFixed(0)} ms** - ` +
            j.incl.slice(0, 4).map(([k, ms]) => `${k} ${ms.toFixed(0)}`).join(' > ') +
            ' | self: ' + j.self.slice(0, 2).map(([k, ms]) => `${k} ${ms.toFixed(0)}`).join(', '));
  }
  fs.writeFileSync(path.join(OUT, `profile-${LABEL}.md`), md.join('\n') + '\n');
  console.log('\nwrote ' + path.join(OUT, `profile-${LABEL}.json`));
})().catch(e => { console.error('PROFILE FAIL', e); process.exit(1); });
