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
  // 3) Apply scheme allow-list to surviving URL-bearing attributes. Marked's
  //    output is double-quoted href/src only, but rwa clone feeds ARBITRARY web
  //    HTML here — single-quoted, unquoted, and other URL attributes (action/
  //    formaction/poster/xlink:href) are all common and must be checked too, or
  //    a `href='javascript:…'` survives into the file:// container as a live,
  //    clickable link. Match all three value forms (mirror of the on*= strip)
  //    and the full reachable URL-attr set. data:image/* stays allowed on src.
  let urlSkipped = 0;
  s = s.replace(
    /(\s)(xlink:href|formaction|href|src|action|poster)(\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/gi,
    (full, ws, name, eq, rawVal) => {
      const lname = name.toLowerCase();
      const attr = (lname === 'src' || lname === 'poster') ? 'src' : 'href';
      const quoted = rawVal[0] === '"' || rawVal[0] === "'";
      const val = quoted ? rawVal.slice(1, -1) : rawVal;
      if (_attrIsSafe(attr, val)) return full;
      urlSkipped++;
      return ws + name + eq + '"#"';
    }
  );
  if (urlSkipped) warnings.push('imported md: neutralised ' + urlSkipped + ' unsafe URL attribute(s)');
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
  const pages = [];
  let totalText = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const rendered = await renderPdfPage(page, pdfjs.Util, pdfjs.OPS);
    pages.push(rendered.html);
    totalText += rendered.textCount;
  }
  await doc.destroy().catch(() => {});

  if (totalText === 0) {
    const e = new Error('pdf: no extractable text — this looks like a scanned/image PDF; OCR is not supported');
    e.exitCode = 2;
    throw e;
  }
  return {
    html: `<article class="rwa-pdf">\n${PDF_PAGE_STYLE}\n<div class="rwa-pdf-doc">\n${pages.join('\n')}\n</div>\n</article>`,
    warnings: ['pdf: imported as a geometry-faithful reconstruction (positioned text + rules) — text stays editable but is absolutely positioned'],
  };
}

// ─────────────────────────────────────────────────────────────────────────
// PDF geometry-faithful reconstruction
//
// Instead of flattening pdf.js text items into prose paragraphs (which throws
// away every column, table, and alignment), reproduce the page: each text run
// becomes an absolutely-positioned <span> at its real device coordinates, and
// the page's vector rules/boxes become positioned <div>s. The result looks
// like the source PDF while keeping the text as real, editable, selectable DOM
// — so the rwa edit loop can still rewrite it (find/replace on the span text).
//
// Coordinate math mirrors pdf.js's own text-layer builder: multiply the page
// viewport transform by each item's text matrix, read font height from the
// resulting matrix, and place the box top at baseline − ascent. Graphics are
// recovered by walking the operator list with a CTM stack (save/restore/
// transform) and emitting the device-space bounding box of every painted
// fill/stroke path. PDFs of this family draw rules as thin filled rectangles,
// so bbox-only rendering is exact; curves degrade to their bounding box.
// ─────────────────────────────────────────────────────────────────────────

const PDF_PAGE_STYLE = `<style>
.rwa-pdf{max-width:none;margin:0;padding:0;background:#e9ecef;}
.rwa-pdf-doc{display:flex;flex-direction:column;align-items:center;gap:20px;padding:20px;overflow-x:auto;}
.rwa-pdf-page{position:relative;flex:none;background:#fff;box-shadow:0 1px 5px rgba(0,0,0,.18);overflow:hidden;}
.rwa-pdf-t{position:absolute;white-space:pre;line-height:1;color:#000;transform-origin:0 0;}
.rwa-pdf-g{position:absolute;}
@media print{.rwa-pdf{background:none}.rwa-pdf-doc{gap:0;padding:0;overflow:visible}.rwa-pdf-page{box-shadow:none}}
</style>`;

function escapePdfText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 2-decimal round as a compact numeric string (no unit).
function pdfNum(n) {
  return (Math.round(n * 100) / 100).toString();
}

// pdf.js 5.x passes path colors as a single CSS string in args[0] (e.g.
// ["#0000ff"]); older shapes pass [r,g,b] 0–255. Normalise to a validated CSS
// color — these strings land in an inline style, so reject anything unexpected.
function pdfColorToCss(a) {
  let c = null;
  if (Array.isArray(a)) {
    if (typeof a[0] === 'string') c = a[0];
    else if (a.length >= 3) c = `rgb(${a[0] | 0},${a[1] | 0},${a[2] | 0})`;
  } else if (typeof a === 'string') c = a;
  if (c && /^#[0-9a-fA-F]{3,8}$/.test(c)) return c.toLowerCase();
  if (c && /^rgb\(\d{1,3},\d{1,3},\d{1,3}\)$/.test(c)) return c;
  return '#000000';
}

function pdfIsWhitish(css) {
  const c = String(css).toLowerCase().replace(/\s+/g, '');
  return c === '#fff' || c === '#ffffff' || c === 'white' || c === 'rgb(255,255,255)';
}

// Recover weight/style + family. The sanitized fontName ("g_d0_f2") carries no
// weight; the embedded font's real PostScript name (via commonObjs, populated
// by getOperatorList) does — e.g. "Cambria-Bold". Guard for the rare miss.
function pdfFontMeta(page, fontName, style) {
  let name = '';
  try { const f = page.commonObjs.get(fontName); name = (f && f.name) || ''; } catch { name = ''; }
  const bold = /bold|black|heavy|semibold|demibold|extrabold/i.test(name);
  const italic = /italic|oblique/i.test(name);
  const fam = style && style.fontFamily;
  let family = "Georgia, 'Times New Roman', serif";
  if (fam === 'sans-serif') family = "Helvetica, Arial, sans-serif";
  else if (fam === 'monospace') family = "'Courier New', monospace";
  return { bold, italic, family };
}

// Walk the operator list and return device-space rectangles for every visible
// fill/stroke path. The CTM stack handles save/restore/transform; the path's
// local minMax (args[2]) is mapped through the CTM via its four corners.
function collectPdfGraphics(opList, baseTransform, Util, OPS) {
  const out = [];
  let ctm = baseTransform.slice();
  const stack = [];
  let fill = '#000000', stroke = '#000000', lineWidth = 1;
  const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const FILLY = new Set([OPS.fill, OPS.eoFill]);
  const STROKEY = new Set([OPS.stroke]);
  const BOTH = new Set([OPS.fillStroke, OPS.eoFillStroke]);
  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i], a = opList.argsArray[i];
    if (fn === OPS.save) stack.push(ctm.slice());
    else if (fn === OPS.restore) { if (stack.length) ctm = stack.pop(); }
    else if (fn === OPS.transform) ctm = Util.transform(ctm, a);
    else if (fn === OPS.setFillRGBColor) fill = pdfColorToCss(a);
    else if (fn === OPS.setStrokeRGBColor) stroke = pdfColorToCss(a);
    else if (fn === OPS.setLineWidth) lineWidth = (typeof a === 'number' ? a : Array.isArray(a) ? a[0] : 1) || 1;
    else if (fn === OPS.constructPath) {
      const paint = a[0];
      const isFill = FILLY.has(paint) || BOTH.has(paint);
      const isStroke = STROKEY.has(paint) || BOTH.has(paint);
      if (!isFill && !isStroke) continue; // endPath / clip → not painted
      const mm = a[2];
      if (!mm || mm.length < 4) continue;
      const px = [], py = [];
      for (const X of [mm[0], mm[2]]) for (const Y of [mm[1], mm[3]]) {
        const [dx, dy] = apply(ctm, X, Y); px.push(dx); py.push(dy);
      }
      const x0 = Math.min(...px), x1 = Math.max(...px);
      const y0 = Math.min(...py), y1 = Math.max(...py);
      const color = isFill ? fill : stroke;
      if (pdfIsWhitish(color)) continue; // invisible on the white page
      const w = x1 - x0, h = y1 - y0;
      if (w < 0.01 && h < 0.01) continue;
      // Keep hairlines visible: strokes get their device line width, fills 0.5px.
      const sc = Math.hypot(ctm[0], ctm[1]) || 1;
      const minThick = isStroke && !isFill ? Math.max(lineWidth * sc, 0.5) : 0.5;
      out.push({ x: x0, y: y0, w: Math.max(w, minThick), h: Math.max(h, minThick), color });
    }
  }
  return out;
}

// Place one pdf.js text item in device space (angle-aware top/left).
function placePdfItem(it, page, viewportTransform, styles, Util) {
  const tx = Util.transform(viewportTransform, it.transform);
  const fh = Math.hypot(tx[2], tx[3]);
  if (fh < 0.1) return null;
  const angle = Math.atan2(tx[1], tx[0]);
  const style = styles[it.fontName] || {};
  let ascentFrac = style.ascent;
  if (!ascentFrac && style.descent) ascentFrac = 1 + style.descent;
  if (!ascentFrac) ascentFrac = 0.8;
  const a = fh * ascentFrac;
  let left, top;
  if (Math.abs(angle) < 1e-3) { left = tx[4]; top = tx[5] - a; }
  else { left = tx[4] + a * Math.sin(angle); top = tx[5] - a * Math.cos(angle); }
  const meta = pdfFontMeta(page, it.fontName, style);
  return { str: it.str, left, right: left + (it.width || 0), top, fh, angle, ...meta };
}

// Reconstruct one page as a positioned layer. Returns { html, textCount }.
//
// Text items are grouped into "runs" — adjacent, same-style glyphs on one
// baseline — and each run is emitted as a single positioned <span> that flows
// naturally. We split a run only at a real column gap, a style change, or a new
// line. This is what fixes word spacing: positioning each item independently
// lets a wider substitute font (the embedded face isn't shipped) overflow its
// slot and collide with the next item, eating the space; a flowing run spaces
// words with the substitute font's own metrics while staying pinned at the
// run's true start x, so columns and table cells stay put.
async function renderPdfPage(page, Util, OPS) {
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const styles = tc.styles || {};
  // getOperatorList yields the graphics and populates commonObjs (fonts).
  const opList = await page.getOperatorList();
  const graphics = collectPdfGraphics(opList, vp.transform, Util, OPS);

  const parts = [];
  for (const g of graphics) {
    parts.push(`<div class="rwa-pdf-g" style="left:${pdfNum(g.x)}px;top:${pdfNum(g.y)}px;width:${pdfNum(g.w)}px;height:${pdfNum(g.h)}px;background:${g.color}"></div>`);
  }

  const placed = [];
  for (const it of tc.items) {
    if (!it.transform || !it.str) continue;
    const p = placePdfItem(it, page, vp.transform, styles, Util);
    if (p) placed.push(p);
  }
  // Reading order: top-to-bottom, then left-to-right.
  placed.sort((a, b) => a.top - b.top || a.left - b.left);

  const WORD_GAP = 2; // device px — below this, no inter-item space
  const runs = [];
  let cur = null;
  const sameStyle = (r, p) => r.bold === p.bold && r.italic === p.italic
    && r.family === p.family && Math.abs(r.fh - p.fh) < 0.5;
  for (const p of placed) {
    const colGap = Math.max(p.fh * 1.2, 12); // wider than a space, narrower than a column
    const mergeable = cur
      && Math.abs(p.angle) < 1e-3 && Math.abs(cur.angle) < 1e-3
      && Math.abs(p.top - cur.top) <= Math.max(cur.fh, p.fh) * 0.5
      && (p.left - cur.right) <= colGap
      && sameStyle(cur, p);
    if (mergeable) {
      const gap = p.left - cur.right;
      const lastChar = cur.text.slice(-1), firstChar = p.str.charAt(0);
      if (gap > WORD_GAP && !/\s/.test(lastChar) && !/\s/.test(firstChar)) cur.text += ' ';
      cur.text += p.str;
      cur.right = p.right;
    } else {
      if (cur) runs.push(cur);
      cur = { text: p.str, left: p.left, top: p.top, right: p.right, fh: p.fh, bold: p.bold, italic: p.italic, family: p.family, angle: p.angle };
    }
  }
  if (cur) runs.push(cur);

  let textCount = 0;
  for (const run of runs) {
    const text = run.text.replace(/\s+$/, '');
    if (text.trim() === '') continue;
    const css = [`left:${pdfNum(run.left)}px`, `top:${pdfNum(run.top)}px`, `font-size:${pdfNum(run.fh)}px`, `font-family:${run.family}`];
    if (run.bold) css.push('font-weight:700');
    if (run.italic) css.push('font-style:italic');
    if (Math.abs(run.angle) >= 1e-3) css.push(`transform:rotate(${(run.angle * 180 / Math.PI).toFixed(2)}deg)`);
    parts.push(`<span class="rwa-pdf-t" style="${css.join(';')}">${escapePdfText(text)}</span>`);
    textCount++;
  }

  const html = `<div class="rwa-pdf-page" style="width:${pdfNum(vp.width)}px;height:${pdfNum(vp.height)}px">\n${parts.join('\n')}\n</div>`;
  return { html, textCount };
}
