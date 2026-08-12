// Emission pruning of foreign-kind SYSTEM_PROMPTS (2026-08-12).
//
// WHY: PRODUCT_KIND is baked at creation and the only prompt lookup is
// SYSTEM_PROMPTS[PRODUCT_KIND] || SYSTEM_PROMPTS.document — every foreign-kind
// prompt is dead bytes in every copy of every emitted container (the workflow
// prompt alone is ~13 KB, carried by every plain document). The SEED keeps all
// kinds (it is the template); EMISSIONS carry their own kind plus the document
// fallback, nothing else. The pruner must fail loud on marker asymmetry — a
// half-pruned bootstrap would be worse than an unpruned one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySeedSubs, kindOverrides, pruneForeignKindPrompts } from '../src/seed.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED = fs.readFileSync(path.join(__dirname, '..', '..', 'seeds', 'rewritable.html'), 'utf8');

const emit = (kind) => {
  const ov = kindOverrides(kind);
  return applySeedSubs(SEED, {
    uuid: '00000000-0000-4000-8000-000000000000', title: 'T', fileMeta: 't.html', productKind: kind,
    lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder,
    productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor,
  });
};

// Distinctive first-line fragments of each kind's prompt.
const FRAG = {
  document: 'editing a rewritable HTML document. Apply',
  workflow: 'editing a rewritable HTML workflow file',
  presentation: 'presented as a slide deck',
  workspace: 'editing a rewritable workspace index',
};

test('seed source carries all kinds and balanced markers', () => {
  for (const f of Object.values(FRAG)) assert.ok(SEED.includes(f));
  assert.equal((SEED.match(/\/\/ rwa:kind-prompt:begin /g) || []).length, 3);
  assert.equal((SEED.match(/\/\/ rwa:kind-prompt:end /g) || []).length, 3);
});

test('document emission drops every foreign kind and all markers', () => {
  const out = emit('document');
  assert.ok(out.includes(FRAG.document));
  for (const k of ['workflow', 'presentation', 'workspace']) {
    assert.ok(!out.includes(FRAG[k]), k + ' prompt should be pruned');
  }
  assert.ok(!out.includes('rwa:kind-prompt:'), 'no markers survive emission');
  assert.ok(out.includes('rwa:extract:end SYSTEM_PROMPTS'), 'registry structure intact');
});

test('workflow emission keeps its own prompt plus the document fallback only', () => {
  const out = emit('workflow');
  assert.ok(out.includes(FRAG.workflow));
  assert.ok(out.includes(FRAG.document), 'document fallback always ships');
  assert.ok(!out.includes(FRAG.presentation));
  assert.ok(!out.includes(FRAG.workspace));
});

test('presentation emission keeps presentation + document only', () => {
  const out = emit('presentation');
  assert.ok(out.includes(FRAG.presentation));
  assert.ok(out.includes(FRAG.document));
  assert.ok(!out.includes(FRAG.workflow));
});

test('a kind without a registry entry (skill-host) keeps only the fallback', () => {
  const out = emit('skill-host');
  assert.ok(out.includes(FRAG.document));
  for (const k of ['workflow', 'presentation', 'workspace']) assert.ok(!out.includes(FRAG[k]));
});

test('pruning saves real bytes on a document emission', () => {
  const saved = Buffer.byteLength(SEED) - Buffer.byteLength(pruneForeignKindPrompts(SEED, 'document'));
  assert.ok(saved > 10_000, `expected >10 KB pruned, got ${saved}`);
});

test('unbalanced markers fail loud instead of emitting half-pruned output', () => {
  const broken = SEED.replace('// rwa:kind-prompt:end workflow', '// gone');
  assert.throws(() => pruneForeignKindPrompts(broken, 'document'), /unbalanced|malformed/);
});
