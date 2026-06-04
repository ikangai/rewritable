import { marked } from 'marked';
import Papa from 'papaparse';
import mammoth from 'mammoth';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

// `convert` takes raw bytes (Buffer / Uint8Array). Text formats decode utf8
// internally; binary formats consume bytes directly. Switching to bytes was
// driven by docx/pdf — keeping a single signature avoids a fork.
export async function convert(ext, bytes) {
  switch (ext) {
    case 'md':
    case 'markdown':
      return convertMd(toText(bytes));
    case 'html':
    case 'htm':
      return convertHtml(toText(bytes));
    case 'csv':
      return convertCsv(toText(bytes));
    case 'txt':
    case '':
      return convertTxt(toText(bytes));
    case 'docx':
      return convertDocx(bytes);
    case 'pdf':
      return convertPdf(bytes);
    default: {
      const e = new Error(`unsupported format: .${ext} (supported: .md, .markdown, .html, .htm, .csv, .txt, .docx, .pdf)`);
      e.exitCode = 2;
      throw e;
    }
  }
}

function toText(bytes) {
  if (typeof bytes === 'string') return bytes;
  if (Buffer.isBuffer(bytes)) return bytes.toString('utf8');
  return Buffer.from(bytes).toString('utf8');
}

function convertMd(md) {
  const raw = marked.parse(md, { gfm: true, breaks: false });
  const { html, warnings } = sanitizeImportedHtml(raw);
  return { html: `<article>\n${html.trim()}\n</article>`, warnings };
}

function convertHtml(input) {
  const warnings = [];

  // Strip HTML comments first. Without this, a comment like <!-- </head> -->
  // would terminate the non-greedy head match prematurely and let head content
  // leak into the body. Comments are dropped — acceptable for an offline import
  // CLI; full preservation would require a real parser.
  let body = input.replace(/<!--[\s\S]*?-->/g, '');
  body = body.replace(/<!DOCTYPE[^>]*>/gi, '').replace(/<\/?html[^>]*>/gi, '');

  const headMatch = body.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  let headStyles = '';
  if (headMatch) {
    const styles = headMatch[1].match(/<style[^>]*>[\s\S]*?<\/style>/gi);
    if (styles) headStyles = styles.join('\n') + '\n';
    body = body.replace(/<head[^>]*>[\s\S]*?<\/head>/i, '');
  }

  const bodyMatch = body.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) body = bodyMatch[1];

  body = body.trim();

  if (/<script[\s>]/i.test(body)) {
    warnings.push('imported HTML contained <script> tags; they will execute when the document loads');
  }

  return { html: headStyles + body, warnings };
}

function looksLikeCsv(text) {
  const probe = Papa.parse(text, { preview: 2, skipEmptyLines: true, header: false });
  if (probe.errors.length > 0) return false;
  if (probe.data.length === 0) return false;
  const cols = probe.data[0].length;
  if (cols < 2) return false;
  if (probe.data.length === 2 && probe.data[1].length !== cols) return false;
  return true;
}

function convertCsv(text) {
  if (!looksLikeCsv(text)) {
    const e = new Error('csv probe failed: input does not look like CSV (need ≥2 columns with consistent column count)');
    e.exitCode = 2;
    throw e;
  }
  // skipEmptyLines drops trailing blank rows that csv exporters often emit.
  // header:false because we own the first-row-as-thead split and want raw rows.
  const result = Papa.parse(text, { skipEmptyLines: true, header: false });
  const warnings = result.errors.map(e => {
    const where = e.row != null ? ` (row ${e.row + 1})` : '';
    return `csv parse: ${e.message}${where}`;
  });
  const rows = result.data;
  if (rows.length === 0) {
    return { html: '<article>\n</article>', warnings };
  }
  const escape = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const [header, ...body] = rows;
  const thead = `<thead>\n<tr>${header.map(c => `<th>${escape(c)}</th>`).join('')}</tr>\n</thead>`;
  const tbody = body.length === 0
    ? ''
    : `\n<tbody>\n${body.map(row => `<tr>${row.map(c => `<td>${escape(c)}</td>`).join('')}</tr>`).join('\n')}\n</tbody>`;
  return { html: `<article>\n<table>\n${thead}${tbody}\n</table>\n</article>`, warnings };
}

function convertTxt(text) {
  const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const blocks = text
    .split(/\n\s*\n/)
    .map(b => b.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .map(b => `<p>${escape(b)}</p>`);
  return { html: `<article>\n${blocks.join('\n')}\n</article>`, warnings: [] };
}

async function convertDocx(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  let result;
  try {
    result = await mammoth.convertToHtml({ buffer });
  } catch (err) {
    const e = new Error(`docx: ${err && err.message ? err.message : String(err)}`);
    e.exitCode = 2;
    throw e;
  }
  const raw = (result.value || '').trim();
  if (!raw) {
    const e = new Error('docx: produced empty document — input may be corrupt or empty');
    e.exitCode = 2;
    throw e;
  }
  const { html, skipped } = sanitizeMammothUrls(raw);
  const warnings = [
    ...skipped.map(s => `docx: ${s}`),
    ...(result.messages || []).map(m => `docx: ${m.message}`),
  ];
  return { html: `<article>\n${html}\n</article>`, warnings };
}

// Mammoth doesn't filter URL schemes — a docx with a `javascript:` hyperlink
// would land in the imported document and execute on click (stored XSS in the
// downloaded rwa container). Strip unsafe schemes from href/src and replace
// with `#`. Mammoth's HTML writer always uses double-quoted attributes and
// escapes &, ", <, > inside values, so a regex match against `attr="..."` is
// sufficient — no quote-escape ambiguity to worry about.
const _SAFE_HREF_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);
// Two layers, both required:
//   1) Strip invisibles before parsing — whitespace + C0/C1 controls (\x00-\x1f,
//      \x7f-\xa0) + soft hyphen (\xad) + Cf-class format chars (ZWSP/ZWNJ/ZWJ,
//      LRM/RLM, LRE/RLE/PDF/LRO/RLO, word joiner, BOM, etc.). The previous
//      regex used JS \s which doesn't match these — they slipped through and
//      let a docx with `​javascript:…` href bypass the scheme check.
//   2) Parse via WHATWG URL — the same parser the browser uses to navigate.
//      Resolve against a synthetic base so scheme-less inputs (relative URL,
//      fragment, path) round-trip back to that base and pass.
const _ATTR_STRIP_RE = /[\s\x00-\x1f\x7f-\xa0\xad؜᠎​-‏‪-‮⁠-⁯﻿]/g;
const _SANITIZER_BASE = 'http://_rwa_sanitizer_base_/';
function _attrIsSafe(attr, val) {
  const normalized = String(val).replace(_ATTR_STRIP_RE, '');
  let parsed;
  try { parsed = new URL(normalized, _SANITIZER_BASE); }
  catch { return true; } // unparseable → cannot be an active URL scheme
  if (parsed.origin === 'http://_rwa_sanitizer_base_') return true; // resolved relative — no scheme
  const proto = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (_SAFE_HREF_SCHEMES.has(proto)) return true;
  // Mammoth embeds raster images as data:image/...;base64,... — allow on src.
  // data:image/svg+xml passes here too, but <img src> renders SVG in image-
  // loading mode with no script execution (HTML spec), so the narrow
  // 'data:image/*' allowance is still safe for src. Keep scoped to src only.
  if (attr === 'src' && proto === 'data' && /^data:image\//i.test(parsed.href)) return true;
  return false;
}
function sanitizeMammothUrls(html) {
  const skipped = [];
  const stripAttr = (attr) => (full, val) => {
    if (_attrIsSafe(attr, val)) return full;
    const m = val.match(/^\s*([a-z][a-z0-9+.\-]*):/i);
    const scheme = m ? m[1].toLowerCase() : 'unknown';
    skipped.push(`stripped unsafe ${attr} (scheme: ${scheme}:)`);
    return `${attr}="#"`;
  };
  return {
    html: html
      .replace(/href="([^"]*)"/g, stripAttr('href'))
      .replace(/src="([^"]*)"/g, stripAttr('src')),
    skipped,
  };
}

// marked v14 explicitly does NOT sanitize HTML — its README points readers at
// DOMPurify. The seed bootstrap injects INLINE_DOC via m.innerHTML AND
// re-creates <script> tags so they execute (intended for documents that ship
// JS), so any active content in the imported HTML runs on container open. An
// imported .md must not be able to add active content.
//
// Regex-based strip (not a parser) for mirror-symmetry with the browser. The
// rules below are deliberately conservative: when in doubt, strip. Marked's
// output is well-formed and uses double-quoted attributes, so the regex shape
// matches reliably. Edge cases (CDATA, malformed nesting) are over-stripped
// rather than under-stripped — acceptable for an import path.
const _ACTIVE_TAGS = ['script', 'iframe', 'object', 'embed', 'svg', 'math', 'link', 'meta', 'base'];
export function sanitizeImportedHtml(html) {
  const warnings = [];
  let s = String(html);
  // 1) Drop active-content tags (open+close blocks, then self-closing/unmatched).
  for (const tag of _ACTIVE_TAGS) {
    const block = new RegExp('<' + tag + '\\b[^>]*>[\\s\\S]*?<\\/' + tag + '\\s*>', 'gi');
    const solo  = new RegExp('<\\/?' + tag + '\\b[^>]*\\/?>', 'gi');
    if (block.test(s) || solo.test(s)) warnings.push('imported md: stripped <' + tag + '> elements');
    s = s.replace(block, '').replace(solo, '');
  }
  // 2) Drop on*= event-handler attributes from surviving elements.
  //    Match quoted (double/single) and unquoted-to-whitespace/> forms.
  let onCount = 0;
  s = s.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, () => { onCount++; return ''; });
  if (onCount) warnings.push('imported md: stripped ' + onCount + ' event-handler attribute(s)');
  // 3) Apply scheme allow-list to surviving href/src (reuses _attrIsSafe).
  let hrefSkipped = 0, srcSkipped = 0;
  s = s.replace(/(\shref\s*=\s*)"([^"]*)"/gi, (full, prefix, val) => {
    if (_attrIsSafe('href', val)) return full;
    hrefSkipped++;
    return prefix + '"#"';
  });
  s = s.replace(/(\ssrc\s*=\s*)"([^"]*)"/gi, (full, prefix, val) => {
    if (_attrIsSafe('src', val)) return full;
    srcSkipped++;
    return prefix + '"#"';
  });
  if (hrefSkipped) warnings.push('imported md: neutralised ' + hrefSkipped + ' unsafe href(s)');
  if (srcSkipped) warnings.push('imported md: neutralised ' + srcSkipped + ' unsafe src(s)');
  return { html: s, warnings };
}

async function convertPdf(bytes) {
  // pdfjs explicitly rejects Node's Buffer (despite Buffer extending Uint8Array)
  // and wants a plain Uint8Array view.
  const src = bytes instanceof Uint8Array ? bytes : Buffer.from(bytes);
  const data = new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
  let doc;
  try {
    doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  } catch (err) {
    const name = err && err.name;
    if (name === 'PasswordException') {
      const e = new Error('pdf: file is password-protected');
      e.exitCode = 2;
      throw e;
    }
    const e = new Error(`pdf: ${err && err.message ? err.message : String(err)}`);
    e.exitCode = 2;
    throw e;
  }
  const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const paragraphs = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    extractParagraphs(tc.items).forEach(line => paragraphs.push(line));
    paragraphs.push(null); // page break: forces flush of next paragraph
  }
  await doc.destroy().catch(() => {});

  const blocks = [];
  let buf = [];
  const flush = () => {
    const joined = buf.join(' ').replace(/\s+/g, ' ').trim();
    if (joined) blocks.push(`<p>${escape(joined)}</p>`);
    buf = [];
  };
  for (const line of paragraphs) {
    if (line === null || line === '') { flush(); continue; }
    buf.push(line);
  }
  flush();

  if (blocks.length === 0) {
    const e = new Error('pdf: no extractable text — this looks like a scanned/image PDF; OCR is not supported');
    e.exitCode = 2;
    throw e;
  }
  return {
    html: `<article>\n${blocks.join('\n')}\n</article>`,
    warnings: ['pdf: layout reconstructed by heuristics — review headings/lists manually'],
  };
}

// Group pdf.js text items into paragraph-shaped lines.
//
// Two non-obvious problems this handles:
// (1) Adjacent items inside a word: pdf.js returns text per font run, so a
//     word like "Aufwände" comes out as ["Aufw", "ä", "nde"] when the umlaut
//     glyph lives in a different font table from the ASCII letters. Joining
//     with ' ' produces "Aufw ä nde" — wrong. We concat directly and only
//     synthesize a space when there's a real positional x-gap.
// (2) Stacked short lines: an address block (Name / Street / City) has small
//     y-gaps that fit inside the within-paragraph threshold, so naive logic
//     would join them into one paragraph "Name Street City". We additionally
//     break paragraphs when the *previous* line ended significantly short of
//     the page's typical right margin (a heuristic for "hard line break").
//
// Returns an array of strings; '' marks a paragraph break.
function extractParagraphs(items) {
  if (!items || items.length === 0) return [];
  const rows = items.map(it => ({
    str: it.str,
    y: it.transform ? it.transform[5] : 0,
    x: it.transform ? it.transform[4] : 0,
    w: it.width || 0,
    h: it.height || (it.transform ? Math.abs(it.transform[3]) : 0) || 12,
  }));
  // Sort top-to-bottom (y desc in PDF coords), then left-to-right within a
  // row. pdfjs's content-stream order is reading order for well-tagged
  // single-column PDFs, but for multi-column or absolutely-positioned layouts
  // it interleaves visually-separate lines; sorting first makes the same-y
  // grouping below tolerant of that.
  rows.sort((a, b) => b.y - a.y || a.x - b.x);
  // Group into visual lines by y (within half a line height).
  const lines = [];
  let cur = null;
  for (const r of rows) {
    if (cur && Math.abs(r.y - cur.y) <= cur.h * 0.5) {
      cur.parts.push(r);
      cur.y = (cur.y + r.y) / 2;
    } else {
      if (cur) lines.push(cur);
      cur = { y: r.y, h: r.h, parts: [r] };
    }
  }
  if (cur) lines.push(cur);

  // For each line: concat parts directly, inserting a synthetic space only
  // when there's a real positional gap (previous part's right edge to next
  // part's x). pdf.js often emits explicit space items (str=" ") with tiny
  // width — those carry the space character themselves, so the position-gap
  // check below typically sees ~0 distance when they're present and we don't
  // double-space.
  const rendered = lines.map(line => {
    line.parts.sort((a, b) => a.x - b.x);
    let text = '';
    let prev = null;
    for (const p of line.parts) {
      if (prev) {
        const gap = p.x - (prev.x + prev.w);
        const lastChar = text.slice(-1);
        const firstChar = p.str.charAt(0);
        // Threshold of 2 user-space units catches inter-word gaps on body
        // text without false-positives inside words. Skip if the boundary
        // already has whitespace from either side.
        if (gap > 2 && !/\s/.test(lastChar) && !/\s/.test(firstChar)) {
          text += ' ';
        }
      }
      text += p.str;
      prev = p;
    }
    const left = line.parts.length ? Math.min(...line.parts.map(p => p.x)) : 0;
    const right = line.parts.length
      ? Math.max(...line.parts.map(p => p.x + p.w))
      : 0;
    return { text: text.replace(/\s+/g, ' ').trim(), y: line.y, h: line.h, left, right };
  });

  // The page's "typical right margin" — use the 90th-percentile right edge
  // (more robust than max, which a stray header/page-number could inflate).
  // Lines ending well short of this are likely hard line-breaks, not soft
  // wraps to the right margin.
  const sortedRights = rendered.filter(l => l.text).map(l => l.right).sort((a, b) => a - b);
  const margin = sortedRights.length
    ? sortedRights[Math.floor(sortedRights.length * 0.9)]
    : 0;

  const out = [];
  let prev = null;
  for (const line of rendered) {
    if (!line.text) continue;  // pdfjs sometimes emits whitespace-only EOL stubs; ignore.
    if (prev != null) {
      const yGap = Math.abs(prev.y - line.y);
      const yJump = yGap > prev.h * 1.5;
      // Previous line ended significantly short of the page's right margin —
      // that's the signature of a hard line-break (address line, table cell,
      // bullet, sender block). Threshold of 1.5× line height (~1-2 chars)
      // ignores end-of-line whitespace + small justification slop while still
      // catching genuinely short lines. Soft wraps to the right margin are
      // within ~few units and don't trigger.
      const prevShortOfMargin = margin > 0 && (margin - prev.right) > prev.h * 1.5;
      // Right-aligned blocks have a fixed right edge but varying left edge
      // per line. A jump of more than a line-height in left position is a
      // structural change, not text-flow continuation.
      const leftJump = Math.abs(prev.left - line.left) > line.h;
      if (yJump || prevShortOfMargin || leftJump) out.push('');
    }
    out.push(line.text);
    prev = line;
  }
  return out;
}
