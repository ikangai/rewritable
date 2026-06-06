# Design — `rwa publish-site`: durable custom publication to a static site

**Status:** design, validated with Martin 2026-06-06. Author: galois.
**Scope:** the "ikangai custom-publish" surface from the north-star plan
(`docs/plans/2026-06-04-north-star-universal-surfaces.md`, the *near / no-new-infra*
tier alongside the just-shipped webpage→clone).

## What this is

A new CLI verb, `rwa publish-site <file>`, that copies a self-contained rewritable
verbatim onto a static site over `scp`, returning the live URL. It is the durable
counterpart to today's `rwa publish` (an ephemeral 24h share on the
rewritable.ikangai.com service). Two distinct commands rather than one overloaded
`rwa publish --target`, because a throwaway link and a permanent publication to
*your own* site are genuinely different actions and read more clearly apart.

Because a rewritable is already a single self-contained `.html`, we publish the
**bytes verbatim** — there is no hosted-projection round-trip (that tension belongs
only to the remote-*edit* surfaces, not to publish). The artifact that renders on
the static site is byte-identical to the file on disk.

CLI-only (scp cannot run from a browser) and online by design — the offline-first
invariant applies to `new`/`import`, not to a publish action, exactly as for the
existing `rwa publish`.

## Flow

1. **Read + validate locally** (fail-fast, offline-detectable). Reuse `publish.mjs`'s
   pattern: read the file, run `extractInlineDoc` to confirm it is a rewritable.
   Same `CliError` `file_error` surface as `rwa doc`/`publish`.
2. **Resolve config.** `RWA_SITE_HOST`, `RWA_SITE_PATH`, `RWA_SITE_URL`, each
   overridable by `--host` / `--path` / `--url`. Any required value missing → a
   `config_error` naming the missing variable. Nothing is baked into the package
   (the server address/path is infra, not a public default like
   `DEFAULT_PUBLISH_URL`).
3. **Compute the remote name.** `basename(file)`, sanitized — never the full local
   path.
4. **Transport.** Invoke the system `scp` to copy the bytes to
   `<host>:<path>/<name>`.
5. **Report.** On success, print the public URL (`<RWA_SITE_URL>/<name>`) on stdout
   and nothing else; on scp failure, exit 4 with an honest subcode.

Republishing the same filename overwrites the same remote path — an idempotent
update, which is the intended "edit then re-publish" workflow. No versioning, no
prompt (it is your own site and an explicit action).

## Security

The command shells out and writes to a public site, so three concrete hazards are
addressed:

1. **Command injection.** Never build a shell string. Invoke `scp` via `execFile`
   with an **argument array** (`['--', localPath, remoteSpec]`), so a filename or
   host containing shell metacharacters is passed as a literal argument and never
   interpreted by a shell. Same discipline as `fetch-page.mjs` (no interpolation
   into dangerous sinks).
2. **Path traversal in the remote name.** The published name is `basename(file)`
   only. Then validate: reject (do not silently rewrite) any name that is not a
   plain `[A-Za-z0-9._-]+` ending in `.html` — no `/`, no `..`, no leading dot.
   A bad name → `invalid_name`. This prevents a crafted filename from escaping
   `RWA_SITE_PATH`. The remote spec is `<host>:<path>/<name>` with `path` from
   trusted config.
3. **Secret leakage — none, by construction.** A rewritable never stores the API
   key or backend choice in its bytes (sessionStorage only, per the container
   spec), so the verbatim file carries no credential. The published page is fully
   interactive — a visitor can use ⌘K with their *own* key — which is the intended
   behavior for a publication.

`scp`'s host-key verification (`known_hosts`) is the machine's existing ssh trust;
we do not disable `StrictHostKeyChecking` and the CLI handles no keys itself.

## Error model (mirrors `publish.mjs`)

| Stage | Condition | Exit | Subcode |
|---|---|---|---|
| Read | file missing | 2 | `not_found` |
| Read | unreadable | 2 | `read_error` |
| Validate | not a rewritable | 2 | `not_a_rewritable` |
| Config | missing host/path/url | 1 | `config_error` |
| Name | bad basename | 1 | `invalid_name` |
| Transport | `scp` not installed | 4 | `scp_not_found` |
| Transport | `scp` non-zero / spawn error | 4 | `transport_error` |

Exit 2 = local file problems (same as `doc`/`edit`/`publish`); exit 1 =
usage/config; exit 4 = remote/transport tier (the bin labels exit 4
`publish_error`, matching `publish.mjs`). Non-`CliError` throws propagate
(Rule 12 — a real bug is not swallowed). On a non-zero `scp` we surface scp's
actual stderr in the error details (the user needs to see "Permission denied
(publickey)" to fix it). No silent fallback, no retry. Success prints only the URL
on stdout; progress/notes go to stderr.

## Testing

`publishSite` takes a `deps` seam — `{ execFile }` defaulting to the real
`node:child_process` — exactly as `fetch-page.mjs` injects `{lookup, fetchImpl}`.
Tests pass a fake that records the argv and returns a scripted exit code/stderr.
No real network or host; runs in the offline suite. Each test encodes *why*
(Rule 9):

- **Validation gate** — a non-rewritable never reaches transport: `not_a_rewritable`
  (exit 2) AND the fake `execFile` is not called.
- **Config resolution** — missing `RWA_SITE_HOST` → `config_error` naming it; a
  `--host` flag overrides the env.
- **Command-injection defense** — `a;rm -rf.html` is rejected as `invalid_name` and
  never reaches spawn; the assembled argv is an array with `--` before the paths
  (assert exact argv).
- **Path traversal** — `../../etc/x.html` reduces to a basename / is rejected; the
  remote spec never contains `..`.
- **Remote-spec assembly** — `host:path/name` built correctly; trailing slashes
  normalized.
- **scp failure** — fake exits 1 with stderr → `transport_error` (exit 4) carrying
  that stderr verbatim.
- **scp missing** — ENOENT → `scp_not_found` (exit 4).
- **Success** — exit 0, stdout is exactly the public URL, the bytes handed to scp
  are the file's bytes.

No new fixture — reuse a minimal rewritable (or generate one via the seed, as other
tests do).

## Files

- `cli/src/publish-site.mjs` (new) — `publishSite(filePath, opts, deps)`.
- `cli/bin/rwa.mjs` — new `publish-site` verb branch + HELP entry (network-required
  note, like `clone`).
- `cli/tests/publish-site.test.mjs` (new).
- `cli/README.md`, `CLAUDE.md` (CLI conventions), `cli/TODO.md` — document the verb
  and any deferred follow-ups.

No service change, no seed change — pure CLI (no collision with concurrent seed
work).
