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

rwa edit notes.html "Add a section on testing"      # instruction → agent loop
echo '{"version":"rwa-edit/1","edits":[...]}' | rwa edit notes.html
rwa edit notes.html --plan plan.json                # envelope from a file
```

### `rwa new`

Writes a fresh rwa container with a unique per-file `DOC_UUID`, a filename-derived `<title>`, and the seed's "Untitled" starter content. Press `⌘K` in the browser to make it become anything.

Pass `--kind <name>` to scaffold a different primary stance at first paint:

- `--kind document` (default) — prose container; lens placeholder *"Write, or describe what you want."*
- `--kind workflow` — three-stage scaffold (Inbox / In progress / Done); lens placeholder *"Add an item, or describe a stage move."*

The product-kind taxonomy is documented at `docs/specs/rwa-product-types.md` in the main repo. The substrate runtime is unchanged across kinds — only the `INLINE_DOC` body and lens placeholder vary at emit time.

### `rwa import <input> [path]`

Embeds the input file's content as the document's initial state. Supported formats:

- `.md`, `.markdown` — converted via [`marked`](https://marked.js.org/) (GFM enabled)
- `.html`, `.htm` — `<!DOCTYPE>`/`<html>`/`<head>`/`<body>` shells stripped, `<style>` tags retained from `<head>`, body content kept as-is. **`<script>` tags are preserved** (rwa documents support inline JS); a stderr warning is printed when scripts are detected.
- `.csv` — parsed via [`papaparse`](https://www.papaparse.com/) (RFC 4180; handles quoted commas, embedded newlines, escaped quotes, BOM). First row becomes `<thead>`, remaining rows `<tbody>`; every cell is HTML-escaped. Parse warnings print to stderr but don't abort the import.
- `.txt` — paragraph-split on blank lines, HTML chars escaped

Output defaults to `<input-basename>.html` in the input's directory. Conversion is deterministic and offline — no API key, no network.

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

### Flags

| Flag | Effect |
|---|---|
| `--force`, `-f` | overwrite the destination if it exists |
| `--open`, `-o` | open the resulting file in the default app |
| `--kind <name>` | (`rwa new` only) starter kind: `document` (default), `workflow` |
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

Exit codes 1–4 are emitted by `rwa edit` and are stable. Other verbs (`new`, `import`) use `0`/`1`/`2` only — `2` for argument or format issues, `1` for everything else. The `--json` flag (edit only) turns every stderr line into a single-line JSON object suitable for piping into a structured log or wrapper script.

## Design

This CLI is **offline-first**. It ships with its own pinned copy of the bootstrap seed; nothing is fetched from a server. The bootstrap version embedded in any file you create is fixed at the moment of `rwa new` / `rwa import`. To upgrade an existing file's bootstrap to a newer version, see the project's `rwa upgrade` (planned).

The seed and the runtime in any file the CLI emits are byte-identical to the seed used by the hosted service at `rewritable.ikangai.com`. Files emitted by either channel are interchangeable.

## License

MIT
