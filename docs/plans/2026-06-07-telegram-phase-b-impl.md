# Telegram Phase B Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Extend the `surfaces/telegram/` bot so that, when `RWA_FOUNDATION_URL` is set, it creates *editable hosted* rewritables on godel's foundation and edits them in-chat (plain message = edit instruction); when unset it behaves exactly as Phase A (no regression).

**Architecture:** New `foundation-api.mjs` (zero-dep HTTP client for the foundation contract) + `state.mjs` (persisted per-chat `{id,token,url}` binding). `rwa-exec.mjs` gains a guarded `rwaEdit`. `bot.mjs` `handleUpdate` gains a foundation-gated create/edit path. All I/O injected via `deps` → fully offline tests behind a fake-foundation + fake-state seam. Edit mechanism: `readDoc`(baseHash) → `exportDoc`(temp container) → `rwa edit` → `rwa doc`(newBody) → `POST /modify` replace_document, with 409 retry-once.

**Tech Stack:** Node ESM, `fetch`, `node:child_process` execFile, `node:crypto` (sha256/randomUUID), `node:fs`, `node:test`. Zero npm deps.

**Design + contract:** `docs/plans/2026-06-07-telegram-phase-b-design.md`. Foundation contract-of-record is in that doc's "foundation HTTP contract" section (godel #234/#235) — build the fake-foundation seam to those EXACT shapes. Honor: token-redaction, argv-array shell-out + leading-dash rejection, capability token/url are secrets (never logged; state file `0600`), honest errors (Rule 12), tests encode WHY (Rule 9).

**Conventions:** match the existing `surfaces/telegram/` modules (`telegram-api.mjs`/`rwa-exec.mjs` `deps`-seam style). Branch `telegram-phase-b`; commit explicit paths only (SHARED checkout — another instance is merging concurrently; NEVER `-a`/`-A`); zsh (separate quoted path args; NO backticks in commit messages).

---

### Task 1: `foundation-api.mjs` — zero-dep HTTP client

**Files:** Create `surfaces/telegram/foundation-api.mjs` + `surfaces/telegram/foundation-api.test.mjs`.

Factory `makeFoundationApi(baseUrl, { fetchImpl })` → `{ createDoc, readDoc, describe, exportDoc, modify }`, plus `FoundationError extends Error` (token-redacting). Methods (contract-of-record):
- `createDoc(htmlBytes) → {id,token,url}` — `POST <base>/r`, `Content-Type: text/html`, body = bytes. `400 {error:'not_a_rewritable'}` → throw FoundationError(code).
- `readDoc(id, token) → {doc, baseHash, selfDescription}` — `GET <base>/r/:id/doc`, `Authorization: Bearer <token>`.
- `describe(id, token) → selfDescription` — `GET /r/:id/describe`.
- `exportDoc(id, token) → string` (html bytes) — `GET /r/:id/export`.
- `modify(id, token, {envelope, baseHash, actor}) → {doc, baseHash, selfDescription, histLen}` — `POST /r/:id/modify` JSON body. Map non-200: `409 {error:'stale_base', currentHash}` → throw FoundationError with `code:'stale_base'` + `currentHash`; `422 {error,detail}` → `code:<subcode>, detail`; `401` → `unauthorized`; `404` → `not_found`; `400` → `bad_request`. Each carries the HTTP status + parsed `error`.

**TDD:** tests inject a fake `fetchImpl` recording `{url,method,headers,body}` + returning scripted responses. Assert: exact URLs/methods; `Authorization: Bearer` present on per-rwa calls; createDoc sends `text/html` + raw bytes; modify sends the exact JSON `{envelope,baseHash,actor}`; each error status maps to the right FoundationError code (incl. 409 carrying currentHash). **Token redaction:** a thrown FoundationError NEVER contains the token in message/stack — test across an HTTP-error path and a fetch-reject path (re-wrap raw fetch errors, like telegram-api.mjs). Steps: write failing tests → run FAIL → implement → run PASS → commit `surfaces/telegram/foundation-api.mjs surfaces/telegram/foundation-api.test.mjs`, message `feat(telegram): zero-dep foundation HTTP client (token-redacting, contract-of-record shapes)`.

---

### Task 2: `state.mjs` — persisted per-chat binding store

**Files:** Create `surfaces/telegram/state.mjs` + `surfaces/telegram/state.test.mjs`.

`makeStateStore({ filePath, fs })` → `{ get(chatId), set(chatId, binding), clear(chatId) }` where binding = `{id, token, url}`. In-memory map backed by a JSON file; load on construction; every mutation persists. **Security:** the file is written with `mode: 0o600` (assert the write options carry 0o600 via the injected `fs` fake). `fs` is injected (`{ readFileSync|readFile, writeFile }`) so tests use a fake — no real disk. A missing/corrupt file → empty store (don't throw). 

**TDD:** set→get round-trips; clear removes; persistence writes the file with mode 0600 (assert the recorded write options); a corrupt file load yields an empty store (fail-soft). Steps: failing tests → FAIL → implement → PASS → commit `surfaces/telegram/state.mjs surfaces/telegram/state.test.mjs`, message `feat(telegram): per-chat binding store (0600, fail-soft, injected fs)`.

---

### Task 3: `rwa-exec.mjs` — add guarded `rwaEdit`

**Files:** Modify `surfaces/telegram/rwa-exec.mjs`; extend `surfaces/telegram/rwa-exec.test.mjs`.

Add `rwaEdit(filePath, instruction, deps) → { ok, doc?, code?, stderr? }`: reject a leading-dash `instruction` (reuse the existing `looksLikeFlag` guard) → `{ok:false, code:'bad_instruction'}` with NO spawn; else `execFile(rwa, [...base, 'edit', filePath, instruction], {})` (argv-array, no shell — `filePath` is a bot temp path, `instruction` a single argv element), then `execFile(rwa, [...base, 'doc', filePath], {})` to read the new LF body → `{ok:true, doc:newBody}`. Non-zero exit → `{ok:false, code, stderr}` (captured, not thrown). Reuse `resolveRwaCmd` + the existing temp/cleanup discipline if needed (here `filePath` is provided by the caller — do NOT delete the caller's file; only clean anything rwaEdit itself creates).

**TDD (security-critical):** an `instruction` of `--api-key x` / `-f` / leading-dash → `{ok:false, code:'bad_instruction'}`, execFile NEVER called. A normal instruction → `edit` then `doc` invoked with the instruction as ONE argv element (assert exact argv; assert no shell, no `shell:true`). A non-zero `rwa edit` exit → `{ok:false, code, stderr}` captured. URL/`doc` parse returns the body. Steps: failing tests → FAIL → implement → PASS → commit `surfaces/telegram/rwa-exec.mjs surfaces/telegram/rwa-exec.test.mjs`, message `feat(telegram): rwaEdit shell-out (argv-array, leading-dash-guarded, doc-readback)`.

---

### Task 4: `bot.mjs` — foundation-gated create + edit dispatch

**Files:** Modify `surfaces/telegram/bot.mjs`; extend `surfaces/telegram/bot.test.mjs`.

`handleUpdate(update, deps)` gains `deps.foundation`, `deps.state`, `deps.foundationEnabled`. Behavior:
- **`foundationEnabled` false →** the EXISTING Phase A path runs unchanged (assert the foundation/state are never touched).
- **`foundationEnabled` true:**
  - **no active binding for chat (or `/new`):** create — produce a container locally (`/new <prompt>`→`exec.rwaCreate*` to a temp container; text/document→`exec.rwaImport*` to a temp container — REUSE the Phase A create-to-temp logic but capture the CONTAINER BYTES instead of publishing to the ephemeral service), then `foundation.createDoc(bytes)` → `state.set(chatId, {id,token,url})` → reply the url (+ "you can keep editing — just send changes"). (Refactor the Phase A create path so the container-building step is shared and only the SINK differs: ephemeral publish vs foundation.createDoc.)
  - **active binding + plain message (edit):** `foundation.readDoc(id,token)` → `{doc,baseHash}`; `foundation.exportDoc(id,token)` → temp container (via injected `writeTemp`/the export bytes); `exec.rwaEdit(tempPath, instruction)` → `{ok,doc:newBody}`; `foundation.modify(id,token,{envelope:{version:'rwa-edit/1',doc:newBody,reason:instruction}, baseHash, actor:'telegram:'+userId})` → reply "updated — url". 
  - **`/show`** → `foundation.describe(id,token)` → reply url + title; no active doc → "no active doc, send something to create one".
  - **`/export`** → `foundation.exportDoc(id,token)` → send as a document (via `api`).
- **Errors:** `rwaEdit` `bad_instruction` → friendly "don't start an edit with a dash"; `modify` FoundationError `stale_base` → re-`readDoc` + retry once, else "doc changed, try again"; `422 <subcode>` → friendly per-subcode + log detail; `401` → "edit link expired"; `404` → clear binding + "that doc's gone"; unreachable → "couldn't reach the doc service" + log. Backend-key gate (edit + agent-fill) reuses `resolveHasBackendKey`/`hasBackendKey` dep. The capability token is NEVER put in a reply or log (the url is the user-facing artifact).

**TDD:** every branch above with fakes (foundation/state/exec/api/rateLimit/log/hasBackendKey/foundationEnabled). Load-bearing assertions: gate-off → foundation/state untouched; create → createDoc(bytes) + state.set + url replied; edit → the EXACT modify payload `{envelope,baseHash,actor}`; 409 → re-read+retry-once (then give up); 404 → state.clear; token absent from every sendMessage/log; leading-dash instruction → no rwaEdit spawn; no-key → "needs a backend". Steps: failing tests → FAIL → implement (refactor create path to share container-build) → PASS → commit `surfaces/telegram/bot.mjs surfaces/telegram/bot.test.mjs`, message `feat(telegram): Phase B dispatch — foundation create + in-chat edit (gated, optimistic-concurrency)`.

---

### Task 5: `main()` wiring + README Phase B section

**Files:** Modify `surfaces/telegram/bot.mjs` (`main()`); modify `surfaces/telegram/README.md`.

In `main()`: `foundationEnabled = !!process.env.RWA_FOUNDATION_URL`; if set, build `foundation = makeFoundationApi(process.env.RWA_FOUNDATION_URL)` and `state = makeStateStore({ filePath: process.env.RWA_TG_STATE_FILE || <tmp default>, fs })`; wire both into the per-update `handle` deps. When unset, pass `foundationEnabled:false` and the bot runs Phase A. Keep the import-guard + everything else unchanged. README: add a "Phase B (editing)" section — `RWA_FOUNDATION_URL` activation, the create-editable + plain-message-edit model, `/show`/`/export`, the capability-url-is-secret note, the state file (`0600`, `RWA_TG_STATE_FILE`), and the manual-acceptance step once the foundation is live.

Steps: implement (main wiring is read-reviewed, not unit-tested) → run ALL `surfaces/telegram/*.test.mjs` (still green) → commit `surfaces/telegram/bot.mjs surfaces/telegram/README.md`, message `feat(telegram): wire Phase B (RWA_FOUNDATION_URL gate) + README`.

---

### Task 6: full-suite gate
Run `for f in surfaces/telegram/*.test.mjs; do node "$f" >/dev/null 2>&1 && echo "PASS $f" || echo "FAIL $f"; done` (all PASS) and confirm the disjoint `cli/` suite still green (`cd cli && for f in tests/*.test.mjs; do node "$f" >/dev/null 2>&1 || echo "FAIL $f"; done`). No commit — gate. If any cli/ test fails, STOP (the surface must be disjoint).

---

## Success criteria
- `RWA_FOUNDATION_URL` unset → byte-for-byte Phase A behavior (foundation/state never touched), proven by test.
- Create → `POST /r` bytes + chat binding + url reply; edit → readDoc→export→rwaEdit→modify with the exact `{envelope,baseHash,actor}` payload + 409 retry-once.
- Capability token never logged/replied; state file `0600`; leading-dash instruction rejected pre-spawn.
- All surface tests green; cli/ disjoint + green.

## Out of scope (YAGNI)
open/switch arbitrary docs; /undo,/rotate,DELETE; surgical apply_edits over the wire; webhook; phone; accounts.
