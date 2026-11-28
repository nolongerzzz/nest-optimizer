'use strict';
/* test/updater-test.js - the updater on throwaway repositories. Run: npm test (in desktop/). */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const up = require('../updater');

let pass = 0, fail = 0;
function ok(c, name, detail) { if (c) pass++; else { fail++; console.log('  FAIL ' + name + (detail ? ' - ' + detail : '')); } }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-upd-'));
const G = (dir, ...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
function write(dir, rel, text) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
function commit(dir, rel, text, msg) { write(dir, rel, text); G(dir, 'add', '-A'); G(dir, 'commit', '-q', '-m', msg); return G(dir, 'rev-parse', 'HEAD'); }

(async () => {
  const remote = path.join(tmp, 'remote.git'), dev = path.join(tmp, 'dev'), app = path.join(tmp, 'app'), log = path.join(tmp, 'data', 'last-update.json');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, dev], { stdio: 'ignore' });
  G(dev, 'checkout', '-q', '-b', 'main');
  commit(dev, 'index.html', 'v1', 'first'); write(dev, 'desktop/package.json', '{"name":"x","version":"1.0.0"}'); G(dev, 'add', '-A'); G(dev, 'commit', '-q', '-m', 'desktop'); G(dev, 'push', '-q', 'origin', 'main');
  execFileSync('git', ['clone', '-q', '--branch', 'main', remote, app], { stdio: 'ignore' });
  const npmOk = [process.execPath, '-e', 'require("fs").writeFileSync("npm-ran","1")'], npmBad = [process.execPath, '-e', 'process.exit(3)'];

  let i = await up.info(app);
  ok(i.ok && i.branch === 'main' && i.short.length === 7 && i.subject === 'desktop', 'info', JSON.stringify(i));
  ok((await up.info(tmp)).ok === false, 'not a checkout: says so');
  let c = await up.check(app);
  ok(c.ok && c.upToDate === true, 'up to date');

  const c2 = commit(dev, 'index.html', 'v2', 'Print card: a Send button'); commit(dev, 'app.js', 'x', 'Fix the nozzle target'); const c3 = G(dev, 'rev-parse', 'HEAD'); G(dev, 'push', '-q', 'origin', 'main');
  c = await up.check(app);
  ok(c.ok && c.upToDate === false && c.available.count === 2 && c.available.commit === c3, 'two commits behind', JSON.stringify(c.available));
  ok(c.available.subjects[0] === 'Fix the nozzle target' && c.available.subjects[1] === 'Print card: a Send button', 'the changes are listed, newest first');
  ok(c.available.depsChanged === false, 'no new parts needed');
  ok(fs.readFileSync(path.join(app, 'index.html'), 'utf8') === 'v1', 'check changed nothing');

  // Local edits: left alone.
  fs.writeFileSync(path.join(app, 'index.html'), 'mine');
  c = await up.check(app);
  ok(!c.ok && c.blocked === 'dirty' && /Nothing was changed/.test(c.reason), 'edited files block the update', c.reason);
  let a = await up.apply(app, { logFile: log });
  ok(!a.ok && fs.readFileSync(path.join(app, 'index.html'), 'utf8') === 'mine', 'apply refuses too, and the edit is still there');
  G(app, 'checkout', '--', 'index.html');
  fs.writeFileSync(path.join(app, 'notes.txt'), 'untracked'); // an untracked file is not an edit
  ok((await up.check(app)).ok, 'an untracked file does not block');

  const steps = [];
  a = await up.apply(app, { logFile: log, onStep: (s) => steps.push(s), npm: npmOk });
  ok(a.ok && a.to === c3 && a.depsInstalled === false && G(app, 'rev-parse', 'HEAD') === c3, 'apply fast-forwards', JSON.stringify(a));
  ok(fs.readFileSync(path.join(app, 'index.html'), 'utf8') === 'v2' && !fs.existsSync(path.join(app, 'desktop', 'npm-ran')), 'files updated, npm not run');
  ok(up.lastUpdate(log).to === c3 && steps.length === 1, 'what was running before is written down');
  ok((await up.apply(app, { logFile: log })).nothing === true, 'applying again does nothing');

  // Go back.
  let r = await up.rollback(app, { logFile: log, npm: npmOk });
  ok(r.ok && G(app, 'rev-parse', 'HEAD') !== c3 && fs.readFileSync(path.join(app, 'index.html'), 'utf8') === 'v1', 'go back', JSON.stringify(r));
  ok((await up.rollback(app, { logFile: log })).ok === false, 'only once');
  ok((await up.check(app)).available.count === 2, 'and the update is offered again');
  await up.apply(app, { logFile: log, npm: npmOk });

  // New parts: npm runs; if it fails the code goes back.
  write(dev, 'desktop/package.json', '{"name":"x","version":"1.1.0"}'); G(dev, 'add', '-A'); G(dev, 'commit', '-q', '-m', 'Desktop 1.1.0: a new part'); G(dev, 'push', '-q', 'origin', 'main');
  c = await up.check(app);
  ok(c.available.depsChanged === true, 'a changed desktop/package.json is noticed');
  const before = G(app, 'rev-parse', 'HEAD');
  a = await up.apply(app, { logFile: log, npm: npmBad });
  ok(!a.ok && G(app, 'rev-parse', 'HEAD') === before && /put back as it was/.test(a.reason), 'npm fails: the code is put back', a.reason);
  ok(JSON.parse(fs.readFileSync(path.join(app, 'desktop/package.json'), 'utf8')).version === '1.0.0', 'the old package.json is back');
  a = await up.apply(app, { logFile: log, npm: npmOk });
  ok(a.ok && a.depsInstalled && fs.existsSync(path.join(app, 'desktop', 'npm-ran')), 'npm ran in desktop/');

  // Commits of its own: left alone.
  commit(app, 'local.txt', 'x', 'local work'); commit(dev, 'index.html', 'v3', 'third'); G(dev, 'push', '-q', 'origin', 'main');
  c = await up.check(app);
  ok(!c.ok && c.blocked === 'ahead', 'a copy with its own commits is left alone', c.reason);
  ok((await up.apply(app, { logFile: log })).ok === false && fs.existsSync(path.join(app, 'local.txt')), 'apply refuses, the commit stays');

  // Unreachable remote, detached head.
  G(app, 'remote', 'set-url', 'origin', path.join(tmp, 'gone.git'));
  c = await up.check(app);
  ok(!c.ok && /Could not reach/.test(c.reason), 'an unreachable repository says so');
  G(app, 'checkout', '-q', '--detach');
  ok((await up.info(app)).ok === false, 'detached: nothing to follow');
  ok(/\/usr\/local\/bin/.test(up.withPath({ PATH: '/usr/bin' }).PATH) && up.withPath({}).GIT_TERMINAL_PROMPT === '0', 'git and npm are looked for where Homebrew puts them; git never waits for a password');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('updater-test: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
