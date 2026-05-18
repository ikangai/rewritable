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
// R9-minimal v0.1.1: per-product-kind substitution sites. The seed hoists
// the lens-copy strings to const declarations (single source of truth across
// the textarea declaration, the legacy palette, and releaseAnchor's reset
// path) so a per-kind override lands everywhere. The PRODUCT HEADER region
// is a comment block at the top of the bootstrap that names the kind and
// flags substrate-vs-graph caveats for non-document kinds (workflow today,
// app/workspace later). Each region is anchored on its marker pair so a
// seed-side rename can't silently break substitution.
const LENS_PLACEHOLDER_RE = /const LENS_PLACEHOLDER = '[^']*';/;
const LEGACY_PAL_PLACEHOLDER_RE = /const LEGACY_PAL_PLACEHOLDER = '[^']*';/;
const PRODUCT_HEADER_RE = /\/\/ === PRODUCT HEADER ===[\s\S]*?\/\/ === END PRODUCT HEADER ===/;
// Audit R1: the active product kind selects which SYSTEM_PROMPTS entry the
// agent loop uses. Substituting just the kind name (not the full prompt body)
// keeps the registry visible in every emitted file — agents and humans alike
// can introspect what alternates exist.
const PRODUCT_KIND_RE = /const PRODUCT_KIND = '[^']*';/;
// Audit R3 scoped: boolean toggle for click-to-anchor inside the doc mount.
// `true` for prose-doc kinds; `false` for kinds where every block is
// anchorable and a stray click would lock the lens onto an item.
const LENS_CLICK_TO_ANCHOR_RE = /const LENS_CLICK_TO_ANCHOR = (?:true|false);/;

export function applySeedSubs(seed, { uuid, title, fileMeta, lensPlaceholder, palPlaceholder, productHeader, productKind, lensClickToAnchor }) {
  // All three required substitution sites must appear exactly once. A
  // regression in the seed (title removed, FILE renamed, etc.) would
  // otherwise silently no-op and ship a CLI emitting partially-substituted
  // containers. Optional per-kind subs are verified the same way but only
  // when a caller passes an override — keeps backwards compatibility with
  // existing newCmd / importCmd callers that don't set them.
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
  for (const { value, re, label } of [
    { value: lensPlaceholder,   re: LENS_PLACEHOLDER_RE,        label: 'LENS_PLACEHOLDER const' },
    { value: palPlaceholder,    re: LEGACY_PAL_PLACEHOLDER_RE,  label: 'LEGACY_PAL_PLACEHOLDER const' },
    { value: productHeader,     re: PRODUCT_HEADER_RE,          label: 'PRODUCT HEADER block' },
    { value: productKind,       re: PRODUCT_KIND_RE,            label: 'PRODUCT_KIND const' },
    { value: lensClickToAnchor, re: LENS_CLICK_TO_ANCHOR_RE,    label: 'LENS_CLICK_TO_ANCHOR const' },
  ]) {
    if (value == null) continue;
    const matches = seed.match(new RegExp(re.source, 'g')) || [];
    if (matches.length !== 1) {
      throw new Error(`seed must contain exactly one ${label}, found ${matches.length}`);
    }
  }
  let out = seed.replace(UUID_RE, `const DOC_UUID = '${uuid}';`);
  if (title != null) out = out.replace(TITLE_RE, `<title>${escapeHtml(title)}</title>`);
  if (fileMeta != null) out = out.replace(FILE_RE, (_m, prefix) => `${prefix}'${escapeJsString(fileMeta)}'`);
  // Function-form replacements so a `$` in the substitute value isn't
  // interpreted by String.replace as a backreference.
  if (lensPlaceholder != null) {
    out = out.replace(LENS_PLACEHOLDER_RE, () => `const LENS_PLACEHOLDER = '${escapeJsString(lensPlaceholder)}';`);
  }
  if (palPlaceholder != null) {
    out = out.replace(LEGACY_PAL_PLACEHOLDER_RE, () => `const LEGACY_PAL_PLACEHOLDER = '${escapeJsString(palPlaceholder)}';`);
  }
  if (productHeader != null) {
    out = out.replace(PRODUCT_HEADER_RE, () => productHeader);
  }
  if (productKind != null) {
    out = out.replace(PRODUCT_KIND_RE, () => `const PRODUCT_KIND = '${escapeJsString(productKind)}';`);
  }
  if (lensClickToAnchor != null) {
    // Boolean literal — coerce to a literal token, not a JSON string.
    out = out.replace(LENS_CLICK_TO_ANCHOR_RE, () => `const LENS_CLICK_TO_ANCHOR = ${lensClickToAnchor ? 'true' : 'false'};`);
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

const KIND_WORKFLOW_BODY = `<!-- rwa:frozen:begin wf-style -->
<style>
.wf-canvas{max-width:920px;margin:0 auto;padding:24px 24px 64px;}
.wf-canvas > header{display:flex;align-items:center;justify-content:space-between;gap:1em;margin:0 0 .5em;}
.wf-canvas > header h1{margin:0;flex:1;}
.wf-run{padding:8px 16px;background:var(--gray-900);color:#fff;border:none;border-radius:6px;cursor:pointer;font-family:var(--font-ui);font-size:14px;font-weight:500;transition:background .15s;}
.wf-run:hover{background:var(--gray-700);}
.wf-run:disabled{background:var(--gray-300);cursor:not-allowed;}
.wf-status{margin:.25em 0 1em;font-family:var(--font-mono);font-size:11px;color:var(--gray-500);min-height:1.4em;letter-spacing:.3px;}
.wf-empty{color:var(--gray-400);font-style:italic;margin:1.5em 0;}
.wf-nodes:has(.wf-node) .wf-empty{display:none;}
.wf-nodes{display:flex;flex-direction:column;gap:.5em;}
.wf-nodes > .wf-node + .wf-node{margin-top:0;}
.wf-node{border:1px solid var(--gray-200);border-radius:8px;padding:14px 16px;background:var(--gray-50);position:relative;}
.wf-node > h2{margin:0 0 .25em;font-size:1rem;font-weight:600;color:var(--gray-900);}
.wf-summary{margin:0;color:var(--gray-600);font-size:13px;line-height:1.45;}
.wf-node[data-running="true"]{border-color:var(--blue);background:#fff;}
.wf-node[data-status="ok"]::after{content:"\\2713";position:absolute;top:14px;right:16px;color:var(--green);font-family:var(--font-mono);font-size:14px;}
.wf-node[data-status="err"]::after{content:"\\2717";position:absolute;top:14px;right:16px;color:var(--red);font-family:var(--font-mono);font-size:14px;}
@media print{.wf-empty,.wf-run,.wf-status,.wf-node::after{display:none;}}
</style>
<!-- rwa:frozen:end wf-style -->
<article class="wf-canvas">
<header>
<h1>Untitled workflow</h1>
<!-- rwa:frozen:begin wf-run -->
<button class="wf-run" type="button">▶ Run</button>
<!-- rwa:frozen:end wf-run -->
</header>
<!-- rwa:frozen:begin wf-status -->
<p class="wf-status"></p>
<!-- rwa:frozen:end wf-status -->
<section class="wf-nodes">
<p class="wf-empty">No nodes yet. Type a step into the lens below — “fetch the last 5 issues from this repo”, “summarize each in two sentences” — and the agent will scaffold a node.</p>
</section>
</article>
<!-- rwa:frozen:begin wf-runtime -->
<script>
(function(){
  'use strict';
  // Workflow runtime (frozen). Walks <script type="text/workflow-node"> blocks
  // in DOM order; each script body is treated as the body of an async function
  // that receives \`input\` (the previous node's return value, null for the
  // first) and returns its result. Stops on first error. Status surfaces in
  // <p class="wf-status">. State that must survive renderDoc lives on
  // window.__wf (per docs/specs/rwa-artifact-conventions.md §6).
  var NS = (window.__wf = window.__wf || { running: false, lastResult: null });
  function setStatus(s) { var el = document.querySelector('.wf-status'); if (el) el.textContent = s || ''; }
  function clearNodeStatus() {
    document.querySelectorAll('.wf-node').forEach(function(n){
      delete n.dataset.running;
      delete n.dataset.status;
    });
  }
  async function runWorkflow() {
    if (NS.running) return;
    NS.running = true;
    var btn = document.querySelector('.wf-run');
    if (btn) btn.disabled = true;
    clearNodeStatus();
    setStatus('● running…');
    try {
      var scripts = Array.from(document.querySelectorAll('script[type="text/workflow-node"]'));
      if (!scripts.length) { setStatus('no nodes to run'); return; }
      var input = null;
      for (var i = 0; i < scripts.length; i++) {
        var sc = scripts[i];
        var nodeId = sc.dataset.nodeId || ('n' + (i+1));
        var nodeEl = document.querySelector('.wf-node[data-node-id="' + nodeId + '"]');
        if (nodeEl) nodeEl.dataset.running = 'true';
        setStatus('● node ' + (i+1) + '/' + scripts.length + ' — ' + nodeId);
        try {
          // Two acceptable shapes for the script body, in preference order:
          // (1) Statement list — what the SYSTEM_PROMPT asks for: "return …".
          // (2) Function expression — what some models emit anyway:
          //     "async function(input) { … }" or "(input) => { … }".
          // Try (1) first via IIFE-wrap; on SyntaxError, try (2) by treating
          // the body as a callable expression and invoking it with input.
          var body = sc.textContent;
          var fn;
          try {
            fn = new Function('input', '"use strict"; return (async () => { ' + body + '\\n })();');
          } catch (eSyn) {
            if (!(eSyn instanceof SyntaxError)) throw eSyn;
            fn = new Function('input', '"use strict"; return Promise.resolve((' + body + ')(input));');
          }
          input = await fn(input);
          if (nodeEl) { delete nodeEl.dataset.running; nodeEl.dataset.status = 'ok'; }
        } catch (e) {
          if (nodeEl) { delete nodeEl.dataset.running; nodeEl.dataset.status = 'err'; }
          throw new Error('node ' + nodeId + ': ' + (e && e.message || e));
        }
      }
      NS.lastResult = input;
      setStatus('✓ done (' + scripts.length + ' node' + (scripts.length===1?'':'s') + ')');
    } catch (e) {
      setStatus('✗ ' + e.message);
      console.error(e);
    } finally {
      NS.running = false;
      if (btn) btn.disabled = false;
    }
  }
  // Re-bind on every render — the previous button is gone after innerHTML swap.
  var btn = document.querySelector('.wf-run');
  if (btn) btn.addEventListener('click', runWorkflow);
})();
</script>
<!-- rwa:frozen:end wf-runtime -->`;
const KIND_WORKFLOW_LENS = 'Describe a step, or describe an edit to an existing node.';
const KIND_WORKFLOW_PAL  = 'modify this workflow...';

// PRODUCT HEADER for the workflow kind. Names the v1 shape (canvas + node
// cards + inline JS) and the deliberate v1 omissions so anyone reading the
// file cold sees both what's here and what isn't.
const KIND_WORKFLOW_HEADER = `// === PRODUCT HEADER ===
// Product: workflow (substrate-layer scaffold, v1).
//
// The file renders as a vertical sequence of node cards inside
// <section class="wf-nodes">. Each <article class="wf-node"> carries a
// title, a one-sentence summary, and an inline
// <script type="text/workflow-node"> whose body is the JS that runs when
// the Run button fires the workflow. The runtime walks nodes in DOM order;
// output of each node feeds the next as \`input\`. The wf-runtime <script>
// at the bottom is frozen; the agent edits the node cards via the lens.
//
// v1 deliberately ships WITHOUT: credential vault (write \`// TODO\`
// placeholders and ask the user), skill library / cross-workflow reuse
// (each workflow ships its own node JS), trigger model (manual Run only),
// Worker isolation (nodes run in the document context). The trust anchor
// is workflow review at creation — the user sees each generated node's JS
// before accepting. Where these v1 omissions are designed for later, see
// docs/specs/re-write-able-actions-spec-v0.7.md and its lineage; the v1
// shape lets us learn from real workflows before committing to that
// surface. See docs/specs/rwa-product-types.md.
// === END PRODUCT HEADER ===`;

const KIND_TABLE = {
  document: {
    body: null,                // pass through seed default
    lensPlaceholder: null,     // pass through seed default
    palPlaceholder: null,      // pass through seed default
    productHeader: null,       // pass through seed default
    lensClickToAnchor: null,   // pass through seed default (true)
  },
  workflow: {
    body: KIND_WORKFLOW_BODY,
    lensPlaceholder: KIND_WORKFLOW_LENS,
    palPlaceholder: KIND_WORKFLOW_PAL,
    productHeader: KIND_WORKFLOW_HEADER,
    lensClickToAnchor: false,  // audit R3 scoped — workflow stages are <li>-anchorable
  },
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

function escapeJsString(s) {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
