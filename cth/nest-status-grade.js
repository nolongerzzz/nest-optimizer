/**
 * click-test-harness / nest soften status grade
 *
 * The one rule that turns Nest's `#status` line into a pass/fail for a
 * driven Soften. Pure — no DOM, no THREE, no window — so the browser driver
 * and a Node test import the same implementation and cannot drift.
 *
 * Every pattern below is a literal Nest string. Where a pattern is quoted in
 * a comment it is quoted from nest-optimizer at the commit this was written
 * against (app-finish.js / app-join.js setStatus calls), so a Nest wording
 * change shows up as a new `unrecognised` grade rather than a silent pass.
 *
 * Grades:
 *   'pass'    - the press baked. A face count or a wrap radius is in the line.
 *   'fail'    - the press armed, cancelled, or was refused.
 *   'pending' - the bake is still running; the caller keeps waiting.
 *   'miss'    - nothing to grade, or wording this rule does not know.
 */

const PENDING = [
  [/^wrapping\b/i, 'wrapping'],
];

const ARMED = [
  [/^soften cancelled\b/i, 'cancelled'],
  [/\bclick a face\b/i, 'armed'],
  [/^click an outer face\b/i, 'pick-refused-recessed'],
  [/^click a flat face\b/i, 'pick-refused-curved'],
];

const REFUSED = [
  [/^still wrapping\b/i, 'busy'],
  [/found no pocket\b/i, 'no-pocket'],
  [/^wrap needs faces it can name\b/i, 'unnameable-face'],
  [/^wrap stopped\b/i, 'wrap-stopped'],
  [/^that face is painted out\b/i, 'face-painted-out'],
  [/^that face is inside the piece\b/i, 'face-recessed'],
  [/^select a piece first\b/i, 'no-piece'],
  [/needs a square-split\b/i, 'no-raw-soup'],
  [/\bfailed\b/i, 'failed'],
  [/piece unchanged\b/i, 'unchanged'],
];

const BAKED = [
  [/\bwrap r \d/i, 'wrap-bake'],
  [/^corners\+edges setback r \d/i, 'setback-bake'],
  [/^corners r \d/i, 'corners-bake'],
  [/^soften ok\b/i, 'soften-ok'],
];

function firstMatch(table, text) {
  for (const [re, reason] of table) if (re.test(text)) return reason;
  return null;
}

export function gradeNestSoftenStatus(status) {
  const text = (status == null ? '' : String(status)).trim();
  if (!text) return { result: 'miss', reason: 'no-status', status: text };

  const pending = firstMatch(PENDING, text);
  if (pending) return { result: 'pending', reason: pending, status: text };

  const armed = firstMatch(ARMED, text);
  if (armed) return { result: 'fail', reason: armed, status: text };

  const refused = firstMatch(REFUSED, text);
  if (refused) return { result: 'fail', reason: refused, status: text };

  const baked = firstMatch(BAKED, text);
  if (baked) {
    if (/nothing to add\b/i.test(text)) {
      return { result: 'pass', reason: 'soften-ok-noop', status: text };
    }
    return { result: 'pass', reason: baked, status: text };
  }

  return { result: 'miss', reason: 'unrecognised', status: text };
}

export default gradeNestSoftenStatus;
