'use strict';
/* updater.js - the desktop app updates itself from its own git branch.

   The app runs from a checkout of the repository (as the Safex apps run from
   their folder), so "an update" is the commits that have landed on the branch
   this copy follows. Merge to main, and every copy that follows main is
   offered the update.

   The same care as safexplug's updater (src/core/updater.js), carried over to
   git:
     - nothing is replaced unseen: the changes are listed first, and applying
       is a separate, confirmed step;
     - it only ever fast-forwards. A copy with local edits, or with commits of
       its own, is left alone and told why. Nothing is discarded or merged;
     - what was running before is written down, so "go back" is one step;
     - if the app's own parts (desktop/package.json) changed, npm install runs,
       and if that fails the code goes back to where it was.

   Pure Node: no Electron. test/updater-test.js drives it on throwaway repos. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const DEPS = ['desktop/package.json', 'desktop/package-lock.json'];

/** A PATH that finds git and npm when the app was started from the Dock or a menu (which pass a bare PATH). */
function withPath(env) {
  const home = os.homedir();
  const extra = ['/usr/local/bin', '/opt/homebrew/bin', '/opt/local/bin', path.join(home, '.local/bin'), path.join(home, '.volta/bin'), path.join(home, '.nvm/current/bin'), '/usr/bin', '/bin'];
  const have = String((env || process.env).PATH || '').split(path.delimiter).filter(Boolean);
  return Object.assign({}, env || process.env, { PATH: have.concat(extra.filter((p) => have.indexOf(p) < 0)).join(path.delimiter), GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' });
}

let shellPath = null;
/** The owner's own login-shell PATH (where nvm, conda and Homebrew put node), asked once. */
function loginPath() {
  if (shellPath !== null) return Promise.resolve(shellPath);
  if (process.platform === 'win32') { shellPath = ''; return Promise.resolve(''); }
  return new Promise((resolve) => {
    execFile(process.env.SHELL || '/bin/sh', ['-lc', 'printf "%s" "$PATH"'], { timeout: 5000 }, (err, out) => { shellPath = err ? '' : String(out).trim(); resolve(shellPath); });
  });
}

function run(cmd, args, opts) {
  opts = opts || {};
  return loginPath().then((lp) => new Promise((resolve, reject) => {
    const env = withPath(Object.assign({}, process.env, lp ? { PATH: lp + path.delimiter + (process.env.PATH || '') } : {}));
    execFile(cmd, args, { cwd: opts.cwd, env, timeout: opts.timeout || 60000, maxBuffer: 16 * 1024 * 1024 }, (err, out, errOut) => {
      if (err) { const e = new Error((String(errOut || '').trim() || err.message).slice(0, 400)); e.code = err.code; return reject(e); }
      resolve(String(out).trim());
    });
  }));
}
const git = (repo, args, timeout) => run('git', ['-C', repo].concat(args), { timeout });

/** Where this copy stands: { ok, branch, commit, short, date, subject, remote } or { ok: false, reason }. */
async function info(repo) {
  try {
    if (!fs.existsSync(path.join(repo, '.git'))) return { ok: false, reason: 'This copy is not a git checkout, so it cannot update itself.' };
    const branch = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch === 'HEAD') return { ok: false, reason: 'This copy is not on a branch (detached), so there is nothing for it to follow.' };
    const [commit, meta, remote] = await Promise.all([
      git(repo, ['rev-parse', 'HEAD']), git(repo, ['log', '-1', '--format=%cs%x09%s']),
      git(repo, ['config', '--get', 'remote.origin.url']).catch(() => '')]);
    const [date, subject] = meta.split('\t');
    return { ok: true, branch, commit, short: commit.slice(0, 7), date, subject, remote: remote.replace(/\/\/[^@/]+@/, '//') };
  } catch (e) { return { ok: false, reason: 'git is not available here (' + e.message + ').' }; }
}

/**
 * Ask the remote and compare. Never changes the working tree.
 * -> { ok, upToDate } | { ok, available: { commit, short, count, subjects, depsChanged } } | { ok: false, reason, blocked? }
 */
async function check(repo) {
  const me = await info(repo);
  if (!me.ok) return me;
  try { await git(repo, ['fetch', '--quiet', 'origin', '+refs/heads/' + me.branch + ':refs/remotes/origin/' + me.branch], 90000); }
  catch (e) { return { ok: false, reason: 'Could not reach the repository to look for updates (' + e.message.split('\n')[0] + ').', current: me }; }
  const target = 'origin/' + me.branch;
  const theirs = await git(repo, ['rev-parse', target]);
  if (theirs === me.commit) return { ok: true, upToDate: true, current: me };
  const [behind, ahead] = (await git(repo, ['rev-list', '--left-right', '--count', target + '...HEAD'])).split(/\s+/).map(Number);
  if (ahead > 0) return { ok: false, blocked: 'ahead', current: me, reason: 'This copy has ' + ahead + ' commit' + (ahead > 1 ? 's' : '') + ' of its own that ' + me.branch + ' on GitHub does not have, so it was left alone. Push or remove them, then check again.' };
  if (behind === 0) return { ok: true, upToDate: true, current: me };
  const dirty = await git(repo, ['status', '--porcelain', '--untracked-files=no']);
  const subjects = (await git(repo, ['log', '--format=%s', '-n', '12', 'HEAD..' + target])).split('\n').filter(Boolean);
  const changed = (await git(repo, ['diff', '--name-only', 'HEAD', target, '--'].concat(DEPS))).split('\n').filter(Boolean);
  const available = { commit: theirs, short: theirs.slice(0, 7), count: behind, subjects, depsChanged: changed.length > 0 };
  if (dirty) return { ok: false, blocked: 'dirty', current: me, available, reason: 'This copy has edited files (' + dirty.split('\n').length + '), so the update was not applied. Nothing was changed. Commit or undo those edits, then check again.' };
  return { ok: true, upToDate: false, current: me, available };
}

/**
 * Apply what check() found: fast-forward, then npm install if the app's parts changed.
 * opts: { logFile, onStep(text), npm: [cmd, ...args] (for the checks) }
 * -> { ok, from, to, depsInstalled } | { ok: false, reason }
 */
async function apply(repo, opts) {
  opts = opts || {};
  const step = opts.onStep || (() => {});
  const c = await check(repo);
  if (!c.ok) return c;
  if (c.upToDate) return { ok: true, from: c.current.commit, to: c.current.commit, nothing: true };
  const from = c.current.commit, to = c.available.commit, branch = c.current.branch;
  step('Updating ' + branch + ' to ' + c.available.short + '...');
  try { await git(repo, ['merge', '--ff-only', '--quiet', 'origin/' + branch]); }
  catch (e) { return { ok: false, reason: 'The update could not be applied cleanly, so nothing was changed (' + e.message.split('\n')[0] + ').' }; }
  let depsInstalled = false;
  if (c.available.depsChanged) {
    step('Installing the app\'s parts (this can take a minute)...');
    const npm = opts.npm || ['npm', 'install', '--no-audit', '--no-fund'];
    try { await run(npm[0], npm.slice(1), { cwd: path.join(repo, 'desktop'), timeout: 600000 }); depsInstalled = true; }
    catch (e) {
      // Put the code back where it was: new code with old parts is the one state that may not start.
      await git(repo, ['reset', '--hard', '--quiet', from]).catch(() => {});
      return { ok: false, reason: 'The update needs new parts and installing them failed, so the app was put back as it was (' + e.message.split('\n')[0] + '). Run "npm install" in the desktop folder to see why.' };
    }
  }
  if (opts.logFile) {
    try { fs.mkdirSync(path.dirname(opts.logFile), { recursive: true }); fs.writeFileSync(opts.logFile, JSON.stringify({ branch, from, to, at: new Date().toISOString() }, null, 2)); } catch (e) { /* the update itself stands */ }
  }
  return { ok: true, from, to, short: to.slice(0, 7), depsInstalled };
}

/** The last update this copy applied, if going back to before it is still possible. */
function lastUpdate(logFile) {
  try { const l = JSON.parse(fs.readFileSync(logFile, 'utf8')); return l && l.from && l.to ? l : null; } catch (e) { return null; }
}

/** Go back to what was running before the last update. Refused unless this copy is exactly at that update, unedited. */
async function rollback(repo, opts) {
  const l = lastUpdate(opts.logFile);
  if (!l) return { ok: false, reason: 'There is no earlier version on record to go back to.' };
  const me = await info(repo);
  if (!me.ok) return me;
  if (me.commit !== l.to || me.branch !== l.branch) return { ok: false, reason: 'This copy has moved on since that update, so going back was not attempted.' };
  if (await git(repo, ['status', '--porcelain', '--untracked-files=no'])) return { ok: false, reason: 'This copy has edited files, so going back was not attempted.' };
  const changed = (await git(repo, ['diff', '--name-only', l.from, l.to, '--'].concat(DEPS))).split('\n').filter(Boolean);
  await git(repo, ['reset', '--hard', '--quiet', l.from]);
  if (changed.length) {
    const npm = opts.npm || ['npm', 'install', '--no-audit', '--no-fund'];
    try { await run(npm[0], npm.slice(1), { cwd: path.join(repo, 'desktop'), timeout: 600000 }); } catch (e) { /* reported by the next start */ }
  }
  try { fs.unlinkSync(opts.logFile); } catch (e) { /* gone */ }
  return { ok: true, to: l.from, short: l.from.slice(0, 7) };
}

module.exports = { info, check, apply, rollback, lastUpdate, withPath };
