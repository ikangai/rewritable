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

// v0.2 workflow stub. Implements the UX design at
// docs/plans/2026-05-18-workflow-ux-design.md. Semantic <ol> / <li>
// structure, collapsible <details> code, per-step <output> slots, an
// async function run(ctx, prev) step contract, and a frozen runner.
// Replaces v1's wf-canvas / wf-node / <script type="text/workflow-node">
// shape wholesale.
const KIND_WORKFLOW_BODY = `<!-- rwa:frozen:begin wf-style -->
<style>
.rwa-workflow{max-width:920px;margin:0 auto;padding:24px 24px 64px;}
.rwa-workflow > header{margin-bottom:1.5em;}
.rwa-workflow > header h1{margin:0 0 .25em;}
.rwa-workflow > header > p{margin:0;color:var(--gray-600);font-size:14px;line-height:1.5;}
.rwa-workflow .placeholder{color:var(--gray-400);font-style:italic;margin:1.5em 0;line-height:1.5;}
.rwa-flow{list-style:none;padding:0;margin:1em 0;display:flex;flex-direction:column;gap:.5em;}
.rwa-step{border:1px solid var(--gray-200);border-radius:8px;padding:14px 16px;background:var(--gray-50);position:relative;transition:border-color .15s,background .15s;}
.rwa-step > header{margin:0;}
.rwa-step > header h3{margin:0 0 .25em;font-size:1rem;font-weight:600;color:var(--gray-900);}
.rwa-step > header p{margin:0;color:var(--gray-600);font-size:13px;line-height:1.45;}
.rwa-step details{margin:.5em 0 0;}
.rwa-step summary{cursor:pointer;font-family:var(--font-mono);font-size:11px;color:var(--gray-500);padding:2px 0;list-style:none;display:inline-block;user-select:none;}
.rwa-step summary::before{content:"▸ ";display:inline-block;width:1em;}
.rwa-step details[open] > summary::before{content:"▾ ";}
.rwa-step summary::-webkit-details-marker{display:none;}
.rwa-step summary:hover{color:var(--gray-700);}
.rwa-step details > script{display:block;white-space:pre-wrap;padding:.5em .75em;margin:.25em 0 0;background:#fff;border:1px solid var(--gray-200);border-radius:4px;font-family:var(--font-mono);font-size:12px;line-height:1.5;color:var(--gray-800);overflow-x:auto;}
.rwa-step-output{display:block;margin-top:.5em;padding:.5em .75em;background:#fff;border:1px solid var(--gray-200);border-radius:4px;font-family:var(--font-mono);font-size:11px;line-height:1.4;color:var(--gray-800);white-space:pre-wrap;overflow-x:auto;max-height:200px;overflow-y:auto;}
.rwa-step-output:empty{display:none;}
.rwa-step.running{border-color:var(--blue);background:#fff;}
.rwa-step.done{border-color:var(--green);}
.rwa-step.done::after{content:"✓";position:absolute;top:14px;right:16px;color:var(--green);font-family:var(--font-mono);font-size:14px;}
.rwa-step.failed{border-color:var(--red);}
.rwa-step.failed::after{content:"✗";position:absolute;top:14px;right:16px;color:var(--red);font-family:var(--font-mono);font-size:14px;}
.rwa-step.failed .rwa-step-output{color:var(--red);}
.rwa-step.dragging{opacity:.4;}
.rwa-step.drop-target{border-color:var(--blue);background:#eef6ff;}
.rwa-step-delete{position:absolute;top:8px;right:8px;width:24px;height:24px;border:none;background:transparent;color:var(--gray-300);cursor:pointer;font-size:18px;line-height:1;border-radius:4px;padding:0;opacity:0;transition:color .15s,background .15s,opacity .15s;}
.rwa-step:hover .rwa-step-delete{opacity:1;color:var(--gray-500);}
.rwa-step-delete:hover{background:var(--gray-200);color:var(--red);}
.rwa-step.running .rwa-step-delete,.rwa-step.done .rwa-step-delete,.rwa-step.failed .rwa-step-delete{display:none;}
.rwa-step-insert{display:block;margin:0 auto;padding:2px 14px;background:transparent;color:var(--gray-300);border:1px dashed var(--gray-200);border-radius:4px;cursor:pointer;font-size:14px;line-height:1.2;font-weight:400;font-family:var(--font-mono);opacity:0;transition:color .15s,border-color .15s,background .15s,opacity .15s;}
.rwa-flow:hover .rwa-step-insert,.rwa-step-insert:focus{opacity:1;}
.rwa-step-insert:hover{color:var(--gray-700);border-color:var(--gray-400);background:var(--gray-50);}
.rwa-workflow-footer{margin-top:1.5em;display:flex;align-items:center;gap:1em;}
.rwa-run{padding:8px 16px;background:var(--gray-900);color:#fff;border:none;border-radius:6px;cursor:pointer;font-family:var(--font-ui);font-size:14px;font-weight:500;transition:background .15s;}
.rwa-run:hover{background:var(--gray-700);}
.rwa-run:disabled{background:var(--gray-300);cursor:not-allowed;}
.rwa-run-status{font-family:var(--font-mono);font-size:11px;color:var(--gray-500);min-height:1.4em;letter-spacing:.3px;}
.rwa-step.pinned{border-left:3px solid var(--blue);padding-left:13px;}
.rwa-step.stale{border-left:3px solid var(--yellow);padding-left:13px;}
.rwa-step.pinned.stale{border-left:3px solid var(--blue);}
.rwa-step.rwa-foreach{border-left:3px dashed var(--gray-400);padding-left:13px;}
.rwa-step.rwa-foreach > ol.rwa-flow{margin:.5em 0 0;padding-left:0;}
.rwa-iter-count{display:inline-block;margin-left:6px;padding:1px 6px;font-size:10px;font-weight:500;border-radius:3px;background:var(--gray-700);color:#fff;font-family:var(--font-mono);letter-spacing:.3px;}
.rwa-parallel{width:100%;border-collapse:separate;border-spacing:8px;margin:.5em 0;position:relative;}
.rwa-parallel.pinned > tbody{outline:2px solid var(--blue);outline-offset:6px;border-radius:6px;}
.rwa-parallel-caption{caption-side:top;text-align:left;padding:0 0 4px 0;}
.rwa-foreach.pinned{border-left-color:var(--blue);}
.rwa-parallel > tbody > tr > td.rwa-step{vertical-align:top;width:1%;min-width:200px;max-width:340px;}
.rwa-parallel > tbody > tr > td.rwa-step::before{content:attr(data-rwa-label);position:absolute;top:-10px;left:8px;padding:1px 6px;background:var(--gray-100);border:1px solid var(--gray-200);border-radius:3px;font-family:var(--font-mono);font-size:10px;font-weight:500;color:var(--gray-600);text-transform:uppercase;letter-spacing:.4px;}
@media (max-width:720px){.rwa-parallel,.rwa-parallel>tbody,.rwa-parallel>tbody>tr,.rwa-parallel>tbody>tr>td.rwa-step{display:block;width:auto;max-width:none;}.rwa-parallel>tbody>tr>td.rwa-step{margin:.5em 0;}}
.rwa-step-badge{display:inline-block;margin-left:6px;padding:1px 6px;font-size:10px;font-weight:500;border-radius:3px;letter-spacing:.3px;text-transform:uppercase;vertical-align:middle;font-family:var(--font-mono);}
.rwa-badge-pinned{background:var(--blue);color:#fff;}
.rwa-badge-stale{background:var(--yellow);color:#fff;}
.rwa-step-toolbar{position:absolute;top:6px;right:36px;display:flex;gap:2px;opacity:0;transition:opacity .15s;z-index:1;}
.rwa-step:hover .rwa-step-toolbar,.rwa-step:focus-within .rwa-step-toolbar{opacity:1;}
.rwa-step-toolbar button{width:22px;height:22px;border:1px solid var(--gray-200);background:#fff;border-radius:4px;cursor:pointer;font-size:11px;padding:0;line-height:1;color:var(--gray-600);display:inline-flex;align-items:center;justify-content:center;}
.rwa-step-toolbar button:hover:not([disabled]){background:var(--gray-50);color:var(--gray-900);}
.rwa-step-toolbar button[disabled]{opacity:.4;cursor:not-allowed;}
.rwa-step.pinned .rwa-pin-btn{color:var(--blue);border-color:var(--blue);}
.rwa-step.running .rwa-step-toolbar{display:none;}
@media print{.placeholder,.rwa-run,.rwa-run-status,.rwa-step-delete,.rwa-step-insert,.rwa-step-toolbar{display:none;} .rwa-step::after{display:none;}}
</style>
<!-- rwa:frozen:end wf-style -->
<article class="rwa-workflow">
<header>
<h1>Untitled workflow</h1>
</header>
<p class="placeholder">Describe what you want this workflow to do — the agent will scaffold the steps. For example: <em>"fetch the last 5 issues from anthropics/anthropic-sdk-python and summarize each in two sentences"</em>.</p>
</article>
<!-- rwa:frozen:begin runner -->
<script>
(function(){
  'use strict';
  // Workflow runner (frozen). Walks <li class="rwa-step"> in DOM order,
  // compiles each step's <script type="text/rwa-step"> body — which must
  // define an async function named "run" with signature run(ctx, prev) —
  // and invokes them in sequence, threading return values as "prev".
  // Writes results into the step's <output class="rwa-step-output">.
  // Sets .running / .done / .failed classes on each <li>. Stops on first
  // error. State surviving renderDoc lives on window.__rwaWorkflow.
  var NS = (window.__rwaWorkflow = window.__rwaWorkflow || { running: false, lastResult: null });

  function setStatus(s) {
    var el = document.querySelector('.rwa-run-status');
    if (el) el.textContent = s || '';
  }

  function clearStepStates() {
    // v0.4: also clears parallel cells and foreach containers.
    document.querySelectorAll('li.rwa-step, td.rwa-step').forEach(function(node){
      node.classList.remove('running', 'done', 'failed');
      var out = node.querySelector(':scope > output.rwa-step-output')
        || node.querySelector('output.rwa-step-output');
      if (out) out.textContent = '';
    });
    // Remove any stale iter-count chips from previous run.
    document.querySelectorAll('.rwa-iter-count').forEach(function (c) { c.remove(); });
  }
  function compile(scriptEl) {
    var src = scriptEl.textContent;
    return new Function('ctx', 'prev',
      '"use strict"; return (async () => { ' + src + '\\nreturn typeof run === "function" ? run(ctx, prev) : undefined; })();');
  }
  function renderOutput(value) {
    if (value === undefined) return '';
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value, null, 2); }
    catch (_) { return String(value); }
  }

  // v0.3: pin / dirty / test-step. State lives on the <li>:
  //   data-pinned-output  — JSON string; runner short-circuits run().
  //   data-last-output    — JSON string; cached for the per-step ▶ button.
  //   data-last-run-hash  — 8-char hex; mismatch with current ⇒ .stale.
  // 32-bit FNV-1a hash (Math.imul guards against overflow on 32-bit ints).
  function hashStr(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }
  function stepBodyOf(li) {
    var sc = li.querySelector('script[type="text/rwa-step"]');
    return sc ? sc.textContent : '';
  }
  // v0.8: recursive structural fingerprint for staleness on containers.
  // For leaves: just the script body. For foreach: 'foreach:' + the join
  // of inner-node fingerprints. For parallel: 'parallel:' + each cell's
  // 'label=fp/F-or-A' joined in DOM order. Adding / removing / reordering
  // / editing inner nodes shifts the fingerprint; same for toggling
  // data-allow-failure on a cell.
  function nodeFingerprint(node) {
    if (node && node.matches && node.matches('li.rwa-step.rwa-foreach')) {
      var innerOl = node.querySelector(':scope > ol.rwa-flow');
      if (!innerOl) return 'foreach:';
      var inner = Array.from(innerOl.children).filter(function (c) {
        return c.matches('li.rwa-step, table.rwa-parallel');
      });
      return 'foreach:' + inner.map(nodeFingerprint).join('|');
    }
    if (node && node.matches && node.matches('table.rwa-parallel')) {
      var cells = Array.from(node.querySelectorAll(':scope > tbody > tr > td.rwa-step'));
      return 'parallel:' + cells.map(function (c) {
        var allow = c.dataset.allowFailure === 'true' ? 'A' : 'F';
        return (c.dataset.rwaLabel || '?') + '=' + nodeFingerprint(c) + '/' + allow;
      }).join('|');
    }
    // Leaf
    return stepBodyOf(node);
  }
  // v0.8: runner state cache, keyed by data-rwa-id. Mirrors the on-DOM
  // dataset values so they survive applyEnvelope's re-render (which wipes
  // any DOM mutations not in the IDB doc). Lost on reload — that's fine:
  // hashes are tied to a session of running + editing.
  var SESSION = (window.__rwa_workflow_session = window.__rwa_workflow_session || {
    lastOutput: new Map(),
    lastRunHash: new Map(),
  });
  function cacheOutput(li, value) {
    try {
      var s = JSON.stringify(value);
      if (s !== undefined) {
        li.dataset.lastOutput = s;
        if (li.dataset.rwaId) SESSION.lastOutput.set(li.dataset.rwaId, s);
      }
    } catch (_) { /* not JSON-serializable; skip */ }
  }
  function persistLastRunHash(node, hash) {
    node.dataset.lastRunHash = hash;
    if (node.dataset.rwaId) SESSION.lastRunHash.set(node.dataset.rwaId, hash);
  }
  function restoreSessionState() {
    document.querySelectorAll('[data-rwa-id]').forEach(function (node) {
      var id = node.dataset.rwaId;
      if (!id) return;
      if (!node.dataset.lastOutput && SESSION.lastOutput.has(id)) {
        node.dataset.lastOutput = SESSION.lastOutput.get(id);
      }
      if (!node.dataset.lastRunHash && SESSION.lastRunHash.has(id)) {
        node.dataset.lastRunHash = SESSION.lastRunHash.get(id);
      }
    });
  }
  function prevHashFor(li, allSteps) {
    var idx = allSteps.indexOf(li);
    if (idx === 0) return 'init';
    var prevLi = allSteps[idx - 1];
    if (prevLi.dataset.pinnedOutput != null) {
      return hashStr('pin:' + prevLi.dataset.pinnedOutput);
    }
    return prevLi.dataset.lastRunHash || 'never';
  }
  function currentHashFor(node, allSteps) {
    // v0.8: containers use nodeFingerprint (recursive) instead of just
    // their script body (which they don't have). Leaves behave identically
    // since nodeFingerprint of a leaf returns its body.
    return hashStr(nodeFingerprint(node) + '::' + prevHashFor(node, allSteps));
  }
  function syncBadges(node) {
    // For <li>/<td>: badge lives in the node's <header>. For <table>:
    // <header> isn't a valid <table> child; we use a <caption> instead.
    var host;
    if (node.tagName === 'TABLE') {
      host = node.querySelector(':scope > caption.rwa-parallel-caption');
      if (!host && (node.classList.contains('pinned') || node.classList.contains('stale'))) {
        host = document.createElement('caption');
        host.className = 'rwa-parallel-caption';
        // <caption> must be the first child of <table>
        node.insertBefore(host, node.firstChild);
      }
    } else {
      host = node.querySelector(':scope > header');
    }
    if (!host) return;
    var existing = host.querySelectorAll(':scope > .rwa-step-badge');
    existing.forEach(function (e) { e.remove(); });
    if (node.classList.contains('pinned')) {
      var bP = document.createElement('span');
      bP.className = 'rwa-step-badge rwa-badge-pinned';
      bP.textContent = 'pinned';
      host.appendChild(bP);
    }
    if (node.classList.contains('stale')) {
      var bS = document.createElement('span');
      bS.className = 'rwa-step-badge rwa-badge-stale';
      bS.textContent = 'stale';
      host.appendChild(bS);
    }
  }
  function syncPinnedClasses() {
    // v0.5: includes container nodes (foreach <li>, parallel <table>).
    document.querySelectorAll('li.rwa-step, td.rwa-step, table.rwa-parallel').forEach(function (node) {
      if (node.dataset.pinnedOutput != null) node.classList.add('pinned');
      else node.classList.remove('pinned');
    });
  }
  // Pin button enabled when there's something to pin (cached or already
  // pinned). The attached handler reads current state, so we just keep the
  // disabled attribute and title in sync with dataset.
  function refreshPinButtonStates() {
    document.querySelectorAll('li.rwa-step, td.rwa-step, table.rwa-parallel').forEach(function (node) {
      var btn = node.querySelector(':scope > .rwa-step-toolbar > .rwa-pin-btn');
      if (!btn) return;
      var isPinned = node.dataset.pinnedOutput != null;
      var hasCache = node.dataset.lastOutput != null;
      var isContainer = node.matches('li.rwa-step.rwa-foreach, table.rwa-parallel');
      var needsId = (node.tagName === 'TABLE' || node.tagName === 'TD') && !node.dataset.rwaId;
      btn.disabled = needsId || (!isPinned && !hasCache);
      btn.title = needsId
        ? 'No data-rwa-id on this node yet — commit (⌘S) to populate it'
        : (isPinned
            ? 'Unpin'
            : (hasCache
                ? (isContainer ? 'Pin this container\\'s output' : 'Pin this step\\'s output')
                : (isContainer ? 'Run the workflow first to enable pinning' : 'Run this step first to enable pinning')));
    });
  }
  function recomputeStaleness() {
    // v0.4: top-level linear steps get a proper chain.
    // v0.8: containers (foreach, parallel) also get hashes via
    // nodeFingerprint. Top-level chain includes both leaves and containers.
    // Nested nodes (inside foreach body or parallel cells) use prevHash='init'.
    var topLevelChain = Array.from(
      document.querySelectorAll('article.rwa-workflow > ol.rwa-flow > li.rwa-step, article.rwa-workflow > ol.rwa-flow > table.rwa-parallel')
    );
    var allNodes = Array.from(document.querySelectorAll('li.rwa-step, td.rwa-step, table.rwa-parallel'));
    allNodes.forEach(function (node) {
      var stored = node.dataset.lastRunHash;
      if (!stored) { node.classList.remove('stale'); syncBadges(node); return; }
      var current;
      if (topLevelChain.indexOf(node) >= 0) {
        current = currentHashFor(node, topLevelChain);
      } else {
        current = hashStr(nodeFingerprint(node) + '::init');
      }
      if (stored !== current) node.classList.add('stale');
      else node.classList.remove('stale');
      syncBadges(node);
    });
  }

  var ctx = {
    credentials: {
      get: async function (name) {
        var key = 'rwa_cred_' + name;
        var v = sessionStorage.getItem(key);
        if (v) return v;
        var entered = prompt('Credential for "' + name + '" (sessionStorage; cleared on tab close):');
        if (entered) { sessionStorage.setItem(key, entered); return entered; }
        return null;
      },
    },
  };

  // v0.4: workflow runner is a recursive tree-walker over three primitives.
  // Spec: docs/specs/rwa-workflow-spec.md.
  //   • Linear  — <li class="rwa-step"> with a <script type="text/rwa-step">
  //   • Foreach — <li class="rwa-step rwa-foreach"> with a nested <ol class="rwa-flow">
  //   • Parallel— <table class="rwa-parallel"> with <tbody><tr><td class="rwa-step" data-rwa-label="...">
  // Pin / dirty / test-step (v0.3) apply to LEAF nodes only — container nodes
  // (foreach, parallel) don't carry data-pinned-output / data-last-output /
  // data-last-run-hash in v0.4 (deferred to v0.5).
  function RwaWorkflowError(code, message) {
    var e = new Error(message || code);
    e.code = code;
    return e;
  }
  // Selectors. Top-level children of a <ol class="rwa-flow"> are either
  // step <li> or parallel <table>. Leaf step nodes are <li class="rwa-step">
  // without rwa-foreach, OR <td class="rwa-step"> inside a parallel block.
  function isForeach(node) {
    return node && node.matches && node.matches('li.rwa-step.rwa-foreach');
  }
  function isParallel(node) {
    return node && node.matches && node.matches('table.rwa-parallel');
  }
  function isLeafStep(node) {
    return node && node.matches && (
      node.matches('li.rwa-step:not(.rwa-foreach)') ||
      node.matches('td.rwa-step')
    );
  }
  function flowChildren(ol) {
    return Array.from(ol.children).filter(function (c) {
      return c.matches('li.rwa-step, table.rwa-parallel');
    });
  }
  function parallelCells(table) {
    return Array.from(table.querySelectorAll(':scope > tbody > tr > td.rwa-step'));
  }
  function validateParallelLabels(cells) {
    var seen = {};
    var labelRe = /^[a-z][a-z0-9_]{0,31}$/;
    for (var i = 0; i < cells.length; i++) {
      var lbl = cells[i].dataset.rwaLabel;
      if (!lbl || !labelRe.test(lbl)) {
        throw RwaWorkflowError('parallel_label_invalid',
          'cell ' + i + ': data-rwa-label missing or invalid (got ' + JSON.stringify(lbl) + ')');
      }
      if (seen[lbl]) {
        throw RwaWorkflowError('parallel_label_invalid',
          'cell ' + i + ': duplicate label "' + lbl + '"');
      }
      seen[lbl] = true;
    }
  }
  async function runLeaf(node, prev, ctx) {
    var sc = node.querySelector(':scope > details > script[type="text/rwa-step"]')
      || node.querySelector('script[type="text/rwa-step"]');
    if (!sc) throw RwaWorkflowError('step_missing_script', 'no <script type="text/rwa-step">');
    // Pin short-circuit.
    if (node.dataset.pinnedOutput != null) {
      var pinned;
      try { pinned = JSON.parse(node.dataset.pinnedOutput); }
      catch (_) { throw RwaWorkflowError('pinned_value_invalid_json', 'pinned value is not valid JSON'); }
      node.classList.add('done');
      var outPin = node.querySelector(':scope > output.rwa-step-output')
        || node.querySelector('output.rwa-step-output');
      if (outPin) outPin.textContent = renderOutput(pinned);
      cacheOutput(node, pinned);
      return pinned;
    }
    node.classList.add('running');
    try {
      var fn = compile(sc);
      var result = await fn(ctx, prev);
      // compile() returns an async function; if the source body had no
      // top-level "run" function, the wrapper resolves to undefined.
      // That's user-acceptable; if the user expected a return, their
      // step body should define run() and return from it.
      node.classList.remove('running');
      node.classList.add('done');
      var out = node.querySelector(':scope > output.rwa-step-output')
        || node.querySelector('output.rwa-step-output');
      if (out) out.textContent = renderOutput(result);
      cacheOutput(node, result);
      // Hash chain. v0.4: top-level linear steps get full chain; nested
      // leaves (inside foreach / parallel cell) use prevHash='init'.
      // v0.8: chain includes foreach + parallel containers as siblings.
      var topLevelChain = Array.from(
        document.querySelectorAll('article.rwa-workflow > ol.rwa-flow > li.rwa-step, article.rwa-workflow > ol.rwa-flow > table.rwa-parallel')
      );
      if (topLevelChain.indexOf(node) >= 0) {
        persistLastRunHash(node, currentHashFor(node, topLevelChain));
      } else {
        persistLastRunHash(node, hashStr(nodeFingerprint(node) + '::init'));
      }
      node.classList.remove('stale');
      return result;
    } catch (e) {
      node.classList.remove('running');
      node.classList.add('failed');
      var outErr = node.querySelector(':scope > output.rwa-step-output')
        || node.querySelector('output.rwa-step-output');
      if (outErr) outErr.textContent = 'Error: ' + (e && e.message || e);
      throw e;
    }
  }
  async function runForeach(node, prev, ctx) {
    // v0.5: container pin short-circuit. Skip iteration entirely.
    if (node.dataset.pinnedOutput != null) {
      var pinned;
      try { pinned = JSON.parse(node.dataset.pinnedOutput); }
      catch (_) { throw RwaWorkflowError('pinned_value_invalid_json', 'foreach pinned value is not valid JSON'); }
      node.classList.add('done');
      var outFP = node.querySelector(':scope > output.rwa-step-output');
      if (outFP) outFP.textContent = renderOutput(pinned);
      cacheOutput(node, pinned);
      return pinned;
    }
    if (!Array.isArray(prev)) {
      node.classList.add('failed');
      var outErrFE = node.querySelector(':scope > output.rwa-step-output');
      if (outErrFE) outErrFE.textContent = 'Error: foreach upstream is not an array';
      throw RwaWorkflowError('foreach_upstream_not_array',
        'foreach requires an array; upstream returned ' + (prev === null ? 'null' : typeof prev));
    }
    var innerOl = node.querySelector(':scope > ol.rwa-flow');
    if (!innerOl) {
      throw RwaWorkflowError('foreach_missing_body', 'foreach <li> has no inner <ol class="rwa-flow">');
    }
    var innerNodes = flowChildren(innerOl);
    var perIter = [];
    node.classList.add('running');
    // Iteration counter chip: shows "1/N", "2/N", ... in the foreach header.
    var header = node.querySelector(':scope > header');
    var counter = null;
    if (header) {
      counter = document.createElement('span');
      counter.className = 'rwa-iter-count';
      counter.textContent = '0/' + prev.length;
      var h3 = header.querySelector('h3');
      if (h3) h3.appendChild(counter);
      else header.appendChild(counter);
    }
    try {
      for (var i = 0; i < prev.length; i++) {
        if (counter) counter.textContent = (i + 1) + '/' + prev.length;
        var iterCtx = Object.assign({}, ctx, {
          iter: { index: i, item: prev[i], total: prev.length, parent: ctx.iter || undefined },
        });
        var innerPrev = prev[i];
        for (var j = 0; j < innerNodes.length; j++) {
          innerPrev = await runNode(innerNodes[j], innerPrev, iterCtx);
        }
        perIter.push(innerPrev);
      }
      node.classList.remove('running');
      node.classList.add('done');
      var outF = node.querySelector(':scope > output.rwa-step-output');
      if (outF) outF.textContent = renderOutput(perIter);
      cacheOutput(node, perIter);
      // v0.8: write data-last-run-hash on the container for stale tracking.
      // Use top-level chain if applicable; nested containers fall back to 'init'.
      var topLevelFE = Array.from(
        document.querySelectorAll('article.rwa-workflow > ol.rwa-flow > li.rwa-step, article.rwa-workflow > ol.rwa-flow > table.rwa-parallel')
      );
      if (topLevelFE.indexOf(node) >= 0) {
        persistLastRunHash(node, currentHashFor(node, topLevelFE));
      } else {
        persistLastRunHash(node, hashStr(nodeFingerprint(node) + '::init'));
      }
      node.classList.remove('stale');
      return perIter;
    } catch (e) {
      node.classList.remove('running');
      node.classList.add('failed');
      throw e;
    }
  }
  async function runParallel(node, prev, ctx) {
    // v0.5: container pin short-circuit. Skip Promise.all entirely.
    if (node.dataset.pinnedOutput != null) {
      var pinnedP;
      try { pinnedP = JSON.parse(node.dataset.pinnedOutput); }
      catch (_) { throw RwaWorkflowError('pinned_value_invalid_json', 'parallel pinned value is not valid JSON'); }
      node.classList.add('done');
      cacheOutput(node, pinnedP);
      return pinnedP;
    }
    var cells = parallelCells(node);
    if (cells.length === 0) {
      throw RwaWorkflowError('parallel_empty', 'parallel block has no <td class="rwa-step"> cells');
    }
    validateParallelLabels(cells);
    node.classList.add('running');
    try {
      // v0.6: allSettled so cells with data-allow-failure="true" don't sink
      // the whole block. Default cells still cause a halt — we detect any
      // un-tolerated rejection post-settle and throw the first one.
      var settled = await Promise.allSettled(cells.map(function (cell) {
        return runLeaf(cell, prev, ctx);
      }));
      var obj = {};
      var firstFatal = null;
      cells.forEach(function (cell, i) {
        var r = settled[i];
        var allow = cell.dataset.allowFailure === 'true';
        if (r.status === 'fulfilled') {
          obj[cell.dataset.rwaLabel] = r.value;
        } else {
          if (allow) {
            obj[cell.dataset.rwaLabel] = {
              __error: (r.reason && r.reason.message) || String(r.reason),
              __code: (r.reason && r.reason.code) || null,
            };
          } else if (!firstFatal) {
            firstFatal = r.reason;
          }
        }
      });
      if (firstFatal) {
        node.classList.remove('running');
        node.classList.add('failed');
        throw firstFatal;
      }
      node.classList.remove('running');
      node.classList.add('done');
      cacheOutput(node, obj);
      // v0.8: write data-last-run-hash on the parallel container for stale tracking.
      var topLevelP = Array.from(
        document.querySelectorAll('article.rwa-workflow > ol.rwa-flow > li.rwa-step, article.rwa-workflow > ol.rwa-flow > table.rwa-parallel')
      );
      if (topLevelP.indexOf(node) >= 0) {
        persistLastRunHash(node, currentHashFor(node, topLevelP));
      } else {
        persistLastRunHash(node, hashStr(nodeFingerprint(node) + '::init'));
      }
      node.classList.remove('stale');
      return obj;
    } catch (e) {
      node.classList.remove('running');
      node.classList.add('failed');
      throw e;
    }
  }
  async function runNode(node, prev, ctx) {
    if (isForeach(node)) return runForeach(node, prev, ctx);
    if (isParallel(node)) return runParallel(node, prev, ctx);
    if (isLeafStep(node)) return runLeaf(node, prev, ctx);
    throw RwaWorkflowError('unknown_node_type', 'unrecognized workflow node: ' + (node.tagName || '?'));
  }
  async function runWorkflow() {
    if (NS.running) return;
    NS.running = true;
    var btn = document.querySelector('.rwa-run');
    if (btn) btn.disabled = true;
    clearStepStates();
    setStatus('● running…');
    try {
      var rootOl = document.querySelector('article.rwa-workflow > ol.rwa-flow')
        || document.querySelector('ol.rwa-flow');
      if (!rootOl) { setStatus('no workflow body to run'); return; }
      var nodes = flowChildren(rootOl);
      if (!nodes.length) { setStatus('no steps to run'); return; }
      var prev;
      for (var i = 0; i < nodes.length; i++) {
        setStatus('● node ' + (i+1) + '/' + nodes.length);
        prev = await runNode(nodes[i], prev, ctx);
      }
      NS.lastResult = prev;
      setStatus('✓ done (' + nodes.length + ' node' + (nodes.length===1?'':'s') + ')');
    } catch (e) {
      setStatus('✗ ' + (e && (e.code || e.message) || e));
      console.error(e);
    } finally {
      NS.running = false;
      if (btn) btn.disabled = false;
      recomputeStaleness();
      refreshPinButtonStates();
    }
  }

  // ---- Visual gestures (Phase 4 of workflow v0.2) ----
  // Five gestures wire up here. Show/hide code is native <details> (no JS).
  // Run is the .rwa-run click handler bound below. The remaining three
  // (drag-to-reorder, ⋮-delete, +-insert-between) synthesize apply_edits
  // envelopes and commit through runtime.applyEnvelope so they flow
  // through the substrate's audit log, frozen-zone checks, shape-check,
  // and undo stack. ⌘Z reverts them like any other commit.

  function findStepInDoc(doc, dataRwaId) {
    // v0.4-5: matches <li>, <td>, or <table> by data-rwa-id, requiring
    // the class attribute to contain rwa-step OR rwa-parallel. Covers:
    //   • linear step <li class="rwa-step">
    //   • foreach <li class="rwa-step rwa-foreach"> (matches via rwa-step)
    //   • parallel cell <td class="rwa-step">
    //   • parallel container <table class="rwa-parallel"> (v0.5 — pinned via container pin gesture)
    // Runner-managed attributes (data-pinned-output, data-last-output,
    // data-last-run-hash) may appear in any order on the opening tag.
    var idEscaped = dataRwaId.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
    var classMatch = '\\\\bclass="(?:[^"]*\\\\s)?(?:rwa-step|rwa-parallel)(?:\\\\s[^"]*)?"';
    var re = new RegExp(
      '<(li|td|table)\\\\b(?=[^>]*\\\\bdata-rwa-id="' + idEscaped + '")(?=[^>]*' + classMatch + ')[^>]*>'
    );
    var m = re.exec(doc);
    if (!m) return null;
    var idx = m.index;
    var openTag = m[0];
    var tagName = m[1];
    var closeTag = '</' + tagName + '>';
    var close = doc.indexOf(closeTag, idx + openTag.length);
    if (close < 0) return null;
    return {
      outerHTML: doc.substring(idx, close + closeTag.length),
      openTag: openTag,
      bodyAndClose: doc.substring(idx + openTag.length, close + closeTag.length),
      tagName: tagName,
      start: idx,
      end: close + closeTag.length,
    };
  }

  // Drag-to-reorder. Mutex via DRAGGED_ID — set on dragstart, read on drop.
  var DRAGGED_ID = null;
  function attachDragReorder(li) {
    if (li.dataset.rwaDragWired === '1') return;
    li.dataset.rwaDragWired = '1';
    li.draggable = true;
    li.addEventListener('dragstart', function (e) {
      var id = li.dataset.rwaId;
      if (!id) { e.preventDefault(); return; }
      DRAGGED_ID = id;
      try { e.dataTransfer.setData('text/rwa-step-id', id); } catch (_) {}
      e.dataTransfer.effectAllowed = 'move';
      li.classList.add('dragging');
    });
    li.addEventListener('dragover', function (e) {
      if (!DRAGGED_ID || DRAGGED_ID === li.dataset.rwaId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      li.classList.add('drop-target');
    });
    li.addEventListener('dragleave', function () { li.classList.remove('drop-target'); });
    li.addEventListener('dragend', function () {
      li.classList.remove('dragging');
      document.querySelectorAll('.drop-target').forEach(function (el) { el.classList.remove('drop-target'); });
      DRAGGED_ID = null;
    });
    li.addEventListener('drop', async function (e) {
      e.preventDefault();
      li.classList.remove('drop-target');
      var sourceId = DRAGGED_ID || (e.dataTransfer && e.dataTransfer.getData && e.dataTransfer.getData('text/rwa-step-id'));
      var targetId = li.dataset.rwaId;
      if (!sourceId || !targetId || sourceId === targetId) return;
      try {
        var doc = await window.getDoc();
        var srcMatch = findStepInDoc(doc, sourceId);
        var tgtMatch = findStepInDoc(doc, targetId);
        if (!srcMatch || !tgtMatch) { console.error('drag-reorder: step not in doc'); return; }
        // Two-edit envelope: remove src <li>...<\/li>\\n; insert it right before
        // target's opening tag. The two finds resolve against the original doc;
        // replaces apply sequentially (substrate enforces this per rwa-edit-spec §5.1).
        var envelope = {
          version: 'rwa-edit/1',
          edits: [
            { find: srcMatch.outerHTML + '\\n', replace: '' },
            { find: tgtMatch.outerHTML, replace: srcMatch.outerHTML + '\\n' + tgtMatch.outerHTML },
          ],
        };
        await window.runtime.applyEnvelope(envelope, {
          surface: 'visual:wf-drag-reorder',
          instruction: 'reorder step',
        });
      } catch (err) { console.error('drag-reorder failed:', err); }
    });
  }

  // Delete step (× button). Confirm + commit via apply_edits.
  function attachDeleteButton(li) {
    if (li.querySelector(':scope > .rwa-step-delete')) return;
    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'rwa-step-delete';
    del.title = 'Delete step';
    del.setAttribute('aria-label', 'Delete step');
    del.textContent = '×';
    del.addEventListener('click', async function (e) {
      e.stopPropagation();
      var id = li.dataset.rwaId;
      if (!id) return;
      var h3 = li.querySelector('h3');
      var title = (h3 && h3.textContent) || 'this step';
      if (!confirm('Delete "' + title + '"?')) return;
      try {
        var doc = await window.getDoc();
        var match = findStepInDoc(doc, id);
        if (!match) { console.error('delete: step not in doc'); return; }
        var envelope = {
          version: 'rwa-edit/1',
          edits: [{ find: match.outerHTML + '\\n', replace: '' }],
        };
        await window.runtime.applyEnvelope(envelope, {
          surface: 'visual:wf-delete-step',
          instruction: 'delete step: ' + title,
        });
      } catch (err) { console.error('delete-step failed:', err); }
    });
    li.appendChild(del);
  }

  // Insert-between (+ button between cards). Opens the lens with a
  // pre-filled prompt that anchors the agent's insertion on the preceding
  // step's title. No substrate change needed — the lens flow handles it.
  function attachInsertButtons() {
    // v0.4: attach + buttons in every <ol class="rwa-flow"> (top-level
    // AND inside foreach bodies). Parallel rows are not <ol>s, so cells
    // don't get them — adding a parallel cell is a different gesture.
    var ols = document.querySelectorAll('ol.rwa-flow');
    ols.forEach(function (ol) {
      ol.querySelectorAll(':scope > .rwa-step-insert').forEach(function (b) { b.remove(); });
      var steps = Array.from(ol.querySelectorAll(':scope > li.rwa-step'));
      steps.forEach(function (li) {
        var h3 = li.querySelector('h3');
        var title = (h3 && h3.textContent) || '';
        var ins = document.createElement('button');
        ins.type = 'button';
        ins.className = 'rwa-step-insert';
        ins.title = 'Insert a step after this one';
        ins.setAttribute('aria-label', 'Insert step here');
        ins.textContent = '+';
        ins.dataset.afterStepTitle = title;
        ins.addEventListener('click', function (ev) {
          var afterTitle = ev.currentTarget.dataset.afterStepTitle || '';
          var input = document.getElementById('rwa-lens-input');
          if (!input) return;
          var prefix = afterTitle
            ? '/insert a step after the "' + afterTitle.replace(/"/g, '\\\\"') + '" step that '
            : '/insert a step that ';
          input.value = prefix;
          input.focus();
          try { input.setSelectionRange(prefix.length, prefix.length); } catch (_) {}
        });
        li.insertAdjacentElement('afterend', ins);
      });
    });
  }

  // v0.3: rewrite the <li>'s opening tag through the substrate's audit
  // pipeline. Pinning is a user gesture that should be persisted (an
  // unpin tomorrow needs to remember what was pinned today), so route
  // through runtime.applyEnvelope like the other visual gestures.
  //
  // Subtle: runWorkflow mutates the live DOM with data-last-output and
  // data-last-run-hash but those aren't in IDB until the next commit.
  // If we only commit data-pinned-output, the next render replays
  // IDB and wipes the run state — leaving step's .stale check with no
  // baseline. So we snapshot the live <li>'s runner attrs at click time
  // and commit them together with the pin gesture.
  async function setPinnedAttribute(li, valueJson /* string or null */) {
    var id = li.dataset.rwaId;
    if (!id) return false;
    var doc = await window.getDoc();
    var match = findStepInDoc(doc, id);
    if (!match) { console.warn('pin: step not in doc'); return false; }
    // Snapshot the live runner-managed state. valueJson overrides pinned.
    var snap = {};
    if (li.dataset.lastOutput != null) snap['data-last-output'] = li.dataset.lastOutput;
    if (li.dataset.lastRunHash != null) snap['data-last-run-hash'] = li.dataset.lastRunHash;
    if (valueJson != null) snap['data-pinned-output'] = valueJson;
    // Strip any existing runner attrs from the IDB openTag.
    var newOpen = match.openTag
      .replace(/\\s+data-pinned-output="[^"]*"/, '')
      .replace(/\\s+data-last-output="[^"]*"/, '')
      .replace(/\\s+data-last-run-hash="[^"]*"/, '');
    // Re-add the snapshot. Encode HTML entities in values.
    var keys = Object.keys(snap);
    if (keys.length > 0) {
      var attrsStr = '';
      for (var k = 0; k < keys.length; k++) {
        var name = keys[k];
        var encoded = String(snap[name])
          .replace(/&/g, '&amp;')
          .replace(/"/g, '&quot;')
          .replace(/</g, '&lt;');
        attrsStr += ' ' + name + '="' + encoded + '"';
      }
      newOpen = newOpen.replace(/>$/, attrsStr + '>');
    }
    var newOuter = newOpen + match.bodyAndClose;
    if (newOuter === match.outerHTML) return true;
    var envelope = {
      version: 'rwa-edit/1',
      edits: [{ find: match.outerHTML, replace: newOuter }],
    };
    await window.runtime.applyEnvelope(envelope, {
      surface: 'visual:wf-' + (valueJson != null ? 'pin' : 'unpin') + '-step',
      instruction: (valueJson != null ? 'pin' : 'unpin') + ' step',
    });
    return true;
  }

  // ▶ Test runs ONE step against the upstream's cached (or pinned) output.
  // v0.4: upstream lookup respects nesting.
  //   • For a leaf <li.rwa-step> inside an <ol class="rwa-flow"> (top-level
  //     OR nested in a foreach body): upstream = previous flow-child of
  //     the same <ol> (either a <li.rwa-step> or a <table.rwa-parallel>).
  //   • For a parallel cell <td.rwa-step>: upstream = previous flow-child
  //     of the <ol> that contains the parallel <table>.
  //   • If upstream lookup yields nothing, prev = undefined.
  // Does not persist through applyEnvelope — the run is transient like
  // runWorkflow's mutations. ⌘S captures it if the user wants to.
  function findTestUpstream(node) {
    var target;
    if (node.tagName === 'LI') {
      target = node;
    } else if (node.tagName === 'TD') {
      // Walk up to the parallel <table>; that's the unit positioned in
      // the containing flow.
      var table = node.closest('table.rwa-parallel');
      if (!table) return null;
      target = table;
    } else {
      return null;
    }
    var sibling = target.previousElementSibling;
    while (sibling) {
      if (sibling.matches && (sibling.matches('li.rwa-step') || sibling.matches('table.rwa-parallel'))) {
        return sibling;
      }
      sibling = sibling.previousElementSibling;
    }
    return null;
  }
  async function testStep(node) {
    if (NS.running) return;
    // v0.7: container test-step. Dispatch on node type — for foreach /
    // parallel containers, call their dedicated runners against the
    // upstream's cached value. The runner functions own classes /
    // output rendering / caching, so this path is just wiring.
    if (isForeach(node) || isParallel(node)) {
      return testContainer(node);
    }
    var sc = node.querySelector(':scope > details > script[type="text/rwa-step"]')
      || node.querySelector('script[type="text/rwa-step"]');
    if (!sc) return;
    node.classList.remove('done', 'failed', 'stale');
    node.classList.add('running');
    syncBadges(node);
    try {
      var prev;
      var upstream = findTestUpstream(node);
      if (upstream) {
        var src = upstream.dataset.pinnedOutput != null
          ? upstream.dataset.pinnedOutput
          : upstream.dataset.lastOutput;
        if (src != null) {
          try { prev = JSON.parse(src); } catch (_) { prev = src; }
        }
      }
      var fn = compile(sc);
      var result = await fn(ctx, prev);
      node.classList.remove('running');
      node.classList.add('done');
      var out = node.querySelector(':scope > output.rwa-step-output')
        || node.querySelector('output.rwa-step-output');
      if (out) out.textContent = renderOutput(result);
      cacheOutput(node, result);
      // Hash chain — see runLeaf for the top-level vs nested branch.
      var topLevelLinear = Array.from(
        document.querySelectorAll('article.rwa-workflow > ol.rwa-flow > li.rwa-step, article.rwa-workflow > ol.rwa-flow > table.rwa-parallel')
      );
      if (topLevelLinear.indexOf(node) >= 0) {
        persistLastRunHash(node, currentHashFor(node, topLevelLinear));
      } else {
        persistLastRunHash(node, hashStr(nodeFingerprint(node) + '::init'));
      }
      recomputeStaleness();
      refreshPinButtonStates();
    } catch (e) {
      node.classList.remove('running');
      node.classList.add('failed');
      var outErr = node.querySelector(':scope > output.rwa-step-output')
        || node.querySelector('output.rwa-step-output');
      if (outErr) outErr.textContent = 'Error: ' + (e && e.message || e);
      recomputeStaleness();
      refreshPinButtonStates();
    }
  }

  // v0.7: container test-step. Runs the whole subtree against the
  // upstream's cached value via the same runForeach / runParallel paths
  // that runWorkflow uses.
  async function testContainer(node) {
    if (NS.running) return;
    NS.running = true;
    var btn = document.querySelector('.rwa-run');
    if (btn) btn.disabled = true;
    try {
      var prev;
      var upstream = findTestUpstream(node);
      if (upstream) {
        var src = upstream.dataset.pinnedOutput != null
          ? upstream.dataset.pinnedOutput
          : upstream.dataset.lastOutput;
        if (src != null) {
          try { prev = JSON.parse(src); } catch (_) { prev = src; }
        }
      }
      // Clear classes/output on this subtree before running. We don't
      // clear the WHOLE doc — only the descendants of this container.
      var subtreeNodes = node.querySelectorAll('li.rwa-step, td.rwa-step, table.rwa-parallel');
      subtreeNodes.forEach(function (n) {
        n.classList.remove('running', 'done', 'failed');
        var out = null;
        for (var k = 0; k < n.children.length; k++) {
          if (n.children[k].tagName === 'OUTPUT') { out = n.children[k]; break; }
        }
        if (out) out.textContent = '';
      });
      // Also clear the container's own visible output + class.
      node.classList.remove('done', 'failed');
      for (var k0 = 0; k0 < node.children.length; k0++) {
        if (node.children[k0].tagName === 'OUTPUT') { node.children[k0].textContent = ''; break; }
      }
      await runNode(node, prev, ctx);
      recomputeStaleness();
      refreshPinButtonStates();
    } catch (e) {
      console.error('test-container failed:', e);
      // runForeach / runParallel already marked the node .failed
    } finally {
      NS.running = false;
      if (btn) btn.disabled = false;
    }
  }

  // ▶/📌 toolbar on each step. Hover-revealed, sits left of the existing
  // × delete button. Pin button is disabled when there's nothing to pin
  // (no cached output yet and not currently pinned).
  // v0.5: containers (foreach <li>, parallel <table>) get a pin button.
  // v0.7: containers also get a test (▶) button — runs the container's
  // subtree against upstream's cached value.
  function attachStepToolbar(node) {
    if (node.querySelector(':scope > .rwa-step-toolbar')) return;
    var isContainer = (node.matches && node.matches('li.rwa-step.rwa-foreach, table.rwa-parallel'));
    var toolbar = document.createElement('span');
    toolbar.className = 'rwa-step-toolbar';
    var testBtn = document.createElement('button');
    testBtn.type = 'button';
    testBtn.className = 'rwa-test-btn';
    testBtn.title = isContainer
      ? 'Test this container (runs subtree against upstream\\'s cached output)'
      : 'Test this step (uses upstream\\'s cached output)';
    testBtn.setAttribute('aria-label', isContainer ? 'Test this container' : 'Test this step');
    testBtn.textContent = '▶';
    testBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      testStep(node);
    });
    toolbar.appendChild(testBtn);
    var pinBtn = document.createElement('button');
    pinBtn.type = 'button';
    pinBtn.className = 'rwa-pin-btn';
    var isPinned = node.dataset.pinnedOutput != null;
    pinBtn.title = isPinned ? 'Unpin' : (isContainer ? 'Pin this container\\'s output' : 'Pin this step\\'s output');
    pinBtn.setAttribute('aria-label', 'Pin or unpin');
    pinBtn.textContent = '📌';
    if (!isPinned && node.dataset.lastOutput == null) {
      pinBtn.disabled = true;
      pinBtn.title = isContainer ? 'Run the workflow first to enable pinning' : 'Run this step first to enable pinning';
    }
    // Pin commits via findStepInDoc which requires data-rwa-id. Substrate
    // 0.11 added TABLE/TD to ANCHORABLE_TAGS so the auto-backfill covers
    // these in fresh containers. Legacy containers without ids gain them
    // on first commit. As a defensive backstop, disable the pin button if
    // an id is missing — the user just needs to ⌘S once to populate it.
    if ((node.tagName === 'TABLE' || node.tagName === 'TD') && !node.dataset.rwaId) {
      pinBtn.disabled = true;
      pinBtn.title = 'No data-rwa-id on this node yet — commit (⌘S) to populate it';
    }
    pinBtn.addEventListener('click', async function (e) {
      e.stopPropagation();
      try {
        if (node.dataset.pinnedOutput != null) {
          await setPinnedAttribute(node, null);
        } else {
          var cached = node.dataset.lastOutput;
          if (cached == null) return;
          try { JSON.parse(cached); } catch (_) { return; }
          await setPinnedAttribute(node, cached);
        }
      } catch (err) {
        console.error('pin-toggle failed:', err);
      }
    });
    toolbar.appendChild(pinBtn);
    node.appendChild(toolbar);
  }

  function attachGestures() {
    // v0.8: restore runner state from the session-state cache before
    // anything else. applyEnvelope-driven re-renders wipe data-last-output
    // and data-last-run-hash from the DOM (they live in live mutations,
    // not IDB); the cache survives renders so stale detection still works
    // after an edit lands.
    restoreSessionState();
    syncPinnedClasses();
    // Drag-reorder: top-level <li.rwa-step> only (v0.4 doesn't reorder
    // inside foreach bodies or across parallel cells).
    document.querySelectorAll('article.rwa-workflow > ol.rwa-flow > li.rwa-step').forEach(function (li) {
      attachDragReorder(li);
    });
    // Delete button: any step node (linear, foreach container, parallel cell).
    document.querySelectorAll('li.rwa-step, td.rwa-step').forEach(function (node) {
      attachDeleteButton(node);
    });
    // Toolbar: leaves get ▶ test + 📌 pin; containers get just 📌 pin (v0.5).
    document.querySelectorAll('li.rwa-step:not(.rwa-foreach), td.rwa-step, li.rwa-step.rwa-foreach, table.rwa-parallel').forEach(function (node) {
      attachStepToolbar(node);
    });
    attachInsertButtons();
    recomputeStaleness();
    refreshPinButtonStates();
  }

  // Re-bind on every renderDoc — the previous button is gone after the
  // innerHTML swap. The renderer re-executes inline scripts on every render
  // (per docs/specs/rwa-artifact-conventions.md §6.1), so this IIFE runs
  // again and re-attaches the click handler + all gestures to the freshly
  // rendered DOM.
  var btn = document.querySelector('.rwa-run');
  if (btn) btn.addEventListener('click', runWorkflow);
  attachGestures();
})();
</script>
<!-- rwa:frozen:end runner -->`;
const KIND_WORKFLOW_LENS = 'Describe what you want this workflow to do.';
const KIND_WORKFLOW_PAL  = 'describe what this workflow does...';

// PRODUCT HEADER for the workflow kind (v0.2 — UX-design alignment).
// Names the canonical shape (ordered list of step cards with inline async
// run(ctx, prev)), the credential surface (ctx.credentials.get), the CORS
// reality, and the deliberate v0.2 omissions.
const KIND_WORKFLOW_HEADER = `// === PRODUCT HEADER ===
// Product: workflow (substrate-layer scaffold, v0.2).
//
// The file renders as a vertical <ol class="rwa-flow"> of step cards
// (<li class="rwa-step">). Each step has a <header> (title + one-sentence
// description), a collapsible <details> wrapping an inert
// <script type="text/rwa-step"> with the step's inline JS, and an
// <output class="rwa-step-output"> slot for the last-run result. A frozen
// runner at the bottom walks the steps on Run click, compiles each
// script's body (which must define an async function "run" with signature
// run(ctx, prev)), and threads return values as "prev" into the next
// step. The runner writes results into the step's output, marks the
// step .done / .failed, and stops the chain on first error.
//
// Credentials: ctx.credentials.get("name") reads sessionStorage with
// prompt-on-first-use. Never persisted in INLINE_DOC; cleared on tab
// close. Use readable names: "gmail", "stripe", "github".
//
// CORS reality: browser fetch is CORS-bound. CORS-friendly APIs work
// (Stripe, OpenAI, GitHub, Slack, Linear, OpenRouter). Most consumer
// SaaS without OAuth proxies (Gmail, etc.) does not.
//
// v0.2 deliberately ships WITHOUT: credential vault encryption (sessionStorage
// only), skill library / cross-workflow reuse, trigger model (manual Run
// only), Worker isolation, branches / parallel execution, scheduling,
// retry / resume. The trust anchor is workflow review at creation: the
// user sees each generated step's JS in the collapsible <details> before
// accepting. See docs/specs/re-write-able-actions-spec-v0.7.md and its
// lineage for where the omitted features are designed; see
// docs/plans/2026-05-18-workflow-ux-design.md for the v0.2 UX spec.
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
