/* Nest-local factory driver for ?cth=drive.
   Loads library/CTH_fixture.stl when the plate is empty, paints the six
   outer faces, Full wrap on, one Soften, grades #status.
   Pull the plug deletes this file with the rest of cth/. */

import { gradeNestSoftenStatus } from './nest-status-grade.js?v=cth14';

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function say(overlay, text, bad) {
  var el = document.getElementById('status');
  if (el) el.textContent = text;
  if (overlay && typeof overlay.setNote === 'function') overlay.setNote(text);
  var card = document.getElementById('cth-fallback');
  if (card) {
    card.textContent = text;
    card.style.borderColor = bad ? '#d2694f' : '#7dce82';
  }
  console.log('[cth-drive]', text);
}

function modelName(m) {
  return String((m && (m.name || m.fileName || m.sourceName)) || '').toLowerCase();
}

function isFixture(m) {
  var n = modelName(m);
  return n.indexOf('cth_fixture') >= 0 || n.indexOf('box_hull') >= 0;
}

function models() {
  return (window.state && window.state.models) ? window.state.models : [];
}

function placed() {
  return (window.state && window.state.placed) ? window.state.placed : [];
}

function findFixture() {
  var list = models();
  for (var i = 0; i < list.length; i++) if (isFixture(list[i])) return list[i];
  if (list.length === 1) return list[0];
  return null;
}

function loadFixture() {
  var url = 'library/' + encodeURIComponent('CTH_fixture.stl');
  return fetch(url, { cache: 'no-store' }).then(function (res) {
    if (!res.ok) throw new Error('library HTTP ' + res.status);
    return res.arrayBuffer();
  }).then(function (buf) {
    if (!buf || buf.byteLength < 84) throw new Error('empty fixture');
    if (typeof handleFiles !== 'function') throw new Error('no importer');
    handleFiles([new File([buf], 'CTH_fixture.stl', { type: 'model/stl' })]);
  });
}

function waitForFixture(ms) {
  var t0 = Date.now();
  return new Promise(function (resolve, reject) {
    function tick() {
      var m = findFixture();
      var on = placed().some(function (p) { return p && p.mesh && m && p.sourceId === m.id; });
      if (m && on) { resolve(m); return; }
      if (Date.now() - t0 > ms) { reject(new Error('fixture never landed')); return; }
      setTimeout(tick, 50);
    }
    tick();
  });
}

function selectModel(m) {
  if (!m) return;
  var list = placed();
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].sourceId === m.id && typeof selectPlaced === 'function') {
      selectPlaced(i);
      return;
    }
  }
  if (window.state) window.state.editId = m.id;
}

/* Exported so tools/cth-test drives this exact function rather than a copy of
   its maths - the copy is what let the n[0] bug sit unnoticed. */
export function paintSixOuter(m) {
  var p = placed().find(function (x) { return x && x.sourceId === m.id && x.mesh; });
  if (!p || !p.mesh || !p.mesh.geometry) throw new Error('no mesh to paint');
  if (!m.rawTris || !m.rawTris.length) throw new Error('piece has no raw soup to paint');

  /* Two boxes, each read from the thing that actually owns it.

     The wrap reads the RAW soup, so the plane offset d is measured there. The
     yellow overlay reads the DISPLAY geometry, so dispPlane is measured there.
     Deriving one from the other is what this used to do, and it cannot work:
     handleFiles runs geometry.center() on the display copy (app-core.js:740),
     so the display box is the raw box rotated AND shifted by m.centerOffset.
     A display value used as a raw plane is only ever right for a piece that
     happens to sit on the origin - which the shipped fixture does, which is
     why nothing caught it. */
  var rlo = [Infinity, Infinity, Infinity], rhi = [-Infinity, -Infinity, -Infinity];
  for (var i = 0; i + 2 < m.rawTris.length; i += 3) {
    for (var k = 0; k < 3; k++) {
      var c = m.rawTris[i + k];
      if (c < rlo[k]) rlo[k] = c;
      if (c > rhi[k]) rhi[k] = c;
    }
  }
  var pos = p.mesh.geometry.attributes.position;
  var dlo = [Infinity, Infinity, Infinity], dhi = [-Infinity, -Infinity, -Infinity];
  for (var v = 0; v < pos.count; v++) {
    var q = [pos.getX(v), pos.getY(v), pos.getZ(v)];
    for (var j = 0; j < 3; j++) {
      if (q[j] < dlo[j]) dlo[j] = q[j];
      if (q[j] > dhi[j]) dhi[j] = q[j];
    }
  }

  /* zUpToYUp is rotateX(-90): display X = raw X, display Y = raw Z, and
     display Z = raw -Y. RAW_OF names the raw axis behind each display axis;
     RAW_SIGN carries the flip on that third one, which the old code stated in
     a comment and then dropped - so the display Z MIN face was filed as the
     raw Y MIN face when it is the raw Y MAX face. */
  var RAW_OF = [0, 2, 1];
  var RAW_SIGN = [1, 1, -1];

  var snap = [];
  for (var a = 0; a < 3; a++) {
    for (var s = 0; s < 2; s++) {
      var dispSign = s ? 1 : -1;                    // which display half
      var axis = RAW_OF[a];
      var rawSign = dispSign * RAW_SIGN[a];         // the raw half it really is
      var keepMin = rawSign < 0;
      var at = keepMin ? rlo[axis] : rhi[axis];     // the raw plane, from raw
      var n = [0, 0, 0];
      n[axis] = rawSign;
      snap.push({
        n: n, d: n[axis] * at,                      // the contract: n . p = d
        axisIdx: axis, keepMin: keepMin, inner: false,
        dispAxis: a, dispSign: dispSign,
        dispPlane: dispSign < 0 ? dlo[a] : dhi[a]   // the plane, from display
      });
    }
  }
  if (typeof window.nsoMaskRestore !== 'function') throw new Error('paint API missing');
  window.nsoMaskRestore(m, snap);
  return window.nsoMaskCount ? window.nsoMaskCount(m) : snap.length;
}

function clickSoften() {
  var wrap = document.getElementById('chk-full-wrap');
  if (wrap && !wrap.checked) {
    wrap.checked = true;
    wrap.dispatchEvent(new Event('change', { bubbles: true }));
  }
  var r = document.getElementById('inp-soften-r');
  if (r) { r.value = '0.5'; r.dispatchEvent(new Event('change', { bubbles: true })); }
  var btn = document.getElementById('btn-soften');
  if (!btn) throw new Error('no Soften button');
  btn.click();
}

function statusText() {
  var el = document.getElementById('status');
  return el ? String(el.textContent || '').trim() : '';
}

/* The wrap is a promise - the wasm CSG kernel runs the union and the subtract -
   so #status reads "Wrapping N face(s), M painted out\u2026" the instant the
   press is taken and only becomes the bake line when the kernel lands. A fixed
   sleep graded that interim line and called a working bake a miss.

   Wait for the line to settle instead: poll until the status has moved off the
   text that was there before the press AND the shared rule stops saying
   'pending'. The rule is cth/nest-status-grade.js, the same module a Node test
   imports, so the driver cannot drift from it the way the old private regexes
   had already drifted - the wrapPocketsInPlace success line never contains the
   word "baked", and the old /baked/i test scored it a miss. */
async function waitForSoftenStatus(before, timeoutMs) {
  var t0 = Date.now();
  var last = null;
  for (;;) {
    var t = statusText();
    if (t && t !== before) {
      last = gradeNestSoftenStatus(t);
      if (last.result !== 'pending') return last;
    }
    if (Date.now() - t0 > timeoutMs) {
      return last && last.result === 'pending'
        ? { result: 'timeout', reason: 'still-wrapping', status: t }
        : { result: 'timeout', reason: (t && t !== before) ? 'no-verdict' : 'no-status-change', status: t };
    }
    await sleep(100);
  }
}

function verdict(g) {
  if (g.result === 'pass') return { ok: true, text: 'DRIVE PASS \u2014 ' + g.status };
  if (g.result === 'fail') return { ok: false, text: 'DRIVE FAIL (' + g.reason + ') \u2014 ' + g.status };
  if (g.result === 'timeout') {
    return { ok: false, text: 'DRIVE TIMEOUT (' + g.reason + ') \u2014 status: ' + (g.status || '(empty)') };
  }
  return { ok: false, text: 'DRIVE MISS (' + g.reason + ') \u2014 status: ' + (g.status || '(empty)') };
}

export async function mountNestDrive(opts) {
  var overlay = opts && opts.overlay;
  try {
    say(overlay, 'Drive: looking for CTH_fixture…');
    var m = findFixture();
    if (!m) {
      say(overlay, 'Drive: loading library/CTH_fixture.stl');
      await loadFixture();
      m = await waitForFixture(12000);
    }
    selectModel(m);
    await sleep(80);
    var n = paintSixOuter(m);
    say(overlay, 'Drive: painted ' + n + ' outer faces');
    await sleep(80);
    var before = statusText();
    clickSoften();
    var g = await waitForSoftenStatus(before, 30000);
    var v = verdict(g);
    say(overlay, v.text, !v.ok);
  } catch (err) {
    say(overlay, 'Drive miss — ' + (err && err.message ? err.message : String(err)), true);
  }
}

export default { mountNestDrive: mountNestDrive };
