# `rwa publish <file>` — design

**Date:** 2026-05-31
**Status:** design (validated via brainstorming, not yet implemented)
**Author:** Martin Treiber (with Claude)

## Problem

A rewritable is a self-contained `.html` you can share by any means (email, USB,
static host). The service also runs a snapshot-publishing endpoint —
`POST /publish` (`service/server.js`) — that takes container bytes, swaps in a
fresh `DOC_UUID`, stores them for 24h, and returns a host-keyed share URL
(`https://<short>.rewritable.ikangai.com/`).

But there is **no first-class client** for the "share *my* locally-edited file"
flow. `service/public/new.html` publishes a *fresh empty* container;
`service/public/import.html` publishes a *newly-converted* container from a
source doc. Neither takes an existing edited `.html` and publishes it. The only
way to publish a CLI-created, locally-edited file today is a hand-rolled
`curl -X POST --data-binary @file https://rewritable.ikangai.com/publish`.

`rwa publish <file>` closes that gap: create with the CLI → edit locally →
publish → get a share URL, in one command.

## Non-goals (YAGNI)

No clipboard copy, no "open in browser", no auth/accounts, no custom expiry, no
delete/unpublish, no batch publishing, no config file. The server is
anonymous-24h-only; the CLI stays a thin, honest mirror of that contract.

This command is **intentionally online** — unlike `rwa new`/`rwa import`, which
must work offline (CLAUDE.md "CLI conventions"). Publishing is inherently a
network action; that invariant does not apply here.

## Command surface

```
rwa publish <file> [--url <base>] [--json]
```

Reads `<file>`, confirms locally it is a rewritable, POSTs the raw bytes to
`<base>/publish`, prints the returned share URL.

**Target base URL resolution** (highest wins) — same pattern as the existing
`RWA_OLLAMA_URL`/`RWA_LMSTUDIO_URL` handling in `bin/rwa.mjs`:

1. `--url <base>` flag
2. `RWA_PUBLISH_URL` env var
3. Hardcoded default `https://rewritable.ikangai.com`

The base is an *origin*; the command appends `/publish` itself and tolerates a
trailing slash (`base.replace(/\/$/, '') + '/publish'`).

**Success output** — friendly multi-line block on stdout:

```
✓ Published!
  URL:     https://ab12cd34.rewritable.ikangai.com/
  Expires: in 24 hours
  Note:    the hosted copy gets a fresh DOC_UUID (distinct container)
```

**`--json`** emits the server object verbatim on stdout for scripting:

```json
{"short":"ab12cd34","url":"https://...","expiresAt":1748736000000}
```

(A `--quiet` flag that prints only the bare URL on stdout is deferred — `--json`
covers scripting; add it only if bare-URL piping turns out to matter.)

## Module structure & integration

**New file `cli/src/publish.mjs`** exports `async function publishCmd(filePath, { baseUrl, json })`.
It mirrors `doc.mjs`'s proven read-and-validate prologue, reusing the *same*
`CliError` `file_error` surface so read (`doc`), write (`edit`), and publish are
consistent:

```js
import { readFile } from 'node:fs/promises';
import { extractInlineDoc } from './seed.mjs';
import { CliError } from './edit.mjs';

export async function publishCmd(filePath, { baseUrl, json } = {}) {
  // 1. Read — identical CliError file_error surface to doc.mjs
  let bytes;
  try { bytes = await readFile(filePath, 'utf8'); }
  catch (e) {
    if (e?.code === 'ENOENT') throw new CliError(2, 'not_found', { path: filePath });
    throw new CliError(2, 'read_error', { path: filePath, errno: e?.code, message: e?.message });
  }
  // 2. Local validity check — same gate as `rwa doc`. Fails fast offline.
  try { extractInlineDoc(bytes); }
  catch { throw new CliError(2, 'not_a_rewritable', { path: filePath }); }
  // 3. POST (see below) — returns { short, url, expiresAt } or throws CliError(4, ...)
  ...
}
```

**Why reuse `extractInlineDoc` rather than duplicate the server's
`validateContainer`:** the CLI's job is fail-fast ("is this even a
rewritable?"), not to duplicate authoritative validation. The server still runs
`validateContainer` on receipt — the single source of validation truth stays
server-side. The local check just saves an obviously-wasted round trip and gives
an offline-detectable error.

**Wiring in `bin/rwa.mjs`:**

- Add a `publish` verb to the dispatch, following the `doc` verb block exactly:
  parse `--json`, find the file arg, define a local `emitPublish` helper (like
  `doc`'s `emitDoc`) for stderr error reporting, call `publishCmd`, surface
  `CliError` via `e.exitCode`/`e.subcode`.
- Add `--url <value>` flag parsing + `RWA_PUBLISH_URL`/default resolution,
  passing `baseUrl` into `publishCmd`.
- Add a `rwa publish` block to `HELP` and the `--url` flag to the flags list.
- Re-export `publishCmd` wherever `doc`/`edit` entry points are surfaced (match
  the existing convention — direct `await import('../src/publish.mjs')` like the
  `doc` verb does for `doc.mjs`).

## Network POST, error mapping & exit codes

**Transport:** global `fetch` (Node ≥20.16, per `cli/package.json` engines).
`POST ${base}/publish`, `Content-Type: text/html; charset=utf-8`, body = the
file bytes. The server reads the raw body and ignores content-type, so this is
safe.

**Exit codes** — stays inside the existing `0/1/2/3/4` contract:

| Exit | When |
|---|---|
| 0 | 201 Created — print friendly block / JSON |
| 1 | usage (missing `<file>` arg, bad `--url` value) |
| 2 | `file_error` — `not_found` / `read_error` / `not_a_rewritable` (local, pre-network) |
| 4 | every remote/network failure |

**Exit-4 subcodes**, mapped from the server's own error envelope so the user
sees the real reason:

| Server response | subcode | details |
|---|---|---|
| fetch throws (ECONNREFUSED, DNS, TLS) | `network_error` | `{url, message}` |
| 400 `validation_failed` | `validation_failed` | `{detail}` |
| 413 `body_too_large` | `body_too_large` | `{maxBytes}` |
| 429 `rate_limited` | `rate_limited` | `{retryAfterSec}` |
| 500/503 (`storage_failed`/`collision`) | `server_error` | `{status, error}` |
| any other non-201 | `unexpected_status` | `{status}` |

**Label note (Rule 7 — surfaced conflict):** exit code 4 is labeled
`agent_error` by the shared `codeName()` in `bin/rwa.mjs`. For `publish`, a
network failure surfacing as "agent_error" is misleading. `publish`'s local
`emitPublish` helper therefore labels exit 4 as **`publish_error`** — same
numeric code (consistent across the CLI), honest human label. We do *not* reuse
`codeName()` verbatim for this verb.

## Testing (`cli/tests/publish.test.mjs`)

Spawn-the-real-binary style of `doc.test.mjs` (`node:test` + `assert/strict`,
tmpdir fixtures). **No test touches the real network** — network cases stand up
an ephemeral `node:http` server (zero-dep, same stack as the service) and point
`RWA_PUBLISH_URL` at it.

**Local, no-network:**

- missing `<file>` arg → exit 1, `usage_error/missing_file_arg`
- nonexistent path → exit 2, `file_error/not_found`
- a directory / unreadable → exit 2, `file_error/read_error`
- a non-rewritable (`notes.txt`) → exit 2, `file_error/not_a_rewritable`, **and
  the stub server is never hit** (assert request count 0 — the fail-fast intent)
- URL resolution precedence: `--url` beats `RWA_PUBLISH_URL`; env beats default
  — assert which host the stub receives

**Network (stub server canned responses):**

- 201 → exit 0; plain mode prints the URL in the friendly block; `--json` emits
  the server object verbatim on stdout
- stub asserts it received the **edited `INLINE_DOC` bytes** (publish sends the
  real file, not a fresh seed) — the whole point of the feature
- 400 → exit 4 `publish_error/validation_failed`
- 413 → exit 4 `publish_error/body_too_large`
- 429 → exit 4 `publish_error/rate_limited` (carries `retryAfterSec`)
- 500/503 → exit 4 `publish_error/server_error`
- connection refused (dead port) → exit 4 `publish_error/network_error`

**Out of scope for tests:** the real `rewritable.ikangai.com` default is
asserted only as a string constant, never called.

## Files touched

- `cli/src/publish.mjs` — new
- `cli/bin/rwa.mjs` — `publish` verb dispatch, `--url` flag, HELP
- `cli/tests/publish.test.mjs` — new
- `cli/README.md` — document `rwa publish` (the CLI-conventions note in CLAUDE.md
  expects new verbs documented here)
