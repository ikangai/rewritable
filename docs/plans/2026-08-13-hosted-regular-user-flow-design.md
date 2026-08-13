# Hosted regular-user flow — design

**Status:** DESIGN (draft), author agent-18, 2026-08-13. Nothing built.
**Builds on:** the hosted-edit foundation (`docs/plans/2026-06-07-hosted-edit-foundation-design.md`,
built + `service/` `/r/` routes), share subdomain isolation
(`docs/plans/2026-05-17-share-subdomain-isolation.md`, shipped for `/s/`), the API-key
persistence change (`docs/received-container-threat-model-2026-08-04.md` §9, shipped
2026-08-12), and `docs/specs/rwa-operations-api.md`.
**Decision owner:** operator. This doc weighs the security prerequisite and the product
gap so that call can be made *before* code.

## 1. Who this is for, and why now

The target audience is a **non-technical office worker on a locked-down machine**: a
browser, no ability to install anything, and — at most — one API key someone handed her.
The last several increments circled this person:

- **Remember-key (shipped 2026-08-12)** removed the per-tab re-paste friction, but at
  `file://` it carries an accepted cost (threat model §9): a remembered key sits in
  storage shared across every local document, so a *malicious* rewritable could read it.
- **`rwa proxy` (shipped)** removes the key from the browser entirely — but needs a local
  install, which this person cannot do. It serves developers, not her.

Both the friction fix and its residual risk trace to one root: **the `file://`
null-origin sandbox.** Every local rewritable shares one origin, so storage is shared and
the browser's own credential machinery is disabled. The clean resolution — named as the
endpoint in threat-model §9 — is to put this user on a **real origin**, where the same
remember-key feature becomes both frictionless *and* safe, and the browser password
manager starts working. That is what this doc designs.

## 2. What already exists (do NOT rebuild)

- **The `/r/` hosted runtime** (`service/server.js`, `service/lib/hosted.js`): `POST /r`
  ingests a rewritable and mints an 8-char id + capability token; `GET /r/:id` serves the
  live editable projection (real stored bytes + an injected shim; the seed's own ⌘K UI
  runs unchanged); `POST /r/:id/{modify,undo,rotate}`, `GET /r/:id/{describe,export,doc}`,
  `DELETE /r/:id` round it out. `modify` is the server-authoritative, model-free
  `rwa-edit/1` apply via the vendored `service/lib/*`. **The file stays canonical:**
  `export` returns byte-identical rewritable bytes. The agent runs client-side; the
  service holds no model key.
- **Per-subdomain origin isolation for `/s/` shares** (shipped): `<short>.rewritable.ikangai.com`,
  an 8-char `[0-9a-z]` label, a Traefik `HostRegexp`, the wildcard cert
  `*.rewritable.ikangai.com` via `letsencrypt-dns` + `auth.acme-dns.io`. **This is the
  exact machinery `/r/` needs** — it just was never pointed at `/r/`.
- **Remember-key + `type=password` field** in the seed: on a real origin these already do
  the right thing (per-origin `localStorage`, browser save/autofill) with no seed change.
- **`rwa host <file>`** (CLI ingest) and **`POST /r`**: the two ways a hosted rwa is
  created today. Both assume a technical actor.

The build here is therefore small in code and mostly about **infra config + one product
on-ramp** — the expensive parts (projection, shared apply, history, isolation pattern)
already exist.

## 3. The core insight

`file://` couples three bad properties: shared storage (key leak surface), no secure
context (no password manager, no WebAuthn), and no per-document isolation. A dedicated
`https://` origin per hosted rewritable **dissolves all three at once**, for free, via the
browser's same-origin policy — the same win `/s/` shares already banked. Nothing about the
key-storage posture needs to be re-litigated; it just becomes safe when the origin
isolates it.

## 4. Design

### 4.1 Origin isolation — THE deploy gate (`docs/…hosted-edit-foundation §Security`)

Today `/r/:id` is served **path-keyed on the apex origin**. Every hosted projection shares
`rewritable.ikangai.com`'s `sessionStorage`/IDB, and hosted bytes can carry arbitrary
`<script>` (anyone can `POST /r`). A victim opening a hostile `/r/A` in the same origin as
a legitimate `/r/B` can read B's capability token. This is a hard **deploy-gate
requirement**, not optional hardening: `/r/:id` must be served per-subdomain before it is
exposed to untrusted ingest at scale.

**Label-shape decision (new — the foundation doc left it as `<id>.r.…`).** Hosted ids are
8-char base36 (`hosted.js generateId`), the *same shape as share short codes*. They cannot
share the share subdomain namespace or the two would collide. Two options:

- **A — distinct-length single label** (recommended): make hosted subdomains a different
  length, e.g. `<id>.rewritable.ikangai.com` with a **12-char** id, and give shares vs
  hosted disjoint Traefik rules (`HostRegexp {8}` for shares, `{12}` for hosted). Covered
  by the **existing** `*.rewritable.ikangai.com` wildcard cert — **no new cert, no new DNS,
  no acme-dns change.** Cost: lengthen `generateId` from 8→12 (one line) and add one
  Traefik rule + one Node host-dispatch branch mirroring `SHORT_HOST_RE`.
- **B — two-level label** (`<id>.r.rewritable.ikangai.com`, the foundation doc's shape):
  cleaner namespacing, but a two-level label needs a **second wildcard** `*.r.rewritable…`
  as a cert SAN + DNS — reopening the acme-dns config that was hard-won for `/s/`.

Recommendation: **A**. It shrinks the deploy gate to a Traefik rule + a Node branch + a
one-line id change, reusing every piece of the `/s/` infra. The 8→12 id change is free if
no production hosted data exists yet (likely — the gate was never met, so `/r/` isn't live);
if any exists, keep apex path-keyed `/r/:id` as a **legacy read-only** resolver and mint
new ones per-subdomain.

Host dispatch: extend the `SHORT_HOST_RE` logic — a 12-char host label routes to the hosted
projection for that id; the apex keeps serving `POST /r`, the authenticated `/r/:id/*`
lifecycle endpoints, and everything else. (Open sub-question: do the authenticated
lifecycle POSTs move to the subdomain too, or stay apex? Recommend they move to the
subdomain so the capability token is only ever presented to the isolated origin — the shim
already reads it from `#k=` client-side, so this is a base-URL change in the shim.)

### 4.2 The key on a real origin — the friction *and* the risk both go away

Once each hosted rwa has its own origin, the **already-shipped remember-key toggle works
correctly there with zero change**: `localStorage` is per-origin, so the key persists
across tabs and reloads *and* no other document (another hosted rwa, a `file://` doc) can
read it. The threat-model §9 residual — "a malicious local doc could read the remembered
key" — **does not exist on an isolated origin**, because a hostile document lives at a
different origin and the same-origin policy walls it off.

Additionally, the key field is already `<input type="password">`. On a secure context
(https) the **browser's own password manager** offers to save and autofill it — the "let
the browser do the work" path the operator asked about (2026-08-12), which is impossible at
`file://`. So the regular-user experience becomes: open the link → type the key once → the
browser remembers it → every future visit is one-click. No install, no re-paste, no
shared-storage risk.

**Honest limit:** this solves *storing and reusing* the key safely and frictionlessly. It
does **not** solve *acquiring* a key — see §5.

### 4.3 The on-ramp — how a non-technical user GETS a hosted rewritable

This is the real product gap: the runtime exists but every path to it assumes a technical
actor (`rwa host`, `POST /r`). Options for the regular-user entry:

- **A — author-provisioned link** (works today, zero new UX): a power user / the org runs
  `rwa host doc.html`, gets `https://<id>.rewritable.ikangai.com/#k=<token>`, sends it. The
  office worker just opens it and edits. Matches the original Telegram/phone framing
  (someone sets it up, the end user consumes). **Recommend as v1** — it needs only §4.1.
- **B — "Edit online" button in the container** (the ↗ share panel already exists for
  connected shares; add a hosted-edit sibling): a user who has the file open in a browser
  clicks once to push it to `/r` and gets the editable link. Needs a seed UI increment.
- **C — web create flow**: `rewritable.ikangai.com/new` offers "create & edit online" →
  `POST /r` → redirect to the subdomain projection. A genuine no-install create path, but
  the largest surface (a create UI + the abuse implications of anonymous public ingest).

Recommend **A for v1** (unblocks the persona immediately once isolation lands), **B next**
(self-serve for people who already have a file), **C only** if anonymous web creation
becomes a goal — it carries the most abuse/cost exposure.

### 4.4 The file stays canonical (the property we must not lose)

A hosted rewritable is a **projection, not a fork**. `GET /r/:id/export` returns
byte-identical rewritable bytes; the user can always pull the real file down and keep
working offline. The pitch to the office worker — "open this link, it just works, and you
can always download your document as a file you own" — preserves the single-file invariant
that is the whole point of the project. Surface this in the projection UI (a visible
"Download this document" affordance mapping to `export`).

## 5. What this explicitly does NOT solve

- **Key acquisition.** The hosted runtime is model-free by design; the browser still needs
  a key. Making a key *appear* for a user who has none is the **managed-key** question,
  which is decision **#11 (bring-your-own-key is permanent)**. A service-held shared key
  would mean the operator pays for everyone's inference and the documents' text flows
  through the operator's account — a business-model reversal, not a technical one. This doc
  does **not** reopen #11; it assumes the user brings a key (possibly org-provisioned) and
  makes *storing* it frictionless and safe. If #11 is ever revisited, the hosted origin is
  where a managed key would live — but that is a separate decision with its own doc.
- **Accounts / "my documents".** Auth stays the capability-token model (foundation doc,
  DECIDED 2026-06-07: Option A). No login, no account store. A user keeps her link.
- **Abuse & cost at scale.** Anonymous ingest (§4.3 option C) can burn storage and, via the
  client-side agent, backend tokens. Rate-limiting per capability + per source IP and a
  sweep/expiry policy are prerequisites for C, not for A.

## 6. Open decisions (each needs the operator)

1. **Label shape** — §4.1 A (distinct-length single label, reuse wildcard — recommended)
   vs B (two-level `.r.`, new cert SAN). Gates the infra work.
2. **On-ramp scope for v1** — A only (author-provisioned), or A+B (add the in-container
   "Edit online" button)? Recommend A for the first cut.
3. **Lifecycle** — do hosted rwas persist until the token-holder deletes (natural for the
   capability model), or expire like shares? A sweep policy is needed either way; the
   connected-share two-class TTL (`shareExpired`) is a reusable precedent.
4. **Do the authenticated lifecycle POSTs move to the subdomain** (§4.1) — recommend yes,
   so the token is only ever presented to the isolated origin.
5. **Staging** — this touches DNS/TLS/Traefik. The `/s/` plan required a staging vhost or a
   fast rollback path; the same discipline applies. Confirm the staging approach before
   prod.

## 7. Sequencing

Once decisions 1–4 land:

1. **Isolation (the deploy gate).** Lengthen `generateId` to the chosen shape; add the
   Traefik `HostRegexp` rule; add the Node host-dispatch branch mirroring `SHORT_HOST_RE`;
   point the shim's base URL at the subdomain. Held-in test: a projection served on its
   subdomain; a cross-origin read of another id's token fails. **Deploy gate: DNS/TLS
   already exist for the wildcard; only Traefik + service change.**
2. **Export affordance** in the projection UI (§4.4) — a visible download-the-file button.
3. **On-ramp A** — document the author-provisioned link flow (`rwa host` already emits it);
   optionally a short "share an editable link" note in the CLI/README.
4. **(If decision 2 = A+B)** the in-container "Edit online" button — a seed increment
   beside the ↗ connected-share panel.

Each phase is independently shippable; phase 1 is the one that unblocks everything and is
the security gate.

## 8. Risks

- **Third-party in the cert chain** (`auth.acme-dns.io`) already carried for `/s/`; option
  A adds no new dependency, option B stretches it to a second wildcard.
- **Namespace collision** if the hosted label length is ever allowed to equal the share
  length — the distinct-length invariant is load-bearing; encode it in the Traefik rules
  and a test.
- **Anonymous ingest abuse** — only if on-ramp C is pursued; A/B are provisioned by a known
  actor.
- **User confusion between the file and the projection** — mitigated by the export
  affordance and framing ("your document is a file; this is a live link onto it").

## 9. Out of scope

Managed keys / #11 reopen; accounts and cross-device document lists; the agentic
"edit by chatting" surfaces (Telegram/phone — they consume the same `/modify`, tracked
separately); CSP/hashed-bootstrap hardening (subdomain isolation is the chosen mechanism,
per the `/s/` plan); custom domains.
