import { gradeHit } from './grade.js?v=cth6f';
import { createPointerCapture } from './pointer-capture.js?v=cth6f';

export function createClickTestHarness({
  container, host, tests, onResult, onComplete, onDragIgnored, pointerMode = 'listen',
}) {
  if (!container) throw new Error('createClickTestHarness: container is required');
  if (!host) throw new Error('createClickTestHarness: host adapter is required');
  if (!Array.isArray(tests) || tests.length === 0) throw new Error('createClickTestHarness: tests[] is required');

  let current = 0;
  let testStart = performance.now();
  let completed = false;
  let capture = null;
  const results = [];

  function currentTest() { return tests[current]; }
  function acceptFor(t) { return t.accept || { objectId: t.target ? t.target.objectId : null }; }

  function setupTest(i) {
    host.clearMarker();
    const t = tests[i];
    if (t && t.target) host.placeMarker(t.target);
    testStart = performance.now();
  }

  function handleClick(clientXpx, clientYpx) {
    if (current >= tests.length) return;
    const rect = container.getBoundingClientRect();
    const xPix = clientXpx - rect.left, yPix = clientYpx - rect.top;
    const point = {
      xPix: Math.round(xPix), yPix: Math.round(yPix),
      xNDC: +(((xPix / rect.width) * 2 - 1).toFixed(4)),
      yNDC: +((-(yPix / rect.height) * 2 + 1).toFixed(4)),
      canvasWidth: Math.round(rect.width), canvasHeight: Math.round(rect.height),
    };
    const hit = host.raycastAtScreenPoint(point);
    const t = currentTest();
    const result = gradeHit(acceptFor(t), hit);
    const entry = {
      testId: t.id, title: t.title,
      reactionMs: Math.round(performance.now() - testStart),
      camera: host.getCameraState ? host.getCameraState() : null,
      clickScreen: point,
      hit: hit && hit.hit ? { objectId: hit.objectId, point: hit.point, normal: hit.normal, distance: hit.distance } : null,
      expected: acceptFor(t),
      result,
    };
    results.push(entry);
    current++;
    if (current < tests.length) setupTest(current);
    else host.clearMarker();
    if (onResult) onResult(entry);
    if (current >= tests.length && !completed) {
      completed = true;
      if (onComplete) onComplete({ results, summary: {
        pass: results.filter(r => r.result === 'pass').length,
        fail: results.filter(r => r.result === 'fail').length,
        miss: results.filter(r => r.result === 'miss').length,
      }});
    }
  }

  function start() {
    setupTest(0);
    if (pointerMode === 'capture') {
      capture = createPointerCapture({
        container,
        onClick: (x, y) => handleClick(x, y),
        onDrag: () => { if (onDragIgnored) onDragIgnored(); },
      });
    } else {
      container.addEventListener('pointerdown', () => {});
    }
  }

  return {
    start,
    armOnce: () => { if (capture) capture.armOnce(); },
    arm: () => { if (capture) capture.arm(); },
    disarm: () => { if (capture) capture.disarm(); },
    isArmed: () => (capture ? capture.isArmed() : false),
    dispose: () => { if (capture) capture.dispose(); },
    getResults: () => results.slice(),
    getSummary: () => ({ results }),
    get currentIndex() { return current; },
    get totalTests() { return tests.length; },
    get currentTest() { return currentTest(); },
  };
}
