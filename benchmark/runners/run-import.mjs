// benchmark/runners/run-import.mjs — the import-fidelity runner + regression
// ratchet (increments 3-4 of
// docs/plans/2026-08-16-import-fidelity-benchmark-design.md).
//
// Runs every fixture in benchmark/fixtures/import/ through the REAL shipped CLI
// converter (cli/src/import.mjs's convert(), or clone-extract.mjs's
// extractArticle() for the html fixture) and scores the output on the five
// dimensions of oracles/import-facts.mjs against the fixture's ground-truth
// manifest. This measures what users actually get, not a reimplementation.
//
// Dep resolution note: convert() pulls pdfjs-dist/mammoth/papaparse/marked as
// bare specifiers; Node resolves those from cli/node_modules by walking up from
// import.mjs's OWN path, so this runner works from benchmark/ as long as
// cli/node_modules exists (i.e. `npm ci` has run in cli/ — the CI gate in
// increment 5 must ensure that).
//
// Modes:
//   default  — a human table to stdout + benchmark/results/import-fidelity.tsv
//              (results/ is gitignored; the TSV is ephemeral inspection output).
//   --json   — the machine scores object to stdout, nothing else. Redirect it
//              to generate the baseline:
//                node runners/run-import.mjs --json > baselines/import-fidelity.json
//   --check  — the RATCHET. Re-scores the corpus and compares to the committed
//              baseline; exits non-zero if any dimension dropped more than TOL
//              below its baseline (or a fixture errored / went missing / is new
//              and un-baselined). This is the CI gate. Improvements never fail —
//              they only print a "re-baseline to lock" hint. Re-baselining is an
//              explicit, reviewed commit (the repo's gate-change discipline).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convert } from '../../cli/src/import.mjs';
import { extractArticle } from '../../cli/src/clone-extract.mjs';
import { scoreImport } from '../oracles/import-facts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures', 'import');
const RESULTS_DIR = path.resolve(__dirname, '..', 'results');
const BASELINE_PATH = path.resolve(__dirname, '..', 'baselines', 'import-fidelity.json');
const DIMS = ['coverage', 'order', 'garble', 'structure', 'special'];
const TOL = 0.02; // a dimension may not drop more than this below its baseline
const round4 = (x) => Math.round(x * 1e4) / 1e4;

// pdf.js's warn() writes "Warning: ..." to STDOUT via console.log, which would
// corrupt --json output (and thus the baseline file) and the TSV. Route only
// those lines to stderr so stdout carries only our table/JSON; everything else
// (our own console.log calls, which never start with "Warning: ") passes through.
const _consoleLog = console.log.bind(console);
console.log = (...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith('Warning: ')) { console.error(...args); return; }
  _consoleLog(...args);
};

// Discover every <name>.expected.json under fixtures/import/<format>/. The
// fixture file sits beside its manifest; its extension IS the manifest's
// `format` (pdf/docx/csv/md/html all match), so we derive it rather than glob.
function discoverFixtures() {
  const out = [];
  for (const sub of fs.readdirSync(FIXTURES_DIR, { withFileTypes: true })) {
    if (!sub.isDirectory() || sub.name === 'tools') continue;
    const dir = path.join(FIXTURES_DIR, sub.name);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.expected.json')) continue;
      const manifestPath = path.join(dir, f);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const base = f.slice(0, -'.expected.json'.length);
      const fixturePath = path.join(dir, `${base}.${manifest.format}`);
      out.push({ name: `${sub.name}/${base}`, fixturePath, manifest });
    }
  }
  // Deterministic order — the baseline diffs this by name.
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// Run the fixture through the SAME entry point a user's import would hit.
async function runConverter({ fixturePath, manifest }) {
  const bytes = fs.readFileSync(fixturePath);
  if (manifest.converter === 'extractArticle') {
    const a = extractArticle(bytes.toString('utf8'));
    return typeof a === 'string' ? a : (a && a.html) || '';
  }
  const { html } = await convert(manifest.format, bytes);
  return html;
}

function factStrOf(f) {
  return `h${f.headingLevels.length} t${f.tables.length}` +
    `${f.tables[0] ? `(${f.tables[0].rows}x${f.tables[0].cols})` : ''}` +
    ` l${f.lists} svg=${f.hasSvg} math=${f.hasMath}`;
}

function printHuman(rows) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('fixture', 18), DIMS.map((d) => pad(d, 10)).join(''), 'facts');
  for (const r of rows) {
    if (r.error) { console.log(pad(r.name, 18), 'ERROR:', r.error); continue; }
    console.log(pad(r.name, 18), DIMS.map((d) => pad(r.scores[d].toFixed(3), 10)).join(''), factStrOf(r.facts));
  }
}

function writeTsv(rows) {
  const lines = [['fixture', ...DIMS, 'facts'].join('\t')];
  for (const r of rows) {
    if (r.error) { lines.push([r.name, ...DIMS.map(() => ''), `ERROR: ${r.error}`].join('\t')); continue; }
    lines.push([r.name, ...DIMS.map((d) => r.scores[d]), factStrOf(r.facts)].join('\t'));
  }
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const tsvPath = path.join(RESULTS_DIR, 'import-fidelity.tsv');
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
      '  node runners/run-import.mjs --json > baselines/import-fidelity.json',
    );
  }
  return JSON.parse(raw).fixtures || {};
}

// Compare this run to the baseline. A regression is any dimension that dropped
// more than TOL below baseline; a fixture that errored now (but was scored in
// the baseline) is a total regression; a fixture missing from this run, or a
// NEW fixture absent from the baseline, both mean the gate no longer matches
// reality and must be resolved by re-baselining — all fail the check.
// Improvements are informational only (they never fail — they suggest locking
// the gain with a re-baseline).
function compareToBaseline(rows, baseline) {
  const cur = new Map(rows.map((r) => [r.name, r]));
  const regressions = [], missing = [], added = [], improvements = [];
  for (const [name, base] of Object.entries(baseline)) {
    const r = cur.get(name);
    if (!r) { missing.push(name); continue; }
    if (r.error) { regressions.push({ name, dim: '(converter error)', base: 'scored', cur: r.error, drop: 1 }); continue; }
    if (base.error) continue; // baseline itself errored — nothing to regress from
    for (const d of DIMS) {
      const b = base[d], c = r.scores[d];
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
  const fixtures = discoverFixtures();
  const rows = [];
  let errored = 0;

  for (const fx of fixtures) {
    try {
      const html = await runConverter(fx);
      const s = scoreImport(html, fx.manifest);
      const scores = {};
      for (const d of DIMS) scores[d] = round4(s[d]);
      rows.push({ name: fx.name, scores, facts: s.facts });
    } catch (e) {
      errored++;
      rows.push({ name: fx.name, error: (e && e.message) || String(e) });
    }
  }

  if (jsonMode) {
    // Minimal, stable shape for the baseline/ratchet — five dims per fixture,
    // no facts (facts like text length would churn the baseline needlessly).
    const fixturesOut = {};
    for (const r of rows) fixturesOut[r.name] = r.error ? { error: r.error } : r.scores;
    process.stdout.write(JSON.stringify({ fixtures: fixturesOut }, null, 2) + '\n');
    process.exit(errored ? 1 : 0);
  }

  printHuman(rows);

  if (checkMode) {
    const baseline = loadBaseline();
    const { regressions, missing, added, improvements } = compareToBaseline(rows, baseline);
    console.log('');
    for (const g of improvements) console.log(`  improved ${g.name}.${g.dim}: ${g.base} -> ${g.cur} (re-baseline to lock)`);
    for (const n of added) console.error(`  NEW fixture not in baseline: ${n} — re-baseline to gate it`);
    for (const n of missing) console.error(`  MISSING fixture (in baseline, not produced this run): ${n}`);
    for (const r of regressions) console.error(`  REGRESSION ${r.name}.${r.dim}: ${r.base} -> ${r.cur} (dropped ${round4(r.drop)}, tol ${TOL})`);
    const failed = !!(errored || regressions.length || missing.length || added.length);
    console.log(`\n${failed ? 'FAIL' : 'PASS'} — import-fidelity ratchet (${DIMS.length} dims x ${rows.length} fixtures, tol ${TOL})`);
    process.exit(failed ? 1 : 0);
  }

  const tsvPath = writeTsv(rows);
  console.log(`\n${rows.length} fixtures scored -> ${path.relative(process.cwd(), tsvPath)}`);
  if (errored) console.error(`\n${errored} fixture(s) errored — see rows above`);
  process.exit(errored ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
