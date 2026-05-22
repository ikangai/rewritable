#!/usr/bin/env node
// benchmark/scenarios/print/generate.mjs
//
// Generator for the print-fidelity scenario fixtures.
//
// Why generator-based: every scenario must include the seed's print CSS,
// verbatim, so what the fixture exercises matches what the runtime ships.
// One source of truth here means no per-file drift; bump the seed's print
// rules, edit PRINT_CSS below, re-run, and all 21 fixtures update together.
//
// Run:   node benchmark/scenarios/print/generate.mjs
// Output: print-XX-*.html files + MANIFEST.md in this directory.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Canonical print CSS ──────────────────────────────────────────────
// Mirror of the @page + @media print rules from seeds/rewritable.html
// (the bootstrap's <style> block, lines ~157–168). The fixtures inline
// these so they print identically whether opened from this directory,
// a tarball, or attached to an email.
//
// SYNC: when seeds/rewritable.html print CSS changes, mirror the block
// here and re-run this generator. Diff `git diff seeds/rewritable.html`
// for the @page / @media print region.
const PRINT_CSS = `@page { margin: 18mm; }
@media print {
  #rwa-runtime { display: none !important; }
  body { background: #fff !important; color: #000 !important; min-height: 0 !important; padding-bottom: 0 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  #rwa-doc-mount { margin: 0 !important; padding: 0 !important; }
  :where(#rwa-doc-mount) article { margin: 0 auto !important; padding: 0 !important; max-width: none !important; }
  :where(#rwa-doc-mount) h1, :where(#rwa-doc-mount) h2, :where(#rwa-doc-mount) h3, :where(#rwa-doc-mount) h4, :where(#rwa-doc-mount) h5, :where(#rwa-doc-mount) h6 { break-after: avoid; page-break-after: avoid; }
  :where(#rwa-doc-mount) figure, :where(#rwa-doc-mount) pre, :where(#rwa-doc-mount) table, :where(#rwa-doc-mount) img { break-inside: avoid; page-break-inside: avoid; }
  :where(#rwa-doc-mount) tr, :where(#rwa-doc-mount) li { break-inside: avoid; page-break-inside: avoid; }
  :where(#rwa-doc-mount) p { orphans: 3; widows: 3; }
  :where(#rwa-doc-mount) p, :where(#rwa-doc-mount) li, :where(#rwa-doc-mount) td, :where(#rwa-doc-mount) th, :where(#rwa-doc-mount) code, :where(#rwa-doc-mount) a { overflow-wrap: break-word; }
  :where(#rwa-doc-mount) pre { white-space: pre-wrap; overflow: visible; overflow-wrap: anywhere; }
  :where(#rwa-doc-mount) a { color: #000 !important; }
  .placeholder { display: none; }
}`;

// Baseline screen typography — a minimal subset of the seed's
// :where(#rwa-doc-mount) baseline rules so paragraphs / tables / pre
// look like a real rwa doc on screen too, not just on print.
const SCREEN_CSS = `:root { --gray-50:#fafafa; --gray-100:#f4f4f5; --gray-200:#e4e4e7; --gray-400:#a1a1aa; --gray-500:#71717a; --gray-700:#3f3f46; --gray-800:#27272a; --gray-900:#18181b; --blue:#2563eb; --font-ui: system-ui,-apple-system,Segoe UI,sans-serif; --font-mono: ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
body { font-family: var(--font-ui); color: var(--gray-900); background: var(--gray-50); margin: 0; line-height: 1.6; }
:where(#rwa-doc-mount) article { max-width: 720px; margin: 64px auto; padding: 0 32px; }
:where(#rwa-doc-mount) h1 { font-size: 2.2em; margin: 0 0 .5em; line-height: 1.2; }
:where(#rwa-doc-mount) h2 { font-size: 1.5em; margin: 1.5em 0 .5em; }
:where(#rwa-doc-mount) h3 { font-size: 1.2em; margin: 1.3em 0 .4em; }
:where(#rwa-doc-mount) p { margin: 0 0 1em; }
:where(#rwa-doc-mount) a { color: var(--blue); text-decoration: underline; }
:where(#rwa-doc-mount) code { font-family: var(--font-mono); font-size: .92em; background: var(--gray-100); padding: .1em .35em; border-radius: 4px; }
:where(#rwa-doc-mount) pre { font-family: var(--font-mono); font-size: .9rem; background: var(--gray-50); border: 1px solid var(--gray-200); border-radius: 8px; padding: 14px 16px; overflow-x: auto; margin: 0 0 1em; line-height: 1.5; }
:where(#rwa-doc-mount) pre code { background: transparent; padding: 0; }
:where(#rwa-doc-mount) blockquote { margin: 1.5em 0; padding: 0 1.2em; border-left: 3px solid var(--gray-200); color: var(--gray-700); }
:where(#rwa-doc-mount) figure { margin: 1.5em 0; }
:where(#rwa-doc-mount) figcaption { font-size: .875em; color: var(--gray-500); margin-top: .5em; text-align: center; }
:where(#rwa-doc-mount) img { max-width: 100%; height: auto; border-radius: 6px; }
:where(#rwa-doc-mount) table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: .95em; }
:where(#rwa-doc-mount) th, :where(#rwa-doc-mount) td { border-bottom: 1px solid var(--gray-200); padding: .5em .75em; text-align: left; vertical-align: top; }
:where(#rwa-doc-mount) th { font-weight: 600; color: var(--gray-700); background: var(--gray-50); }
.placeholder { color: var(--gray-400); font-style: italic; }
#rwa-runtime { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); width: 680px; background: #fff; border: 1px solid var(--gray-200); border-radius: 24px; padding: 16px 20px; box-shadow: 0 4px 24px rgba(0,0,0,.06); }`;

// ─── Helpers ──────────────────────────────────────────────────────────

function lorem(n) {
  const seed = [
    'Operating margin held steady at 22 percent despite headcount additions.',
    'Revenue grew 18 percent year over year, driven by enterprise renewals and modest expansion in the EMEA region.',
    'We expect mid-teens growth to continue through Q2 with new product introductions in late summer.',
    'Risk register updated this quarter to track supplier concentration and currency exposure across three new corridors.',
    'The board approved the dividend at the prior level pending Q3 results.',
    'Cost discipline remains the operating principle for the back half of the fiscal year.',
    'Technical investments include rebuilding the ingestion path and reducing batch latency by half.',
    'Headcount plan calls for selective expansion in engineering and customer success.',
    'Competitive position improved in the mid-market segment after the spring product cycle.',
    'Customer satisfaction scores moved up two points after the support overhaul.',
  ];
  const out = [];
  for (let i = 0; i < n; i++) out.push(seed[i % seed.length]);
  return out;
}

function wrap({ id, title, hypothesis, checklist, body, extraStyle = '', extraBodyClass = '', includeRuntimeChrome = false }) {
  const checklistHtml = checklist
    .map((item, i) => `       ${i + 1}. ${item}`)
    .join('\n');
  const runtimeChrome = includeRuntimeChrome
    ? `\n<div id="rwa-runtime">lens placeholder — this should NOT appear in print preview</div>\n`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${id} — ${title}</title>
<!--
  ${id} — ${title}

  Hypothesis under test:
    ${hypothesis}

  Manual verification (open in Chromium → Cmd-P → preview):
${checklistHtml}

  Failure modes this scenario catches:
    See MANIFEST.md for the per-scenario failure-mode table.
-->
<style>
${SCREEN_CSS}
${extraStyle ? extraStyle + '\n' : ''}${PRINT_CSS}
</style>
</head>
<body${extraBodyClass ? ` class="${extraBodyClass}"` : ''}>
<div id="rwa-doc-mount">
${body}
</div>${runtimeChrome}
</body>
</html>
`;
}

// ─── Catalog ──────────────────────────────────────────────────────────
// Each entry is one printable scenario. Categories:
//   sp    — single-page documents that should fit on one printed page
//   mp    — multipage prose that paginates naturally
//   tbl   — tables (highest break-risk category)
//   code  — <pre>/<code> blocks
//   list  — <ul>/<ol> at various lengths
//   fig   — <figure>/<img> across page boundaries
//   chr   — runtime chrome leakage into print output
//   pg    — @page rules and document overrides
//   edge  — forced breaks, colors, oversize blocks
const SCENARIOS = [
  // ─── Single-page ─────────────────────────────────────────────────────
  {
    id: 'sp-01-placeholder-only',
    category: 'sp',
    title: 'placeholder-only doc prints as a blank single page',
    hypothesis: '.placeholder { display: none } in @media print removes the invitation copy so an unwritten doc prints clean — heading only, no lorem-esque "Start writing…" text.',
    checklist: [
      'Print preview shows EXACTLY ONE page.',
      'The page shows only the H1 "Untitled" at the top.',
      'The placeholder paragraph "Start writing, or ask…" does NOT appear anywhere.',
    ],
    body: `<article>
<h1>Untitled</h1>
<p class="placeholder">Start writing, or ask the lens below to draft something for you.</p>
</article>`,
  },
  {
    id: 'sp-02-short-prose',
    category: 'sp',
    title: 'short prose fits one page and expands to full width',
    hypothesis: 'On screen the article is capped at 720px (centred); on print the @media print override removes max-width so the prose uses the full page width (A4 minus 2×18mm = ~174mm).',
    checklist: [
      'Print preview shows EXACTLY ONE page.',
      'The paragraph text spans the full printable width — measure with a ruler/eyeball: roughly 17cm of usable width, not the 720px (≈19cm at default DPI) on-screen card.',
      'There is no left or right gutter wider than the 18mm page margin.',
    ],
    body: `<article>
<h1>Q1 board memo</h1>
<p>Revenue grew 18 percent year over year, driven by enterprise renewals and modest expansion in the EMEA region. Operating margin held steady at 22 percent despite headcount additions.</p>
<p>We expect mid-teens growth to continue through Q2 with new product introductions in late summer. The board approved the dividend at the prior level pending Q3 results.</p>
<p>Risk register updated this quarter to track supplier concentration and currency exposure across three new corridors.</p>
</article>`,
  },
  {
    id: 'sp-03-receipt',
    category: 'sp',
    title: 'receipt-style doc fits one page with table intact',
    hypothesis: 'A short doc with a key/value header plus a small itemised table fits one page with the table never split.',
    checklist: [
      'Print preview shows EXACTLY ONE page.',
      'The line-items table is rendered as a single intact block — no row appears at the top of a phantom page 2.',
      'The "Total" row sits directly under the last line item, never on its own page.',
    ],
    body: `<article>
<h1>Invoice #4574C971-0038</h1>
<p><strong>Issued:</strong> 2026-04-30 &nbsp; <strong>Due:</strong> 2026-05-30 &nbsp; <strong>Currency:</strong> EUR</p>
<table>
<thead><tr><th>Item</th><th>Qty</th><th>Unit</th><th>Total</th></tr></thead>
<tbody>
<tr><td>Consulting — discovery</td><td>1</td><td>3,200.00</td><td>3,200.00</td></tr>
<tr><td>Consulting — workshop</td><td>2</td><td>2,400.00</td><td>4,800.00</td></tr>
<tr><td>Out-of-pocket travel</td><td>1</td><td>612.40</td><td>612.40</td></tr>
<tr><td><strong>Total</strong></td><td></td><td></td><td><strong>8,612.40</strong></td></tr>
</tbody>
</table>
<p style="font-size:.9em;color:#71717a">Bank: DE00 0000 0000 0000 0000 00 — please reference the invoice number on transfer.</p>
</article>`,
  },

  // ─── Multipage prose ─────────────────────────────────────────────────
  {
    id: 'mp-01-long-prose',
    category: 'mp',
    title: 'long prose paginates naturally with no orphan/widow lines',
    hypothesis: 'orphans:3 / widows:3 on <p> prevent a single line of a paragraph being stranded at the top or bottom of a page.',
    checklist: [
      'Print preview shows AT LEAST 3 pages.',
      'On every page boundary: the bottom of one page does not show a single line of a paragraph followed by the rest on the next page (no widow of 1–2 lines).',
      'No page starts with a single trailing line of the previous page\'s paragraph (no orphan of 1–2 lines).',
      'Page transitions happen between paragraphs whenever possible.',
    ],
    body: `<article>
<h1>Annual review — long form</h1>
${lorem(40).map(p => `<p>${p}</p>`).join('\n')}
</article>`,
  },
  {
    id: 'mp-02-heading-near-break',
    category: 'mp',
    title: 'H2 near a page break moves with its following paragraph',
    hypothesis: 'break-after:avoid + page-break-after:avoid on h1-h6 prevents a heading being stranded at the bottom of a page while the body content starts on the next.',
    checklist: [
      'Print preview shows AT LEAST 2 pages.',
      'Scan every page boundary: NO H2 appears as the LAST element on a page.',
      'Every visible H2 is immediately followed by at least one of its paragraphs on the same page.',
    ],
    body: `<article>
<h1>Quarterly notes</h1>
${lorem(18).map(p => `<p>${p}</p>`).join('\n')}
<h2>Outlook</h2>
${lorem(6).map(p => `<p>${p}</p>`).join('\n')}
<h2>Risks</h2>
${lorem(6).map(p => `<p>${p}</p>`).join('\n')}
<h2>People</h2>
${lorem(6).map(p => `<p>${p}</p>`).join('\n')}
</article>`,
  },

  // ─── Tables ──────────────────────────────────────────────────────────
  {
    id: 'tbl-01-small-intact',
    category: 'tbl',
    title: 'small table fits on one page intact',
    hypothesis: 'break-inside:avoid on <table> keeps a small table from being split unnecessarily.',
    checklist: [
      'The 6-row table appears as ONE intact block (header + 6 rows) on a single page.',
      'No row of the table appears on a different page from the header.',
    ],
    body: `<article>
<h1>Supplier scorecard</h1>
<p>Six suppliers, three metrics each. Should never split across a page boundary.</p>
<table>
<thead><tr><th>Supplier</th><th>On-time %</th><th>Defect ppm</th><th>Cost index</th></tr></thead>
<tbody>
<tr><td>Acme</td><td>98.4</td><td>140</td><td>1.02</td></tr>
<tr><td>Beacon</td><td>96.1</td><td>220</td><td>0.97</td></tr>
<tr><td>Crestline</td><td>99.0</td><td>85</td><td>1.10</td></tr>
<tr><td>Doric</td><td>92.7</td><td>410</td><td>0.91</td></tr>
<tr><td>Esmark</td><td>97.8</td><td>165</td><td>1.04</td></tr>
<tr><td>Falconer</td><td>94.5</td><td>305</td><td>0.95</td></tr>
</tbody>
</table>
</article>`,
  },
  {
    id: 'tbl-02-long-breaks-between-rows',
    category: 'tbl',
    title: '25-row table breaks BETWEEN rows, never mid-row',
    hypothesis: 'When a table is larger than a single page, the engine breaks it across pages but break-inside:avoid on <tr> ensures the split lands at a row boundary, not inside a row.',
    checklist: [
      'Print preview shows AT LEAST 2 pages.',
      'On the boundary between page 1 and page 2: scan the bottom of page 1 and the top of page 2 — the same row must NOT appear partially on both.',
      'Every row is fully visible on exactly ONE page.',
    ],
    body: `<article>
<h1>25-row register</h1>
<p>Pages should split between rows. No row should ever appear half on one page and half on the next.</p>
<table>
<thead><tr><th>#</th><th>Account</th><th>Note</th></tr></thead>
<tbody>
${Array.from({length:25}, (_,i) => `<tr><td>${i+1}</td><td>ACCT-${String(i+1).padStart(4,'0')}</td><td>${lorem(1)[0]}</td></tr>`).join('\n')}
</tbody>
</table>
</article>`,
  },
  {
    id: 'tbl-03-tall-row-moves',
    category: 'tbl',
    title: 'a row with tall content moves to next page as a unit',
    hypothesis: 'A row with several paragraphs in one cell — much taller than other rows — must move to the next page as a whole when it would otherwise straddle the boundary.',
    checklist: [
      'Print preview shows AT LEAST 2 pages.',
      'The "tall" row (the third row, containing multi-paragraph notes) appears entirely on one page.',
      'There is NO scenario where the first paragraph of the tall row sits on page 1 while the second paragraph sits on page 2.',
    ],
    body: `<article>
<h1>Incident log with notes</h1>
${lorem(15).map(p => `<p>${p}</p>`).join('\n')}
<table>
<thead><tr><th>#</th><th>Stage</th><th>Notes</th></tr></thead>
<tbody>
<tr><td>1</td><td>Detection</td><td>Paged at 02:14.</td></tr>
<tr><td>2</td><td>Triage</td><td>Owner identified.</td></tr>
<tr><td>3</td><td>Investigation</td><td>
  <p>${lorem(1)[0]}</p>
  <p>${lorem(1)[1]}</p>
  <p>${lorem(1)[2]}</p>
  <p>${lorem(1)[3]}</p>
  <p>${lorem(1)[4]}</p>
</td></tr>
<tr><td>4</td><td>Mitigation</td><td>Traffic shed to fallback region.</td></tr>
<tr><td>5</td><td>Resolution</td><td>Root cause identified; permanent fix landed.</td></tr>
</tbody>
</table>
</article>`,
  },
  {
    id: 'tbl-04-wide-no-overflow',
    category: 'tbl',
    title: 'wide 9-column table fits within the printable width',
    hypothesis: 'A table with width:100% on screen should reflow to the print page width, not overflow the right margin (no clipped rightmost columns).',
    checklist: [
      'All 9 columns are visible on every page where the table appears.',
      'The right edge of the table aligns to the right margin of the page; columns are not clipped.',
      'If columns are too narrow to read, that is acceptable — the test is that nothing is HIDDEN.',
    ],
    body: `<article>
<h1>Wide table</h1>
<table>
<thead><tr><th>K</th><th>A</th><th>B</th><th>C</th><th>D</th><th>E</th><th>F</th><th>G</th><th>H</th></tr></thead>
<tbody>
${Array.from({length:8}, (_,i) => `<tr><td>${i+1}</td><td>${i*1.1|0}</td><td>${i*2.2|0}</td><td>${i*3.3|0}</td><td>${i*4.4|0}</td><td>${i*5.5|0}</td><td>${i*6.6|0}</td><td>${i*7.7|0}</td><td>${i*8.8|0}</td></tr>`).join('\n')}
</tbody>
</table>
</article>`,
  },
  {
    id: 'tbl-05-caption-with-table',
    category: 'tbl',
    title: 'table caption stays with its table',
    hypothesis: 'A <caption> inside a <table> is part of the same block that break-inside:avoid protects — caption and at least the header row stay together.',
    checklist: [
      'The caption "Table 1: ..." appears on the same page as the table header row.',
      'There is NO page where the caption appears at the bottom and the table header appears at the top of the next page.',
    ],
    body: `<article>
<h1>Captioned table</h1>
${lorem(20).map(p => `<p>${p}</p>`).join('\n')}
<table>
<caption style="caption-side:top;text-align:left;font-weight:600;padding:.4em 0;">Table 1: Q1 revenue by segment</caption>
<thead><tr><th>Segment</th><th>Q1</th><th>YoY</th></tr></thead>
<tbody>
<tr><td>Enterprise</td><td>4.2M</td><td>+22%</td></tr>
<tr><td>Mid-market</td><td>2.1M</td><td>+15%</td></tr>
<tr><td>SMB</td><td>0.8M</td><td>+8%</td></tr>
</tbody>
</table>
</article>`,
  },

  // ─── Code blocks ─────────────────────────────────────────────────────
  {
    id: 'code-01-short-pre-intact',
    category: 'code',
    title: 'short <pre> stays intact on one page',
    hypothesis: 'break-inside:avoid on <pre> keeps a short code block from being split across pages.',
    checklist: [
      'The 10-line code block appears as ONE intact block on a single page.',
      'No line of the code appears on a different page from the rest.',
    ],
    body: `<article>
<h1>API example</h1>
${lorem(15).map(p => `<p>${p}</p>`).join('\n')}
<pre><code>fetch('/api/run', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    instruction: 'edit the prose',
    fixture: { content: '<p>Hello.</p>' },
  }),
})
  .then(r =&gt; r.json())
  .then(result =&gt; console.log(result));</code></pre>
</article>`,
  },
  {
    id: 'code-02-long-pre-must-break',
    category: 'code',
    title: '<pre> longer than a page is forced to break (known limit)',
    hypothesis: 'When a single <pre> exceeds one printed page, the rendering engine is forced to break inside it (break-inside:avoid is a HINT, not a guarantee). This scenario DOCUMENTS the limit rather than fixing it: the user must split long code blocks manually if intact printing matters.',
    checklist: [
      'The code block spans at least 2 pages.',
      'The break lands at a LINE boundary, not mid-character or mid-word.',
      'No code line is split in half horizontally between two pages.',
      'NOTE: This scenario PASSES if the break is line-aligned, even though the pre was split.',
    ],
    body: `<article>
<h1>Long log dump</h1>
<p>This pre exceeds one printed page. The engine MUST split it. The check is only that the split lands cleanly at a line boundary.</p>
<pre><code>${Array.from({length:120}, (_,i) => `[${String(i+1).padStart(3,'0')}] ${lorem(1)[0]}`).join('\n')}</code></pre>
</article>`,
  },

  // ─── Lists ───────────────────────────────────────────────────────────
  {
    id: 'list-01-long-list-breaks-between-items',
    category: 'list',
    title: '30-item list breaks between items, never mid-item',
    hypothesis: 'break-inside:avoid on <li> keeps each list item intact across page boundaries.',
    checklist: [
      'Print preview shows AT LEAST 2 pages.',
      'No list item is split between two pages — each bullet sits on exactly ONE page.',
    ],
    body: `<article>
<h1>Backlog</h1>
<p>Fifty items. Each item should stay on one page, even though the list itself spans pages. Count chosen so the list overflows even on US Letter paper at default margins.</p>
<ul>
${Array.from({length:50}, (_,i) => `<li>Item ${i+1}: ${lorem(1)[0]}</li>`).join('\n')}
</ul>
</article>`,
  },
  {
    id: 'list-02-multiline-items-intact',
    category: 'list',
    title: 'list items with multi-line content stay intact',
    hypothesis: 'A list item containing several lines of text (or wrapped long text) is kept on one page by break-inside:avoid on <li>.',
    checklist: [
      'Every list item with a long description is fully visible on ONE page.',
      'No item\'s description starts on one page and continues on the next.',
    ],
    body: `<article>
<h1>Plays we discussed</h1>
<ol>
${Array.from({length:12}, (_,i) => `<li><strong>Play ${i+1}.</strong> ${lorem(1)[0]} ${lorem(1)[1]} ${lorem(1)[2]} ${lorem(1)[3]}</li>`).join('\n')}
</ol>
</article>`,
  },

  // ─── Figures ─────────────────────────────────────────────────────────
  {
    id: 'fig-01-figure-caption-together',
    category: 'fig',
    title: 'figure and its caption stay together',
    hypothesis: 'break-inside:avoid on <figure> keeps the image and its <figcaption> on the same page.',
    checklist: [
      'The image AND its caption appear on the SAME page.',
      'There is no page where the image appears at the bottom and the caption at the top of the next page.',
    ],
    body: `<article>
<h1>Architecture overview</h1>
${lorem(18).map(p => `<p>${p}</p>`).join('\n')}
<figure>
<svg viewBox="0 0 600 200" width="600" height="200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Three boxes connected by arrows">
  <rect x="20" y="60" width="140" height="80" fill="#e4e4e7" stroke="#71717a"/>
  <text x="90" y="105" text-anchor="middle" font-family="sans-serif" font-size="14">Ingest</text>
  <rect x="230" y="60" width="140" height="80" fill="#e4e4e7" stroke="#71717a"/>
  <text x="300" y="105" text-anchor="middle" font-family="sans-serif" font-size="14">Process</text>
  <rect x="440" y="60" width="140" height="80" fill="#e4e4e7" stroke="#71717a"/>
  <text x="510" y="105" text-anchor="middle" font-family="sans-serif" font-size="14">Store</text>
  <line x1="160" y1="100" x2="230" y2="100" stroke="#71717a" stroke-width="2" marker-end="url(#arrow)"/>
  <line x1="370" y1="100" x2="440" y2="100" stroke="#71717a" stroke-width="2" marker-end="url(#arrow)"/>
  <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 Z" fill="#71717a"/></marker></defs>
</svg>
<figcaption>Figure 1 — high-level data flow across the three pipeline stages.</figcaption>
</figure>
${lorem(4).map(p => `<p>${p}</p>`).join('\n')}
</article>`,
  },
  {
    id: 'fig-02-figure-near-boundary-moves',
    category: 'fig',
    title: 'figure near page boundary moves to the next page',
    hypothesis: 'A figure that would otherwise be cut in half by a page break is moved entirely to the next page.',
    checklist: [
      'The figure (the second SVG) appears entirely on ONE page.',
      'No part of the figure or its caption is split across pages.',
      'It is acceptable for the bottom of the preceding page to have whitespace where the figure was moved away from.',
    ],
    body: `<article>
<h1>Process diagram</h1>
${lorem(28).map(p => `<p>${p}</p>`).join('\n')}
<figure>
<svg viewBox="0 0 600 300" width="600" height="300" xmlns="http://www.w3.org/2000/svg" role="img">
  <rect x="20" y="20" width="560" height="260" fill="#f4f4f5" stroke="#a1a1aa"/>
  <text x="300" y="160" text-anchor="middle" font-family="sans-serif" font-size="18">Tall figure that should not be split</text>
</svg>
<figcaption>Figure 2 — a tall figure that should never be split mid-figure across pages.</figcaption>
</figure>
${lorem(3).map(p => `<p>${p}</p>`).join('\n')}
</article>`,
  },

  // ─── Runtime chrome ──────────────────────────────────────────────────
  {
    id: 'chr-01-runtime-chrome-hidden',
    category: 'chr',
    title: '#rwa-runtime, lens, and .placeholder are all hidden in print',
    hypothesis: 'The print stylesheet hides #rwa-runtime entirely, and .placeholder { display: none } removes the invitation copy. Neither should leak into print output.',
    checklist: [
      'The bottom-of-page "lens placeholder" floating card does NOT appear in print preview.',
      'The .placeholder paragraph "Start writing…" does NOT appear in print preview.',
      'On screen (before printing), the lens IS visible at the bottom of the viewport.',
    ],
    body: `<article>
<h1>Doc with runtime chrome attached</h1>
<p class="placeholder">Start writing, or ask the lens below to draft something for you.</p>
<p>Some actual content. The lens chrome and the placeholder should both disappear in print preview.</p>
</article>`,
    includeRuntimeChrome: true,
  },

  // ─── @page rules ─────────────────────────────────────────────────────
  {
    id: 'pg-01-default-18mm-margin',
    category: 'pg',
    title: 'default @page margin is 18mm on all sides',
    hypothesis: '@page { margin: 18mm } gives a uniform 18mm margin on A4/Letter so the prose fits inside a predictable safe area.',
    checklist: [
      'In print preview, the top edge of the first line of text sits ~18mm from the top of the page.',
      'Left and right edges of body text are ~18mm from the page edges.',
      'Bottom of the last line is ~18mm above the bottom edge.',
      'Use a ruler tool or the print-preview measurements panel for verification.',
    ],
    body: `<article>
<h1>Margin probe</h1>
<p>Top, left, right, bottom — all four margins should measure approximately 18mm in the print preview. Resize / paper change should preserve the 18mm margin uniformly.</p>
${lorem(20).map(p => `<p>${p}</p>`).join('\n')}
</article>`,
  },
  {
    id: 'pg-02-document-override-wins',
    category: 'pg',
    title: 'document-level @page override beats the runtime default',
    hypothesis: 'A document\'s own @page rule (declared after the runtime\'s) overrides margin / size — because both rules cascade and the document\'s comes later.',
    checklist: [
      'The page margins are notably tighter (~6mm on all sides), NOT the default 18mm.',
      'This proves the document\'s @page rule won over the runtime\'s @page { margin: 18mm } default.',
    ],
    extraStyle: `@page { margin: 6mm; }`,
    body: `<article>
<h1>Tight-margin doc</h1>
<p>This document overrides the default @page margin to 6mm. Print preview should show MUCH more text per page than a default-margin doc would.</p>
${lorem(35).map(p => `<p>${p}</p>`).join('\n')}
</article>`,
  },
  {
    id: 'pg-03-named-pages-cover-and-body',
    category: 'pg',
    title: 'named pages: cover (no margins, no header) + body (header + page number)',
    hypothesis: '@page :first (or a named-page selector) can carry margin-boxes for headers/footers/page numbers; the cover page is rendered with margin:0 and no margin-box content.',
    checklist: [
      'Page 1 (the cover) prints edge-to-edge with NO header and NO page number.',
      'Page 2 onward prints with a top-center header reading "Annual Report 2026" and a bottom-center page number.',
      'Page numbers increment correctly (1, 2, 3…) on body pages. NOTE: page-number rendering depends on browser engine — Chromium supports counter(page) only via margin-boxes; Safari may differ. Document the actual behavior observed.',
    ],
    extraStyle: `@page { size: A4; margin: 22mm 18mm; @top-center { content: "Annual Report 2026"; font-size: 9pt; } @bottom-center { content: counter(page); font-size: 9pt; } }
@page :first { margin: 0; @top-center { content: none; } @bottom-center { content: none; } }
.cover { page: auto; min-height: 95vh; display: flex; align-items: center; justify-content: center; background: #0a0a0a; color: white; break-after: page; }
.cover h1 { color: white; font-size: 3em; }`,
    body: `<section class="cover">
<h1>Annual Report 2026</h1>
</section>
<article>
<h1>Executive summary</h1>
${lorem(20).map(p => `<p>${p}</p>`).join('\n')}
<h1>Outlook</h1>
${lorem(15).map(p => `<p>${p}</p>`).join('\n')}
</article>`,
  },

  // ─── Edge cases ──────────────────────────────────────────────────────
  {
    id: 'edge-01-forced-break-before',
    category: 'edge',
    title: 'forced break-before:page starts a new section on a new page',
    hypothesis: 'A section with break-before:page (or page-break-before:always) starts a new printed page even if the previous page has room.',
    checklist: [
      'Print preview shows AT LEAST 3 pages.',
      'The H1 "Chapter 2" begins at the TOP of a new page (page 2), regardless of how much space remained on page 1.',
      'The H1 "Chapter 3" begins at the TOP of yet another new page.',
    ],
    extraStyle: `section.chapter { break-before: page; page-break-before: always; }
section.chapter:first-of-type { break-before: auto; page-break-before: auto; }`,
    body: `<article>
<section class="chapter">
<h1>Chapter 1</h1>
${lorem(5).map(p => `<p>${p}</p>`).join('\n')}
</section>
<section class="chapter">
<h1>Chapter 2</h1>
${lorem(5).map(p => `<p>${p}</p>`).join('\n')}
</section>
<section class="chapter">
<h1>Chapter 3</h1>
${lorem(5).map(p => `<p>${p}</p>`).join('\n')}
</section>
</article>`,
  },
  {
    id: 'edge-02-colored-bg-and-links',
    category: 'edge',
    title: 'colored backgrounds preserved (print-color-adjust:exact); links forced black',
    hypothesis: '-webkit-print-color-adjust:exact + print-color-adjust:exact preserve colored backgrounds (callout boxes, highlights). a { color:#000 } in @media print converts blue link text to black so it remains legible when printed monochrome.',
    checklist: [
      'The yellow callout box prints with its yellow background visible.',
      'The green "ok" badge prints with its green background visible.',
      'Hyperlink text (the "rewritable docs" link) prints in BLACK, not blue.',
      'If colored backgrounds are missing, the user may have disabled "Background graphics" in print options — verify it is enabled.',
    ],
    body: `<article>
<h1>Color rendering on print</h1>
<p>This page checks that <em>print-color-adjust:exact</em> preserves coloured backgrounds and that link text drops to black for legibility on monochrome printers.</p>
<aside style="background:#fef3c7;border-left:3px solid #ca8a04;padding:.8em 1em;margin:1em 0;">
<strong>Note.</strong> The yellow background of this callout MUST be visible on the printed page.
</aside>
<p>Status: <span style="background:#dcfce7;color:#15803d;padding:.1em .5em;border-radius:4px;font-weight:600;">ok</span> — the green badge should retain its green background in print.</p>
<p>See the <a href="https://example.com/rewritable">rewritable docs</a> for more — this link should appear in black on the printed page, not the blue you see on screen.</p>
</article>`,
  },
  {
    id: 'edge-03-oversize-block-breaks-inside',
    category: 'edge',
    title: 'block taller than a page is forced to break inside (known limit)',
    hypothesis: 'break-inside:avoid is a hint. When a single <blockquote> is taller than a page, the engine MUST break inside it. The expected behavior is a clean break between lines, not mid-character.',
    checklist: [
      'The blockquote spans AT LEAST 2 pages.',
      'The break inside the blockquote lands at a clean LINE boundary.',
      'No line of the blockquote is split horizontally across two pages.',
      'NOTE: this scenario documents a limit, not a bug — there is nothing CSS can do to keep an oversize block on one page.',
    ],
    body: `<article>
<h1>An oversize quotation</h1>
<blockquote>
${Array.from({length:60}, (_,i) => `<p>Line ${i+1}. ${lorem(1)[0]}</p>`).join('\n')}
</blockquote>
</article>`,
  },
  {
    id: 'edge-04-long-url-in-paragraph',
    category: 'edge',
    title: 'long URL in paragraph — does it wrap or overflow the right margin?',
    hypothesis: 'A long URL has no word-break candidates. Without overflow-wrap:break-word or word-break:break-all in the print CSS, the URL will overflow the right margin and be clipped in print. The runtime currently does NOT set either property.',
    checklist: [
      'The long URL line appears in print preview AND its tail is VISIBLE — i.e. it wraps or is broken.',
      'If the URL extends past the right margin and is CLIPPED, this scenario FAILS — the user lost information.',
      'A footer/references section with many long URLs is a common shape; if URLs are truncated, the printed page is missing data the screen view shows.',
    ],
    body: `<article>
<h1>References</h1>
<p>Recommended reading on the topic — full URLs preserved so this prints as a usable bibliography:</p>
<ol>
<li>See <a href="https://example.com/very/deeply/nested/path/that/keeps/going/forever/with-no-natural-break-points-because-someone-set-up-the-URL-this-way/article-2026-q1-financial-results-and-outlook-with-extensive-supporting-detail-and-appendices.html">https://example.com/very/deeply/nested/path/that/keeps/going/forever/with-no-natural-break-points-because-someone-set-up-the-URL-this-way/article-2026-q1-financial-results-and-outlook-with-extensive-supporting-detail-and-appendices.html</a> for the primary source.</li>
<li>Background context at <a href="https://docs.example.com/2026/operational-reviews/quarterly/Q1-2026-comprehensive-board-package-final-version-after-legal-review-and-board-comments-incorporated.pdf">https://docs.example.com/2026/operational-reviews/quarterly/Q1-2026-comprehensive-board-package-final-version-after-legal-review-and-board-comments-incorporated.pdf</a>.</li>
<li>Inline plain text URL with no anchor: https://internal-tools.example.com/dashboards/finance/revenue-attribution/by-segment/by-region/by-product-line/2026Q1?view=summary&filter=enterprise&group=region&compare=YoY</li>
</ol>
</article>`,
  },
  {
    id: 'edge-05-long-line-in-pre',
    category: 'edge',
    title: '<pre> with very long lines — overflow:auto hides content on print',
    hypothesis: 'The baseline content stylesheet sets pre{overflow-x:auto} so long source lines get a horizontal scrollbar on screen. In print there is no scrollbar — the line is clipped at the right margin and the rest is lost.',
    checklist: [
      'Every line of the code block is FULLY VISIBLE in the print preview.',
      'If any line is cut off at the right margin (because pre has overflow-x:auto and no print override), this FAILS — the user cannot read the rest of that line.',
      'Common shape: a doc with shell commands, long JSON, or stack traces. Truncation in print = unusable PDF.',
    ],
    body: `<article>
<h1>API request example</h1>
<p>The complete URL-encoded request — every character must survive printing:</p>
<pre><code>curl -X POST 'https://api.example.com/v1/runs?org=acme&project=rewritable&environment=production' \\
  -H 'Authorization: Bearer sk-proj-1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890' \\
  -H 'Content-Type: application/json' \\
  -d '{"instruction":"please rewrite the Executive summary section to mention the new EMEA expansion and the supply chain risk register update that the board approved last week","fixture":{"content":"&lt;p&gt;the original document body&lt;/p&gt;"},"options":{"retries":3,"timeout":30000}}'</code></pre>
<p>Notice how each of the three lines in the request body above is intentionally longer than any reasonable page width — this is exactly the shape that the runtime's <code>overflow-x:auto</code> on <code>pre</code> handles on screen but loses in print.</p>
</article>`,
  },
  {
    id: 'edge-06-long-word-in-paragraph',
    category: 'edge',
    title: 'very long unbroken word (hash, German compound) in body text',
    hypothesis: 'A long unbroken word inside a <p> has no spaces to wrap on. Default Chromium behavior on print is to either overflow the right margin (no break) or accept the overflow (clipping). Without overflow-wrap:break-word, a long hash or German compound word will push past the margin.',
    checklist: [
      'The long hash AND the long German compound word are FULLY VISIBLE on the printed page.',
      'If either pushes past the right margin and is clipped, this FAILS.',
      'Real-world shapes: cryptographic hashes in audit logs, German legal/medical compounds, transaction IDs, file paths.',
    ],
    body: `<article>
<h1>Audit log entry</h1>
<p>Transaction reference: 0x4f9c8b2e7a1d6f3c5b8a9e7d4c2b1f0e8d6c5b4a3f2e1d0c9b8a7e6d5c4b3a2f1e0d. The hash is intentionally long and has no break opportunities; it must remain fully readable on the printed page.</p>
<p>Counterparty (German legal entity): Donaudampfschiffahrtselektrizitätenhauptbetriebswerkbauunterbeamtengesellschaft. Same overflow concern, different cause — German compounding produces single tokens with no natural break candidates.</p>
<p>File path: /Users/finance-ops/Documents/2026/quarterly-reviews/q1-board-package/working-drafts/v17-after-legal-review/appendix-c-supplementary-supplier-concentration-analysis.xlsx</p>
</article>`,
  },
  {
    id: 'edge-07-table-in-list-in-blockquote',
    category: 'edge',
    title: 'deeply nested: <table> inside <li> inside <blockquote>',
    hypothesis: 'Three nested break-inside:avoid elements (blockquote, li, table). Chromium resolves the conflict by treating each rule as a hint at each level. The expected result: the WHOLE blockquote tries to stay together; if it cannot, the engine breaks at LI boundaries; if any LI is taller than a page, the engine breaks inside it (at row boundaries inside the table).',
    checklist: [
      'Every TABLE row appears on exactly one page (no mid-row split).',
      'Every LI in the outer list appears on exactly one page where reasonably sized.',
      'The blockquote border-left visual treatment is preserved across page breaks.',
      'Header rows of the nested tables repeat at the top of each continuation page (browser default for <thead>).',
    ],
    body: `<article>
<h1>Nested content stress test</h1>
<p>The blockquote below contains a list, each item of which contains a small table. All three layers carry break-inside:avoid in the print CSS.</p>
<blockquote>
<p>From the Q1 board memo, pre-meeting comments:</p>
<ol>
<li>
<strong>Supplier concentration.</strong> The top three suppliers represent over 60% of input spend. Recent contract renewals brought the breakdown to:
<table>
<thead><tr><th>Supplier</th><th>Spend share</th><th>Renewed</th></tr></thead>
<tbody>
<tr><td>Acme</td><td>28%</td><td>Yes</td></tr>
<tr><td>Beacon</td><td>19%</td><td>Yes</td></tr>
<tr><td>Crestline</td><td>14%</td><td>No</td></tr>
<tr><td>Doric</td><td>9%</td><td>No</td></tr>
</tbody>
</table>
</li>
<li>
<strong>FX exposure by corridor.</strong> Three new corridors added to the risk register this quarter:
<table>
<thead><tr><th>Corridor</th><th>Notional</th><th>Hedge</th></tr></thead>
<tbody>
<tr><td>EUR→USD</td><td>4.2M</td><td>50%</td></tr>
<tr><td>USD→JPY</td><td>2.8M</td><td>30%</td></tr>
<tr><td>GBP→EUR</td><td>1.1M</td><td>0%</td></tr>
</tbody>
</table>
</li>
<li>
<strong>Headcount plan.</strong> Net additions through Q3, by function:
<table>
<thead><tr><th>Function</th><th>Q2</th><th>Q3</th><th>Total</th></tr></thead>
<tbody>
<tr><td>Engineering</td><td>+4</td><td>+6</td><td>+10</td></tr>
<tr><td>Customer success</td><td>+2</td><td>+3</td><td>+5</td></tr>
<tr><td>Finance</td><td>+1</td><td>+1</td><td>+2</td></tr>
</tbody>
</table>
</li>
</ol>
<p>End of pre-meeting comments. Comments above represent author position only.</p>
</blockquote>
</article>`,
  },
  {
    id: 'edge-08-pre-and-list-in-table-cell',
    category: 'edge',
    title: 'rich content inside table cell: <pre>, <ul>, multi-paragraph',
    hypothesis: 'A table cell holding multi-paragraph text plus a code block plus a list. The print rules apply break-inside:avoid to the row (tr), but the row may be taller than the page if the cell content is large. Same forced-break dynamic as edge-03.',
    checklist: [
      'Every table row is fully readable across pages.',
      'No paragraph or list item inside a cell is split horizontally.',
      'If the row exceeds one page (expected for the largest row), the engine breaks at a child-element boundary inside the cell (between paragraphs or list items), not mid-text.',
      'The thead row repeats at the top of every continuation page that contains table content.',
    ],
    body: `<article>
<h1>Runbook</h1>
<table>
<thead><tr><th>Step</th><th>Action</th><th>Details</th></tr></thead>
<tbody>
<tr>
<td>1</td>
<td>Detect</td>
<td>
<p>Paging signals come from two sources:</p>
<ul>
<li>Synthetic checks on the primary endpoint</li>
<li>Customer-reported errors via the support inbox</li>
</ul>
<p>The on-call engineer acknowledges within 5 minutes.</p>
</td>
</tr>
<tr>
<td>2</td>
<td>Triage</td>
<td>
<p>Reproduce the error locally using the recorded curl from the alert payload:</p>
<pre><code>curl -X GET 'https://api.example.com/v1/health/deep' \\
  -H 'Authorization: Bearer $TOKEN'</code></pre>
<p>If the deep health check returns 5xx, escalate to the platform team via the #incidents channel and proceed to step 3.</p>
</td>
</tr>
<tr>
<td>3</td>
<td>Mitigate</td>
<td>
<p>Mitigation options in order of preference:</p>
<ol>
<li>Roll back the last deploy via the rollback workflow</li>
<li>Shed traffic to the fallback region</li>
<li>Engage the database team for replica promotion</li>
<li>Failover to the last known good snapshot</li>
</ol>
<p>Document the chosen mitigation in the incident channel before executing.</p>
</td>
</tr>
<tr>
<td>4</td>
<td>Resolve</td>
<td>
<p>Once the root cause is identified, land the permanent fix on the next release train. Update the runbook with any newly discovered failure mode.</p>
</td>
</tr>
</tbody>
</table>
</article>`,
  },
];

// ─── Emit ─────────────────────────────────────────────────────────────

const CATEGORY_LABELS = {
  sp:   'Single-page',
  mp:   'Multipage prose',
  tbl:  'Tables',
  code: 'Code blocks',
  list: 'Lists',
  fig:  'Figures',
  chr:  'Runtime chrome',
  pg:   '@page rules',
  edge: 'Edge cases',
};

function emit() {
  let count = 0;
  for (const s of SCENARIOS) {
    const filename = `${s.id}.html`;
    const html = wrap(s);
    fs.writeFileSync(path.join(__dirname, filename), html);
    count++;
  }
  fs.writeFileSync(path.join(__dirname, 'MANIFEST.md'), buildManifest());
  console.log(`wrote ${count} scenario fixtures + MANIFEST.md`);
}

function buildManifest() {
  const rows = SCENARIOS.map(s => {
    const cat = CATEGORY_LABELS[s.category] || s.category;
    return `| \`${s.id}.html\` | ${cat} | ${s.title} |`;
  }).join('\n');

  const detail = SCENARIOS.map(s => {
    const cat = CATEGORY_LABELS[s.category] || s.category;
    const checks = s.checklist.map((c, i) => `   ${i+1}. ${c}`).join('\n');
    return `### \`${s.id}.html\` — ${cat}

**Title.** ${s.title}

**Hypothesis under test.** ${s.hypothesis}

**Manual checklist (Chromium ⌘P preview):**
${checks}
`;
  }).join('\n---\n\n');

  return `# Print-fidelity scenarios

Self-contained HTML fixtures that exercise the runtime's print stylesheet
across the failure modes that matter for "save as PDF" output.

## Quick start

\`\`\`bash
# Regenerate the .html fixtures from generate.mjs
node benchmark/scenarios/print/generate.mjs

# Open any scenario in a browser; preview with Cmd/Ctrl-P
open benchmark/scenarios/print/sp-02-short-prose.html

# Run automated assertions (requires Chrome + poppler-utils)
node benchmark/scenarios/print/validate.mjs
\`\`\`

The validator prints each fixture to PDF via headless Chrome, then runs
text-only assertions on the result: page count, text presence/absence,
"every row on exactly one page", "caption + table on same page", and
forced-break-target-page. Expected output: \`23 passed, 0 failed\`.

## Side-by-side: source HTML ↔ rendered PDF

The validator writes one PDF per fixture, same basename, to
\`benchmark/results/print/\` (gitignored). After a run:

\`\`\`
benchmark/scenarios/print/<id>.html   ← source fixture
benchmark/results/print/<id>.pdf      ← what Chrome printed
\`\`\`

Open both side-by-side to eyeball the rendering, or compare PDFs across
runs after a print-CSS change:

\`\`\`bash
# Compare two runs (e.g. before / after a seed CSS edit)
mv benchmark/results/print benchmark/results/print.before
node benchmark/scenarios/print/validate.mjs
diff -r benchmark/results/print.before benchmark/results/print
\`\`\`

## Verification protocol

Each fixture embeds the seed's print CSS verbatim (mirrored in
\`generate.mjs\`'s \`PRINT_CSS\` constant). The verification protocol:

1. Open the fixture in **Chromium** (Chrome / Edge / Brave). Chromium is
   the primary save-as-PDF target — Safari and Firefox behave slightly
   differently for some scenarios (notably named-page margin-boxes).
2. Hit **⌘P / Ctrl-P** to enter print preview.
3. In the print dialog: paper size A4 (or Letter), background graphics
   **enabled**, margins **default** (do NOT override — that's what \`@page\`
   controls in the document).
4. Walk through the **checklist** embedded as an HTML comment at the top
   of the fixture (also reproduced below).
5. If any checklist item fails, the scenario fails.

For automated text-level checks, run \`node validate.mjs\` from this
directory — it prints each fixture to PDF with headless Chrome and
asserts the per-scenario text invariants. See \`_runner-spec.md\` for
the larger puppeteer-based design that adds pixel-level checks.

## Scenario index

| Fixture | Category | What it tests |
| --- | --- | --- |
${rows}

## Per-scenario detail

${detail}

## What the print CSS protects

The fixtures cover each claim the runtime's \`@media print\` block makes:

| Claim | Scenarios |
| --- | --- |
| 18mm @page margin | \`pg-01\`, \`pg-02\` |
| Document @page wins over runtime default | \`pg-02\`, \`pg-03\` |
| Named pages (first / body) + margin-boxes | \`pg-03\` |
| Runtime chrome (\`#rwa-runtime\`) hidden | \`chr-01\` |
| \`.placeholder\` hidden | \`sp-01\`, \`chr-01\` |
| \`article { max-width: none }\` on print | \`sp-02\` |
| \`break-after: avoid\` on h1-h6 | \`mp-02\` |
| \`break-inside: avoid\` on table | \`tbl-01\`, \`tbl-05\` |
| \`break-inside: avoid\` on tr | \`tbl-02\`, \`tbl-03\` |
| \`break-inside: avoid\` on pre | \`code-01\` (and \`code-02\` documents the limit) |
| \`break-inside: avoid\` on li | \`list-01\`, \`list-02\` |
| \`break-inside: avoid\` on figure | \`fig-01\`, \`fig-02\` |
| \`break-inside: avoid\` on blockquote | (limit documented in \`edge-03\`) |
| \`orphans: 3; widows: 3\` on p | \`mp-01\` |
| \`a { color: #000 }\` on print | \`edge-02\` |
| \`print-color-adjust: exact\` | \`edge-02\` |
| Forced \`break-before: page\` | \`edge-01\` |

## How to add a scenario

1. Add an entry to the \`SCENARIOS\` array in \`generate.mjs\`. Required
   fields: \`id\`, \`category\`, \`title\`, \`hypothesis\`, \`checklist\`, \`body\`.
   Optional: \`extraStyle\`, \`includeRuntimeChrome\`.
2. Pick an \`id\` of the form \`<category>-NN-shortname\`.
3. Re-run \`node generate.mjs\`. The new \`.html\` file appears alongside
   the others, and MANIFEST.md is regenerated.
4. Walk the checklist yourself in Chromium print preview at least once
   to make sure the scenario behaves as described — both the
   "passes-on-current-runtime" and "would-fail-if-the-runtime-broke-X"
   sides.

## Known scope limits

- These fixtures assume Chromium semantics. Firefox's print engine
  honors break-* hints slightly differently; Safari ignores some
  margin-box content. The fixtures still print correctly there, but the
  named-page header/footer in \`pg-03\` is the most engine-sensitive.
- jsdom (the conformance harness) cannot evaluate page-break rules. The
  print fixtures are therefore NOT run as part of \`npm run conformance\`
  or \`npm run fidelity\`. See \`_runner-spec.md\` for the optional headless
  runner that wraps these fixtures in puppeteer.
- iOS Safari's "Save to PDF" share path uses the same WebKit engine as
  desktop Safari for layout, but adds its own page-break heuristics on
  top — verify there separately for critical share targets.
`;
}

emit();
