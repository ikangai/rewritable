import { spawn } from 'node:child_process';
import path from 'node:path';

// PDF / docx → HTML by spawning the `claude` CLI in print mode.
//
// Why: the user's machine has Anthropic's official `pdf` and `docx` skills
// installed under ~/.claude/skills/. Those skills have rich Python tooling
// (pypdf, pdfplumber, pandoc, mammoth, LibreOffice) that the rwa CLI itself
// can't reasonably bundle. Calling `claude -p` lets the agent invoke its
// skill, run the local Python sandbox, and hand back clean semantic HTML —
// strictly better fidelity than either the local pdfjs heuristic or the
// raw-vision OpenRouter path, on documents where the skills apply.
//
// Trust model: this spawns a Claude Code subprocess with
// `--permission-mode bypassPermissions`, which lets the agent run shell
// commands and write files without prompting. The user already trusts
// their input file (they're importing it). Document this in HELP.

const SKILL_FOR_EXT = { pdf: 'pdf', docx: 'docx' };

const PROMPT_TEMPLATE = (skill, filePath) => `Use the ${skill} skill to extract the content of ${filePath} and convert it to a single <article>...</article> element that VISUALLY MATCHES the original document as closely as possible when rendered in a browser.

The output will be embedded inside a re-writeable document container that has its own dark-theme CSS. Your <article> must include a leading scoped <style> block that defines its own visual appearance, so the container's theme does not bleed in.

Required structure:

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
- Padding/margins around sections that mirror the PDF's visual breathing room.
- Tables — borders, cell padding, header weight, alternating rows or shading where the PDF has them.
- Bold and italic where used, via <strong>/<em> (preferred) or font-weight/font-style in the scoped CSS.

Content requirements:
- Use semantic tags: <h1>-<h6>, <p>, <ul>/<ol>/<li>, <table>/<thead>/<tbody>/<tr>/<td>/<th>, <strong>/<em>, <a href="...">.
- Preserve text exactly. Do not summarize, paraphrase, or reword.
- Reconstruct multi-column layouts as the source has them: side-by-side blocks via CSS flex/grid in your scoped styles, or as table cells if that fits better.
- No <img> tags. No <script>. No external resources (no @import, no <link>, no Google Fonts URLs — only system or generic font families).
- No id attributes. Class names should be scoped under .doc to avoid collisions with the container.
- Do not include <html>, <head>, <body>, or <!doctype>.

Print ONLY the final <article>...</article> as your last response. No preamble, no markdown fences, no commentary.`;

/**
 * @param {string} filePath  Absolute path to the file to import
 * @param {string} ext       Extension without dot ("pdf" or "docx")
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.timeoutMs]  Wall-clock cap for the subprocess (default 5min)
 * @returns {Promise<{ html: string, warnings: string[] }>}
 */
export async function convertViaClaudeCli(filePath, ext, { signal, timeoutMs = 300_000 } = {}) {
  const skill = SKILL_FOR_EXT[ext];
  if (!skill) {
    const e = new Error(`--claude only supports .pdf and .docx (got .${ext})`);
    e.exitCode = 2;
    throw e;
  }

  const prompt = PROMPT_TEMPLATE(skill, filePath);
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

      const html = extractArticle(stdout);
      if (!html) {
        const preview = stdout.trim().slice(0, 400);
        const e = new Error(
          `claude: output did not contain an <article> element. Output preview:\n${preview}`
        );
        e.exitCode = 2;
        return reject(e);
      }

      resolve({
        html,
        warnings: [`claude: imported via \`claude -p\` (${skill} skill)`],
      });
    });
  });
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
