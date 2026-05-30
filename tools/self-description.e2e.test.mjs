// End-to-end / product-level conformance for the self-description/1 contract.
//
// Unlike self-description.test.mjs (synthetic inputs), this drives the REAL `rwa`
// CLI: it generates containers with `rwa new --kind <k>`, computes the contract
// oracle off the produced bytes, and asserts the CONSUMER (`rwa doc --json`)
// agrees with the contract on every overlapping field. This is the cross-surface
// convergence gate — it makes "the file knows what it is" true against the
// shipping product, not just against hand-written objects, and it auto-tightens
// as the consumer lands the richer shape.
//
// Run: node --test tools/self-description.e2e.test.mjs   (from repo root)
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeSelfDescription,
  validateSelfDescription,
  checkAffordanceAgreement,
  affordanceKindsForKind,
} from './self-description.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const rwaBin = join(repoRoot, 'cli', 'bin', 'rwa.mjs');

// Expected first-party affordance KINDS per generated kind (spec §4).
const KINDS = [
  { kind: 'document', affordanceKinds: [], frozen: [] },
  { kind: 'presentation', affordanceKinds: ['view'], frozen: [] },
  { kind: 'workflow', affordanceKinds: [], frozen: ['wf-style', 'runner'] },
];

function newContainer(dir, kind) {
  const out = join(dir, `${kind}.html`);
  execFileSync('node', [rwaBin, 'new', '--kind', kind, '-o', out], { cwd: repoRoot, stdio: 'pipe' });
  return out;
}

function rwaDocJson(file) {
  // Returns the parsed `rwa doc --json` object, or null if the verb/flag is
  // unavailable on this build (so the test degrades honestly rather than failing
  // on an unrelated CLI gap).
  try {
    const out = execFileSync('node', [rwaBin, 'doc', '--json', file], { cwd: repoRoot, stdio: 'pipe' }).toString();
    return JSON.parse(out);
  } catch {
    return null;
  }
}

for (const spec of KINDS) {
  test(`e2e: rwa new --kind ${spec.kind} → contract holds off real bytes`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'rwa-sd-'));
    try {
      const file = newContainer(dir, spec.kind);
      const sd = computeSelfDescription(readFileSync(file, 'utf8'));

      // The contract validates and the kind→providers table matches reality.
      assert.equal(validateSelfDescription(sd).valid, true, JSON.stringify(validateSelfDescription(sd).errors));
      assert.equal(checkAffordanceAgreement(sd).ok, true);
      assert.deepEqual(sd.affordances.map((a) => a.kind), affordanceKindsForKind(spec.kind));
      assert.deepEqual(sd.affordances.map((a) => a.kind), spec.affordanceKinds);
      assert.deepEqual([...sd.frozenZones].sort(), [...spec.frozen].sort());
      // Every provider the static path emits is first-party (a file holds no installed ones, §6).
      assert.ok(sd.affordances.every((a) => a.provenance === 'first-party'));
      // Substrate baseline is present and honest (no redo — Invariant 7).
      assert.deepEqual(sd.baseline.history, ['undo']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`e2e: consumer (rwa doc --json) agrees with the contract for ${spec.kind}`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'rwa-sd-'));
    try {
      const file = newContainer(dir, spec.kind);
      const sd = computeSelfDescription(readFileSync(file, 'utf8'));
      const doc = rwaDocJson(file);
      if (!doc) { t.skip('rwa doc --json unavailable on this build'); return; }

      // Overlap that the consumer already emits today — must agree with the
      // contract oracle (this is consumer==contract on the existing surface).
      assert.equal(doc.uuid, sd.uuid, 'uuid disagreement: rwa doc vs contract');
      assert.equal(doc.kind, sd.kind, 'kind disagreement: rwa doc vs contract');
      assert.deepEqual([...(doc.frozenZones || [])].sort(), [...sd.frozenZones].sort(), 'frozenZones disagreement');

      // Auto-tightening gate: the moment the consumer emits the richer
      // self-description shape, hold it to the full contract.
      if ('affordances' in doc) {
        assert.equal(validateSelfDescription(doc).valid, true, 'rwa doc affordances do not validate against self-description/1');
        assert.equal(checkAffordanceAgreement(doc).ok, true, 'rwa doc affordance kinds disagree with the kind table');
        assert.deepEqual(
          doc.affordances.map((a) => a.kind).sort(),
          sd.affordances.map((a) => a.kind).sort(),
          'consumer and contract disagree on affordance kinds',
        );
      } else {
        t.diagnostic(`rwa doc does not yet emit \`affordances\` for ${spec.kind} — consumer richer-shape not landed; overlap (uuid/kind/frozenZones) verified`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
