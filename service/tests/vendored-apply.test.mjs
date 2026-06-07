// Pins the service's vendored copy of the CLI file-edit apply pipeline.
//
// The service deploy is a flat scp of `service/` only — `cli/` is NOT present
// after deploy — so the future `/modify` endpoint (essentially `rwa edit
// --plan` run server-side) must carry its own byte-identical copy of the apply
// pipeline rather than reimplement the validator. These tests enforce that
// discipline, the same way the CLI mirrors the seed:
//
//   1. DRIFT GATE — every vendored file under service/lib/ is byte-identical to
//      its cli/src source. If anyone edits the validator on one side only, this
//      fails loudly (parity with the CLI's cmp-gated dsl-compiler snapshot).
//   2. ROUND-TRIP — the vendored pipeline edits a real fixture rewritable to
//      byte-identical output vs the CLI pipeline. Proves the vendored modules
//      are wired and behave as the canonical ones, not merely copied.
//   3. FROZEN-ZONE WALL — a frozen-zone-violating envelope is rejected by the
//      vendored path with the same error code, so the author-invariant wall
//      holds server-side too (the whole point of not reimplementing the apply).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');          // worktree root
const CLI_SRC = join(REPO, 'cli', 'src');
const SERVICE_LIB = join(REPO, 'service', 'lib');
const RWA_BIN = join(REPO, 'cli', 'bin', 'rwa.mjs');

// The complete, minimal relative-import closure of cli/src/edit.mjs's applyPlan:
//   edit.mjs        — entry (exports applyPlan + CliError)
//   apply-edits.mjs — find/replace validator + splice (sibling of edit.mjs)
//   dsl-compiler.mjs — apply_dsl_plan → apply_edits compile (sibling)
//   seed.mjs        — extractInlineDoc / replaceInlineDoc splice helpers (sibling)
//   atomic-write.mjs — temp+fsync+rename file write (sibling)
// All four siblings + the entry are vendored so the relative imports resolve
// within service/lib/. Their only further imports are node: builtins (no npm).
const VENDORED = ['edit', 'apply-edits', 'dsl-compiler', 'seed', 'atomic-write'];

// ─── 1. Drift gate: byte-identical to cli/src ──────────────────────────────

test('every vendored file is byte-identical to its cli/src source', () => {
  for (const name of VENDORED) {
    const v = join(SERVICE_LIB, `${name}.mjs`);
    const s = join(CLI_SRC, `${name}.mjs`);
    assert.equal(
      readFileSync(v, 'utf8'),
      readFileSync(s, 'utf8'),
      `service/lib/${name}.mjs drifted from cli/src/${name}.mjs`,
    );
  }
});

// ─── 2. Round-trip: vendored output === CLI output, byte-for-byte ──────────
// Fixtures are real rewritables bootstrapped by `rwa new` (same pattern as
// cli/tests/edit-plan.test.mjs) so the production splice path is exercised
// end-to-end, not a hand-written stub.

test('vendored applyPlan edits a file identically to the CLI applyPlan', async () => {
  const { applyPlan: cliApply } = await import(join(CLI_SRC, 'edit.mjs'));
  const { applyPlan: vendoredApply } = await import(join(SERVICE_LIB, 'edit.mjs'));
  const { replaceInlineDoc } = await import(join(CLI_SRC, 'seed.mjs'));

  const body = '<article><h1>Old Title</h1><p>Some unique body text here.</p></article>';
  const envelope = { version: 'rwa-edit/1', edits: [{ find: 'Old Title', replace: 'New Title' }] };

  // Bootstrap ONE fixture, then materialize the SAME bytes at two paths so each
  // pipeline starts from an identical input file.
  const dir = mkdtempSync(join(tmpdir(), 'rwa-vendored-rt-'));
  try {
    const seedPath = join(dir, 'seed.html');
    execFileSync('node', [RWA_BIN, 'new', seedPath], { stdio: 'pipe' });
    const baseBytes = replaceInlineDoc(readFileSync(seedPath, 'utf8'), body);

    const cliPath = join(dir, 'cli.html');
    const svcPath = join(dir, 'svc.html');
    writeFileSync(cliPath, baseBytes, 'utf8');
    writeFileSync(svcPath, baseBytes, 'utf8');

    const cliResult = await cliApply(cliPath, structuredClone(envelope));
    const svcResult = await vendoredApply(svcPath, structuredClone(envelope));

    assert.equal(cliResult.exitCode, 0);
    assert.equal(svcResult.exitCode, 0);

    const cliOut = readFileSync(cliPath, 'utf8');
    const svcOut = readFileSync(svcPath, 'utf8');
    assert.equal(svcOut, cliOut, 'vendored output drifted from CLI output');
    // And it actually applied the edit (guards against both pipelines being no-ops).
    assert.ok(svcOut.includes('New Title'));
    assert.ok(!svcOut.includes('Old Title'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 3. Frozen-zone wall holds in the vendored path ────────────────────────

test('vendored applyPlan rejects a frozen-zone-violating envelope', async () => {
  const { applyPlan: vendoredApply } = await import(join(SERVICE_LIB, 'edit.mjs'));
  const { replaceInlineDoc } = await import(join(CLI_SRC, 'seed.mjs'));

  const body =
    '<article>a<!-- rwa:frozen:begin lock --><h2>locked</h2><!-- rwa:frozen:end lock -->z</article>';

  const dir = mkdtempSync(join(tmpdir(), 'rwa-vendored-frozen-'));
  try {
    const path = join(dir, 'frozen.html');
    execFileSync('node', [RWA_BIN, 'new', path], { stdio: 'pipe' });
    writeFileSync(path, replaceInlineDoc(readFileSync(path, 'utf8'), body), 'utf8');

    // replace_document escape hatch trying to drift the frozen zone's content.
    const envelope = {
      version: 'rwa-edit/1',
      doc: '<article>a<!-- rwa:frozen:begin lock --><h2>tampered</h2><!-- rwa:frozen:end lock -->z</article>',
      reason: 'attempt to drift a frozen zone server-side',
    };

    await assert.rejects(
      () => vendoredApply(path, envelope),
      err => err.exitCode === 3 && err.subcode === 'frozen_zone_violation',
      'vendored path must reject frozen-zone drift with exitCode 3 / frozen_zone_violation',
    );

    // The file on disk must be UNCHANGED (the rejection is pre-write).
    const after = readFileSync(path, 'utf8');
    assert.ok(after.includes('<h2>locked</h2>'));
    assert.ok(!after.includes('<h2>tampered</h2>'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
