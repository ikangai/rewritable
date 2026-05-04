import { marked } from 'marked';
import Papa from 'papaparse';

export async function convert(ext, content) {
  switch (ext) {
    case 'md':
    case 'markdown':
      return convertMd(content);
    case 'html':
    case 'htm':
      return convertHtml(content);
    case 'csv':
      return convertCsv(content);
    case 'txt':
    case '':
      return convertTxt(content);
    default: {
      const e = new Error(`unsupported format: .${ext} (supported: .md, .markdown, .html, .htm, .csv, .txt)`);
      e.exitCode = 2;
      throw e;
    }
  }
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

function convertCsv(text) {
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
