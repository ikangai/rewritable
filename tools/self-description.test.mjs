// Conformance tests for the self-description/1 reference implementation.
// Pins the SD-01..07 contract (docs/specs/rwa-self-description-spec.md §7) so
// the schema cannot drift silently. Run: node --test tools/self-description.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  computeSelfDescription,
  validateSelfDescription,
  checkAffordanceAgreement,
  affordanceKindsForKind,
  KIND_PROVIDERS,
  AFFORDANCE_KINDS,
  SUBSTRATE_BASELINE,
  SCHEMA_TAG,
} from './self-description.mjs';

const seedPath = fileURLToPath(new URL('../seeds/rewritable.html', import.meta.url));

// A minimal valid static projection.
const base = () => ({
  rwa: SCHEMA_TAG,
  source: 'static',
  uuid: '00000000-0000-0000-0000-000000000000',
  kind: 'document',
  title: null,
  blocks: 0,
  affordances: [],
  frozenZones: [],
  baseline: { ...SUBSTRATE_BASELINE },
});

const present = () => ({ kind: 'view', name: 'presentation', label: 'Present', provenance: 'first-party' });

test('SD-01: a well-formed static object validates', () => {
  assert.deepEqual(validateSelfDescription(base()), { valid: true, errors: [] });
});

test('SD-01: a well-formed live object validates (activeView allowed when source=live)', () => {
  const live = { ...base(), source: 'live', kind: 'presentation', affordances: [present()], activeView: 'presentation' };
  assert.equal(validateSelfDescription(live).valid, true);
});

test('SD-01: wrong schema tag and bad source are rejected', () => {
  assert.equal(validateSelfDescription({ ...base(), rwa: 'self-description/2' }).valid, false);
  assert.equal(validateSelfDescription({ ...base(), source: 'guess' }).valid, false);
});

test('SD-01: each required field is enforced (uuid may be null)', () => {
  for (const f of ['rwa', 'source', 'kind', 'affordances', 'frozenZones']) {
    const obj = base(); delete obj[f];
    assert.equal(validateSelfDescription(obj).valid, false, `${f} should be required`);
  }
  assert.equal(validateSelfDescription({ ...base(), uuid: null }).valid, true);
  const noUuid = base(); delete noUuid.uuid;
  assert.equal(validateSelfDescription(noUuid).valid, false);
});

test('SD-01: affordances are provider OBJECTS {kind,name,provenance}, kind from the enum', () => {
  // bare strings are no longer valid
  assert.equal(validateSelfDescription({ ...base(), affordances: ['view'] }).valid, false);
  // unknown kind rejected
  assert.equal(validateSelfDescription({ ...base(), affordances: [{ kind: 'bogus', name: 'x', provenance: 'first-party' }] }).valid, false);
  // missing name rejected
  assert.equal(validateSelfDescription({ ...base(), affordances: [{ kind: 'view', provenance: 'first-party' }] }).valid, false);
  // bad provenance rejected
  assert.equal(validateSelfDescription({ ...base(), affordances: [{ kind: 'view', name: 'p', provenance: 'maybe' }] }).valid, false);
  // a full provider object passes
  assert.equal(validateSelfDescription({ ...base(), kind: 'presentation', affordances: [present()] }).valid, true);
});

test('SD-05: static projection must not carry the live-only activeView', () => {
  assert.equal(validateSelfDescription({ ...base(), activeView: 'presentation' }).valid, false);
});

test('Rule 12: baseline.history may not claim a redo that does not exist', () => {
  const bad = { ...base(), baseline: { ...SUBSTRATE_BASELINE, history: ['undo', 'redo'] } };
  assert.equal(validateSelfDescription(bad).valid, false);
  assert.equal(SUBSTRATE_BASELINE.history.includes('redo'), false);
});

test('readers ignore unknown fields', () => {
  assert.equal(validateSelfDescription({ ...base(), somethingNew: 42 }).valid, true);
});

test('table integrity: every bundled provider has a known affordance kind', () => {
  for (const [kind, bundle] of Object.entries(KIND_PROVIDERS)) {
    for (const p of bundle) {
      assert.ok(AFFORDANCE_KINDS.includes(p.kind), `${kind} bundles unknown affordance kind ${p.kind}`);
      assert.ok(p.name, `${kind} provider missing name`);
    }
  }
  assert.deepEqual(affordanceKindsForKind('presentation'), ['view']);
  assert.deepEqual(affordanceKindsForKind('document'), []);
});

test('SD-02/03: the canonical seed computes as a first-party document with no affordances', async () => {
  const text = await readFile(seedPath, 'utf8');
  const sd = computeSelfDescription(text);
  assert.equal(sd.rwa, SCHEMA_TAG);
  assert.equal(sd.source, 'static');
  assert.equal(sd.kind, 'document');
  assert.deepEqual(sd.affordances, []);
  assert.equal(validateSelfDescription(sd).valid, true);
  assert.equal(checkAffordanceAgreement(sd).ok, true);
  // baseline is emitted and honest
  assert.deepEqual(sd.baseline.history, ['undo']);
});

test('SD-03: affordance agreement matches the kind table and catches a mismatch', () => {
  assert.equal(checkAffordanceAgreement({ kind: 'presentation', affordances: [present()] }).ok, true);
  // a presentation that lost its view provider is a detectable bug
  const bad = checkAffordanceAgreement({ kind: 'presentation', affordances: [] });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.expected, ['view']);
  // an INSTALLED provider is not kind-derivable, so it does not break agreement
  const installed = { kind: 'presentation', affordances: [present(), { kind: 'tool', name: 'x', provenance: 'installed' }] };
  assert.equal(checkAffordanceAgreement(installed).ok, true);
});

test('not_a_rewritable: plain text throws the deterministic probe error', () => {
  assert.throws(() => computeSelfDescription('<html>not a rewritable</html>'), /not_a_rewritable/);
});
