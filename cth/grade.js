/** click-test grade — vendored from 2a44fa1. Pull plug: delete cth/ + app-cth.js + tag. */
export const DEFAULT_NORMAL_TOLERANCE = 0.95;

function idMatch(wanted, got) {
  if (!wanted || !got) return false;
  if (wanted === got) return true;
  return got.indexOf(wanted + '_') === 0;
}

function wantedList(accept) {
  if (!accept) return [];
  if (Array.isArray(accept.objectId)) return accept.objectId;
  if (accept.objectId) return [accept.objectId];
  if (Array.isArray(accept.aliases)) return accept.aliases;
  return [];
}

export function gradeHit(accept, hit) {
  if (!hit || !hit.hit) return 'miss';
  const wanted = wantedList(accept);
  if (!wanted.length) return 'pass';
  if (!wanted.some(function (w) { return idMatch(w, hit.objectId); })) return 'fail';

  if (accept.normals && accept.normals.length) {
    const hn = hit.normal;
    if (!hn) return 'fail';
    const tolerance = typeof accept.normalTolerance === 'number'
      ? accept.normalTolerance
      : DEFAULT_NORMAL_TOLERANCE;
    const ok = accept.normals.some(([nx, ny, nz]) => (hn.x * nx + hn.y * ny + hn.z * nz) > tolerance);
    return ok ? 'pass' : 'fail';
  }

  return 'pass';
}
