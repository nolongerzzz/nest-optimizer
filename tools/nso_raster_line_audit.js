/* Task 1 of the raster-to-flat-line ticket: the diagnosis, measured.
 *     node tools/nso_raster_line_audit.js        exit 0 = every gate held
 *
 * THE QUESTION. A two-layer breakaway interface is built the way Bambu builds
 * one: a layer of lines, then a second layer of the same lines turned 90
 * degrees across it. Nest can already make that shape - Skin patch 'loose'
 * bakes a pattern as its own object - and the path shape and the crossing
 * angle have both been confirmed correct. What has NOT been confirmed is the
 * SECTION. The shipped patterns are RELIEF profiles: a rib or a sawtooth
 * ridge STANDING on a plane, as tall as it is wide or taller, and in the
 * zigzag's case wider at the bottom than at the top. A real printed line is
 * none of those things - it is flat and thin, 0.3 mm tall and 0.42 to 0.61 mm
 * wide, the same width at its underside as at its top.
 *
 * So: measure the real contact at a crossing, both ways, and settle whether
 * the section is what is over-bonding the interface.
 *
 * WHAT IS MEASURED, AND WITH WHAT. tools/nso_contact_area.js, which
 * intersects the two meshes' material regions IN the interface plane as real
 * 2D polygons - A's up-facing faces there against B's down-facing faces - and
 * clusters the result into patches so a total cannot hide whether it is
 * isolated dots or a continuous weld. NSO_Skin.tipContactArea is the wrong
 * instrument for this and the difference is the whole point: it answers "how
 * much of A's tips plane lies under B's footprint", which is right when B is
 * a flat plate covering everything, and wrong when B is itself a patterned
 * piece whose underside is mostly air.
 *
 * THE NUMBERS ARE THE TICKET'S, NOT INVENTED HERE. LINE_H 0.3 mm and
 * LINE_W 0.42 / 0.61 mm are tonight's measured Bambu values, carried in
 * nso_raster_lines.js as its defaults; 0.42 is also this repo's own
 * MIN_WALL - one extrusion line at a 0.4 nozzle - so the narrow end of the
 * measured range and the repo's existing figure are the same number. The
 * shipped patch numbers are read off nso_skin_patch.js as it stands today.
 */
'use strict';

const NSO_Skin = require('../nso_skin.js');
const NSO_SkinPatch = require('../nso_skin_patch.js');
const RL = require('../nso_raster_lines.js');
const { interfaceContact, rotateZ, bbox } = require('./nso_contact_area.js');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
const f = (x, n) => Number(x).toFixed(n == null ? 4 : n);

/* tonight's measured line, from the importer's own defaults */
const LINE_H = RL.LINE_HEIGHT;      /* 0.3  mm */
const LINE_W = RL.LINE_WIDTH;       /* 0.42 mm - also this repo's MIN_WALL */
const LINE_W_MAX = RL.LINE_WIDTH_MAX; /* 0.61 mm - the wide end of the range */
const SIZE = NSO_SkinPatch.SIZE;    /* 30 mm, the sample footprint */

/* ------------------------------------------------------------------ rigs */

/* Two stacked copies of one patch, the second turned `deg` across the first
 * and set down on the first's tips - Bambu's two-layer construction. Returns
 * the contact measurement plus the patch's own numbers. `flip` turns the upper
 * copy upside down: not a printable proposal, a CONTROL that changes which end
 * of the section meets the interface and nothing else. */
function stackAndMeasure(opts, deg, flip) {
  const r = NSO_SkinPatch.buildPatch(opts);
  if (!r.ok) throw new Error('buildPatch: ' + r.reason);
  const h = r.extent[2];
  let B = rotateZ(r.tris, deg == null ? 90 : deg, SIZE / 2, SIZE / 2, 0);
  if (flip) {
    const g = new Float32Array(B.length);
    for (let i = 0; i < B.length; i += 3) { g[i] = B[i]; g[i + 1] = B[i + 1]; g[i + 2] = h - B[i + 2]; }
    /* mirroring reverses winding - swap two vertices of every triangle back */
    for (let t = 0; t < g.length / 9; t++) {
      for (let k = 0; k < 3; k++) {
        const a = t * 9 + 3 + k, b = t * 9 + 6 + k;
        const tmp = g[a]; g[a] = g[b]; g[b] = tmp;
      }
    }
    B = g;
  }
  for (let i = 2; i < B.length; i += 3) B[i] += r.tipsZ;
  const ct = interfaceContact(r.tris, B, { plane: r.tipsZ });
  return { patch: r, contact: ct, stackHeight: r.tipsZ + h, B: B };
}

/* The patch areas, grouped - "195 crossings of 0.5040 mm^2 at 0.42 x 1.20 mm,
 * and 2 welds of 8.3700 at 30.00 x 1.60" rather than one average. */
function groupPatches(ct) {
  const m = new Map();
  ct.patchAreas.forEach((a, i) => {
    const k = f(a) + '|' + ct.patchExtents[i].map(x => f(x, 2)).join(' x ');
    m.set(k, (m.get(k) || 0) + 1);
  });
  return Array.from(m.entries())
    .map(([k, n]) => { const p = k.split('|'); return { n: n, area: +p[0], extent: p[1] }; })
    .sort((a, b) => b.n * b.area - a.n * a.area);
}
function reportPatches(ct) {
  for (const g of groupPatches(ct)) {
    console.log('       x' + String(g.n).padStart(3) + '  ' + f(g.area) + ' mm^2 each, ' + g.extent + ' mm' +
      '   (' + f(g.n * g.area, 3) + ' mm^2 of the total)');
  }
}

/* An axis-aligned box as a soup - the reference flat line, from first
 * principles, so the flat figure is MEASURED on real geometry with the same
 * instrument rather than multiplied out on paper. */
function boxSoup(x0, x1, y0, y1, z0, z1) {
  const out = [];
  const P = (x, y, z) => [x, y, z];
  const quad = (a, b, c, d) => { out.push(...a, ...b, ...c, ...a, ...c, ...d); };
  quad(P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1));   /* +Z */
  quad(P(x0, y1, z0), P(x1, y1, z0), P(x1, y0, z0), P(x0, y0, z0));   /* -Z */
  quad(P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1));   /* -Y */
  quad(P(x1, y1, z0), P(x0, y1, z0), P(x0, y1, z1), P(x1, y1, z1));   /* +Y */
  quad(P(x0, y1, z0), P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1));   /* -X */
  quad(P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), P(x1, y0, z1));   /* +X */
  return new Float32Array(out);
}

/* One crossing of two genuine flat printed lines: a bar `w` wide and `h` tall
 * along Y, and the same bar along X resting on top of it. Nothing about the
 * section is assumed - the bars are solids and the contact is measured. */
function flatCrossing(w, h, span) {
  const c = span / 2;
  const A = boxSoup(c - w / 2, c + w / 2, 0, span, 0, h);
  const B = boxSoup(0, span, c - w / 2, c + w / 2, h, 2 * h);
  return { A: A, B: B, contact: interfaceContact(A, B, { plane: h }) };
}

console.log('\n============================================================');
console.log(' Task 1 - the standing-rib diagnosis, measured');
console.log('============================================================');
console.log(' the real printed line under test: ' + LINE_H + ' mm tall, ' +
  LINE_W + ' - ' + LINE_W_MAX + ' mm wide (tonight\'s measured Bambu values)');

/* ------------------------------------------------------------------ part 1 */
console.log('\n=== 1. what a genuine flat printed line does at a crossing ===');
const flat = {};
{
  for (const w of [LINE_W, LINE_W_MAX]) {
    const r = flatCrossing(w, LINE_H, SIZE);
    flat[w] = r.contact;
    console.log('  line ' + f(w, 2) + ' x ' + f(LINE_H, 2) + ' mm, two crossing at 90 deg:');
    console.log('       contact ' + f(r.contact.area) + ' mm^2 in ' + r.contact.patches + ' patch(es), ' +
      r.contact.patchExtents.map(e => e.map(x => f(x, 2)).join(' x ')).join('; ') + ' mm');
    check('  ' + f(w, 2) + ' mm line: the crossing is exactly w x w, one patch',
      r.contact.patches === 1 && near(r.contact.area, w * w, 1e-6), f(r.contact.area) + ' vs ' + f(w * w));
    check('  ' + f(w, 2) + ' mm line: nothing else touches - the rest is air',
      r.contact.patches === 1 && r.contact.maxPatchSpan <= w + 1e-4,
      'widest patch spans ' + f(r.contact.maxPatchSpan, 3) + ' mm, one line width');
    check('  ' + f(w, 2) + ' mm line: two layers stack to ' + f(2 * LINE_H, 2) + ' mm',
      near(bbox(r.B).hi[2], 2 * LINE_H, 1e-6), f(bbox(r.B).hi[2], 3));
  }
}
const FLAT_CROSS = LINE_W * LINE_W;            /* 0.1764 mm^2 */
const FLAT_CROSS_MAX = LINE_W_MAX * LINE_W_MAX; /* 0.3721 mm^2 */

/* ------------------------------------------------------------------ part 2 */
console.log('\n=== 2. the shipped loose patches, stacked the way Bambu stacks ===');
const shipped = {};
for (const pattern of ['zigzag', 'crosshatch']) {
  const s = stackAndMeasure({ variant: 'loose', pattern: pattern }, 90);
  shipped[pattern] = s;
  const ct = s.contact;
  console.log('\n  ' + pattern + ' loose: ' + s.patch.describeFull);
  console.log('    A\'s up-facing material at the tips plane   ' + f(ct.areaA, 3) + ' mm^2');
  console.log('    B\'s down-facing material at the same plane ' + f(ct.areaB, 3) + ' mm^2   ' +
    '(of a ' + (SIZE * SIZE) + ' mm^2 footprint)');
  console.log('    CONTACT ' + f(ct.area, 3) + ' mm^2 in ' + ct.patches + ' patch(es):');
  reportPatches(ct);
  console.log('    interface thickness, two layers: ' + f(s.stackHeight, 2) + ' mm' +
    '   (a real two-layer interface: ' + f(2 * LINE_H, 2) + ' mm)');
}

/* the zigzag, the pattern whose path shape really is a printed layer's */
{
  const ct = shipped.zigzag.contact;
  const g = groupPatches(ct);
  const cross = g.find(x => x.n > 100);
  const weld = g.find(x => x.n <= 4);
  check('zigzag: every ridge crossing measures 0.42 x 1.20 mm = the CREST width x the BASE width',
    !!cross && near(cross.area, 0.42 * 1.2, 1e-6) && cross.extent === '0.42 x 1.20',
    cross ? f(cross.area) + ' mm^2 at ' + cross.extent + ' mm, x' + cross.n : 'not found');
  check('zigzag: that is ' + f(0.42 * 1.2 / FLAT_CROSS, 3) + 'x a real ' + LINE_W + ' mm line\'s crossing',
    !!cross && near(cross.area / FLAT_CROSS, 2.857142, 1e-5), f(cross.area) + ' vs ' + f(FLAT_CROSS));
  check('zigzag: and still ' + f(0.42 * 1.2 / FLAT_CROSS_MAX, 3) + 'x the WIDEST real line (' + LINE_W_MAX + ' mm)',
    !!cross && cross.area > FLAT_CROSS_MAX, f(cross.area) + ' vs ' + f(FLAT_CROSS_MAX));
  check('zigzag: the two ties weld continuously over the full 30 mm, not at points',
    !!weld && weld.n === 2 && near(weld.area, 8.37, 1e-3) && weld.extent === '30.00 x 1.60',
    weld ? 'x' + weld.n + ' ' + f(weld.area) + ' mm^2 at ' + weld.extent + ' mm' : 'not found');
  check('zigzag: the stack is ' + f(shipped.zigzag.stackHeight / (2 * LINE_H), 2) + 'x as thick as two real layers',
    near(shipped.zigzag.stackHeight, 2.04, 1e-6), f(shipped.zigzag.stackHeight, 3) + ' mm vs ' + f(2 * LINE_H, 2));
}

/* the crosshatch, where the answer is a DIFFERENT one and worth separating */
{
  const ct = shipped.crosshatch.contact;
  check('crosshatch: the whole tip area welds - one patch spanning the entire footprint',
    ct.patches === 1 && near(ct.area, ct.areaA, 1e-3) && near(ct.maxPatchSpan, SIZE, 1e-4),
    f(ct.area, 3) + ' mm^2 = 100.0% of its ' + f(ct.areaA, 3) + ' mm^2 of tips, span ' + f(ct.maxPatchSpan, 2) + ' mm');
  check('crosshatch: that is ' + Math.round(ct.area / FLAT_CROSS) + ' crossings\' worth of bonding in ONE weld',
    ct.area / FLAT_CROSS > 2000, f(ct.area, 1) + ' / ' + f(FLAT_CROSS));
}

/* ------------------------------------------------------------------ part 3 */
console.log('\n=== 3. the control: change the SECTION and nothing else ===');
console.log('  Same 15 ridges, same 2.0 mm pitch, same 90 deg crossing, ties off. The only');
console.log('  thing that changes is which end of the sawtooth meets the interface.');
{
  const base = stackAndMeasure({ variant: 'loose', pattern: 'zigzag', ties: 0 }, 90, false);
  const crest = stackAndMeasure({ variant: 'loose', pattern: 'zigzag', ties: 0 }, 90, true);
  const gb = groupPatches(base.contact)[0], gc = groupPatches(crest.contact)[0];
  console.log('    upper copy BASE down (as a relief prints): ' + f(base.contact.area, 3) + ' mm^2, ' +
    base.contact.patches + ' crossings of ' + f(gb.area) + ' at ' + gb.extent + ' mm');
  console.log('    upper copy CREST down (a symmetric section): ' + f(crest.contact.area, 3) + ' mm^2, ' +
    crest.contact.patches + ' crossings of ' + f(gc.area) + ' at ' + gc.extent + ' mm');
  check('the path and the angle are untouched: the same 225 crossings either way',
    base.contact.patches === 225 && crest.contact.patches === 225,
    base.contact.patches + ' / ' + crest.contact.patches);
  check('a symmetric section lands EXACTLY on the flat line\'s figure, 0.42 x 0.42 mm',
    near(gc.area, FLAT_CROSS, 1e-6) && near(crest.contact.area, 225 * FLAT_CROSS, 2e-3),
    f(gc.area) + ' mm^2 per crossing, ' + f(crest.contact.area, 3) + ' mm^2 total vs the flat ' +
    f(225 * FLAT_CROSS, 3));
  check('the tapered section is ' + f(gb.area / gc.area, 3) + 'x that, and the ratio IS base/tip = 1.2/0.42',
    near(gb.area / gc.area, 1.2 / 0.42, 1e-6), f(gb.area / gc.area, 6));

  /* and it scales with the base width, linearly, path and angle fixed */
  console.log('  Contact against the base width alone, taper kept, tip fixed at 0.42:');
  for (const b of [1.2, 0.9, 0.6]) {
    const s = stackAndMeasure({ variant: 'loose', pattern: 'zigzag', ties: 0, params: { base: b } }, 90);
    const g = groupPatches(s.contact)[0];
    console.log('    base ' + f(b, 2) + ' mm -> ' + f(g.area) + ' mm^2 per crossing at ' + g.extent +
      ' mm, ' + f(s.contact.area, 3) + ' mm^2 total');
    check('  base ' + f(b, 2) + ': the crossing is 0.42 x base, to the digit',
      near(g.area, 0.42 * b, 1e-6) && s.contact.patches === 225, f(g.area) + ' vs ' + f(0.42 * b));
  }
}

/* ------------------------------------------------------------------ part 4 */
console.log('\n=== 4. the verdict ===');
{
  const zz = groupPatches(shipped.zigzag.contact).find(x => x.n > 100);
  const ratio = zz.area / FLAT_CROSS;
  console.log('  zigzag - the pattern whose path shape IS a printed layer\'s (parallel, one');
  console.log('  direction, crossed 90 deg by the layer above):');
  console.log('    crossing contact   shipped ' + f(zz.area) + ' mm^2   vs real flat line ' +
    f(FLAT_CROSS) + ' mm^2   = ' + f(ratio, 3) + 'x');
  console.log('    whole interface    shipped ' + f(shipped.zigzag.contact.area, 3) + ' mm^2   vs ' +
    f(225 * FLAT_CROSS, 3) + ' mm^2   = ' +
    f(shipped.zigzag.contact.area / (225 * FLAT_CROSS), 3) + 'x');
  console.log('    interface height   shipped ' + f(shipped.zigzag.stackHeight, 2) + ' mm      vs ' +
    f(2 * LINE_H, 2) + ' mm          = ' + f(shipped.zigzag.stackHeight / (2 * LINE_H), 2) + 'x');
  console.log('  CONFIRMED: the excess is the SECTION. The control in part 3 holds the path and');
  console.log('  the angle fixed and recovers the flat line\'s figure exactly by presenting a');
  console.log('  symmetric 0.42 mm end to the interface instead of the sawtooth\'s 1.2 mm base.');
  console.log('');
  console.log('  crosshatch - and here the honest answer is a DIFFERENT one, which the ticket\'s');
  console.log('  diagnosis does not cover and which this audit will not fold in with it:');
  console.log('    its ribs are PRISMATIC - 0.42 mm at the top and 0.42 at the bottom - so the');
  console.log('    section is not the fault. Its fault is that ONE layer already carries ribs');
  console.log('    BOTH ways, so a 90 deg copy\'s underside is the same lattice as the layer');
  console.log('    below\'s tips and the two coincide instead of crossing: ' +
    f(shipped.crosshatch.contact.area, 1) + ' mm^2 in one');
  console.log('    weld. A real layer runs lines in one direction; the crossing comes from the');
  console.log('    NEXT layer. So crosshatch needs a one-direction path, zigzag needs a flat');
  console.log('    section, and the importer below gives both by taking the path from a raster');
  console.log('    and the section from the measured numbers.');

  check('the ticket\'s diagnosis holds on the zigzag: the section, not the path or the angle',
    near(ratio, 1.2 / 0.42, 1e-6), f(ratio, 6) + 'x');
  check('and the crosshatch\'s excess is NOT the section - its rib is 0.42 top and bottom',
    near(shipped.crosshatch.patch.minWall, 0.42, 1e-9) &&
    near(shipped.crosshatch.patch.tipWall, 0.42, 1e-9),
    'wall ' + shipped.crosshatch.patch.minWall + ' -> tip ' + shipped.crosshatch.patch.tipWall + ' mm');
}

console.log('\n' + (fails ? fails + ' CHECK(S) FAILED' : 'all checks held') + '\n');
process.exit(fails ? 1 : 0);
