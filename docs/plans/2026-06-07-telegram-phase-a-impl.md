# Telegram Phase A Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or subagent-driven-development) to implement this plan task-by-task.

**Goal:** A `surfaces/telegram/` long-poll bot that turns Telegram messages into published rewritables — wrap path (text/markdown/document → `rwa import` → `rwa publish`) and agent-fill path (`/new <prompt>` → `rwa create` → publish) — by shelling out to the `rwa` CLI.

**Architecture:** Zero-dep Node ESM. Three modules: `telegram-api.mjs` (Bot API over `fetch`), `rwa-exec.mjs` (`execFile` shell-out helpers, argv arrays only), `bot.mjs` (pure `handleUpdate(update, deps)` + a thin poll wrapper + `main()`). All I/O is injected via `deps` so the whole thing tests offline (fake Telegram transport + fake execFile). No identity (create-only). Ephemeral publish target.

**Tech Stack:** Node ≥18 (`fetch`, `node:child_process` `execFile`, `node:test`, `node:fs`). No npm deps. Depends at runtime on the `rwa` CLI being invokable.

**Design reference:** `docs/plans/2026-06-07-telegram-phase-a-design.md`. Honor: zero-dep, execFile arg-arrays (never a shell string), untrusted input → temp file or single argv element, honest error surfacing (Rule 12), tests encode WHY (Rule 9).

**Conventions:** match `cli/src` style (small focused modules, a `CliError`-like typed error, `deps` seam exactly like `cli/src/fetch-page.mjs`/`publish-site.mjs`). Run tests with `node <file>` from the worktree root. Branch `telegram-phase-a`; commit explicit paths only (shared checkout), zsh (separate quoted path args).

---

### Task 1: `telegram-api.mjs` — zero-dep Bot API client

**Files:**
- Create: `surfaces/telegram/telegram-api.mjs`
- Test: `surfaces/telegram/telegram-api.test.mjs`

**Step 1: Write failing tests.** A `makeTelegramApi(token, { fetchImpl })` factory returning `{ getUpdates, sendMessage, getFile, downloadFile, sendChatAction }`. Tests inject a fake `fetchImpl` recording URL + body and returning scripted JSON:
- `getUpdates(offset)` → GETs/POSTs `https://api.telegram.org/bot<token>/getUpdates` with `{offset, timeout}`; returns `result` array; on Telegram `{ok:false}` throws a `TelegramError` with `description`.
- `sendMessage(chatId, text)` → POSTs `sendMessage` with `{chat_id, text}` (and `disable_web_page_preview:false`).
- `getFile(fileId)` → POSTs `getFile`, returns `{file_path, file_size}`.
- `downloadFile(filePath, destPath, { maxBytes })` → GETs `https://api.telegram.org/file/bot<token>/<file_path>`, streams to `destPath`, throws `TelegramError('file_too_large')` if `content-length` > maxBytes.
- **token never appears in a thrown error message** (assert).

**Step 2:** Run `node surfaces/telegram/telegram-api.test.mjs` → FAIL (module missing).

**Step 3:** Implement with `fetch` (default `globalThis.fetch`, override via `deps.fetchImpl`). `TelegramError extends Error` with `{ description }`. Keep the base URL overridable (`deps.baseUrl`) for tests. Redact the token from any error/string.

**Step 4:** Run → PASS.

**Step 5: Commit**
```
git commit -m "feat(telegram): zero-dep Bot API client (fetch wrappers, token-redacting)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" -- surfaces/telegram/telegram-api.mjs surfaces/telegram/telegram-api.test.mjs
```

---

### Task 2: `rwa-exec.mjs` — `rwa` CLI shell-out (argv-array only)

**Files:**
- Create: `surfaces/telegram/rwa-exec.mjs`
- Test: `surfaces/telegram/rwa-exec.test.mjs`

**Step 1: Write failing tests.** Functions, each taking `deps={execFile}` (default promisified `node:child_process` execFile) and returning `{ ok, url?, title?, stderr?, code? }`:
- `rwaImportPublish(filePath, { execFile })` → runs `rwa import <filePath> <tmpOut>` then `rwa publish <tmpOut>`, parses the publish stdout for the share URL, returns `{ok:true, url}`. (For Phase A simplicity, `import` writes to a temp `.html`, then `publish` it.)
- `rwaCreatePublish(prompt, { execFile, hasBackendKey })` → if `!hasBackendKey` returns `{ok:false, code:'agent_not_configured'}` WITHOUT calling execFile; else runs `rwa create "<prompt>" <tmpOut>` then `rwa publish`, returns `{ok:true,url}`.
- **Security:** assert every `execFile` call is `('rwa'|node, [argArray])` — `prompt`/`filePath` are single argv elements, NEVER concatenated into one string. Test with `filePath='a b;rm.md'` and `prompt='; rm -rf ~'` → they appear as one literal argv element.
- **Error:** a non-zero `execFile` (reject with `{code, stderr}`) → `{ok:false, code, stderr}` (stderr captured verbatim, not thrown to the caller's face).

**Step 2:** Run → FAIL.

**Step 3:** Implement. Resolve the `rwa` invocation once (prefer `process.env.RWA_BIN` → `node <path>`, else `'rwa'` on PATH). Use `os.tmpdir()` + a random subdir; clean in `finally`. Parse the publish URL from stdout (the CLI prints `URL: <url>` / JSON — match `https?://\S+`). argv arrays throughout.

**Step 4:** Run → PASS.

**Step 5: Commit** `surfaces/telegram/rwa-exec.mjs surfaces/telegram/rwa-exec.test.mjs` — message `feat(telegram): rwa CLI shell-out helpers (argv-array, temp-file, url-parse)`.

---

### Task 3: `bot.mjs` — `handleUpdate` dispatch (wrap + agent-fill + fallback)

**Files:**
- Create: `surfaces/telegram/bot.mjs`
- Test: `surfaces/telegram/bot.test.mjs`

**Step 1: Write failing tests.** `handleUpdate(update, deps)` where `deps = { api, exec, writeTemp, hasBackendKey, rateLimit }` (all injected/faked). Behaviors:
- `/start` → `api.sendMessage(chatId, <help text>)`; no exec.
- `/new <prompt>` with `hasBackendKey:true` → calls `exec.rwaCreatePublish(prompt, …)`; on `{ok,url}` → `sendMessage` containing the url + "expires in 24h".
- `/new <prompt>` with `hasBackendKey:false` → `sendMessage` "agent-fill isn't configured"; `exec.rwaCreatePublish` NOT called (assert) OR called and short-circuits — pick: dispatch checks `hasBackendKey` first, asserts no exec.
- plain text message → `writeTemp(text, '.md')` then `exec.rwaImportPublish(tempPath,…)` → reply with url.
- document message (`update.message.document`) → `api.getFile` + `api.downloadFile` (size cap) then `exec.rwaImportPublish` → reply with url. Oversized → friendly reply, no import (assert).
- sticker/photo/empty → fallback "send me text, a markdown file, or /new …"; no exec.
- exec returns `{ok:false, code, stderr}` → friendly failure reply (mapped per code), and the raw stderr is passed to `deps.log` (assert it's logged, not sent to the user).
- a thrown error inside handling is caught → an "something went wrong" reply + `deps.log`, never rethrown (so the loop survives).
- rate-limit: `deps.rateLimit(chatId)` returns false → "slow down" reply, no exec.

**Step 2:** Run → FAIL.

**Step 3:** Implement `handleUpdate` as pure dispatch over the injected deps. A `HELP` constant. A `replyForExec(result)` mapping `{code}` → friendly text. All side effects via `deps`.

**Step 4:** Run → PASS.

**Step 5: Commit** `surfaces/telegram/bot.mjs surfaces/telegram/bot.test.mjs` — `feat(telegram): handleUpdate dispatch — wrap/agent-fill/document/fallback + honest errors`.

---

### Task 4: poll loop + `main()` + offset persistence

**Files:**
- Modify: `surfaces/telegram/bot.mjs` (add `runPoll(deps)` + `main()`)
- Test: `surfaces/telegram/poll.test.mjs`

**Step 1: Write failing tests.** `runPoll(deps)` where `deps` includes a fake `api.getUpdates` returning one batch then signalling stop (inject a `shouldStop()` predicate or a max-iterations cap so the test terminates). Assert:
- each returned update is passed to `handleUpdate`;
- `offset` advances to `max(update_id)+1` and is persisted via `deps.saveOffset` ONLY after the batch is handled;
- `deps.loadOffset()` seeds the first `getUpdates` call;
- a `handleUpdate` that throws does NOT stop the loop and does NOT advance past the unhandled update incorrectly (offset still advances per design — handled-or-errored; document the chosen semantics in a comment and test it).

**Step 2:** Run → FAIL.

**Step 3:** Implement `runPoll` (loop: load offset → getUpdates → for each, `await handleUpdate` (try/catch) → saveOffset). `main()` wires real deps: `makeTelegramApi(process.env.TELEGRAM_BOT_TOKEN)`, real `rwa-exec`, `writeTemp` via `node:fs`, `hasBackendKey` from the rwa backend env, file-based `loadOffset`/`saveOffset`, an in-memory sliding-window `rateLimit`, `log` to stderr. `main()` is NOT unit-tested (it's wiring) — guard it with `if (import.meta.url === ...)`.

**Step 4:** Run → PASS. Then run the WHOLE surface suite: `for f in surfaces/telegram/*.test.mjs; do node "$f" || echo FAIL; done` → all pass.

**Step 5: Commit** `surfaces/telegram/bot.mjs surfaces/telegram/poll.test.mjs` — `feat(telegram): poll loop + main() wiring + offset persistence`.

---

### Task 5: README + the manual-acceptance / gates doc

**Files:**
- Create: `surfaces/telegram/README.md`

**Step 1:** Document: what it is (Phase A create-and-publish), how to run (`TELEGRAM_BOT_TOKEN=… node surfaces/telegram/bot.mjs`, `rwa` must be on PATH or `RWA_BIN` set, backend key env for agent-fill), the commands (`/start`, `/new <prompt>`, send text/markdown/document), the 24h-ephemeral caveat, the security posture (argv-array shell-out, temp-file, size cap, rate limit), and the gates (token + host + backend key). One manual-acceptance checklist: set token, run, message the bot, confirm a link comes back.

**Step 2:** No tests (doc). 

**Step 3: Commit** `surfaces/telegram/README.md` — `docs(telegram): Phase A run + manual-acceptance + gates`.

---

### Task 6: full-suite regression gate

**Step 1:** Confirm nothing else broke (the bot is a new top-level dir, so it shouldn't touch cli/seed/service — verify):
```
cd cli && for f in tests/*.test.mjs; do node "$f" >/dev/null 2>&1 || echo "FAIL $f"; done
cd ../surfaces/telegram && for f in *.test.mjs; do node "$f" >/dev/null 2>&1 || echo "FAIL $f"; done
```
Expected: zero FAIL lines. (No commit — this is a gate. If anything in cli/ fails, STOP — the surface should be fully disjoint.)

---

## Success criteria
- `handleUpdate` correctly routes `/start` / `/new` / text / document / junk, with the agent-fill gate, rate limit, and honest error replies — all proven offline via injected deps.
- Untrusted Telegram input never reaches a shell: asserted argv-array shape with `;`/metacharacter inputs.
- Oversized documents rejected before download.
- Offset persists; the loop survives a thrown handler.
- Zero npm deps added. cli/ suite still green (disjoint).

## Out of scope (YAGNI)
Webhook; concurrency/worker pool; photos/vision; durable publish-site target; any edit (Phase B); identity; a live-token integration test (the deps seam covers logic; live run is the documented manual step).
