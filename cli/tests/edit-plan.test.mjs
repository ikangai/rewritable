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

// #32: the CLI commit path now backfills data-rwa-id, so block open tags carry
// an attribute they did not before. Where a test asserts on exact document bytes
// (rather than on the content of a block), strip the ids first: the assertion's
// subject was always the CONTENT transformation, never the runtime's own
// bookkeeping. Which blocks get an id, and that frozen zones are skipped, is
// pinned in cli/tests/block-ids.test.mjs and tests/block-id-parity.mjs.
const stripIds = (s) => s.replace(/ data-rwa-id="[a-z2-7]{8}"/g, '');


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
    assert.match(body, /<h1[^>]*>New<\/h1>/);
    assert.doesNotMatch(body, /<h1[^>]*>Old<\/h1>/);
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
    assert.match(body, /<h1[^>]*>New<\/h1>/);
  } finally { fx.cleanup(); }
});

test('#3: a DSL compile error surfaces the offending op in CliError.details', async () => {
  const fx = mkFixture('<article><h1>Old</h1></article>');
  try {
    const envelope = { version: 'rwa-edit-dsl/1', ops: [{ op: 'unknown_op', target: 'x' }] };
    let err;
    try { await applyPlan(fx.path, envelope); } catch (e) { err = e; }
    assert.ok(err, 'applyPlan rejects on a malformed DSL plan');
    assert.equal(err.subcode, 'op_unknown');
    assert.deepEqual(err.details.op, { op: 'unknown_op', target: 'x' }, 'the offending op is passed through, not dropped');
  } finally { fx.cleanup(); }
});

test('#1: replace_document rejects an injected reserved id (rwa-doc-mount)', async () => {
  const fx = mkFixture('<article><h1>Old</h1></article>');
  try {
    const env = { version: 'rwa-edit/1', doc: '<article id="rwa-doc-mount"><h1>X</h1></article>', reason: 'hijack the mount' };
    let err; try { await applyPlan(fx.path, env); } catch (e) { err = e; }
    assert.ok(err, 'rejects');
    assert.equal(err.subcode, 'reserved_id_used');
    assert.equal(err.details.id, 'rwa-doc-mount');
  } finally { fx.cleanup(); }
});

test('#1: replace_document rejects a lone surrogate in the doc', async () => {
  const fx = mkFixture('<article><h1>Old</h1></article>');
  try {
    const env = { version: 'rwa-edit/1', doc: '<article>\uD800 lone high surrogate</article>', reason: 'x' };
    let err; try { await applyPlan(fx.path, env); } catch (e) { err = e; }
    assert.ok(err, 'rejects');
    assert.equal(err.subcode, 'malformed_envelope');
    assert.equal(err.details.reason, 'lone_surrogate');
  } finally { fx.cleanup(); }
});

test('#5: rwa-id-strict rejects an apply_edits that drops an existing data-rwa-id', async () => {
  const fx = mkFixture('<div data-rwa-frozen><meta name="rwa-id-strict"></div>\n<p data-rwa-id="keepme01">Hello</p>');
  try {
    const env = { version: 'rwa-edit/1', edits: [{ find: '<p data-rwa-id="keepme01">Hello</p>', replace: '<p>Hello edited</p>' }] };
    let err; try { await applyPlan(fx.path, env); } catch (e) { err = e; }
    assert.ok(err, 'rejects');
    assert.equal(err.subcode, 'rwa_id_stripped');
    assert.equal(err.details.id, 'keepme01');
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
    assert.equal(stripIds(body), '<article><h1>Brand new</h1></article>');
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

// ─── replace_document must preserve ATTRIBUTE-form frozen zones too ─────
// The escape hatch must not become a frozen-zone bypass: a file that declares
// its self-knowledge in a frozen `<… data-rwa-frozen>` block (tesla's datatable
// #rwa-affordances) must stay un-driftable through replace_document, just as it
// is through apply_edits.

test('frozen_zone_violation — replace_document drifts an attribute-form data-rwa-frozen element', async () => {
  const fx = mkFixture('<article>a<div data-rwa-frozen><p>locked</p></div>z</article>');
  try {
    await assert.rejects(
      applyPlan(fx.path, {
        version: 'rwa-edit/1',
        doc: '<article>a<div data-rwa-frozen><p>tampered</p></div>z</article>',
        reason: 'drift the frozen element',
      }),
      err => err.exitCode === 3 && err.subcode === 'frozen_zone_violation',
    );
  } finally { fx.cleanup(); }
});

test('replace_document preserving the attribute-form frozen element succeeds', async () => {
  const fx = mkFixture('<article>a<div data-rwa-frozen><p>locked</p></div>z</article>');
  try {
    const result = await applyPlan(fx.path, {
      version: 'rwa-edit/1',
      doc: '<article>NEW<div data-rwa-frozen><p>locked</p></div>NEW</article>',
      reason: 'replace surrounding only',
    });
    assert.equal(result.exitCode, 0);
  } finally { fx.cleanup(); }
});

test('frozen_zone_violation — replace_document must not ADD a new frozen zone', async () => {
  // Parity with the seed (frozenZonesIntact rejects a zone-count change) and the
  // apply_edits path (frozen_zone_corrupted on count change): an agent must not
  // be able to mint new author-invariants via the escape hatch. Frozen zones are
  // added by editing the file directly, never through the edit protocol.
  const fx = mkFixture('<article>just text</article>'); // no frozen zones
  try {
    await assert.rejects(
      applyPlan(fx.path, {
        version: 'rwa-edit/1',
        doc: '<article>just text<!-- rwa:frozen:begin new --><b>locked</b><!-- rwa:frozen:end new --></article>',
        reason: 'sneak in a frozen zone',
      }),
      err => err.exitCode === 3 && err.subcode === 'frozen_zone_violation',
    );
  } finally { fx.cleanup(); }
});

// ─── #1: replace_document unterminated-marker detection ───────────────
// A stray begin marker with no matching end is NOT a terminated zone, so the
// byte-preservation + add-rejection guards above (which only see terminated
// zones) miss it. The seed catches it via extractFrozenZones 'unterminated' →
// frozenZonesIntact reject. The escape hatch must not be able to leave the doc
// with a half-open frozen fence that the next loader would choke on.

test('#1: replace_document rejects an unterminated frozen-zone marker (comment form)', async () => {
  const fx = mkFixture('<article>just text</article>'); // no frozen zones
  try {
    await assert.rejects(
      applyPlan(fx.path, {
        version: 'rwa-edit/1',
        doc: '<article>just text<!-- rwa:frozen:begin orphan --></article>', // begin, no end
        reason: 'leave a half-open fence',
      }),
      err => err.exitCode === 3 && err.subcode === 'frozen_zone_violation' && err.details.zone === 'orphan',
    );
  } finally { fx.cleanup(); }
});

test('#1: replace_document rejects an unterminated frozen-zone marker (script-comment form)', async () => {
  const fx = mkFixture('<article>just text</article>');
  try {
    await assert.rejects(
      applyPlan(fx.path, {
        version: 'rwa-edit/1',
        doc: '<article>just text</article>\n// rwa:frozen:begin orphan\nconsole.log(1);',
        reason: 'half-open JS fence',
      }),
      err => err.exitCode === 3 && err.subcode === 'frozen_zone_violation' && err.details.zone === 'orphan',
    );
  } finally { fx.cleanup(); }
});

// ─── #1: replace_document class-lock coverage (class_lock_uncovered) ────
// A bare .rwa-locked block in the CURRENT doc cannot survive a wholesale
// rewrite — the wrapper can be reshaped, attribute-mutated, or dropped. The
// seed rejects ANY replace_document while a lock sits outside a marker-form
// frozen zone (rwa-lens/1 spec §7; replaceDocument class_lock_uncovered).

test('#1: replace_document rejects a wholesale rewrite while a bare .rwa-locked block is uncovered', async () => {
  const fx = mkFixture('<article>a<div class="rwa-locked"><p>locked</p></div>z</article>');
  try {
    await assert.rejects(
      applyPlan(fx.path, {
        version: 'rwa-edit/1',
        doc: '<article>brand new content</article>',
        reason: 'wholesale rewrite over an uncovered lock',
      }),
      err => err.exitCode === 3 && err.subcode === 'class_lock_uncovered',
    );
  } finally { fx.cleanup(); }
});

test('#1: replace_document allows a rewrite when the .rwa-locked block is covered by a frozen zone', async () => {
  // Lock fully inside a marker-form frozen zone: the zone protects it
  // byte-identically, so the rewrite is safe and must NOT be rejected.
  const fx = mkFixture(
    '<article>a<!-- rwa:frozen:begin lk --><div class="rwa-locked"><p>locked</p></div><!-- rwa:frozen:end lk -->z</article>',
  );
  try {
    const result = await applyPlan(fx.path, {
      version: 'rwa-edit/1',
      doc: '<article>NEW<!-- rwa:frozen:begin lk --><div class="rwa-locked"><p>locked</p></div><!-- rwa:frozen:end lk -->NEW</article>',
      reason: 'rewrite surrounding, lock stays covered',
    });
    assert.equal(result.exitCode, 0);
  } finally { fx.cleanup(); }
});

test('#1: replace_document with no .rwa-locked block is unaffected by the coverage check (regression)', async () => {
  const fx = mkFixture('<article>plain content, no locks</article>');
  try {
    const result = await applyPlan(fx.path, {
      version: 'rwa-edit/1',
      doc: '<article>totally new content</article>',
      reason: 'plain rewrite',
    });
    assert.equal(result.exitCode, 0);
  } finally { fx.cleanup(); }
});

// ─── review follow-up: 3-fence-form parity on the BYTE-PRESERVATION path ──
// The card shipped a 3-form coverage + unterminated check, but byte-preservation
// and add-rejection were comment-form-only (findFrozenZones). A /* */ or // zone
// could then be dropped (its content unprotected) or minted (a new author-
// invariant) via the escape hatch — divergence from the seed's 3-form
// extractFrozenZones/frozenZonesIntact. These pin the fix.

test('review: replace_document must preserve a CSS-comment-form (/* */) frozen zone byte-identically', async () => {
  const fx = mkFixture('<article>a<style>/* rwa:frozen:begin css */.x{color:red}/* rwa:frozen:end css */</style>z</article>');
  try {
    await assert.rejects(
      applyPlan(fx.path, {
        version: 'rwa-edit/1',
        doc: '<article>a<style>/* rwa:frozen:begin css */.x{color:BLUE}/* rwa:frozen:end css */</style>z</article>',
        reason: 'drift the content of a CSS-form frozen zone',
      }),
      err => err.exitCode === 3 && err.subcode === 'frozen_zone_violation' && err.details.zone === 'css',
    );
  } finally { fx.cleanup(); }
});

test('review: replace_document must not MINT a terminated // (script-comment) frozen zone', async () => {
  const fx = mkFixture('<article><script>console.log(1)</script></article>');
  try {
    await assert.rejects(
      applyPlan(fx.path, {
        version: 'rwa-edit/1',
        doc: '<article><script>// rwa:frozen:begin minted\nconsole.log(1)\n// rwa:frozen:end minted</script></article>',
        reason: 'mint a new JS-form author-invariant via the escape hatch',
      }),
      err => err.exitCode === 3 && err.subcode === 'frozen_zone_violation' && err.details.zone === 'minted',
    );
  } finally { fx.cleanup(); }
});

test('review: replace_document rejects a DUPLICATE-name frozen zone (shadow-copy tamper)', async () => {
  // Current doc: one zone z. New doc: a TAMPERED first copy + a pristine duplicate.
  // A last-wins Map would compare only the pristine copy and pass — the seed (and
  // now the CLI) rejects the duplicate name outright.
  const fx = mkFixture('<article><!-- rwa:frozen:begin z -->KEEP<!-- rwa:frozen:end z --></article>');
  try {
    await assert.rejects(
      applyPlan(fx.path, {
        version: 'rwa-edit/1',
        doc: '<article><!-- rwa:frozen:begin z -->TAMPERED<!-- rwa:frozen:end z --><!-- rwa:frozen:begin z -->KEEP<!-- rwa:frozen:end z --></article>',
        reason: 'smuggle a tampered shadow copy behind a duplicate name',
      }),
      err => err.exitCode === 3 && err.subcode === 'frozen_zone_violation' && err.details.zone === 'z',
    );
  } finally { fx.cleanup(); }
});

// The DSL escape op (apply_dsl_plan → replace_document) must hit the SAME
// frozen guards as a direct replace_document — the card claims it does
// (assertFrozenPreserved is called on both branches), but nothing exercised it.
test('review: apply_dsl_plan escape op is subject to the frozen-zone guard', async () => {
  const fx = mkFixture('<article>a<!-- rwa:frozen:begin keep -->X<!-- rwa:frozen:end keep -->z</article>');
  try {
    await assert.rejects(
      applyPlan(fx.path, {
        version: 'rwa-edit-dsl/1',
        ops: [{ op: 'replace_document', doc: '<article>wiped the frozen zone</article>', reason: 'drop frozen via DSL escape' }],
      }),
      err => err.exitCode === 3 && err.subcode === 'frozen_zone_violation',
    );
  } finally { fx.cleanup(); }
});

// ─── Regression: I-2 — non-ENOENT read errors mislabeled as not_found ─
// EACCES (and other non-ENOENT codes) used to map to `not_found`, which
// misleads users about why the read failed. Now they surface as
// `read_error` with the original errno attached.

// Root (some CI containers) bypasses file mode bits and Windows has no chmod 000,
// so the environment can't trigger EACCES — report SKIPPED, not a false PASS
// (Rule 12: an early-return reported as a pass is dishonest test reporting).
const cannotForceEacces = process.platform === 'win32' || process.getuid?.() === 0;
test('read_error — non-ENOENT (EACCES via chmod 000)',
  { skip: cannotForceEacces && 'root/Windows bypasses file mode bits; chmod 000 cannot trigger EACCES here' },
  async () => {
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
