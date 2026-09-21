// ===================== Build volume: does it fit the machine? ==============
//
// The live half of nso_printer.js. That module answers "will this box fit that
// machine"; this file asks it, continuously, about whatever is on the plate,
// and puts the answer where the user is already looking.
//
// ---------------------------------------------------------------------------
// WHY IT IS A POLL AND NOT A HOOK
// ---------------------------------------------------------------------------
// A piece's bounding box changes from a dozen places - Cut, Join, Soften,
// Thicken, Smooth, Extend, Scale, an import, a Split, and the Pottery Wheel
// re-revolving a form on every frame of a drag. Hooking all of them means
// every future tool has to remember to call this, and the one that forgets is
// the one that ships a piece that does not fit.
//
// So instead: one requestAnimationFrame loop, one cheap SIGNATURE - the plate
// id, the custom fields, and each model's three sizes - and a recompute only
// when that signature changes. Reading a few dozen numbers per frame costs
// nothing measurable; the fit arithmetic runs only on a real change. The
// effect is that a tool which changes a piece's size gets the warning updated
// whether or not its author ever heard of this file, which is the property
// worth having.
//
// It is also why this is not an export-time check. By export time the
// decision has been made. A potter pulling a vase up finds out on the pull
// that takes it past 180 mm, not twenty minutes later.
//
// ---------------------------------------------------------------------------
// SCOPE
// ---------------------------------------------------------------------------
// "Does it physically fit the machine", and nothing else. Not a printability
// check: bridging, overhangs, wall thickness and severed connections are
// separate, already-existing concerns with their own modules, and a piece
// that fits and cannot be printed produces no warning here. See the scope
// note at the top of nso_printer.js.

/* The printer the app is currently pointed at, including the live custom
   fields. One resolution path, so nothing else has to know that the plate
   card speaks w/d and the profile speaks bed axes. */
function NSO_fitCurrentPrinter() {
  if (typeof NSO_Printer === 'undefined' || !NSO_Printer) return null;
  var id = (typeof state !== 'undefined' && state && state.plate) ? state.plate : 'a1mini';
  var over = null;
  if (typeof document !== 'undefined') {
    var w = document.getElementById('custom-w');
    var d = document.getElementById('custom-d');
    var h = document.getElementById('custom-h');
    over = {
      w: w ? parseFloat(w.value) : undefined,
      d: d ? parseFloat(d.value) : undefined,
      h: h ? parseFloat(h.value) : undefined
    };
  }
  /* Only the custom plate reads those fields; every other id is fixed, and
     resolve() ignores overrides that match the profile anyway. */
  return NSO_Printer.resolve(id, id === 'custom' ? over : null);
}

/* Every piece on the plate against the current machine. Returned rather than
   only rendered, so a check or another tool can ask the same question. */
function NSO_fitCheckAll() {
  var printer = NSO_fitCurrentPrinter();
  if (!printer || typeof state === 'undefined' || !state || !state.models) return null;
  var out = { printer: printer, pieces: [], over: [] };
  for (var i = 0; i < state.models.length; i++) {
    var m = state.models[i];
    if (!m || !m.size) continue;
    /* m.size is DISPLAY space - Y up - because zUpToYUp runs at import and
       every rebuild goes back through it. fromDisplaySize is the only place
       that conversion is written down. */
    var rep = NSO_Printer.fit(NSO_Printer.fromDisplaySize(m.size), printer);
    rep.modelId = m.id;
    rep.name = m.name;
    out.pieces.push(rep);
    if (!rep.fits) out.over.push(rep);
  }
  out.over.sort(function (a, b) { return b.worst_mm - a.worst_mm; });
  return out;
}

/* One line, the worst offender first, naming the machine and every axis. */
function NSO_fitWarningText(all) {
  if (!all || !all.over.length) return '';
  var w = all.over[0];
  var txt = w.name + ': ' + NSO_Printer.describe(w);
  if (all.over.length > 1) {
    txt += ' (and ' + (all.over.length - 1) + ' more piece' + (all.over.length > 2 ? 's' : '') +
           ' over the build volume)';
  }
  return txt;
}

if (typeof document !== 'undefined') {
  (function wireFitWatch() {
    var lastSig = null;

    function signature() {
      var parts = [];
      parts.push((typeof state !== 'undefined' && state) ? state.plate : '?');
      var ids = ['custom-w', 'custom-d', 'custom-h'];
      for (var k = 0; k < ids.length; k++) {
        var el = document.getElementById(ids[k]);
        parts.push(el ? el.value : '');
      }
      if (typeof state !== 'undefined' && state && state.models) {
        for (var i = 0; i < state.models.length; i++) {
          var m = state.models[i];
          if (!m || !m.size) { parts.push('-'); continue; }
          parts.push(m.id + ':' + m.size.x + ',' + m.size.y + ',' + m.size.z);
        }
      }
      return parts.join('|');
    }

    function render() {
      var el = document.getElementById('build-volume-warning');
      if (!el) return;
      var all = NSO_fitCheckAll();
      var txt = NSO_fitWarningText(all);
      if (!txt) {
        el.hidden = true;
        el.textContent = '';
        return;
      }
      el.hidden = false;
      el.textContent = txt;
      el.title = 'Build volume only - this says the piece is too big for the machine, ' +
                 'not that it is unprintable. Bridging, wall thickness and severed ' +
                 'connections are separate checks.';
    }

    function tick() {
      try {
        var sig = signature();
        if (sig !== lastSig) { lastSig = sig; render(); }
      } catch (err) {
        /* A warning that throws is worse than no warning: stop polling and
           say so once, rather than filling the console every frame. */
        if (typeof console !== 'undefined') console.error('[fit] build-volume watch stopped', err);
        return;
      }
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(tick);
    }

    function start() {
      /* Belt and braces on the two inputs that are not a model size: a plate
         change and a custom-field edit both land in the signature anyway, but
         firing render straight away makes the change feel immediate rather
         than one frame late. */
      var ids = ['plate-select', 'custom-w', 'custom-d', 'custom-h'];
      for (var k = 0; k < ids.length; k++) {
        var el = document.getElementById(ids[k]);
        if (el) { el.addEventListener('change', render); el.addEventListener('input', render); }
      }
      tick();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  })();
}
