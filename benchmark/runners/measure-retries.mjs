#!/usr/bin/env node
// benchmark/runners/measure-retries.mjs — measure the apply_edits retry rate.
//
// Counts how often the modify() multi-turn loop in seeds/rewritable.html
// fires a retry, broken down by failure code (find_not_unique,
// find_not_found, frozen_zone_violation, etc.). This is the empirical
// signal that decides whether a scout tool like grep_doc is worth adding
// to the agent contract.
//
// Re-uses harness.fresh() + the fidelity scenario set; instruments the
// fetch handler to capture tool_result messages flowing back from the
// runtime to the model. Each tool_result is a JSON object with `ok:false`
// and a `code` field (see failureToToolResult in the seed). The k-th
// request body contains all previously-fed-back failures, so we only
// count failures from the *last* request body to avoid double-counting.
//
// Usage:
//   node benchmark/runners/measure-retries.mjs <model> [N]
//     <model>: stub | <openrouter-model-id> (e.g. google/gemini-3.1-flash-lite-preview)
//     [N]:     runs per scenario (default 3; scenario-declared N overrides if smaller)
//
// Notes:
// - Stub mode is useful as a sanity check (stubs are designed to succeed
//   on first attempt, so retry rate should be 0).
// - Custom-run scenarios (those that bypass modify()) are skipped.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as harness from './harness.mjs';
import { openRouterModel, modelToFetch } from './model.mjs';

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
      console.error(`  SKIP ${f}: ${err.message}`);
    }
  }
  return scenarios;
}

function loadFixture(name) {
  const p = path.join(FIXTURES_DIR, 'templates', name + '.html');
  if (!fs.existsSync(p)) throw new Error(`fixture not found: ${name}`);
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

function resolveFixture(scenario) {
  if (typeof scenario.fixtureContent === 'string') {
    return scenario.fixtureContent.replace(/\r\n/g, '\n');
  }
  if (typeof scenario.fixture === 'string') return loadFixture(scenario.fixture);
  throw new Error(`scenario ${scenario.id}: missing fixture`);
}

// Wrap a model's fetch handler so we can extract tool_result failures
// from request bodies. Each retry round adds an `{ role: 'tool', content: '<json>' }`
// message to the conversation; the JSON is `{ ok: false, code: '...', edit_index?: N, ... }`.
// We replace (not accumulate) the captured list on each request, so after
// the run, the captured list reflects the last (most complete) body.
function instrumentedModelToFetch(model) {
  const base = modelToFetch(model);
  const origHandler = base.handler;
  let lastBodyFailures = [];
  const handler = async (url, opts) => {
    const body = typeof opts?.body === 'string' ? JSON.parse(opts.body) : {};
    const failures = [];
    for (const msg of body.messages || []) {
      if (msg.role !== 'tool') continue;
      try {
        const c = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
        if (c && c.ok === false && c.code) {
          failures.push({ code: c.code, edit_index: c.edit_index ?? null });
        }
      } catch (_) { /* non-JSON tool result, ignore */ }
    }
    if (failures.length > lastBodyFailures.length) lastBodyFailures = failures;
    return origHandler(url, opts);
  };
  return { handler, getStats: base.getStats, getFailures: () => lastBodyFailures.slice() };
}

function selectModel(modelName, scenario) {
  if (modelName === 'stub') {
    if (typeof scenario.stub !== 'function') return null;
    return scenario.stub();
  }
  return openRouterModel({ model: modelName });
}

async function runOnce(scenario, modelName) {
  // Skip custom-run scenarios — they bypass modify().
  if (typeof scenario.customRun === 'function') return { skipped: true, reason: 'custom_run' };

  const model = selectModel(modelName, scenario);
  if (!model) return { skipped: true, reason: 'no_stub' };

  const ctx = await harness.fresh();
  try {
    const fixture = resolveFixture(scenario);
    await ctx.setDoc(fixture);

    const inst = instrumentedModelToFetch(model);
    ctx.setFetchHandler(inst.handler);

    let modifyErr = null;
    try { await ctx.modify(scenario.prompt); }
    catch (err) { modifyErr = err; }

    const stats = inst.getStats();
    const failures = inst.getFailures();
    return {
      skipped: false,
      fetch_calls: stats.fetch_calls,
      retry_rounds: Math.max(0, stats.fetch_calls - 1),
      failures,                                   // [{ code, edit_index }]
      tool_counts: stats.tool_counts,
      modify_threw: modifyErr ? (modifyErr.code || modifyErr.message || 'error') : null,
    };
  } finally {
    ctx.dispose();
  }
}

function mean(nums) { return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0; }
function pct(num, denom) { return denom === 0 ? 0 : (num / denom) * 100; }

async function main() {
  const modelName = process.argv[2] || 'stub';
  const N_OVERRIDE = process.argv[3] ? Number(process.argv[3]) : null;

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const scenarios = await discoverScenarios();
  console.log(`== measure-retries — model=${modelName}, ${scenarios.length} scenario(s) ==\n`);

  const perScenario = [];
  let totalRuns = 0;
  let totalRetries = 0;
  let runsWithAnyRetry = 0;
  let runsThatThrew = 0;
  const failureCodeCounts = Object.create(null);
  const toolCountTotals = Object.create(null);

  for (const s of scenarios) {
    const declaredN = s.N || 5;
    const N = N_OVERRIDE != null ? Math.min(N_OVERRIDE, declaredN) : Math.min(3, declaredN);
    process.stdout.write(`  [${s.id}] (N=${N}) `);
    const runs = [];
    for (let i = 0; i < N; i++) {
      let r;
      try { r = await runOnce(s, modelName); }
      catch (err) { r = { error: String(err.message || err) }; }
      runs.push(r);
      if (r.skipped) process.stdout.write('-');
      else if (r.error) process.stdout.write('E');
      else process.stdout.write(String(r.retry_rounds));
    }
    console.log('');
    const valid = runs.filter(r => !r.skipped && !r.error);
    if (valid.length === 0) {
      perScenario.push({ id: s.id, tag: s.tag || 'untagged', N: 0, skipped: true });
      continue;
    }
    const retries = valid.map(r => r.retry_rounds);
    const meanRetries = mean(retries);
    const anyRetry = valid.filter(r => r.retry_rounds > 0).length;
    const threw = valid.filter(r => r.modify_threw).length;

    totalRuns += valid.length;
    totalRetries += retries.reduce((a, b) => a + b, 0);
    runsWithAnyRetry += anyRetry;
    runsThatThrew += threw;

    for (const r of valid) {
      for (const f of r.failures || []) {
        failureCodeCounts[f.code] = (failureCodeCounts[f.code] || 0) + 1;
      }
      for (const [name, count] of Object.entries(r.tool_counts || {})) {
        toolCountTotals[name] = (toolCountTotals[name] || 0) + count;
      }
    }

    perScenario.push({
      id: s.id, tag: s.tag || 'untagged', N: valid.length,
      meanRetries, anyRetryPct: pct(anyRetry, valid.length),
      threwPct: pct(threw, valid.length),
      runs: valid,
    });
    const failCodes = valid.flatMap(r => r.failures.map(f => f.code));
    const uniqueFailCodes = [...new Set(failCodes)];
    console.log(`        meanRetries=${meanRetries.toFixed(2)}  anyRetry=${pct(anyRetry, valid.length).toFixed(0)}%  threw=${threw}/${valid.length}  codes={${uniqueFailCodes.join(', ')}}`);
  }

  console.log('\n=========================================');
  console.log('HEADLINE');
  console.log('=========================================');
  console.log(`Total runs:           ${totalRuns}`);
  console.log(`Total retry rounds:   ${totalRetries}`);
  console.log(`Mean retries / run:   ${(totalRetries / Math.max(1, totalRuns)).toFixed(3)}`);
  console.log(`Runs with ≥1 retry:   ${runsWithAnyRetry}/${totalRuns} (${pct(runsWithAnyRetry, totalRuns).toFixed(1)}%)`);
  console.log(`Runs that threw:      ${runsThatThrew}/${totalRuns} (${pct(runsThatThrew, totalRuns).toFixed(1)}%)`);
  console.log('\nFailure code distribution (fed-back tool_result errors):');
  const sortedCodes = Object.entries(failureCodeCounts).sort((a, b) => b[1] - a[1]);
  if (sortedCodes.length === 0) {
    console.log('  (none observed)');
  } else {
    for (const [code, count] of sortedCodes) {
      console.log(`  ${code.padEnd(28)} ${count}`);
    }
  }
  console.log('\nTool-call counts (across all runs):');
  for (const [name, count] of Object.entries(toolCountTotals).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${name.padEnd(28)} ${count}`);
  }

  // Per-tag breakdown — same axis run-fidelity.mjs uses.
  console.log('\nBy tag:');
  const byTag = new Map();
  for (const r of perScenario) {
    if (r.skipped) continue;
    if (!byTag.has(r.tag)) byTag.set(r.tag, []);
    byTag.get(r.tag).push(r);
  }
  for (const [tag, rs] of [...byTag.entries()].sort()) {
    const allRuns = rs.flatMap(r => r.runs);
    const retries = allRuns.map(r => r.retry_rounds);
    const anyRetry = allRuns.filter(r => r.retry_rounds > 0).length;
    console.log(`  ${tag.padEnd(22)} scenarios=${rs.length}  runs=${allRuns.length}  meanRetries=${mean(retries).toFixed(2)}  anyRetry=${pct(anyRetry, allRuns.length).toFixed(0)}%`);
  }

  // Persist a TSV for record-keeping.
  const tsvPath = path.join(RESULTS_DIR, `retries.${modelName.replace(/[\/:]/g, '-')}.tsv`);
  const tsvLines = [
    `# model: ${modelName}  total_runs: ${totalRuns}  any_retry_pct: ${pct(runsWithAnyRetry, totalRuns).toFixed(2)}`,
    '# failure_codes: ' + sortedCodes.map(([c, n]) => `${c}=${n}`).join(' '),
    ['id', 'tag', 'N', 'meanRetries', 'anyRetryPct', 'threwPct'].join('\t'),
    ...perScenario.filter(r => !r.skipped).map(r =>
      [r.id, r.tag, r.N, r.meanRetries.toFixed(3), r.anyRetryPct.toFixed(1), r.threwPct.toFixed(1)].join('\t')
    ),
  ];
  fs.writeFileSync(tsvPath, tsvLines.join('\n') + '\n');
  console.log(`\nWrote ${tsvPath}`);
}

main().catch(err => { console.error('runner crashed:', err); process.exit(2); });
