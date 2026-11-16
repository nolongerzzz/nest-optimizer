/* nso_interlock.js - keys and sockets as solids, headless.
     node tools/nso_interlock_test.js        exit 0 = every gate held

   Pinned, for every shape, with and without an ease:
   1. the key and its cutter are closed and consistently wound - every
      directed edge is met exactly once by its reverse - with no degenerate
      triangle, and the signed volume is positive and is the volume the
      dimensions give by hand;
   2. the key runs from -embed to exactly `height`, and spans exactly
      length x width (diameter for a pin; width + 2 catch for a snap);
   3. the cutter is the key grown by `fit` per side - its span is the key's
      plus 2 fit - and runs exactly from `from` to `to`;
   4. every vertex of the key above its face is strictly inside the cutter's
      side walls by `fit` or more (checked on the section, not on boxes);
   5. place() is rigid: volume kept, the frame's axes honoured, a 90 degree
      turn swaps the spans; halfSpan() is what the placed solid measures;
   6. check() refuses what cannot be built, in words. */
const path = require('path');
const IL = require(path.join(__dirname, '..', 'nso_interlock.js'));

let fails = 0;
const check = (name, cond, detail) => { console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : '')); if (!cond) fails++; };
const near = (a, b, t) => Math.abs(a - b) <= t;

function topology(s) {
  const key = (x, y, z) => Math.round(x * 1e5) + ',' + Math.round(y * 1e5) + ',' + Math.round(z * 1e5);
  const edges = new Map();
  let degenerate = 0;
  for (let i = 0; i < s.length; i += 9) {
    const v = [key(s[i], s[i + 1], s[i + 2]), key(s[i + 3], s[i + 4], s[i + 5]), key(s[i + 6], s[i + 7], s[i + 8])];
    const ax = s[i + 3] - s[i], ay = s[i + 4] - s[i + 1], az = s[i + 5] - s[i + 2], bx = s[i + 6] - s[i], by = s[i + 7] - s[i + 1], bz = s[i + 8] - s[i + 2];
    if (Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) < 1e-9) degenerate++;
    for (let k = 0; k < 3; k++) { const e = v[k] + '>' + v[(k + 1) % 3]; edges.set(e, (edges.get(e) || 0) + 1); }
  }
  let bad = 0;
  for (const [e, n] of edges) { const [a, b] = e.split('>'); if (n !== 1 || edges.get(b + '>' + a) !== 1) bad++; }
  return { bad, degenerate, tris: s.length / 9 };
}
function box(s) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < s.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], s[i + k]); hi[k] = Math.max(hi[k], s[i + k]); }
  return { lo, hi, size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] };
}

const EMBED = 0.4;
const CASES = [
  { name: 'tongue 25 x 5 x 2, no ease', spec: { shape: 'tongue', length: 25, width: 5, height: 2, ease: 0, fit: 0.1 },
    vol: s => 25 * 5 * (2 + EMBED), span: [25, 5] },
  { name: 'tongue 25 x 5 x 2, ease 0.4', spec: { shape: 'tongue', length: 25, width: 5, height: 2, ease: 0.4, fit: 0.1 },
    /* a box to the ease, then a frustum: h/3 (A1 + A2 + sqrt(A1 A2)) is only for similar ends, so by prismatoid: h/6 (A1 + 4 Am + A2) */
    vol: s => 25 * 5 * (2 - 0.4 + EMBED) + 0.4 / 6 * (25 * 5 + 4 * 24.6 * 4.6 + 24.2 * 4.2), span: [25, 5] },
  { name: 'pin 6 x 8, ease 0.5', spec: { shape: 'pin', diameter: 6, height: 8, ease: 0.5, fit: 0.15 },
    vol: s => { const A = r => 64 / 2 * r * r * Math.sin(2 * Math.PI / 64); return A(3) * (8 - 0.5 + EMBED) + 0.5 / 3 * (A(3) + A(2.5) + Math.sqrt(A(3) * A(2.5))); }, span: [6, 6] },
  { name: 'snap 12 x 4 x 5, ease 0.4, catch 0.5', spec: { shape: 'snap', length: 12, width: 4, height: 5, ease: 0.4, fit: 0.1, catch: 0.5 },
    /* section: the bar less its two eased corners plus two ridge triangles (base 1, height 0.5) */
    vol: s => 12 * (4 * (5 + EMBED) - 2 * (0.4 * 0.4 / 2) + 2 * (1 * 0.5 / 2)), span: [12, 5] }
];

for (const c of CASES) {
  console.log('\n--- ' + c.name + ' ---');
  const k = IL.key(c.spec, { embed: EMBED });
  check('the key builds', k.ok === true, k.reason);
  if (!k.ok) continue;
  let t = topology(k.soup), b = box(k.soup);
  check('key: closed, consistently wound, no degenerate triangle', t.bad === 0 && t.degenerate === 0, JSON.stringify(t));
  check('key: volume is what the dimensions give (1e-3)', k.volume > 0 && near(k.volume, c.vol(c.spec), 1e-3), k.volume + ' vs ' + c.vol(c.spec));
  check('key: runs from -embed to exactly the height', near(b.lo[2], -EMBED, 1e-6) && near(b.hi[2], c.spec.height, 1e-6), b.lo[2] + ' .. ' + b.hi[2]);
  check('key: spans exactly ' + c.span.join(' x '), near(b.size[0], c.span[0], 1e-5) && near(b.size[1], c.span[1], 1e-5), b.size.slice(0, 2).join(' x '));
  const to = c.spec.height + c.spec.fit;
  const q = IL.cutter(c.spec, { from: -0.2, to });
  check('the cutter builds', q.ok === true, q.reason);
  t = topology(q.soup); const cb = box(q.soup);
  check('cutter: closed, consistently wound, no degenerate triangle', t.bad === 0 && t.degenerate === 0 && q.volume > 0, JSON.stringify(t));
  check('cutter: the key\'s span plus 2 x fit', near(cb.size[0], c.span[0] + 2 * c.spec.fit, 1e-5) && near(cb.size[1], c.span[1] + 2 * c.spec.fit, 1e-5), cb.size.slice(0, 2).join(' x '));
  check('cutter: runs exactly from `from` to `to`', near(cb.lo[2], -0.2, 1e-6) && near(cb.hi[2], to, 1e-6));
  /* every key vertex above the face, against the cutter's own walls at that height */
  let worst = Infinity;
  const wallAt = (z) => {         // the cutter's half-width in y at height z
    if (c.spec.shape !== 'snap') return c.spec.shape === 'pin' ? null : c.spec.width / 2 + c.spec.fit;
    const w = c.spec.width / 2 + c.spec.fit, hb = IL.snapPeak(c.spec), kk = c.spec.catch;
    return w + Math.max(0, kk - Math.abs(z - hb));
  };
  for (let i = 0; i < k.soup.length; i += 3) {
    const x = k.soup[i], y = k.soup[i + 1], z = k.soup[i + 2];
    if (z < 0) continue;
    if (c.spec.shape === 'pin') worst = Math.min(worst, (c.spec.diameter / 2 + c.spec.fit) - Math.hypot(x, y));
    else worst = Math.min(worst, (c.spec.length / 2 + c.spec.fit) - Math.abs(x), wallAt(z) - Math.abs(y));
  }
  check('every part of the key is at least `fit` inside the socket\'s walls', worst >= c.spec.fit - 1e-6, worst);
}

console.log('\n--- place() and halfSpan() ---');
{
  const spec = { shape: 'tongue', length: 25, width: 5, height: 2, ease: 0.4, fit: 0.1 };
  const k = IL.key(spec, { embed: EMBED });
  const frame = { o: [10, 20, 30], u: [0, 0, 1], v: [1, 0, 0], n: [0, 1, 0] };      // u x v = n
  const p0 = IL.place(k.soup, frame, 0), p90 = IL.place(k.soup, frame, 90), p30 = IL.place(k.soup, frame, 30);
  const b0 = box(p0), b90 = box(p90), b30 = box(p30);
  check('rigid: volume kept, still outward (1e-3)', near(IL.signedVolume(p0), k.volume, 1e-3) && near(IL.signedVolume(p30), k.volume, 1e-3));
  check('length lies along u, width along v, height along n from the face', near(b0.size[2], 25, 1e-4) && near(b0.size[0], 5, 1e-4) && near(b0.hi[1], 22, 1e-5) && near(b0.lo[1], 20 - EMBED, 1e-5), JSON.stringify(b0.size));
  check('centred on o', near((b0.lo[0] + b0.hi[0]) / 2, 10, 1e-5) && near((b0.lo[2] + b0.hi[2]) / 2, 30, 1e-5));
  check('a 90 degree turn swaps the spans', near(b90.size[2], 5, 1e-4) && near(b90.size[0], 25, 1e-4));
  const h30 = IL.halfSpan(spec, 30);
  check('halfSpan is what the placed solid measures at 30 degrees (1e-4)', near(b30.size[2], 2 * h30.u, 1e-4) && near(b30.size[0], 2 * h30.v, 1e-4), JSON.stringify(h30));
  const hs = IL.halfSpan({ shape: 'snap', length: 12, width: 4, height: 5, catch: 0.5 }, 0);
  check('a snap\'s span across includes its two ridges', near(hs.u, 6, 1e-9) && near(hs.v, 2.5, 1e-9));
}

console.log('\n--- what cannot be built ---');
{
  const r = (spec) => IL.key(spec, {});
  check('no height', r({ shape: 'tongue', length: 5, width: 5, height: 0 }).ok === false);
  check('no width', r({ shape: 'tongue', length: 5, width: 0, height: 2 }).ok === false);
  check('no diameter', r({ shape: 'pin', diameter: 0, height: 2 }).ok === false);
  const s = r({ shape: 'snap', length: 10, width: 4, height: 1.2, ease: 0.4, catch: 0.5 });
  check('a snap too short for its catch, with the height it needs in words', s.ok === false && /at least 2\.00 mm/.test(s.reason), s.reason);
  check('an ease bigger than the key is cut down, not refused', r({ shape: 'tongue', length: 5, width: 2, height: 1, ease: 9 }).ok === true);
  check('a cutter with no depth is refused', IL.cutter({ shape: 'pin', diameter: 4, height: 2 }, { from: 1, to: 1 }).ok === false);
  const plain = IL.cutter({ shape: 'snap', length: 12, width: 4, height: 5, ease: 0.4, fit: 0.1, catch: 0.5 }, { from: 3.9, to: 5.1 });
  check('a snap socket whose groove would break out of its mouth is a plain slot', plain.ok && near(box(plain.soup).size[1], 4.2, 1e-5));
  check('the words: key and socket', IL.describe({ shape: 'tongue', length: 25, width: 5, height: 2, fit: 0.1 }, 'key') === 'tongue 25.00 × 5.00 × 2.00' &&
    IL.describe({ shape: 'tongue', length: 25, width: 5, height: 2, fit: 0.1 }, 'socket') === 'slot 25.20 × 5.20 × 2.10');
}

console.log('\n' + (fails ? fails + ' gate(s) FAILED' : 'all gates held'));
process.exit(fails ? 1 : 0);
