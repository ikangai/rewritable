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
import { stubModel, openRouterModel, baselineModel, bridgeModel, modelToFetch } from './model.mjs';
import { runDslMode } from './dsl-mode.mjs';
import { runHybridMode, flattenStats } from './hybrid-mode.mjs';

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
  if (modelName === 'bridge') {
    // Local `claude -p` via the web_cli_bridge shim. No API key needed —
    // authenticates against the user's Claude Code subscription.
    return bridgeModel();
  }
  // Real model paths — RWA_OPENROUTER_KEY required.
  return openRouterModel({ model: modelName });
}

async function runOnce(scenario, modelName, mode) {
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
    } else if (mode === 'hybrid') {
      // Supervisor + workers orchestration. The doc evolves between steps;
      // ctx is shared across tier-dispatched calls. supervisor & structural
      // worker default to the same strong model (matching the May 2026
      // baseline finding that pro+DSL is best for both planning and structure);
      // content worker defaults to the cheap model.
      const supervisor = openRouterModel({
        model: process.env.RWA_HYBRID_SUPERVISOR || 'google/gemini-3.1-pro-preview',
      });
      const structuralWorker = openRouterModel({
        model: process.env.RWA_HYBRID_STRUCTURAL || process.env.RWA_HYBRID_SUPERVISOR || 'google/gemini-3.1-pro-preview',
      });
      const contentWorker = openRouterModel({
        model: process.env.RWA_HYBRID_CONTENT || 'google/gemini-3.1-flash-lite-preview',
      });
      const t0 = Date.now();
      const hybridOut = await runHybridMode(ctx, scenario.prompt, { supervisor, structuralWorker, contentWorker });
      wall_ms = Date.now() - t0;
      result = await ctx.getDoc();
      const hist = await ctx.getHistory();
      // Synthesize a single envelope from all edit_batch records committed
      // during the hybrid run. The stability oracle uses envelope.edits to
      // compute drift_ratio against expected regions in the FIXTURE; a
      // unioned envelope gives the right answer when all steps were
      // apply_edits. (Mixed plans with replace_document degrade gracefully:
      // any replace_document step short-circuits the doc, and subsequent
      // edits operate against the new doc — drift becomes ill-defined.)
      const allEdits = hist
        .filter(r => r?.kind === 'edit_batch')
        .flatMap(r => r.envelope?.edits || []);
      editEnvelope = allEdits.length > 0 ? { version: 'rwa-edit/1', edits: allEdits } : null;
      stats = flattenStats(hybridOut.stats);
      success = await scenario.success(result, fixture);
      stability = await scenario.stability(fixture, result, editEnvelope);
    } else if (mode === 'dsl') {
      // DSL plan mode — model emits apply_dsl_plan; we compile and apply.
      // Bypasses ctx.modify (which is bound to the runtime's apply_edits/
      // replace_document tool schema). Still uses ctx.applyEdits /
      // ctx.replaceDocument for the apply step so runtime validation runs.
      const model = selectModel(modelName, scenario);
      const currentDoc = await ctx.getDoc();
      const t0 = Date.now();
      const dslOut = await runDslMode(currentDoc, scenario.prompt, model);
      if (dslOut.envelope) {
        try {
          if (dslOut.envelope.tool === 'apply_edits') {
            await ctx.applyEdits(dslOut.envelope.envelope, currentDoc);
          } else if (dslOut.envelope.tool === 'replace_document') {
            await ctx.replaceDocument(dslOut.envelope.envelope, currentDoc);
          }
        } catch (_applyErr) {
          // Runtime rejected (frozen zone, structural shape, etc.) — leave
          // doc unchanged; success oracle scores against unchanged doc.
        }
      }
      wall_ms = Date.now() - t0;
      result = await ctx.getDoc();
      const hist = await ctx.getHistory();
      editEnvelope = hist[0]?.kind === 'edit_batch' ? hist[0].envelope : null;
      stats = {
        fetch_calls: dslOut.stats.fetch_calls,
        tokens_in: dslOut.stats.tokens_in,
        tokens_out: dslOut.stats.tokens_out,
        tokens_total: dslOut.stats.tokens_in + dslOut.stats.tokens_out,
      };
      success = await scenario.success(result, fixture);
      stability = await scenario.stability(fixture, result, editEnvelope);
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
      tool_counts: stats.tool_counts || {},
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
  const mode = process.argv[3] || 'apply_edits';
  if (mode !== 'apply_edits' && mode !== 'dsl' && mode !== 'hybrid') {
    console.error(`Unknown mode: ${mode}. Use 'apply_edits' (default), 'dsl', or 'hybrid'.`);
    process.exit(2);
  }
  if ((mode === 'dsl' || mode === 'hybrid') && modelName === 'stub') {
    console.error(`stub model not supported in ${mode} mode. Use a real model.`);
    process.exit(2);
  }
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const scenarios = await discoverScenarios();
  console.log(`== rwa-edit fidelity — ${scenarios.length} scenario(s) discovered (model=${modelName}, mode=${mode}) ==\n`);

  const allResults = [];
  for (const s of scenarios) {
    const N = s.N || 5;
    process.stdout.write(`  [${s.id}] ${s.description || ''} (N=${N}) `);
    const runs = [];
    for (let i = 0; i < N; i++) {
      const r = await runOnce(s, modelName, mode);
      runs.push(r);
      process.stdout.write(`${r.S}${r.T}`);
      if (i < N - 1) process.stdout.write(' ');
    }
    console.log('');
    const meanS = mean(runs.map(r => r.S));
    const meanT = mean(runs.map(r => r.T));
    const medianDrift = median(runs.map(r => r.drift_ratio));
    const tokens_in_med = median(runs.map(r => r.tokens_in));
    const tokens_out_med = median(runs.map(r => r.tokens_out));
    const tokens_total_med = median(runs.map(r => r.tokens_total));
    const tokens_total_p95 = p95(runs.map(r => r.tokens_total));
    const wall_ms_med = median(runs.map(r => r.wall_ms));
    const wall_ms_p95 = p95(runs.map(r => r.wall_ms));
    const toolCounts = {};
    for (const r of runs) {
      for (const [n, c] of Object.entries(r.tool_counts || {})) {
        toolCounts[n] = (toolCounts[n] || 0) + c;
      }
    }
    allResults.push({
      id: s.id,
      category: s.category,
      tag: s.tag || 'untagged',
      N,
      meanS,
      meanT,
      medianDrift,
      tokens_in_med,
      tokens_out_med,
      tokens_total_med,
      tokens_total_p95,
      wall_ms_med,
      wall_ms_p95,
      toolCounts,
      runs,
    });
    console.log(`        meanS=${meanS.toFixed(2)}  meanT=${meanT.toFixed(2)}  drift=${medianDrift.toFixed(4)}  tok=${tokens_in_med}/${tokens_out_med} (in/out)  wall=${wall_ms_med}ms`);
  }

  const tsvPath = path.join(RESULTS_DIR, 'fidelity.tsv');
  const tsvLines = [
    '# model: ' + modelName + ', mode: ' + mode,
    ['id', 'category', 'tag', 'N', 'meanS', 'meanT', 'medianDrift', 'tokens_in_med', 'tokens_out_med', 'tokens_total_med', 'tokens_total_p95', 'wall_ms_med', 'wall_ms_p95'].join('\t'),
    ...allResults.map(r => [r.id, r.category, r.tag, r.N, r.meanS.toFixed(3), r.meanT.toFixed(3), r.medianDrift.toFixed(5), r.tokens_in_med, r.tokens_out_med, r.tokens_total_med, r.tokens_total_p95, r.wall_ms_med, r.wall_ms_p95].join('\t')),
  ];
  fs.writeFileSync(tsvPath, tsvLines.join('\n') + '\n');

  // Headline numbers
  const overallMeanS = mean(allResults.map(r => r.meanS));
  const overallMeanT = mean(allResults.map(r => r.meanT));
  const overallMedianDrift = median(allResults.map(r => r.medianDrift));
  console.log(`\nOverall: meanS=${overallMeanS.toFixed(2)}  meanT=${overallMeanT.toFixed(2)}  median_drift=${overallMedianDrift.toFixed(4)} across ${allResults.length} scenario(s)`);

  // Per-tag breakdown — the architecture-comparison axis (separate from `category`).
  const TAG_ORDER = ['structural_regular', 'structural_irregular', 'content', 'mixed', 'paste', 'failure_mode', 'drift', 'runtime', 'untagged'];
  const byTag = new Map();
  for (const r of allResults) {
    if (!byTag.has(r.tag)) byTag.set(r.tag, []);
    byTag.get(r.tag).push(r);
  }
  console.log('\nBy tag:');
  const tagAggregates = [];
  for (const tag of TAG_ORDER) {
    const rs = byTag.get(tag);
    if (!rs || rs.length === 0) continue;
    const tagToolCounts = {};
    for (const r of rs) {
      for (const [n, c] of Object.entries(r.toolCounts || {})) {
        tagToolCounts[n] = (tagToolCounts[n] || 0) + c;
      }
    }
    const agg = {
      tag,
      N: rs.length,
      meanS: mean(rs.map(r => r.meanS)),
      meanT: mean(rs.map(r => r.meanT)),
      drift: median(rs.map(r => r.medianDrift)),
      tokens_in_med: Math.round(median(rs.map(r => r.tokens_in_med))),
      tokens_out_med: Math.round(median(rs.map(r => r.tokens_out_med))),
      tokens_total_med: Math.round(median(rs.map(r => r.tokens_total_med))),
      wall_ms_med: Math.round(median(rs.map(r => r.wall_ms_med))),
      wall_ms_p95: Math.round(median(rs.map(r => r.wall_ms_p95))),
      toolCounts: tagToolCounts,
    };
    tagAggregates.push(agg);
    const toolStr = Object.entries(tagToolCounts).map(([n, c]) => `${n}=${c}`).join(' ');
    console.log(`  ${tag.padEnd(22)} meanS=${agg.meanS.toFixed(2)}  meanT=${agg.meanT.toFixed(2)}  drift=${agg.drift.toFixed(4)}  tok_in=${agg.tokens_in_med}  tok_out=${agg.tokens_out_med}  wall_med=${agg.wall_ms_med}ms  (N=${agg.N})  tools={${toolStr}}`);
  }

  // Write a markdown summary alongside the TSV.
  writeFidelitySummary(modelName, mode, allResults, tagAggregates, {
    overallMeanS, overallMeanT, overallMedianDrift,
  });
}

function writeFidelitySummary(modelName, mode, allResults, tagAggregates, headline) {
  const lines = [
    '# Fidelity summary',
    '',
    `Model: \`${modelName}\` — mode: \`${mode}\` — ${allResults.length} scenarios.`,
    '',
    `**Overall**: meanS=${headline.overallMeanS.toFixed(2)}  meanT=${headline.overallMeanT.toFixed(2)}  median_drift=${headline.overallMedianDrift.toFixed(4)}`,
    '',
    '## By tag (architecture-comparison axis)',
    '',
    '| tag | N | meanS | meanT | drift | tok_in_med | tok_out_med | tok_total_med | wall_med (ms) | wall_p95 (ms) |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...tagAggregates.map(a =>
      `| ${a.tag} | ${a.N} | ${a.meanS.toFixed(2)} | ${a.meanT.toFixed(2)} | ${a.drift.toFixed(4)} | ${a.tokens_in_med} | ${a.tokens_out_med} | ${a.tokens_total_med} | ${a.wall_ms_med} | ${a.wall_ms_p95} |`,
    ),
    '',
    '## Per-scenario',
    '',
    '| id | tag | meanS | meanT | drift | tok_in | tok_out | wall_med (ms) |',
    '|---|---|---|---|---|---|---|---|',
    ...allResults.map(r =>
      `| ${r.id} | ${r.tag} | ${r.meanS.toFixed(2)} | ${r.meanT.toFixed(2)} | ${r.medianDrift.toFixed(4)} | ${r.tokens_in_med} | ${r.tokens_out_med} | ${r.wall_ms_med} |`,
    ),
    '',
  ];
  const out = path.join(RESULTS_DIR, 'fidelity-summary.md');
  fs.writeFileSync(out, lines.join('\n'));
  console.log(`\nWrote ${out}`);
}

main().catch(err => {
  console.error('runner crashed:', err);
  process.exit(2);
});
