// rwa new <bare-word> dispatch — a bare first positional resolves template-first,
// then falls back to a built-in kind (design 2026-05-31, §3.2). Before this change
// `rwa new presentation` errored ("no rwa file labeled presentation") because the
// bare word was treated as a template name only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replaceInlineDoc } from '../src/seed.mjs';

const execFileP = promisify(execFile);
const here = fileURLToPath(new URL('.', import.meta.url));
const RWA = join(here, '..', 'bin', 'rwa.mjs');

const run = (args, cwd) => execFileP('node', [RWA, ...args], { cwd });
const mkTmp = () => mkdtemp(join(tmpdir(), 'rwa-newdispatch-'));

test('rwa new presentation (no template) creates the built-in presentation kind', async () => {
  // WHY: the bare word names a built-in kind; with no cwd template to clone, it
  // must fall through to that kind, not error. This is the original bug report.
  const dir = await mkTmp();
  try {
    await run(['new', 'presentation'], dir);
    // default out path for a kind clone is ./presentation-YYYY-MM-DD.html
    const entries = await readFile(join(dir, await onlyHtml(dir)), 'utf8');
    assert.match(entries, /const PRODUCT_KIND = 'presentation'/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rwa new workflow (no template) creates the built-in workflow kind', async () => {
  // WHY: the fallback is general to KNOWN_KINDS, not special-cased to presentation.
  const dir = await mkTmp();
  try {
    await run(['new', 'workflow'], dir);
    const text = await readFile(join(dir, await onlyHtml(dir)), 'utf8');
    assert.match(text, /const PRODUCT_KIND = 'workflow'/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a cwd template named like a kind wins over the built-in (template-first)', async () => {
  // WHY: template-first precedence (ratified) — a user who labels their own deck
  // data-rwa-template="presentation" must override the built-in starter.
  const dir = await mkTmp();
  try {
    await run(['new', 'source.html'], dir);
    // Inject a real labeled body (the blank starter has no <article>, so a naive
    // string-replace would no-op). replaceInlineDoc is the same splice the CLI uses.
    const src = await readFile(join(dir, 'source.html'), 'utf8');
    const labeled = replaceInlineDoc(src, '<article data-rwa-template="presentation"><h1>My deck</h1></article>');
    await writeFile(join(dir, 'source.html'), labeled);
    await run(['new', 'presentation', 'clone.html'], dir);
    const clone = await readFile(join(dir, 'clone.html'), 'utf8');
    // Cloned from a document-kind source → PRODUCT_KIND stays 'document'
    // (the clone is an instance, not the built-in presentation starter).
    assert.match(clone, /const PRODUCT_KIND = 'document'/);
    // and the template label is stripped from the clone's body.
    assert.doesNotMatch(clone, /data-rwa-template="presentation"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rwa new bogusword (no template, not a kind) errors naming the known kinds', async () => {
  // WHY: an unknown bare word is neither a template nor a kind; the error must
  // name both misses so the user knows their options (lists KNOWN_KINDS, no
  // hardcoded triple).
  const dir = await mkTmp();
  try {
    await assert.rejects(
      run(['new', 'bogusword'], dir),
      (err) => {
        const msg = String(err.stderr || err.message);
        assert.match(msg, /bogusword/);
        assert.match(msg, /presentation/); // a known kind is listed
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The kind-clone default output name is ./<kind>-YYYY-MM-DD.html; find the one
// .html the run produced without hardcoding today's date.
async function onlyHtml(dir) {
  const { readdir } = await import('node:fs/promises');
  const names = (await readdir(dir)).filter(n => /\.html?$/i.test(n));
  assert.equal(names.length, 1, `expected exactly one .html, got ${names.join(', ')}`);
  return names[0];
}
