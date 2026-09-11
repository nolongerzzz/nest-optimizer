import { createThreeHostAdapter } from './three-adapter.js';
import { createClickTestHarness } from './harness.js';
import { createCthOverlay, shouldMount } from './overlay.js';

export function mountLiveHarness({
  THREE,
  scene,
  camera,
  renderer,
  container,
  raycastables,
  tests,
  flag = 'cth',
  force = false,
  title,
  onResult,
  onComplete,
}) {
  if (!force && !shouldMount({ flag })) return null;

  const canvas = container || (renderer && renderer.domElement);
  if (!canvas) throw new Error('mountLiveHarness: pass container or renderer');
  if (!Array.isArray(tests) || tests.length === 0) throw new Error('mountLiveHarness: tests[] is required');

  const host = createThreeHostAdapter({ THREE, scene, camera, raycastables });

  const overlay = createCthOverlay({
    tests,
    title,
    onArm: () => {
      harness.armOnce();
      overlay.setArmed(true);
      overlay.setNote('Armed. The next click on the model is captured — the app will not move it.');
    },
  });

  const harness = createClickTestHarness({
    container: canvas,
    host,
    tests,
    pointerMode: 'capture',
    onResult: (entry) => {
      overlay.recordResult(entry);
      overlay.setArmed(false);
      overlay.setCurrent(harness.currentIndex);
      overlay.setNote(
        entry.result === 'pass'
          ? 'Recorded. Arm again for the next aim.'
          : 'Recorded ' + entry.result + '. Arm again for the next aim.',
        entry.result !== 'pass',
      );
      if (onResult) onResult(entry);
    },
    onDragIgnored: () => {
      overlay.setArmed(false);
      overlay.setNote('That gesture moved — treated as a drag, not a pick. Re-arm and click without sliding.', true);
    },
    onComplete: (summary) => {
      overlay.setNote('All aims recorded.');
      if (onComplete) onComplete(summary);
    },
  });

  harness.start();
  overlay.setCurrent(0);
  overlay.setNote('Ready. Orbit to line up aim 1, then Arm pick.');

  if (typeof window !== 'undefined') {
    window.__CTH_HARNESS__ = harness;
    window.__CTH_OVERLAY__ = overlay;
  }

  return { harness, host, overlay };
}
