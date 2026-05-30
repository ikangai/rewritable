import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

// PDF / docx → HTML by spawning the `claude` CLI in print mode.
//
// PDFs are processed in PARALLEL: split into page ranges, each chunk
// handed to its own `claude -p` subprocess concurrently, then merged.
// Long papers go from sequential N×t to roughly t×ceil(chunks/concurrency).
//
// Why: the user's machine has Anthropic's official `pdf` and `docx` skills
// installed under ~/.claude/skills/. Those skills have rich Python tooling
// (pypdf, pdfplumber, pandoc, mammoth, LibreOffice) that the rwa CLI itself
// can't reasonably bundle. Calling `claude -p` lets the agent invoke its
// skill, run the local Python sandbox, and hand back clean semantic HTML —
// strictly better fidelity than either the local pdfjs heuristic or the
// raw-vision OpenRouter path, on documents where the skills apply.
//
// Trust model: this spawns a Claude Code subprocess that reads the input file's
// CONTENTS into an agent context (the pdf/docx skill needs Python — pypdf,
// pdfplumber, mammoth — to extract them, so the agent genuinely needs tool
// access). That makes the file attacker-controlled input: prompt-injection text
// hidden in a third-party PDF/DOCX could hijack the agent. `import` is precisely
// the command you point at files you received from someone else, so "the user
// trusts their input file" is the WRONG threat model.
//
// Therefore `--claude` is gated behind an explicit `--trust-input` consent flag
// (convertViaClaudeCli throws below if it is absent). Only when the user vouches
// for the file do we add `--permission-mode bypassPermissions`. The default
// import path (pdfjs/mammoth — parses bytes, never executes the file's content)
// remains the safe, no-flag route. Documented in HELP.

const SKILL_FOR_EXT = { pdf: 'pdf', docx: 'docx' };

const DEFAULT_CHUNK_SIZE = 5;       // pages per chunk
const DEFAULT_CONCURRENCY = 4;      // simultaneous claude -p subprocesses
const DEFAULT_TIMEOUT_MS = 1_200_000; // 20 minutes per chunk

const PROMPT_TEMPLATE = (skill, filePath, pageRange) => {
  const rangeNote = pageRange
    ? `\n\nIMPORTANT: Process ONLY pages ${pageRange.start} to ${pageRange.end} (inclusive) of the document. Use the pdf skill's page-range support (pypdf/pdfplumber accept page indices) to extract just that slice. Do not output content from any other pages. The full document is ${pageRange.totalPages} pages; this chunk is pages ${pageRange.start}-${pageRange.end}.`
    : '';
  const styleNote = pageRange && pageRange.start > 1
    ? `\n\nIMPORTANT (chunk ${pageRange.start}-${pageRange.end}): omit the leading <style> and @page rules. Output ONLY the inner content of the .doc wrapper for these pages — start your output with the actual content elements (e.g., <h2>, <p>, <table>...) and end with the last content element. Do NOT include <article>, <style>, <div class="doc">, or </article>, </div>. Just the content of pages ${pageRange.start}-${pageRange.end}, ready to splice into a larger document. The first chunk handled the styling; later chunks contribute content only.`
    : '';

  return `Use the ${skill} skill to extract the content of ${filePath} and convert it to a single <article>...</article> element that VISUALLY MATCHES the original document as closely as possible when rendered in a browser.${rangeNote}${styleNote}

The output will be embedded inside a re-writeable document container that has its own dark-theme CSS. Your <article> must include a leading scoped <style> block that defines its own visual appearance, so the container's theme does not bleed in.

Required structure (full-document or first-chunk only — see chunk note above):

<article style="all: revert;">
  <style>
    /* Scope every rule to .doc to avoid leaking into the container.
       Use 'all: revert' or explicit resets to neutralize the container's theme. */
    .doc { background: ...; color: ...; font-family: ...; padding: ...; max-width: ...; margin: 0 auto; }
    .doc h1, .doc h2, .doc p, .doc table, .doc th, .doc td { ... }
    /* etc. */
  </style>
  <div class="doc">
    ... actual content ...
  </div>
</article>

Style requirements (match the source PDF):
- Background color (usually white #ffffff for printed documents).
- Text color (usually black #000000 or near-black).
- Font family — pick a generic match: invoices and letters use sans-serif (Helvetica, Arial, system-ui); academic/literary uses serif (Georgia, Times New Roman); monospaced text uses monospace.
- Font sizes — match the visual hierarchy (titles bigger, body smaller, footnotes smallest).
- Text alignment — left, right, center, or justify, matching each block in the source.
- Right-aligned blocks (sender addresses, dates) MUST remain right-aligned via CSS.
- Padding/margins around sections that mirror the PDF's vertical density. Crucially, do NOT inflate vertical spacing — if the source fits on N pages, your output should fit on N pages when printed at the source paper size. Prefer tight margins (~0.5em-1em between blocks) over generous ones; a single-page invoice should remain a single-page invoice.
- Tables — borders, cell padding, header weight, alternating rows or shading where the PDF has them.
- Bold and italic where used, via <strong>/<em> (preferred) or font-weight/font-style in the scoped CSS.

Print-fit requirements (REQUIRED for documents that match a paper size):
- Include an @media print rule inside the scoped <style> block that:
  * Removes any max-width constraint (so the doc fills the page width).
  * Sets margin:0 / padding:0 on .doc so the printer's @page margin (default 0.5in) is the only outer margin.
  * Optionally tightens block spacing further if the source page density is dense.
  * Uses page-break-inside:avoid on tables, headers, and footer blocks so they don't split awkwardly across pages.
- Add an @page rule with size matching the source (default A4 if uncertain): @page { size: A4; margin: 0.5in; }

Content requirements:
- Use semantic tags: <h1>-<h6>, <p>, <ul>/<ol>/<li>, <table>/<thead>/<tbody>/<tr>/<td>/<th>, <strong>/<em>, <a href="...">.
- Preserve text exactly. Do not summarize, paraphrase, or reword.
- Reconstruct multi-column layouts as the source has them: side-by-side blocks via CSS flex/grid in your scoped styles, or as table cells if that fits better.
- No <img> tags. No <script>. No external resources (no @import, no <link>, no Google Fonts URLs — only system or generic font families).
- No id attributes. Class names should be scoped under .doc to avoid collisions with the container.
- Do not include <html>, <head>, <body>, or <!doctype>.

Print ONLY the final HTML as your last response. No preamble, no markdown fences, no commentary.`;
};

/**
 * @param {string} filePath  Absolute path to the file to import
 * @param {string} ext       Extension without dot ("pdf" or "docx")
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.timeoutMs]    Wall-clock cap PER CHUNK (default 20min)
 * @param {number} [opts.chunkSize]    Pages per chunk for PDFs (default 5)
 * @param {number} [opts.concurrency]  Max simultaneous subprocesses (default 4)
 * @returns {Promise<{ html: string, warnings: string[] }>}
 */
export async function convertViaClaudeCli(filePath, ext, opts = {}) {
  const skill = SKILL_FOR_EXT[ext];
  if (!skill) {
    const e = new Error(`--claude only supports .pdf and .docx (got .${ext})`);
    e.exitCode = 2;
    throw e;
  }

  // Consent gate (SECURITY). Refuse to point an autonomous agent at the file
  // unless the user explicitly vouched for it. Must run BEFORE any file read or
  // subprocess spawn, so an unconsented file is never touched by the agent.
  if (!opts.trustInput) {
    const e = new Error(
      `refusing to run an autonomous agent on ${filePath} without consent.\n` +
      `  --claude extraction reads the file's contents into a Claude Code agent, so a\n` +
      `  malicious file could hijack it (prompt-injection -> code execution).\n` +
      `  Re-run with --claude --trust-input only if you trust this file's source.\n` +
      `  (The default import, without --claude, parses the file safely and never executes its contents.)`
    );
    e.exitCode = 2;
    throw e;
  }

  // docx isn't naturally page-chunkable (no fixed page boundaries inside the
  // XML). Single call.
  if (ext !== 'pdf') {
    const stdout = await runClaude(filePath, PROMPT_TEMPLATE(skill, filePath, null), opts);
    const html = extractArticle(stdout);
    if (!html) {
      const preview = stdout.trim().slice(0, 400);
      const e = new Error(
        `claude: output did not contain an <article> element. Output preview:\n${preview}`
      );
      e.exitCode = 2;
      throw e;
    }
    return {
      html,
      warnings: [`claude: imported via \`claude -p\` (${skill} skill)`],
    };
  }

  const totalPages = await getPdfPageCount(filePath);
  const chunkSize = opts.chunkSize || DEFAULT_CHUNK_SIZE;
  const concurrency = opts.concurrency || DEFAULT_CONCURRENCY;

  const ranges = [];
  for (let start = 1; start <= totalPages; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, totalPages);
    ranges.push({ start, end, totalPages });
  }

  console.error(
    `note: claude: ${totalPages}-page PDF → ${ranges.length} chunk${ranges.length === 1 ? '' : 's'} of ≤${chunkSize} pages, ${Math.min(concurrency, ranges.length)} parallel`
  );

  const htmlChunks = await runWithConcurrency(ranges, concurrency, async (range, idx) => {
    console.error(`note: claude: chunk ${idx + 1}/${ranges.length} (pages ${range.start}-${range.end}) starting…`);
    const prompt = PROMPT_TEMPLATE(skill, filePath, range);
    const html = await runClaude(filePath, prompt, opts);
    console.error(`note: claude: chunk ${idx + 1}/${ranges.length} done`);
    return html;
  });

  const merged = mergeChunks(htmlChunks);
  return {
    html: merged,
    warnings: [
      `claude: imported ${ranges.length} chunk${ranges.length === 1 ? '' : 's'} via parallel \`claude -p\` (${skill} skill)`,
    ],
  };
}

// Run a single `claude -p` invocation. Returns the extracted HTML for the
// chunk (either a full <article> or content-only fragment depending on the
// prompt's chunk hint).
function runClaude(filePath, prompt, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const args = [
    '-p',
    '--output-format', 'text',
    '--add-dir', path.dirname(filePath),
    '--permission-mode', 'bypassPermissions',
    prompt,
  ];

  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
    } catch (err) {
      const e = new Error(`claude: failed to spawn (${err && err.message ? err.message : String(err)}). Is the claude CLI installed?`);
      e.exitCode = 2;
      return reject(e);
    }

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', d => { stderr += d.toString('utf8'); });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      const e = new Error(`claude: timed out after ${Math.round(timeoutMs / 1000)}s`);
      e.exitCode = 2;
      reject(e);
    }, timeoutMs);

    proc.on('error', err => {
      clearTimeout(timer);
      const e = new Error(`claude: spawn error (${err.code || err.message})`);
      e.exitCode = 2;
      reject(e);
    });

    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        const tail = stderr.trim().split('\n').slice(-5).join('\n').slice(0, 800);
        const e = new Error(`claude -p exited ${code}${tail ? '\n' + tail : ''}`);
        e.exitCode = 2;
        return reject(e);
      }
      // Output may be a full <article>...</article> (first chunk / single call)
      // or just inner content (later chunks). Hand the full stdout to the
      // merger; it knows how to extract either shape.
      resolve(stdout);
    });
  });
}

// Bounded-concurrency parallel runner. Items are processed in input order
// up to `concurrency` at a time. Order of `results[]` matches input order,
// regardless of completion order.
async function runWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let nextIdx = 0;
  const worker = async () => {
    while (true) {
      const myIdx = nextIdx++;
      if (myIdx >= items.length) break;
      results[myIdx] = await fn(items[myIdx], myIdx);
    }
  };
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

async function getPdfPageCount(filePath) {
  const buf = await readFile(filePath);
  const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let doc;
  try {
    doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  } catch (err) {
    const e = new Error(`claude: failed to read PDF page count (${err && err.message ? err.message : String(err)})`);
    e.exitCode = 2;
    throw e;
  }
  const count = doc.numPages;
  await doc.destroy().catch(() => {});
  return count;
}

// Merge per-chunk HTML output into a single <article>. The first chunk's
// output is treated as a full <article> with leading <style>/@page; later
// chunks are content-only fragments (per their prompt). We:
// 1. Extract the first chunk's full <article ...>...<style>...</style>...<div class="doc"> shell
// 2. Append each later chunk's content fragments inside that .doc
// 3. Close with </div></article>
//
// If a later chunk DID emit a full <article>+<style> (the model ignored the
// chunk hint), strip its <article>/<style>/<div class="doc"> wrappers and
// keep only its inner content.
function mergeChunks(stdouts) {
  if (stdouts.length === 1) {
    const html = extractArticle(stdouts[0]);
    if (!html) {
      const preview = stdouts[0].trim().slice(0, 400);
      const e = new Error(
        `claude: output did not contain an <article> element. Output preview:\n${preview}`
      );
      e.exitCode = 2;
      throw e;
    }
    return html;
  }

  const first = extractArticle(stdouts[0]);
  if (!first) {
    const preview = stdouts[0].trim().slice(0, 400);
    const e = new Error(
      `claude: first chunk output did not contain an <article> element. Output preview:\n${preview}`
    );
    e.exitCode = 2;
    throw e;
  }

  // Find the .doc wrapper closing in the first chunk, so we can splice
  // additional content before it. Prefer </div></article>; fall back to just
  // </article> if no .doc wrapper exists.
  const closingDocArticle = /<\/div>\s*<\/article>\s*$/i;
  const closingArticleOnly = /<\/article>\s*$/i;
  let prefix, suffix;
  if (closingDocArticle.test(first)) {
    prefix = first.replace(closingDocArticle, '');
    suffix = '</div></article>';
  } else if (closingArticleOnly.test(first)) {
    prefix = first.replace(closingArticleOnly, '');
    suffix = '</article>';
  } else {
    // Shouldn't happen — extractArticle guarantees </article>. Defensive.
    prefix = first;
    suffix = '';
  }

  const additional = stdouts.slice(1).map(stripChunkWrappers).filter(Boolean);
  return [prefix, ...additional.map(c => '\n' + c), suffix].join('');
}

// Pull content out of a chunk's stdout. If the chunk emitted a full
// <article>+<style>+<div class="doc">...</div></article> (because the model
// ignored the "content-only" hint), strip those wrappers and the <style>.
// Otherwise return the cleaned stdout (already content-only).
function stripChunkWrappers(stdout) {
  let body = stdout.trim();

  // If wrapped in <article>...</article>, take only the inside.
  const articleMatch = body.match(/<article(?:\s[^>]*)?>([\s\S]*)<\/article>/i);
  if (articleMatch) body = articleMatch[1];

  // Strip any <style>...</style> (we keep only the first chunk's styles).
  body = body.replace(/<style(?:\s[^>]*)?>[\s\S]*?<\/style>/gi, '');

  // Strip <div class="doc">...</div> wrapper if present.
  const docMatch = body.match(/<div[^>]*class\s*=\s*["']doc["'][^>]*>([\s\S]*)<\/div>/i);
  if (docMatch) body = docMatch[1];

  // Strip stray markdown fences (some models add them despite the prompt).
  body = body.replace(/^```(?:html)?\s*/i, '').replace(/\s*```\s*$/i, '');

  return body.trim();
}

// Extract the outermost <article>...</article>. The agent's stdout might
// include thinking commentary, tool-use traces, or markdown fences in
// addition to the HTML; pull out only the article element.
function extractArticle(text) {
  const start = text.search(/<article(?:\s[^>]*)?>/i);
  if (start < 0) return null;
  const end = text.lastIndexOf('</article>');
  if (end < 0 || end < start) return null;
  return text.slice(start, end + '</article>'.length).trim();
}
