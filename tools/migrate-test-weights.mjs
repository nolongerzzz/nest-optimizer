#!/usr/bin/env node
/**
 * nest-optimizer / tools / migrate-test-weights.mjs
 *
 * Moves package.json's `testStepWeights` map and `testStepWeightsNote` into
 * tools/test-weights.json - one step per line, {"weight": N, "note": "..."} -
 * and deletes both keys from package.json.
 *
 * WHY. Every batch re-measured or added a weight, and the map, the note's one
 * 6 000-character paragraph and `testSteps` all sat in package.json, so two PRs
 * edited the same lines. In test-weights.json each step is its own line,
 * sorted by name, and its note rides on that line.
 *
 *   node tools/migrate-test-weights.mjs
 *
 * Re-runnable on any tree. Where package.json has no testStepWeights it does
 * nothing (the tree is migrated). Where it still has them - a rebase that took
 * the other side of package.json, say - the file is regenerated from
 * package.json, which is then the newer of the two. The note's per-step
 * annotations ("name 1234 (how it was measured)") become that step's "note";
 * the rest of the prose is kept as the file's "about". Whatever the parser
 * cannot attach to a step stays in "about", verbatim: nothing is dropped.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = join(ROOT, 'package.json');
const OUT = join(ROOT, 'tools', 'test-weights.json');

/* One step per line, sorted by name, so an added or re-measured step is a
   one-line diff nobody else's line sits next to. */
export function formatWeights({ about, source, steps }) {
  const names = Object.keys(steps).sort();
  const head = ['{', '  "about": [', ...about.map((l, i) => `    ${JSON.stringify(l)}${i < about.length - 1 ? ',' : ''}`), '  ],'];
  if (source) head.push(`  "source": ${JSON.stringify(source)},`);
  head.push('  "steps": {');
  const body = names.map((n, i) =>
    `    ${JSON.stringify(n)}: ${JSON.stringify({ weight: steps[n].weight, note: steps[n].note || '' })}${i < names.length - 1 ? ',' : ''}`);
  return [...head, ...body, '  }', '}', ''].join('\n');
}

/* Splits `text` at `sep` where no parenthesis is open. */
function splitTop(text, sep) {
  const out = [];
  let d = 0, cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') d++;
    else if (ch === ')') d--;
    if (d === 0 && text.startsWith(sep, i)) { out.push(cur); cur = ''; i += sep.length - 1; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/* "a 10 and b 20 (how)" -> a and b both get "how". Returns [[name, note]]. */
function readItem(item, known) {
  const parts = splitTop(item, ' and ').map((p) => {
    const open = p.indexOf('(');
    const close = p.lastIndexOf(')');
    const head = (open < 0 ? p : p.slice(0, open)).trim();
    const paren = open < 0 ? '' : p.slice(open + 1, close < open ? p.length : close).trim();
    const names = head.split(/\s+/).filter((t) => known.has(t));
    const first = names[0];
    const extra = first && !new RegExp('^' + first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+\\d+$').test(head)
      ? head.slice(head.indexOf(first) + first.length).trim() : '';
    return { names, note: [extra, paren].filter(Boolean).join(': ') };
  });
  const out = [];
  parts.forEach((p, i) => {
    let note = p.note;
    for (let j = i + 1; !note && j < parts.length; j++) note = parts[j].note; // "a 1 and b 2 (shared)"
    p.names.forEach((n) => out.push([n, note]));
  });
  return out;
}

export function split(pkg) {
  const weights = pkg.testStepWeights;
  const lines = pkg.testStepWeightsNote || [];
  const known = new Set(Object.keys(weights));
  const steps = {};
  for (const [n, w] of Object.entries(weights)) steps[n] = { weight: w, note: '' };

  /* The estimates are listed after "...measures them:". Two layouts have existed:
     one long line "measures them: a 1 (..); b 2 (..)", and indented wrapped lines
     "  a 1 (..)." under a line ending "measures them:". */
  const at = lines.findIndex((l) => /measures them:/.test(l));
  let about = lines.slice();
  let attached = 0, leftover = [];
  if (at >= 0) {
    let end = at + 1;
    let text = lines[at].replace(/^.*?measures them:\s*/, '');
    while (end < lines.length && /^\s+\S/.test(lines[end])) text += ' ' + lines[end++].trim();
    text = text.replace(/\)\.(\s+)(?=\S+ \d)/g, '); ').replace(/\.\s*$/, '');
    const items = splitTop(text, '; ').map((x) => x.trim()).filter(Boolean);
    for (const item of items) {
      const got = readItem(item, known);
      if (!got.length) { leftover.push(item); continue; }
      for (const [n, note] of got) {
        steps[n].note = steps[n].note ? steps[n].note + ' | ' + note : note;
        attached++;
      }
    }
    about = [...lines.slice(0, at), lines[at].replace(/measures them:.*$/, 'measures them:'),
      '(how each estimate was made is that step\'s own "note" in this file)',
      ...(leftover.length ? ['Not attached to a step: ' + leftover.join('; ')] : []),
      ...lines.slice(end)];
  }
  about = about.map((l) => l.replace(/testStepWeightsSource/g, 'this file\'s "source"'));
  return { steps, about, source: pkg.testStepWeightsSource || '', attached, leftover };
}

function main() {
  const text = readFileSync(PKG, 'utf8');
  const pkg = JSON.parse(text);
  if (!pkg.testStepWeights) {
    console.log('migrate-test-weights: package.json has no testStepWeights - already migrated, nothing to do');
    return;
  }
  const r = split(pkg);
  writeFileSync(OUT, formatWeights(r));
  delete pkg.testStepWeights;
  delete pkg.testStepWeightsNote;
  delete pkg.testStepWeightsSource;
  writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n');
  const steps = Object.keys(r.steps);
  console.log(`migrate-test-weights: ${steps.length} steps -> tools/test-weights.json ` +
    `(${steps.filter((n) => r.steps[n].note).length} with a note, ${r.attached} annotations attached, ${r.leftover.length} left in "about")`);
}

if (process.argv[1] && join(process.argv[1]) === fileURLToPath(import.meta.url)) main();
