#!/usr/bin/env node
// benchmark/runners/run-fidelity-dsl.mjs — DSL compile-down round-trip runner.
//
// For each fidelity scenario carrying an `expectedDslPlan` field:
//   1. Resolve the fixture (same path as run-fidelity.mjs).
//   2. Extract the stub envelope (the "model would have emitted" answer).
//   3. Compile the scenario's DSL plan against the fixture.
//   4. Apply BOTH the stub envelope and the compiled envelope to the fixture.
//   5. Compare resulting docs. Equal → DSL plan round-trips ↔ stub.
//
// What this validates:
//   - The DSL spec's compile-down semantics are implementable.
//   - Each op produces an envelope semantically equivalent to a hand-written
//     apply_edits stub.
//   - No DSL plan I claim works actually fails to compile or produces a
//     different doc state than the stub.
//
// What this does NOT validate:
//   - Whether real models can write good DSL plans (that's the next layer).
//   - Whether the DSL's expressivity is sufficient (that's covered by which
//     scenarios DON'T have an expectedDslPlan — see §11 of the DSL spec).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileDslPlan, applyEnvelopeToDoc, DslCompileError } from '../oracles/dsl-compiler.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = path.resolve(__dirname, '..', 'scenarios', 'fidelity');
const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');
const RESULTS_DIR = path.resolve(__dirname, '..', 'results');

async function discoverScenarios() {
  const files = fs.readdirSync(SCENARIOS_DIR)
    .filter(f => f.endsWith('.mjs') && !f.startsWith('_'))
    .sort();
  const scenarios = [];
  for (const f of files) {
    const url = pathToFileURL(path.join(SCENARIOS_DIR, f)).href;
    const mod = await import(url);
    if (mod.default) scenarios.push({ ...mod.default, _file: f });
  }
  return scenarios;
}

function loadFixture(name) {
  const p = path.join(FIXTURES_DIR, 'templates', name + '.html');
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

function resolveFixture(scenario) {
  if (typeof scenario.fixtureContent === 'string') {
    return scenario.fixtureContent.replace(/\r\n/g, '\n');
  }
  if (typeof scenario.fixture === 'string') return loadFixture(scenario.fixture);
  throw new Error(`scenario ${scenario.id}: must declare fixture or fixtureContent`);
}

// Call the scenario's stub() to get a model fn, invoke it once with empty
// inputs, extract the tool_call payload as { tool, envelope }.
async function extractStubEnvelope(scenario) {
  const model = scenario.stub();
  const result = await model([], {});
  const call = result.tool_calls?.[0];
  if (!call) throw new Error(`stub returned no tool_calls`);
  return {
    tool: call.function.name,
    envelope: JSON.parse(call.function.arguments),
  };
}

function diffPreview(a, b, maxLines = 6) {
  // Show the smallest neighbourhood around the first divergence, capped.
  const minLen = Math.min(a.length, b.length);
  let i = 0;
  while (i < minLen && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  const ctx = 40;
  const aSlice = a.slice(Math.max(0, i - ctx), Math.min(a.length, i + ctx));
  const bSlice = b.slice(Math.max(0, i - ctx), Math.min(b.length, i + ctx));
  return `  divergence at byte ${i}\n  stub: ${JSON.stringify(aSlice)}\n  dsl:  ${JSON.stringify(bSlice)}`;
}

async function main() {
  const scenarios = await discoverScenarios();
  const candidates = scenarios.filter(s => s.expectedDslPlan);
  console.log(`== rwa-edit-dsl/1 round-trip — ${candidates.length} scenario(s) with expectedDslPlan ==\n`);

  const results = [];
  for (const s of candidates) {
    const result = { id: s.id, tag: s.tag || 'untagged' };
    try {
      const fixture = resolveFixture(s);
      const stubEnv = await extractStubEnvelope(s);
      const compiledEnv = compileDslPlan(s.expectedDslPlan, fixture);
      const docFromStub = applyEnvelopeToDoc(fixture, stubEnv);
      const docFromDsl = applyEnvelopeToDoc(fixture, compiledEnv);
      if (docFromStub === docFromDsl) {
        result.pass = true;
        result.reason = 'round-trip equal';
      } else {
        result.pass = false;
        result.reason = 'docs diverged';
        result.detail = diffPreview(docFromStub, docFromDsl);
      }
      // Also record envelope shape for reporting
      result.stubTool = stubEnv.tool;
      result.dslTool = compiledEnv.tool;
      result.stubEditCount = stubEnv.envelope.edits?.length ?? null;
      result.dslEditCount = compiledEnv.envelope.edits?.length ?? null;
    } catch (err) {
      result.pass = false;
      if (err instanceof DslCompileError) {
        result.reason = `compile error [${err.code}]: ${err.message}`;
      } else {
        result.reason = `runtime error: ${err.message}`;
      }
    }
    results.push(result);

    const status = result.pass ? 'PASS' : 'FAIL';
    const shape = result.dslTool
      ? ` ${result.stubTool}(${result.stubEditCount ?? '-'}) vs dsl(${result.dslEditCount ?? '-'})`
      : '';
    console.log(`  ${status}  [${result.id}]${shape}  ${result.pass ? '' : '— ' + result.reason}`);
    if (result.detail) console.log(result.detail);
  }

  const passed = results.filter(r => r.pass).length;
  console.log(`\n${passed} / ${results.length} DSL round-trips passing.`);
  // Scenarios discovered but without expectedDslPlan — useful for the gap map.
  const skipped = scenarios.filter(s => !s.expectedDslPlan);
  if (skipped.length) {
    const byTag = new Map();
    for (const s of skipped) {
      const t = s.tag || 'untagged';
      byTag.set(t, (byTag.get(t) || 0) + 1);
    }
    const summary = [...byTag.entries()].map(([t, n]) => `${t}=${n}`).join(', ');
    console.log(`(${skipped.length} scenario(s) skipped — no expectedDslPlan: ${summary})`);
  }

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const tsv = [
    'id\ttag\tpass\tstub_tool\tstub_edits\tdsl_tool\tdsl_edits\treason',
    ...results.map(r => [r.id, r.tag, r.pass ? '1' : '0', r.stubTool ?? '-', r.stubEditCount ?? '-', r.dslTool ?? '-', r.dslEditCount ?? '-', r.reason ?? ''].join('\t')),
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(RESULTS_DIR, 'fidelity-dsl.tsv'), tsv);

  process.exit(passed === results.length ? 0 : 1);
}

main().catch(err => {
  console.error('runner crashed:', err);
  process.exit(2);
});
