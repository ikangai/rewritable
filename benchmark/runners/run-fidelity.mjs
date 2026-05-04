#!/usr/bin/env node
// benchmark/runners/run-fidelity.mjs — fidelity scenario runner.
//
// Discovers benchmark/scenarios/fidelity/*.mjs and runs each N times
// (per-scenario default; scenario can override). For each run:
//   1. Load fixture into runtime (via replaceDocument as setup)
//   2. Wire up the model (stub or real) as fetch handler
//   3. Call modify(scenario.prompt)
//   4. Read result via getDoc()
//   5. Run scenario's success oracle (returns S in {0,1,2})
//   6. Run scenario's stability oracle (returns drift_ratio + T in {0,1,2})
//   7. Capture operational metrics (tokens_total, wall_ms, retry_rounds)
//
// Aggregates per-scenario: mean S, mean T, median drift_ratio, distribution
// of operational metrics.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as harness from './harness.mjs';
import { stubModel, openRouterModel, baselineModel, modelToFetch } from './model.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = path.resolve(__dirname, '..', 'scenarios', 'fidelity');
const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');
const RESULTS_DIR = path.resolve(__dirname, '..', 'results');

async function discoverScenarios() {
  if (!fs.existsSync(SCENARIOS_DIR)) return [];
  const files = fs.readdirSync(SCENARIOS_DIR)
    .filter(f => f.endsWith('.mjs') && !f.startsWith('_'))
    .sort();
  const scenarios = [];
  for (const f of files) {
    const url = pathToFileURL(path.join(SCENARIOS_DIR, f)).href;
    try {
      const mod = await import(url);
      const s = mod.default;
      if (!s) continue;
      scenarios.push({ ...s, _file: f });
    } catch (err) {
      console.error(`  SKIP  ${f}: load failed — ${err.message}`);
    }
  }
  return scenarios;
}

function loadFixture(name) {
  const p = path.join(FIXTURES_DIR, 'templates', name + '.html');
  if (!fs.existsSync(p)) throw new Error(`fixture not found: ${name} (looked at ${p})`);
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

function resolveFixture(scenario) {
  if (typeof scenario.fixtureContent === 'string') {
    return scenario.fixtureContent.replace(/\r\n/g, '\n');
  }
  if (typeof scenario.fixture === 'string') return loadFixture(scenario.fixture);
  throw new Error(`scenario ${scenario.id}: must declare fixture or fixtureContent`);
}

function selectModel(modelName, scenario) {
  if (modelName === 'stub') {
    if (typeof scenario.stub !== 'function') {
      throw new Error(`scenario ${scenario.id} has no stub() — cannot run with model=stub`);
    }
    return scenario.stub();
  }
  if (modelName === 'baseline') {
    // Use the scenario's declared baselineDoc if present; otherwise fall
    // back to running the stub (no comparison signal — same envelope).
    if (typeof scenario.baselineDoc === 'string') return baselineModel(scenario.baselineDoc);
    if (typeof scenario.stub === 'function') return scenario.stub();
    throw new Error(`scenario ${scenario.id} has neither baselineDoc nor stub`);
  }
  // Real model paths — RWA_OPENROUTER_KEY required.
  return openRouterModel({ model: modelName });
}

async function runOnce(scenario, modelName) {
  const ctx = await harness.fresh();
  try {
    const fixture = resolveFixture(scenario);
    // Setup: write fixture directly to IDB. Bypasses runtime validation
    // (replaceDocument forbids introducing frozen zones, structural shape
    // changes vs the seed default, etc. — none of which matter for
    // fixture setup, all of which need to be settable for fidelity tests).
    await ctx.setDoc(fixture);

    let success, stability;
    let wall_ms = 0, stats = { tokens_in: 0, tokens_out: 0, tokens_total: 0, fetch_calls: 0 };
    let result = fixture;
    let editEnvelope = null;

    if (typeof scenario.customRun === 'function' && typeof scenario.scoreAfterCustom === 'function') {
      const t0 = Date.now();
      const out = await scenario.customRun({ ctx, fixture });
      wall_ms = Date.now() - t0;
      result = await ctx.getDoc();
      const scored = scenario.scoreAfterCustom(out, fixture, result);
      success = scored.successResult;
      stability = scored.stabilityResult;
    } else {
      const model = selectModel(modelName, scenario);
      const { handler, getStats } = modelToFetch(model);
      ctx.setFetchHandler(handler);

      const t0 = Date.now();
      try {
        await ctx.modify(scenario.prompt);
      } catch (err) {
        // modify rejections (e.g. concurrent_modify) fall through; success
        // oracle decides whether that's expected.
      }
      wall_ms = Date.now() - t0;

      result = await ctx.getDoc();
      const hist = await ctx.getHistory();
      editEnvelope = hist[0]?.kind === 'edit_batch' ? hist[0].envelope : null;
      stats = getStats();

      success = await scenario.success(result, fixture);
      stability = await scenario.stability(fixture, result, editEnvelope);
    }
    return {
      ok: true,
      wall_ms,
      tokens_in: stats.tokens_in,
      tokens_out: stats.tokens_out,
      tokens_total: stats.tokens_total,
      retry_rounds: Math.max(0, stats.fetch_calls - 1),
      S: success.score,
      T: stability.score,
      drift_ratio: stability.drift_ratio,
      success_detail: success,
      stability_detail: stability,
    };
  } finally {
    ctx.dispose();
  }
}

function median(nums) {
  if (nums.length === 0) return 0;
  const sorted = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function mean(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}
function p95(nums) {
  if (nums.length === 0) return 0;
  const sorted = nums.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx];
}

async function main() {
  const modelName = process.argv[2] || 'stub';
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const scenarios = await discoverScenarios();
  console.log(`== rwa-edit fidelity — ${scenarios.length} scenario(s) discovered (model=${modelName}) ==\n`);

  const allResults = [];
  for (const s of scenarios) {
    const N = s.N || 5;
    process.stdout.write(`  [${s.id}] ${s.description || ''} (N=${N}) `);
    const runs = [];
    for (let i = 0; i < N; i++) {
      const r = await runOnce(s, modelName);
      runs.push(r);
      process.stdout.write(`${r.S}${r.T}`);
      if (i < N - 1) process.stdout.write(' ');
    }
    console.log('');
    const meanS = mean(runs.map(r => r.S));
    const meanT = mean(runs.map(r => r.T));
    const medianDrift = median(runs.map(r => r.drift_ratio));
    const tokens_total_med = median(runs.map(r => r.tokens_total));
    const tokens_total_p95 = p95(runs.map(r => r.tokens_total));
    const wall_ms_med = median(runs.map(r => r.wall_ms));
    allResults.push({
      id: s.id,
      category: s.category,
      N,
      meanS,
      meanT,
      medianDrift,
      tokens_total_med,
      tokens_total_p95,
      wall_ms_med,
      runs,
    });
    console.log(`        meanS=${meanS.toFixed(2)}  meanT=${meanT.toFixed(2)}  drift_ratio=${medianDrift.toFixed(4)}  tokens_med=${tokens_total_med}  wall_ms_med=${wall_ms_med}`);
  }

  const tsvPath = path.join(RESULTS_DIR, 'fidelity.tsv');
  const tsvLines = [
    '# model: ' + modelName,
    ['id', 'category', 'N', 'meanS', 'meanT', 'medianDrift', 'tokens_med', 'tokens_p95', 'wall_ms_med'].join('\t'),
    ...allResults.map(r => [r.id, r.category, r.N, r.meanS.toFixed(3), r.meanT.toFixed(3), r.medianDrift.toFixed(5), r.tokens_total_med, r.tokens_total_p95, r.wall_ms_med].join('\t')),
  ];
  fs.writeFileSync(tsvPath, tsvLines.join('\n') + '\n');

  // Headline numbers
  const overallMeanS = mean(allResults.map(r => r.meanS));
  const overallMeanT = mean(allResults.map(r => r.meanT));
  const overallMedianDrift = median(allResults.map(r => r.medianDrift));
  console.log(`\nOverall: meanS=${overallMeanS.toFixed(2)}  meanT=${overallMeanT.toFixed(2)}  median_drift=${overallMedianDrift.toFixed(4)} across ${allResults.length} scenario(s)`);
}

main().catch(err => {
  console.error('runner crashed:', err);
  process.exit(2);
});
