// The CLI's eagerly-loaded module graph must stay dependency-free.
//
// `bin/rwa.mjs` statically imports `commands.mjs`, which statically imported
// `import.mjs` / `import-vision.mjs` / `import-claude.mjs`, which pull marked,
// mammoth, papaparse and pdfjs-dist. So EVERY invocation loaded all four —
// `rwa doc`, `rwa edit`, `rwa render`, even `--version` — and on any checkout
// without `cli/node_modules` populated they all died on a dependency they never
// use.
//
// That is invisible on a developer machine, where node_modules always exists. It
// showed up only in CI, as the browser lane failing with ERR_MODULE_NOT_FOUND
// 'marked' from `rwa render` — a verb whose own module graph (cdp/seed/edit) is
// dependency-free. The tempting fix was an `npm ci` step in that job, which would
// have turned the lane green and left the real defect in place: a tool meant to be
// the door an agent reads a document through should not need a PDF parser to do it.
//
// This guards the GENERAL form rather than the one instance. It walks the static
// import graph from the bin and fails if anything eagerly reachable imports a bare
// specifier. Dynamic `import()` inside a function is invisible to it, which is
// exactly right: that is the mechanism for making a heavy dependency opt-in.
//
// Deliberately a static scan, not a runtime probe: you cannot observe "would this
// fail without node_modules" from a process that has node_modules.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..');
const ENTRY = join(CLI, 'bin', 'rwa.mjs');

// Static `import … from '…'` only. A dynamic import() is a deliberate opt-in and
// must NOT be followed — that is the whole point of the distinction.
const STATIC_IMPORT_RE = /^\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gm;

/** Every module reachable from `entry` through STATIC imports, plus the bare specifiers found. */
function eagerGraph(entry) {
  const seen = new Set();
  const bare = new Map();          // specifier → the file that eagerly imports it
  const queue = [resolve(entry)];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(STATIC_IMPORT_RE)) {
      const spec = m[1];
      if (spec.startsWith('node:')) continue;                  // built-ins are free
      if (spec.startsWith('.') || spec.startsWith('/')) {
        queue.push(resolve(dirname(file), spec));
        continue;
      }
      if (!bare.has(spec)) bare.set(spec, file);
    }
  }
  return { modules: seen, bare };
}

test('the CLI entry point loads no third-party dependency eagerly', () => {
  const { bare, modules } = eagerGraph(ENTRY);
  assert.ok(modules.size > 5, `the walk must actually traverse (saw ${modules.size} modules)`);

  const offenders = [...bare.entries()].map(([spec, file]) => `${spec}  (from ${file.replace(CLI + '/', '')})`);
  assert.deepEqual(offenders, [],
    'these are loaded on EVERY rwa invocation, so the CLI cannot run without them installed.\n' +
    'Make the import dynamic inside the function that needs it, as commands.mjs does for the\n' +
    'document-conversion stack — do not add an npm ci step to whichever CI job noticed.');
});

test('the heavy conversion stack is still reachable — just not eagerly', () => {
  // The complement, so the fix cannot degenerate into "delete the feature".
  // import.mjs must still exist, still import its dependencies, and still be
  // reached by commands.mjs — dynamically.
  const importMjs = readFileSync(join(CLI, 'src', 'import.mjs'), 'utf8');
  assert.match(importMjs, /from 'marked'/, 'import.mjs still uses its dependencies');

  const commands = readFileSync(join(CLI, 'src', 'commands.mjs'), 'utf8');
  assert.match(commands, /import\('\.\/import\.mjs'\)/, 'commands.mjs reaches it via dynamic import()');
  assert.doesNotMatch(commands, /^\s*import\s+\{[^}]*\}\s+from\s+'\.\/import\.mjs'/m,
    'and never statically');

  // And it is genuinely NOT in the eager graph.
  const { modules } = eagerGraph(ENTRY);
  assert.equal([...modules].some(f => f.endsWith('/src/import.mjs')), false);
});

test('the guard actually walks — negative control', () => {
  // A walk that silently found nothing would report an empty offender list and
  // pass forever. Point it at a file that DOES import a bare specifier and
  // require it to be caught.
  const { bare } = eagerGraph(join(CLI, 'src', 'import.mjs'));
  assert.ok(bare.size > 0, 'walking import.mjs must surface its bare specifiers');
  assert.ok([...bare.keys()].includes('marked'), 'including marked');
});
