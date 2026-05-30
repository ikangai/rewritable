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
  extractTitle, countBlocks, buildSelfDescription,
  KIND_PROVIDERS, SUBSTRATE_BASELINE,
} from '../src/identity.mjs';
import {
  KIND_PROVIDERS as REF_KIND_PROVIDERS,
  SUBSTRATE_BASELINE as REF_BASELINE,
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
