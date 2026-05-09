# Lens Edit Model Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Spec:** `docs/specs/rwa-lens-spec.md` (v0.9). If not present yet, copy the v0.9 spec from the conversation that produced this plan into that path before starting Phase 0.

**Goal:** Replace the modal `⌘K` prompt in `seeds/rewritable.html` with a single steerable input — the *lens* — that has two states (default, anchored) and discriminates content from instruction via a leading slash. Every gesture compiles to an existing rwa-edit/1 envelope; no new edit protocol.

**Architecture:** All work lives inside the runtime block of `seeds/rewritable.html`. The lens is added as new functions and DOM nodes; existing `applyEdits` / `replaceDocument` / `modify` machinery is preserved and reused. A new in-memory *source-position map* bridges DOM clicks to `rwa_doc` source ranges. Class-declared locks (`class="rwa-locked"`) extend the existing frozen-zone enforcement.

**Tech Stack:** Vanilla JS in a single `.html` (no build step, no framework). Tests live in `tests/` (jsdom + fake-indexeddb).

**Reference invariants (from the spec):**
- Every lens gesture compiles to a valid rwa-edit/1 envelope. The lens does not bypass the protocol.
- Direct text in any state produces additions, not replacements (byte-identical pre-existing body).
- Slash commands in anchored state modify only the anchored block (byte-identical outside).
- `rwa_undo` and `rwa_hist` are not serialized into the inline snapshot.
- Plain Enter is always a newline; ⌘Enter is always submit.
- The lens has exactly two states (default, anchored). No third state.
- The source-position map is in-memory and ephemeral — built at parse/render time, rebuilt after each successful commit, never persisted.

**Critical files (read these first):**
- `seeds/rewritable.html` — the runtime; everything new goes here.
  - `buildUI` (~L242) — where the lens DOM gets mounted.
  - `modify` (~L964) — the multi-turn loop the lens reuses for slash commands.
  - `applyEdits` / `replaceDocument` (~L666 / L729) — envelope validation; class-declared lock check is added here.
  - `SYSTEM_PROMPT` (~L322), `TOOL_SCHEMAS` (~L355), `buildUserPrompt` (~L948) — agent prompt; augmented for `.rwa-locked` and the anchored variant.
  - `extractFrozenZones`, `frozenZonesIntact` (~L513, L545) — extended to recognize `.rwa-locked` zones.
  - `commitDoc` (~L639) — history record shape; extended with `surface` / `instruction` / `scope`.
- `tests/e2e.mjs` — test harness pattern; new `tests/lens.mjs` mirrors it.
- `rwa-edit-spec.md` §4–§9 — the envelope rules the lens must respect.
- `CLAUDE.md` — repo conventions; in particular, the seed is the source of truth and the references (`hello.html`, `re-write-able-spec.html`) get regenerated from it.

**TDD discipline:** Every task pairs a failing test with a minimal implementation. Skip the test only when noted ("UI / visual" tasks). Commit after every task.

**Phase ordering rationale:** The source-position map is the foundation — every anchor path depends on it. Then default-state direct text (the simplest envelope path), then default-state slash (reuses existing `modify`), then anchored state, then locks, then history extension, then UI polish. Each phase produces a working slice; the lens is usable from end of Phase 3 onward, with capabilities accreting.

---

## Phase 0: Test harness setup

### Task 0.1: Create lens-specific test file

**Files:**
- Create: `tests/lens.mjs`
- Modify: `tests/package.json` (add `"test:lens"` script)

**Step 1: Bootstrap a copy of `tests/e2e.mjs`'s harness scaffolding into `tests/lens.mjs`**

Read `tests/e2e.mjs` lines 1-77 (imports, jsdom setup, fetchHandler stub, virtualConsole) and copy into `tests/lens.mjs`. Replace the `console.log('== Bootstrap loaded ==')` line and what follows with:

```javascript
console.log('== Lens harness loaded ==');
// Tests appended below per phase.
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
```

**Step 2: Add `test:lens` script to `tests/package.json`**

```json
"scripts": {
  "test": "node e2e.mjs",
  "test:lens": "node lens.mjs"
}
```

**Step 3: Verify the harness boots without error**

Run: `cd tests && npm run test:lens`
Expected: prints `== Lens harness loaded ==` and `0 pass, 0 fail`, exits 0.

**Step 4: Commit**

```bash
git add tests/lens.mjs tests/package.json
git commit -m "test(lens): scaffold lens-specific e2e harness"
```

---

## Phase 1: Source-position map

The map is the bridge between DOM clicks and `apply_edits` envelopes (spec §5.5, invariant 11). Every later anchored-mode task depends on it.

### Task 1.1: Define the anchorable set

**Files:**
- Modify: `seeds/rewritable.html` (add a new top-level constant near `RWA` at ~L81)

**Step 1: Write a failing test in `tests/lens.mjs`**

Append:

```javascript
// === Phase 1: source-position map ===
console.log('\n== Test L1.1: anchorable-set membership ==');
check('ANCHORABLE_TAGS includes p, h1-h6, blockquote, li, figure, pre, aside',
  ['P','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','LI','FIGURE','PRE','ASIDE']
    .every(t => window.ANCHORABLE_TAGS.has(t)));
check('ANCHORABLE_TAGS excludes hr, ul, ol, dl, dt, dd',
  ['HR','UL','OL','DL','DT','DD'].every(t => !window.ANCHORABLE_TAGS.has(t)));
```

**Step 2: Run, expect FAIL** (`window.ANCHORABLE_TAGS` is undefined).

Run: `cd tests && npm run test:lens`

**Step 3: Add the constant in `seeds/rewritable.html` just before the `RWA` constant (~L80)**

```javascript
const ANCHORABLE_TAGS = new Set(['P','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','LI','FIGURE','PRE','ASIDE']);
window.ANCHORABLE_TAGS = ANCHORABLE_TAGS; // expose for tests
```

(The `window.` line stays for tests; production callers use the local binding.)

**Step 4: Run, expect PASS.**

**Step 5: Commit**

```bash
git add seeds/rewritable.html tests/lens.mjs
git commit -m "feat(lens): define anchorable tag set"
```

### Task 1.2: Build the source-position map

**Files:**
- Modify: `seeds/rewritable.html` (add `buildSourcePositionMap` function near other parsing helpers ~L559)

**Step 1: Write a failing test**

Append to `tests/lens.mjs`:

```javascript
console.log('\n== Test L1.2: source-position map basic ==');
{
  const doc = '<p>Alpha</p>\n<p>Beta</p>\n<h2>Gamma</h2>';
  const map = window.buildSourcePositionMap(doc);
  check('map is an array of 3 entries', Array.isArray(map) && map.length === 3);
  check('first entry covers <p>Alpha</p>',
    doc.slice(map[0].start, map[0].end) === '<p>Alpha</p>');
  check('second entry covers <p>Beta</p>',
    doc.slice(map[1].start, map[1].end) === '<p>Beta</p>');
  check('third entry covers <h2>Gamma</h2>',
    doc.slice(map[2].start, map[2].end) === '<h2>Gamma</h2>');
  check('each entry has tag', map.every(e => typeof e.tag === 'string'));
  check('each entry has node reference', map.every(e => e.node && e.node.tagName));
}
```

**Step 2: Run, expect FAIL.**

**Step 3: Implement `buildSourcePositionMap` in `seeds/rewritable.html`** (insert just after `parseHtmlFragment` at ~L573)

The implementation strategy: use the existing DOMParser to get the parsed tree, then walk both the source string and the parsed tree in lockstep. For each anchorable element, find its source range by string-searching for its serialized form *with normalization fallback* (the spec §5.5 explicitly lists this as a viable approach).

The simpler v1 approach: walk the parsed tree, and for each anchorable element, use a small offset-tracking re-parse via regex on the source. Since anchorable blocks are top-level-ish in prose docs and HTML5 syntax for the tags is regular enough, a tag-bracket scan suffices.

```javascript
// Build a source-position map: an array of { tag, start, end, node } for every
// anchorable element in `doc`, in source order. The recorded [start, end) slice of
// `doc` equals that element's source-form content (invariant 11). Walk the source
// with a tag scanner; on hitting an opening tag for an anchorable type, find its
// matching close tag honoring nesting. Skip CDATA-like containers (script, style)
// since prose docs don't anchor inside them.
function buildSourcePositionMap(doc) {
  const map = [];
  // Parse once to attach node references in source order.
  const parsed = new DOMParser().parseFromString(`<body>${doc}</body>`, 'text/html');
  const nodesInOrder = [];
  (function walk(el) {
    for (const child of el.children) {
      if (ANCHORABLE_TAGS.has(child.tagName)) nodesInOrder.push(child);
      walk(child);
    }
  })(parsed.body);

  // Source scan: for every anchorable opening tag found in source order,
  // find its end via balanced tag matching.
  const tagOpen = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  let nodeIdx = 0;
  let m;
  while ((m = tagOpen.exec(doc)) !== null) {
    const tag = m[1].toUpperCase();
    if (!ANCHORABLE_TAGS.has(tag)) continue;
    const start = m.index;
    // Self-closing? Bare void-like? Anchorable set has no void tags, so always look for end.
    const end = findCloseTagEnd(doc, tag, m.index + m[0].length);
    if (end < 0) continue;
    const node = nodesInOrder[nodeIdx++] || null;
    map.push({ tag, start, end, node });
    tagOpen.lastIndex = end; // skip past nested anchorables already inside; they're separate entries via outer walk
  }
  return map;
}

// Find the end position (exclusive) of the closing tag matching `tag`, starting
// scan at `from`. Returns -1 if not found. Honors nested same-tag pairs.
function findCloseTagEnd(doc, tag, from) {
  const re = new RegExp(`<(\\/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = from;
  let depth = 1, m;
  while ((m = re.exec(doc)) !== null) {
    if (m[1] === '/') {
      depth--;
      if (depth === 0) return m.index + m[0].length;
    } else {
      depth++;
    }
  }
  return -1;
}

window.buildSourcePositionMap = buildSourcePositionMap; // expose for tests
```

**Important caveat:** the regex scanner above resets `tagOpen.lastIndex = end` after each anchorable; this means *nested* anchorables inside another anchorable (e.g., `<li>` inside `<ul>` inside `<aside>`) are not double-counted. But it also means `<li>` items inside a `<ul>` inside the document body get handled by the inner pass differently than I described. Re-think on the test failure.

If the test fails for nested cases, replace the scan with a nodes-first approach: walk `nodesInOrder`, and for each, find its source range by string-searching for its `outerHTML`-like signature. (The full implementation strategy is in the spec §5.5 "Source mapping" — implementer's choice between scanner and lockstep walk; both are valid as long as invariant 11 holds.)

**Step 4: Run, expect PASS** for the basic case. If nested cases fail, iterate: switch to the nodes-first approach noted above.

**Step 5: Add nested-case test**

```javascript
console.log('\n== Test L1.2b: source-position map with nested li ==');
{
  const doc = '<p>Intro</p>\n<ul>\n  <li>One</li>\n  <li>Two</li>\n</ul>\n<p>Outro</p>';
  const map = window.buildSourcePositionMap(doc);
  const tags = map.map(e => e.tag);
  check('map contains P, LI, LI, P (in order, no UL)',
    JSON.stringify(tags) === JSON.stringify(['P','LI','LI','P']));
  check('first LI has correct source slice',
    doc.slice(map[1].start, map[1].end) === '<li>One</li>');
}
```

**Step 6: Run; iterate the implementation until both tests pass.**

**Step 7: Commit**

```bash
git add seeds/rewritable.html tests/lens.mjs
git commit -m "feat(lens): build source-position map for anchorable elements"
```

### Task 1.3: Map invariant test

**Files:**
- Modify: `tests/lens.mjs`

**Step 1: Add an invariant test that walks every entry in the map**

```javascript
console.log('\n== Test L1.3: source-position map invariant 11 ==');
{
  const doc = '<h1>Title</h1>\n<p>One.</p>\n<blockquote><p>Quoted.</p></blockquote>\n<aside>Side.</aside>';
  const map = window.buildSourcePositionMap(doc);
  for (const e of map) {
    const slice = doc.slice(e.start, e.end);
    check(`invariant 11 holds for ${e.tag}: slice equals expected source form`,
      slice.startsWith(`<${e.tag.toLowerCase()}`) && slice.endsWith(`</${e.tag.toLowerCase()}>`));
  }
}
```

**Step 2: Run, expect PASS.**

**Step 3: Commit**

```bash
git add tests/lens.mjs
git commit -m "test(lens): assert source-position map invariant 11"
```

### Task 1.4: Map lifetime — ephemeral, rebuilt on commit

**Files:**
- Modify: `seeds/rewritable.html` — add a module-level `let sourceMap = null;` and a `rebuildSourceMap()` helper near `renderDoc` (~L192). Wire `commitDoc` (~L639) and `renderDoc` to call it.

**Step 1: Write a test that asserts the map is rebuilt after commit**

```javascript
console.log('\n== Test L1.4: source-position map lifetime ==');
{
  // Initial map (from current rwa_doc)
  const doc1 = await window.getDoc();
  const map1 = window.getSourceMap();
  check('map exists after bootstrap', Array.isArray(map1) && map1.length > 0);

  // Stub the agent to insert a new <p> at end via apply_edits.
  fetchHandler = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { role: 'assistant', content: '', tool_calls: [{
        id: 'm1', type: 'function',
        function: { name: 'apply_edits', arguments: JSON.stringify({
          version: 'rwa-edit/1',
          edits: [{ find: 'Hello, world.', replace: 'Hello, world.</p>\n<p>Added.' }]
        })}
      }]}}]
    })
  });
  await window.modify('add a paragraph');
  await new Promise(r => setTimeout(r, 100));

  const map2 = window.getSourceMap();
  const doc2 = await window.getDoc();
  check('map rebuilt after commit', map2 !== map1);
  check('map reflects new content', map2.some(e => doc2.slice(e.start, e.end).includes('Added.')));
}
```

**Step 2: Run, expect FAIL** (`window.getSourceMap` undefined; `commitDoc` doesn't rebuild).

**Step 3: Implement**

Add near top of the runtime block (after `RWA` constant, ~L100):

```javascript
let sourceMap = null;
function rebuildSourceMap() {
  // Read the current doc synchronously is not possible (IDB is async). Instead,
  // expose a setter and call it after every commit / first render.
}
function setSourceMap(doc) { sourceMap = buildSourcePositionMap(doc); }
function getSourceMap() { return sourceMap; }
window.getSourceMap = getSourceMap;
```

In `renderDoc(html)` (~L192), after the mount innerHTML assignment, add:

```javascript
setSourceMap(html);
```

In `commitDoc` (~L639), after the IDB transaction commits successfully and *before* the re-render, the map will be rebuilt by the upcoming `renderDoc` call — so no extra wiring needed if `commitDoc` already triggers `renderDoc`. Verify by reading the commitDoc body and confirming `renderDoc(currentDoc)` (or equivalent) is called after success. If not, add the call.

**Step 4: Run, expect PASS.**

**Step 5: Commit**

```bash
git add seeds/rewritable.html tests/lens.mjs
git commit -m "feat(lens): source-position map lifetime — rebuild after commit"
```

### Task 1.5: Source uniqueness extension (algorithm)

**Files:**
- Modify: `seeds/rewritable.html` — add `resolveAnchorFind(mapEntry)` near `buildSourcePositionMap`.

**Step 1: Write a failing test for the unique case (trivial pass-through)**

```javascript
console.log('\n== Test L1.5a: anchor find — unique case ==');
{
  const doc = '<p>Unique paragraph.</p>\n<p>Another.</p>';
  window.__setDocForTest(doc); // helper, see below
  const map = window.getSourceMap();
  const find = window.resolveAnchorFind(map[0]);
  check('find equals entry source for unique case',
    find.find === '<p>Unique paragraph.</p>' && find.replacePrefix === '<p>Unique paragraph.</p>');
}
```

(The `__setDocForTest` helper rewrites `rwa_doc` directly via IDB and rebuilds the map. Add to runtime: `async function __setDocForTest(d) { const db = await openDB(); await new Promise(r => { const tx = db.transaction('rwa_doc','readwrite'); tx.objectStore('rwa_doc').put(d,'self'); tx.oncomplete = r; }); renderDoc(d); }; window.__setDocForTest = __setDocForTest;`)

**Step 2: Add ambiguous-case test**

```javascript
console.log('\n== Test L1.5b: anchor find — duplicate paragraph ==');
{
  const doc = '<p>Same.</p>\n<p>Other.</p>\n<p>Same.</p>';
  await window.__setDocForTest(doc);
  const map = window.getSourceMap();
  // Anchor on the first <p>Same.</p>. Its outerHTML duplicates the third's.
  const find = window.resolveAnchorFind(map[0]);
  check('find for first duplicate is unique within doc',
    doc.indexOf(find.find) === doc.lastIndexOf(find.find));
  check('find still anchors at original position',
    doc.indexOf(find.find) === map[0].start || doc.indexOf(find.find) <= map[0].start);
}
```

**Step 3: Run, expect FAIL** (function not defined).

**Step 4: Implement `resolveAnchorFind` in `seeds/rewritable.html`** (after `buildSourcePositionMap`)

```javascript
// Given a map entry, return { find, replacePrefix } where:
//   find          = a substring of the current doc that appears exactly once
//                   and includes the entry's source range
//   replacePrefix = the same prefix bytes in find that are NOT the entry's own
//                   source (so the caller assembles `replace` as
//                   `replacePrefix + entryContent + replaceSuffix + insertedAfter`).
// Implements the "Source uniqueness" disambiguation in spec §5.5 by extending
// outward through map siblings until uniqueness is achieved. Returns null when
// even full-document context fails (pathological case — surface "ambiguous").
function resolveAnchorFind(entry) {
  const doc = currentDocCache; // the last-rendered doc
  if (!doc) return null;
  const map = sourceMap;
  const idx = map.indexOf(entry);
  let lo = idx, hi = idx;
  while (true) {
    const start = map[lo].start;
    const end   = map[hi].end;
    const find  = doc.slice(start, end);
    if (countOccurrences(doc, find) === 1) {
      return {
        find,
        replacePrefix: doc.slice(start, entry.start),
        replaceSuffix: doc.slice(entry.end, end),
      };
    }
    // Expand: prefer growing in whichever direction has a sibling available.
    const grew = (lo > 0 && (hi >= map.length - 1 || (idx - lo) <= (hi - idx)))
      ? (lo--, true)
      : (hi < map.length - 1 ? (hi++, true) : false);
    if (!grew) return null;
  }
}
```

You'll need a `currentDocCache` — set it in `renderDoc` alongside `setSourceMap`:

```javascript
let currentDocCache = null;
// inside renderDoc:
currentDocCache = html;
```

**Step 5: Run, expect PASS for both tests.**

**Step 6: Commit**

```bash
git add seeds/rewritable.html tests/lens.mjs
git commit -m "feat(lens): anchor find resolution with uniqueness extension"
```

---

## Phase 2: Lens UI scaffolding (default state)

The lens replaces the modal `⌘K` UI. Most of `buildUI` (~L242) is recycled; the modal prompt is removed and the docked input takes its place.

### Task 2.1: Add the docked lens to `buildUI`

**Files:**
- Modify: `seeds/rewritable.html` `buildUI` (~L242)

**Step 1: Write a UI-presence test**

```javascript
console.log('\n== Test L2.1: lens DOM is mounted ==');
check('lens input exists', !!window.document.getElementById('rwa-lens-input'));
check('lens is initially in default state',
  window.document.getElementById('rwa-lens')?.dataset.state === 'default');
check('lens placeholder mentions writing or describing',
  /write|describe/i.test(window.document.getElementById('rwa-lens-input')?.placeholder || ''));
```

**Step 2: Run, expect FAIL.**

**Step 3: Add the lens DOM in `buildUI`**

Locate `buildUI` (~L242). Identify where the existing modal prompt is created. Append the lens scaffolding to whatever shadow-root or root element `buildUI` uses. Conceptually:

```javascript
// Inside buildUI, after the existing UI is built:
const lens = document.createElement('div');
lens.id = 'rwa-lens';
lens.dataset.state = 'default';
lens.innerHTML = `
  <div id="rwa-lens-badge" hidden></div>
  <textarea id="rwa-lens-input" rows="1"
    placeholder="Write, or describe what you want. /command to instruct."></textarea>
  <div id="rwa-lens-hint"></div>
`;
// Style it as a docked bar at viewport bottom — re-use existing CSS variables.
lens.style.cssText = `
  position: fixed; left: 0; right: 0; bottom: 0;
  background: var(--rwa-surface, #161618);
  border-top: 1px solid var(--rwa-border, #2d2d34);
  padding: 12px 16px;
  z-index: 10;
`;
(uiRoot || document.body).appendChild(lens); // uiRoot is whatever existing root buildUI uses
```

**Step 4: Run, expect PASS.**

**Step 5: Commit**

```bash
git add seeds/rewritable.html tests/lens.mjs
git commit -m "feat(lens): mount docked lens UI in default state"
```

### Task 2.2: Submit gesture (⌘Enter) and Enter-as-newline

**Files:**
- Modify: `seeds/rewritable.html` `buildUI` (lens event wiring)

**Step 1: Write a test that simulates Enter (no submit) and ⌘Enter (submit)**

```javascript
console.log('\n== Test L2.2: ⌘Enter submits, Enter does not ==');
{
  let submittedWith = null;
  window.__lensSubmitHandler = (text) => { submittedWith = text; };
  const input = window.document.getElementById('rwa-lens-input');
  input.value = 'hello';
  // Plain Enter: should NOT submit.
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  check('plain Enter did not trigger submit', submittedWith === null);
  // ⌘Enter: should submit.
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
  check('⌘Enter triggered submit with text', submittedWith === 'hello');
}
```

**Step 2: Run, expect FAIL.**

**Step 3: Add the keydown handler in `buildUI` (after lens DOM)**

```javascript
const lensInput = lens.querySelector('#rwa-lens-input');
lensInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (!(e.metaKey || e.ctrlKey)) return; // plain Enter remains newline (default behavior)
  e.preventDefault();
  const text = lensInput.value;
  if (typeof window.__lensSubmitHandler === 'function') {
    window.__lensSubmitHandler(text);
  } else {
    submitLens(text);
  }
});
```

`submitLens` is defined in the next task.

**Step 4: Run, expect PASS.**

**Step 5: Commit**

```bash
git add seeds/rewritable.html tests/lens.mjs
git commit -m "feat(lens): ⌘Enter submits; plain Enter remains newline"
```

### Task 2.3: Slash discriminator + live mode indication

**Files:**
- Modify: `seeds/rewritable.html` (lens input event wiring)

**Step 1: Write a test for chrome shift on leading slash**

```javascript
console.log('\n== Test L2.3: live mode indication ==');
{
  const input = window.document.getElementById('rwa-lens-input');
  const lens = window.document.getElementById('rwa-lens');
  // Type a leading slash.
  input.value = '/dark mode';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  check('lens dataset.mode shifts to "command"', lens.dataset.mode === 'command');
  // Backspace away the slash.
  input.value = 'dark mode';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  check('lens dataset.mode reverts to "text"', lens.dataset.mode === 'text');
}
```

**Step 2: Run, expect FAIL.**

**Step 3: Add the input handler**

In `buildUI`, near the keydown handler:

```javascript
lensInput.addEventListener('input', () => {
  const v = lensInput.value;
  // Leading slash — but \/ is the escape, so check for \/ explicitly first.
  const isCommand = v.startsWith('/') && !v.startsWith('\\/');
  lens.dataset.mode = isCommand ? 'command' : 'text';
});
```

**Step 4: Run, expect PASS.**

**Step 5: Commit**

```bash
git add seeds/rewritable.html tests/lens.mjs
git commit -m "feat(lens): live mode indication for slash discriminator"
```

### Task 2.4: Submit dispatcher — `submitLens(text)`

**Files:**
- Modify: `seeds/rewritable.html` — add `submitLens` near `modify`.

**Step 1: Write tests that route correctly to four behaviors (all fail at first)**

```javascript
console.log('\n== Test L2.4: submitLens routes by state and mode ==');
{
  const calls = [];
  window.__synthesizeAndCommit = (envelope, surface) => calls.push({ envelope, surface });
  // Save original modify; we'll re-stub fetch for slash paths in later tests.
  // Default + text: routes to direct-text envelope synthesis.
  await window.submitLens('hello world');
  check('default + text invokes synth with surface=default-text',
    calls.length === 1 && calls[0].surface === 'default-text');
  // Default + command: routes through modify (we just check it returns).
  // Replaced in Phase 4; for now, assert it does NOT call __synthesizeAndCommit.
  calls.length = 0;
  let modifyCalled = false;
  const realModify = window.modify;
  window.modify = async () => { modifyCalled = true; };
  await window.submitLens('/whatever');
  check('default + command routes to modify, not direct-text synth',
    modifyCalled === true && calls.length === 0);
  window.modify = realModify;
}
```

**Step 2: Run, expect FAIL** (`submitLens` undefined).

**Step 3: Implement**

```javascript
async function submitLens(text) {
  if (!text || !text.length) return;
  // Escape resolution: \/ at start becomes literal /.
  const isEscapedSlash = text.startsWith('\\/');
  const isCommand = text.startsWith('/') && !isEscapedSlash;
  const stripped = isEscapedSlash ? text.slice(1) : text;
  const anchored = lensState.anchor !== null;
  if (isCommand) {
    const instruction = stripped.slice(1); // strip the '/' itself
    if (anchored) {
      await runAnchoredCommand(lensState.anchor, instruction);
    } else {
      await modify(instruction); // existing default-mode whole-doc loop
    }
  } else {
    const envelope = anchored
      ? synthesizeAnchoredInsert(lensState.anchor, stripped)
      : synthesizeDefaultAppend(stripped);
    const surface = anchored ? 'anchored-text' : 'default-text';
    await synthesizeAndCommit(envelope, surface, stripped);
  }
  // After successful submit, clear the input.
  const input = document.getElementById('rwa-lens-input');
  if (input) input.value = '';
}
window.submitLens = submitLens;

// Lens state (extends across input lifetime).
const lensState = { anchor: null }; // null = default state; entry = map entry
window.__lensState = lensState;
```

The functions `runAnchoredCommand`, `synthesizeAnchoredInsert`, `synthesizeDefaultAppend`, `synthesizeAndCommit` are defined in later tasks. For now, stub them to keep the dispatcher testable:

```javascript
async function runAnchoredCommand(anchor, instr) { /* Phase 7 */ }
function synthesizeAnchoredInsert(anchor, text) { /* Phase 6 */ return null; }
function synthesizeDefaultAppend(text) { /* Phase 3 */ return null; }
async function synthesizeAndCommit(envelope, surface, instr) {
  // Test seam:
  if (typeof window.__synthesizeAndCommit === 'function') {
    return window.__synthesizeAndCommit(envelope, surface, instr);
  }
  // Phase 3 fills this in.
}
```

**Step 4: Run, expect PASS.**

**Step 5: Commit**

```bash
git add seeds/rewritable.html tests/lens.mjs
git commit -m "feat(lens): submitLens dispatcher routes by state × mode"
```

---

## Phase 3: Default + direct text — append at EOF

The simplest of the four cells. Synthesizes an `apply_edits` envelope with the EOF anchor, runs it through the existing `applyEdits` validation + commit.

### Task 3.1: Wrap-text helper (default `<p>`, `<li>` special case)

**Files:**
- Modify: `seeds/rewritable.html` — add `wrapDirectText(text, anchorTag)` near `submitLens`.

**Step 1: Write the test**

```javascript
console.log('\n== Test L3.1: wrapDirectText ==');
check('single paragraph wraps in <p>',
  window.wrapDirectText('Hello world.', null) === '<p>Hello world.</p>');
check('multi-paragraph splits on blank lines',
  window.wrapDirectText('First.\n\nSecond.', null) === '<p>First.</p>\n<p>Second.</p>');
check('anchor on LI wraps in <li>',
  window.wrapDirectText('New item.', 'LI') === '<li>New item.</li>');
check('anchor on BLOCKQUOTE still wraps in <p>',
  window.wrapDirectText('After quote.', 'BLOCKQUOTE') === '<p>After quote.</p>');
```

**Step 2: Run, expect FAIL.**

**Step 3: Implement**

```javascript
function wrapDirectText(text, anchorTag) {
  const wrapper = (anchorTag === 'LI') ? 'li' : 'p';
  const chunks = text.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  return chunks.map(c => `<${wrapper}>${escapeHtml(c)}</${wrapper}>`).join('\n');
}
function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
window.wrapDirectText = wrapDirectText;
```

**Step 4: Run, expect PASS.**

**Step 5: Commit**

```bash
git add seeds/rewritable.html tests/lens.mjs
git commit -m "feat(lens): wrapDirectText with li special case"
```

### Task 3.2: EOF anchor resolution

**Files:**
- Modify: `seeds/rewritable.html` — add `resolveEofAnchor()` near `resolveAnchorFind`.

**Step 1: Write the test**

```javascript
console.log('\n== Test L3.2: resolveEofAnchor ==');
{
  await window.__setDocForTest('<p>First.</p>\n<p>Last.</p>');
  const eof = window.resolveEofAnchor();
  check('EOF anchor finds last anchorable block',
    eof.find === '<p>Last.</p>');
}
```

**Step 2: Run, expect FAIL.**

**Step 3: Implement**

```javascript
function resolveEofAnchor() {
  // Last anchorable block, with locked blocks excluded (Phase 8 wires the lock check).
  const map = sourceMap;
  if (!map || map.length === 0) return null;
  // For now, no lock awareness (Phase 8 adds isLocked filter).
  for (let i = map.length - 1; i >= 0; i--) {
    return resolveAnchorFind(map[i]);
  }
  return null;
}
window.resolveEofAnchor = resolveEofAnchor;
```

**Step 4: Run, expect PASS.**

**Step 5: Commit**

```bash
git add seeds/rewritable.html tests/lens.mjs
git commit -m "feat(lens): EOF anchor resolution via source-position map"
```

### Task 3.3: synthesizeDefaultAppend

**Files:**
- Modify: `seeds/rewritable.html` — replace stub with real implementation.

**Step 1: Write the test**

```javascript
console.log('\n== Test L3.3: synthesizeDefaultAppend ==');
{
  await window.__setDocForTest('<p>Existing.</p>');
  const env = window.synthesizeDefaultAppend('New paragraph.');
  check('envelope is rwa-edit/1', env.version === 'rwa-edit/1');
  check('envelope has 1 edit', env.edits.length === 1);
  check('edit find is last anchorable',
    env.edits[0].find === '<p>Existing.</p>');
  check('edit replace appends new <p>',
    env.edits[0].replace === '<p>Existing.</p>\n<p>New paragraph.</p>');
}
```

**Step 2: Run, expect FAIL.**

**Step 3: Implement** (replace stub from Task 2.4)

```javascript
function synthesizeDefaultAppend(text) {
  const eof = resolveEofAnchor();
  if (!eof) return null; // empty doc — handled by synthesizeAndCommit via replace_document
  const wrapped = wrapDirectText(text, null);
  return {
    version: 'rwa-edit/1',
    edits: [{
      find: eof.find,
      replace: eof.find + '\n' + wrapped,
      reason: 'lens: default-state direct-text append',
    }],
    reason: 'lens: append at EOF',
  };
}
```

**Step 4: Run, expect PASS.**

**Step 5: Commit**

```bash
git add seeds/rewritable.html tests/lens.mjs
git commit -m "feat(lens): synthesize apply_edits envelope for default append"
```

### Task 3.4: synthesizeAndCommit — wire envelope through existing applyEdits

**Files:**
- Modify: `seeds/rewritable.html` — replace stub.

**Step 1: Write a test that submits real text and verifies the doc grew**

```javascript
console.log('\n== Test L3.4: end-to-end default + direct text ==');
{
  await window.__setDocForTest('<p>Existing.</p>');
  delete window.__synthesizeAndCommit; // unstub — use the real one
  await window.submitLens('Direct text appended.');
  await new Promise(r => setTimeout(r, 50));
  const doc = await window.getDoc();
  check('doc contains both old and new', doc.includes('<p>Existing.</p>') && doc.includes('Direct text appended.'));
  check('order: existing first, new last',
    doc.indexOf('Existing.') < doc.indexOf('Direct text appended.'));
}
```

**Step 2: Run, expect FAIL** (synthesizeAndCommit is a no-op stub).

**Step 3: Implement**

Replace the stubbed `synthesizeAndCommit` with the real one, reusing the existing `applyEdits` plus a history-extension hook (the basic surface/instruction/scope fields land here; Phase 9 raises the cap and adds the pane).

```javascript
async function synthesizeAndCommit(envelope, surface, instruction) {
  // Test seam preserved.
  if (typeof window.__synthesizeAndCommit === 'function') {
    return window.__synthesizeAndCommit(envelope, surface, instruction);
  }
  if (!envelope) {
    // Empty doc → first append → use replace_document.
    const wrapped = wrapDirectText(instruction || '', null);
    const repEnv = { version: 'rwa-edit/1', doc: wrapped, reason: 'initial content into an empty document' };
    const result = await replaceDocument(repEnv, await getDoc());
    if (result.ok) {
      // History extension wiring is Phase 9; for now the existing kind:'replace_document' record is fine.
    }
    return result;
  }
  const result = await applyEdits(envelope, await getDoc());
  // Phase 9 will augment the just-committed history record with surface/instruction/scope.
  return result;
}
```

**Step 4: Run, expect PASS.**

**Step 5: Commit**

```bash
git add seeds/rewritable.html tests/lens.mjs
git commit -m "feat(lens): commit default-append envelope through applyEdits"
```

### Task 3.5: First-append from genuinely-empty doc → replace_document

**Files:**
- Modify: `seeds/rewritable.html` — refine `synthesizeAndCommit` empty branch and define the predicate.

**Step 1: Write the test**

```javascript
console.log('\n== Test L3.5: first append into empty doc uses replace_document ==');
{
  await window.__setDocForTest(''); // genuinely empty
  delete window.__synthesizeAndCommit;
  // Watch the audit log for kind: 'replace_document'.
  await window.submitLens('First content.');
  await new Promise(r => setTimeout(r, 50));
  const doc = await window.getDoc();
  check('doc now contains first content', doc.includes('First content.'));
  // Inspect rwa_hist
  const hist = await new Promise(res => {
    window.openDB().then(db => {
      const r = db.transaction('rwa_hist').objectStore('rwa_hist').get('self');
      r.onsuccess = () => res(r.result);
    });
  });
  const top = hist[0];
  check('most recent history record is replace_document', top.kind === 'replace_document');
  check('reason matches "initial content into an empty document"',
    /initial content/.test(top.reason || top.envelope?.reason || ''));
}
```

**Step 2: Run, expect PASS** if Task 3.4's empty branch already routed correctly. If FAIL, fix the predicate: `synthesizeDefaultAppend` returns `null` only when `sourceMap.length === 0`, which matches the spec's "no anchorable elements after parse" predicate.

**Step 3: Verify by adding a test for a structural-skeleton doc (`<article></article>`)**

```javascript
console.log('\n== Test L3.5b: skeleton-only doc treated as empty ==');
{
  await window.__setDocForTest('<article></article>');
  await window.submitLens('Content into skeleton.');
  await new Promise(r => setTimeout(r, 50));
  const doc = await window.getDoc();
  check('skeleton replaced with content', doc.includes('Content into skeleton.'));
}
```

If FAIL, confirm `buildSourcePositionMap` returns `[]` for `<article></article>` (no anchorable inside) — the predicate then engages.

**Step 4: Commit**

```bash
git add seeds/rewritable.html tests/lens.mjs
git commit -m "feat(lens): first append into empty doc routes to replace_document"
```

---

## Phase 4: Default + slash command — whole-document transform

This cell reuses the existing `modify(instr)` loop as-is. The lens just hands the instruction over.

### Task 4.1: Verify default + slash routes through modify

**Files:**
- Modify: `tests/lens.mjs`

**Step 1: Write the test**

```javascript
console.log('\n== Test L4.1: default + slash invokes modify ==');
{
  await window.__setDocForTest('<p>Original.</p>');
  fetchHandler = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { role: 'assistant', content: '', tool_calls: [{
        id: 's1', type: 'function',
        function: { name: 'apply_edits', arguments: JSON.stringify({
          version: 'rwa-edit/1',
          edits: [{ find: 'Original.', replace: 'Tightened.' }]
        })}
      }]}}]
    })
  });
  await window.submitLens('/tighten throughout');
  await new Promise(r => setTimeout(r, 100));
  const doc = await window.getDoc();
  check('agent edit applied via default-slash path', doc.includes('Tightened.'));
  check('original removed', !doc.includes('Original.'));
}
```

**Step 2: Run, expect PASS** (Task 2.4's dispatcher already routes `isCommand && !anchored` to `modify`). If FAIL, debug the dispatcher.

**Step 3: Commit**

```bash
git add tests/lens.mjs
git commit -m "test(lens): default + slash routes through existing modify"
```

---

## Phase 5: Anchored state — click to anchor, lens repositions

### Task 5.1: Click-to-anchor with DOM traversal

**Files:**
- Modify: `seeds/rewritable.html` — wire mount click handler in `renderDoc` (~L192).

**Step 1: Write the test**

```javascript
console.log('\n== Test L5.1: click anchors lens ==');
{
  await window.__setDocForTest('<p id="x">First.</p>\n<p>Second.</p>');
  const target = window.document.querySelector('#x');
  // Click on the <p>.
  target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('lens state is anchored', window.__lensState.anchor !== null);
  check('anchor entry matches first <p>',
    window.__lensState.anchor && window.__lensState.anchor.tag === 'P');
  check('lens dataset.state shifted to "anchored"',
    window.document.getElementById('rwa-lens').dataset.state === 'anchored');
}
console.log('\n== Test L5.1b: click on inline traverses to ancestor ==');
{
  await window.__setDocForTest('<p>Containing <strong id="s">strong</strong> here.</p>');
  const target = window.document.querySelector('#s');
  target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('inline click anchors the containing P',
    window.__lensState.anchor && window.__lensState.anchor.tag === 'P');
}
console.log('\n== Test L5.1c: click on lens itself is not anchor ==');
{
  await window.__setDocForTest('<p>One.</p>');
  // Reset anchor first.
  window.__lensState.anchor = null;
  const lensInput = window.document.getElementById('rwa-lens-input');
  lensInput.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('clicking lens does not anchor', window.__lensState.anchor === null);
}
```

**Step 2: Run, expect FAIL.**

**Step 3: Implement the click handler**

In `renderDoc(html)` (after setting `mount.innerHTML = html`), add:

```javascript
mount.addEventListener('click', handleMountClick);
```

Define `handleMountClick`:

```javascript
function handleMountClick(e) {
  // Walk up from the click target until we find an anchorable ancestor *within* the mount.
  let el = e.target;
  while (el && el !== mount) {
    if (ANCHORABLE_TAGS.has(el.tagName)) {
      const entry = sourceMap.find(m => m.node === el);
      if (entry) anchorTo(entry);
      return;
    }
    el = el.parentNode;
  }
  // No anchorable ancestor — no-op.
}
function anchorTo(entry) {
  lensState.anchor = entry;
  document.getElementById('rwa-lens').dataset.state = 'anchored';
  // Visual + position changes are Task 5.2.
}
```

(Note: don't add a click handler on the lens itself; clicks there focus the input and don't propagate to mount because the lens is a sibling of mount, not a descendant.)

**Step 4: Run, expect PASS.**

**Step 5: Commit**

```bash
git add seeds/rewritable.html tests/lens.mjs
git commit -m "feat(lens): click on a block anchors the lens"
```

### Task 5.2: Lens reposition + badge + visual highlight (UI / visual)

**Files:**
- Modify: `seeds/rewritable.html` `anchorTo`, plus CSS in lens scaffolding.

**Step 1 (UI):** When `anchorTo` fires, move the lens to be the next sibling of `entry.node`, and add a `data-rwa-anchored` attribute on `entry.node` for the visual highlight.

```javascript
function anchorTo(entry) {
  lensState.anchor = entry;
  const lens = document.getElementById('rwa-lens');
  lens.dataset.state = 'anchored';
  // Reposition: move lens DOM-wise to right after the anchored block.
  entry.node.parentNode.insertBefore(lens, entry.node.nextSibling);
  lens.style.position = ''; // remove the docked-fixed position
  // Badge.
  const badge = lens.querySelector('#rwa-lens-badge');
  badge.hidden = false;
  badge.textContent = `anchored on ${shortDescribe(entry)} `;
  const x = document.createElement('button');
  x.textContent = '✕';
  x.addEventListener('click', releaseAnchor);
  badge.appendChild(x);
  // Visual highlight on the anchored block.
  if (lensState._highlighted) lensState._highlighted.removeAttribute('data-rwa-anchored');
  entry.node.setAttribute('data-rwa-anchored', '');
  lensState._highlighted = entry.node;
  // Placeholder shift.
  const input = lens.querySelector('#rwa-lens-input');
  input.placeholder = `insert after this block, or /edit it`;
}
function shortDescribe(entry) {
  // E.g., "¶3", "h2", "li".
  return entry.tag.toLowerCase();
}
function releaseAnchor() {
  const lens = document.getElementById('rwa-lens');
  // Move lens back to docked position (re-append to the original UI root).
  document.body.appendChild(lens);
  lens.style.cssText = `position: fixed; left: 0; right: 0; bottom: 0;
    background: var(--rwa-surface, #161618);
    border-top: 1px solid var(--rwa-border, #2d2d34);
    padding: 12px 16px; z-index: 10;`;
  lens.dataset.state = 'default';
  lens.querySelector('#rwa-lens-badge').hidden = true;
  if (lensState._highlighted) lensState._highlighted.removeAttribute('data-rwa-anchored');
  lensState._highlighted = null;
  lensState.anchor = null;
  const input = lens.querySelector('#rwa-lens-input');
  input.placeholder = 'Write, or describe what you want. /command to instruct.';
}
window.releaseAnchor = releaseAnchor;
```

CSS for `[data-rwa-anchored]` — add a subtle border or background tint inside the existing `<style>` block in the seed.

**Step 2:** Add Esc handler in `buildUI`:

```javascript
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && lensState.anchor !== null) {
    releaseAnchor();
  }
});
```

**Step 3:** Test.

```javascript
console.log('\n== Test L5.2: badge shown when anchored, hidden in default ==');
{
  await window.__setDocForTest('<p>One.</p>');
  window.document.querySelector('p').click();
  const badge = window.document.getElementById('rwa-lens-badge');
  check('badge shown when anchored', badge.hidden === false);
  // Esc releases.
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  check('badge hidden after release', badge.hidden === true);
  check('lens state default after release',
    window.document.getElementById('rwa-lens').dataset.state === 'default');
}
```

**Step 4:** Commit.

```bash
git add seeds/rewritable.html tests/lens.mjs
git commit -m "feat(lens): badge, visual highlight, Esc to release anchor"
```

---

## Phase 6: Anchored + direct text — insert after block

### Task 6.1: synthesizeAnchoredInsert

**Files:**
- Modify: `seeds/rewritable.html` — replace stub.

**Step 1: Write the test**

```javascript
console.log('\n== Test L6.1: synthesizeAnchoredInsert ==');
{
  await window.__setDocForTest('<p>First.</p>\n<p>Second.</p>');
  const map = window.getSourceMap();
  const env = window.__synthesizeAnchoredInsert(map[0], 'New between.');
  check('envelope has 1 edit', env.edits.length === 1);
  check('find equals first paragraph source',
    env.edits[0].find === '<p>First.</p>');
  check('replace inserts after first paragraph',
    env.edits[0].replace === '<p>First.</p>\n<p>New between.</p>');
}
```

(Expose `synthesizeAnchoredInsert` as `window.__synthesizeAnchoredInsert` for testing.)

**Step 2: Run, expect FAIL.**

**Step 3: Implement** (replace stub from Task 2.4)

```javascript
function synthesizeAnchoredInsert(anchor, text) {
  const find = resolveAnchorFind(anchor);
  if (!find) return null;
  const wrapped = wrapDirectText(text, anchor.tag);
  return {
    version: 'rwa-edit/1',
    edits: [{
      find: find.find,
      replace: find.find + '\n' + wrapped,
      reason: 'lens: anchored direct-text insert',
    }],
    reason: 'lens: insert after anchor',
  };
}
window.__synthesizeAnchoredInsert = synthesizeAnchoredInsert;
```

**Step 4: Run, expect PASS.**

**Step 5: Commit**

```bash
git add seeds/rewritable.html tests/lens.mjs
git commit -m "feat(lens): synthesize anchored direct-text insert envelope"
```

### Task 6.2: End-to-end anchored direct text

**Step 1: Write the test**

```javascript
console.log('\n== Test L6.2: e2e anchored direct text ==');
{
  await window.__setDocForTest('<p>First.</p>\n<p>Second.</p>');
  window.document.querySelector('p').click(); // anchors first
  await window.submitLens('Insert me.');
  await new Promise(r => setTimeout(r, 50));
  const doc = await window.getDoc();
  check('doc has three paragraphs', (doc.match(/<p>/g) || []).length === 3);
  check('inserted between first and second',
    doc.indexOf('Insert me.') > doc.indexOf('First.') &&
    doc.indexOf('Insert me.') < doc.indexOf('Second.'));
  check('lens stays anchored on first paragraph after insert',
    window.__lensState.anchor && window.__lensState.anchor.tag === 'P');
}
```

**Step 2: Run, expect PASS** (all wiring is in place from prior tasks). If FAIL, the most likely cause is anchor-staleness: after the commit, the source-position map rebuilds and the `lensState.anchor` reference is stale. Fix by re-resolving the anchor against the new map after commit using its source-start offset:

```javascript
// After successful direct-text commit, in synthesizeAndCommit:
if (lensState.anchor) {
  const oldStart = lensState.anchor.start;
  const re = sourceMap.find(m => m.start === oldStart);
  if (re) lensState.anchor = re;
}
```

**Step 3: Commit**

```bash
git add seeds/rewritable.html tests/lens.mjs
git commit -m "feat(lens): end-to-end anchored direct text + post-commit re-anchor"
```

### Task 6.3: <li> wrapping prevents <p>-in-<ul> invalidity

**Step 1: Write the test**

```javascript
console.log('\n== Test L6.3: anchored direct text on <li> wraps as <li> ==');
{
  await window.__setDocForTest('<ul>\n  <li>One</li>\n  <li>Two</li>\n</ul>');
  // Click on the first <li>.
  window.document.querySelectorAll('li')[0].click();
  await window.submitLens('Three');
  await new Promise(r => setTimeout(r, 50));
  const doc = await window.getDoc();
  check('new content wrapped as <li>, not <p>',
    doc.includes('<li>Three</li>') && !doc.includes('<p>Three</p>'));
  check('list now has three items',
    (doc.match(/<li>/g) || []).length === 3);
}
```

**Step 2: Run, expect PASS** (Task 3.1 already implements the wrapping table). If FAIL, debug `wrapDirectText` for the LI branch.

**Step 3: Commit**

```bash
git add tests/lens.mjs
git commit -m "test(lens): assert <li> context wraps direct text as <li>"
```

---

## Phase 7: Anchored + slash command — edit the block

### Task 7.1: Bounded context window

**Files:**
- Modify: `seeds/rewritable.html` — add `buildAnchoredContextWindow(anchor)`.

**Step 1: Write the test (heading-relative heuristic for v1)**

```javascript
console.log('\n== Test L7.1: bounded context window — heading-relative ==');
{
  const doc = '<h1>Title</h1>\n<p>Intro.</p>\n<h2>Section A</h2>\n<p>A1.</p>\n<p>A2.</p>\n<h2>Section B</h2>\n<p>B1.</p>';
  await window.__setDocForTest(doc);
  const map = window.getSourceMap();
  // Anchor on "A1." (third <p>, index 2 in map after H1, P, H2 ahead — verify).
  const a1 = map.find(e => doc.slice(e.start, e.end).includes('A1.'));
  const ctx = window.buildAnchoredContextWindow(a1);
  check('context includes section A blocks',
    ctx.context.includes('A1.') && ctx.context.includes('A2.'));
  check('context does NOT include section B',
    !ctx.context.includes('B1.'));
  check('context labels target distinct from window',
    ctx.target.includes('A1.') && !ctx.target.includes('A2.'));
}
```

**Step 2: Run, expect FAIL.**

**Step 3: Implement** the heading-relative heuristic. v1 picks one and documents it in §10.

```javascript
function buildAnchoredContextWindow(anchor) {
  const map = sourceMap, doc = currentDocCache;
  const idx = map.indexOf(anchor);
  // Walk backward to nearest preceding heading at any level (we use any heading in v1).
  const isHeading = e => /^H[1-6]$/.test(e.tag);
  let lo = idx;
  while (lo > 0 && !isHeading(map[lo - 1])) lo--;
  if (lo > 0) lo--; // include the heading itself
  // Walk forward to next heading.
  let hi = idx;
  while (hi < map.length - 1 && !isHeading(map[hi + 1])) hi++;
  const blocks = [];
  for (let i = lo; i <= hi; i++) {
    if (i === idx) continue;
    blocks.push(doc.slice(map[i].start, map[i].end));
  }
  return {
    target: doc.slice(anchor.start, anchor.end),
    context: blocks.join('\n'),
  };
}
window.buildAnchoredContextWindow = buildAnchoredContextWindow;
```

**Step 4: Run, expect PASS.**

**Step 5: Commit**

```bash
git add seeds/rewritable.html tests/lens.mjs
git commit -m "feat(lens): heading-relative context window for anchored prompts"
```

### Task 7.2: Anchored agent prompt

**Files:**
- Modify: `seeds/rewritable.html` — add `buildAnchoredPrompt(target, context, instruction)`.

**Step 1: Write the test**

```javascript
console.log('\n== Test L7.2: anchored prompt structure ==');
{
  const p = window.buildAnchoredPrompt('<p>Target.</p>', '<h2>Section</h2>', 'tighten this');
  check('prompt names target', p.includes('<TARGET>') && p.includes('<p>Target.</p>'));
  check('prompt names context', p.includes('<CONTEXT>') && p.includes('<h2>Section</h2>'));
  check('prompt names instruction', p.includes('tighten this'));
  check('prompt forbids markdown fences', /naked HTML|no markdown fences|no commentary/i.test(p));
  check('prompt mentions parent-type rule when target is <li>',
    !p.includes('<li>') || /list item|<li>/.test(p)); // weak check; refined per impl
}
```

**Step 2: Run, expect FAIL.**

**Step 3: Implement**

```javascript
function buildAnchoredPrompt(target, context, instruction) {
  // Detect parent-type constraint by inspecting the target's outer element.
  const parsed = new DOMParser().parseFromString(`<body>${target}</body>`, 'text/html');
  const root = parsed.body.firstElementChild;
  const targetTag = root ? root.tagName : '';
  const parentConstraint = (targetTag === 'LI')
    ? '\n\nThe target is an <li>. Every top-level element of your response must also be <li> — never <p> or other types. Lists may not contain <p> children.'
    : '';
  return [
    `You are editing a single block of an HTML document.`,
    ``,
    `<TARGET>`,
    target,
    `</TARGET>`,
    ``,
    `<CONTEXT>`,
    context || '(no surrounding context — the target is in a section by itself)',
    `</CONTEXT>`,
    ``,
    `User instruction: ${instruction}`,
    ``,
    `Return a replacement for the target block, of any length.`,
    `Output naked HTML markup only — no markdown fences, no commentary, no preamble or explanation.`,
    `The first character of your response must be the first character of the replacement block.${parentConstraint}`,
  ].join('\n');
}
window.buildAnchoredPrompt = buildAnchoredPrompt;
```

**Step 4: Run, expect PASS.**

**Step 5: Commit**

```bash
git add seeds/rewritable.html tests/lens.mjs
git commit -m "feat(lens): anchored agent prompt with parent-type constraint"
```

### Task 7.3: Response validation

**Files:**
- Modify: `seeds/rewritable.html` — add `validateAnchoredResponse(response, anchor)`.

**Step 1: Write the test**

```javascript
console.log('\n== Test L7.3: response validation against parent context ==');
{
  // <li> target → response must be all <li>.
  await window.__setDocForTest('<ul><li>Item.</li></ul>');
  const liEntry = window.getSourceMap().find(e => e.tag === 'LI');
  const ok = window.validateAnchoredResponse('<li>New item.</li>', liEntry);
  check('all-<li> response accepted', ok.ok === true);
  const bad = window.validateAnchoredResponse('<p>Wrong.</p>', liEntry);
  check('<p> response rejected for <li> parent',
    bad.ok === false && /li|list/i.test(bad.reason));
  const mixed = window.validateAnchoredResponse('<li>Good.</li><p>Bad.</p>', liEntry);
  check('mixed <li> + <p> response rejected (multi-element check)',
    mixed.ok === false);
  // <p> target → flow content accepted.
  await window.__setDocForTest('<p>Para.</p>');
  const pEntry = window.getSourceMap().find(e => e.tag === 'P');
  const okP = window.validateAnchoredResponse('<blockquote>Q</blockquote>', pEntry);
  check('flow content accepted for <p> parent', okP.ok === true);
}
```

**Step 2: Run, expect FAIL.**

**Step 3: Implement**

```javascript
function validateAnchoredResponse(response, anchor) {
  const parsed = new DOMParser().parseFromString(`<body>${response}</body>`, 'text/html');
  const tops = Array.from(parsed.body.children);
  if (tops.length === 0) {
    // Empty response is the deletion path — handled in post-commit, accepted here.
    return { ok: true };
  }
  // v1: only <ul>/<ol> parent constrains child type to <li>.
  const parentRequiresLi = anchor.node && (anchor.node.parentNode?.tagName === 'UL' || anchor.node.parentNode?.tagName === 'OL');
  if (parentRequiresLi) {
    for (const el of tops) {
      if (el.tagName !== 'LI') {
        return { ok: false, reason: `parent <${anchor.node.parentNode.tagName.toLowerCase()}> requires <li> children; got <${el.tagName.toLowerCase()}>` };
      }
    }
  }
  return { ok: true };
}
window.validateAnchoredResponse = validateAnchoredResponse;
```

**Step 4: Run, expect PASS.**

**Step 5: Commit**

```bash
git add seeds/rewritable.html tests/lens.mjs
git commit -m "feat(lens): validate anchored response against parent context"
```

### Task 7.4: runAnchoredCommand — integrate prompt + validation + envelope

**Files:**
- Modify: `seeds/rewritable.html` — replace stub.

This is the most involved task. The implementation:
1. Acquire the modify mutex (re-use whatever `modify()` does).
2. Build prompt, send to model (re-use OpenRouter call helper from `modify`).
3. Validate response.
4. On valid response, build `apply_edits` envelope: `find = resolveAnchorFind(anchor)`, `replace = response`.
5. Pass through `applyEdits`.
6. Post-commit anchor behavior (Task 7.5).

**Step 1: Write an end-to-end test**

```javascript
console.log('\n== Test L7.4: e2e anchored slash command ==');
{
  await window.__setDocForTest('<p>Original.</p>');
  window.document.querySelector('p').click(); // anchor
  fetchHandler = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { role: 'assistant', content: '<p>Tightened.</p>' }}]
    })
  });
  await window.submitLens('/tighten');
  await new Promise(r => setTimeout(r, 100));
  const doc = await window.getDoc();
  check('anchored block was rewritten', doc.includes('<p>Tightened.</p>'));
  check('original removed', !doc.includes('<p>Original.</p>'));
}
```

**Step 2: Run, expect FAIL** (`runAnchoredCommand` is a stub).

**Step 3: Implement**

Look at `modify` (~L964) to identify the OpenRouter call site. Extract into a helper `callAgentSingleShot(prompt)` that returns the assistant's `content` string (no tool_use loop — anchored mode uses a single completion, since the runtime synthesizes the envelope itself). Note: the model returns naked HTML per the prompt directive; the runtime *constructs* the envelope.

```javascript
async function runAnchoredCommand(anchor, instruction) {
  if (modifyMutex) return; // reuse existing mutex
  modifyMutex = true;
  try {
    const { target, context } = buildAnchoredContextWindow(anchor);
    const prompt = buildAnchoredPrompt(target, context, instruction);
    let attempts = 0;
    let lastFailure = null;
    while (attempts < 3) {
      attempts++;
      const response = await callAgentSingleShot(prompt + (lastFailure ? `\n\nPrevious attempt failed: ${lastFailure}\nPlease retry honoring the constraint.` : ''));
      const validation = validateAnchoredResponse(response, anchor);
      if (!validation.ok) { lastFailure = validation.reason; continue; }
      // Build envelope.
      const find = resolveAnchorFind(anchor);
      if (!find) { lastFailure = 'anchor could not be resolved (ambiguous source)'; continue; }
      const envelope = {
        version: 'rwa-edit/1',
        edits: [{
          find: find.find,
          replace: find.replacePrefix + response + find.replaceSuffix,
          reason: 'lens: anchored slash command',
        }],
        reason: `lens: ${instruction}`,
      };
      const result = await applyEdits(envelope, await getDoc());
      if (!result.ok) { lastFailure = result.reason || 'envelope rejected'; continue; }
      // Post-commit anchor behavior — Task 7.5.
      handlePostCommitAnchor(response, anchor);
      return;
    }
    // Retry exhausted — surface failure (re-use existing failure UX from modify).
    surfaceLensFailure(lastFailure);
  } finally {
    modifyMutex = false;
  }
}
```

`callAgentSingleShot`, `surfaceLensFailure`, `modifyMutex` — extract or create from `modify`'s code. If the existing `modify` already exposes a multi-turn loop with tool calls, you may want a separate single-shot helper for anchored mode (the runtime wraps the response into the envelope itself, not the agent).

**Step 4: Run, expect PASS.**

**Step 5: Commit**

```bash
git add seeds/rewritable.html tests/lens.mjs
git commit -m "feat(lens): e2e anchored slash command — prompt, validate, envelope, commit"
```

### Task 7.5: Post-commit anchor behavior

**Files:**
- Modify: `seeds/rewritable.html` — add `handlePostCommitAnchor(response, prevAnchor)`.

**Step 1: Write tests for the three branches**

```javascript
console.log('\n== Test L7.5: post-commit anchor branches ==');

// Single block → re-anchor on the new block.
{
  await window.__setDocForTest('<p>Original.</p>');
  window.document.querySelector('p').click();
  fetchHandler = async () => ({ ok: true, json: async () => ({
    choices: [{ message: { role: 'assistant', content: '<p>Tightened.</p>' }}]
  })});
  await window.submitLens('/tighten');
  await new Promise(r => setTimeout(r, 100));
  check('still anchored after single-block reply',
    window.__lensState.anchor !== null);
  check('anchor points to new <p>',
    window.__lensState.anchor && (await window.getDoc()).slice(window.__lensState.anchor.start, window.__lensState.anchor.end).includes('Tightened.'));
}

// Multi-block → release.
{
  await window.__setDocForTest('<p>Solo.</p>');
  window.document.querySelector('p').click();
  fetchHandler = async () => ({ ok: true, json: async () => ({
    choices: [{ message: { role: 'assistant', content: '<p>One.</p><p>Two.</p>' }}]
  })});
  await window.submitLens('/expand');
  await new Promise(r => setTimeout(r, 100));
  check('anchor released on multi-block reply',
    window.__lensState.anchor === null);
  check('lens state default after multi-block release',
    window.document.getElementById('rwa-lens').dataset.state === 'default');
}

// Empty → release without affordance.
{
  await window.__setDocForTest('<p>To delete.</p>\n<p>Keep.</p>');
  window.document.querySelector('p').click();
  fetchHandler = async () => ({ ok: true, json: async () => ({
    choices: [{ message: { role: 'assistant', content: '' }}]
  })});
  await window.submitLens('/delete this');
  await new Promise(r => setTimeout(r, 100));
  check('anchor released on empty reply',
    window.__lensState.anchor === null);
  const doc = await window.getDoc();
  check('first paragraph removed', !doc.includes('To delete.'));
  check('second paragraph preserved', doc.includes('Keep.'));
}
```

**Step 2: Run, expect FAIL** (no implementation).

**Step 3: Implement**

```javascript
function handlePostCommitAnchor(response, prevAnchor) {
  // After commit, the source-position map has been rebuilt by renderDoc.
  const parsed = new DOMParser().parseFromString(`<body>${response}</body>`, 'text/html');
  const tops = Array.from(parsed.body.children).filter(el => ANCHORABLE_TAGS.has(el.tagName));
  if (tops.length === 0) {
    // Empty (or no anchorable elements) → release without affordance.
    releaseAnchor();
    return;
  }
  if (tops.length === 1) {
    // Re-anchor on the new element at the prevAnchor.start position.
    const newEntry = sourceMap.find(m => m.start === prevAnchor.start);
    if (newEntry) anchorTo(newEntry);
    else releaseAnchor();
    return;
  }
  // Multi-block — release with affordance.
  releaseAnchor();
  showAffordance('anchor released — response was multi-block');
}
function showAffordance(text) {
  // Lightweight: brief toast next to the lens. UI detail; minimal impl is fine.
  const el = document.createElement('div');
  el.textContent = text;
  el.style.cssText = 'position:fixed;bottom:80px;left:16px;background:#222;color:#dde;padding:8px 12px;border-radius:4px;z-index:11;';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}
```

**Step 4: Run, expect PASS for all three branches.**

**Step 5: Commit**

```bash
git add seeds/rewritable.html tests/lens.mjs
git commit -m "feat(lens): post-commit anchor behavior (re-anchor / release)"
```

---

## Phase 8: Class-declared locks (`class="rwa-locked"`)

### Task 8.1: Recognize `.rwa-locked` in source-position map

**Files:**
- Modify: `seeds/rewritable.html` `buildSourcePositionMap` — add `locked: boolean` to each entry.

**Step 1: Write the test**

```javascript
console.log('\n== Test L8.1: source-position map flags locked entries ==');
{
  const doc = '<p>Free.</p>\n<section class="rwa-locked"><p>Locked.</p></section>';
  await window.__setDocForTest(doc);
  const map = window.getSourceMap();
  const lockedSection = map.find(e => doc.slice(e.start, e.end).includes('Locked.'));
  // The <p>Locked.</p> inside is anchorable, but the <section> with class is not in the anchorable set.
  // What we want: a sibling helper getLockedRanges() returning every .rwa-locked source range.
  const lockedRanges = window.getLockedRanges();
  check('one locked range identified', lockedRanges.length === 1);
  check('locked range covers the section',
    doc.slice(lockedRanges[0][0], lockedRanges[0][1]).includes('class="rwa-locked"'));
}
```

**Step 2: Run, expect FAIL.**

**Step 3: Implement**

Add `getLockedRanges()` that scans `currentDocCache` for elements with `class="rwa-locked"` and returns their source ranges. Implementation: parse, find `[class~="rwa-locked"]` elements, then re-find their source via the same mechanism as `buildSourcePositionMap` (or a simpler regex scan since the class is a literal substring).

```javascript
let lockedRanges = [];
function rebuildLockedRanges(doc) {
  // Scan source for opening tags carrying class containing 'rwa-locked'.
  const opening = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\bclass\s*=\s*("([^"]*)"|'([^']*)')[^>]*>/g;
  const out = [];
  let m;
  while ((m = opening.exec(doc)) !== null) {
    const cls = (m[3] || m[4] || '');
    if (!/\brwa-locked\b/.test(cls)) continue;
    const tag = m[1];
    const start = m.index;
    const end = findCloseTagEnd(doc, tag, m.index + m[0].length);
    if (end > 0) out.push([start, end]);
  }
  lockedRanges = out;
}
function getLockedRanges() { return lockedRanges; }
window.getLockedRanges = getLockedRanges;
```

In `renderDoc`, after `setSourceMap(html)`:

```javascript
rebuildLockedRanges(html);
```

**Step 4: Run, expect PASS.**

**Step 5: Commit**

```bash
git add seeds/rewritable.html tests/lens.mjs
git commit -m "feat(lens): track .rwa-locked source ranges"
```

### Task 8.2: Reject anchoring on locked blocks

**Files:**
- Modify: `seeds/rewritable.html` `handleMountClick`.

**Step 1: Write the test**

```javascript
console.log('\n== Test L8.2: clicking a locked block does not anchor ==');
{
  await window.__setDocForTest('<section class="rwa-locked"><p>Legal.</p></section>\n<p>Free.</p>');
  window.__lensState.anchor = null;
  window.document.querySelector('section.rwa-locked p').click();
  check('click on locked content does not anchor', window.__lensState.anchor === null);
  // Free block still anchors.
  window.document.querySelectorAll('p')[1].click();
  check('click on free block still anchors', window.__lensState.anchor !== null);
}
```

**Step 2: Run, expect FAIL** (locked detection not wired).

**Step 3: Modify `handleMountClick` to walk up checking for `.rwa-locked` ancestor**

```javascript
function handleMountClick(e) {
  let el = e.target;
  while (el && el !== mount) {
    if (el.classList && el.classList.contains('rwa-locked')) {
      showAffordance('this region is locked');
      return;
    }
    if (ANCHORABLE_TAGS.has(el.tagName)) {
      const entry = sourceMap.find(m => m.node === el);
      if (entry) anchorTo(entry);
      return;
    }
    el = el.parentNode;
  }
}
```

**Step 4: Run, expect PASS.**

**Step 5: Commit**

```bash
git add seeds/rewritable.html tests/lens.mjs
git commit -m "feat(lens): reject anchoring on .rwa-locked content"
```

### Task 8.3: EOF resolution skips locked tail

**Files:**
- Modify: `seeds/rewritable.html` `resolveEofAnchor`.

**Step 1: Write the test**

```javascript
console.log('\n== Test L8.3: EOF resolution skips locked footer ==');
{
  const doc = '<p>Body.</p>\n<section class="rwa-locked"><p>Footer.</p></section>';
  await window.__setDocForTest(doc);
  const eof = window.resolveEofAnchor();
  check('EOF anchor is the body <p>, not the locked footer',
    eof.find === '<p>Body.</p>');
}
```

**Step 2: Run, expect FAIL.**

**Step 3: Modify `resolveEofAnchor`**

```javascript
function resolveEofAnchor() {
  const map = sourceMap;
  if (!map || map.length === 0) return null;
  for (let i = map.length - 1; i >= 0; i--) {
    if (isWithinLockedRange(map[i].start, map[i].end)) continue;
    return resolveAnchorFind(map[i]);
  }
  return null;
}
function isWithinLockedRange(start, end) {
  return lockedRanges.some(([ls, le]) => start >= ls && end <= le);
}
```

**Step 4: Run, expect PASS.**

**Step 5: Commit**

```bash
git add seeds/rewritable.html tests/lens.mjs
git commit -m "feat(lens): EOF anchor skips locked tail"
```

### Task 8.4: Lock enforcement in apply_edits / apply_dsl_plan (overlap check)

**Files:**
- Modify: `seeds/rewritable.html` `applyEdits` (~L666) — add a class-lock overlap check before commit.

**Step 1: Write the test**

```javascript
console.log('\n== Test L8.4: apply_edits rejects edits overlapping a .rwa-locked range ==');
{
  await window.__setDocForTest('<section class="rwa-locked"><p>Locked.</p></section>\n<p>Free.</p>');
  // Forge an envelope whose find overlaps the locked range.
  const env = {
    version: 'rwa-edit/1',
    edits: [{ find: '<p>Locked.</p>', replace: '<p>Hacked.</p>' }],
    reason: 'attempt to edit locked content',
  };
  const result = await window.applyEdits(env, await window.getDoc());
  check('apply_edits rejected for class-locked overlap', result.ok === false);
  check('failure code mentions lock or frozen',
    /lock|frozen/i.test(result.reason || result.code || ''));
}

console.log('\n== Test L8.4b: adjacent insertion (find ends where lock begins) is accepted ==');
{
  // Setup: <p>Before.</p> immediately followed by the locked section.
  await window.__setDocForTest('<p>Before.</p>\n<section class="rwa-locked"><p>Locked.</p></section>');
  const env = {
    version: 'rwa-edit/1',
    // Insert a new <p> after Before., which sits adjacent to the locked range.
    edits: [{ find: '<p>Before.</p>', replace: '<p>Before.</p>\n<p>Inserted.</p>' }],
  };
  const result = await window.applyEdits(env, await window.getDoc());
  check('adjacent insertion accepted', result.ok === true);
}
```

**Step 2: Run, expect FAIL.**

**Step 3: Implement**

In `applyEdits`, after the existing validation (find/replace constraints, frozen-zone marker check) but **before** the IDB commit, add:

```javascript
// Class-declared lock check (lens-spec §7).
for (const edit of envelope.edits) {
  // Find the position of `edit.find` in the working copy (already validated to be unique).
  const start = workingCopy.indexOf(edit.find);
  if (start < 0) continue; // shouldn't happen post-validation
  const end = start + edit.find.length;
  for (const [ls, le] of lockedRanges) {
    // Overlap: NOT (end <= ls || start >= le)
    if (end > ls && start < le) {
      return { ok: false, code: 'class_lock_violation', reason: `edit overlaps a class-declared lock at [${ls}, ${le}]` };
    }
  }
}
```

(Note: `lockedRanges` is captured for the *current* doc, before edits apply. Adjacent insertions where `end === ls` are OK because the strict inequality `end > ls` is false.)

**Step 4: Run, expect PASS for both tests.**

**Step 5: Commit**

```bash
git add seeds/rewritable.html tests/lens.mjs
git commit -m "feat(lens): apply_edits rejects overlap with .rwa-locked ranges"
```

### Task 8.5: Lock enforcement in replace_document (containment check)

**Files:**
- Modify: `seeds/rewritable.html` `replaceDocument` (~L729).

**Step 1: Write the test for the containment-direction rule**

```javascript
console.log('\n== Test L8.5a: replace_document rejected on bare class-locked doc ==');
{
  await window.__setDocForTest('<section class="rwa-locked"><p>Legal.</p></section>\n<p>Free.</p>');
  const env = { version: 'rwa-edit/1', doc: '<p>Wholesale rewrite.</p>', reason: 'test' };
  const result = await window.replaceDocument(env, await window.getDoc());
  check('replace_document rejected for bare class-locked doc', result.ok === false);
  check('failure mentions class lock coverage',
    /class.lock|coverage|marker|covered/i.test(result.reason || ''));
}

console.log('\n== Test L8.5b: marker-wrapping coexistence allows replace_document ==');
{
  // .rwa-locked range entirely contained within a marker-form frozen zone.
  const doc = '<!-- rwa:frozen:begin legal -->\n<section class="rwa-locked"><p>Legal.</p></section>\n<!-- rwa:frozen:end legal -->\n<p>Free.</p>';
  await window.__setDocForTest(doc);
  // Wholesale rewrite must include the locked content byte-identically (existing rwa-edit/1 rule).
  const newDoc = '<!-- rwa:frozen:begin legal -->\n<section class="rwa-locked"><p>Legal.</p></section>\n<!-- rwa:frozen:end legal -->\n<p>Rewritten.</p>';
  const env = { version: 'rwa-edit/1', doc: newDoc, reason: 'test' };
  const result = await window.replaceDocument(env, await window.getDoc());
  check('replace_document accepted with marker coexistence',
    result.ok === true);
}

console.log('\n== Test L8.5c: marker nested INSIDE class wrapper does NOT satisfy coverage ==');
{
  const doc = '<section class="rwa-locked"><!-- rwa:frozen:begin inner -->\n<p>Inner.</p>\n<!-- rwa:frozen:end inner --></section>';
  await window.__setDocForTest(doc);
  const env = { version: 'rwa-edit/1', doc: '<p>Wrong.</p>', reason: 'test' };
  const result = await window.replaceDocument(env, await window.getDoc());
  check('inverse-nesting pattern still rejects replace_document',
    result.ok === false);
}
```

**Step 2: Run, expect FAIL.**

**Step 3: Implement**

In `replaceDocument`, after the existing frozen-zone check, add:

```javascript
// Class-declared lock coverage check (lens-spec §7).
// For every .rwa-locked range, require it to be entirely contained within
// at least one marker-form frozen zone's source range.
const markerZones = extractMarkerZoneRanges(currentDocRaw); // returns [[start,end],...]
for (const [ls, le] of lockedRangesIn(currentDocRaw)) {
  const covered = markerZones.some(([ms, me]) => ms <= ls && le <= me);
  if (!covered) {
    return { ok: false, code: 'class_lock_uncovered', reason: `class-declared lock at [${ls}, ${le}] is not entirely contained within a marker-form frozen zone; replace_document is unavailable. Use apply_edits or apply_dsl_plan, or wrap the lock with rwa:frozen markers.` };
  }
}
```

You'll need helpers:
- `extractMarkerZoneRanges(doc)` — find every `<!-- rwa:frozen:begin <name> -->` ... `<!-- rwa:frozen:end <name> -->` pair (and the `data-rwa-frozen` attribute equivalents) and return their `[start, end]` ranges.
- `lockedRangesIn(doc)` — same as `getLockedRanges` but parameterized on a doc string (so the check uses the *current* doc, not the cached one which may have already been replaced).

`extractFrozenZones` (~L513) already finds frozen-zone markers — you may be able to reuse / adapt it to return source ranges instead of names.

**Step 4: Run, expect PASS for all three tests** (the inverse-nesting test passes because the marker zone is *inside* the lock range — the containment check `ms <= ls && le <= me` fails).

**Step 5: Commit**

```bash
git add seeds/rewritable.html tests/lens.mjs
git commit -m "feat(lens): replace_document coverage check for class-declared locks"
```

### Task 8.6: Visual rendering of locked blocks (UI / visual)

**Files:**
- Modify: `seeds/rewritable.html` (CSS in seed `<style>`).

Add a CSS rule:

```css
.rwa-locked { position: relative; background: rgba(255, 255, 87, 0.04); border-left: 3px solid #ff5757; }
.rwa-locked::before { content: '🔒'; position: absolute; top: 4px; right: 8px; font-size: 12px; opacity: 0.6; }
```

No test (visual). Commit:

```bash
git add seeds/rewritable.html
git commit -m "style(lens): visual rendering for .rwa-locked blocks"
```

### Task 8.7: Agent prompt names .rwa-locked blocks in <FROZEN_ZONES>

**Files:**
- Modify: `seeds/rewritable.html` `buildUserPrompt` (~L948) and `SYSTEM_PROMPT` (~L322).

**Step 1: Write the test**

```javascript
console.log('\n== Test L8.7: prompt names .rwa-locked blocks ==');
{
  const doc = '<!-- rwa:frozen:begin x -->...<!-- rwa:frozen:end x -->\n<section class="rwa-locked"><p>Locked.</p></section>';
  await window.__setDocForTest(doc);
  const prompt = window.buildUserPrompt('any', doc, /* frozenZones */ ['x'] /* or whatever shape */);
  check('prompt mentions .rwa-locked alongside marker zones', /rwa-locked|class.declared/i.test(prompt));
}
```

(Adjust signature to whatever `buildUserPrompt` actually takes.)

**Step 2: Run, expect FAIL.**

**Step 3: Modify `buildUserPrompt`** to enumerate `.rwa-locked` blocks and append their identifying tag/snippet to the `<FROZEN_ZONES>` block. Also note in `SYSTEM_PROMPT` that `replace_document` is unavailable for documents containing class-declared locks not covered by marker forms.

**Step 4: Run, expect PASS.**

**Step 5: Commit**

```bash
git add seeds/rewritable.html tests/lens.mjs
git commit -m "feat(lens): prompt names .rwa-locked blocks; notes replace_document constraint"
```

---

## Phase 9: History extension

### Task 9.1: Extend rwa_hist record shape

**Files:**
- Modify: `seeds/rewritable.html` `commitDoc` (~L639) and `synthesizeAndCommit`.

**Step 1: Write the test**

```javascript
console.log('\n== Test L9.1: rwa_hist records carry surface, instruction, scope ==');
{
  await window.__setDocForTest('<p>X.</p>');
  await window.submitLens('Direct text added.');
  await new Promise(r => setTimeout(r, 50));
  const hist = await new Promise(res => {
    window.openDB().then(db => {
      const r = db.transaction('rwa_hist').objectStore('rwa_hist').get('self');
      r.onsuccess = () => res(r.result);
    });
  });
  const top = hist[0];
  check('record has surface field', top.surface === 'default-text');
  check('record has instruction field', typeof top.instruction === 'string');
  check('record has scope field', top.scope && top.scope.type === 'eof');
}
```

**Step 2: Run, expect FAIL.**

**Step 3: Implement**

Modify `synthesizeAndCommit` (and the equivalent path in `runAnchoredCommand`) to pass `surface`, `instruction`, `scope` down to whichever code adds the history record. The cleanest path: have `applyEdits` and `replaceDocument` accept an optional `lensMeta` parameter:

```javascript
async function applyEdits(envelope, currentDocRaw, lensMeta = null) {
  // ... existing validation ...
  // When building the history record:
  const histRecord = {
    ts: Date.now(),
    kind: 'edit_batch',
    envelope,
    ...(lensMeta && {
      surface: lensMeta.surface,
      instruction: lensMeta.instruction,
      scope: lensMeta.scope,
    }),
  };
  // ... existing commit ...
}
```

Then `synthesizeAndCommit` passes `lensMeta = { surface, instruction, scope: { type: 'eof' } }` (or `block` for anchored, or `document` for default-slash).

**Step 4: Run, expect PASS.**

**Step 5: Commit**

```bash
git add seeds/rewritable.html tests/lens.mjs
git commit -m "feat(lens): extend rwa_hist with surface/instruction/scope"
```

### Task 9.2: Raise rwa_hist cap to 1000

**Files:**
- Modify: `seeds/rewritable.html` `commitDoc` — change `histArr.slice(0, 15)` (or wherever the cap lives) to `histArr.slice(0, 1000)`.

**Step 1: Find the cap. Grep for `slice(0, 15)` or similar in seeds/rewritable.html.**

**Step 2: Change to `1000`. No new test — covered by the existing harness ensuring history grows.**

**Step 3: Commit**

```bash
git add seeds/rewritable.html
git commit -m "feat(lens): raise rwa_hist cap from 15 to 1000"
```

### Task 9.3: History pane (UI / visual)

Optional minimal pane. Add a button to the lens chrome that toggles a side panel listing `rwa_hist` entries with `instruction`, `surface`, and `ts`. No test required.

```bash
git add seeds/rewritable.html
git commit -m "feat(lens): minimal collapsible history pane"
```

---

## Phase 10: Slash-discriminator polish

### Task 10.1: Paste-detection hint

**Files:**
- Modify: `seeds/rewritable.html` lens input wiring.

**Step 1: Write the test**

```javascript
console.log('\n== Test L10.1: paste-detection hint shown for slash-leading code paste ==');
{
  const input = window.document.getElementById('rwa-lens-input');
  // Simulate paste event with multi-line content containing additional slashes.
  const e = new window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'clipboardData', { value: { getData: () => '/path/to/file\n/another/path' } });
  input.dispatchEvent(e);
  await new Promise(r => setTimeout(r, 10));
  const hint = window.document.getElementById('rwa-lens-paste-hint');
  check('paste hint visible', hint && !hint.hidden);
  check('hint mentions \\/ escape', /\\\//.test(hint?.textContent || ''));
}
```

**Step 2: Run, expect FAIL.**

**Step 3: Implement**

In `buildUI` lens scaffolding, add a hint container `<div id="rwa-lens-paste-hint" hidden></div>`. Add paste handler:

```javascript
let pasteHintShown = false;
lensInput.addEventListener('paste', (e) => {
  const text = e.clipboardData?.getData('text/plain') || '';
  const triggers = text.startsWith('/') && text.includes('\n') && (text.match(/\//g) || []).length > 1;
  if (triggers && !pasteHintShown) {
    pasteHintShown = true;
    const hint = document.getElementById('rwa-lens-paste-hint');
    hint.textContent = 'Looks like content — escape the leading slash with \\/ to insert literally.';
    hint.hidden = false;
    setTimeout(() => { hint.hidden = true; }, 5000);
  }
});
```

**Step 4: Run, expect PASS.**

**Step 5: Commit**

```bash
git add seeds/rewritable.html tests/lens.mjs
git commit -m "feat(lens): paste-detection hint for slash-leading multi-line pastes"
```

---

## Phase 11: Streaming / in-flight UX (defer or minimal)

The spec defers full streaming to §11.2 (conservative direction). For v1 you can skip streaming entirely and render the full response on completion — the `runAnchoredCommand` already does this. If you want a streaming indicator (visual only), add a spinner to `lens.dataset.busy = 'true'` while the agent call is in flight.

### Task 11.1: Busy indicator

**Files:**
- Modify: `seeds/rewritable.html` `runAnchoredCommand`, `submitLens` (default-slash branch).

In `runAnchoredCommand` and the default-slash branch of `submitLens`, set `lens.dataset.busy = 'true'` before the agent call and clear after. Add CSS for `[data-busy]` showing a spinner. No test required (visual).

```bash
git add seeds/rewritable.html
git commit -m "feat(lens): busy indicator during in-flight commands"
```

---

## Phase 12: Regenerate references; integration sanity

The spec says the bootstrap is the source of truth and `hello.html` / `re-write-able-spec.html` are regenerated from it (CLAUDE.md).

### Task 12.1: Regenerate hello.html and re-write-able-spec.html

**Step 1: Read each reference file's existing `DOC_UUID` and `INLINE_DOC` content. Re-emit each with the updated bootstrap.**

The repo's existing CLI (`rwa new` / `rwa import`) is the right tool — but those produce *fresh* containers. For an in-place re-emit preserving DOC_UUID and INLINE_DOC, do it by hand:

```bash
# For each reference (hello.html, re-write-able-spec.html):
# 1. Read its DOC_UUID (grep -E "const DOC_UUID = '([^']+)'" file)
# 2. Read its INLINE_DOC body (between the marked backticks)
# 3. Read seeds/rewritable.html
# 4. Substitute DOC_UUID and INLINE_DOC in the seed copy
# 5. Write back to the reference path
```

A small node script in `tools/regenerate-refs.mjs` is reasonable.

**Step 2: Sanity-load each reference** in jsdom (extend `tests/lens.mjs` or write `tests/refs.mjs`) and check the lens UI mounts. If both load and the lens appears, regeneration is correct.

**Step 3: Commit**

```bash
git add hello.html re-write-able-spec.html tools/regenerate-refs.mjs
git commit -m "chore(refs): regenerate references against new lens runtime"
```

### Task 12.2: Run the full existing test suite

```bash
cd tests && npm test       # existing rwa-edit/1 e2e
cd tests && npm run test:lens  # new lens tests
cd ../benchmark && npm run conformance  # 42 conformance scenarios
```

All three should pass. Conformance is the most likely to surface regressions: the lens additions must not break the rwa-edit/1 protocol invariants. If conformance fails, the most likely cause is `applyEdits` or `replaceDocument` rejecting an envelope they previously accepted because of the new class-lock check; verify the conformance scenarios don't include `.rwa-locked` blocks (they shouldn't), and if they do, update the check to skip when `lockedRanges` is empty.

### Task 12.3: Update CLAUDE.md

Add a short note under "What re-write-able is" describing the lens model and pointing at the spec:

> **Lens edit model.** As of v0.9 of `docs/specs/rwa-lens-spec.md`, the runtime ships a single steerable input (the lens) replacing the modal `⌘K`. Two states (default, anchored), slash discriminator for command-vs-text, every gesture compiles to existing rwa-edit/1 envelopes. Class-declared locks (`class="rwa-locked"`) extend frozen-zone enforcement.

Commit:

```bash
git add CLAUDE.md
git commit -m "docs(claude): note lens edit model in repo guide"
```

---

## Phase 13 (optional): Deferred items

The spec's §11 lists six deferred items. None block v1. If you want to take any on later:

- **§11.1 Plain Enter footgun mitigation** — tightening of the placeholder-text and submit-hint, no protocol work.
- **§11.2 Streaming protocol extension** — invasive; touches rwa-edit/1, not just the lens.
- **§11.3 Sub-block anchoring** — would require a richer selection model; defer.
- **§11.4 Multi-anchor** — shift-click to add, click to release; non-trivial.
- **§11.5 Drag affordance details** — the conservative drag handler is fine for v1; refinement waits for usage.
- **§11.6 Bare class-locks through replace_document** — `data-lock-id` proposal; gated on whether v1 coexistence pattern proves too burdensome.

---

## Final sanity checklist

Before declaring v1 done:

- [ ] All twelve invariants from the spec hold in the harness (write a final integration test that exercises each).
- [ ] No regressions in `tests/e2e.mjs` (existing rwa-edit/1) or `benchmark/`'s conformance run.
- [ ] References (`hello.html`, `re-write-able-spec.html`) regenerated and load cleanly.
- [ ] CLAUDE.md updated.
- [ ] Spec saved at a stable path (`docs/specs/rwa-lens-spec.md`) and the plan references it.

---

*End of plan. Implementation order is sequential by phase; within a phase, tasks can be reordered if a particular implementation choice changes the dependency structure. Estimated effort: 30–50 commits across roughly 15–25 working hours, depending on familiarity with the existing seed runtime.*
