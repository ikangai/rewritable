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
    document.querySelectorAll('li.rwa-step').forEach(function(li){
      li.classList.remove('running', 'done', 'failed');
      var out = li.querySelector('.rwa-step-output');
      if (out) out.textContent = '';
    });
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
  function cacheOutput(li, value) {
    try {
      var s = JSON.stringify(value);
      if (s !== undefined) li.dataset.lastOutput = s;
    } catch (_) { /* not JSON-serializable; skip */ }
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
  function currentHashFor(li, allSteps) {
    return hashStr(stepBodyOf(li) + '::' + prevHashFor(li, allSteps));
  }
  function syncBadges(li) {
    var header = li.querySelector(':scope > header');
    if (!header) return;
    var existing = header.querySelectorAll(':scope > .rwa-step-badge');
    existing.forEach(function (e) { e.remove(); });
    if (li.classList.contains('pinned')) {
      var bP = document.createElement('span');
      bP.className = 'rwa-step-badge rwa-badge-pinned';
      bP.textContent = 'pinned';
      header.appendChild(bP);
    }
    if (li.classList.contains('stale')) {
      var bS = document.createElement('span');
      bS.className = 'rwa-step-badge rwa-badge-stale';
      bS.textContent = 'stale';
      header.appendChild(bS);
    }
  }
  function syncPinnedClasses() {
    document.querySelectorAll('li.rwa-step').forEach(function (li) {
      if (li.dataset.pinnedOutput != null) li.classList.add('pinned');
      else li.classList.remove('pinned');
    });
  }
  // Pin button enabled when there's something to pin (cached or already
  // pinned). The attached handler reads current state, so we just keep the
  // disabled attribute and title in sync with dataset.
  function refreshPinButtonStates() {
    document.querySelectorAll('li.rwa-step').forEach(function (li) {
      var btn = li.querySelector(':scope > .rwa-step-toolbar > .rwa-pin-btn');
      if (!btn) return;
      var isPinned = li.dataset.pinnedOutput != null;
      var hasCache = li.dataset.lastOutput != null;
      btn.disabled = !isPinned && !hasCache;
      btn.title = isPinned
        ? 'Unpin this step'
        : (hasCache ? 'Pin this step\\'s output' : 'Run this step first to enable pinning');
    });
  }
  function recomputeStaleness() {
    var allSteps = Array.from(document.querySelectorAll('li.rwa-step'));
    allSteps.forEach(function (li) {
      var stored = li.dataset.lastRunHash;
      if (!stored) { li.classList.remove('stale'); syncBadges(li); return; }
      var current = currentHashFor(li, allSteps);
      if (stored !== current) li.classList.add('stale');
      else li.classList.remove('stale');
      syncBadges(li);
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

  async function runWorkflow() {
    if (NS.running) return;
    NS.running = true;
    var btn = document.querySelector('.rwa-run');
    if (btn) btn.disabled = true;
    clearStepStates();
    setStatus('● running…');
    try {
      var steps = Array.from(document.querySelectorAll('li.rwa-step'));
      if (!steps.length) { setStatus('no steps to run'); return; }
      var prev;
      for (var i = 0; i < steps.length; i++) {
        var li = steps[i];
        var sc = li.querySelector('script[type="text/rwa-step"]');
        if (!sc) throw new Error('step ' + (i+1) + ': missing <script type="text/rwa-step">');
        // Pin short-circuit: skip run(), return the parsed pinned value.
        // Does NOT update data-last-run-hash — pin is its own state, and
        // staleness should still reflect "code drifted from last actual run."
        if (li.dataset.pinnedOutput != null) {
          try {
            prev = JSON.parse(li.dataset.pinnedOutput);
          } catch (eP) {
            li.classList.add('failed');
            var outPinErr = li.querySelector('.rwa-step-output');
            if (outPinErr) outPinErr.textContent = 'Error: pinned value is not valid JSON';
            throw new Error('step ' + (i+1) + ': pinned value is not valid JSON');
          }
          li.classList.add('done');
          var outPin = li.querySelector('.rwa-step-output');
          if (outPin) outPin.textContent = renderOutput(prev);
          cacheOutput(li, prev);
          setStatus('● step ' + (i+1) + '/' + steps.length + ' (pinned)');
          continue;
        }
        li.classList.add('running');
        setStatus('● step ' + (i+1) + '/' + steps.length);
        try {
          var fn = compile(sc);
          prev = await fn(ctx, prev);
          li.classList.remove('running');
          li.classList.add('done');
          var out = li.querySelector('.rwa-step-output');
          if (out) out.textContent = renderOutput(prev);
          cacheOutput(li, prev);
          li.dataset.lastRunHash = currentHashFor(li, steps);
          li.classList.remove('stale');
        } catch (e) {
          li.classList.remove('running');
          li.classList.add('failed');
          var outErr = li.querySelector('.rwa-step-output');
          if (outErr) outErr.textContent = 'Error: ' + (e && e.message || e);
          throw e;
        }
      }
      NS.lastResult = prev;
      setStatus('✓ done (' + steps.length + ' step' + (steps.length===1?'':'s') + ')');
    } catch (e) {
      setStatus('✗ ' + (e && e.message || e));
      console.error(e);
    } finally {
      NS.running = false;
      if (btn) btn.disabled = false;
      // Run-state changes can flip staleness for downstream steps; refresh
      // the visual indicators so the cascade is accurate.
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
    // v0.3: <li class="rwa-step" data-rwa-id="X"> may carry extra runner
    // attributes (data-pinned-output, data-last-output, data-last-run-hash)
    // in any order. Match by requiring both class="rwa-step" and the target
    // data-rwa-id, regardless of position or surrounding attributes.
    var idEscaped = dataRwaId.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
    var re = new RegExp(
      '<li\\\\b(?=[^>]*\\\\bdata-rwa-id="' + idEscaped + '")(?=[^>]*\\\\bclass="rwa-step")[^>]*>'
    );
    var m = re.exec(doc);
    if (!m) return null;
    var idx = m.index;
    var openTag = m[0];
    var close = doc.indexOf('</li>', idx + openTag.length);
    if (close < 0) return null;
    return {
      outerHTML: doc.substring(idx, close + 5),
      openTag: openTag,
      bodyAndClose: doc.substring(idx + openTag.length, close + 5),
      start: idx,
      end: close + 5,
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
    var ol = document.querySelector('ol.rwa-flow');
    if (!ol) return;
    // Drop existing insert buttons from a previous attach pass.
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
  // Does not persist through applyEnvelope — the run is transient like
  // runWorkflow's mutations. ⌘S captures it if the user wants to.
  async function testStep(li) {
    if (NS.running) return;
    var allSteps = Array.from(document.querySelectorAll('li.rwa-step'));
    var idx = allSteps.indexOf(li);
    if (idx < 0) return;
    var sc = li.querySelector('script[type="text/rwa-step"]');
    if (!sc) return;
    li.classList.remove('done', 'failed', 'stale');
    li.classList.add('running');
    syncBadges(li);
    try {
      var prev;
      if (idx > 0) {
        var prevLi = allSteps[idx - 1];
        var src = prevLi.dataset.pinnedOutput != null
          ? prevLi.dataset.pinnedOutput
          : prevLi.dataset.lastOutput;
        if (src != null) {
          try { prev = JSON.parse(src); } catch (_) { prev = src; }
        }
      }
      var fn = compile(sc);
      var result = await fn(ctx, prev);
      li.classList.remove('running');
      li.classList.add('done');
      var out = li.querySelector('.rwa-step-output');
      if (out) out.textContent = renderOutput(result);
      cacheOutput(li, result);
      li.dataset.lastRunHash = currentHashFor(li, allSteps);
      // Downstream may now be stale relative to this fresh upstream.
      recomputeStaleness();
      refreshPinButtonStates();
    } catch (e) {
      li.classList.remove('running');
      li.classList.add('failed');
      var outErr = li.querySelector('.rwa-step-output');
      if (outErr) outErr.textContent = 'Error: ' + (e && e.message || e);
      recomputeStaleness();
      refreshPinButtonStates();
    }
  }

  // ▶/📌 toolbar on each step. Hover-revealed, sits left of the existing
  // × delete button. Pin button is disabled when there's nothing to pin
  // (no cached output yet and not currently pinned).
  function attachStepToolbar(li) {
    if (li.querySelector(':scope > .rwa-step-toolbar')) return;
    var toolbar = document.createElement('span');
    toolbar.className = 'rwa-step-toolbar';
    var testBtn = document.createElement('button');
    testBtn.type = 'button';
    testBtn.className = 'rwa-test-btn';
    testBtn.title = 'Test this step (uses upstream\\'s cached output)';
    testBtn.setAttribute('aria-label', 'Test this step');
    testBtn.textContent = '▶';
    testBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      testStep(li);
    });
    var pinBtn = document.createElement('button');
    pinBtn.type = 'button';
    pinBtn.className = 'rwa-pin-btn';
    var isPinned = li.dataset.pinnedOutput != null;
    pinBtn.title = isPinned ? 'Unpin this step' : 'Pin this step\\'s output';
    pinBtn.setAttribute('aria-label', 'Pin or unpin step');
    pinBtn.textContent = '📌';
    if (!isPinned && li.dataset.lastOutput == null) {
      pinBtn.disabled = true;
      pinBtn.title = 'Run this step first to enable pinning';
    }
    pinBtn.addEventListener('click', async function (e) {
      e.stopPropagation();
      try {
        if (li.dataset.pinnedOutput != null) {
          await setPinnedAttribute(li, null);
        } else {
          var cached = li.dataset.lastOutput;
          if (cached == null) return;
          try { JSON.parse(cached); } catch (_) { return; }
          await setPinnedAttribute(li, cached);
        }
      } catch (err) {
        console.error('pin-toggle failed:', err);
      }
    });
    toolbar.appendChild(testBtn);
    toolbar.appendChild(pinBtn);
    li.appendChild(toolbar);
  }

  function attachGestures() {
    syncPinnedClasses();
    document.querySelectorAll('li.rwa-step').forEach(function (li) {
      attachDragReorder(li);
      attachDeleteButton(li);
      attachStepToolbar(li);
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
