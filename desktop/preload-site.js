'use strict';
/* preload-site.js - what the NSO page itself may ask the desktop shell for.
   Deliberately small: the page cannot reach printers, credentials or files
   through this. It can only tell that it is running in the desktop app and
   ask for the Printers window to be shown. */
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('nsoDesktop', {
  desktop: true,
  openPrinters: () => ipcRenderer.send('site:open-printers')
});
