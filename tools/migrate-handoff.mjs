#!/usr/bin/env node
/**
 * nest-optimizer / tools / migrate-handoff.mjs
 *
 * Splits docs/HANDOFF.md into docs/handoff/<slug>.md, one file per `## `
 * section, and leaves HANDOFF.md as its preamble plus a generated index
 * (tools/handoff-index.mjs). See that file for why.
 *
 *   node tools/migrate-handoff.mjs
 *
 * Re-runnable on any tree. Where HANDOFF.md has no `## ` section left it does
 * nothing. Where it has some - a rebase that took the other side of the file -
 * it writes those sections (replacing a docs/handoff file of the same slug, the
 * HANDOFF.md copy being the newer) and puts the index back. Lossless: before
 * anything is written, the preamble and the sections are joined again and must
 * equal the file byte for byte. `## ` inside a code fence is not a heading.
 * The slug is the heading without a trailing (parenthetical), lower-cased, a-z0-9
 * and hyphens; sections that slug alike each get their date, or -2.
 *
 * The preamble is rewritten in one place: the sentence that gave Grok the ?v=
 * tags now points at `npm run stamp`, and the handoff rule is added.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexBlock } from './handoff-index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'docs', 'HANDOFF.md');
const DIR = join(ROOT, 'docs', 'handoff');

export function sections(text) {
  const lines = text.split('\n');
  let fence = false;
  const starts = [];
  lines.forEach((l, i) => {
    if (/^```/.test(l)) fence = !fence;
    else if (!fence && /^## /.test(l)) starts.push(i);
  });
  if (!starts.length) return { preamble: text, parts: [] };
  const cut = (a, b) => lines.slice(a, b).join('\n') + (b >= lines.length ? '' : '\n');
  const parts = starts.map((s, k) => ({ heading: lines[s].slice(3).trim(), body: cut(s, starts[k + 1] ?? lines.length) }));
  return { preamble: cut(0, starts[0]), parts };
}

export function slugOf(heading) {
  const s = heading.replace(/\s*\([^()]*\)\s*$/, '').toLowerCase().replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s.length > 64 ? s.slice(0, 64).replace(/-[^-]*$/, '') : s;
}

export function names(parts) {
  const base = parts.map((p) => slugOf(p.heading));
  const count = new Map();
  base.forEach((b) => count.set(b, (count.get(b) || 0) + 1));
  const used = new Set();
  return parts.map((p, i) => {
    let slug = base[i];
    if (count.get(slug) > 1) {
      const date = /(\d{4}-\d{2}-\d{2})/.exec(p.heading);
      slug = date ? slug + '-' + date[1] : slug;
    }
    for (let n = 2; used.has(slug); n++) slug = base[i] + '-' + n;
    used.add(slug);
    return slug;
  });
}

const OLD_RULE = 'Grok merges `claude-wip` → `main` and owns HUD / `?v=` tags.';
const NEW_RULE = [
  'Grok merges `claude-wip` → `main` and owns the HUD. `?v=` tags are nobody\'s to pick: run `npm run stamp` before you open the PR.',
  '',
  '**Handoff notes are one file per ticket.** Add `docs/handoff/<your-ticket>.md` (start it with a `## ` heading)',
  'and run `npm run handoff:index`; do not append to this file. After a rebase, run the index again rather than',
  'merging its list by hand. The list below is generated.',
].join('\n');

function main() {
  const text = readFileSync(FILE, 'utf8');
  const { preamble, parts } = sections(text);
  if (!parts.length) {
    console.log('migrate-handoff: docs/HANDOFF.md has no sections - already migrated, nothing to do');
    return;
  }
  if (preamble + parts.map((p) => p.body).join('') !== text) throw new Error('split is not lossless - refusing to write');
  const slugs = names(parts);
  mkdirSync(DIR, { recursive: true });
  parts.forEach((p, i) => writeFileSync(join(DIR, slugs[i] + '.md'), p.body.replace(/\n+$/, '\n')));
  const head = (preamble.includes(OLD_RULE) ? preamble.replace(OLD_RULE, NEW_RULE) : preamble).replace(/\n+$/, '\n');
  writeFileSync(FILE, head + '\n' + indexBlock(DIR) + '\n');
  console.log(`migrate-handoff: ${parts.length} sections -> docs/handoff/ (${parts.length} files), docs/HANDOFF.md is the preamble and an index`);
}

if (process.argv[1] && join(process.argv[1]) === fileURLToPath(import.meta.url)) main();
