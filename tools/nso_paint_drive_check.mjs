#!/usr/bin/env node
/* Painted colours through the real app, in headless Chromium (docs/MULTICOLOR.md). npm run paint:drive
   Opens the owner's 3-colour pyramid, checks the piece keeps its paint and is drawn in the project's colours, that the overlay
   is never picked, that a clone keeps the paint, and that a piece rebuilt by a tool loses it. Writes tools/paint-out/pyramid.png. */
import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveRoot, routeCdn, mkCheck, launchOpts } from './cth-test/browser-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = mkCheck();

const served = await serveRoot();
const browser = await chromium.launch(launchOpts());
const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
routeCdn(page);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`${served.base}/index.html`, { waitUntil: 'load' });
await page.waitForFunction('window.state && window.state.ready', null, { timeout: 20000 });

const bytes = Array.from(await readFile(join(ROOT, 'fixtures/multicolor/pyramid-3colors.3mf')));
await page.evaluate((b) => handleFiles([new File([new Uint8Array(b)], 'Test_Pyramid_3_Colors_P1S_AMS.3mf')]), bytes);
await page.waitForFunction('state.models.length === 1 && state.placed.length === 1', null, { timeout: 20000 });
await page.waitForTimeout(400);

const got = await page.evaluate(() => {
  const m = state.models[0], p = state.placed[0];
  const ov = p.mesh.children.find((c) => c.userData && c.userData.nsoPaintOverlay);
  const col = ov ? ov.geometry.attributes.color.array : null;
  const colours = {};
  if (col) for (let i = 0; i < col.length; i += 9) colours[[col[i], col[i + 1], col[i + 2]].map((v) => Math.round(v * 255)).join(',')] = 1;
  return {
    paint: !!m.paint, tris: m.paint && m.paint.triangles, filaments: m.paint ? NSO_Paint.filaments(m.paint) : null,
    overlay: !!ov, leaves: ov ? ov.geometry.attributes.position.count / 3 : 0, colours: Object.keys(colours).sort(),
    helper: ov ? nsoHelpers.isHelper(ov) : null, status: document.getElementById('status') ? document.getElementById('status').textContent : ''
  };
});
check('the pyramid keeps its paint: 6 triangles, filaments 1, 2, 3', [got.paint, got.tris, JSON.stringify(got.filaments)], [true, 6, '[1,2,3]']);
check('...and is drawn in the project\'s three colours (grey, white, black), every painted leaf', [got.overlay, got.leaves, got.colours],
      [true, 8190, ['0,0,0', '142,144,137', '255,255,255']]);
check('...the overlay is a helper: never picked, exported or counted', got.helper, true);
check('...the status line says so', /painted in colour: .*3 filaments \(1, 2, 3\)/.test(got.status), true);

await mkdir(join(ROOT, 'tools/paint-out'), { recursive: true });
await page.evaluate(() => { if (typeof frameAll === 'function') frameAll(); });
await page.waitForTimeout(500);
await page.screenshot({ path: join(ROOT, 'tools/paint-out/pyramid.png') });

/* a pick on the piece lands on the piece, not on its colours */
const pick = await page.evaluate(() => {
  const p = state.placed[0];
  const rc = new THREE.Raycaster(new THREE.Vector3(p.mesh.position.x, 200, p.mesh.position.z), new THREE.Vector3(0, -1, 0));
  const hits = rc.intersectObjects(state.modelGroup.children, true);
  return hits.length ? { first: hits[0].object === p.mesh, any: hits.some((h) => h.object.userData && h.object.userData.nsoPaintOverlay) } : null;
});
check('a ray down onto the piece hits the piece and never its colours', pick, { first: true, any: false });

/* a clone keeps the paint */
const cl = await page.evaluate(async () => {
  state.selectedIndex = 0;
  cloneSelectedModel();
  await new Promise((r) => setTimeout(r, 400));
  const ov = state.placed.map((p) => !!(p.mesh && p.mesh.children.find((c) => c.userData && c.userData.nsoPaintOverlay)));
  return { n: state.models.length, paint: state.models.map((m) => !!m.paint), ov };
});
check('a clone of the piece keeps its colours, and both are drawn in them', cl, { n: 2, paint: [true, true], ov: [true, true] });

/* a piece whose triangles changed loses its paint on screen */
const lost = await page.evaluate(async () => {
  const m = state.models[0], p = state.placed.find((q) => q.sourceId === m.id);
  const g = p.mesh.geometry.clone();
  const pos = g.attributes.position.array;
  const more = new Float32Array(pos.length + 9);
  more.set(pos); more.set([0, 0, 0, 1, 0, 0, 0, 1, 0], pos.length);
  g.setAttribute('position', new THREE.BufferAttribute(more, 3));
  p.mesh.geometry = g;
  await new Promise((r) => setTimeout(r, 200));
  return !!p.mesh.children.find((c) => c.userData && c.userData.nsoPaintOverlay);
});
check('...and a piece rebuilt with other triangles shows no colours (the paint no longer lines up)', lost, false);
check('no page errors', errors, []);

await browser.close();
served.close && served.close();
process.exit(check.report() ? 1 : 0);
