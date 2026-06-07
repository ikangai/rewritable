# Hosted-edit foundation — build design (resolved decisions)

**Status:** design (validated, ready to plan). Author: godel, 2026-06-07.
**Companion to** `docs/plans/2026-06-07-hosted-edit-foundation-design.md` (galois —
the architecture + the auth decision) and `docs/plans/2026-06-07-north-star-execution-program.md`
(Thread 4). That doc says *what* and *why*; this doc resolves the *how* — the open
questions it flagged, the one seed change the live projection needs, and the build
shape — grounded in the actual seed code (`seeds/rewritable.html`) read 2026-06-07.

This is the **build** spec for Thread 4. It does not restate the architecture; read
galois's doc first. Auth is **DECIDED**: Option A, capability-token-only.

## Decisions resolved in brainstorm (2026-06-07, with Martin)

| Question | Decision |
|---|---|
| First slice | **Full foundation** — all endpoints incl. the live editable web projection `GET /r/:id`. |
| Web projection build | **Served real `current.html` + a small additive seed seam** (commit-transport sink). Server is the **strictly authoritative** apply path; full seed lens/⌘K UI is reused untouched. |
| Undo on hosted docs | **Server-undo button** (shim-injected → `POST /r/:id/undo`). Keyboard ⌘Z hosted-redirect **deferred** (would need a 2nd seam). |
| Lifecycle | **Persist until DELETE + generous inactivity sweep** (90 days since last access). |
| CLI | Add a thin **`rwa host <file>`** ingest verb (deps-injected, offline-testable). |
| Apply path | **Vendor the CLI file-edit pipeline into `service/`**, pinned byte-identical by test; loaded via dynamic `import()` (no CJS rewrite). Service stays model-free / deterministic / single audited write path. |

## Why a seed change after all (correcting the Thread-4 "no seed edit" assumption)

The live projection serves the canonical `current.html` (the real rewritable, full
UI) and must make the **server** the authoritative apply path. But the seed's commit
path is **closure-private**: the lens/⌘K calls the internal `modify()`
(`seeds/rewritable.html:5397`), which applies+commits through the private
`applyEdits`/`replaceDocument`/`commitDoc`. `window.runtime` exposes `modify`/
`commit`/`applyEnvelope`/`on`/`db`/`undo` but **not** the internal commit path, and
`RWA` is a closure-`const` (`:331`) — so an injected script cannot intercept commits
or even read `RWA`. A pure "redirect the seed's own commit" shim is therefore
**impossible without a seed change**. The chosen resolution is the smallest possible:
**one additive, guarded sink** at the single shared write funnel.

## The one seed change — a commit-transport sink in `commitDoc`

Both `applyEdits` (`:4300`) and `replaceDocument` (`:4357`) — every commit kind, both
the agent path (`modify`) and the direct-text path (`commitCore`) — funnel through:

```js
return await commitDoc(currentDoc, newDoc, histRecord);   // seeds/rewritable.html:4170
```

The seam lives at the top of `commitDoc`, before the IDB transaction:

```js
async function commitDoc(currentDoc, newDoc, histRecord) {
  if (typeof window.__rwaCommitSink === 'function') {
    // Hosted projection: the server is the authoritative apply path.
    // Reconstruct the rwa-edit/1 envelope and hand it over. The sink POSTs to
    // the server FIRST; on success it returns the server's canonical new doc.
    const envelope = histRecord.kind === 'edit_batch'
      ? histRecord.envelope                                   // {version, edits}
      : { version: 'rwa-edit/1', doc: newDoc, reason: histRecord.reason };
    const serverDoc = await window.__rwaCommitSink(envelope, histRecord, currentDoc);
    await idbPut(RWA.DOC, serverDoc);   // mirror server truth so getDoc()/reload are consistent
    return serverDoc;                   // caller renders it; NO rwa_undo/rwa_hist locally
  }
  /* …existing IDB transaction — byte-identical when the sink is unset… */
}
```

**Invariants this preserves**

- **Byte-identical when unset.** `window.__rwaCommitSink` is undefined in every
  normal container (file://, share, CLI-emitted), so every existing caller and every
  test is unchanged. Same additive/guarded discipline as `runtimeRegionCommit`'s
  `frozenBypass` param.
- **Server strictly authoritative.** The sink awaits the server POST *before* the
  local mirror update. A failed POST throws → `commitDoc` throws → `modify()`/
  `commitCore` surface the error → local `rwa_doc` is **not** advanced → local stays
  == server. No optimistic divergence.
- **`getDoc`/reload stay consistent.** `getDoc` (`:868`) prefers IDB `rwa_doc` over
  `INLINE_DOC`. The mirror write (`idbPut(RWA.DOC, serverDoc)`) keeps the next edit's
  base correct *and* makes a reload (which re-serves the updated `current.html`)
  consistent with what the user last saw. `rwa_undo`/`rwa_hist` are **not** written
  locally — history is server-side (`history.jsonl`).
- **Window-level, not `RWA`-level.** Because `RWA` is closure-private, the hook is a
  `window.*` global the seam reads lazily at commit time (no boot-order coupling).

The seam is pinned by a new seed test asserting: (a) unset → byte-identical commit
behavior across apply_edits/replace_document/direct-text; (b) set → the sink receives
the correct reconstructed envelope and the local mirror tracks the returned doc;
(c) a throwing sink leaves local state unadvanced. Reference regeneration follows the
seed change (`node tools/regenerate-refs.mjs`).

## The injected shim (server adds this to `GET /r/:id`)

The server serves `data/<id>/current.html` verbatim with a small `<script>`
**prepended** (so it parses before the bootstrap reads anything) that:

1. Sets `window.__rwaCommitSink = async (envelope, histRecord, baseDoc) => { … }`:
   - `POST /r/:id/modify` with `Authorization: Bearer <token>`, body
     `{ envelope, baseHash: sha256(baseDoc) }`.
   - On `200` → return `result.doc` (the server's canonical new doc).
   - On `409` (stale/concurrent) → surface a "document changed — reloading" notice
     and `location.reload()` (re-fetches the authoritative bytes).
   - On `401`/`5xx` → throw a clear `RwaEditError`-shaped error so the lens shows it
     and the user's edit is preserved (the seed already preserves lens input on a
     rejected submit).
2. Injects a small **Undo** button → `POST /r/:id/undo` → render returned prior doc +
   `idbPut(RWA.DOC, prior)`.
3. Holds the capability token from the capability URL fragment (`#k=<token>`) in
   `sessionStorage`, never in a query string (avoids referer/log leakage).

The agent still runs **client-side** (the user's own key in `sessionStorage`, exactly
as the seed does today). The service never sees a model key and only ever applies
envelopes — it is the deterministic, single audited write path.

## Endpoints & store

```
POST   /r                      ingest bytes → fresh DOC_UUID → mint token → {id, token, url}
POST   /r/:id/describe         → self-description/1   (Bearer)
POST   /r/:id/modify           {envelope, baseHash} → apply, log, commit → {doc, selfDescription, histLen}   (Bearer)
POST   /r/:id/undo             pop history.jsonl → {doc, histLen}   (Bearer)
GET    /r/:id/export           → canonical .html bytes   (Bearer)
GET    /r/:id                  → current.html + injected shim   (token via #fragment)
POST   /r/:id/rotate           → mint new token, supersede old   (Bearer)
DELETE /r/:id                  → remove the hosted rwa   (Bearer)

store:  data/<id>/current.html   canonical bytes (a real rewritable)
        data/<id>/history.jsonl  rwa_hist mirror, actor-attributed (telegram:<u>, web:<s>, …)
        data/<id>/owner          { capHash, createdAt, lastAccess }   (token sha-256 hash)
```

`/r/` is a new reserved prefix, disjoint from `/s/` (publishing). The `:id` reuses
the existing 8-char `[0-9a-z]` short-code generator; ids and tokens are independent
(id is public/in the URL path; token is the secret).

## The apply path — vendored CLI file-edit pipeline

`/modify` is effectively **`rwa edit --plan` run server-side** against the stored
file: extract `INLINE_DOC` → `applyPlan(envelope)` → rebuild the file. The CLI
already does exactly this (`cli/src/edit.mjs` `applyPlan` over `apply-edits.mjs` +
`dsl-compiler.mjs` + the `seed.mjs` `escapeTL`/INLINE_DOC backtick-walk). So:

- Vendor that module set (its full import closure) into `service/lib/` **byte-identical**
  to `cli/src`, gated by a `cmp`/deep-equal test (same pattern as
  `cli/src/dsl-compiler.mjs` ← `benchmark/oracles`). The deploy is a flat scp of
  `service/`, so the service must carry its own copy regardless.
- `server.js` stays CommonJS and loads the ESM via dynamic `import()` (Node supports
  this from CJS) — **no CJS rewrite**, so the bytes stay diffable against `cli/src`.
- Frozen zones, reserved markers, structural-shape, class-lock, size caps all hold
  server-side identically. The `baseHash` precondition rejects a stale-base envelope
  (the server applies against *its* `current.html`, never the client's claimed bytes).

This is the security spine: the server validates+applies the envelope itself; it
never trusts a client-computed doc. A malicious client can at most submit an envelope,
which the vendored validator subjects to the same wall the lens faces.

## Auth, concurrency, lifecycle, limits

- **Token:** 32-byte `base64url` (`crypto.randomBytes`). Stored **sha-256-hashed** in
  `owner.capHash`; compared in **constant time** (`crypto.timingSafeEqual`); **never
  logged**. Delivered to the browser via the capability-URL fragment (`#k=`), kept in
  `sessionStorage`. Rotation supersedes the hash; optional expiry is a later add.
- **Concurrency:** an in-process per-`id` write lock (mirrors the seed's
  `modifyMutex`) serializes `/modify`+`/undo` for one doc; plus the `baseHash`
  optimistic check → `409` on stale/concurrent so the client reloads. Single-writer
  semantics, no lost updates.
- **Lifecycle:** persist until `DELETE`; `owner.lastAccess` is touched on every
  authorized op; the existing hourly sweep gains a branch reclaiming docs idle > 90d.
- **Limits:** reuse the existing per-IP sliding-window limiter; add a per-token
  `/modify` cap. The agentic token-burn is client-side (user's key), so server cost is
  just deterministic applies.

## CLI — `rwa host <file>`

Thin ingest client: read the file, `POST /r` (transport injected via `deps` for
offline tests, like `publish-site`/`clone`), print `{id, token, url}`. Config
flags-over-env (`RWA_HOST_URL` / `--url`). Network-bearing (offline-first excludes
it). Exit-code surface mirrors `publish`/`publish-site` (2 file, 1 usage, 4 host
error). This is also how the build is end-to-end tested: host a fixture → modify →
export → assert byte round-trip.

## Testing (all offline, deps-injected)

- **Seed seam:** new seed test (commitDoc sink — set/unset/throwing) + full jsdom
  suite stays green + refs regenerated.
- **Service:** a node test harness driving the request handlers with a fake FS/data
  dir and fixture rewritables — ingest, describe, modify (apply + history + rebuild +
  byte round-trip vs `rwa edit`), undo, export, auth (wrong/absent token → 401),
  concurrency (stale baseHash → 409), rotate, delete, sweep. Vendored-apply cmp gate.
- **CLI:** `rwa host` with an injected transport (offline).
- **Conformance:** add a hosted-projection scenario asserting `/modify` output is
  byte-identical to the local seed apply of the same envelope (the "one contract,
  one more door" guarantee).

## Build increments (subagent-driven TDD, own worktree)

1. Seed seam in `commitDoc` + pin test + refs regen. *(seed — coordinate; smallest change)*
2. Vendor the apply pipeline into `service/lib/` + cmp gate.
3. Service core: store, ingest (`POST /r`), `describe`, `export`, auth + capability.
4. Service `modify`: vendored apply + history append + rebuild + `baseHash` + lock.
5. Service `undo`, `rotate`, `delete`, lastAccess + 90d sweep + per-token limit.
6. `GET /r/:id` projection + injected shim (commit sink + Undo button + token plumbing).
7. `rwa host <file>` CLI verb + test.
8. Conformance hosted-projection scenario; full-suite green; docs (CLAUDE.md routing
   + `rwa-operations-api.md` hosted-runtime column).

Order rationale: the seed seam and the headless API are independently testable before
the browser projection (step 6) ties them together. Steps 2–5,7 touch only
`service/`+`cli/` (seed-disjoint), so they proceed in a worktree while the seed step
is coordinated.

## Honest ceiling (unchanged from the program)

Autonomously deliverable + verified: **all of the above, offline.** The **deploy** is
yours — a host, DNS for `/r/` (or a subdomain), and a writable `data/` volume. Going
live needs no code I can't write; it needs infrastructure I can't provision. "Done"
means done-and-verified offline, with a precise hand-off for the deploy gate.

## Open / deferred

- Keyboard ⌘Z hosted-redirect (2nd seam) — deferred; server-undo button ships in v1.
- Token expiry (rotation ships; TTL later).
- Account-linked identity — explicitly out (Option A); the `owner` file is the one
  thing a future accounts upgrade would change.
- Telegram Phase B / phone (Thread 5) consume this once **deployed**.

## Known limitations (v1)

Documented-and-accepted, not bugs — each is a deliberate scope-down for v1.

- **Undo pre-image stack is unbounded.** Each edit writes one full-doc pre-image
  snapshot under `data/r/<id>/undo/`; there is no retention cap. Acceptable: edits
  are human-paced and rate-limited (60/hr/token), the 90-day sweep reclaims abandoned
  docs, and a snapshot is bytes-cheap vs. the audit value of unbounded undo.
- **Rate limit consumes a slot on rejected requests too.** A `400/409/422` still
  burns one of the per-token hourly slots. Deliberate abuse-resistance — a caller
  spraying malformed/conflicting envelopes can't probe for free.
- **Append-then-rename + push-before-rename crash window.** `history.jsonl` is
  appended (and the undo pre-image pushed) before `current.html` is renamed into
  place, so a crash mid-commit can leave history one record ahead of the live bytes.
  Forward audit only — history is never used to *rebuild* bytes (undo reads the
  pre-image stack); current.html is always a complete, valid prior commit.
- **Hosted bytes are un-blessed of `data-rwa-id`.** The hosted body is served and
  edited without the boot-time `data-rwa-id` backfill (the 2nd guarded seam suppresses
  it for baseHash parity), so within-hosted fragment links to mid-doc blocks don't
  auto-resolve. The exported file self-blesses on first local open — the canonical
  artifact is unaffected.
- **Hosted edit applies a CLIENT-driven envelope.** The agent runs in the
  browser/adapter; the service is model-free — `/modify` deterministically applies the
  `rwa-edit/1` envelope it is handed and never calls a model itself.
