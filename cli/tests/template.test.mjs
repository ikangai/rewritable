// Tests for `rwa new <kind>` template discovery + cloning (cli/src/template.mjs).
//
// The model (docs/plans/2026-05-05-cli-templates-design.md): a user labels one
// rwa file per kind with data-rwa-template="<kind>" on its body's first element;
// `rwa new <kind>` scans cwd, finds the labeled file, and clones it (pristine
// seed + the template's INLINE_DOC, fresh UUID, label stripped). "The file you
// made yesterday is the template for the file you make tomorrow." These pin the
// discovery rules (match / no-match / multi-match-by-mtime / skip-malformed) and
// the label strip.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replaceInlineDoc, extractInlineDoc } from '../src/seed.mjs';
import { findTemplate, stripTemplateAttribute } from '../src/template.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RWA_BIN = join(__dirname, '..', 'bin', 'rwa.mjs');

// Build a real rwa container at `path` whose body carries the given template label.
function mkTemplate(path, label, body = '<article data-rwa-template="LABEL"><h1>Invoice</h1><p>Body.</p></article>') {
  execFileSync('node', [RWA_BIN, 'new', path], { stdio: 'pipe' });
  const filled = body.replace('LABEL', label);
  writeFileSync(path, replaceInlineDoc(readFileSync(path, 'utf8'), filled), 'utf8');
}

// ─── stripTemplateAttribute: a pure label strip on the first tag ──────

test('stripTemplateAttribute removes the label and preserves other attributes', () => {
  assert.equal(
    stripTemplateAttribute('<article class="x" data-rwa-template="invoice"><h1>T</h1></article>'),
    '<article class="x"><h1>T</h1></article>',
  );
});

test('stripTemplateAttribute is a no-op when there is no label', () => {
  const body = '<article><h1>T</h1></article>';
  assert.equal(stripTemplateAttribute(body), body);
});

test('stripTemplateAttribute only strips the FIRST element, not a later mention', () => {
  // The label is author metadata on the root; a later occurrence (e.g. in prose)
  // is not the template marker and must survive.
  const body = '<article data-rwa-template="invoice"><p>about data-rwa-template="x"</p></article>';
  assert.equal(stripTemplateAttribute(body), '<article><p>about data-rwa-template="x"</p></article>');
});

// ─── findTemplate: discovery in a directory ───────────────────────────

test('findTemplate finds the single labeled container and returns its body', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-tmpl-'));
  try {
    mkTemplate(join(dir, 'invoice.html'), 'invoice');
    mkTemplate(join(dir, 'letter.html'), 'letter');
    const t = await findTemplate(dir, 'invoice');
    assert.ok(t, 'expected a match');
    assert.equal(basename(t.path), 'invoice.html');
    assert.match(t.inlineDoc, /data-rwa-template="invoice"/); // raw body (strip happens at clone)
    assert.ok(t.inlineDoc.includes('Invoice'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('findTemplate returns null when no file carries the label', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-tmpl-'));
  try {
    mkTemplate(join(dir, 'letter.html'), 'letter');
    execFileSync('node', [RWA_BIN, 'new', join(dir, 'plain.html')], { stdio: 'pipe' }); // unlabeled rwa
    writeFileSync(join(dir, 'notrwa.html'), '<!doctype html><p>not an rwa file</p>'); // skipped by pre-check
    assert.equal(await findTemplate(dir, 'invoice'), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('findTemplate picks the most-recently-modified file when several match', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-tmpl-'));
  try {
    const older = join(dir, 'invoice-old.html');
    const newer = join(dir, 'invoice-new.html');
    mkTemplate(older, 'invoice');
    mkTemplate(newer, 'invoice');
    // Make `older` genuinely older regardless of write order.
    const past = Date.now() / 1000 - 3600;
    utimesSync(older, past, past);
    const t = await findTemplate(dir, 'invoice');
    assert.equal(basename(t.path), 'invoice-new.html');
    assert.equal(t.ambiguous, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('findTemplate skips a malformed candidate and still finds a valid one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-tmpl-'));
  try {
    // A file that pre-checks as rwa (has the bootstrap id) but has corrupt INLINE_DOC.
    writeFileSync(join(dir, 'broken.html'), '<script id="rwa-bootstrap">INLINE_DOC = `unterminated');
    mkTemplate(join(dir, 'good.html'), 'invoice');
    const t = await findTemplate(dir, 'invoice');
    assert.equal(basename(t.path), 'good.html');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ─── End-to-end: `rwa new <kind>` clones the labeled file ─────────────

function runRwa(args, { cwd } = {}) {
  try {
    const out = execFileSync('node', [RWA_BIN, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, stdout: out, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '' };
  }
}
const uuidOf = (file) => (readFileSync(file, 'utf8').match(/const DOC_UUID = '([0-9a-f-]{36})'/) || [])[1];

test('rwa new <kind> clones the template: fresh UUID, label stripped, body preserved', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-tmpl-'));
  try {
    const tmplPath = join(dir, 'invoice.html');
    mkTemplate(tmplPath, 'invoice');
    const { code, stdout } = runRwa(['new', 'invoice', 'out.html'], { cwd: dir });
    assert.equal(code, 0);
    assert.match(stdout, /from template/);
    const out = join(dir, 'out.html');
    const body = extractInlineDoc(readFileSync(out, 'utf8'));
    // body content preserved, label stripped, instance is its own container.
    assert.ok(body.includes('Invoice') && body.includes('Body.'), 'template body must be cloned');
    assert.ok(!body.includes('data-rwa-template'), 'the template label must be stripped on the clone');
    assert.notEqual(uuidOf(out), uuidOf(tmplPath), 'the clone must get a fresh DOC_UUID');
    assert.match(uuidOf(out), /^[0-9a-f-]{36}$/);
    // and it is a valid rwa the rest of the CLI can read.
    const doc = runRwa(['doc', out, '--json'], { cwd: dir });
    assert.equal(JSON.parse(doc.stdout).kind, 'document'); // a cloned instance is a document
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rwa new <kind> with no labeled file in cwd errors (exit 2) with a hint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-tmpl-'));
  try {
    const { code, stderr } = runRwa(['new', 'invoice'], { cwd: dir });
    assert.equal(code, 2);
    assert.match(stderr, /no rwa file in .* is labeled "invoice"/);
    assert.match(stderr, /data-rwa-template="invoice"/); // the fix hint
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rwa new <path>.html is an output path, not a template name (back-compat)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-tmpl-'));
  try {
    // Even with a labeled "blank.html" present, `rwa new blank.html` writes a
    // blank doc at blank.html — a .html positional is an outPath, not a kind.
    const { code } = runRwa(['new', 'fresh.html'], { cwd: dir });
    assert.equal(code, 0);
    const body = extractInlineDoc(readFileSync(join(dir, 'fresh.html'), 'utf8'));
    assert.ok(!body.includes('data-rwa-template')); // a plain blank container
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
