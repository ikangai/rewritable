// Cross-site parity: the workflow SYSTEM PROMPT vs the workflow RUNNER.
//
// WHY this exists (Rule 9 — encode the intent, not the behaviour). CLAUDE.md names three sites that
// must stay aligned for workflow shape: docs/specs/rwa-workflow-spec.md, cli/src/seed.mjs
// (KIND_WORKFLOW_BODY — the runner), and SYSTEM_PROMPTS.workflow in the seed. Nothing enforced it,
// and the prompt drifted ~9 versions behind the runner (issue #17): it told the authoring agent
// that ctx.signal was "reserved; do not use them in v0.2" while cancellation had shipped in v0.11,
// and it never mentioned foreach, parallel, or ctx.iter at all. Nothing was broken — the agent
// simply never used features that existed, so generated workflows silently lost capability. The
// spec side was correct throughout, which is exactly why nobody noticed.
//
// These assertions are DERIVED from the runner rather than hardcoded, so they keep working as the
// runner grows: each one asks "does the runner implement X?" and only then requires the prompt to
// teach X. A future surface that ships without a prompt update fails here instead of silently
// degrading generation quality.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFromSeed } from '../src/seed-extract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const seedHtml = fs.readFileSync(path.join(REPO, 'seeds', 'rewritable.html'), 'utf8');
const runner = fs.readFileSync(path.join(REPO, 'cli', 'src', 'seed.mjs'), 'utf8');
const prompt = extractFromSeed(seedHtml).SYSTEM_PROMPTS.workflow;

test('workflow prompt exists and is substantial', () => {
  assert.ok(typeof prompt === 'string' && prompt.length > 1000, 'SYSTEM_PROMPTS.workflow missing');
});

test('ctx.signal: shipped in the runner => taught by the prompt', () => {
  // Runner-side evidence: the AbortController wiring and the boundary check.
  const shipped = runner.includes('signal:') && runner.includes('abort_signaled');
  assert.ok(shipped, 'runner no longer implements ctx.signal — update this test deliberately');
  assert.ok(prompt.includes('ctx.signal'), 'runner ships ctx.signal but the prompt never mentions it');
  // The specific regression from #17: the prompt actively forbade a shipped surface.
  assert.ok(!/ctx\.signal[^\n]*reserved/i.test(prompt),
    'prompt still calls ctx.signal "reserved" while the runner implements it');
});

test('ctx.iter: shipped in the runner => taught by the prompt, including .parent', () => {
  const shipped = /iter:\s*\{[^}]*index[^}]*item[^}]*total[^}]*parent/.test(runner);
  assert.ok(shipped, 'runner no longer builds ctx.iter with parent — update this test deliberately');
  assert.ok(prompt.includes('ctx.iter'), 'runner ships ctx.iter but the prompt never mentions it');
  assert.ok(/parent/.test(prompt), 'prompt omits ctx.iter.parent, so nested loops cannot reach outward');
});

test('foreach: recognised by the runner => authorable from the prompt', () => {
  const shipped = runner.includes('rwa-foreach');
  assert.ok(shipped, 'runner no longer recognises foreach — update this test deliberately');
  assert.ok(prompt.includes('rwa-foreach'),
    'runner supports foreach but the prompt never teaches the markup, so the agent cannot author one');
});

test('parallel: recognised by the runner => authorable from the prompt', () => {
  const shipped = runner.includes('rwa-parallel');
  assert.ok(shipped, 'runner no longer recognises parallel — update this test deliberately');
  assert.ok(prompt.includes('rwa-parallel'), 'runner supports parallel but the prompt never teaches it');
  // data-rwa-label is REQUIRED on every parallel cell; an agent that omits it emits a broken table.
  assert.ok(prompt.includes('data-rwa-label'),
    'prompt teaches parallel without its required data-rwa-label attribute');
});

test('reserved surfaces stay honestly labelled', () => {
  // ctx.log and ctx.shared are genuinely NOT built. If the runner gains either, this flips and the
  // prompt must start teaching it rather than continuing to call it absent.
  for (const surface of ['ctx.log', 'ctx.shared']) {
    const shipped = runner.includes(surface);
    if (shipped) {
      assert.ok(prompt.includes(surface),
        `runner now implements ${surface} — teach it in SYSTEM_PROMPTS.workflow`);
    } else {
      assert.ok(prompt.includes(surface),
        `prompt should still tell the agent ${surface} does not exist, so it does not invent it`);
    }
  }
});

test('the prompt does not date itself to a stale runner version', () => {
  // The literal tell from #17. A version self-label rots the moment the runner moves; the parity
  // assertions above are the durable check, so the prompt should not carry one at all.
  assert.ok(!/\bin v0\.\d+\b/.test(prompt),
    'prompt carries a hardcoded runner version, which is what went stale in #17');
});
