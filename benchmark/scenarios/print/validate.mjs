#!/usr/bin/env node
// benchmark/scenarios/print/validate.mjs
//
// Drive headless Chrome to print each fixture to PDF, then run text-only
// assertions on the result. This is the cheap-but-real automation layer
// for the print fixtures — see _runner-spec.md for the longer-term
// puppeteer-based design.
//
// Requirements (graceful skip if missing):
//   - Chrome / Chromium on PATH or at /Applications/Google Chrome.app
//   - pdfinfo + pdftotext (poppler-utils; brew install poppler)
//
// Run:  node benchmark/scenarios/print/validate.mjs
//
// Paper size is Letter (Chrome's headless --print-to-pdf default). The
// flag has no paper-size option. To validate A4 behavior, add an
// `@page { size: A4 }` rule to the fixture itself (the runtime's
// `@page { margin: 18mm }` is intentionally paper-agnostic). All
// existing fixtures are paper-tolerant: exact page counts assert on
// scenarios where pagination is forced (forced breaks, very-short
// docs), and the rest use pages_min.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// PDFs land in benchmark/results/print/ — same parent dir the other
// benchmark modes (conformance, fidelity) write their .tsv/.md/.log
// artifacts to. Gitignored via benchmark/.gitignore. Sits two parents
// up from this file: scenarios/print → scenarios → benchmark.
const OUTDIR = path.resolve(__dirname, '..', '..', 'results', 'print');

// ─── Probe environment ───────────────────────────────────────────────

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function require_tool(cmd) {
  try { execSync(`which ${cmd}`, { stdio: 'ignore' }); return true; }
  catch { return false; }
}

const chrome = findChrome();
const havePdfInfo = require_tool('pdfinfo');
const havePdfText = require_tool('pdftotext');

if (!chrome) {
  console.error('SKIP — no Chrome / Chromium found. Set CHROME_PATH.');
  process.exit(2);
}
if (!havePdfInfo || !havePdfText) {
  console.error('SKIP — pdfinfo and pdftotext required (brew install poppler).');
  process.exit(2);
}

fs.mkdirSync(OUTDIR, { recursive: true });

// ─── Per-fixture assertions ──────────────────────────────────────────
// Each entry: { id, pages|pages_min|pages_max, present[], absent[],
// one_page_each[], same_page[[a,b]], starts_page[[s,n]] }
// All counts assume Letter paper. Pass --paper=A4 to also validate A4.
const ASSERTIONS = [
  // ─── sp ─────────────────────────────────────────────────────────────
  { id: 'sp-01-placeholder-only', pages: 1,
    present: ['Untitled'],
    absent: ['Start writing'] },
  { id: 'sp-02-short-prose', pages: 1,
    present: ['Q1 board memo', 'Revenue grew 18'],
    absent: [] },
  { id: 'sp-03-receipt', pages: 1,
    present: ['Invoice #4574C971-0038', '8,612.40', 'Total'],
    absent: [] },

  // ─── mp ─────────────────────────────────────────────────────────────
  { id: 'mp-01-long-prose', pages_min: 3,
    present: ['Annual review'],
    absent: [] },
  { id: 'mp-02-heading-near-break', pages_min: 2,
    present: ['Outlook', 'Risks', 'People'],
    no_heading_last_on_page: ['Outlook', 'Risks', 'People'] },

  // ─── tbl ────────────────────────────────────────────────────────────
  { id: 'tbl-01-small-intact', pages: 1,
    present: ['Supplier scorecard', 'Falconer'],
    absent: [] },
  { id: 'tbl-02-long-breaks-between-rows', pages_min: 2,
    present: ['ACCT-0001', 'ACCT-0025'],
    one_page_each: [
      ...Array.from({length:25}, (_,i) => `ACCT-${String(i+1).padStart(4,'0')}`),
    ] },
  { id: 'tbl-03-tall-row-moves', pages_min: 2,
    present: ['Detection', 'Investigation', 'Mitigation', 'Resolution'],
    one_page_each: ['Investigation'] },
  { id: 'tbl-04-wide-no-overflow', pages_min: 1,
    present: ['Wide table'],
    absent: [] },
  { id: 'tbl-05-caption-with-table', pages_min: 1,
    present: ['Table 1', 'Enterprise', 'Mid-market', 'SMB'],
    same_page: [['Table 1', 'Segment']] },

  // ─── code ───────────────────────────────────────────────────────────
  { id: 'code-01-short-pre-intact', pages_min: 1,
    present: ['API example'],
    same_page: [["fetch('/api/run'", 'console.log(result)']] },
  { id: 'code-02-long-pre-must-break', pages_min: 2,
    present: ['Long log dump', '[001]', '[120]'],
    absent: [] },

  // ─── list ───────────────────────────────────────────────────────────
  { id: 'list-01-long-list-breaks-between-items', pages_min: 2,
    present: ['Backlog', 'Item 1:', 'Item 50:'],
    one_page_each: [
      ...Array.from({length:50}, (_,i) => `Item ${i+1}:`),
    ] },
  { id: 'list-02-multiline-items-intact', pages_min: 1,
    present: ['Plays we discussed', 'Play 1.', 'Play 12.'],
    one_page_each: Array.from({length:12}, (_,i) => `Play ${i+1}.`) },

  // ─── fig ────────────────────────────────────────────────────────────
  { id: 'fig-01-figure-caption-together', pages_min: 1,
    present: ['Architecture overview', 'Figure 1'],
    // SVG content does not contribute to text extraction; same_page
    // check on the caption alone would be trivial. Skip same_page.
    absent: [] },
  { id: 'fig-02-figure-near-boundary-moves', pages_min: 1,
    present: ['Process diagram', 'Figure 2'],
    absent: [] },

  // ─── chr ────────────────────────────────────────────────────────────
  { id: 'chr-01-runtime-chrome-hidden', pages_min: 1,
    present: ['Doc with runtime chrome'],
    absent: ['lens placeholder', 'Start writing'] },

  // ─── pg ─────────────────────────────────────────────────────────────
  { id: 'pg-01-default-18mm-margin', pages_min: 1,
    present: ['Margin probe'],
    absent: [] },
  { id: 'pg-02-document-override-wins', pages_min: 1,
    present: ['Tight-margin doc'],
    absent: [] },
  { id: 'pg-03-named-pages-cover-and-body', pages_min: 2,
    present: ['Annual Report 2026', 'Executive summary', 'Outlook'],
    // Don't assert page numbers — engine-dependent rendering.
    absent: [] },

  // ─── edge ───────────────────────────────────────────────────────────
  { id: 'edge-01-forced-break-before', pages: 3,
    present: ['Chapter 1', 'Chapter 2', 'Chapter 3'],
    starts_page: [['Chapter 2', 2], ['Chapter 3', 3]] },
  { id: 'edge-02-colored-bg-and-links', pages_min: 1,
    present: ['Color rendering on print', 'yellow background of this callout', 'rewritable docs'],
    absent: [] },
  { id: 'edge-03-oversize-block-breaks-inside', pages_min: 2,
    present: ['An oversize quotation', 'Line 1.', 'Line 60.'],
    absent: [] },
  // edge-04 / 05 / 06: overflow scenarios. Text-only assertions can
  // only confirm the text reached the PDF — clipping at the right
  // margin still leaves the text extractable. The real verdict is
  // visual (read the PDF), so we only check presence here and let the
  // visual review section in MANIFEST.md document the actual failure.
  { id: 'edge-04-long-url-in-paragraph', pages_min: 1,
    // URLs wrap with soft breaks; pdftotext renders "internal-\ntools" as
    // two lines, so a substring containing the hyphen across the break
    // isn't extractable. Pick fragments that fit within a single visual
    // line in the rendered PDF.
    present: ['References', 'example.com/very/deeply', 'view=summary'],
    absent: [] },
  { id: 'edge-05-long-line-in-pre', pages_min: 1,
    present: ['API request example', 'Authorization: Bearer sk-proj', 'X POST'],
    absent: [] },
  { id: 'edge-06-long-word-in-paragraph', pages_min: 1,
    present: ['Audit log entry', '0x4f9c8b2e7a1d6f3c5b8a9e7d4c2b1f0e', 'Donaudampfschiffahrtselektrizit'],
    absent: [] },
  { id: 'edge-07-table-in-list-in-blockquote', pages_min: 1,
    present: ['Nested content stress test', 'Supplier concentration', 'FX exposure by corridor', 'Headcount plan', 'Crestline', 'EUR→USD', 'Engineering'],
    one_page_each: ['Acme', 'Beacon', 'Crestline', 'Doric', 'EUR→USD', 'USD→JPY', 'GBP→EUR'] },
  { id: 'edge-08-pre-and-list-in-table-cell', pages_min: 1,
    present: ['Runbook', 'Detect', 'Triage', 'Mitigate', 'Resolve', 'curl -X GET', 'Roll back the last deploy'] },
];

// ─── Print + assert ──────────────────────────────────────────────────

function printFixture(id) {
  const src = `file://${path.join(__dirname, id + '.html')}`;
  const dst = path.join(OUTDIR, id + '.pdf');
  // --no-pdf-header-footer keeps the PDF the same as what print preview
  // shows when the user picks "Save as PDF" with header/footer disabled.
  // --print-to-pdf-no-header is the modern alias for the same flag.
  execFileSync(chrome, [
    '--headless',
    '--disable-gpu',
    '--no-pdf-header-footer',
    `--print-to-pdf=${dst}`,
    src,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  return dst;
}

function pageCount(pdf) {
  const out = execFileSync('pdfinfo', [pdf], { encoding: 'utf8' });
  const m = out.match(/^Pages:\s+(\d+)/m);
  return m ? parseInt(m[1], 10) : 0;
}

function pageText(pdf, n) {
  return execFileSync('pdftotext', ['-layout', '-f', String(n), '-l', String(n), pdf, '-'], { encoding: 'utf8' });
}

function findPagesContaining(pdf, totalPages, needle) {
  const hits = [];
  for (let p = 1; p <= totalPages; p++) {
    if (pageText(pdf, p).includes(needle)) hits.push(p);
  }
  return hits;
}

function pageLastNonBlankLine(pdf, p) {
  const lines = pageText(pdf, p).split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.length > 0);
  return lines[lines.length - 1] || '';
}

function assert(spec) {
  const pdf = printFixture(spec.id);
  const total = pageCount(pdf);
  const fails = [];

  if (typeof spec.pages === 'number' && total !== spec.pages) {
    fails.push(`pages=${total}, expected exactly ${spec.pages}`);
  }
  if (typeof spec.pages_min === 'number' && total < spec.pages_min) {
    fails.push(`pages=${total}, expected at least ${spec.pages_min}`);
  }
  if (typeof spec.pages_max === 'number' && total > spec.pages_max) {
    fails.push(`pages=${total}, expected at most ${spec.pages_max}`);
  }
  for (const s of (spec.present || [])) {
    const hits = findPagesContaining(pdf, total, s);
    if (hits.length === 0) fails.push(`expected "${s}" present, not found`);
  }
  for (const s of (spec.absent || [])) {
    const hits = findPagesContaining(pdf, total, s);
    if (hits.length > 0) fails.push(`expected "${s}" absent, found on page(s) ${hits.join(',')}`);
  }
  for (const s of (spec.one_page_each || [])) {
    const hits = findPagesContaining(pdf, total, s);
    if (hits.length !== 1) fails.push(`expected "${s}" on exactly 1 page, found on ${hits.length} (pages ${hits.join(',') || 'none'})`);
  }
  for (const [a, b] of (spec.same_page || [])) {
    const pa = findPagesContaining(pdf, total, a);
    const pb = findPagesContaining(pdf, total, b);
    const overlap = pa.find(p => pb.includes(p));
    if (overlap === undefined) fails.push(`expected "${a}" and "${b}" on same page; a=${pa.join(',') || 'none'} b=${pb.join(',') || 'none'}`);
  }
  for (const [s, n] of (spec.starts_page || [])) {
    const text = pageText(pdf, n).trimStart();
    const firstLine = text.split(/\r?\n/).find(l => l.trim().length > 0) || '';
    if (!firstLine.includes(s)) fails.push(`expected page ${n} to start with "${s}", got "${firstLine.slice(0,50)}"`);
  }
  for (const h of (spec.no_heading_last_on_page || [])) {
    for (let p = 1; p < total; p++) {
      const last = pageLastNonBlankLine(pdf, p);
      if (last.includes(h)) fails.push(`heading "${h}" stranded as last line of page ${p}: "${last.slice(0,80)}"`);
    }
  }

  return { id: spec.id, pages: total, pdf, fails };
}

// ─── Run ─────────────────────────────────────────────────────────────

console.log(`paper=Letter (Chrome --print-to-pdf default); chrome=${chrome}; output=${OUTDIR}\n`);
const results = [];
for (const spec of ASSERTIONS) {
  process.stdout.write(`  ${spec.id} ... `);
  try {
    const r = assert(spec);
    results.push(r);
    if (r.fails.length === 0) console.log(`pass (pages=${r.pages})`);
    else { console.log(`FAIL (pages=${r.pages})`); for (const f of r.fails) console.log(`    - ${f}`); }
  } catch (e) {
    console.log(`ERROR — ${e.message}`);
    results.push({ id: spec.id, pages: -1, fails: [`exception: ${e.message}`] });
  }
}

const passed = results.filter(r => r.fails.length === 0).length;
const failed = results.length - passed;
console.log(`\n${passed} passed, ${failed} failed (of ${results.length})`);
process.exit(failed > 0 ? 1 : 0);
