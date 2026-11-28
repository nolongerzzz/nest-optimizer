#!/usr/bin/env node
'use strict';
/* printer-link/cli.js - the printer link from a terminal, without the app.

   The printer is named by environment variables, so nothing secret is typed
   into a command line that the shell would remember:
     NSO_PRINTER_HOST    its address
     NSO_PRINTER_SERIAL  its serial number
     NSO_PRINTER_CODE    its LAN access code
     NSO_PRINTER_MODEL   a1mini (default) | a1 | p1s | p1p
     NSO_PRINTER_PIN     the MQTT certificate fingerprint `probe` printed
     NSO_PRINTER_PIN_FTP the FTPS one (for send / list)

   node cli.js probe                  read and print the certificates to pin
   node cli.js status [--watch]       the printer's status
   node cli.js list                   files on the SD card
   node cli.js send <file> [--start]  upload a .gcode.3mf (and start it)
   node cli.js pause | resume | stop | clear-error | home-xy
   node cli.js gcode "<line>"         run G-code now (the guard applies) */
const { PrinterLink, probe, FTPS_PORT } = require('./index');
const E = process.env;
const [cmd, ...rest] = process.argv.slice(2);
const need = (k) => { if (!E[k]) { console.error('Set ' + k + '.'); process.exit(2); } return E[k]; };

(async () => {
  if (!cmd || cmd === 'help') { console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0].split('\n').slice(3).join('\n')); return; }
  const host = need('NSO_PRINTER_HOST');
  if (cmd === 'probe') {
    const m = await probe(host);
    console.log('MQTT  ' + m.fingerprint256 + '\n      name ' + m.subjectCN + ', issued by ' + m.issuerCN);
    try { const f = await probe(host, FTPS_PORT); console.log('FTPS  ' + f.fingerprint256); } catch (e) { console.log('FTPS  ' + e.message); }
    console.log('The name should be the printer\'s serial number. Put the fingerprints in NSO_PRINTER_PIN and NSO_PRINTER_PIN_FTP.');
    return;
  }
  const link = new PrinterLink({ host, serial: need('NSO_PRINTER_SERIAL'), accessCode: need('NSO_PRINTER_CODE'), model: E.NSO_PRINTER_MODEL || 'a1mini', pins: { mqtt: need('NSO_PRINTER_PIN'), ftp: E.NSO_PRINTER_PIN_FTP || '' } });
  link.on('error', () => {});
  const settle = () => new Promise((r) => setTimeout(r, 1500));
  const show = (r) => console.log(r === null ? 'Sent. The printer did not echo it.' : JSON.stringify(r));
  if (cmd === 'list') { console.table(await link.list()); return; }
  if (cmd === 'send' && rest.indexOf('--start') < 0) { console.log('Uploaded as ' + await link.upload(rest[0], null, (a, b) => process.stdout.write('\r' + Math.round(100 * a / b) + '%  ')) + '\n'); return; }
  await link.connect(); await settle();
  try {
    if (cmd === 'status') {
      console.log(JSON.stringify(link.status(), null, 2));
      if (rest.indexOf('--watch') >= 0) { link.on('status', (s) => console.log(new Date().toLocaleTimeString(), s.gcodeState, s.percent + '%', 'nozzle ' + s.nozzle.temp, 'bed ' + s.bed.temp, s.printError)); return; }
    } else if (cmd === 'send') { const r = await link.sendAndPrint(rest[0], null, {}, (a, b) => process.stdout.write('\r' + Math.round(100 * a / b) + '%  ')); console.log('\n' + r.name); show(r.ack); }
    else if (cmd === 'pause') show(await link.pause());
    else if (cmd === 'resume') show(await link.resume());
    else if (cmd === 'stop') show(await link.stop());
    else if (cmd === 'clear-error') show(await link.clearError());
    else if (cmd === 'home-xy') show(await link.homeXY());
    else if (cmd === 'gcode') show(await link.gcode(rest.join(' ')));
    else { console.error('Unknown command: ' + cmd); process.exitCode = 2; }
  } finally { if (!(cmd === 'status' && rest.indexOf('--watch') >= 0)) link.close(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
