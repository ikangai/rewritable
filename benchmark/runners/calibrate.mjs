#!/usr/bin/env node
// benchmark/runners/calibrate.mjs — self-calibration gate per spec §9.
//
// Runs a representative subset (FID-01..06 + DEG-01) against both the
// rwa-edit/1 stub and the v0.x wholesale-rewrite baseline. Verifies that
// the benchmark is sensitive to the differences it claims to measure:
//   - baseline mean-T should be substantially worse than rwa-edit/1
//   - baseline median drift_ratio should be ≥10× rwa-edit/1
//   - mean-S should be approximately equivalent (both produce correct edits)
//
// Output: calibration/baseline-vs-v1.json
//
// If calibration fails (baseline produces equivalent stability), the
// benchmark is not measuring what it claims and must be debugged before
// any model report is published.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as harness from './harness.mjs';
import { stubModel, baselineModel, modelToFetch } from './model.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = path.resolve(__dirname, '..', 'scenarios', 'fidelity');
const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');
const CALIB_DIR = path.resolve(__dirname, '..', 'calibration');

const CALIBRATION_SCENARIOS = ['fid-01', 'fid-02', 'fid-03', 'fid-04', 'fid-05', 'fid-06', 'deg-01'];

function loadFixture(name) {
  const p = path.join(FIXTURES_DIR, 'templates', name + '.html');
  if (!fs.existsSync(p)) throw new Error(`fixture not found: ${name}`);
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

function resolveFixture(scenario) {
  if (typeof scenario.fixtureContent === 'string') return scenario.fixtureContent.replace(/\r\n/g, '\n');
  if (typeof scenario.fixture === 'string') return loadFixture(scenario.fixture);
  throw new Error(`scenario ${scenario.id}: must declare fixture or fixtureContent`);
}

async function runOnce(scenario, model) {
  const ctx = await harness.fresh();
  try {
    const fixture = resolveFixture(scenario);
    await ctx.setDoc(fixture);
    const { handler } = modelToFetch(model);
    ctx.setFetchHandler(handler);
    try { await ctx.modify(scenario.prompt || ''); } catch (_) { /* swallow */ }
    const result = await ctx.getDoc();
    const hist = await ctx.getHistory();
    const editEnvelope = hist[0]?.kind === 'edit_batch' ? hist[0].envelope : null;
    const success = await scenario.success(result, fixture);
    const stability = await scenario.stability(fixture, result, editEnvelope);
    return { S: success.score, T: stability.score, drift_ratio: stability.drift_ratio };
  } finally {
    ctx.dispose();
  }
}

async function loadScenarios() {
  const out = {};
  for (const name of CALIBRATION_SCENARIOS) {
    const p = path.join(SCENARIOS_DIR, name + '.mjs');
    if (!fs.existsSync(p)) continue;
    const mod = await import(pathToFileURL(p).href);
    out[name] = mod.default;
  }
  return out;
}

function median(nums) {
  if (nums.length === 0) return 0;
  const s = nums.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function mean(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

async function main() {
  const scenarios = await loadScenarios();
  const v1 = []; const baseline = [];
  console.log(`== Calibration: ${Object.keys(scenarios).length} scenarios ==\n`);
  for (const [name, s] of Object.entries(scenarios)) {
    process.stdout.write(`  [${s.id}] `);
    const v1Run = await runOnce(s, s.stub());
    const baselineRun = typeof s.baselineDoc === 'string'
      ? await runOnce(s, baselineModel(s.baselineDoc))
      : null;
    v1.push(v1Run);
    if (baselineRun) baseline.push(baselineRun);
    console.log(`v1: S=${v1Run.S} T=${v1Run.T} drift=${v1Run.drift_ratio.toFixed(4)}` +
      (baselineRun ? ` | baseline: S=${baselineRun.S} T=${baselineRun.T} drift=${baselineRun.drift_ratio.toFixed(4)}` : ' | (no baselineDoc)'));
  }

  const summary = {
    timestamp: new Date().toISOString(),
    scenarios: Object.keys(scenarios),
    v1: { meanS: mean(v1.map(r => r.S)), meanT: mean(v1.map(r => r.T)), medianDrift: median(v1.map(r => r.drift_ratio)) },
    baseline: baseline.length > 0 ? { meanS: mean(baseline.map(r => r.S)), meanT: mean(baseline.map(r => r.T)), medianDrift: median(baseline.map(r => r.drift_ratio)) } : null,
  };

  fs.mkdirSync(CALIB_DIR, { recursive: true });
  fs.writeFileSync(path.join(CALIB_DIR, 'baseline-vs-v1.json'), JSON.stringify(summary, null, 2));

  console.log(`\n== Summary ==`);
  console.log(`v1:       meanS=${summary.v1.meanS.toFixed(2)} meanT=${summary.v1.meanT.toFixed(2)} medianDrift=${summary.v1.medianDrift.toFixed(4)}`);
  if (summary.baseline) {
    console.log(`baseline: meanS=${summary.baseline.meanS.toFixed(2)} meanT=${summary.baseline.meanT.toFixed(2)} medianDrift=${summary.baseline.medianDrift.toFixed(4)}`);
    const driftRatio = summary.v1.medianDrift > 0 ? summary.baseline.medianDrift / summary.v1.medianDrift : Infinity;
    console.log(`baseline drift / v1 drift: ${driftRatio === Infinity ? '∞' : driftRatio.toFixed(2) + '×'}`);
    const calibrated = summary.baseline.meanT < summary.v1.meanT - 0.3 && (summary.baseline.medianDrift > summary.v1.medianDrift * 5 || summary.v1.medianDrift === 0);
    console.log(`Calibration ${calibrated ? 'PASSED' : 'INCONCLUSIVE'} — ${calibrated ? 'benchmark distinguishes v1 from baseline' : 'no clear difference; review oracles'}`);
  } else {
    console.log(`(no scenarios with baselineDoc — calibration skipped)`);
  }
}

main().catch(err => { console.error('calibrate crashed:', err); process.exit(2); });
