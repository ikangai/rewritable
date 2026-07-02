// PDF structural reconstruction — geometry (positioned runs + drawn rules) → editable
// hybrid HTML (nested tables for grid regions, flowing prose elsewhere). Deterministic,
// offline. Design: docs/plans/2026-07-02-pdf-structural-reconstruction-design.md
//
// This is a NEW module and does NOT touch the geometry importer (cli/src/import.mjs).
// It is opt-in (a --editable rung, wired in a later step). Input is structured runs so
// the core is testable without pdf.js; a parser adapts the emitted geometry HTML.
//
// Run shape: { x, y, w, fontSize, bold?, italic?, text }  (x=left, y=top, w=width, px).
// Rule shape: { x, y, w, h }  (a drawn line/box, px).
//
// STATUS — increment 1 (deterministic core). Verified on a real invoice: the letter
// paragraph reflows to <p> (bold phrase merged), the line-item / totals / footer become
// editable <table>s, headings become <h*>. Honest limitations, each a future increment or
// exactly what the opt-in visual judge is meant to flag:
//   • Spatial multi-column blocks (An:/Kontaktdaten: address pair, right-aligned header)
//     are kept as faithful positioned-span ISLANDS via the confidence fallback rather than
//     lifted to a 2-cell row — safe, not yet ideal.
//   • Table column detection can over-split a cell whose runs sit at slightly varying x
//     (e.g. "€" and the number as separate columns); cell-merge is not done yet.
//   • Run widths from the HTML adapter are ESTIMATED (text length × font size); exact
//     pdf.js widths arrive when this is wired straight into the importer.
// Not yet wired into the CLI — the --editable rung + import.mjs integration is a next step.

// Cluster runs into visual lines by baseline (y), then order each line left-to-right.
// Runs whose top is within ~half a line-height of the line's anchor share a baseline;
// this re-derives reading order from x, so a run the extractor emitted out of order
// (or merged across columns) is put back in place.
export function groupLines(runs) {
  const sorted = [...runs].sort((a, b) => a.y - b.y);
  const lines = [];
  for (const r of sorted) {
    const last = lines[lines.length - 1];
    const rfs = r.fontSize || 10;
    // Tolerance scales to the LARGER of the line's and the run's font, so a small superscript
    // stays on its big-font baseline; the anchor is a running mean, so it doesn't drift with a
    // slowly-shifting baseline (comparing to a fixed first-run y wrongly splits either case).
    const tol = last ? Math.max(rfs, last.fs) * 0.6 : rfs * 0.6;
    if (last && Math.abs(r.y - last.y) <= tol) {
      last.runs.push(r);
      last.sum += r.y;
      last.y = last.sum / last.runs.length;
      last.fs = Math.max(last.fs, rfs);
    } else {
      lines.push({ y: r.y, runs: [r], sum: r.y, fs: rfs });
    }
  }
  for (const l of lines) { l.runs.sort((a, b) => a.x - b.x); delete l.sum; delete l.fs; }
  return lines;
}

// Group consecutive lines into regions, splitting where the vertical gap is markedly
// larger than the document's typical line spacing (median-based, so a few big gaps don't
// skew the threshold). A region is a candidate block: prose paragraph, table, heading, …
export function segmentRegions(lines) {
  if (lines.length === 0) return [];
  const gaps = [];
  for (let i = 1; i < lines.length; i++) gaps.push(lines[i].y - lines[i - 1].y);
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const fonts = lines.map((l) => l.runs[0]?.fontSize || 10).sort((a, b) => a - b);
  const medFont = fonts[Math.floor(fonts.length / 2)];
  // Intra-region line spacing: a LOW percentile of the gaps when there are enough to be
  // representative, else font-based (a lone/2-line region has no reliable gap sample — a
  // single gap IS the boundary, so estimating from it never splits). The floor uses the
  // MEDIAN font, not the first line's, so a large opening title can't inflate it and swallow
  // the body. Threshold ≈ 1.8 line-heights.
  const typical = sortedGaps.length >= 3 ? sortedGaps[Math.floor(sortedGaps.length * 0.35)] : medFont * 1.3;
  const threshold = Math.max(typical * 1.8, medFont * 1.6);
  const regions = [{ lines: [lines[0]] }];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].y - lines[i - 1].y > threshold) regions.push({ lines: [lines[i]] });
    else regions[regions.length - 1].lines.push(lines[i]);
  }
  return regions;
}

// Cluster run left-edges across a region's lines into ordered column bands. Runs whose x
// starts within `tol` of a band's leftmost member share a column (bounds the band width to
// tol, so distant columns never chain-merge). LIMITATION: a right-aligned numeric column whose
// left edges vary by more than tol (different digit counts) can over-split into phantom
// columns; right-edge-based column detection is a later increment (see module header).
export function detectColumns(region, tol = 12) {
  const xs = [];
  for (const l of region.lines) for (const r of l.runs) xs.push(r.x);
  xs.sort((a, b) => a - b);
  const clusters = [];
  for (const x of xs) {
    const last = clusters[clusters.length - 1];
    if (last && x - last.min <= tol) { last.count++; last.min = Math.min(last.min, x); }
    else clusters.push({ min: x, count: 1 });
  }
  return clusters.map((c) => ({ x: c.min, count: c.count }));
}

// Classify a region: table (≥2 aligned columns), prose (multi-line single column),
// heading (a lone emphasized line), or block (a lone plain line). Confidence reflects how
// cleanly the region fits its type — it drives the per-region geometry fallback later.
export function classifyRegion(region, rules = []) {
  const columns = detectColumns(region);
  const nLines = region.lines.length;
  const fs = region.lines[0].runs[0]?.fontSize || 10;

  // A lone line, decided BEFORE the grid test: a bold line is a heading (so a title the
  // extractor split into runs isn't turned into a 1-row table), a plain multi-column line is
  // a table row (a line-item), otherwise a block.
  if (nLines === 1) {
    const bold = region.lines[0].runs.some((r) => r.bold);
    if (bold) return { type: 'heading', confidence: 0.9 };
    if (columns.length >= 2) return { type: 'table', confidence: 0.9, columns };
    return { type: 'block', confidence: 0.9 };
  }

  // Table = ≥2 columns populated across most rows. Drawn rules spanning the region corroborate
  // a real (possibly sparse, empty-celled) table, so the fill bar is relaxed when rule-bounded;
  // without rules the bar stays high so scattered prose runs aren't mistaken for columns.
  const colOf = (x) => { let idx = 0; for (let i = 0; i < columns.length; i++) if (x >= columns[i].x - 1) idx = i; return idx; };
  const pop = columns.map(() => new Set());
  region.lines.forEach((l, li) => { for (const r of l.runs) pop[colOf(r.x)].add(li); });
  const top = Math.min(...region.lines.map((l) => l.y));
  const bottom = Math.max(...region.lines.map((l) => l.y));
  const ruleBounded = rules.some((ru) => ru.y >= top - fs && ru.y <= bottom + fs);
  const minFill = ruleBounded ? 0.3 : 0.6;
  const realIdx = columns.map((_, i) => i).filter((i) => pop[i].size / nLines >= minFill);
  if (realIdx.length >= 2) {
    const filled = realIdx.reduce((a, i) => a + pop[i].size, 0);
    return { type: 'table', confidence: filled / (realIdx.length * nLines), columns };
  }

  // Multi-line, not a grid: prose if the lines share ONE dominant left margin (tolerating a
  // single indented first line); two substantial left-margin clusters mean a spatial
  // multi-column block (address pair / right-aligned header) — score it below the fallback
  // threshold so it stays a faithful positioned-span island rather than jumbled prose.
  const lefts = region.lines.map((l) => l.runs[0].x).sort((a, b) => a - b);
  const groups = [];
  for (const x of lefts) {
    const g = groups[groups.length - 1];
    if (g && x - g.min <= fs * 1.5) g.count++;
    else groups.push({ min: x, count: 1 });
  }
  const biggest = Math.max(...groups.map((g) => g.count));
  const substantial = groups.filter((g) => g.count >= 2).length;
  const confidence = biggest >= nLines - 1 ? 0.9 : substantial >= 2 ? 0.3 : 0.6;
  return { type: 'prose', confidence };
}

// Kept local (duplicates import.mjs's escapePdfText) so this module stays standalone and
// pdf.js-free; consolidate into one shared escaper when it's wired into import.mjs.
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Reflow a prose region's runs (across all its lines, in reading order) into one flowing
// <p>. Consecutive runs of the same emphasis are merged and wrapped once (<b>/<i>), so the
// bold phrase the PDF split across a line break becomes a single span. Flowing text can't
// collide, which is exactly why this beats the positioned-span form for prose.
export function emitProse(region) {
  // Flatten runs in reading order, remembering line index. The separator before each run is
  // '' when it butts against the previous run on the SAME line (a mid-word split the extractor
  // introduced — "Rech"+"nung") and ' ' otherwise (a real word gap, or a line break). Runs of
  // the same emphasis are coalesced; the boundary separator sits outside the <b>/<i> tags.
  const flat = [];
  region.lines.forEach((l, li) => { for (const r of l.runs) flat.push({ r, li }); });
  let out = '';
  let cur = null;
  const flush = () => {
    if (!cur) return;
    let t = esc(cur.text);
    if (cur.bold) t = `<b>${t}</b>`;
    if (cur.italic) t = `<i>${t}</i>`;
    out += t;
    cur = null;
  };
  for (let i = 0; i < flat.length; i++) {
    const { r, li } = flat[i];
    const prev = flat[i - 1];
    let sep = '';
    if (prev) {
      const sameLine = prev.li === li;
      const gap = r.x - (prev.r.x + (prev.r.w || 0));
      sep = sameLine && gap <= (r.fontSize || 10) * 0.25 ? '' : ' ';
    }
    const bold = !!r.bold;
    const italic = !!r.italic;
    if (cur && cur.bold === bold && cur.italic === italic) {
      cur.text += sep + r.text;
    } else {
      flush();
      out += sep;
      cur = { bold, italic, text: r.text };
    }
  }
  flush();
  return `<p>${out}</p>`;
}

// Emit a region as a <table>: one <tr> per line, one <td> per detected column. Each run is
// placed in the last column whose left edge it clears. A column is right-aligned when its
// runs' RIGHT edges cluster tighter than their left edges (how the PDF right-aligns money),
// so the amounts stay under one another and reflow correctly when edited.
export function emitTable(region, columns) {
  const cols = columns && columns.length ? columns : detectColumns(region);
  const colOf = (x) => {
    let idx = 0;
    for (let i = 0; i < cols.length; i++) if (x >= cols[i].x - 1) idx = i;
    return idx;
  };
  const spread = (a) => (a.length ? Math.max(...a) - Math.min(...a) : 0);
  const per = cols.map(() => ({ lefts: [], rights: [] }));
  for (const l of region.lines) for (const r of l.runs) {
    const c = per[colOf(r.x)];
    c.lefts.push(r.x);
    c.rights.push(r.x + (r.w || 0));
  }
  const align = per.map((c) => (c.rights.length >= 2 && spread(c.rights) < spread(c.lefts) ? 'right' : 'left'));
  const rows = region.lines.map((l) => {
    const cells = cols.map(() => []);
    for (const r of l.runs) cells[colOf(r.x)].push(r);
    const tds = cells.map((runs, ci) => {
      const text = esc(runs.map((r) => r.text).join(' '));
      const style = align[ci] === 'right' ? ' style="text-align:right"' : '';
      return `<td${style}>${text}</td>`;
    });
    return `<tr>${tds.join('')}</tr>`;
  });
  return `<table>\n${rows.join('\n')}\n</table>`;
}

// Below this per-region confidence, keep the faithful positioned-span form for that region
// only (a geometry island) rather than risk a wrong semantic lift. The rest of the page is
// still editable prose/tables. This is the safety net for the no-on-path-verification path.
const FALLBACK_THRESHOLD = 0.5;

function emitHeading(region) {
  const fs = region.lines[0].runs[0]?.fontSize || 12;
  const level = fs >= 15 ? 1 : fs >= 11 ? 2 : 3;
  const text = esc(region.lines[0].runs.map((r) => r.text).join(' '));
  return `<h${level}>${text}</h${level}>`;
}

function emitBlock(region) {
  const text = esc(region.lines.flatMap((l) => l.runs).map((r) => r.text).join(' '));
  return `<p>${text}</p>`;
}

// A low-confidence region kept as a positioned-span island (relative to its own top), so the
// page as a whole is still an editable article with, at worst, one faithful geometry patch.
function emitGeometryFallback(region) {
  const runs = region.lines.flatMap((l) => l.runs);
  const top = Math.min(...runs.map((r) => r.y));
  const bottom = Math.max(...runs.map((r) => r.y + (r.fontSize || 10)));
  const spans = runs.map((r) => {
    const w = r.bold ? ';font-weight:700' : '';
    const it = r.italic ? ';font-style:italic' : '';
    // position:absolute is INLINE here on purpose: reconstructGeometryHtml ships no
    // .rwa-pdf-t stylesheet, so the island must self-position or it renders as run-on text.
    return `<span class="rwa-pdf-t" style="position:absolute;left:${r.x}px;top:${r.y - top}px;font-size:${r.fontSize || 10}px${w}${it}">${esc(r.text)}</span>`;
  });
  return `<div class="rwa-pdf-fallback" style="position:relative;height:${Math.max(0, bottom - top)}px">\n${spans.join('\n')}\n</div>`;
}

// Orchestrate: runs → lines → regions → classify → emit hybrid HTML. Returns the assembled
// body plus a mean confidence (and region count) so callers can gate / warn.
export function reconstructPage(page) {
  const lines = groupLines(page.runs || []);
  const regions = segmentRegions(lines);
  const rules = page.rules || [];
  const parts = [];
  let confSum = 0;
  for (const region of regions) {
    const c = classifyRegion(region, rules);
    let html;
    if (c.confidence < FALLBACK_THRESHOLD) html = emitGeometryFallback(region);
    else if (c.type === 'table') html = emitTable(region, c.columns);
    else if (c.type === 'heading') html = emitHeading(region);
    else if (c.type === 'prose') html = emitProse(region);
    else html = emitBlock(region);
    parts.push(html);
    confSum += c.confidence;
  }
  const confidence = regions.length ? confSum / regions.length : 1;
  return { html: parts.join('\n'), confidence, regions: regions.length };
}

function unesc(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function styleNum(style, prop) {
  // Anchor the property to a boundary (start / after ';' / whitespace) and regex-escape it, so
  // `styleNum(style,'top')` can't capture the value of a compound like `margin-top`.
  const p = prop.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  const m = new RegExp('(?:^|[;\\s])' + p + ':\\s*([\\d.-]+)px').exec(style);
  return m ? parseFloat(m[1]) : undefined;
}

// The emitted geometry span carries no width (it's a render-time quantity), so estimate it
// from text length × font size. Rough, but enough for column / right-edge clustering; when
// this module is wired directly into the importer, exact pdf.js widths replace the estimate.
function estimateWidth(text, fontSize) {
  return [...String(text)].length * fontSize * 0.5;
}

// Adapter: parse ONE emitted geometry page (`<div class="rwa-pdf-page" …>…</div>`) back into
// { width, height, runs, rules }. Lets the reconstruction run on the importer's HTML output
// with no change to the importer; the core takes structured input so it's testable directly.
export function parseGeometryPage(pageHtml) {
  const pm = /class="rwa-pdf-page"\s+style="width:([\d.]+)px;height:([\d.]+)px"/.exec(pageHtml);
  const width = pm ? parseFloat(pm[1]) : 0;
  const height = pm ? parseFloat(pm[2]) : 0;
  const runs = [];
  const spanRe = /<span class="rwa-pdf-t" style="([^"]*)">([\s\S]*?)<\/span>/g;
  let m;
  while ((m = spanRe.exec(pageHtml))) {
    const style = m[1];
    const text = unesc(m[2]);
    if (!text.trim()) continue; // drop empty/whitespace positioning spans (no phantom columns)
    const fontSize = styleNum(style, 'font-size') || 10;
    runs.push({
      x: styleNum(style, 'left') || 0,
      y: styleNum(style, 'top') || 0,
      fontSize,
      bold: /font-weight:\s*(?:700|bold)/.test(style),
      italic: /font-style:\s*italic/.test(style),
      w: estimateWidth(text, fontSize),
      text,
    });
  }
  const rules = [];
  const gRe = /<div class="rwa-pdf-g" style="([^"]*)">/g;
  while ((m = gRe.exec(pageHtml))) {
    const style = m[1];
    rules.push({
      x: styleNum(style, 'left') || 0,
      y: styleNum(style, 'top') || 0,
      w: styleNum(style, 'width') || 0,
      h: styleNum(style, 'height') || 0,
    });
  }
  return { width, height, runs, rules };
}

// Top level: take an emitted geometry article (`<article class="rwa-pdf">` with the page
// style + one or more `.rwa-pdf-page` divs) and return a clean, semantic, editable
// `<article>` — nested tables for grid regions, flowing prose elsewhere, geometry islands
// only where confidence was too low. Pages are split on their start marker (rule divs are
// self-closing one-liners, so no balanced-div parsing is needed) and reconstructed in order.
// If there are no pages, the input is returned unchanged (nothing to reconstruct).
export function reconstructGeometryHtml(articleHtml) {
  const marker = '<div class="rwa-pdf-page"';
  const starts = [];
  for (let i = articleHtml.indexOf(marker); i !== -1; i = articleHtml.indexOf(marker, i + 1)) starts.push(i);
  if (!starts.length) return articleHtml;
  const bodies = [];
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : articleHtml.length;
    bodies.push(reconstructPage(parseGeometryPage(articleHtml.slice(starts[i], end))).html);
  }
  return `<article>\n${bodies.join('\n<hr class="rwa-page-sep">\n')}\n</article>`;
}
