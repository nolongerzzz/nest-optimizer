/* app-texture.js - the Texture button: a conformal skin over a cylinder's
   curved side (nso_skin_band.js), applied to the selected piece in place, as
   a bake.

   ---------------------------------------------------------------------------
   "TEXTURE" IS NOT "FULL WRAP", AND NOT "SKIN WRAP"
   ---------------------------------------------------------------------------
   Three different things in this app carry a covering word, and they are
   deliberately named apart in the UI so nobody has to guess:

     Full wrap   a CHECKBOX on Soften. "One click wraps all six faces of a
                 box" (index.html). It is about edge treatment - Round,
                 Corners, Bevel - and has nothing to do with relief patterns.
                 Untouched by this file.
     Skin wrap   a BUTTON. The same contact relief on every flat rectangular
                 face of a piece, one face after another (app-skin.js). Every
                 face is still a flat rectangle; a cylinder's side is refused.
     Texture     THIS button. One relief that covers a cylinder's curved side
                 in a single closed surface, wrapping all the way round with
                 no seam. Flat faces are none of its business; the caps are
                 left in their own planes.

   Texture is the parked "OTHER wrap" from docs/HANDOFF.md, built. The
   geometry, the three blockers it had to clear, and what it costs are in
   nso_skin_band.js and docs/CURVED-SKIN.md.

   ---------------------------------------------------------------------------
   PAINT SCOPE: SUB-REGION - the curved band, and only that
   ---------------------------------------------------------------------------
   Standing rule (docs/HANDOFF.md): a painted / excluded face stays untouched
   by ANY bake mechanism. This bake acts on one identifiable sub-region - the
   cylinder's side - so it checks paint THERE, and paint elsewhere does not
   block it. That is the sub-region half of the scoping rule, the same rule as
   Smooth's whole-piece stand-down applied at a different scope, not a laxer
   reading of it.

   What that means concretely, because a curved band is not one of mask6's six
   faces and the rule has to be read, not re-derived:

     - the band's facets. A click on a cylinder's side records ONE facet's
       plane, exactly as a click on a box face records that face's. So the
       check is `nsoMaskIsExcludedRaw(m, face.n, face.d)` over the band's
       distinct facet planes - mask6's own answer, per facet, never a second
       mapping from a plane and a bounding box. ANY painted facet stands the
       whole bake down and the status says how many, because the band is
       treated as one surface: the relief is periodic around the full
       circumference and the engine has no per-facet height. A pattern that
       simply skipped a painted facet would leave a bald stripe, which is a
       different feature, not this one.
     - the two CAPS do not stand it down. They keep their planes and their
       boundary loops; only the cap triangles that border a rim are re-fanned
       over the points the relief adds there, which is what applySkinToFace
       already does to the walls beside a skinned face. Nothing moves.

   Lifecycle is the house one, through NSO_sculptCommitRaw (app-sculpt.js):
   undo entry first ('textureReplace', wired in app-core.js undoLast), display
   geometry rebuilt from the new rawTris, placed instance re-seated.

   ---------------------------------------------------------------------------
   OUT OF SCOPE, STATED
   ---------------------------------------------------------------------------
   Seat against a curved contact is a separate ticket and nothing here
   answers it. Seat translates B along one normal and explicitly does not
   tilt-fit a skin; a curved interface has no single contact plane, so the
   number this bake reports as `contact` is the tip-surface area, not a
   promise that Seat can land a part on it. Do not wire Seat to this. */

/* The piece's raw soup, or null with the status already said. */
function NSO_textureSoupOf(m, say) {
  if (!m) { say('Select a piece first', true); return null; }
  if (!(m.rawTris && m.rawAxis === 'zup')) {
    say('Texture needs a raw piece - unchanged', true);
    return null;
  }
  return m.rawTris;
}

/* The band's distinct facet planes, as the paint system records a face: the
   outward normal and the offset n.p. Read back, never re-derived - that is
   the rule in docs/HANDOFF.md and the reason this walks the band's own
   triangles instead of deciding which faces "must" be there. */
function NSO_textureFacetPlanes(soup, band) {
  var seen = new Map(), out = [];
  for (var i = 0; i < band.bandTris.length; i++) {
    var t = band.bandTris[i], o = t * 9;
    var ax = soup[o], ay = soup[o + 1], az = soup[o + 2];
    var ux = soup[o + 3] - ax, uy = soup[o + 4] - ay, uz = soup[o + 5] - az;
    var vx = soup[o + 6] - ax, vy = soup[o + 7] - ay, vz = soup[o + 8] - az;
    var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    var L = Math.hypot(nx, ny, nz);
    if (!(L > 1e-12)) continue;
    var n = [nx / L, ny / L, nz / L];
    var d = n[0] * ax + n[1] * ay + n[2] * az;
    var key = Math.round(n[0] * 1e3) + '|' + Math.round(n[1] * 1e3) + '|' +
              Math.round(n[2] * 1e3) + '|' + Math.round(d * 1e3);
    if (seen.has(key)) continue;
    seen.set(key, 1);
    out.push({ n: n, d: d });
  }
  return out;
}

/* How many of the band's facets the paint has taken out.

   PAINT SCOPE: SUB-REGION - see the header and docs/HANDOFF.md "Scoping".
   Only the band's own facets are asked about. A painted cap, or paint on any
   other piece, is not this bake's business and does not reach here. */
function NSO_textureBandPainted(m, soup, band) {
  if (typeof nsoMaskIsExcludedRaw !== 'function') return 0;
  var faces = NSO_textureFacetPlanes(soup, band), hit = 0;
  for (var i = 0; i < faces.length; i++) {
    var face = faces[i];
    if (nsoMaskIsExcludedRaw(m, face.n, face.d)) hit++;
  }
  return hit;
}

/* Texture the selected piece and bake it. Returns the result object so a
   caller (or the console) can read the numbers. */
function NSO_textureSelectedModel(opts) {
  opts = opts || {};
  var say = function (t, bad) { if (typeof setStatus === 'function') setStatus(t, !!bad); };
  var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
  var soup = NSO_textureSoupOf(m, say);
  if (!soup) return { ok: false, reason: 'no raw piece' };
  if (typeof NSO_SkinBand === 'undefined' || !NSO_SkinBand.applyBandSkin) {
    say('Texture needs nso_skin_band.js - unchanged', true);
    return { ok: false, reason: 'engine not loaded' };
  }

  /* The band first, so a refusal names the shape rather than the pattern.
     `findBand` is the only place that decides what a cylinder is, and its
     reasons are written to be read by a user, not only by a test. */
  var band = NSO_SkinBand.findBand(soup);
  if (typeof band === 'string') {
    say('Texture refused - ' + band + '. Texture covers a cylinder’s curved side; ' +
        'use Skin wrap for flat faces.', true);
    return { ok: false, reason: band };
  }

  /* Standing rule: a painted face stays untouched by ANY bake. The relief is
     periodic around the whole circumference and there is no per-facet height
     to zero, so a painted facet is a stand-down, not a hole in the pattern. */
  var painted = NSO_textureBandPainted(m, soup, band);
  if (painted > 0) {
    say('Texture stood down - ' + painted + ' painted facet(s) on the curved side; the wrap is ' +
        'one surface all the way round and cannot leave one facet bare. Clear paint on the ' +
        'side to texture it (paint on the caps does not block it).', true);
    return { ok: false, reason: 'painted band facets: ' + painted, painted: painted };
  }

  var r = NSO_SkinBand.applyBandSkin(soup, {
    pattern: opts.pattern || NSO_texturePatternFromUI(),
    params: opts.params || NSO_textureParamsFromUI(),
    margin: opts.margin
  });
  if (!r.ok) { say('Texture refused - piece unchanged (' + r.reason + ')', true); return r; }

  var txt = 'Textured the curved side - ' + r.describe +
    ', tips +' + r.tipHeight.toFixed(2) + 'mm' +
    (r.pitchSnapped ? ' (pitch snapped ' + r.pitchAsked.toFixed(2) + ' → ' + r.pitch.toFixed(3) +
                      'mm so the wrap closes)' : '') +
    ', contact ' + r.tipArea.toFixed(1) + 'mm² on the curve (' +
    r.tipAreaUnrolled.toFixed(1) + 'mm² unrolled), ' +
    (r.tris.length / 9) + ' tris - caps untouched';
  if (typeof NSO_sculptCommitRaw === 'function') NSO_sculptCommitRaw(m, r.tris, 'textureReplace', txt);
  return r;
}

/* ---- the two controls, read where they are used ---------------------- */

function NSO_texturePatternFromUI() {
  var sel = (typeof document !== 'undefined') ? document.getElementById('sel-texture-pattern') : null;
  return (sel && sel.value) ? sel.value : 'crosshatch';
}
function NSO_textureParamsFromUI() {
  var num = function (id, dflt) {
    var el = (typeof document !== 'undefined') ? document.getElementById(id) : null;
    var v = el ? parseFloat(el.value) : NaN;
    return isFinite(v) && v > 0 ? v : dflt;
  };
  /* Only the two a user actually turns. Everything else stays on
     nso_skin.js's stated defaults, which is where the rib width lives and
     where the coupon doc's one-extrusion-line rule is written down. */
  return { pitch: num('inp-texture-pitch', 1.2), height: num('inp-texture-depth', 0.6) };
}

/* ---------------------------------------------------------------------------
   UI entry point. Self-wired here rather than in the shared button block, the
   same way app-sculpt.js wires Smooth, so adding a bake does not touch a
   protected fat file. Guarded on `document` because this file is also loaded
   headless by tools/nso_texture_test.js.
--------------------------------------------------------------------------- */
if (typeof document !== 'undefined') {
  (function wireTextureButton() {
    function wire() {
      var btn = document.getElementById('btn-texture');
      if (!btn || btn.dataset.nsoWired === '1') return;
      btn.dataset.nsoWired = '1';
      btn.addEventListener('click', function () {
        try {
          NSO_textureSelectedModel();
        } catch (err) {
          console.error('[texture]', err);
          if (typeof setStatus === 'function') {
            setStatus('Texture failed - piece unchanged (' + ((err && err.message) || err) + ')', true);
          }
        }
      });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  })();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    NSO_textureFacetPlanes: NSO_textureFacetPlanes,
    NSO_textureBandPainted: NSO_textureBandPainted,
    NSO_textureSelectedModel: NSO_textureSelectedModel
  };
}
