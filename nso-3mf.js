/*
 * NSO 3MF writer
 * --------------
 * Builds a Bambu Studio project (.3mf) from the nested plate, with the selected
 * cooling profile baked into Metadata/project_settings.config.
 *
 * Two envelopes. The default is Bambu Studio's own PROJECT envelope, copied
 * from a template the owner's Studio saved (fixtures/bambu-templates/<key>/,
 * docs/BAMBU-PROJECT-EXPORT.md): Studio opens it as a project, so per-object
 * overrides and the cooling keys survive. Template, not invention - NSO writes
 * the parts that template has, in its order, and overlays only what NSO owns:
 *
 *   [Content_Types].xml, _rels/.rels, Metadata/*.png, slice_info.config,
 *   filament_sequence.json          the template's bytes, verbatim
 *   3D/3dmodel.model                Studio's Application tag (the template's
 *                                   version, never newer), one <components>
 *                                   wrapper per piece, placement on the item
 *   3D/_rels/3dmodel.model.rels     one relationship per object part
 *   3D/Objects/object_N.model       piece N's mesh, centred on its own origin
 *   Metadata/project_settings.config   the template's keys, NSO's 14 cooling
 *                                   keys overlaid on every filament slot
 *   Metadata/model_settings.config  project shape: names, overrides, parts,
 *                                   the plate with identify_id per instance,
 *                                   <assemble>
 *   Metadata/cut_information.xml, Metadata/plate_1.json   per piece
 *   Metadata/nso_profile.json, Metadata/nso_scene.json    NSO's own, as below
 *
 * When the template cannot be read (a page opened from file://, say), the
 * export falls back to NSO's original envelope, which Studio loads as
 * geometry only:
 *
 *   [Content_Types].xml            OPC part types
 *   _rels/.rels                    root relationship -> the model part
 *   3D/3dmodel.model               core 3MF geometry (millimetres, Z up), one
 *                                  named object per piece so the slicer keeps them apart
 *   Metadata/project_settings.config   <- the baked cooling settings
 *   Metadata/model_settings.config     Bambu object/plate names
 *   Metadata/nso_profile.json          NSO provenance (see note below)
 *   Metadata/nso_scene.json            NSO scene state, when a scene is given
 *
 * Note on provenance: NSO's own bookkeeping deliberately lives in a separate
 * part, NOT as extra keys inside project_settings.config. Bambu Studio warns on
 * keys it does not recognise, so project_settings.config carries Studio's own
 * keys only. Metadata/nso_scene.json - the whole working
 * plate, written only when the caller passes one - sits alongside for the same
 * reason; nso-3mf-scene.js owns its schema and this writer only stores the
 * bytes it is handed.
 *
 * No third-party dependencies -- the ZIP writer is below; the template is
 * opened with nso-3mf-read.js. Runs in the browser and in Node (both have
 * CompressionStream), so the round-trip validator
 * exercises the exact code path the app uses.
 */
(function (root, factory) {
  'use strict';
  var node = typeof module === 'object' && module.exports;
  // Host: how the Bambu template is read. Node reads it off disk next to this
  // file; the browser fetches it from the same site (read: null).
  var api = factory(
    node ? require('./nso-cooling-profiles.js') : root.NSOCoolingProfiles,
    node ? {
      read: function (rel) { return require('fs').readFileSync(require('path').join(__dirname, rel)); },
      reader: function () { return require('./nso-3mf-read.js'); }
    } : {
      read: null,
      reader: function () { return root.NSO3MFRead; }
    }
  );
  if (node) module.exports = api;
  if (root) root.NSO3MF = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Profiles, Host) {
  'use strict';

  // ===========================================================================
  // CRC32
  // ===========================================================================
  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ===========================================================================
  // Minimal ZIP writer (deflate when available, stored otherwise)
  // ===========================================================================

  function utf8(str) {
    return new TextEncoder().encode(str);
  }

  function deflateRaw(bytes) {
    if (typeof CompressionStream !== 'function' || !bytes.length) {
      return Promise.resolve(null); // caller falls back to stored
    }
    try {
      var cs = new CompressionStream('deflate-raw');
      var writer = cs.writable.getWriter();
      writer.write(bytes);
      writer.close();
      return new Response(cs.readable).arrayBuffer()
        .then(function (buf) { return new Uint8Array(buf); })
        .catch(function () { return null; });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function Writer(size) {
    this.buf = new Uint8Array(size);
    this.view = new DataView(this.buf.buffer);
    this.at = 0;
  }
  Writer.prototype.u16 = function (v) { this.view.setUint16(this.at, v, true); this.at += 2; };
  Writer.prototype.u32 = function (v) { this.view.setUint32(this.at, v >>> 0, true); this.at += 4; };
  Writer.prototype.bytes = function (b) { this.buf.set(b, this.at); this.at += b.length; };

  /**
   * @param {{name:string, data:Uint8Array}[]} entries
   * @returns {Promise<Uint8Array>} the ZIP archive
   */
  function buildZip(entries) {
    // DOS timestamp is fixed so the same plate + profile always produces a
    // byte-identical archive. Makes exports diffable and the round-trip test
    // deterministic. 1980-01-01 00:00:00.
    var DOS_TIME = 0;
    var DOS_DATE = 33; // (1980-1980)<<9 | 1<<5 | 1

    var prepared = entries.map(function (e) {
      var nameBytes = utf8(e.name);
      return { nameBytes: nameBytes, raw: e.data, crc: crc32(e.data) };
    });

    return Promise.all(prepared.map(function (p) {
      return deflateRaw(p.raw).then(function (def) {
        // Only take the deflated form if it actually saved space.
        if (def && def.length < p.raw.length) {
          p.method = 8;
          p.body = def;
        } else {
          p.method = 0;
          p.body = p.raw;
        }
        return p;
      });
    })).then(function (parts) {
      var localSize = 0, centralSize = 0;
      parts.forEach(function (p) {
        localSize += 30 + p.nameBytes.length + p.body.length;
        centralSize += 46 + p.nameBytes.length;
      });

      var w = new Writer(localSize + centralSize + 22);

      parts.forEach(function (p) {
        p.offset = w.at;
        w.u32(0x04034B50);          // local file header signature
        w.u16(20);                  // version needed
        w.u16(0x0800);              // flags: UTF-8 names
        w.u16(p.method);
        w.u16(DOS_TIME);
        w.u16(DOS_DATE);
        w.u32(p.crc);
        w.u32(p.body.length);
        w.u32(p.raw.length);
        w.u16(p.nameBytes.length);
        w.u16(0);                   // extra field length
        w.bytes(p.nameBytes);
        w.bytes(p.body);
      });

      var centralStart = w.at;
      parts.forEach(function (p) {
        w.u32(0x02014B50);          // central directory header signature
        w.u16(20);                  // version made by
        w.u16(20);                  // version needed
        w.u16(0x0800);
        w.u16(p.method);
        w.u16(DOS_TIME);
        w.u16(DOS_DATE);
        w.u32(p.crc);
        w.u32(p.body.length);
        w.u32(p.raw.length);
        w.u16(p.nameBytes.length);
        w.u16(0);                   // extra
        w.u16(0);                   // comment
        w.u16(0);                   // disk number
        w.u16(0);                   // internal attrs
        w.u32(0);                   // external attrs
        w.u32(p.offset);
        w.bytes(p.nameBytes);
      });

      // Capture this before writing the EOCD -- w.at advances as we go and the
      // size field must describe the central directory only.
      var centralSize2 = w.at - centralStart;

      w.u32(0x06054B50);            // end of central directory
      w.u16(0);                     // this disk
      w.u16(0);                     // disk with central directory
      w.u16(parts.length);          // entries on this disk
      w.u16(parts.length);          // entries total
      w.u32(centralSize2);          // central directory size
      w.u32(centralStart);          // central directory offset
      w.u16(0);                     // comment length

      return w.buf.subarray(0, w.at);
    });
  }

  // ===========================================================================
  // XML parts
  // ===========================================================================

  function xmlEscape(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  var CONTENT_TYPES =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
    ' <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
    ' <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n' +
    ' <Default Extension="config" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n' +
    ' <Default Extension="json" ContentType="application/json"/>\n' +
    '</Types>\n';

  var RELS =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
    ' <Relationship Target="/3D/3dmodel.model" Id="rel-1" ' +
    'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n' +
    '</Relationships>\n';

  /** Round to 6 dp and strip the trailing ".000000" noise. */
  function num(v) {
    var s = v.toFixed(6);
    if (s.indexOf('.') !== -1) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s === '-0' ? '0' : s;
  }

  var KNOB_TAGS = [['trunkTipMm', 'trunk'], ['trunkAngleDeg', 'angle'], ['leanDeg', 'lean'], ['nodeMm', 'node']];

  /**
   * "trunk1.2 angle3 lean30 node4": the support knobs that are NOT the
   * defaults (nso_support_gridpack.js plan.knobs.nonDefault), in that order,
   * so a print says what made it. '' when none is, and the name is as it
   * always was.
   */
  function knobTag(k) {
    if (!k || typeof k !== 'object') return '';
    var parts = [];
    KNOB_TAGS.forEach(function (t) {
      var v = k[t[0]];
      if (typeof v === 'number' && isFinite(v)) parts.push(t[1] + String(+v.toFixed(3)));
    });
    return parts.join(' ');
  }

  /**
   * The name an object is written under, in both the model and the settings
   * part. A support built with knobs (obj.supportKnobs) carries them: inside
   * the closing bracket of "<piece> - support 1.1 (Tree)" so the name still
   * reads as the card's ("... (Tree trunk1.2 angle3 lean30)"), else after it.
   */
  function objectName(obj, i) {
    var name = (obj && obj.name) || ('object_' + (i + 1)), tag = knobTag(obj && obj.supportKnobs);
    if (!tag) return name;
    return name.charAt(name.length - 1) === ')' ? name.slice(0, -1) + ' ' + tag + ')' : name + ' ' + tag;
  }

  // 3MF's production extension wants a UUID on every object, on <build> and on
  // every <item>. Ours are derived from the object's own identity rather than
  // generated, because the same plate + profile must keep producing byte-
  // identical archives (see the determinism check in tools/3mf-test). Bambu
  // Studio does the same thing -- its own files carry counter-shaped UUIDs like
  // "00000001-61cb-4c03-9d28-80fed5dfa1dc" -- so a derived UUID is precedented,
  // not a shortcut. Uniqueness only has to hold inside the one package.
  function hash32(str, seed) {
    var h = (seed >>> 0) ^ 0x811C9DC5;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      h = Math.imul(h ^ (c & 0xFF), 0x01000193) >>> 0;
      h = Math.imul(h ^ ((c >>> 8) & 0xFF), 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  function hex8(v) {
    return ('0000000' + (v >>> 0).toString(16)).slice(-8);
  }

  /** A stable RFC 4122 v4-shaped UUID for `seed`. Same seed, same UUID, always. */
  function uuidFor(seed) {
    var h = hex8(hash32(seed, 0x9E3779B9)) + hex8(hash32(seed, 0x85EBCA6B)) +
            hex8(hash32(seed, 0xC2B2AE35)) + hex8(hash32(seed, 0x27D4EB2F));
    // Version nibble 4, and the variant nibble forced into 8/9/a/b.
    var variant = '89ab'.charAt(parseInt(h.charAt(16), 16) & 3);
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) +
           '-' + variant + h.slice(17, 20) + '-' + h.slice(20, 32);
  }

  function objectUuid(obj, i) {
    return uuidFor('object:' + i + ':' + objectName(obj, i) + ':' +
                   obj.vertices.length + ':' + obj.triangles.length);
  }

  /**
   * Build 3D/3dmodel.model.
   * @param {{name:string, vertices:number[], triangles:number[]}[]} objects
   *        vertices are flat [x,y,z,...] in millimetres, Z up, plate coordinates.
   *
   * Each piece is written as its own <object> carrying its name and a UUID, with
   * its own <item> in <build>. The name has to be on the <object> element: a name
   * that lives only in Metadata/model_settings.config does not reliably reach the
   * slicer, and without per-object identity Bambu Studio collapses the plate into
   * a single object -- one OBJECT_ID for the whole print instead of one per piece.
   * Confirmed against a real slice; see docs/3MF-OBJECT-IDENTITY.md.
   */
  function buildModelXml(objects) {
    var out = [];
    out.push('<?xml version="1.0" encoding="UTF-8"?>');
    out.push('<model unit="millimeter" xml:lang="en-US" ' +
             'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ' +
             'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">');
    out.push(' <metadata name="Application">Nest Optimizer</metadata>');
    out.push(' <resources>');
    objects.forEach(function (obj, i) {
      var id = i + 1;
      out.push('  <object id="' + id + '" name="' + xmlEscape(objectName(obj, i)) +
               '" type="model" p:UUID="' + objectUuid(obj, i) + '">');
      out.push('   <mesh>');
      out.push('    <vertices>');
      for (var v = 0; v < obj.vertices.length; v += 3) {
        out.push('     <vertex x="' + num(obj.vertices[v]) +
                 '" y="' + num(obj.vertices[v + 1]) +
                 '" z="' + num(obj.vertices[v + 2]) + '"/>');
      }
      out.push('    </vertices>');
      out.push('    <triangles>');
      for (var t = 0; t < obj.triangles.length; t += 3) {
        out.push('     <triangle v1="' + obj.triangles[t] +
                 '" v2="' + obj.triangles[t + 1] +
                 '" v3="' + obj.triangles[t + 2] + '"/>');
      }
      out.push('    </triangles>');
      out.push('   </mesh>');
      out.push('  </object>');
    });
    out.push(' </resources>');
    out.push(' <build p:UUID="' + uuidFor('build') + '">');
    objects.forEach(function (obj, i) {
      out.push('  <item objectid="' + (i + 1) + '" transform="1 0 0 0 1 0 0 0 1 0 0 0"' +
               ' p:UUID="' + uuidFor('item:' + i + ':' + objectName(obj, i)) + '"/>');
    });
    out.push(' </build>');
    out.push('</model>');
    return out.join('\n') + '\n';
  }

  /** Bambu-specific object/plate naming, and an object's own settings.
   *  Bambu regenerates what it needs. obj.settings ({key: value}, optional)
   *  is written as the object's metadata, as Bambu saves a per-object
   *  override: Bambu Studio reads it into that object's config for any
   *  vendor's 3MF (and drops it when the file is imported as geometry only). */
  function buildModelSettings(objects) {
    var out = [];
    out.push('<?xml version="1.0" encoding="UTF-8"?>');
    out.push('<config>');
    objects.forEach(function (obj, i) {
      out.push('  <object id="' + (i + 1) + '">');
      out.push('    <metadata key="name" value="' + xmlEscape(objectName(obj, i)) + '"/>');
      Object.keys(obj.settings || {}).forEach(function (k) {
        out.push('    <metadata key="' + xmlEscape(k) + '" value="' + xmlEscape(String(obj.settings[k])) + '"/>');
      });
      out.push('  </object>');
    });
    out.push('  <plate>');
    out.push('    <metadata key="plater_id" value="1"/>');
    out.push('    <metadata key="plater_name" value=""/>');
    objects.forEach(function (obj, i) {
      out.push('    <model_instance>');
      out.push('      <metadata key="object_id" value="' + (i + 1) + '"/>');
      out.push('      <metadata key="instance_id" value="0"/>');
      out.push('    </model_instance>');
    });
    out.push('  </plate>');
    out.push('</config>');
    return out.join('\n') + '\n';
  }

  var PART_PROJECT_SETTINGS = 'Metadata/project_settings.config';
  var PART_MODEL = '3D/3dmodel.model';
  var PART_MODEL_SETTINGS = 'Metadata/model_settings.config';
  var PART_NSO_PROFILE = 'Metadata/nso_profile.json';
  var PART_NSO_SCENE = 'Metadata/nso_scene.json';

  // ===========================================================================
  // Bambu Studio project envelope (docs/BAMBU-PROJECT-EXPORT.md)
  // ===========================================================================
  //
  // One template per printer + nozzle: fixtures/bambu-templates/<key>/ holds a
  // project the owner's Studio saved and template.json, its record (the Studio
  // version among it). A new printer is a new directory, no code.
  //
  // COMPATIBILITY SHIM, ON RECORD: the root model's Application tag says
  // "BambuStudio-<version>" although NSO wrote the file. That is deliberate -
  // Studio loads a 3MF as a project (per-object config, project settings) only
  // when it was written by Studio - and the version is always the template's
  // recorded one, never newer. loadTemplate refuses a template whose own tag
  // differs from its record, and export:bambu fails if the written tag ever
  // differs from the fixture's recorded version.

  var TEMPLATE_DIR = 'fixtures/bambu-templates/';
  var DEFAULT_TEMPLATE = 'a1mini-0.4';

  // Bambu Studio's fixed UUID suffixes (bbs_3mf.cpp); the counter in front is
  // eight hex digits: object N, sub-object and component N << 16, build item
  // the wrapper object's id - exactly as the template carries them.
  var OBJECT_UUID_SUFFIX = '-61cb-4c03-9d28-80fed5dfa1dc';
  var SUB_OBJECT_UUID_SUFFIX = '-81cb-4c03-9d28-80fed5dfa1dc';
  var COMPONENT_UUID_SUFFIX = '-b206-40ff-9872-83e8017abed1';
  var BUILD_ITEM_UUID_SUFFIX = '-b1ec-4553-aec9-835e5b724bb4';

  var NS_CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
  var NS_BAMBU = 'http://schemas.bambulab.com/package/2021';
  var NS_PROD = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
  var REL_3DMODEL = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';
  var MODEL_OPEN = '<model unit="millimeter" xml:lang="en-US" xmlns="' + NS_CORE +
    '" xmlns:BambuStudio="' + NS_BAMBU + '" xmlns:p="' + NS_PROD + '" requiredextensions="p">';
  var IDENTITY_3X4 = '1 0 0 0 1 0 0 0 1 0 0 0';
  var IDENTITY_4X4 = '1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1';

  var PART_ROOT_RELS = '3D/_rels/3dmodel.model.rels';
  var PART_CUT_INFO = 'Metadata/cut_information.xml';
  var PART_PLATE_JSON = 'Metadata/plate_1.json';
  var OBJECTS_PREFIX = '3D/Objects/';

  function bambuUuid(counter, suffix) {
    return hex8(counter) + suffix;
  }

  function objectPartName(n) {
    return OBJECTS_PREFIX + 'object_' + n + '.model';
  }

  var templateCache = {};

  function decodeText(bytes) {
    return new TextDecoder().decode(bytes);
  }

  function readTemplateFile(rel) {
    if (Host && Host.read) {
      try { return Promise.resolve(new Uint8Array(Host.read(rel))); }
      catch (e) { return Promise.reject(e); }
    }
    if (typeof fetch !== 'function') return Promise.reject(new Error('cannot read ' + rel + ' (no fetch)'));
    return fetch(rel).then(function (r) {
      if (!r.ok) throw new Error(rel + ': HTTP ' + r.status);
      return r.arrayBuffer();
    }).then(function (buf) { return new Uint8Array(buf); });
  }

  /**
   * Read fixtures/bambu-templates/<key>/: template.json and the project it
   * names. Cached per key; a failed load is retried on the next export.
   * @returns {Promise<object>} the parsed template (see parseTemplate)
   */
  function loadTemplate(key) {
    key = key || DEFAULT_TEMPLATE;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) return Promise.reject(new Error('Bad template key "' + key + '"'));
    if (templateCache[key]) return templateCache[key];
    var dir = TEMPLATE_DIR + key + '/';
    var p = readTemplateFile(dir + 'template.json').then(function (bytes) {
      var record = JSON.parse(decodeText(bytes));
      if (!record.studio_version || !record.file) {
        throw new Error(dir + 'template.json must record studio_version and file');
      }
      return readTemplateFile(dir + record.file).then(function (zipBytes) {
        var Reader = Host && Host.reader && Host.reader();
        if (!Reader || !Reader.openZip) throw new Error('nso-3mf-read.js is not loaded');
        var zip = Reader.openZip(zipBytes);
        var names = zip.names();
        // The template's own meshes are never used, so they are not inflated.
        var wanted = names.filter(function (n) { return n.indexOf(OBJECTS_PREFIX) !== 0; });
        return Promise.all(wanted.map(function (n) { return zip.read(n); })).then(function (datas) {
          var parts = {};
          wanted.forEach(function (n, i) { parts[n] = datas[i]; });
          return parseTemplate(key, record, names, parts);
        });
      });
    });
    templateCache[key] = p;
    p.catch(function () { delete templateCache[key]; });
    return p;
  }

  function parseTemplate(key, record, names, parts) {
    var where = TEMPLATE_DIR + key + '/' + record.file;
    [PART_MODEL, PART_ROOT_RELS, PART_PROJECT_SETTINGS, PART_MODEL_SETTINGS].forEach(function (n) {
      if (!parts[n]) throw new Error(where + ' has no ' + n);
    });
    names.forEach(function (n) {
      // A template is an unsliced project: a sliced one would carry its G-code
      // into every export.
      if (/\.(gcode|md5)$/i.test(n)) throw new Error(where + ' is sliced (' + n + '); save the project unsliced');
    });

    var modelXml = decodeText(parts[PART_MODEL]);
    var head = modelXml.slice(0, modelXml.indexOf('<resources'));
    var modelMeta = [];
    head.replace(/<metadata name="([^"]*)">([^<]*)<\/metadata>/g, function (m, k, v) {
      modelMeta.push([k, v]);
      return m;
    });
    var app = modelMeta.filter(function (kv) { return kv[0] === 'Application'; })[0];
    var tag = 'BambuStudio-' + record.studio_version;
    if (!app || app[1] !== tag) {
      throw new Error(where + ' was written by "' + (app ? app[1] : '?') + '" but template.json records ' + tag);
    }

    var ms = decodeText(parts[PART_MODEL_SETTINGS]);
    var plate = (ms.match(/<plate>([\s\S]*?)<\/plate>/) || [])[1] || '';
    var plateHead = plate.split('<model_instance>')[0];
    var plateMeta = [];
    plateHead.replace(/<metadata key="([^"]*)" value="([^"]*)"\/>/g, function (m, k, v) {
      plateMeta.push([k, v]);
      return m;
    });
    var extruder = (ms.match(/<object id="[^"]*">\s*<metadata key="name" value="[^"]*"\/>\s*<metadata key="extruder" value="([^"]*)"\/>/) || [])[1] || '1';

    return {
      key: key,
      record: record,
      tag: tag,
      names: names.slice(),
      parts: parts,
      modelMeta: modelMeta,
      settings: JSON.parse(decodeText(parts[PART_PROJECT_SETTINGS])),
      plateMeta: plateMeta,
      extruder: extruder,
      plateJson: parts[PART_PLATE_JSON] ? JSON.parse(decodeText(parts[PART_PLATE_JSON])) : null
    };
  }

  /** The template's project settings with NSO's cooling values on every
   *  filament slot, pretty-printed the way Studio writes the file.
   *
   *  different_settings_to_system is Studio's list, per preset (the process,
   *  each filament slot, the printer; keys joined by ';', sorted), of the keys
   *  the project changed from that system preset. A filament slot whose list
   *  is empty loads as the system preset itself and its project values are
   *  dropped: the owner's first open showed Generic PLA's own 0 s / 8 s, not
   *  NSO's 2 s / 6 s. So every key NSO changes from the template's slot (the
   *  template's filaments are system presets) joins that slot's list. */
  function overlayProjectSettings(tplSettings, values) {
    var problems = Profiles.validateValues(values);
    if (problems.length) {
      throw new Error('Refusing to write invalid cooling settings:\n  - ' + problems.join('\n  - '));
    }
    var out = JSON.parse(JSON.stringify(tplSettings));
    var diffs = out.different_settings_to_system;
    var slots = (out.filament_settings_id || []).length;
    if (!Array.isArray(diffs) || diffs.length !== slots + 2) {
      throw new Error('The template\'s different_settings_to_system is not process + ' + slots + ' filaments + printer');
    }
    Object.keys(values).forEach(function (k) {
      if (!Array.isArray(out[k]) || out[k].length !== slots) {
        throw new Error('The template has no per-filament "' + k + '" to overlay');
      }
      out[k] = out[k].map(function (was, i) {
        if (was !== values[k]) {
          var keys = diffs[i + 1] ? diffs[i + 1].split(';') : [];
          if (keys.indexOf(k) === -1) diffs[i + 1] = keys.concat([k]).sort().join(';');
        }
        return values[k];
      });
    });
    return JSON.stringify(out, null, 4) + '\n';
  }

  /** Where piece i sits: its bounding-box centre, at the writer's 6 dp, so
   *  centre + (vertex - centre) prints back to the vertex. */
  function placementOf(obj) {
    var v = obj.vertices;
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < v.length; i += 3) {
      for (var a = 0; a < 3; a++) {
        if (v[i + a] < lo[a]) lo[a] = v[i + a];
        if (v[i + a] > hi[a]) hi[a] = v[i + a];
      }
    }
    if (!v.length) lo = hi = [0, 0, 0];
    return {
      lo: lo,
      hi: hi,
      c: [0, 1, 2].map(function (a) { return +num((lo[a] + hi[a]) / 2); })
    };
  }

  /**
   * identify_id per instance, as the template carries it. Studio does NOT
   * label the G-code with it: the owner's first slice labelled NSO's 1098 /
   * 8388 as 96 / 107, its own runtime ids (slice_info.config pairs each label
   * with the object's name). An object's own identifyId (a
   * positive integer) is used when it has one; otherwise it is derived from
   * the piece's name and face count, so the same plate exports the same ids.
   * A collision steps to the next free id, in object order.
   */
  function identifyIds(objects) {
    var used = {};
    return objects.map(function (obj, i) {
      var id = obj.identifyId;
      if (!(id === (id | 0) && id > 0)) {
        id = 1 + hash32('identify:' + objectName(obj, i) + ':' + (obj.triangles.length / 3), 0x5BD1E995) % 65535;
      }
      while (used[id]) id = id % 65535 + 1;
      used[id] = true;
      return id;
    });
  }

  function buildProjectModelXml(objects, places, tpl, date) {
    var out = [];
    out.push('<?xml version="1.0" encoding="UTF-8"?>');
    out.push(MODEL_OPEN);
    tpl.modelMeta.forEach(function (kv) {
      var v = kv[1];
      if (kv[0] === 'Application') v = tpl.tag;
      else if (kv[0] === 'CreationDate' || kv[0] === 'ModificationDate') v = date;
      else if (kv[0] === 'DesignerUserId') v = '';   // the template owner's account, not the export's
      out.push(' <metadata name="' + xmlEscape(kv[0]) + '">' + xmlEscape(v) + '</metadata>');
    });
    out.push(' <resources>');
    objects.forEach(function (obj, i) {
      var n = i + 1;
      out.push('  <object id="' + (2 * n) + '" p:UUID="' + bambuUuid(n, OBJECT_UUID_SUFFIX) + '" type="model">');
      out.push('   <components>');
      out.push('    <component p:path="/' + objectPartName(n) + '" objectid="' + (2 * n - 1) +
               '" p:UUID="' + bambuUuid(n << 16, COMPONENT_UUID_SUFFIX) + '" transform="' + IDENTITY_3X4 + '"/>');
      out.push('   </components>');
      out.push('  </object>');
    });
    out.push(' </resources>');
    out.push(' <build p:UUID="' + uuidFor('build') + '">');
    objects.forEach(function (obj, i) {
      var n = i + 1, c = places[i].c;
      out.push('  <item objectid="' + (2 * n) + '" p:UUID="' + bambuUuid(2 * n, BUILD_ITEM_UUID_SUFFIX) +
               '" transform="1 0 0 0 1 0 0 0 1 ' + num(c[0]) + ' ' + num(c[1]) + ' ' + num(c[2]) +
               '" printable="1"/>');
    });
    out.push(' </build>');
    out.push('</model>');
    return out.join('\n') + '\n';
  }

  function buildObjectPartXml(obj, n, c, tpl) {
    var version = (tpl.modelMeta.filter(function (kv) { return kv[0] === 'BambuStudio:3mfVersion'; })[0] || [0, '1'])[1];
    var out = [];
    out.push('<?xml version="1.0" encoding="UTF-8"?>');
    out.push(MODEL_OPEN);
    out.push(' <metadata name="BambuStudio:3mfVersion">' + xmlEscape(version) + '</metadata>');
    out.push(' <resources>');
    out.push('  <object id="' + (2 * n - 1) + '" p:UUID="' + bambuUuid(n << 16, SUB_OBJECT_UUID_SUFFIX) + '" type="model">');
    out.push('   <mesh>');
    out.push('    <vertices>');
    for (var v = 0; v < obj.vertices.length; v += 3) {
      out.push('     <vertex x="' + num(obj.vertices[v] - c[0]) +
               '" y="' + num(obj.vertices[v + 1] - c[1]) +
               '" z="' + num(obj.vertices[v + 2] - c[2]) + '"/>');
    }
    out.push('    </vertices>');
    out.push('    <triangles>');
    for (var t = 0; t < obj.triangles.length; t += 3) {
      out.push('     <triangle v1="' + obj.triangles[t] +
               '" v2="' + obj.triangles[t + 1] +
               '" v3="' + obj.triangles[t + 2] + '"/>');
    }
    out.push('    </triangles>');
    out.push('   </mesh>');
    out.push('  </object>');
    out.push(' </resources>');
    out.push(' <build/>');
    out.push('</model>');
    return out.join('\n') + '\n';
  }

  function buildRootRels(objects) {
    var out = [];
    out.push('<?xml version="1.0" encoding="UTF-8"?>');
    out.push('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">');
    objects.forEach(function (obj, i) {
      out.push(' <Relationship Target="/' + objectPartName(i + 1) + '" Id="rel-' + (i + 1) + '" Type="' + REL_3DMODEL + '"/>');
    });
    out.push('</Relationships>');
    return out.join('\n');
  }

  /** model_settings.config in project shape. An object's own settings sit
   *  with its extruder in key order, as Studio saves a per-object override. */
  function buildProjectModelSettings(objects, places, ids, tpl, sourceFile) {
    var out = [];
    out.push('<?xml version="1.0" encoding="UTF-8"?>');
    out.push('<config>');
    objects.forEach(function (obj, i) {
      var n = i + 1, c = places[i].c, name = xmlEscape(objectName(obj, i));
      var faces = obj.triangles.length / 3;
      var cfg = { extruder: tpl.extruder };
      Object.keys(obj.settings || {}).forEach(function (k) { cfg[k] = String(obj.settings[k]); });
      out.push('  <object id="' + (2 * n) + '">');
      out.push('    <metadata key="name" value="' + name + '"/>');
      Object.keys(cfg).sort().forEach(function (k) {
        out.push('    <metadata key="' + xmlEscape(k) + '" value="' + xmlEscape(cfg[k]) + '"/>');
      });
      out.push('    <metadata face_count="' + faces + '"/>');
      out.push('    <part id="' + (2 * n - 1) + '" subtype="normal_part" uuid="' +
               uuidFor('part:' + i + ':' + objectName(obj, i) + ':' + faces) + '">');
      out.push('      <metadata key="name" value="' + name + '"/>');
      out.push('      <metadata key="matrix" value="' + IDENTITY_4X4 + '"/>');
      out.push('      <metadata key="source_file" value="' + xmlEscape(sourceFile) + '"/>');
      out.push('      <metadata key="source_object_id" value="' + i + '"/>');
      out.push('      <metadata key="source_volume_id" value="0"/>');
      out.push('      <metadata key="source_offset_x" value="' + num(c[0]) + '"/>');
      out.push('      <metadata key="source_offset_y" value="' + num(c[1]) + '"/>');
      out.push('      <metadata key="source_offset_z" value="' + num(c[2]) + '"/>');
      out.push('      <mesh_stat face_count="' + faces + '" edges_fixed="0" degenerate_facets="0" ' +
               'facets_removed="0" facets_reversed="0" backwards_edges="0"/>');
      out.push('    </part>');
      out.push('  </object>');
    });
    out.push('  <plate>');
    tpl.plateMeta.forEach(function (kv) {
      out.push('    <metadata key="' + xmlEscape(kv[0]) + '" value="' + xmlEscape(kv[1]) + '"/>');
    });
    objects.forEach(function (obj, i) {
      out.push('    <model_instance>');
      out.push('      <metadata key="object_id" value="' + (2 * (i + 1)) + '"/>');
      out.push('      <metadata key="instance_id" value="0"/>');
      out.push('      <metadata key="identify_id" value="' + ids[i] + '"/>');
      out.push('    </model_instance>');
    });
    out.push('  </plate>');
    out.push('  <assemble>');
    objects.forEach(function (obj, i) {
      var id = 2 * (i + 1), c = places[i].c;
      out.push('   <assemble_item object_id="' + id + '" instance_id="0" transform="1 0 0 0 1 0 0 0 1 ' +
               num(c[0]) + ' ' + num(c[1]) + ' ' + num(c[2]) + '" offset="0 0 0" />');
      out.push('   <assemble_item object_id="' + id + '" volume_id="0" transform="' + IDENTITY_3X4 + '" />');
    });
    out.push('  </assemble>');
    out.push('</config>');
    return out.join('\n') + '\n';
  }

  function buildCutInformation(objects) {
    var out = ['<?xml version="1.0" encoding="utf-8"?>', '<objects>'];
    objects.forEach(function (obj, i) {
      out.push(' <object id="' + (i + 1) + '">');
      out.push('  <cut_id id="0" check_sum="1" connectors_cnt="0"/>');
      out.push(' </object>');
    });
    out.push('</objects>');
    return out.join('\n');
  }

  /** Metadata/plate_1.json: the template's fields, with each piece's first
   *  layer (its faces lying on the plate) as its bbox and area. NSO has not
   *  sliced, so first_layer_time is 0; Studio rewrites the file when it does. */
  function buildPlateJson(objects, places, ids, tpl) {
    var json = JSON.parse(JSON.stringify(tpl.plateJson || {}));
    var layer = parseFloat(tpl.settings.layer_height) || 0.2;
    var all = null;
    json.bbox_objects = objects.map(function (obj, i) {
      var v = obj.vertices, t = obj.triangles, lo = places[i].lo, hi = places[i].hi;
      var area = 0, bb = null;
      for (var k = 0; k < t.length; k += 3) {
        var a = 3 * t[k], b = 3 * t[k + 1], c = 3 * t[k + 2];
        if (v[a + 2] > lo[2] + 1e-4 || v[b + 2] > lo[2] + 1e-4 || v[c + 2] > lo[2] + 1e-4) continue;
        var cross = (v[b] - v[a]) * (v[c + 1] - v[a + 1]) - (v[b + 1] - v[a + 1]) * (v[c] - v[a]);
        if (cross >= 0) continue;   // facing up: not a face on the plate
        area -= cross / 2;
        [a, b, c].forEach(function (p) {
          if (!bb) bb = [v[p], v[p + 1], v[p], v[p + 1]];
          bb = [Math.min(bb[0], v[p]), Math.min(bb[1], v[p + 1]), Math.max(bb[2], v[p]), Math.max(bb[3], v[p + 1])];
        });
      }
      if (!bb) bb = [lo[0], lo[1], hi[0], hi[1]];
      all = all ? [Math.min(all[0], bb[0]), Math.min(all[1], bb[1]), Math.max(all[2], bb[2]), Math.max(all[3], bb[3])] : bb.slice();
      return { area: +num(area), bbox: bb.map(function (x) { return +num(x); }), id: ids[i],
               layer_height: layer, name: objectName(obj, i) };
    });
    json.bbox_all = (all || [0, 0, 0, 0]).map(function (x) { return +num(x); });
    if ('first_layer_time' in json) json.first_layer_time = 0;
    // bbox_all first, as Studio orders the file.
    var ordered = { bbox_all: json.bbox_all };
    Object.keys(json).forEach(function (k) { if (k !== 'bbox_all') ordered[k] = json[k]; });
    return JSON.stringify(ordered);
  }

  function todayIso() {
    var d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }

  /** The project archive's entries, in the template's part order. */
  function buildProjectEntries(objects, tpl, values, opts) {
    var places = objects.map(placementOf);
    var ids = identifyIds(objects);
    var settingsText = overlayProjectSettings(tpl.settings, values);
    var sourceFile = opts.sourceFile || ((opts.plateName || 'nso_plate') + '.3mf');
    var generated = {};
    generated[PART_MODEL] = function () { return buildProjectModelXml(objects, places, tpl, opts.date || todayIso()); };
    generated[PART_ROOT_RELS] = function () { return buildRootRels(objects); };
    generated[PART_PROJECT_SETTINGS] = function () { return settingsText; };
    generated[PART_MODEL_SETTINGS] = function () { return buildProjectModelSettings(objects, places, ids, tpl, sourceFile); };
    generated[PART_CUT_INFO] = function () { return buildCutInformation(objects); };
    generated[PART_PLATE_JSON] = function () { return buildPlateJson(objects, places, ids, tpl); };

    var entries = [], objectsDone = false;
    tpl.names.forEach(function (name) {
      if (name.indexOf(OBJECTS_PREFIX) === 0) {
        if (objectsDone) return;
        objectsDone = true;
        objects.forEach(function (obj, i) {
          entries.push({ name: objectPartName(i + 1), data: utf8(buildObjectPartXml(obj, i + 1, places[i].c, tpl)) });
        });
      } else if (generated[name]) {
        entries.push({ name: name, data: utf8(generated[name]()) });
      } else if (name !== PART_NSO_PROFILE && name !== PART_NSO_SCENE) {
        entries.push({ name: name, data: tpl.parts[name] });
      }
    });
    return { entries: entries, settingsText: settingsText, identifyIds: ids };
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * @param {object} opts
   * @param {{name:string, vertices:number[], triangles:number[], settings?:object, identifyId?:number, supportKnobs?:object}[]} opts.objects
   *        supportKnobs: a support's non-default knobs (plan.knobs.nonDefault),
   *        named in the object's name (knobTag);
   *        settings: the object's own slicer settings ({key: value}), written
   *        into Metadata/model_settings.config as its per-object override;
   *        identifyId: the instance's identify_id (derived when absent)
   * @param {string} [opts.profileId]   cooling profile to bake in
   * @param {string} [opts.plateName]
   * @param {string} [opts.sceneJson]   serialized NSO scene block; written as
   *        Metadata/nso_scene.json when given, omitted entirely when not
   * @param {string} [opts.template]    Bambu template key (DEFAULT_TEMPLATE)
   * @param {string} [opts.envelope]    'project' (default) or 'nso', NSO's
   *        original geometry-only envelope
   * @param {string} [opts.date]        YYYY-MM-DD for the model's dates (today)
   * @param {string} [opts.sourceFile]  the parts' source_file (plate name + .3mf)
   * @returns {Promise<{bytes:Uint8Array, profileId:string, values:object, settingsText:string,
   *          scene:boolean, envelope:string, template?:string, identifyIds?:number[], templateError?:string}>}
   *          envelope says which was written: 'project', or 'nso' when asked
   *          for or when the template could not be read (templateError)
   */
  function build3MF(opts) {
    opts = opts || {};
    var objects = opts.objects || [];
    if (!objects.length) return Promise.reject(new Error('No objects to export'));

    var profileId = Profiles.hasProfile(opts.profileId)
      ? opts.profileId
      : Profiles.DEFAULT_PROFILE_ID;

    var values = Profiles.resolveValues(profileId);
    var hasScene = opts.sceneJson != null && String(opts.sceneJson).length > 0;

    var provenance = JSON.stringify({
      generator: 'Nest Optimizer',
      cooling_profile: profileId,
      cooling_profile_tuned: !!(Profiles.getProfile(profileId) || {}).tuned,
      plate: opts.plateName || '',
      note: 'Cooling settings are baked into ' + PART_PROJECT_SETTINGS + '. ' +
            'Swapping the filament preset in Bambu Studio and choosing ' +
            '"Discard Modified Value" will drop them.'
    }, null, 2) + '\n';

    // NSO's own parts close every archive. The scene block is optional and
    // opaque here: nso-3mf-scene.js validated it on the way in.
    function nsoParts(entries) {
      entries.push({ name: PART_NSO_PROFILE, data: utf8(provenance) });
      if (hasScene) entries.push({ name: PART_NSO_SCENE, data: utf8(String(opts.sceneJson)) });
      return entries;
    }

    function nsoEnvelope(templateError) {
      // Throws on any format drift (missing key, stray/absent '%', bad enum).
      var settingsText = Profiles.serializeProjectSettings(values);
      var entries = nsoParts([
        { name: '[Content_Types].xml', data: utf8(CONTENT_TYPES) },
        { name: '_rels/.rels', data: utf8(RELS) },
        { name: PART_MODEL, data: utf8(buildModelXml(objects)) },
        { name: PART_PROJECT_SETTINGS, data: utf8(settingsText) },
        { name: PART_MODEL_SETTINGS, data: utf8(buildModelSettings(objects)) }
      ]);
      return buildZip(entries).then(function (bytes) {
        var r = { bytes: bytes, profileId: profileId, values: values, settingsText: settingsText,
                  scene: hasScene, envelope: 'nso' };
        if (templateError) r.templateError = templateError;
        return r;
      });
    }

    if (opts.envelope === 'nso') return nsoEnvelope(null);

    var templateKey = opts.template || DEFAULT_TEMPLATE;
    return loadTemplate(templateKey).then(function (tpl) {
      var built = buildProjectEntries(objects, tpl, values, opts);
      return buildZip(nsoParts(built.entries)).then(function (bytes) {
        return { bytes: bytes, profileId: profileId, values: values, settingsText: built.settingsText,
                 scene: hasScene, envelope: 'project', template: tpl.key,
                 studioVersion: tpl.record.studio_version, identifyIds: built.identifyIds };
      });
    }, function (err) {
      var why = 'Bambu template "' + templateKey + '" unavailable (' + (err && err.message || err) +
                '); wrote the geometry-only envelope';
      if (typeof console !== 'undefined' && console.warn) console.warn('NSO3MF: ' + why);
      return nsoEnvelope(why);
    });
  }

  /**
   * Collapse a flat triangle soup [x,y,z, x,y,z, ...] into indexed vertices.
   * Dedup key is the rounded coordinate triple, matching the 6 dp the XML
   * writer emits, so two vertices that serialise identically share an index.
   */
  function indexTriangleSoup(flat) {
    var vertices = [];
    var triangles = [];
    var seen = new Map();
    for (var i = 0; i < flat.length; i += 3) {
      var x = flat[i], y = flat[i + 1], z = flat[i + 2];
      var key = num(x) + ',' + num(y) + ',' + num(z);
      var idx = seen.get(key);
      if (idx === undefined) {
        idx = vertices.length / 3;
        seen.set(key, idx);
        vertices.push(x, y, z);
      }
      triangles.push(idx);
    }
    // Drop degenerate triangles -- Bambu Studio flags them as mesh errors.
    var kept = [];
    for (var t = 0; t + 2 < triangles.length; t += 3) {
      var a = triangles[t], b = triangles[t + 1], c = triangles[t + 2];
      if (a !== b && b !== c && a !== c) kept.push(a, b, c);
    }
    return { vertices: vertices, triangles: kept };
  }

  return {
    build3MF: build3MF,
    objectName: objectName,
    knobTag: knobTag,
    indexTriangleSoup: indexTriangleSoup,
    buildZip: buildZip,
    crc32: crc32,
    PART_PROJECT_SETTINGS: PART_PROJECT_SETTINGS,
    PART_MODEL: PART_MODEL,
    PART_MODEL_SETTINGS: PART_MODEL_SETTINGS,
    PART_NSO_PROFILE: PART_NSO_PROFILE,
    PART_NSO_SCENE: PART_NSO_SCENE,
    // The Bambu project envelope (docs/BAMBU-PROJECT-EXPORT.md)
    loadTemplate: loadTemplate,
    overlayProjectSettings: overlayProjectSettings,
    identifyIds: identifyIds,
    TEMPLATE_DIR: TEMPLATE_DIR,
    DEFAULT_TEMPLATE: DEFAULT_TEMPLATE,
    PART_ROOT_RELS: PART_ROOT_RELS,
    PART_CUT_INFO: PART_CUT_INFO,
    PART_PLATE_JSON: PART_PLATE_JSON,
    UUID_SUFFIX: {
      object: OBJECT_UUID_SUFFIX,
      subObject: SUB_OBJECT_UUID_SUFFIX,
      component: COMPONENT_UUID_SUFFIX,
      buildItem: BUILD_ITEM_UUID_SUFFIX
    }
  };
});
