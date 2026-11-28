'use strict';
/* ui/printers.js - the Printers window. Talks to the main process through
   window.nso (preload-ui.js); it holds no credentials and opens no sockets. */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var S = { printers: [], sel: null, status: {}, probe: null, editId: null, file: null, canKeep: true };

  function show(id) { ['empty', 'form', 'detail'].forEach(function (p) { $(p).hidden = p !== id; }); }
  function text(id, t) { $(id).textContent = t === null || t === undefined ? '' : String(t); }
  /** Unwrap a main-process reply; an error is thrown with its words. */
  function un(r) { if (!r || !r.ok) { var e = new Error((r && r.error) || 'No reply.'); e.code = r && r.code; throw e; } return r.value; }
  function sel() { return S.printers.filter(function (p) { return p.id === S.sel; })[0] || null; }
  function st() { return S.status[S.sel] || { link: 'offline' }; }

  // ---------------------------------------------------------------- list
  function renderList() {
    var ul = $('list'); ul.textContent = '';
    S.printers.forEach(function (p) {
      var li = document.createElement('li');
      if (p.id === S.sel) li.className = 'sel';
      var dot = document.createElement('span'); dot.className = 'dot ' + ((S.status[p.id] || {}).link || 'offline');
      var nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = p.name || p.serial;
      var md = document.createElement('span'); md.className = 'md'; md.textContent = modelLabel(p.model);
      li.appendChild(dot); li.appendChild(nm); li.appendChild(md);
      li.addEventListener('click', function () { S.sel = p.id; S.editId = null; render(); });
      ul.appendChild(li);
    });
  }
  var MODELS = [];
  function modelLabel(id) { var m = MODELS.filter(function (x) { return x.id === id; })[0]; return m ? m.label : id; }

  // ---------------------------------------------------------------- form
  function openForm(p) {
    S.editId = p ? p.id : 'new'; S.probe = null;
    text('form-title', p ? 'Edit ' + p.name : 'Add a printer');
    $('f-name').value = p ? p.name : ''; $('f-model').value = p ? p.model : 'a1mini';
    $('f-host').value = p ? p.host : ''; $('f-serial').value = p ? p.serial : ''; $('f-code').value = '';
    text('f-code-note', (p ? 'Leave empty to keep the stored code. ' : '') + (S.canKeep ? 'Kept in this computer\'s keychain.' : 'This session has no keychain, so the code is kept until the app closes and asked for again next time.'));
    $('cert').hidden = true; text('check-out', ''); text('form-err', ''); $('btn-save').disabled = true;
    show('form');
  }
  function checkPrinter() {
    var host = $('f-host').value.trim();
    text('form-err', ''); text('check-out', 'Asking ' + host + '...'); $('cert').hidden = true; $('btn-save').disabled = true; S.probe = null;
    window.nso.printers.probe(host).then(un).then(function (r) {
      S.probe = r; text('check-out', '');
      var serial = $('f-serial').value.trim();
      text('c-cn', r.mqtt.subjectCN || '(none)'); text('c-issuer', r.mqtt.issuerCN || '(none)'); text('c-fp', r.mqtt.fingerprint256);
      text('c-ftp', r.ftp ? 'answers on port 990' : 'no answer on port 990 (' + r.ftpError + ') - status and commands will work, sending files will not');
      var match = serial && r.mqtt.subjectCN && r.mqtt.subjectCN.toUpperCase() === serial.toUpperCase();
      text('c-verdict', match
        ? 'The certificate carries the serial number you entered. Saving pins this certificate: only a printer that presents it will be sent the access code.'
        : 'The certificate\'s name is not the serial number you entered. Check the serial on the printer\'s screen. If they should match and do not, do not save.');
      $('c-verdict').className = match ? 'note' : 'err';
      $('cert').hidden = false; $('btn-save').disabled = false;
    }).catch(function (e) { text('check-out', ''); text('form-err', e.message); });
  }
  function savePrinter() {
    var existing = S.editId !== 'new' ? S.printers.filter(function (p) { return p.id === S.editId; })[0] : null;
    var rec = { name: $('f-name').value.trim() || modelLabel($('f-model').value), model: $('f-model').value, host: $('f-host').value.trim(), serial: $('f-serial').value.trim() };
    var code = $('f-code').value;
    if (!rec.host || !rec.serial) return text('form-err', 'The address and the serial number are both needed.');
    if (!existing && !code) return text('form-err', 'Enter the access code from the printer\'s screen.');
    if (!S.probe) return text('form-err', 'Press "Check the printer" first.');
    if (existing) rec.id = existing.id;
    if (code) rec.accessCode = code;
    rec.pins = { mqtt: S.probe.mqtt.fingerprint256, ftp: S.probe.ftp ? S.probe.ftp.fingerprint256 : '' };
    window.nso.printers.save(rec).then(un).then(function (p) { S.sel = p.id; S.editId = null; delete S.status[p.id]; return reload(); })
      .catch(function (e) { text('form-err', e.message); });
  }

  // ---------------------------------------------------------------- detail
  function fmtTemp(v) { return v === null || v === undefined ? '-' : (Math.round(v * 10) / 10) + '°'; }
  function renderDetail() {
    var p = sel(), s = st();
    text('d-name', p.name); text('d-sub', modelLabel(p.model) + ' · ' + p.host + ' · ' + p.serial);
    var link = s.link || 'offline';
    text('d-link', link + (s.detail && link !== 'online' ? ' - ' + s.detail : '')); $('d-link').className = 'pill ' + link;
    text('btn-connect', link === 'online' || link === 'connecting' ? 'Disconnect' : 'Connect');
    var on = link === 'online';
    text('s-state', on && s.gcodeState ? s.gcodeState : '-'); text('s-file', on ? (s.file || '') : '');
    text('s-pct', on && s.percent !== null && s.percent !== undefined ? s.percent + '%' : '-');
    text('s-layer', on && s.totalLayers ? 'layer ' + s.layer + ' of ' + s.totalLayers + (s.remainingMin ? ' · ' + s.remainingMin + ' min left' : '') : '');
    text('s-nozzle', on && s.nozzle ? fmtTemp(s.nozzle.temp) : '-'); text('s-nozzle-t', on && s.nozzle && s.nozzle.target ? 'target ' + fmtTemp(s.nozzle.target) : '');
    text('s-bed', on && s.bed ? fmtTemp(s.bed.temp) : '-'); text('s-bed-t', on && s.bed && s.bed.target ? 'target ' + fmtTemp(s.bed.target) : '');
    var errs = [];
    if (on && s.printError) errs.push('Print error ' + s.printError);
    if (on && s.hms && s.hms.length) errs.push('HMS ' + s.hms.join(', '));
    if (on && s.sdcard === false) errs.push('No SD card in the printer: files cannot be sent.');
    $('s-errors').hidden = !errs.length; text('s-errors', errs.join('  ·  '));
    var locked = !!(S.status[p.id] ? s.locked : p.locked);
    $('lockbar').hidden = !locked;
    text('btn-lock', locked ? 'Take the service lock off...' : 'Turn the service lock on'); $('btn-lock').className = 'btn' + (locked ? ' on' : '');
    Array.prototype.forEach.call(document.querySelectorAll('[data-cmd]'), function (b) {
      var c = b.getAttribute('data-cmd');
      b.disabled = !on || (c === 'pause' && s.gcodeState !== 'RUNNING') || (c === 'resume' && (!s.paused || locked)) || (c === 'stop' && !s.jobActive) || (c === 'homeXY' && locked);
    });
    ['btn-lock', 'btn-nozzle', 'btn-nozzle-off'].forEach(function (id) { $(id).disabled = !on; });
    var canSend = on && !!S.file && s.sdcard !== false && !!p.pins.ftp;
    $('btn-upload').disabled = !canSend; $('btn-print').disabled = !canSend || !!s.jobActive || locked;
    text('file-name', S.file ? S.file.name + ' (' + (S.file.size / 1048576).toFixed(1) + ' MB)' : 'No file chosen.');
    judge();
  }
  function render() {
    renderList();
    if (S.editId) return;
    if (!sel()) { S.sel = S.printers.length ? S.printers[0].id : null; renderList(); }
    if (!sel()) return show('empty');
    show('detail'); renderDetail();
  }
  function fail(e) { text('d-err', e.message); }
  function clearErr() { text('d-err', ''); }

  function toggleConnect() {
    var p = sel(), link = st().link; clearErr();
    if (link === 'online' || link === 'connecting') {
      return window.nso.link.disconnect(p.id).then(un).then(function () { S.status[p.id] = { link: 'offline' }; render(); }).catch(fail);
    }
    if (!p.hasCode) { openForm(p); return text('form-err', 'Enter this printer\'s access code again: it was not kept between runs.'); }
    S.status[p.id] = { link: 'connecting' }; render();
    window.nso.link.connect(p.id).then(un).then(function (s) { S.status[p.id] = s; render(); })
      .catch(function (e) { S.status[p.id] = { link: e.code === 'PIN_MISMATCH' || e.code === 'AUTH' ? 'refused' : 'offline' }; render(); fail(e); });
  }
  function cmd(name, arg) {
    clearErr();
    return window.nso.link.command(S.sel, name, arg).then(un).then(function (r) {
      if (r && r.result === 'fail') fail(new Error('The printer refused "' + name + '"' + (r.reason ? ': ' + r.reason : '.')));
      return r;
    }).catch(fail);
  }
  var judgeTimer = null;
  function judge() {
    clearTimeout(judgeTimer);
    var t = $('gcode').value;
    if (!t.trim() || st().link !== 'online') { text('gcode-verdict', ''); $('btn-gcode').disabled = true; return; }
    judgeTimer = setTimeout(function () {
      window.nso.link.judge(S.sel, t).then(un).then(function (v) {
        $('btn-gcode').disabled = !v.ok; text('gcode-verdict', v.ok ? v.lines.length + ' line' + (v.lines.length > 1 ? 's' : '') + ' to send' : v.reason);
        $('gcode-verdict').className = v.ok ? 'note' : 'err';
      }).catch(function () {});
    }, 120);
  }
  function send(start) {
    var p = sel(); clearErr(); text('send-out', start ? 'Sending...' : 'Uploading...'); $('prog').hidden = false; $('prog').value = 0;
    var opts = { start: start, bedLevelling: $('o-level').checked, vibrationCali: $('o-vib').checked, flowCali: $('o-flow').checked, timelapse: $('o-lapse').checked, useAms: $('o-ams').checked };
    window.nso.link.send(p.id, S.file, opts).then(un).then(function (r) {
      $('prog').hidden = true;
      if (r === 'cancelled') return text('send-out', '');
      if (r.started && r.ack && r.ack.result === 'fail') return text('send-out', 'Uploaded as ' + r.name + ', but the printer refused to start it' + (r.ack.reason ? ': ' + r.ack.reason : '.'));
      if (r.started && !r.ack) return text('send-out', 'Uploaded as ' + r.name + ' and asked to start. The printer has not confirmed: watch its screen.');
      text('send-out', r.started ? 'Started ' + r.name + '.' : 'Uploaded as ' + r.name + '. Start it from the printer\'s screen.');
      if (r.started) { $('pending').hidden = true; }
    }).catch(function (e) { $('prog').hidden = true; text('send-out', ''); fail(e); });
  }
  function setPending(f) {
    if (!f) return;
    S.file = f; $('pending').hidden = false;
    text('pending', 'From Nest Optimizer: ' + f.name + '. Pick the printer on the left, connect, then Send and print.');
    render();
  }

  function log(id, payload) {
    if (id !== S.sel) return;
    var el = $('log'), t = new Date().toLocaleTimeString();
    el.textContent = t + '  ' + JSON.stringify(payload) + '\n' + el.textContent.split('\n').slice(0, 60).join('\n');
  }

  function reload() { return window.nso.printers.list().then(un).then(function (l) { S.printers = l; render(); }); }

  // ---------------------------------------------------------------- wiring
  $('btn-add').addEventListener('click', function () { openForm(null); });
  $('btn-cancel').addEventListener('click', function () { S.editId = null; render(); });
  $('btn-check').addEventListener('click', checkPrinter);
  $('btn-save').addEventListener('click', savePrinter);
  ['f-host', 'f-serial'].forEach(function (id) { $(id).addEventListener('input', function () { S.probe = null; $('cert').hidden = true; $('btn-save').disabled = true; }); });
  $('btn-connect').addEventListener('click', toggleConnect);
  $('btn-edit').addEventListener('click', function () { openForm(sel()); });
  $('btn-remove').addEventListener('click', function () {
    var p = sel();
    if (!window.confirm('Remove ' + p.name + '? Its access code and certificate pin are forgotten.')) return;
    window.nso.printers.remove(p.id).then(un).then(function () { delete S.status[p.id]; S.sel = null; return reload(); }).catch(fail);
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-cmd]'), function (b) { b.addEventListener('click', function () { cmd(b.getAttribute('data-cmd')); }); });
  $('btn-lock').addEventListener('click', function () { var want = !st().locked; cmd('lock', want).then(function () { return reload(); }); });
  $('btn-nozzle').addEventListener('click', function () { cmd('setNozzle', Number($('t-nozzle').value)); });
  $('btn-nozzle-off').addEventListener('click', function () { cmd('setNozzle', 0); });
  $('gcode').addEventListener('input', judge);
  $('btn-gcode').addEventListener('click', function () { cmd('gcode', $('gcode').value); });
  $('btn-pick').addEventListener('click', function () { window.nso.link.pickFile().then(un).then(function (f) { if (f) { S.file = f; text('send-out', ''); render(); } }).catch(fail); });
  $('btn-upload').addEventListener('click', function () { send(false); });
  $('btn-print').addEventListener('click', function () { send(true); });

  window.nso.on('link:status', function (id, s) { S.status[id] = s; if (!S.editId) render(); else renderList(); });
  window.nso.on('link:sent', log);
  window.nso.on('link:progress', function (id, a, b) { if (id === S.sel && b) { $('prog').max = b; $('prog').value = a; } });
  window.nso.on('link:pending', setPending);

  window.nso.info().then(un).then(function (i) {
    MODELS = i.models; S.canKeep = i.canKeep;
    var m = $('f-model'); i.models.forEach(function (x) { var o = document.createElement('option'); o.value = x.id; o.textContent = x.label; m.appendChild(o); });
    text('keep-note', i.canKeep ? 'Access codes are kept in this computer\'s keychain.' : 'No keychain in this session: access codes are kept only until the app closes.');
    return reload();
  }).then(function () { return window.nso.link.pending().then(un).then(setPending); });
})();
