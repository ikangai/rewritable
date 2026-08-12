# Threat model — the received container (`file://`)

**Status:** ANALYSIS. No mitigation implemented. Decision required — see §8.
**Trigger:** [issue #4](https://github.com/ikangai/rewritable/issues/4), from the 2026-08-03 blindspot audit.
**Scope:** a rewritable authored by someone else, opened from the local filesystem.
**Precedent:** `docs/plans/2026-05-17-share-subdomain-isolation.md` did this for the *hosted*
case and fixed it. This document is the local analogue. It reaches a different conclusion, because
the fix that worked there does not exist here.

> This document deliberately states *which properties are missing*, not a working recipe. Everything
> cited is already visible in the repository. `SECURITY.md` now exists; concrete exploit development
> belongs in a private advisory, not here.

## 1. Why this is being written now

The hosted threat model was written in May, when the product's default gesture was **"edit your own
file."** Since then the gesture has changed:

- **Drop-in AI** (2026-07-05) made "someone hands you an AI carrier, you drop it in" a primary flow.
- **The artifact bus** (2026-07-06) generalised dropping foreign artifacts onto a container.
- **The "Use this AI" consent card** invites the user to type their API key **into a dialog rendered
  by the container they just received** (`seeds/rewritable.html:8502-8511`, `:8607-8611`).
- **Connected shares** extended a share's life from 24 hours to 90 days.

The product moved toward receiving files from other people. The threat model did not move with it.
That gap — not any single line of code — is the finding.

## 2. Threat model (motivation)

Mirroring the structure of the hosted document's own threat section.

**The pre-existing shared state.** A rewritable's document body may contain `<script>`, and the
runtime *deliberately re-executes* it on every render — `renderDoc` walks `querySelectorAll('script')`
and re-creates each one as a live element (`seeds/rewritable.html:1258-1267`). Interactive documents
are an intended, documented feature (`docs/specs/rwa-artifact-conventions.md:37`). There is no
sandbox: the document's script and the runtime share one JS realm.

**The unvalidated boundary.** Nothing distinguishes "document content" from "runtime" at execution
time. The runtime publishes its entire capability surface on `window.runtime`
(`seeds/rewritable.html:10549`), in the same realm, with no caller identity anywhere.

**The chain.** A container authored by someone else, opened locally, can — with zero indirection,
no message passing, no serialization boundary:

1. read the API key from `sessionStorage['rwa_apikey']`, including the one the user types into the
   container's own "Use this AI" card seconds earlier;
2. read the **raw AES-GCM vault key** from `sessionStorage['rwa_vault_key']`, which the runtime
   writes there in base64 on every unlock (`:7848`), with **no idle timeout and no auto-lock**;
3. open any other container's IndexedDB directly — `rwa_<DOC_UUID>` is a guessable, enumerable name
   and `runtime.db`'s reserved-name guard (`:652-655`) is a wrapper check that native
   `indexedDB.open()` simply bypasses;
4. exfiltrate all of it with `fetch()` to any origin — the CSP has **no `connect-src`**.

**Why UUID namespacing does not save us.** The hosted document already rejected this argument for
its own case, and the reasoning transfers verbatim: the malicious script is *inside* the realm, so
namespacing is bookkeeping, not a boundary. `re-write-able-spec.md` §5.7 says as much — *"the null
origin is no longer the bus; the UUID is the boundary"* — which is a statement about collision
avoidance, not security.

## 3. Capability inventory

What a received container's own script reaches. All verified.

| Capability | Reached via | Note |
|---|---|---|
| API key | `sessionStorage['rwa_apikey']` (`:474`) | also settable by URL: `?key=` is lifted into sessionStorage at boot (`:526-530`) |
| **Vault key (raw)** | `sessionStorage['rwa_vault_key']` (`:7848`) | exported AES-GCM key, base64. No auto-lock; clears only on explicit lock or tab close (`:7873`) |
| **Every vault namespace** | `runtime.vault.get(ns, key)` (`:7874`) | checks only *whether* a key is held — **no namespace ACL, no caller identity** in the main realm. Per-namespace gating exists only on the Worker/skill bridge path (`:9054`, `:9208`) |
| Bridge token / cwd | `sessionStorage['rwa_bridge_token' / 'rwa_bridge_cwd']` (`:481`) | credentials for the localhost shell bridge |
| Drive an LLM edit + commit | `runtime.modify` / `.commit` / `.applyEnvelope` (`:10569-10572`) | spends the user's key; writes the document |
| Same, undocumented | `window.applySkinL1`, `window.applySkinLike` (`:5919-5920`) | marked "expose for tests" but **not** jsdom-gated — ships in every container |
| Install + activate an agent | `runtime.agents.install` then `.setActive` (`:8349`, `:8321`) | see §5 — signature ≠ trust |
| Install + run a skill | `runtime.installSkill`, `runtime.invokeSkill` (`:8248`, `:9152`) | |
| Other containers' documents | native `indexedDB.open('rwa_<uuid>')` | shared null origin |
| Network egress | `fetch()` to any origin | no `connect-src` in the CSP |

## 4. Why the hosted fix does not port

The hosted case was fixed **structurally**: each share moved to its own subdomain, so the browser's
own origin partitioning makes cross-share reads impossible by construction. The plan explicitly
rejected CSP-with-hashed-bootstrap and sandboxed-iframe wrappers as weaker and more brittle than
origin separation.

**There is no `file://` analogue.** Every local container shares the one null origin. There are no
subdomains to separate them, and no browser-level partitioning to recruit. The mitigation that made
the hosted problem go away cannot be pointed at this one.

## 5. Things that look like mitigations and are not

Stating these explicitly, because each has been cited at some point as if it helped.

- **The CSP.** `script-src 'unsafe-inline' blob:; worker-src blob:; object-src 'none'` (`:17`). It
  stops a *skill Worker* from importing remote code — a real fix for a real hole (v0.8 "F1"). It
  governs script **origin**, not capability. It permits inline script by design (the bootstrap is
  inline), has no `connect-src`, and does not restrict `sessionStorage`, `indexedDB`, or `window`
  access, which CSP does not govern in any case. It is orthogonal to everything in §3.
- **The consent dialogs.** `showAgentInstallDialog` / `showSkillInstallDialog` are UI wrappers.
  `runtime.agents.install()` and `runtime.installSkill()` perform validation and signature checks
  but **do not render or await consent**. A script calls the install function directly.
- **Signature verification.** `_agVerify` checks the envelope against a public key **carried in the
  same envelope** (`:7555-7578`). That proves the envelope was not altered after signing. It does
  not establish who signed it. Self-signing is free.
- **`runtime.db`'s reserved-name guard.** `assertRuntimeDbStore` rejects `rwa_*` (`:652-655`) for
  callers of the wrapper. Native `indexedDB.open()` is unaffected.
- **The frozen zone / `data-rwa-frozen`.** An author-declared invariant enforced against *the agent's
  edits*. It is not a runtime privilege boundary and never claimed to be.
- **jsdom-gating of test seams.** Most `window.__*` seams are correctly gated (`:6673-6676` explains
  why). But several helpers commented "expose for tests" are **not** gated and ship —
  `window.bridgeCommand` (`:6223`), `window.getCurrentDocCache` (`:3420`), `window.applySkinL1`
  (`:5919`). This is a smaller, independently fixable gap.

## 6. Options

Each has a real cost. None is free, and one of them is "do nothing, on purpose."

**A. Accept, and say so.** Document that opening a received rewritable is equivalent to running
someone's program — because it is. Put it in `README.md` and `SECURITY.md`, not only in a design doc.
*Cost:* none technically; the risk stays. *Honest, and strictly better than the status quo, which is
the same risk undocumented.*

**B. Stop storing the vault key in `sessionStorage`.** Keep the `CryptoKey` in a module-scope
closure only (it is already `let _vaultKey` at `:7766` — the sessionStorage copy exists to survive
reload) and add an idle auto-lock. *Cost:* the vault re-prompts after every reload. *This is the
highest value-per-unit-effort item here, and it is independent of every other option.*

**C. Narrow `runtime.vault` in the main realm.** Per-namespace gating already exists on the Worker
path; the main-realm surface has none. *Cost:* some in-document code may rely on the broad surface.

**D. Trust ceremony on first open of a container the user did not author.** Record authorship at
creation; on first open of an unrecognised container, present a choice before executing document
script — read-only preview versus full trust. *Cost:* real friction on the product's central gesture,
and "did not author" is only heuristically knowable.

**E. Move key entry out of the container's realm.** The "Use this AI" card asks for a secret inside
the attacker-controlled realm. Even a separate ceremony that does not render inside the received
document would reduce the sharpest edge. *Cost:* significant UX rework of a flow shipped four weeks
ago.

**F. Sandbox the document body.** Render document content in a sandboxed iframe with a narrow
postMessage bridge. *Cost:* very large. It breaks interactive documents, which are a core feature,
and the hosted plan already judged iframe-wrapping brittle.

## 7. Recommendation

**B + A, now. D and E as product decisions. F: no.**

B is a contained change to one subsystem with a clear cost, and it removes the single worst item in
§3 — a raw encryption key sitting in the most trivially readable location in the browser, unlocked
indefinitely. A costs nothing and converts an undocumented hazard into a documented one.

F is not proportionate: it would dismantle interactive documents, which are the reason the format is
interesting, to defend against a threat the user can also avoid by not opening files from people they
distrust. The honest framing is closer to email attachments than to web pages, and that framing
should be *stated* (option A) rather than engineered away.

## 8. Decision — RESOLVED 2026-08-05

**A + B, with C–F declined. The residual risk is accepted deliberately.**

Built:

- **B** — the vault key no longer persists. It lives only in a runtime closure, a reload re-prompts,
  and it auto-locks after `RWA.VAULT_IDLE_MS` (15 min) without a vault operation. This removed the
  worst item in §3: a raw AES-GCM key sitting in the most readable place in the browser, unlocked
  indefinitely.
- **A** — the risk is stated where users meet it: `README.md` under "Opening a rewritable someone
  sent you", and `SECURITY.md` as an explicitly accepted risk rather than an unlisted one.
- The ungated test seams are gated (`bridgeCommand`, `getSourceMap`/`getCurrentDocCache`, the skin
  block), which shipped in every container while the `window.__*` seams beside them were correctly
  jsdom-gated.

**Accepted, and unchanged:** a received container's own inline script runs in the same realm as the
runtime. It can read the API key typed into it, reach other containers' IndexedDB at the shared
`file://` null origin, and exfiltrate freely — there is no `connect-src`.

## 9. Amendment — API key persistence (operator decision, 2026-08-12)

The 2026-08-05 decision kept the API key in `sessionStorage` (per tab, never persisted). The whole
value proposition, though, is a non-technical user opening a document — and for that user, re-pasting
the key in every tab of every document is the entire friction. The `rwa proxy` broker removes the key
from the browser but requires a local install, which that user cannot do. So the posture was
reconsidered deliberately.

**Decision: default to remembering the key.** A "Remember" toggle (⚙ → OpenRouter, **on by default**)
mirrors the key into `localStorage` — shared across all local rewritables at the `file://` null origin,
per-origin when hosted — so it is entered once and every document reuses it (`persistApiKey` /
`rememberKeyOn` / boot hydration in the seed; pinned by `tests/key-persist.mjs`).

**What this changes vs. §8.** A remembered key now sits in `localStorage`, which is *more durable* than
`sessionStorage` and readable by the same in-realm script a received container already runs — so a
**malicious rewritable opened from an untrusted source could read the remembered key** without the
user ever typing it into that document. This is a real widening of the §2 threat, accepted knowingly:
the target audience is trusted-source documents, and the friction otherwise makes the product
unusable for them. The vault key decision (B) is untouched — secrets in the encrypted vault never
persist; only the single OpenRouter key does.

**The off-switch is first-class.** Turning "Remember" off clears the stored key immediately and
restores the exact per-tab posture of §8 — the security-conscious user gives up nothing. The safe
path for the friction-free *and* isolated case remains a hosted origin, where `localStorage` is
per-origin and a `file://` document cannot read it (and the browser password manager becomes
available — it does not work at `file://`).

**Why C–F were declined.** F (sandboxing the document body) would dismantle interactive documents,
which are the reason the format is interesting — trading the product's point for a threat a user can
also avoid by not opening files from people they distrust. C, D and E are each defensible but carry
blast radius disproportionate to that same threat.

**The condition that should reopen this.** E (moving key entry out of the container's realm) stops
being optional if drop-in AI becomes a primary acquisition path rather than a power-user feature —
because the consent card asks for a secret *inside* the attacker-controlled realm, and that is the
sharpest single edge in this model. The artifact bus and the AI gallery have already moved in that
direction since this document was written. Revisit when a meaningful number of users arrive by
being handed a container rather than by making one.

## Appendix — corrections found while verifying

Two things stated elsewhere in the repository turned out not to match the code. Both are instances of
[#7](https://github.com/ikangai/rewritable/issues/7) (spec-fiction) rather than security findings:

- **`runtime.shared` / `rwa_shared` does not exist.** `re-write-able-spec.md` §5.7/§11.5 and
  `CLAUDE.md`'s storage table both describe a shared composition surface. Grepping the seed returns
  **zero** matches. The implemented cross-container primitive is `runtime.bus.*`
  (`BroadcastChannel`, `:1000-1048`) — message passing, not shared storage.
- **`?key=` in the URL.** The boot path lifts `?key=`, `?backend=`, and `?model=` from the query
  string into `sessionStorage` and then strips them from the address bar (`:526-539`). This is not
  documented in the container spec's sessionStorage section, and it means a *link* can carry a key.

---

*Analysis version 1 — no mitigation implemented. Issue #4.*
