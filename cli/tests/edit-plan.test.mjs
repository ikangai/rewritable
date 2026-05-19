// Tests for `applyPlan` — the plan-path entry composing dsl-compiler +
// apply-edits + seed splice. Fixtures use `rwa new` to bootstrap a real
// rewritable file, then `replaceInlineDoc` to swap in a known body, so
// the production splice path is exercised end-to-end.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyPlan } from '../src/edit.mjs';
import { replaceInlineDoc, extractInlineDoc } from '../src/seed.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RWA_BIN = join(__dirname, '..', 'bin', 'rwa.mjs');

function mkFixture(inlineDocBody = '<article><h1>Old</h1></article>') {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-edit-test-'));
  const path = join(dir, 'test.html');
  // Bootstrap a real rewritable. `rwa new` writes a valid INLINE_DOC + bootstrap.
  execFileSync('node', [RWA_BIN, 'new', path], { stdio: 'pipe' });
  // Swap in a known INLINE_DOC body using the same splice the production
  // path uses — this is what we want to round-trip through extractInlineDoc.
  const current = readFileSync(path, 'utf8');
  writeFileSync(path, replaceInlineDoc(current, inlineDocBody), 'utf8');
  return { path, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ─── Happy paths ───────────────────────────────────────────────────────

test('apply_edits envelope applies and writes', async () => {
  const fx = mkFixture('<article><h1>Old</h1></article>');
  try {
    const envelope = { version: 'rwa-edit/1', edits: [{ find: 'Old', replace: 'New' }] };
    const result = await applyPlan(fx.path, envelope);
    assert.equal(result.exitCode, 0);
    const written = readFileSync(fx.path, 'utf8');
    const body = extractInlineDoc(written);
    assert.ok(body.includes('<h1>New</h1>'));
    assert.ok(!body.includes('<h1>Old</h1>'));
  } finally { fx.cleanup(); }
});

test('apply_dsl_plan envelope routes through compiler and applies', async () => {
  const fx = mkFixture('<article><h1>Old</h1></article>');
  try {
    const envelope = {
      version: 'rwa-edit-dsl/1',
      ops: [{ op: 'replace', find: 'Old', replace: 'New' }],
    };
    const result = await applyPlan(fx.path, envelope);
    assert.equal(result.exitCode, 0);
    const body = extractInlineDoc(readFileSync(fx.path, 'utf8'));
    assert.ok(body.includes('<h1>New</h1>'));
  } finally { fx.cleanup(); }
});

test('replace_document envelope swaps the whole doc', async () => {
  const fx = mkFixture('<article><h1>Old</h1></article>');
  try {
    const envelope = {
      version: 'rwa-edit/1',
      doc: '<article><h1>Brand new</h1></article>',
      reason: 'starting fresh',
    };
    const result = await applyPlan(fx.path, envelope);
    assert.equal(result.exitCode, 0);
    const body = extractInlineDoc(readFileSync(fx.path, 'utf8'));
    assert.equal(body, '<article><h1>Brand new</h1></article>');
  } finally { fx.cleanup(); }
});

test('apply_dsl_plan with replace_document op routes through the escape branch', async () => {
  const fx = mkFixture('<article>old</article>');
  try {
    const envelope = {
      version: 'rwa-edit-dsl/1',
      ops: [{ op: 'replace_document', doc: '<article>brand new</article>', reason: 'r' }],
    };
    const result = await applyPlan(fx.path, envelope);
    assert.equal(result.exitCode, 0);
    const body = extractInlineDoc(readFileSync(fx.path, 'utf8'));
    assert.equal(body, '<article>brand new</article>');
  } finally { fx.cleanup(); }
});

// ─── Envelope validation ───────────────────────────────────────────────

test('not_an_object — non-object envelope', async () => {
  const fx = mkFixture();
  try {
    await assert.rejects(
      () => applyPlan(fx.path, 'string'),
      err => err.exitCode === 3 && err.subcode === 'not_an_object',
    );
    await assert.rejects(
      () => applyPlan(fx.path, null),
      err => err.exitCode === 3 && err.subcode === 'not_an_object',
    );
    await assert.rejects(
      () => applyPlan(fx.path, []),
      err => err.exitCode === 3 && err.subcode === 'not_an_object',
    );
  } finally { fx.cleanup(); }
});

test('unknown_shape — envelope with no discriminator', async () => {
  const fx = mkFixture();
  try {
    await assert.rejects(
      () => applyPlan(fx.path, { version: 'rwa-edit/1' }),
      err => err.exitCode === 3 && err.subcode === 'unknown_shape',
    );
  } finally { fx.cleanup(); }
});

test('ambiguous_envelope — two discriminators present', async () => {
  const fx = mkFixture();
  try {
    await assert.rejects(
      () => applyPlan(fx.path, { version: 'rwa-edit/1', edits: [], doc: 'x' }),
      err => err.exitCode === 3 && err.subcode === 'ambiguous_envelope',
    );
  } finally { fx.cleanup(); }
});

test('missing_version — envelope without version', async () => {
  const fx = mkFixture();
  try {
    await assert.rejects(
      () => applyPlan(fx.path, { edits: [{ find: 'x', replace: 'y' }] }),
      err => err.exitCode === 3 && err.subcode === 'missing_version',
    );
  } finally { fx.cleanup(); }
});

test('version_mismatch — DSL ops with rwa-edit/1 version', async () => {
  const fx = mkFixture();
  try {
    await assert.rejects(
      () => applyPlan(fx.path, { version: 'rwa-edit/1', ops: [] }),
      err =>
        err.exitCode === 3 &&
        err.subcode === 'version_mismatch' &&
        err.details.expected === 'rwa-edit-dsl/1' &&
        err.details.got === 'rwa-edit/1',
    );
  } finally { fx.cleanup(); }
});

test('version_mismatch — apply_edits with wrong version', async () => {
  const fx = mkFixture();
  try {
    await assert.rejects(
      () => applyPlan(fx.path, { version: 'rwa-edit/2', edits: [{ find: 'a', replace: 'b' }] }),
      err =>
        err.exitCode === 3 &&
        err.subcode === 'version_mismatch' &&
        err.details.expected === 'rwa-edit/1',
    );
  } finally { fx.cleanup(); }
});

test('missing_reason — replace_document without reason', async () => {
  const fx = mkFixture();
  try {
    await assert.rejects(
      () => applyPlan(fx.path, { version: 'rwa-edit/1', doc: '<article>x</article>' }),
      err => err.exitCode === 3 && err.subcode === 'missing_reason',
    );
  } finally { fx.cleanup(); }
});

// ─── File-target errors ────────────────────────────────────────────────

test('not_found — target file does not exist', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-edit-test-'));
  try {
    const missing = join(dir, 'no-such.html');
    await assert.rejects(
      () => applyPlan(missing, { version: 'rwa-edit/1', edits: [{ find: 'x', replace: 'y' }] }),
      err => err.exitCode === 2 && err.subcode === 'not_found',
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('not_a_rewritable — target is plain text without INLINE_DOC marker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-edit-test-'));
  try {
    const path = join(dir, 'plain.html');
    writeFileSync(path, '<html><body>hello</body></html>', 'utf8');
    await assert.rejects(
      () => applyPlan(path, { version: 'rwa-edit/1', edits: [{ find: 'hello', replace: 'world' }] }),
      err => err.exitCode === 2 && err.subcode === 'not_a_rewritable',
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ─── Inherited apply-edits errors ──────────────────────────────────────

test('find_not_found — bubbled up with exitCode 3 and editIndex', async () => {
  const fx = mkFixture('<article>hello</article>');
  try {
    await assert.rejects(
      () => applyPlan(fx.path, { version: 'rwa-edit/1', edits: [{ find: 'goodbye', replace: 'hi' }] }),
      err => err.exitCode === 3 && err.subcode === 'find_not_found' && err.details.editIndex === 0,
    );
  } finally { fx.cleanup(); }
});

// ─── DSL compile errors ────────────────────────────────────────────────

test('dsl op_unknown — surfaces compiler error code', async () => {
  const fx = mkFixture('<article>x</article>');
  try {
    await assert.rejects(
      () => applyPlan(fx.path, { version: 'rwa-edit-dsl/1', ops: [{ op: 'frobnicate' }] }),
      err => err.exitCode === 3 && err.subcode === 'op_unknown',
    );
  } finally { fx.cleanup(); }
});

// ─── Atomic write ──────────────────────────────────────────────────────

test('atomic write — no temp file remains on success', async () => {
  const fx = mkFixture('<article>x</article>');
  try {
    await applyPlan(fx.path, { version: 'rwa-edit/1', edits: [{ find: 'x', replace: 'y' }] });
    const remaining = readdirSync(fx.dir).filter(f => f.includes('rwa-tmp'));
    assert.equal(remaining.length, 0);
  } finally { fx.cleanup(); }
});

// ─── Regression: C-1 data-loss bug — replace_document doc-type check ──
// Before the fix, `{doc: undefined}` and `{doc: 42}` passed validation because
// the discriminator check only did `'doc' in env`. The result was
// `replaceInlineDoc(fileText, undefined)` silently writing an empty body via
// `canonLF(undefined) → ''`. Now we require typeof === 'string'.

test('malformed_envelope — replace_document with doc: undefined', async () => {
  const fx = mkFixture('<article>x</article>');
  try {
    await assert.rejects(
      applyPlan(fx.path, { version: 'rwa-edit/1', doc: undefined, reason: 'r' }),
      err => err.exitCode === 3 && err.subcode === 'malformed_envelope',
    );
    // File must be unchanged — the whole point of failing loud here.
    const body = extractInlineDoc(readFileSync(fx.path, 'utf8'));
    assert.ok(body.includes('<article>x</article>'));
  } finally { fx.cleanup(); }
});

test('malformed_envelope — replace_document with doc: non-string', async () => {
  const fx = mkFixture('<article>x</article>');
  try {
    await assert.rejects(
      applyPlan(fx.path, { version: 'rwa-edit/1', doc: 42, reason: 'r' }),
      err => err.exitCode === 3 && err.subcode === 'malformed_envelope',
    );
  } finally { fx.cleanup(); }
});

// ─── Regression: I-1 — replace_document frozen-zone preservation ──────
// The CLI's replace_document branch previously bypassed the bootstrap's
// frozen-zone integrity check entirely. A marker-form zone present in the
// current doc but missing from `envelope.doc` would be silently dropped on
// commit. These three tests pin the new check: removal, content change,
// and the intact-pass case.

test('frozen_zone_violation — replace_document removes a frozen zone', async () => {
  const fx = mkFixture(
    '<article>a<!-- rwa:frozen:begin lock --><h2>locked</h2><!-- rwa:frozen:end lock -->z</article>',
  );
  try {
    await assert.rejects(
      applyPlan(fx.path, {
        version: 'rwa-edit/1',
        doc: '<article>a z</article>', // zone removed
        reason: 'remove lock',
      }),
      err => err.exitCode === 3 && err.subcode === 'frozen_zone_violation',
    );
  } finally { fx.cleanup(); }
});

test('frozen_zone_violation — replace_document changes content inside frozen zone', async () => {
  const fx = mkFixture(
    '<article>a<!-- rwa:frozen:begin lock --><h2>original</h2><!-- rwa:frozen:end lock -->z</article>',
  );
  try {
    await assert.rejects(
      applyPlan(fx.path, {
        version: 'rwa-edit/1',
        doc: '<article>a<!-- rwa:frozen:begin lock --><h2>modified</h2><!-- rwa:frozen:end lock -->z</article>',
        reason: 'modify lock',
      }),
      err => err.exitCode === 3 && err.subcode === 'frozen_zone_violation',
    );
  } finally { fx.cleanup(); }
});

test('replace_document with intact frozen zone succeeds', async () => {
  const fx = mkFixture(
    '<article>a<!-- rwa:frozen:begin lock --><h2>locked</h2><!-- rwa:frozen:end lock -->z</article>',
  );
  try {
    const result = await applyPlan(fx.path, {
      version: 'rwa-edit/1',
      doc: '<article>NEW<!-- rwa:frozen:begin lock --><h2>locked</h2><!-- rwa:frozen:end lock -->NEW</article>',
      reason: 'replace surrounding',
    });
    assert.equal(result.exitCode, 0);
  } finally { fx.cleanup(); }
});

// ─── Regression: I-2 — non-ENOENT read errors mislabeled as not_found ─
// EACCES (and other non-ENOENT codes) used to map to `not_found`, which
// misleads users about why the read failed. Now they surface as
// `read_error` with the original errno attached.

test('read_error — non-ENOENT (EACCES via chmod 000)', async () => {
  // Skip when running as root (e.g. some CI containers) — root bypasses
  // file mode bits, so chmod 000 cannot trigger EACCES on read.
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    return; // implementation still correct; environment can't exercise it
  }
  const fx = mkFixture('<article>x</article>');
  try {
    execFileSync('chmod', ['000', fx.path]);
    try {
      await assert.rejects(
        applyPlan(fx.path, { version: 'rwa-edit/1', edits: [{ find: 'x', replace: 'y' }] }),
        err => err.exitCode === 2 && err.subcode === 'read_error',
      );
    } finally {
      // Restore so the temp dir can be removed.
      execFileSync('chmod', ['644', fx.path]);
    }
  } finally { fx.cleanup(); }
});
