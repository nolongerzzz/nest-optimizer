/*
 * NSO 3MF reader
 * --------------
 * Pulls mesh geometry out of a .3mf so it can be loaded like an STL. First
 * pass: geometry only. Print settings, materials, colours, thumbnails and every
 * other part of the archive are ignored on purpose.
 *
 * What it does read:
 *
 *   _rels/.rels                 root relationship -> the model part
 *   3D/3dmodel.model            3MF core: <object><mesh>, <components>, <build>
 *   3D/Objects/*.model          Production-extension object parts, reached via
 *                               p:path on <component> / <item> (Bambu Studio
 *                               and PrusaSlicer write their meshes this way)
 *   Metadata/model_settings.config   Bambu object names, when present
 *   Metadata/nso_scene.json          NSO's own scene block, handed back
 *                                    verbatim as `sceneJson` when the archive
 *                                    has one - this reader does not interpret
 *                                    it (nso-3mf-scene.js owns that schema),
 *                                    and a file without it simply reports null
 *
 * Output is one triangle soup per build item, in millimetres, Z up, with every
 * component and item transform applied - i.e. where the object sits on the
 * plate in the slicer that wrote the file. That is the same shape handleFiles()
 * gets from STLLoader, so the app treats the two identically from there on.
 *
 * No third-party dependencies. The ZIP reader below walks the central directory
 * and inflates with DecompressionStream, which the app's browsers and Node 18+
 * both have. The XML walker is a small SAX-style tokenizer rather than DOMParser
 * so the exact same code runs under Node for tools/3mf-test.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NSO3MFRead = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ===========================================================================
  // ZIP reader (central directory walk, stored + deflate)
  // ===========================================================================

  function inflateRaw(bytes) {
    if (typeof DecompressionStream !== 'function') {
      return Promise.reject(new Error('This browser cannot inflate ZIP entries (no DecompressionStream)'));
    }
    var ds = new DecompressionStream('deflate-raw');
    var writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();
    return new Response(ds.readable).arrayBuffer().then(function (buf) {
      return new Uint8Array(buf);
    });
  }

  /** Little-endian u64 as a Number (archives here are far below 2^53 bytes). */
  function u64(view, at) {
    var lo = view.getUint32(at, true), hi = view.getUint32(at + 4, true);
    if (hi > 0x1FFFFF) throw new Error('ZIP offset too large');
    return hi * 0x100000000 + lo;
  }

  /**
   * @param {Uint8Array} bytes  the whole archive
   * @returns {{names: function(): string[], has: function(string): boolean,
   *            read: function(string): Promise<Uint8Array>}}
   *          Entries are inflated on demand, so thumbnails and G-code inside a
   *          project are never touched.
   */
  function openZip(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // End of central directory: signature 0x06054b50, scanned back from the
    // tail past any archive comment (max 65535 bytes).
    var eocd = -1;
    var stop = Math.max(0, bytes.length - 22 - 65535);
    for (var i = bytes.length - 22; i >= stop; i--) {
      if (view.getUint32(i, true) === 0x06054B50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a ZIP archive (no end-of-central-directory record)');

    var count = view.getUint16(eocd + 10, true);
    var ptr = view.getUint32(eocd + 16, true);
    if (count === 0xFFFF || ptr === 0xFFFFFFFF) {
      // ZIP64: the locator sits just before the EOCD and points at the ZIP64
      // EOCD record, which carries the real count and offset. Some slicers
      // write these markers even for small files.
      var loc = eocd - 20;
      if (loc < 0 || view.getUint32(loc, true) !== 0x07064B50) {
        throw new Error('Corrupt ZIP: ZIP64 markers without a ZIP64 locator');
      }
      var z64 = u64(view, loc + 8);
      if (view.getUint32(z64, true) !== 0x06064B50) {
        throw new Error('Corrupt ZIP: bad ZIP64 end-of-central-directory record');
      }
      count = u64(view, z64 + 32);
      ptr = u64(view, z64 + 48);
    }

    var entries = new Map();
    var decoder = new TextDecoder();
    for (var n = 0; n < count; n++) {
      if (view.getUint32(ptr, true) !== 0x02014B50) {
        throw new Error('Corrupt ZIP: bad central directory entry ' + n);
      }
      var flags = view.getUint16(ptr + 8, true);
      var method = view.getUint16(ptr + 10, true);
      var compSize = view.getUint32(ptr + 20, true);
      var rawSize = view.getUint32(ptr + 24, true);
      var nameLen = view.getUint16(ptr + 28, true);
      var extraLen = view.getUint16(ptr + 30, true);
      var commentLen = view.getUint16(ptr + 32, true);
      var localOff = view.getUint32(ptr + 42, true);
      var name = decoder.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
      if (flags & 0x1) throw new Error('Encrypted ZIP entries are not supported: ' + name);
      if (rawSize === 0xFFFFFFFF || compSize === 0xFFFFFFFF || localOff === 0xFFFFFFFF) {
        // ZIP64 extended information extra field (id 0x0001): only the fields
        // that overflowed are present, in this fixed order.
        var xp = ptr + 46 + nameLen, xend = xp + extraLen, found = false;
        while (xp + 4 <= xend) {
          var xid = view.getUint16(xp, true), xlen = view.getUint16(xp + 2, true);
          if (xid === 0x0001) {
            var f = xp + 4;
            if (rawSize === 0xFFFFFFFF) { rawSize = u64(view, f); f += 8; }
            if (compSize === 0xFFFFFFFF) { compSize = u64(view, f); f += 8; }
            if (localOff === 0xFFFFFFFF) { localOff = u64(view, f); f += 8; }
            found = true;
            break;
          }
          xp += 4 + xlen;
        }
        if (!found) throw new Error('Corrupt ZIP: ' + name + ' needs a ZIP64 extra field that is missing');
      }
      // Normalise: OPC part names are compared without a leading slash.
      entries.set(name.replace(/^\/+/, ''), {
        method: method, compSize: compSize, rawSize: rawSize, localOff: localOff
      });
      ptr += 46 + nameLen + extraLen + commentLen;
    }

    function read(name) {
      var e = entries.get(String(name).replace(/^\/+/, ''));
      if (!e) return Promise.reject(new Error('Missing part in 3MF: ' + name));
      var lo = e.localOff;
      if (view.getUint32(lo, true) !== 0x04034B50) {
        return Promise.reject(new Error('Corrupt ZIP: bad local header for ' + name));
      }
      // Sizes come from the central directory, so a data descriptor (flag bit 3)
      // in the local header does not matter.
      var lNameLen = view.getUint16(lo + 26, true);
      var lExtraLen = view.getUint16(lo + 28, true);
      var start = lo + 30 + lNameLen + lExtraLen;
      var body = bytes.subarray(start, start + e.compSize);
      if (e.method === 0) return Promise.resolve(body);
      if (e.method === 8) {
        return inflateRaw(body).then(function (out) {
          if (out.length !== e.rawSize) {
            throw new Error('Corrupt ZIP: ' + name + ' inflated to ' + out.length +
                            ' bytes, expected ' + e.rawSize);
          }
          return out;
        });
      }
      return Promise.reject(new Error('Unsupported ZIP compression method ' + e.method + ' for ' + name));
    }

    return {
      names: function () { return Array.from(entries.keys()); },
      has: function (name) { return entries.has(String(name).replace(/^\/+/, '')); },
      read: read
    };
  }

  // ===========================================================================
  // XML walker - enough of XML for 3MF (elements + attributes; text is not
  // needed for geometry, but is delivered so <metadata> can be read).
  // ===========================================================================

  var ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

  function decodeEntities(s) {
    if (s.indexOf('&') === -1) return s;
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, function (m, e) {
      if (e[0] === '#') {
        var code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return isNaN(code) ? m : String.fromCodePoint(code);
      }
      return Object.prototype.hasOwnProperty.call(ENTITIES, e) ? ENTITIES[e] : m;
    });
  }

  function localName(qname) {
    var c = qname.indexOf(':');
    return c === -1 ? qname : qname.slice(c + 1);
  }

  /**
   * @param {string} xml
   * @param {{open: function(string, object, boolean), close: function(string),
   *          text: function(string)}} h
   *        open(local element name, attrs keyed by local attribute name,
   *        selfClosing); close(local name); text(decoded text).
   */
  function walkXml(xml, h) {
    var i = 0, n = xml.length;
    while (i < n) {
      var lt = xml.indexOf('<', i);
      if (lt === -1) {
        if (h.text && i < n) h.text(decodeEntities(xml.slice(i)));
        break;
      }
      if (lt > i && h.text) h.text(decodeEntities(xml.slice(i, lt)));
      i = lt;

      if (xml.startsWith('<!--', i)) {
        var ce = xml.indexOf('-->', i + 4);
        if (ce === -1) throw new Error('Unterminated XML comment');
        i = ce + 3;
        continue;
      }
      if (xml.startsWith('<![CDATA[', i)) {
        var de = xml.indexOf(']]>', i + 9);
        if (de === -1) throw new Error('Unterminated CDATA section');
        if (h.text) h.text(xml.slice(i + 9, de));
        i = de + 3;
        continue;
      }
      if (xml.startsWith('<?', i)) {
        var pe = xml.indexOf('?>', i + 2);
        if (pe === -1) throw new Error('Unterminated processing instruction');
        i = pe + 2;
        continue;
      }
      if (xml.startsWith('<!', i)) {           // DOCTYPE etc.
        var be = xml.indexOf('>', i + 2);
        if (be === -1) throw new Error('Unterminated declaration');
        i = be + 1;
        continue;
      }
      if (xml[i + 1] === '/') {                 // closing tag
        var xe = xml.indexOf('>', i + 2);
        if (xe === -1) throw new Error('Unterminated closing tag');
        h.close(localName(xml.slice(i + 2, xe).trim()));
        i = xe + 1;
        continue;
      }

      // Opening / self-closing tag. Scan to the real '>' (quotes may hold one).
      var j = i + 1;
      while (j < n && !isSpace(xml.charCodeAt(j)) && xml[j] !== '>' && xml[j] !== '/') j++;
      var name = localName(xml.slice(i + 1, j));
      var attrs = {};
      var selfClosing = false;
      for (;;) {
        while (j < n && isSpace(xml.charCodeAt(j))) j++;
        if (j >= n) throw new Error('Unterminated start tag <' + name + '>');
        var ch = xml[j];
        if (ch === '>') { j++; break; }
        if (ch === '/') { selfClosing = true; j++; continue; }
        var k = j;
        while (k < n && xml[k] !== '=' && xml[k] !== '>' && !isSpace(xml.charCodeAt(k))) k++;
        var aname = xml.slice(j, k);
        while (k < n && isSpace(xml.charCodeAt(k))) k++;
        if (xml[k] !== '=') {                   // attribute without a value
          attrs[localName(aname)] = '';
          j = k;
          continue;
        }
        k++;
        while (k < n && isSpace(xml.charCodeAt(k))) k++;
        var q = xml[k];
        if (q !== '"' && q !== "'") throw new Error('Unquoted attribute value in <' + name + '>');
        var qe = xml.indexOf(q, k + 1);
        if (qe === -1) throw new Error('Unterminated attribute value in <' + name + '>');
        attrs[localName(aname)] = decodeEntities(xml.slice(k + 1, qe));
        j = qe + 1;
      }
      h.open(name, attrs, selfClosing);
      if (selfClosing) h.close(name);
      i = j;
    }
  }

  function isSpace(c) { return c === 32 || c === 9 || c === 10 || c === 13; }

  // ===========================================================================
  // 3MF model part
  // ===========================================================================

  var PART_NSO_SCENE = 'Metadata/nso_scene.json';

  var UNIT_TO_MM = {
    micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000
  };

  var IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

  /** "m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32" -> 12 numbers, or identity. */
  function parseTransform(s) {
    if (!s) return IDENTITY.slice();
    var parts = String(s).trim().split(/\s+/).map(Number);
    if (parts.length !== 12 || parts.some(function (v) { return !isFinite(v); })) {
      throw new Error('Bad 3MF transform: "' + s + '"');
    }
    return parts;
  }

  /** Row-vector convention: v' = v * M. mul(A, B) applies A first, then B. */
  function mul(A, B) {
    var out = new Array(12);
    for (var r = 0; r < 3; r++) {
      for (var c = 0; c < 3; c++) {
        out[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
      }
    }
    for (var c2 = 0; c2 < 3; c2++) {
      out[9 + c2] = A[9] * B[c2] + A[10] * B[3 + c2] + A[11] * B[6 + c2] + B[9 + c2];
    }
    return out;
  }

  function det3(M) {
    return M[0] * (M[4] * M[8] - M[5] * M[7])
         - M[1] * (M[3] * M[8] - M[5] * M[6])
         + M[2] * (M[3] * M[7] - M[4] * M[6]);
  }

  /**
   * Parse one model part.
   * @returns {{unit: string, scale: number, objects: Map<string, object>,
   *            build: object[], metadata: object}}
   *   object: {id, type, name, mesh: {vertices: number[], triangles: number[]}|null,
   *            components: {objectid, path, transform}[]}
   */
  function parseModelXml(xml) {
    var model = { unit: 'millimeter', scale: 1, objects: new Map(), build: [], metadata: {} };
    var cur = null;        // object being built
    var inMesh = false;
    var metaName = null;   // <metadata name="..."> being read (model level only)
    var depth = 0, modelDepth = -1;

    walkXml(xml, {
      open: function (name, attrs) {
        depth++;
        switch (name) {
          case 'model':
            modelDepth = depth;
            if (attrs.unit) {
              var u = String(attrs.unit).toLowerCase();
              if (!Object.prototype.hasOwnProperty.call(UNIT_TO_MM, u)) {
                throw new Error('Unknown 3MF unit "' + attrs.unit + '"');
              }
              model.unit = u;
              model.scale = UNIT_TO_MM[u];
            }
            break;
          case 'metadata':
            if (depth === modelDepth + 1 && attrs.name) metaName = attrs.name;
            break;
          case 'object':
            cur = {
              id: String(attrs.id),
              type: attrs.type || 'model',
              name: attrs.name || '',
              mesh: null,
              components: []
            };
            model.objects.set(cur.id, cur);
            break;
          case 'mesh':
            if (cur) { inMesh = true; cur.mesh = { vertices: [], triangles: [] }; }
            break;
          case 'vertex':
            if (inMesh) {
              var x = +attrs.x, y = +attrs.y, z = +attrs.z;
              if (!isFinite(x) || !isFinite(y) || !isFinite(z)) {
                throw new Error('Non-numeric vertex in object ' + cur.id);
              }
              cur.mesh.vertices.push(x, y, z);
            }
            break;
          case 'triangle':
            if (inMesh) {
              var a = +attrs.v1, b = +attrs.v2, c = +attrs.v3;
              if (!(a >= 0 && b >= 0 && c >= 0) || a % 1 || b % 1 || c % 1) {
                throw new Error('Bad triangle indices in object ' + cur.id);
              }
              cur.mesh.triangles.push(a, b, c);
            }
            break;
          case 'component':
            if (cur) {
              cur.components.push({
                objectid: String(attrs.objectid),
                path: attrs.path || null,
                transform: parseTransform(attrs.transform)
              });
            }
            break;
          case 'item':
            model.build.push({
              objectid: String(attrs.objectid),
              path: attrs.path || null,
              transform: parseTransform(attrs.transform),
              printable: attrs.printable !== '0'
            });
            break;
        }
      },
      close: function (name) {
        if (name === 'mesh') inMesh = false;
        else if (name === 'object') cur = null;
        else if (name === 'metadata') metaName = null;
        depth--;
      },
      text: function (t) {
        if (metaName) model.metadata[metaName] = (model.metadata[metaName] || '') + t;
      }
    });

    // Triangle indices must point at real vertices.
    model.objects.forEach(function (obj) {
      if (!obj.mesh) return;
      var nv = obj.mesh.vertices.length / 3;
      var tri = obj.mesh.triangles;
      for (var i = 0; i < tri.length; i++) {
        if (tri[i] >= nv) {
          throw new Error('Object ' + obj.id + ': triangle index ' + tri[i] + ' out of range (' + nv + ' vertices)');
        }
      }
    });
    return model;
  }

  /** Bambu's Metadata/model_settings.config: object id -> name. */
  function parseModelSettingsNames(xml) {
    var names = {};
    var objId = null, depth = 0, objDepth = -1;
    walkXml(xml, {
      open: function (name, attrs) {
        depth++;
        if (name === 'object' && attrs.id != null) { objId = String(attrs.id); objDepth = depth; }
        else if (name === 'metadata' && objId && depth === objDepth + 1 &&
                 attrs.key === 'name' && attrs.value && !names[objId]) {
          names[objId] = attrs.value;
        }
      },
      close: function (name) {
        if (name === 'object' && depth === objDepth) { objId = null; objDepth = -1; }
        depth--;
      }
    });
    return names;
  }

  /** Root relationship -> model part name, defaulting to 3D/3dmodel.model. */
  function parseRootModelPart(relsXml) {
    var target = null;
    walkXml(relsXml, {
      open: function (name, attrs) {
        if (name === 'Relationship' && !target && attrs.Type &&
            /3dmodel$/i.test(attrs.Type) && attrs.Target) {
          target = attrs.Target;
        }
      },
      close: function () {}
    });
    return target ? target.replace(/^\/+/, '') : '3D/3dmodel.model';
  }

  /** Resolve a p:path (absolute OPC part name) or a relative one against a part. */
  function resolvePartPath(path, fromPart) {
    if (!path) return fromPart;
    if (path[0] === '/') return path.slice(1);
    var dir = fromPart.lastIndexOf('/');
    return (dir === -1 ? '' : fromPart.slice(0, dir + 1)) + path;
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * @param {Uint8Array|ArrayBuffer} bytes  the .3mf
   * @param {{name?: string}} [opts]         name of the file, for fallback names
   * @returns {Promise<{objects: {id: string, name: string, positions: Float32Array,
   *                              triangleCount: number}[],
   *                    unit: string, application: string, sceneJson: string|null,
   *                    warnings: string[]}>}
   *   positions is a triangle soup [x,y,z, x,y,z, x,y,z, ...] per triangle, in
   *   millimetres, Z up, with all transforms applied - one entry per build item.
   */
  function parse3MF(bytes, opts) {
    opts = opts || {};
    var zip;
    try {
      zip = openZip(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes);
    } catch (e) {
      return Promise.reject(e);
    }
    var warnings = [];
    var parts = new Map();   // part name -> parsed model
    var decoder = new TextDecoder();

    function loadPart(name) {
      if (parts.has(name)) return Promise.resolve(parts.get(name));
      return zip.read(name).then(function (data) {
        var model = parseModelXml(decoder.decode(data));
        parts.set(name, model);
        return model;
      });
    }

    var rootRels = zip.has('_rels/.rels')
      ? zip.read('_rels/.rels').then(function (d) { return parseRootModelPart(decoder.decode(d)); })
      : Promise.resolve('3D/3dmodel.model');

    var bambuNames = zip.has('Metadata/model_settings.config')
      ? zip.read('Metadata/model_settings.config').then(function (d) {
          try { return parseModelSettingsNames(decoder.decode(d)); }
          catch (e) { warnings.push('model_settings.config unreadable: ' + e.message); return {}; }
        })
      : Promise.resolve({});

    // Optional, and optional all the way down: a plain Bambu or MakerWorld
    // file has no such part, and an unreadable one is a warning rather than a
    // failed import - geometry does not depend on it.
    var sceneJson = zip.has(PART_NSO_SCENE)
      ? zip.read(PART_NSO_SCENE).then(function (d) {
          try { return decoder.decode(d); }
          catch (e) { warnings.push('nso_scene.json unreadable: ' + e.message); return null; }
        }).catch(function (e) {
          warnings.push('nso_scene.json could not be read: ' + e.message);
          return null;
        })
      : Promise.resolve(null);

    return Promise.all([rootRels, bambuNames, sceneJson]).then(function (r) {
      var rootPart = r[0], names = r[1], scene = r[2];
      return loadPart(rootPart).then(function (root) {
        var items = root.build.slice();
        if (!items.length) {
          // No <build>: import every top-level mesh-bearing object as-is.
          root.objects.forEach(function (obj) {
            if (obj.mesh || obj.components.length) {
              items.push({ objectid: obj.id, path: null, transform: IDENTITY.slice(), printable: true });
            }
          });
          if (items.length) warnings.push('No <build> section; imported every object at its own origin');
        }
        if (!items.length) throw new Error('No objects found in this 3MF');

        var base = String(opts.name || '3mf').replace(/\.3mf$/i, '');
        var seq = Promise.resolve();
        var out = [];

        items.forEach(function (item, idx) {
          seq = seq.then(function () {
            var soup = [];
            var found = { name: '' };   // first <object name> met on the way down
            var itemPart = resolvePartPath(item.path, rootPart);
            return collect(itemPart, item.objectid, item.transform, soup, 0, found).then(function () {
              if (!soup.length) {
                warnings.push('Build item ' + (idx + 1) + ' (object ' + item.objectid + ') has no mesh; skipped');
                return;
              }
              var scale = root.scale;
              var positions = new Float32Array(soup.length);
              for (var i = 0; i < soup.length; i++) positions[i] = soup[i] * scale;
              // Bambu's model_settings.config name wins; then the first named
              // object in the chain (a wrapper is usually nameless, the mesh
              // object inside it may not be); then the file name.
              var name = names[item.objectid] || found.name ||
                         (items.length === 1 ? base : base + '_' + (idx + 1));
              out.push({
                id: item.objectid,
                name: name,
                positions: positions,
                triangleCount: positions.length / 9
              });
            });
          });
        });

        // Depth-first over components, composing transforms; every mesh
        // reached lands in `soup` already transformed into item space.
        function collect(partName, objectId, M, soup, depth, found) {
          if (depth > 32) throw new Error('Component nesting too deep (cycle?) at object ' + objectId);
          return loadPart(partName).then(function (model) {
            var obj = model.objects.get(String(objectId));
            if (!obj) throw new Error('Object ' + objectId + ' not found in ' + partName);
            if (obj.type !== 'model' && obj.type !== 'solidsupport') {
              warnings.push('Object ' + objectId + ' is type "' + obj.type + '"; skipped');
              return;
            }
            if (obj.name && !found.name) found.name = obj.name;
            if (obj.mesh) appendTransformed(obj.mesh, M, soup);
            var chain = Promise.resolve();
            obj.components.forEach(function (comp) {
              chain = chain.then(function () {
                return collect(resolvePartPath(comp.path, partName), comp.objectid,
                               mul(comp.transform, M), soup, depth + 1, found);
              });
            });
            return chain;
          });
        }

        return seq.then(function () {
          if (!out.length) throw new Error('No mesh geometry found in this 3MF');
          return {
            objects: out,
            unit: root.unit,
            application: root.metadata.Application || '',
            sceneJson: scene,
            warnings: warnings
          };
        });
      });
    });
  }

  function appendTransformed(mesh, M, soup) {
    var v = mesh.vertices, t = mesh.triangles;
    // A mirroring transform turns the mesh inside out; swap two corners so the
    // winding still points outward.
    var flip = det3(M) < 0;
    for (var i = 0; i < t.length; i += 3) {
      var a = t[i], b = flip ? t[i + 2] : t[i + 1], c = flip ? t[i + 1] : t[i + 2];
      pushVertex(v, a, M, soup);
      pushVertex(v, b, M, soup);
      pushVertex(v, c, M, soup);
    }
  }

  function pushVertex(v, idx, M, soup) {
    var x = v[idx * 3], y = v[idx * 3 + 1], z = v[idx * 3 + 2];
    soup.push(
      x * M[0] + y * M[3] + z * M[6] + M[9],
      x * M[1] + y * M[4] + z * M[7] + M[10],
      x * M[2] + y * M[5] + z * M[8] + M[11]
    );
  }

  return {
    parse3MF: parse3MF,
    openZip: openZip,
    walkXml: walkXml,
    parseModelXml: parseModelXml,
    parseModelSettingsNames: parseModelSettingsNames,
    parseRootModelPart: parseRootModelPart,
    parseTransform: parseTransform,
    mul: mul,
    det3: det3,
    UNIT_TO_MM: UNIT_TO_MM,
    PART_NSO_SCENE: PART_NSO_SCENE
  };
});
