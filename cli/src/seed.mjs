import fs from 'node:fs/promises';

export async function loadSeed(candidates) {
  for (const p of candidates) {
    try {
      return await fs.readFile(p, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  throw new Error(`seed not found in any of: ${candidates.join(', ')}`);
}

const UUID_RE = /const DOC_UUID = '[0-9a-f-]{36}';/;
const TITLE_RE = /<title>[^<]*<\/title>/;
const FILE_RE = /(FILE\s*:\s*)'[^']*'/;
// R9-minimal: per-product-kind lens placeholder override. Matches the
// rwa-lens-input <textarea> opening tag's placeholder attribute, anchoring
// on the stable id+rows prefix so a copy change to the default text doesn't
// silently break substitution. Mirrors the existing pattern (regex match on
// a known seed substring; no template marker in the seed).
const LENS_PLACEHOLDER_RE = /(id="rwa-lens-input"\s+rows="\d+"\s+)placeholder="[^"]*"/;

export function applySeedSubs(seed, { uuid, title, fileMeta, lensPlaceholder }) {
  // All three required substitution sites must appear exactly once. A
  // regression in the seed (title removed, FILE renamed, etc.) would
  // otherwise silently no-op and ship a CLI emitting partially-substituted
  // containers. Lens placeholder is verified the same way but only when a
  // caller passed an override — keeps backwards compatibility with existing
  // newCmd / importCmd callers that don't set it.
  for (const { re, label } of [
    { re: UUID_RE, label: 'DOC_UUID' },
    { re: TITLE_RE, label: '<title>' },
    { re: FILE_RE, label: 'FILE:' },
  ]) {
    const matches = seed.match(new RegExp(re.source, 'g')) || [];
    if (matches.length !== 1) {
      throw new Error(`seed must contain exactly one ${label} line, found ${matches.length}`);
    }
  }
  if (lensPlaceholder != null) {
    const matches = seed.match(new RegExp(LENS_PLACEHOLDER_RE.source, 'g')) || [];
    if (matches.length !== 1) {
      throw new Error(`seed must contain exactly one lens-placeholder line, found ${matches.length}`);
    }
  }
  let out = seed.replace(UUID_RE, `const DOC_UUID = '${uuid}';`);
  if (title != null) out = out.replace(TITLE_RE, `<title>${escapeHtml(title)}</title>`);
  if (fileMeta != null) out = out.replace(FILE_RE, (_m, prefix) => `${prefix}'${escapeJsString(fileMeta)}'`);
  if (lensPlaceholder != null) {
    out = out.replace(LENS_PLACEHOLDER_RE, (_m, prefix) => `${prefix}placeholder="${escapeHtmlAttr(lensPlaceholder)}"`);
  }
  return out;
}

// R9-minimal: per-product-kind starter scaffolds. Each entry supplies the
// INLINE_DOC body and the lens placeholder text. The substrate is unchanged;
// kinds are CLI-side substitutions at emit time.
//
// Scope discipline (the cheapest viable scaffold):
//   - INLINE_DOC body: a recognizable first-paint shape that names the
//     primary stance. No JS, no interactive UI — just structure.
//   - Lens placeholder: one line of plain-English copy framed for the kind.
//   - Title bar / FILE / DOC_UUID: untouched; come from basename and crypto
//     as before.
//
// SYSTEM_PROMPT is intentionally NOT varied here — that's audit R1's job
// (parameterize the prompt registry); R9-minimal stops at the substitution
// layer so R1 has a second concrete prompt to parameterize over.
const KIND_DOCUMENT_LENS = 'Write, or describe what you want.';

const KIND_WORKFLOW_BODY = `<style>
.wf-stage{margin:1.5em 0;padding-top:1em;border-top:1px solid var(--gray-200);}
.wf-stage h2{margin:0 0 .5em;font-size:1.1rem;font-weight:600;color:var(--gray-700);}
.wf-stage ul{margin:0;padding-left:1.25em;}
.wf-empty{color:var(--gray-400);font-style:italic;}
@media print{.wf-empty{display:none;}}
</style>
<article>
<h1>Untitled workflow</h1>
<p class="wf-empty">A workflow over items. Add to <em>Inbox</em>, then describe stage moves to the lens.</p>
<section class="wf-stage">
<h2>Inbox</h2>
<ul></ul>
</section>
<section class="wf-stage">
<h2>In progress</h2>
<ul></ul>
</section>
<section class="wf-stage">
<h2>Done</h2>
<ul></ul>
</section>
</article>`;
const KIND_WORKFLOW_LENS = 'Add an item, or describe a stage move.';

const KIND_TABLE = {
  document: { body: null,                lensPlaceholder: null /* keep seed default */ },
  workflow: { body: KIND_WORKFLOW_BODY,  lensPlaceholder: KIND_WORKFLOW_LENS },
  // app, workspace: reserved — wire when the templates land. The CLI rejects
  // unknown kinds explicitly rather than silently emitting a document.
};

export const KNOWN_KINDS = Object.keys(KIND_TABLE);

export function kindOverrides(kind) {
  if (!KIND_TABLE[kind]) {
    throw new Error(`unknown kind "${kind}". Known kinds: ${KNOWN_KINDS.join(', ')}`);
  }
  return KIND_TABLE[kind];
}

// Mirrors the bootstrap's escapeTL — keep in sync with seeds/rewritable.html.
// LF-canonicalizes first; rwa-edit/1 invariant is that on-disk docs are LF-only.
const canonLF = s => s == null ? '' : String(s).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
const escapeTL = s => canonLF(s)
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$\{/g, '\\${')
  .replace(/<\/script/gi, '<\\/script');

const INLINE_DOC_MARKER = 'const INLINE_DOC = `';

export function replaceInlineDoc(seed, newDoc) {
  const start = seed.indexOf(INLINE_DOC_MARKER);
  if (start < 0) throw new Error('cannot locate INLINE_DOC marker in seed');
  const cs = start + INLINE_DOC_MARKER.length;
  let i = cs;
  while (i < seed.length) {
    if (seed[i] === '\\') { i += 2; continue; }
    if (seed[i] === '`') break;
    i++;
  }
  if (i >= seed.length) throw new Error('unterminated INLINE_DOC literal in seed');
  return seed.slice(0, cs) + escapeTL(newDoc) + seed.slice(i);
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Attribute-context escape: same as escapeHtml minus the `>` rewrite (already
// allowed inside attribute values per the HTML spec) plus `&` first. Used for
// the lens placeholder substitution since it lands inside a quoted attribute.
function escapeHtmlAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function escapeJsString(s) {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
