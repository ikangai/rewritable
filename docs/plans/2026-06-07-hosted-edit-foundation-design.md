# Hosted-edit foundation — design

**Status:** design (draft), one open decision flagged. Author: galois, 2026-06-07.
The keystone that unblocks every remote-*edit* surface (Telegram Phase B, phone).
Builds on `docs/specs/rwa-operations-api.md` and the offline-file invariant in
`re-write-able-spec.md`.

## The problem

`modify(file)` and `export(file)` assume the caller holds the bytes. A chat message
or a phone call doesn't. But the core invariant is non-negotiable: **the
self-contained `.html` is the durable truth.** We must enable edit-at-a-distance
*without* dethroning the file.

## The resolution: hosted projection, file stays canonical

A **writable hosted runtime** stores a rewritable's canonical bytes server-side and
exposes three operations from the contract over HTTP:

- `describe` — what is this / what can be done (`self-description/1`).
- `modify` — apply an `rwa-edit/1` envelope to the hosted copy; append to a durable
  history; return the new `self-description`.
- `export` — regenerate and hand back the canonical `.html` bytes (the escape hatch:
  you can always pull the real file down and it is byte-for-byte a normal rewritable).

The hosted copy is a **projection**, not a fork: every change is a logged
`rwa-edit/1` commit, so the canonical file is always reconstructable. A surface
(Telegram, phone) never edits "a database row" — it submits the *same envelope* the
CLI and lens submit. One contract, one more door.

**Why this preserves the invariant:** the bytes the server stores ARE a rewritable.
`export` returns a file identical to what `⌘S` would have written. Hosting adds a
*remote door onto modify*; it does not create a second source of truth. If the
service vanished, every user could `export` their file and keep working offline.

## Architecture (extends `service/`, stays zero-dep Node `http`)

```
   Surface adapter (Telegram bot / Twilio handler / web)
        │  HTTPS, bearer <capability or session token>
        ▼
   ┌──────────────────────────────────────────────────────┐
   │  service/  (zero-dep Node http — existing stack)       │
   │                                                        │
   │  POST /r/:id/describe   → self-description/1           │
   │  POST /r/:id/modify     → apply rwa-edit/1, log, commit│
   │  GET  /r/:id/export     → canonical .html bytes        │
   │  GET  /r/:id            → live editable web projection │
   │                                                        │
   │  store:  data/<id>/current.html  (canonical bytes)     │
   │          data/<id>/history.jsonl (rwa_hist mirror)     │
   │          data/<id>/owner        (identity binding)     │
   └──────────────────────────────────────────────────────┘
```

- **The apply path is shared, not reimplemented.** `modify` runs the *same*
  validator + splice the CLI uses (`cli/src/apply-edits.mjs` / `dsl-compiler.mjs`) —
  vendored into the service the way the CLI mirrors the seed, pinned by test. Frozen
  zones, reserved markers, structural-shape checks all hold server-side identically.
- **Agentic instruction → envelope** (the "edit by chatting" path) runs where a
  backend is reachable: the surface adapter (or a service worker) drives the agent
  loop to produce an `rwa-edit/1` envelope, then submits it to `/modify`. The
  service itself only ever applies *envelopes* — it has no model dependency, stays
  deterministic, and is the single audited write path.
- **History** is the durable `rwa_hist` mirror (actor-attributed: `telegram:<user>`,
  `phone:<caller>`, `web:<session>`) — so a hosted edit is as auditable as a local
  one, and `export`'d files carry their provenance.

## Mapping to the operations contract

This is **not a new contract** — it's the existing `modify`/`describe`/`export`
operations reachable over HTTP. The wire format on `/modify` is exactly
`rwa-edit/1`. `/describe` returns exactly `self-description/1`. A hosted rewritable
is the same animal; only the transport changed. (Per `rwa-operations-api.md`: route
to the contract, never reimplement.)

## THE OPEN DECISION — identity / auth model

Who may edit which hosted rewritable? This gates all foundation code, so it is
decided before a line is written. Three coherent options:

### Option A — Per-rwa capability token (recommended for v1)
Each hosted rwa mints an unguessable edit token at creation. Holding the token (a
"capability URL" / a secret the bot stores per chat) = the right to edit. No
accounts, no login.
- **Pros:** simplest possible; no user-account infrastructure; matches how shares
  already work (per-origin, unguessable short codes); a Telegram chat just stores
  its rwa's token; trivially testable.
- **Cons:** token leak = edit access (mitigate: rotate, scope, expire); no
  cross-device "my documents" list without the user keeping the link.
- **Best when:** the near goal is "create from a chat, keep editing from that chat /
  link." This is exactly Telegram Phase B and the phone spike.

### Option B — Account-linked identity
Users authenticate (OAuth / email magic-link); rwas are owned by an account; edit
requires being the owner (or shared-with).
- **Pros:** real "my documents," multi-device, revocation, sharing model.
- **Cons:** a whole auth subsystem (sessions, account store, a login UX per
  surface — and Telegram/phone identity ≠ web identity, so you need identity
  *linking* too); much larger build; more to secure.
- **Best when:** this becomes a multi-user product with durable accounts.

### Option C — Hybrid (capability now, account later)
Ship A. Make the owner binding pluggable (`data/<id>/owner` holds a capability hash
in v1, an account id later) so B is an additive upgrade, not a rewrite.
- **Pros:** fastest path to a working remote edit; doesn't foreclose accounts;
  smallest thing that unblocks Telegram B + phone.
- **Cons:** you will revisit auth when accounts arrive (but the projection/commit
  machinery is unchanged — only the `owner` check swaps).

**My recommendation: C (ship A's capability model, keep the owner-check pluggable).**
It unblocks the actual near-term surfaces with the least infra and security surface,
and the expensive part (the projection + shared apply + history) is auth-agnostic,
so an account upgrade later touches only the authorization check.

### ✅ DECIDED (2026-06-07, Martin): **Option A — capability token only.**
No accounts. Each hosted rwa mints an unguessable edit token at creation; holding
the token is the right to edit. The `owner` binding (`data/<id>/owner`) stores a
capability hash. We are NOT building account linking now (the projection/commit/
history machinery stays auth-agnostic, so the door to accounts isn't bricked — but
no pluggable-owner abstraction is built speculatively, per Rule 2; if accounts ever
come, the `owner` check is the one thing that changes). **Security obligations that
follow from this choice:** tokens must be high-entropy + constant-time compared +
never logged; support rotation + (optional) expiry; rate-limit per capability.

### Security — origin isolation (DEPLOY GATE)

**Hosted `/r/:id` MUST be served per-subdomain in production** — same pattern as
`/s/` shares: `<id>.r.rewritable.ikangai.com` (or similar), with a matching Traefik
`HostRegexp` route + the existing wildcard cert. This is a **deploy-gate
requirement**, not optional hardening.

Why: the v1 foundation serves the projection path-keyed on the APEX origin
(`/r/:id`). All hosted projections then share ONE origin's `sessionStorage` +
IndexedDB — and hosted bytes can contain arbitrary interactive `<script>` (anyone
can `POST /r`). So a victim who opens a malicious `/r/A` in the same tab session as
a legitimate `/r/B` exposes B's capability token (the shim stores it in
`sessionStorage["rwa_hosted_token_<id>"]`) to A's script. `/s/` shares avoid this
precisely because each gets its own per-subdomain origin, where the browser's
same-origin policy isolates per-doc storage.

The risk is narrow (it needs the same tab session AND the victim opening a hostile
hosted doc), but real. Until the per-subdomain deploy lands, the interim mitigation
is capability-token **rotation** (`POST /r/:id/rotate`); the durable fix is
origin isolation. Serve `/r/:id` per-subdomain before exposing it to untrusted
ingest at scale.

## Sequencing once the decision lands

1. Foundation build (Thread 4): the three endpoints + store + the chosen owner-check,
   reusing the CLI apply path. Offline-testable behind a `deps` seam. **Deploy gate:
   a host + DNS + secret store (yours).**
2. Telegram Phase B: reply-to-edit → drive agent → submit `rwa-edit/1` to `/modify`.
3. Phone spike: Twilio voice → STT → agent → `/modify` → TTS the new
   `self-description`. Timeboxed.

## Open questions (beyond the auth decision)

- **Conversational state** during a multi-turn edit: lives in the surface adapter
  (chat thread ↔ hosted rwa id), not in the service. Confirm.
- **Concurrency:** two surfaces editing one hosted rwa — reuse the seed's
  modify-mutex idea server-side (single-writer per id; reject/retry on conflict).
- **Lifecycle/cost:** do hosted rwas expire like shares (24h) or persist? Capability
  model makes "persist until token-holder deletes" natural; needs a sweep policy.
- **Abuse/limits:** the agentic path can burn backend tokens; rate-limit per
  capability + per surface identity.
