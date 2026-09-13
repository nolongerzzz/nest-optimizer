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

function resolveMount(explicit) {
  if (explicit) return explicit;
  if (typeof document === 'undefined') return null;
  return document.querySelector('.viewport-section') || document.querySelector('#viewport') || document.body;
}

export function createCthOverlay({ tests, onArm, title = 'Click Test Harness', mount } = {}) {
  const parent = resolveMount(mount);
  if (!parent) throw new Error('createCthOverlay: nowhere to mount');
  if (parent !== document.body && typeof getComputedStyle === 'function') {
    const pos = getComputedStyle(parent).position;
    if (!pos || pos === 'static') parent.style.position = 'relative';
  }

  const hostEl = document.createElement('div');
  hostEl.setAttribute('data-cth-overlay', '');
  hostEl.style.cssText = 'position:absolute;left:60px;bottom:12px;z-index:40;pointer-events:none;';
  const shadow = hostEl.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    .dock{display:flex;flex-direction:row;align-items:flex-end;gap:8px;pointer-events:none}
    .side{display:flex;flex-direction:column-reverse;gap:8px;align-items:flex-start;pointer-events:auto}
    .chip,.arm{
      width:40px;height:40px;box-sizing:border-box;padding:0;
      border-radius:8px;border:1px solid #3a4558;
      background:rgba(15,23,42,.82);color:#e8a33d;
      font:600 10px/1 ui-monospace,Menlo,monospace;
      cursor:pointer;display:flex;align-items:center;justify-content:center;
      text-align:center;
    }
    .chip{color:#fbbf24}
    .arm{background:rgba(15,23,42,.82);color:#e7e5e1}
    .arm.hot{background:#e8a33d;color:#161616;border-color:#e8a33d}
    button:disabled{opacity:.4}
    .tab{
      pointer-events:auto;
      min-width:280px;max-width:min(420px,calc(100vw - 220px));
      min-height:88px;max-height:120px;overflow:auto;
      padding:8px 10px;
      background:rgba(20,23,27,.94);color:#e7e5e1;
      border:1px solid #2a3037;border-radius:8px;
      font:12px/1.4 ui-monospace,Menlo,monospace;
    }
    .tab[hidden]{display:none}
    h1{font-size:12px;margin:0 0 6px;color:#e8a33d}
    .aim-name{font-weight:600}
    .aim-status{font-weight:600;text-transform:uppercase;font-size:10px;margin-left:8px}
    .row{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
    .detail,.note{color:#9aa1a8;font-size:11px;margin-top:4px}
    .note.warn{color:#d2694f}
  </style>
  <div class="dock">
    <div class="side">
      <button type="button" class="chip" id="cth-toggle" title="Hide or show the batch tab">CTH</button>
      <button type="button" class="arm" id="cth-arm">Arm</button>
    </div>
    <div class="tab" id="cth-panel">
      <h1></h1>
      <div class="row"><span class="aim-name" id="cth-aim"></span><span class="aim-status" id="cth-status"></span></div>
      <div class="detail" id="cth-detail"></div>
      <div class="note" id="cth-note"></div>
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
    render();
  }
  toggle.addEventListener('click', (e) => { e.stopPropagation(); setOpen(!open); });

  function currentAim() {
    if (current >= state.length) return state[state.length - 1] || null;
    return state[current];
  }

  function render() {
    const aim = currentAim();
    const done = current >= state.length;
    const passed = state.filter((a) => a.status === 'pass').length;
    toggle.textContent = open ? 'CTH \u2715' : ('CTH\n' + passed + '/' + state.length);
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
    armBtn.textContent = done ? 'Done' : 'Arm';
    armBtn.className = 'arm' + (armed && !done ? ' hot' : '');
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
        aim.detail = 'got <b>' + escapeHtml(String(got)) + '</b> \u00b7 wanted <b>' + escapeHtml(String(wantId) + wantReg) + '</b>';
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
