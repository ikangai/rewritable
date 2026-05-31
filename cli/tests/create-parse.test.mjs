// `rwa create` argument parsing + the shared template-first frame resolver
// (design 2026-05-31 §4.1/§4.2). Two pure-ish units:
//   parseCreateArgs(argv)  — structural: separate flags (with values) from the
//                            positional task words. No IO, no kind resolution.
//   resolveBareWord(word,cwd) — the ONE resolver shared with `rwa new` (§3.2):
//                            a cwd data-rwa-template match first, else a built-in
//                            kind, else null. (IO: scans cwd.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCreateArgs } from '../src/create.mjs';
import { resolveBareWord } from '../src/template.mjs';
import { replaceInlineDoc } from '../src/seed.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RWA_BIN = join(__dirname, '..', 'bin', 'rwa.mjs');

// ─── parseCreateArgs: flags vs task words ─────────────────────────────

test('collects the whole positional tail as task words', () => {
  const p = parseCreateArgs(['a', 'presentation', 'about', 'Q3']);
  assert.deepEqual(p.words, ['a', 'presentation', 'about', 'Q3']);
  assert.equal(p.kind, null);
});

test('--kind/--from/--data/--out are value flags kept out of the task words', () => {
  const p = parseCreateArgs([
    'visualize', 'tokens',
    '--kind', 'document', '--from', 'base.html', '--data', 'd.json', '--out', 'o.html',
  ]);
  assert.equal(p.kind, 'document');
  assert.equal(p.from, 'base.html');
  assert.equal(p.data, 'd.json');
  assert.equal(p.out, 'o.html');
  assert.deepEqual(p.words, ['visualize', 'tokens']);
});

test('a value-flag argument is never mistaken for a task word', () => {
  // WHY: "document" here is --kind's value, not part of the brief; the brief is
  // exactly "make a deck".
  const p = parseCreateArgs(['make', 'a', 'deck', '--kind', 'document']);
  assert.deepEqual(p.words, ['make', 'a', 'deck']);
  assert.equal(p.kind, 'document');
});

test('boolean flags --force/-f and --open/-o are recognized, not task words', () => {
  const p = parseCreateArgs(['hello', '--force', '--open']);
  assert.equal(p.force, true);
  assert.equal(p.open, true);
  assert.deepEqual(p.words, ['hello']);
});

test('backend flags are captured under backend{} and excluded from words', () => {
  const p = parseCreateArgs([
    'topic', '--backend', 'ollama', '--model', 'llama3', '--base-url', 'http://x/v1', '--api-key', 'k',
  ]);
  assert.equal(p.backend.name, 'ollama');
  assert.equal(p.backend.model, 'llama3');
  assert.equal(p.backend.baseUrl, 'http://x/v1');
  assert.equal(p.backend.apiKey, 'k');
  assert.deepEqual(p.words, ['topic']);
});

// ─── resolveBareWord: the shared template-first resolver ──────────────

function mkRwa(path, body) {
  execFileSync('node', [RWA_BIN, 'new', path], { stdio: 'pipe' });
  if (body) writeFileSync(path, replaceInlineDoc(readFileSync(path, 'utf8'), body), 'utf8');
}

test('resolveBareWord returns a built-in kind when no template matches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-frame-'));
  try {
    const r = await resolveBareWord('presentation', dir);
    assert.equal(r.source, 'kind');
    assert.equal(r.kind, 'presentation');
    assert.equal(r.body, null); // body comes from kindOverrides, not a template
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resolveBareWord prefers a cwd template over the built-in kind (template-first)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-frame-'));
  try {
    mkRwa(join(dir, 'deck.html'), '<article data-rwa-template="presentation"><h1>Mine</h1></article>');
    const r = await resolveBareWord('presentation', dir);
    assert.equal(r.source, 'template');
    assert.equal(r.kind, 'document');            // a cloned instance is a document
    assert.match(r.body, /Mine/);                 // the template body
    assert.doesNotMatch(r.body, /data-rwa-template/); // label stripped on the clone
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resolveBareWord returns null for a word that is neither template nor kind', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-frame-'));
  try {
    assert.equal(await resolveBareWord('bogusword', dir), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
