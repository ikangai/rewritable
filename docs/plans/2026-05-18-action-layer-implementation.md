# Action layer implementation plan (audit R7)

*Draft v0.1 — 2026-05-18. Scoping document, not a commit-to-ship sequence.
Sizes are rough, informed by reading v0.6 + v0.6.1 + v0.7 end-to-end; not
yet validated against a code path. Phases may resize as the open questions
in §6 resolve.*

---

## 1. Background

Audit R7 is *"implement the action/skill/permission/Worker-mode layer
specified in `docs/specs/re-write-able-actions-spec-v0.7.md` against the
current substrate."* With v0.7 + the v0.1 → v0.6.1 antecedents now
in-repo (commit `d70316c`), the design is fully accessible to
implementers. This plan slices the implementation into deliverable
phases.

The substrate as of 2026-05-18 ships with:

- A generic agent-call surface: `runtime.modify` / `runtime.commit` /
  `runtime.undo`, `lensMeta` with `actor` field (audit R2), `modifyMutex`
  serializing all agent calls.
- Per-container storage: `runtime.db.*` (IDB), `runtime.fs.*` (OPFS,
  `_<DOC_UUID>/`-namespaced).
- An event surface: `runtime.on('commit' | 'modify' | 'status', cb)`.
- Per-product-kind machinery: `PRODUCT_KIND` substitution, `SYSTEM_PROMPTS`
  registry, hoisted `LENS_PLACEHOLDER` consts, `LENS_CLICK_TO_ANCHOR`
  toggle (audit R0 + R1 + R3-scoped).

None of the action layer's surfaces exist yet — no vault, no skill
library, no install dialog, no Worker mode, no workflow graph.

## 2. Scope

**In scope:**
- v0.4 §2.4 defense-in-depth proxies.
- v0.6 §2 (skills), §3 (vault), §4 (installation + permissions).
- v0.6.1 patch (Worker pool semantics).
- v0.7 §1 (install dialog), §2/§11.9 (provenance + share format),
  §3/§11.10 (permission grammar), §4/§11.12 (Worker mode).

**Out of scope (handled separately):**
- The **workflow document type** (`rwa_workflow`, `rwa-graph/1`,
  `runtime.workflow.*`). Phase 7 below names it for completeness, but
  it depends on a graph spec (`rwa-graph/1`) that doesn't exist yet and
  overlaps with audit R4 (event-mount surface). Recommend: write the
  graph spec first, then plan workflow implementation against it.
- v0.7 §11.1 (common skill set contents) — separate design pass.
- v0.7 §11.7 (local-LLM fallback) — independent of the cluster.
- v0.7 §11.8 (Argon2id parameter pinning) — needs separate threat-model pass.
- The v0.7 §5.3 lens-lock cross-reference imprecision — flagged in
  CLAUDE.md for v0.7's next pass; not blocking this plan.

## 3. Phases

### Phase 1 — Vault (`runtime.vault.*`)

The most isolated piece. Encrypted-at-rest credential store usable by
documents directly before any skill exists.

**Sub-phases:**

- **1a — IDB store + namespace schema.** New runtime-reserved IDB
  database `rwa_vault` per v0.6 §3.1. Vault entries keyed by
  `{namespace, field}`. Add to the reserved-namespace list in CLAUDE.md.
- **1b — Crypto.** Argon2id KDF + AES-GCM (per v0.6 §3.4). Per-vault
  salt, per-entry IV. Pin parameters using current OWASP guidance
  (deferring §11.8's full threat-model pass).
- **1c — API.** `runtime.vault.{set, get, has, namespaces, unlock,
  lock, status}` per v0.6 §3.2. Two surfaces: skill-callable (with
  namespace-identity enforcement, but in Phase 1 there are no skills
  yet, so this is "future-proofed") and host-context-only (`unlock`,
  `lock`).
- **1d — Lock lifecycle.** Unlock UX (passphrase prompt in settings
  panel), focus-loss timeout (current direction: 30 min, see open
  question §6.2), tab close clears the cache.

**Dependencies:** None beyond the existing `runtime.db.*`
reserved-store mechanism.

**Verification:**
- 6–10 e2e scenarios in `tests/`: set/get/has round-trips, unlock with
  right/wrong passphrase, lock-after-timeout, persistence across reload.
- Smoke: open a fresh container, populate vault with a fake credential,
  confirm survives reload and is opaque to commit/export.

**Size:** 1–2 weeks. Mostly crypto-careful code.

### Phase 2 — Skill library (browse / edit, no execution yet)

`rwa_skill_library` IDB store + skill manifest schema + a viewer
container `skill-library.html`. Skills are visible-but-inert.

**Sub-phases:**

- **2a — IDB store + manifest schema** per v0.6 §2.1. Add
  `rwa_skill_library` to runtime-reserved IDB databases. Skill manifest:
  name, version, description, input/output schemas, permissions,
  execution mode, `tested_modes`, vault_namespace, implementation.
- **2b — Skill library viewer.** A new reference container shaped like
  the workflow scaffold (`Drafts` / `Installed` sections, each holding
  a `<ul>` of skills). Either: (a) `rwa new --kind skill-library`,
  using the R9-minimal machinery; or (b) a runtime-known special file
  the runtime opens directly. See open question §6.1.
- **2c — In-place skill authoring via ⌘K.** The library viewer's ⌘K
  targets the library, not skill code directly. Generated skills land
  as drafts (`status: 'draft'`) per v0.6 §4.1.

**Out of subscope:** imported `.rwa-skill.json` (Phase 4),
installation flow (Phase 3), invocation (Phase 3).

**Dependencies:** Phase 1 (manifest references vault namespaces, so
the namespace concept must exist).

**Verification:**
- 5–8 e2e scenarios: library round-trip, draft creation, manifest
  schema validation, status transitions (`draft` → ... handled in
  Phase 3).

**Size:** 1–2 weeks. The viewer container is substantial; the IDB
shape is straightforward.

### Phase 3 — Skill invocation in default mode + install dialog v1

The biggest phase. Implements v0.6 §2.4 (defense-in-depth proxies),
v0.6 §4 (installation flow), v0.6 §4.2 (permission enforcement), and
the v0.7 §1 install dialog (default-mode only — Worker mode is Phase 6).

**Sub-phases:**

- **3a — Per-skill bound API surfaces.** Each skill receives its own
  `runtime.{vault, bus, fs, skills}`, closed over its identity and
  permission manifest (v0.6 §2.4). The mechanism (closure-per-skill,
  Proxy objects, or something else) is an open question — see §6.5.
- **3b — Capability proxies.** Shadow `fetch`, `XMLHttpRequest`,
  `WebSocket`, `EventSource`, `navigator.sendBeacon`, `indexedDB`, FSA
  pickers in the skill's execution scope. Defense-in-depth, not
  adversarial sandbox (the v0.6 §2.4 framing is load-bearing here —
  don't oversell the boundary).
- **3c — Capability scan.** Maintained list of capability-bearing
  patterns (v0.6 §4.1). Initial coverage: proxy-bypass channels
  (`importScripts`, dynamic `import`, `new Worker`, `<iframe srcdoc>`,
  `postMessage`, element `.src` to remote URLs), plus `WebSocket`,
  `EventSource`, `navigator.sendBeacon`, `<link rel="preload">`,
  `RTCPeerConnection`, `navigator.serviceWorker.register`,
  `document.cookie`, `eval`, `new Function`, string-arg
  `setTimeout`/`setInterval`. Obfuscation-detection paragraph per v0.6 §4.1.
- **3d — Install dialog v1.** Implements v0.7 §1 shape minus Worker
  mode and provenance. Code review (syntax-highlighted), permissions
  in plain English, capability-scan notes, vault namespace disclosure
  with existing-namespace surfacing (v0.6 §3.1). No "install with
  reduced permissions" — accept the dialog or don't (v0.6 §4.1).
- **3e — `runtime.skills.invoke(name, input)` API.** Validates input
  schema against manifest, prompts user consent per v0.6 §4.4:
  `compute`-only no prompt, I/O permissions prompt-on-first-invocation
  per (document, skill) pair, with remember/session/ask-each-time
  options.
- **3f — Bus reservation.** `skills:*` topic reserved per v0.6 §2.2 —
  runtime is the only writer. Update CLAUDE.md reserved-namespace list.

**Dependencies:** Phase 1 (vault for credential access), Phase 2
(library + manifest schema).

**Verification:**
- 15–25 e2e scenarios: permission enforcement (allowed and denied
  cases per tier), install dialog approval/rejection, consent prompt
  branches (`remember for document`, `remember for session`, `ask each
  time`), capability-scan flag rendering, draft → installed lifecycle,
  reserved-namespace rejection at install.
- Smoke: install a sample compute-only skill, invoke from a document,
  then install a `network:` skill and verify the consent prompt fires
  exactly once.

**Size:** 4–6 weeks. The biggest phase — roughly half the plan's effort.

### Phase 4 — `.rwa-skill.json` import + provenance

v0.7 §2 / §11.9: share-file envelope, Ed25519 source identity,
signature optionality, lookalike detection.

**Sub-phases:**

- **4a — `.rwa-skill.json` parser.** JSON envelope with `skill` +
  `source` + `signature` fields. RFC 8785 (JSON Canonicalization
  Scheme) canonical encoding for signature verification.
- **4b — Ed25519 verification** via Web Crypto API. Successful
  verification → *signed import*; missing fields or verification
  failure → *unsigned import*. No fall-back from unsigned to "trust
  partially."
- **4c — `rwa_sources` IDB store.** Per-source state per v0.7 §2.2:
  `public_key` (durable identifier), `current_name`, `name_history`,
  `first_seen`, `installs_total`, `installs_current`, `last_install_at`.
- **4d — Lookalike detection.** Normalized comparison (case-fold +
  whitespace collapse), Unicode confusables (Unicode confusables data
  table), edit distance ≤ 2 on names of 8+ chars. Fire only against
  *known trusted* sources (`installs_current > 0`).
- **4e — Install dialog v2.** Provenance section (Author + signed /
  unsigned rendering). Lookalike warning surface. Update install dialog
  v1 from Phase 3d — additive, doesn't replace.
- **4f — Import-from-share UX.** Drag-and-drop or "Open With"
  pattern. Lands the skill as a draft in the library; install proceeds
  from the dialog.

**Dependencies:** Phase 3 (install dialog v1, library lifecycle).

**Verification:**
- 10–15 e2e scenarios: signed/unsigned imports, lookalike detection
  across normalization paths (Cyrillic 'а' for Latin 'a', case
  variations, edit-distance edge cases), source-counting persistence,
  signed-with-rename detection.

**Size:** 2–3 weeks. Crypto is plumbing; the UX surfaces are substantial.

### Phase 5 — Permission grammar (anti-escalation by construction)

v0.7 §3 / §11.10: left-anchored typed patterns per tier, recognizable
combinations curated list.

**Sub-phases:**

- **5a — Per-tier parser/validator.** `network:` (origin patterns with
  scheme), `vault:` (exact namespace, no wildcards except `vault:*`),
  `fsa:` (anchored glob with explicit `read:` / `write:` split),
  `bus:` (`<topic-pattern>:<scope>`), `idb:` (exact store).
- **5b — Anti-escalation rules** per v0.7 §3.1. Reject malformed
  patterns at install time:
  - No left-unanchored wildcards anywhere.
  - No path-level matching on `network:` (origin scope only).
  - No partial wildcards on `vault:`.
  - No leading globs on `fsa:` patterns.
  - No `..` in `fsa:` patterns.
- **5c — Pattern matchers in the proxies.** Phase 3b reuses these.
  Origin matching needs scheme-aware comparison; `*.wordpress.com`
  binds exactly one label.
- **5d — Recognizable combinations list** per v0.7 §3.7.
  Runtime-maintained list. Initial set (v0.7 §3.7):
  - credential + network exfiltration capability
  - credential + filesystem write capability
  - filesystem read + network exfiltration capability
  Each combination is a *disclosure category*, not an additive
  permission — it surfaces in the dialog as a named callout. The list
  also feeds the forced-Worker policy (Phase 6f).
- **5e — Dialog rendering** per v0.7 §3.2–§3.6: exact origin →
  *"Make network requests to `api.wordpress.com`."*, single-label
  wildcard → *"any direct subdomain of `wordpress.com`"*, catch-all
  → *strong warning*.

**Dependencies:** Phase 3 (install dialog + proxies in place).

**Verification:**
- 30+ scenarios: pattern parser for each tier (positive + negative),
  anti-escalation rejection (every rule in 5b), matcher behavior on
  tricky inputs (Unicode in origins, paths with traversal, IP edge
  cases), combination disclosure rendering.

**Size:** 2–3 weeks.

### Phase 6 — Worker mode (full v0.7 §11.12 design)

Largest single subsystem after Phase 3. v0.7 §4.

**Sub-phases:**

- **6a — Worker spawn + bootstrap.** Runtime supplies a bootstrap
  script that, before loading the skill's code, modifies the Worker's
  global scope (v0.7 §4.2).
- **6b — In-Worker shadowing.** Remove: `importScripts`, `Worker`,
  `SharedWorker`, `ServiceWorkerContainer`, `XMLHttpRequest`,
  `EventSource`, `WebSocket`, `indexedDB`, `eval`, `Function`. Install
  bridged proxies for: `fetch`, `runtime.vault`, `runtime.bus`,
  `runtime.skills.invoke`, `runtime.fs`. Leave untouched: `Date`,
  `Math`, `JSON`, `Promise`, `Map`, `Set`, `crypto`, `setTimeout`
  (function-arg form), etc.
- **6c — Host-page CSP.** Generate `connect-src` per installed
  Worker-mode skills' `network:` permissions. `script-src 'self'
  blob:`, `worker-src 'self' blob:`, `frame-src 'none'`. Update on
  install / uninstall / permission change. Open question §6.7:
  compose-and-decompose under concurrent install.
- **6d — Message-channel contract.** Identity tags (runtime-issued,
  per-Worker, opaque); message validation; async-Promise bridging;
  error vocabulary (`permission_denied`, `vault_locked`,
  `network_unreachable`, `quota_exceeded`, `timeout`, `invalid_argument`,
  `runtime_error`). v0.7 §4.4.
- **6e — Pool lifecycle.** Spawn-on-first-invoke; `pool: true`
  (default) reuses across invocations within a session; `pool: false`
  sends `shutdown` with 1.5s ack window, then `worker.terminate()`;
  5-minute idle timeout sweep; Compute Pressure API preemption when
  available, falling back to idle alone (v0.7 §4.5).
- **6f — Forced-Worker policy.** Detect recognizable combinations
  (Phase 5d), pre-select Worker in install dialog. Reject when
  manifest declares `execution: 'default'` + `tested_modes: ['default']`
  only for a forced-Worker combination (v0.7 §4.6).
- **6g — Reject-with-message for runtime mode mismatch** (v0.7 §1.2):
  skill declares `worker`, runtime doesn't support Worker mode →
  rejection surface with edit-or-decline.

**Dependencies:** Phase 3 (default-mode infrastructure), Phase 5
(`network:` pattern matching feeds CSP generation), R5 (concurrency
model — see §4).

**Verification:**
- 25–35 e2e scenarios: Worker spawn + message round-trip; each
  bridged API; CSP enforcement under mock fetch; pool lifecycle (idle
  timeout, pressure preemption, tab close, shutdown ack timeout); all
  three forced-Worker rejection paths from v0.7 §4.6.
- Smoke: install a credential×network skill, observe forced-Worker
  pre-select, verify in-Worker `fetch` actually goes through the
  bridged proxy and not the platform's native `fetch`.

**Size:** 4–6 weeks. The most platform-fragile work in the plan.

### Phase 7 — Workflow document type *(deferred — separate plan)*

Per v0.6 §5–§6: `rwa_workflow` store, `rwa-graph/1` editing protocol,
`runtime.workflow.*` API, trigger model, RunResult shape, cost caps,
self-modifying workflows with by-trigger persistence.

Substantial phase on its own. Depends on the **`rwa-graph/1` spec**
which doesn't exist yet — the action-spec drafts reference it but
don't define it. Recommendation: write `docs/specs/rwa-graph-spec.md`
first; plan workflow implementation against it as a separate document.

Out of scope here. Named for completeness.

## 4. Substrate work that touches every phase

Identified upfront so the right Phase scoops each:

- **Bus / `runtime.shared.*`.** The bus exists conceptually
  (per-store BroadcastChannel) but the cross-container surface
  `runtime.shared.*` is deferred per `re-write-able-spec.md` §11.5.
  Skills (Phase 3+) and the `skills:registry` topic (Phase 2) need at
  least a single-container-scoped bus. See open question §6.4.
- **Reserved-namespace expansion.** CLAUDE.md's reserved-namespace
  list needs updating for each new IDB database (`rwa_vault`,
  `rwa_skill_library`, `rwa_sources`, plus `rwa_workflow*` if Phase 7
  ships). Group additions per phase commit.
- **Lens-lock cross-reference (v0.7 §5.3).** Worth fixing in v0.7
  (or a v0.8 bump) before Phase 6 — Worker mode adds new in-flight
  message types whose state machine interacts with the modify mutex.
- **Concurrency model (audit R5).** `modifyMutex` is a single
  caller-held lock today. By Phase 6, Worker pools want concurrent
  skill invocations against separate Workers. R5 is implicit in Phase
  6; best done before Phase 6 starts to avoid a Worker-pool-vs-mutex
  collision. Estimate: 1–2 weeks.

## 5. Sequence and dependencies

```
                 ┌─ Phase 1 (vault)
                 │
                 └─→ Phase 2 (skill library, no execution)
                          │
                          ↓
              Phase 3 (skill invocation default mode + install dialog v1)
                  ↓                    ↓
              Phase 4              Phase 5
              (.rwa-skill.json)    (permission grammar)
                  ↓                    ↓
                  └───────→ R5 ───→ Phase 6 (Worker mode)
                       (substrate
                        concurrency)

(Phase 7 workflows — deferred, separate plan after rwa-graph/1 spec)
```

Phases 4 and 5 can run in parallel after Phase 3. Phase 6 needs both
+ R5.

## 6. Open questions

Design decisions that need resolution before implementation can
proceed in each phase:

1. **Skill library viewer: rwa `--kind skill-library` vs.
   runtime-known special file (Phase 2).** v0.6 §2.2 says
   `skill-library.html` is "one possible UI"; the library data lives
   in IDB regardless. Should the runtime know a specific file path
   (well-known location on disk)? Or is the viewer just a normal rwa
   container with `runtime.skills.*` API access? The v0.6 spec leans
   toward the latter but doesn't fully commit. Closely tied to: is the
   viewer a singleton (one per machine), or can the user have multiple?
2. **Vault unlock UX (Phase 1d).** v0.6 §3.4 says "unlock once per
   session, re-prompt after N hours of inactivity, surface lock/unlock
   in runtime status." Doesn't pin N or specify how the UX appears.
   v0.6.1 doesn't refine. Needs UX pass before Phase 1d.
3. **Argon2id parameter pinning (Phase 1b).** v0.7 §11.8 deferred.
   Implementation needs concrete values; "current OWASP guidance"
   lets us start, but the threat-model pass per §11.8 may shift them.
4. **Cross-container bus shape (Phase 2/3).** `runtime.shared.*`
   deferred per `re-write-able-spec.md` §11.5. The skill library
   publishes to `skills:registry` per v0.6 §2.2; that requires
   cross-container reads. Decide: implement a minimum-viable
   `runtime.shared` for this case, or scope to per-container library
   via a runtime-known file path (closely tied to §6.1).
5. **Per-skill bound API surface mechanism (Phase 3a).** v0.6 §2.4
   specifies the model ("each skill receives its own runtime.vault,
   runtime.bus, etc., closed over its identity") but doesn't pin the
   JavaScript mechanism. Options: function-scope closure per skill;
   Proxy objects; separate import maps; iframes per skill (heavy).
   Each has tradeoffs on overhead, debuggability, and isolation
   strength.
6. **Capability-scan list curation (Phase 3c).** v0.6 §4.1 commits to
   "a curated list of capability-bearing patterns; the list grows
   with the web platform." Where in the codebase does the list live?
   Who owns its update cadence? Is it bundled with the seed (per
   release) or fetched (with all the supply-chain tradeoffs that
   implies)?
7. **CSP composition under uninstall (Phase 6c).** When the user
   uninstalls a Worker-mode skill, host CSP's `connect-src` shrinks.
   If two skills overlap on a network permission, removing one should
   keep the origin in the CSP. The compose-and-decompose logic under
   concurrent install/uninstall needs design.
8. **`rwa-graph/1` spec (blocks Phase 7).** Doesn't exist yet.
   Recommend: write it as a separate document before Phase 7 is
   planned in detail.

## 7. Rough sizing

Estimates are *focused-effort weeks* — not calendar weeks (calibrate
against actual capacity).

| Phase | Estimate |
|---|---|
| Phase 1 (vault) | 1–2 weeks |
| Phase 2 (library, no execution) | 1–2 weeks |
| Phase 3 (invocation + dialog v1) | 4–6 weeks |
| Phase 4 (.rwa-skill.json + provenance) | 2–3 weeks |
| Phase 5 (permission grammar) | 2–3 weeks |
| R5 (substrate concurrency — prereq for Phase 6) | 1–2 weeks |
| Phase 6 (Worker mode) | 4–6 weeks |
| **Total Phases 1–6 + R5** | **15–24 weeks** |

Plus Phase 7 (workflows): roughly 4–6 weeks once the graph spec
exists.

The total spec defines a system roughly the size of the substrate
again. The action layer is a real second-level investment, not a
small addition.

## 8. Tracer-bullet alternative (smallest meaningful demo)

If full Phase 1–6 is too big to commit to upfront, the smallest viable
end-to-end demonstration is:

- **Phase 1, minimal** (vault: just set/get/lock; skip the focus
  timeout polish).
- **Phase 2, minimal** (library + manifest schema; one hand-coded skill
  hardcoded into the library at boot — no authoring UX).
- **Phase 3, abbreviated**: just `runtime.skills.invoke` against the
  hand-coded skill + a one-page install confirmation (no capability
  scan, no full permission grammar, no defense-in-depth proxies).
  Default-mode only, single-permission (`network:` only) skill.

That's roughly **3–4 weeks** of focused work and proves the model
end-to-end. It produces a *"publish-to-blog skill that posts a
document"* demo. It is **not spec-conformant** — many of v0.6's
invariants (especially install-time review, capability scan, vault
encryption) are stubbed or absent. Worth doing as a decision-forcing
function before committing to Phases 4–6.

## 9. Status check before Phase 1 starts

Recommended resolutions before any code is written:

- Open questions §6.1 (library file shape), §6.2 (vault UX), §6.4
  (cross-container bus scope) — these block Phase 2.
- Confirm sizing is OK with the rest of the roadmap. This is 15–24
  weeks of focused work on the action layer, displacing other
  substrate work.
- Decide whether to write the `rwa-graph/1` spec now (clears Phase 7
  path) or defer (workflows wait).

Recommend talking through the open questions in §6 in one pass before
starting Phase 1.

---

*Plan version 0.1 — initial action-layer implementation scoping. Not
committed; phases will resize as open questions resolve. References:
`docs/specs/re-write-able-actions-spec-v0.7.md` + v0.4 / v0.6 / v0.6.1
antecedents + v0.7 working-method companions (all under
`docs/specs/`); audit context at `docs/runtime-product-agnosticism-audit.md`
(R7 graded MEDIUM-HIGH cost, HIGH return on product type 4 — see
2026-05-18 addendum).*
