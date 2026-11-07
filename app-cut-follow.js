/* ============================================================
   Cut card - Follow strand (docs/CUT-FOLLOW.md). The sized blade, put square across
   a cord wherever it runs and walked along it: slice a spiral like salami.

   Click the strand: its centre line is traced (nso_strand.js), the blade is turned
   (mitre + bevel) until it stands square across the cord there, and put on it. Back /
   Forward move it one step - a slice plus the kerf - along the strand, round the bends.
   Cut cuts, then moves on to the next slice by itself, so clicking Cut is all it takes.

   The blade's place is kept in the WORLD (state.cutFollowAt: the strand's centre and
   direction there, and where the step either way lands), not as a click on a piece: a
   cut that severs the cord replaces the piece with its parts, and the next slice is on
   one of them. The marching reads every piece on the plate as one strand, so it goes
   on over the kerfs earlier cuts left. After app-cut.js, nso_strand.js.
   ============================================================ */

const CUT_FOLLOW_SLICE_DEFAULT = 1.5;
const CUT_FOLLOW_UP = [0, 1, 0];                 // the plate vertical, world

function cutFollowOn() {
  const b = state.cutBlade;
  return !!(b && b.mode === 'sized' && b.follow && typeof NSO_Strand !== 'undefined');
}

/** Slice (material left between cuts) + kerf (what the blade takes): how far one step moves the blade. */
function cutFollowStep() {
  const b = cutBladeState(), z = NSO_Notch.sizes(b);
  const slice = Number(b.slice) > 0 ? Number(b.slice) : CUT_FOLLOW_SLICE_DEFAULT;
  return { slice: slice, kerf: z.kerf, pitch: slice + z.kerf };
}

/** Every piece on the plate as one soup, world frame: the strand goes on across the gaps cuts leave and the slices
    cut off it are still part of it. */
function cutFollowWorldSoup() {
  const parts = [];
  let n = 0;
  (state.placed || []).forEach(function (p) {
    if (!p || p.sourceId == null || !p.mesh) return;
    const s = meshToWorldSoup(p.mesh);
    parts.push(s); n += s.length;
  });
  const out = new Float32Array(n);
  let o = 0;
  parts.forEach(function (s) { out.set(s, o); o += s.length; });
  return out;
}

/** The placed piece the strand is in at `c` (its section there, square to `t`, has its centre at c): an index into
    state.placed, or -1. */
function cutFollowPieceAt(c, t) {
  let best = -1, bd = 1.5;
  const d = t[0] * c[0] + t[1] * c[1] + t[2] * c[2];
  (state.placed || []).forEach(function (p, idx) {
    if (!p || p.sourceId == null || !p.mesh) return;
    const tris = NSO_Strand.near(meshToWorldSoup(p.mesh), c, 4);
    if (!tris.length) return;
    NSO_Strand.sections(tris, t, d).forEach(function (l) {
      const e = Math.hypot(l.c[0] - c[0], l.c[1] - c[1], l.c[2] - c[2]);
      if (e < bd) { bd = e; best = idx; }
    });
  });
  return best;
}

/** The cut frame's normal for a mitre and a bevel, as cutFrame builds it (kept in step with it by the drive check). */
function cutNormalFor(f, deg, bevel) {
  const turnDeg = f.base ? deg - f.base : deg;
  const n = new THREE.Vector3(f.axis === 'x' ? 1 : 0, f.axis === 'y' ? 1 : 0, f.axis === 'z' ? 1 : 0);
  let back = null;
  if (turnDeg) { back = cutTurnMatrix(f.up, -turnDeg); n.applyMatrix4(back); }
  if (bevel) { const lean = cutLeanBasis(n, f.up, f.axis, back); n.applyMatrix4(cutTurnMatrix(lean.a, bevel)); }
  return n;
}

/** Set mitre and bevel so the blade stands square to `tL` (the strand's direction, in the piece's frame, unit).
    A sweep, near the present angles first (a step along a cord turns the blade a little) and then all of them; each
    pass narrows to 0.1 degree, the grid the card keeps. -> the angle (degrees) the blade is left off square. */
function cutFollowAim(m, tL) {
  const f = cutFrame(m);
  if (!f) return null;
  const err = function (d, b) { return 1 - Math.abs(cutNormalFor(f, d, b).dot(tL)); };
  let best = { d: cutMiterDeg(), b: cutBevelDeg() }, be = err(best.d, best.b);
  const scan = function (c, dr, br, step) {
    for (let d = c.d - dr; d <= c.d + dr + 1e-9; d += step) {
      for (let b = Math.max(-90, c.b - br); b <= Math.min(90, c.b + br) + 1e-9; b += step) {
        const dd = ((Math.round(d * 10) / 10 % 360) + 360) % 360, bb = Math.round(b * 10) / 10;
        const e = err(dd, bb);
        if (e < be - 1e-12) { be = e; best = { d: dd, b: bb }; }
      }
    }
  };
  scan(best, 15, 15, 1);
  if (be > 1 - Math.cos(Math.PI / 180)) scan({ d: 180, b: 0 }, 180, 90, 2);
  scan(best, 2, 2, 0.1);
  state.cutMiterDeg = best.d;
  state.cutBevelDeg = best.b;
  return Math.acos(Math.max(-1, Math.min(1, 1 - be))) * 180 / Math.PI;
}

/** The strand's centre `c` and direction `t` (world, unit, in the sense Forward goes) found by marching `step` mm
    either way along it. Each is { c, t } or null where the strand ends. */
function cutFollowNeighbours(soup, c, t, st) {
  const opts = { up: CUT_FOLLOW_UP, gap: st.kerf + 1.5 };
  const f = NSO_Strand.advance(soup, c, t, st.pitch, opts);
  const bt = [-t[0], -t[1], -t[2]];
  const b = NSO_Strand.advance(soup, c, bt, st.pitch, opts);
  return {
    next: f && !f.end ? { c: f.c, t: f.t } : null,
    prev: b && !b.end ? { c: b.c, t: [-b.t[0], -b.t[1], -b.t[2]] } : null
  };
}

/** Put the blade square across the strand at world point `c` (running along `t`, a hint: the sense is kept). The piece the
    strand is in becomes the selected one. Returns { ok, why }. */
function cutFollowPlace(c, t, why, quiet) {
  const soup = cutFollowWorldSoup();
  const tr = NSO_Strand.traceAt(soup, c, { hint: t, up: CUT_FOLLOW_UP, within: 1.2 });
  if (!tr) return { ok: false, why: 'no strand there - already cut, or the strand has ended' };
  const idx = cutFollowPieceAt(tr.c, tr.t);
  if (idx < 0) return { ok: false, why: 'that strand is not on a piece on the plate' };
  const p = state.placed[idx];
  if (p.sourceId !== state.editId && typeof selectPlaced === 'function') selectPlaced(idx);
  const m = getActiveModel(), mesh = m ? cutMeshOf(m) : null;
  if (!m || !mesh) return { ok: false, why: 'that piece is not on the plate' };

  mesh.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
  const cL = new THREE.Vector3(tr.c[0], tr.c[1], tr.c[2]).applyMatrix4(inv);
  const topL = new THREE.Vector3(tr.top[0], tr.top[1], tr.top[2]).applyMatrix4(inv);
  const tL = new THREE.Vector3(tr.t[0], tr.t[1], tr.t[2]).transformDirection(inv);
  const upL = new THREE.Vector3(CUT_FOLLOW_UP[0], CUT_FOLLOW_UP[1], CUT_FOLLOW_UP[2]).transformDirection(inv);

  const off = cutFollowAim(m, tL);
  // The blade must reach through the cord: as wide as it is across, and in far enough from the top to clear the underside.
  const b = cutBladeState(), notes = [];
  const needD = Math.ceil((tr.h + 0.5) * 10) / 10, needW = Math.ceil((tr.w + 1) * 10) / 10;
  if (b.depth < needD) { b.depth = needD; notes.push('depth raised to ' + needD + ' mm to go through the strand'); }
  if (b.width < needW) { b.width = needW; notes.push('width raised to ' + needW + ' mm'); }
  state.cutBladeAt = { modelId: m.id, local: topL, normal: upL.clone() };
  const f = cutFrame(m);
  const want = f.normal.dot(cL) - f.origin;
  state.cutT = snapCutT(want / f.span, f.span);
  const got = cutMmAt(state.cutT, f.span);

  const st = cutFollowStep();
  const nb = cutFollowNeighbours(soup, tr.c, tr.t, st);
  state.cutFollowAt = { c: tr.c, t: tr.t, w: tr.w, h: tr.h, r: tr.r, next: nb.next, prev: nb.prev,
                        off: off, clamped: Math.abs(got - want) > 0.3 };
  cutBladeRefresh();
  cutFollowSyncUI();
  const dirSay = (b.followDir || 1) > 0 ? nb.next : nb.prev;
  const msg = (why || 'blade square across the strand') + ' (' + (Math.round(tr.w * 10) / 10) + ' mm cord, step ' +
    (Math.round(st.pitch * 10) / 10) + ' mm)' + (notes.length ? ' - ' + notes.join(', ') : '') +
    (state.cutFollowAt.clamped ? ' - too near the end of the piece to cut here' : '') +
    (!dirSay ? ' - that is the end of the strand this way' : '');
  if (!quiet) setStatus('Follow: ' + msg + '.');
  return { ok: true, msg: msg };
}

/** A click on the piece, with Follow on: trace the strand under it and put the blade there. */
function cutFollowFromHit(hit) {
  const pt = hit && hit.point ? [hit.point.x, hit.point.y, hit.point.z] : null;
  if (!pt) return;
  const tr = NSO_Strand.traceAt(cutFollowWorldSoup(), pt, { up: CUT_FOLLOW_UP });
  if (!tr) { setStatus('Follow: no strand under that click - click on the cord itself.', true); return; }
  const r = cutFollowPlace(tr.c, tr.t, 'strand found');
  if (!r.ok) setStatus('Follow: ' + r.why + '.', true);
}

/** Back (-1) / Forward (+1): one step along the strand without cutting. The way last pressed is the way Cut goes on. */
function cutFollowMove(sign) {
  const fa = state.cutFollowAt;
  cutBladeState().followDir = sign;
  if (!fa) { setStatus('Follow: click the strand first.', true); cutFollowSyncUI(); return; }
  const to = sign > 0 ? fa.next : fa.prev;
  if (!to) { setStatus('Follow: that is the end of the strand - nothing further ' + (sign > 0 ? 'forward' : 'back') + '.', true); cutFollowSyncUI(); return; }
  const r = cutFollowPlace(to.c, to.t, sign > 0 ? 'one step forward' : 'one step back');
  if (!r.ok) setStatus('Follow: ' + r.why + '.', true);
}

/** After a cut: on to the next slice, the way the last step went. Called by cutNotchAt once the cut is made and the
    parts are separated. */
function cutFollowAfterCut() {
  if (!cutFollowOn() || !state.cutFollowAt) return null;
  const sign = cutBladeState().followDir || 1, fa = state.cutFollowAt;
  const to = sign > 0 ? fa.next : fa.prev;
  if (!to) { state.cutFollowAt = null; cutFollowSyncUI(); return { done: true, text: ' - Follow: that was the last slice, the strand ends here' }; }
  const r = cutFollowPlace(to.c, to.t, 'on to the next slice', true);
  return r.ok ? { done: false, text: ' - Follow: ' + r.msg } : { done: true, text: ' - could not go on: ' + r.why };
}

/** The step or the kerf changed: where Back / Forward land changes with it. */
let cutFollowTimer = null;
function cutFollowRecompute() {
  if (!cutFollowOn() || !state.cutFollowAt) return;
  clearTimeout(cutFollowTimer);
  cutFollowTimer = setTimeout(function () {
    const fa = state.cutFollowAt;
    if (!fa || !cutFollowOn()) return;
    const nb = cutFollowNeighbours(cutFollowWorldSoup(), fa.c, fa.t, cutFollowStep());
    fa.next = nb.next; fa.prev = nb.prev;
    cutFollowSyncUI();
  }, 120);
}

function cutFollowSyncUI() {
  if (typeof document === 'undefined') return;
  const b = state.cutBlade || {};
  const on = cutFollowOn();
  const box = document.getElementById('chk-cut-follow');
  if (box) box.checked = !!b.follow;
  const fields = document.getElementById('cut-follow-fields');
  if (fields) fields.hidden = !on;
  const fa = state.cutFollowAt;
  const back = document.getElementById('btn-cut-follow-back'), fwd = document.getElementById('btn-cut-follow-fwd');
  const dir = b.followDir || 1;
  if (back) { back.disabled = !fa || !fa.prev; back.setAttribute('aria-pressed', dir < 0 ? 'true' : 'false'); }
  if (fwd) { fwd.disabled = !fa || !fa.next; fwd.setAttribute('aria-pressed', dir > 0 ? 'true' : 'false'); }
  const ro = document.getElementById('cut-follow-readout');
  if (ro) {
    const st = cutFollowStep(), r1 = v => Math.round(v * 10) / 10;
    ro.textContent = !fa
      ? 'Click the strand. Each slice is ' + r1(st.slice) + ' mm and the blade takes ' + r1(st.kerf) + ' mm: ' + r1(st.pitch) + ' mm a step.'
      : 'On the strand (' + r1(fa.w) + ' mm across). ' + r1(st.pitch) + ' mm a step; Cut goes on ' + (dir > 0 ? 'forward' : 'back') +
        (dir > 0 ? (fa.next ? '' : ' - the strand ends here') : (fa.prev ? '' : ' - the strand ends here')) + '.';
  }
}

function cutFollowWire() {
  if (typeof document === 'undefined') return;
  const box = document.getElementById('chk-cut-follow');
  if (!box || box.dataset.nsoWired === '1') return;
  box.dataset.nsoWired = '1';
  box.addEventListener('change', function () {
    const b = cutBladeState();
    b.follow = box.checked;
    if (!b.follow) state.cutFollowAt = null;
    cutBladeRefresh();
    cutFollowSyncUI();
    if (b.follow) setStatus('Follow strand on - click the strand to put the blade square across it.');
  });
  const back = document.getElementById('btn-cut-follow-back'), fwd = document.getElementById('btn-cut-follow-fwd');
  if (back) back.addEventListener('click', function () { cutFollowMove(-1); });
  if (fwd) fwd.addEventListener('click', function () { cutFollowMove(1); });
  cutFollowSyncUI();
}
