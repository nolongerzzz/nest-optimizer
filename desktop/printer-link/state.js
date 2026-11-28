'use strict';
/* printer-link/state.js - the printer's reports, merged and summarised.

   A Bambu printer publishes JSON on device/<serial>/report. The A1 and P1
   series send a full picture only when asked (pushall) and deltas after that,
   so the last value of every key is kept and each report is merged in.

   Field names are the community-documented ones (OpenBambuAPI). Every field
   is optional here: a key the printer does not send stays null in the summary
   rather than being guessed. */

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

/** Merge a delta into the kept report: objects merge, everything else replaces. */
function merge(into, delta) {
  Object.keys(delta).forEach((k) => {
    const v = delta[k];
    if (isObj(v) && isObj(into[k])) merge(into[k], v);
    else into[k] = isObj(v) ? merge({}, v) : v;
  });
  return into;
}

function hex4(n) { return ('0000' + ((n >>> 0) & 0xffff).toString(16)).slice(-4).toUpperCase(); }

/** print_error 0x03008008 -> "0300-8008", as the touchscreen shows it. */
function printErrorCode(n) {
  n = Number(n) >>> 0;
  return n ? hex4(n >>> 16) + '-' + hex4(n) : '';
}

/** One hms entry { attr, code } -> "0300-1000-0002-0001", as Bambu's wiki names them. */
function hmsCode(e) {
  const a = Number(e && e.attr) >>> 0, c = Number(e && e.code) >>> 0;
  return [hex4(a >>> 16), hex4(a), hex4(c >>> 16), hex4(c)].join('-');
}

function num(v) { const n = Number(v); return v === undefined || v === null || v === '' || !isFinite(n) ? null : n; }

/** States in which a job owns the machine: anything that moves must be judged against it. */
const JOB_STATES = ['RUNNING', 'PAUSE', 'PREPARE', 'SLICING'];

function summarise(report) {
  const p = (report && report.print) || {};
  const state = typeof p.gcode_state === 'string' ? p.gcode_state : null;
  return {
    gcodeState: state,
    jobActive: state ? JOB_STATES.indexOf(state) >= 0 : null,
    paused: state === 'PAUSE',
    percent: num(p.mc_percent),
    remainingMin: num(p.mc_remaining_time),
    layer: num(p.layer_num),
    totalLayers: num(p.total_layer_num),
    file: p.subtask_name || p.gcode_file || null,
    nozzle: { temp: num(p.nozzle_temper), target: num(p.nozzle_target_temper) },
    bed: { temp: num(p.bed_temper), target: num(p.bed_target_temper) },
    partFan: num(p.cooling_fan_speed),
    speedLevel: num(p.spd_lvl),
    wifi: p.wifi_signal || null,
    stage: num(p.stg_cur),
    printError: printErrorCode(p.print_error),
    hms: Array.isArray(p.hms) ? p.hms.map(hmsCode) : [],
    sdcard: typeof p.sdcard === 'boolean' ? p.sdcard : null,
    nozzleDiameter: p.nozzle_diameter !== undefined ? String(p.nozzle_diameter) : null
  };
}

module.exports = { merge, summarise, printErrorCode, hmsCode, JOB_STATES };
