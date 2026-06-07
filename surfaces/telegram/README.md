# rwa telegram bot — Phase A (create & publish)

A Telegram bot that turns messages into **published rewritables**. Send it text, a
markdown file, or a document — it wraps it into a self-contained `.html` page and
replies with a shareable link (ephemeral, expires in 24h). With a backend key it can
also generate a page from a prompt (`/new <topic>`). It is a **thin adapter**: it
reimplements no rewritable logic, it shells out to the installed `rwa` CLI
(`import`/`create` → `publish`) over argument arrays. **Create-only** — there is no
editing yet (that's Phase B, which needs the hosted-edit foundation).

See the design (`docs/plans/2026-06-07-telegram-phase-a-design.md`) and the surface
contract it speaks (`docs/specs/rwa-operations-api.md`).

## Requirements / gates

An operator must provide:

- **`TELEGRAM_BOT_TOKEN`** — required. Create a bot with
  [@BotFather](https://t.me/BotFather) and copy the token.
- **The `rwa` CLI must be invokable.** `rwa-exec.mjs` resolves it once from the env
  (`resolveRwaCmd`):
  - if **`RWA_BIN`** is set, the bot runs `node $RWA_BIN <verb> …` (so a checked-out
    repo works with no global install — point it at `cli/bin/rwa.mjs`);
  - otherwise it runs **`rwa`** off your `PATH` (a global `npm i -g rewritable`).
- **A host to run the long-poll process.** The bot only makes outbound HTTPS calls to
  Telegram — **no public URL, no webhook** needed. Any always-on box works.
- **A backend — only for agent-fill (`/new`).** Sending text / markdown / documents
  (the *wrap* path) needs **no backend key**. `/new <prompt>` calls `rwa create`,
  which needs a model backend. The bot decides up front whether agent-fill is enabled
  via `resolveHasBackendKey`:
  - default backend is **openrouter** → enabled only if **`RWA_OPENROUTER_KEY`** or
    **`OPENROUTER_API_KEY`** is set;
  - a **keyless** backend (`RWA_BACKEND=ollama` or `RWA_BACKEND=lmstudio`) → enabled
    with **no key** at all;
  - otherwise `/new` replies *"agent-fill isn't configured on this bot."* and `rwa
    create` is never spawned.

## Run it

```sh
TELEGRAM_BOT_TOKEN=123456:ABC… \
RWA_BIN=/abs/path/to/rewritable/cli/bin/rwa.mjs \
node surfaces/telegram/bot.mjs
```

To enable agent-fill, also export a backend (one of):

```sh
RWA_OPENROUTER_KEY=sk-or-…          # default openrouter backend
# or, keyless:
RWA_BACKEND=ollama                  # ollama / lmstudio need no key
```

The long-poll **offset** is persisted to a small file so a restart doesn't reprocess
or drop updates. The path defaults to `<os tmpdir>/rwa-tg-offset`; override it with
**`RWA_TG_OFFSET_FILE`**.

`SIGINT`/`SIGTERM` shut the bot down cleanly — it stops after the current poll
iteration rather than mid-handle. Shutdown lag is bounded by the in-flight long-poll
(`getUpdates` waits ~50s), so allow up to that for the process to exit.

## Usage / commands

DM the bot, or add it to a chat:

- **`/start`** — prints help.
- **send text** — wrapped into a page (treated as markdown). Replies with a link.
- **send a markdown/document file** — `pdf`, `docx`, `csv`, `txt`, `md`, `html`.
  Same wrap → publish. Documents over **20 MB** are rejected with a friendly note.
- **`/new <prompt>`** — agent-fill: generates a full page from your prompt (requires a
  backend, see above). Replies with a link.

Every successful reply is the share link plus a one-line *"⚠️ expires in 24h"*.

## Security posture

Every byte from Telegram is attacker-controlled and the bot spawns subprocesses, so
(mirroring `cli/src/publish-site.mjs`):

- **No shell, ever.** All `rwa` calls go through `execFile(cmd, [argsArray])` —
  argument arrays, never a built command string, never `shell:true`. A `/new` prompt
  or filename of `; rm -rf ~` can only ever be the *text of a prompt* or the *name of
  a file*, never a command.
- **Untrusted input becomes a file or one argv element.** Wrap text is written to a
  random-named temp file and passed by path; a `/new` prompt is a single argv element
  to `rwa create`.
- **Flag-smuggling defense.** An argv array stops shell injection but not CLI-option
  injection: a positional beginning with `-` could be read by `rwa create` as a flag
  (e.g. `--base-url`, redirecting the backend). A `/new` prompt that starts with `-`
  is therefore **rejected** before any spawn; a dash-leading file path is neutralized
  to `./`-relative.
- **Document size cap** (20 MB) — checked *before* download where the size is
  advertised, and again on the received bytes.
- **Per-chat rate limit** — a sliding window; over-limit replies friendly and spawns
  nothing.
- **No secret leakage.** The bot token and backend key live only in the env; they are
  never logged or echoed. CLI stderr is logged host-side (for the operator) and never
  shown in the chat.

Prompt injection is bounded, not eliminated: a hostile `/new` prompt can only steer
the *content* of the page it publishes (as the sender's own doc) — no shell, no host
FS beyond the temp dir, no other chat. Accepted Phase-A boundary.

## Testing

The suite is fully offline — no token, no network, no live `rwa`:

```sh
for f in surfaces/telegram/*.test.mjs; do node "$f"; done
```

`handleUpdate`, `runPoll`, and the exec helpers are pure over injected deps (fake
Telegram transport, fake `execFile`), so dispatch, the security gates, the agent-fill
gate, error surfacing, and offset persistence are all asserted without side effects.

## Manual acceptance checklist

The one step that needs a live token. Set `TELEGRAM_BOT_TOKEN` and `RWA_BIN`, run the
bot, then DM it from Telegram:

1. **`/start`** → you get the help message.
2. send **`hello world`** → you get a share link (the wrap path; no backend key
   needed).
3. *(only if a backend is configured)* **`/new a one-page guide to espresso`** → you
   get a share link to a generated page.

## Scope — not in Phase A

No **editing** (Phase B — needs the hosted-edit foundation), no **webhook**
transport, no **photos / vision**, no **durable publish-site** target (shares are the
ephemeral 24h kind), and no **identity**. Create-only needs none of these.
