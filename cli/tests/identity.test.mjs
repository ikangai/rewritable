// Tests for the consumer-side static self-description helpers (`self-description/1`).
//
// The CLI emits the SAME object the runtime producer (runtime.describe()) and
// the reference computer (tools/self-description.mjs computeSelfDescription) do —
// so a rewritable answers "what am I, and what can be done with me?" identically
// whether read live, by the CLI, or by the reference oracle. These tests pin the
// publish-safe mirror in cli/src/identity.mjs to that single source: the kind→
// provider table and the substrate baseline are deep-equal to the reference, and
// the assembled object matches computeSelfDescription field-for-field
// (the full file-level proof lives in doc.test.mjs against a real container).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractTitle, countBlocks, buildSelfDescription, resolveSelfDescription,
  parseDeclaration, declarationFacts, validateSelfDescription as cliValidate,
  KIND_PROVIDERS, SUBSTRATE_BASELINE,
} from '../src/identity.mjs';
import {
  KIND_PROVIDERS as REF_KIND_PROVIDERS,
  SUBSTRATE_BASELINE as REF_BASELINE,
  parseDeclaration as refParseDeclaration,
  declarationFacts as refDeclarationFacts,
  validateSelfDescription,
} from '../../tools/self-description.mjs';

// ─── Mirror pins: drift from the single source fails loudly ───────────

test('KIND_PROVIDERS mirrors the reference exactly (single source, no drift)', () => {
  // The reference (tools/self-description.mjs) owns the table; the CLI is a
  // publish-safe copy. If bohr changes the contract, this fails until the CLI
  // mirror is brought back in step — same discipline as apply-edits.mjs.
  assert.deepEqual(KIND_PROVIDERS, REF_KIND_PROVIDERS);
});

test('SUBSTRATE_BASELINE mirrors the reference exactly', () => {
  assert.deepEqual(SUBSTRATE_BASELINE, REF_BASELINE);
});

// ─── extractTitle: the document's human-readable name ─────────────────

test('extractTitle returns the first <h1> text', () => {
  assert.equal(extractTitle('<article><h1>Quarterly Report</h1><p>x</p></article>'), 'Quarterly Report');
});

test('extractTitle strips inner tags and collapses whitespace', () => {
  assert.equal(extractTitle('<h1 class="t" data-rwa-id="ab12cd34">Hello  <em>World</em>\n</h1>'), 'Hello World');
});

test('extractTitle returns null when there is no h1', () => {
  assert.equal(extractTitle('<article><p>No heading.</p></article>'), null);
});

test('extractTitle returns null for an empty h1', () => {
  assert.equal(extractTitle('<h1>   </h1>'), null);
});

// ─── countBlocks: a coarse "how structured" signal ───────────────────

test('countBlocks counts data-rwa-id-addressable blocks', () => {
  assert.equal(countBlocks('<h1 data-rwa-id="a1">T</h1><p data-rwa-id="b2">x</p><p>no id</p>'), 2);
});

test('countBlocks is 0 when the body has none', () => {
  assert.equal(countBlocks('<article><p>plain</p></article>'), 0);
});

// ─── buildSelfDescription: the assembled static projection ────────────

test('buildSelfDescription assembles the full self-description/1 object', () => {
  const self = buildSelfDescription({
    doc: '<article><h1>Deck</h1><p data-rwa-id="x">y</p></article>',
    uuid: 'u-1', kind: 'presentation', frozenZones: ['sig'],
  });
  assert.equal(self.rwa, 'self-description/1');
  assert.equal(self.source, 'static');           // CLI is the static projection
  assert.equal(self.uuid, 'u-1');
  assert.equal(self.kind, 'presentation');
  assert.equal(self.title, 'Deck');
  assert.equal(self.blocks, 1);
  assert.deepEqual(self.affordances, [
    { kind: 'view', name: 'presentation', label: 'Present', provenance: 'first-party' },
  ]);
  assert.deepEqual(self.frozenZones, ['sig']);
  assert.deepEqual(self.baseline, {
    edit: ['lens'],
    tools: ['apply_dsl_plan', 'apply_edits', 'replace_document'],
    export: ['html', 'print'],
    history: ['undo'],   // undo-only — there is no redo (Invariant 7)
  });
});

test('buildSelfDescription gives a base document an empty affordance bundle', () => {
  const self = buildSelfDescription({ doc: '<article><h1>Note</h1></article>', uuid: 'u', kind: 'document', frozenZones: [] });
  assert.deepEqual(self.affordances, []);
  assert.equal(self.title, 'Note');
});

// ─── resolveSelfDescription: the declared > static precedence (v1.1) ───
// For a custom-affordance file the kind table can only GUESS; if the file carries
// a trustworthy embedded #rwa-affordances declaration the reader prefers it
// (source:'declared'). "Trustworthy" = edit-unreachable: outside INLINE_DOC (chrome)
// OR carrying data-rwa-frozen. A non-conforming or edit-reachable declaration is
// NOT trusted — the reader falls back to the static kind-derived answer rather
// than emit a guess as truth or trust a driftable claim (spec §3.1).

const ALIGNED_DECL = {
  rwa: 'self-description/1', source: 'declared', kind: 'datatable',
  title: 'Q1 Budget', data: '#dt-data',
  affordances: [
    { kind: 'view', name: 'grid', label: 'Grid', provenance: 'first-party' },
    { kind: 'view', name: 'summary', label: 'Summary', provenance: 'first-party' },
    { kind: 'edit-surface', name: 'cell', label: 'Edit cells', provenance: 'first-party', surface: 'datatable:cell-edit', target: '#dt-data' },
    { kind: 'compute', name: 'total', label: 'Total', provenance: 'first-party', inputs: ['qty', 'unit_price'], output: 'total' },
  ],
  baseline: { edit: ['lens'], tools: ['apply_dsl_plan', 'apply_edits', 'replace_document'], export: ['html', 'print'], history: ['undo'] },
};
// tesla's CURRENT (pre-align) shape: `schema` instead of the `rwa` discriminator.
const NONCONFORMING_DECL = (() => { const { rwa, ...rest } = ALIGNED_DECL; return { schema: rwa, ...rest }; })();

const declScript = (obj, { frozen } = {}) =>
  `<script type="application/rwa-affordances+json" id="rwa-affordances"${frozen ? ' data-rwa-frozen' : ''}>${JSON.stringify(obj)}</script>`;
const bodyWith = (obj, opts) => `<article><h1>T</h1>${declScript(obj, opts)}<div id="dt-data">[]</div></article>`;
const fileWrap = (doc) => `<html><body>${doc}</body></html>`;
const chromeFile = (obj, doc) => `<html><head>${declScript(obj)}</head><body>${doc}</body></html>`;
const kinds = (self) => self.affordances.map(a => a.kind);

test('resolveSelfDescription prefers a frozen body declaration (trustworthy → declared)', () => {
  const doc = bodyWith(ALIGNED_DECL, { frozen: true });
  const self = resolveSelfDescription({ fileText: fileWrap(doc), doc, uuid: 'u-1', kind: 'datatable', frozenZones: [] });
  assert.equal(self.source, 'declared');
  assert.deepEqual(kinds(self), ['view', 'view', 'edit-surface', 'compute']); // the REAL affordances, not the kind guess
  assert.equal(self.data, '#dt-data');
});

test('resolveSelfDescription does NOT trust an edit-reachable (unfrozen body) declaration → static', () => {
  const doc = bodyWith(ALIGNED_DECL, { frozen: false });
  const self = resolveSelfDescription({ fileText: fileWrap(doc), doc, uuid: 'u', kind: 'datatable', frozenZones: [] });
  assert.equal(self.source, 'static');
  assert.deepEqual(kinds(self), []); // custom kind → no first-party template → honest-unknown (not a wrong guess)
});

test('resolveSelfDescription falls back to static for a trusted but NON-conforming declaration', () => {
  // tesla's current schema-not-rwa block: frozen (trusted) but invalid → never
  // emit a non-conforming answer; static is at least valid.
  const doc = bodyWith(NONCONFORMING_DECL, { frozen: true });
  const self = resolveSelfDescription({ fileText: fileWrap(doc), doc, uuid: 'u', kind: 'datatable', frozenZones: [] });
  assert.equal(self.source, 'static');
});

test('resolveSelfDescription trusts a chrome declaration (outside INLINE_DOC) even unfrozen', () => {
  const doc = '<article><h1>T</h1></article>';
  const self = resolveSelfDescription({ fileText: chromeFile(ALIGNED_DECL, doc), doc, uuid: 'u', kind: 'datatable', frozenZones: [] });
  assert.equal(self.source, 'declared');
  assert.deepEqual(kinds(self), ['view', 'view', 'edit-surface', 'compute']);
});

test('resolveSelfDescription returns the static projection when there is no declaration', () => {
  const doc = '<article><h1>Plain</h1></article>';
  const self = resolveSelfDescription({ fileText: fileWrap(doc), doc, uuid: 'u', kind: 'document', frozenZones: [] });
  assert.equal(self.source, 'static');
  assert.deepEqual(self.affordances, []);
});

test('#10: a trustworthy declaration UNIONS installed skills (SD-04 declared+skills)', () => {
  // A skill-host with BOTH a frozen #rwa-affordances declaration AND installed
  // skills: the declared projection must not drop the skills (static did union
  // them, so declared≠live broke SD-04).
  const skillBlock = `<script type="application/rwa-skill+json">${Buffer.from(JSON.stringify({
    format: 'rwa-skill/1',
    skill: { name: 'word-count', version: '1.0.0', kind: 'compute', permissions: [], author_pubkey: 'UEsx', code: 'async function run(i){return i.length}' },
  })).toString('base64')}</script>`;
  const doc = `<article><h1>T</h1>${declScript(ALIGNED_DECL, { frozen: true })}<div id="dt-data">[]</div></article>\n<div data-rwa-frozen id="rwa-skills">${skillBlock}</div>`;
  const self = resolveSelfDescription({ fileText: fileWrap(doc), doc, uuid: 'u', kind: 'datatable', frozenZones: [] });
  assert.equal(self.source, 'declared');
  // declared providers still present (the kind-guess override)…
  assert.ok(self.affordances.some(a => a.kind === 'edit-surface'), 'declared providers retained');
  // …AND the installed skill is unioned in (was dropped).
  const inst = self.affordances.find(a => a.provenance === 'installed');
  assert.ok(inst, 'installed skill unioned into the declared projection');
  assert.equal(inst.name, 'word-count');
});

test('a declared projection fills uuid/frozenZones from container facts, not the author claim', () => {
  // uuid/frozenZones are container facts (DOC_UUID / the bytes), authoritative
  // over anything the declaration claims — an author cannot lie about them.
  const declWithBogusFacts = { ...ALIGNED_DECL, uuid: 'AUTHOR-LIE', frozenZones: ['author-claim'] };
  const doc = bodyWith(declWithBogusFacts, { frozen: true });
  const self = resolveSelfDescription({ fileText: fileWrap(doc), doc, uuid: 'real-uuid', kind: 'datatable', frozenZones: ['sig'] });
  assert.equal(self.source, 'declared');
  assert.equal(self.uuid, 'real-uuid');
  assert.deepEqual(self.frozenZones, ['sig']);
});

test('CLI validateSelfDescription mirrors the oracle exactly (no drift)', () => {
  // The reader trusts a declaration only if the assembled object validates; that
  // gate is a publish-safe mirror of the oracle's validator. Pin them together
  // across valid + every failure mode so a malformed trustworthy declaration can
  // never slip past the CLI but be rejected by the oracle (or vice-versa).
  const cases = [
    { rwa: 'self-description/1', source: 'declared', kind: 'datatable', affordances: ALIGNED_DECL.affordances },
    { ...ALIGNED_DECL, uuid: 'u', frozenZones: [] },
    NONCONFORMING_DECL,                                                  // schema not rwa
    { ...ALIGNED_DECL, source: 'bogus' },                               // bad source
    { ...ALIGNED_DECL, affordances: [{ kind: 'nope', name: 'x', provenance: 'first-party' }] }, // bad kind
    { ...ALIGNED_DECL, affordances: [{ kind: 'view', name: 'g', provenance: 'first-party', surface: 7 }] }, // bad detail type
    { ...ALIGNED_DECL, data: 123 },                                     // bad data type
    { ...ALIGNED_DECL, baseline: { history: ['undo', 'redo'] } },       // phantom redo
    { ...ALIGNED_DECL, affordances: [{ kind: 'view', name: 'g', provenance: 'bad' }] }, // bad provenance
    buildSelfDescription({ doc: '<h1>x</h1>', uuid: 'u', kind: 'presentation', frozenZones: [] }), // a real static obj
    null, 'str', [],
  ];
  for (const c of cases) {
    assert.equal(cliValidate(c).valid, validateSelfDescription(c).valid,
      `CLI vs oracle validity disagree for ${JSON.stringify(c)}`);
  }
});

test('CLI declarationFacts/parseDeclaration mirror the oracle on a chrome declaration', () => {
  // For a chrome declaration the oracle reads raw bytes (no INLINE_DOC needed),
  // so the CLI mirror (which takes the already-extracted doc) and the oracle agree
  // without a real container. Body-declaration agreement is pinned on real
  // containers in doc.test.mjs (where extractInlineDoc succeeds for both).
  const doc = '<article><h1>T</h1></article>';
  const fileText = chromeFile(ALIGNED_DECL, doc);
  assert.deepEqual(declarationFacts(fileText, doc), refDeclarationFacts(fileText));
  assert.deepEqual(parseDeclaration(fileText, doc).declaration, refParseDeclaration(fileText).declaration);
});

// ─── frozenAttr must be DOM-accurate (the cross-surface trust gate) ────
// The trust signal must match the SEED's real enforcement (DOM
// querySelectorAll('[data-rwa-frozen]') / tagHasFrozenAttr, seed 9864a66): a
// data-rwa-frozen STRING inside an attribute VALUE — or a longer attribute name —
// is NOT a frozen attribute. A regex that fires on the bare string would over-trust
// a declaration the lens can still drift (euler #112). NB the oracle's
// declarationFacts needs the matching fix to re-align; pinned here is the CLI's
// correct behavior, not (yet) CLI⇔oracle agreement on this case.

const declAttr = (extraAttr) =>
  `<script type="application/rwa-affordances+json" id="rwa-affordances"${extraAttr}>${JSON.stringify(ALIGNED_DECL)}</script>`;

test('declarationFacts: data-rwa-frozen in an attribute VALUE is NOT frozenAttr', () => {
  const doc = `<article><h1>T</h1>${declAttr(' title="data-rwa-frozen tip"')}</article>`;
  assert.equal(declarationFacts(fileWrap(doc), doc).frozenAttr, false);
});

test('declarationFacts: a real data-rwa-frozen attribute IS frozenAttr', () => {
  const doc = `<article><h1>T</h1>${declAttr(' data-rwa-frozen')}</article>`;
  assert.equal(declarationFacts(fileWrap(doc), doc).frozenAttr, true);
});

test('resolveSelfDescription does NOT trust a body declaration frozen only by a value-mention → static', () => {
  // Edit-reachable (in the body, no real data-rwa-frozen) → the lens can drift it
  // → not trustworthy → static fallback, even though the string appears in the tag.
  const doc = `<article><h1>T</h1>${declAttr(' title="data-rwa-frozen"')}</article>`;
  const self = resolveSelfDescription({ fileText: fileWrap(doc), doc, uuid: 'u', kind: 'datatable', frozenZones: [] });
  assert.equal(self.source, 'static');
});
