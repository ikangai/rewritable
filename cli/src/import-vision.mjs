import fs from 'node:fs/promises';
import path from 'node:path';

// PDF → HTML via OpenRouter chat completions.
//
// Why this exists: pdfjs's text extraction produces flat-paragraph output
// that loses tables, multi-column layouts, and any text whose font has a
// broken toUnicode CMap (e.g. "Ü" decoded as "UY"). Sending the raw PDF to
// a vision-capable model bypasses both — the model reads the rendered
// content and reconstructs semantic HTML.
//
// Trade-off: ~$0.01-$0.05 per page in API costs, network round-trip
// latency. Opt-in via `rwa import file.pdf --vision`.
//
// Wire format: OpenRouter's PDF input docs say content type is "file" with
// `file_data: "data:application/pdf;base64,..."`. For Anthropic models OR
// passes this through as a native PDF document block; for others (Gemini,
// GPT-4o), it's routed through OR's file-parser plugin (engine "native"
// uses the model's own multimodal capability).

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const SYSTEM_PROMPT = `You are converting a PDF document into clean, semantic HTML for embedding in a single-file rewritable document container.

Output requirements:
- A single <article> element containing all document content.
- Use semantic HTML: <h1>-<h6> for headings, <p> for paragraphs, <ul>/<ol>/<li> for lists, <table><thead><tbody><tr><td>/<th> for tables, <strong>/<em> for emphasis, <a href="..."> for links.
- Do NOT output <html>, <head>, <body>, <!doctype>, any preamble, or any explanation before or after the HTML.
- Do NOT wrap output in markdown code fences (no \`\`\`html).
- Preserve text content exactly — do not summarize, paraphrase, translate, or reword.
- Reconstruct multi-column layouts and tables faithfully. Table headers go in <thead>, body rows in <tbody>.
- Omit <img> entirely; this container is text-focused. If an image carries information, describe it briefly in a <p>.
- No <script>, <style>, class, or id attributes. Plain semantic HTML only.

Output ONLY the <article>...</article> element.`;

const USER_PROMPT = 'Convert this PDF document to a single <article> element of clean semantic HTML, following the rules in the system prompt.';

/**
 * @param {Buffer|Uint8Array} bytes  PDF content
 * @param {object} [opts]
 * @param {string} [opts.apiKey]     OpenRouter API key. If omitted, read from
 *                                   process.env.OPENROUTER_API_KEY, then ./.env
 * @param {string} [opts.model]      OpenRouter model id; default reuses
 *                                   the rwa container's default
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ html: string, warnings: string[] }>}
 */
export async function convertPdfViaVision(bytes, { apiKey, model, signal } = {}) {
  apiKey = apiKey || process.env.OPENROUTER_API_KEY || await readDotEnvKey('OPENROUTER_API_KEY');
  if (!apiKey) {
    const e = new Error('vision: OPENROUTER_API_KEY is required (set in env or ./.env)');
    e.exitCode = 2;
    throw e;
  }
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const dataUri = `data:application/pdf;base64,${buf.toString('base64')}`;

  const body = {
    model: model || 'google/gemini-3-flash-preview',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: USER_PROMPT },
          { type: 'file', file: { filename: 'document.pdf', file_data: dataUri } },
        ],
      },
    ],
    // Generous output budget — long PDFs can produce a lot of HTML.
    // OpenRouter will clamp to model's actual max if smaller.
    max_tokens: 16384,
    // Deterministic output — we want the same HTML for the same input.
    temperature: 0,
  };

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      // Recommended by OpenRouter for tracking, helps with rate-limit accounting.
      'HTTP-Referer': 'https://github.com/martintreiber/rewritable',
      'X-Title': 'rwa CLI',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const e = new Error(`vision: openrouter ${res.status}${text ? ': ' + text.slice(0, 500) : ''}`);
    e.exitCode = 2;
    throw e;
  }

  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    const e = new Error('vision: openrouter returned empty content');
    e.exitCode = 2;
    throw e;
  }

  const html = extractArticle(content);
  if (!html) {
    const e = new Error(
      `vision: model output did not contain an <article> element. Output preview:\n${content.slice(0, 300)}`
    );
    e.exitCode = 2;
    throw e;
  }

  const warnings = [];
  // Surface usage so the user sees what each import cost.
  const usage = json?.usage;
  if (usage) {
    const tokens = `${usage.prompt_tokens || 0} in / ${usage.completion_tokens || 0} out`;
    warnings.push(`vision: ${body.model} (${tokens} tokens)`);
  }
  return { html, warnings };
}

// Minimal .env reader for the OPENROUTER_API_KEY fallback path. Handles
// KEY=value with optional surrounding whitespace, optional matched quotes,
// optional `export` prefix. No interpolation, no multi-line values. Returns
// null if the file or key is missing.
async function readDotEnvKey(name) {
  let text;
  try {
    text = await fs.readFile(path.join(process.cwd(), '.env'), 'utf8');
  } catch (_) { return null; }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || m[1] !== name) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    return v || null;
  }
  return null;
}

// Extract the outermost <article>...</article>. Models often wrap output in
// ```html fences or add a "Here is the HTML:" preamble despite the system
// prompt; pull out only the article element to be robust to that.
function extractArticle(text) {
  // Find the first <article (allow attributes) and the LAST </article>.
  const start = text.search(/<article(?:\s[^>]*)?>/i);
  if (start < 0) return null;
  const end = text.lastIndexOf('</article>');
  if (end < 0 || end < start) return null;
  return text.slice(start, end + '</article>'.length).trim();
}
