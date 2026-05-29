# Implementation Plan — `presentation` render mode as a first-party `view` provider

*2026-05-29. Execution plan for shipping the first render mode, implementing the `re-write-able-spec.md` §5.10 contract. Produced by a localize→plan→adversarial-review workflow; the review verified the **inertness theorem** (below) against actual code and surfaced 5 confirmed plan-detail issues, folded into "Review fixes" at the end. Status: reviewed, awaiting execution against the canonical seed under the conformance gate.*


Adapts the harness-green PoC (`docs/plans/prototypes/2026-05-29-presentation-view-provider-poc.html`) into the real seed (`seeds/rewritable.html`), CLI, references, and tests. Spec contract: `re-write-able-spec.md` §5.10 + Invariants 8–9. The PoC's local names (`docText`, `setDocText`, `getStatus`, `viewKey`/`slideKey`, `getElementById('rwa-status')`, PoC panel) are replaced with the real runtime's names (`getDoc()`, `idbPut(RWA.DOC, …)`, `setStatus`, `DOC_UUID`, `#rwa-set`/`#rwa-st-status`).

**Global inertness theorem (why every addition is inert for `document`/`app`/`workflow`):** Every behavioral change is gated on one of two runtime states that are *both unreachable* unless `PRODUCT_KIND === 'presentation'`:
- `activeView` (a new module-scoped `let`, initialized `null`) is only ever set non-null by `runtimeSetView(name)`, which is only ever called by the toggle button or the bootstrap restore block — and **both are only created/run when `PRODUCT_KIND === 'presentation'`** (Step 5). For any other kind, `activeView` is permanently `null`.
- `providers.view` is only set by `runtimeProvide('view', …)`, called once in the bootstrap **only when `PRODUCT_KIND === 'presentation'`** (Step 5). For any other kind it stays `null`, so the toggle/chrome are never built.

So for non-presentation containers: `renderDoc` takes its existing `else` branch verbatim (`mountHtml = html`), `setSourceMap(html)`/`rebuildLockedRanges(html)` run on the same value as today, the click listener is wired exactly as today, `mounted()` never fires, `setView`/`provide` are never called, the anchored-modify gates are all `activeView === null === true`, and no new DOM/CSS classes appear. The only unconditional new bytes are: function/`let` *declarations* (dead code, never invoked), the `@media print { #rwa-lens{…} }` rule (a pre-existing-bug fix that is correct for all kinds), and the `SYSTEM_PROMPTS.presentation` registry entry (an unread map key when `PRODUCT_KIND !== 'presentation'`). None of these alter the rendered/committed bytes of an existing container. **This is verified by Success Criterion 1 (conformance 42/42) and 2 (jsdom green) running against the still-`document` seed.**

Implement in the order below; each step compiles/loads on its own.

---

## Step 1 — Seed: provider registry, `viewCtx`, `sanitizeViewOutput`, output validator

**File:** `/Users/martintreiber/Documents/Development/rewritable/seeds/rewritable.html`

**1a. Insert the registry + state next to the modify mutex.** Match (line 3241–3242):
```js
// ─── Modify lifecycle (rwa-edit/1) ──────────────────────────────────
let modifyMutex = false;
```
Insert immediately **after** the `let modifyMutex = false;` line:
```js

// ─── Render modes / view providers (spec §5.10, Invariants 8–9) ─────
// Single nullable first-party slot per kind (spec §5.10). `activeView`
// stays null for every non-presentation container — Step 5's bootstrap is
// the ONLY caller that ever registers/activates a view, so this whole
// subsystem is inert unless PRODUCT_KIND === 'presentation'.
const providers = { view: null };
let activeView = null;

// Reserved ids/markers a view's render() output must not contain (§5.10 clause 4).
const RWA_VIEW_RESERVED_IDS = ['rwa-doc-mount', 'rwa-lens', 'rwa-runtime'];
const RWA_VIEW_RESERVED_MARKERS = ['rwa:frozen:begin', 'rwa:frozen:end', 'data-rwa-frozen'];

// Read-only ctx handed to render()/mounted(). Capability: none (§5.10).
// Trimmed to docUuid per the kernel-findings "viewCtx over-exposes" note —
// presentation consumes nothing else; do not hand frozen-zone topology here.
function viewCtx() {
  return Object.freeze({ docUuid: DOC_UUID });
}

// §5.10 clause 5: first-party render output is HTML+CSS, never code. The
// render path re-executes <script> as main-thread code; assert their absence
// and fail loud (CLAUDE.md Rule 12) rather than silently running them.
function sanitizeViewOutput(html, spec) {
  const name = spec && spec.name ? spec.name : '(unknown)';
  if (/<script[\s/>]/i.test(html)) {
    throw new Error(`view '${name}' render() emitted <script> — forbidden by the first-party view contract (spec §5.10 clause 5)`);
  }
  return html;
}

// §5.10 clause 4: validate render output once at provide/setView time. A
// duplicate #rwa-lens etc. silently breaks getElementById identity.
function validateViewOutput(html, spec) {
  const name = spec && spec.name ? spec.name : '(unknown)';
  sanitizeViewOutput(html, spec);
  for (const id of RWA_VIEW_RESERVED_IDS) {
    if (new RegExp('\\bid\\s*=\\s*["\\\']' + id + '["\\\']', 'i').test(html)) {
      throw new Error(`view '${name}' render() output contains reserved id #${id} (spec §5.10 clause 4)`);
    }
  }
  for (const mk of RWA_VIEW_RESERVED_MARKERS) {
    if (html.indexOf(mk) !== -1) {
      throw new Error(`view '${name}' render() output contains reserved marker '${mk}' (spec §5.10 clause 4)`);
    }
  }
  return html;
}

// runtime.provide(kind, spec) -> unregister closure (spec §5.10).
function runtimeProvide(kind, spec) {
  if (kind !== 'view') throw new Error('unknown provider kind: ' + kind);
  if (!spec || spec.kind !== 'view') throw new Error("view spec.kind must be 'view'");
  for (const f of ['name', 'label', 'render']) {
    if (spec[f] == null) throw new Error('view spec missing required field: ' + f);
  }
  if (typeof spec.render !== 'function') throw new Error('view spec.render must be a function');
  spec.__provenance = 'first-party';
  providers.view = spec;   // single-slot replace; does NOT auto-activate (§5.10)
  return function unregister() {
    if (providers.view === spec) {
      if (activeView === spec) runtimeSetView(null);
      providers.view = null;
    }
  };
}

// runtime.setView(name|null) — guards added in Step 3.
function runtimeSetView(name) {
  if (modifyMutex) { setStatus('err', '✗ modify in progress'); return; }
  if (name === null) {
    activeView = null;
    sessionStorage.setItem(rwaViewKey(), '');
  } else {
    const spec = providers.view;
    if (!spec || spec.name !== name) throw new Error('no registered view named ' + name);
    releaseAnchor();   // §5.10: clear any standing anchor before a whole-mount view
    activeView = spec;
    sessionStorage.setItem(rwaViewKey(), name);
  }
  if (typeof syncViewChrome === 'function') syncViewChrome();
  getDoc().then(d => renderDoc(canonLF(d)));   // re-render through the new branch
}
function rwaViewKey() { return 'rwa_view_active_' + DOC_UUID; }
function rwaSlideKey() { return 'rwa_view_slide_' + DOC_UUID; }
```
**Inert because:** all of the above are declarations plus two functions (`runtimeProvide`, `runtimeSetView`) that have no call site for non-presentation kinds (Step 5 is the only caller, and it is `PRODUCT_KIND`-gated). `providers.view`/`activeView` stay at their initializers. `rwaViewKey`/`rwaSlideKey` write sessionStorage only when `setView` runs.

> Note: `setView` reads `await getDoc()` rather than a PoC-style `docText`, matching the real runtime. The PoC's TOCTOU finding (kernel findings, write-path lens) is handled by the `modifyMutex` guard — `getDoc()` is only read once no modify holds the mutex.

---

## Step 2 — Seed: the C2 render seam inside the real `renderDoc`

**File:** `seeds/rewritable.html`, function `renderDoc(html)` (lines 829–873).

**2a. Replace the innerHTML assignment.** Match (line 849):
```js
  m.innerHTML = html;
```
Replace with:
```js
  // ─ C2 SEAM (spec §5.10). render() output is mount-only and is NEVER read
  //   back into the doc text. `html` (the stored doc text) is what reaches
  //   setSourceMap/rebuildLockedRanges/commit — that is WHY data-rwa-id and
  //   frozen zones survive (Invariant 8), not because wrapping rides them.
  //   For activeView===null (every non-presentation container) this is exactly
  //   today's behavior: mountHtml === html, no class added.
  let mountHtml;
  if (activeView) {
    mountHtml = sanitizeViewOutput(activeView.render(html, viewCtx()), activeView);
    m.classList.add('viewmode-' + activeView.name);
  } else {
    mountHtml = html;
    m.classList.remove('viewmode-presentation');
  }
  m.innerHTML = mountHtml;
```

**2b. Keep `setSourceMap`/`rebuildLockedRanges` on the stored text.** No edit needed — lines 866–867 already pass `html` (the stored doc text), which is now distinct from `mountHtml`. **This is the load-bearing invisible-by-construction guarantee (Invariant 9):** the agent-facing cache (`currentDocCache`) is set from `html`, never from `mountHtml`. Add a one-line comment above line 866 documenting the constraint:
```js
  // §5.10 clause 2 / Invariant 9: source map + locked ranges derive from the
  // STORED doc text (`html`), never the (possibly view-wrapped) `mountHtml`.
  setSourceMap(html);
```

**2c. Wire the click listener only in the default view, add the `mounted` post-mount hook.** Match (lines 868–872):
```js
  // rwa-lens/1: click-to-anchor (Task 5.1). renderDoc runs on every commit and
  // on bootstrap; remove first so listeners don't multiply across renders. Same
  // function reference, so removing the previous instance is safe.
  m.removeEventListener('click', handleMountClick);
  m.addEventListener('click', handleMountClick);
}
```
Replace with:
```js
  // rwa-lens/1: click-to-anchor (Task 5.1). renderDoc runs on every commit and
  // on bootstrap; remove first so listeners don't multiply across renders. Same
  // function reference, so removing the previous instance is safe. With a
  // whole-mount view active, byte-offset click resolution is undefined, so the
  // listener is removed and not re-added (spec §5.10 activation). For
  // activeView===null this is byte-identical to the previous behavior.
  m.removeEventListener('click', handleMountClick);
  if (!activeView) m.addEventListener('click', handleMountClick);
  // §5.10: post-mount provider seam. render() stays pure string->string; this
  // impure slot restores transient UI state (slide index) after innerHTML +
  // script-rerun + form-restore. Mirrors the runtime's own form-state restore.
  if (activeView && typeof activeView.mounted === 'function') {
    activeView.mounted(m, viewCtx());
  }
}
```
**Inert because:** when `activeView === null`, `mountHtml = html` and `m.classList.remove('viewmode-presentation')` is a no-op on a mount that never carried the class; the listener is added exactly as before; `mounted()` is skipped. The PoC's `mount.className = ''` is deliberately *not* copied — the real mount carries no view classes for non-presentation kinds, so we only remove the specific class we add, preserving any future non-view classes.

---

## Step 3 — Seed: `setView` guards + gate the anchored-modify / post-commit-anchor path on `activeView === null`

**File:** `seeds/rewritable.html`

**3a.** The `modifyMutex` refusal and `releaseAnchor()`-on-activate guards are already in `runtimeSetView` (Step 1). No further edit there.

**3b. Gate the anchored slash-command runner.** In `runAnchoredCommand` (lines 2503–2509), match:
```js
async function runAnchoredCommand(anchor, instruction) {
  if (modifyMutex) {
```
Insert a guard as the first statement of the function body (before the `modifyMutex` check):
```js
async function runAnchoredCommand(anchor, instruction) {
  // §5.10: the anchored-edit path is available ONLY when no render mode is
  // active. A whole-mount view rearranges the DOM; re-anchoring against it
  // (via handlePostCommitAnchor -> liveNodeForEntry) would resolve the wrong
  // block. Suspending the click listener alone is insufficient because a
  // stale anchor can re-enter here. Inert for non-presentation: activeView
  // is permanently null, so this branch is never taken.
  if (activeView) { setStatus('err', '✗ anchored edits unavailable in this view'); return; }
  if (modifyMutex) {
```

**3c. Gate the post-commit re-anchor in `synthesizeAndCommit`.** In `synthesizeAndCommit` (line 2685), match:
```js
    if (prevAnchorStart !== null && sourceMap) {
```
Replace with:
```js
    if (prevAnchorStart !== null && sourceMap && !activeView) {
```
(With `activeView` set, `setView`'s `releaseAnchor()` already nulled `lensState.anchor`, so `prevAnchorStart` is `null` in practice; the `!activeView` guard is belt-and-suspenders matching spec §5.10's "available only when no render mode is active.")

**Inert because:** `activeView` is permanently `null` for non-presentation kinds, so 3b's early-return is never hit and 3c's added conjunct is always `true` — both paths behave exactly as today.

---

## Step 4 — Seed: the `presentation` provider + present-mode CSS + the `@media print` lens-hide fix

**File:** `seeds/rewritable.html`

**4a. Define the provider.** Insert immediately **after** the `runtimeProvide`/`runtimeSetView`/`rwaViewKey`/`rwaSlideKey` block from Step 1:
```js

// ─── First-party 'presentation' view provider (spec §5.10) ──────────
// WRAP-IN-PLACE: split the doc on H1/H2 boundaries into <section class="rwa-slide">
// wrappers WITHOUT reordering. SECTION is NOT in ANCHORABLE_TAGS, and both
// ordinal walks recurse through non-anchorables counting only anchorables, so
// wrap-in-place is transparent to the source-map ordinals (kernel findings,
// render lens). data-rwa-id attributes ride along untouched (Invariant 8).
let rwaSlideCount = 0;
function rwaWrapIntoSlides(docHtml) {
  const tmp = document.createElement('div');
  tmp.innerHTML = docHtml;
  const art = tmp.querySelector('article') || tmp;
  const slides = [];
  let current = null;
  Array.from(art.childNodes).forEach(node => {
    const isHeading = node.nodeType === 1 && /^H[12]$/.test(node.tagName);
    if (isHeading || current === null) {
      current = document.createElement('section');
      current.className = 'rwa-slide';
      slides.push(current);
    }
    current.appendChild(node.cloneNode(true));
  });
  rwaSlideCount = slides.length;
  const wrapped = document.createElement('article');
  slides.forEach((s, i) => { if (i === 0) s.classList.add('active'); wrapped.appendChild(s); });
  return wrapped.outerHTML;
}
const presentationProvider = {
  kind: 'view',
  name: 'presentation',
  label: 'Present',
  render(doc /*, ctx */) { return rwaWrapIntoSlides(doc); },
  mounted(m /*, ctx */) {
    const secs = Array.from(m.querySelectorAll('.rwa-slide'));
    if (!secs.length) return;
    let idx = parseInt(sessionStorage.getItem(rwaSlideKey()) || '0', 10);
    if (!(idx >= 0 && idx < secs.length)) idx = 0;  // clamp (kernel findings: undo granularity)
    secs.forEach((s, i) => s.classList.toggle('active', i === idx));
    rwaUpdateSlideCounter(idx, secs.length);
  },
};
function rwaCurrentSlideIndex() {
  const m = document.getElementById('rwa-doc-mount');
  const secs = m ? m.querySelectorAll('.rwa-slide') : [];
  let i = 0; secs.forEach((s, n) => { if (s.classList.contains('active')) i = n; });
  return i;
}
function rwaGotoSlide(delta) {
  if (!activeView) return;
  const m = document.getElementById('rwa-doc-mount');
  const secs = Array.from(m ? m.querySelectorAll('.rwa-slide') : []);
  if (!secs.length) return;
  const i = Math.max(0, Math.min(secs.length - 1, rwaCurrentSlideIndex() + delta));
  secs.forEach((s, n) => s.classList.toggle('active', n === i));
  sessionStorage.setItem(rwaSlideKey(), String(i));
  rwaUpdateSlideCounter(i, secs.length);
}
function rwaUpdateSlideCounter(i, total) {
  const c = document.getElementById('rwa-view-count');
  if (c) c.textContent = (i + 1) + ' / ' + total;
}
```
**Inert because:** all declarations; `presentationProvider`/`rwaGotoSlide` are only reachable via Step 5's `PRODUCT_KIND`-gated registration and toggle wiring.

**4b. Present-mode CSS (screen) + lens-print fix.** In the CSS region. First, insert the **screen** slide rules immediately **before** the `@page{margin:18mm;}` line (line 169). Match:
```css
@page{margin:18mm;}
```
Insert before it:
```css
/* presentation render mode (spec §5.10) — screen only; print resets below.
   Inert for non-presentation containers: the .viewmode-presentation class is
   only ever added to #rwa-doc-mount when the presentation view is active. */
@media screen{
  #rwa-doc-mount.viewmode-presentation article{max-width:none;margin:0;padding:0;}
  #rwa-doc-mount.viewmode-presentation .rwa-slide{
    display:none;min-height:78vh;max-width:860px;margin:24px auto;padding:48px 56px;
    background:#fff;border:1px solid var(--gray-200);border-radius:18px;
    box-shadow:0 1px 3px rgba(0,0,0,.04);
  }
  #rwa-doc-mount.viewmode-presentation .rwa-slide.active{display:block;}
  #rwa-view-chrome{display:none;gap:6px;align-items:center;}
  #rwa-view-chrome.active{display:flex;}
  #rwa-view-chrome .count{font-family:var(--font-mono);font-size:11px;color:var(--gray-500);min-width:42px;text-align:center;}
}
```
Then, inside the existing `@media print{ … }` block (lines 170–182), add two rules. Match the first line of the print block:
```css
@media print{
  #rwa-runtime{display:none!important;}
```
Replace with:
```css
@media print{
  #rwa-runtime{display:none!important;}
  /* spec §5.10 / kernel-findings render lens: releaseAnchor() reparents the lens
     to <body>, escaping #rwa-runtime's transitive hide. Hide it explicitly so a
     printed deck (or any printed doc) never shows the lens. This is a
     pre-existing bug fix, correct for ALL kinds. */
  #rwa-lens{display:none!important;}
  #rwa-view-chrome{display:none!important;}
  #rwa-doc-mount.viewmode-presentation article{max-width:720px;margin:0 auto!important;padding:0!important;}
  #rwa-doc-mount.viewmode-presentation .rwa-slide{all:unset;display:block;break-inside:avoid;margin:0 0 18px;}
```
**Inert because:** every screen rule is scoped under `.viewmode-presentation`, a class never present on non-presentation mounts; the new print rules are likewise `.viewmode-presentation`-scoped except `#rwa-lens{display:none}`, which is a correct, kind-agnostic fix (the lens should never print for any document).

---

## Step 5 — Seed: `PRODUCT_KIND==='presentation'` conditional registration/activation + chrome + `SYSTEM_PROMPTS['presentation']`

**File:** `seeds/rewritable.html`

**5a. View chrome + toggle, built only for presentation.** This must be wired without polluting `buildUI` for other kinds. Add a `syncViewChrome` helper and a kind-gated wiring function. Insert immediately **after** the provider block from Step 4:
```js

// ─── Presentation chrome (toggle + nav), built ONLY for PRODUCT_KIND === 'presentation' ───
function syncViewChrome() {
  const toggle = document.getElementById('rwa-view-toggle');
  const chrome = document.getElementById('rwa-view-chrome');
  if (!toggle || !chrome) return;
  const on = activeView !== null;
  toggle.classList.toggle('on', on);
  toggle.textContent = on ? 'Prose' : (providers.view ? providers.view.label : 'Present');
  chrome.classList.toggle('active', on);
}
function rwaInstallPresentationChrome() {
  // Append a view-chrome group + toggle into the existing #rwa-set status bar.
  const set = document.getElementById('rwa-set');
  if (!set) return;
  const chrome = document.createElement('span');
  chrome.id = 'rwa-view-chrome';
  chrome.innerHTML =
    '<button class="rwa-st-btn" id="rwa-view-prev" title="Previous slide" aria-label="previous slide">&larr;</button>' +
    '<span class="count" id="rwa-view-count">1 / 1</span>' +
    '<button class="rwa-st-btn" id="rwa-view-next" title="Next slide" aria-label="next slide">&rarr;</button>';
  const toggle = document.createElement('button');
  toggle.className = 'rwa-st-btn';
  toggle.id = 'rwa-view-toggle';
  toggle.textContent = 'Present';
  set.insertBefore(chrome, set.firstChild);
  set.insertBefore(toggle, chrome.nextSibling);
  toggle.addEventListener('click', () => runtimeSetView(activeView ? null : 'presentation'));
  document.getElementById('rwa-view-prev').addEventListener('click', () => rwaGotoSlide(-1));
  document.getElementById('rwa-view-next').addEventListener('click', () => rwaGotoSlide(+1));
  document.addEventListener('keydown', (e) => {
    if (!activeView) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); rwaGotoSlide(+1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); rwaGotoSlide(-1); }
  });
}
```
> The chrome `.rwa-st-btn`/`#rwa-view-*` styling reuses existing status-bar button classes; the `#rwa-view-chrome .count` and `.active` display rules come from Step 4b's `@media screen` block.

**5b. Conditional bootstrap registration/activation.** In the bootstrap IIFE, match (line 3724):
```js
    renderDoc(doc);
    scrollToFragment();
    setStatus('ok', '● ready');
```
Replace with:
```js
    // §5.10 + spec version note: the presentation render mode ships ONLY for
    // presentation containers. For every other kind this block is skipped
    // entirely — activeView stays null, no provider is registered, no chrome
    // is built, and renderDoc takes its byte-identical default branch.
    if (PRODUCT_KIND === 'presentation') {
      runtimeProvide('view', presentationProvider);   // register; does not activate
      rwaInstallPresentationChrome();
      const persisted = sessionStorage.getItem(rwaViewKey());
      if (persisted === 'presentation' && providers.view) {
        activeView = providers.view;                  // restore BEFORE first render (§5.10)
      }
      syncViewChrome();
    }
    renderDoc(doc);
    scrollToFragment();
    setStatus('ok', '● ready');
```

**5c. Expose `provide`/`setView` on `window.runtime`.** In the `window.runtime = { … }` literal (lines 3694–3715), match:
```js
      applyEnvelope: runtimeApplyEnvelope,
      on:     runtimeOn,
    };
```
Replace with:
```js
      applyEnvelope: runtimeApplyEnvelope,
      on:     runtimeOn,
      provide: runtimeProvide,   // spec §5.10 — register a view provider
      setView: runtimeSetView,   // spec §5.10 — activate/deactivate a render mode
    };
```
**Inert because:** adding two members to the plain (non-frozen) `window.runtime` literal does not change any existing member or behavior; they are only *invoked* by Step 5b's `PRODUCT_KIND`-gated block. A `document`/`workflow` container exposes `runtime.provide`/`runtime.setView` but never calls them, and calling `setView('presentation')` would throw `no registered view` (nothing registered) — i.e., harmless and explicit, never silently mutating render.

**5d. Add the `SYSTEM_PROMPTS['presentation']` entry.** In the `SYSTEM_PROMPTS` object (between the `rwa:extract:begin`/`end` markers, lines 1449–1565), match the `workflow:` entry's closing and the object close:
```js
${SYSTEM_PROMPT_RULES}`,
};
// rwa:extract:end SYSTEM_PROMPTS
```
Replace with (insert the `presentation` entry before the closing brace, inside the markers):
```js
${SYSTEM_PROMPT_RULES}`,

  presentation: `You are editing a rewritable HTML document that is presented as a slide deck. Apply the user's request as a small set of surgical edits via tool calls.

The stored document is ordinary prose HTML inside a single <article>: <h1>/<h2> headings, <p> paragraphs, lists, etc. The runtime DISPLAYS it as slides by wrapping the content at each <h1>/<h2> boundary into a slide — but that wrapping is display-only and you NEVER see it. You only ever receive and edit the stored prose. Do NOT emit <section>, slide wrappers, or any slide-specific markup; just edit the headings and prose.

Slide model the user reasons about: a new slide STARTS at each <h1> or <h2>. So "add a slide" = add a new <h2> (a short title) followed by its body paragraphs/bullets, inserted at the right position. "Split this slide" = add an <h2> in the middle. "Merge two slides" = remove the second slide's heading. "Reorder slides" = move the heading-plus-its-body block. Keep slide bodies concise — a deck slide is a title plus a few short paragraphs or a short list, not an essay.

Preserve every existing data-rwa-id verbatim (the runtime assigns them). Anchor edits on unique text near the heading you mean.
${SYSTEM_PROMPT_RULES}`,
};
// rwa:extract:end SYSTEM_PROMPTS
```
**Inert because:** `SYSTEM_PROMPT = SYSTEM_PROMPTS[PRODUCT_KIND] || SYSTEM_PROMPTS.document` (line 1567) selects `presentation` only when `PRODUCT_KIND === 'presentation'`; for other kinds the key is never read. The `rwa:extract` markers still bound the whole object, so `cli/src/seed-extract.mjs` continues to parse it (the new entry is inside the markers).

---

## Step 6 — CLI four sites: `KIND_TABLE` entry, help, README

**File:** `/Users/martintreiber/Documents/Development/rewritable/cli/src/seed.mjs`

**6a. Add the starter slide-deck body + lens copy + header.** Insert before `const KIND_TABLE = {` (line 1286):
```js
const KIND_PRESENTATION_LENS = 'Add a slide, or describe a change.';
const KIND_PRESENTATION_PAL  = 'edit this deck...';

const KIND_PRESENTATION_HEADER = `// === PRODUCT HEADER ===
// Product: presentation (substrate layer, render mode).
// The stored document is ordinary prose HTML — one <article> of <h1>/<h2>
// headings and prose. A first-party 'view' provider (bootstrap-resident,
// spec §5.10) DISPLAYS it as a slide deck by wrapping content at each
// <h1>/<h2> boundary into a <section class="rwa-slide"> at render time. The
// wrapping is display-only: it never reaches rwa_doc, never the agent
// (Invariants 8-9). Toggle 'Present' in the status bar to activate; arrow
// keys / PageUp-Down navigate. Printing renders the deck as a linear
// document. See docs/specs/rwa-product-types.md.
// === END PRODUCT HEADER ===`;

// Real starter content (CLAUDE.md: never lorem ipsum). Three slides keyed on
// h1/h2 boundaries — title, the rewrite loop, one-substrate-many-views.
const KIND_PRESENTATION_BODY = `<article>
<h1>re-write-able</h1>
<p>A single self-contained <code>.html</code> file that renders, stores, edits, and exports itself — no server, no build step.</p>
<p>One file is the whole application and the whole archive.</p>

<h2>The rewrite loop</h2>
<p>Press the lens. Hand the document to a model. Get back surgical edits on unique anchors, committed atomically, then re-render.</p>
<p>The bootstrap never moves; only the inline document snapshot changes between commits.</p>

<h2>One substrate, many views</h2>
<p>The same prose can render as a document or — through a registered view provider — as this slide deck.</p>
<p>The view is a pure re-presentation at render time; the bytes on disk never change shape.</p>
</article>`;
```

**6b. Add the `presentation` entry to `KIND_TABLE`.** Match (lines 1300–1303):
```js
    lensClickToAnchor: false,  // audit R3 scoped — workflow stages are <li>-anchorable
  },
  // app, workspace: reserved — wire when the templates land. The CLI rejects
  // unknown kinds explicitly rather than silently emitting a document.
};
```
Replace with:
```js
    lensClickToAnchor: false,  // audit R3 scoped — workflow stages are <li>-anchorable
  },
  presentation: {
    body: KIND_PRESENTATION_BODY,
    lensPlaceholder: KIND_PRESENTATION_LENS,
    palPlaceholder: KIND_PRESENTATION_PAL,
    productHeader: KIND_PRESENTATION_HEADER,
    // Whole-deck lens semantics: clicking a slide should not anchor the lens
    // on a paragraph. Mirrors the workflow stance (kernel findings: providers
    // are NOT wired into KIND_TABLE — the provider CODE is bootstrap-resident;
    // this kind only sets PRODUCT_KIND + starter/framing/lens/click-to-anchor).
    lensClickToAnchor: false,
  },
  // app, workspace: reserved — wire when the templates land. The CLI rejects
  // unknown kinds explicitly rather than silently emitting a document.
};
```
> Per kernel findings §4 item 6: do **not** add a `providers[]` field to `KIND_TABLE`. The CLI's only job for `presentation` is the existing six-region substitution (`PRODUCT_KIND` becomes `'presentation'` via the existing `PRODUCT_KIND_RE` path, `lensClickToAnchor:false`, body/lens/header). The provider lives in the seed. `applySeedSubs` already handles all six regions; no signature change.

**File:** `/Users/martintreiber/Documents/Development/rewritable/cli/bin/rwa.mjs`

**6c. Update help text.** Match (lines 24–25):
```
  --kind <name>  (new only) starter kind: document (default) or workflow.
                 'document' is the canonical prose container — substrate
                 layer. 'workflow' scaffolds three stages (Inbox / In
                 progress / Done) and swaps the lens placeholder for the
                 workflow framing. See docs/specs/rwa-product-types.md.
```
Replace with:
```
  --kind <name>  (new only) starter kind: document (default), workflow, or
                 presentation. 'document' is the canonical prose container.
                 'workflow' scaffolds three stages (Inbox / In progress /
                 Done). 'presentation' scaffolds a prose deck that the
                 'Present' toggle displays as slides (split on h1/h2). See
                 docs/specs/rwa-product-types.md.
```
> Validation at lines 470–474 reads `KNOWN_KINDS` from `seed.mjs`, which now includes `presentation` automatically (`Object.keys(KIND_TABLE)`). No code edit needed there.

**File:** `/Users/martintreiber/Documents/Development/rewritable/cli/README.md`

**6d. Document the kind.** Match (README line ~37):
```
- `--kind workflow` — three-stage scaffold (Inbox / In progress / Done); lens placeholder *"Add an item, or describe a stage move."*
```
Insert after it:
```
- `--kind presentation` — prose slide deck (split on `h1`/`h2`); the *Present* toggle renders it as slides at view time without changing the stored text; lens placeholder *"Add a slide, or describe a change."*
```

---

## Step 7 — References: regenerate from the changed seed

The seed bootstrap bytes changed (Steps 1–5), so `hello.html` and `re-write-able-spec.html` must re-share it. Both stay `PRODUCT_KIND === 'document'` and so remain behaviorally identical, but their FROZEN bootstrap bytes update.

**Command (run from repo root):**
```
node tools/regenerate-refs.mjs
```
This preserves each reference's own `DOC_UUID`, `RWA.FILE`, and `INLINE_DOC` body, swapping only the seed's bootstrap. Per CLAUDE.md "References — regeneration flow," do not hand-edit the references. (The spec version note at `re-write-able-spec.md:665` says the contract-only revision did *not* regenerate references; this follow-on revision implementing §5.10 **does** regenerate them, since the bootstrap bytes now change.)

---

## Step 8 — Tests

Two new jsdom test files plus assertions, all running the still-`document` seed for inertness and a `presentation`-substituted seed for behavior. Add them as benchmark conformance scenarios (auto-discovered) plus a lens-style jsdom test.

**8a. New conformance scenarios** in `/Users/martintreiber/Documents/Development/rewritable/benchmark/scenarios/conformance/` (each default-exports `{ id, description, category:'VIEW', weight, async run({ harness, expectRwaError }) }`, returns `{ pass, reason }`, uses `harness.fresh()` then `ctx.dispose()`). These run against the default seed harness loads (`document` kind), so they exercise the API surface on a non-presentation container — which also proves inertness of the registry:

- **VIEW-01 — output never read into `rwa_doc`.** `runtime.provide('view', {kind:'view',name:'presentation',label:'Present',render:d=>'<article><section class="rwa-slide">'+d+'</section></article>'})`; `runtime.setView('presentation')`; await a microtask; assert `mount.innerHTML` contains `rwa-slide` AND `await ctx.getDoc()` (i.e. `rwa_doc`) contains **no** `rwa-slide`. (Spec Invariant 8.)
- **VIEW-02 — agent source has no slide wrappers while presenting.** With the view active, read `window.getSourceMap()`/the exposed `currentDocCache` via a test seam, assert it contains no `rwa-slide` and equals the stored doc text. (Invariant 9 / §5.10 clause 2.) If `currentDocCache` is not already exposed, add a jsdom-only `window.__currentDocCache = () => currentDocCache;` test seam next to the existing `window.getSourceMap` export.
- **VIEW-03 — `setView` refused during modify.** Set `window.modifyMutex`? It is not exposed; instead acquire it via a real in-flight modify is heavy — simpler: expose a jsdom-only seam `window.__setModifyMutex = v => { modifyMutex = v; }` guarded by the same `/jsdom/i` check used at line 2128. Set it true, call `runtime.setView('presentation')`, assert `activeView` unchanged (view did not activate; status shows refusal). Reset. (Spec §5.10 activation / kernel findings F7.)
- **VIEW-04 — `data-rwa-id` preserved through render.** Provide a wrap-in-place view; activate; assert every `data-rwa-id` present in the stored doc is present in `mount.querySelectorAll('[data-rwa-id]')`. (§5.10 clause 3.)
- **VIEW-05 — reserved-id rejected.** `setView` with a provider whose `render` returns `<div id="rwa-lens"></div>` must throw (or `setView`/`provide`-time validate). Use `expectRwaError`-style try/catch asserting the throw mentions `reserved id`. (§5.10 clause 4.) Also assert a `data-rwa-frozen`/`rwa:frozen:begin` marker in output throws.
- **VIEW-06 — no-`<script>` assertion.** A provider whose `render` returns `<script>…</script>` must throw at render time mentioning the script contract. (§5.10 clause 5.)
- **VIEW-07 — inert when no view registered.** On a fresh default container with no `provide` call, assert `window.runtime.provide` and `window.runtime.setView` are functions, `mount` carries no `viewmode-presentation` class, and `getDoc()` round-trips byte-for-byte through a normal `applyEdits` (i.e. existing behavior unchanged). This is the explicit inertness scenario.

**8b. Presentation-kind jsdom test** — a new harness path that loads a seed with `PRODUCT_KIND` substituted to `'presentation'` and the presentation `INLINE_DOC` body (use `cli/src/seed.mjs` `applySeedSubs` + `replaceInlineDoc` with `kindOverrides('presentation')` to build the bytes, then load in jsdom — mirroring `tests/e2e.mjs`'s load at line 26). Assertions:
- **present-mode renders ≥3 slides:** after bootstrap, `runtime.setView('presentation')`, await microtask, assert `mount.querySelectorAll('.rwa-slide').length >= 3` and the deck's starter content yields exactly 3 (title + 2 `<h2>`).
- **undo/commit work with a view active:** with the view active, run a `window.modify`-stubbed edit (stub `fetchHandler` to return an `apply_edits` renaming a heading), assert it commits to `rwa_doc` (no slide wrappers in stored bytes), `mount` re-derives slides via `mounted()`, then `window.undo()` restores and the deck still renders. (Spec Invariant 8 under the edit path; kernel findings undo-granularity clamp.)
- **toggle round-trip:** `setView('presentation')` then `setView(null)` returns `mount` to no `viewmode-presentation` class and re-wires the click listener (assert `activeView === null`).

Wire 8b under `tests/package.json` as a new script, e.g. `"test:view": "node view.mjs"` (mirroring `test:lens`), and create `tests/view.mjs`.

**8c. Tests must encode WHY (CLAUDE.md Rule 9):** each assertion's `reason` string names the spec clause it protects (e.g. `"Invariant 8: render output must never reach rwa_doc"`), so a regression that, say, reassigns `setSourceMap(mountHtml)` fails VIEW-02 with a business-meaning message, not just a diff.

---

## Commands that MUST pass (SUCCESS CRITERIA)

1. **Conformance 42/42 + new VIEW scenarios green** — `cd benchmark && npm install && npm run conformance` prints `(42 + N) / (42 + N) conformance scenarios passing` (the original 42 unchanged → proves inertness for the `document`-kind seed; new VIEW-01..07 green).
2. **jsdom modify-pathway green** — `cd tests && npm install && npm test` (e2e.mjs unchanged → bootstrap APIs `window.modify`/`applyEdits`/`replaceDocument` still present and behaving).
3. **New view tests green** — `cd tests && npm run test:view` (presentation-kind behavior + toggle/undo/commit).
4. **Lens tests green** — `cd tests && npm run test:lens` (proves Step 2c's `!activeView` click-listener change is inert for the default kind).
5. **References regenerated** — `node tools/regenerate-refs.mjs` runs clean; `git diff hello.html re-write-able-spec.html` shows only bootstrap-byte updates, identical `DOC_UUID`/`INLINE_DOC`/`FILE`.
6. **CLI kind round-trips** — `node cli/bin/rwa.mjs new --kind presentation /tmp/deck.html` succeeds; the emitted file has `const PRODUCT_KIND = 'presentation';`, `const LENS_CLICK_TO_ANCHOR = false;`, the presentation header, and the 3-slide `INLINE_DOC` body; opening it in a browser and clicking **Present** shows ≥3 slides; `node cli/bin/rwa.mjs new --kind document /tmp/doc.html` is byte-identical bootstrap to before this change except for the additive view subsystem.

---

## Key files (absolute paths)

- Seed (all of Steps 1–5): `/Users/martintreiber/Documents/Development/rewritable/seeds/rewritable.html`
- CLI kind table + body/header: `/Users/martintreiber/Documents/Development/rewritable/cli/src/seed.mjs`
- CLI help: `/Users/martintreiber/Documents/Development/rewritable/cli/bin/rwa.mjs`
- CLI docs: `/Users/martintreiber/Documents/Development/rewritable/cli/README.md`
- Reference regen tool: `/Users/martintreiber/Documents/Development/rewritable/tools/regenerate-refs.mjs`
- Conformance scenarios dir: `/Users/martintreiber/Documents/Development/rewritable/benchmark/scenarios/conformance/`
- jsdom harnesses: `/Users/martintreiber/Documents/Development/rewritable/tests/e2e.mjs`, `/Users/martintreiber/Documents/Development/rewritable/tests/lens.mjs`, new `/Users/martintreiber/Documents/Development/rewritable/tests/view.mjs`, `/Users/martintreiber/Documents/Development/rewritable/tests/package.json`
- Spec contract: `/Users/martintreiber/Documents/Development/rewritable/re-write-able-spec.md` §5.10 + Invariants 8–9 (already landed; no edit)

## Risks folded into the plan (from the localization map + kernel findings)

- **`setSourceMap` must get the stored text, not the view output** — Step 2b keeps line 866 on `html`; VIEW-02 enforces it. This is the single highest-risk one-keystroke regression (the idiomatic `html = render(html)` reassignment) the kernel findings flagged; the plan keeps `html` and `mountHtml` as distinct locals.
- **Form-state capture/restore** (lines 843–861) runs before the seam and is unaffected; the `presentation` provider's `render` is wrap-in-place so all id-keyed elements survive (§5.10 clause 3 / VIEW-04). The PoC's F3 contract is encoded as VIEW-04.
- **Click-to-anchor ordinal mapping** stays valid: `SECTION ∉ ANCHORABLE_TAGS` and both ordinal walks recurse through non-anchorables, so wrap-in-place does not desync ordinals; the listener is additionally removed while a view is active (Step 2c).
- **Anchored-modify re-anchor against rearranged DOM** — gated on `activeView === null` in `runAnchoredCommand` (3b) and `synthesizeAndCommit` (3c), per the kernel BLOCKER ("suspend the click listener alone is insufficient").
- **`modifyMutex` no-timeout / `window.runtime` not frozen** — out of scope; the plan adds members to the existing non-frozen literal (Step 5c) and guards `setView` with the same `modifyMutex` check `undo` uses, matching spec §5.10. No new deadlock surface.
- **Undo granularity / slide-index drift** — `mounted()` clamps the restored index to `[0, slideCount-1]` (Step 4a), per the kernel write-path minor finding.

---

## Review fixes folded into execution (adversarial pass, 5 confirmed)

The localize→plan→review workflow confirmed the inertness theorem against actual
code (renderDoc default path byte-identical; provide/setView cannot throw at
bootstrap for non-presentation kinds; click-anchor and anchored-modify gates are
no-ops; SNAPSHOT byte-identity survives). It also confirmed 5 blocker/major issues,
all plan-detail. Resolutions applied during execution:

1. **[blocker+major] `validateViewOutput` was dead code** — defined but never called,
   so §5.10 clause 4 (reserved-id / frozen-marker / no-`<script>`) was unenforced and
   VIEW-05/06 could not pass. **Fix:** the render seam (Step 2a) calls
   `validateViewOutput` (which wraps `sanitizeViewOutput` + reserved-id/marker scan),
   not bare `sanitizeViewOutput`; AND `runtimeSetView`'s non-null branch
   probe-validates `spec.render(currentDocCache, viewCtx())` **synchronously before**
   setting `activeView`, so a bad provider throws catchably and never activates.

2. **[major] §5.10 clause 3 — off-slide fragment scroll** — `presentation` hides
   inactive slides with `display:none`, so `scrollToFragment` cannot scroll to a
   `data-rwa-id` on a non-active slide. **Fix:** when `activeView` is set, resolve the
   hash target to its containing `.rwa-slide`, activate that slide (update counter),
   then `scrollIntoView`; wire this into both `scrollToFragment` and the `hashchange`
   handler.

3. **[major] VIEW-02 asserted on `getSourceMap()` as if it were the doc text** — it
   returns a position-map object. **Fix:** add a `/jsdom/i`-gated
   `window.__currentDocCache = () => currentDocCache;` seam next to the existing
   `window.getSourceMap` export; VIEW-02 asserts `__currentDocCache() === storedDocText`
   and contains no `rwa-slide`.

4. **[major] tests read module-scoped `activeView` (never exposed)** — VIEW-03 and the
   toggle round-trip were unauthorable. **Fix:** assert via the DOM-observable proxy
   (`#rwa-doc-mount.viewmode-presentation` class and `#rwa-view-chrome.active`) where
   possible; add a `/jsdom/i`-gated `window.__activeViewName = () => activeView ? activeView.name : null;`
   seam for VIEW-03 / the modify-refusal test.

5. **[minor→split] the `@media print { #rwa-lens{display:none} }` fix is unrelated to
   the render-mode feature** (the lens reparents to `<body>` and can print on any
   document). **Fix:** land it as its own small commit *before* the feature, framed as
   the pre-existing-bug fix it is.

Also folded: the success criterion is "(42 + N)/(42 + N) green," not "42/42" (the
runner counts discovered scenarios — adding VIEW-01..07 raises the total); the print
fixtures in `benchmark/scenarios/print/generate.mjs` may need regeneration once the
`#rwa-lens` print rule lands (checked during execution).
