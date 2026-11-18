/* nso_cut_plane_drive_check.js - the Cut card's Blade row (Chop / Dice / Notch / Plane, Whole plate under them), the Plane blade, and
   a piece imported while the Cut card is open.
     node tools/nso_cut_plane_drive_check.js        exit 0 = every gate held

   WHAT IS PINNED
   - Layout: the Blade row is the first thing in the card under the Cut | Crop switch (above Hide blade); its four buttons read Chop, Dice,
     Notch, Plane; Whole plate is one thin button the full width of the card on a row of its own under them; "Rotate" sits as far from
     its wheel's rail as Mitre and Bevel do.
   - Import: a piece loaded with the Cut card open becomes the piece the cutter works on - shown, with the blade on it and Cut live
     (it used to be added to the list and never shown: nothing set the active piece, and the status line said it was).
   - Plane: it reaches 0.1 mm from either end (Chop keeps its 1 mm); the readout says which end comes off and how much; Cut takes the
     NEARER end off flat and keeps one piece, in its place, closed (no open or non-manifold edge), with the same name; Undo is one step
     per Plane and gives the length back; a mitre slants the cut face and the piece is still closed; Chop is as it was (1 mm minimum,
     two pieces). */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

function box(Lx, Wy, Hz) {
  const o = [];
  const q = (a, b, c, d) => o.push(...a, ...b, ...c, ...a, ...c, ...d);
  q([0, 0, 0], [0, Wy, 0], [Lx, Wy, 0], [Lx, 0, 0]); q([0, 0, Hz], [Lx, 0, Hz], [Lx, Wy, Hz], [0, Wy, Hz]);
  q([0, 0, 0], [Lx, 0, 0], [Lx, 0, Hz], [0, 0, Hz]); q([0, Wy, 0], [0, Wy, Hz], [Lx, Wy, Hz], [Lx, Wy, 0]);
  q([0, 0, 0], [0, 0, Hz], [0, Wy, Hz], [0, Wy, 0]); q([Lx, 0, 0], [Lx, Wy, 0], [Lx, Wy, Hz], [Lx, 0, Hz]);
  return o;
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-cut-plane-'));
function stl(name, soup) {
  const f = path.join(TMP, name), n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(f, b);
  return f;
}

const HELP = `
window.__rect = id => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; };
window.__piece = () => { const m = state.models[0]; if (!m) return null; m.geometry.computeBoundingBox();
  const s = m.geometry.boundingBox.getSize(new THREE.Vector3()), soup = displaySoupOf(m.geometry);
  let vol = 0; for (let i = 0; i + 8 < soup.length; i += 9) { const a = soup.slice(i, i + 3), b = soup.slice(i + 3, i + 6), c = soup.slice(i + 6, i + 9);
    vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6; }
  return { n: state.models.length, name: m.name, len: Math.max(s.x, s.y, s.z), size: [s.x, s.y, s.z], vol: vol, faults: cutEdgeFaults(soup), tris: soup.length / 9,
           undo: state.undoStack.length, placed: state.placed.length }; };
window.__pick = () => { const id = state.models[0].id; selectPlaced(state.placed.findIndex(p => p && p.sourceId === id)); };
window.__centre = () => { const p = state.placed[0]; return p && p.mesh ? new THREE.Box3().setFromObject(p.mesh).getCenter(new THREE.Vector3()).toArray() : null; };
`;

withApp(async (page, logs) => {
  await page.addScriptTag({ content: HELP });
  const R = id_ => page.evaluate(i => __rect(i), id_);
  const piece = () => page.evaluate(() => __piece());
  const setMm = async v => { await page.fill('#cut-mm', String(v)); await page.press('#cut-mm', 'Tab'); await page.waitForTimeout(200); };
  const cutNow = async () => { await page.click('#btn-cut'); await page.waitForTimeout(1500); };

  console.log('import with the Cut card open');
  await page.click('#menu-cut > summary');
  await page.waitForTimeout(250);
  const id = await loadSTL(page, stl('bar.stl', box(60, 14, 8)));
  await page.waitForTimeout(800);
  const imp = await page.evaluate(id_ => ({ edit: state.editId, preview: !!state.previewMesh, helper: !!state.cutHelper, cutOff: document.getElementById('btn-cut').disabled,
    readout: document.getElementById('cut-readout').textContent, mm: document.getElementById('cut-mm').value, id: id_ }), id);
  check('the imported piece is the active one, shown, with the blade on it', imp.edit === id && imp.preview && imp.helper, JSON.stringify(imp));
  check('...Cut is live and the readout reads the blade at mid-piece', imp.cutOff === false && /^RED LINE @ 30\.0 mm/.test(imp.readout) && imp.mm === '30.0', imp.readout);

  console.log('layout');
  const tog = await R('btn-cut-mode-cut'), full = await R('btn-cut-blade-full'), hide = await R('chk-cut-hide-blade'), plate = await R('btn-cut-blade-plate'), plane = await R('btn-cut-blade-plane');
  const card = await R('edit-card');
  const labels = await page.$$eval('.cut-blade-mode .btn', b => b.map(x => x.textContent.trim()));
  check('the Blade row reads Chop | Dice | Notch | Plane', labels.join('|') === 'Chop|Dice|Notch|Plane', labels.join('|'));
  check('it is at the top of the card, under the Cut | Crop switch and above Hide blade', full.y >= tog.b - 1 && full.b <= hide.y, JSON.stringify({ toggleBottom: tog.b, blade: full.y, hide: hide.y }));
  check('Whole plate is a thin button on a row of its own under the four, the full width of the row', plate.y >= full.b - 1 && plate.h < full.h * 0.8 && Math.abs(plate.x - full.x) < 2 && Math.abs(plate.r - plane.r) < 2,
    JSON.stringify({ plate: [plate.x, plate.y, plate.w, plate.h], row: [full.x, plane.r, full.h] }));
  const gaps = await page.evaluate(() => [...document.querySelectorAll('.cut-dial-label')].map(l => { const r = l.getBoundingClientRect(), w = l.parentElement.querySelector('svg').getBoundingClientRect();
    return { t: l.textContent, gap: (w.left + 52 - Math.sqrt(41.6 * 41.6 - (52 - r.height) ** 2)) - r.right }; }));
  const g = Object.fromEntries(gaps.map(x => [x.t, x.gap]));
  check('Rotate is as far from its rail as Mitre and Bevel are (within 3 px of Bevel, and not closer than Mitre by more than 4)', Math.abs(g.Rotate - g.Bevel) < 3 && g.Rotate > g.Mitre - 4, JSON.stringify(g));

  console.log('the Plane blade');
  await page.click('#btn-cut-blade-plane');
  await page.waitForTimeout(250);
  const lim = await page.evaluate(() => ({ min: document.getElementById('cut-slider').min, max: document.getElementById('cut-slider').max, pressed: document.getElementById('btn-cut-blade-plane').getAttribute('aria-pressed'),
    readout: document.getElementById('cut-readout').textContent }));
  check('Plane is pressed and the blade reaches 0.1 mm from either end (0.1 .. 59.9)', lim.pressed === 'true' && lim.min === '0.1' && lim.max === '59.9', JSON.stringify(lim));
  check('the readout says which end comes off', /^PLANE @ 30\.0 mm - takes 30\.0 mm off the low end, keeps 30\.0 mm/.test(lim.readout), lim.readout);
  await setMm(0.04);
  check('a blade typed closer than 0.1 mm to the end stands at 0.1', (await page.inputValue('#cut-mm')) === '0.1');
  await setMm(59.8);
  check('near the high end the HIGH end is the one that comes off', /takes 0\.2 mm off the high end, keeps 59\.8 mm/.test(await page.textContent('#cut-readout')), await page.textContent('#cut-readout'));

  await setMm(0.5);
  check('0.5 mm from the low end: it says it takes 0.5 off the low end', /takes 0\.5 mm off the low end, keeps 59\.5 mm/.test(await page.textContent('#cut-readout')), await page.textContent('#cut-readout'));
  const c0 = await page.evaluate(() => { const b = state.previewMesh ? new THREE.Box3().setFromObject(state.previewMesh) : null; return b ? b.getCenter(new THREE.Vector3()).toArray() : null; });
  await cutNow();
  let p = await piece();
  check('Cut keeps ONE piece, the same name, 59.5 mm long, closed', p.n === 1 && p.name === 'bar' && Math.abs(p.len - 59.5) < 0.02 && p.faults.total === 0, JSON.stringify(p));
  check('...and it is on the plate in its place (no gap opened, no second piece)', p.placed === 1, 'placed ' + p.placed);
  const c1 = await page.evaluate(() => __centre());
  check('...its middle stayed where that part of the piece was (moved by half of what came off, along the length, and no other way)',
    c0 && c1 && Math.abs(Math.hypot(c1[0] - c0[0], c1[2] - c0[2]) - 0.25) < 0.05, JSON.stringify({ before: c0, after: c1 }));
  const undo1 = p.undo;

  console.log('the other end, and Undo');
  await page.evaluate(() => __pick());
  await page.waitForTimeout(300);
  const span2 = (await page.evaluate(() => getCutPlaneLocal(getActiveModel()).span));
  await setMm((span2 - 0.3).toFixed(1));
  await cutNow();
  p = await piece();
  check('near the high end it takes the high end off: 59.5 -> 59.2 mm, still one closed piece', p.n === 1 && Math.abs(p.len - 59.2) < 0.02 && p.faults.total === 0 && p.undo === undo1 + 1, JSON.stringify(p));
  await page.click('#btn-undo'); await page.waitForTimeout(600);
  p = await piece();
  check('one Undo gives the 0.3 mm back (one step per Plane): 59.5 mm', p.n === 1 && Math.abs(p.len - 59.5) < 0.02, JSON.stringify(p));
  await page.click('#btn-undo'); await page.waitForTimeout(600);
  p = await piece();
  check('and one more gives the original back: 60 mm, closed', p.n === 1 && Math.abs(p.len - 60) < 0.02 && p.faults.total === 0, JSON.stringify(p));

  console.log('a slanted plane');
  // An Undo closes the cutter (as for every Cut); opening it again starts on Chop, so Plane is pressed again.
  await page.evaluate(() => { openCutter('cut'); __pick(); });
  await page.waitForTimeout(300);
  await page.click('#btn-cut-blade-plane'); await page.waitForTimeout(200);
  await page.fill('#cut-miter-deg', '20'); await page.press('#cut-miter-deg', 'Tab'); await page.waitForTimeout(250);
  await setMm(2);
  const rd = await page.textContent('#cut-readout');
  check('a mitred Plane says so in the readout', /^PLANE @ [\d.]+ mm - takes [\d.]+ mm off the low end.*mitre 20°/.test(rd), rd);
  await cutNow();
  p = await piece();
  check('a mitred Plane leaves one closed piece with a slanted wedge gone (6720 mm3 -> between 6000 and 6700)', p.n === 1 && p.faults.total === 0 && p.vol < 6700 && p.vol > 6000, JSON.stringify(p));
  await page.click('#btn-undo'); await page.waitForTimeout(600);

  console.log('Chop is as it was');
  await page.evaluate(() => { openCutter('cut'); __pick(); });
  await page.waitForTimeout(300);
  await page.click('#btn-cut-square'); await page.waitForTimeout(150);
  await page.click('#btn-cut-blade-full'); await page.waitForTimeout(250);
  const lim2 = await page.evaluate(() => ({ min: document.getElementById('cut-slider').min, max: document.getElementById('cut-slider').max }));
  check('Chop keeps 1 mm from each end (1 .. 59)', lim2.min === '1' && lim2.max === '59', JSON.stringify(lim2));
  await setMm(0.2);
  check('a Chop typed closer than 1 mm snaps to 1', (await page.inputValue('#cut-mm')) === '1.0');
  await setMm(20);
  await cutNow();
  p = await piece();
  check('Chop still makes two pieces', p.n === 2, JSON.stringify(p));

  check('no page errors', logs.filter(l => /pageerror|Uncaught/i.test(String(l))).length === 0, JSON.stringify(logs.slice(0, 3)));
}).then(() => {
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
});
