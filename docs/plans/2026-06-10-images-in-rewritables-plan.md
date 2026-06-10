# Images in Rewritables — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Inline data-URI images in the doc, with agent-side `rwa-asset:` token virtualization and drag-drop/paste/`/image` GUI insertion, per `docs/plans/2026-06-10-images-in-rewritables-design.md`.

**Architecture:** Image bytes live in the doc as `<img src="data:image/…">` (already legal — docx import emits them). The agent and the edit-protocol caps never see the bytes: every agent boundary virtualizes URIs to `src="rwa-asset:<hash8>"` tokens; the apply core validates on the virtual form and expands tokens back before commit. GUI inserts ride the existing non-agent commit path (R5 queue) in token form. CLI mirror + service re-vendor follow, gated on kay's in-flight card.

**Tech stack:** seed JS (no deps), jsdom+fake-indexeddb tests (`tests/`), Node test mirrors (`cli/tests/`).

**Branch/worktree:** `images-v1` in `.worktrees/images-v1` (shared root checkout has kay's uncommitted CLI work — do NOT touch `cli/src` or `service/lib` until Task 12's gate).

**Working rules for every task:** TDD (`superpowers:test-driven-development`); run `node <suite>.mjs` from `tests/`; commit with explicit paths only (multi-agent tree); seed changes regenerate refs ONLY in Task 10 (not per-task — refs regen rewrites two big files; once at the end keeps commits reviewable).

---

## Phase A — virtualization core (seed)

### Task 1: Worktree + test scaffold

**Step 1:** `git worktree add .worktrees/images-v1 -b images-v1` (from repo root, branched off current `main`).
**Step 2:** `cd .worktrees/images-v1/tests && npm install` (worktree has no node_modules).
**Step 3:** Create `tests/image-assets.mjs` with the harness header copied from `tests/inline-edit.mjs:14-58` (jsdom + fake-indexeddb + fetch-throws guard), loading `../seeds/rewritable.html`. Add the `check(label, cond)` counter + non-zero exit tail (same file, bottom). Run `node image-assets.mjs` → "harness loaded", exit 0.
**Step 4:** Commit (`tests/image-assets.mjs`): `test(seed): image-assets harness scaffold`.

### Task 2: `virtualizeImages` / `expandImages` helpers

**Files:** Modify `seeds/rewritable.html` (insert after `containsReservedMarker`, ~line 1897). Test `tests/image-assets.mjs`.

**Step 1 — failing tests (block A):**
- A1 round-trip: a doc with two `<img src="data:image/png;base64,AAAA…">` (one duplicated) → `virtualizeImages(doc)` returns vdoc with `src="rwa-asset:<8hex>"`, 1 map entry for the duplicate pair (dedupe), and `expandImages(vdoc, assets)` === original byte-for-byte. WHY: round-trip identity is the invariant everything else stands on.
- A2 substring coherence: `virtualizeWithMap(slice, assets)` of any slice containing a whole URI equals the corresponding vdoc slice. WHY: anchored-command finds are doc slices.
- A3 unknown token: `expandImages('… src="rwa-asset:deadbeef" …', new Map())` throws `RwaEditError` code `unknown_asset_reference`. WHY: fail loud, no silent broken images.
- A4 orphan tolerance: a token present in the doc BEFORE virtualization (user-authored, unmapped) survives expansion unchanged when passed via the `orphans` set. WHY: a pre-broken doc must stay editable.
- A5 single-quote `src='data:image/…'` form round-trips.

Helpers are exposed for tests like other seed internals: `window.__virtualizeImages` etc. (jsdom-gated like `__synthesizeAnchoredInsert`, seed :4064).

**Step 2:** Run → FAIL (functions undefined).

**Step 3 — implementation** (verbatim, after `containsReservedMarker`):

```js
// ─── Image-asset virtualization (rwa-edit/1 §images) ────────────────
// The agent never sees image bytes: data:image URIs are swapped for compact
// rwa-asset:<hash8> tokens at every agent boundary, and expanded back in the
// apply core after validation. Caps (MAX_DOC/MAX_REPLACE) are measured on the
// token form — the TEXT budget — so pixels never collide with the protocol.
// FNV-1a (not crypto) — identity/dedupe within one doc, not integrity.
function rwaAssetHash8(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
const RWA_ASSET_SRC_RE = /(\bsrc\s*=\s*)(["'])(data:image\/[^"']*)\2/g;
const RWA_ASSET_TOKEN_RE = /(\bsrc\s*=\s*)(["'])(rwa-asset:[0-9a-f]{8,})\2/g;
function registerImageAsset(assets, uri) {
  let n = 1, token;
  do { token = 'rwa-asset:' + rwaAssetHash8(n === 1 ? uri : uri + '\0' + n); n++; }
  while (assets.has(token) && assets.get(token) !== uri);
  assets.set(token, uri);
  return token;
}
function virtualizeImages(doc, assets) {
  assets = assets || new Map();
  // Orphans: rwa-asset tokens already present in the raw doc (user-authored or
  // pre-broken). They map to nothing; expansion must pass them through, not throw.
  const orphans = new Set();
  let m;
  RWA_ASSET_TOKEN_RE.lastIndex = 0;
  while ((m = RWA_ASSET_TOKEN_RE.exec(doc)) !== null) orphans.add(m[3]);
  const vdoc = doc.replace(RWA_ASSET_SRC_RE, (_, p, q, uri) => p + q + registerImageAsset(assets, uri) + q);
  return { doc: vdoc, assets, orphans };
}
// Apply the URI→token substitution to ANY string (prompt slices, commitBase).
// Plain split/join: URIs are long and quote-free, no regex-escape worries.
function virtualizeWithMap(s, assets) {
  if (!s || !assets || assets.size === 0) return s;
  let out = s;
  for (const [token, uri] of assets) out = out.split(uri).join(token);
  return out;
}
function expandImages(vdoc, assets, orphans) {
  return vdoc.replace(RWA_ASSET_TOKEN_RE, (whole, p, q, token) => {
    const uri = assets ? assets.get(token) : null;
    if (uri == null) {
      if (orphans && orphans.has(token)) return whole;
      throw new RwaEditError('unknown_asset_reference', null, { token });
    }
    return p + q + uri + q;
  });
}
```

Note `virtualizeWithMap` iterates token→uri but splits on `uri` joining `token` — write it exactly as above. Expose the four under `window.__…` in the jsdom gate block.

**Step 4:** Run → block A green. **Step 5:** Commit (`seeds/rewritable.html tests/image-assets.mjs`): `feat(seed): image-asset virtualize/expand core + tests`.

### Task 3: Thread `opts.assets` through `applyEdits` / `replaceDocument` / `commitDoc`

**Files:** `seeds/rewritable.html` — `applyEdits` (:4539), `replaceDocument` (:4642), `commitDoc` (:4482), `FAILURE_HINTS` (:5751). Test block B.

**Step 1 — failing tests (block B):** drive via `window.__…` exposed `applyEdits` (already reachable? if not, expose in jsdom gate). Fixture: real doc with one image figure; `const { doc: vdoc, assets, orphans } = virtualizeImages(real)`.
- B1 move: apply_edits on vdoc moving the `<figure>` (find/replace quote the token) with `{assets, orphans}` → committed doc (via `getDoc()`) has the figure moved WITH the full data URI; `rwa_undo` top frame is the REAL pre-edit doc. WHY: undo must restore pixels, not tokens.
- B2 duplicate: replace token-bearing tag with two copies → both expand.
- B3 delete: remove the figure → no token, no URI in committed doc.
- B4 invented token in `replace` → `unknown_asset_reference`, doc unchanged.
- B5 caps on virtual form: a vdoc whose REAL form is >1 MB (big URI) but virtual form small → edit succeeds (no `target_size_exceeded`); and a `replace` quoting a real URI >8 KB without assets still fails `replace_too_large` (today's behavior preserved when no assets passed).
- B6 frozen image: image inside `<div data-rwa-frozen>` — an unrelated edit succeeds and frozen bytes are byte-identical after expansion; an edit touching the frozen img rejects `frozen_zone_corrupted`. WHY: virtual-vs-virtual snapshot equality must hold.
- B7 hist stores the VIRTUAL envelope (compact) — read `rwa_hist[0].envelope`, assert token not URI.

**Step 2:** FAIL. **Step 3 — implementation:**

In `applyEdits`, signature unchanged (`opts` grows keys `assets`, `orphans`). After the `MAX_DOC` check (:4619) and the `noCommit` early-return (:4627 — compose stays VIRTUAL; modify()'s final compose commit expands), replace the tail:

```js
  if (opts && opts.noCommit) return work;

  const histRecord = { ts: Date.now(), kind: 'edit_batch', envelope };
  if (lensMeta) { /* …unchanged… */ }
  let commitCur = currentDoc, commitWork = work;
  if (opts && opts.assets) {
    commitCur = expandImages(currentDoc, opts.assets, opts.orphans);
    commitWork = expandImages(work, opts.assets, opts.orphans);
  }
  return await commitDoc(commitCur, commitWork, histRecord, opts && opts.assets, opts && opts.orphans);
```

`replaceDocument` gains a 5th param `opts` (after `frozenBypass`) with the same expansion before its `commitDoc` call. `commitDoc(currentDoc, newDoc, histRecord, assets, orphans)`: in the `__rwaCommitSink` branch ONLY, expand the envelope's strings before handing to the sink (the server applies on the REAL doc):

```js
  if (typeof window.__rwaCommitSink === 'function') {
    let envelope = histRecord.kind === 'edit_batch'
      ? histRecord.envelope
      : { version: 'rwa-edit/1', doc: newDoc, reason: histRecord.reason };
    if (assets && envelope.edits) envelope = { ...envelope, edits: envelope.edits.map(e =>
      ({ ...e, find: expandImages(e.find, assets, orphans), replace: expandImages(e.replace || '', assets, orphans) })) };
    …
```

(Known v1 limitation, documented in Task 11: an image-bearing edit through the hosted sink will trip the server's 8 KB cap — hosted+images is deferred.)

Add to `FAILURE_HINTS` (seed :5751): `unknown_asset_reference: 'src uses an rwa-asset: token that does not exist in this document. Copy tokens verbatim from existing <img> tags; never invent or edit them.',`

**Step 4:** block B green, then `node e2e.mjs && node lens.mjs && node skin-compose.mjs` → all green (no-assets paths byte-equivalent). **Step 5:** Commit: `feat(seed): apply core expands rwa-asset tokens; caps measured on virtual form`.

## Phase B — agent boundaries (seed)

### Task 4: `modify()` + `modifyViaBridge()` virtualize

**Files:** `seeds/rewritable.html` `modify()` (:5779) and `modifyViaBridge()` (:5984). Test block C.

**Step 1 — failing tests (block C):** stub backend per `tests/lens.mjs` pattern (mock `window.fetch` returning an OpenAI-shaped `tool_calls` response).
- C1 prompt lean: doc with a 200 KB data URI; mock captures the request body; assert body contains `rwa-asset:` and does NOT contain `data:image/` — and is < 10 KB total. WHY: the entire feature's point.
- C2 agent move round-trip: mock returns apply_edits quoting the token → committed doc has real URI at the new location.
- C3 agent invents token → mock gets a `tool` retry message containing `unknown_asset_reference` (retry feedback, no silent escalation), and after retries exhaust the doc is unchanged.
- C4 compose (skin) on an image doc: drive `applySkinL1` path with the compose mock (see `tests/skin-compose.mjs` helpers) → ONE commit, theme present, image URI intact. WHY: compose threads `commitBase` through the same map.
- C5 bridge: `modifyViaBridge` single-shot envelope quoting a token → expands on commit (mock `RWA.BRIDGE_URL` fetch).

**Step 2:** FAIL. **Step 3 — implementation in `modify()`:**

```js
    const realCur = canonLF((opts && opts.baseDoc != null) ? opts.baseDoc : await getDoc());
    // Virtualize ONCE per call; commitBase (compose) is scanned into the SAME map
    // so every string in this call speaks one token vocabulary.
    const v = virtualizeImages(realCur);
    if (opts && opts.commitBase != null) virtualizeImages(canonLF(opts.commitBase), v.assets);
    const cur = v.doc;
    const frozenZones = extractFrozenZones(cur);
```

- every `applyEdits(…, cur, lensMeta, editOpts)` call: `editOpts` becomes `{ ...(opts && opts.compose ? { noCommit: true } : null), assets: v.assets, orphans: v.orphans }` (build once before the loop as `editOpts`; note it is now always non-null — the compose-refusal checks test `editOpts.noCommit`, adjust the two `if (editOpts)` guards (:5901, :5908) to `if (editOpts.noCommit)`).
- `replaceDocument(envelope, cur, lensMeta)` calls gain `, null, { assets: v.assets, orphans: v.orphans }`.
- compose tail (:5930-5936): `base`/`finalDoc` are virtual; `commitBase` must be too: `const commitBase = (opts.commitBase != null) ? virtualizeWithMap(canonLF(opts.commitBase), v.assets) : cur;` and the final `replaceDocument(…, commitBase, lensMeta, null, { assets: v.assets, orphans: v.orphans })`.
- `compileDslPlan(envelope, cur)` already receives the virtual `cur` — correct as-is.

`modifyViaBridge`: same three lines (virtualize after `getDoc`), same opts on its three apply calls.

**Step 4:** block C green + `node skin-compose.mjs` (89/89) + `node bridge.mjs`. **Step 5:** Commit: `feat(seed): modify()/bridge virtualize image srcs at the agent boundary`.

### Task 5: `runAnchoredCommand` virtualize

**Files:** `seeds/rewritable.html` (:3960). Test block D.

**Step 1 — failing tests (block D):** anchored command on an image figure (single-shot mock per lens tests): D1 prompt contains token not URI; D2 response keeping the token commits with real URI; D3 response with invented token → retry with `unknown_asset_reference` context, then clean failure.

**Step 2:** FAIL. **Step 3:** in `runAnchoredCommand`, after `modifyMutex = true`: read the real doc once — `const realDoc = canonLF(await getDoc()); const v = virtualizeImages(realDoc);`. Then:
- `buildAnchoredContextWindow(anchor)` output strings: wrap → `const target = virtualizeWithMap(rawTarget, v.assets)` etc. (target/context are doc slices, so A2's substring-coherence applies).
- envelope construction (:5993-6001): `find: virtualizeWithMap(find.find, v.assets)`, `replace: virtualizeWithMap(find.replacePrefix, v.assets) + response + virtualizeWithMap(find.replaceSuffix, v.assets)` — `response` is already token-form (the model saw tokens).
- apply: `await applyEdits(envelope, v.doc, lensMeta, { assets: v.assets, orphans: v.orphans })` (replacing `await getDoc()`).
- `validateAnchoredResponse` / `handlePostCommitAnchor` take `response` (token form) — tokens parse as plain attributes; no change.

**Step 4:** block D + `node lens.mjs` (254 checks) green. **Step 5:** Commit: `feat(seed): anchored commands virtualize image srcs`.

### Task 6: `SYSTEM_PROMPT_RULES` image rule

**Step 1:** Inside the `rwa:extract:begin SYSTEM_PROMPT_RULES` block, add one rule line alongside the `data-rwa-id` guidance: `Image src values appear as opaque "rwa-asset:<id>" tokens. They are stable identifiers for embedded images: move, copy, or delete the whole <img>/<figure> tag freely, but never edit a token, invent a new one, or replace one with a URL.`
**Step 2:** `node ../cli/tests/seed-extract.test.mjs` if present, else `node -e` smoke the extractor (`cli/src/seed-extract.mjs`) still parses. Run `node e2e.mjs`.
**Step 3:** Commit: `feat(seed): system-prompt rule for rwa-asset tokens`.

## Phase C — GUI (seed)

### Task 7: Non-agent insert path (`assets` through the R5 queue)

**Files:** `seeds/rewritable.html` — `runtimeApplyEnvelope` (:882), `synthesizeAndCommit` (:4094), `commitCore` (:4116). Test block E.

**Step 1 — failing tests (block E):**
- E1: `runtimeApplyEnvelope(env, { surface:'image:insert', actor:'user:image-drop', assets: new Map([[token, uri]]) })` where `env.edits[0].replace` carries the token → committed doc has the URI; hist actor `user:image-drop`; ⌘Z (`undo()`) restores. WHY: GUI inserts must not trip MAX_REPLACE.
- E2: token-form envelope WITHOUT assets option → `unknown_asset_reference` (fail loud, not silent broken img).

**Step 2:** FAIL. **Step 3:** `runtimeApplyEnvelope` passes `options.assets` → `synthesizeAndCommit(envelope, surface, instruction, actor, assets)` → `commitCore(envelope, surface, instruction, actor, undefined, assets)` (note `frozenBypass` stays 5th; keep order). In `commitCore`, where the doc is read (:4160/:4171/:4173): when `assets` present, virtualize: `const real = canonLF(await getDoc()); const v = virtualizeImages(real, new Map(assets));` then pass `v.doc` as currentDoc and `{ assets: v.assets, orphans: v.orphans }` as the opts to `applyEdits`/`replaceDocument` (the caller's new-image entries merge with the doc's existing map because `virtualizeImages` takes the seeded map). Without `assets`: byte-identical today's path (guard everything on `assets`).
**Step 4:** block E + `node write-path.mjs && node r5-concurrent-commit.mjs && node region-commit.mjs` green. **Step 5:** Commit: `feat(seed): non-agent commit path accepts image assets`.

### Task 8: Ingestion pipeline

**Files:** `seeds/rewritable.html` — new block after the inline-edit block (after `handleMountDblClick` region, before the lens-anchor section). Test block F.

**Step 1 — failing tests (block F)** for the PURE helpers (canvas-free): F1 `rwaImageTargetDims(4000,3000)` → `{w:1600,h:1200}`; portrait + no-upscale cases. F2 `rwaPickSmaller(origBlobBytes, encodedBytes)` keep-original logic. F3 `rwaImageBudgetOk(len)` 500 KB boundary. F4 `buildImageFigure(token, alt)` emits `<figure><img src="TOKEN" alt="ESCAPED"></figure>` with `escapeHtml`-escaped alt.

**Step 2:** FAIL. **Step 3 — implementation:**

```js
// ─── Image ingestion (images-v1) ─────────────────────────────────────
// Deterministic transform, no model (Rule 5). Downscale to ≤1600px long edge,
// encode WebP q0.82 (JPEG fallback where toBlob/webp is unsupported — Safari
// <17), keep the original bytes when re-encoding doesn't help, refuse >500 KB
// after the 1280px/q0.7 second pass. SVG/GIF pass through un-recoded.
const RWA_IMG = { MAX_EDGE: 1600, RETRY_EDGE: 1280, Q: 0.82, RETRY_Q: 0.7, MAX_BYTES: 500 * 1024, FILE_WARN: 5 * 1024 * 1024, FILE_STOP: 10 * 1024 * 1024 };
function rwaImageTargetDims(w, h, maxEdge = RWA_IMG.MAX_EDGE) {
  const edge = Math.max(w, h);
  if (edge <= maxEdge) return { w, h };
  const k = maxEdge / edge;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}
async function rwaBlobToDataUri(blob) { … FileReader readAsDataURL promise wrapper … }
async function rwaEncodeBitmap(bitmap, w, h, type, q) { … canvas → toBlob promise; null on encoder-unsupported … }
async function ingestImageFile(file) {
  if (window.__rwaIngestImage) return window.__rwaIngestImage(file);   // test seam
  if (!/^image\//.test(file.type)) throw new Error('not an image: ' + (file.type || file.name));
  if (file.type === 'image/svg+xml' || file.type === 'image/gif') {
    if (file.size > RWA_IMG.MAX_BYTES) throw new Error('image too large even for passthrough — try a raster export');
    return { dataUri: await rwaBlobToDataUri(file), bytes: file.size, name: file.name, resizedFrom: null };
  }
  const bitmap = await createImageBitmap(file);
  // pass 1 at MAX_EDGE/Q (webp, jpeg fallback), keep original if smaller,
  // pass 2 at RETRY_EDGE/RETRY_Q if over budget, throw if still over —
  // exactly the design §4 ladder. Returns {dataUri, bytes, name, resizedFrom}.
  …
}
```

Implement the ladder fully (it's ~30 lines); pure helpers exposed via the jsdom gate for tests.

**Step 4:** block F green. **Step 5:** Commit: `feat(seed): image ingestion pipeline (downscale→webp, budget ladder)`.

### Task 9: Insert surfaces — drop, paste, `/image`, hover ✕

**Files:** `seeds/rewritable.html` — same new block, `renderDoc` listener wiring (:989-995 pattern), `submitLens` (:3695), bootstrap chrome `<style>` (drop-bar + chip CSS). Test block G.

**Step 1 — failing tests (block G):** override `window.__rwaIngestImage = async f => ({dataUri:'data:image/png;base64,QUJD', bytes:3, name:'x.png'})`.
- G1 drop: dispatch a `drop` event on a block with `dataTransfer.files=[fakeImageFile]` → doc gains `<figure><img src="data:image/png;base64,QUJD" alt="x">` AFTER that block (below-midpoint clientY); hist `actor:'user:image-drop'`, `surface:'image:insert'`. ⌘Z restores.
- G2 drop above midpoint → inserted BEFORE the block; drop on mount background → appended at EOF.
- G3 paste with an image item, lens anchored → inserted after anchor, actor `user:image-paste`; with inline edit open → handler defers (no commit).
- G4 `/image` in submitLens routes to the picker opener (spy `window.__rwaOpenImagePicker`).
- G5 hover ✕: `mouseover` an `<img>` shows the chip; clicking it deletes the enclosing figure (envelope, actor `user:image-delete`), ⌘Z restores.
- G6 budget stop: `__rwaIngestImage` returning a URI that would push the doc past `FILE_STOP` → refused with toast, doc unchanged.
- G7 frozen: drop targeting a block inside `data-rwa-frozen` → appended at EOF instead (never splices into frozen).
- G8 dirty + dblclick-style gating: insert while `modifyMutex` held queues via the R5 chain (it does by construction — assert both commits land).

**Step 2:** FAIL. **Step 3 — implementation sketch (follow it closely):**

- `findDropTarget(e)`: from `e.target`, walk up to the nearest `ANCHORABLE_TAGS` element inside `#rwa-doc-mount` that is NOT inside `[data-rwa-frozen]`/`.rwa-locked`, resolve its sourceMap entry (same walk as `handleMountClick` :2430). Returns `{entry, before}` (`before` = clientY above the block's `getBoundingClientRect()` midpoint) or null.
- `insertImageAt(ingested, target)`: `const assets = new Map(); const token = registerImageAsset(assets, ingested.dataUri);` alt = filename stem, `escapeHtml`'d. Envelope: target ⇒ `find` = doc slice for `entry` (`resolveAnchorFind`-style; reuse the helper the lens insert path uses), `replace` = before ? figure+'\n'+find : find+'\n'+figure; no target ⇒ EOF append via the `resolveEofAnchor()` helper (mirror `synthesizeDefaultAppend` :4067); empty doc ⇒ `replace_document` with the figure as the whole doc (mirror commitCore's empty-doc branch). Commit via `runtimeApplyEnvelope(env, { surface:'image:insert', instruction:'image: '+ingested.name, actor, assets })`. Budget guard first: `(await getDoc()).length + ingested.dataUri.length > RWA_IMG.FILE_STOP` → toast + return; `> FILE_WARN` → `showAffordance('container is getting large — N MB')` and proceed. Success toast: `Added x.png — 184 KB (resized from 3.2 MB)` via `showAffordance`.
- Drop wiring in `renderDoc` (remove-then-add discipline, not under `activeView`): `dragover` → preventDefault + set `rwa-drop-before/after` class on the would-be target (CSS: `::before/::after` 2px `--blue` bar); `dragleave/drop` → clear class; `drop` → preventDefault, iterate `e.dataTransfer.files` filtering `image/*`, sequential `insertImageAt` (R5 queue serializes).
- Paste: ONE document-level listener registered at bootstrap (not per-render): skip when `inlineEdit` is open or the event target is inside `#rwa-lens` EXCEPT the lens-input image case (design: lens paste of an image does the obvious thing) — simplest correct rule: if clipboard has `image/*` files and no inline edit is open, ingest + insert at `lensState.anchor ?? EOF`, `preventDefault`.
- `/image`: in `submitLens` before the `anchored` branch: `const imageMatch = /^image$/.exec(instruction.trim()); if (imageMatch) { (window.__rwaOpenImagePicker || openImagePicker)(); }` — `openImagePicker()` creates a hidden `<input type=file accept="image/*" multiple>` outside the mount, `.click()`, on `change` ingests + inserts (anchor ?? EOF), actor `user:image-picker`.
- Hover chip: delegated `mouseover/mouseout` on the mount: on `IMG` (not inside frozen/locked), position one shared absolutely-positioned `✕` button at the image's top-right; click → resolve the image's enclosing anchorable entry (figure preferred, else the img's own slice via sourceMap-relative `indexOf` of its serialized open tag — if ambiguous, bail with a toast) → envelope `{find: slice (+one leading \n if present), replace: ''}` → `runtimeApplyEnvelope(…, {surface:'image:delete', actor:'user:image-delete'})`. Hide chip during `activeView`/drag.
- CSS additions go in the bootstrap chrome stylesheet (NOT the doc): `.rwa-drop-before::before, .rwa-drop-after::after { content:''; display:block; height:2px; background:var(--blue); border-radius:1px; }` + `#rwa-img-chip` styles matching the lens chrome (white card, `--gray-200` border).

**Step 4:** block G green; full `node inline-edit.mjs && node lens.mjs && node view.mjs && node e2e.mjs`. **Step 5:** Commit: `feat(seed): image insert surfaces — drag-drop, paste, /image, hover delete`.

## Phase D — integration, docs, mirrors

### Task 10: Refs + full suites + conformance

**Step 1:** `node tools/regenerate-refs.mjs` (regenerates `hello.html`, `re-write-able-spec.html`).
**Step 2:** From `tests/`: run EVERY suite in the directory (e2e, lens, view, inline-edit, skin-compose, write-path, r5-concurrent-commit, region-commit, identity, datatable, bridge, session, affordance-kernel, vault, seed-hardening, commit-sink, hosted-bless-parity, csp-boot, skill-*). All green — any red is a regression to fix BEFORE proceeding (Rule 12: no skips).
**Step 3:** `cd benchmark && npm run conformance` → 86/86 (or current count) green.
**Step 4:** Commit (`seeds/rewritable.html hello.html re-write-able-spec.html` as regenerated): `chore(refs): regenerate references for images-v1 seed`.

### Task 11: Specs + routing

**Files:** `rwa-edit-spec.md`, `docs/specs/rwa-lens-spec.md`, `CLAUDE.md`, `docs/plans/2026-06-10-images-in-rewritables-design.md`.

**Step 1:** `rwa-edit-spec.md`: new section "Image-asset virtualization" — token grammar `rwa-asset:[0-9a-f]{8,}`, virtual-form caps, `unknown_asset_reference` (add to the failure-code table), orphan-token tolerance, hist-stores-virtual, hosted-sink expansion + the 8 KB hosted limitation. Bump the closing version line (1.5 → 1.6) + trailing summary.
**Step 2:** Lens spec: add `/image` to the command list + image insert surfaces note (one short subsection; bump its version line).
**Step 3:** CLAUDE.md: add an **Images** routing entry (seed block + spec §s + `tests/image-assets.mjs`; "regenerate references after a seed change"; CLI mirror pending note until Task 12).
**Step 4:** Design doc: Status → Implemented (seed); add "Hosted limitation" note from Task 3.
**Step 5:** Commit (explicit paths): `docs(spec): rwa-edit 1.6 — image-asset virtualization; lens /image; CLAUDE.md routing`.

### Task 12: CLI mirror — **GATED on kay's card landing**

**Gate:** `git log --oneline -5 -- cli/src/apply-edits.mjs` shows kay's parity commit AND `git status --short cli/src` is clean in the ROOT checkout. If not landed, post in group chat and pause this task (do NOT edit around uncommitted work). Rebase `images-v1` over the landed main first.

**Files:** `cli/src/apply-edits.mjs`, `cli/src/agent-loop.mjs`, `cli/src/edit.mjs`; tests `cli/tests/apply-edits.test.mjs` (new image section) — read the files AS THEY EXIST post-kay before mirroring.

**Step 1 — failing tests:** mirror B1–B7 + A1/A3/A4 semantics against the CLI exports (`virtualizeImages`/`expandImages`/`applyEdits` with `{assets, orphans}`), plus: agent-loop prompt contains tokens not URIs (drive `runAgentLoop` with an injected fake backend per existing agent-loop tests).
**Step 2:** Implement: port Task 2's helpers verbatim into `apply-edits.mjs` (hand-mirror discipline, header comment names the seed lines); `applyEdits`/`replaceDocument` accept the opts and expand post-validation; `FAILURE_HINTS.unknown_asset_reference` identical text; `agent-loop.mjs` virtualizes before its `<DOC>` prompt and threads assets to apply; `edit.mjs`: ONLY the instruction (agent) path virtualizes — piped-envelope and `--plan` stay raw (documented in `cli/README.md` exit-code section if it mentions caps).
**Step 3:** `cd cli && npm test` → all green (375+ baseline + new).
**Step 4:** Commit: `feat(cli): mirror image-asset virtualization (seed parity)`.

### Task 13: Service re-vendor — gated on Task 12

Per `service/lib/VENDORED.md`: re-copy the changed `cli/src` files byte-identical, run `cd service && npm test` (cmp gate `vendored-apply.test.mjs` + functional 61+). Commit: `chore(service): re-vendor cli/src (image virtualization)`.

### Task 14: Real-browser verification + finish

**Step 1:** Build a scratch container (`node cli/bin/rwa.mjs new /tmp/img-test.html` from the worktree seed — or copy `seeds/rewritable.html`), open via chrome-devtools MCP, and verify by hand: drag-drop a real PNG (use `upload_file` on the hidden picker via `/image` if drag synthesis is flaky), confirm figure renders, ⌘Z, ⌘S download contains the data URI, reopen the saved file → image present. Take a screenshot for the record.
**Step 2:** `superpowers:verification-before-completion` — re-run ALL suites (tests/, cli/, service/, conformance) and paste counts.
**Step 3:** `superpowers:finishing-a-development-branch` — merge `images-v1` → main (ff or --no-ff per repo habit), announce in group chat (seed + CLI + vendored files touched; refs regenerated), clean up worktree. Do NOT push (Martin pushes).
