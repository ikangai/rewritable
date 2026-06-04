# re-write-able actions, skills, and workflows — v0.8

*The realizability pass. v0.7 produced a complete, careful design and proved each piece "implementable";
v0.8 takes that design, measures it against the actual substrate (a single self-contained `.html` with no
build, no CDN, running from `file://` and from a published origin), and resolves it into the leanest shape
that is buildable end-to-end while keeping the install dialog an honest trust anchor. Where v0.7 and v0.8
disagree, **v0.8 wins for implementation**; v0.7 remains the reference design and the source of the dialog
language. Derived from `docs/plans/2026-06-03-skill-layer-v08-design.md` (brainstormed + 17-scenario
stress-tested + adversarially red-teamed).*

---

## 0. What v0.8 changes vs v0.7

Measured browser facts that ground every decision below (real Chrome, file:// and http(s)):

- Blob Web Workers **spawn** under `file://` and `http(s)`; a fresh worker has `importScripts`/`fetch`/
  `indexedDB`/`Worker`/`eval` by default, so the runtime must remove them.
- `<meta http-equiv="Content-Security-Policy">` with `connect-src` **is enforced** under `file://` and
  `http(s)` — a single file can constrain network reach with no server headers, even offline. Measured
  further: in Chromium a `connect-src` meta injected by script **enforces even when inserted post-parse /
  post-load** (both timings blocked a cross-origin fetch). This is more permissive than the HTML spec (which
  says ignore post-parse meta-CSP), so CSP is treated as a **Chromium-measured backstop, not the primary
  control** — see §4/§5: the Worker fetch-bridge is the primary, all-browser per-origin enforcement.
- WebCrypto **Ed25519** sign/verify and **PBKDF2 + AES-GCM** both work with no CDN lib.
- **OPFS throws under `file://`** — durable skill state lives in the file bytes + IDB, never OPFS.

The deltas from v0.7:

1. **Placement is a dedicated `skill-host` PRODUCT_KIND** (v0.7 left it implicit). Base products carry none
   of the skill runtime; the immutable-bootstrap invariant is preserved for them.
2. **Every skill runs in a Web Worker.** v0.7 made Worker-mode a per-skill mode and let default-mode skills
   run on the page. v0.8 has **no main-thread skill path**: a main-thread function scope does not shadow
   `window.sessionStorage`/`indexedDB`/`document`/`fetch`, so a "default-mode" skill could read the API key,
   the vault, and the document directly. Compute runs in a **bridgeless** Worker; capability skills in a
   Worker **with** the `fetch`/`vault` bridge. This is the load-bearing correction and it makes the dialog's
   enforcement promise true for *every* kind.
3. **Permission tiers cut to two** that are cheaply enforceable: `network:` and `vault:`. `bus:`, `fsa:`,
   `idb:`-gating deferred to v0.9.
4. **Worker pool cut entirely** — spawn → invoke → terminate, no pooling/idle-timeout/pressure/shutdown-ack.
5. **CSP is boot-derived**, computed from the in-file skill manifests and injected as `<meta>` at boot —
   replacing v0.7's "regenerate the frozen bootstrap CSP on every install," which would violate Invariant 1.
6. **Forced-Worker demoted from a policy to the universal rule** (all skills are isolated); the manifest
   `execution`/`tested_modes` fields are removed.
7. **Vault downscoped to PBKDF2-200k + AES-GCM** (no Argon2id/WASM), machine-local.
8. **Bus, signed-marketplace distribution, Unicode-confusable lookalike, `name_history`, Worker pool,
   `hook` kind, and installable `view`/`edit-surface` skills are deferred to v0.9+.**
9. **Installed skills are reported through self-description/1** as `tool`/`compute` providers with
   `provenance:'installed'` — wiring the `tool` kind that is currently half-present (in the validators but
   not in the runtime producer).

The install dialog (§1) and the public-key-is-identity model are **kept from v0.7 unchanged** in substance.

**Normative framing (read before §§5–8).** This spec describes the *target* runtime behavior of the
`skill-host` kind. **None of it ships in the base seed bootstrap today** (which carries no skill runtime —
Invariant 1). Sentences about runtime behavior are normative-future ("the runtime **must** …"); §12 is the
acceptance gate that proves it built. The current substrate state is: `tool` is present in
`AFFORDANCE_KINDS` (both validator sites) but **not** in the runtime producer (`runtimeProvide`/
`runtimeDescribe`) or `KIND_PROVIDERS`, and there is no `installedSkills` registry, Worker spawner,
`parseSkillZone`, or skill-zone rewrite — all are to be built.

---

## 1. The install dialog (trust anchor — kept from v0.7 §1)

Installation is the privileged moment (Invariant 10). The dialog renders, in a bounded plain-English
vocabulary: the skill's declared purpose; the author (public key, with first-seen/install-count when known);
**what it can do** (permissions in prose); compound-risk callouts; capability-scan notes; and the affirmation.
v0.8 keeps v0.7's dialog structure and its anti-over-promise stance. Because every skill is isolated, the
dialog states a single enforcement claim that is now true for all kinds:

> **A skill cannot reach a network origin or vault namespace it didn't declare.** Within those limits, the
> skill's code decides what to do — the runtime cannot tell whether its author wrote it to help you or to
> harm you.

Required prose (normative — Invariant 10 demands the sentences be true):
- **Boundary claim** (above).
- **Attack-B disclosure** (above, second sentence) — at the decision point, immediately before the buttons.
- **Compound callout** when `vault:` and `network:` co-occur: *"⚠️ This skill can read stored credentials AND
  reach the network. A malicious author could send your secrets out. Install only if you fully trust this key."*
- **Lookalike** (when a name resembles a known source with a different key): *"This name closely matches
  '<trusted>' (edit distance N), first installed by key `…` on <date>. This skill's key is different. The
  author is identified by the key, not the name."*
- **Unsigned**: *"Unsigned — the runtime can't verify the author or that the code is unmodified."*

Variants (⌘K-authored, update, unsigned, etc.) follow v0.7 §1.2. The **update** variant shows a prose
permission diff and requires re-affirmation (§9, Shape C). Compute (zero-capability) skills get a
**lightweight** consent (no permission grid) but still carry the lookalike check and the Attack-B disclosure.

---

### 1.3 Skill-host UI & flows (target)
- **Install trigger:** a visible "Install skill…" button (and/or a `/install` lens command) opens a file
  picker for a `.rwa-skill.json`; the parsed envelope drives the §1 dialog. `rwa install <file>` is the CLI
  counterpart (deferred-optional in v0.8).
- **Skill-host INLINE_DOC stub:** a title, an **installed-skills list** (name · author-key · kind ·
  verified), the Install button, and the empty `<div data-rwa-frozen id="rwa-skills"></div>`.
- **Invocation wiring:** an author/runtime button calls `runtime.invokeSkill(skillId, input)`; input is
  validated against `input_schema` before spawn (`input_validation_error`); `output_schema` is advisory/doc.
- **Vault unlock UI:** a settings passphrase prompt; a locked invoke degrades per §6 (`null`/`vault_locked`);
  auto-lock clears the session key on tab unload.
- **Uninstall UI:** a per-skill remove button + confirm; orphaned vault credentials are flagged (machine-local
  data the uninstall does not erase by default).
- **Capability-scan note + update diff:** the scan note renders as a collapsible, non-blocking dialog block;
  the update variant shows the added/removed permission list with an "Accept new permissions" affirmation.

## 2. The `skill-host` product kind

Skills are hosted only by a container of kind `skill-host`, created via `rwa new --kind skill-host`. Its
bootstrap carries the skill runtime (keyed registry, Worker spawner + bridge, vault, install dialog,
capability scan, CSP injector). Base kinds (document/datatable/workflow/presentation) carry none of it and
keep byte-identical bootstraps (Invariant 1). Adding the kind touches the standard CLI sites: `KIND_TABLE` +
`kindOverrides` (`cli/src/seed.mjs`), `SYSTEM_PROMPTS` (seed), `KIND_PROVIDERS` (`tools/self-description.mjs`
+ `cli/src/identity.mjs`), `cli/README.md`, `cli/bin/rwa.mjs`. Its INLINE_DOC stub ships an **empty**
`<div data-rwa-frozen id="rwa-skills"></div>`.

---

## 3. Share format & provenance

### 3.1 The `.rwa-skill.json` envelope
```json
{
  "format": "rwa-skill/1",
  "skill": {
    "name": "gh-stars",
    "version": "1.2.0",
    "kind": "compute" | "tool",
    "description": "…",
    "permissions": ["network:api.github.com", "vault:github-prod"],
    "author_pubkey": "<base64 Ed25519 public key>",
    "input_schema": { … }, "output_schema": { … },
    "code": "/* the skill's JavaScript: defines async function run(input, runtime) */"
  },
  "signature": "<base64 Ed25519 signature, optional>"
}
```
`kind` is `compute` (zero capability — `permissions` MUST be empty) or `tool` (declares `network:`/`vault:`).

### 3.2 skillId
```
skillId = base64url( sha256( utf8(name) ‖ 0x00 ‖ utf8(author_pubkey) ) )
```
Deterministic, collision-free across authors, recoverable from the manifest alone. The registry is a
module-scoped `installedSkills: Map<skillId, {skillId, kind, manifest, code, signature, verified}>`, owned by
the runtime (`runtime.installSkill/uninstallSkill/invokeSkill/listSkills`) — never the kernel's single-slot
`providers` object. `invokeSkill`/`uninstallSkill` take the `skillId`, so same-named skills from different
authors coexist. The registry is rebuilt at boot by `parseSkillZone` (§8) over the frozen zone bytes.

### 3.3 Signature coverage (atomic manifest‖code)
```
sig = Ed25519.sign( authorPrivKey, sha256( canonicalJSON(manifest \ signature) ‖ 0x00 ‖ utf8(code) ) )
```
The signature covers manifest **and** code as one unit: you cannot swap code under a signed manifest nor
weaken permissions under signed code. `canonicalJSON` is stable-key-ordered over the manifest minus the
`signature` field. The **`author_pubkey` is the identity**; a forged trusted *name* is caught by lookalike
(§3.5), not by the signature. Verification re-runs from the bytes at every boot / `describe()` / `rwa doc`
(native Ed25519 is cheap), so `verified` reflects current truth and tampering flips it to `false`.

### 3.4 Signed vs unsigned
Signatures are optional. **Unsigned ⇒ `verified:false`**, permitted only for `compute` (zero-capability)
skills, rendered with weaker provenance language, and **an unsigned skill never contributes to the CSP
`connect-src` union** (it cannot widen the page's network surface for anyone). Capability (`tool`) skills
MUST be signed. There is no central registry; the key proves only that the bytes came from the key-holder.

**Install gate (normative).** The runtime MUST reject: an unsigned envelope that declares any permission
(error `unsigned_with_permissions`); any `compute` envelope with non-empty `permissions`
(`compute_with_permissions`); a `tool` envelope that is unsigned or fails verification (`unsigned_capability`).
The boot CSP parser additionally **skips unsigned skills** (defense-in-depth against hand-edited bytes), so an
unsigned skill can never widen `connect-src` even if its bytes were tampered to declare an origin.

### 3.5 Source identity & lookalike
Per-key state lives in IDB `rwa_sources` (`pubkey → {count, first_seen}`), **rebuilt at boot from the in-file
manifests**. At install, the runtime computes Levenshtein distance (Wagner-Fischer) between the incoming name
and each installed skill's name; distance ≤2 against a *different* key raises the §1 lookalike warning.
Unicode-confusable folding and `name_history` are deferred to v0.9.

---

## 4. Permission grammar (two tiers)

- **`network:<origin-pattern>`** — left-anchored per v0.7 §3.2: exact origin (`api.github.com`), single-label
  wildcard (`*.github.com` matches exactly one label: `api.github.com`, not `a.b.github.com`), multi-label
  (`**.github.com` matches zero-or-more left labels: `github.com`, `api.github.com`, `api.v2.github.com`; `**`
  may appear only as a left prefix), catch-all (`*`). No left-unanchored wildcards,
  no path matching, no IP wildcards. **Primary enforcement is the Worker fetch-bridge** per-call origin check
  (raw `fetch` is removed in the Worker; works in every browser); the boot CSP `connect-src` union is a
  **defense-in-depth backstop** (measured to enforce in Chromium, may be ignored by non-Chromium per the HTML
  spec). The injected `connect-src` must be the *sole effective* connect-src policy (CSP policies intersect).
- **`vault:<namespace>`** — exact-match string (lowercase ASCII/digits/`-`/`_`, ≤64, no leading/trailing `-`).
  No wildcards. Enforced by the vault bridge's per-call namespace check.

Deferred (v0.9+): `bus:`, `fsa:`, `idb:`. Invariant 17 (left-anchored, typed, anti-escalation) holds for both
shipped tiers.

---

## 5. Execution model — every skill runs in a Worker

There is **no main-thread skill path**. At invoke, the runtime spawns a blob Web Worker and runs a runtime
bootstrap that, **before loading the skill code**, sets these globals to non-writable/non-configurable
`undefined`: `importScripts`, `Worker`, `SharedWorker`, `ServiceWorkerContainer`, `XMLHttpRequest`,
`WebSocket`, `EventSource`, `indexedDB`, `eval`, `Function` (`window`/`document`/`sessionStorage` do not
exist in a Worker). Then:

- **`compute` (bridgeless):** no `fetch`, no `vault` — nothing to reach. "Zero capability" is structural.
- **`tool` (bridged):** the bootstrap installs proxied `fetch` and `runtime.vault` that tunnel over the
  message channel. Each message carries a per-invocation `identity_tag` (`crypto.randomUUID()` minted at
  spawn, validated on the main thread to bind the message to this live invocation — anti-confusion, not a
  capability token). **Permission enforcement happens on the main-thread side**, per call: the bridge
  re-derives `new URL(url).origin` and matches it against the manifest's `network:` patterns (no cached
  allowlist to poison); the vault bridge checks the namespace against the manifest's `vault:` set. The bridge
  is the **sole** path to network/vault.

Contract: `async function run(input, runtime)` → JSON-serializable output. 5 s timeout. **No pool** — spawn →
invoke → terminate. A `fetch` to an origin not matching the skill's `network:` patterns rejects with
`permission_denied`; vault calls use the §6 codes; uncaught skill exceptions surface as `runtime_error`;
timeout as `timeout`.

**Capability scan** runs on the envelope (manifest + code string) **before persistence**: a regex heuristic
(`\beval\s*\(`, `\bFunction\s*\(`, string-first `setTimeout`/`setInterval`, computed-member access). It is
**advisory and incomplete** (evadable via `Function.prototype.constructor`, blind to `postMessage`): its
output is a dialog note, **never an auto-reject**. The defense that *holds* is structural (§5a), not the scan.

### 5a. Worker spawn & bridge (normative)
1. **Spawn.** From the persisted code string, build a blob Worker: a runtime bootstrap prologue + the skill
   code. (Module vs classic worker is an impl choice; classic + `self`-scoped is sufficient.)
2. **Global removal, synchronously before the skill code runs.** For each of `importScripts`, `Worker`,
   `SharedWorker`, `ServiceWorkerContainer`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `indexedDB`,
   `eval`, `Function`: `Object.defineProperty(self, name, {value: undefined, writable: false, configurable:
   false})`. (`window`/`document`/`sessionStorage` do not exist in a Worker.) The prologue runs first in the
   blob, so the skill code never sees the originals. This is the testable form of Invariant 18 (§12.4).
3. **Bridge (tool only).** The prologue installs `fetch` and `runtime.vault` proxies that `postMessage` to the
   main thread. Message shape Worker→main: `{type:'fetch'|'vault.get'|'vault.set'|'vault.has', id, identity_tag,
   args}`; main→Worker: `{id, identity_tag, ok, result|error}`. Compute Workers receive **no** proxies.
4. **`identity_tag`.** A per-invocation `crypto.randomUUID()` minted at spawn and known only to that Worker.
   It is **never part of a permission decision** (the bridge re-derives origin via `new URL(url).origin` and
   the vault namespace from the call args, not the tag); it only routes responses. A message whose tag
   doesn't match the live invocation is **dropped**. It is never surfaced in errors or logs.
5. **Enforcement (main-thread side).** On `fetch`: check `new URL(url).origin` against the manifest's
   `network:` patterns → match ⇒ perform the real fetch (**`redirect:'error'`, forced after the opts spread**)
   and post back a structured-clone-safe response; no-match ⇒ `permission_denied`. On vault: §6 namespace
   check + codes. **Redirect handling is part of the boundary:** the pre-check only validates the *initial*
   origin, so the bridge sets `redirect:'error'` — fetch rejects on ANY 3xx *without contacting the target*,
   so a declared (or compromised) origin cannot redirect the request to an undeclared/internal origin and
   bypass the allowlist (SSRF). A post-hoc `r.url` check would be too late (the redirect request would already
   have been sent). Browser-proven: a 302 from a declared origin to an undeclared one yields `network_error`,
   not the redirect target's body.
6. **Lifecycle.** `Promise.race([result, 5s])`; on expiry `worker.terminate()` and resolve `{error:'timeout'}`.
   On `worker.onerror` ⇒ `{error:'runtime_error', message}`. Always `terminate()` after the single invoke
   (no pool). Input is validated against `input_schema` before spawn (`input_validation_error` on failure);
   `output_schema` is advisory/doc-only in v0.8.

---

## 6. Vault

`runtime.vault.{get,set,has,namespaces,unlock,lock,isLocked}`. PBKDF2-200k(SHA-256) → AES-256-GCM, per-
container salt + per-entry IV, ciphertext in IDB `rwa_vault`. The unlock passphrase derives a session key
cached in `sessionStorage` (never persisted); lock clears it. A Worker reaches the vault only via the bridge.
**Vault ciphertext is machine-local — it never travels in the file**; the file carries only namespace
*references* in manifests. Argon2id deferred.

Bridge error vocabulary (closed set; **no mid-invoke unlock prompt** — a Worker has no DOM, unlock is an
explicit settings action): `get` returns **`null`** on locked-or-missing — `null` is a **contract value, not
an error**; callers must not treat it as an exception. `set` while locked throws **`vault_locked`**; a
namespace outside the skill's `vault:` perms throws **`vault_namespace_denied`**; ciphertext present but
AES-GCM auth fails throws **`vault_decrypt_failed`**; IDB quota/IO failure throws **`vault_quota_exceeded`** /
**`vault_storage_error`**. This is the closed set.

---

## 7. Persistence & CSP

| Artifact | Lives in | Travels with file | Survives IDB eviction |
|---|---|---|---|
| Skill `{manifest, code, signature}` | `<div data-rwa-frozen id="rwa-skills">` (frozen zone), written at **install time** (durable in IDB before ⌘S) | **Yes** | Yes |
| CSP `connect-src` union | recomputed at boot from the frozen zone, injected as `<meta>` in `<head>` | derived | derived |
| Vault ciphertext | IDB `rwa_vault` | **No (by design)** | No |
| Vault session key | sessionStorage | No | No |
| Source records | IDB `rwa_sources`, rebuilt at boot from in-file manifests | rebuilt | rebuilt |

**The runtime is the sole writer of the frozen skill zone.** The agent/lens cannot edit it (the
`data-rwa-frozen` snapshot-equality guard rejects any drift). The runtime edits it through the
**`runtimeRegionCommit` primitive** (`reachability:'frozen'`; `docs/specs/rwa-runtime-region-commit-spec.md`),
called at **install / update / uninstall time** — *not* at ⌘S. `runtimeInstallSkill` registers the skill, then
calls `runtimeRegionCommit({ regions:[{ select:#rwa-skills, build:buildSkillZone, frozenId:'rwa-skills' }],
actor:'skill:install', reachability:'frozen' })`. `buildSkillZone(installedSkills)` regenerates the
`<div data-rwa-frozen id="rwa-skills">` with one `<script type="application/rwa-skill+json">base64(JSON(envelope))</script>`
per record (**canonical: sorted by `skillId`** so the bytes are install-order-independent — the primitive's
determinism requirement). The primitive splices *only* that region (asserted `region_escaped`), rides the R5
serialized queue (one `rwa_hist` entry, one ⌘Z), scopes the frozen-snapshot bypass to `rwa-skills` alone (every
*other* frozen zone stays byte-locked), and **re-asserts the region is still `data-rwa-frozen` post-build**
(`region_not_refrozen`) so a `buildSkillZone` bug can't ship an agent-writable zone. The write lands in
`currentDoc`/IDB immediately — **durable across a reload before any ⌘S** — and the existing `commit()` /
`buildFile(await getDoc())` then bakes it into the file unchanged (no registry logic at save time; `commit()`
stays a dumb file-builder). **Each envelope is base64-encoded**
(refinement validated in `parseSkillZone` impl): base64 contains no `</script>`/`</div>`/backtick/`${`, so
the stored block round-trips through escapeForTL and the frozen snapshot with zero encoding landmines (X1
neutralized at the encoding layer rather than relying on escape ordering), and the static parser can scope to
the frozen `</div>` by a flat scan. The snapshot guard then sees a self-consistent zone (the runtime wrote
it) and passes; any *other* writer's drift still fails. This single mechanism serves install, update, uninstall.
`parseSkillZone` (§8) reverses it: base64-decode → `JSON.parse` → re-verify. It trusts **only** blocks inside
the `data-rwa-frozen #rwa-skills` div (a skill `<script>` placed in the editable doc is ignored — agent cannot forge).

**CSP** is a boot-time property: at boot the runtime parses the frozen zone, unions all *signed* skills'
`network:` origins, and injects `<meta http-equiv="Content-Security-Policy" content="… connect-src 'self'
<union> …">` into `<head>` before any skill runs. The injected `<meta>` enforces the *current* session
(measured, §0); a *byte change* from install/uninstall is only re-read at the **next** boot. Boot resilience:
a skill block that fails `JSON.parse` or signature re-verify is **skipped** (contributes zero origins, never
blocks boot); an empty/absent zone ⇒ `connect-src 'self'`; if `<head>` is absent, injection is skipped and
the Worker bridge remains the all-browser enforcement; the union is recomputed every boot, never cached. No
live mutation of the base seed bootstrap — the `<meta>` lives in the skill-host head (preserving Invariant 1).

---

## 8. Self-description integration (the 4-site invariant)

Installed skills MUST be reported through self-description/1 as providers of kind `tool` (capability) or
`compute` (zero-capability), tagged `provenance:'installed'`, carrying `skillId` + `verified`. `tool` is
already in `AFFORDANCE_KINDS` at both validator sites (`tools/self-description.mjs`, `cli/src/identity.mjs`)
but absent from the runtime producer and `KIND_PROVIDERS` — so the first install would breach the 4-site
invariant until **three concrete gaps** close:
1. **`runtimeProvide` guard** (seed ~L3592) must accept `tool`.
2. **`runtimeDescribe`** (seed ~L3700) must add `'tool'` to its loop and **union** the keyed
   `installedSkills` registry (many; each tagged `provenance:'installed'` + `skillId`) with the first-party
   providers (one per kind, unchanged), de-duped on `(kind,name)` as today.
3. **`parseSkillZone(doc)`** must exist in the **oracle** `tools/self-description.mjs` (source) and be
   byte-mirrored in `cli/src/identity.mjs` (pinned by `identity.test.mjs`/`doc.test.mjs`). It locates the
   `id="rwa-skills"` frozen `<div>` (reusing `extractFrozenZones`, filtered to `name==='rwa-skills'` — not a
   new zone-finder), parses each `<script type="application/rwa-skill+json">`, **re-verifies the signature**,
   and returns `[{skillId, kind, name, verified}]`. So `rwa doc`/`ls` (static) report installed skills with
   `verified` from re-checked bytes → static projection **equals** live (SD-04).

`KIND_PROVIDERS['skill-host'] = []` — an **explicit** empty entry (matching how every existing kind is
tabled; not relying on the `|| []` fallback, which would mask a missing kind). A skill-host has no
first-party affordances; everything it reports is `provenance:'installed'`, emitted by
`runtimeDescribe`/`parseSkillZone`, not by `KIND_PROVIDERS`.

`view`/`edit-surface` remain **uninstallable** in v0.8 (they require DOM authorship = unrestricted
execution); the install gate rejects them with a clear error.

---

## 9. Trust model & attack shapes (resolved)

- **A — perm/code mismatch:** the capability scan is **advisory and incomplete** (evadable, blind to
  `postMessage`) — it informs the human, it is not the wall. What **holds** is *structural*: globals removed in
  the Worker, the per-call bridge origin/namespace check, the CSP backstop. (Timing/WebRTC/DNS side-channels
  are out of scope for v0.8.)
- **B — declared perms misused:** outside any runtime's reach; the Attack-B disclosure is the only honest
  defense; the dialog asserts only the boundary, never benignity. Acknowledged, not defended.
- **C — quiet capability expansion on update:** `skillId` decides update-vs-fresh; the previous manifest is
  read from the (agent-unreachable) frozen zone; a prose permission diff is shown and re-affirmation is
  required; CSP recomputes at next boot. Holds.
- **D — plausible-source forgery:** Levenshtein ≤2 lookalike warning; the public key is the identity;
  unsigned imports still run the check. Unicode-confusable variants deferred (narrower than v0.7, stated
  honestly). Novel sources fall back to Shape B.
- **E — compound `vault:`+`network:`:** named callout; Worker isolation is universal (was a "forced-Worker
  policy"); the bridge enforces both tiers per call. Holds. Combinations involving an unshipped tier
  (`fsa:`/`bus:`/`idb:`) cannot arise: a manifest declaring an unknown tier is **rejected at install with a
  clear error** (`unknown_permission_tier`) — not silently "defended," and not a deferred TODO.

---

## 10. Invariants (v0.8)

Carries v0.7 invariants 10 (install is the trust anchor), 16 (identity anchored on public key), 17
(permission patterns left-anchored & typed). Adds:

- **18 — Every skill executes in a Web Worker.** No main-thread skill path exists; compute runs bridgeless,
  capability skills run with the `fetch`/`vault` bridge as the sole I/O path. The dialog's boundary claim is
  true for every kind because of this.
- **19a — No one but the runtime may write the frozen skill zone.** The agent/lens can never write it (the
  `data-rwa-frozen` snapshot-equality guard rejects any drift — this exists today).
- **19b — The runtime is the *active* writer of the zone**, via `runtimeRegionCommit` (`reachability:'frozen'`,
  §7) on install/update/uninstall — the one mechanism that legitimately rewrites it (the agent path has no
  frozen-bypass, so the wall in 19a still holds). Skill code + manifest + signature are the durable artifact and
  travel with the file; vault ciphertext is machine-local and does not travel.
- **20 — A signature covers `manifest ‖ code` atomically.** Unsigned skills are `verified:false`, are limited
  to zero-capability `compute`, and never contribute to the CSP `connect-src` union.

The substrate invariants (byte-identical bootstrap for base kinds, per-container IDB, runtime never in IDB
and never visible to the agent, reserved stores runtime-only, commits carry no undo state) are unchanged.

---

## 11. What v0.8 does not deliver (deferred to v0.9+)

Bus / inter-skill messaging (`bus:` tier + message channel); Worker pool (idle timeout, compute pressure,
shutdown ack); `fsa:` and `idb:` tiers; Unicode-confusable lookalike + `name_history`; signed-skill
marketplace/distribution; installable `view`/`edit-surface` (DOM-authoring) skills; the `hook` kind;
Argon2id KDF. v0.8 keeps the *formats* forward-compatible (the envelope, the permission grammar, the
self-description shape) so v0.9 extends without breaking changes.

The architectural ceiling is unchanged from v0.7: Shape B (a skill misusing its declared permissions) is not
defendable by any runtime; the trust anchor is the human's install-time review, and the dialog's job is to
make that review possible and honest.

---

## 12. Acceptance (MVP conformance)

v0.8 is proven when, on a real `rwa new --kind skill-host` container, these pass end-to-end (in real Chrome):

1. Install `word-count` (compute, unsigned) → lightweight consent → registry → frozen-zone write on ⌘S →
   `rwa doc --json` reports `provenance:'installed', verified:false` (registry + persistence + 4-site).
2. Install `gh-stars` (signed, `network:api.github.com`) → signature verifies → CSP union → frozen-zone write
   (signature + CSP + skillId).
3. Invoke `gh-stars` → Worker spawn → globals removed → bridged fetch: `api.github.com` allowed, `evil.com`
   denied by **both** CSP and the bridge → terminate (the whole trust model).
4. Invoke `word-count` in a bridgeless Worker; **assert it cannot read `sessionStorage`/`indexedDB`/
   `document`/`fetch`** (Invariant 18 as a test, not a claim).
5. Update `gh-stars` (+`network:tracker.y`) → prose diff + re-affirmation (Shape C).
6. Uninstall `gh-stars` → ⌘S → manifest gone from bytes → reload → CSP no longer lists `api.github.com`
   (Invariant 19 + CSP tighten).
7. Email the file, open on a 2nd machine, re-verify from bytes, invoke → vault `null` + machine-local note
   (portability honesty + escape round-trip).

---

*v0.8 — the realizability pass. Placement as a `skill-host` kind; every skill in a Worker (bridgeless compute
/ bridged capability); two permission tiers (`network:`, `vault:`); boot-derived `<meta>` CSP; skillId-keyed
registry; atomic manifest‖code Ed25519 signatures (unsigned ⇒ compute-only, no CSP contribution); machine-
local PBKDF2/AES-GCM vault with a closed error vocabulary; runtime-as-sole-writer of the `data-rwa-frozen`
skill zone via a registry-aware commit; installed skills reported through self-description/1 as `tool`/
`compute` providers across all four sites. Three invariants added (18 all-skills-in-Worker; 19 runtime-sole-
writer + machine-local vault; 20 atomic signature + unsigned constraints). Bus, Worker pool, `fsa:`/`idb:`,
confusables, marketplace, `hook`, installable view/edit-surface, and Argon2id deferred to v0.9. Supersedes
v0.7 §1–§4 for implementation; v0.7 remains the reference design.*
