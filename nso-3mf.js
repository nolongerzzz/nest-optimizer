/*
 * NSO 3MF writer
 * --------------
 * Builds a Bambu Studio project (.3mf) from the nested plate, with the selected
 * cooling profile baked into Metadata/project_settings.config.
 *
 * A .3mf is an OPC (ZIP) archive. We emit:
 *
 *   [Content_Types].xml            OPC part types
 *   _rels/.rels                    root relationship -> the model part
 *   3D/3dmodel.model               core 3MF geometry (millimetres, Z up)
 *   Metadata/project_settings.config   <- the baked cooling settings
 *   Metadata/model_settings.config     Bambu object/plate names
 *   Metadata/nso_profile.json          NSO provenance (see note below)
 *
 * Note on provenance: NSO's own bookkeeping deliberately lives in a separate
 * part, NOT as extra keys inside project_settings.config. Bambu Studio warns on
 * keys it does not recognise, so project_settings.config contains the confirmed
 * cooling keys and nothing else.
 *
 * No third-party dependencies -- the ZIP writer is below. Runs in the browser
 * and in Node (both have CompressionStream), so the round-trip validator
 * exercises the exact code path the app uses.
 */
(function (root, factory) {
  'use strict';
  var api = factory(
    (typeof module === 'object' && module.exports)
      ? require('./nso-cooling-profiles.js')
      : root.NSOCoolingProfiles
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NSO3MF = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Profiles) {
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

  /**
   * Build 3D/3dmodel.model.
   * @param {{name:string, vertices:number[], triangles:number[]}[]} objects
   *        vertices are flat [x,y,z,...] in millimetres, Z up, plate coordinates.
   */
  function buildModelXml(objects) {
    var out = [];
    out.push('<?xml version="1.0" encoding="UTF-8"?>');
    out.push('<model unit="millimeter" xml:lang="en-US" ' +
             'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">');
    out.push(' <metadata name="Application">Nest Optimizer</metadata>');
    out.push(' <resources>');
    objects.forEach(function (obj, i) {
      var id = i + 1;
      out.push('  <object id="' + id + '" type="model">');
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
    out.push(' <build>');
    objects.forEach(function (obj, i) {
      out.push('  <item objectid="' + (i + 1) + '" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>');
    });
    out.push(' </build>');
    out.push('</model>');
    return out.join('\n') + '\n';
  }

  /** Bambu-specific object/plate naming. Bambu regenerates what it needs. */
  function buildModelSettings(objects) {
    var out = [];
    out.push('<?xml version="1.0" encoding="UTF-8"?>');
    out.push('<config>');
    objects.forEach(function (obj, i) {
      out.push('  <object id="' + (i + 1) + '">');
      out.push('    <metadata key="name" value="' + xmlEscape(obj.name || ('object_' + (i + 1))) + '"/>');
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

  // ===========================================================================
  // Public API
  // ===========================================================================

  var PART_PROJECT_SETTINGS = 'Metadata/project_settings.config';
  var PART_MODEL = '3D/3dmodel.model';
  var PART_MODEL_SETTINGS = 'Metadata/model_settings.config';
  var PART_NSO_PROFILE = 'Metadata/nso_profile.json';

  /**
   * @param {object} opts
   * @param {{name:string, vertices:number[], triangles:number[]}[]} opts.objects
   * @param {string} [opts.profileId]   cooling profile to bake in
   * @param {string} [opts.plateName]
   * @returns {Promise<{bytes:Uint8Array, profileId:string, values:object, settingsText:string}>}
   */
  function build3MF(opts) {
    opts = opts || {};
    var objects = opts.objects || [];
    if (!objects.length) return Promise.reject(new Error('No objects to export'));

    var profileId = Profiles.hasProfile(opts.profileId)
      ? opts.profileId
      : Profiles.DEFAULT_PROFILE_ID;

    var values = Profiles.resolveValues(profileId);
    // Throws on any format drift (missing key, stray/absent '%', bad enum).
    var settingsText = Profiles.serializeProjectSettings(values);

    var provenance = JSON.stringify({
      generator: 'Nest Optimizer',
      cooling_profile: profileId,
      cooling_profile_tuned: !!(Profiles.getProfile(profileId) || {}).tuned,
      plate: opts.plateName || '',
      note: 'Cooling settings are baked into ' + PART_PROJECT_SETTINGS + '. ' +
            'Swapping the filament preset in Bambu Studio and choosing ' +
            '"Discard Modified Value" will drop them.'
    }, null, 2) + '\n';

    var entries = [
      { name: '[Content_Types].xml', data: utf8(CONTENT_TYPES) },
      { name: '_rels/.rels', data: utf8(RELS) },
      { name: PART_MODEL, data: utf8(buildModelXml(objects)) },
      { name: PART_PROJECT_SETTINGS, data: utf8(settingsText) },
      { name: PART_MODEL_SETTINGS, data: utf8(buildModelSettings(objects)) },
      { name: PART_NSO_PROFILE, data: utf8(provenance) }
    ];

    return buildZip(entries).then(function (bytes) {
      return {
        bytes: bytes,
        profileId: profileId,
        values: values,
        settingsText: settingsText
      };
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
    indexTriangleSoup: indexTriangleSoup,
    buildZip: buildZip,
    crc32: crc32,
    PART_PROJECT_SETTINGS: PART_PROJECT_SETTINGS,
    PART_MODEL: PART_MODEL,
    PART_MODEL_SETTINGS: PART_MODEL_SETTINGS,
    PART_NSO_PROFILE: PART_NSO_PROFILE
  };
});
