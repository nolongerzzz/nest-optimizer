/**
 * nest-optimizer / tools / test-cache / cache.mjs
 *
 * Fingerprints, keys and the on-disk store behind tools/run-tests-cached.mjs.
 *
 * THE RULE
 * A suite may be skipped only when EVERY path its last green run touched is,
 * right now, exactly what it was then: same bytes for a file, still absent
 * for a lookup that missed, same entry names for a directory it listed. Plus
 * the same command, the same environment (see envSalt) and the same cache
 * version. Anything else, including "could not tell", is a rerun.
 *
 * The dependency set is not declared anywhere and not inferred from imports.
 * It is whatever tools/test-cache/trace.mjs saw the suite's processes open,
 * stat and list on its last green run - see the header there for why that is
 * the only graph this project can trust.
 *
 * WHAT IS HASHED HOW
 *   content   sha256 of the bytes. Everything under the repo (node_modules
 *             included), under the repo's parent directory (the optional
 *             ../nest-library sibling checkout), and under the temp dir.
 *   stat      size + mtime + ctime + inode. Toolchain files outside those
 *             roots - /usr, /opt/node22, /opt/pw-browsers, python's stdlib.
 *             ctime cannot be preserved by a package manager or `touch`, so
 *             an upgrade always shows up; a false MISS here only costs a rerun.
 *   ignored   /proc, /sys, /dev (pseudo files that differ every run); this
 *             cache's own directory; python bytecode (__pycache__/*.pyc is a
 *             pure function of the .py next to it, which is itself hashed);
 *             and anything the step itself created before reading it,
 *             including everything under a directory it created (mkdtemp).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

/* Bump when the keying or tracing changes meaning: every old record becomes
   unmatchable, which is the safe direction. */
export const CACHE_VERSION = 1;
const KEEP_RECORDS = 6;
const TMP_ROOT = resolve(tmpdir()); // per suite: enough to hop between a few branches

const sha = (s) => createHash('sha256').update(s).digest('hex');

export function cacheDir(root) {
  let common = '.git';
  try { common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root }).toString().trim(); } catch {}
  return resolve(root, common, 'nso-test-cache');
}

export function gitState(root) {
  const run = (a) => { try { return execFileSync('git', a, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };
  const commit = run(['rev-parse', 'HEAD']) || 'unknown';
  const dirty = run(['status', '--porcelain', '--untracked-files=normal']) !== '';
  return { commit, dirty };
}

/* STEPS THAT CANNOT BE WATCHED
   A step that goes red under the tracer's slowdown can never produce a
   trustworthy green record, and running it traced would show red where an
   untraced run is green. These run plainly (untraced), every time, and are
   never recorded - the same as `npm test` for them. Add a step here only with
   the evidence.

   gcode:solid-drive  LOAD-SENSITIVE, not ptrace-specific (first written up
     here as the latter, which was wrong). The "Export as solid" click at
     gscope-solid-drive-check.mjs:364 times out at 30s - Playwright reports the
     button visible, enabled and stable, then the click never completes. It
     does that under strace every time here (with or without sendto tracing),
     AND in plain, untraced CI: shard 5 of claude-wip runs 36133545206
     (495e6d9) and 36190459022 (5b7dad1), 2026-09-25. Untraced on the quiet
     4-core sandbox it passes (104s, 37/37; twice more inside full npm test
     runs). So the tracer is one way to be slow enough, not the cause. */
export const UNTRACEABLE = {
  'gcode:solid-drive': 'load-sensitive: its Export-as-solid click times out when the box is slow - under strace always, in CI too',
};

/* ENVIRONMENT
   A step's environment is an input the trace cannot see. Hashing ALL of it
   would make every record die with the shell session (tokens, trace ids,
   timestamps rotate), so the salt is: every variable the repo's own code
   names (scanned fresh on each run, so a new process.env.FOO is picked up
   without editing this file), plus the prefixes the toolchain itself reads.
   A variable outside both that still changes a result is the one gap here;
   docs/TEST-CACHE.md lists it. */
const ENV_PREFIXES = ['NSO_', 'PW_', 'PLAYWRIGHT', 'NODE_', 'NPM_CONFIG_', 'PYTHON', 'CHROME', 'THREE_', 'APP_',
  'LANG', 'LC_', 'TZ', 'PATH', 'HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'LD_', 'UV_', 'MESA', 'LIBGL', 'GALLIUM', 'DISPLAY', 'BENCH_', 'CI'];

function referencedEnvNames(root) {
  const names = new Set();
  const scan = (dir, depth) => {
    let ents = [];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'vendor') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (depth < 4) scan(p, depth + 1); continue; }
      if (!/\.(m?js|py|sh)$/.test(e.name)) continue;
      let s;
      try { s = readFileSync(p, 'utf8'); } catch { continue; }
      for (const m of s.matchAll(/process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\])/g)) names.add(m[1] || m[2]);
      for (const m of s.matchAll(/os\.environ(?:\.get)?[([]\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)) names.add(m[1]);
      for (const m of s.matchAll(/os\.getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)) names.add(m[1]);
    }
  };
  scan(root, 0);
  return names;
}

export function envSalt(root, env = process.env) {
  const named = referencedEnvNames(root);
  const out = {};
  for (const k of Object.keys(env).sort()) {
    /* Hashed: the record lives on disk, and a proxy URL can carry a
       password. Equality is all the key needs. */
    if (named.has(k) || ENV_PREFIXES.some((p) => k.startsWith(p))) out[k] = sha(String(env[k])).slice(0, 16);
  }
  return out;
}

/* PATH CLASSES */
export function makeClassifier(root, cache) {
  const parent = dirname(root);
  const tmp = resolve(tmpdir());
  const under = (p, d) => p === d || p.startsWith(d.endsWith(sep) ? d : d + sep);
  return (p) => {
    if (under(p, '/proc') || under(p, '/sys') || under(p, '/dev')) return 'ignored';
    if (under(p, cache)) return 'ignored';
    if (/\/__pycache__\/[^/]+\.pyc$/.test(p)) return 'ignored';
    if (under(p, root) || under(p, parent) || under(p, tmp)) return 'content';
    return 'stat';
  };
}

/* FINGERPRINTS
   Hashes are memoised on (dev, ino, size, mtime, ctime). Any write to a file
   moves its ctime, and nothing in userland can set ctime back, so a memo hit
   is the same bytes. The memo persists between runs, which is what makes the
   check itself cheap: a warm check of ~140 suites is stats, not reads. */
export class Fingerprinter {
  constructor(memoFile) {
    this.memoFile = memoFile;
    this.memo = {};
    this.dirty = false;
    try { this.memo = JSON.parse(readFileSync(memoFile, 'utf8')); } catch {}
  }

  stat(p) {
    try { return statSync(p, { bigint: true }); } catch { return null; }
  }

  hashFile(p, st) {
    const tag = `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
    const m = this.memo[p];
    if (m && m[0] === tag) return m[1];
    const h = sha(readFileSync(p));
    /* Re-stat after reading: a file that changed while being hashed gets no
       memo entry, and its (possibly torn) hash can only cause a miss. */
    const st2 = this.stat(p);
    if (st2 && `${st2.dev}:${st2.ino}:${st2.size}:${st2.mtimeNs}:${st2.ctimeNs}` === tag) {
      this.memo[p] = [tag, h];
      this.dirty = true;
    }
    return h;
  }

  /* One path's current state as a string. `listed` adds the directory's
     entry names, for a directory the step read the listing of. */
  fp(p, cls, listed) {
    const st = this.stat(p);
    if (!st) return 'absent';
    if (st.isDirectory()) {
      if (!listed) return 'dir';
      let names = [];
      try { names = readdirSync(p).sort(); } catch { return 'dir:unreadable'; }
      return 'dir:' + sha(names.join('\n'));
    }
    if (!st.isFile()) return 'special';
    if (cls === 'stat') return `stat:${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.ino}`;
    try { return 'sha256:' + this.hashFile(p, st); } catch { return 'unreadable'; }
  }

  save() {
    if (!this.dirty) return;
    /* Drop entries for files that are gone so the memo does not only grow. */
    for (const p of Object.keys(this.memo)) if (!existsSync(p)) delete this.memo[p];
    const tmp = this.memoFile + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.memo));
    renameSync(tmp, this.memoFile);
    this.dirty = false;
  }
}

/* MANIFEST
   From one green, traced run to the list of (path, fingerprint) pairs the
   next run must match. Returns problems instead of a manifest when the run
   cannot be trusted as a record - the step then simply is not cached. */
export function buildManifest(access, { classify, fper, startedNs, root }) {
  const problems = [];
  if (!access) return { problems: ['no trace was captured'] };
  if (access.remote.length) problems.push(`talked to the network (${access.remote[0]}) - its answer is not a file this cache can hash`);
  if (access.uring && access.uring.length) problems.push(`set up io_uring (pid ${access.uring[0]}) - reads through it are invisible to the trace`);
  if (access.unresolved.length) problems.push(`${access.unresolved.length} path(s) could not be resolved to absolute paths, e.g. ${access.unresolved[0]}`);

  /* The step's own products: written before ever being read, and anything
     below a directory it created. Not inputs. */
  const own = [...access.createdFirst];
  const ownDirs = own.map((p) => p + sep);
  const isOwn = (p) => access.createdFirst.has(p) || ownDirs.some((d) => p.startsWith(d));

  const manifest = {};
  const SLACK_NS = 20_000_000n; // 20 ms either side of the start line
  for (const [p, seen] of access.reads) {
    const cls = classify(p);
    if (cls === 'ignored' || isOwn(p)) continue;
    /* The temp dir's own listing changes with every process on the box.
       Chromium lists it while tearing a profile down; no test reads its
       inputs by listing it (audit.mjs checks that statically). So its
       existence is recorded, its listing is not. */
    const listed = access.listed.has(p) && p !== TMP_ROOT;
    /* Toolchain state the toolchain itself maintains: fontconfig's cache,
       Chromium's NSS db and crash-report settings, Playwright's
       DEPENDENCIES_VALIDATED marker. Outside the repo, rewritten by the
       run, and derived from things that are themselves on the record (the
       font directories, the browser build). */
    if (cls === 'stat' && access.written.has(p)) continue;
    if (access.written.has(p) && !listed) {
      /* Looked, found nothing, made it (existsSync -> writeFileSync/mkdir),
         or a directory it recreated: that is an output, checked as one
         below, not an input. A FILE it read and then rewrote is different -
         what it read is gone. */
      if (seen === 'absent' || seen === 'dir' || fper.stat(p)?.isDirectory()) continue;
      problems.push(`reads ${rel(root, p)} and then rewrites it - its pre-run content is gone, so the run cannot be keyed`);
      continue;
    }
    const st = fper.stat(p);
    /* Changed during the run - by the step itself (it listed a directory it
       then wrote into) or by you, saving a file mid-run. Either way what the
       step saw is not what is on disk now. */
    const watched = st && (st.isFile() || (listed && st.isDirectory()));
    if (watched && st.ctimeNs >= startedNs - SLACK_NS && cls !== 'stat') {
      problems.push(`${rel(root, p)} changed while the step was running`);
      continue;
    }
    const now = fper.fp(p, cls, listed);
    if (seen === 'absent' && now !== 'absent') { problems.push(`${rel(root, p)} was absent during the run and exists now`); continue; }
    if (seen === 'file' && now === 'absent') { problems.push(`${rel(root, p)} was read during the run and is gone now`); continue; }
    manifest[p] = now;
  }

  /* Outputs the step leaves in the tree. Skipping it must leave the tree as
     running it would, so these are checked on lookup too: a later suite (or
     you) may read them. Temp-dir products are the step's business only. */
  const outputs = {};
  const tmp = resolve(tmpdir()) + sep;
  for (const p of access.written) {
    const cls = classify(p);
    if (cls !== 'content' || p.startsWith(tmp) || ownDirs.some((d) => p.startsWith(d) && d.startsWith(tmp))) continue;
    const now = fper.fp(p, cls, false);
    if (now === 'absent' || now === 'dir') continue;
    outputs[p] = now;
  }
  return { manifest, outputs, problems };
}

const rel = (root, p) => (p.startsWith(root + sep) ? p.slice(root.length + 1) : p);

export function keyOf({ step, command, salt, manifest }) {
  const lines = [`v${CACHE_VERSION}`, `step ${step}`, `cmd ${command}`];
  for (const k of Object.keys(salt).sort()) lines.push(`env ${k}=${salt[k]}`);
  for (const p of Object.keys(manifest).sort()) lines.push(`dep ${p} ${manifest[p]}`);
  return sha(lines.join('\n'));
}

/* STORE: one JSON file per suite, newest record first. */
const fileFor = (dir, step) => join(dir, 'suites', step.replace(/[^A-Za-z0-9_.-]/g, '_') + '.json');

export function loadRecords(dir, step) {
  try {
    const j = JSON.parse(readFileSync(fileFor(dir, step), 'utf8'));
    return j.step === step && Array.isArray(j.records) ? j.records : [];
  } catch { return []; }
}

export function saveRecord(dir, step, record) {
  const f = fileFor(dir, step);
  mkdirSync(dirname(f), { recursive: true });
  const kept = loadRecords(dir, step).filter((r) => r.key !== record.key);
  const out = { step, records: [record, ...kept].slice(0, KEEP_RECORDS) };
  writeFileSync(f + '.tmp', JSON.stringify(out, null, 1));
  renameSync(f + '.tmp', f);
}

export function saveTrace(dir, step, t) {
  const f = join(dir, 'traces', step.replace(/[^A-Za-z0-9_.-]/g, '_') + '.json');
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f + '.tmp', JSON.stringify({ step, ...t }, null, 1));
  renameSync(f + '.tmp', f);
}

export function loadTrace(dir, step) {
  try { return JSON.parse(readFileSync(join(dir, 'traces', step.replace(/[^A-Za-z0-9_.-]/g, '_') + '.json'), 'utf8')); } catch { return null; }
}

/* LOOKUP: re-fingerprint each record's own paths against the tree as it is
   now and recompute its key. A hit needs the key AND every output to match.
   On a miss, `why` names the paths that moved, newest record first. */
export function lookup({ step, command, salt, records, fper, classify, root }) {
  let why = records.length ? null : 'never recorded green';
  for (const r of records) {
    if (r.version !== CACHE_VERSION) { why = why || 'recorded by an older cache version'; continue; }
    const now = {};
    const changed = [];
    for (const p of Object.keys(r.manifest)) {
      now[p] = fper.fp(p, classify(p), r.manifest[p].startsWith('dir:'));
      if (now[p] !== r.manifest[p]) changed.push(rel(root, p));
    }
    const envChanged = Object.keys({ ...salt, ...r.salt }).filter((k) => salt[k] !== r.salt[k]);
    const key = keyOf({ step, command, salt, manifest: now });
    if (key === r.key) {
      const outMissing = Object.keys(r.outputs || {}).filter((p) => fper.fp(p, classify(p), false) !== r.outputs[p]);
      if (!outMissing.length) return { hit: r };
      why = why || `its output ${outMissing.map((p) => rel(root, p)).slice(0, 3).join(', ')} is missing or different`;
      continue;
    }
    if (!why) {
      const parts = [];
      if (r.command !== command) parts.push('the command changed');
      if (envChanged.length) parts.push(`env ${envChanged.slice(0, 3).join(', ')} changed`);
      if (changed.length) parts.push(`${changed.length} dep(s) changed: ${changed.slice(0, 4).join(', ')}${changed.length > 4 ? ', ...' : ''}`);
      why = parts.join('; ') || 'key mismatch';
    }
  }
  return { hit: null, why };
}
