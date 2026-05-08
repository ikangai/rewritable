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
  const html = marked.parse(md, { gfm: true, breaks: false });
  return { html: `<article>\n${html.trim()}\n</article>`, warnings: [] };
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
  const html = (result.value || '').trim();
  if (!html) {
    const e = new Error('docx: produced empty document — input may be corrupt or empty');
    e.exitCode = 2;
    throw e;
  }
  const warnings = (result.messages || []).map(m => `docx: ${m.message}`);
  return { html: `<article>\n${html}\n</article>`, warnings };
}

async function convertPdf(bytes) {
  // pdfjs explicitly rejects Node's Buffer (despite Buffer extending Uint8Array)
  // and wants a plain Uint8Array view.
  const src = bytes instanceof Uint8Array ? bytes : Buffer.from(bytes);
  const data = new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
  let doc;
  try {
    doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;
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

// Group pdf.js text items into paragraph-shaped lines using y-coordinate
// jumps. A small jump (within ~0.5× line height) keeps the same line; a large
// jump (>1.5× line height) starts a new paragraph (emitted as an empty-string
// separator). Returns an array of strings; '' marks a paragraph break.
function extractParagraphs(items) {
  if (!items || items.length === 0) return [];
  // Each item: { str, transform: [a,b,c,d,e,f] }. transform[5] is y.
  const rows = items.map(it => ({
    str: it.str,
    y: it.transform ? it.transform[5] : 0,
    x: it.transform ? it.transform[4] : 0,
    h: it.height || (it.transform ? Math.abs(it.transform[3]) : 0) || 12,
  }));
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
  // Render each line: sort parts left-to-right, join with single space.
  const out = [];
  let prevY = null, prevH = null;
  for (const line of lines) {
    line.parts.sort((a, b) => a.x - b.x);
    const text = line.parts.map(p => p.str).join(' ').replace(/\s+/g, ' ').trim();
    if (prevY != null) {
      const gap = Math.abs(prevY - line.y);
      if (gap > prevH * 1.5) out.push(''); // paragraph break
    }
    if (text) out.push(text);
    prevY = line.y;
    prevH = line.h;
  }
  return out;
}
