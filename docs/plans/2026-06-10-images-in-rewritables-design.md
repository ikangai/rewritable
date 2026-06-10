# Images in rewritables — single-file, agent-lean, drag-and-drop

**Date:** 2026-06-10
**Status:** Implemented in the seed (branch images-v1; `tests/image-assets.mjs` blocks A–G). CLI mirror + service re-vendor pending (gated on an in-flight CLI card). Normative contract now lives in `rwa-edit-spec.md` §19; insert surfaces in `rwa-lens-spec.md` §6.3.
**Owner:** torvalds
**Companions:** `rwa-edit-spec.md` (caps + validation), `re-write-able-spec.md` §5.3/§5.7 (storage tiers), `docs/specs/rwa-lens-spec.md` (insert surfaces)

## Goal

Let users put images into a rewritable while the rewritable stays a **single self-contained `.html` file**, and make the GUI experience a pleasure: drag a photo onto the page, paste a screenshot, done. No server, no sidecar files, no build step.

## Current state (verified 2026-06-10)

1. **Inline `data:` URIs already work end-to-end.** `rwa import` of a `.docx` emits mammoth's images as `data:image/*;base64` URIs; `sanitizeMammothUrls` explicitly allows `data:image/*` on `<img src>` (`cli/src/import.mjs:172-176`, mirrored in `service/public/import.html`). They render via `renderDoc`'s `innerHTML`, persist through the atomic IDB commit, and serialize through `buildFile`/`escapeTL` untouched — base64's alphabet contains no `` ` ``, `\`, or `${`, so escaping is a no-op on the payload. The seed even ships `img{max-width:100%;height:auto;border-radius:6px}` baseline CSS.
2. **The agent boundary is the real problem.** `buildUserPrompt` sends the entire doc verbatim (`<DOC>…</DOC>`, seed :5743). A single 500 KB photo is ~680 KB of base64 ≈ 170K tokens — it blows the context, the cost, and frequently the model. Worse, `MAX_REPLACE` (8 KB/edit) makes any edit that quotes an `<img>` tag fail, and `MAX_DOC` (1 MB) caps the whole document including image bytes.
3. **OPFS is not the answer for durability.** The spec routes binary blobs to OPFS (`runtime.fs.*`), but OPFS is unavailable under `file://` in Chromium (`re-write-able-spec.md` §5.3) — and `file://` is the primary way rewritables open. Platform reality (CLAUDE.md): *the exported `.html` on disk is the only durable artifact*. Anything stored outside the file is one iOS-Safari eviction away from gone.
4. **No GUI ingestion exists.** No drop handlers anywhere; both paste handlers (`lens`, inline edit) extract `text/plain` only.
5. `computeShape` doesn't track `<img>`, so the agent can already freely add/move/delete image tags — no validation change needed there.

## Approaches considered

### A — Inline `data:` URIs + agent-side virtualization (CHOSEN)

Image bytes live **in the document itself** as `<img src="data:image/webp;base64,…">`. The file is self-contained by construction — ⌘S, undo, history, hosted `/r/`, `rwa doc`, publish-site all work today with zero serialization changes. The agent never sees the bytes: at the modify() boundary the runtime swaps each data-URI for a compact token (`src="rwa-asset:<hash8>"`), and the apply layer expands tokens back before commit.

* **Pro:** preserves the load-bearing invariant *"bootstrap is byte-identical except `INLINE_DOC` contents"* — no spec-invariant change. One storage format, and it's the format docx import already produces, so existing imported docs get the agent-shield retroactively for free. No hydration/GC/blob-URL lifecycle. Works identically across all surfaces (file://, hosted, CLI).
* **Con:** undo frames (10×) and the IDB doc string carry the image bytes (a 3-image doc ≈ 1–2 MB → ~15 MB undo store; acceptable, and capped by the per-image budget below). Regex scans (`setSourceMap`, frozen-zone scan) run over a larger string — linear, still fast at single-digit MB.

### B — Runtime asset store (`rwa_assets` IDB store + second serialized slot in the file)

Doc carries `<img data-rwa-asset="id">`; bytes live in a new IDB store, resolved to blob URLs at render; ⌘S writes a second template-literal/JSON slot next to `INLINE_DOC`.

* **Pro:** doc string stays tiny everywhere (undo, sourceMap, agent) without a virtualization layer.
* **Con:** breaks the byte-identical-bootstrap invariant (new serialized slot ⇒ spec bump + `buildFile` second backtick-walk + CLI `seed.mjs` mirror + service vendored mirror + hosted suppress/sink seams + `rwa doc`/import/identity all need to learn the slot). Render needs an asset-resolution pass and blob-URL lifecycle; deletion needs GC; boot needs file→IDB hydration; an un-⌘S'd container whose IDB is evicted loses images that the *doc text* still references. Roughly 4× the surface area of A for the same user-visible result.

### C — External/remote URLs (what `rwa clone` keeps today)

Not self-contained; breaks offline and longevity. Stays allowed (clone keeps remote `https://` images) but is explicitly *not* the image story. A later "localize images" affordance can convert C → A (see Deferred).

**Decision: A.** B's only real advantage (lean doc string) is recovered in A by the virtualization layer exactly where leanness matters — the agent prompt and the edit-protocol caps — without touching serialization, the spec invariant, or the five aligned import/seed sites.

## Design

### 1. Storage format (the doc is the store)

An inserted image is a normal block:

```html
<figure data-rwa-id="b12">
  <img src="data:image/webp;base64,…" alt="Team offsite, Vienna">
  <figcaption>Team offsite, Vienna</figcaption>
</figure>
```

No new attributes, no reserved namespace in the stored form. `FIGURE` is already in the `injectMissingBlockIds` anchorable list, so click-to-anchor and `data-rwa-id` stability work unchanged. Bare `<img>` (no figure) is also legal — imports produce it; the GUI inserter always wraps in `<figure>` for caption + anchoring ergonomics.

### 2. Agent virtualization (`rwa-asset:` tokens)

**Virtualize (doc → agent):** before building the agent prompt, scan the doc for `src="data:image/…"` attributes and replace each URI with `rwa-asset:<hash8>` where `hash8` = first 8 hex chars of SHA-256 of the URI. The mapping `{hash8 → dataURI}` is held for the modify call. Identical images dedupe to one token naturally. The agent sees:

```html
<img src="rwa-asset:3fa9c21b" alt="Team offsite, Vienna">
```

**Expand (apply → commit):** token expansion lives in the **apply core** (`applyEdits`/`replaceDocument` in the seed, mirrored in `cli/src/apply-edits.mjs`, re-vendored to `service/lib/`): after edits are applied to the virtual doc and all validation passes, every `src="rwa-asset:H"` is replaced from the mapping. Hash-keyed (not ordinal) tokens are order-independent, so the agent can freely move, duplicate (token expands twice), or delete (token simply never expands) images.

**Validation runs on the virtual form.** `MAX_DOC` (1 MB) and `MAX_REPLACE` (8 KB) are measured on the tokenized doc — the *text* budget — so image bytes never collide with edit-protocol caps. A separate **container budget** caps total file size (see §5). A `replace` that references a token absent from the mapping fails loudly as `unknown_asset_reference` (new rwa-edit/1 failure code; feeds back as `tool_result` like the others — no silent broken images). The agent prompt rules gain one line: *image `src` values are opaque `rwa-asset:` tokens — move or delete the whole tag, never edit the token.*

**What does NOT change:** the rwa-edit/1 wire format. Envelopes that quote raw `data:` URIs remain legal on every raw-envelope path (piped `rwa edit`, hosted `/modify`); virtualization is applied at *agent* boundaries (seed `modify()`, CLI `agent-loop.mjs`), expansion at *apply* boundaries everywhere. `rwa_hist` stores the (compact) virtual-form envelopes — a nice side effect. `rwa_undo` stores full expanded docs, as today.

### 3. GUI — the pleasure part

Three insert surfaces, one ingestion pipeline, all riding the existing **non-agent commit path** (`runtimeApplyEnvelope` → R5 `nonAgentCommitChain`, actor `user:image-drop` / `user:image-paste`). No LLM call, instant, one ⌘Z frame.

* **Drag-drop (primary).** `dragover` on `#rwa-doc-mount` with `image/*` files shows a horizontal insertion bar at the nearest block boundary (reuse the lens-anchor block geometry: `clientY` vs anchorable-block midpoints). Drop → ingest → splice a `<figure>` envelope at that boundary. Multi-file drop inserts in order. Drop outside any block appends to the end (same as default-append).
* **Paste.** A document-level `paste` handler (active when neither lens input nor inline edit owns the event): if `clipboardData.files`/items contain `image/*` — the screenshot case — ingest and insert at the lens anchor if one is set, else append. The lens input itself gets the same check so pasting an image "into the lens" does the obvious thing instead of nothing.
* **File picker fallback.** `/image` in the lens opens a native file picker (anchored → insert at anchor; the discoverable path for users who don't know about drag-drop). Listed in the lens placeholder hints alongside `/skin`.
* **Feedback.** Toast on insert: `Added offsite.jpg — 184 KB (resized from 3.2 MB)`. The dirty-state nudge already covers "remember to ⌘S".
* **Selected-image affordances (small, v1).** Hovering an image shows a 28px corner chip with ✕ (remove — non-agent commit deletes the enclosing `<figure>`/`<img>`, undoable) and the current size badge. Clicking the image anchors the lens to its figure, so *"make this smaller"*, *"add a caption"*, *"move this above the intro"* all work through the existing anchored `/`-command path with zero new machinery — the agent sees a 60-byte tag, not 600 KB.
* **Alt text.** Default = filename stem; the figcaption is editable via the existing double-click inline edit (figcaption joins the leaf-editable set). Optional v2: an "describe for alt text" anchored command.

### 4. Ingestion pipeline (deterministic, client-side)

```
File/Blob → createImageBitmap → downscale (long edge ≤ 1600px, EXIF-honoring)
  → canvas.toBlob('image/webp', 0.82)   // Safari <17 fallback: 'image/jpeg', 0.85
  → if encoded ≥ original, keep original bytes
  → FileReader → data URI → <figure> envelope
```

* PNG screenshots: try WebP-lossless-ish (q0.9); keep PNG if smaller. GIF (animation) and SVG pass through un-recoded, subject to the per-image cap. SVG enters as `data:image/svg+xml` on `<img src>` only — same no-script rationale already documented in `sanitizeMammothUrls`.
* **Per-image budget: 500 KB encoded** (post-pipeline). Over budget after downscale → second pass at 1280px/q0.7; still over → refuse with a clear toast (`Image too large even after compression — try cropping`). Fail loud, never silently degrade to a thumbnail.
* This is mechanical transform code — no model involved (Rule 5).

### 5. Caps & platform

* **Container budget:** warn at 5 MB total file size (status-bar indicator next to the dirty dot: `2.1 MB`), hard-stop inserts at 10 MB. IDB and FSA handle this fine; the constraint is taste + iOS memory.
* **Print/export:** images print as-is; `print-color-adjust:exact` already set. ⌘S unchanged.
* **escapeTL/buildFile:** unchanged — verified the backtick-walk and escaping are payload-transparent for base64.

### 6. Surface parity

| Surface | Change |
|---|---|
| Seed `modify()` | virtualize before prompt; `unknown_asset_reference` handling |
| Seed apply core | token expansion post-validation; caps on virtual form |
| Seed GUI | drop/paste/`/image` + ingestion pipeline + hover chip |
| `cli/src/apply-edits.mjs` | mirror expansion + virtual-form caps (hand-mirror, as ever) |
| `cli/src/agent-loop.mjs` | virtualize before prompt (parity with seed) |
| `service/lib/*` | re-vendor per `VENDORED.md` (cmp-gated) |
| `rwa doc` | plain mode prints the raw doc (bytes are the contract); `--json` gains `images: [{hash8, bytes, mime}]` in the self-description extras (nice-to-have, v1-optional) |
| Specs | `rwa-edit-spec.md`: token expansion, `unknown_asset_reference`, caps-on-virtual-form (version bump). `re-write-able-spec.md`: note inline-data-URI as the durable image tier; OPFS remains the tier for *non-doc* blobs. CLAUDE.md routing entry. |

### 7. Error handling

* Unsupported file type on drop → toast, no commit.
* Encode failure (corrupt file) → toast with the browser error, no commit.
* `unknown_asset_reference` → structured tool_result, agent retries (≤3), then surfaces like every other failure code.
* Budget exceeded → refuse insert, doc untouched.
* A doc whose data URI was hand-mangled outside the runtime: virtualization only matches well-formed `src="data:image/…"`; mangled ones pass through to the agent as-is (today's behavior — no regression).

### 8. Testing

* `tests/image-assets.mjs` (jsdom): virtualize/expand round-trip (byte-identical doc on no-op), dedupe, move/duplicate/delete via apply_edits on virtual form, `unknown_asset_reference`, caps measured on virtual form, expansion ordering vs frozen-zone snapshot (image inside `data-rwa-frozen` must stay byte-identical — virtualization must NOT rewrite frozen regions' bytes when prompting? It may tokenize for the *prompt*; the apply-side frozen snapshot compares stored bytes, which are untouched — pin this).
* `cli/tests/apply-edits.test.mjs`: mirror parity for expansion + caps.
* Ingestion pipeline: pure-function unit tests on the transform (dimension math, format selection, budget logic) with canvas mocked; one real-browser proof page (pattern: `tests/csp-7b-probe.html`) for drag-drop → render → ⌘S → reopen.
* Conformance: IMG-01 (insert via envelope renders + survives commit), IMG-02 (agent move/delete on virtual form), IMG-03 (caps).

### 9. Scope

**v1 (this design):** inline-data-URI storage; virtualization/expansion in seed + CLI + vendored service; drag-drop, paste, `/image`; ingestion pipeline with budgets; hover ✕ chip; click-to-anchor figure; tests + spec bumps.

**Deferred:**
* *Localize remote images* (`rwa clone --localize-images`, and a per-image "make local" chip on remote `<img>`) — network + CORS-taint caveats in-browser; clean in the CLI.
* *Alt-text via model* (anchored command exists anyway; a dedicated affordance is sugar).
* *Resize/crop UI* (S/M/L width presets via the anchored agent path cover most needs).
* *`rwa import` recompression* of oversized mammoth images through the same pipeline (CLI has no canvas; needs a pure-JS encoder — evaluate `sharp`-free options or accept v1 passthrough).
* *Image gallery / OPFS-backed media library* — explicitly out; YAGNI until a real consumer.

## Why this is the right shape

The single-file constraint is the product. Approach A is the only option where **the constraint enforces itself** — bytes in the doc are bytes in the file, with no hydration, GC, or eviction story. The two genuine costs (agent context, edit caps) are paid at exactly one seam — the boundary the architecture already treats as special ("the agent never sees the bootstrap" extends naturally to "the agent never sees the pixels") — and the GUI work is pure addition on the existing non-agent commit path that inline manual edit and skinning already proved out.
