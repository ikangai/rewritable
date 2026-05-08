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

const PROMPT_TEMPLATE = (skill, filePath) => `Use the ${skill} skill to extract the content of ${filePath} and convert it to a single <article>...</article> element of clean semantic HTML for embedding in a re-writeable document container.

Output requirements:
- Output ONLY the <article> element. No preamble, no markdown code fences, no commentary.
- Use semantic tags: <h1>-<h6> for headings, <p> for paragraphs, <ul>/<ol>/<li> for lists, <table>/<thead>/<tbody>/<tr>/<td>/<th> for tables, <strong>/<em> for emphasis, <a href="..."> for links.
- Preserve text content exactly. Do not summarize, paraphrase, or reword.
- Reconstruct multi-column layouts and tables faithfully.
- No <script>, <style>, class, or id attributes. No <img> tags (this container is text-focused; if an image carries information, describe it briefly in a <p>).
- Do not include <html>, <head>, <body>, or <!doctype>.

Print the final <article>...</article> as your last response. Nothing else.`;

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
