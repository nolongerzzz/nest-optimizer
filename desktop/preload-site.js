'use strict';
/* preload-site.js - what the NSO page itself may ask the desktop shell for.
   Deliberately small: the page cannot reach printers, credentials or files
   through this. It can tell that it is running in the desktop app, ask for
   the Printers window, and ask for an update check.

   It also adds one small strip to the window (bottom, beside the HUD):
   Printers, and Update when one is ready. The site's own files are not
   changed for it, so the web version shows no such strip. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nsoDesktop', {
  desktop: true,
  openPrinters: () => ipcRenderer.send('site:open-printers'),
  checkForUpdates: () => ipcRenderer.send('site:check-updates')
});

function strip() {
  if (document.getElementById('nso-desktop-strip')) return;
  const css = document.createElement('style');
  css.textContent =
    '#nso-desktop-strip{position:fixed;right:118px;bottom:10px;z-index:2147483000;display:flex;gap:6px;font:600 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;letter-spacing:.08em;text-transform:uppercase}' +
    '#nso-desktop-strip button{font:inherit;letter-spacing:inherit;text-transform:inherit;color:#cfd8ea;background:rgba(20,25,38,.92);border:1px solid #2a3246;border-radius:8px;padding:8px 11px;cursor:pointer}' +
    '#nso-desktop-strip button:hover{border-color:#4aa8ff;color:#fff}' +
    '#nso-desktop-strip button.ready{background:#4aa8ff;border-color:#4aa8ff;color:#06121f}' +
    '#nso-desktop-strip button[hidden]{display:none}';
  const box = document.createElement('div'); box.id = 'nso-desktop-strip';
  const printers = document.createElement('button'); printers.type = 'button'; printers.textContent = 'Printers'; printers.title = 'Add a printer, see its status, send it a sliced file';
  printers.addEventListener('click', () => ipcRenderer.send('site:open-printers'));
  const update = document.createElement('button'); update.type = 'button'; update.id = 'nso-desktop-update'; update.hidden = true; update.className = 'ready';
  update.addEventListener('click', () => ipcRenderer.send('site:check-updates'));
  box.appendChild(update); box.appendChild(printers);
  document.head.appendChild(css); document.body.appendChild(box);
}
function showUpdate(state) {
  const b = document.getElementById('nso-desktop-update');
  if (!b) return;
  b.hidden = !state.available && !state.busy;
  b.disabled = !!state.busy;
  b.textContent = state.busy ? 'Updating...' : state.available ? 'Update ready (' + state.available.count + ')' : '';
}
let last = { available: null, busy: false };
ipcRenderer.on('site:update-state', (e, state) => { last = state; showUpdate(state); });
window.addEventListener('DOMContentLoaded', () => { strip(); showUpdate(last); });
