/**
 * nest-optimizer / tools / test-cache / trace.mjs
 *
 * Runs one command under strace and reports every file it touched.
 *
 * WHY A SYSCALL TRACE AND NOT AN IMPORT GRAPH
 * This project's code reaches its tests three ways, and only the first is
 * visible to anything that reads `require`/`import` statements:
 *
 *   1. require()/import of tools/ helpers,
 *   2. fs.readFileSync(<app file>) + vm.runInContext - app-cut.js, app-crop.js
 *      and friends are classic scripts with no exports; the geometry tests
 *      load them as TEXT and run them in one shared context (crop:test loads
 *      app-cut.js because Crop calls Cut's rawFlatCapLoop by global name),
 *   3. a real Chromium loading index.html, whose ~90 <script> tags then call
 *      each other through globals (setStatus is defined in app-join.js and
 *      called from forty other files), plus whatever the page fetches later.
 *
 * Every one of those, and a python3 subprocess reading its own imports, ends
 * in the same place: an open(2)/stat(2)/getdents(2) by some process in the
 * step's process tree. So the trace is taken there, below all three. A file
 * that decided anything about a step's outcome was opened or stat'd by it;
 * a file that was never touched cannot have decided anything. That is the
 * soundness argument the cache rests on, and it is file-granular on purpose:
 * it does not try to know WHICH function in app-cut.js Crop uses, only that
 * app-cut.js was read, so any edit anywhere in it reruns Crop.
 *
 * What it does NOT see, and what the caller has to key on separately:
 * environment variables, the command line itself, the network, the clock and
 * randomness. Network use is detected here (connect(2) to anything but
 * loopback or a unix socket) so the caller can refuse to cache that step.
 *
 * Output of trace(): { code, signal, ms, out, access } where access is
 *   reads     Map<abs path, 'file'|'dir'|'absent'|'other'> - looked at
 *   listed    Set<abs dir> - getdents'd (a listing is an input: a new
 *             fixture dropped into a directory a test globs changes it)
 *   written   Set<abs path> - created, truncated, renamed-to, unlinked
 *   createdFirst Set<abs path> - written BEFORE any read of the same path
 *             in this step: the step's own output, not an input
 *   execs     Set<abs path> - every binary execve'd
 *   remote    [string] - connections that reached the network
 *   uring     [pid] - processes that set up io_uring. File reads submitted
 *             through a ring are not syscalls and are invisible here, so a
 *             step that uses one cannot be cached (libuv in Node 22 has it
 *             off by default; this is the tripwire if that ever changes).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';

const SYSCALLS = [
  '%file',                 // every syscall that takes a path: open*, stat*, access*, exec*, chdir, rename*, unlink*, mkdir*, readlink*...
  'getdents64', 'getdents', // directory listings
  'fchdir',
  'connect', 'sendto',     // network detection (sendto: the proxy CONNECT line)
  'clone', 'clone3', 'fork', 'vfork', // process tree, for cwd inheritance
  'io_uring_setup',        // file I/O through io_uring never shows up as a syscall
].join(',');

/* strace quotes paths as C strings. */
function unquote(s) {
  return s.replace(/\\(x[0-9a-fA-F]{2}|[0-7]{1,3}|.)/g, (m, e) => {
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return { n: '\n', t: '\t', r: '\r', v: '\v', f: '\f' }[e] ?? e;
  });
}

/* Split a syscall's argument text at top-level commas, respecting quotes,
   brackets and <...> fd decorations. */
function splitArgs(s) {
  const out = [];
  let depth = 0, q = false, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      cur += c;
      if (c === '\\') { cur += s[++i] ?? ''; continue; }
      if (c === '"') q = false;
      continue;
    }
    if (c === '"') { q = true; cur += c; continue; }
    if ('{[(<'.includes(c)) depth++;
    else if ('}])>'.includes(c)) depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const strArg = (a) => (a && a[0] === '"' ? unquote(a.slice(1, a.lastIndexOf('"'))) : null);
/* `AT_FDCWD</x/y>` or `20</x/y>` -> '/x/y' */
const fdPath = (a) => {
  const m = a && /<(.*)>$/.exec(a);
  return m ? m[1] : null;
};

/* Merge `<unfinished ...>` / `<... name resumed>` halves back into one line
   per call, in completion order. */
function* calls(text) {
  const pending = new Map();
  for (const line of text.split('\n')) {
    const m = /^(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    let body = m[2];
    if (body.startsWith('+++') || body.startsWith('---')) continue;
    if (body.endsWith('<unfinished ...>')) {
      pending.set(pid, body.slice(0, -'<unfinished ...>'.length).trimEnd());
      continue;
    }
    const r = /^<\.\.\. (\w+) resumed>(.*)$/.exec(body);
    if (r) {
      const head = pending.get(pid);
      pending.delete(pid);
      if (!head) continue;
      body = head + r[2];
    }
    const c = /^(\w+)\((.*)\)\s+=\s+(.*)$/s.exec(body);
    if (!c) continue;
    yield { pid, name: c[1], args: c[2], ret: c[3] };
  }
}

const WRITE_FLAGS = /O_WRONLY|O_RDWR|O_CREAT|O_TRUNC/;

export function parseTrace(text, rootCwd, { proxyPorts = new Set() } = {}) {
  const all = [...calls(text)];

  /* Pass 1: the process tree. A child's first lines can be logged before the
     parent's fork returns, so parentage is collected first. CLONE_FS children
     (threads) share their parent's cwd; everything else gets a copy. */
  const parent = new Map(), sharesFs = new Map();
  for (const c of all) {
    if (!/^(clone3?|v?fork)$/.test(c.name)) continue;
    const child = Number((/^(\d+)/.exec(c.ret) || [])[1]);
    if (!child) continue;
    parent.set(child, c.pid);
    sharesFs.set(child, /CLONE_FS/.test(c.args));
  }

  /* Pass 2: walk in order, resolving relative paths against the right cwd. */
  const fsGroup = new Map(); // pid -> group object {cwd}
  const groupOf = (pid) => {
    let g = fsGroup.get(pid);
    if (g) return g;
    const p = parent.get(pid);
    if (p !== undefined) {
      const pg = groupOf(p);
      g = sharesFs.get(pid) ? pg : { cwd: pg.cwd };
    } else {
      g = { cwd: rootCwd };
    }
    fsGroup.set(pid, g);
    return g;
  };

  const reads = new Map(), listed = new Set(), written = new Set();
  const firstTouch = new Map(); // path -> 'r' | 'w'
  const execs = new Set(), remote = [];
  const sockets = new Map();
  const uring = [];
  const exe = new Map(); // pid -> binary it exec'd; threads inherit
  const exeOf = (pid) => exe.get(pid) ?? (parent.has(pid) ? exeOf(parent.get(pid)) : null);
  const isBrowser = (pid) => /\/(chrome|headless_shell|chromium)$/.test(exeOf(pid) || '');
  const unresolved = [];

  const touchRead = (p, kind) => {
    if (!p) return;
    if (!firstTouch.has(p)) firstTouch.set(p, 'r');
    const prev = reads.get(p);
    // A later successful look wins over an earlier ENOENT only if it is the
    // same kind of evidence; keep the most informative.
    if (!prev || prev === 'absent' || prev === 'other') reads.set(p, kind);
  };
  /* A successful open reports the fully resolved path. Record the path as
     asked for too: through a symlink the two differ, and retargeting the
     link changes what is read without touching the old target. */
  const touchOpen = (asked, resolvedPath, kind) => {
    if (resolvedPath && kind !== 'absent') touchRead(resolvedPath, kind);
    if (asked && asked !== resolvedPath) touchRead(asked, kind);
  };
  const touchWrite = (p) => {
    if (!p) return;
    if (!firstTouch.has(p)) firstTouch.set(p, 'w');
    written.add(p);
  };

  for (const c of all) {
    const g = groupOf(c.pid);
    const a = splitArgs(c.args);
    const ok = !/^-1 /.test(c.ret);
    /* Only "no such entry" means absent. readlink(2) on a plain file fails
       with EINVAL, access(2) with EACCES - the thing is there. */
    const missing = /^-1 (ENOENT|ENOTDIR)\b/.test(c.ret);
    const retPath = fdPath((/^\d+(<.*>)/.exec(c.ret) || [])[1] || '');
    const resolveAt = (dirArg, pathArg) => {
      const p = strArg(pathArg);
      if (p === null) return null;
      if (p === '' ) return fdPath(dirArg); // AT_EMPTY_PATH on an fd
      if (isAbsolute(p)) return resolve(p);
      const base = dirArg ? fdPath(dirArg) : g.cwd;
      if (!base) { unresolved.push(`${c.name}(${c.args})`); return null; }
      return resolve(base, p);
    };
    /* A resolved AT_FDCWD<...> is a free, exact reading of the cwd. */
    const cwdSeen = /^AT_FDCWD<(.*)>/.exec(a[0] || '');
    if (cwdSeen) g.cwd = cwdSeen[1];

    const kindOf = (st) => (missing ? 'absent' : !ok ? 'other' : /S_IFDIR/.test(st || '') ? 'dir' : /S_IFREG/.test(st || '') ? 'file' : 'other');

    switch (c.name) {
      case 'open': case 'creat': {
        const p = resolveAt(null, a[0]);
        const flags = c.name === 'creat' ? 'O_CREAT' : a[1] || '';
        if (WRITE_FLAGS.test(flags)) { if (ok) touchWrite(retPath || p); if (/O_RDWR/.test(flags)) touchRead(retPath || p, 'file'); }
        else touchOpen(p, retPath, ok ? (/O_DIRECTORY/.test(flags) ? 'dir' : 'file') : missing ? 'absent' : 'other');
        break;
      }
      case 'openat': case 'openat2': {
        const p = resolveAt(a[0], a[1]);
        const flags = a[2] || '';
        if (WRITE_FLAGS.test(flags)) { if (ok) touchWrite(retPath || p); if (/O_RDWR/.test(flags) && !/O_TRUNC/.test(flags)) touchRead(retPath || p, 'file'); }
        else touchOpen(p, retPath, ok ? (/O_DIRECTORY/.test(flags) ? 'dir' : 'file') : missing ? 'absent' : 'other');
        break;
      }
      case 'stat': case 'lstat': case 'access': case 'readlink':
        touchRead(resolveAt(null, a[0]), c.name === 'stat' || c.name === 'lstat' ? kindOf(a[1]) : missing ? 'absent' : 'other');
        break;
      case 'newfstatat': case 'fstatat64': case 'statx': case 'faccessat': case 'faccessat2': case 'readlinkat': {
        const p = resolveAt(a[0], a[1]);
        const st = c.name === 'statx' ? a[4] : a[2];
        touchRead(p, /stat/.test(c.name) ? kindOf(st) : missing ? 'absent' : 'other');
        break;
      }
      case 'getdents64': case 'getdents': {
        const d = fdPath(a[0]);
        if (d) { listed.add(d); touchRead(d, 'dir'); }
        break;
      }
      case 'execve': case 'execveat': {
        const p = c.name === 'execve' ? resolveAt(null, a[0]) : resolveAt(a[0], a[1]);
        touchRead(p, ok ? 'file' : missing ? 'absent' : 'other');
        /* Chromium forks its renderer/GPU/network processes by exec'ing
           /proc/self/exe: the same binary as before the exec. */
        if (ok && p) { execs.add(p); exe.set(c.pid, p === '/proc/self/exe' ? exeOf(c.pid) : p); }
        break;
      }
      case 'chdir': {
        const p = resolveAt(null, a[0]);
        if (ok && p) g.cwd = p;
        touchRead(p, ok ? 'dir' : missing ? 'absent' : 'other');
        break;
      }
      case 'fchdir': {
        const p = fdPath(a[0]);
        if (ok && p) g.cwd = p;
        break;
      }
      case 'rename': case 'renameat': case 'renameat2': {
        const [from, to] = c.name === 'rename' ? [resolveAt(null, a[0]), resolveAt(null, a[1])] : [resolveAt(a[0], a[1]), resolveAt(a[2], a[3])];
        if (ok) { touchWrite(from); touchWrite(to); }
        break;
      }
      case 'unlink': case 'rmdir': case 'mkdir': case 'truncate': case 'symlink': case 'link':
      case 'unlinkat': case 'mkdirat': case 'symlinkat': case 'linkat': case 'utimensat': case 'chmod': case 'fchmodat': {
        let p;
        if (/at$/.test(c.name) && c.name !== 'utimensat') p = c.name === 'symlinkat' ? resolveAt(a[1], a[2]) : c.name === 'linkat' ? resolveAt(a[2], a[3]) : resolveAt(a[0], a[1]);
        else if (c.name === 'utimensat') p = resolveAt(a[0], a[1]);
        else if (c.name === 'symlink' || c.name === 'link') p = resolveAt(null, a[1]);
        else p = resolveAt(null, a[0]);
        if (ok) touchWrite(p);
        else if (c.name === 'mkdir' || c.name === 'mkdirat') touchRead(p, 'dir'); // EEXIST: it looked
        break;
      }
      case 'connect': {
        const s = c.args;
        if (/AF_UNIX|AF_LOCAL|AF_NETLINK/.test(s)) break;
        if (!/AF_INET6?/.test(s)) break;
        const port = Number((/htons\((\d+)\)/.exec(s) || [])[1]);
        const loopback = /inet_addr\("127\.|inet_pton\(AF_INET6, "::1"|inet_pton\(AF_INET6, "::ffff:127\./.test(s);
        /* Loopback is the harness's own static server - unless it is the
           egress proxy's port, which is the network all the same. */
        if (loopback && !proxyPorts.has(port)) break;
        /* Port 53 alone is a name lookup, which returns no content; Chromium
           also connect()s a UDP socket to 8.8.8.8:53 at startup purely to
           learn its default route, sending nothing. A fetch that follows a
           lookup still has to connect somewhere else, and that is caught. */
        if (!loopback && port === 53) break;
        /* ...and the same lookup over DNS-over-HTTPS, which Chromium tries
           against the public resolvers it knows (8.8.8.8 -> dns.google). */
        if (port === 443 && /"(8\.8\.8\.8|8\.8\.4\.4|1\.1\.1\.1|1\.0\.0\.1|2001:4860:4860::88(88|44))"/.test(s)) break;
        const sock = (/socket:\[(\d+)\]/.exec(a[0]) || [])[1] || `anon${sockets.size}`;
        sockets.set(sock, { desc: s.slice(0, 160), pid: c.pid, exe: exeOf(c.pid), browser: isBrowser(c.pid), hosts: [], sent: false });
        break;
      }
      case 'sendto': {
        const sock = (/socket:\[(\d+)\]/.exec(a[0]) || [])[1];
        const k = sock && sockets.get(sock);
        if (!k || k.sent) break;
        k.sent = true; // the first thing sent names where it is going
        const payload = a[1] || '';
        const m = /^"CONNECT ([^: ]+)/.exec(payload) || /\\r\\nHost: ([^:\\ ]+)/.exec(payload);
        if (m) k.hosts.push(m[1]);
        else for (const h of payload.matchAll(/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|dev|app|google)\b/g)) k.hosts.push(h[0]); // TLS SNI
        break;
      }
      case 'io_uring_setup':
        /* libuv (Node 22) always sets up one small ring to batch its
           epoll_ctl calls - IORING_OP_EPOLL_CTL only, no files. Its file-I/O
           ring is the SQPOLL one, off unless UV_USE_IO_URING=1. Anything
           else setting up a ring is unknown, and so not trusted. */
        if (ok && (/IORING_SETUP_SQPOLL/.test(c.args) || !/\/node$/.test(exeOf(c.pid) || ''))) uring.push(`${c.pid} ${exeOf(c.pid)}`);
        break;
      default:
        break;
    }
  }
  /* Outbound sockets. Anything opened by a process that is not Chromium is
     the network, full stop: Node writes to sockets with writev, which is not
     traced, so there is nothing to inspect. A Chromium socket is let off
     only when what it sent names nothing but Chromium's own background
     services (the page's own requests are answered from disk by the
     harness's page.route and never reach a socket), or it sent nothing. */
  for (const k of sockets.values()) {
    if (k.browser && (!k.sent || (k.hosts.length && k.hosts.every((h) => BROWSER_BACKGROUND_HOSTS.test(h))))) continue;
    remote.push(k.hosts.length ? `${k.hosts.join(', ')} (${k.desc})` : k.desc);
  }

  const createdFirst = new Set([...firstTouch].filter(([, t]) => t === 'w').map(([p]) => p));
  const outbound = [...sockets.values()];
  return { reads, listed, written, createdFirst, execs, remote, outbound, unresolved, uring, calls: all.length };
}

/* Chromium phones these home on its own (autofill, sign-in, component and
   safe-browsing updates, variations) whether or not a page asks for
   anything. Their answers do not reach the page under test. */
const BROWSER_BACKGROUND_HOSTS = new RegExp('^(' + [
  'content-autofill\\.googleapis\\.com',
  'accounts\\.google\\.com',
  'optimizationguide-pa\\.googleapis\\.com',
  'update\\.googleapis\\.com',
  'clients\\d*\\.google\\.com',
  'clientservices\\.googleapis\\.com',
  'safebrowsing(-cache)?\\.googleapis\\.com',
  'safebrowsing\\.google\\.com',
  '[a-z0-9-]+\\.gvt1\\.com',
  'gvt1\\.com',
  'www\\.googleapis\\.com',
  'android\\.clients\\.google\\.com',
  'chromesyncpasswords-pa\\.googleapis\\.com',
  'www\\.google\\.com',
  'www\\.gstatic\\.com',
  'dns\\.google',
].join('|') + ')$');

/* Ports of any egress proxy the environment points at. */
export function proxyPortsOf(env) {
  const ports = new Set();
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const v = env[k];
    if (!v) continue;
    try { const u = new URL(/^\w+:\/\//.test(v) ? v : 'http://' + v); ports.add(Number(u.port || (u.protocol === 'https:' ? 443 : 80))); } catch {}
  }
  return ports;
}

const live = new Set();
export function killAll(signal = 'SIGTERM') {
  for (const c of live) { try { process.kill(-c.pid, signal); } catch {} }
}

/* Run `command` via /bin/sh under strace. Output is streamed through
   `onOut` as it arrives (the runner echoes it, like run-tests.mjs). */
export function trace(command, { cwd, env, onOut } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nso-trace-'));
  const log = join(dir, 'strace.log');
  const args = ['-f', '-qq', '-y', '-s', '4096', '--seccomp-bpf', '-e', `trace=${SYSCALLS}`, '-o', log,
    '/bin/sh', '-c', command];
  return new Promise((done) => {
    const started = Date.now();
    /* Its own process group, so an interrupted runner can take the whole
       traced tree down with it (killing strace alone detaches it and leaves
       the step running, orphaned). */
    const child = spawn('strace', args, { cwd, env: env || process.env, detached: true });
    live.add(child);
    let out = '';
    const take = (d) => { const s = d.toString(); out += s; if (onOut) onOut(s); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (err) => {
      rmSync(dir, { recursive: true, force: true });
      done({ code: -1, signal: null, ms: Date.now() - started, out: out + `\n[trace] could not start strace: ${err.message}\n`, access: null });
    });
    child.on('close', (code, signal) => {
      live.delete(child);
      const ms = Date.now() - started;
      let access = null;
      try { access = parseTrace(readFileSync(log, 'utf8'), cwd, { proxyPorts: proxyPortsOf(env || process.env) }); }
      catch (e) { out += `\n[trace] could not read the trace: ${e.message}\n`; }
      rmSync(dir, { recursive: true, force: true });
      done({ code: code === null ? -1 : code, signal, ms, out, access });
    });
  });
}
