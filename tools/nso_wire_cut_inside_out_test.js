/* Cut on an inside-out piece, driven through the real app.
   node tools/nso_wire_cut_inside_out_test.js        exit 0 = every gate held

   The headless proofs are tools/nso_cut_inside_out_test.js. This file proves
   the same on the path a person takes: real index.html, real file input, the
   real Split button (#btn-cut -> cutActiveModel), the real buttons the
   refusal offers - the one in the status line (#status-cut-right-side-out)
   and the one in the Cut panel (#btn-cut-right-side-out), both clicked with
   the mouse - and the real Undo button.

   GATES
     1. Split on an inside-out box or tube is refused as before, the piece is
        unchanged bit for bit, and both buttons offer "Turn it right-side-out,
        then cut". Clicking Split again is refused again: nothing is turned
        without the click.
     2. The click (status line, then the panel): two pieces, each closed,
        2-manifold, enclosing positive volume; their volumes add up to the
        original's absolute volume plus the kerf band each keeps; and they are
        bit for bit the halves of the same piece built right-side-out.
     3. One step on the Undo stack, and one Undo puts the original inside-out
        piece back bit for bit (raw triple, display mesh, name, size).
     4. A piece only partly inside-out (a box with an inside-out box beside
        it) is refused naming the shell, and no button is offered.
     5. The offer belongs to its piece: select another and the panel button
        goes away.
     6. library/USB_bit.stl, the inside-out piece from the person's library,
        is cut the same way. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, statusOf, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

const LABEL = 'Turn it right-side-out, then cut';
const KERF = 1.0;   // KERF_MM, app-core.js

/* ---------------- fixtures, in the file's own frame (Z up) ---------------- */
function box(x0, y0, z0, x1, y1, z1) {
  const P = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const F = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const o = [];
  for (const f of F) for (const v of f) o.push(...P[v]);
  return o;
}
const SEG = 128, R_OUT = 10, R_IN = 9, H = 8;
function tube() {
  const o = [];
  const P = (r, i, w) => { const t = 2 * Math.PI * (i % SEG) / SEG; return [r * Math.cos(t), r * Math.sin(t), w]; };
  const q = (A, B, C, D) => o.push(...A, ...B, ...C, ...A, ...C, ...D);
  for (let i = 0; i < SEG; i++) {
    q(P(R_OUT, i, 0), P(R_OUT, i + 1, 0), P(R_OUT, i + 1, H), P(R_OUT, i, H));
    q(P(R_IN, i + 1, 0), P(R_IN, i, 0), P(R_IN, i, H), P(R_IN, i + 1, H));
    q(P(R_IN, i, H), P(R_OUT, i, H), P(R_OUT, i + 1, H), P(R_IN, i + 1, H));
    q(P(R_IN, i + 1, 0), P(R_OUT, i + 1, 0), P(R_OUT, i, 0), P(R_IN, i, 0));
  }
  return o;
}
function reversed(s) {
  const o = s.slice();
  for (let t = 0; t < o.length; t += 9) for (let k = 0; k < 3; k++) { o[t + 3 + k] = s[t + 6 + k]; o[t + 6 + k] = s[t + 3 + k]; }
  return o;
}
const ANNULUS = SEG / 2 * Math.sin(2 * Math.PI / SEG) * (R_OUT * R_OUT - R_IN * R_IN);
const CASES = [
  // 20 x 12 x 10 off the origin; cut along display X, whose section is 12 x 10.
  { name: 'box', out: box(5, 3, 1, 25, 15, 11), vol: 2400, section: 120 },
  // The tube standing on its end, cut along display X through its axis: the
  // section is two thin wall strips of a 128-gon, so the kerf band is taken
  // from the right-side-out twin's cut rather than written down.
  { name: 'tube', out: tube(), vol: ANNULUS * H, section: null }
];

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-wire-cut-inside-out-'));
function writeSTL(name, soup) {
  const file = path.join(TMP, name), n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(file, b);
  return file;
}
async function load(page, file) {
  await page.evaluate(() => { if (state.cutterOpen) closeCutter(true); });
  return loadSTL(page, file);
}
const openCutter = async page => {
  await page.evaluate(() => {
    const e = document.getElementById('btn-cutter-open');
    for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
  });
  if (!(await page.evaluate(() => state.cutterOpen))) await page.click('#btn-cutter-open');
};

/* Puts the red line on piece `id` the way a click on it does, on plate axis X,
   and clicks Split with the mouse. */
async function split(page, id) {
  await openCutter(page);
  const ok = await page.evaluate(id => {
    const idx = state.placed.findIndex(p => p && p.sourceId === id);
    if (idx < 0) return false;
    selectPlaced(idx);
    state.cutAxis = 'x';
    buildCutHelper();
    return true;
  }, id);
  if (!ok) return null;
  await page.click('#btn-cut');
  return look(page, id);
}

/* What the page shows now, and the piece `id` exactly as it is stored. */
function look(page, id) {
  return page.evaluate(id => {
    const m = state.models.find(x => x.id === id);
    const panel = document.getElementById('btn-cut-right-side-out');
    const inStatus = document.getElementById('status-cut-right-side-out');
    return {
      status: document.getElementById('status').textContent,
      statusIsError: document.getElementById('status').classList.contains('error'),
      statusButton: inStatus ? inStatus.textContent : null,
      panelButton: panel && !panel.hidden && panel.offsetParent !== null ? panel.textContent : null,
      undo: state.undoStack.length,
      ids: state.models.map(x => x.id),
      piece: m ? {
        name: m.name,
        size: [m.size.x, m.size.y, m.size.z],
        raw: m.rawTris ? Array.from(new Uint8Array(m.rawTris.buffer, m.rawTris.byteOffset, m.rawTris.byteLength)) : null,
        disp: Array.from(new Uint8Array((m.geometry.index ? m.geometry.toNonIndexed() : m.geometry).attributes.position.array.buffer.slice(0)))
      } : null
    };
  }, id);
}

/* The pieces that are new since `before`, measured on their raw soup. */
function halvesSince(page, before) {
  return page.evaluate(before => state.models.filter(m => !before.includes(m.id)).map(m => {
    const s = m.rawTris;
    const T = topo(s);
    return { name: m.name, T, raw: Array.from(s) };
  }), before);
}
const tStr = T => 'bad edges ' + T.badEdge + ', bad winding ' + T.badWinding + ', dup ' + T.dupFaces +
  ', volume ' + T.volume.toFixed(3) + ' mm³';
const sameBytes = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

withApp(async (page, logs) => {
  await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, 'nso_cut_bore_measure.js'), 'utf8') });

  for (const c of CASES) {
    for (const via of ['status line', 'Cut panel']) {
      const tag = c.name + ' (' + via + ')';
      console.log('\n=== ' + tag + ': refused, offered, turned and cut, undone ===');
      // The same piece built right-side-out, cut the same way: the halves to match.
      const twinId = await load(page, writeSTL(c.name + '-out.stl', c.out));
      const twinBefore = await page.evaluate(() => state.models.map(m => m.id));
      const tw = await split(page, twinId);
      const twin = await halvesSince(page, twinBefore);
      check(tag + ': the right-side-out twin cuts as it always did', twin.length === 2, tw && tw.status);

      const id = await load(page, writeSTL(c.name + '-in.stl', reversed(c.out)));
      const start = await look(page, id);
      check(tag + ': loaded inside-out', start.piece && start.piece.raw, start.status);

      // 1. Refused, and offered.
      const r0 = await split(page, id);
      check(tag + ': Split is refused for the inside-out reason',
        /^Cut not made: the piece's faces point inward \(it is inside-out\), so a cut face cannot be wound to match them\. The piece is unchanged\./.test(r0.status) && r0.statusIsError,
        r0.status);
      check(tag + ': the status line offers "' + LABEL + '"', r0.statusButton === LABEL, String(r0.statusButton));
      check(tag + ': the Cut panel offers "' + LABEL + '"', r0.panelButton === LABEL, String(r0.panelButton));
      check(tag + ': no new pieces, nothing on Undo, the piece bit for bit as loaded',
        r0.ids.join() === start.ids.join() && r0.undo === start.undo &&
        sameBytes(r0.piece.raw, start.piece.raw) && sameBytes(r0.piece.disp, start.piece.disp));
      const again = await split(page, id);
      check(tag + ': Split again is refused again: nothing turns without the click',
        /^Cut not made: the piece's faces point inward/.test(again.status) && again.ids.join() === start.ids.join() &&
        sameBytes(again.piece.raw, start.piece.raw), again.status);

      // 2. The click.
      const before = again.ids;
      await page.click(via === 'status line' ? '#status-cut-right-side-out' : '#btn-cut-right-side-out');
      const after = await look(page, id);
      check(tag + ': the status says it was turned, then cut',
        /^Turned right-side-out \(\d+ triangles reversed\), then cut; one Undo puts the original back\. Cut @ .*\[raw\]/.test(after.status),
        after.status);
      check(tag + ': the original is replaced by two pieces', !after.piece && after.ids.length === before.length + 1,
        after.ids.length + ' pieces');
      check(tag + ': the offer is gone from the panel', after.panelButton === null);
      const halves = await halvesSince(page, before);
      halves.forEach(h => check(tag + ' ' + h.name + ': closed, 2-manifold, volume positive',
        h.T.dupFaces === 0 && h.T.badEdge === 0 && h.T.badWinding === 0 && h.T.volume > 0, tStr(h.T)));
      const sum = halves.reduce((a, h) => a + h.T.volume, 0);
      const twinSum = twin.reduce((a, h) => a + h.T.volume, 0);
      // Each piece keeps the 1 mm kerf band (the raw route), so the two add
      // up to the piece plus one band: section x kerf.
      const band = c.section != null ? c.section * KERF : twinSum - c.vol;
      check(tag + ': the pieces\' volumes add up to the original\'s absolute volume plus the kerf band',
        halves.length === 2 && Math.abs(sum - (c.vol + band)) < 1e-4 * c.vol && band > 0 && band < 0.1 * c.vol,
        sum.toFixed(3) + ' = ' + c.vol.toFixed(3) + ' + ' + band.toFixed(3) + ' (kerf band)');
      check(tag + ': the pieces are bit for bit the right-side-out twin\'s',
        halves.length === 2 && twin.length === 2 && halves.every((h, i) => sameBytes(h.raw, twin[i].raw)));
      check(tag + ': one step on Undo', after.undo === start.undo + 1,
        'undo ' + start.undo + ' -> ' + after.undo);

      // 3. One Undo.
      await page.click('#btn-undo');
      const undone = await look(page, id);
      check(tag + ': one Undo brings the original back', !!undone.piece && undone.undo === after.undo - 1, undone.status);
      if (undone.piece) {
        check(tag + ': ... bit for bit: raw triple, display mesh, name and size',
          sameBytes(undone.piece.raw, start.piece.raw) && sameBytes(undone.piece.disp, start.piece.disp) &&
          undone.piece.name === start.piece.name && undone.piece.size.join() === start.piece.size.join());
        const still = await split(page, id);
        check(tag + ': ... and it is inside-out again: Split refuses it and offers the button',
          /^Cut not made: the piece's faces point inward/.test(still.status) && still.statusButton === LABEL, still.status);
      }
    }
  }

  console.log('\n=== a piece only partly inside-out ===');
  {
    const soup = box(5, 3, 1, 25, 15, 11).concat(reversed(box(5, 20, 1, 25, 26, 11)));
    const id = await load(page, writeSTL('mixed.stl', soup));
    const start = await look(page, id);
    const r = await split(page, id);
    check('refused, naming the inside-out shell and the one that is not',
      /^Cut not made: the piece is only partly inside-out: shell 2 of 2 \(12 triangles, 20\.0 x 10\.0 x 6\.0 mm\) is inside-out, while shell 1 is not, so turning the whole piece would turn shell 1 inside-out instead; nothing was turned\. The piece is unchanged\.$/.test(r.status) && r.statusIsError,
      r.status);
    check('no button offered, in the status line or the panel', r.statusButton === null && r.panelButton === null);
    check('the piece is unchanged and nothing is on Undo',
      r.ids.join() === start.ids.join() && r.undo === start.undo && sameBytes(r.piece.raw, start.piece.raw));
  }

  console.log('\n=== the offer belongs to its piece ===');
  {
    const a = await load(page, writeSTL('a-in.stl', reversed(box(0, 0, 0, 20, 12, 10))));
    const b = await load(page, writeSTL('b-out.stl', box(0, 0, 0, 20, 12, 10)));
    const r = await split(page, a);
    check('offered for the inside-out piece', r.panelButton === LABEL, r.status);
    await page.evaluate(b => { selectPlaced(state.placed.findIndex(p => p && p.sourceId === b)); }, b);
    const other = await look(page, b);
    check('select another piece: the panel button goes away', other.panelButton === null);
    const forced = await page.evaluate(() => { cutRightSideOutClicked(); return document.getElementById('status').textContent; });
    const sb = await look(page, b);
    check('and a stale click turns nothing', /^Not turned: /.test(forced) && sb.piece && sb.ids.length === other.ids.length, forced);
  }

  console.log('\n=== library/USB_bit.stl ===');
  {
    const id = await load(page, path.join(ROOT, 'library', 'USB_bit.stl'));
    const start = await look(page, id);
    const r = await split(page, id);
    check('USB_bit: refused as inside-out, and offered', /faces point inward/.test(r.status) && r.statusButton === LABEL, r.status);
    await page.click('#status-cut-right-side-out');
    const halves = await halvesSince(page, r.ids);
    const st = await statusOf(page);
    check('USB_bit: turned and cut into two pieces', halves.length === 2 && /^Turned right-side-out/.test(st), st);
    halves.forEach(h => check('USB_bit ' + h.name + ': closed, 2-manifold, volume positive',
      h.T.dupFaces === 0 && h.T.badEdge === 0 && h.T.badWinding === 0 && h.T.volume > 0, tStr(h.T)));
    await page.click('#btn-undo');
    const back = await look(page, id);
    check('USB_bit: one Undo puts it back bit for bit', !!back.piece && sameBytes(back.piece.raw, start.piece.raw) &&
      sameBytes(back.piece.disp, start.piece.disp));
  }

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
