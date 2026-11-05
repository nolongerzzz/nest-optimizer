/**
 * nest-optimizer / tools / test-cache / static-graph.mjs
 *
 * Two dependency graphs built by READING the code, kept for one purpose:
 * auditing the traced graph (tools/test-cache/audit.mjs) - neither is what
 * the cache keys on.
 *
 *   imports   the naive graph: require(), import, and nothing else. This is
 *             what an off-the-shelf "affected tests" tool would compute.
 *   mentions  a deliberately generous graph: every string literal in a file
 *             that names an existing repo file (resolved against the file's
 *             own directory, the repo root and tools/), every <script src>
 *             of index.html once any file mentions index.html or the app
 *             harness, and every file a shell script globs. Closed
 *             transitively. It over-approximates what a static reader can
 *             see, and it is still blind to anything whose name is computed.
 *
 * Both start from the files named in a step's command line.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';

const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

function scriptSrcs(root, html) {
  const s = readFileSync(join(root, html), 'utf8');
  const out = [];
  for (const m of s.matchAll(/<script[^>]*\bsrc="([^"?#]+)[^"]*"/g)) {
    if (/^https?:/.test(m[1])) continue;
    const p = resolve(root, m[1]);
    if (isFile(p)) out.push(p);
  }
  return out;
}

function globSh(root, s) {
  const out = [];
  for (const m of s.matchAll(/([\w./-]+)\/\*(\.[\w.]+)/g)) {
    const dir = resolve(root, m[1]);
    try { for (const f of readdirSync(dir)) if (f.endsWith(m[2])) out.push(join(dir, f)); } catch {}
  }
  return out;
}

/* Files named on a step's command line: `node a.js && node b.js`, `sh x.sh`,
   `python3 x.py`, `python3 -m unittest discover -s dir`. */
export function entryFiles(root, command) {
  const out = [];
  for (const tok of command.split(/\s+/)) {
    const t = tok.replace(/^["']|["']$/g, '');
    if (/\.(m?js|py|sh)$/.test(t) && isFile(resolve(root, t))) out.push(resolve(root, t));
  }
  return out;
}

const REQ = /(?:require\(\s*|import\(\s*|from\s+|import\s+)(['"])(\.{1,2}\/[^'"]+)\1/g;
const REQ_ROOTJOIN = /require\(\s*path\.join\(\s*(?:ROOT|__dirname)\s*,\s*((?:['"][^'"]+['"]\s*,?\s*)+)\)\s*\)/g;

function resolveModule(from, spec) {
  const base = resolve(dirname(from), spec);
  for (const c of [base, base + '.js', base + '.mjs', join(base, 'index.js')]) if (isFile(c)) return c;
  return null;
}

export function importsOf(root, file) {
  let s;
  try { s = readFileSync(file, 'utf8'); } catch { return []; }
  const out = new Set();
  for (const m of s.matchAll(REQ)) { const r = resolveModule(file, m[2]); if (r) out.add(r); }
  // require(path.join(ROOT, 'x.js')) is still an import, just spelled long.
  for (const m of s.matchAll(REQ_ROOTJOIN)) {
    const parts = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
    const base = /ROOT/.test(m[0]) ? root : dirname(file);
    const r = resolveModule(join(base, 'x'), './' + relative(dirname(join(base, 'x')), join(base, ...parts)));
    if (r) out.add(r);
  }
  if (/\.py$/.test(file)) {
    for (const m of s.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm)) {
      const mod = (m[1] || m[2]).split('.')[0];
      const p = join(dirname(file), mod + '.py');
      if (isFile(p)) out.add(p);
    }
  }
  return [...out];
}

export function mentionsOf(root, file) {
  let s;
  try { s = readFileSync(file, 'utf8'); } catch { return []; }
  const out = new Set(importsOf(root, file));
  const bases = [dirname(file), root, join(root, 'tools')];
  for (const m of s.matchAll(/['"`]([\w@][\w@./-]*\.[A-Za-z0-9]{1,5})['"`]/g)) {
    for (const b of bases) {
      const p = resolve(b, m[1]);
      if (p.startsWith(root + sep) && isFile(p)) { out.add(p); break; }
    }
  }
  if (/\.sh$/.test(file)) globSh(root, s).forEach((p) => out.add(p));
  const touchesApp = /index\.html|nso_app_harness|browser-lib\.mjs/.test(s);
  if (touchesApp && isFile(join(root, 'index.html'))) {
    out.add(join(root, 'index.html'));
    scriptSrcs(root, 'index.html').forEach((p) => out.add(p));
  }
  return [...out];
}

export function closure(roots, edges) {
  const seen = new Set(), stack = [...roots];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    if (/\.(m?js|py|sh|html)$/.test(f)) for (const g of edges(f)) if (!seen.has(g)) stack.push(g);
  }
  return seen;
}

export function staticGraphs(root, command) {
  const entry = entryFiles(root, command);
  const imports = closure(entry, (f) => (/\.html$/.test(f) ? [] : importsOf(root, f)));
  const mentions = closure(entry, (f) => (/\.html$/.test(f) ? scriptSrcs(root, relative(root, f)) : mentionsOf(root, f)));
  return { entry, imports, mentions };
}

export const exists = existsSync;
