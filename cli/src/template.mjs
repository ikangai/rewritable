// `rwa new <kind>` template discovery + label strip
// (docs/plans/2026-05-05-cli-templates-design.md).
//
// A user labels one rwa file per kind with data-rwa-template="<kind>" on the
// first element of its body (#rwa-doc-mount's first child). `rwa new <kind>`
// scans cwd, finds the labeled file, and clones it — pristine seed + the
// template's INLINE_DOC, fresh UUID, label stripped. No registry, no shipped
// starters: the file you made yesterday is the template for the file you make
// tomorrow. CLI-only for v1; cross-folder discovery is deferred.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { extractInlineDoc, KNOWN_KINDS } from './seed.mjs';

const HTML_RE = /\.html?$/i;
// The first opening tag inside the body (the template's root element).
const FIRST_TAG_RE = /<[a-zA-Z][^>]*>/;
const LABEL_ATTR_RE = /\s*\bdata-rwa-template=["'][^"']*["']/;

// The data-rwa-template value on the body's first element, or null.
function templateLabelOf(body) {
  const tag = (body || '').match(FIRST_TAG_RE);
  if (!tag) return null;
  const m = tag[0].match(/\bdata-rwa-template=["']([^"']*)["']/);
  return m ? m[1] : null;
}

/**
 * Strip data-rwa-template="…" from the body's first opening tag (the cloned
 * container is an instance, not the template). No-op when absent; only the first
 * element is touched, so a later mention in prose survives.
 * @param {string} body — the INLINE_DOC body
 * @returns {string}
 */
export function stripTemplateAttribute(body) {
  const tag = (body || '').match(FIRST_TAG_RE);
  if (!tag) return body;
  const stripped = tag[0].replace(LABEL_ATTR_RE, '');
  return body.slice(0, tag.index) + stripped + body.slice(tag.index + tag[0].length);
}

/**
 * Find the rwa container in `dir` labeled `data-rwa-template="<name>"`. Scans
 * (non-recursive) `*.html`; cheap-pre-checks for the bootstrap id before parsing;
 * skips malformed candidates; most-recent mtime wins when several match.
 *
 * @param {string} dir — directory to scan (typically cwd)
 * @param {string} name — the template kind
 * @returns {Promise<{path:string, inlineDoc:string, ambiguous:boolean}|null>}
 * @throws {Error} exitCode 2 when the directory holds more than 200 .html files
 */
export async function findTemplate(dir, name) {
  let entries;
  try { entries = await readdir(dir); } catch { return null; }
  const htmls = entries.filter(n => HTML_RE.test(n));
  if (htmls.length > 200) {
    const e = new Error(`too many .html files in ${dir} (>200) to scan for a "${name}" template`);
    e.exitCode = 2;
    throw e;
  }
  const matches = [];
  for (const n of htmls) {
    const p = join(dir, n);
    let text;
    try { text = await readFile(p, 'utf8'); } catch { continue; }
    if (!text.includes('id="rwa-bootstrap"')) continue;   // cheap: not an rwa file
    let body;
    try { body = extractInlineDoc(text); } catch { continue; } // malformed → skip, keep scanning
    if (templateLabelOf(body) !== name) continue;
    let mtime = 0;
    try { mtime = (await stat(p)).mtimeMs; } catch { /* keep 0 */ }
    matches.push({ path: p, inlineDoc: body, mtime });
  }
  if (!matches.length) return null;
  matches.sort((a, b) => b.mtime - a.mtime); // most-recent first
  return { path: matches[0].path, inlineDoc: matches[0].inlineDoc, ambiguous: matches.length > 1 };
}

/**
 * Resolve a bare word to a creation frame, template-first then built-in kind
 * (design 2026-05-31 §3.2). This is THE single resolver shared by `rwa new <word>`
 * and `rwa create <word> …` so the two surfaces never diverge.
 *
 *   1. a cwd file labeled data-rwa-template="<word>" → clone it
 *      → { source:'template', kind:'document', body:<stripped>, templatePath, ambiguous }
 *   2. else <word> ∈ KNOWN_KINDS → emit that built-in kind
 *      → { source:'kind', kind:<word>, body:null }  (body comes from kindOverrides)
 *   3. else → null  (caller decides: error, or Stage-2 inference)
 *
 * @param {string} word — the bare leading token
 * @param {string} cwd — directory to scan for a labeled template
 * @returns {Promise<{source:string, kind:string, body:string|null, templatePath?:string, ambiguous?:boolean}|null>}
 */
export async function resolveBareWord(word, cwd) {
  const tmpl = await findTemplate(cwd, word);
  if (tmpl) {
    return {
      source: 'template',
      kind: 'document',
      body: stripTemplateAttribute(tmpl.inlineDoc),
      templatePath: tmpl.path,
      ambiguous: tmpl.ambiguous,
    };
  }
  if (KNOWN_KINDS.includes(word)) {
    return { source: 'kind', kind: word, body: null };
  }
  return null;
}
