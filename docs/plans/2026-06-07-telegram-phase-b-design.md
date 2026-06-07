# Telegram Phase B — reply-to-edit a hosted rewritable, design

**Status:** design, validated with Martin 2026-06-07. Thread 5 of the north-star
program (`docs/plans/2026-06-07-north-star-execution-program.md`). The first
*remote-edit* surface. Client of godel's hosted-edit foundation
(`docs/plans/2026-06-07-hosted-edit-foundation-design.md`); extends the Phase A bot
(`docs/plans/2026-06-07-telegram-phase-a-design.md`). A thin adapter onto the
operations contract (`docs/specs/rwa-operations-api.md`) — reuses the `rwa` CLI and
the foundation's HTTP `/modify`, reimplements nothing.

## Dependency & activation

Phase B is a **client of a foundation built in parallel** (godel, Thread 4). It is
built offline-testable behind a fake-foundation seam against the concrete
contract-of-record (below), and goes live when the foundation is deployed and the
wire contracts are jointly pinned.

**Activation gate — `RWA_FOUNDATION_URL`:**
- **unset →** the bot behaves exactly as Phase A today (ephemeral `rwa publish`,
  create-only). No live regression.
- **set →** Phase B mode: create-editable + edit, against the foundation at that URL.

## The model

A chat has at most one *active hosted doc*, tracked in a persisted per-chat binding
`chatId → { id, token, url }`.
- **No active doc, or `/new`:** create. `/new <prompt>` → `rwa create` (agent-fill,
  needs a backend key); forwarded text/markdown/document → `rwa import`. Either way a
  full container is produced locally, then `POST /r` (raw `.html` bytes) creates the
  editable hosted doc; the chat binds to the returned `{id,token,url}`; the bot
  replies the capability url.
- **Active doc + plain message:** an edit instruction (see Edit flow).
- `/new` always starts+binds fresh. `/start` help. `/show` → the active doc's url
  (+ title via `describe`). `/export` → sends the canonical `.html` file (offline
  escape hatch). Opening an arbitrary existing doc is **out of v1** (one active doc
  per chat).

## The foundation HTTP contract (godel's contract-of-record, #234/#235; built+verified)

Auth: `Authorization: Bearer <token>` on every per-rwa call.
- `POST /r` — body raw `.html` bytes (`text/html`) → `200 {id, token, url}`
  (url is the GET projection incl. `#k=<token>`); `400 {error:'not_a_rewritable'}`.
- `GET /r/:id/doc` → `200 {doc:<LF-canonical body>, baseHash:<sha256-hex of body>,
  selfDescription}`.
- `GET /r/:id/describe` → `200 self-description/1`.
- `POST /r/:id/modify` — `{envelope:<rwa-edit/1>, baseHash:<hex>, actor?:<≤128, no
  newlines>}` → `200 {doc, baseHash, selfDescription, histLen}`;
  `409 {error:'stale_base', currentHash}`; `422 {error:<subcode>, detail?}` (subcode
  = `rwa edit --json` vocab: `frozen_zone_violation`/`find_not_found`/…);
  `401 {error:'unauthorized'}`; `404` unknown id; `400 {error:'bad_request'}`.
- `GET /r/:id/export` → `200 text/html` canonical bytes.
- (`POST /r/:id/undo`, `POST /r/:id/rotate`, `DELETE /r/:id` exist; not consumed in
  Phase B v1.)

`baseHash = sha256(LF-canonical editable body)` — the same string `rwa doc` prints
and the rwa-edit/1 envelope operates on; `/modify` echoes the new baseHash to chain
edits. Server is **model-free** (applies envelopes only) — the adapter drives the
agent→envelope step.

## Architecture

Extends `surfaces/telegram/`. New `foundation-api.mjs` — a zero-dep HTTP client
(mirrors `telegram-api.mjs`; `deps.fetchImpl`+`deps.baseUrl` seam; `FoundationError`,
token-redacting):
- `createDoc(htmlBytes) → {id,token,url}`
- `readDoc(id,token) → {doc,baseHash,selfDescription}`
- `describe(id,token) → self-description/1`
- `exportDoc(id,token) → bytes`
- `modify(id,token,{envelope,baseHash,actor}) → {doc,baseHash,selfDescription,histLen}`

`bot.mjs` `handleUpdate(update, deps)` gains `deps.foundation`, `deps.state`
(load/save per-chat binding), `deps.foundationEnabled`. `rwa-exec.mjs` gains a
guarded `rwaEdit` shell-out (or reuse). A per-chat state store persists bindings.

## Edit flow (chosen mechanism: export → local `rwa edit` → replace_document)

1. `readDoc(id,token)` → `{doc, baseHash}`.
2. `exportDoc(id,token)` → temp `.html` container.
3. `rwa edit <temp> "<instruction>"` — leading-dash-guarded (reuse `looksLikeFlag`),
   argv-array, no shell; the agent applies the surgical change locally.
4. `rwa doc <temp>` → `newBody`.
5. `modify(id,token,{ envelope:{version:'rwa-edit/1', doc:newBody, reason:instruction},
   baseHash, actor:'telegram:<uid>' })`.
6. Reply: `✓ updated — <url>` (+ optional title from the returned selfDescription).

This mechanism is **robust to the data-rwa-id/baseHash subtlety** godel is fixing
server-side: `replace_document` ships the whole new body, so it never depends on
find/replace anchors matching blessed-vs-unblessed ids.

## Security (extends Phase A)

- The edit instruction is attacker-controlled → leading-dash rejection
  (`looksLikeFlag`) + argv-array on the `rwa edit` shell-out; same wall as the
  create-prompt.
- The **capability token is a secret** and the **url is a capability URL** (contains
  `#k=<token>`): never logged; replied only to the owning chat (that *is* their edit
  link); the state file is written `0600`.
- Exported temp container is bot-named (random), cleaned in `finally`.
- Foundation calls HTTPS + bearer; `FoundationError` redacts the token on every path
  (mirrors the telegram-api token-redaction test).
- Edit + agent-fill need a backend key (agent runs adapter-side) → reuse
  `resolveHasBackendKey`; no key → friendly "needs a backend configured."

## Error handling (Rule 12)

- `409 stale_base` → re-`readDoc` + retry `modify` **once**; still stale → "the doc
  changed underneath me, try again."
- `422 <subcode>` → friendly per-subcode reply; raw detail → `log`.
- `401` → "this doc's edit link expired/rotated"; `404` → "that doc no longer exists"
  + **clear the chat binding**; `400` → generic + log.
- Foundation unreachable / non-JSON → "couldn't reach the doc service, try again" +
  log. The poll loop already survives handler throws.

## Testing (all offline, injected deps)

New fakes: a **fake `foundation`** (records calls, scripted success/error statuses)
and a **fake `state`** store. Dispatch stays pure `handleUpdate(update, deps)`.
- **Activation gate:** `foundationEnabled:false` → Phase A behavior; foundation
  **never called** (pins no-regression).
- **Create binds:** `/new X`/text/document → create-local then `createDoc(bytes)`;
  binding saved with `{id,token}`; reply has url.
- **Edit flow:** active doc + message → `readDoc`→`exportDoc`→`rwa edit`→`modify`
  with the **exact** `{envelope,baseHash,actor}` payload; reply has url.
- **409 retry:** 409 once→200 = re-read+retry success; twice = friendly give-up.
- **422/401/404:** friendly per-case; 404 clears binding; detail→log not user.
- **Security:** `--api-key`-style instruction rejected, `rwa edit` never spawned;
  token absent from every `sendMessage`/`log` (create+edit+`/show`).
- **Backend-key gate:** no key → "needs a backend"; no spawn.
- **`/show`/`/export`:** describe / export bytes.

`main()` wires real `foundation-api` + a `0600` file-backed state store (read-
reviewed, not unit-tested). README documents the Phase B env + the manual-acceptance
step once the foundation is live.

## Files

- `surfaces/telegram/foundation-api.mjs` (new) + `.test.mjs`
- `surfaces/telegram/bot.mjs` (edit dispatch + create-via-foundation + gate)
- `surfaces/telegram/rwa-exec.mjs` (add guarded `rwaEdit`)
- `surfaces/telegram/state.mjs` (new, per-chat binding store) + `.test.mjs`
- `surfaces/telegram/README.md` (Phase B section)

## Out of scope (YAGNI / later)

Opening/switching arbitrary docs (one active per chat); `/undo`/`/rotate`/`DELETE`
surfacing; surgical apply_edits over the wire (v1 is replace_document); webhook;
phone (separate spike); accounts (capability-token only).
