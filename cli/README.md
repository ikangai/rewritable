# rwa

CLI for [re-write-able](https://github.com/ikangai/rewritable) — emit and import single-file rwa documents.

A re-writeable file is a self-contained `.html` that renders, stores, modifies, and commits itself with no server. Open it in a browser, press `⌘K`, and tell it what to become.

## Install

```sh
npx rewritable --help       # zero-install (one-time cost is the longer name)
npm i -g rewritable         # global; after this, the bin is `rwa` so daily use is `rwa <verb>`
```

Requires Node ≥ 18.

## Usage

```sh
rwa new [path]              # → ./rewritable.html (default)
rwa new my-notes.html       # → ./my-notes.html

rwa import notes.md         # → ./notes.html
rwa import page.html out.html

rwa clone https://example.com/post   # → ./post.html (fetches; SSRF-guarded)

rwa edit notes.html "Add a section on testing"      # instruction → agent loop
echo '{"version":"rwa-edit/1","edits":[...]}' | rwa edit notes.html
rwa edit notes.html --plan plan.json                # envelope from a file

rwa doc notes.html                                  # print the editable body
rwa doc notes.html --json                           # read + edit-contract, one call

rwa publish notes.html                              # → a hosted 24h share URL

rwa skin notes.html notion-clean                    # apply a named style preset
rwa skin notes.html reset                           # remove the skin
```

### `rwa new`

Writes a fresh rwa container with a unique per-file `DOC_UUID`, a filename-derived `<title>`, and the seed's "Untitled" starter content. Press `⌘K` in the browser to make it become anything.

Pass `--kind <name>` to scaffold a different primary stance at first paint:

- `--kind document` (default) — prose container; lens placeholder *"Write, or describe what you want."*
- `--kind workflow` — three-stage scaffold (Inbox / In progress / Done); lens placeholder *"Add an item, or describe a stage move."*
- `--kind presentation` — prose slide deck (split on `h1`/`h2`); the *Present* toggle renders it as slides at view time without changing the stored text (spec §5.10); lens placeholder *"Add a slide, or describe a change."*
- `--kind skill-host` — hosts permission-gated skills installed from `.rwa-skill.json` files; ships an empty runtime-owned frozen `#rwa-skills` zone the runtime (never the agent) rewrites on install/uninstall; installed skills are reported via `rwa doc`/`ls` as `tool`/`compute` affordances (`provenance:'installed'`). See `docs/specs/re-write-able-actions-spec-v0.8.md` §2.

The product-kind taxonomy is documented at `docs/specs/rwa-product-types.md` in the main repo. The substrate runtime is unchanged across kinds — only the `INLINE_DOC` body and lens placeholder vary at emit time.

**Your own templates.** Label any rwa file as a reusable template by adding `data-rwa-template="<name>"` to its root element (the body's first child, typically `<article>`). Then `rwa new <name>` scans the current folder, finds the labeled file, and clones it — pristine seed + the template's content, a fresh `DOC_UUID`, and the label stripped (the clone is an instance, not the template):

```sh
# label invoice.html: <article data-rwa-template="invoice"> … </article>
rwa new invoice              # → ./invoice-2026-05-30.html (cloned from invoice.html)
rwa new invoice april.html   # → ./april.html
```

No registry, no shipped starters: the file you made yesterday is the template for the file you make tomorrow. A bare-word first argument is a template name; a `.html`/path argument is the output path (so `rwa new notes.html` still writes a blank doc). If no file in the folder carries the label, it exits `2` with a hint. Multiple matches: most-recent wins (printed). The clone always pulls the *latest* bootstrap from the seed, so an old template doesn't lock you into an old runtime. CLI-only for v1 — cross-folder discovery (`~/.rwa/templates/`, `--from`) is deferred.

### `rwa import <input> [path]`

Embeds the input file's content as the document's initial state. Supported formats:

- `.md`, `.markdown` — converted via [`marked`](https://marked.js.org/) (GFM enabled). Inline HTML in markdown is **sanitized**: `<script>`/`<iframe>`/`<object>`/`<embed>`/`<svg>`/`<math>`/`<link>`/`<meta>`/`<base>` elements are dropped, `on*=` event-handler attributes are stripped, and any `href`/`src` outside the safe scheme allow-list (`http`, `https`, `mailto`, `tel`, plus `data:image/*` for `src`) is neutralised to `#`. Removals are reported as warnings on stderr.
- `.html`, `.htm` — `<!DOCTYPE>`/`<html>`/`<head>`/`<body>` shells stripped, `<style>` tags retained from `<head>`, body content kept as-is. **`<script>` tags are preserved** (rwa documents support inline JS); a stderr warning is printed when scripts are detected.
- `.csv` — parsed via [`papaparse`](https://www.papaparse.com/) (RFC 4180; handles quoted commas, embedded newlines, escaped quotes, BOM). First row becomes `<thead>`, remaining rows `<tbody>`; every cell is HTML-escaped. Parse warnings print to stderr but don't abort the import.
- `.txt` — paragraph-split on blank lines, HTML chars escaped

Output defaults to `<input-basename>.html` in the input's directory. Conversion is deterministic and offline — no API key, no network.

### `rwa clone <url> [path]`

Clone a public webpage into a self-contained rewritable: fetch the page, extract its main article and title, and bake the content into a fresh container. First-class for **WordPress / ikangai posts** — a blog post becomes an editable, shareable single-file `.html` you can rewrite with `⌘K`.

```sh
rwa clone https://www.ikangai.com/some-post/          # → ./some-post.html
rwa clone https://www.ikangai.com/some-post/ out.html
```

Unlike `rwa import`, which is **offline**, `rwa clone` **requires the network** (it fetches the URL). The fetch is **SSRF-guarded**: only `http`/`https` schemes, private/loopback/link-local/metadata addresses are blocked (including via DNS rebinding and per-hop redirect re-validation), responses are capped in size and must be HTML. A blocked or failed fetch exits `2` (`file_error`, e.g. `blocked_host`, `bad_scheme`, `not_html`, `http_error`) and writes no file. The destination is checked first — an existing file exits `2` (`exists`) unless you pass `--force`.

Cloning is **content-only** in v1: the extracted article text/markup plus the page title (prepended as an `<h1>`) and a provenance footer linking back to the source. The source page's styles are **not** cloned — the new rewritable renders with the seed's baseline typography (re-style it later with `rwa skin` or `⌘K`).

### `rwa create <task...>` (alias `rwa draft`)

Scaffold **and** agent-fill a new rewritable in one shot, from a natural-language task. The CLI bootstraps the container, hands the brief to the model, and bakes the generated content into the file — which is then an ordinary, self-contained rewritable (edit it in-browser with `⌘K`, or re-run `rwa create` for a fresh one). Unlike `new`/`import`, this verb calls the model, so it is **not** offline; but its **output** is always self-contained.

```sh
rwa create a presentation about the rewritable architecture
rwa create an interactive document that visualizes token usage --data tokens.json
rwa draft presentation --from ./q2-deck.html --data q3.csv --out q3-deck.html
```

The leading word resolves a **frame** by the same template-first precedence as `rwa new` (a cwd `data-rwa-template` match, else a built-in kind); the rest is the brief. Flags: `--kind <name>` forces the kind (and disables leading-word detection); `--from <file>` bases the artifact on an existing rewritable's body; `--data <file>` (or `-` for stdin) bakes a dataset inline; `--out <path>` sets the output (default `./<kind>-YYYY-MM-DD.html`); `--force`/`--open`; and the backend flags (`--backend`/`--model`/`--base-url`/`--api-key`) as in `rwa edit`.

Created output is held to a **stricter, code-enforced self-containment bar** than `new`/`import`: no runtime CDN/remote references (`<script src>`, `<link href>`, `@import`, `url()`, `srcset`, …) — visualizations are hand-rolled SVG/Canvas, data is embedded. A violation fails loud (exit 4, `not_self_contained`) and writes no file. The write is atomic: a failed run (agent, envelope, or self-containment) leaves nothing at `--out`. Exit codes match `rwa edit`: 0 ok · 1 usage · 2 file · 3 envelope · 4 agent. The API key is used only for the model call and never written into the artifact.

### `rwa edit <path> [instruction]`

Programmatic edit entry point. Applies an `rwa-edit/1` tool envelope (`apply_edits`, `apply_dsl_plan`, or `replace_document`) to an existing rwa container in place. Three invocation forms:

```sh
# 1. Instruction path — run the agent loop, apply the resulting envelope.
rwa edit notes.html "Add a section on testing"

# 2. Piped envelope — read a tool envelope as JSON from stdin.
echo '{"version":"rwa-edit/1","edits":[{"find":"old","replace":"new"}]}' \
  | rwa edit notes.html

# 3. --plan <file> — read the envelope from a file. Use `--plan -` to force stdin.
rwa edit notes.html --plan plan.json
```

All three paths funnel through the same `applyPlan` splice/write code path: extract `INLINE_DOC`, apply the edit (with frozen-zone + reserved-marker + structural-shape checks), and atomic-rename the file in place.

The agent loop retries up to 3 times when the model emits plain text instead of a tool call (`no_tool_call`) or when the tool arguments aren't valid JSON (`invalid_json`). Apply-time failures (`frozen_zone_violation`, `find_not_found`, `find_not_unique`, `structural_shape_changed`, `reserved_substring`, `dsl_compile_error`) surface immediately as `envelope_error` (exit 3) without retrying through the model. This differs from the browser runtime, which feeds apply failures back as `tool_result` for the model to recover from — bringing that behavior to the CLI is tracked as a v2 follow-up in `cli/TODO.md`. After 3 exhausted retries the failure surfaces as `agent_error/no_envelope_after_retries` (exit 4).

#### Backend flags (instruction path only)

| Flag | Effect |
|---|---|
| `--backend <name>` | `openrouter` (default), `ollama`, `lmstudio`. Falls back to `$RWA_BACKEND`. `bridge` is browser-only by design. |
| `--model <id>` | model id passed to the backend. Falls back to `$RWA_MODEL`, then `google/gemini-3.5-flash`. |
| `--base-url <url>` | OpenAI-compatible base URL override. Defaults: `https://openrouter.ai/api/v1`, `http://localhost:11434/v1` (or `$RWA_OLLAMA_URL`), `http://localhost:1234/v1` (or `$RWA_LMSTUDIO_URL`). |
| `--api-key <key>` | openrouter only; falls back to `$RWA_OPENROUTER_KEY`. ollama / lmstudio run locally without auth. |

#### Other edit flags

| Flag | Effect |
|---|---|
| `--plan <file>` | read the tool envelope from a file (or `--plan -` for explicit stdin). |
| `--json` | emit one JSON object per line on stderr for structured failure / retry reporting. Each line is `{code, subcode, details}` (or `{phase:"retry", attempt, reason}` during agent retries). |

### `rwa doc <path>`

The **read** counterpart to `rwa edit`. `rwa edit` writes the editable body; `rwa doc` reads it. An agent handed a rewritable `.html` shouldn't have to parse the ~4000-line bootstrap to find the document it's allowed to touch — `rwa doc` prints exactly the LF-canonical text the edit contract operates on, so anchors computed against it round-trip through `rwa edit`.

```sh
# Plain mode — the editable body, pipe/terminal friendly (one trailing newline).
rwa doc notes.html
rwa doc notes.html | grep -n '<h2'

# --json — the full editing contract + self-description in a single call.
rwa doc notes.html --json
# → {"rwa":"self-description/1","source":"static","uuid":"…","kind":"document",
#    "title":"Status report","blocks":3,"affordances":[],"frozenZones":["sig"],
#    "baseline":{"edit":["lens"],"tools":[…],"export":["html","print"],"history":["undo"]},
#    "rewritable":true,"length":465,"doc":"…"}
```

`--json` gives an agent everything it needs to edit safely in one read: `doc` (the byte-exact body), `frozenZones` (author-declared invariants it must preserve, or `apply_edits` rejects the change with `frozen_zone_violation`), `kind` (which framing applies), and `uuid` (to correlate). `rewritable:true` is an explicit parsed-field marker.

The payload is also a `self-description/1` object — the answer to *"what is this, and what can be done with it?"* ([`docs/specs/rwa-self-description-spec.md`](../docs/specs/rwa-self-description-spec.md)): `affordances` (the type's registered provider kinds — `[]` for a base document, `["view"]` for a presentation), `title`, `blocks` (addressable-block count), and `baseline` (the substrate-universal ops every container has — lens-edit, the three edit tools, html/print export, undo). `source:"static"` marks this as computed from the file bytes (no JS executed); the in-browser `runtime.describe()` emits the same shape live. The CLI projection is pinned to the reference oracle (`tools/self-description.mjs`) by test, so it cannot drift from the contract.

A custom-affordance file (e.g. a datatable) whose real affordances the kind-template can only *guess* at may carry its own answer: an inert `<script id="rwa-affordances">` block declaring its affordances. When that declaration is **trustworthy** — *edit-unreachable*, i.e. outside the editable body or carrying `data-rwa-frozen` (which `rwa edit` now enforces) so it can't be silently drifted — `rwa doc` prefers it and reports `source:"declared"` with the file's *real* affordances. `uuid`/`frozenZones` are always filled from the bytes (container facts the author can't fake); an edit-reachable or malformed declaration is ignored and the answer falls back to `source:"static"`. So `rwa ls`/`rwa doc` tell the truth about a multi-affordance file the moment it declares itself honestly.

`rwa doc` never reads stdin and never writes the file. On a non-rewritable target it exits `2` with `not_a_rewritable` and an empty stdout — a clean "is this a rewritable?" probe. Errors always go to stderr (plain `rwa doc: file_error/not_found {…}`, or `--json` `{code, subcode, details}`), so stdout stays clean for piping.

### `rwa ls [paths...]`

Where `rwa doc` answers *"what is this file?"*, `rwa ls` answers *"what are all these?"* — the inventory of a folder of rewritables, one line each. Hand it a directory (or a list of files; default is `./`) and it prints each rewritable's identity; non-rewritables and bad paths are counted, never hidden.

```sh
rwa ls                # the rewritables in the current directory
rwa ls demo/          # …in a folder
rwa ls a.html b.html  # …an explicit list
# KIND          TITLE            AFFORDANCES        FILE
# document      Invoice tracker  —                  demo/invoice-tracker.html
# presentation  Q1 Architecture  view               demo/q1.html
# datatable     Sales 2026       view,edit-surface,compute  demo/sales.html
#
# 3 rewritables
```

`--json` emits an array of rows for an agent — `{file, status, self}` where `status` is `rewritable` (with the full `self-description/1` object), `not_a_rewritable`, or `error` (with a `reason`). The scan is lenient like its namesake: one bad path among many is a row, not a fatal exit, so a completed scan exits `0`. This is how an agent handed a project learns its whole rewritable inventory — and every container's affordances — in a single call.

### `rwa publish <path>`

Publish a local rewritable to the hosted share service and get back a URL. A rewritable is already shareable as a file — it's a self-contained `.html` you can email or host anywhere — but `rwa publish` is the one-command path to an *anonymous, hosted* snapshot: create with `rwa new`, edit locally, publish.

```
rwa publish notes.html
# ✓ Published!
#   URL:     https://ab12cd34.rewritable.ikangai.com/
#   Expires: in 24 hours (anonymous share)
#   Note:    the hosted copy gets a fresh DOC_UUID (distinct container)

rwa publish notes.html --json   # {"short":"…","url":"…","expiresAt":…} on stdout
```

It POSTs **your edited bytes** (the current `INLINE_DOC`), unlike the browser `/new` and `/import` pages, which publish a fresh or freshly-converted container. The hosted snapshot gets its own fresh `DOC_UUID` (a distinct container at its own origin) and is **anonymous, ephemeral (24h), and rate-limited** — it's a share link, not durable storage. The file on your disk remains the durable artifact.

**Target** resolves `--url <base>` › `$RWA_PUBLISH_URL` › `https://rewritable.ikangai.com` (point it at a self-hosted service or local dev with either). The file is checked locally first — a non-rewritable exits `2` (`not_a_rewritable`) **before any network call**. Remote/network failures exit `4` with an honest reason on stderr (`publish_error/network_error`, `/rate_limited`, `/body_too_large`, `/validation_failed`, …); `--json` emits those as `{code, subcode, details}`. stdout stays clean for the URL/JSON.

### `rwa skin <path> <name>`

Pick a **named look** for a rewritable instead of hand-styling it from the blank lens. A skin is one self-contained `<style data-rwa-skin="NAME">` block — system fonts only, no web fonts or remote assets — that the command splices into the **document body**. So it commits with the document, ships inside the exported `.html`, survives sharing, and one in-browser undo (`⌘Z`) reverts it. Five presets ship today: `notion-clean`, `linear-dark`, `editorial-serif`, `stripe-docs`, `terminal-mono` (clean · dark · editorial · docs · terminal).

```
rwa skin notes.html notion-clean        # apply (an unknown name lists every preset)
rwa skin notes.html editorial-serif     # re-skin — replaces the current skin, never stacks
rwa skin notes.html reset               # remove the skin
rwa skin notes.html linear-dark --json  # {"exitCode":0,"mode":"insert","skin":"linear-dark"}
```

This is **deterministic and offline** — no model, no key. The block is scoped to `#rwa-doc-mount`, so it overrides the seed's baseline typography while leaving the runtime chrome's palette untouched (a dark skin re-tints the document, not the lens). Applying the first skin inserts the block (a `replace_document`); re-skinning swaps it in place (an `apply_edits`); `reset` removes it — each one commit. Routed through the same write path as `rwa edit`, so frozen zones and `data-rwa-id`s are preserved and a non-rewritable target exits `2` (`not_a_rewritable`). `--theme-only` is the explicit name for this deterministic swap; an always-on, content-aware restyle (the model rewrites markup to make the look land) is a planned later phase (`docs/plans/2026-06-03-skinning-design.md`).

### Driving a rewritable from an agent — no embedded LLM, no API key

`rwa doc` + `rwa edit --plan` close a fully **deterministic** edit loop. An agent that can already reason (Claude Code, a script, a CI job) doesn't need the in-file `⌘K` model or an OpenRouter key: it reads the body, computes its own `apply_edits` envelope against anchors it can see, and applies it. Read → decide → write → confirm, all offline:

```sh
# 1. READ — get the exact body the edit contract sees (and what it must preserve).
rwa doc report.html --json > /tmp/state.json
#    state.json: { "doc": "<article><h1>Untitled</h1>…", "frozenZones": [...], ... }

# 2. DECIDE — the agent picks a unique anchor from state.json.doc and forms an
#    rwa-edit/1 envelope. (Each `find` must appear exactly once; avoid frozenZones.)
echo '{"version":"rwa-edit/1","edits":[{"find":"Untitled","replace":"Q2 Revenue Review"}]}' \
  > /tmp/plan.json

# 3. WRITE — apply deterministically, in place, atomically. No model in the loop.
rwa edit report.html --plan /tmp/plan.json

# 4. CONFIRM — read back; the anchor round-trips, the bootstrap/uuid are untouched.
rwa doc report.html | grep '<h1>'
```

Because the anchors in step 1 are the *same* text step 3 splices against, what the agent reads is exactly what it can edit — no HTML-parsing guesswork, no drift. The browser runtime's agent loop (multi-turn tool-use against a model) and this CLI loop apply through the identical `apply_edits` core, so an envelope that works here behaves identically in the file's own `⌘K`.

### Flags

| Flag | Effect |
|---|---|
| `--force`, `-f` | overwrite the destination if it exists |
| `--open`, `-o` | open the resulting file in the default app |
| `--kind <name>` | (`rwa new` only) starter kind: `document` (default), `workflow`, `presentation`, `skill-host` |
| `--version` | print version |
| `--help`, `-h` | usage |

### Exit codes

| Code | Name | Meaning |
|---|---|---|
| `0` | success | edit applied / file written |
| `1` | usage_error | bad arguments, missing input, unknown backend, conflicting input sources |
| `2` | file_error | target not found, read/write failure, not a rewritable container |
| `3` | envelope_error | malformed JSON, ambiguous/unknown shape, version mismatch, missing required fields, apply-time failures (`frozen_zone_violation`, `find_not_found`, `find_not_unique`, `structural_shape_changed`, `reserved_substring`, `dsl_compile_error`) |
| `4` | agent_error | agent loop exhausted retries (`no_envelope_after_retries`), backend HTTP/network error (`backend_error`), or missing API key (`no_api_key`) |

Exit codes 1–4 are emitted by `rwa edit` and are stable. `rwa doc` reuses the same `file_error` (exit `2`) surface — `not_found`, `read_error`, `not_a_rewritable` — and exits `1`/`missing_file_arg` when no path is given. Other verbs (`new`, `import`) use `0`/`1`/`2` only — `2` for argument or format issues, `1` for everything else. The `--json` flag turns each `rwa edit` stderr line into a single-line JSON object; on `rwa doc` it switches stdout to the editing-contract object (failures still emit the `{code, subcode, details}` object on stderr).

## Design

This CLI is **offline-first**. It ships with its own pinned copy of the bootstrap seed; nothing is fetched from a server. The bootstrap version embedded in any file you create is fixed at the moment of `rwa new` / `rwa import`. To upgrade an existing file's bootstrap to a newer version, see the project's `rwa upgrade` (planned).

The seed and the runtime in any file the CLI emits are byte-identical to the seed used by the hosted service at `rewritable.ikangai.com`. Files emitted by either channel are interchangeable.

## License

MIT
