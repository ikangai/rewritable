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

## Phase B — editing hosted rewritables

Phase B turns the bot from create-only into **create + edit**, by talking to a
**hosted-edit foundation** (a service that stores rewritables behind capability
URLs and applies `rwa-edit/1` modify envelopes). It is **opt-in**:

- **Set `RWA_FOUNDATION_URL`** to the foundation's base URL → the bot creates
  **editable hosted docs** and edits them **in-chat**.
- **Unset** → exactly the Phase A behavior above (ephemeral create, no editing).
  The foundation and state store are never even constructed.

### Model — one active doc per chat

A chat is bound to **one** active hosted doc at a time:

- **`/new <prompt>`** (or sending content when there is **no** active doc) creates
  and binds a fresh editable doc and replies with its link.
- **a plain message** (with an active doc) is an **edit instruction** — e.g.
  *"make the title a question"* — applied to the active doc; the bot replies *"✓
  updated"* with the link.
- **`/show`** — shows the active doc's link + title.
- **`/export`** — sends the canonical `.html` file (the offline escape hatch).
- **`/new` always starts fresh** — even when a doc is already bound, it creates and
  rebinds rather than editing the old one.

Sending a document or markdown file with no active doc creates a doc from it (same
as plain text); with an active doc, a plain text message is an edit.

### Env

In addition to the Phase A env (`TELEGRAM_BOT_TOKEN`, and a backend key for
`/new`/editing — see *Requirements / gates* above):

- **`RWA_FOUNDATION_URL`** — the hosted-edit foundation's base URL. Presence of
  this is the Phase B activation switch.
- **`RWA_TG_STATE_FILE`** — path to the per-chat binding store (the JSON file that
  maps each chat to its active doc + capability token). Defaults to
  `<os tmpdir>/rwa-tg-state.json`.

Both **creating** and **editing** call the agent (`rwa create` / `rwa edit`), so
they need a model backend configured — same gate as Phase A `/new`.

### Security

- **The capability URL is the edit credential.** A hosted doc's link embeds its
  write token (`…#k=<token>`). Anyone with the link can edit the doc — **treat it
  as a secret**. The bot only ever replies the link to the **owning** chat.
- **Tokens are stored `0600` and never logged.** The state file is written with
  mode `0600` (the binding carries the token); the token never appears in a log
  line or in any reply other than the capability link itself.
- **Editing/agent-fill need a backend key** (the agent runs adapter-side). With no
  backend configured, `/new` and edits refuse with a friendly note and spawn
  nothing.

### Deploy gate (carry forward)

> **When the foundation goes live, `/r/:id` MUST be served per-subdomain in
> production** (sessionStorage isolation — each hosted rewritable needs its own
> origin, exactly like the snapshot-publishing `<short>.rewritable.ikangai.com`
> shares). This is a **browser-projection / deploy concern on the foundation
> side**. The bot is a **server-side client** and is unaffected — but go-live must
> not forget it.

### Manual acceptance (needs a live foundation + token)

Set `RWA_FOUNDATION_URL`, `TELEGRAM_BOT_TOKEN`, and a backend key; run the bot;
then DM it:

1. send **`a one-page guide to otters`** → you get an **edit link** (a hosted,
   editable doc — not the ephemeral 24h share).
2. send **`make the title a question`** → *"✓ updated"* with the same link.
3. **`/show`** → the doc's link + title.
4. **`/export`** → you receive the canonical `.html` file.

## Scope — not in Phase A / Phase B

No **webhook** transport, no **photos / vision**, no **durable publish-site** target
for Phase A shares (they stay the ephemeral 24h kind), and no **identity**. Phase A
is create-only; Phase B adds editing of hosted docs but still no webhook/vision/
identity.
