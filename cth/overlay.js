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
  hostEl.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483000;';
  const shadow = hostEl.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    .wrap{display:flex;flex-direction:column;align-items:flex-end;gap:6px}
    .chip{background:#14171b;color:#e8a33d;border:1px solid #e8a33d;border-radius:6px;padding:5px 8px;font:600 11px ui-monospace,Menlo,monospace;cursor:pointer}
    .panel{width:300px;max-height:70vh;overflow-y:auto;padding:10px 12px 12px;background:rgba(20,23,27,.94);color:#e7e5e1;border:1px solid #2a3037;border-radius:8px;font:12px/1.45 ui-monospace,Menlo,monospace}
    .panel[hidden]{display:none}
    h1{font-size:12px;margin:0 0 2px}
    .sub{color:#9aa1a8;font-size:11px;margin-bottom:8px}
    .aim{border-top:1px solid #2a3037;padding:7px 0 6px}
    .aim.current{background:rgba(232,163,61,.08);margin:0 -12px;padding-left:12px;padding-right:12px}
    .row{display:flex;gap:8px;justify-content:space-between}
    .aim.current .name{color:#e8a33d;font-weight:600}
    .chip-status{font-weight:600;text-transform:uppercase;font-size:10px}
    .how,.detail,.note,.tally{color:#9aa1a8;font-size:11px;margin-top:4px}
    .note.warn{color:#d2694f}
    button.arm{width:100%;background:#e8a33d;color:#161616;border:0;border-radius:5px;padding:8px 10px;font:600 12px inherit;cursor:pointer}
    button.arm.idle{background:#262c33;color:#e7e5e1;border:1px solid #39414a}
    button:disabled{opacity:.4}
  </style>
  <div class="wrap">
    <button type="button" class="chip" id="cth-toggle">CTH</button>
    <div class="panel" id="cth-panel">
      <h1></h1><div class="sub"></div><div class="aims"></div>
      <div class="controls"><button type="button" class="arm idle"></button></div>
      <div class="note"></div><div class="tally"></div>
    </div>
  </div>`;

  const panel = shadow.getElementById('cth-panel');
  const toggle = shadow.getElementById('cth-toggle');
  shadow.querySelector('h1').textContent = title;
  shadow.querySelector('.sub').textContent = 'Arm, then click the aim. Orbit freely when not armed.';
  const aimsEl = shadow.querySelector('.aims');
  const armBtn = shadow.querySelector('button.arm');
  const noteEl = shadow.querySelector('.note');
  const tallyEl = shadow.querySelector('.tally');
  const state = (tests || []).map((t) => ({ id: t.id, title: t.title || t.id, instruction: t.instruction || '', status: 'pending', detail: '' }));
  let current = 0;
  let armed = false;
  let open = true;

  function setOpen(v) {
    open = !!v;
    panel.hidden = !open;
    toggle.textContent = open ? 'CTH \u2715' : 'CTH';
  }
  toggle.addEventListener('click', (e) => { e.stopPropagation(); setOpen(!open); });

  function render() {
    aimsEl.innerHTML = '';
    state.forEach((aim, i) => {
      const el = document.createElement('div');
      el.className = 'aim' + (i === current ? ' current' : '');
      const colour = STATUS_COLOURS[aim.status] || STATUS_COLOURS.pending;
      el.innerHTML = `<div class="row"><span class="name">${i + 1}. ${escapeHtml(aim.title)}</span><span class="chip-status" style="color:${colour}">${aim.status}</span></div>${i === current && aim.instruction ? `<div class="how">${escapeHtml(aim.instruction)}</div>` : ''}${aim.detail ? `<div class="detail">${aim.detail}</div>` : ''}`;
      aimsEl.appendChild(el);
    });
    const done = current >= state.length;
    armBtn.disabled = done;
    armBtn.textContent = done ? 'All aims recorded' : (armed ? 'Armed \u2014 click the aim' : 'Arm pick');
    armBtn.className = 'arm' + (armed && !done ? '' : ' idle');
    const count = (s) => state.filter((a) => a.status === s).length;
    tallyEl.textContent = count('pass') + ' pass \u00b7 ' + count('fail') + ' fail \u00b7 ' + count('miss') + ' miss \u00b7 ' + count('pending') + ' pending';
    toggle.textContent = open ? 'CTH \u2715' : ('CTH ' + count('pass') + '/' + state.length);
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
