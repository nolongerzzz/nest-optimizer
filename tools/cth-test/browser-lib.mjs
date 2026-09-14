/**
 * nest-optimizer / tools/cth-test / browser-lib.mjs
 *
 * The bits the browser checks share: a static server over the repo, the CDN
 * substitution, and the check/report helper.
 *
 * index.html names two things on cdn.jsdelivr.net - three, and the manifold
 * kernel NSO_CSG imports (app-join.js) - and the CDN is not reachable from
 * every runner; the agent proxy this was written on denies it outright. Both
 * are already in the repo or in devDependencies, so the checks serve those
 * copies and need no network at all. The app is not modified to do it: the
 * requests go out as written and are answered locally.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

export const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.stl': 'model/stl', '.wasm': 'application/wasm', '.json': 'application/json',
};

/* Matched against the CDN request URL, longest-specific first. */
const CDN = [
  ['three@0.147.0/build/three.min.js', 'node_modules/three/build/three.min.js'],
  ['controls/OrbitControls.js', 'node_modules/three/examples/js/controls/OrbitControls.js'],
  ['loaders/STLLoader.js', 'node_modules/three/examples/js/loaders/STLLoader.js'],
  ['manifold-3d@3.5.3/manifold.js', 'vendor/manifold/manifold.js'],
  ['manifold-3d@3.5.3/manifold.wasm', 'vendor/manifold/manifold.wasm'],
];

export function serveRoot() {
  return new Promise((resolve) => {
    const srv = createServer(async (req, res) => {
      const p = decodeURIComponent(req.url.split('?')[0]);
      const file = normalize(join(ROOT, p));
      if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      try {
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': TYPES[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream' });
        res.end(body);
      } catch { res.writeHead(404); res.end('not found'); }
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}

/* Returns the list the page actually asked for, so a check can assert the
   substitution really happened rather than silently testing a build with no
   kernel in it. */
export function routeCdn(page) {
  const served = [];
  page.route('**cdn.jsdelivr.net/**', async (route) => {
    const url = route.request().url();
    const hit = CDN.find(([k]) => url.includes(k));
    if (!hit) { served.push('UNROUTED ' + url); return route.abort(); }
    served.push(hit[0]);
    route.fulfill({
      status: 200,
      contentType: hit[0].endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
      body: await readFile(join(ROOT, hit[1])),
    });
  });
  return served;
}

export function mkCheck() {
  const checks = [];
  function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    checks.push({ name, ok });
    console.log(`${ok ? 'ok    ' : 'FAILED'} ${name}` +
      (ok ? '' : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`));
  }
  check.report = () => {
    const failed = checks.filter((c) => !c.ok);
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
    return failed.length;
  };
  return check;
}

export const launchOpts = () =>
  (process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
