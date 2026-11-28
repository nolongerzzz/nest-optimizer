'use strict';
/* preload-ui.js - the Printers window's bridge to the main process. Only the
   shell's own window (desktop/ui/printers.html) is given this preload, and the
   main process checks the sender of every call. */
const { contextBridge, ipcRenderer } = require('electron');
const call = (name) => (...args) => ipcRenderer.invoke(name, ...args);
contextBridge.exposeInMainWorld('nso', {
  info: call('app:info'),
  printers: { list: call('printers:list'), probe: call('printers:probe'), save: call('printers:save'), remove: call('printers:remove') },
  link: {
    connect: call('link:connect'), disconnect: call('link:disconnect'), status: call('link:status'),
    command: call('link:command'), judge: call('link:judge'), pickFile: call('link:pick-file'), send: call('link:send'), pending: call('link:pending')
  },
  on: (channel, fn) => {
    if (['link:status', 'link:sent', 'link:progress', 'link:pending'].indexOf(channel) < 0) return;
    ipcRenderer.on(channel, (e, ...args) => fn(...args));
  }
});
