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
    // No stub fallback. Until 2026-08-27 this silently ran the *stub* — the
    // PERFECT model — for any scenario without a baselineDoc, which was 107 of
    // 108 of them. The "bad model" run was therefore a copy of the good model
    // run, reporting meanT=1.98 / drift=0.0000 and reading as "models are fine"
    // rather than "this lane measures nothing". main() now filters the run down
    // to scenarios that actually carry a baselineDoc and says how many it
    // dropped, so this branch is only reached for those; it throws rather than
    // quietly substituting a different model.
    if (typeof scenario.baselineDoc === 'string') return baselineModel(scenario.baselineDoc);
    throw new Error(
      `scenario ${scenario.id} has no baselineDoc — it cannot participate in a baseline run. ` +
      `(The suite-wide negative control is \`npm run fidelity:control\`.)`);
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

// Renders a null aggregate (a tag with no stability sample at all) as an
// explicit dash rather than letting mean([])===0 print as a perfect-zero score.
function fmt(v, d) { return v === null || v === undefined ? '—' : v.toFixed(d); }

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
  let scenarios = await discoverScenarios();
  // RWA_FID_ONLY: comma-separated filter terms; a scenario matches if any term
  // equals/prefixes its id or is a substring of its category/tag. Lets slow
  // real-model (bridge) runs target a representative subset instead of all 108.
  const only = (process.env.RWA_FID_ONLY || '').trim();
  if (only) {
    const terms = only.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    scenarios = scenarios.filter(s => {
      const id = (s.id || '').toLowerCase();
      const cat = (s.category || '').toLowerCase();
      const tag = (s.tag || '').toLowerCase();
      return terms.some(t => id === t || id.startsWith(t) || cat.includes(t) || tag.includes(t));
    });
  }
  if (modelName === 'baseline') {
    // The baseline lane is a CALIBRATION check — "does a deliberately bad model
    // actually score worse here?" — and it can only ask that of scenarios that
    // carry a baselineDoc describing what bad looks like. One does. Run those
    // and name the rest out loud, rather than padding the average with 107
    // copies of the perfect model and reporting the result as a suite score.
    const withBaseline = scenarios.filter(s => typeof s.baselineDoc === 'string');
    const dropped = scenarios.length - withBaseline.length;
    if (dropped > 0) {
      console.log(`NOTE: ${dropped} of ${scenarios.length} scenarios have no baselineDoc and are EXCLUDED from this run.`);
      console.log(`      A baseline run covers only what has been calibrated — ${withBaseline.length} scenario(s): ${withBaseline.map(s => s.id).join(', ') || '(none)'}.`);
      console.log(`      For a negative control across all ${scenarios.length}, run \`npm run fidelity:control\`.\n`);
    }
    if (withBaseline.length === 0) {
      console.error('No scenario declares a baselineDoc — nothing to calibrate against.');
      process.exit(2);
    }
    scenarios = withBaseline;
  }

  console.log(`== rwa-edit fidelity — ${scenarios.length} scenario(s)${only ? ` (filtered by RWA_FID_ONLY=${only})` : ''} (model=${modelName}, mode=${mode}) ==\n`);

  const deterministic = modelName === 'stub' || modelName === 'baseline';
  const allResults = [];
  for (const s of scenarios) {
    // RWA_FID_N overrides per-scenario N (e.g. =1 to keep slow bridge runs short).
    //
    // Otherwise N is model-aware. Under the stub the trace is fixed, so N:1 is
    // exactly right and repetition buys nothing. Under a REAL model the same
    // N:1 means a single sample decides the scenario — and anchor-precision
    // failures are intermittent, so one unlucky draw flips it. 14 scenarios
    // shipped N:1, one of them carrying the comment "deterministic with stub;
    // for real model bump to 10", which is a note-to-self that never became
    // behaviour. A scenario can still opt into a specific real-model count with
    // `Nreal`.
    const N = process.env.RWA_FID_N
      ? Math.max(1, parseInt(process.env.RWA_FID_N, 10) || 1)
      : deterministic ? (s.N || 1) : (s.Nreal || Math.max(3, s.N || 3));
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
    // retry_rounds was computed per run since this runner was written and then
    // dropped on the floor — it reached no summary line, no TSV column, nothing.
    // It is a first-class signal: a model that only gets there on attempt 3
    // costs 3x the tokens and 3x the latency of one that lands it first try,
    // and scores identically on every other number here.
    const retry_rounds_med = median(runs.map(r => r.retry_rounds));
    const retry_rounds_max = Math.max(...runs.map(r => r.retry_rounds));
    // Distribution, not central tendency. median_drift over a suite where most
    // scenarios are legitimately 0 can never move, so it reported 0.0000 even
    // on runs where meanT had visibly dropped. The rare catastrophic rewrite is
    // the entire product meaning of this signal — measure the tail and the rate.
    const drift_p95 = p95(runs.map(r => r.drift_ratio));
    const zero_drift_rate = runs.filter(r => r.drift_ratio === 0).length / runs.length;
    const perfect_rate = runs.filter(r => r.S === 2 && r.T === 2).length / runs.length;
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
      retry_rounds_med,
      retry_rounds_max,
      drift_p95,
      zero_drift_rate,
      perfect_rate,
      // Scenarios whose stability oracle is a hardcoded score:2 (declared
      // driftProbe:'none' and gated by `npm run fidelity:control`) measure no
      // drift at all. Averaging their free 2.0 into meanT inflated the headline
      // stability of every run ever recorded here — 17 of 108 scenarios were
      // voting on a dimension they do not measure. They stay in the S aggregate,
      // which they DO measure, and are excluded from the stability aggregates.
      noDriftDimension: s.driftProbe === 'none',
      toolCounts,
      runs,
      // customRun scenarios drive modify() themselves; the harness collects no
      // token stats on that path, so zero tokens is normal for them.
      customRun: typeof s.customRun === 'function',
    });
    console.log(`        meanS=${meanS.toFixed(2)}  meanT=${meanT.toFixed(2)}  drift_p95=${drift_p95.toFixed(4)}  zero_drift=${(zero_drift_rate * 100).toFixed(0)}%  retries=${retry_rounds_med}${retry_rounds_max > retry_rounds_med ? `/${retry_rounds_max}max` : ''}  tok=${tokens_in_med}/${tokens_out_med} (in/out)  wall=${wall_ms_med}ms`);
  }

  // fidelity.tsv is the canonical FULL-run output (multimodel.mjs reads it
  // right after each child run). A filtered run writes elsewhere so it can
  // never clobber a full run's results.
  const tsvPath = path.join(RESULTS_DIR, only ? 'fidelity.partial.tsv' : 'fidelity.tsv');
  const tsvLines = [
    '# model: ' + modelName + ', mode: ' + mode,
    ['id', 'category', 'tag', 'N', 'meanS', 'meanT', 'medianDrift', 'driftP95', 'zeroDriftRate', 'perfectRate', 'retryMed', 'retryMax', 'noDriftDim', 'tokens_in_med', 'tokens_out_med', 'tokens_total_med', 'tokens_total_p95', 'wall_ms_med', 'wall_ms_p95'].join('\t'),
    ...allResults.map(r => [r.id, r.category, r.tag, r.N, r.meanS.toFixed(3), r.meanT.toFixed(3), r.medianDrift.toFixed(5), r.drift_p95.toFixed(5), r.zero_drift_rate.toFixed(3), r.perfect_rate.toFixed(3), r.retry_rounds_med, r.retry_rounds_max, r.noDriftDimension ? 1 : 0, r.tokens_in_med, r.tokens_out_med, r.tokens_total_med, r.tokens_total_p95, r.wall_ms_med, r.wall_ms_p95].join('\t')),
  ];
  fs.writeFileSync(tsvPath, tsvLines.join('\n') + '\n');
  if (!only && modelName !== 'stub' && modelName !== 'baseline') {
    // Real-model runs are expensive; keep a model-named copy so the next
    // invocation's fidelity.tsv overwrite can't erase this one.
    const slug = modelName.replace(/[^A-Za-z0-9_-]/g, '_');
    fs.copyFileSync(tsvPath, path.join(RESULTS_DIR, `fidelity.${slug}.tsv`));
  }

  // Headline numbers.
  //
  // Stability aggregates are computed over the scenarios that actually MEASURE
  // stability. The 17 scenarios declaring driftProbe:'none' return a hardcoded
  // score:2 (they assert runtime behaviour or tool_result payload shape, not
  // document bytes); averaging that in was quietly adding ~17 free perfect
  // scores to every meanT this suite has ever printed.
  const stabilityScored = allResults.filter(r => !r.noDriftDimension);
  const excluded = allResults.length - stabilityScored.length;

  const overallMeanS = mean(allResults.map(r => r.meanS));
  const overallMeanT = mean(stabilityScored.map(r => r.meanT));
  const overallMedianDrift = median(stabilityScored.map(r => r.medianDrift));
  const overallDriftP95 = p95(stabilityScored.map(r => r.drift_p95));
  const overallZeroDrift = mean(stabilityScored.map(r => r.zero_drift_rate));
  const overallPerfect = mean(allResults.map(r => r.perfect_rate));
  const overallRetries = mean(allResults.map(r => r.retry_rounds_med));

  console.log(`\nOverall (${allResults.length} scenario(s)):`);
  console.log(`  task success    meanS=${overallMeanS.toFixed(2)}`);
  console.log(`  perfect runs    ${(overallPerfect * 100).toFixed(1)}%   (S=2 AND T=2 on the same run)`);
  console.log(`  ZERO-DRIFT RATE ${(overallZeroDrift * 100).toFixed(1)}%   ← the product signal: how often nothing outside the edit moved`);
  console.log(`  drift tail      p95=${overallDriftP95.toFixed(4)}   median=${overallMedianDrift.toFixed(4)} (median is near-blind here — kept for continuity)`);
  console.log(`  stability       meanT=${overallMeanT.toFixed(2)}   over ${stabilityScored.length} scenario(s); ${excluded} excluded as driftProbe:'none'`);
  console.log(`  retry rounds    mean=${overallRetries.toFixed(2)}   (0 = landed it first attempt)`);

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
    // A tag whose every scenario declares driftProbe:'none' has NO stability
    // sample. mean([]) is 0, which would print as meanT=0.00 — a catastrophic
    // reading for a tag that simply doesn't measure the dimension. Carry the
    // emptiness through as null and render it as '—'.
    const stab = rs.filter(t => !t.noDriftDimension);
    const agg = {
      tag,
      N: rs.length,
      stabN: stab.length,
      meanS: mean(rs.map(r => r.meanS)),
      meanT: stab.length ? mean(stab.map(r => r.meanT)) : null,
      drift: stab.length ? p95(stab.map(r => r.drift_p95)) : null,
      zeroDrift: stab.length ? mean(stab.map(r => r.zero_drift_rate)) : null,
      retries: mean(rs.map(r => r.retry_rounds_med)),
      tokens_in_med: Math.round(median(rs.map(r => r.tokens_in_med))),
      tokens_out_med: Math.round(median(rs.map(r => r.tokens_out_med))),
      tokens_total_med: Math.round(median(rs.map(r => r.tokens_total_med))),
      wall_ms_med: Math.round(median(rs.map(r => r.wall_ms_med))),
      wall_ms_p95: Math.round(median(rs.map(r => r.wall_ms_p95))),
      toolCounts: tagToolCounts,
    };
    tagAggregates.push(agg);
    const toolStr = Object.entries(tagToolCounts).map(([n, c]) => `${n}=${c}`).join(' ');
    console.log(`  ${tag.padEnd(22)} meanS=${agg.meanS.toFixed(2)}  meanT=${fmt(agg.meanT, 2)}  drift_p95=${fmt(agg.drift, 4)}  zero_drift=${agg.zeroDrift === null ? ' n/a' : (agg.zeroDrift*100).toFixed(0)+'%'}  retries=${agg.retries.toFixed(1)}  tok_in=${agg.tokens_in_med}  tok_out=${agg.tokens_out_med}  wall_med=${agg.wall_ms_med}ms  (N=${agg.N})  tools={${toolStr}}`);
  }

  // Write a markdown summary alongside the TSV.
  writeFidelitySummary(modelName, mode, allResults, tagAggregates, {
    overallMeanS, overallMeanT, overallMedianDrift,
  });

  // A real-model scenario that ends with zero tokens never completed a call
  // (dead API key, API-side refusal, unparseable output) — its score measures
  // the failed call, not the model's editing. Scoring that silently is how a
  // dead key produced a plausible-looking all-zero "gemini" run (2026-08-05).
  if (modelName !== 'stub' && modelName !== 'baseline') {
    const silent = allResults.filter(r => !r.customRun && r.tokens_total_med === 0);
    if (silent.length) {
      console.error(`\n✗ ${silent.length} scenario(s) returned ZERO tokens — the model call itself failed (auth/refusal/parse); their scores are not edit-quality signal:`);
      console.error('  ' + silent.map(r => r.id).join(', '));
      process.exitCode = 1;
    }
  }
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
      `| ${a.tag} | ${a.N} | ${a.meanS.toFixed(2)} | ${fmt(a.meanT, 2)} | ${fmt(a.drift, 4)} | ${a.tokens_in_med} | ${a.tokens_out_med} | ${a.tokens_total_med} | ${a.wall_ms_med} | ${a.wall_ms_p95} |`,
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
