'use strict';
/* printer-link/guard.js - what may be sent to the printer, judged before it is sent.

   Every rule here comes from a print the owner lost (docs/DESKTOP.md,
   "Why the guard exists"):

   1. A full home during a job re-measures Z on top of the part. So while a
      job is running or paused, G28 must name its axes and must not name Z.
   2. With the service lock on, the blocks are on the rails. Anything that
      moves an axis stalls the motors against them, so motion, homing, resume
      and the firmware's own filament routines are refused until the lock is
      taken off in the app.

   The guard cannot see the touchscreen: a press there bypasses it. */

/** G-code words, comments stripped: "G28 X ; re-home" -> ["G28", "X"]. */
function words(line) {
  return String(line).replace(/;.*$/, '').replace(/\(.*?\)/g, '').trim().toUpperCase().split(/\s+/).filter(Boolean);
}

function splitLines(text) {
  return String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l[0] !== ';');
}

const MOTION = /^(G0|G1|G2|G3|G00|G01|G02|G03)$/;

/** Does this line move X, Y or Z? (An E-only G1 - a purge - does not.) */
function movesAxis(w) {
  if (!MOTION.test(w[0])) return false;
  return w.slice(1).some((a) => /^[XYZ]-?[\d.]/.test(a));
}

function isHome(w) { return w[0] === 'G28'; }
function homeAxes(w) { return w.slice(1).filter((a) => /^[XYZ]/.test(a)).map((a) => a[0]); }

/**
 * Judge G-code against the printer's state.
 *   state: { jobActive: bool|null, locked: bool }
 * Returns { ok: true } or { ok: false, reason }.
 * jobActive null (state not known yet) is treated as a job: refuse rather than guess.
 */
function checkGcode(text, state) {
  const lines = splitLines(text);
  if (!lines.length) return { ok: false, reason: 'No G-code to send.' };
  const job = state.jobActive !== false;
  for (const line of lines) {
    const w = words(line);
    if (!w.length) continue;
    if (state.locked && (movesAxis(w) || isHome(w) || w[0] === 'G29' || w[0] === 'G29.1' || w[0] === 'G29.2' || w[0] === 'G39.4')) {
      return { ok: false, reason: 'The service lock is on: "' + line + '" would move an axis against the blocks. Take the lock off first.' };
    }
    if (isHome(w) && job) {
      const ax = homeAxes(w);
      if (!ax.length) return { ok: false, reason: '"' + line + '" homes every axis. During a job that re-measures Z on top of the part. Name the axes (X, Y) instead.' };
      if (ax.indexOf('Z') >= 0) return { ok: false, reason: '"' + line + '" homes Z. During a job that re-measures Z on top of the part.' };
    }
    if ((w[0] === 'G29' || w[0] === 'G39.4') && job) {
      return { ok: false, reason: '"' + line + '" probes the bed. Not during a job.' };
    }
  }
  return { ok: true, lines };
}

/** Commands (not G-code) the lock refuses. */
const LOCK_REFUSES = ['resume', 'project_file', 'unload_filament', 'ams_change_filament', 'calibration'];

function checkCommand(name, state) {
  if (state.locked && LOCK_REFUSES.indexOf(name) >= 0) {
    return { ok: false, reason: 'The service lock is on: "' + name + '" moves the head. Take the lock off first.' };
  }
  return { ok: true };
}

module.exports = { checkGcode, checkCommand, words, splitLines, movesAxis };
