# Telegram Phase A — create-and-publish bot, design

**Status:** design, validated with Martin 2026-06-07. Thread 3 of the north-star
execution program (`docs/plans/2026-06-07-north-star-execution-program.md`). The
first *messaging* surface; create-only, so it needs **no hosted-edit foundation and
no identity**. A thin adapter onto the operations contract
(`docs/specs/rwa-operations-api.md`): `bootstrap`/`import` + `publish`.

## What it is

A standalone **`surfaces/telegram/`** adapter (sibling slot for a future
`surfaces/phone/`). A thin **long-poll** loop — `getUpdates` → `handleUpdate` →
`sendMessage` — needing only outbound HTTPS, so **no public URL / webhook**.
**Zero npm deps:** the Bot API is HTTPS via `fetch`. All rewritable logic comes from
**shelling out to the installed `rwa` CLI** (`execFile`, argument arrays) — the
adapter reimplements nothing (the operations-API rule: route to the contract).

## The two create paths

Both end in `rwa publish` → an ephemeral `<short>.rewritable.ikangai.com` link the
bot replies with (zero-config, no identity; the share expires in 24h — the bot says
so).

1. **Wrap path (no model key needed):**
   - plain text / markdown message → written to a per-update temp file → `rwa import`
     → `rwa publish`.
   - forwarded **document** (pdf/docx/csv/txt/md/html) → `getFile` (size-capped) →
     `rwa import` → publish. Documents work because `rwa import` already owns those
     converters — a direct payoff of shell-out.
2. **Agent-fill path (gated on a backend key):** `/new <prompt>` → `rwa create
   "<prompt>"` (agent generates a full rewritable) → publish. No key configured →
   a clear "agent-fill isn't configured on this bot" reply; `rwa create` is never
   spawned.

Commands: `/start` (help), `/new <prompt>` (agent-fill), bare text/document (wrap).
Photos / vision are **out of Phase A scope**.

## Config (env)

- `TELEGRAM_BOT_TOKEN` — required to run (from `@BotFather`).
- Backend key passthrough (the same env `rwa create` reads) — enables the agent-fill
  path; absent → wrap path still works, agent-fill replies "not configured".
- Long-poll `offset` persisted to a small file so restarts don't reprocess/drop.

## Security (untrusted input → subprocess)

Every byte from Telegram is attacker-controlled and the adapter spawns processes, so
(mirroring `publish-site`/`clone`):

1. **No shell, ever.** `execFile('rwa', [args…])` with **argument arrays**; user
   text/prompts/filenames are literal argv/stdin, never interpolated into a shell.
2. **User content becomes a file or a single argv element, not a parsed command.**
   Wrap text → a random-named temp file passed by path; `/new` prompt → one argv
   element to `rwa create`. Temp dirs cleaned in `finally`.
3. **Downloaded documents bounded:** size cap *before* `getFile`, extension/type
   allowlist, download to the per-update temp dir; never executed — handed to
   `rwa import` (which sanitizes HTML via `sanitizeImportedHtml`).
4. **Abuse / token-burn limits:** per-chat sliding-window rate limit, tightest on the
   agent-fill path; over-limit → friendly reply, no spawn.
5. **No secret leakage:** token + backend key in env, never logged, never echoed.
6. **Prompt-injection is bounded, not eliminated:** a malicious `/new` prompt can
   only steer the generated document's *content* (published as the user's own doc) —
   no shell, no host FS beyond the temp dir, no other chat. Accepted Phase-A boundary.

## Data flow, lifecycle & error handling

- **Loop:** `getUpdates(offset, timeout=50)` → dispatch each update → advance
  `offset = update_id + 1` and persist **only after** handling-or-error-reply
  (transient failures retry next poll rather than being lost). v1 handles one update
  at a time (a slow `rwa create` blocks the loop; concurrency is a noted later
  refinement).
- **Dispatch:** `/start`→help; `/new <prompt>`→agent-fill; document→download+wrap;
  text/markdown→wrap; else→friendly "send me text, a markdown file, or /new …".
- **Reply UX:** success → link + title + a one-line "⚠️ expires in 24h"; during a
  long create → `sendChatAction('typing')`.
- **Errors (Rule 12):** every `rwa` exit code + stderr captured; non-zero → a
  user-friendly reply ("couldn't read that PDF", "file too big", "agent-fill isn't
  configured") while full stderr is logged host-side. No silent swallow; a thrown
  handler is caught + logged and the loop continues (one bad message can't kill the
  bot).

## Testing

Core is a pure **`handleUpdate(update, deps)`** under a thin poll wrapper. `deps`
inject a fake **Telegram transport** (`getUpdates`/`sendMessage`/`getFile`/
`sendChatAction`, recording calls + scripted updates) and a fake **`execFile`**
(records argv, scripted exit/stdout/stderr). Fully offline. Tests (each encodes
*why*):

- **Dispatch:** `/start`→help; `/new X`→`rwa create` with `X` as one argv element;
  text→temp file + `rwa import`; document→`getFile` then import; junk→fallback.
- **Security (load-bearing):** `; rm -rf ~` reaches `execFile` as a literal
  argv/stdin element or file content — assert the exact argv array; oversized
  document rejected *before* `getFile` (assert no download).
- **Agent-fill gate:** no key → "not configured" reply, `rwa create` never spawned.
- **Success reply:** publish output parsed → reply has link + 24h note.
- **Error surfacing:** non-zero `rwa import` → friendly failure reply, stderr
  captured; loop survives a thrown handler.
- **Offset:** advances + persists only after handling; re-poll doesn't reprocess.

No live token in any test. A `surfaces/telegram/README.md` documents the one manual
acceptance step (set `TELEGRAM_BOT_TOKEN`, run, message the bot).

## Files

- `surfaces/telegram/bot.mjs` — `handleUpdate(update, deps)` + the poll wrapper +
  `main()`.
- `surfaces/telegram/telegram-api.mjs` — the zero-dep Bot API client (fetch wrappers).
- `surfaces/telegram/rwa-exec.mjs` — the `execFile` shell-out helpers (create/import/
  publish), argv-array only.
- `surfaces/telegram/*.test.mjs` — the offline test suite.
- `surfaces/telegram/README.md` — run + manual-acceptance instructions, the gates.

## The gates (to RUN, not to write)

The code lands + is green offline without either: a **bot token** (`@BotFather`) and
a **host** to run the long-poll process; the agent-fill path additionally needs a
**backend key**. All three are operator-provided; the adapter is written and tested
without them.

## Out of scope (YAGNI / later)

Webhook transport; concurrency/worker pool; photos/vision; durable `publish-site`
target; any *edit* (that's Phase B, gated on the hosted-edit foundation); identity
(create-only needs none).
