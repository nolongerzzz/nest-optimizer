/** click-test grade — vendored from 2a44fa1. Pull plug: delete cth/ + app-cth.js + tag. */
export const DEFAULT_NORMAL_TOLERANCE = 0.95;

function idMatch(wanted, got) {
  if (!wanted || !got) return false;
  if (wanted === got) return true;
  return got.indexOf(wanted + '_') === 0;
}

export function gradeHit(accept, hit) {
  if (!hit || !hit.hit) return 'miss';
  if (!accept || !accept.objectId) return 'pass';
  if (!idMatch(accept.objectId, hit.objectId)) return 'fail';

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
