/* The REAL test images: drawn by Chromium's own Canvas 2D, exported as real
 * PNG and JPEG files, and committed.
 *
 *     node tools/nso_raster_real_fixtures.mjs          (re)draw fixtures/raster-real/
 *
 * WHY THIS IS NOT tools/nso_raster_fixtures.js AGAIN. That generator draws the
 * reference interface with this repo's own stroke() (nso_raster_fixtures.js:112)
 * at this repo's own constants - the shipped zigzag's pitch, 15 lines, and an
 * angle the tracer was built around. It is the tool's own output fed back to
 * it, which is worth having as a regression pin and is worth nothing as
 * evidence that the tracer reads a picture somebody else drew.
 *
 * These are that evidence. Every one is:
 *   - rasterised by Chromium's Skia, not by any code in this repo,
 *   - antialiased, because a real drawing program antialiases,
 *   - at angles chosen to be awkward - 23, 67, 113 degrees - never 0, 45 or 90,
 *   - encoded as a real PNG or a real JPEG, the two formats a person uploads,
 *   - and committed as binary, so the checks never need Chromium to re-draw
 *     them. They are fixed artefacts now, the way a scanned drawing would be.
 *     This generator is kept for provenance, not as a --check gate: Skia's
 *     antialiasing is not promised to be byte-stable across Chromium versions
 *     and a byte-diff gate on it would fail for the wrong reason.
 *
 * GROUND TRUTH. Each image ships with what it REALLY contains, in
 * fixtures/raster-real/ground-truth.json, taken from the drawing instructions -
 * where the endpoints were put - and not from anything the tracer reported.
 * tools/nso_raster_image_probe.js then measures the same facts back off the
 * source PIXELS independently, so the check has two witnesses that never
 * consulted the tracer.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'fixtures', 'raster-real');

/* Canvas y runs DOWN; the plate's +Y runs UP and buildFromImage flips it
 * (nso_raster_lines.js:951). So a stroke drawn (x0,y0)->(x1,y1) on the canvas
 * runs at atan2(-(y1-y0), x1-x0) in the finished solid. Every ground-truth
 * angle below is computed through this function, never typed in by hand. */
function plateAngle(x0, y0, x1, y1) {
  const deg = Math.atan2(-(y1 - y0), x1 - x0) * 180 / Math.PI;
  return ((deg % 180) + 180) % 180;
}

const PPMM = 20;            /* px per mm - the scale the checks build at */

/* Endpoints are given in px on a SIZE x SIZE canvas. */
const SIZE = 500;

/* A point at `deg` from centre, `r` px out, in CANVAS coords (y down). */
function ray(deg, r) {
  const t = deg * Math.PI / 180;
  return [SIZE / 2 + r * Math.cos(t), SIZE / 2 - r * Math.sin(t)];
}

/* ------------------------------------------------------------------ images */
/* Each: { name, format, quality?, draw (runs IN the browser), truth }.
   `truth` is what the picture really shows, from the endpoints above. */

const A = ray(23, 200), A2 = ray(23 + 180, 200);
const B = ray(67, 200), B2 = ray(67 + 180, 200);

const IMAGES = [
  {
    /* Two straight strokes crossing at 23 and 67 degrees - deliberately NOT
       perpendicular and NOT any angle the tracer's own fixtures use. Drawn at
       two DIFFERENT stroke widths in one picture, because the printed width
       must come back 0.42 mm for both. */
    name: 'skew-cross', format: 'png',
    segs: [[A2, A], [B2, B]],
    widths: [9, 15],
    truth: {
      shows: 'two straight strokes crossing once, at 23 and 67 degrees, drawn 9 px and 15 px wide',
      angles: [plateAngle(...A2, ...A), plateAngle(...B2, ...B)],
      components: 1, junctions: 1,
      drawnStrokePx: [9, 15]
    }
  },
  {
    /* The SAME two lines, both drawn thin. Same geometry, different ink: the
       traced angles and the printed width must not move. */
    name: 'skew-cross-thin', format: 'png',
    segs: [[A2, A], [B2, B]],
    widths: [5, 5],
    truth: {
      shows: 'the same two strokes as skew-cross, both drawn 5 px wide',
      angles: [plateAngle(...A2, ...A), plateAngle(...B2, ...B)],
      components: 1, junctions: 1,
      drawnStrokePx: [5, 5]
    }
  },
  {
    /* Two strokes that do NOT touch: parallel at 113 degrees, well apart.
       Connectivity ground truth that is not 1 - a tracer that welds things
       that are not joined fails here and nowhere else. */
    name: 'two-apart', format: 'png',
    segs: (() => {
      const d = 113 * Math.PI / 180;
      const ux = Math.cos(d), uy = -Math.sin(d);
      const nx = -uy, ny = ux;                    /* canvas-space normal */
      const mk = (off) => {
        const cx = SIZE / 2 + nx * off, cy = SIZE / 2 + ny * off;
        return [[cx - ux * 180, cy - uy * 180], [cx + ux * 180, cy + uy * 180]];
      };
      return [mk(-70), mk(70)];
    })(),
    widths: [7, 7],
    truth: {
      shows: 'two parallel strokes at 113 degrees, 140 px apart, touching nothing',
      angles: [113], components: 2, junctions: 0, drawnStrokePx: [7, 7]
    }
  },
  {
    /* two-apart drawn FAT - the same two lines, 17 px instead of 7. Isolated
       parallel strokes are the one shape whose printed WIDTH can be measured
       off the mesh exactly (project onto the lines' normal; each band's spread
       IS the width), so this pair is what proves the module's central claim:
       the drawn stroke width is discarded and the printed width is the one the
       caller asked for, whatever the picture was drawn with. */
    name: 'two-apart-fat', format: 'png',
    segs: (() => {
      const d = 113 * Math.PI / 180;
      const ux = Math.cos(d), uy = -Math.sin(d);
      const nx = -uy, ny = ux;
      const mk = (off) => {
        const cx = SIZE / 2 + nx * off, cy = SIZE / 2 + ny * off;
        return [[cx - ux * 180, cy - uy * 180], [cx + ux * 180, cy + uy * 180]];
      };
      return [mk(-70), mk(70)];
    })(),
    widths: [17, 17],
    truth: {
      shows: 'the same two strokes as two-apart, drawn 17 px wide instead of 7',
      angles: [113], components: 2, junctions: 0, drawnStrokePx: [17, 17]
    }
  },
  {
    /* A hand-drawn-looking stroke: wobbled off a straight 23 degree line by a
       few px, drawn with a pressure-varying width, then saved as a JPEG over
       an off-white paper background. Antialiasing, compression ringing and a
       background that is not 255 - all three at once, which is what an
       uploaded photo of a sketch actually is. */
    name: 'hand-stroke', format: 'jpeg', quality: 0.82,
    wobble: { deg: 23, r: 190, amp: 5, waves: 3.5, w0: 6, w1: 13 },
    paper: '#f2efe8',
    truth: {
      shows: 'one hand-drawn wobbly stroke about 23 degrees, pressure-varying width, JPEG on off-white paper',
      angles: [23], components: 1, junctions: 0, drawnStrokePx: [6, 13],
      /* A wobbled stroke does not have ONE angle and must not be checked as
         though it did. Its offset is amp sin(waves pi s) across a half-length
         r, so its steepest tangent is atan(amp waves pi / r) away from the
         stroke's overall direction - the exact range its traced lines should
         cover, computed here from the drawing parameters and nowhere else. */
      tangentRange: (function () {
        const { deg, r, amp, waves } = { deg: 23, r: 190, amp: 5, waves: 3.5 };
        const swing = Math.atan(amp * waves * Math.PI / r) * 180 / Math.PI;
        return [deg - swing, deg + swing];
      })()
    }
  }
];

/* The wobbly stroke again, as a PNG. Same drawing, losslessly: the JPEG is
 * what the browser check opens (it is the shipped decoder and the realistic
 * upload), and this twin is what Node can read, so the same hand-drawn shape
 * reaches tools/nso_raster_real_test.js and the library sample generator. It
 * is appended rather than written as a second spec so the two really are one
 * drawing and cannot drift apart. */
IMAGES.push({
  ...IMAGES.find(x => x.name === 'hand-stroke'),
  name: 'hand-stroke', format: 'png', quality: undefined,
  truth: {
    ...IMAGES.find(x => x.name === 'hand-stroke').truth,
    shows: 'the same hand-drawn wobbly stroke as hand-stroke.jpg, saved losslessly as PNG',
    pngTwinOf: 'hand-stroke.jpg'
  }
});

/* ------------------------------------------------------------------- draw */

const PAGE = `<!doctype html><meta charset="utf-8"><body style="margin:0"><canvas id="c"></canvas>`;

async function render(page, spec) {
  return await page.evaluate(({ spec, SIZE }) => {
    const c = document.getElementById('c');
    c.width = SIZE; c.height = SIZE;
    const g = c.getContext('2d');
    g.fillStyle = spec.paper || '#ffffff';
    g.fillRect(0, 0, SIZE, SIZE);
    g.strokeStyle = '#111111';
    g.lineCap = 'round';
    g.lineJoin = 'round';

    if (spec.segs) {
      spec.segs.forEach((s, i) => {
        g.lineWidth = spec.widths[i];
        g.beginPath();
        g.moveTo(s[0][0], s[0][1]);
        g.lineTo(s[1][0], s[1][1]);
        g.stroke();
      });
    }

    if (spec.wobble) {
      /* one stroke, laid down as many short overlapping segments so the width
         can vary along it the way a pen's does */
      const { deg, r, amp, waves, w0, w1 } = spec.wobble;
      const t = deg * Math.PI / 180;
      const ux = Math.cos(t), uy = -Math.sin(t);
      const nx = -uy, ny = ux;
      const N = 240;
      const pt = (k) => {
        const s = (k / N) * 2 - 1;                       /* -1 .. 1 */
        const off = Math.sin(s * waves * Math.PI) * amp;
        return [SIZE / 2 + ux * r * s + nx * off, SIZE / 2 + uy * r * s + ny * off];
      };
      for (let k = 0; k < N; k++) {
        const a = pt(k), b = pt(k + 1);
        g.lineWidth = w0 + (w1 - w0) * (0.5 - 0.5 * Math.cos(k / N * Math.PI * 2));
        g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
      }
    }

    return c.toDataURL(spec.format === 'jpeg' ? 'image/jpeg' : 'image/png',
      spec.quality == null ? undefined : spec.quality);
  }, { spec, SIZE });
}

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(PAGE);
mkdirSync(OUT, { recursive: true });

const index = { note: 'Drawn by Chromium Canvas 2D, not by this repo. Ground truth is from the drawing instructions in tools/nso_raster_real_fixtures.mjs, never from the tracer.', pxPerMM: PPMM, canvas: SIZE, images: [] };

for (const spec of IMAGES) {
  const url = await render(page, spec);
  const b64 = url.slice(url.indexOf(',') + 1);
  const buf = Buffer.from(b64, 'base64');
  const file = spec.name + '.' + (spec.format === 'jpeg' ? 'jpg' : 'png');
  writeFileSync(join(OUT, file), buf);
  index.images.push({ file, format: spec.format, bytes: buf.length, ...spec.truth });
  console.log('  wrote ' + file + '  (' + buf.length + ' bytes)  ' + spec.truth.shows);
}

writeFileSync(join(OUT, 'ground-truth.json'), JSON.stringify(index, null, 2) + '\n');
console.log('\nwrote ground-truth.json - ' + index.images.length + ' images');
await browser.close();
