'use strict';
/* main.js - Nest Optimizer's desktop shell (Electron main process).

   It does three things the browser version cannot:
     1. shows the same static site in its own window (served from loopback),
     2. keeps the owner's printers and their access codes (store.js),
     3. talks to those printers (printer-link/), behind the Printers window.

   The site's own files are not changed by any of this: the web version stays
   the web version. docs/DESKTOP.md is the write-up. */
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, safeStorage, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const staticServer = require('./static-server');
const { Store } = require('./store');
const { PrinterLink, probe, MODELS, MQTT_PORT, FTPS_PORT } = require('./printer-link');
const updater = require('./updater');

const SITE_ROOT = app.isPackaged ? path.join(process.resourcesPath, 'app-site') : path.resolve(__dirname, '..');
const UI_FILE = path.join(__dirname, 'ui', 'printers.html');
const REPO = path.resolve(__dirname, '..');           // the checkout this copy runs from, and updates
const ICON = path.join(__dirname, 'assets', 'icon.png');
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

let siteUrl = '';
let mainWin = null;
let uiWin = null;
let store = null;
const links = new Map();      // printer id -> PrinterLink
let pendingSend = null;       // a .gcode.3mf the site just exported, waiting for the Printers window
const upd = { current: null, available: null, busy: false, askedFor: '' };

// The smoke check runs against a throwaway profile, never the owner's.
if (process.env.NSO_DESKTOP_SMOKE) app.setPath('userData', process.env.NSO_DESKTOP_SMOKE);

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => { if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); } });

function toUi(channel, ...args) { if (uiWin && !uiWin.isDestroyed()) uiWin.webContents.send(channel, ...args); }

function createMain() {
  mainWin = new BrowserWindow({
    width: 1560, height: 980, minWidth: 1000, minHeight: 640, backgroundColor: '#0c0f16', title: 'Nest Optimizer', icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload-site.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  mainWin.on('page-title-updated', (e) => { e.preventDefault(); mainWin.setTitle(titleText()); });
  mainWin.loadURL(siteUrl + '/index.html');
  mainWin.webContents.on('did-finish-load', () => { mainWin.setTitle(titleText()); pushUpdateState(); });
  // The window shows the site and nothing else: no navigating away, no new windows.
  mainWin.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(siteUrl + '/')) e.preventDefault(); });
  mainWin.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  mainWin.on('closed', () => { mainWin = null; });
}

function openPrinters() {
  if (uiWin && !uiWin.isDestroyed()) { uiWin.show(); uiWin.focus(); return uiWin; }
  uiWin = new BrowserWindow({
    width: 980, height: 760, minWidth: 760, minHeight: 520, backgroundColor: '#0c0f16', title: 'Printers',
    webPreferences: { preload: path.join(__dirname, 'preload-ui.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  uiWin.setMenuBarVisibility(false);
  uiWin.loadFile(UI_FILE);
  uiWin.webContents.on('will-navigate', (e) => e.preventDefault());
  uiWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  uiWin.on('closed', () => { uiWin = null; });
  return uiWin;
}

/** Only the Printers window may call the handlers below. */
function fromUi(e) { return !!uiWin && !uiWin.isDestroyed() && e.sender === uiWin.webContents; }
function handle(name, fn) {
  ipcMain.handle(name, async (e, ...args) => {
    if (!fromUi(e)) return { ok: false, error: 'Not allowed from this window.' };
    try { return { ok: true, value: await fn(...args) }; } catch (err) { return { ok: false, error: (err && err.message) || String(err), code: err && err.code }; }
  });
}

function linkFor(id) {
  if (links.has(id)) return links.get(id);
  const p = store.get(id);
  if (!p) throw new Error('That printer is not in the list.');
  const code = store.code(id);
  if (!code) throw Object.assign(new Error('Enter this printer\'s access code again: it could not be read from the keychain.'), { code: 'NO_CODE' });
  const link = new PrinterLink({ host: p.host, serial: p.serial, accessCode: code, model: p.model, pins: p.pins, locked: p.locked });
  link.on('status', (s) => toUi('link:status', id, s));
  link.on('state', (s, detail) => toUi('link:status', id, Object.assign(link.status(), { detail })));
  link.on('sent', (m) => toUi('link:sent', id, m.payload));
  link.on('error', () => {});
  links.set(id, link);
  return link;
}
function dropLink(id) { const l = links.get(id); if (l) { l.close(); l.removeAllListeners(); links.delete(id); } }

// ---------------------------------------------------------------- updates
function logFile() { return path.join(app.getPath('userData'), 'last-update.json'); }
function titleText() { return 'Nest Optimizer' + (upd.current ? '  -  ' + upd.current.branch + ' @ ' + upd.current.short + ' (' + upd.current.date + ')' : ''); }
function pushUpdateState() {
  if (!mainWin || mainWin.isDestroyed()) return;
  mainWin.webContents.send('site:update-state', { available: upd.available ? { short: upd.available.short, count: upd.available.count } : null, busy: upd.busy });
}

/** Look for an update. manual: the owner asked, so say what was found either way. */
async function checkForUpdates(manual) {
  if (upd.busy || app.isPackaged) return;
  const r = await updater.check(REPO);
  if (r.current) { upd.current = r.current; if (mainWin) mainWin.setTitle(titleText()); }
  upd.available = r.ok && !r.upToDate ? r.available : null;
  pushUpdateState();
  if (!r.ok) { if (manual || r.blocked) dialog.showMessageBox(mainWin, { type: 'warning', message: 'Not updated', detail: r.reason }); return; }
  if (r.upToDate) { if (manual) dialog.showMessageBox(mainWin, { type: 'info', message: 'This copy is up to date.', detail: r.current.branch + ' @ ' + r.current.short + ', ' + r.current.date + '\n' + r.current.subject }); return; }
  if (!manual && upd.askedFor === r.available.commit) return;      // already said "later" to this one
  upd.askedFor = r.available.commit;
  const a = r.available;
  const more = a.count > a.subjects.length ? '\n... and ' + (a.count - a.subjects.length) + ' more' : '';
  const go = dialog.showMessageBoxSync(mainWin, {
    type: 'question', buttons: ['Update and restart', 'Later'], defaultId: 0, cancelId: 1,
    message: 'An update is ready: ' + a.count + ' change' + (a.count > 1 ? 's' : '') + ' on ' + r.current.branch,
    detail: a.subjects.map((x) => '- ' + x).join('\n') + more + (a.depsChanged ? '\n\nThis one also installs new parts, which can take a minute.' : '') + '\n\nA print already running on the printer carries on; this app only watches it.'
  });
  if (go === 0) applyUpdate();
}

async function applyUpdate() {
  if (upd.busy) return;
  upd.busy = true; pushUpdateState();
  const r = await updater.apply(REPO, { logFile: logFile() });
  upd.busy = false;
  if (!r.ok) { pushUpdateState(); dialog.showMessageBox(mainWin, { type: 'warning', message: 'Not updated', detail: r.reason }); return; }
  if (r.nothing) { upd.available = null; pushUpdateState(); return; }
  app.relaunch(); app.exit(0);
}

async function goBack() {
  const l = updater.lastUpdate(logFile());
  if (!l) { dialog.showMessageBox(mainWin, { type: 'info', message: 'There is no earlier version on record to go back to.' }); return; }
  const go = dialog.showMessageBoxSync(mainWin, { type: 'question', buttons: ['Go back and restart', 'Cancel'], defaultId: 1, cancelId: 1, message: 'Go back to the version before the last update?', detail: 'From ' + l.to.slice(0, 7) + ' back to ' + l.from.slice(0, 7) + '. The update will be offered again next time.' });
  if (go !== 0) return;
  const r = await updater.rollback(REPO, { logFile: logFile() });
  if (!r.ok) { dialog.showMessageBox(mainWin, { type: 'warning', message: 'Not changed', detail: r.reason }); return; }
  upd.askedFor = l.to;
  app.relaunch(); app.exit(0);
}

function wireIpc() {
  ipcMain.on('site:open-printers', (e) => { if (mainWin && e.sender === mainWin.webContents) openPrinters(); });
  ipcMain.on('site:check-updates', (e) => { if (mainWin && e.sender === mainWin.webContents) checkForUpdates(true); });

  handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, canKeep: store.canKeep(), models: Object.keys(MODELS).map((k) => ({ id: k, label: MODELS[k].label })) }));
  handle('printers:list', () => store.list());
  handle('printers:probe', async (host) => {
    host = String(host || '').trim();
    if (!/^[A-Za-z0-9.\-:]+$/.test(host)) throw new Error('That does not look like an address. Use the IP the printer shows, for example 192.168.1.50.');
    const mqtt = await probe(host, MQTT_PORT);
    let ftp = null, ftpError = '';
    try { ftp = await probe(host, FTPS_PORT); } catch (err) { ftpError = err.message; }
    return { mqtt, ftp, ftpError };
  });
  handle('printers:save', (rec) => { const saved = store.save(rec); dropLink(saved.id); return saved; });
  handle('printers:remove', (id) => { dropLink(id); store.remove(id); return true; });

  handle('link:connect', async (id) => { const l = linkFor(id); if (l.state !== 'online') await l.connect(); return l.status(); });
  handle('link:disconnect', (id) => { dropLink(id); return true; });
  handle('link:status', (id) => (links.has(id) ? links.get(id).status() : { link: 'offline' }));
  handle('link:judge', (id, text) => linkFor(id).judgeGcode(text));
  handle('link:command', async (id, name, arg) => {
    const l = linkFor(id);
    const ask = (message, detail, yes) => dialog.showMessageBoxSync(uiWin, { type: 'warning', buttons: [yes, 'Cancel'], defaultId: 1, cancelId: 1, message, detail }) === 0;
    switch (name) {
      case 'pause': return l.pause();
      case 'resume': return l.resume();
      case 'stop': if (!ask('Stop this print?', 'A stopped print cannot be resumed.', 'Stop the print')) return 'cancelled'; return l.stop();
      case 'clearError': return l.clearError();
      case 'refresh': return l.pushAll();
      case 'homeXY': return l.homeXY();
      case 'setNozzle': return l.setNozzle(Number(arg));
      case 'setBed': return l.setBed(Number(arg));
      case 'gcode': return l.gcode(String(arg));
      case 'lock':
        if (!arg && !ask('Are the locks off the printer?', 'X lock removed, Z lock removed, and nothing else on the rails or the bed. With the lock off here, the app will let the head move again.', 'They are off')) return 'cancelled';
        l.setLock(!!arg); store.setLock(id, !!arg); return l.status();
      default: throw new Error('Unknown command: ' + name);
    }
  });
  handle('link:pick-file', async () => {
    const r = await dialog.showOpenDialog(uiWin, { title: 'A sliced file to send', properties: ['openFile'], filters: [{ name: 'Sliced 3MF', extensions: ['3mf'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    return { path: r.filePaths[0], name: path.basename(r.filePaths[0]), size: fs.statSync(r.filePaths[0]).size };
  });
  handle('link:pending', () => pendingSend);
  handle('link:send', async (id, file, opts) => {
    const l = linkFor(id);
    const p = store.get(id);
    if (!file || !file.path || !/\.gcode\.3mf$/i.test(file.path)) throw new Error('Pick a sliced file (.gcode.3mf): a plain project is not printable.');
    if (!fs.existsSync(file.path)) throw new Error('That file is no longer there.');
    const start = !!(opts && opts.start);
    if (start) {
      const go = dialog.showMessageBoxSync(uiWin, {
        type: 'question', buttons: ['Send and start printing', 'Cancel'], defaultId: 1, cancelId: 1,
        message: 'Start "' + path.basename(file.path) + '" on ' + p.name + '?',
        detail: 'The printer will heat and move as soon as the file arrives. Check that the bed is clear and that the file was sliced for this printer, nozzle and filament.'
      });
      if (go !== 0) return 'cancelled';
    }
    const onProgress = (a, b) => toUi('link:progress', id, a, b);
    if (!start) return { name: await l.upload(file.path, file.name, onProgress), started: false };
    const r = await l.sendAndPrint(file.path, file.name, opts, onProgress);
    if (pendingSend && pendingSend.path === file.path) pendingSend = null;
    return { name: r.name, started: true, ack: r.ack };
  });
}

/** When the site exports a .gcode.3mf, offer the printer as well as the disk. */
function wireDownloads() {
  session.defaultSession.on('will-download', (e, item) => {
    const name = item.getFilename();
    if (!/\.gcode\.3mf$/i.test(name) || !store.list().length) return;   // the usual save dialog
    const choice = dialog.showMessageBoxSync(mainWin, {
      type: 'question', buttons: ['Send to a printer...', 'Save to disk...', 'Cancel'], defaultId: 0, cancelId: 2,
      message: name, detail: 'This is a sliced file. Send it to a printer from here, or save it as before.'
    });
    if (choice === 2) return item.cancel();
    if (choice === 1) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-send-'));
    const dest = path.join(dir, name);
    item.setSavePath(dest);
    item.once('done', (ev, state) => {
      if (state !== 'completed') return;
      pendingSend = { path: dest, name, size: fs.statSync(dest).size };
      openPrinters();
      toUi('link:pending', pendingSend);
    });
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' },
    { label: 'Printer', submenu: [{ label: 'Printers...', accelerator: 'CmdOrCtrl+Shift+P', click: () => openPrinters() }] },
    { label: 'Update', submenu: [
      { label: 'Check for Updates...', click: () => checkForUpdates(true) },
      { label: 'Go Back to the Previous Version...', click: () => goBack() }
    ] },
    { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  store = new Store(app.getPath('userData'), safeStorage);
  const srv = await staticServer.start(SITE_ROOT);
  siteUrl = srv.url;
  wireIpc();
  wireDownloads();
  buildMenu();
  if (process.platform === 'darwin' && app.dock && fs.existsSync(ICON)) app.dock.setIcon(ICON);
  createMain();
  if (!app.isPackaged && !process.env.NSO_DESKTOP_SMOKE) {
    updater.info(REPO).then((i) => { if (i.ok) { upd.current = i; if (mainWin) mainWin.setTitle(titleText()); } });
    setTimeout(() => checkForUpdates(false), 8000);
    setInterval(() => checkForUpdates(false), CHECK_EVERY_MS);
  }
  if (process.env.NSO_DESKTOP_SMOKE) require('./test/smoke-hook')({ app, mainWin, openPrinters, siteUrl, store });
  app.on('activate', () => { if (!mainWin) createMain(); });
});

app.on('window-all-closed', () => { links.forEach((l) => l.close()); if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { links.forEach((l) => l.close()); });
