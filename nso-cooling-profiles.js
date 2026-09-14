/*
 * NSO cooling profiles
 * --------------------
 * Named, swappable sets of Bambu Studio cooling / overhang-fan settings that get
 * baked into Metadata/project_settings.config of every exported .3mf.
 *
 * Format notes (confirmed against a real Bambu Studio export, stock
 * "Bambu PLA Basic @BBL A1M" profile -- these are NOT guesses):
 *
 *   1. Every value is a single-element array of strings:  ["50%"], not 50 or "50%".
 *   2. Percent-bearing fields keep the literal '%'; plain numeric fields do not,
 *      even when the number semantically *is* a percentage (overhang_fan_speed
 *      is "100", fan_max_speed is "80" -- no '%'). This is Bambu's own
 *      inconsistency and it is reproduced verbatim on purpose. Do not normalise:
 *      Bambu Studio's parser expects each field exactly as it ships it.
 *
 * KEY_FORMATS below encodes rule 2 so that future tuned profiles cannot
 * accidentally add or drop a '%'. validateValues() is called on every export.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NSOCoolingProfiles = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Per-key format contract. 'percent' MUST carry '%', 'number' MUST NOT.
  // ---------------------------------------------------------------------------
  var KEY_FORMATS = {
    enable_overhang_bridge_fan:               { type: 'bool' },
    overhang_fan_threshold:                   { type: 'percent' },
    overhang_threshold_participating_cooling: { type: 'percent' },
    overhang_fan_speed:                       { type: 'number' },
    pre_start_fan_time:                       { type: 'number' },
    reduce_fan_stop_start_freq:               { type: 'bool' },
    slow_down_for_layer_cooling:              { type: 'bool' },
    fan_min_speed:                            { type: 'number' },
    fan_cooling_layer_time:                   { type: 'number' },
    fan_max_speed:                            { type: 'number' },
    slow_down_layer_time:                     { type: 'number' },
    slow_down_min_speed:                      { type: 'number' },
    no_slow_down_for_cooling_on_outwalls:     { type: 'bool' },
    cooling_slowdown_logic:                   { type: 'enum', values: ['uniform_cooling', 'quality_first'] }
  };

  // ---------------------------------------------------------------------------
  // The locked default. Confirmed real stock "Bambu PLA Basic @BBL A1M" data.
  // Key order matches the order they appear in the real project_settings.config
  // so a diff against an untouched Bambu export stays readable.
  //
  // This object is frozen. Tuned profiles layer overrides on top of it; nothing
  // edits it in place.
  // ---------------------------------------------------------------------------
  var DEFAULT_VALUES = Object.freeze({
    enable_overhang_bridge_fan:               '1',
    overhang_fan_threshold:                   '50%',
    overhang_threshold_participating_cooling: '95%',
    overhang_fan_speed:                       '100',
    pre_start_fan_time:                       '2',
    reduce_fan_stop_start_freq:               '1',
    slow_down_for_layer_cooling:              '1',
    fan_min_speed:                            '60',
    fan_cooling_layer_time:                   '80',
    fan_max_speed:                            '80',
    slow_down_layer_time:                     '6',
    slow_down_min_speed:                      '20',
    no_slow_down_for_cooling_on_outwalls:     '0',
    cooling_slowdown_logic:                   'uniform_cooling'
  });

  // ---------------------------------------------------------------------------
  // Profile table. Every profile is DEFAULT_VALUES + its own overrides, so an
  // untuned slot exports byte-identical to `default` until someone fills it in.
  //
  // To tune a slot: put the measured values in `overrides` and flip `tuned` to
  // true. Nothing else needs to change -- the selector, the exporter and the
  // validator all read this table.
  // ---------------------------------------------------------------------------
  var PROFILES = {
    'default': {
      id: 'default',
      label: 'Default - Bambu PLA Basic (stock)',
      note: 'Confirmed stock values pulled from a real Bambu Studio export (Bambu PLA Basic @BBL A1M).',
      tuned: true,
      overrides: {}
    },
    'breakaway-support': {
      id: 'breakaway-support',
      label: 'Breakaway support (not yet tuned)',
      note: 'Reserved for the breakaway-support cooling experiments. Exports the default values until tuned.',
      tuned: false,
      overrides: {}
    },
    'fine-detail': {
      id: 'fine-detail',
      label: 'Fine detail / small parts (not yet tuned)',
      note: 'Reserved for small-part cooling tuning. Exports the default values until tuned.',
      tuned: false,
      overrides: {}
    },
    'high-flow': {
      id: 'high-flow',
      label: 'High flow / large parts (not yet tuned)',
      note: 'Reserved for high-flow cooling tuning. Exports the default values until tuned.',
      tuned: false,
      overrides: {}
    }
  };

  var DEFAULT_PROFILE_ID = 'default';

  // ---------------------------------------------------------------------------
  // Lookup / resolution
  // ---------------------------------------------------------------------------

  function listProfiles() {
    return Object.keys(PROFILES).map(function (id) {
      var p = PROFILES[id];
      return { id: p.id, label: p.label, note: p.note, tuned: p.tuned };
    });
  }

  function getProfile(id) {
    return PROFILES[id] || null;
  }

  function hasProfile(id) {
    return Object.prototype.hasOwnProperty.call(PROFILES, id);
  }

  /**
   * Resolve a profile id to the flat key/value map that gets written.
   * Unknown ids fall back to the default rather than throwing, so a stale
   * saved selection can never block an export.
   */
  function resolveValues(id) {
    var profile = PROFILES[id] || PROFILES[DEFAULT_PROFILE_ID];
    var out = {};
    // Iterate DEFAULT_VALUES so key order is always the confirmed order.
    Object.keys(DEFAULT_VALUES).forEach(function (key) {
      out[key] = Object.prototype.hasOwnProperty.call(profile.overrides, key)
        ? profile.overrides[key]
        : DEFAULT_VALUES[key];
    });
    // An override for a key outside the confirmed set is a bug, not a feature.
    Object.keys(profile.overrides).forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_VALUES, key)) {
        throw new Error('Profile "' + profile.id + '" overrides unknown cooling key "' + key + '"');
      }
    });
    return out;
  }

  // ---------------------------------------------------------------------------
  // Validation -- enforces the two confirmed format rules
  // ---------------------------------------------------------------------------

  var PERCENT_RE = /^\d+(?:\.\d+)?%$/;
  var NUMBER_RE = /^\d+(?:\.\d+)?$/;
  var BOOL_RE = /^[01]$/;

  /**
   * @returns {string[]} list of problems; empty array means valid.
   */
  function validateValues(values) {
    var problems = [];
    Object.keys(KEY_FORMATS).forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(values, key)) {
        problems.push('missing key: ' + key);
        return;
      }
      var v = values[key];
      if (typeof v !== 'string') {
        problems.push(key + ': value must be a string, got ' + typeof v);
        return;
      }
      var fmt = KEY_FORMATS[key];
      if (fmt.type === 'percent' && !PERCENT_RE.test(v)) {
        problems.push(key + ': expected a percent value carrying "%", got "' + v + '"');
      } else if (fmt.type === 'number' && !NUMBER_RE.test(v)) {
        problems.push(key + ': expected a bare number with no "%", got "' + v + '"');
      } else if (fmt.type === 'bool' && !BOOL_RE.test(v)) {
        problems.push(key + ': expected "0" or "1", got "' + v + '"');
      } else if (fmt.type === 'enum' && fmt.values.indexOf(v) === -1) {
        problems.push(key + ': expected one of ' + fmt.values.join(' / ') + ', got "' + v + '"');
      }
    });
    Object.keys(values).forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(KEY_FORMATS, key)) {
        problems.push('unknown key: ' + key);
      }
    });
    return problems;
  }

  // ---------------------------------------------------------------------------
  // Serialise / parse Metadata/project_settings.config
  //
  // The file is JSON. Each cooling value is a JSON array holding exactly one
  // string -- that single-element-array shape is the confirmed format and is
  // what makes the '%' / no-'%' distinction meaningful, since both live inside
  // a string either way.
  //
  // Output is pretty-printed with 4-space indent to match how Bambu Studio
  // writes the file, so a text diff against a real export lines up.
  // ---------------------------------------------------------------------------

  function serializeProjectSettings(values) {
    var problems = validateValues(values);
    if (problems.length) {
      throw new Error('Refusing to write invalid cooling settings:\n  - ' + problems.join('\n  - '));
    }
    var lines = [];
    var keys = Object.keys(values);
    keys.forEach(function (key, i) {
      // Single-element string array, exactly as Bambu ships it.
      var body = '    ' + JSON.stringify(key) + ': [' + JSON.stringify(values[key]) + ']';
      lines.push(body + (i === keys.length - 1 ? '' : ','));
    });
    return '{\n' + lines.join('\n') + '\n}\n';
  }

  /**
   * Parse a project_settings.config back into a flat key -> string map.
   * Throws if any cooling key is not a single-element array of one string,
   * so the round-trip check catches shape drift, not just value drift.
   */
  function parseProjectSettings(text) {
    var raw = JSON.parse(text);
    var out = {};
    Object.keys(raw).forEach(function (key) {
      var v = raw[key];
      if (!Array.isArray(v)) {
        throw new Error('key "' + key + '": expected an array, got ' + JSON.stringify(v));
      }
      if (v.length !== 1) {
        throw new Error('key "' + key + '": expected exactly 1 element, got ' + v.length);
      }
      if (typeof v[0] !== 'string') {
        throw new Error('key "' + key + '": element must be a string, got ' + typeof v[0]);
      }
      out[key] = v[0];
    });
    return out;
  }

  return {
    KEY_FORMATS: KEY_FORMATS,
    DEFAULT_VALUES: DEFAULT_VALUES,
    DEFAULT_PROFILE_ID: DEFAULT_PROFILE_ID,
    listProfiles: listProfiles,
    getProfile: getProfile,
    hasProfile: hasProfile,
    resolveValues: resolveValues,
    validateValues: validateValues,
    serializeProjectSettings: serializeProjectSettings,
    parseProjectSettings: parseProjectSettings
  };
});
