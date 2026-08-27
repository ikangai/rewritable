#!/usr/bin/env node
// benchmark/runners/run-cost.mjs — the CONTEXT-COST ratchet for the fidelity lane.
//
// WHY
//
// Every rewritable runs its model on the END USER's own API key. That makes
// tokens-per-edit a product property, not an implementation detail: a change to
// SYSTEM_PROMPT_RULES that adds 400 tokens to every single ⌘K is a real
// regression for every user, forever, and no gate in this repo could see it.
// The fidelity runner has captured tokens_in since it was written and used it
// for exactly nothing — it printed a number nobody was accountable for.
//
// The agent-surface lane already ratchets context cost for the CLI door. This
// is the same idea pointed at the in-browser edit loop.
//
// WHY IT WORKS WITHOUT A MODEL
//
// Under the stub model the conversation is deterministic, but tokens_in is NOT
// synthetic: it is measured over the real messages the runtime assembles — the
// real system prompt for the product kind, the real tool schemas, the real
// document. So a stub run measures actual prompt size. Offline, free, and it
// moves exactly when the prompt does.
//
// It deliberately does NOT ratchet tokens_out: that is the model's business,
// and under the stub it is a fixed property of the reference trace.
//
// WHICH SEED REGIONS ACTUALLY MOVE THIS NUMBER
//
// Worth knowing before you trust a green run, because not every seed change can
// move it and the delta alone will not tell you which kind you are looking at:
//
//   MOVES IT    SYSTEM_PROMPTS / SYSTEM_PROMPT_RULES / TOOL_SCHEMAS — anything
//               assembled into the messages sent to the model. A rule added
//               here lands on every scenario at once, which is why the suite
//               total is the sensitive measure.
//   DOESN'T     The frozen <head>, runtime JS, UI chrome, CSS. Real seed edits,
//               but they never reach a prompt.
//   PER-CALL    buildUserPrompt content varies per invocation rather than per
//               scenario, so it moves the number less than its size suggests.
//
// THE TRAP: a baseline captured AFTER an unreviewed prompt change reads exactly
// like one where nothing changed — both report 0.00%. A zero delta is therefore
// evidence of nothing on its own; it only means something once you know the
// change touched a region that could have moved it. If you are re-baselining,
// say in the commit which region you changed and why the new number is right.
// (Diagnosed by agent-191, 2026-08-27, checking why a same-day seed change
// correctly showed 0.00%: the edits were banner/runtime-JS/per-call, none of
// them prompt rules.)
//
// USAGE
//
//   node runners/run-cost.mjs --check     compare results/fidelity.tsv against the baseline
//   node runners/run-cost.mjs --update    rewrite the baseline from the current run
//
// Reads the TSV that `npm run fidelity:stub` just wrote rather than re-running
// 108 scenarios. It REFUSES a TSV that was not produced by the stub model —
// comparing a real-model run's token counts against a stub baseline would be
// nonsense, and silently doing it would be the same class of bug this lane and
// its sibling gates exist to prevent.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TSV = path.resolve(__dirname, '..', 'results', 'fidelity.tsv');
const BASELINE = path.resolve(__dirname, '..', 'baselines', 'context-cost.json');

// Suite-total tolerance. Prompt bloat is a global property — a rule added to
// SYSTEM_PROMPT_RULES lands on every scenario at once — so the total is the
// sensitive measure. Per-scenario tolerance is looser: individual fixtures move
// for legitimate reasons (a fixture edited, a scenario retuned).
const TOTAL_TOL = 0.03;
const SCENARIO_TOL = 0.10;

function readRun() {
  if (!fs.existsSync(TSV)) {
    console.error(`No ${path.relative(process.cwd(), TSV)} — run \`npm run fidelity:stub\` first.`);
    process.exit(2);
  }
  const lines = fs.readFileSync(TSV, 'utf8').split('\n').filter(Boolean);
  const header = lines[0] || '';
  const m = header.match(/^#\s*model:\s*([^,]+)/);
  const model = m ? m[1].trim() : '(unknown)';
  if (model !== 'stub') {
    console.error(`results/fidelity.tsv was produced by model="${model}", not "stub".`);
    console.error(`Token counts are only comparable within one model. Run \`npm run fidelity:stub\` first.`);
    process.exit(2);
  }
  const cols = lines[1].split('\t');
  const iId = cols.indexOf('id');
  const iTok = cols.indexOf('tokens_in_med');
  if (iId < 0 || iTok < 0) {
    console.error(`results/fidelity.tsv is missing an id or tokens_in_med column — cannot score cost.`);
    process.exit(2);
  }
  const out = {};
  for (const line of lines.slice(2)) {
    const f = line.split('\t');
    const tok = Number(f[iTok]);
    if (f[iId] && Number.isFinite(tok)) out[f[iId]] = tok;
  }
  return out;
}

const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

function update(run) {
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
  fs.writeFileSync(BASELINE, JSON.stringify({
    _comment: 'Context cost per fidelity scenario (tokens_in, stub model). Ratcheted by runners/run-cost.mjs. Update deliberately, never to make a red gate green.',
    total: sum(run),
    scenarios: run,
  }, null, 2) + '\n');
  console.log(`Wrote ${path.relative(process.cwd(), BASELINE)} — ${Object.keys(run).length} scenarios, ${sum(run)} total prompt tokens.`);
}

function check(run) {
  if (!fs.existsSync(BASELINE)) {
    console.error(`No baseline at ${path.relative(process.cwd(), BASELINE)}. Create it with --update.`);
    process.exit(2);
  }
  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const baseScenarios = base.scenarios || {};

  const runTotal = sum(run), baseTotal = base.total ?? sum(baseScenarios);
  const totalDelta = baseTotal > 0 ? (runTotal - baseTotal) / baseTotal : 0;

  const regressions = [], newOnes = [], missing = [];
  for (const [id, tok] of Object.entries(run)) {
    const b = baseScenarios[id];
    if (b === undefined) { newOnes.push(id); continue; }
    const d = b > 0 ? (tok - b) / b : 0;
    if (d > SCENARIO_TOL) regressions.push({ id, from: b, to: tok, pct: d });
  }
  for (const id of Object.keys(baseScenarios)) if (run[id] === undefined) missing.push(id);

  console.log(`Context cost — ${Object.keys(run).length} scenario(s), stub model\n`);
  console.log(`  suite prompt tokens  ${baseTotal} → ${runTotal}  (${(totalDelta * 100).toFixed(2)}%, tolerance ±${(TOTAL_TOL * 100).toFixed(0)}%)`);

  const movers = Object.entries(run)
    .filter(([id]) => baseScenarios[id] !== undefined && baseScenarios[id] > 0)
    .map(([id, tok]) => ({ id, pct: (tok - baseScenarios[id]) / baseScenarios[id], from: baseScenarios[id], to: tok }))
    .filter(m => Math.abs(m.pct) > 0.005)
    .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
    .slice(0, 5);
  if (movers.length) {
    console.log(`\n  biggest movers:`);
    for (const m of movers) console.log(`    ${m.id.padEnd(12)} ${m.from} → ${m.to}  (${m.pct >= 0 ? '+' : ''}${(m.pct * 100).toFixed(1)}%)`);
  }

  // A scenario the baseline knows and this run does not is as much a gate
  // failure as a regression — it is how coverage silently disappears.
  const fail = [];
  if (totalDelta > TOTAL_TOL) fail.push(`suite prompt cost grew ${(totalDelta * 100).toFixed(2)}% (tolerance ${(TOTAL_TOL * 100).toFixed(0)}%)`);
  if (regressions.length) fail.push(`${regressions.length} scenario(s) grew more than ${(SCENARIO_TOL * 100).toFixed(0)}%`);
  if (missing.length) fail.push(`${missing.length} baselined scenario(s) absent from this run: ${missing.join(', ')}`);

  if (newOnes.length) {
    console.log(`\n  ${newOnes.length} new scenario(s) not yet baselined: ${newOnes.join(', ')}`);
    console.log(`  (not a failure — re-run with --update to adopt them)`);
  }

  if (fail.length) {
    console.error(`\nFAIL — context cost ratchet`);
    for (const f of fail) console.error(`  · ${f}`);
    for (const r of regressions) console.error(`    ${r.id}: ${r.from} → ${r.to} (+${(r.pct * 100).toFixed(1)}%)`);
    console.error(`\nEvery token here is spent on the END USER's key, on every single edit.`);
    console.error(`If the growth is intended, re-baseline deliberately: node runners/run-cost.mjs --update`);
    process.exit(1);
  }
  console.log(`\nPASS — context cost ratchet`);
}

const mode = process.argv[2] || '--check';
const run = readRun();
if (mode === '--update') update(run);
else if (mode === '--check') check(run);
else { console.error(`Unknown mode: ${mode}. Use --check or --update.`); process.exit(2); }
