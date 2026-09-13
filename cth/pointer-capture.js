const DOWN_EVENTS = ['pointerdown', 'mousedown', 'touchstart'];
const MOVE_EVENTS = ['pointermove', 'mousemove', 'touchmove'];
const UP_EVENTS = ['pointerup', 'mouseup', 'touchend', 'pointercancel', 'touchcancel'];
const TAIL_EVENTS = ['click', 'dblclick', 'contextmenu', 'dragstart'];
const TAIL_SUPPRESS_MS = 700;

function pointOf(event) {
  if (event.touches && event.touches.length) return { x: event.touches[0].clientX, y: event.touches[0].clientY };
  if (event.changedTouches && event.changedTouches.length) {
    return { x: event.changedTouches[0].clientX, y: event.changedTouches[0].clientY };
  }
  return { x: event.clientX, y: event.clientY };
}

export function createPointerCapture({
  container,
  onClick,
  onDrag,
  dragThresholdPx = 24,
  root = typeof window !== 'undefined' ? window : null,
}) {
  if (!container) throw new Error('createPointerCapture: container is required');
  if (!root) throw new Error('createPointerCapture: no root to listen on');

  let armed = false;
  let sticky = false;
  let gesture = null;
  let tailUntil = 0;
  const bound = [];
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function inContainer(event) {
    const t = event.target;
    return t === container || (t && container.contains && container.contains(t));
  }

  function consume(event) {
    event.stopImmediatePropagation();
    event.stopPropagation();
    if (event.cancelable) event.preventDefault();
  }

  function onDown(event) {
    if (gesture) {
      if (inContainer(event)) consume(event);
      return;
    }
    if (!armed || !inContainer(event)) return;
    consume(event);
    const p = pointOf(event);
    gesture = { x: p.x, y: p.y, dragged: false };
  }

  function onMove(event) {
    if (!gesture) return;
    consume(event);
    const p = pointOf(event);
    if (Math.abs(p.x - gesture.x) + Math.abs(p.y - gesture.y) > dragThresholdPx) gesture.dragged = true;
  }

  function onUp(event) {
    if (!gesture) return;
    consume(event);
    const p = pointOf(event);
    const moved = Math.abs(p.x - gesture.x) + Math.abs(p.y - gesture.y);
    const wasDrag = gesture.dragged || moved > dragThresholdPx;
    gesture = null;
    tailUntil = now() + TAIL_SUPPRESS_MS;
    if (!sticky) armed = false;
    if (wasDrag) { if (onDrag) onDrag(); }
    else if (onClick) onClick(p.x, p.y);
  }

  function onTail(event) {
    if (now() < tailUntil && inContainer(event)) consume(event);
  }

  function bind(names, handler) {
    for (const name of names) {
      root.addEventListener(name, handler, { capture: true, passive: false });
      bound.push([name, handler]);
    }
  }

  bind(DOWN_EVENTS, onDown);
  bind(MOVE_EVENTS, onMove);
  bind(UP_EVENTS, onUp);
  bind(TAIL_EVENTS, onTail);

  return {
    armOnce() { armed = true; sticky = false; },
    arm() { armed = true; sticky = true; },
    disarm() { armed = false; sticky = false; gesture = null; },
    isArmed() { return armed; },
    dispose() {
      for (const [name, handler] of bound) root.removeEventListener(name, handler, { capture: true });
      bound.length = 0;
      armed = false;
      gesture = null;
    },
  };
}
