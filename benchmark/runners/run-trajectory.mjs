#!/usr/bin/env node
// benchmark/runners/run-trajectory.mjs — the TRAJECTORY coherence benchmark +
// regression ratchet (issue #22: "measure what a document looks like after
// 50 sequential edits").
//
// benchmark/'s other two harnesses each measure a SINGLE transformation:
// run-import.mjs scores one converter pass, run-fidelity.mjs scores one
// modify() call. Neither says anything about what happens after dozens of
// them land back to back — per-edit fidelity can be perfect on every
// individual commit while heading hierarchy, class-name bloat, dead CSS, id
// duplication, and markup-vs-text growth all drift monotonically across the
// SEQUENCE. This runner closes that gap: it drives a scenario's scripted
// edit sequence through the REAL commit path (the same harness.mjs container
// run-fidelity.mjs boots — this file does not reimplement booting), then
// scores start-doc vs end-doc with oracles/coherence.mjs's five dimensions.
//
// *** WHAT THE STUB RUN MEASURES — READ BEFORE TRUSTING THIS GATE ***
// Every step in scenarios/trajectory/*.mjs is a scripted, deterministic stub
// envelope — nothing here calls a model. That means:
//   - This ratchet measures the SUBSTRATE: does applying N edits through the
//     real commit path (renderDoc, commitCore, data-rwa-id backfill, etc.)
//     accumulate structural damage ON ITS OWN — id duplication, orphaned
//     wrapper bytes, whatever — independent of what any model chooses to
//     write? The EDITS are exactly what the scenario author wrote, every
//     run, forever.
//   - It does NOT measure model drift. A real model that decides to sprinkle
//     a fresh wrapper div on every turn, or duplicate a heading, would not
//     be caught here — that behavior isn't in the loop.
//   - Measuring model drift would need a real-model mode (mirroring
//     fidelity's `openrouter`/`bridge` paths) driving actual multi-turn
//     modify() calls and scoring the result the same way. That mode is
//     NOT built here — see the report's "deliberately not done" note. Read a
//     green --check as "the substrate does not corrupt documents across a
//     long edit session on its own," never as "the model keeps documents
//     coherent."
//
// Modes (mirrors run-import.mjs exactly):
//   default  — a human table to stdout + benchmark/results/trajectory.tsv
//              (results/ is gitignored; the TSV is ephemeral inspection output).
//   --json   — the machine scores object to stdout, nothing else. Redirect it
//              to regenerate the baseline:
//                node runners/run-trajectory.mjs --json > baselines/trajectory.json
//   --check  — the RATCHET. Re-runs every scenario's edit sequence, re-scores
//              start-vs-end coherence, and compares to the committed
//              baseline; exits non-zero if any dimension dropped more than
//              TOL below its baseline (or a scenario errored / a scripted
//              step was rejected by the runtime / a scenario is new and
//              un-baselined). Improvements never fail — they only print a
//              "re-baseline to lock" hint. Re-baselining is an explicit,
//              reviewed commit (the repo's gate-change discipline).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as harness from './harness.mjs';
import { stubModel, modelToFetch } from './model.mjs';
import { scoreCoherence, DIMENSIONS } from '../oracles/coherence.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = path.resolve(__dirname, '..', 'scenarios', 'trajectory');
const RESULTS_DIR = path.resolve(__dirname, '..', 'results');
const BASELINE_PATH = path.resolve(__dirname, '..', 'baselines', 'trajectory.json');
const TOL = 0.02; // a dimension may not drop more than this below its baseline
const round4 = (x) => Math.round(x * 1e4) / 1e4;

// Discover benchmark/scenarios/trajectory/*.mjs, each default-exporting
// { id, description, startDoc, steps: [{ prompt, name, envelope }, ...] }.
function discoverScenarios() {
  if (!fs.existsSync(SCENARIOS_DIR)) return Promise.resolve([]);
  const files = fs.readdirSync(SCENARIOS_DIR)
    .filter((f) => f.endsWith('.mjs') && !f.startsWith('_'))
    .sort();
  return (async () => {
    const scenarios = [];
    for (const f of files) {
      const url = pathToFileURL(path.join(SCENARIOS_DIR, f)).href;
      try {
        const mod = await import(url);
        const s = mod.default;
        if (!s || typeof s.startDoc !== 'string' || !Array.isArray(s.steps)) {
          console.error(`  SKIP  ${f}: no default export with {startDoc, steps}`);
          continue;
        }
        scenarios.push({ ...s, _file: f });
      } catch (err) {
        console.error(`  SKIP  ${f}: load failed — ${err.message}`);
      }
    }
    return scenarios;
  })();
}

// Boot a fresh container, load the scenario's startDoc as the CURRENT doc
// (bypassing runtime validation — same pattern run-fidelity.mjs's harness
// uses for fixture setup; the scripted steps below are what exercises real
// validation), then drive every step through modify() on the REAL commit
// path so id-backfill, structural-shape checks, and renderDoc all run for
// real. A step that the runtime rejects (e.g. a hand-authored `find` that
// stopped matching after a prior step changed the text) fails the whole
// scenario LOUDLY — a silently-skipped step would score a trajectory that
// never actually happened.
async function runScenario(scenario) {
  const ctx = await harness.fresh();
  try {
    await ctx.setDoc(scenario.startDoc);
    let histLen = (await ctx.getHistory()).length;
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i];
      const model = stubModel([{ name: step.name, envelope: step.envelope }]);
      ctx.setFetchHandler(modelToFetch(model).handler);
      try {
        await ctx.modify(step.prompt || `step ${i + 1}`);
      } catch (err) {
        throw new Error(`step ${i + 1}/${scenario.steps.length} (${step.name}) failed: ${(err && err.message) || err}`);
      }
      // modify() does NOT throw when its retry budget exhausts on a rejected
      // tool call (find_not_found, structural_shape_changed, ...) — it
      // swallows the failure into a status message and leaves the doc
      // UNCHANGED (real, deliberate seed behavior: see modify()'s final
      // `else` branch in seeds/rewritable.html). A scripted step the runtime
      // silently rejected must fail LOUD here — Rule 12 — or the trajectory
      // scored below never actually happened.
      const newHistLen = (await ctx.getHistory()).length;
      if (newHistLen <= histLen) {
        throw new Error(
          `step ${i + 1}/${scenario.steps.length} (${step.name}) was rejected by the runtime — ` +
          'no rwa_hist entry was committed (the scripted find/replace likely no longer matches ' +
          'the live document, or violates a structural guard — see rwa-edit-spec.md §10)',
        );
      }
      histLen = newHistLen;
    }
    const endDoc = await ctx.getDoc();
    const { dimensions, notes } = scoreCoherence(scenario.startDoc, endDoc);
    const scores = {};
    for (const d of DIMENSIONS) scores[d] = round4(dimensions[d]);
    return { name: scenario.id, steps: scenario.steps.length, scores, notes };
  } catch (err) {
    return { name: scenario.id, error: (err && err.message) || String(err) };
  } finally {
    ctx.dispose();
  }
}

function printHuman(rows) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('scenario', 12), pad('steps', 7), DIMENSIONS.map((d) => pad(d, 12)).join(''));
  for (const r of rows) {
    if (r.error) { console.log(pad(r.name, 12), 'ERROR:', r.error); continue; }
    console.log(pad(r.name, 12), pad(r.steps, 7), DIMENSIONS.map((d) => pad(r.scores[d].toFixed(3), 12)).join(''));
  }
}

function writeTsv(rows) {
  const lines = [['scenario', 'steps', ...DIMENSIONS, 'notes'].join('\t')];
  for (const r of rows) {
    if (r.error) { lines.push([r.name, '', ...DIMENSIONS.map(() => ''), `ERROR: ${r.error}`].join('\t')); continue; }
    lines.push([r.name, r.steps, ...DIMENSIONS.map((d) => r.scores[d]), r.notes.join(' | ')].join('\t'));
  }
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const tsvPath = path.join(RESULTS_DIR, 'trajectory.tsv');
  fs.writeFileSync(tsvPath, lines.join('\n') + '\n');
  return tsvPath;
}

function loadBaseline() {
  let raw;
  try {
    raw = fs.readFileSync(BASELINE_PATH, 'utf8');
  } catch {
    throw new Error(
      `no baseline at ${path.relative(process.cwd(), BASELINE_PATH)} — generate it with:\n` +
      '  node runners/run-trajectory.mjs --json > baselines/trajectory.json',
    );
  }
  return JSON.parse(raw).scenarios || {};
}

// Same comparison shape as run-import.mjs's compareToBaseline: a regression
// is any dimension that dropped more than TOL below baseline; a scenario
// that errored now (but was scored in the baseline) is a total regression; a
// scenario missing from this run, or a NEW scenario absent from the
// baseline, both mean the gate no longer matches reality and must be
// resolved by re-baselining. Improvements are informational only.
function compareToBaseline(rows, baseline) {
  const cur = new Map(rows.map((r) => [r.name, r]));
  const regressions = [], missing = [], added = [], improvements = [];
  for (const [name, base] of Object.entries(baseline)) {
    const r = cur.get(name);
    if (!r) { missing.push(name); continue; }
    if (r.error) { regressions.push({ name, dim: '(scenario error)', base: 'scored', cur: r.error, drop: 1 }); continue; }
    if (base.error) continue; // baseline itself errored — nothing to regress from
    for (const d of DIMENSIONS) {
      const b = base[d], c = r.scores[d];
      if (typeof b !== 'number') continue; // baseline predates this dimension — nothing to compare
      if (c < b - TOL) regressions.push({ name, dim: d, base: b, cur: c, drop: b - c });
      else if (c > b + TOL) improvements.push({ name, dim: d, base: b, cur: c });
    }
  }
  for (const r of rows) if (!(r.name in baseline)) added.push(r.name);
  return { regressions, missing, added, improvements };
}

async function main() {
  const jsonMode = process.argv.includes('--json');
  const checkMode = process.argv.includes('--check');
  const scenarios = await discoverScenarios();
  const rows = [];
  let errored = 0;

  for (const s of scenarios) {
    const r = await runScenario(s);
    if (r.error) errored++;
    rows.push(r);
  }

  if (jsonMode) {
    // Minimal, stable shape for the baseline/ratchet — five dims per
    // scenario, no notes (notes are prose facts that would churn the
    // baseline on every wording tweak without signaling anything real).
    const scenariosOut = {};
    for (const r of rows) scenariosOut[r.name] = r.error ? { error: r.error } : r.scores;
    process.stdout.write(JSON.stringify({ scenarios: scenariosOut }, null, 2) + '\n');
    process.exit(errored ? 1 : 0);
  }

  printHuman(rows);
  for (const r of rows) if (!r.error) console.log(`  ${r.name}: ${r.notes.join(' | ')}`);

  if (checkMode) {
    const baseline = loadBaseline();
    const { regressions, missing, added, improvements } = compareToBaseline(rows, baseline);
    console.log('');
    for (const g of improvements) console.log(`  improved ${g.name}.${g.dim}: ${g.base} -> ${g.cur} (re-baseline to lock)`);
    for (const n of added) console.error(`  NEW scenario not in baseline: ${n} — re-baseline to gate it`);
    for (const n of missing) console.error(`  MISSING scenario (in baseline, not produced this run): ${n}`);
    for (const r of regressions) console.error(`  REGRESSION ${r.name}.${r.dim}: ${r.base} -> ${r.cur} (dropped ${typeof r.drop === 'number' ? round4(r.drop) : r.drop}, tol ${TOL})`);
    const failed = !!(errored || regressions.length || missing.length || added.length);
    console.log(`\n${failed ? 'FAIL' : 'PASS'} — trajectory coherence ratchet (${DIMENSIONS.length} dims x ${rows.length} scenarios, tol ${TOL})`);
    process.exit(failed ? 1 : 0);
  }

  const tsvPath = writeTsv(rows);
  console.log(`\n${rows.length} scenario(s) scored -> ${path.relative(process.cwd(), tsvPath)}`);
  if (errored) console.error(`\n${errored} scenario(s) errored — see rows above`);
  process.exit(errored ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
