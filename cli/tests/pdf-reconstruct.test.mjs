// Tests for the PDF structural reconstruction module (spans+rules → editable hybrid HTML).
// Design: docs/plans/2026-07-02-pdf-structural-reconstruction-design.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupLines,
  segmentRegions,
  detectColumns,
  classifyRegion,
  emitProse,
  emitTable,
  reconstructPage,
  parseGeometryPage,
  reconstructGeometryHtml,
} from '../src/pdf-reconstruct.mjs';

test('groupLines: runs on the same baseline become one line, ordered left-to-right', () => {
  const runs = [
    { x: 300, y: 100,   w: 20, fontSize: 10, text: 'C' },
    { x: 71,  y: 100.4, w: 40, fontSize: 10, text: 'A' },
    { x: 150, y: 101,   w: 30, fontSize: 10, text: 'B' },
    { x: 71,  y: 130,   w: 40, fontSize: 10, text: 'next line' },
  ];
  const lines = groupLines(runs);
  assert.equal(lines.length, 2, 'two baselines → two lines');
  assert.deepEqual(lines[0].runs.map((r) => r.text), ['A', 'B', 'C'], 'first line ordered by x');
  assert.deepEqual(lines[1].runs.map((r) => r.text), ['next line']);
});

test('segmentRegions: a large vertical gap splits lines into separate regions', () => {
  const line = (y, text) => ({ y, runs: [{ x: 71, y, fontSize: 10, text }] });
  const lines = [
    line(100, 'a1'), line(113, 'a2'), line(126, 'a3'), // tight block
    line(300, 'b1'), line(313, 'b2'),                   // after a big gap
  ];
  const regions = segmentRegions(lines);
  assert.equal(regions.length, 2, 'the outsized gap is a region boundary');
  assert.deepEqual(regions[0].lines.map((l) => l.runs[0].text), ['a1', 'a2', 'a3']);
  assert.deepEqual(regions[1].lines.map((l) => l.runs[0].text), ['b1', 'b2']);
});

test('segmentRegions: a lone-line region between blocks still splits (few small gaps)', () => {
  const line = (y, t) => ({ y, runs: [{ x: 71, y, fontSize: 10, text: t }] });
  // heading (1 line) · gap · prose (2 lines) · gap · table-ish (2 lines) — big gaps are
  // half of all gaps, so a median threshold collapses it; the estimate must favour the
  // small intra-region spacing.
  const lines = [line(100, 'H'), line(200, 'p1'), line(214, 'p2'), line(300, 't1'), line(314, 't2')];
  const regions = segmentRegions(lines);
  assert.equal(regions.length, 3, 'three blocks despite the sparse intra-region lines');
});

test('detectColumns: runs that align across lines form ordered column bands', () => {
  const region = {
    lines: [
      { y: 100, runs: [
        { x: 71, y: 100, w: 100, fontSize: 10, text: 'Item A' },
        { x: 340, y: 100, w: 50, fontSize: 10, text: '10' },
        { x: 450, y: 100, w: 60, fontSize: 10, text: 'Q1' },
      ] },
      { y: 120, runs: [
        { x: 71, y: 120, w: 100, fontSize: 10, text: 'Item B' },
        { x: 340, y: 120, w: 50, fontSize: 10, text: '20' },
        { x: 450, y: 120, w: 60, fontSize: 10, text: 'Q2' },
      ] },
    ],
  };
  const cols = detectColumns(region);
  assert.equal(cols.length, 3, 'three aligned x-bands → three columns');
  assert.ok(Math.abs(cols[0].x - 71) < 5, 'col 0 at ~71');
  assert.ok(Math.abs(cols[1].x - 340) < 5, 'col 1 at ~340');
  assert.ok(Math.abs(cols[2].x - 450) < 5, 'col 2 at ~450');
});

test('classifyRegion: a multi-column region is a table', () => {
  const region = { lines: [
    { y: 100, runs: [{ x: 71, y: 100, w: 100, fontSize: 10, text: 'A' }, { x: 340, y: 100, w: 50, fontSize: 10, text: '1' }] },
    { y: 120, runs: [{ x: 71, y: 120, w: 100, fontSize: 10, text: 'B' }, { x: 340, y: 120, w: 50, fontSize: 10, text: '2' }] },
  ] };
  assert.equal(classifyRegion(region).type, 'table');
});

test('classifyRegion: a multi-line single-column region is prose', () => {
  const region = { lines: [
    { y: 100, runs: [{ x: 71, y: 100, w: 400, fontSize: 10, text: 'Sehr geehrte Damen und Herren, wie im' }] },
    { y: 114, runs: [{ x: 71, y: 114, w: 400, fontSize: 10, text: 'Angebot vereinbart, stellen wir in Rechnung.' }] },
  ] };
  assert.equal(classifyRegion(region).type, 'prose');
});

test('classifyRegion: a lone bold line is a heading', () => {
  const region = { lines: [
    { y: 100, runs: [{ x: 71, y: 100, w: 150, fontSize: 11, bold: true, text: 'RECHNUNG 0018_2026' }] },
  ] };
  assert.equal(classifyRegion(region).type, 'heading');
});

test('classifyRegion: prose with scattered positional runs is NOT mistaken for a table', () => {
  // Two lines: the left edge is shared, but the other runs land at different x per line
  // (justified prose with an emphasized phrase), so the non-first "columns" are sparse —
  // this is prose, not a grid. A real table populates its columns across most rows.
  const region = { lines: [
    { y: 100, runs: [
      { x: 71, y: 100, w: 300, fontSize: 10, text: 'wie im Angebot vereinbart, das Projekt' },
      { x: 501, y: 100, w: 15, fontSize: 11, bold: true, text: 'KI' },
    ] },
    { y: 114, runs: [
      { x: 71, y: 114, w: 220, fontSize: 11, bold: true, text: 'Chatbot Apothekengruppe' },
      { x: 304, y: 114, w: 110, fontSize: 10, text: 'in Rechnung zu stellen.' },
    ] },
  ] };
  assert.equal(classifyRegion(region).type, 'prose');
});

test('emitProse: region reflows into one <p>, consecutive bold runs merged, order fixed', () => {
  const region = { lines: [
    { y: 100, runs: [
      { x: 71, y: 100, w: 300, fontSize: 10, text: 'wie im Angebot vereinbart, stellen wir das Projekt' },
      { x: 400, y: 100, w: 20, fontSize: 11, bold: true, text: 'KI' },
    ] },
    { y: 114, runs: [
      { x: 71, y: 114, w: 200, fontSize: 11, bold: true, text: 'Chatbot Apothekengruppe' },
      { x: 300, y: 114, w: 120, fontSize: 10, text: 'in Rechnung zu stellen.' },
    ] },
  ] };
  const html = emitProse(region);
  assert.match(html, /^<p>.*<\/p>$/s, 'wrapped in a single <p>');
  assert.match(
    html,
    /wie im Angebot vereinbart, stellen wir das Projekt <b>KI Chatbot Apothekengruppe<\/b> in Rechnung zu stellen\./,
    'runs reflowed in reading order with the bold phrase merged into one <b>',
  );
});

test('emitProse: HTML-special characters in run text are escaped', () => {
  const region = { lines: [{ y: 1, runs: [{ x: 0, y: 1, w: 50, fontSize: 10, text: 'A & B < C' }] }] };
  assert.match(emitProse(region), /A &amp; B &lt; C/);
});

test('emitTable: builds rows x columns, assigns runs to the right cell, right-aligns amounts', () => {
  const region = { lines: [
    { y: 100, runs: [
      { x: 71, y: 100, w: 120, fontSize: 10, text: 'Gesamtsumme netto' },
      { x: 340, y: 100, w: 54, fontSize: 10, text: '€ 1.740,00' },
    ] },
    { y: 114, runs: [
      { x: 71, y: 114, w: 110, fontSize: 10, text: '20% Umsatzsteuer' },
      { x: 347, y: 114, w: 47, fontSize: 10, text: '€ 348,00' }, // right-aligned: starts further right, same right edge
    ] },
  ] };
  const cols = detectColumns(region); // [~71, ~340] — 347 is within tol of 340
  const html = emitTable(region, cols, []);
  assert.match(html, /^<table[\s\S]*<\/table>$/, 'wrapped in a table');
  assert.equal((html.match(/<tr>/g) || []).length, 2, 'two rows');
  assert.equal((html.match(/<td/g) || []).length, 4, 'two cells per row');
  assert.match(html, /<td[^>]*>Gesamtsumme netto<\/td>/, 'label cell, left-aligned (no style)');
  assert.match(html, /<td style="text-align:right">€ 1\.740,00<\/td>/, 'amount cell right-aligned');
});

test('reconstructPage: assembles heading + prose + table into semantic HTML', () => {
  const page = { width: 595, height: 842, rules: [], runs: [
    { x: 71, y: 100, w: 150, fontSize: 12, bold: true, text: 'RECHNUNG 0018' },
    { x: 71, y: 200, w: 400, fontSize: 10, text: 'Sehr geehrte Damen und Herren, wir stellen' },
    { x: 71, y: 214, w: 400, fontSize: 10, text: 'die Leistung in Rechnung.' },
    { x: 71, y: 300, w: 120, fontSize: 10, text: 'Netto' },
    { x: 340, y: 300, w: 54, fontSize: 10, text: '€ 100' },
    { x: 71, y: 314, w: 120, fontSize: 10, text: 'Summe' },
    { x: 345, y: 314, w: 49, fontSize: 10, text: '€ 120' },
  ] };
  const { html, confidence } = reconstructPage(page);
  assert.match(html, /<h2>RECHNUNG 0018<\/h2>/, 'lone bold line → heading');
  assert.match(html, /<p>Sehr geehrte Damen und Herren, wir stellen die Leistung in Rechnung\.<\/p>/, 'prose reflowed');
  assert.match(html, /<table>[\s\S]*Netto[\s\S]*€ 100[\s\S]*Summe[\s\S]*€ 120[\s\S]*<\/table>/, 'grid → table');
  assert.ok(confidence > 0.8, 'clean regions → high confidence');
});

test('reconstructPage: a scattered multi-line block (two x-groups, not a grid) → geometry island', () => {
  // Lines alternate between a left column (x=62) and a right column (x=476) — a spatial
  // two-column block (like an An:/Kontaktdaten: address pair), NOT a filled grid and NOT
  // single-column prose. Flowing it as one <p> would interleave the columns into gibberish,
  // so the safe output is the faithful positioned-span island.
  const page = { width: 595, height: 842, rules: [], runs: [
    { x: 62, y: 100, w: 200, fontSize: 10, text: 'Left line one' },
    { x: 476, y: 114, w: 100, fontSize: 10, text: 'Right line one' },
    { x: 62, y: 128, w: 150, fontSize: 10, text: 'Left line two' },
    { x: 476, y: 142, w: 90, fontSize: 10, text: 'Right line two' },
  ] };
  const { html } = reconstructPage(page);
  assert.match(html, /rwa-pdf-fallback/, 'preserved as a positioned island');
  assert.match(html, /Left line one/);
  assert.doesNotMatch(html, /Left line one Right line one/, 'columns not interleaved into one paragraph');
});

test('parseGeometryPage: parses positioned spans + rule divs into runs and rules', () => {
  const pageHtml = [
    '<div class="rwa-pdf-page" style="width:595.28px;height:841.89px">',
    '<div class="rwa-pdf-g" style="left:71px;top:460px;width:250px;height:1.5px;background:#000000"></div>',
    '<span class="rwa-pdf-t" style="left:71px;top:100px;font-size:10px;font-family:Georgia, \'Times New Roman\', serif">Hello &amp; you</span>',
    '<span class="rwa-pdf-t" style="left:340px;top:100px;font-size:11px;font-family:Georgia;font-weight:700">Bold</span>',
    '</div>',
  ].join('\n');
  const page = parseGeometryPage(pageHtml);
  assert.equal(page.width, 595.28);
  assert.equal(page.height, 841.89);
  assert.equal(page.runs.length, 2);
  assert.equal(page.runs[0].text, 'Hello & you', 'entities decoded');
  assert.equal(page.runs[0].x, 71);
  assert.equal(page.runs[0].y, 100);
  assert.equal(page.runs[0].fontSize, 10);
  assert.ok(page.runs[0].w > 0, 'run width estimated (not in the emitted span)');
  assert.equal(page.runs[1].bold, true, 'font-weight:700 → bold');
  assert.equal(page.rules.length, 1);
  assert.deepEqual(
    { x: page.rules[0].x, y: page.rules[0].y, w: page.rules[0].w, h: page.rules[0].h },
    { x: 71, y: 460, w: 250, h: 1.5 },
  );
});

test('reconstructGeometryHtml: converts a geometry article into a semantic editable article', () => {
  const article = [
    '<article class="rwa-pdf">',
    '<style>.rwa-pdf{margin:0}</style>',
    '<div class="rwa-pdf-doc">',
    '<div class="rwa-pdf-page" style="width:595px;height:842px">',
    '<span class="rwa-pdf-t" style="left:71px;top:100px;font-size:12px;font-weight:700">Invoice 42</span>',
    '<span class="rwa-pdf-t" style="left:71px;top:200px;font-size:10px">Thank you for your</span>',
    '<span class="rwa-pdf-t" style="left:71px;top:214px;font-size:10px">business this year.</span>',
    '</div>',
    '</div>',
    '</article>',
  ].join('\n');
  const out = reconstructGeometryHtml(article);
  assert.match(out, /^<article/, 'still an article');
  assert.match(out, /<h2>Invoice 42<\/h2>/, 'lone bold line → heading');
  assert.match(out, /<p>Thank you for your business this year\.<\/p>/, 'prose reflowed into a paragraph');
  assert.doesNotMatch(out, /rwa-pdf-t/, 'positioned spans replaced by semantic elements');
});

// ── Review fixes ────────────────────────────────────────────────────────────

// F1: islands must self-position (the reconstructed article ships no .rwa-pdf-t stylesheet)
test('F1 emitGeometryFallback: island spans carry inline position:absolute', () => {
  // Alternating left/right lines (an address pair) — a scattered block that stays an island,
  // NOT a filled grid (which would correctly become a table).
  const page = { runs: [
    { x: 62, y: 100, w: 200, fontSize: 10, text: 'Left one' },
    { x: 476, y: 114, w: 100, fontSize: 10, text: 'Right one' },
    { x: 62, y: 128, w: 150, fontSize: 10, text: 'Left two' },
    { x: 476, y: 142, w: 90, fontSize: 10, text: 'Right two' },
  ] };
  const { html } = reconstructPage(page);
  assert.match(html, /rwa-pdf-fallback/, 'is an island');
  const spans = html.match(/<span class="rwa-pdf-t"[^>]*>/g) || [];
  assert.ok(spans.length >= 2, 'has positioned spans');
  for (const s of spans) assert.match(s, /position:absolute/, 'every span self-positions');
});

// F2: a lone bold line split into runs is a heading, not a 1-row table
test('F2 classifyRegion: a lone bold multi-run line is a heading, not a table', () => {
  const region = { lines: [{ y: 100, runs: [
    { x: 71, y: 100, w: 120, fontSize: 12, bold: true, text: 'RECHNUNG' },
    { x: 260, y: 100, w: 100, fontSize: 12, bold: true, text: '0018_2026' },
  ] }] };
  assert.equal(classifyRegion(region).type, 'heading');
});

test('F2 classifyRegion: a lone non-bold multi-column line stays a table (line-item row)', () => {
  const region = { lines: [{ y: 100, runs: [
    { x: 71, y: 100, w: 200, fontSize: 10, text: 'Umsetzung X' },
    { x: 340, y: 100, w: 54, fontSize: 10, text: '€ 100' },
    { x: 450, y: 100, w: 60, fontSize: 10, text: 'Q1' },
  ] }] };
  assert.equal(classifyRegion(region).type, 'table');
});

// F3: adjacency-aware spacing — a mid-word run split joins without a space
test('F3 emitProse: adjacent runs join without a space; gapped runs get a space', () => {
  const adjacent = { lines: [{ y: 1, runs: [
    { x: 71, y: 1, w: 20, fontSize: 10, text: 'Rech' },
    { x: 91, y: 1, w: 30, fontSize: 10, text: 'nung' }, // butts against 71+20
  ] }] };
  assert.match(emitProse(adjacent), /<p>Rechnung<\/p>/);
  const gapped = { lines: [{ y: 1, runs: [
    { x: 71, y: 1, w: 20, fontSize: 10, text: 'Hello' },
    { x: 130, y: 1, w: 30, fontSize: 10, text: 'World' }, // clear gap
  ] }] };
  assert.match(emitProse(gapped), /<p>Hello World<\/p>/);
});

// F4: a two-line region with a large gap splits (font-based threshold when gaps are too few)
test('F4 segmentRegions: a two-line region with a large gap splits', () => {
  const line = (y, t) => ({ y, runs: [{ x: 71, y, fontSize: 10, text: t }] });
  assert.equal(segmentRegions([line(100, 'title'), line(500, 'body')]).length, 2);
});

// F5: a large opening title does not inflate the threshold and swallow the body
test('F5 segmentRegions: a large title does not merge the body blocks below it', () => {
  const line = (y, fs, t) => ({ y, runs: [{ x: 71, y, fontSize: fs, text: t }] });
  // Body blocks are 30px apart — above a 10px-font threshold (~25) but below the inflated
  // 24px-title floor (24*1.6=38.4), so a first-line-font floor wrongly merges them.
  const lines = [line(100, 24, 'BIG'), line(160, 10, 'a'), line(174, 10, 'ab'), line(204, 10, 'b'), line(218, 10, 'bb')];
  assert.ok(segmentRegions(lines).length >= 3, 'title + 2 body blocks stay separate');
});

// F6: groupLines keeps a small superscript run on its large-font baseline
test('F6 groupLines: a small superscript run stays on its large-font baseline', () => {
  const runs = [
    { x: 71, y: 100, w: 30, fontSize: 20, text: 'H' },
    { x: 101, y: 108, w: 8, fontSize: 8, text: '2' },
    { x: 71, y: 140, w: 30, fontSize: 20, text: 'next' },
  ];
  const lines = groupLines(runs);
  assert.equal(lines.length, 2, 'H+2 share a line; next is separate');
  assert.deepEqual(lines[0].runs.map((r) => r.text), ['H', '2']);
});

// F8: prose with a first-line indent stays prose (one dominant margin + one outlier)
test('F8 classifyRegion: prose with a first-line indent is still prose, above threshold', () => {
  const region = { lines: [
    { y: 100, runs: [{ x: 91, y: 100, w: 380, fontSize: 10, text: 'Indented first line' }] },
    { y: 114, runs: [{ x: 71, y: 114, w: 400, fontSize: 10, text: 'second line at margin' }] },
    { y: 128, runs: [{ x: 71, y: 128, w: 400, fontSize: 10, text: 'third line at margin' }] },
  ] };
  const c = classifyRegion(region);
  assert.equal(c.type, 'prose');
  assert.ok(c.confidence >= 0.5, 'not dumped to a fallback island');
});

// F9: drawn rules corroborate a sparse (empty-celled) short table
test('F9 classifyRegion: a rule-bounded sparse 2-column region is a table', () => {
  const region = { lines: [
    { y: 100, runs: [{ x: 71, y: 100, w: 100, fontSize: 10, text: 'Netto' }, { x: 340, y: 100, w: 54, fontSize: 10, text: '€ 100' }] },
    { y: 114, runs: [{ x: 71, y: 114, w: 100, fontSize: 10, text: 'Rabatt' }] }, // amount cell empty
  ] };
  const rules = [{ x: 71, y: 95, w: 300, h: 1 }, { x: 71, y: 120, w: 300, h: 1 }];
  assert.equal(classifyRegion(region, rules).type, 'table');
});

// F13: parseGeometryPage drops empty/whitespace positioning spans (no phantom runs)
test('F13 parseGeometryPage: empty/whitespace spans are not turned into phantom runs', () => {
  const pageHtml = [
    '<div class="rwa-pdf-page" style="width:595px;height:842px">',
    '<span class="rwa-pdf-t" style="left:71px;top:100px;font-size:10px"></span>',
    '<span class="rwa-pdf-t" style="left:71px;top:100px;font-size:10px">real</span>',
    '</div>',
  ].join('\n');
  const page = parseGeometryPage(pageHtml);
  assert.equal(page.runs.length, 1);
  assert.equal(page.runs[0].text, 'real');
});

// F15: styleNum matches the exact property, not a substring of a compound one
test('F15 parseGeometryPage: a compound property does not leak into a shorter lookup', () => {
  const pageHtml = '<div class="rwa-pdf-page" style="width:1px;height:1px"><span class="rwa-pdf-t" style="margin-top:999px;left:71px;top:100px;font-size:10px">x</span></div>';
  const page = parseGeometryPage(pageHtml);
  assert.equal(page.runs[0].y, 100, 'top is 100, not 999 leaked from margin-top');
});
