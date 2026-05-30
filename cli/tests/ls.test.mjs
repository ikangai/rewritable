// Tests for `rwa ls` — collection-scale self-description.
//
// Where `rwa doc` answers "what is THIS file?", `rwa ls` answers "what are all
// these?" — hand it a folder (or file list) and it reports each rewritable's
// one-line identity (kind · title · affordances) and flags non-rewritables. It
// reuses inspectDoc's self-description/1 projection per file, so an agent learns
// a project's whole rewritable inventory in one call. These tests pin that
// contract: the JSON rows carry the same self-description the oracle computes,
// non-rewritables are detected (not crashed on), and the scan is lenient (a bad
// path is a row, not a fatal exit).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replaceInlineDoc } from '../src/seed.mjs';
import { validateSelfDescription } from '../../tools/self-description.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RWA_BIN = join(__dirname, '..', 'bin', 'rwa.mjs');

function runRwa(args, { cwd } = {}) {
  return new Promise(resolve => {
    const child = spawn('node', [RWA_BIN, ...args], cwd ? { cwd } : {});
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.stdin.end();
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

// A temp dir holding two rewritables (a titled document, a presentation) and a
// plain non-rewritable .html — the realistic mixed folder an agent is handed.
function mkDir() {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-ls-test-'));
  const docPath = join(dir, 'report.html');
  execFileSync('node', [RWA_BIN, 'new', docPath], { stdio: 'pipe' });
  writeFileSync(docPath, replaceInlineDoc(readFileSync(docPath, 'utf8'),
    '<article><h1>Status Report</h1><p>Body.</p></article>'), 'utf8');
  const presPath = join(dir, 'deck.html');
  execFileSync('node', [RWA_BIN, 'new', presPath, '--kind', 'presentation'], { stdio: 'pipe' });
  const plainPath = join(dir, 'plain.html');
  writeFileSync(plainPath, '<!doctype html><html><body><p>just a page</p></body></html>', 'utf8');
  return { dir, docPath, presPath, plainPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const byFile = (rows, name) => rows.find(r => basename(r.file) === name);

// ─── JSON mode: the inventory an agent consumes ───────────────────────

test('--json reports each rewritable in a directory with its self-description', async () => {
  const fx = mkDir();
  try {
    const { code, stdout, stderr } = await runRwa(['ls', fx.dir, '--json']);
    assert.equal(code, 0);
    assert.equal(stderr, '');
    const rows = JSON.parse(stdout);
    assert.equal(rows.length, 3);

    const report = byFile(rows, 'report.html');
    assert.equal(report.status, 'rewritable');
    assert.equal(report.self.kind, 'document');
    assert.equal(report.self.title, 'Status Report');
    assert.deepEqual(report.self.affordances, []);

    const deck = byFile(rows, 'deck.html');
    assert.equal(deck.status, 'rewritable');
    assert.equal(deck.self.kind, 'presentation');
    assert.deepEqual(deck.self.affordances.map(a => a.kind), ['view']);

    const plain = byFile(rows, 'plain.html');
    assert.equal(plain.status, 'not_a_rewritable');
    assert.equal(plain.self, undefined);
  } finally { fx.cleanup(); }
});

test('--json rows carry a valid self-description/1 object (oracle-checked)', async () => {
  const fx = mkDir();
  try {
    const { stdout } = await runRwa(['ls', fx.dir, '--json']);
    const rows = JSON.parse(stdout).filter(r => r.status === 'rewritable');
    assert.ok(rows.length >= 1);
    for (const r of rows) {
      const { valid, errors } = validateSelfDescription(r.self);
      assert.ok(valid, `row ${r.file} should carry a valid self-description; errors: ${errors.join('; ')}`);
    }
  } finally { fx.cleanup(); }
});

test('--json accepts explicit file paths, not just a directory', async () => {
  const fx = mkDir();
  try {
    const { code, stdout } = await runRwa(['ls', fx.docPath, fx.presPath, '--json']);
    assert.equal(code, 0);
    const rows = JSON.parse(stdout);
    assert.equal(rows.length, 2);
    assert.ok(rows.every(r => r.status === 'rewritable'));
  } finally { fx.cleanup(); }
});

test('--json marks a missing path as an error row, but the scan still exits 0', async () => {
  // Why: ls is lenient like its namesake — one bad path among many must not
  // abort the inventory. The agent reads the per-row status and branches.
  const fx = mkDir();
  try {
    const { code, stdout } = await runRwa(['ls', fx.docPath, join(fx.dir, 'nope.html'), '--json']);
    assert.equal(code, 0);
    const rows = JSON.parse(stdout);
    assert.equal(byFile(rows, 'report.html').status, 'rewritable');
    assert.equal(byFile(rows, 'nope.html').status, 'error');
    assert.equal(byFile(rows, 'nope.html').reason, 'not_found');
  } finally { fx.cleanup(); }
});

test('no positional args scans the current directory', async () => {
  const fx = mkDir();
  try {
    const { code, stdout } = await runRwa(['ls', '--json'], { cwd: fx.dir });
    assert.equal(code, 0);
    const rows = JSON.parse(stdout);
    assert.equal(rows.length, 3);
  } finally { fx.cleanup(); }
});

// ─── Plain mode: the human-readable inventory ─────────────────────────

test('plain mode prints kind, title and file for each rewritable', async () => {
  const fx = mkDir();
  try {
    const { code, stdout } = await runRwa(['ls', fx.dir]);
    assert.equal(code, 0);
    assert.match(stdout, /presentation/);
    assert.match(stdout, /Status Report/);
    assert.match(stdout, /deck\.html/);
    assert.match(stdout, /report\.html/);
  } finally { fx.cleanup(); }
});

test('plain mode summarises how many rewritables vs other files were found', async () => {
  const fx = mkDir();
  try {
    const { stdout } = await runRwa(['ls', fx.dir]);
    // 2 rewritables, 1 non-rewritable — surfaced so the count is never silently
    // truncated (the non-rewritable must be acknowledged, not hidden).
    assert.match(stdout, /2 rewritable/);
    assert.match(stdout, /1 other|1 non-rewritable|plain\.html/);
  } finally { fx.cleanup(); }
});
