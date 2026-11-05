#!/usr/bin/env node
/* Merges the before/after profiles (tools/nso_big_mesh_profile.js) into the one
   table the PR carries: tools/big-mesh-out/REPORT.md.
     node tools/nso_big_mesh_report.js [dir]
   JS ms is the app's own time (stretches with JS on the stack); "longest" is the
   longest single stretch; "long tasks" is the browser's own count and maximum, which in this
   headless browser includes software-GL frames (see nso_big_mesh_lib.js). The Lift rows
   come from the --lift-only runs, which select the piece first so Lift has something to read. */
const fs = require('fs');
const path = require('path');
const dir = path.resolve(process.argv[2] || path.join(__dirname, 'big-mesh-out'));
const load = f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { return null; } };
const B = load('profile-before.json'), A = load('profile-after.json');
const BL = load('profile-before-lift.json'), AL = load('profile-after-lift.json');
if (!B || !A) { console.error('need profile-before.json and profile-after.json in ' + dir); process.exit(1); }

const byName = (P) => { const m = new Map(); P.results.forEach(r => m.set(r.name, r)); return m; };
const b = byName(B), a = byName(A);
const rows = [];
const cell = r => r ? { js: r.jsMs, max: r.maxJsMs, lt: Math.max(0, ...r.longTasks), wall: r.wallMs, ans: r.value && r.value.answerMs } : null;
const f0 = x => x == null ? '-' : x >= 1000 ? (x / 1000).toFixed(1) + ' s' : Math.round(x) + ' ms';
const names = B.results.map(r => r.name).filter(n => !/^arm Lift|^Lift armed/.test(n));
names.forEach(n => rows.push([n, cell(b.get(n)), cell(a.get(n))]));
if (BL && AL) {
  const bl = byName(BL), al = byName(AL);
  ['arm Lift (piece selected)', 'Lift armed: 20 hovers'].forEach(n => rows.push([n, cell(bl.get(n)), cell(al.get(n))]));
}
const out = [];
out.push('### ' + B.file + ' - ' + B.tris.toLocaleString() + ' triangles: main-thread JS, before and after', '');
out.push('| gesture | JS before | longest before | JS after | longest after |', '|---|--:|--:|--:|--:|');
rows.forEach(([n, x, y]) => out.push(`| ${n} | ${f0(x && x.js)} | ${f0(x && x.max)} | ${f0(y && y.js)} | ${f0(y && y.max)} |`));
out.push('', 'Read in the background after the change (opening to the answer, page free meanwhile; before, the same reads ran on the page\'s thread - the Subtract card\'s during selection): ' +
  ['open card: supports', 'open card: bit'].map(n => { const y = a.get(n); return `${n.replace('open card: ', '').replace('bit', 'subtract/split')} ${f0(y && y.value && y.value.answerMs)}`; }).join(', ') + '.');
fs.writeFileSync(path.join(dir, 'REPORT.md'), out.join('\n') + '\n');
console.log(out.join('\n'));
