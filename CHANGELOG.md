# Changelog

Notable changes to `re-write-able`. The container format is versioned in `re-write-able-spec.md`; the edit protocol in `rwa-edit-spec.md`. The CLI follows semver in `cli/package.json`.

## 2026-05-02 — rwa-edit/1 anchor-based modify pathway

The headline change: the agent now edits documents via **surgical anchor-based edits** instead of returning a fully rewritten document. Format drift across edits — the slow accumulation of model-driven whitespace, attribute reordering, comment removal, "improvements" to class names — is eliminated, because the model never re-emits the unchanged regions.

### What changed for users

- **`Cmd+K` is now a multi-turn tool-use conversation** (preferred model: any with strong tool-use; Claude Sonnet, GPT-4 family, Gemini Pro 1.5+). The agent submits `(find, replace)` pairs via the `apply_edits` tool. The runtime validates and commits atomically. On validation failure, the runtime feeds back a structured error and the model retries — up to 3 attempts per `Cmd+K`.
- **Wholesale rewrites still work**, via the `replace_document` escape hatch — used for scaffolding fresh documents or honoring explicit redesign requests. The runtime never falls back automatically; the model picks consciously.
- **New failure modes surface as status messages** in the palette and as structured payloads in the browser console:
    - `find_not_unique` — the model's anchor matched multiple places. Returned with occurrence count and surrounding-context snippets.
    - `frozen_zone_violation` — the edit tried to write reserved marker text or `data-rwa-frozen`.
    - `frozen_zone_corrupted` — author-declared frozen zones must be preserved byte-identically; this fires if any name or inner content changed, or a new zone was introduced.
    - `structural_shape_changed` — `<script>`/`<style>` tag counts must not change via `apply_edits`. Use `replace_document` for that.
    - `parse_error_post_apply` — the resulting doc didn't parse as valid HTML.
    - `replace_too_large` — a single replacement exceeds the 8 KB cap (nudges the model toward smaller edits).
    - `target_size_exceeded` — the resulting doc exceeds 1 MB.
    - `concurrent_modify` — a second `Cmd+K` while one is in flight is rejected immediately.

### What changed for document authors

- **Frozen zones are now a first-class feature.** Wrap any region in paired comment fences and the runtime refuses to modify the content between them — across both `apply_edits` and `replace_document`. Three forms:
    ```html
    <!-- rwa:frozen:begin invariants -->
    <meta name="schema-hash" content="b3a8...">
    <!-- rwa:frozen:end invariants -->
    ```
    ```css
    /* rwa:frozen:begin theme-tokens */
    :root { --accent: oklch(...); }
    /* rwa:frozen:end theme-tokens */
    ```
    ```js
    // rwa:frozen:begin api-contract
    window.runtime.shared.put('!tracker-tasks', tasks);
    // rwa:frozen:end api-contract
    ```
    Or mark a whole `<script>` / `<style>` element with `data-rwa-frozen`.

    Frozen zones can only be **added or removed by external editing of the container file**. The agent cannot introduce, alter, or delete them — that's the point.

- **LF-only line endings** are now an on-disk invariant. The runtime canonicalizes at read, validate, and commit time. CRLF input is normalized; the bootstrap captures itself LF-only at boot.

### What changed for the seed

- New constants and helpers in the bootstrap:
    - `canonLF`, `RWA_EDIT` (caps and reserved-marker list), `RwaEditError`.
    - Validator: `containsReservedMarker`, `countOccurrences`, `nearbySnippets`, `extractFrozenZones`, `frozenZonesIntact`, `parseHtmlFragment`, `computeShape`, `shapesEqual`, `dataRwaFrozenSnapshot`, `snapshotsEqual`.
    - `commitDoc` — single IDB transaction across `rwa_doc`, `rwa_undo`, `rwa_hist`. Replaces the v0.7 read-modify-write sequence that wasn't atomic.
    - `applyEdits`, `replaceDocument` — the validators-and-committers behind the two tools.
    - New `modify()` lifecycle: mutex → multi-turn tool conversation → validate → commit → re-render.
    - `TOOL_SCHEMAS`, new `SYSTEM_PROMPT` framing the agent as editor (not author).
- `rwa_hist` schema migrates from free-form prompt strings to typed records (`{ ts, kind, envelope }` for `edit_batch`; `{ ts, kind, reason }` for `replace_document`). Legacy entries coexist and cycle out within ~15 modifies.
- `escapeTL` LF-canonicalizes; FROZEN-bytes capture LF-canonicalizes.

### What changed for references

- `hello.html` and `re-write-able-spec.html` are now **regenerated from the seed**, inheriting the new bootstrap. Each preserves its own `DOC_UUID`, `RWA.FILE`, and `INLINE_DOC` content.

### What changed for the CLI

- `cli/src/seed.mjs`'s `escapeTL` mirrors the seed's LF canonicalization. Bumps `cli/package.json` to **v0.2.0** because freshly-emitted containers ship with the new modify pathway.

### What changed for documentation

- New `rwa-edit-spec.md` (v1.4) defines the edit protocol end to end: tool schemas, the multi-turn loop, frozen-zone enforcement, structural-shape preservation, atomic commit, audit log, failure modes, system prompt skeleton, validator pseudocode.
- `re-write-able-spec.md` (container spec) is unchanged at v0.8 — the bootstrap byte-identity invariant is preserved; only the contents of the modify pathway change.
- `CLAUDE.md` updated: editor-first agent contract, expanded reserved-namespaces list (now includes `rwa:frozen:*` markers, `data-rwa-frozen`, `data-rwa-id`, `#rwa-doc-mount`, and `rwa_hist` `kind` field), regenerate-from-seed convention for references.

### What changed for testing

- New `tests/` directory. `tests/e2e.mjs` is a 26-assertion harness that loads the seed in jsdom with `fake-indexeddb` and a stubbed `fetch`, drives `modify()` through every spec scenario, and verifies the resulting IDB state and DOM. Run with `(cd tests && npm install && npm test)`. The first regression test in this repo.

### Backward compatibility

- **Existing containers in IndexedDB are unaffected.** A container committed with the v0.7 single-shot bootstrap keeps using its own bootstrap until `Cmd+S` writes a new version. Nothing in the IDB schema changes.
- **`rwa new` and `rwa import` produce v1 containers.** A user who upgrades the CLI gets the new pathway in newly-emitted containers; their old containers continue to work as before.
- **The bootstrap byte-identity invariant holds.** The bootstrap of any v1 container is byte-identical to any other v1 container (modulo `DOC_UUID`, `RWA.FILE`, and `INLINE_DOC` body) — the v0.7 invariant is preserved.

## Earlier history

This is the first published changelog. Prior development is in the git log:

- 2026-04-* — `rwa` CLI (offline `rwa new` + `rwa import md/html/txt`), canonical `seeds/` layout, npm package renamed to `rewritable`.
- container spec v0.8 — preserve substantial pasted content; raise `max_tokens` to 32 000.
- container spec v0.7 — per-container UUID-namespaced IndexedDB, closing the cross-container shadowing footgun under `file://`.
- earlier drafts (v0.4 – v0.6) — the architecture got worked out the hard way.
