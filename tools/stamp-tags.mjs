#!/usr/bin/env node
/**
 * nest-optimizer / tools / stamp-tags.mjs
 *
 * Rewrites every ?v= on a page's local <script src> / <link href> to the first
 * 8 hex of the sha256 of the file it points at. Nobody picks a tag by hand.
 *
 * WHY. Every batch bumped the same ?v= lines in index.html, two PRs edited one
 * line, and git conflicted (or worse, kept both: see tools/nso_page_manifest_test.js
 * gate 1). A tag derived from the file's bytes cannot be wrong and cannot be
 * edited twice - after a rebase you re-run the script and the tree is right.
 *
 *   npm run stamp                      # rewrite; prints the files whose tag changed
 *   node tools/stamp-tags.mjs --check  # change nothing; exit 1 if any tag is stale
 *   node tools/stamp-tags.mjs --root <dir>   # a tree other than the repo (the gate's samples)
 *
 * Scope: every *.html under the root (node_modules and .git skipped) that loads a
 * local file with ?v=. Tags inside <!-- --> are not loaded and are left alone.
 * A tag with no ?v= is left without one; a remote URL is never touched. A local
 * file that does not exist is an error (exit 2), not a guess.
 * The ES-module imports inside cth/*.js carry their own ?v= and are not pages;
 * they are not stamped.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const hashOf = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 8);

/* Stamps one page's text. `pageDir` is what its relative srcs resolve against.
   Returns { html, changes: [{ file, from, to }], missing: [file] }. */
export function stampHtml(html, pageDir) {
  const changes = [];
  const missing = [];
  const cache = new Map();
  const tagFor = (file) => {
    if (!cache.has(file)) {
      const p = join(pageDir, file);
      cache.set(file, existsSync(p) ? hashOf(readFileSync(p)) : null);
    }
    return cache.get(file);
  };
  /* Same comment rule as the page manifest: blank the comments, rewrite only
     where the blanked copy still shows a tag. */
  const live = html.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
  const edits = [];
  const tagRe = /<(script|link)\b[^>]*>/gi;
  let m;
  while ((m = tagRe.exec(live))) {
    const attr = m[1].toLowerCase() === 'script' ? 'src' : 'href';
    const a = new RegExp('(\\b' + attr + '\\s*=\\s*)(["\'])([^"\']*)\\2', 'i').exec(m[0]);
    if (!a) continue;
    const url = a[3];
    const q = /^([^?#]*)\?([^#]*)(#.*)?$/.exec(url);
    if (!q || /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) continue;
    const params = q[2].split('&');
    const vi = params.findIndex((p) => /^v=/.test(p));
    if (vi < 0) continue;
    const file = q[1].replace(/^\.\//, '');
    const want = tagFor(file);
    if (want === null) { missing.push(file); continue; }
    const have = params[vi].slice(2);
    if (have === want) continue;
    params[vi] = 'v=' + want;
    const at = m.index + a.index + a[1].length + 1; // inside the quotes
    edits.push({ at, len: url.length, text: q[1] + '?' + params.join('&') + (q[3] || '') });
    changes.push({ file, from: have, to: want });
  }
  let out = html;
  for (const e of edits.sort((x, y) => y.at - x.at)) out = out.slice(0, e.at) + e.text + out.slice(e.at + e.len);
  return { html: out, changes, missing };
}

function pagesUnder(root) {
  const out = [];
  const walk = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      const p = join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.html')) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

function main(argv) {
  const check = argv.includes('--check');
  const ri = argv.indexOf('--root');
  const root = ri >= 0 ? resolve(argv[ri + 1]) : join(HERE, '..');
  let stale = 0, bad = 0, tags = 0;
  for (const page of pagesUnder(root)) {
    const src = readFileSync(page, 'utf8');
    const r = stampHtml(src, dirname(page));
    const rel = relative(root, page);
    r.missing.forEach((f) => { bad++; console.error(`${rel}: ?v= on ${f}, which does not exist`); });
    if (!r.changes.length) continue;
    stale += r.changes.length;
    console.log(`${rel}: ${r.changes.length} tag${r.changes.length === 1 ? '' : 's'} ${check ? 'stale' : 'changed'}`);
    r.changes.forEach((c) => console.log(`  ${c.file}  ${c.from} -> ${c.to}`));
    if (!check) writeFileSync(page, r.html);
    tags += r.changes.length;
  }
  if (bad) process.exit(2);
  if (check && stale) {
    console.error(`stamp: ${stale} stale ?v= tag(s) - run \`npm run stamp\` and commit the result`);
    process.exit(1);
  }
  if (!stale) console.log('stamp: every ?v= already matches its file');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
