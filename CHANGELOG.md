# Changelog

Notable changes to `re-write-able`. The container format is versioned in `re-write-able-spec.md`; the edit protocol in `rwa-edit-spec.md`. The CLI follows semver in `cli/package.json`.

## 2026-05-04 — CSV import (CLI + service)

`rwa import data.csv` and `rewritable.ikangai.com/import` accept CSV. The first row becomes `<thead>`, remaining rows `<tbody>`; every cell is HTML-escaped. Parses RFC 4180 — quoted commas, embedded newlines, escaped quotes, BOM — via PapaParse.

### What changed for users

- **`rwa import data.csv` is supported** by the CLI. Output is `<article><table>…</table></article>` wrapped in the seed.
- **`/import` accepts `.csv` alongside `.md`/`.markdown`** in the browser. Same drop zone, same flow.
- Parse warnings (e.g. malformed trailing quote) print to stderr (CLI) or are silently kept (browser, matching the CLI's "lenient" semantics — the result is still produced).

### What changed for the CLI

- `cli/src/import.mjs` gains `convertCsv()`. The `convert(ext, content)` switch grows a `case 'csv'` branch and the unsupported-format error message lists `.csv`.
- `cli/package.json` adds `papaparse@^5.4.1` (pinned to match cdnjs's latest, so the browser path can stay byte-equivalent).
- `cli/README.md` documents the CSV branch.

### What changed for the service

- `service/public/import.html` loads `papaparse@5.4.1` from cdnjs with a pinned **SRI hash** (`sha512-dfX5uYVXzyU8…`) alongside the existing pinned `marked`.
- `convertCsv` is a verbatim port of the CLI's; the file picker accepts `.csv,text/csv`; the handler dispatches on extension; the basename-stripping regex covers `.csv`.
- No new server-side code — the conversion stays in the browser.

### What changed for documentation

- `README.md` and `cli/README.md` mention CSV.
- `CLAUDE.md` extends the service conventions: `convertCsv` is now part of the CLI ↔ browser mirror, and the SRI-bump procedure covers both libraries.

### What changed for testing

- **Byte-equivalence test (load-bearing):** with the canonical seed, a stable `DOC_UUID`, and a fixture exercising RFC 4180 edge cases (quoted commas, embedded newlines, escaped quotes), `rwa import` and the browser-simulated `/import` produce byte-identical 37 422-byte outputs. A second fixture covering BOM + HTML-special chars in cells (`<script>`, `&amp;`, `<b>bold</b>`) also matches byte-for-byte at 37 347 bytes; cells are correctly HTML-escaped (no script can inject from a CSV cell).
- Manual: rebuilt the local Docker container, dropped both fixtures into `localhost:8083/import`, downloaded files opened in Chromium, table rendered, ⌘K still reached the agent.

### Backward compatibility

- Strict addition. Existing `rwa import .md/.html/.txt` paths are untouched.
- New CLI dependency: `papaparse`. `npm i -g rewritable` will pull it transitively; no opt-in needed.
- Bumping `papaparse` later requires recomputing the SRI hash and updating both `cli/package.json` and `service/public/import.html`; the procedure is documented in `CLAUDE.md`.

### Known limitations

- The imported `<table>` ships unstyled. The seed's stylesheet doesn't define table CSS, so a freshly imported CSV renders with default browser table styling against the dark body background — readable but plain. Users can prompt the agent (⌘K "make this table readable" / "add zebra striping") to style it. This matches how md tables behave on the existing path; adding default table CSS would be a separate decision affecting both paths.

## 2026-05-04 — `/import` endpoint: browser-side markdown import on the hosted service

The hosted service grows a sibling to `/new`. Visit `rewritable.ikangai.com/import`, drop a `.md` file, get back a re-writeable container with the markdown rendered into `INLINE_DOC` — no install, no upload.

### What changed for users

- **New page `/import`** (service). A drop zone + file picker that accepts `.md` / `.markdown`, converts client-side via `marked` (GFM enabled), and downloads a fresh container with a server-issued `DOC_UUID` and a filename-derived `<title>`.
- **`/new` carries a cross-link** to `/import`, and `/import` links back to `/new`. Both pages stay self-contained.
- **The file never leaves your machine.** Conversion runs in the browser; the server only serves the static page and the existing `/rewritable.html` (which already mints fresh UUIDs).

### What changed for the service

- `service/server.js` adds a single `/import` route (six-line addition) returning a static `service/public/import.html`. The `isHead` closure handles `HEAD /import` for free.
- `service/public/import.html` is a single self-contained page (~150 lines incl. styling). It loads `marked@14.1.4` from cdnjs with a pinned **SRI hash** (`sha512-oUb+v+OGnC4ls...`). The version is aligned with `cli/package.json`'s resolved `marked` so `/import` and `rwa import` produce byte-identical output.
- The conversion module ports three pieces of `cli/src/seed.mjs` and `commands.mjs` logic — `escapeTL` + LF canonicalization, the `INLINE_DOC` backtick-walk, and `<title>` / `FILE:` substitution. The CLI remains the source of truth; the browser is the mirror. **`DOC_UUID` substitution is not ported** — the server's `/rewritable.html` endpoint already substitutes a fresh UUID before the seed reaches the browser.
- Zero new server-side dependencies. No multipart parsing, no upload size limits, no `marked` on the server.
- `service/public/new.html` gains one anchor: `<p><a href="/import">import an existing markdown file instead</a></p>`.

### What changed for documentation

- `CLAUDE.md` grows a "Conventions when editing the service (`service/`)" section: the zero-dep rule, the keep-conversion-client-side rule, the import.html ↔ cli/src/seed.mjs mirror clause, and the SRI bump procedure.
- `docs/plans/2026-05-04-server-import-design.md` records the design (decisions, alternatives weighed, error surfaces, test strategy, future work for HTML/TXT/CSV).

### What changed for testing

- No new automated harness — the change is six lines of server route plumbing plus a static page. Verification is layered:
    - **Syntax checks:** `node --check` on `server.js`; `vm.createScript` on the inline browser script.
    - **Smoke tests** against a running server: `/health`, `/`, `/new`, `/import`, `HEAD /import`, `/rewritable.html`, and `/nonexistent` all return correct status, headers, and content.
    - **Byte-equivalence check (load-bearing):** with the canonical seed, a stable `DOC_UUID`, and a fixture markdown that exercises the gnarly cases (literal backticks, `${...}`, code blocks, blockquotes — the inputs that exercise `escapeTL`), `rwa import` and the browser-simulated `/import` produce byte-identical 37 529-byte outputs. This is the test that gates correctness; promoting it to an automated jsdom check is queued.
- Manual browser test: dropped a real `.md` into `localhost:8083/import` against the rebuilt Docker container; download fired, opening the resulting `.html` in Chromium showed the expected `<article>` and ⌘K reached the agent. The bootstrap is intact.

### Backward compatibility

- `/import` is a strict addition. `/new`, `/rewritable.html`, `/health`, and the `/` redirect are unchanged.
- No new environment variables, no migrations. Build → push → restart. Rollback = previous image.
- Bumping `marked` later requires recomputing the SRI hash and updating `import.html`; the procedure is documented in `CLAUDE.md`.

### Future work (not in this change)

- TXT import (trivial port of `convertTxt` from `cli/src/import.mjs`), then CSV import (new ground — the CLI doesn't support it), then HTML import (with a visible script-tag warning before download).
- Automated jsdom test that diffs `/import` browser output against `rwa import` for a fixture set.

## 2026-05-02 — hardening (low-priority sweep): popUndo, applySeedSubs, HEAD, comment-resilient HTML import, reserved IDs

A second pass at the LOW findings from the same bug hunt that produced the morning's HIGH/MEDIUM fixes. None of these are user-visible failures on the happy path; they tighten edge cases and defenses.

### What changed

- **`popUndo()` is now atomic** (seed). The read+write of `rwa_undo` runs in a single `readwrite` transaction, so two rapid `⌘Z` keypresses can no longer both observe the same array, both pop the same entry, and both write back the same shortened state. Previously: two presses, one undo. Now: two presses, two undos.
- **`applySeedSubs` validates `<title>` and `RWA.FILE` match counts** (CLI). Until now only `DOC_UUID` was guarded; a future seed regression that removes or duplicates the title/FILE site would have silently no-oped. All three substitution sites now enforce exactly-one-match-or-throw.
- **HEAD requests no longer return a body** (service). Per RFC 9110 §9.3.2. Refactored `send` into a per-request closure that observes `req.method === 'HEAD'` and ends the response with no body for HEAD.
- **`rwa import` of HTML survives comment-embedded `</head>`** (CLI). HTML comments are stripped before head/body extraction, so a literal `<!-- </head> -->` in the head no longer truncates the head match and let head-only content (e.g. `<style>`) leak into the body. Comments themselves are dropped — acceptable for an offline import; full preservation would require a real parser.
- **Reserved IDs cannot be introduced by `apply_edits` or `replace_document`** (seed). Both validators now reject any payload whose parsed DOM contains `#rwa-doc-mount` (the runtime's render mount, per CLAUDE.md "Reserved namespaces") or `[data-rwa-id]` (reserved for v2). Surfaces as `reserved_id_used` with the offending name in the structured payload.

### What changed for the seed

- New helper `findReservedIdViolation(parsedDoc)` returning the offending reserved name or null.
- `applyEdits` and `replaceDocument` call it after `parseHtmlFragment` and before `commitDoc`.
- `popUndo` rewritten as a single-transaction promise (no API change for callers).

### What changed for testing

- `tests/e2e.mjs` grows from 33 to 35 assertions:
    - **Test 12:** `replace_document` with `<div id="rwa-doc-mount">` is rejected; doc unchanged.
    - **Test 13:** `replace_document` with `[data-rwa-id]` is rejected; doc unchanged.
- The atomic `popUndo` and the HTTP HEAD fix are not exercised in the harness (concurrency-shaped and HTTP-shaped, respectively); both are verified by inspection and by smoke. The applySeedSubs and convertHtml fixes are smoke-tested via `rwa new` and `rwa import` against a fixture HTML containing `<!-- </head> -->`.

### Backward compatibility

- IDB shape unchanged; existing containers continue to work.
- `reserved_id_used` is a new failure code; no doc previously committed by the runtime would trip it (the doc-mount lives in the bootstrap, not in `INLINE_DOC`).
- The bootstrap byte-identity invariant still holds within this release across seed/hello.html/spec.html.

## 2026-05-02 — hardening: undo race, FSA stale handle, parallel tool_calls

Three correctness fixes on the rwa-edit/1 modify pathway, found by an autonomous bug-hunt over the runtime, CLI, service, and tests. All landed against the canonical seed and were regenerated into `hello.html` and `re-write-able-spec.html`. The container spec stays at v0.8 and the edit protocol stays at rwa-edit/1 (v1.4) — these are implementation corrections, not contract changes.

### What changed

- **`⌘Z` is now rejected while a `⌘K` is in flight** (HIGH). Previously, an undo pressed during the agent's fetch would `popUndo` and write `rwa_doc`, then `commitDoc` resolving inside `modify()` would clobber the doc and re-push the *pre-undo* doc onto the undo stack — silently destroying the user's revert and the popped state. `undo()` now checks `modifyMutex` and surfaces `✗ modify in progress`. The popped state is preserved for the next `⌘Z` once the modify completes.
- **Stale `FileSystemFileHandle` is purged on permission denial** (MEDIUM). When a saved handle's permission could not be regranted (file moved, access revoked, OS-level lockout), `commit()` fell through to a download blob — but left the dead handle in IDB, so every subsequent `⌘S` repeated the cycle and downloaded forever. The handle is now deleted from `rwa_<DOC_UUID>.rwa_fsa` on `permission !== 'granted'`, and the next `⌘S` re-prompts via `showSaveFilePicker`.
- **Parallel `tool_calls` no longer break retries** (MEDIUM). When the model emits two or more `tool_calls` in one assistant message, the runtime processes only the first. Previously, the failure feedback loop echoed the *full* `tool_calls` array back into the conversation but only emitted a `tool_result` for the consumed call — providers (OpenAI/OpenRouter spec) reject any assistant message whose `tool_calls` aren't all paired with `tool_results` on the next turn, so the next fetch returned HTTP 400 and the user saw a provider error instead of the structured rwa-edit retry. The runtime now echoes only `[tc]`.

### What changed for the seed

- New `idbDel` helper alongside `idbGet` / `idbPut`, scoped to a single read/write transaction.
- `undo()` gains the `modifyMutex` early-return guard.
- `commit()` calls `idbDel(RWA.FSA)` on the denied-permission branch and re-throws as `'permission denied — re-pick on next ⌘S'`.
- `modify()` retries push `tool_calls: [tc]` (the consumed one) instead of the full `toolCalls` array, in both the malformed-JSON and the `RwaEditError` branches.

### What changed for testing

- `tests/e2e.mjs` grows from 26 to 33 assertions. Two new scenarios:
    - **Test 10:** in-flight `⌘K` blocks `⌘Z`. Stubs `fetch` with a never-resolving promise, calls `modify()`, then awaits `undo()` and asserts the doc and the undo stack are unchanged. Resolves the fetch and asserts the modify completes cleanly.
    - **Test 11:** a model response with two parallel `tool_calls` triggers a retry that echoes only the consumed call. Asserts the retry assistant message has exactly one `tool_call` and that its id matches the consumed one.
- The FSA fix is *not* exercised in the harness: `FileSystemFileHandle` carries methods, and `fake-indexeddb`'s structured-clone roundtrip drops or rejects function-bearing values, so jsdom can't faithfully simulate the denied-permission path. The fix is verified by inspection; integration coverage requires a real Chromium harness.

### Backward compatibility

- Existing IDB state is unaffected. Containers committed with the morning's rwa-edit/1 bootstrap continue to work; their bootstrap upgrades only on the next `⌘S`.
- The bootstrap byte-identity invariant still holds: any container's bootstrap is byte-identical to any other (modulo `DOC_UUID`, `RWA.FILE`, and `INLINE_DOC` body) within a release. Across the morning and afternoon releases of 2026-05-02, the bootstrap differs by ~12 lines.

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
