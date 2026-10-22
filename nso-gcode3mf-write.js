/*
 * NSO .gcode.3mf packager
 * -----------------------
 * Wraps a G-code string and its plate's metadata in a Bambu-shaped sliced
 * project (`*.gcode.3mf`), the file a Bambu printer takes over the network or
 * off the SD card. Phase 2b (salvage: cut an existing print at layer N and
 * re-send) and Phase 4 (NSO's own print path) both hand their G-code here.
 *
 * THE REFERENCE is fixtures/supports/top_clip_x2_supports.gcode.3mf (Bambu
 * Studio 02.08.02.61, A1 mini 0.4). This writes its part list exactly, in its
 * order:
 *
 *   [Content_Types].xml             the reference's bytes
 *   Metadata/plate_1.png, plate_1_small.png, plate_no_light_1.png,
 *   top_1.png, pick_1.png           the caller's thumbnails, else blank
 *                                   (transparent) PNGs at the reference's sizes
 *   Metadata/plate_1.json           layer-1 footprint per object, bed, filaments
 *   3D/3dmodel.model                header only: Studio's metadata, no meshes
 *   Metadata/project_settings.config   the config the G-code was made with
 *   Metadata/plate_1.gcode.md5      uppercase hex MD5 of the G-code bytes
 *   Metadata/plate_1.gcode          the G-code, as given
 *   Metadata/_rels/model_settings.config.rels   -> plate_1.gcode
 *   Metadata/model_settings.config  the plate block: G-code, thumbnails, bbox file
 *   Metadata/cut_information.xml    one uncut entry per object
 *   Metadata/slice_info.config      printer, prediction, weight, objects,
 *                                   filament, layer_filament_lists
 *   Metadata/filament_sequence.json
 *   _rels/.rels                     model + cover thumbnails
 *
 * READ FROM THE G-CODE FIRST. Bambu's G-code carries most of what the metadata
 * says: its HEADER_BLOCK (layers, time, weight, label ids, max_z), its
 * CONFIG_BLOCK (nozzle, filaments, bed, printable area), and the body itself
 * (layer-1 extrusion per label, filament changes, pauses). Those are read from
 * the G-code; what the caller passes only fills what the G-code lacks.
 * `describe()` reports every field with where it came from (`sources`).
 *
 * Placeholders, where NSO has no real value (docs/GCODE3MF-PACKAGER.md):
 * thumbnails (blank PNGs), first_layer_time (0, unless `estimate.firstLayer
 * Seconds`), plate_1.json `area` (the footprint's bbox area), plate_1.json ids
 * (the G-code label ids; Studio writes its runtime ids), DesignerUserId
 * (empty), and no <warning> lines in slice_info.
 *
 * The ZIP writer and CRC32 are nso-3mf.js's (buildZip, crc32); reading back
 * uses nso-3mf-read.js's openZip. MD5 is below: crypto.subtle has none.
 * Runs in the browser (load nso-3mf.js and nso-3mf-read.js first) and in Node.
 */
(function (root, factory) {
  'use strict';
  var node = typeof module === 'object' && module.exports;
  var api = factory(
    node ? require('./nso-3mf.js') : root.NSO3MF,
    node ? function () { return require('./nso-3mf-read.js'); } : function () { return root.NSO3MFRead; }
  );
  if (node) module.exports = api;
  if (root) root.NSO_Gcode3mf = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (W, reader) {
  'use strict';

  // ===========================================================================
  // MD5 (RFC 1321)
  // ===========================================================================

  var MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  var MD5_K = (function () {
    var k = new Int32Array(64);
    for (var i = 0; i < 64; i++) k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) | 0;
    return k;
  })();

  function md5Blocks(state, view, at, end, M) {
    for (; at < end; at += 64) {
      for (var j = 0; j < 16; j++) M[j] = view.getInt32(at + j * 4, true);
      var a = state[0], b = state[1], c = state[2], d = state[3];
      for (var i = 0; i < 64; i++) {
        var f, g, r = i >> 4;
        if (r === 0) { f = (b & c) | (~b & d); g = i; }
        else if (r === 1) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
        else if (r === 2) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
        else { f = c ^ (b | ~d); g = (7 * i) & 15; }
        var s = MD5_S[(r << 2) | (i & 3)];
        var t = (a + f + MD5_K[i] + M[g]) | 0;
        a = d; d = c; c = b;
        b = (b + ((t << s) | (t >>> (32 - s)))) | 0;
      }
      state[0] = (state[0] + a) | 0; state[1] = (state[1] + b) | 0;
      state[2] = (state[2] + c) | 0; state[3] = (state[3] + d) | 0;
    }
  }

  /**
   * @param {Uint8Array|string} input  bytes, or a string (hashed as UTF-8)
   * @returns {string} 32 uppercase hex digits, as Bambu writes plate_N.gcode.md5
   */
  function md5(input) {
    var bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    var n = bytes.length;
    var state = new Int32Array([0x67452301, 0xEFCDAB89 | 0, 0x98BADCFE | 0, 0x10325476]);
    var M = new Int32Array(16);
    var full = n - (n & 63);
    md5Blocks(state, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), 0, full, M);
    // The tail: what is left, 0x80, zeros, and the bit length (64-bit LE).
    var tail = new Uint8Array((n & 63) < 56 ? 64 : 128);
    tail.set(bytes.subarray(full));
    tail[n & 63] = 0x80;
    var tv = new DataView(tail.buffer);
    tv.setUint32(tail.length - 8, (n * 8) >>> 0, true);
    tv.setUint32(tail.length - 4, Math.floor(n * 8 / 0x100000000), true);
    md5Blocks(state, tv, 0, tail.length, M);
    var hex = '';
    for (var w = 0; w < 4; w++) {
      for (var k = 0; k < 4; k++) {
        var byte = (state[w] >>> (k * 8)) & 0xFF;
        hex += (byte < 16 ? '0' : '') + byte.toString(16);
      }
    }
    return hex.toUpperCase();
  }

  // ===========================================================================
  // Reading the G-code
  // ===========================================================================

  /** "1d 2h 3m 4s" -> seconds; null when nothing parses. */
  function parseDuration(s) {
    var total = 0, any = false, re = /(\d+(?:\.\d+)?)\s*([dhms])/g, m;
    var unit = { d: 86400, h: 3600, m: 60, s: 1 };
    while ((m = re.exec(s))) { total += parseFloat(m[1]) * unit[m[2]]; any = true; }
    return any ? Math.round(total) : null;
  }

  function block(text, start, end) {
    var a = text.indexOf('; ' + start);
    if (a < 0) return null;
    var b = text.indexOf('; ' + end, a);
    return text.slice(a, b < 0 ? text.length : b);
  }

  /** HEADER_BLOCK: "; key: value" and "; key [unit] : value" lines. */
  function parseHeader(text) {
    var out = {};
    var h = block(text, 'HEADER_BLOCK_START', 'HEADER_BLOCK_END');
    if (!h) return out;
    h.split('\n').forEach(function (raw) {
      var line = raw.replace(/^;\s?/, '').trim();
      var m;
      if ((m = /^BambuStudio\s+(\S+)/.exec(line))) { out.studioVersion = m[1]; return; }
      if ((m = /total estimated time:\s*([^;]+)/.exec(line))) out.totalTime = m[1].trim();
      if ((m = /^model printing time:\s*([^;]+)/.exec(line))) out.modelTime = m[1].trim();
      if ((m = /^([a-z_ ]+?)(?:\s*\[[^\]]*\])?\s*:\s*(.*)$/i.exec(line)) && !/time/.test(m[1])) {
        out[m[1].trim()] = m[2].trim();
      }
    });
    return out;
  }

  /** CONFIG_BLOCK: "; key = value" lines, values as written. */
  function parseConfigBlock(text) {
    var out = {};
    var c = block(text, 'CONFIG_BLOCK_START', 'CONFIG_BLOCK_END');
    if (!c) return out;
    c.split('\n').forEach(function (raw) {
      var m = /^;\s*([A-Za-z0-9_]+)\s*=\s?(.*)$/.exec(raw);
      if (m) out[m[1]] = m[2].replace(/\r$/, '');
    });
    return out;
  }

  function nums(s) {
    return s == null || s === '' ? [] : String(s).split(/[,;]/).map(function (v) { return parseFloat(v); });
  }
  function strs(s) {
    return s == null || s === '' ? [] : String(s).split(/[,;]/).map(function (v) { return v.trim().replace(/^"|"$/g, ''); });
  }

  /**
   * One pass over the executable body: layers, the label printing, layer-1
   * extrusion bounds per label (each endpoint widened by half its
   * LINE_WIDTH; arcs sampled), filament changes, pauses, Support features.
   */
  function scanBody(text) {
    var lines = text.split('\n');
    var s = {
      layers: 0, labelsSeen: [], layer1: {}, maxZ: 0,
      filamentByLayer: [], loads: {}, unloads: {}, firstFilament: null,
      pauses: 0, supportFeature: false
    };
    var inBody = text.indexOf('; EXECUTABLE_BLOCK_START') < 0;
    var label = null, x = 0, y = 0, z = 0, w = 0, absXY = true, relE = false;
    var current = -1, layer = -1;
    var seen = {};
    function widen(b, px, py) {
      if (px - w / 2 < b[0]) b[0] = px - w / 2;
      if (py - w / 2 < b[1]) b[1] = py - w / 2;
      if (px + w / 2 > b[2]) b[2] = px + w / 2;
      if (py + w / 2 > b[3]) b[3] = py + w / 2;
    }
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li].trim();
      if (!line) continue;
      if (!inBody) { if (line === '; EXECUTABLE_BLOCK_START') inBody = true; continue; }
      if (line === '; EXECUTABLE_BLOCK_END') break;
      var m;
      if (line.charAt(0) === ';') {
        if (line === '; CHANGE_LAYER') {
          layer++; s.layers = layer + 1;
          if (current >= 0) s.filamentByLayer[layer] = [current];
        } else if ((m = /^; start printing object, unique label id: (\d+)/.exec(line))) {
          label = m[1];
          if (!seen[label]) { seen[label] = true; s.labelsSeen.push(label); }
        } else if (/^; stop printing object/.test(line)) label = null;
        else if ((m = /^; LINE_WIDTH: ([\d.]+)/.exec(line))) w = parseFloat(m[1]);
        else if (/^; FEATURE: Support/.test(line)) s.supportFeature = true;
        continue;
      }
      var code = line.split(';')[0].trim();
      if (code === 'M83') { relE = true; continue; }
      if (code === 'M82') { relE = false; continue; }
      if (code === 'G90') { absXY = true; continue; }
      if (code === 'G91') { absXY = false; continue; }
      if (code === 'M400 U1') { s.pauses++; continue; }
      if ((m = /^M620 S(\d+)A/.exec(code))) {
        var f = parseInt(m[1], 10);
        if (f < 255 && f !== current) {
          if (current >= 0) s.unloads[current] = (s.unloads[current] || 0) + 1;
          s.loads[f] = (s.loads[f] || 0) + 1;
          if (s.firstFilament === null) s.firstFilament = f;
          current = f;
          if (layer >= 0) {
            var list = s.filamentByLayer[layer] || (s.filamentByLayer[layer] = []);
            if (list.indexOf(f) < 0) list.push(f);
          }
        }
        continue;
      }
      if (!(m = /^G([0-3])(?:\s|$)/.exec(code))) continue;
      var v = {};
      code.split(/\s+/).slice(1).forEach(function (t) { v[t.charAt(0)] = parseFloat(t.slice(1)); });
      var nx = v.X == null ? x : (absXY ? v.X : x + v.X);
      var ny = v.Y == null ? y : (absXY ? v.Y : y + v.Y);
      if (v.Z != null) z = absXY ? v.Z : z + v.Z;
      var extruding = v.E != null && (relE ? v.E > 0 : true);
      if (extruding && z > s.maxZ) s.maxZ = z;
      if (layer === 0 && label && extruding && (nx !== x || ny !== y)) {
        var b = s.layer1[label] || (s.layer1[label] = [Infinity, Infinity, -Infinity, -Infinity]);
        widen(b, x, y); widen(b, nx, ny);
        if (m[1] === '2' || m[1] === '3') {
          var cx = x + (v.I || 0), cy = y + (v.J || 0), r = Math.hypot(x - cx, y - cy);
          var a0 = Math.atan2(y - cy, x - cx), a1 = Math.atan2(ny - cy, nx - cx);
          var sweep = m[1] === '2' ? a0 - a1 : a1 - a0;
          if (sweep <= 0) sweep += 2 * Math.PI;
          for (var k = 1; k < 16; k++) {
            var a = a0 + (m[1] === '2' ? -1 : 1) * sweep * k / 16;
            widen(b, cx + r * Math.cos(a), cy + r * Math.sin(a));
          }
        }
      }
      x = nx; y = ny;
    }
    return s;
  }

  // ===========================================================================
  // describe(): every field the parts carry, and where it came from
  // ===========================================================================

  // printer_model -> slice_info printer_model_id. Only what a fixture proves.
  var MODEL_IDS = { 'Bambu Lab A1 mini': 'N1' };
  // curr_bed_type -> plate_N.json bed_type (Studio's bed_type_to_gcode_string)
  var BED_TYPES = {
    'Cool Plate': 'cool_plate', 'Engineering Plate': 'eng_plate', 'High Temp Plate': 'hot_plate',
    'Textured PEI Plate': 'textured_plate', 'Supertack Plate': 'supertack_plate'
  };
  // The Studio version the reference was sliced with; slice_info's client
  // version when the G-code names none (the same pin as nso-3mf.js's template).
  var DEFAULT_STUDIO_VERSION = '02.08.02.61';

  function configObject(config) {
    if (config == null) return null;
    if (typeof config === 'string') { try { return JSON.parse(config); } catch (e) { return null; } }
    return config;
  }
  function configText(config) {
    if (typeof config === 'string') return config;
    if (config instanceof Uint8Array) return new TextDecoder().decode(config);
    return JSON.stringify(config, null, 4) + '\n';
  }
  /** A config key as G-code CONFIG_BLOCK text: lists joined with ','. */
  function fromConfig(obj, key) {
    if (!obj || obj[key] == null) return undefined;
    return Array.isArray(obj[key]) ? obj[key].join(',') : String(obj[key]);
  }

  /**
   * Everything the parts say, resolved: the G-code first, then what was passed.
   * @returns {object} fields plus `sources` {field: 'gcode'|'config'|'passed'|'placeholder'|'default'}
   */
  function describe(opts) {
    opts = opts || {};
    var text = typeof opts.gcode === 'string' ? opts.gcode
      : opts.gcode instanceof Uint8Array ? new TextDecoder().decode(opts.gcode) : null;
    if (text == null) throw new Error('NSO_Gcode3mf: gcode (a string) is required');
    if (opts.config == null) throw new Error('NSO_Gcode3mf: config (project_settings.config, the config the G-code was made with) is required');
    var header = parseHeader(text);
    var cfgBlock = parseConfigBlock(text);
    var cfgObj = configObject(opts.config);
    var body = scanBody(text);
    var sources = {};
    var estimate = opts.estimate || {}, printer = opts.printer || {};

    // A value from the G-code's CONFIG_BLOCK, else the passed config.
    function cfg(key) {
      if (cfgBlock[key] != null) { sources[key] = 'gcode'; return cfgBlock[key]; }
      var v = fromConfig(cfgObj, key);
      if (v != null) sources[key] = 'config';
      return v;
    }
    function pick(field, fromGcode, passed, fallback, fallbackSource) {
      if (fromGcode != null && !(typeof fromGcode === 'number' && isNaN(fromGcode))) { sources[field] = 'gcode'; return fromGcode; }
      if (passed != null) { sources[field] = 'passed'; return passed; }
      sources[field] = fallbackSource || 'placeholder';
      return fallback;
    }

    var d = { sources: sources };
    d.studioVersion = pick('studioVersion', header.studioVersion, null, DEFAULT_STUDIO_VERSION, 'default');
    d.layers = pick('layers', header['total layer number'] != null ? parseInt(header['total layer number'], 10) : (body.layers || null), null, 0);
    d.seconds = pick('seconds', header.totalTime ? parseDuration(header.totalTime) : null, estimate.seconds, 0);
    var grams = nums(header['total filament weight']);
    d.grams = pick('grams', grams.length ? grams.reduce(function (a, b) { return a + b; }, 0) : null, estimate.grams, 0);
    var lengths = nums(header['total filament length']);
    d.maxZ = pick('maxZ', header.max_z_height != null ? parseFloat(header.max_z_height) : (body.maxZ || null), null, 0);
    d.firstLayerSeconds = pick('firstLayerSeconds', null, estimate.firstLayerSeconds, 0);

    // Filament slots: the config's lists; then which are used, from the header
    // ("filament: 1", 1-based) or the body's M620 changes.
    var colours = strs(cfg('filament_colour'));
    var types = strs(cfg('filament_type'));
    var trays = strs(cfg('filament_ids'));
    var slots = Math.max(colours.length, types.length, trays.length, strs(cfg('filament_map')).length);
    var passedF = opts.filaments || [];
    if (!slots) slots = passedF.length;
    var used = header.filament != null ? nums(header.filament).map(function (f) { return f - 1; })
      : Object.keys(body.loads).map(Number).sort(function (a, b) { return a - b; });
    sources.filamentsUsed = header.filament != null ? 'gcode' : used.length ? 'gcode' : 'passed';
    if (!used.length) used = passedF.length ? [0] : [];
    var loadTime = parseFloat(cfg('machine_load_filament_time')) || 0;
    var unloadTime = parseFloat(cfg('machine_unload_filament_time')) || 0;
    var nozzleStr = cfg('nozzle_diameter');
    nozzleStr = nozzleStr != null ? strs(nozzleStr)[0] : (printer.nozzle != null ? String(printer.nozzle) : null);
    sources.nozzle = sources.nozzle_diameter || (printer.nozzle != null ? 'passed' : 'placeholder');
    if (nozzleStr == null) throw new Error('NSO_Gcode3mf: no nozzle diameter in the G-code, the config or printer.nozzle');
    d.nozzle = nozzleStr;
    var volumeType = strs(cfg('nozzle_volume_type'))[0] || 'Standard';
    d.volumeType = volumeType;
    d.filaments = used.map(function (slot, i) {
      var p = passedF[slot] || {};
      var len = lengths.length === slots ? lengths[slot] : lengths.length === used.length ? lengths[i] : null;
      var g = grams.length === slots ? grams[slot] : grams.length === used.length ? grams[i] : null;
      if (len == null && used.length === 1 && lengths.length === 1) len = lengths[0];
      if (g == null && used.length === 1) g = d.grams;
      return {
        id: slot + 1,
        tray_info_idx: trays[slot] || p.tray_info_idx || '',
        type: types[slot] || p.type || '',
        color: colours[slot] || p.color || '',
        used_m: len != null ? len / 1000 : (p.used_m != null ? p.used_m : 0),
        used_g: g != null ? g : (p.used_g != null ? p.used_g : 0),
        used_for_object: true,
        used_for_support: body.supportFeature,
        total_load_time: (body.loads[slot] || (slot === used[0] ? 1 : 0)) * loadTime,
        total_unload_time: (body.unloads[slot] || 0) * unloadTime
      };
    });
    d.slots = slots;
    d.firstFilament = body.firstFilament != null ? body.firstFilament : (used[0] || 0);

    // layer_filament_lists: per layer the filaments it used, grouped by list.
    var groups = [], byKey = {}, prev = null;
    for (var L = 0; L < d.layers; L++) {
      var lst = body.filamentByLayer[L] || (prev ? prev.list : [d.firstFilament]);
      var key = lst.slice().sort().join(' ');
      if (prev && prev.key === key && prev.end === L - 1) { prev.end = L; continue; }
      prev = { key: key, list: lst, start: L, end: L };
      if (!byKey[key]) { byKey[key] = []; groups.push(key); }
      byKey[key].push(prev);
    }
    d.layerFilamentLists = groups.map(function (k) {
      return { filament_list: k, layer_ranges: byKey[k].map(function (r) { return r.start + ' ' + r.end; }).join(' ') };
    });

    // Objects: the G-code's label ids, named from what was passed.
    var labels = header['model label id'] != null ? strs(header['model label id']) : body.labelsSeen;
    var objs = opts.objects || [];
    if (labels.length) {
      sources.labelIds = 'gcode';
      var byId = {};
      objs.forEach(function (o) { if (o.identify_id != null) byId[String(o.identify_id)] = o; });
      var allById = labels.every(function (id) { return byId[id]; });
      if (!allById && objs.length !== labels.length) {
        throw new Error('NSO_Gcode3mf: the G-code labels ' + labels.length + ' object(s) (' + labels.join(',') +
          ') and ' + objs.length + ' were passed; cannot name them');
      }
      d.objects = labels.map(function (id, i) {
        var o = allById ? byId[id] : objs[i];
        return { identify_id: id, name: o.name != null ? String(o.name) : 'object ' + id, skipped: !!o.skipped };
      });
    } else {
      sources.labelIds = 'passed';
      d.objects = objs.map(function (o, i) {
        return { identify_id: String(o.identify_id != null ? o.identify_id : i + 1), name: String(o.name || ''), skipped: !!o.skipped };
      });
    }
    d.labelObjectEnabled = cfg('exclude_object') === '1' && labels.length > 0;

    // Printer
    var printerModel = cfg('printer_model');
    d.printerModel = printerModel;
    d.modelId = printer.model_id || MODEL_IDS[printerModel];
    sources.modelId = printer.model_id ? 'passed' : 'default';
    if (!d.modelId) throw new Error('NSO_Gcode3mf: printer.model_id is required (no id on record for "' + printerModel + '")');
    d.timelapseType = cfg('timelapse_type') || '0';
    d.extruderType = /bowden/i.test(cfg('extruder_type') || '') ? 1 : 0;
    d.nozzleVolumeType = /high\s*flow/i.test(volumeType) ? 1 : 0;
    d.supportUsed = cfg('enable_support') === '1';
    d.supportOnWipeTower = header.support_material_on_wipe_tower === '1';
    d.pauseCount = body.pauses;
    d.filamentMaps = strs(cfg('filament_map'));
    if (!d.filamentMaps.length) d.filamentMaps = Array.apply(null, Array(slots)).map(function () { return '1'; });
    d.filamentVolumeMaps = strs(cfg('filament_volume_map'));
    if (!d.filamentVolumeMaps.length) d.filamentVolumeMaps = d.filamentMaps.map(function () { return '0'; });
    d.filamentMapMode = cfg('filament_map_mode') || 'Auto For Flush';
    d.bedType = BED_TYPES[cfg('curr_bed_type')] || 'textured_plate';
    d.isSeqPrint = cfg('print_sequence') === 'by object';
    d.layerHeight = parseFloat(cfg('layer_height')) || 0.2;

    // Layer-1 footprint per object (plate_1.json) and "outside".
    var all = [Infinity, Infinity, -Infinity, -Infinity];
    d.bboxObjects = d.objects.map(function (o) {
      var b = body.layer1[o.identify_id];
      if (!b) return null;
      all = [Math.min(all[0], b[0]), Math.min(all[1], b[1]), Math.max(all[2], b[2]), Math.max(all[3], b[3])];
      return { area: (b[2] - b[0]) * (b[3] - b[1]), bbox: b.slice(), id: Number(o.identify_id), name: o.name };
    }).filter(Boolean);
    d.bboxAll = isFinite(all[0]) ? all : [0, 0, 0, 0];
    var area = strs(cfg('printable_area')).map(function (p) { return p.split('x').map(Number); });
    var height = parseFloat(cfg('printable_height'));
    d.outside = false;
    if (area.length && isFinite(all[0])) {
      var ax = area.map(function (p) { return p[0]; }), ay = area.map(function (p) { return p[1]; });
      d.outside = all[0] < Math.min.apply(null, ax) || all[1] < Math.min.apply(null, ay) ||
                  all[2] > Math.max.apply(null, ax) || all[3] > Math.max.apply(null, ay);
    }
    if (isFinite(height) && d.maxZ > height + 1e-6) d.outside = true;
    return d;
  }

  // ===========================================================================
  // The parts
  // ===========================================================================

  var PART = {
    contentTypes: '[Content_Types].xml',
    plate: 'Metadata/plate_1.png',
    plateSmall: 'Metadata/plate_1_small.png',
    noLight: 'Metadata/plate_no_light_1.png',
    top: 'Metadata/top_1.png',
    pick: 'Metadata/pick_1.png',
    plateJson: 'Metadata/plate_1.json',
    model: '3D/3dmodel.model',
    projectSettings: 'Metadata/project_settings.config',
    md5: 'Metadata/plate_1.gcode.md5',
    gcode: 'Metadata/plate_1.gcode',
    modelSettingsRels: 'Metadata/_rels/model_settings.config.rels',
    modelSettings: 'Metadata/model_settings.config',
    cutInfo: 'Metadata/cut_information.xml',
    sliceInfo: 'Metadata/slice_info.config',
    filamentSequence: 'Metadata/filament_sequence.json',
    rels: '_rels/.rels'
  };
  // The reference's order.
  var PART_ORDER = ['contentTypes', 'plate', 'plateSmall', 'noLight', 'top', 'pick', 'plateJson', 'model',
    'projectSettings', 'md5', 'gcode', 'modelSettingsRels', 'modelSettings', 'cutInfo', 'sliceInfo',
    'filamentSequence', 'rels'];
  // Thumbnail sizes, as the reference has them.
  var THUMBS = { plate: 512, plateSmall: 128, noLight: 512, top: 512, pick: 512 };
  var THUMB_KEYS = { plate: 'plate', plate_small: 'plateSmall', no_light: 'noLight', top: 'top', pick: 'pick' };

  var XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n';
  var NS_BAMBU = 'http://schemas.bambulab.com/package/2021';
  var REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }
  function f2(v) { return Number(v).toFixed(2); }

  var CONTENT_TYPES = XML_HEAD +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
    ' <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
    ' <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n' +
    ' <Default Extension="png" ContentType="image/png"/>\n' +
    ' <Default Extension="gcode" ContentType="text/x.gcode"/>\n' +
    '</Types>';

  var ROOT_RELS = XML_HEAD +
    '<Relationships xmlns="' + REL_NS + '">\n' +
    ' <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n' +
    ' <Relationship Target="/Metadata/plate_1.png" Id="rel-2" Type="' + REL_NS + '/metadata/thumbnail"/>\n' +
    ' <Relationship Target="/Metadata/plate_1.png" Id="rel-4" Type="' + NS_BAMBU + '/cover-thumbnail-middle"/>\n' +
    ' <Relationship Target="/Metadata/plate_1_small.png" Id="rel-5" Type="' + NS_BAMBU + '/cover-thumbnail-small"/>\n' +
    '</Relationships>';

  var MODEL_SETTINGS_RELS = XML_HEAD +
    '<Relationships xmlns="' + REL_NS + '">\n' +
    ' <Relationship Target="/Metadata/plate_1.gcode" Id="rel-1" Type="' + NS_BAMBU + '/gcode"/>\n' +
    '</Relationships>';

  // 3D/3dmodel.model: the header Studio writes for a sliced plate, no meshes.
  var MODEL_METADATA = ['Application', 'BambuStudio:3mfVersion', 'Copyright', 'CreationDate', 'Description',
    'Designer', 'DesignerCover', 'DesignerUserId', 'License', 'ModificationDate', 'Origin', 'ProfileCover',
    'ProfileDescription', 'ProfileTitle', 'Title'];

  function modelXml(d, date) {
    var values = { Application: 'BambuStudio-' + d.studioVersion, 'BambuStudio:3mfVersion': '1',
                   CreationDate: date, ModificationDate: date };
    var out = [XML_HEAD + '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"' +
      ' xmlns:BambuStudio="' + NS_BAMBU + '" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">'];
    MODEL_METADATA.forEach(function (k) {
      out.push(' <metadata name="' + k + '">' + esc(values[k] || '') + '</metadata>');
    });
    out.push(' <resources>', ' </resources>', ' <build/>', '</model>', '');
    return out.join('\n');
  }

  function modelSettingsXml(d) {
    var meta = [['plater_id', '1'], ['plater_name', ''], ['locked', 'false'],
      ['filament_map_mode', d.filamentMapMode], ['filament_maps', d.filamentMaps.join(' ')],
      ['filament_volume_maps', d.filamentVolumeMaps.join(' ')],
      ['gcode_file', PART.gcode], ['thumbnail_file', PART.plate], ['thumbnail_no_light_file', PART.noLight],
      ['top_file', PART.top], ['pick_file', PART.pick], ['pattern_bbox_file', PART.plateJson]];
    return XML_HEAD + '<config>\n  <plate>\n' +
      meta.map(function (m) { return '    <metadata key="' + m[0] + '" value="' + esc(m[1]) + '"/>\n'; }).join('') +
      '  </plate>\n</config>\n';
  }

  function sliceInfoXml(d) {
    var meta = [['index', '1'], ['extruder_type', d.extruderType], ['nozzle_volume_type', d.nozzleVolumeType],
      ['printer_model_id', d.modelId], ['nozzle_diameters', d.nozzle], ['timelapse_type', d.timelapseType],
      ['prediction', String(Math.round(d.seconds))], ['weight', f2(d.grams)], ['pause_count', d.pauseCount],
      ['first_layer_time', Number(d.firstLayerSeconds).toFixed(6)], ['outside', d.outside],
      ['support_used', d.supportUsed], ['label_object_enabled', d.labelObjectEnabled],
      ['support_material_on_wipe_tower', d.supportOnWipeTower], ['enable_filament_dynamic_map', false],
      ['has_filament_switcher', false], ['filament_maps', d.filamentMaps.join(' ')],
      ['limit_filament_maps', d.filamentMaps.map(function () { return '0'; }).join(' ')]];
    var out = [XML_HEAD + '<config>', '  <header>',
      '    <header_item key="X-BBL-Client-Type" value="slicer"/>',
      '    <header_item key="X-BBL-Client-Version" value="' + esc(d.studioVersion) + '"/>',
      '  </header>', '  <plate>'];
    meta.forEach(function (m) { out.push('    <metadata key="' + m[0] + '" value="' + esc(m[1]) + '"/>'); });
    d.objects.forEach(function (o) {
      out.push('    <object identify_id="' + esc(o.identify_id) + '" name="' + esc(o.name) + '" skipped="' + o.skipped + '" />');
    });
    d.filaments.forEach(function (f) {
      out.push('    <filament id="' + f.id + '" tray_info_idx="' + esc(f.tray_info_idx) + '" type="' + esc(f.type) +
        '" color="' + esc(f.color) + '" used_m="' + f2(f.used_m) + '" used_g="' + f2(f.used_g) +
        '" group_id="0" nozzle_diameter="' + f2(d.nozzle) + '" volume_type="' + esc(d.volumeType) +
        '" used_for_object="' + f.used_for_object + '" used_for_support="' + f.used_for_support +
        '" total_load_time="' + f2(f.total_load_time) + '" total_unload_time="' + f2(f.total_unload_time) + '"/>');
    });
    out.push('    <nozzle id="0" extruder_id="1" nozzle_diameter="' + esc(d.nozzle) + '" volume_type="' + esc(d.volumeType) + '"/>');
    out.push('    <layer_filament_lists>');
    d.layerFilamentLists.forEach(function (l) {
      out.push('      <layer_filament_list filament_list="' + l.filament_list + '" layer_ranges="' + l.layer_ranges + '" />');
    });
    out.push('    </layer_filament_lists>', '  </plate>', '</config>', '');
    return out.join('\n');
  }

  // Studio writes these as float32 widened to double.
  var f32 = Math.fround;

  function plateJson(d) {
    return JSON.stringify({
      bbox_all: d.bboxAll,
      bbox_objects: d.bboxObjects.map(function (o) {
        return { area: o.area, bbox: o.bbox, id: o.id, layer_height: f32(d.layerHeight), name: o.name };
      }),
      bed_type: d.bedType,
      filament_colors: d.filaments.map(function (f) { return f.color; }),
      filament_ids: d.filaments.map(function (f) { return f.id - 1; }),
      first_extruder: d.firstFilament,
      first_layer_time: f32(d.firstLayerSeconds),
      is_seq_print: d.isSeqPrint,
      nozzle_diameter: f32(parseFloat(d.nozzle)),
      version: 2
    });
  }

  function filamentSequenceJson(d) {
    return JSON.stringify({ plate_1: {
      nozzle_sequence: [0],
      optimal_assignment: d.filamentMaps.map(function () { return 0; }),
      sequence: d.filaments.map(function (f) { return f.id; })
    } });
  }

  function cutInfoXml(d) {
    var out = ['<?xml version="1.0" encoding="utf-8"?>', '<objects>'];
    d.objects.forEach(function (o, i) {
      out.push(' <object id="' + (i + 1) + '">', '  <cut_id id="0" check_sum="1" connectors_cnt="0"/>', ' </object>');
    });
    out.push('</objects>'); // no trailing newline, as the reference
    return out.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Placeholder thumbnails: a fully transparent RGBA PNG of the given size.
  // ---------------------------------------------------------------------------

  function adler32(bytes) {
    var a = 1, b = 0;
    for (var i = 0; i < bytes.length; i++) { a = (a + bytes[i]) % 65521; b = (b + a) % 65521; }
    return ((b << 16) | a) >>> 0;
  }

  /** zlib stream: CompressionStream('deflate') where there is one, else stored blocks. */
  function zlibDeflate(raw) {
    if (typeof CompressionStream === 'function') {
      try {
        var cs = new CompressionStream('deflate');
        var wr = cs.writable.getWriter();
        wr.write(raw); wr.close();
        return new Response(cs.readable).arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
      } catch (e) { /* stored below */ }
    }
    var blocks = Math.max(1, Math.ceil(raw.length / 65535));
    var out = new Uint8Array(2 + raw.length + blocks * 5 + 4), at = 0;
    out[at++] = 0x78; out[at++] = 0x01;
    for (var i = 0; i < blocks; i++) {
      var chunk = raw.subarray(i * 65535, Math.min(raw.length, (i + 1) * 65535));
      out[at++] = i === blocks - 1 ? 1 : 0;
      out[at++] = chunk.length & 0xFF; out[at++] = chunk.length >>> 8;
      out[at++] = ~chunk.length & 0xFF; out[at++] = (~chunk.length >>> 8) & 0xFF;
      out.set(chunk, at); at += chunk.length;
    }
    var ad = adler32(raw);
    out[at++] = ad >>> 24; out[at++] = (ad >>> 16) & 0xFF; out[at++] = (ad >>> 8) & 0xFF; out[at++] = ad & 0xFF;
    return Promise.resolve(out);
  }

  function pngChunk(type, data) {
    var out = new Uint8Array(12 + data.length), v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    for (var i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    v.setUint32(8 + data.length, W.crc32(out.subarray(4, 8 + data.length)));
    return out;
  }

  function blankPng(size) {
    var ihdr = new Uint8Array(13), v = new DataView(ihdr.buffer);
    v.setUint32(0, size); v.setUint32(4, size);
    ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA, as Studio writes; compression/filter/interlace 0
    return zlibDeflate(new Uint8Array(size * (size * 4 + 1))).then(function (idat) {
      var parts = [new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0))];
      var len = parts.reduce(function (n, p) { return n + p.length; }, 0);
      var out = new Uint8Array(len), at = 0;
      parts.forEach(function (p) { out.set(p, at); at += p.length; });
      return out;
    });
  }

  // ===========================================================================
  // write()
  // ===========================================================================

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  /**
   * @param {object} opts
   * @param {string} opts.gcode         the plate's G-code, written as given
   * @param {string|object} opts.config project_settings.config: its text
   *                                    (written verbatim) or its object
   * @param {{identify_id?, name, skipped?}[]} opts.objects  names for the
   *                                    G-code's label ids (by id, else in order)
   * @param {{model_id?, nozzle?}} [opts.printer]
   * @param {{seconds?, grams?, firstLayerSeconds?}} [opts.estimate]
   * @param {{type?, color?, tray_info_idx?}[]} [opts.filaments]  per slot
   * @param {{plate?, plate_small?, no_light?, top?, pick?}} [opts.thumbnails]  PNG bytes
   * @param {string} [opts.date]        YYYY-MM-DD for 3dmodel.model; default today (UTC)
   * @returns {Promise<Uint8Array>} the .gcode.3mf
   */
  function write(opts) {
    return writeDetailed(opts).then(function (r) { return r.bytes; });
  }

  /** write(), also handing back describe()'s fields and the part texts. */
  function writeDetailed(opts) {
    var d;
    try { d = describe(opts); } catch (e) { return Promise.reject(e); }
    var enc = new TextEncoder();
    var gcodeBytes = typeof opts.gcode === 'string' ? enc.encode(opts.gcode) : opts.gcode;
    var thumbs = opts.thumbnails || {};
    var text = {
      contentTypes: CONTENT_TYPES,
      plateJson: plateJson(d),
      model: modelXml(d, opts.date || today()),
      projectSettings: configText(opts.config),
      md5: md5(gcodeBytes),
      modelSettingsRels: MODEL_SETTINGS_RELS,
      modelSettings: modelSettingsXml(d),
      cutInfo: cutInfoXml(d),
      sliceInfo: sliceInfoXml(d),
      filamentSequence: filamentSequenceJson(d),
      rels: ROOT_RELS
    };
    d.sources.thumbnails = {};
    var pngs = {};
    var pending = Object.keys(THUMB_KEYS).map(function (k) {
      var key = THUMB_KEYS[k];
      if (thumbs[k]) { d.sources.thumbnails[k] = 'passed'; pngs[key] = thumbs[k]; return null; }
      d.sources.thumbnails[k] = 'placeholder';
      return blankPng(THUMBS[key]).then(function (b) { pngs[key] = b; });
    });
    return Promise.all(pending).then(function () {
      var entries = PART_ORDER.map(function (key) {
        var data = key === 'gcode' ? gcodeBytes : pngs[key] || enc.encode(text[key]);
        return { name: PART[key], data: data };
      });
      return W.buildZip(entries).then(function (bytes) {
        return { bytes: bytes, fields: d, text: text, md5: text.md5 };
      });
    });
  }

  // ===========================================================================
  // read(): the fields back out of a .gcode.3mf
  // ===========================================================================

  function attrs(tag) {
    var out = {}, re = /([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g, m;
    while ((m = re.exec(tag))) out[m[1]] = m[2].replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    return out;
  }
  function tags(xml, name) {
    var re = new RegExp('<' + name + '\\b[^>]*>', 'g'), out = [], m;
    while ((m = re.exec(xml))) out.push(attrs(m[0]));
    return out;
  }
  function metadataMap(xml) {
    var out = {};
    tags(xml, 'metadata').forEach(function (a) { if (a.key != null) out[a.key] = a.value; });
    return out;
  }

  /**
   * @param {Uint8Array} bytes  a .gcode.3mf
   * @returns {Promise<{parts: string[], gcode: string, md5: string, md5Ok: boolean,
   *   header: object, sliceInfo: {meta, clientVersion, objects, filaments, nozzles,
   *   layerFilamentLists}, plate: object, modelSettings: object,
   *   projectSettings: string, filamentSequence: object}>}
   */
  function read(bytes) {
    var R = reader();
    if (!R || !R.openZip) return Promise.reject(new Error('NSO3MFRead is not loaded - it owns the ZIP reader'));
    var zip;
    try { zip = R.openZip(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)); }
    catch (e) { return Promise.reject(e); }
    var dec = new TextDecoder();
    var want = [PART.gcode, PART.md5, PART.sliceInfo, PART.plateJson, PART.modelSettings,
      PART.projectSettings, PART.filamentSequence];
    return Promise.all(want.map(function (n) {
      return zip.has(n) ? zip.read(n).then(function (b) { return b; }) : null;
    })).then(function (got) {
      var gcodeBytes = got[0];
      var gcode = gcodeBytes ? dec.decode(gcodeBytes) : null;
      var md5Text = got[1] ? dec.decode(got[1]).trim() : null;
      var si = got[2] ? dec.decode(got[2]) : '';
      var hdr = tags(si, 'header_item').filter(function (a) { return a.key === 'X-BBL-Client-Version'; })[0];
      return {
        parts: zip.names(),
        gcode: gcode,
        md5: md5Text,
        md5Ok: !!(gcodeBytes && md5Text && md5(gcodeBytes) === md5Text.toUpperCase()),
        header: gcode != null ? parseHeader(gcode) : null,
        sliceInfo: {
          clientVersion: hdr ? hdr.value : null,
          meta: metadataMap(si),
          objects: tags(si, 'object'),
          filaments: tags(si, 'filament'),
          nozzles: tags(si, 'nozzle'),
          layerFilamentLists: tags(si, 'layer_filament_list')
        },
        plate: got[3] ? JSON.parse(dec.decode(got[3])) : null,
        modelSettings: got[4] ? metadataMap(dec.decode(got[4])) : null,
        projectSettings: got[5] ? dec.decode(got[5]) : null,
        filamentSequence: got[6] ? JSON.parse(dec.decode(got[6])) : null
      };
    });
  }

  return {
    write: write,
    writeDetailed: writeDetailed,
    describe: describe,
    read: read,
    md5: md5,
    parseHeader: parseHeader,
    parseConfigBlock: parseConfigBlock,
    parseDuration: parseDuration,
    blankPng: blankPng,
    PART: PART,
    PART_ORDER: PART_ORDER.map(function (k) { return PART[k]; }),
    THUMB_SIZES: { plate: 512, plate_small: 128, no_light: 512, top: 512, pick: 512 },
    MODEL_IDS: MODEL_IDS,
    BED_TYPES: BED_TYPES,
    DEFAULT_STUDIO_VERSION: DEFAULT_STUDIO_VERSION
  };
});
