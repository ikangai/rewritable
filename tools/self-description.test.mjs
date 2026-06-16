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
  parseDeclaration,
  declarationFacts,
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

test('refinement: KIND_PROVIDERS holds only kinds the runtime first-party-provides', () => {
  // Illustrative custom-kind entries removed — the real datatable proved them wrong.
  // skill-host is a KNOWN kind with NO first-party affordances ([]) — everything it
  // offers is an installed skill (provenance:'installed'), emitted by parseSkillZone,
  // not this table — so it belongs here with an empty bundle (like document/workflow).
  assert.deepEqual(Object.keys(KIND_PROVIDERS).sort(), ['document', 'presentation', 'skill-host', 'workflow', 'workspace']);
});

test('refinement: a custom kind is not statically guessable; agreement is vacuous', () => {
  const r = checkAffordanceAgreement({ kind: 'datatable', affordances: [{ kind: 'edit-surface', name: 'cell', provenance: 'first-party' }] });
  assert.equal(r.ok, true);
  assert.equal(r.expected, null); // unknown kind → nothing to vouch for; the real answer is declared/live
});

test('refinement: SUBSET semantics — a file may register beyond its kind template', () => {
  // a document that registers edit-surface+compute still AGREES (template [] ⊆ registered)
  const doc = { kind: 'document', affordances: [
    { kind: 'edit-surface', name: 'cell', provenance: 'first-party' },
    { kind: 'compute', name: 'total', provenance: 'first-party' },
  ] };
  assert.equal(checkAffordanceAgreement(doc).ok, true);
  // but a presentation that LOST its normative view still fails (missing normative provider)
  assert.equal(checkAffordanceAgreement({ kind: 'presentation', affordances: [] }).ok, false);
});

test('not_a_rewritable: plain text throws the deterministic probe error', () => {
  assert.throws(() => computeSelfDescription('<html>not a rewritable</html>'), /not_a_rewritable/);
});

// ── v1.1: the `declared` projection ───────────────────────────────────────

test("v1.1: source 'declared' validates", () => {
  assert.equal(validateSelfDescription({ ...base(), source: 'declared' }).valid, true);
});

test("v1.1: tesla's aligned datatable declaration validates against the contract", () => {
  // The shape tesla aligns to: schema->rwa, history true->['undo'], + per-affordance detail + data ptr.
  const decl = {
    rwa: SCHEMA_TAG, source: 'declared', kind: 'datatable',
    title: 'Q1 2026 — Marketing Budget', data: '#dt-data',
    affordances: [
      { kind: 'view', name: 'grid', label: 'Grid', provenance: 'first-party' },
      { kind: 'view', name: 'summary', label: 'Summary by category', provenance: 'first-party' },
      { kind: 'edit-surface', name: 'cell', label: 'Edit cells directly (no model)', provenance: 'first-party', surface: 'datatable:cell-edit', target: '#dt-data' },
      { kind: 'compute', name: 'total', label: 'Total = qty × unit_price', provenance: 'first-party', inputs: ['qty', 'unit_price'], output: 'total' },
    ],
    frozenZones: [],
    baseline: { edit: ['lens'], view: ['document'], export: ['html', 'print'], history: ['undo'] },
  };
  const v = validateSelfDescription(decl);
  assert.equal(v.valid, true, v.errors.join('; '));
});

test('v1.1: per-affordance verified flag (registry∪declaration union) validates; non-boolean rejected', () => {
  assert.equal(validateSelfDescription({ ...base(), kind: 'presentation', affordances: [{ ...present(), verified: true }] }).valid, true);
  assert.equal(validateSelfDescription({ ...base(), kind: 'presentation', affordances: [{ ...present(), verified: 'yes' }] }).valid, false);
});

test('v1.1: baseline.history must stay honest ops (true/boolean rejected; no redo)', () => {
  assert.equal(validateSelfDescription({ ...base(), baseline: { ...SUBSTRATE_BASELINE, history: true } }).valid, false);
  assert.equal(validateSelfDescription({ ...base(), baseline: { ...SUBSTRATE_BASELINE, view: ['document'] } }).valid, true);
});

test('v1.1: parseDeclaration extracts the embedded #rwa-affordances block', () => {
  const decl = { rwa: SCHEMA_TAG, source: 'declared', kind: 'datatable', affordances: [], frozenZones: [] };
  const file = `<html><body><script type="application/rwa-affordances+json" id="rwa-affordances" data-rwa-frozen="affordances">${JSON.stringify(decl)}</script></body></html>`;
  const p = parseDeclaration(file);
  assert.equal(p.error, null);
  assert.equal(p.declaration.kind, 'datatable');
  assert.equal(parseDeclaration('<html>no declaration</html>').declaration, null);
});

test('v1.1: declarationFacts reports frozen-attr (the trust basis), not frozenZones', () => {
  const frozen = '<script type="application/rwa-affordances+json" id="rwa-affordances" data-rwa-frozen="affordances">{}</script>';
  const f1 = declarationFacts(frozen);
  assert.equal(f1.found, true);
  assert.equal(f1.frozenAttr, true);
  const open = '<script type="application/rwa-affordances+json" id="rwa-affordances">{}</script>';
  assert.equal(declarationFacts(open).frozenAttr, false);
  assert.equal(declarationFacts('<html>none</html>').found, false);
});

test('v1.1: declarationFacts on the REAL datatable — edit-reachable but frozen-attr protected', async () => {
  const dt = fileURLToPath(new URL('../examples/datatable/datatable.html', import.meta.url));
  let text;
  try { text = await readFile(dt, 'utf8'); } catch { return; } // skip if the demo isn't present
  const f = declarationFacts(text);
  assert.equal(f.found, true);
  assert.equal(f.inEditableBody, true, 'the declaration lives inside INLINE_DOC');
  assert.equal(f.frozenAttr, true, 'tesla froze it (af8e9fa) — trustworthy despite being in the body');
});

test('v1.1: declarationFacts is DOM-accurate — a data-rwa-frozen VALUE mention does not over-trust', () => {
  // A declaration tag with NO real data-rwa-frozen attribute, only the string in
  // another attribute's value (or a longer-named attribute), must NOT report
  // frozenAttr:true — otherwise the CLI trusts a declaration the seed lens (DOM
  // querySelectorAll) can actually drift, a cross-surface bypass of the "declared
  // only if edit-unreachable" safeguard. tagHasFrozenAttr requires a real NAME.
  const valueMention = '<script type="application/rwa-affordances+json" id="rwa-affordances" title="data-rwa-frozen tip">{}</script>';
  assert.equal(declarationFacts(valueMention).frozenAttr, false, 'a value mention is not a frozen attribute');
  const longerName = '<script type="application/rwa-affordances+json" id="rwa-affordances" data-rwa-frozen-note="x">{}</script>';
  assert.equal(declarationFacts(longerName).frozenAttr, false, 'data-rwa-frozen-note is a different attribute');
  const realAttr = '<script type="application/rwa-affordances+json" id="rwa-affordances" data-rwa-frozen>{}</script>';
  assert.equal(declarationFacts(realAttr).frozenAttr, true, 'a real data-rwa-frozen attribute is still trusted');
});
