const STATUS_COLOURS = { pending: '#8a8f96', pass: '#5fa779', fail: '#d2694f', miss: '#c99a3d', drag: '#7f8ea3' };

export function shouldMount({ flag = 'cth', search } = {}) {
  const query = search ?? (typeof location !== 'undefined' ? location.search : '');
  const value = new URLSearchParams(query).get(flag);
  if (value === null) return false;
  return value === '' || ['1', 'true', 'yes', 'on', 'finish'].includes(String(value).toLowerCase());
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&', '<': '<', '>': '>', '"': '"', "'": '&#39;' }[c]));
}

export function createCthOverlay({ tests, onArm, title = 'Click Test Harness', mount } = {}) {
  const parent = mount || (typeof document !== 'undefined' ? document.body : null);
  if (!parent) throw new Error('createCthOverlay: nowhere to mount');

  const hostEl = document.createElement('div');
  hostEl.setAttribute('data-cth-overlay', '');
  hostEl.style.cssText = 'position:fixed;left:64px;bottom:12px;z-index:2147483000;pointer-events:auto;';
  const shadow = hostEl.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    .dock{display:flex;flex-direction:row;align-items:flex-end;gap:6px}
    .tab{width:248px;padding:8px 10px;background:rgba(20,23,27,.94);color:#e7e5e1;border:1px solid #2a3037;border-radius:8px;font:12px/1.4 ui-monospace,Menlo,monospace}
    .tab[hidden]{display:none}
    h1{font-size:12px;margin:0 0 6px;color:#e8a33d}
    .aim-name{font-weight:600}
    .aim-status{font-weight:600;text-transform:uppercase;font-size:10px;margin-left:8px}
    .row{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
    .detail,.note{color:#9aa1a8;font-size:11px;margin-top:4px}
    .note.warn{color:#d2694f}
    .side{display:flex;flex-direction:column;gap:6px;align-items:stretch}
    .chip,.arm{min-width:52px;border-radius:6px;padding:7px 8px;font:600 11px ui-monospace,Menlo,monospace;cursor:pointer;border:1px solid #e8a33d;background:#14171b;color:#e8a33d}
    .arm{background:#e8a33d;color:#161616;border:0}
    .arm.idle{background:#262c33;color:#e7e5e1;border:1px solid #39414a}
    button:disabled{opacity:.4}
  </style>
  <div class="dock">
    <div class="tab" id="cth-panel">
      <h1></h1>
      <div class="row"><span class="aim-name" id="cth-aim"></span><span class="aim-status" id="cth-status"></span></div>
      <div class="detail" id="cth-detail"></div>
      <div class="note" id="cth-note"></div>
    </div>
    <div class="side">
      <button type="button" class="chip" id="cth-toggle">CTH ✕</button>
      <button type="button" class="arm idle" id="cth-arm">Arm</button>
    </div>
  </div>`;

  const panel = shadow.getElementById('cth-panel');
  const toggle = shadow.getElementById('cth-toggle');
  const armBtn = shadow.getElementById('cth-arm');
  const titleEl = shadow.querySelector('h1');
  const aimEl = shadow.getElementById('cth-aim');
  const statusEl = shadow.getElementById('cth-status');
  const detailEl = shadow.getElementById('cth-detail');
  const noteEl = shadow.getElementById('cth-note');
  titleEl.textContent = title;

  const state = (tests || []).map((t) => ({
    id: t.id,
    title: t.title || t.id,
    instruction: t.instruction || '',
    status: 'pending',
    detail: '',
  }));
  let current = 0;
  let armed = false;
  let open = true;

  function setOpen(v) {
    open = !!v;
    panel.hidden = !open;
    const n = state.filter((a) => a.status === 'pass').length;
    toggle.textContent = open ? 'CTH ✕' : ('CTH ' + n + '/' + state.length);
  }
  toggle.addEventListener('click', (e) => { e.stopPropagation(); setOpen(!open); });

  function currentAim() {
    if (current >= state.length) return state[state.length - 1] || null;
    return state[current];
  }

  function render() {
    const aim = currentAim();
    const done = current >= state.length;
    if (aim) {
      const idx = done ? state.length : current + 1;
      aimEl.textContent = idx + '. ' + aim.title;
      statusEl.textContent = done ? 'done' : aim.status;
      statusEl.style.color = STATUS_COLOURS[done ? 'pass' : aim.status] || STATUS_COLOURS.pending;
      detailEl.innerHTML = aim.detail || (aim.instruction ? escapeHtml(aim.instruction) : '');
    } else {
      aimEl.textContent = 'No aims';
      statusEl.textContent = '';
      detailEl.textContent = '';
    }
    armBtn.disabled = done;
    armBtn.textContent = done ? 'Done' : (armed ? 'Armed' : 'Arm');
    armBtn.className = 'arm' + (armed && !done ? '' : ' idle');
    if (open) toggle.textContent = 'CTH ✕';
    else toggle.textContent = 'CTH ' + state.filter((a) => a.status === 'pass').length + '/' + state.length;
  }

  armBtn.addEventListener('click', (e) => { e.stopPropagation(); if (onArm) onArm(); });
  parent.appendChild(hostEl);
  render();

  return {
    root: hostEl,
    setCurrent(index) { current = index; render(); },
    setArmed(value) { armed = !!value; render(); },
    recordResult(entry) {
      const aim = state.find((a) => a.id === entry.testId);
      if (aim) {
        aim.status = entry.result;
        const got = entry.hit ? (entry.hit.objectId + (entry.hit.region ? '/' + entry.hit.region : '')) : 'nothing';
        const wantId = entry.expected && entry.expected.objectId ? entry.expected.objectId : 'any';
        const wantReg = entry.expected && entry.expected.region ? '/' + entry.expected.region : '';
        aim.detail = 'got <b>' + escapeHtml(String(got)) + '</b> · wanted <b>' + escapeHtml(String(wantId) + wantReg) + '</b>';
      }
      render();
    },
    setNote(text, isWarning = false) {
      noteEl.textContent = text || '';
      noteEl.className = 'note' + (isWarning ? ' warn' : '');
    },
    destroy() { hostEl.remove(); },
  };
}
