// Import fidelity loop — increment 1 (design 2026-06-30). The CLI's OFFLINE structural check +
// auto-escalate, gated on offline-first: escalation fires ONLY when a model is reachable; a keyless
// low-fidelity import stays offline and warns. structuralScore is pure; measureAndEscalate is tested
// with injected deps (no network).
//
// Increment 1 scopes the offline trigger to COVERAGE (did the source text survive the import) +
// GARBLE (was extraction clean) — both false-positive-free. The graphics/visual signal needs a
// renderer and is deferred to the browser-side visual judge (a later increment).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { structuralScore, measureAndEscalate } from '../src/import-fidelity.mjs';

const html = (t) => '<article class="rwa-pdf"><span>' + t + '</span></article>';
const dense = 'The quarterly report shows revenue up twelve percent across all regions this year and next.';
// ~1/3 of the characters are U+FFFD → garble ≈ 0.67, well below the 0.85 escalate threshold.
const garbled = 'Introduction to the system and its output format shown right here today.'.split('').map((c, i) => (i % 3 === 0 ? '�' : c)).join('');

test('structuralScore: a faithful, clean import scores ~1', () => {
  const s = structuralScore({ sourceText: dense, pages: 1 }, html(dense));
  assert.ok(s.score > 0.95, 'score ' + s.score);
  assert.ok(s.coverage > 0.95 && s.garble === 1 && s.reasons.length === 0);
});

test('structuralScore: garbled extraction (replacement chars) → low garble → low score', () => {
  const s = structuralScore({ sourceText: garbled, pages: 1 }, html(garbled));
  assert.ok(s.garble < 0.9, 'garble ' + s.garble);
  assert.ok(s.score < 0.9 && s.reasons.includes('garbled-text'));
});

test('structuralScore: import dropped the source text → low coverage', () => {
  const s = structuralScore({ sourceText: dense, pages: 1 }, html('something completely unrelated written instead'));
  assert.ok(s.coverage < 0.3, 'coverage ' + s.coverage);
  assert.ok(s.score < 0.3 && s.reasons.includes('low-coverage'));
});

test('structuralScore: empty source → neutral (no false low)', () => {
  const s = structuralScore({ sourceText: '', pages: 1 }, html(''));
  assert.equal(s.coverage, 1); assert.equal(s.garble, 1);
});

const goodInput = { structuralInput: { sourceText: dense, pages: 1 }, importResult: { html: html(dense), warnings: [] } };
const lowInput = { structuralInput: { sourceText: garbled, pages: 1 }, importResult: { html: html(garbled), warnings: [] } };

test('measureAndEscalate: high fidelity → no escalation, geometry result kept, model never called', async () => {
  let called = false;
  const r = await measureAndEscalate(goodInput, { modelReachable: () => true, visionImport: async () => { called = true; return { html: html('vision') }; } });
  assert.equal(r.escalated, false);
  assert.equal(called, false);
  assert.equal(r.result, goodInput.importResult);
  assert.ok(r.fidelity.score > 0.95);
});

test('measureAndEscalate: low fidelity + model reachable → escalates to --vision and keeps it', async () => {
  const better = { html: html(dense), warnings: ['pdf: vision'] };
  let called = false;
  const r = await measureAndEscalate(lowInput, { modelReachable: () => true, visionImport: async () => { called = true; return better; } });
  assert.equal(called, true);
  assert.equal(r.escalated, true);
  assert.equal(r.result, better, 'the escalated (higher-rung) result is kept');
  assert.ok(r.baselineFidelity.score < 0.9);
});

test('measureAndEscalate: low fidelity + NO model → STAYS OFFLINE, warns, no network', async () => {
  let called = false;
  const r = await measureAndEscalate(lowInput, { modelReachable: () => false, visionImport: async () => { called = true; return { html: 'x' }; } });
  assert.equal(called, false, 'OFFLINE-FIRST: no network without a reachable model');
  assert.equal(r.escalated, false);
  assert.equal(r.result, lowInput.importResult);
  assert.ok(r.note && /fidelity/i.test(r.note));
});

test('measureAndEscalate: --no-escalate disables the loop even when reachable', async () => {
  let called = false;
  const r = await measureAndEscalate(lowInput, { escalate: false, modelReachable: () => true, visionImport: async () => { called = true; return { html: 'x' }; } });
  assert.equal(called, false);
  assert.equal(r.escalated, false);
});

test('measureAndEscalate: a failed escalation falls back to the deterministic import (loud)', async () => {
  const r = await measureAndEscalate(lowInput, { modelReachable: () => true, visionImport: async () => { throw new Error('model 500'); } });
  assert.equal(r.escalated, false);
  assert.equal(r.result, lowInput.importResult, 'never lose the offline result on an escalation error');
  assert.ok(r.note && /escalation/i.test(r.note));
});
