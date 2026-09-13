/* Paint-mode clicks getting stolen by the plate-drag.

   A paint click on a piece was also starting a move drag, so endMoveDrag()
   reported "Moved model #N" over the paint's own status line. Three parts:

   1. the platform mechanism, on Node's real EventTarget - why app-core's
      stopPropagation() never protected app-mask, and why answering it with
      stopImmediatePropagation() there would be worse, not better;
   2. the two-listener contract as a model, with and without the guard;
   3. source checks, so the model above cannot drift from the shipped files.

   Run: node tools/cth-test/paint-click-steal.test.mjs */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

/* ================= 1. the platform mechanism ================= */
console.log('\nplatform: two listeners on one node, same phase');

function twoListeners(firstAction) {
  const node = new EventTarget();
  const ran = [];
  node.addEventListener('pointerdown', (e) => { ran.push('core'); firstAction(e); });
  node.addEventListener('pointerdown', () => { ran.push('mask'); });
  node.dispatchEvent(new Event('pointerdown', { cancelable: true }));
  return ran;
}

ok('both run when the first does nothing',
   twoListeners(() => {}).join(',') === 'core,mask');
ok('stopPropagation() does NOT stop the sibling  <- the bug',
   twoListeners((e) => e.stopPropagation()).join(',') === 'core,mask');
ok('stopImmediatePropagation() DOES stop it  <- would kill painting',
   twoListeners((e) => e.stopImmediatePropagation()).join(',') === 'core');

/* app-core binds inside initThree(), run at app-join.js top level while the
   document is still parsing; app-mask binds at DOMContentLoaded. So core is
   always first, and cannot be given stopImmediatePropagation without taking
   the event away from the paint. The fix has to be core standing down. */

/* ================= 2. the contract, modelled ================= */
console.log('\ncontract: a paint-mode click that lands on a piece');

// The branch of onCanvasPointerDown that matters, and app-mask's handler.
// `guarded` is the only difference between the old behaviour and the new.
function clickOnPiece({ maskPaint, guarded }) {
  const log = [];
  const state = { maskPaint, moveDragging: false, status: '' };
  const setStatus = (t) => { state.status = t; };
  const hitFace = () => (state.modelGroupHasPiece === false ? null : { faceIndex: 0 });
  const nsoMaskTakesClick = () => !!(state.maskPaint && hitFace());

  // listener 1 - app-core's onCanvasPointerDown
  if (guarded && nsoMaskTakesClick()) {
    log.push('core: stood down');
  } else {
    log.push('core: startMoveDrag');
    state.moveDragging = true;
  }
  // listener 2 - app-mask's, which runs either way
  if (state.maskPaint && hitFace()) { log.push('mask: toggled face'); setStatus('Excluded the X+ face - 1 face(s) excluded'); }

  // pointerup -> endMoveDrag, which reports unconditionally (app-core.js:1765)
  if (state.moveDragging) { log.push('up: endMoveDrag'); setStatus('Moved model #1'); }
  return { log, status: state.status };
}

const bugged = clickOnPiece({ maskPaint: true, guarded: false });
ok('unguarded: the click starts a move drag',
   bugged.log.includes('core: startMoveDrag'), bugged.log.join(' | '));
ok('unguarded: the face still gets painted',
   bugged.log.includes('mask: toggled face'));
ok('unguarded: status ends up "Moved model #1"  <- the symptom',
   bugged.status === 'Moved model #1', bugged.status);

const fixed = clickOnPiece({ maskPaint: true, guarded: true });
ok('guarded: no move drag', !fixed.log.includes('core: startMoveDrag'), fixed.log.join(' | '));
ok('guarded: the face is still painted', fixed.log.includes('mask: toggled face'));
ok('guarded: the paint status survives',
   fixed.status === 'Excluded the X+ face - 1 face(s) excluded', fixed.status);

const normal = clickOnPiece({ maskPaint: false, guarded: true });
ok('paint off: the move drag still works',
   normal.log.includes('core: startMoveDrag') && normal.status === 'Moved model #1',
   normal.log.join(' | '));

/* ================= 3. the shipped source ================= */
console.log('\nsource: app-core.js and app-mask.js');
const core = readFileSync(new URL('../../app-core.js', import.meta.url), 'utf8');
const mask = readFileSync(new URL('../../app-mask.js', import.meta.url), 'utf8');

ok('app-mask exposes the predicate', /window\.nsoMaskTakesClick\s*=/.test(mask));
ok('the predicate is paint-gated and needs a real face hit',
   /nsoMaskTakesClick[\s\S]{0,320}state\.maskPaint[\s\S]{0,320}hitFace\(/.test(mask));

const down = core.slice(core.indexOf('function onCanvasPointerDown('));
const body = down.slice(0, down.indexOf('\nfunction '));
ok('onCanvasPointerDown consults it', /nsoMaskTakesClick/.test(body));
const gAt = body.indexOf('nsoMaskTakesClick'), dAt = body.indexOf('startMoveDrag(');
ok('the guard sits before the startMoveDrag branch',
   gAt >= 0 && dAt >= 0 && gAt < dAt, 'guard@' + gAt + ' drag@' + dAt);
ok('the guard does not stopImmediatePropagation (that would kill the paint)',
   !/nsoMaskTakesClick[\s\S]{0,260}stopImmediatePropagation/.test(body));
ok('app-mask still binds in the capture phase on the canvas',
   /renderer\.domElement\.addEventListener\('pointerdown'[\s\S]{0,1400}\}, true\)/.test(mask));
ok('the paint overlay is still raycast-inert (the earlier fix, not regressed)',
   /overlay\.raycast\s*=\s*function\s*\(\)\s*\{\s*\}/.test(mask));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
