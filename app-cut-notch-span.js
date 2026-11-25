/* ============================================================
   Cut card, Notch: From / To.

   The notch is set by where its middle sits (the blade's slider) and how wide
   it is (Notch width). A notch meant to clear a tab is known by its ends
   instead - "from 0 to 10 up the wall" - and working that back to a middle and
   a width by hand is a sum to get wrong. From and To are the notch's two ends:
   typed, they set the slider to the middle and Notch width to the gap; the
   slider and the width moved, they follow.

   On which scale. With the blade lying flat (its plane level on the plate) the
   ends are heights up from the bottom of the piece, whichever way the slider
   happens to count (a flat blade's slider can run down from the top). Any other
   way the blade stands, they are on the slider's own scale.

   The slider steps in 0.1 mm, so the middle the ends ask for can sit off its
   grid: the slider goes to the nearest step and the notch carries the rest
   (state.cutBlade.nshift, app-cut.js cutBladeSpec), so the ends are exactly
   the numbers typed - until the slider is moved.
   ============================================================ */

/** How the slider's mm reads as From / To: { flat, toUser(mm), toMm(u) }, or null with no piece. */
function cutNotchSpanMap(m) {
  const f = m ? cutFrame(m) : null;
  if (!f) return null;
  const same = { flat: false, toUser: mm => mm, toMm: u => u };
  if (!f.mesh) return same;
  f.mesh.updateMatrixWorld(true);
  const nW = f.normal.clone().transformDirection(f.mesh.matrixWorld);
  if (Math.abs(nW.y) < 0.98) return same;
  // The plane is n.x = origin + mm in the piece's frame; its height on the plate, from the piece's bottom.
  const yAt = mm => f.normal.clone().multiplyScalar(f.origin + mm).applyMatrix4(f.mesh.matrixWorld).y;
  const bottom = new THREE.Box3().setFromObject(f.mesh).min.y;
  const y0 = yAt(0) - bottom, s = yAt(1) - yAt(0);
  if (!(Math.abs(s) > 1e-6)) return same;
  return { flat: true, toUser: mm => y0 + s * mm, toMm: u => (u - y0) / s };
}

// two places: an end typed as 1.25 reads back 1.25 (to one place it read 1.3, and typing the other end then took that)
const r1Span = v => String(Math.round(v * 100) / 100);

/** The From / To boxes read off the blade: its middle and Notch width. */
function cutNotchSpanSync() {
  if (typeof document === 'undefined') return;
  const from = document.getElementById('cut-notch-from'), to = document.getElementById('cut-notch-to');
  const label = document.getElementById('cut-notch-span-label');
  const b = state.cutBlade, m = getActiveModel();
  // Turn 90: the button shows it, and From / To - ends along the blade's travel - have nothing to say then
  const turn = document.getElementById('btn-cut-notch-turn');
  if (turn && b) turn.setAttribute('aria-pressed', b.nturn ? 'true' : 'false');
  const spanRow = from && from.closest('.cut-slide-row');
  if (spanRow && b) spanRow.hidden = !!b.nturn;
  if (!from || !to || !b || b.mode !== 'notch' || !m) return;
  const info = getCutPlaneLocal(m), map = cutNotchSpanMap(m);
  if (!info || !map) return;
  const w = NSO_Notch.sizes(b).kerf, mid = info.mm + (info.blade && info.blade.shift || 0);
  const a = map.toUser(mid - w / 2), c = map.toUser(mid + w / 2);
  if (document.activeElement !== from) from.value = r1Span(Math.min(a, c));
  if (document.activeElement !== to) to.value = r1Span(Math.max(a, c));
  const row = from.closest('.cut-slide-row');
  const what = map.flat ? 'mm up from the bottom of the piece' : 'mm on the slider\'s scale';
  if (label) label.title = 'From / to: ' + what;
  if (row) row.title = 'Where the notch starts and ends (' + what + '). Type them and the blade moves to the middle and ' +
    'Notch width becomes the gap; move the blade or the width and they follow.';
}

/** From / To typed: the blade to the middle, Notch width to the gap. -> { mm, width } or null (refused, said why). */
function cutNotchSetSpan(fromVal, toVal) {
  const m = getActiveModel(), map = cutNotchSpanMap(m);
  const a = Number(fromVal), c = Number(toVal);
  if (!map || !isFinite(a) || !isFinite(c)) return null;
  const lo = Math.min(a, c), hi = Math.max(a, c), w = Math.round((hi - lo) * 100) / 100;
  if (!(w >= NSO_Notch.MIN_KERF_MM)) {
    if (typeof setStatus === 'function') setStatus('Notch not moved: From and To are under ' + NSO_Notch.MIN_KERF_MM + ' mm apart.', true);
    cutNotchSpanSync();
    return null;
  }
  const b = cutBladeState(), want = map.toMm((lo + hi) / 2);
  b.nwidth = w;
  b.nshift = 0;
  setCutMm(want);
  const got = getCutPlaneLocal(m).mm;
  b.nshift = want - got;              // the slider's 0.1 mm step (or its stop 1 mm in from an end): the notch carries the rest
  b.nshiftAt = got;
  cutBladeRefresh();
  return { mm: getCutPlaneLocal(m).mm, width: w };
}

function cutNotchSpanWire() {
  if (typeof document === 'undefined') return;
  const from = document.getElementById('cut-notch-from'), to = document.getElementById('cut-notch-to');
  if (!from || !to || from.dataset.nsoWired === '1') return;
  from.dataset.nsoWired = '1';
  // On change (leaving the box, or Enter), not on every keystroke: half-typed, "1" of "10" would move the blade.
  const apply = () => cutNotchSetSpan(from.value, to.value);
  from.addEventListener('change', apply);
  to.addEventListener('change', apply);
  [from, to].forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } }));
  const turn = document.getElementById('btn-cut-notch-turn');
  if (turn) turn.addEventListener('click', () => cutNotchTurn());
}

/** Notch Turn 90: the width runs across the face (centred on the click) and the notch runs the face's length, or back. */
function cutNotchTurn(on) {
  const b = cutBladeState();
  b.nturn = on == null ? !b.nturn : !!on;
  cutBladeRefresh();
  return b.nturn;
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', cutNotchSpanWire);
  else cutNotchSpanWire();
}
