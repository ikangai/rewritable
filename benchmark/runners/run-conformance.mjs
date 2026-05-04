#!/usr/bin/env node
// benchmark/runners/run-conformance.mjs — main runner.
//
// Discovers benchmark/scenarios/conformance/*.mjs (each default-exporting
// { id, description, category?, weight?, async run({ harness, expectRwaError }) -> { pass, reason } }),
// runs them sequentially, prints progress, and writes a TSV + summary.md.
//
// The final line of stdout is the metric for the autoresearch loop:
//   "<passing> / <total> conformance scenarios passing"
// followed by a single integer (the passing count) on its own line.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as harness from './harness.mjs';
import { writeTSV, writeSummary, ensureResultsDir } from './score.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = path.resolve(__dirname, '..', 'scenarios', 'conformance');

async function discoverScenarios() {
  if (!fs.existsSync(SCENARIOS_DIR)) return [];
  const files = fs.readdirSync(SCENARIOS_DIR)
    .filter(f => f.endsWith('.mjs'))
    .sort();
  const scenarios = [];
  for (const f of files) {
    const url = pathToFileURL(path.join(SCENARIOS_DIR, f)).href;
    try {
      const mod = await import(url);
      const s = mod.default;
      if (!s || typeof s.run !== 'function') {
        console.error(`  SKIP  ${f}: no default-export with run()`);
        continue;
      }
      scenarios.push({ ...s, _file: f });
    } catch (err) {
      console.error(`  SKIP  ${f}: load failed — ${err.message}`);
    }
  }
  return scenarios;
}

async function runScenario(s) {
  const t0 = Date.now();
  try {
    const result = await s.run({ harness, expectRwaError: harness.expectRwaError });
    const duration_ms = Date.now() - t0;
    if (result && typeof result === 'object' && 'pass' in result) {
      return { pass: !!result.pass, reason: result.reason || (result.pass ? 'ok' : 'no reason'), duration_ms };
    }
    return { pass: false, reason: `scenario returned ${typeof result}, expected { pass, reason }`, duration_ms };
  } catch (err) {
    return { pass: false, reason: `threw: ${err.message || err}`, duration_ms: Date.now() - t0 };
  }
}

async function main() {
  ensureResultsDir();
  const scenarios = await discoverScenarios();
  console.log(`== rwa-edit conformance — ${scenarios.length} scenario(s) discovered ==\n`);

  const results = [];
  for (const s of scenarios) {
    process.stdout.write(`  [${s.id}] ${s.description || ''} ... `);
    const r = await runScenario(s);
    results.push(r);
    console.log(r.pass ? `OK (${r.duration_ms}ms)` : `FAIL (${r.duration_ms}ms) — ${r.reason}`);
  }

  const passing = results.filter(r => r.pass).length;
  const total = scenarios.length;

  writeTSV(scenarios, results);
  writeSummary(scenarios, results);

  console.log(`\n${passing} / ${total} conformance scenarios passing`);
  console.log(passing);
}

main().catch(err => {
  console.error('runner crashed:', err);
  process.exit(2);
});
