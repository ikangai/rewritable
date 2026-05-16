# Local model backends: Ollama + LM Studio

**Status:** design accepted 2026-05-16
**Scope:** runtime change to `seeds/rewritable.html` (and regenerated references). No CLI, service, or spec changes.

## Motivation

The rwa container currently has two agent backends:

- `openrouter` — OpenAI-compatible chat completions against `https://openrouter.ai/api/v1`, full multi-turn tool-use loop with `apply_dsl_plan` / `apply_edits` / `replace_document`.
- `bridge` — single-shot delegation to a localhost HTTP shim that invokes `claude -p`.

Users who want to run the rewrite loop entirely on their own machine — either for privacy, offline use, or cost — currently have to use the bridge backend, which routes through Claude Code rather than a local model. Adding two first-class local-model backends — **Ollama** (`ollama serve`, default port 11434) and **LM Studio** (default port 1234) — closes that gap. Both expose an OpenAI-compatible `/v1/chat/completions` endpoint with `tools` / `tool_choice` / `tool_calls` support, which means the existing tool-use loop applies unchanged.

## Constraints inherited from the project

- **Single self-contained HTML file** — no new dependencies, no build step, no fetched libraries.
- **The bootstrap is the anchor** — bootstrap bytes are immutable per container. Settings live in `sessionStorage`, never persisted across reloads of a fresh-pull container.
- **Default behavior unchanged** — OpenRouter remains the default for new containers; this is an additive change.
- **Three sites stay aligned** for DSL/lens changes, but this change touches only the *transport* layer (which backend serves the OpenAI-compat protocol), not the edit protocol. Spec docs do not change.

## Design

### Backend dispatch — small generalization

The OpenAI-compat call site in `seeds/rewritable.html` is parameterized to take `(baseUrl, apiKey)`:

- `baseUrl` is the prefix up to but not including `/chat/completions` (i.e. ends in `/v1`).
- When `apiKey` is `null`/`""`, the `Authorization` header is omitted.

The `callAgent()` dispatcher gains two new branches that call this helper with their backend's base URL:

| Backend     | Base URL (default)                  | Auth header                       |
|-------------|-------------------------------------|-----------------------------------|
| `openrouter`| `https://openrouter.ai/api/v1`      | `Bearer <key>` (required)         |
| `ollama`    | `http://localhost:11434/v1`         | none                              |
| `lmstudio`  | `http://localhost:1234/v1`          | none                              |
| `bridge`    | (unchanged — different transport)   | n/a                               |

The OpenRouter-specific `HTTP-Referer` / `X-Title` headers are kept for `openrouter` only.

### Settings panel — three new pieces of UI

The `<select id="rwa-backend">` gains two options: `ollama`, `lmstudio`. The visible rows depend on the selected backend, driven by `syncBackendRows()`:

| Backend     | API-key row | Base-URL row | Model row             | Setup hint           |
|-------------|-------------|--------------|-----------------------|----------------------|
| openrouter  | shown       | hidden       | text input            | (existing)           |
| ollama      | hidden      | shown        | dropdown (with fallback to text) | "Set `OLLAMA_ORIGINS=*`" |
| lmstudio    | hidden      | shown        | dropdown (with fallback to text) | "Enable CORS in LM Studio → Developer" |
| bridge      | hidden      | hidden       | hidden                | (existing)           |

**Base-URL row.** A text input with placeholder set to the backend default. Per-backend overrides live in `sessionStorage`:

- `rwa_base_url_ollama` (default `http://localhost:11434/v1`)
- `rwa_base_url_lmstudio` (default `http://localhost:1234/v1`)

A small **Test** button next to the base URL fetches `<baseUrl>/models`, displaying either model count or a short error message ("CORS blocked", "Connection refused", etc.) inline. This is the primary diagnostic affordance — most first-run failures will be CORS.

**Model row** — for ollama/lmstudio, on backend-select and on settings-panel open, the runtime attempts `GET <baseUrl>/models`. On success, the existing text input is replaced by a `<select>` populated from the response. On failure, the text input remains visible and the inline hint nudges the user toward CORS setup. The chosen value persists to the existing `rwa_model` key (single shared model name across backends — when switching backends, the previously chosen model may or may not exist on the new backend; behavior is "best effort, user adjusts").

### CORS setup hints (verbatim text)

Inline copy in the settings panel:

- **Ollama:** "First-run setup: in the shell where you'll `ollama serve`, set `OLLAMA_ORIGINS=*` (or your site origin). Default Ollama blocks browser requests."
- **LM Studio:** "First-run setup: in LM Studio, open Developer → enable 'CORS' and start the server. Default LM Studio blocks browser requests."

These are not interactive — just text under the backend selector.

## Files touched

1. **`seeds/rewritable.html`** — all functional changes.
2. **`hello.html`**, **`re-write-able-spec.html`** — regenerate via `node tools/regenerate-refs.mjs` after the seed change.
3. **`CLAUDE.md`** — update the "Default model" and "Agent contract" paragraphs to mention the four backends.

**Not touched:**
- `cli/` — the CLI does not embed runtime model logic.
- `service/public/import.html` — imports go through `/rewritable.html` which already substitutes a fresh `DOC_UUID`. The runtime in that fresh container is the same updated seed.
- `service/public/build-skill.md` and skill examples — the skill teaches *document-side* building, not runtime configuration. No mention of model providers in the skill.
- Specs (`re-write-able-spec.md`, `rwa-edit-spec.md`, `rwa-edit-dsl-spec.md`, `rwa-lens-spec.md`) — the edit protocol is unchanged.
- Snapshot publishing — share recipients get the bootstrap as-published; they choose their own backend via their browser session.

## Risks / trade-offs

1. **CORS friction is the dominant UX risk.** Most users will fail their first attempt because `OLLAMA_ORIGINS` is unset or LM Studio's CORS toggle is off. Mitigation: inline hint + Test button. Without both, the failure mode is silent ("nothing happens when I press ⌘K").
2. **Existing minted containers don't get the new backends** — they carry the bootstrap they were minted with. Only new containers from `rwa new` / `/new` / `/import` / `/s/<short>` get the new options. Acceptable; documented in release notes.
3. **Tool-capable model coverage is uneven on local models.** Some local models support `tools` weakly or not at all. The existing tool-call-failure → retry loop will surface this. We deliberately do not gate model choices — the user can already switch models from the picker.
4. **The base-URL override could be used for arbitrary OpenAI-compat servers** (vLLM, Jan, llama.cpp's server). This is a side benefit, not the primary use case; we don't advertise it but we also don't prevent it.

## Rejected alternatives

- **Generic "OpenAI-compat custom" backend** — adds a fourth UI mode and a fourth setup-hint surface for one extra slot that the URL-override already covers.
- **MCP-based integration** — different transport, requires an MCP host, doesn't fit the in-page agent loop.
- **Auto-detect on page load** — would slow boot and produce CORS noise; lazy fetch on backend-select is cleaner.
- **Tool-capability gate** — adds machinery for a problem the retry loop already surfaces.

## Open questions resolved during research

- Q: Native `/api/chat` or OpenAI-compat `/v1/chat/completions` for Ollama? **A: OpenAI-compat.** Ollama supports both; using the compat endpoint means a single code path for all three OpenAI-compat backends.
- Q: Does LM Studio require an API key? **A: No.** The server accepts requests without `Authorization`; sending one is also accepted (ignored).
- Q: Are list-models endpoints uniform? **A: Yes.** All three serve `GET /v1/models` with the OpenAI `{data: [{id, ...}, ...]}` shape.

## Out of scope

- Connection-pool / streaming improvements.
- Per-backend default model.
- "Recently used model" history across backends.
- Tool-capability auto-detection.
- Subdomain-isolated OPFS for shares (tracked separately in `docs/plans/2026-05-16-snapshot-publishing.md`).

---

Implementation plan in a follow-up doc at `docs/plans/2026-05-16-ollama-lmstudio-backends-plan.md`.
