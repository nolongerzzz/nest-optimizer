/*
 * NSO scene block - full plate state inside a .3mf
 * -----------------------------------------------
 * The 3MF the app already writes carries geometry (3D/3dmodel.model), the
 * baked cooling settings (Metadata/project_settings.config) and NSO's
 * provenance note (Metadata/nso_profile.json). None of that says WHERE a
 * piece sits, whether it is locked, what gap it was seated at, which pattern
 * its skin is, which faces are painted, or whether it was declared non-solid.
 * Reopening such a file gives you the pieces back as placed-but-unconfigured
 * geometry.
 *
 * This module defines one more part:
 *
 *   Metadata/nso_scene.json      the whole working plate, NSO's own
 *
 * It is a SEPARATE OPC part under a name nothing else claims, for the same
 * reason nso_profile.json is: Bambu Studio warns on keys it does not know, so
 * project_settings.config keeps its confirmed cooling keys and nothing else,
 * and model_settings.config keeps Bambu's own object/plate naming. A slicer
 * that does not know this part ignores it; NSO reading a file without it
 * imports plain geometry exactly as before.
 *
 * WHAT A PIECE CARRIES  (see docs/SCENE-3MF.md for the table and its sources)
 *
 *   basis      the 12-number transform the export baked into the geometry -
 *              piece model space (the centred, Y-up display geometry) to
 *              plate coordinates. Restore inverts it to recover the model.
 *   center_offset
 *              the model's own centerOffset, the translation between its raw
 *              file axes and its centred display geometry. With it, restore
 *              rebuilds rawTris in the SAME frame the piece had before the
 *              export, which is what lets the paint planes, the skin record
 *              and everything else raw-space come back verbatim instead of
 *              re-anchored. Null on a model that never had one.
 *   position   x, z, liftY, overflow
 *   pose       rotY, flipX, tipX, tipZ, tiltX, tiltZ, yaw, rotated
 *   footprint  width, depth, height - re-derived on restore, stored as a
 *              cross-check
 *   lock       this piece's own posLock (app-poslock.js)
 *   seat       the gap the piece was seated at, in the coupon sign
 *              convention, with the partner it was seated against
 *   skin       the pattern and parameters a Skin bake used (app-skin.js)
 *   paint      the excluded and selected face lists (app-mask.js)
 *   non_solid  the per-piece flag (app-nonsolid.js)
 *
 * and the plate itself carries its size, its preset id and the plate lock.
 *
 * TRANSFORM CONVENTION. `basis` is 12 numbers in the same row-vector layout
 * 3MF's own <item transform> uses and nso-3mf-read.js already parses:
 *
 *   x' = x*M[0] + y*M[3] + z*M[6] + M[9]
 *   y' = x*M[1] + y*M[4] + z*M[7] + M[10]
 *   z' = x*M[2] + y*M[5] + z*M[8] + M[11]
 *
 * poseBasis() builds it from the pose fields, and is the ONE place that
 * knows the chain. The exporter bakes the same chain through THREE; the
 * round-trip check asserts the two agree on every vertex, so a change to one
 * without the other fails the suite rather than silently shifting a plate.
 *
 * No third-party dependencies, no DOM, no THREE - runs in the browser and
 * under Node, so tools/3mf-test exercises the exact code the app uses.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NSO3MFScene = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PART = 'Metadata/nso_scene.json';
  var ROOT_KEY = 'nso_scene';
  var SCHEMA = 'nso.scene/1';
  var SCHEMA_MAJOR = 1;

  // ===========================================================================
  // Transforms - 3x3 in column convention while composing, emitted row-vector
  // ===========================================================================

  function mul3(A, B) {           // (A then B applied to a column vector: B*A)
    var out = new Array(9);
    for (var r = 0; r < 3; r++) {
      for (var c = 0; c < 3; c++) {
        out[r * 3 + c] = B[r * 3] * A[c] + B[r * 3 + 1] * A[3 + c] + B[r * 3 + 2] * A[6 + c];
      }
    }
    return out;
  }

  function rotX(a) {
    var c = Math.cos(a), s = Math.sin(a);
    return [1, 0, 0, 0, c, -s, 0, s, c];
  }
  function rotY(a) {
    var c = Math.cos(a), s = Math.sin(a);
    return [c, 0, s, 0, 1, 0, -s, 0, c];
  }
  function rotZ(a) {
    var c = Math.cos(a), s = Math.sin(a);
    return [c, -s, 0, s, c, 0, 0, 0, 1];
  }

  /* Three.js Y up -> Bambu Z up: (x, y, z) -> (x, -z, y). */
  var SWAP = [1, 0, 0, 0, 0, -1, 0, 1, 0];

  function num(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : (fallback || 0);
  }

  /**
   * The transform buildPlacedObjects3MF() bakes into one piece's geometry.
   *
   * @param {object} pose  x, z, rotY, rotated, flipX, tipX, tipZ, tiltX,
   *                       tiltZ, liftY, height - the placed entry's own fields
   * @param {{w:number, d:number}} plate
   * @returns {number[]} 12 numbers, row-vector convention (see the file head)
   */
  function poseBasis(pose, plate) {
    pose = pose || {};
    plate = plate || { w: 0, d: 0 };
    var tip = num(pose.tipX) * (Math.PI / 2) + num(pose.tiltX) * (Math.PI / 180);
    var flip = pose.flipX ? Math.PI : 0;
    var yaw = (pose.rotY != null) ? num(pose.rotY) : (pose.rotated ? Math.PI / 2 : 0);
    var roll = num(pose.tipZ) * (Math.PI / 2) + num(pose.tiltZ) * (Math.PI / 180);

    // rotateX, then rotateY, then rotateZ - the exporter's order - then the
    // Y-up -> Z-up swap.
    var A = mul3(rotX(tip + flip), rotY(yaw));
    A = mul3(A, rotZ(roll));
    A = mul3(A, SWAP);

    var tx = num(pose.x) + num(plate.w) / 2;
    var ty = -num(pose.z) + num(plate.d) / 2;
    var tz = num(pose.height) / 2 + num(pose.liftY);

    // column-convention A -> row-vector M is the transpose
    return [
      A[0], A[3], A[6],
      A[1], A[4], A[7],
      A[2], A[5], A[8],
      tx, ty, tz
    ];
  }

  /** Apply a 12-number transform to one point. */
  function apply12(M, x, y, z) {
    return [
      x * M[0] + y * M[3] + z * M[6] + M[9],
      x * M[1] + y * M[4] + z * M[7] + M[10],
      x * M[2] + y * M[5] + z * M[8] + M[11]
    ];
  }

  /**
   * The inverse transform. The 3x3 block of a pose basis is a rotation, so
   * this is always invertible, but the general adjugate is used rather than a
   * transpose so a hand-written or future non-rigid basis cannot silently
   * produce a wrong answer.
   */
  function invert12(M) {
    var a = M[0], b = M[1], c = M[2],
        d = M[3], e = M[4], f = M[5],
        g = M[6], h = M[7], i = M[8];
    var det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if (!isFinite(det) || Math.abs(det) < 1e-12) {
      throw new Error('Scene basis is not invertible (determinant ' + det + ')');
    }
    var inv = [
      (e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
      (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
      (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det
    ];
    // translation: p = (q - t) * inv  ->  the new offset is -(t * inv)
    var t = [M[9], M[10], M[11]];
    inv.push(
      -(t[0] * inv[0] + t[1] * inv[3] + t[2] * inv[6]),
      -(t[0] * inv[1] + t[1] * inv[4] + t[2] * inv[7]),
      -(t[0] * inv[2] + t[1] * inv[5] + t[2] * inv[8])
    );
    return inv;
  }

  /**
   * Push a whole triangle soup through a transform.
   * @param {number[]|Float32Array} soup  flat [x,y,z, ...]
   * @returns {Float32Array}
   */
  function transformSoup(M, soup) {
    var out = new Float32Array(soup.length);
    for (var i = 0; i + 2 < soup.length; i += 3) {
      var p = apply12(M, soup[i], soup[i + 1], soup[i + 2]);
      out[i] = p[0]; out[i + 1] = p[1]; out[i + 2] = p[2];
    }
    return out;
  }

  // ===========================================================================
  // Capture - app state in, plain JSON-safe object out
  // ===========================================================================

  function fin(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  /** One paint entry, copied field for field (app-mask.js copyEntry's shape). */
  function paintEntry(e) {
    if (!e || !e.n) return null;
    return {
      n: [fin(e.n[0]), fin(e.n[1]), fin(e.n[2])],
      d: fin(e.d),
      axisIdx: (e.axisIdx == null ? null : (e.axisIdx | 0)),
      keepMin: (e.axisIdx == null ? null : !!e.keepMin),
      dispAxis: (e.dispAxis == null ? null : (e.dispAxis | 0)),
      dispSign: (e.dispAxis == null ? null : fin(e.dispSign)),
      dispPlane: (e.dispPlane == null ? null : fin(e.dispPlane)),
      inner: !!e.inner
    };
  }

  function paintList(list) {
    var out = [];
    if (!list || !list.length) return out;
    for (var i = 0; i < list.length; i++) {
      var e = paintEntry(list[i]);
      if (e) out.push(e);
    }
    return out;
  }

  /** The seat record a Seat leaves on a placed piece, if any. */
  function seatOf(src) {
    var s = src && src.seat;
    if (!s || !isFinite(Number(s.gap))) return null;
    return {
      gap: fin(s.gap),
      kind: (s.kind === 'flush' ? 'flush' : 'support'),
      partner_name: String(s.partnerName || ''),
      partner_index: (s.partnerIndex == null ? null : (s.partnerIndex | 0)),
      measured: (s.measured == null ? null : fin(s.measured)),
      residual: (s.residual == null ? null : fin(s.residual)),
      reference: (s.reference === 'tips' ? 'tips' : 'face')
    };
  }

  /** The provenance a Skin bake leaves on a model, if any. */
  function skinOf(m) {
    var s = m && m.skin;
    if (!s || !s.pattern) return null;
    var out = {
      pattern: String(s.pattern),
      scope: (s.scope === 'wrap' ? 'wrap' : 'face'),
      mode: (s.mode == null ? null : String(s.mode)),
      faces: [],
      layer2: null,
      params: null
    };
    if (s.faces && s.faces.length) {
      for (var i = 0; i < s.faces.length; i++) out.faces.push(String(s.faces[i]));
    }
    if (s.layer2 && s.layer2.pattern) {
      out.layer2 = { pattern: String(s.layer2.pattern), free: !!s.layer2.free };
    }
    if (s.params && typeof s.params === 'object') {
      out.params = {};
      Object.keys(s.params).sort().forEach(function (k) {
        var v = s.params[k];
        if (typeof v === 'number' && isFinite(v)) out.params[k] = v;
        else if (typeof v === 'boolean' || typeof v === 'string') out.params[k] = v;
      });
    }
    return out;
  }

  /**
   * Build the scene block.
   *
   * Everything comes in as plain data so this stays testable without a DOM:
   *
   * @param {object} src
   * @param {{id:string, name:string, w:number, d:number, locked:boolean}} src.plate
   * @param {object[]} src.pieces  one per exported object, in export order:
   *        { name, sourceId, pose:{...}, basis:number[12], locked, seat,
   *          skin, paint:{exclude,select}, nonSolid }
   * @param {string} [src.scope]     'plate' (default) or 'model'
   * @param {object} [src.selection] { placedIndex, editId }
   * @returns {object} JSON-safe
   */
  function capture(src) {
    src = src || {};
    var plate = src.plate || {};
    var pieces = src.pieces || [];
    var sel = src.selection || {};

    var objects = pieces.map(function (p, i) {
      var pose = p.pose || {};
      return {
        index: i,
        object_id: String(i + 1),
        name: String(p.name == null ? '' : p.name),
        source_id: (p.sourceId == null ? null : (p.sourceId | 0)),
        basis: (p.basis || []).map(fin),
        center_offset: (p.centerOffset && isFinite(Number(p.centerOffset.x)))
          ? { x: fin(p.centerOffset.x), y: fin(p.centerOffset.y), z: fin(p.centerOffset.z) }
          : null,
        position: {
          x: fin(pose.x),
          z: fin(pose.z),
          lift_y: fin(pose.liftY),
          overflow: !!pose.overflow
        },
        pose: {
          rot_y: fin(pose.rotY),
          yaw: fin(pose.yaw),
          flip_x: !!pose.flipX,
          tip_x: fin(pose.tipX),
          tip_z: fin(pose.tipZ),
          tilt_x: fin(pose.tiltX),
          tilt_z: fin(pose.tiltZ),
          rotated: !!pose.rotated
        },
        footprint: {
          width: fin(pose.width),
          depth: fin(pose.depth),
          height: fin(pose.height)
        },
        lock: { piece: !!p.locked },
        seat: seatOf(p),
        skin: skinOf(p),
        paint: {
          excluded: paintList(p.paint && p.paint.exclude),
          selected: paintList(p.paint && p.paint.select)
        },
        non_solid: !!p.nonSolid
      };
    });

    var block = {};
    block[ROOT_KEY] = {
      schema: SCHEMA,
      generator: 'Nest Optimizer',
      scope: (src.scope === 'model' ? 'model' : 'plate'),
      units: 'millimeter',
      axes: 'bambu-z-up',
      note: 'NSO scene state. A slicer that does not know this part ignores ' +
            'it; NSO reading a 3MF without it imports plain geometry.',
      plate: {
        id: String(plate.id || ''),
        name: String(plate.name || ''),
        w: fin(plate.w),
        d: fin(plate.d),
        locked: !!plate.locked
      },
      selection: {
        placed_index: (sel.placedIndex == null ? null : (sel.placedIndex | 0)),
        edit_id: (sel.editId == null ? null : (sel.editId | 0))
      },
      objects: objects
    };
    return block;
  }

  /**
   * Serialize for the archive. Key order is the construction order above and
   * nothing here is time- or environment-dependent, so the same plate always
   * produces the same bytes - which is what keeps the export diffable and the
   * round-trip check deterministic, the same property buildZip's fixed DOS
   * timestamp gives the archive.
   */
  function serialize(block) {
    return JSON.stringify(block, null, 2) + '\n';
  }

  // ===========================================================================
  // Parse - strict, but only about this part
  // ===========================================================================

  function need(cond, msg) {
    if (!cond) throw new Error('nso_scene: ' + msg);
  }

  function readNum(v, what) {
    var n = Number(v);
    need(isFinite(n), what + ' is not a finite number (' + v + ')');
    return n;
  }

  function readPaint(list, what) {
    if (list == null) return [];
    need(Array.isArray(list), what + ' is not an array');
    return list.map(function (e, i) {
      need(e && Array.isArray(e.n) && e.n.length === 3, what + '[' + i + '].n must be 3 numbers');
      return {
        n: [readNum(e.n[0], what), readNum(e.n[1], what), readNum(e.n[2], what)],
        d: readNum(e.d, what + '[' + i + '].d'),
        axisIdx: (e.axisIdx == null ? null : (e.axisIdx | 0)),
        keepMin: (e.axisIdx == null ? null : !!e.keepMin),
        dispAxis: (e.dispAxis == null ? null : (e.dispAxis | 0)),
        dispSign: (e.dispAxis == null ? null : readNum(e.dispSign, what + '[' + i + '].dispSign')),
        dispPlane: (e.dispPlane == null ? null : readNum(e.dispPlane, what + '[' + i + '].dispPlane')),
        inner: !!e.inner
      };
    });
  }

  /** Major version of "nso.scene/N", or NaN if the string is not one. */
  function majorOf(schema) {
    var m = /^nso\.scene\/(\d+)$/.exec(String(schema || ''));
    return m ? parseInt(m[1], 10) : NaN;
  }

  /**
   * @param {string} text  the raw Metadata/nso_scene.json
   * @returns {object} normalised scene: {schema, major, scope, plate,
   *          selection, objects:[{index, objectId, name, basis, inverse,
   *          centerOffset, pose, footprint, locked, seat, skin, paint,
   *          nonSolid}]}
   * @throws on anything malformed - the caller falls back to geometry-only.
   */
  function parse(text) {
    var raw;
    try {
      raw = JSON.parse(String(text));
    } catch (e) {
      throw new Error('nso_scene: not valid JSON (' + e.message + ')');
    }
    need(raw && typeof raw === 'object', 'top level is not an object');
    var s = raw[ROOT_KEY];
    need(s && typeof s === 'object', 'no "' + ROOT_KEY + '" section');

    var major = majorOf(s.schema);
    need(!isNaN(major), 'unknown schema "' + s.schema + '"');
    need(major <= SCHEMA_MAJOR,
         'written by a newer NSO (schema ' + s.schema + ', this build reads up to ' +
         SCHEMA + ')');

    need(Array.isArray(s.objects), 'objects is not an array');

    var plate = s.plate || {};
    var sel = s.selection || {};

    var objects = s.objects.map(function (o, i) {
      need(o && typeof o === 'object', 'objects[' + i + '] is not an object');
      need(Array.isArray(o.basis) && o.basis.length === 12,
           'objects[' + i + '].basis must be 12 numbers');
      var basis = o.basis.map(function (v, k) {
        return readNum(v, 'objects[' + i + '].basis[' + k + ']');
      });
      var co = null;
      if (o.center_offset && o.center_offset.x != null) {
        co = {
          x: readNum(o.center_offset.x, 'objects[' + i + '].center_offset.x'),
          y: readNum(o.center_offset.y, 'objects[' + i + '].center_offset.y'),
          z: readNum(o.center_offset.z, 'objects[' + i + '].center_offset.z')
        };
      }
      var pos = o.position || {};
      var pose = o.pose || {};
      var fp = o.footprint || {};
      var seat = null;
      if (o.seat) {
        seat = {
          gap: readNum(o.seat.gap, 'objects[' + i + '].seat.gap'),
          kind: (o.seat.kind === 'flush' ? 'flush' : 'support'),
          partnerName: String(o.seat.partner_name || ''),
          partnerIndex: (o.seat.partner_index == null ? null : (o.seat.partner_index | 0)),
          measured: (o.seat.measured == null ? null : readNum(o.seat.measured, 'seat.measured')),
          residual: (o.seat.residual == null ? null : readNum(o.seat.residual, 'seat.residual')),
          reference: (o.seat.reference === 'tips' ? 'tips' : 'face')
        };
      }
      var skin = null;
      if (o.skin && o.skin.pattern) {
        skin = {
          pattern: String(o.skin.pattern),
          scope: (o.skin.scope === 'wrap' ? 'wrap' : 'face'),
          mode: (o.skin.mode == null ? null : String(o.skin.mode)),
          faces: Array.isArray(o.skin.faces) ? o.skin.faces.map(String) : [],
          layer2: (o.skin.layer2 && o.skin.layer2.pattern)
            ? { pattern: String(o.skin.layer2.pattern), free: !!o.skin.layer2.free }
            : null,
          params: (o.skin.params && typeof o.skin.params === 'object') ? o.skin.params : null
        };
      }
      return {
        index: (o.index == null ? i : (o.index | 0)),
        objectId: String(o.object_id == null ? (i + 1) : o.object_id),
        name: String(o.name == null ? '' : o.name),
        sourceId: (o.source_id == null ? null : (o.source_id | 0)),
        basis: basis,
        inverse: invert12(basis),
        centerOffset: co,
        pose: {
          x: readNum(pos.x, 'objects[' + i + '].position.x'),
          z: readNum(pos.z, 'objects[' + i + '].position.z'),
          liftY: readNum(pos.lift_y == null ? 0 : pos.lift_y, 'position.lift_y'),
          overflow: !!pos.overflow,
          rotY: readNum(pose.rot_y == null ? 0 : pose.rot_y, 'pose.rot_y'),
          yaw: readNum(pose.yaw == null ? 0 : pose.yaw, 'pose.yaw'),
          flipX: !!pose.flip_x,
          tipX: readNum(pose.tip_x == null ? 0 : pose.tip_x, 'pose.tip_x'),
          tipZ: readNum(pose.tip_z == null ? 0 : pose.tip_z, 'pose.tip_z'),
          tiltX: readNum(pose.tilt_x == null ? 0 : pose.tilt_x, 'pose.tilt_x'),
          tiltZ: readNum(pose.tilt_z == null ? 0 : pose.tilt_z, 'pose.tilt_z'),
          rotated: !!pose.rotated
        },
        footprint: {
          width: readNum(fp.width == null ? 0 : fp.width, 'footprint.width'),
          depth: readNum(fp.depth == null ? 0 : fp.depth, 'footprint.depth'),
          height: readNum(fp.height == null ? 0 : fp.height, 'footprint.height')
        },
        locked: !!(o.lock && o.lock.piece),
        seat: seat,
        skin: skin,
        paint: {
          exclude: readPaint(o.paint && o.paint.excluded, 'objects[' + i + '].paint.excluded'),
          select: readPaint(o.paint && o.paint.selected, 'objects[' + i + '].paint.selected')
        },
        nonSolid: !!o.non_solid
      };
    });

    return {
      schema: String(s.schema),
      major: major,
      scope: (s.scope === 'model' ? 'model' : 'plate'),
      plate: {
        id: String(plate.id || ''),
        name: String(plate.name || ''),
        w: readNum(plate.w == null ? 0 : plate.w, 'plate.w'),
        d: readNum(plate.d == null ? 0 : plate.d, 'plate.d'),
        locked: !!plate.locked
      },
      selection: {
        placedIndex: (sel.placed_index == null ? null : (sel.placed_index | 0)),
        editId: (sel.edit_id == null ? null : (sel.edit_id | 0))
      },
      objects: objects
    };
  }

  return {
    PART: PART,
    ROOT_KEY: ROOT_KEY,
    SCHEMA: SCHEMA,
    SCHEMA_MAJOR: SCHEMA_MAJOR,
    poseBasis: poseBasis,
    apply12: apply12,
    invert12: invert12,
    transformSoup: transformSoup,
    capture: capture,
    serialize: serialize,
    parse: parse
  };
});
