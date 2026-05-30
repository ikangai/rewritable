// Conformance tests for the self-description/1 reference implementation.
// Pins the SD-01..05 contract (docs/specs/rwa-self-description-spec.md §7) so
// the schema cannot drift silently. Run: node --test tools/self-description.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  computeSelfDescription,
  validateSelfDescription,
  checkAffordanceAgreement,
  KIND_AFFORDANCES,
  AFFORDANCE_KINDS,
  SCHEMA_TAG,
} from './self-description.mjs';

const seedPath = fileURLToPath(new URL('../seeds/rewritable.html', import.meta.url));

const base = () => ({
  rwa: SCHEMA_TAG,
  uuid: '00000000-0000-0000-0000-000000000000',
  kind: 'document',
  affordances: [],
  provenance: 'first-party',
  frozenZones: [],
});

test('SD-01: a well-formed object validates', () => {
  assert.deepEqual(validateSelfDescription(base()), { valid: true, errors: [] });
});

test('SD-01: wrong schema tag is rejected', () => {
  const r = validateSelfDescription({ ...base(), rwa: 'self-description/2' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('rwa must be')));
});

test('SD-01: each missing required field is caught', () => {
  for (const f of ['kind', 'affordances', 'provenance', 'frozenZones']) {
    const obj = base();
    delete obj[f];
    assert.equal(validateSelfDescription(obj).valid, false, `${f} should be required`);
  }
  // uuid is required but may be null (legacy containers)
  assert.equal(validateSelfDescription({ ...base(), uuid: null }).valid, true);
  const noUuid = base(); delete noUuid.uuid;
  assert.equal(validateSelfDescription(noUuid).valid, false);
});

test('SD-01: unknown affordance kinds are rejected; known ones pass', () => {
  assert.equal(validateSelfDescription({ ...base(), affordances: ['bogus'] }).valid, false);
  assert.equal(validateSelfDescription({ ...base(), affordances: AFFORDANCE_KINDS.slice() }).valid, true);
});

test('SD-01: provenance is constrained to the enum', () => {
  assert.equal(validateSelfDescription({ ...base(), provenance: 'somewhere' }).valid, false);
  assert.equal(validateSelfDescription({ ...base(), provenance: 'installed' }).valid, true);
});

test('readers ignore unknown fields; runtime `live` block is permitted', () => {
  assert.equal(validateSelfDescription({ ...base(), somethingNew: 42 }).valid, true);
  assert.equal(
    validateSelfDescription({ ...base(), live: { dirty: false, view: null } }).valid,
    true,
  );
  // but a malformed live block is caught
  assert.equal(validateSelfDescription({ ...base(), live: [] }).valid, false);
});

test('table integrity: every bundled affordance is a known kind (SD-01 over §4)', () => {
  for (const [kind, bundle] of Object.entries(KIND_AFFORDANCES)) {
    for (const a of bundle) {
      assert.ok(AFFORDANCE_KINDS.includes(a), `${kind} bundles unknown affordance ${a}`);
    }
  }
});

test('SD-02/03: the canonical seed computes as a first-party document with no affordances', async () => {
  const text = await readFile(seedPath, 'utf8');
  const sd = computeSelfDescription(text);
  assert.equal(sd.rwa, SCHEMA_TAG);
  assert.equal(sd.kind, 'document');
  assert.deepEqual(sd.affordances, []);
  assert.equal(sd.provenance, 'first-party');
  assert.equal(validateSelfDescription(sd).valid, true);
  assert.equal(checkAffordanceAgreement(sd).ok, true);
});

test('SD-03: affordance agreement matches the kind table, and catches a mismatch', () => {
  // presentation MUST carry exactly ["view"]
  assert.equal(checkAffordanceAgreement({ kind: 'presentation', affordances: ['view'], provenance: 'first-party' }).ok, true);
  // a presentation that lost its view provider is a detectable bug
  const bad = checkAffordanceAgreement({ kind: 'presentation', affordances: [], provenance: 'first-party' });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.expected, ['view']);
  // installed provenance is not kind-derivable, so agreement is not asserted
  assert.equal(checkAffordanceAgreement({ kind: 'presentation', affordances: ['view', 'tool'], provenance: 'installed' }).ok, true);
});

test('not_a_rewritable: plain text throws the deterministic probe error', () => {
  assert.throws(() => computeSelfDescription('<html>not a rewritable</html>'), /not_a_rewritable/);
});
