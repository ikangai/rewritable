// benchmark/runners/run-import.mjs — the import-fidelity runner (increment 3 of
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
// Output:
//   default  — a human table to stdout + benchmark/results/import-fidelity.tsv
//              (results/ is gitignored; the TSV is ephemeral inspection output).
//   --json   — the machine scores object to stdout (used in increment 4 to
//              generate benchmark/baselines/import-fidelity.json and to feed
//              the --check ratchet). Nothing else is printed to stdout in this
//              mode, so it is safe to redirect into a file.
//
// This runner does NOT gate anything yet; the --check ratchet is increment 4.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convert } from '../../cli/src/import.mjs';
import { extractArticle } from '../../cli/src/clone-extract.mjs';
import { scoreImport } from '../oracles/import-facts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures', 'import');
const RESULTS_DIR = path.resolve(__dirname, '..', 'results');
const DIMS = ['coverage', 'order', 'garble', 'structure', 'special'];
const round4 = (x) => Math.round(x * 1e4) / 1e4;

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
  // Deterministic order — the baseline (increment 4) diffs this by name.
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

async function main() {
  const jsonMode = process.argv.includes('--json');
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

  // Human table + TSV.
  const header = ['fixture', ...DIMS, 'facts'];
  const tsvLines = [header.join('\t')];
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('fixture', 18), DIMS.map((d) => pad(d, 10)).join(''), 'facts');
  for (const r of rows) {
    if (r.error) {
      console.log(pad(r.name, 18), 'ERROR:', r.error);
      tsvLines.push([r.name, ...DIMS.map(() => ''), `ERROR: ${r.error}`].join('\t'));
      continue;
    }
    const f = r.facts;
    const factStr = `h${f.headingLevels.length} t${f.tables.length}${f.tables[0] ? `(${f.tables[0].rows}x${f.tables[0].cols})` : ''} l${f.lists} svg=${f.hasSvg} math=${f.hasMath}`;
    console.log(pad(r.name, 18), DIMS.map((d) => pad(r.scores[d].toFixed(3), 10)).join(''), factStr);
    tsvLines.push([r.name, ...DIMS.map((d) => r.scores[d]), factStr].join('\t'));
  }

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const tsvPath = path.join(RESULTS_DIR, 'import-fidelity.tsv');
  fs.writeFileSync(tsvPath, tsvLines.join('\n') + '\n');
  console.log(`\n${rows.length} fixtures scored → ${path.relative(process.cwd(), tsvPath)}`);
  if (errored) console.error(`\n${errored} fixture(s) errored — see rows above`);
  process.exit(errored ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
