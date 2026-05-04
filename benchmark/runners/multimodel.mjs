#!/usr/bin/env node
// benchmark/runners/multimodel.mjs — orchestrates fidelity runs across
// multiple model classes (frontier / mid-tier / small) per spec §6.4.
//
// Reads benchmark/models.json (or accepts --models=A,B,C inline) for the
// list of models to run. Invokes run-fidelity.mjs once per model and
// aggregates per-scenario results into a side-by-side comparison TSV with
// portability score (mean σ across models per category).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_JSON = path.resolve(__dirname, '..', 'models.json');
const RESULTS_DIR = path.resolve(__dirname, '..', 'results');

function loadModelList() {
  const argv = process.argv.slice(2);
  const flag = argv.find(a => a.startsWith('--models='));
  if (flag) return flag.slice('--models='.length).split(',').map(s => s.trim()).filter(Boolean);
  if (fs.existsSync(MODELS_JSON)) {
    const decl = JSON.parse(fs.readFileSync(MODELS_JSON, 'utf8'));
    return [decl.frontier, decl.mid, decl.small].filter(Boolean);
  }
  // Default: just the stub model (multi-model is meaningful only with reals).
  return ['stub'];
}

function readTSV(file) {
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l && !l.startsWith('#'));
  const header = lines[0].split('\t');
  return lines.slice(1).map(line => {
    const cells = line.split('\t');
    const obj = {};
    header.forEach((k, i) => { obj[k] = cells[i]; });
    return obj;
  });
}

function stddev(nums) {
  if (nums.length === 0) return 0;
  const m = nums.reduce((a, b) => a + b, 0) / nums.length;
  const v = nums.reduce((a, b) => a + (b - m) ** 2, 0) / nums.length;
  return Math.sqrt(v);
}

async function main() {
  const models = loadModelList();
  console.log(`== Multi-model run across: ${models.join(', ')} ==\n`);
  const perModel = {};

  for (const model of models) {
    console.log(`-- Running model: ${model} --`);
    const r = spawnSync('node', [path.join(__dirname, 'run-fidelity.mjs'), model], {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'inherit',
    });
    if (r.status !== 0) { console.error(`fidelity run for ${model} failed`); continue; }
    const tsv = path.join(RESULTS_DIR, 'fidelity.tsv');
    perModel[model] = readTSV(tsv) || [];
    fs.copyFileSync(tsv, path.join(RESULTS_DIR, `fidelity.${model.replace(/[^A-Za-z0-9_-]/g, '_')}.tsv`));
  }

  // Side-by-side comparison + portability score.
  const allIds = new Set();
  Object.values(perModel).forEach(rows => rows.forEach(r => allIds.add(r.id)));
  const sortedIds = [...allIds].sort();

  const header = ['id', 'category', ...models.map(m => `${m}_meanT`), 'sigma_T'];
  const rows = [header.join('\t')];
  const categoryStats = new Map();

  for (const id of sortedIds) {
    const cells = [id];
    let category = '';
    const ts = [];
    for (const m of models) {
      const row = (perModel[m] || []).find(r => r.id === id);
      if (row) {
        category = category || row.category;
        const t = parseFloat(row.meanT);
        ts.push(Number.isFinite(t) ? t : 0);
      }
    }
    const sigma = stddev(ts);
    rows.push([id, category, ...ts.map(t => t.toFixed(2)), sigma.toFixed(3)].join('\t'));
    if (!categoryStats.has(category)) categoryStats.set(category, []);
    categoryStats.get(category).push(sigma);
  }

  fs.writeFileSync(path.join(RESULTS_DIR, 'multimodel.tsv'), rows.join('\n') + '\n');

  console.log(`\n== Portability (lower mean σ = better) ==`);
  for (const [cat, sigmas] of categoryStats) {
    const meanSigma = sigmas.reduce((a, b) => a + b, 0) / sigmas.length;
    console.log(`  ${cat}: mean σ = ${meanSigma.toFixed(3)}`);
  }
}

main().catch(err => { console.error('multimodel crashed:', err); process.exit(2); });
