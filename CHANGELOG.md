# Changelog

Notable changes to `re-write-able`. The container format is versioned in `re-write-able-spec.md`; the edit protocol in `rwa-edit-spec.md`; the structural-transform DSL in `rwa-edit-dsl-spec.md`. The CLI follows semver in `cli/package.json`.

## 2026-05-12 — rwa-lens/1 edit model: the modal ⌘K becomes a steerable lens

The user-surface layer over rwa-edit/1 changes. The modal `Cmd+K` palette is replaced by a single steerable input — the **lens** — that has two states (default, anchored) and discriminates content from instruction via a leading slash. No new edit protocol; every gesture compiles down to an existing `apply_edits`, `apply_dsl_plan`, or `replace_document` envelope. The container spec stays at v0.8 and the edit protocol stays at rwa-edit/1 (v1.4).

The model also adds class-declared locks (`class="rwa-locked"`) as a UI-affordance layer over the existing frozen-zone mechanism, and a re-skin: the runtime ships a Claude-styled light theme (warm cream `#f5f4ef` / terracotta accent `#cd5d3c`) replacing the previous dark theme.

### What changed for users

- **The lens.** A single text input docked at the bottom of the viewport as a floating max-width 740px white card. Always present, in one of two states:
    - **Default (global).** Direct text (⌘Enter) appends a new block at end-of-document. A slash command (`/dark mode`, `/convert this to a kanban board`) runs the existing multi-turn rwa-edit/1 loop with the whole document as context.
    - **Anchored on a block.** Click any block (`<p>`, `<h1>`–`<h6>`, `<blockquote>`, `<li>`, `<figure>`, `<pre>`, `<aside>`) to anchor the lens beneath it. Direct text now *inserts* a new block after the anchor; a slash command *edits* the anchored block. The badge on the lens shows what it's targeting; `Esc` (or the badge X) releases. A "down" button re-docks at EOF.
- **Slash convention.** No leading slash → direct text (prose). Leading `/` → command. `\/` at the start of a submission produces a literal slash. Live mode indication: the lens chrome shifts (border accent + placeholder + "command" pill) as soon as the input begins with `/`, so the discriminator is visible before submit. Multi-line pastes that start with a slash surface a one-time hint (*escape with `\/` to insert literally*).
- **Class-declared locks.** `class="rwa-locked"` on any block renders it with a stripe + lock icon. Anchoring on it is rejected, edits that overlap it are rejected, and `replace_document` is rejected unless the lock is entirely contained within a marker-form frozen zone (comment fence or `data-rwa-frozen`). The UI affordance for the *this part is fixed, the rest is malleable* use case — contract templates, tax forms, press releases.
- **Collapsible history pane.** A read-only pane lists recent edits with surface (default / anchored), instruction, and scope (whole-doc / single-block). History cap raised from 15 to **1000** entries.
- **Light theme.** Bg `#f5f4ef` (warm cream), surface `#ffffff`, text `#1a1a17`, accents `#cd5d3c` (terracotta) / `#3d7fb8` (blue) / `#c84a4a` (red). Fonts unchanged. Print stylesheet adjusted: lens, history button, status pill all hidden; body padding zeroed.
- **Busy indicator.** A ⏳ pulse animates on the lens while a command is in flight, so the user can see that ⌘Enter registered.
- **Bridge backend works with anchored commands.** Anchored slash commands now route through `claude -p` when the bridge backend is selected, not just OpenRouter.

### What changed for the seed

- New CSS variables and a full re-skin: light palette, floating lens chrome with rounded-24px corners, drop shadow, focus-within glow, command-mode terracotta accent. `body` gains `padding-bottom:160px` so document content scrolls above the floating lens.
- New runtime cluster in `seeds/rewritable.html`: source-position map for `rwa_doc`, click-to-anchor, anchored/default dispatchers, EOF anchor resolution (skips locked tail), `.rwa-locked` source-range tracking, overlap check for `apply_edits` / `apply_dsl_plan`, coverage check for `replace_document`, post-commit anchor re-anchoring / release logic, paste-detection hint, collapsible history pane.
- `rwa_hist` schema extended with `surface` (`default` / `anchored`), `instruction` (user prompt verbatim), and `scope` (`whole-doc` / `single-block`); cap raised 15 → 1000. Schema is additive; existing entries continue to render.
- Direct-text submissions hold the modify mutex; submit errors surface in the lens chrome instead of silently dropping. Default-state slash commands carry `lensMeta` ({surface, scope}) into the audit record.
- New `callBridgeSingleShot` parallel to `callAgentSingleShot` so anchored commands work with both backends.
- Agent prompt for anchored slash commands names `.rwa-locked` blocks explicitly and reminds the agent that `replace_document` cannot remove them; anchored response is validated against the parent context to avoid structurally invalid HTML before envelope construction.

### What changed for the references

- `hello.html` and `re-write-able-spec.html` regenerated from the new seed against the lens runtime. Each preserves its own `DOC_UUID` and `INLINE_DOC` body; the bootstrap mirrors the seed.
- `tools/regenerate-refs.mjs` gains an optional `rewritable.html` target at the repo root so a `rwa new`-produced container can be re-skinned in place during dev.

### What changed for documentation

- New spec `docs/specs/rwa-lens-spec.md` (rwa-lens/1 v0.9). Defines the two states, the slash convention, anchor resolution, the source-position map invariant, post-commit anchor behavior, lock semantics (class-declared vs. marker-form coverage), wrapper rules per anchor type, and the failure modes that need affordances.
- `CLAUDE.md` documents the lens edit model, the four-site alignment for lens changes (spec ↔ seed ↔ regen flow), and the new light-theme palette.

### What changed for testing

- `tests/e2e.mjs`: HIST_CAP assertions updated for the new 1000-entry cap; new tests cover the anchored slash command end-to-end (prompt, validate, envelope, commit), parent-type validation, `.rwa-locked` overlap rejection on `apply_edits`, and `replace_document` coverage rejection.

### Backward compatibility

- **No edit-protocol changes.** rwa-edit/1 envelope shapes and semantics are unchanged. `apply_edits`, `apply_dsl_plan`, and `replace_document` validate identically.
- **`rwa_hist` schema is additive.** New fields (`surface`, `instruction`, `scope`) coexist with legacy entries; the history pane renders both.
- **Existing containers continue to work.** Their bootstrap upgrades only on the next `⌘S` (or by regenerating from the seed). The bootstrap byte-identity invariant still holds across containers within this release.
- **CLI and service unchanged.** Both handle the seed bytes opaquely. The CLI's bundled seed regenerates on the next `npm publish` from the canonical seed.

### Known limitations

- **Definition lists are not in v1's anchorable set.** Clicks on `<dl>`/`<dt>`/`<dd>` content traverse to the nearest anchorable ancestor or no-op.
- **Multi-block responses release the anchor.** When an agent returns more than one anchorable element from an anchored slash command, the lens releases to default with a brief affordance — v1 does not support multi-anchor.
- **The bare `.rwa-locked` class has no protocol-level preservation through `replace_document`.** Authors who want both the UI affordance and `replace_document` survival declare both forms on the same block (comment fence outside, or `data-rwa-frozen` on the same element).

## 2026-05-09 — `-o` hands the OpenRouter key to a fresh container via `?key=`

Quality-of-life fix on the `rwa new -o` / `rwa import -o` path. When `OPENROUTER_API_KEY` is set in the environment (or in a `./.env` file in the working directory), the CLI now appends it to the `file://` URL it opens as `?key=…`. The bootstrap reads the parameter on first paint, lifts it into `sessionStorage`, and immediately scrubs the URL via `history.replaceState` so the key doesn't sit in the location bar, history, or any later bookmark. Without `-o`, behavior is unchanged. Without a key in the environment, behavior is unchanged.

### What changed for users

- `rwa new -o` and `rwa import -o` will now silently bring an OpenRouter key with them when one is available. ⌘K works on first open without visiting the settings panel.
- The CLI prints `note: passing OPENROUTER_API_KEY via ?key= URL parameter` to stderr when it does so.
- A minimal `.env` parser is included (`KEY=value`, optional `export`, optional matched quotes, no interpolation, no multiline). Existing shell-exported env wins.

### What changed for the seed

- The bootstrap gains a ~10-line block right after `RWA` is defined that reads `?key=…` from `location.search`, writes it to `sessionStorage[RWA.K_API]`, and rewrites the URL via `history.replaceState`. Wrapped in `try/catch` because sandboxed `file://` contexts can throw on `history.replaceState`.

### Backward compatibility

- Strict addition. The seed bytes change only by the inserted block; bootstrap byte-identity invariant still holds across containers within this release.
- Bridge backend (`rwa_backend = bridge`) ignores the key — the URL parameter is still consumed and scrubbed, just unused.

## 2026-05-08 — bridge backend: ⌘K via local `claude -p`, plus printable containers

The runtime grows a second agent backend, selectable in the ⚙ settings panel. In addition to the existing OpenRouter HTTP path, ⌘K can now route through a localhost CLI bridge — a `web_cli_bridge`-style endpoint at `http://127.0.0.1:8765/run` that takes `{command}` and returns `{stdout, stderr, exit_code}`. The bridge spawns `claude -p`, which produces a JSON edit envelope; the runtime parses it and dispatches through the existing `applyEdits` / `compileDslPlan` / `replaceDocument` paths. For users with a Claude subscription this is free per call (vs. per-token OpenRouter cost) and uses whatever model their `claude` CLI is configured for.

In the same release, freshly-imported containers print correctly: the runtime chrome (READY pill, ⚙ button, ⌘S button) is hidden via `@media print`, and the import skills/agent are prompted to lay content out for printing.

### What changed for users

- **New "Backend" select** in ⚙ settings. Choose `OpenRouter` (existing HTTP path, requires API key) or `Bridge` (local subprocess, requires `web_cli_bridge` running and `claude` CLI installed). Persisted in `sessionStorage` as `rwa_backend`.
- When `Bridge` is selected, the OpenRouter Key + Model rows hide. They're irrelevant.
- **Containers print as documents, not as web apps.** The status pill, settings cog, and commit button are `display: none` in print media. A blank container's hero placeholder is also hidden.
- **Import paths nudge the agent toward print-fit layouts.** `rwa import --claude` and `--vision` skills are asked to keep imported invoices/letters/forms on a single page where possible, with white background, system fonts, and clean alignment.

### What changed for the seed

- New `RWA.K_BACKEND` constant; new branch in `modify()` selects the backend.
- New `callBridge()` parallel to `callOpenRouter()`. The bridge call shells out `claude -p` with the prompt + tool envelope on stdin; the response is parsed as a single JSON object matching one of the three tool envelopes (`apply_edits`, `apply_dsl_plan`, `replace_document`).
- New `@media print` block hides `#rwa-status`, `#rwa-settings-btn`, `#rwa-commit-btn`, and the empty-state hero. The doc mount itself prints as-is.

### Backward compatibility

- OpenRouter remains the default backend. Existing containers in IDB are unaffected — the `K_BACKEND` slot is read with a default of `openrouter`.
- The bridge endpoint URL is hardcoded to `http://127.0.0.1:8765/run` to match the `web_cli_bridge` convention. Containers that don't have one running surface a connection error in the palette.

## 2026-05-08 — docx + pdf import (CLI + service), with optional `--vision` and `--claude` paths for PDFs

`rwa import` and `rewritable.ikangai.com/import` now accept `.docx` and `.pdf`. By default both run a deterministic offline conversion: mammoth for docx, a pdfjs-driven paragraph heuristic for PDFs. Two opt-in paths exist for PDFs whose layout the heuristic mangles: `--vision` ships the PDF to OpenRouter and asks a vision model for clean HTML, and `--claude` spawns the user's locally-installed `claude` CLI in print mode so the agent can use its official `pdf` / `docx` skills (~/.claude/skills/) and the rich Python tooling those skills carry (pypdf, pdfplumber, pandoc, mammoth, LibreOffice).

### What changed for users

- **`rwa import file.docx`** — mammoth.convertToHtml. Warnings on unmapped styles surface via stderr.
- **`rwa import file.pdf`** — pdfjs walks text items, groups same-y items into lines, flushes paragraphs on y-jumps. Always emits a heuristic warning. Encrypted/scanned PDFs exit cleanly with an error.
- **`rwa import file.pdf --vision [--model …]`** — sends the PDF to OpenRouter (default `google/gemini-3-flash-preview`); the model returns clean HTML. Bypasses the local heuristic. Requires `OPENROUTER_API_KEY`.
- **`rwa import file.{pdf,docx} --claude [--timeout SECS]`** — spawns `claude -p` with the file path on stdin. The agent reads the file with its skill's tools, returns clean HTML on stdout. Default timeout 20 minutes. PDFs with more than ~10 pages are split into page-range chunks and run in up to 4 parallel `claude -p` subprocesses.
- **`/import` accepts `.docx` and `.pdf`** in the browser. Same drop zone, same client-side conversion, same offline guarantee.

### What changed for the CLI

- New runtime deps in `cli/package.json`: `mammoth@1.11.0`, `pdfjs-dist@5.4.149`. Pinned to match cdnjs builds so `/import` stays byte-equivalent.
- `convert(ext, content)` is now `convert(ext, bytes)` — text formats decode utf8 internally, binary formats consume bytes directly.
- `importCmd` reads the input as a `Buffer`.
- New `import-vision.mjs` — wraps OpenRouter chat completions with a base64-encoded PDF and a system prompt asking for `<article>`-wrapped HTML.
- New `import-claude.mjs` — spawns `claude -p`, manages timeout + chunking + parallelism, parses the agent's stdout to extract the `<article>` block. The skills it invokes live in `~/.claude/skills/`; the CLI does not bundle them.
- `--vision` and `--claude` are mutually exclusive and produce a clear error if both are passed.

### What changed for the service

- `service/public/import.html` accepts `.docx` and `.pdf`. mammoth + pdfjs are loaded from cdnjs (mammoth) and self-hosted at `service/public/pdf/{pdf.min.mjs,pdf.worker.min.mjs}` (pdfjs is ESM-only on cdnjs and `integrity=` on `<script type="module">` doesn't validate the URL the inline body imports — self-hosting gives real SRI).
- The browser convertDocx + convertPdf functions are verbatim ports of the CLI's. Mammoth output is passed through `sanitizeMammothUrls` (allowlist: `http`, `https`, `mailto`, `tel`, relatives, `data:image/*` for `<img src>`) — mammoth's tag vocabulary is fixed but it does **not** filter URL schemes, so a docx with a `javascript:` link would otherwise land in `INLINE_DOC` and execute on click. CLI does the same sanitization.
- Four sites must stay aligned when import logic changes: `cli/src/seed.mjs`, `cli/src/import.mjs`, `seeds/rewritable.html`, and `service/public/import.html`. Documented in `CLAUDE.md`.

### What changed for documentation

- `CLAUDE.md` extends the service conventions with the four-site mirror, the pdfjs self-hosting rationale, and the mammoth URL sanitization rule.
- `docs/plans/2026-05-08-docx-pdf-import-design.md` records the design.

### Backward compatibility

- Strict addition for both CLI and service. Existing `.md`/`.html`/`.csv`/`.txt` paths are untouched.
- New CLI runtime deps (`mammoth`, `pdfjs-dist`). `npm i -g rewritable` pulls them transitively.

## 2026-05-05 — DSL structural-transform tool (rwa-edit-dsl/1) shipped in runtime

The runtime gains a third tool, `apply_dsl_plan`, that takes a small typed DSL of structural transforms (`replace`, `insert`, `delete`, `set_attr`, plus a `replace_document` escape) and compiles them deterministically to `apply_edits` envelopes. Sugar on top of rwa-edit/1 — `apply_edits` and `replace_document` semantics are unchanged. The DSL parser is the trust boundary; compiled output flows through the existing `applyEdits` / `replaceDocument` paths so all rwa-edit/1 invariants (frozen zones, structural shape, reserved markers) still hold.

### What changed for users

- **The system prompt has been rewritten** with an explicit structural-vs-content split and a paste-verbatim rule. Even agents that never pick the new tool benefit: gemini-3.1-pro-preview's paste meanT jumped 0.22 → 1.78 on the same `apply_edits` path.
- **A third tool surface is available** to agents that prefer DSL: `replace`, `insert`, `delete`, `set_attr` ops, plus the same `replace_document` escape under a different envelope shape.
- **DSL plans share the audit log with `apply_edits`.** Both land as `kind: 'edit_batch'` in `rwa_hist` (DSL plans flatten to their compiled form before the audit record is written).

### What changed for the runtime

- `seeds/rewritable.html` gains an inline `compileDslPlan` block (~150 lines) that mirrors `benchmark/oracles/dsl-compiler.mjs`. The compiler runs each op against an in-memory shadow doc and emits a single sequential `apply_edits` envelope (or one `replace_document` envelope for the sole-op escape), then dispatches through the existing apply paths.
- `TOOL_SCHEMAS` grows a third entry for `apply_dsl_plan` with a `oneOf` op switch covering all five op shapes.
- `SYSTEM_PROMPT` is rewritten — three-tool description, structural-vs-content preference, plus rules sections per tool.
- The dispatch in `modify()` adds an `apply_dsl_plan` branch that calls `compileDslPlan` and routes the result. Compile errors are reported as `RwaEditError('malformed_envelope', i, { reason: ... })` — the existing failure shape — and flow through `failureToToolResult` → `tool_result` → retry up to 3 times.

### What changed for the references

- `hello.html` and `re-write-able-spec.html` regenerated from the new seed. Each preserves its own `DOC_UUID` and `INLINE_DOC` body; the bootstrap mirrors the seed.

### What changed for the benchmark

- `rwa-edit-dsl/1` is specified in `rwa-edit-dsl-spec.md`. v0.1, sole-source.
- `benchmark/oracles/dsl-compiler.mjs` ports the same compile-down semantics for offline use.
- `benchmark/runners/run-fidelity-dsl.mjs` is a new round-trip oracle (`npm run fidelity:dsl`): feeds each scenario's `expectedDslPlan` to the compiler, applies both the stub envelope and the compiled envelope to the fixture, and asserts byte-equal output. **12/12 expressible scenarios pass.**
- `benchmark/runners/dsl-mode.mjs` and `benchmark/runners/hybrid-mode.mjs` are real-model runners exploring the DSL-only and supervisor+worker architectures. Surfaced as `node runners/run-fidelity.mjs <model> dsl` and `... hybrid` modes.
- 89 fidelity scenarios get a `tag` field for the architecture-comparison axis (`structural_regular`, `structural_irregular`, `content`, `mixed`, `paste`, `failure_mode`, `drift`, `runtime`).
- 9 new scenarios fill gaps the May 2026 inventory pass surfaced: PASTE-01..03 (Python code, CSV, 400-word prose excerpt), IRREG-01..03 (swap-by-content, sort-by-date, multi-card move), STRUCT-01..03 (wrap_each, for_each_match, chained insert+set_attr).
- `benchmark/runners/model.mjs` instruments per-tool call counts so smoke runs can tell which tool the model picked per tag.
- `benchmark/models.json` typo fixes — gemini IDs corrected from `gemini-3-...` to `gemini-3.1-...`.

### What changed for testing

- `tests/e2e.mjs` test 63 updated for 3 tools (was hardcoded to 2).
- New tests **115a** (multi-op DSL plan: insert + set_attr round-trips through `modify()`, hist records single `edit_batch` with 2 compiled edits) and **115b** (DSL compile failure on non-unique anchor surfaces tool_result with code; model retries with corrected plan; succeeds). **274/274 e2e scenarios pass.**
- **42/42 conformance scenarios pass** against the modified seed.

### What changed for documentation

- `rwa-edit-dsl-spec.md` v0.1 — initial draft. §12 captures the production-runtime smoke results.
- `CLAUDE.md` updated: repository contents, rewrite-loop description (three tools), agent-contract section, three-site-alignment convention for DSL changes (spec ↔ runtime ↔ benchmark compiler).
- `README.md` mentions the DSL as part of the agent contract; adds `rwa-edit-dsl-spec.md` to the spec list.

### Backward compatibility

- **Strict addition.** `apply_edits` and `replace_document` envelope shapes and semantics are unchanged. Existing agents continue to work.
- **`rwa_hist` schema unchanged.** DSL plans flatten to `kind: 'edit_batch'`; consumers cannot distinguish whether an `edit_batch` came from `apply_edits` directly or from a compiled `apply_dsl_plan`.
- **No new IDB stores, OPFS paths, or HTML markers.** Reserved namespaces unchanged.
- **No CLI or service changes.** Both handle the seed bytes opaquely; no DSL-aware logic needed at those layers. The CLI's bundled `cli/seeds/rewritable.html` regenerates on the next `npm publish` from the canonical seed.

### Empirical observations (2026-05-05 production-runtime smoke)

Two real-model smoke runs against the modified seed via `ctx.modify` (89 scenarios, three tools available, model picks freely):

| metric | gemini-3.1-pro-preview | gemini-3.1-flash-lite-preview |
|---|---|---|
| Overall meanS | 1.73 | 1.57 |
| Overall meanT | 1.02 | 1.24 |
| `apply_dsl_plan` adoption (across all model calls) | **0.8 %** (2 / 244) | **~70 %** on structural; 0 % on content |

For comparison, the May 2026 apply_edits-only baselines: pro overall meanT=0.88, lite overall meanT=1.35.

Two findings the data forced:

- **Pro almost never picks `apply_dsl_plan`** when given the choice. The system prompt's "preferred for STRUCTURAL transforms" guidance is a nudge that the model overrides — most likely because str_replace-shaped tools dominate training data.
- **Most of pro's stability gain comes from the new prompt structure**, not from tool adoption. Paste meanT 0.22 → 1.78 on the same `apply_edits` path; structural_regular 1.27 → 1.76. The "render substantial paste verbatim" rule and the structural-vs-content split do the work.

Lite adopts the DSL freely but sees no net stability win (1.35 → 1.24 — slight regression). Lite was already byte-conservative on raw `apply_edits`; the DSL adds prompt-overhead and minor compile-down anchor widening without offsetting discipline gain.

The May 2026 forced-DSL ceiling (pro meanT=1.44) doesn't reproduce in production because pro doesn't adopt the tool. Full empirical writeup in `rwa-edit-dsl-spec.md` §12.

### Known limitations

- **Strong-model adoption is low.** Pro-class models override the prompt's preference and rarely pick `apply_dsl_plan` (~1 %). The architectural prediction "DSL ships → pro reaches meanT=1.44" was conditional on adoption that doesn't happen freely. Tightening the prompt or a runtime-level DSL-only mode could unlock it but neither is in v0.1.
- **The system prompt grew significantly.** Three tools, op schemas, and per-tool rules add ~1500 tokens to every modify request. Cost goes up modestly — flash-lite tok_in went 918 → 4402 on structural_regular. Acceptable for the fidelity gain but worth monitoring.
- **No DSL-only mode.** A runtime flag that disables `apply_edits` for structural intent would force agents into the DSL but isn't shipped. See `rwa-edit-dsl-spec.md` §12 for the open questions list.

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
