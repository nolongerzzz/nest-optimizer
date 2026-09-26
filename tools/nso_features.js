/* Controlled feature generation: put real functional features - a flange, a
 * handle, a bracket, a lid, a hinge - on ONE known-clean base hull, each built
 * from an explicit geometric definition, and say in advance exactly what the
 * result is: where each feature is, where it meets the hull (its root), and
 * what the canonical checker (tools/mesh_validate.py) will read off the whole.
 *
 * The architecture is tools/nso_damage.js's, reused rather than reinvented
 * (docs/FEATURES.md has the side-by-side):
 *
 *   nso_damage.js                        nso_features.js
 *   a named, parameterized damage type   a named, parameterized feature type
 *   refuses a dirty input                refuses parameters that are not the
 *                                        feature it names, with the reason
 *   `expected`: the exact census, from   `expected`: the same census (its own
 *   topology the tool BUILT              exactIndex/census), plus volume and
 *                                        area, from what each feature DECLARES
 *   `sites`: where the damage went       `features`: where each one went - its
 *                                        root, its cell, its ground truth
 *   sever: kernel output checked twice   every composition checked the same
 *   and refused if it is not exactly     way, and refused if the kernel's
 *   what was promised                    census, chi or volume is not what the
 *                                        definitions add up to
 *
 *   const FX = require('./nso_features.js');
 *   const p = await FX.build({ features: [{ type: 'flange' }, { type: 'handle' }] });
 *   p.soup       Float32Array, 9 floats per triangle - the whole test piece
 *   p.expected   what mesh_validate.py --json must report on p.soup
 *   p.features   per feature: type, face, params, root, cell, volume, truth
 *   await FX.detach(p.soup, p.features[0])   -> { feature, host } soups
 *   await FX.reattach(host, feature)         -> the piece again
 *
 * THE FRAME. The hull is a box resting on z = 0, centred on x and y. Each
 * feature sits on one face and is built in that face's own frame (u, v, w):
 * w is the outward normal, u and v lie in the face (v is +Z on the side
 * faces), u x v = w, and the face itself is w = 0 with the hull at w < 0. The
 * frame is taken to the world by a signed permutation - an exact transform,
 * so no coordinate is moved by rounding on the way.
 *
 * THE CELL. Every feature lives in a cell: the box over its own footprint,
 * out from the face, plus (for the lid) the air round its plug in the pocket. A
 * cell holds none of the hull and none of any other feature - that is
 * checked, and two cells that overlap are refused - so the piece inside a
 * cell IS the feature, and where the cell meets the hull IS its root.
 * detach() separates exactly that, reading nothing but the soup and the
 * manifest, and caps both sides on the root: the reference a Detach /
 * Reattach operation is held to.
 *
 * Node only; not shipped. Every choice is a function of the parameters, so
 * the same call writes the same bytes. */
'use strict';

const D = require('./nso_damage.js');

const HOST = { size: [120, 70, 40] };

/* Outward normal W and in-face axes U, V, with U x V = W. No -z: that is the bed. */
const FACES = {
  '-x': { W: [-1, 0, 0], U: [0, -1, 0], V: [0, 0, 1] },
  '+x': { W: [1, 0, 0], U: [0, 1, 0], V: [0, 0, 1] },
  '-y': { W: [0, -1, 0], U: [1, 0, 0], V: [0, 0, 1] },
  '+y': { W: [0, 1, 0], U: [-1, 0, 0], V: [0, 0, 1] },
  '+z': { W: [0, 0, 1], U: [1, 0, 0], V: [0, 1, 0] }
};

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const absDot = (e, s) => Math.abs(e[0]) * s[0] + Math.abs(e[1]) * s[1] + Math.abs(e[2]) * s[2];
const r9 = x => Math.round(x * 1e9) / 1e9;

function refuse(type, why) { throw new Error(type + ': not a ' + type + ' - ' + why); }

/* The face's frame on a host box: centre C of the face, its extents along U
   and V, and the host's depth behind it. */
function frame(host, face) {
  const f = FACES[face];
  if (!f) throw new Error('unknown face "' + face + '" (' + Object.keys(FACES).join(', ') + ')');
  const s = host.size;
  const centre = [0, 0, s[2] / 2];
  const dw = absDot(f.W, s);
  const C = [0, 1, 2].map(i => centre[i] + f.W[i] * dw / 2);
  return Object.assign({ face, C, Fu: absDot(f.U, s), Fv: absDot(f.V, s), Dw: dw }, f);
}
/* local (u, v, w) -> world, and the same as a Manifold column-major 4x4. */
function toWorld(F, p) {
  return [0, 1, 2].map(i => F.C[i] + p[0] * F.U[i] + p[1] * F.V[i] + p[2] * F.W[i]);
}
function mat(F) {
  return [F.U[0], F.U[1], F.U[2], 0, F.V[0], F.V[1], F.V[2], 0, F.W[0], F.W[1], F.W[2], 0, F.C[0], F.C[1], F.C[2], 1];
}
/* A local box [u0,u1] x [v0,v1] x [w0,w1] as a world AABB. */
function worldBox(F, b) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < 8; k++) {
    const p = toWorld(F, [b[0][k & 1], b[1][(k >> 1) & 1], b[2][(k >> 2) & 1]]);
    for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]); }
  }
  return { lo: lo.map(r9), hi: hi.map(r9) };
}

/* ------------------------------------------------------------ primitives */

function box(w, b) {
  return w.Manifold.cube([b[0][1] - b[0][0], b[1][1] - b[1][0], b[2][1] - b[2][0]], false)
    .translate([b[0][0], b[1][0], b[2][0]]);
}
/* A closed mesh from vertices and outward-wound triangles. */
function fromTris(w, verts, tris) {
  const vp = new Float32Array(verts.length * 3);
  verts.forEach((p, i) => vp.set(p, i * 3));
  const mesh = new w.Mesh({ numProp: 3, vertProperties: vp, triVerts: Uint32Array.from(tris.flat()) });
  mesh.merge();
  const m = new w.Manifold(mesh);
  if (m.status() !== 'NoError') throw new Error('internal: a primitive is not a closed solid (' + m.status() + ')');
  return m;
}
/* n-gon cylinder of radius r along local u, from u0 to u1, axis at (v, w).
   A vertex points along +v, so a box edge at v = +-h (h < r) crosses the
   side walls instead of grazing a vertex. */
function cylU(w, r, u0, u1, v, wc, n) {
  return w.Manifold.cylinder(u1 - u0, r, r, n, false)
    .transform([0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, u0, v, wc, 1]);
}
/* Triangular prism: the right triangle (w0, v0), (w0 + g, v0), (w0, v0 + g)
   in the (w, v) plane, from u0 to u1. */
function gusset(w, u0, u1, w0, v0, g) {
  const P = [[w0, v0], [w0 + g, v0], [w0, v0 + g]];
  const V = [];
  for (const u of [u0, u1]) for (const [ww, vv] of P) V.push([u, vv, ww]);
  // 0 1 2 at u0, 3 4 5 at u1; the triangle (w,v) is counter-clockwise, and
  // (w, v) -> (v, w) in (u, v, w) mirrors it, so the u0 face keeps 0 1 2.
  const T = [[0, 1, 2], [3, 5, 4], [0, 3, 4], [0, 4, 1], [1, 4, 5], [1, 5, 2], [2, 5, 3], [2, 3, 0]];
  let m = fromTris(w, V, T);
  if (m.volume() < 0) m = fromTris(w, V, T.map(t => [t[0], t[2], t[1]]));
  return m;
}
/* Half torus: a rod of radius r (an n-gon section) swept through 180 degrees
   of an arc of radius R in the (u, w) plane at height v, both ends ON w = 0.
   The ends' sines are exact zeros, so the feet lie exactly in the face. */
function arch(w, R, r, v, n, M) {
  const V = [], T = [];
  for (let j = 0; j <= M; j++) {
    const ph = Math.PI * j / M;
    const c = j === 0 ? 1 : j === M ? -1 : 2 * j === M ? 0 : Math.cos(ph);
    const s = j === 0 || j === M ? 0 : 2 * j === M ? 1 : Math.sin(ph);
    for (let k = 0; k < n; k++) {
      const th = 2 * Math.PI * k / n;
      const ct = 4 * k === n ? 0 : 2 * k === n ? -1 : 4 * k === 3 * n ? 0 : k === 0 ? 1 : Math.cos(th);
      const st = 4 * k === n ? 1 : 2 * k === n ? 0 : 4 * k === 3 * n ? -1 : k === 0 ? 0 : Math.sin(th);
      const rad = R + r * ct;
      V.push([rad * c, v + r * st, rad * s]);
    }
  }
  const id = (j, k) => j * n + (k % n);
  for (let j = 0; j < M; j++) for (let k = 0; k < n; k++) {
    // (d/d phi) x (d/d theta) points in toward the tube's centre line, so
    // walk the quad the other way round; both caps then face -w, outward.
    T.push([id(j, k), id(j + 1, k + 1), id(j + 1, k)]);
    T.push([id(j, k), id(j, k + 1), id(j + 1, k + 1)]);
  }
  for (let k = 1; k < n - 1; k++) {
    T.push([id(0, 0), id(0, k + 1), id(0, k)]);
    T.push([id(M, 0), id(M, k), id(M, k + 1)]);
  }
  const m = fromTris(w, V, T);
  if (!(m.volume() > 0)) throw new Error('internal: the arch is inside out');
  return m;
}
const ngonArea = (n, r) => n / 2 * r * r * Math.sin(2 * Math.PI / n);

/* ----------------------------------------------------------- feature types
 *
 * Each type is a definition, not just a shape:
 *   face       where it goes by default
 *   defaults   its parameters
 *   define(p, F)  refuses, with the reason, any parameters that do not make
 *                 the thing it names - a flange that does not stick out 3t,
 *                 a handle you cannot get a finger through
 *   make(w, p, F) builds it in the face frame and returns
 *                 solid    the feature (local)
 *                 recess   what it cuts into the hull, or null (local)
 *                 roots    the contact with the hull, as rectangles or
 *                          polygons on w = 0, and their total area
 *                 topology what it adds: host genus, enclosed voids, and
 *                          extra bodies (their genus)
 *                 truth    the type's own ground truth, for its detector
 */

const TYPES = {};

/* FLANGE - the rule nso_flange.js detects, turned into a generator: a flat
   plate of one thickness t, standing out `reach` from a face along a
   straight root `length` long, off a body that is thicker than it. Every
   clause of docs/GSCOPE-FLANGE.md's rule is a refusal here. */
TYPES.flange = {
  face: '-y',
  defaults: { t: 2.5, reach: 15, length: 60, u: 0, v: 0 },
  define(p, F) {
    if (!(p.t > 0)) refuse('flange', 'thickness must be > 0');
    if (!(p.reach >= 3 * p.t)) refuse('flange', 'it sticks out ' + p.reach + ' mm, under 3t = ' + 3 * p.t + ' ("wide")');
    if (!(p.length >= 2 * p.t)) refuse('flange', 'its root is ' + p.length + ' mm, under 2t ("attached")');
    if (!(F.Fv >= 2.5 * p.t)) refuse('flange', 'the body at the root is ' + F.Fv + ' mm, under 2.5t ("thin")');
    if (!(F.Dw >= 2.5 * p.t)) refuse('flange', 'the body behind the root is ' + F.Dw + ' mm deep, under 2.5t ("body")');
    if (Math.abs(p.v) + p.t / 2 > F.Fv / 2 - p.t) refuse('flange', 'the plate is not inside the face with a thickness of body on both sides');
    if (Math.abs(p.u) + p.length / 2 > F.Fu / 2) refuse('flange', 'the root runs off the face');
  },
  make(w, p, F) {
    const bu = [p.u - p.length / 2, p.u + p.length / 2], bv = [p.v - p.t / 2, p.v + p.t / 2];
    return {
      solid: box(w, [bu, bv, [0, p.reach]]),
      recess: null,
      roots: { rects: [[bu, bv]], area: p.length * p.t },
      topology: {},
      truth: {
        axis: F.V.slice(),
        thickness: p.t,
        band: [dot(F.C, F.V) + bv[0], dot(F.C, F.V) + bv[1]],
        reach: p.reach,
        root_length: p.length,
        root_normal: F.W.slice(),                 // out of the body, toward the flange
        root_offset: dot(F.C, F.W),
        bounds: worldBox(F, [bu, bv, [0, p.reach]])
      }
    };
  }
};

/* HANDLE - a rod, not a plate, that closes a loop with its host face: a
   grip standing `clear` off the face, carried to the face by two legs that
   meet it at two disjoint round feet. Here the loop is an arch - a half
   torus of rod radius r on an arc of radius R, feet 2R apart - so the
   opening is a half disc of radius R - r. What it adds is exactly one
   through-opening: genus + 1. Refused if the opening is narrower than the
   rod, which is a boss with a hole in it, not something you take hold of. */
TYPES.handle = {
  face: '-x',
  defaults: { r: 4, R: 25, u: 0, v: 0, sides: 24, arc: 24 },
  define(p, F) {
    if (!(p.r > 0)) refuse('handle', 'rod radius must be > 0');
    if (!(p.sides >= 8 && p.sides % 4 === 0)) refuse('handle', 'the rod section needs a multiple of 4 sides, >= 8');
    if (!(p.arc >= 4 && p.arc % 2 === 0)) refuse('handle', 'the arc needs an even number of segments, >= 4');
    if (!(p.R - p.r >= 2 * p.r)) refuse('handle', 'the opening (' + (p.R - p.r) + ' mm) is narrower than the rod (' + 2 * p.r + ' mm)');
    if (Math.abs(p.u) + p.R + p.r > F.Fu / 2 || Math.abs(p.v) + p.r > F.Fv / 2) refuse('handle', 'its feet are not on the face');
  },
  make(w, p, F) {
    const clear = p.R - p.r;
    return {
      solid: arch(w, p.R, p.r, p.v, p.sides, p.arc).translate([p.u, 0, 0]),
      recess: null,
      roots: {
        feet: [[p.u - p.R, p.v], [p.u + p.R, p.v]].map(c => ({ centre_local: c, centre: toWorld(F, [c[0], c[1], 0]).map(r9), radius: p.r, sides: p.sides })),
        area: 2 * ngonArea(p.sides, p.r)
      },
      topology: { host_genus: 1 },
      truth: {
        loop_plane_normal: F.V.slice(),           // the opening is in the (U, W) plane
        rod_radius: p.r,
        arc_radius: p.R,
        clear,                                    // face to the grip, at the middle
        opening_width: 2 * clear,                 // between the legs, at the face
        opening_centre: toWorld(F, [p.u, p.v, clear / 2]).map(r9),
        span: 2 * p.R,
        bounds: worldBox(F, [[p.u - p.R - p.r, p.u + p.R + p.r], [p.v - p.r, p.v + p.r], [0, p.R + p.r]])
      }
    };
  }
};

/* BRACKET - a braced angle: a mounting plate flat on the host face, an arm
   of the same thickness square to it along the plate's lower edge, and
   triangular gussets tying the arm to the plate - a triangulated cantilever.
   Its root is the plate's whole contact with the face, not a line.

   The gussets are the definition, not decoration. An angle WITHOUT them is a
   thin, flat plate standing straight off a thicker body along a line - which
   is exactly the flange rule, and nso_flange.js finds it as one. So an
   unbraced angle is refused here and made by its own type, `angle`, whose
   manifest says the flange detector must find its arm. */
function angleDefine(type, p, F, braced) {
  if (!(p.t > 0)) refuse(type, 'thickness must be > 0');
  if (!(p.arm >= 3 * p.t)) refuse(type, 'the arm projects ' + p.arm + ' mm, under 3t');
  if (!(p.height >= 3 * p.t)) refuse(type, 'the mounting plate is ' + p.height + ' mm tall, under 3t');
  if (!(p.width >= 2 * p.t)) refuse(type, 'it is ' + p.width + ' mm wide, under 2t');
  if (braced) {
    if (!(p.gussets === 2)) refuse(type, 'an angle without its gussets is a flange by nso_flange\'s rule - use type "angle" for that');
    if (!(p.gusset >= 2 * p.t && p.gusset <= Math.min(p.arm, p.height) - p.t)) {
      refuse(type, 'a gusset leg must be 2t .. min(arm, height) - t, got ' + p.gusset);
    }
    if (!(p.width >= 4 * p.t)) refuse(type, 'two gussets and room between them need 4t of width');
  }
  if (Math.abs(p.u) + p.width / 2 > F.Fu / 2) refuse(type, 'it runs off the face sideways');
  if (p.v0 < -F.Fv / 2 || p.v0 + p.height > F.Fv / 2) refuse(type, 'the mounting plate runs off the face');
}
function angleMake(w, p, F, braced) {
  const bu = [p.u - p.width / 2, p.u + p.width / 2];
  const bv = [p.v0, p.v0 + p.height];
  let m = box(w, [bu, bv, [0, p.t]]).add(box(w, [bu, [p.v0, p.v0 + p.t], [0, p.arm]]));
  if (braced) {
    m = m.add(gusset(w, bu[0], bu[0] + p.t, p.t, p.v0 + p.t, p.gusset))
         .add(gusset(w, bu[1] - p.t, bu[1], p.t, p.v0 + p.t, p.gusset));
  }
  const V = p.width * p.t * p.height + p.width * p.t * (p.arm - p.t) + (braced ? 2 * p.t * p.gusset * p.gusset / 2 : 0);
  return {
    solid: m,
    recess: null,
    roots: { rects: [[bu, bv]], area: p.width * p.height },
    topology: {},
    truth: {
      thickness: p.t,
      arm: { normal: F.V.slice(), top: dot(F.C, F.V) + p.v0 + p.t, projects: p.arm,
             bounds: worldBox(F, [bu, [p.v0, p.v0 + p.t], [0, p.arm]]) },
      plate: { normal: F.W.slice(), bounds: worldBox(F, [bu, bv, [0, p.t]]) },
      gussets: braced ? [bu[0], bu[1] - p.t].map(u0 => ({ leg: p.gusset, bounds: worldBox(F, [[u0, u0 + p.t], [p.v0 + p.t, p.v0 + p.t + p.gusset], [p.t, p.t + p.gusset]]) })) : [],
      volume_analytic: V,
      flange_expected: !braced,
      bounds: worldBox(F, [bu, bv, [0, p.arm]])
    }
  };
}
TYPES.bracket = {
  face: '+x',
  defaults: { t: 3, width: 40, height: 30, arm: 20, gusset: 14, gussets: 2, u: 0, v0: -15 },
  define(p, F) { angleDefine('bracket', p, F, true); },
  make(w, p, F) { return angleMake(w, p, F, true); }
};
TYPES.angle = {
  face: '+x',
  defaults: { t: 3, width: 40, height: 30, arm: 20, u: 0, v0: -15 },
  define(p, F) { angleDefine('angle', p, F, false); },
  make(w, p, F) { return angleMake(w, p, F, false); }
};

/* LID - a cover seated on the rim of an opening. The hull gets a pocket; the
   lid is a plate over it, `rim` wider all round, with a plug that drops into
   the pocket with `clear` all round and stops short of its floor. The only
   place it meets the hull is the seat - the rim ring - so lifting it along
   the seat frees it whole, and the plug is what locates it: it cannot slide
   further than `clear`. Seated, it closes the pocket: one enclosed void. */
TYPES.lid = {
  face: '+z',
  defaults: { pu: 60, pv: 40, depth: 15, rim: 6, t: 3, plug: 5, clear: 0.5, u: 0, v: 0 },
  define(p, F) {
    if (!(p.t > 0 && p.rim > 0)) refuse('lid', 'plate thickness and rim must be > 0');
    if (!(p.clear >= 0.05)) refuse('lid', 'the plug needs a real clearance (>= 0.05 mm), got ' + p.clear);
    if (!(p.plug > 0 && p.plug <= p.depth - p.clear)) refuse('lid', 'the plug must stop at least `clear` short of the pocket floor');
    if (!(p.pu > 2 * p.clear + 2 * p.t && p.pv > 2 * p.clear + 2 * p.t)) refuse('lid', 'the pocket is too small for a plug');
    if (!(p.depth < F.Dw - p.t)) refuse('lid', 'the pocket would go through the hull');
    if (Math.abs(p.u) + p.pu / 2 + p.rim > F.Fu / 2 || Math.abs(p.v) + p.pv / 2 + p.rim > F.Fv / 2) refuse('lid', 'the lid is bigger than the face');
  },
  make(w, p, F) {
    const pu = [p.u - p.pu / 2, p.u + p.pu / 2], pv = [p.v - p.pv / 2, p.v + p.pv / 2];
    const lu = [pu[0] - p.rim, pu[1] + p.rim], lv = [pv[0] - p.rim, pv[1] + p.rim];
    const gu = [pu[0] + p.clear, pu[1] - p.clear], gv = [pv[0] + p.clear, pv[1] - p.clear];
    const plateA = (lu[1] - lu[0]) * (lv[1] - lv[0]), pocketA = p.pu * p.pv, plugA = (gu[1] - gu[0]) * (gv[1] - gv[0]);
    return {
      solid: box(w, [lu, lv, [0, p.t]]).add(box(w, [gu, gv, [-p.plug, 0]])),
      recess: box(w, [pu, pv, [-p.depth, 0]]),
      /* The plug's half of the cell: every wall in the air around the plug -
         half the clearance in from the pocket's walls, half the floor gap up
         from its floor - so no face of it lies on a face of anything. */
      recessCell: [[pu[0] + p.clear / 2, pu[1] - p.clear / 2], [pv[0] + p.clear / 2, pv[1] - p.clear / 2],
                   [-(p.plug + (p.depth - p.plug) / 2), 0]],
      roots: { rings: [{ outer: [lu, lv], inner: [pu, pv] }], area: plateA - pocketA },
      topology: { voids: 1 },
      truth: {
        seat_normal: F.W.slice(),
        seat_offset: dot(F.C, F.W),
        clear: p.clear,
        plug_depth: p.plug,
        pocket: worldBox(F, [pu, pv, [-p.depth, 0]]),
        plate: worldBox(F, [lu, lv, [0, p.t]]),
        plug: worldBox(F, [gu, gv, [-p.plug, 0]]),
        void_volume: pocketA * p.depth - plugA * p.plug,
        volume_analytic: plateA * p.t + plugA * p.plug,
        bounds: worldBox(F, [lu, lv, [-p.plug, p.t]])
      }
    };
  }
};

/* HINGE - a print-in-place knuckle hinge: three coaxial knuckles of radius R
   and length k on an axis parallel to the face. The two outer ones are
   FIXED - each on a web to the face - and a pin of radius rp runs through
   all three, fused to the outer two. The middle one is MOVING: it turns on
   the pin with `clear` all round (radial), `gap` from its neighbours
   (axial), clears the face by `clear`, and carries a leaf `leaf` long. So
   the moving knuckle and its leaf are a second body, captive on the pin,
   free to turn. The webs are the root; the pin loop adds host genus 1 and
   the bored moving knuckle is a body of genus 1. */
TYPES.hinge = {
  face: '+y',
  defaults: { R: 5, rp: 2.5, clear: 0.5, gap: 0.5, k: 16, leaf: 25, web: 4, half: 4, u: 0, v: 0, sides: 32 },
  define(p, F) {
    if (!(p.clear >= 0.05 && p.gap >= 0.05)) refuse('hinge', 'the moving knuckle needs real clearances (>= 0.05 mm)');
    if (!(p.rp > 0 && p.R - p.rp - p.clear >= 2 * p.clear)) refuse('hinge', 'the moving knuckle\'s wall (R - rp - clear) is too thin');
    if (!(p.web > 0 && p.web < p.R)) refuse('hinge', 'a web must be narrower than its knuckle (0 < web < R)');
    if (!(p.half > 0 && p.half < p.R)) refuse('hinge', 'the leaf is carried by its knuckle: half-thickness must be < R');
    if (!(p.k > 4 * p.gap)) refuse('hinge', 'knuckles must be longer than 4 axial gaps');
    if (!(p.leaf >= 2 * p.R + p.clear)) refuse('hinge', 'the leaf must reach past the fixed knuckles (>= 2R + clear)');
    if (!(p.sides >= 8 && p.sides % 8 === 0)) refuse('hinge', 'knuckle sides must be a multiple of 8');
    if (Math.abs(p.u) + 1.5 * p.k > F.Fu / 2 || Math.abs(p.v) + p.R > F.Fv / 2) refuse('hinge', 'it runs off the face');
  },
  make(w, p, F) {
    const a = p.clear + p.R;                                  // the axis, off the face
    const f1 = [p.u - 1.5 * p.k, p.u - 0.5 * p.k], f2 = [p.u + 0.5 * p.k, p.u + 1.5 * p.k];
    const mv = [p.u - 0.5 * p.k + p.gap, p.u + 0.5 * p.k - p.gap];
    const n = p.sides;
    const webs = [f1, f2].map(fr => box(w, [fr, [p.v - p.web, p.v + p.web], [0, a]]));
    const fixed = cylU(w, p.R, f1[0], f1[1], p.v, a, n).add(cylU(w, p.R, f2[0], f2[1], p.v, a, n))
      .add(webs[0]).add(webs[1])
      .add(cylU(w, p.rp, f1[0] + p.k / 4, f2[1] - p.k / 4, p.v, a, n));
    // The leaf: full width far out; over the fixed knuckles it starts clear of them.
    const leafV = [p.v - p.half, p.v + p.half];
    const moving = cylU(w, p.R, mv[0], mv[1], p.v, a, n)
      .add(box(w, [mv, leafV, [a, a + p.leaf]]))
      .add(box(w, [[f1[0], f2[1]], leafV, [a + p.R + p.clear, a + p.leaf]]))
      .subtract(cylU(w, p.rp + p.clear, f1[0], f2[1], p.v, a, n));
    return {
      solid: fixed.add(moving),
      recess: null,
      roots: { rects: [f1, f2].map(fr => [fr, [p.v - p.web, p.v + p.web]]), area: 2 * p.k * 2 * p.web },
      topology: { host_genus: 1, bodies: [1] },
      truth: {
        axis_point: toWorld(F, [p.u, p.v, a]).map(r9),
        axis_dir: F.U.slice(),
        knuckle_radius: p.R, pin_radius: p.rp, clear: p.clear, gap: p.gap,
        fixed: [f1, f2].map(fr => worldBox(F, [fr, [p.v - p.R, p.v + p.R], [a - p.R, a + p.R]])),
        moving: worldBox(F, [[f1[0], f2[1]], [p.v - p.R, p.v + p.R], [p.clear, a + p.leaf]]),
        leaf_direction: F.W.slice(),                 // at rest: straight out of the face
        swing_free_deg: [-90, 90],                    // leaf clears webs and face over this
        swing_blocked_deg: [-135, 135],               // ...and the face stops it here
        bounds: worldBox(F, [[f1[0], f2[1]], [p.v - p.R, p.v + p.R], [0, a + p.leaf]])
      }
    };
  }
};

const ORDER = ['flange', 'handle', 'bracket', 'lid', 'hinge'];

/* ------------------------------------------------------------ composition */

/* A feature's cell, in world AABBs: the box over its footprint out from the
   face (keep mm of margin, never behind the face). A recess adds its own
   cell (recess_cells), made by the type. */
function cellOf(F, localBB, keep) {
  return [worldBox(F, [[localBB.min[0] - keep, localBB.max[0] + keep],
                       [localBB.min[1] - keep, localBB.max[1] + keep],
                       [0, localBB.max[2] + keep]])];
}
const overlaps = (a, b) => [0, 1, 2].every(i => a.lo[i] < b.hi[i] && b.lo[i] < a.hi[i]);

/* The census the checker will read, off a soup, as nso_damage.js takes it. */
function measureSoup(soup) {
  const ex = D.exactIndex(soup);
  return { ex, e: D.expectation(ex.index, soup) };
}

async function build(spec) {
  spec = spec || {};
  const host = { size: (spec.host && spec.host.size || HOST.size).slice() };
  const keep = spec.keep != null ? spec.keep : 1;
  const list = spec.features || [];
  if (!list.length) throw new Error('no features asked for');
  const w = await D.kernel();
  const live = [];
  const own = m => (live.push(m), m);
  try {
    const recs = [];
    let hostSolid = own(box(w, [[-host.size[0] / 2, host.size[0] / 2], [-host.size[1] / 2, host.size[1] / 2], [0, host.size[2]]]));
    const made = [];
    for (const f of list) {
      const T = TYPES[f.type];
      if (!T) throw new Error('unknown feature type "' + f.type + '" (' + Object.keys(TYPES).join(', ') + ')');
      const face = f.face || T.face;
      const F = frame(host, face);
      const p = Object.assign({}, T.defaults, f.params || {});
      T.define(p, F);
      const g = T.make(w, p, F);
      const M = mat(F);
      const solid = own(own(g.solid).transform(M));
      if (solid.status() !== 'NoError' || solid.isEmpty()) throw new Error(f.type + ': the kernel refused the feature (' + solid.status() + ')');
      const lbb = g.solid.boundingBox();
      if (lbb.min[2] < (g.recess ? -Infinity : -1e-9)) throw new Error(f.type + ': reaches behind its face');
      const cells = cellOf(F, lbb, keep);
      const recess = g.recess ? own(own(g.recess).transform(M)) : null;
      made.push({ solid, recess });
      recs.push({
        type: f.type, face, params: p,
        frame: { C: F.C, U: F.U, V: F.V, W: F.W },
        root_plane: { normal: F.W.slice(), offset: dot(F.C, F.W) },
        roots: g.roots, topology: g.topology, cells,
        recess_cells: g.recessCell ? [worldBox(F, g.recessCell)] : [],
        volume: solid.volume(), surface_area: solid.surfaceArea(),
        triangles_alone: solid.numTri(),
        truth: g.truth
      });
    }
    // Independence: no two cells overlap, so no feature can touch another.
    for (let i = 0; i < recs.length; i++) for (let j = i + 1; j < recs.length; j++) {
      for (const a of recs[i].cells.concat(recs[i].recess_cells)) for (const b of recs[j].cells.concat(recs[j].recess_cells)) {
        if (overlaps(a, b)) throw new Error(recs[i].type + ' and ' + recs[j].type + ' overlap - their cells are not independent');
      }
    }
    for (const m of made) if (m.recess) hostSolid = own(hostSolid.subtract(m.recess));
    const hostVol = hostSolid.volume(), hostArea = hostSolid.surfaceArea();
    let piece = hostSolid;
    for (const m of made) piece = own(piece.add(m.solid));
    if (piece.status() !== 'NoError') throw new Error('the kernel refused the composition: ' + piece.status());

    /* What the definitions add up to - stated before the output is read. */
    const hostGenus = recs.reduce((s, r) => s + (r.topology.host_genus || 0), 0);
    const voids = recs.reduce((s, r) => s + (r.topology.voids || 0), 0);
    const extra = [].concat(...recs.map(r => r.topology.bodies || []));
    const declared = {
      shells: 1 + voids + extra.length,
      bodies: 1 + extra.length,
      host_genus: hostGenus,
      euler_characteristic: (2 - 2 * hostGenus) + 2 * voids + extra.reduce((s, g) => s + 2 - 2 * g, 0),
      signed_volume: hostVol + recs.reduce((s, r) => s + r.volume, 0),
      surface_area: hostArea + recs.reduce((s, r) => s + r.surface_area - 2 * r.roots.area, 0)
    };

    const soup = D.toSoup(piece);
    const { ex, e } = measureSoup(soup);
    const gap = D.closestPair(ex.verts, 2 * D.WELD_TOL);
    const shells = piece.decompose();
    const nShells = shells.length;
    shells.forEach(s => s.delete());
    const vol = piece.volume(), area = piece.surfaceArea();
    const why = [];
    if (e.open_edges || e.nonmanifold_edges || e.inconsistent_winding_edges || e.degenerate_tris) why.push('census ' + JSON.stringify(e));
    if (gap <= 2 * D.WELD_TOL) why.push('two vertices ' + gap.toExponential(3) + ' mm apart');
    if (e.welded_vertices !== piece.numVert()) why.push('exact vertices ' + e.welded_vertices + ' vs kernel ' + piece.numVert());
    if (e.euler_characteristic !== declared.euler_characteristic) why.push('chi ' + e.euler_characteristic + ', the definitions add up to ' + declared.euler_characteristic);
    if (nShells !== declared.shells) why.push(nShells + ' shells, the definitions add up to ' + declared.shells);
    if (Math.abs(vol - declared.signed_volume) > 1e-6 * declared.signed_volume) why.push('volume ' + vol + ' vs ' + declared.signed_volume + ' - a feature overlaps the hull or another');
    if (Math.abs(area - declared.surface_area) > 1e-6 * declared.surface_area) why.push('area ' + area + ' vs ' + declared.surface_area + ' - a root is not the contact it declares');
    if (why.length) throw new Error('the composition is not what its definitions promise: ' + why.join('; '));

    // Per feature, the piece inside its cell must be exactly the feature.
    for (let i = 0; i < recs.length; i++) {
      const v = soupVolume(splitSoup(w, soup, recs[i]).feature);
      if (Math.abs(v - recs[i].volume) > 1e-6 * recs[i].volume) {
        throw new Error(recs[i].type + ': its cell holds ' + v + ' mm3 of the piece, not its own ' + recs[i].volume);
      }
    }

    return {
      soup, host, keep,
      host_volume: hostVol, host_area: hostArea,
      declared, shells: nShells,
      features: recs,
      expected: Object.assign(e, { signed_volume: vol, surface_area: area })
    };
  } finally {
    for (const m of live) { try { m.delete(); } catch (x) { /* already gone */ } }
  }
}

/* ---------------------------------------------------- the reference detach */

/* Split a piece into one feature and the rest, by the feature's record
   alone - and exactly: no cut, no new vertex, nothing moved.

   A kernel cut cannot do this. The root lies ON the host face, and every cut
   through that plane - a cell box with a face on it, or the kernel's own
   plane trim - leaves a zero-thickness sheet of host face behind on the
   feature (measured: 258 mm2 of extra area on the flange, a non-manifold
   fringe round the handle's feet). So the piece's own triangles are sorted
   instead:
     feature   beyond the root plane and inside a cell; on the plane and
               facing into the hull (a feature's underside, like the lid's
               over the plug gap) inside a cell's footprint; or inside a
               recess cell
     host      everything else
   The two sets are open along the same loops - the roots. Each loop is
   chained from the feature's boundary edges, and both sides are closed
   with ONE triangulation of those loops (the kernel's own triangulate, on
   the loops' own vertices): as is for the host, reversed for the feature. */
function splitSoup(w, soup, rec) {
  const ex = D.exactIndex(soup), n = ex.n, I = ex.index, V = ex.verts;
  const N = rec.root_plane.normal, off = rec.root_plane.offset;
  const k = N.findIndex(x => x !== 0);
  const inside = (p, b, skip) => [0, 1, 2].every(i => i === skip || (p[i] > b.lo[i] && p[i] < b.hi[i]));
  const isF = new Uint8Array(n);
  for (let t = 0; t < n; t++) {
    const A = V[I[t * 3]], B = V[I[t * 3 + 1]], C = V[I[t * 3 + 2]];
    const c = [0, 1, 2].map(i => (A[i] + B[i] + C[i]) / 3);
    const h = dot(c, N) - off;
    const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const facing = (e1[1] * e2[2] - e1[2] * e2[1]) * N[0] + (e1[2] * e2[0] - e1[0] * e2[2]) * N[1] + (e1[0] * e2[1] - e1[1] * e2[0]) * N[2];
    let f = false;
    if (h > 1e-6) f = rec.cells.some(b => inside(c, b));
    else if (h >= -1e-6) f = facing < 0 && rec.cells.some(b => inside(c, b, k));
    if (!f && rec.recess_cells) f = rec.recess_cells.some(b => inside(c, b));
    isF[t] = f ? 1 : 0;
  }
  // The feature's boundary: directed edges whose reverse it does not have.
  const dir = new Set();
  for (let t = 0; t < n; t++) if (isF[t]) for (let e = 0; e < 3; e++) dir.add(I[t * 3 + e] + '>' + I[t * 3 + (e + 1) % 3]);
  const next = new Map();
  for (const d of dir) {
    const [u, v] = d.split('>').map(Number);
    if (dir.has(v + '>' + u)) continue;
    if (next.has(u)) throw new Error(rec.type + ': its root loops touch at a vertex - not a clean root');
    next.set(u, v);
  }
  if (!next.size) throw new Error(rec.type + ': no root - the cell holds nothing attached to the hull');
  const U = planeAxes(N);
  const loops = [];
  const seen = new Set();
  for (const s0 of next.keys()) {
    if (seen.has(s0)) continue;
    const loop = [];
    let v = s0;
    while (!seen.has(v)) {
      seen.add(v);
      if (Math.abs(dot(V[v], N) - off) > 1e-6) throw new Error(rec.type + ': a root loop leaves the root plane');
      loop.push(v);
      v = next.get(v);
      if (v === undefined) throw new Error(rec.type + ': a root loop does not close');
    }
    loops.push(loop);
  }
  // 2D, in a right-handed frame of the plane; outer loops counter-clockwise,
  // holes clockwise, which is what triangulate() reads.
  const P2 = loops.map(l => l.map(v => [dot(V[v], U[0]), dot(V[v], U[1])]));
  const area = pts => pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
  const within = (pt, poly) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      if ((poly[i][1] > pt[1]) !== (poly[j][1] > pt[1]) &&
          pt[0] < (poly[j][0] - poly[i][0]) * (pt[1] - poly[i][1]) / (poly[j][1] - poly[i][1]) + poly[i][0]) c = !c;
    }
    return c;
  };
  const flat = [], polys = [];
  P2.forEach((pts, i) => {
    const depth = P2.filter((q, j) => j !== i && within(pts[0], q)).length;
    const ccw = area(pts) > 0;
    const want = depth % 2 === 0;
    const order = ccw === want ? loops[i] : loops[i].slice().reverse();
    const pp = ccw === want ? pts : pts.slice().reverse();
    polys.push(pp);
    flat.push(...order);
  });
  const tris = w.triangulate(polys, 1e-9);
  const out = (keep, capRev) => {
    const T = [];
    for (let t = 0; t < n; t++) if (isF[t] === keep) T.push([I[t * 3], I[t * 3 + 1], I[t * 3 + 2]]);
    for (const [a, b, c] of tris) T.push(capRev ? [flat[a], flat[c], flat[b]] : [flat[a], flat[b], flat[c]]);
    const o = new Float32Array(T.length * 9);
    T.forEach((tr, i) => tr.forEach((v, j) => o.set(V[v], i * 9 + j * 3)));
    const c = D.census(Int32Array.from(T.flat()));
    if (c.open_edges || c.nonmanifold_edges || c.inconsistent_winding_edges) {
      throw new Error(rec.type + ': the root cap does not close the ' + (keep ? 'feature' : 'host') + ' (' + JSON.stringify(c) + ')');
    }
    return o;
  };
  return { feature: out(1, true), host: out(0, false), loops: loops.length, cap_triangles: tris.length };
}
/* A right-handed in-plane pair (U, V) for a face normal: U x V = N. */
function planeAxes(N) {
  for (const f of Object.values(FACES)) if (f.W.join() === N.join()) return [f.U, f.V];
  throw new Error('no face has normal ' + N.join(','));
}
function soupVolume(s) {
  let v = 0;
  for (let t = 0; t < s.length; t += 9) {
    v += (s[t] * (s[t + 4] * s[t + 8] - s[t + 5] * s[t + 7]) - s[t + 1] * (s[t + 3] * s[t + 8] - s[t + 5] * s[t + 6]) +
          s[t + 2] * (s[t + 3] * s[t + 7] - s[t + 4] * s[t + 6])) / 6;
  }
  return v;
}

/* Split a piece into one feature and the rest, reading only the soup and the
   feature's manifest record. This is the ground truth a Detach operation is
   held to. */
async function detach(soup, rec) {
  const w = await D.kernel();
  const r = splitSoup(w, soup, rec);
  return Object.assign(r, { feature_volume: soupVolume(r.feature), host_volume: soupVolume(r.host) });
}
async function reattach(hostSoup, featSoup) {
  const w = await D.kernel();
  const live = [];
  const own = m => (live.push(m), m);
  try {
    const u = own(own(D.toManifold(w, hostSoup)).add(own(D.toManifold(w, featSoup))));
    return { soup: D.toSoup(u), volume: u.volume(), area: u.surfaceArea() };
  } finally { for (const m of live) { try { m.delete(); } catch (x) { /* gone */ } } }
}

/* Volume of A n B, both soups - the collision test for the functional checks. */
async function overlapVolume(a, b) {
  const w = await D.kernel();
  const live = [];
  const own = m => (live.push(m), m);
  try { return own(own(D.toManifold(w, a)).intersect(own(D.toManifold(w, b)))).volume(); }
  finally { for (const m of live) { try { m.delete(); } catch (x) { /* gone */ } } }
}

/* Soup transforms, exact where the numbers allow. */
function translate(soup, d) {
  const o = new Float32Array(soup.length);
  for (let i = 0; i < soup.length; i++) o[i] = soup[i] + d[i % 3];
  return o;
}
/* Rotate by deg about the line through point P along unit axis A (Rodrigues). */
function rotateAbout(soup, P, A, deg) {
  const th = deg * Math.PI / 180, c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  const [x, y, z] = A;
  const R = [c + x * x * C, x * y * C - z * s, x * z * C + y * s,
             y * x * C + z * s, c + y * y * C, y * z * C - x * s,
             z * x * C - y * s, z * y * C + x * s, c + z * z * C];
  const o = new Float32Array(soup.length);
  for (let i = 0; i < soup.length; i += 3) {
    const px = soup[i] - P[0], py = soup[i + 1] - P[1], pz = soup[i + 2] - P[2];
    o[i] = P[0] + R[0] * px + R[1] * py + R[2] * pz;
    o[i + 1] = P[1] + R[3] * px + R[4] * py + R[5] * pz;
    o[i + 2] = P[2] + R[6] * px + R[7] * py + R[8] * pz;
  }
  return o;
}

module.exports = { HOST, FACES, TYPES, ORDER, frame, build, detach, reattach, overlapVolume, translate, rotateAbout, ngonArea, soupVolume };
