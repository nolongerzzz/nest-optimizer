// ===================== Text: the card =====================
// The geometry is nso_text.js (headless, tools/nso_text_test.js); this file is
// the card on it, the left bar's TEXT, between Shape and Paint. docs/TEXT.md.
//
// The menu IS the card: open it and a click on a face of a piece places the
// text there, laid on the face. The card's numbers shape it:
//   text     what to stamp; Enter starts a line
//   Font     Sans · Serif · Mono · Heavy · Script, or a font file loaded with
//            "Font file" (read in the page, sent nowhere); Bold, Italic
//   Size     the height of a capital letter, mm
//   Depth    mm below the surface, square to it - the same all over a curved face
//   Angle    degrees, counter-clockwise seen from outside; 0 reads along the
//            face's longest edge
//   Mirror   read backwards (a stamp, a mould)
// and STAMP or Cancel.
//
// The page makes the picture and the engine does the rest: a canvas draws the
// lines in the font (the page's own text renderer knows every font the machine
// has) at about 16 px a mm, its alpha goes to NSO_Text.shape, which traces the
// letters' outlines, and NSO_Text.plan lays them on the face under the click.
//
// While the card is open:
//   - a GHOST of the engraving sits in the piece, drawn through it: the very
//     cutter STAMP subtracts, amber, its floor outlined. A refusal draws it in
//     red and says why (runs off the face; the wall under it is too thin, and
//     how deep would fit); STAMP is off;
//   - DRAG the text to move it across the face (a press inside its box, 0.1 mm
//     steps, 0.5 with Shift off); the arrows nudge it 1 mm (0.1 with Shift), the
//     way the arrow points on screen. Escape puts a drag back; with none, it
//     closes the card. A press on a piece elsewhere moves the text there; a
//     press on the bare plate still orbits.
//
// STAMP subtracts the cutter in ONE boolean (NSO_subtractSoups, so a big piece
// goes to the boolean worker, docs/BOOLEAN-WORKER.md) and commits through the
// sculpt commit, undo type 'textReplace': one Undo puts the piece back. If it
// runs longer than 300 ms the #226 bar sweeps under the readout (NSO_BoolBusy).
// The card stays open for the next face; the fields stay.
//
// REMOVE (the Stamp | Remove switch at the top of the card): the pointer is the tool. NSO_Resurface.scan
// reads the box round the first point once and numbers every piece of work in it (engraving, trench,
// recess, hole); the pointer over one lights it (amber), a click locks it (green), more clicks add, a click on
// a locked one lets it go, Escape lets go of all. "Whole word" (on) takes the pieces within Reach mm of the
// one under the pointer too. REMOVE lays the skin again over what is green (NSO_Resurface.apply: mesh
// surgery, no boolean), one Undo (textReplace). It needs no memory of the stamp, so it works on text
// stamped last week, after other edits, on a flat face or a curved one, on a scan full of splinters.
// Drag and the arrows are the stamp's, off here. docs/RESURFACE.md.
//
// PAINT SCOPE: WHOLE-PIECE. Per the scoping rule in docs/HANDOFF.md: the text
// is cut through whatever faces it meets, curved ones too, and paint names its
// faces by axis and side - so any paint stands it down, naming the count:
// nsoMaskCount(m) is the whole test.

var TEXT_GHOST_COLOR = 0xf59e0b;        // Punch's ghost
var TEXT_LINE_COLOR = 0xffc83d;         // its outline
var TEXT_FILL_COLOR = 0x34d399;         // what REMOVE would put back
var TEXT_BAD_COLOR = 0xf87171;          // what a refusal would have cut
var TEXT_RENDER_ORDER = 20;
var TEXT_STEP_MM = 0.1;                 // a drag's step
var TEXT_KEY_MM = 1;                    // an arrow key
var TEXT_FINE_MM = 0.1;                 // either, with Shift
var TEXT_BAR_MS = 300;                  // a STAMP this slow shows the bar
var TEXT_PPM = 16;                      // pixels a mm in the picture of the letters
var TEXT_MAX_PX = 4096;                 // and no side of it longer than this
var TEXT_MIN_PPM = 4;                   // coarser than this and the letters are not worth tracing
var TEXT_DEBOUNCE_MS = 90;

var TEXT_FONTS = {
  sans:   { css: '"Helvetica Neue", Helvetica, Arial, "Liberation Sans", "DejaVu Sans", sans-serif' },
  serif:  { css: 'Georgia, "Times New Roman", "Liberation Serif", "DejaVu Serif", serif' },
  mono:   { css: '"Courier New", Courier, "Liberation Mono", "DejaVu Sans Mono", monospace' },
  heavy:  { css: 'Impact, "Arial Black", Haettenschweiler, "DejaVu Sans", sans-serif', bold: true },
  script: { css: '"Brush Script MT", "Segoe Script", "Snell Roundhand", "Lucida Handwriting", cursive' }
};

function NSO_textUI() {
  if (typeof state === 'undefined') return {};
  if (!state.text) {
    state.text = { open: false, modelId: null, soup: null, hit: null, plan: null, key: '', shape: null, shapeKey: '', mask: null,
                   ghost: null, raf: 0, timer: 0, drag: null, hover: false, said: null, busy: false, fonts: {}, fontCount: 0, mode: 'stamp' };
  }
  return state.text;
}
function NSO_textEl(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }
function NSO_textModel() {
  var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
  return (m && m.rawTris && m.rawAxis === 'zup') ? m : null;
}
function NSO_textMeshOf(m) {
  if (!m || typeof state === 'undefined') return null;
  var p = (state.placed || []).find(function (q) { return q && q.sourceId === m.id && q.mesh; });
  return p ? p.mesh : null;
}
// Raw (z up) <-> the piece's display frame: (x, z, -y) - centerOffset.
function NSO_textRawToDisplay(m, p) {
  var o = m.centerOffset || { x: 0, y: 0, z: 0 };
  return [p[0] - o.x, p[2] - o.y, -p[1] - o.z];
}
function NSO_textDisplayToRaw(m, d) {
  var o = m.centerOffset || { x: 0, y: 0, z: 0 };
  return [d.x + o.x, -(d.z + o.z), d.y + o.y];
}
function NSO_textFmt(v) { return (Math.round(v * 10) / 10).toFixed(1); }

/* ---------------------------------------------------------------- the card */

function NSO_textNum(id) { var el = NSO_textEl(id); return el && el.value !== '' ? +el.value : NaN; }
function NSO_textPressed(id) { var b = NSO_textEl(id); return !!(b && b.getAttribute('aria-pressed') === 'true'); }
/* The card's numbers as NSO_Text.plan opts. */
function NSO_textOpts() {
  var mir = NSO_textEl('chk-text-mirror');
  return { depth: NSO_textNum('inp-text-depth'), angle: NSO_textNum('inp-text-angle'), mirror: !!(mir && mir.checked) };
}
/* What the picture is made of; the same spec, the same picture. */
function NSO_textSpec() {
  var sel = NSO_textEl('sel-text-font'), ta = NSO_textEl('inp-text');
  return { text: ta ? ta.value : '', font: sel ? sel.value : 'sans', bold: NSO_textPressed('btn-text-bold'),
           italic: NSO_textPressed('btn-text-italic'), sizeMm: NSO_textNum('inp-text-size') };
}
function NSO_textFontOf(key) {
  var B = NSO_textUI();
  return TEXT_FONTS[key] || (B.fonts && B.fonts[key]) || TEXT_FONTS.sans;
}

function NSO_textReadout(text, bad) {
  var el = NSO_textEl('text-readout');
  if (el) { el.textContent = text; el.classList.toggle('is-bad', !!bad); }
  NSO_textUI().said = { text: text, bad: !!bad };
}
function NSO_textSyncButtons() {
  var B = NSO_textUI(), go = NSO_textEl('btn-text-go'), rm = NSO_textEl('btn-text-remove'), ok = !B.busy && !!(B.plan && B.plan.ok);
  if (go) go.disabled = !ok || B.mode !== 'stamp';
  if (rm) rm.disabled = !ok || B.mode !== 'remove';
}
/* Stamp | Remove. */
function NSO_textSetMode(mode) {
  var B = NSO_textUI();
  if (B.mode === mode) return;
  if (B.drag) NSO_textDragEnd(false);
  B.mode = mode;
  B.hit = null; B.plan = null; B.key = '';
  if (B.rm) { if (B.rm.timer) clearTimeout(B.rm.timer); B.rm = null; }
  NSO_textClearGhost();
  var card = NSO_textEl('text-card');
  if (card) card.classList.toggle('is-remove', mode === 'remove');
  [['btn-text-mode-stamp', 'stamp'], ['btn-text-mode-remove', 'remove']].forEach(function (p) {
    var b = NSO_textEl(p[0]);
    if (b) b.setAttribute('aria-pressed', p[1] === mode ? 'true' : 'false');
  });
  NSO_textPreview();
  if (typeof setStatus === 'function') {
    setStatus(mode === 'remove' ? 'Text remove - move over an engraved letter, click to lock it, click more to add, then REMOVE. Escape clears, then closes.'
                                : 'Text open - type the text, then click a face to place it. Close the menu or press Escape to stop.');
  }
}

/* ------------------------------------------------------- the picture */

/* The text drawn in its font on a canvas as alpha: { w, h, data, mmPerPx }, or
   { error }. Capital letters stand `sizeMm` high; lines are 1.2 em apart; the
   lines are centred on each other (the engine centres the whole on its ink). */
function NSO_textMask(spec) {
  if (typeof document === 'undefined') return { error: 'there is no page to draw the text on' };
  var lines = String(spec.text || '').replace(/\r/g, '').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length || !lines.some(function (l) { return l.trim(); })) return { error: 'empty' };
  if (!(spec.sizeMm >= 0.5 && spec.sizeMm <= 500)) return { error: 'the size needs a number between 0.5 and 500 mm' };
  var F = NSO_textFontOf(spec.font), REF = 200;
  function fontStr(px) { return (spec.italic ? 'italic ' : '') + ((spec.bold || F.bold) ? 'bold ' : '') + px + 'px ' + F.css; }
  var cv = document.createElement('canvas'), ctx = cv.getContext('2d');
  if (!ctx) return { error: 'the page cannot draw the text' };
  ctx.font = fontStr(REF);
  var capRef = ctx.measureText('H').actualBoundingBoxAscent || REF * 0.72, wRef = 0;
  lines.forEach(function (l) { wRef = Math.max(wRef, ctx.measureText(l).width); });
  var emMm = spec.sizeMm * REF / capRef;
  var wMm = wRef / REF * emMm, hMm = (1.2 * lines.length + 0.4) * emMm;
  var ppm = TEXT_PPM;
  while ((wMm * ppm + 0.8 * emMm * ppm > TEXT_MAX_PX || hMm * ppm > TEXT_MAX_PX) && ppm > TEXT_MIN_PPM) ppm *= 0.9;
  if (wMm * ppm + 0.8 * emMm * ppm > TEXT_MAX_PX || hMm * ppm > TEXT_MAX_PX) return { error: 'that much text is too big to draw (' + NSO_textFmt(wMm) + ' mm wide)' };
  var px = emMm * ppm, pad = Math.ceil(0.4 * px) + 4;
  cv.width = Math.ceil(wMm * ppm + 2 * pad);
  cv.height = Math.ceil(hMm * ppm + 2 * pad);
  ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.font = fontStr(px);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  lines.forEach(function (l, i) { ctx.fillText(l, cv.width / 2, pad + px * (1.0 + 1.2 * i)); });
  var img = ctx.getImageData(0, 0, cv.width, cv.height), a = new Uint8Array(cv.width * cv.height);
  for (var k = 0; k < a.length; k++) a[k] = img.data[4 * k + 3];
  return { w: cv.width, h: cv.height, data: a, mmPerPx: 1 / ppm };
}
/* The shape of the current spec, kept until the spec changes. */
function NSO_textShape() {
  var B = NSO_textUI(), spec = NSO_textSpec(), key = JSON.stringify(spec);
  if (B.shape && B.shapeKey === key) return B.shape;
  var mask = NSO_textMask(spec), sh;
  if (mask.error) sh = { ok: false, reason: mask.error === 'empty' ? 'Type the text to stamp.' : mask.error, empty: mask.error === 'empty' };
  else {
    try { sh = NSO_Text.shape(mask); }
    catch (err) { sh = { ok: false, reason: (err && err.message) || String(err) }; }
  }
  B.shape = sh; B.shapeKey = key;
  return sh;
}

/* --------------------------------------------------------------- the plan */

// Run the engine on the current click and numbers; draw the ghost, say what it is.
function NSO_textPreview() {
  var B = NSO_textUI(), m = NSO_textModel();
  if (!B.open) return null;
  if (B.mode === 'remove') return NSO_textPreviewRemove(m);
  var sh = NSO_textShape();
  function nothing(msg, bad) {
    B.plan = null; B.key = '';
    NSO_textClearGhost();
    NSO_textReadout(msg, bad);
    NSO_textSyncButtons();
    return null;
  }
  if (!sh.ok) return nothing(sh.empty ? sh.reason : 'Text: ' + sh.reason, !sh.empty);
  var size = NSO_textFmt(sh.width) + ' × ' + NSO_textFmt(sh.height) + ' mm';
  if (!m || !B.hit || B.modelId !== m.id) {
    return nothing(m ? 'The text is ' + size + ' - click a face of the piece to place it.' : 'The text is ' + size + ' - click a face of a piece to place it.');
  }
  var o = NSO_textOpts(), key = m.id + '|' + JSON.stringify(B.hit) + '|' + B.shapeKey + '|' + JSON.stringify(o);
  if (B.key === key && B.soup === m.rawTris && B.plan) { NSO_textSyncButtons(); return B.plan; }
  var pl;
  try { pl = NSO_Text.plan(m.rawTris, B.hit, sh, o); }
  catch (err) { pl = { ok: false, reason: (err && err.message) || String(err) }; }
  B.plan = pl; B.key = key; B.soup = m.rawTris;
  NSO_textDraw(m);
  if (pl.ok) NSO_textReadout(pl.reason);
  else NSO_textReadout('Text: ' + pl.reason, true);
  NSO_textSyncButtons();
  return pl;
}
/* REMOVE: the piece's pieces of work, hovered, picked, filled. A scan of the box round the first point
   (NSO_Resurface.scan) finds every engraving, trench and recess in it, each a piece of work with its own number;
   the pointer over one highlights it (amber), a click locks it (green), more clicks add more, a click on a
   locked one lets it go. With Whole word, a click or a hover takes the pieces within Reach of it too. REMOVE fills
   what is green. */
var TEXT_BOX_MM = 22;                   // half the box one scan reads (a word up to ~40 mm from a click at its end)
function NSO_textRm() {
  var B = NSO_textUI();
  if (!B.rm) B.rm = { soup: null, modelId: null, scan: null, sel: [], hover: [], plan: null, tris: null, timer: 0, pend: null };
  return B.rm;
}
function NSO_textRmReset(say) {
  var B = NSO_textUI(), R = B.rm;
  if (R && R.timer) clearTimeout(R.timer);
  B.rm = null; B.plan = null; B.key = '';
  NSO_textClearGhost();
  if (say !== false) NSO_textReadout(NSO_textRmHint());
  NSO_textSyncButtons();
}
function NSO_textRmHint() {
  return NSO_textModel() ? 'Move over an engraved letter to see what will be filled; click it to lock it, click more to add. REMOVE fills the green.'
                         : 'Select a piece, then move over an engraved letter to see what will be filled.';
}
function NSO_textRemoveOpts() {
  var w = NSO_textEl('chk-text-word'), r = NSO_textNum('inp-text-reach');
  return { word: !w || !!w.checked, reach: r >= 0 ? r : 3 };
}
// The scan that covers raw point `pt` (a hit: { point, normal, view }), reading the box again when it does not.
function NSO_textRmEnsure(m, hit) {
  var R = NSO_textRm(), sc = R.scan;
  if (sc && R.soup === m.rawTris && R.modelId === m.id) {
    var fr = sc.frame, w = [hit.point[0] - fr.o[0], hit.point[1] - fr.o[1], hit.point[2] - fr.o[2]];
    var x = w[0] * fr.e1[0] + w[1] * fr.e1[1] + w[2] * fr.e1[2], y = w[0] * fr.e2[0] + w[1] * fr.e2[1] + w[2] * fr.e2[2], z = w[0] * fr.n[0] + w[1] * fr.n[1] + w[2] * fr.n[2];
    if (Math.abs(x) < 0.75 * sc.box && Math.abs(y) < 0.75 * sc.box && Math.abs(z) < 6) return sc;
  }
  var fb = R.fail;                                          // a reading that found nothing is not repeated for every move of the pointer
  if (fb && R.soup === m.rawTris && R.modelId === m.id && Math.hypot(hit.point[0] - fb.p[0], hit.point[1] - fb.p[1], hit.point[2] - fb.p[2]) < 0.5 * TEXT_BOX_MM) {
    B_textRmSay(fb.say, true);
    return null;
  }
  // a new reading: the selection is carried across by where its pieces are
  var keep = [];
  if (sc && R.soup === m.rawTris) R.sel.forEach(function (id) { var a = NSO_Resurface.pieceAnchor(sc, id); if (a) keep.push(a); });
  var axis = NSO_Resurface.axisAt(m.rawTris, hit.point, 2.5, hit.view) || hit.normal;
  var ns;
  try { ns = NSO_Resurface.scan(m.rawTris, { point: hit.point, normal: axis }, { half: TEXT_BOX_MM }); }
  catch (err) { ns = { ok: false, reason: (err && err.message) || String(err) }; }
  R.soup = m.rawTris; R.modelId = m.id; R.tris = null; R.hover = []; R.fail = null;
  if (!ns.ok) {
    var say = /no pit/.test(ns.reason || '') ? 'Text: no engraved work within ' + TEXT_BOX_MM + ' mm of that point - move onto a letter.' : 'Text: ' + ns.reason;
    R.fail = { p: hit.point, say: say };
    R.scan = null; R.sel = []; R.plan = null; B_textRmSay(say, true);
    return null;
  }
  R.scan = ns;
  R.sel = [];
  keep.forEach(function (a) { var id = NSO_Resurface.pieceAt(ns, a); if (id >= 0 && R.sel.indexOf(id) < 0) R.sel.push(id); });
  NSO_textRmPlan();
  return ns;
}
function B_textRmSay(text, bad) { NSO_textReadout(text, bad); NSO_textSyncButtons(); }
// The pieces a hover or click at piece `id` stands for.
function NSO_textRmGroup(id) {
  var R = NSO_textRm(), o = NSO_textRemoveOpts();
  if (id < 0 || !R.scan) return [];
  return o.word ? R.scan.group(id, o.reach) : [id];
}
// The plan for what is locked.
function NSO_textRmPlan() {
  var B = NSO_textUI(), R = NSO_textRm();
  if (!R.scan || !R.sel.length) { R.plan = null; B.plan = null; B.key = ''; NSO_textRmDraw(); NSO_textRmSay(); return null; }
  var pl;
  try { pl = R.scan.pick(R.sel); }
  catch (err) { pl = { ok: false, reason: (err && err.message) || String(err) }; }
  R.plan = pl; B.plan = pl; B.key = 'rm';
  NSO_textRmDraw();
  NSO_textRmSay();
  return pl;
}
function NSO_textRmSay() {
  var R = NSO_textRm(), pl = R.plan;
  if (!R.sel.length) { NSO_textReadout(R.hover.length ? 'Click to lock ' + (R.hover.length === 1 ? 'this letter' : R.hover.length + ' letters') + ' for REMOVE.' : NSO_textRmHint()); NSO_textSyncButtons(); return; }
  if (pl && pl.ok) {
    NSO_textReadout(R.sel.length + (R.sel.length === 1 ? ' piece' : ' pieces') + ' locked, up to ' + NSO_textFmt(pl.depth) + ' mm deep, ' + NSO_textFmt(pl.area) + ' mm² - REMOVE fills ' + (R.sel.length === 1 ? 'it' : 'them') + '. Click a locked one to let it go, Escape to clear.');
  } else {
    NSO_textReadout('Text: ' + (pl ? pl.reason : 'nothing to fill'), true);
  }
  NSO_textSyncButtons();
}
// Amber: under the pointer, not yet locked. Green: locked.
function NSO_textRmDraw() {
  NSO_textClearGhost();
  var B = NSO_textUI(), R = NSO_textRm(), m = NSO_textModel();
  if (typeof THREE === 'undefined' || !state.scene || !m || !R.scan) return;
  if (!R.tris) R.tris = NSO_Resurface.highlight(m.rawTris, R.scan);
  var group = new THREE.Group();
  group.name = 'textGhost';
  group.matrixAutoUpdate = false;
  function add(ids, color, opacity) {
    var n = 0, k, i;
    ids.forEach(function (id) { if (R.tris[id]) n += R.tris[id].length; });
    if (!n) return;
    var flat = new Float32Array(n), at = 0;
    ids.forEach(function (id) {
      var a = R.tris[id];
      if (!a) return;
      for (k = 0; k < a.length; k += 3) {
        var d = NSO_textRawToDisplay(m, [a[k], a[k + 1], a[k + 2]]);
        flat[at++] = d[0]; flat[at++] = d[1]; flat[at++] = d[2];
      }
    });
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(flat, 3));
    var mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: opacity, side: THREE.DoubleSide,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
    mesh.renderOrder = TEXT_RENDER_ORDER; mesh.userData.skipXray = true; mesh.userData.textFill = true;
    mesh.raycast = function () {}; mesh.frustumCulled = false;
    group.add(mesh);
  }
  add(R.hover.filter(function (id) { return R.sel.indexOf(id) < 0; }), TEXT_GHOST_COLOR, 0.7);
  add(R.sel, TEXT_FILL_COLOR, 0.75);
  if (!group.children.length) return;
  if (typeof nsoHelpers !== 'undefined') nsoHelpers.attach(state.scene, group, 'text'); else state.scene.add(group);
  B.ghost = group;
  NSO_textFollow();
}
// The point under (x, y) as { point, normal, view } in raw, or null.
function NSO_textRmHit(clientX, clientY) {
  var m = NSO_textModel(), t = NSO_textPick(clientX, clientY);
  if (!m || !t || t.sourceId !== m.id) return null;
  var ray = NSO_textRawRay(m, clientX, clientY);
  return { point: NSO_textDisplayToRaw(m, t.local), normal: t.normal, view: ray ? ray.d : null };
}
function NSO_textRmHoverSoon(clientX, clientY) {
  var R = NSO_textRm();
  R.pend = { x: clientX, y: clientY };
  if (R.timer) return;
  R.timer = setTimeout(function () {
    var B = NSO_textUI(), R2 = B.rm, p = R2 && R2.pend;
    if (!R2) return;
    R2.timer = 0; R2.pend = null;
    if (B.open && B.mode === 'remove' && p) NSO_textRmHover(p.x, p.y);
  }, 40);
}
function NSO_textRmHover(clientX, clientY) {
  var B = NSO_textUI(), R = NSO_textRm(), m = NSO_textModel();
  if (!m || B.busy) return;
  var hit = NSO_textRmHit(clientX, clientY), ids = [];
  if (hit) {
    var sc = NSO_textRmEnsure(m, hit);
    if (sc) ids = NSO_textRmGroup(NSO_Resurface.pieceAt(sc, hit.point, 5));
  }
  if (ids.join() === R.hover.join()) return;
  R.hover = ids;
  NSO_textRmDraw();
  if (!R.sel.length) NSO_textRmSay();
}
// A press: lock the piece (and the ones with it), or let a locked one go. False when the press is not on a piece.
function NSO_textRmClick(clientX, clientY) {
  var B = NSO_textUI(), R = NSO_textRm(), m = NSO_textModel();
  if (!m) return false;
  var hit = NSO_textRmHit(clientX, clientY);
  if (!hit) return false;
  B.modelId = m.id;
  var sc = NSO_textRmEnsure(m, hit);
  if (!sc) return true;
  var id = NSO_Resurface.pieceAt(sc, hit.point, 5);
  if (id < 0) { NSO_textReadout('Text: no engraved work under that point - move onto a letter.', true); return true; }
  var ids = NSO_textRmGroup(id), allIn = ids.every(function (i) { return R.sel.indexOf(i) >= 0; });
  if (allIn) R.sel = R.sel.filter(function (i) { return ids.indexOf(i) < 0; });
  else ids.forEach(function (i) { if (R.sel.indexOf(i) < 0) R.sel.push(i); });
  R.hover = ids;
  NSO_textRmPlan();
  return true;
}
function NSO_textPreviewRemove(m) {
  var B = NSO_textUI(), R = B.rm;
  if (!m || (R && (R.modelId !== m.id || R.soup !== m.rawTris))) { NSO_textRmReset(); return null; }
  if (!R) NSO_textReadout(NSO_textRmHint());
  NSO_textSyncButtons();
  return B.plan || null;
}
function NSO_textSchedule() {
  var B = NSO_textUI();
  if (B.timer) clearTimeout(B.timer);
  B.timer = setTimeout(function () { B.timer = 0; NSO_textPreview(); }, TEXT_DEBOUNCE_MS);
}

/* ---------------------------------------------------------------- drawing */

function NSO_textClearGhost() {
  var B = NSO_textUI();
  if (!B.ghost) return;
  if (B.ghost.parent) B.ghost.parent.remove(B.ghost);
  B.ghost.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  B.ghost = null;
}
function NSO_textDraw(m) {
  NSO_textClearGhost();
  var B = NSO_textUI(), pl = B.plan;
  if (typeof THREE === 'undefined' || !state.scene || !pl || !pl.data) return;
  var color = pl.ok ? TEXT_GHOST_COLOR : TEXT_BAD_COLOR;
  var group = new THREE.Group();
  group.name = 'textGhost';
  group.matrixAutoUpdate = false;
  var soup = NSO_Text.cutter(pl), flat = new Float32Array(soup.length), k;
  for (k = 0; k < soup.length; k += 3) {
    var d = NSO_textRawToDisplay(m, [soup[k], soup[k + 1], soup[k + 2]]);
    flat[k] = d[0]; flat[k + 1] = d[1]; flat[k + 2] = d[2];
  }
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(flat, 3));
  var fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.4,
    depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
  fill.renderOrder = TEXT_RENDER_ORDER; fill.userData.skipXray = true; fill.userData.textFill = true;
  fill.raycast = function () {}; fill.frustumCulled = false;
  group.add(fill);
  // the floor of the engraving, outlined
  var D = pl.data, lines = [];
  (D.edges || []).forEach(function (e) {
    [e[0], e[1]].forEach(function (i) {
      var x = D.V[i][0], y = D.V[i][1], w = D.hb[i];
      var raw = [D.o[0] + D.ex[0] * x + D.ey[0] * y + D.n[0] * w, D.o[1] + D.ex[1] * x + D.ey[1] * y + D.n[1] * w,
                 D.o[2] + D.ex[2] * x + D.ey[2] * y + D.n[2] * w];
      var dd = NSO_textRawToDisplay(m, raw);
      lines.push(dd[0], dd[1], dd[2]);
    });
  });
  var lgeo = new THREE.BufferGeometry();
  lgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lines), 3));
  var ln = new THREE.LineSegments(lgeo, new THREE.LineBasicMaterial({ color: pl.ok ? TEXT_LINE_COLOR : TEXT_BAD_COLOR,
    transparent: true, depthTest: false, depthWrite: false }));
  ln.renderOrder = TEXT_RENDER_ORDER + 1; ln.userData.skipXray = true; ln.userData.textOutline = true;
  ln.raycast = function () {}; ln.frustumCulled = false;
  group.add(ln);
  if (typeof nsoHelpers !== 'undefined') nsoHelpers.attach(state.scene, group, 'text'); else state.scene.add(group);
  B.ghost = group;
  NSO_textFollow();
}
function NSO_textFollow() {
  var B = NSO_textUI(), m = NSO_textModel(), mesh = m && NSO_textMeshOf(m);
  if (!mesh || !B.ghost) return;
  mesh.updateMatrixWorld(true);
  B.ghost.matrix.copy(mesh.matrixWorld);
  B.ghost.matrixWorldNeedsUpdate = true;
}

/* ------------------------------------------------------------ the pointer */

// The pointer's ray in the piece's raw frame: { o, d }, d a unit vector.
function NSO_textRawRay(m, clientX, clientY) {
  var mesh = NSO_textMeshOf(m);
  if (!mesh || !state.raycaster || !state.camera || !state.renderer) return null;
  setPointerFromEvent({ clientX: clientX, clientY: clientY });
  state.raycaster.setFromCamera(state.pointer, state.camera);
  mesh.updateMatrixWorld(true);
  var inv = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
  var o = state.raycaster.ray.origin.clone().applyMatrix4(inv);
  var p = state.raycaster.ray.origin.clone().add(state.raycaster.ray.direction).applyMatrix4(inv).sub(o);
  var O = NSO_textDisplayToRaw(m, o), d = [p.x, -p.z, p.y], n = Math.hypot(d[0], d[1], d[2]);
  return n > 0 ? { o: O, d: [d[0] / n, d[1] / n, d[2] / n] } : null;
}
// A raw point on the screen, in client pixels.
function NSO_textScreen(m, raw) {
  var mesh = NSO_textMeshOf(m);
  var v = new THREE.Vector3().fromArray(NSO_textRawToDisplay(m, raw)).applyMatrix4(mesh.matrixWorld).project(state.camera);
  var r = state.renderer.domElement.getBoundingClientRect();
  return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height, z: v.z };
}
// Where a ray meets the plane through `at` square to `n`: the raw point, or null.
function NSO_textOnPlane(ray, at, n) {
  var dn = ray.d[0] * n[0] + ray.d[1] * n[1] + ray.d[2] * n[2];
  if (Math.abs(dn) < 1e-6) return null;
  var t = ((at[0] - ray.o[0]) * n[0] + (at[1] - ray.o[1]) * n[1] + (at[2] - ray.o[2]) * n[2]) / dn;
  return [ray.o[0] + t * ray.d[0], ray.o[1] + t * ray.d[1], ray.o[2] + t * ray.d[2]];
}
// A point in the click's tangent plane as (u, v) along the face's own axes.
function NSO_textUV(q, F) {
  var w = [q[0] - F.o[0], q[1] - F.o[1], q[2] - F.o[2]];
  return [w[0] * F.u[0] + w[1] * F.u[1] + w[2] * F.u[2], w[0] * F.v[0] + w[1] * F.v[1] + w[2] * F.v[2]];
}

/* The piece under (x, y), its point and face normal in the piece's raw frame.
   A press on another piece selects it first. */
function NSO_textPick(clientX, clientY) {
  if (!state.renderer || !state.camera || !state.modelGroup) return null;
  setPointerFromEvent({ clientX: clientX, clientY: clientY });
  state.raycaster.setFromCamera(state.pointer, state.camera);
  var hits = state.raycaster.intersectObjects(state.modelGroup.children, true);
  for (var i = 0; i < hits.length; i++) {
    if (!hits[i].face) continue;
    var obj = hits[i].object;
    while (obj && (!obj.userData || obj.userData.placedIndex == null) && obj.parent) obj = obj.parent;
    var idx = obj && obj.userData ? obj.userData.placedIndex : undefined;
    if (typeof idx !== 'number' || !state.placed[idx] || state.placed[idx].sourceId == null) continue;
    var mesh = state.placed[idx].mesh;
    mesh.updateMatrixWorld(true);
    var local = hits[i].point.clone().applyMatrix4(new THREE.Matrix4().copy(mesh.matrixWorld).invert());
    var n = hits[i].face.normal;
    return { index: idx, sourceId: state.placed[idx].sourceId, local: local, normal: [n.x, -n.z, n.y] };
  }
  return null;
}
// Place the text at (x, y): false when the press is not on a piece.
function NSO_textPlaceAt(clientX, clientY) {
  var B = NSO_textUI(), t = NSO_textPick(clientX, clientY);
  if (!t) return false;
  var m = NSO_textModel();
  if (!m || m.id !== t.sourceId) {
    if (typeof selectPlaced === 'function') selectPlaced(t.index);
    m = NSO_textModel();
  }
  if (!m || m.id !== t.sourceId) { NSO_textReadout('Text: that piece cannot be read here.', true); return true; }
  if (typeof NSO_bendFrameMatches === 'function' && !NSO_bendFrameMatches(m)) {
    B.hit = null; B.modelId = m.id; NSO_textClearGhost();
    NSO_textReadout('Text: the piece was turned since it was loaded - bake its pose first, then stamp.', true);
    NSO_textSyncButtons();
    return true;
  }
  B.modelId = m.id;
  B.hit = { point: NSO_textDisplayToRaw(m, t.local), normal: t.normal };
  NSO_textPreview();
  return true;
}

/* Is the pointer over the text: inside its box (a little over), on the click's tangent plane. */
function NSO_textHitAt(clientX, clientY) {
  var B = NSO_textUI(), m = NSO_textModel(), pl = B.plan, sh = B.shape;
  if (!B.open || B.mode !== 'stamp' || !m || !pl || !pl.frame || !sh || !sh.ok || B.modelId !== m.id || !NSO_textMeshOf(m)) return false;
  var ray = NSO_textRawRay(m, clientX, clientY), F = pl.frame;
  if (!ray) return false;
  var q = NSO_textOnPlane(ray, F.o, F.n);
  if (!q) return false;
  var w = [q[0] - F.o[0], q[1] - F.o[1], q[2] - F.o[2]];
  var x = w[0] * F.ex[0] + w[1] * F.ex[1] + w[2] * F.ex[2], y = w[0] * F.ey[0] + w[1] * F.ey[1] + w[2] * F.ey[2];
  var pad = 0.6;
  return Math.abs(x) <= sh.width / 2 + pad && Math.abs(y) <= sh.height / 2 + pad;
}

/* ------------------------------------------------------------ the drag */

function NSO_textSnap(d, fine) { var st = fine ? TEXT_FINE_MM : TEXT_STEP_MM; return Math.round(d / st) * st; }
function NSO_textDragBegin(ev) {
  var B = NSO_textUI(), m = NSO_textModel(), pl = B.plan, ray = m && NSO_textRawRay(m, ev.clientX, ev.clientY);
  if (!ray || !pl || !pl.frame) return false;
  var F = pl.frame, q = NSO_textOnPlane(ray, F.o, F.n);
  if (!q) return false;
  B.drag = { x0: ev.clientX, y0: ev.clientY, last: '', frame: F, at0: NSO_textUV(q, F), hit0: JSON.parse(JSON.stringify(B.hit)),
             undo: JSON.parse(JSON.stringify(B.hit)) };
  if (state.controls) state.controls.enabled = false;
  var cv = state.renderer && state.renderer.domElement;
  if (cv) cv.classList.add('text-cur-grab');
  return true;
}
function NSO_textDragMove(ev) {
  var B = NSO_textUI(), D = B.drag, m = NSO_textModel();
  if (!D || !m) return;
  var ray = NSO_textRawRay(m, ev.clientX, ev.clientY);
  if (!ray) return;
  var q = NSO_textOnPlane(ray, D.frame.o, D.frame.n);
  if (!q) return;
  var uv = NSO_textUV(q, D.frame), fine = !!ev.shiftKey;
  var sx = NSO_textSnap(uv[0] - D.at0[0], fine), sy = NSO_textSnap(uv[1] - D.at0[1], fine), key = sx + ',' + sy;
  if (key === D.last) return;
  D.last = key;
  var s = NSO_Punch.slide(m.rawTris, D.hit0, sx, sy, {});
  if (s.ok) { B.hit = { point: s.point, normal: s.normal }; NSO_textPreview(); }
}
// End a drag: kept (a release), or put back where it began (Escape, the card going away).
function NSO_textDragEnd(keep) {
  var B = NSO_textUI(), D = B.drag;
  if (!D) return;
  B.drag = null;
  if (state.controls) state.controls.enabled = true;
  if (!keep) B.hit = D.undo;
  B.key = '';
  NSO_textPreview();
  var cv = state.renderer && state.renderer.domElement;
  if (cv) cv.classList.remove('text-cur-grab');
}
function NSO_textHover(on) {
  var B = NSO_textUI();
  if (B.hover === on) return;
  B.hover = on;
  var cv = state.renderer && state.renderer.domElement;
  if (cv) cv.classList.toggle('text-cur-grab', !!on);
}

// One arrow key: nudge the text along the face, the way the arrow points on screen.
function NSO_textNudge(key, fine) {
  var B = NSO_textUI(), m = NSO_textModel(), pl = B.plan;
  if (!m || !pl || !pl.frame || !B.hit) return false;
  var F = pl.frame, st = fine ? TEXT_FINE_MM : TEXT_KEY_MM;
  var want = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[key];
  var c = NSO_textScreen(m, F.o), best = null, bd = -Infinity;
  [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) {
    var p = [F.o[0] + d[0] * F.u[0] + d[1] * F.v[0], F.o[1] + d[0] * F.u[1] + d[1] * F.v[1], F.o[2] + d[0] * F.u[2] + d[1] * F.v[2]];
    var s = NSO_textScreen(m, p), sx = s.x - c.x, sy = s.y - c.y, L = Math.hypot(sx, sy);
    var score = L > 1e-6 ? (sx * want[0] + sy * want[1]) / L : -1;
    if (score > bd) { bd = score; best = d; }
  });
  var s2 = NSO_Punch.slide(m.rawTris, B.hit, best[0] * st, best[1] * st, {});
  if (!s2.ok) { NSO_textReadout('Text: it stops at the edge of the face.', true); return true; }
  B.hit = { point: s2.point, normal: s2.normal };
  NSO_textPreview();
  return true;
}

/* --------------------------------------------------------------- STAMP */

// PAINT SCOPE: WHOLE-PIECE - see the header and docs/HANDOFF.md.
async function NSO_textGo() {
  var B = NSO_textUI(), m = NSO_textModel();
  if (B.busy) return { ok: false, reason: 'busy' };
  function refuse(why) {
    if (typeof setStatus === 'function') setStatus('Text refused - piece unchanged (' + why + ')', true);
    NSO_textReadout('Text: ' + why, true);
    return { ok: false, reason: why };
  }
  if (!m) return refuse('select a piece and click a face first');
  var painted = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
  if (painted > 0) {
    if (typeof setStatus === 'function') {
      setStatus('Text stood down - ' + painted + ' painted face(s); the text is cut through every face it meets. Clear paint to stamp.', true);
    }
    return { ok: false, reason: 'painted faces: ' + painted, painted: painted };
  }
  var pl = NSO_textPreview();
  if (!pl) return refuse('type the text and click a face first');
  if (!pl.ok) return refuse(pl.reason);
  var soup0 = m.rawTris, hit = B.hit, o = NSO_textOpts(), sh = B.shape, job = null;
  B.busy = true;
  NSO_textSyncButtons();
  NSO_textReadout('Stamping…');
  var bar = setTimeout(function () {
    if (B.busy && typeof NSO_BoolBusy !== 'undefined') job = NSO_BoolBusy.begin('Stamping', 'text-readout');
  }, TEXT_BAR_MS);
  try {
    // Work as is (nso-helpers.js, nsoOverlap): overlapping shells are merged for the boolean
    var sol = (typeof nsoOverlap !== 'undefined' && nsoOverlap) ? await nsoOverlap.solid(m, null, 'text-readout') : { ok: true, merged: false };
    if (!sol.ok) return refuse(sol.cancelled ? 'stopped' : sol.reason);
    var soup = sol.merged ? sol.soup : soup0;
    if (sol.merged) {
      pl = NSO_Text.plan(soup, hit, sh, o);
      if (!pl.ok) return refuse(pl.reason);
    }
    var res = await NSO_subtractSoups(soup, NSO_Text.cutter(pl), { label: 'Stamping', host: 'text-readout' });
    if (!res || !res.ok || !res.soup || res.soup.length < 9) {
      return refuse(res && res.cancelled ? 'stopped' : res && res.timedOut ? 'it ran too long and was stopped' : (res && res.reason) || 'the boolean returned nothing');
    }
    if (NSO_textModel() !== m || m.rawTris !== soup0) return refuse('the piece changed while it was stamped');
    var txt = 'Text done - ' + NSO_textFmt(sh.width) + ' × ' + NSO_textFmt(sh.height) + ' mm, ' + NSO_textFmt(o.depth) + ' mm deep' +
      (sol.merged ? ' - ' + sol.note : '');
    if (!NSO_sculptCommitRaw(m, res.soup, 'textReplace', txt)) return refuse('the result could not be committed');
    if (typeof updateAdjustUI === 'function') updateAdjustUI();
    // open for the next face: the click goes, the numbers stay
    B.hit = null; B.plan = null; B.key = '';
    NSO_textClearGhost();
    NSO_textReadout('Stamped ' + NSO_textFmt(sh.width) + ' × ' + NSO_textFmt(sh.height) + ' mm - click the next face.');
    return { ok: true, plan: pl };
  } catch (err) {
    console.error('[text]', err);
    return refuse((err && err.message) || String(err));
  } finally {
    clearTimeout(bar);
    if (job) job.end();
    B.busy = false;
    NSO_textSyncButtons();
  }
}

// PAINT SCOPE: WHOLE-PIECE - see the header and docs/HANDOFF.md.
// REMOVE is mesh surgery (NSO_Resurface.apply): no boolean, so no worker, no bar, no merge of overlapping
// shells first - a piece that is open or self-piercing elsewhere is not asked to be a solid.
function NSO_textRemoveGo() {
  var B = NSO_textUI(), m = NSO_textModel();
  if (B.busy) return { ok: false, reason: 'busy' };
  function refuse(why) {
    if (typeof setStatus === 'function') setStatus('Text remove refused - piece unchanged (' + why + ')', true);
    NSO_textReadout('Text: ' + why, true);
    return { ok: false, reason: why };
  }
  if (!m) return refuse('select a piece and click an engraved letter first');
  var painted = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
  if (painted > 0) {
    if (typeof setStatus === 'function') {
      setStatus('Text stood down - ' + painted + ' painted face(s); filling a recess rebuilds the face it is in. Clear paint to remove text.', true);
    }
    return { ok: false, reason: 'painted faces: ' + painted, painted: painted };
  }
  var R = B.rm, pl = R && R.plan;
  if (!pl) return refuse('click an engraved letter first - it turns green when it is locked');
  if (!pl.ok) return refuse(pl.reason);
  var res;
  try { res = NSO_Resurface.apply(m.rawTris, pl); }
  catch (err) { console.error('[text]', err); return refuse((err && err.message) || String(err)); }
  if (!res.ok) return refuse(res.reason);
  var txt = 'Text removed - ' + R.sel.length + (R.sel.length === 1 ? ' piece' : ' pieces') + ', up to ' + NSO_textFmt(pl.depth) + ' mm deep';
  if (!NSO_sculptCommitRaw(m, res.soup, 'textReplace', txt)) return refuse('the result could not be committed');
  if (typeof updateAdjustUI === 'function') updateAdjustUI();
  B.hit = null;
  NSO_textRmReset(false);
  NSO_textReadout('Removed - ' + (R.sel.length === 1 ? '1 piece' : R.sel.length + ' pieces') + '. Move over the next letter.');
  return { ok: true, plan: pl };
}

/* ------------------------------------------------------------ a font file */

async function NSO_textLoadFont(file) {
  var B = NSO_textUI();
  if (!file) return;
  if (typeof FontFace === 'undefined' || !document.fonts) { NSO_textReadout('Text: this browser cannot load a font file.', true); return; }
  try {
    var buf = await file.arrayBuffer();
    B.fontCount++;
    var fam = 'NSOText' + B.fontCount, face = new FontFace(fam, buf);
    await face.load();
    document.fonts.add(face);
    var key = 'file' + B.fontCount;
    B.fonts[key] = { css: '"' + fam + '", sans-serif' };
    var sel = NSO_textEl('sel-text-font'), opt = document.createElement('option');
    opt.value = key;
    opt.textContent = String(file.name || 'font').replace(/\.[^.]+$/, '').slice(0, 24);
    sel.appendChild(opt);
    sel.value = key;
    B.shapeKey = '';
    NSO_textPreview();
  } catch (err) {
    B.fontCount--;
    NSO_textReadout('Text: that is not a font the page can read (' + ((err && err.message) || err) + ').', true);
  }
}

/* -------------------------------------------------------------- open, close */

function NSO_textOpen() {
  var B = NSO_textUI();
  if (B.open) return;
  // one click-owning tool at a time: Carve and Punch take a press on a piece too
  if (state.carveArmed) { var cb = NSO_textEl('btn-carve'); if (cb) cb.click(); }
  if (typeof NSO_punchClose === 'function' && state.punch && state.punch.open) NSO_punchClose();
  B.open = true; B.hit = null; B.plan = null; B.key = ''; B.shapeKey = '';
  B.modelId = (NSO_textModel() || {}).id || null;
  NSO_textPreview();
  if (typeof setStatus === 'function') setStatus('Text open - type the text, then click a face to place it. Close the menu or press Escape to stop.');
  NSO_textTick();
}
function NSO_textClose() {
  var B = NSO_textUI();
  if (B.drag) NSO_textDragEnd(false);
  if (B.timer) { clearTimeout(B.timer); B.timer = 0; }
  B.hover = false;
  B.open = false; B.hit = null; B.plan = null; B.key = '';
  if (B.rm) { if (B.rm.timer) clearTimeout(B.rm.timer); B.rm = null; }
  NSO_textClearGhost();
  var cv = state.renderer && state.renderer.domElement;
  if (cv) cv.classList.remove('text-cur-grab');
  if (B.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(B.raf);
  B.raf = 0;
  var menu = NSO_textEl('menu-text');
  if (menu && menu.open) menu.open = false;
}

// Text's session, for the helper registry (nso-helpers.js): leave-tool and
// Clear close it, an Undo under it re-plans it.
if (typeof nsoHelpers !== 'undefined') nsoHelpers.owner('text', {
  live: function () { return !!NSO_textUI().open; },
  close: NSO_textClose,
  clear: NSO_textClearGhost,
  refresh: function () { var B = NSO_textUI(); B.key = ''; NSO_textPreview(); }
});

// Per frame while open: follow the piece; start over when the selection
// changes, re-plan when its soup does (another bake, Undo).
function NSO_textTick() {
  var B = NSO_textUI();
  if (!B.open) return;
  // one click-owning tool at a time: Carve, Paint or Punch armed over Text puts Text away
  if (!B.busy && (state.carveArmed || state.maskPaint || (state.punch && state.punch.open))) { NSO_textClose(); return; }
  var m = NSO_textModel();
  if ((m ? m.id : null) !== B.modelId) { B.modelId = m ? m.id : null; B.hit = null; NSO_textPreview(); }
  else if (B.mode === 'remove') {
    if (B.rm && m && B.rm.scan && (B.rm.soup !== m.rawTris || B.rm.modelId !== m.id)) NSO_textRmReset();   // another bake, an Undo: the readings are stale
    else NSO_textFollow();
  }
  else if (m && B.hit && m.rawTris !== B.soup && !B.busy) NSO_textPreview();
  else NSO_textFollow();
  B.raf = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame(NSO_textTick) : 0;
}

/* For the drive check: what the card shows. */
function nsoTextState() {
  var B = NSO_textUI(), pl = B.plan, sh = B.shape;
  var kids = B.ghost ? B.ghost.children : [];
  return {
    open: !!B.open, mode: B.mode, busy: !!B.busy, hit: B.hit, ok: !!(pl && pl.ok), reason: pl ? pl.reason : '',
    ghosts: kids.filter(function (o) { return o.userData.textFill; }).length,
    outlines: kids.filter(function (o) { return o.userData.textOutline; }).length,
    count: pl && pl.count || 0,
    shape: sh && sh.ok ? { width: sh.width, height: sh.height, area: sh.area, polys: sh.polys.length } : null,
    stats: pl ? pl.stats || null : null,
    frame: pl && pl.frame ? { o: pl.frame.o, n: pl.frame.n, u: pl.frame.u, v: pl.frame.v } : null,
    readout: (NSO_textEl('text-readout') || {}).textContent || '',
    bad: !!(NSO_textEl('text-readout') && NSO_textEl('text-readout').classList.contains('is-bad')),
    drag: !!B.drag,
    sel: B.rm ? B.rm.sel.length : 0, hover: B.rm ? B.rm.hover.length : 0
  };
}
/* For the drive check: the text's middle on the screen, in client pixels. */
function nsoTextCentreScreen(dx, dy) {
  var B = NSO_textUI(), m = NSO_textModel(), pl = B.plan;
  if (!m || !pl || !pl.frame) return null;
  var F = pl.frame, p = [F.o[0] + (dx || 0) * F.u[0] + (dy || 0) * F.v[0], F.o[1] + (dx || 0) * F.u[1] + (dy || 0) * F.v[1],
                         F.o[2] + (dx || 0) * F.u[2] + (dy || 0) * F.v[2]];
  return NSO_textScreen(m, p);
}

if (typeof document !== 'undefined') {
  (function wireText() {
    function onDown(ev) {
      var B = NSO_textUI();
      if (!B.open || ev.button !== 0 || !state.raycaster || !state.camera || !state.renderer) return;
      if (ev.target !== state.renderer.domElement) return;
      if (B.drag) NSO_textDragEnd(false);
      if (B.busy) {
        if (NSO_textPick(ev.clientX, ev.clientY)) { ev.stopImmediatePropagation(); ev.preventDefault(); }
        return;
      }
      if (B.mode === 'remove') {
        if (!NSO_textRmClick(ev.clientX, ev.clientY)) return;       // a press off the piece orbits as ever
        ev.stopImmediatePropagation();
        ev.preventDefault();
        return;
      }
      if (NSO_textHitAt(ev.clientX, ev.clientY) && NSO_textDragBegin(ev)) {
        // out of a field, so the arrows are the text's after the drag
        var f = document.activeElement, card = NSO_textEl('text-card');
        if (f && card && card.contains(f) && typeof f.blur === 'function') f.blur();
        ev.stopImmediatePropagation();
        ev.preventDefault();
        return;
      }
      if (!NSO_textPlaceAt(ev.clientX, ev.clientY)) return;
      ev.stopImmediatePropagation();
      ev.preventDefault();
    }
    function onMove(ev) {
      var B = NSO_textUI();
      if (B.drag) { NSO_textDragMove(ev); ev.stopImmediatePropagation(); ev.preventDefault(); return; }
      if (!B.open || !state.renderer || ev.target !== state.renderer.domElement || ev.buttons) {
        if (B.hover) NSO_textHover(false);
        return;
      }
      if (B.mode === 'remove') { NSO_textRmHoverSoon(ev.clientX, ev.clientY); return; }
      NSO_textHover(NSO_textHitAt(ev.clientX, ev.clientY));
    }
    function onUp(ev) {
      var B = NSO_textUI();
      if (!B.drag) return;
      NSO_textDragEnd(ev.type === 'pointerup');
      ev.stopImmediatePropagation();
    }
    var KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    function onKey(ev) {
      var B = NSO_textUI();
      if (!B.open || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.key === 'Escape' && B.drag) {
        NSO_textDragEnd(false);
        ev.preventDefault(); ev.stopImmediatePropagation();
        return;
      }
      var t = ev.target, typing = t && ((t.tagName === 'INPUT' && t.type !== 'checkbox') || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (typing) {
        // Escape leaves the field first, so a second one closes the card
        if (ev.key === 'Escape') { t.blur(); ev.preventDefault(); ev.stopImmediatePropagation(); }
        return;
      }
      if (t && t.tagName === 'SELECT' && ev.key !== 'Escape') return;
      // a top-bar menu that owns the arrows (Rotate, Tip, Move) keeps them (app-input-mode.js)
      var IM = window.nsoInputMode, owner = IM && IM.active && IM.active();
      if (owner && IM.registered && IM.registered().indexOf(owner) >= 0) return;
      if (ev.key === 'Escape') {
        if (B.busy) return;                 // app-bool-busy.js's Escape stops the boolean
        if (B.mode === 'remove' && B.rm && B.rm.sel.length) {      // the first Escape lets go of what is locked
          B.rm.sel = []; B.rm.hover = [];
          NSO_textRmPlan();
          ev.preventDefault(); ev.stopImmediatePropagation();
          return;
        }
        NSO_textClose();
        if (typeof setStatus === 'function') setStatus('Text off');
        ev.preventDefault(); ev.stopImmediatePropagation();
        return;
      }
      var k = KEYS[ev.key];
      if (!k || B.drag || B.busy || !B.plan || B.mode !== 'stamp') return;
      NSO_textNudge(k, ev.shiftKey);
      ev.preventDefault(); ev.stopImmediatePropagation();
    }
    function wire() {
      var menu = NSO_textEl('menu-text');
      if (!menu || menu.dataset.nsoWired === '1') return;
      menu.dataset.nsoWired = '1';
      menu.addEventListener('toggle', function () { if (menu.open) NSO_textOpen(); else if (NSO_textUI().open) NSO_textClose(); });
      var go = NSO_textEl('btn-text-go'), cancel = NSO_textEl('btn-text-cancel'), rm = NSO_textEl('btn-text-remove');
      if (go) go.addEventListener('click', function () { NSO_textGo(); });
      if (rm) rm.addEventListener('click', function () { NSO_textRemoveGo(); });
      [['btn-text-mode-stamp', 'stamp'], ['btn-text-mode-remove', 'remove']].forEach(function (p) {
        var b = NSO_textEl(p[0]);
        if (b) b.addEventListener('click', function () { NSO_textSetMode(p[1]); });
      });
      ['chk-text-word', 'inp-text-reach'].forEach(function (id) {
        var el = NSO_textEl(id);
        if (!el) return;
        el.addEventListener('change', function () { NSO_textSchedule(); });
        el.addEventListener('input', function () { NSO_textSchedule(); });
      });
      if (cancel) cancel.addEventListener('click', NSO_textClose);
      ['btn-text-bold', 'btn-text-italic'].forEach(function (id) {
        var b = NSO_textEl(id);
        if (b) b.addEventListener('click', function () { b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true'); NSO_textSchedule(); });
      });
      var ff = NSO_textEl('btn-text-font-file'), fi = NSO_textEl('inp-text-font-file');
      if (ff && fi) {
        ff.addEventListener('click', function () { fi.click(); });
        fi.addEventListener('change', function () { var f = fi.files && fi.files[0]; fi.value = ''; NSO_textLoadFont(f); });
      }
      ['inp-text', 'sel-text-font', 'inp-text-size', 'inp-text-depth', 'inp-text-angle', 'chk-text-mirror'].forEach(function (id) {
        var el = NSO_textEl(id);
        if (!el) return;
        el.addEventListener('change', function () { NSO_textSchedule(); });
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.addEventListener('input', function () { NSO_textSchedule(); });
      });
      // Capture on window: ahead of app-core's canvas handler, so a click that
      // places the text does not also start a drag or a selection.
      window.addEventListener('pointerdown', onDown, true);
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onUp, true);
      window.addEventListener('keydown', onKey, true);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  })();
}
