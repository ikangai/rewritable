# Changelog

All notable changes to the `rewritable` CLI (`rwa`).

## [0.8.0] - 2026-06-16

### Added
- **`rwa workspace create <dir>` / `rwa workspace sync [dir]`** — a folder-level
  control center. `create` writes `<dir>/rwa-index.html`, a `workspace`-kind
  rewritable whose editable body holds durable shared context (workspace memory,
  guidelines, examples, open questions) and whose frozen `#rwa-workspace` JSON
  manifest lists the sibling rewritables in that directory. `sync` refreshes the
  manifest from the current `.html` files on disk (non-recursive; skips the index
  and non-rewritables) while preserving the edited context block. `create` refuses
  to overwrite an existing index without `--force`. Intentionally small: no
  document merging, no automation, no skill-host runtime.
- **`rwa new --kind workspace`** — scaffold the workspace index directly (prefer
  `rwa workspace create` so the manifest is filled from the directory inventory).

### Changed
- **New seed** (shipped with `rwa new`): containers now open in **Document** mode
  and unlock editing in **Edit** mode (`runtime.mode`/`setMode`/`on('mode')`).
  Inline manual edit becomes a **single click** on a leaf text block (caret lands
  where you click; double-click remains a compatibility path); clicking a
  non-editable container still anchors the lens. New **selection commands** —
  select text and type or dictate `make it bold` / `italic` / `inline code`,
  compiled locally with no model call. The `self-description/1` mirror gains the
  first-party `workspace` kind (`workspace: []`), kept in step across
  `cli/src/identity.mjs` and the reference oracle.

## [0.7.0] - 2026-06-11

### Added
- **`atomic` backend** — atomic.chat, a local OpenAI-compatible MLX server on
  `http://127.0.0.1:1337/v1` (no key, real multi-turn `tool_calls`). Select with
  `--backend atomic`; `$RWA_ATOMIC_URL` overrides the base URL. A per-backend
  `max_tokens` was introduced (atomic 8192, others 32000, `$RWA_MAX_TOKENS`
  overrides) because atomic rejects requests past its `MAX_KV_SIZE` rather than
  clamping. Backend routing is pinned by `tests/backends.mjs` (an unwired backend
  name must not silently fall back to OpenRouter).

## [0.6.0] - 2026-06-11

### Added
- **Connected shares in the seed** — `rwa new` containers carry the ↗ share panel:
  publish to a stable `<short>.rewritable.ikangai.com/` URL, re-publish a new
  version under a Bearer token, or stop sharing. The update token is stored only
  machine-locally (`rwa_state`), never in the DOM or the exported file.

## [0.5.0] - 2026-06-10

### Added
- **`rwa clone --localize-images`** — make a clone self-contained by inlining each
  remote `<img src>` as a `data:` URI. Each image is fetched through the same
  SSRF-guarded core as the page (`fetchImageDataUri`; image/* only, raw bytes —
  the CLI has no canvas to recompress), bounded per-image (2 MB) and total (8 MB).
  Graceful: a failed, oversized, non-image, or over-budget fetch leaves that
  `<img>` at its remote URL and prints a `note:` — one bad image never fails the
  clone. Relative `src` resolves against the page URL. Default `rwa clone` is
  unchanged (content-only, remote images kept).

### Changed
- **`rwa edit <instruction>` virtualizes embedded images** (rwa-edit-spec.md §19,
  seed parity): the model's prompt carries the document with each `data:image`
  `src` replaced by a compact `rwa-asset:<hash8>` token — a 200 KB photo no
  longer costs ~170K prompt tokens — and the model's token-form envelope is
  expanded back to real bytes before the atomic write. An invented token fails
  as `unknown_asset_reference` (exit 3) with the same self-correcting hint
  surface as other failure codes.
- **Raw envelope paths fail loud on broken images**: a piped / `--plan`
  envelope that introduces a *new* `rwa-asset:` token (bytes nowhere) is
  rejected as `unknown_asset_reference` instead of committing a permanently
  broken image. Pre-existing tokens in the document stay editable.

## [0.4.0] - 2026-05-31

### Added
- **`rwa create <task...>` / `rwa draft <task...>`** — scaffold *and* agent-fill a new
  rewritable in one shot from a natural-language task. The leading word picks a frame
  (a cwd `data-rwa-template` match, else a built-in kind) by the same template-first
  precedence as `rwa new`; the rest is the brief. Flags: `--kind`, `--from <file>`,
  `--data <file>` (or `-` for stdin), `--out`, `--force`/`--open`, and the
  `--backend`/`--model`/`--base-url`/`--api-key` backend flags. Output is held to a
  **code-enforced self-containment bar** (no runtime CDN/remote `<script src>`,
  `<link href>`, `@import`, `url()`, `srcset`, …) — visualizations are hand-rolled
  SVG/Canvas, data is embedded; a violation fails loud (exit 4) and writes no file.
  The write is atomic (temp-then-write); a failed run leaves nothing at `--out`. The
  API key is used only for the model call and is never baked into the artifact.
- **`rwa new <name>` bare-word kind dispatch** — a bare first positional now resolves
  template-first, then falls back to a built-in kind. `rwa new presentation` makes the
  built-in deck instead of erroring; a cwd `data-rwa-template="<name>"` file still
  overrides the built-in. Unknown words error naming both misses (lists the known
  kinds).
- **`rwa publish <file>`** — publish a local rewritable to the hosted share service and
  print the share URL (`<short>.rewritable.ikangai.com`, 24h anonymous share).
  `--url` overrides the base; `--json` emits the result/error object. Intentionally
  online (the offline-first invariant of `new`/`import` does not apply to publishing).

Exit codes are stable across the write verbs: `0` ok · `1` usage · `2` file ·
`3` envelope · `4` agent.
