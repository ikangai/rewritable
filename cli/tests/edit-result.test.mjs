// Tests for the `rwa edit` SUCCESS surface (#30) — the return channel of the
// two-agent collaboration.
//
// WHY these assertions matter, not just what they check: an external agent that
// delegates an edit deliberately never reads the document body (that is the cost
// delegation exists to avoid). So the result object is the ONLY thing it can
// audit. Three properties have to hold or delegation is fire-and-forget:
//
//   1. the apply reports what it did (tool, how many edits, resulting size);
//   2. the hashes chain — this edit's newHash is the next edit's baseHash, which
//      is what makes the #31 compare-and-swap usable at all;
//   3. success lands on STDOUT and failure on STDERR, so a caller can tell the
//      two apart from the streams alone without parsing.
//
// Assertion 2 is also the load-bearing cross-surface property: the same bytes
// must hash identically here and in the hosted runtime, or an agent that reads
// from one surface cannot reason about staleness on the other. The hosted half
// of that identity is pinned in service/tests/hash-parity.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyPlan, bodyHash } from '../src/edit.mjs';
import { replaceInlineDoc, extractInlineDoc } from '../src/seed.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RWA_BIN = join(__dirname, '..', 'bin', 'rwa.mjs');

function mkFixture(inlineDocBody = '<article><h1>Old</h1><p>Body text.</p></article>') {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-editresult-'));
  const path = join(dir, 'test.html');
  execFileSync('node', [RWA_BIN, 'new', path], { stdio: 'pipe' });
  writeFileSync(path, replaceInlineDoc(readFileSync(path, 'utf8'), inlineDocBody), 'utf8');
  return { path, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const HEX64 = /^[0-9a-f]{64}$/;

// ─── The result object ─────────────────────────────────────────────────

test('#30: apply_edits reports tool, edit count, hashes and size', async () => {
  const fx = mkFixture();
  try {
    const before = extractInlineDoc(readFileSync(fx.path, 'utf8'));
    const result = await applyPlan(fx.path, {
      version: 'rwa-edit/1',
      edits: [{ find: 'Old', replace: 'New' }, { find: 'Body text.', replace: 'Fresh text.' }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.tool, 'apply_edits');
    assert.equal(result.applied, 2, 'both edits are counted, not just the batch');
    assert.match(result.baseHash, HEX64);
    assert.match(result.newHash, HEX64);
    // baseHash describes the doc as it was BEFORE the edit — that is what makes
    // it usable as the staleness token a caller could have supplied.
    assert.equal(result.baseHash, bodyHash(before));
    const after = extractInlineDoc(readFileSync(fx.path, 'utf8'));
    assert.equal(result.newHash, bodyHash(after));
    assert.equal(result.bytes, after.length);
    assert.notEqual(result.baseHash, result.newHash);
  } finally { fx.cleanup(); }
});

test('#30: hashes chain across successive edits (the basis of #31 CAS)', async () => {
  const fx = mkFixture();
  try {
    const first = await applyPlan(fx.path, { version: 'rwa-edit/1', edits: [{ find: 'Old', replace: 'Mid' }] });
    const second = await applyPlan(fx.path, { version: 'rwa-edit/1', edits: [{ find: 'Mid', replace: 'New' }] });
    // Without this the compare-and-swap in #31 cannot be built on the result:
    // a caller has to be able to carry the hash forward rather than re-read.
    assert.equal(second.baseHash, first.newHash);
  } finally { fx.cleanup(); }
});

test('#30: replace_document reports one wholesale write', async () => {
  const fx = mkFixture();
  try {
    const result = await applyPlan(fx.path, {
      version: 'rwa-edit/1',
      doc: '<article><h1>Rewritten</h1></article>',
      reason: 'testing the escape hatch result shape',
    });
    assert.equal(result.tool, 'replace_document');
    assert.equal(result.applied, 1);
    assert.equal(result.compiledTo, undefined, 'a direct replace_document did not compile from anything');
  } finally { fx.cleanup(); }
});

test('#30: a DSL plan reports the requested tool AND what it compiled to', async () => {
  const fx = mkFixture();
  try {
    const result = await applyPlan(fx.path, {
      version: 'rwa-edit-dsl/1',
      ops: [{ op: 'replace', find: 'Old', replace: 'New' }],
    });
    // The caller asked for a DSL plan; knowing it compiled to apply_edits is the
    // difference between "my structural transform ran" and "something ran".
    assert.equal(result.tool, 'apply_dsl_plan');
    assert.equal(result.compiledTo, 'apply_edits');
    assert.equal(result.applied, 1);
  } finally { fx.cleanup(); }
});

test('#30: hashes describe the REAL body, never the virtualized form', async () => {
  // An image-bearing doc is applied on the token form, but the hash a caller
  // compares against `rwa doc` / the hosted /doc must be over the real bytes —
  // otherwise the number is self-consistent and useless to everyone else.
  const png = 'data:image/png;base64,iVBORw0KGgo' + 'A'.repeat(400);
  const fx = mkFixture(`<article><h1>Old</h1><img src="${png}" alt="chart"></article>`);
  try {
    const result = await applyPlan(
      fx.path,
      { version: 'rwa-edit/1', edits: [{ find: '<h1>Old</h1>', replace: '<h1>New</h1>' }] },
      { virtualImages: true },
    );
    const after = extractInlineDoc(readFileSync(fx.path, 'utf8'));
    assert.ok(after.includes(png), 'the image bytes survived the round trip');
    assert.equal(result.newHash, bodyHash(after), 'newHash is over the expanded body');
    assert.equal(result.bytes, after.length, 'bytes counts real bytes, not tokens');
  } finally { fx.cleanup(); }
});

// ─── The CLI surface: which stream carries what ────────────────────────

test('#30: --json puts the result on stdout and leaves stderr clean', () => {
  const fx = mkFixture();
  try {
    const planPath = join(fx.dir, 'plan.json');
    writeFileSync(planPath, JSON.stringify({ version: 'rwa-edit/1', edits: [{ find: 'Old', replace: 'New' }] }));
    const r = spawnSync('node', [RWA_BIN, 'edit', fx.path, '--plan', planPath, '--json'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '', 'a successful edit says nothing on the error stream');
    const payload = JSON.parse(r.stdout.trim());
    assert.equal(payload.ok, true);
    assert.equal(payload.tool, 'apply_edits');
    assert.match(payload.newHash, HEX64);
    assert.equal(payload.exitCode, undefined, 'the internal exitCode field is not part of the wire shape');
  } finally { fx.cleanup(); }
});

test('#30: plain mode prints a one-line summary to stdout', () => {
  const fx = mkFixture();
  try {
    const planPath = join(fx.dir, 'plan.json');
    writeFileSync(planPath, JSON.stringify({ version: 'rwa-edit/1', edits: [{ find: 'Old', replace: 'New' }] }));
    const r = spawnSync('node', [RWA_BIN, 'edit', fx.path, '--plan', planPath], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim().split('\n').length, 1, 'one line, so it stays greppable');
    assert.match(r.stdout, /apply_edits/);
    assert.match(r.stdout, /1 edit applied/);
  } finally { fx.cleanup(); }
});

test('#30: failure still goes to stderr with an empty stdout', () => {
  const fx = mkFixture();
  try {
    const planPath = join(fx.dir, 'plan.json');
    writeFileSync(planPath, JSON.stringify({ version: 'rwa-edit/1', edits: [{ find: 'NotPresent', replace: 'x' }] }));
    const r = spawnSync('node', [RWA_BIN, 'edit', fx.path, '--plan', planPath, '--json'], { encoding: 'utf8' });
    assert.equal(r.status, 3);
    // The stream split is the contract: a caller distinguishes success from
    // failure without parsing either payload.
    assert.equal(r.stdout, '', 'nothing is reported as a result when nothing was applied');
    const err = JSON.parse(r.stderr.trim());
    assert.equal(err.subcode, 'find_not_found');
  } finally { fx.cleanup(); }
});
