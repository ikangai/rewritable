import { marked } from 'marked';

export async function convert(ext, content) {
  switch (ext) {
    case 'md':
    case 'markdown':
      return convertMd(content);
    case 'html':
    case 'htm':
      return convertHtml(content);
    case 'txt':
    case '':
      return convertTxt(content);
    default: {
      const e = new Error(`unsupported format: .${ext} (supported: .md, .markdown, .html, .htm, .txt)`);
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

  let body = input.replace(/<!DOCTYPE[^>]*>/gi, '').replace(/<\/?html[^>]*>/gi, '');

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

function convertTxt(text) {
  const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const blocks = text
    .split(/\n\s*\n/)
    .map(b => b.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .map(b => `<p>${escape(b)}</p>`);
  return { html: `<article>\n${blocks.join('\n')}\n</article>`, warnings: [] };
}
