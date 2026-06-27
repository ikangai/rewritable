# re-write-able intelligence — `intelligence/0.2` (grounded on the built substrate)

*A droppable, swappable model-plus-editing-behavior for a re-writeable file. Re-grounded on what the repo actually ships: core container spec **v0.15**, the **rwa-edit/1** modify protocol, the **actions/skill layer v0.8 + v0.9** (built, browser-proven, shipped), and **`self-description/1`**. This supersedes `intelligence/0.1`, which was grounded on a non-existent "spec v0.2," rode a localStorage embed bus that was removed in core v0.7, and quarantined as "forward design" a stack of mechanisms — signed roles, install consent, a per-kind prompt registry, `describe()` binding, validation — that are in fact already built. The thesis flips: the overlay half of an intelligence is **not waiting on substrate; it is the v0.9 `rwa-agent/1` role.** Packaging follows the **hybrid**: an intelligence is a small rewritable that *carries* the signed role and renders a card describing itself — both an openable file and the exact install payload (§1–§2). What is genuinely forward is much smaller, and named in §6.*

---

## 0. The boundary this moves (still almost none — but for a sharper reason)

A re-writeable file rewrites itself through **rwa-edit/1**: the runtime reads the document from its per-container IndexedDB, drives a multi-turn tool-use conversation (`apply_dsl_plan` / `apply_edits` / `replace_document`) against an agent, validates the result, and commits atomically. The agent is reached through one of **six backends** (`openrouter` / `ollama` / `lmstudio` / `atomic` / `bridge` / `bridge-session`), several of which are keyless-local. The agent **never sees the bootstrap** — only the document body (the LF-canonical text inside `#rwa-doc-mount`).

Two things an intelligence might want to carry are on **opposite sides of a hard line**:

- **The model + key + backend** are `sessionStorage`-only (`rwa_apikey`, `rwa_backend`, `rwa_model`; seed `~:437`). They are **never serialized into the file** — not the key, not even the model name. This is an invariant, not an accident: the bootstrap is byte-identical across commits and the inline snapshot is the only durable artifact, so a stored credential would leak on every share. So an intelligence **cannot carry the model in the file**. It can only *recommend* one.
- **The modify-prompt overlay** is already an in-file, signed, runtime-owned object: a **`rwa-agent/1` role** living in the frozen `#rwa-agents` zone (§2). It travels with the document on export, by construction.

`intelligence/0.1` got this backwards in both directions: it claimed "the model name is the only part baked in" (it is not baked in at all) and built the overlay's transport on a bus that no longer exists. The corrected boundary is: **the overlay is portable and built; the model is, by design, a per-machine recommendation.** That split is the whole spec.

---

## 1. What a dropped intelligence is

An intelligence is **(a recommended model + a modify-prompt overlay)**. On the built substrate this resolves to:

- **Overlay** = a signed `rwa-agent/1` record: `{ role, system_prompt, vault_namespace_set }`, **no code** (seed `~:7028`). This is the droppable, swappable, in-file half.
- **Model recommendation** = a non-secret hint the runtime can *offer to apply* to `sessionStorage`, but never stores in the file as a credential (§6, I-A).

**Packaged as a rwa (the carrier).** The shareable artifact is itself a small rewritable — a `skill-host` container whose own frozen `#rwa-agents` zone holds the signed record, and whose document body renders a *self-describing card*: the recommended model/backend, the ≤200-char prompt preview, the author-key fingerprint, and a human-readable affinity note. So an intelligence is a file you can open, read, render, and `describe()` on its own — not an opaque blob — and it carries the **exact** signed record that will be installed. "Dropping" it (§2) means the *target* extracts that record, verifies it, and installs it into the target's own `#rwa-agents` zone; the carrier and the install payload are the same signed bytes. The carrier reuses the built `skill-host` kind (which already owns the `#rwa-agents` zone, the install dialog, and `describe()` surfacing); a dedicated `intelligence` kind is a packaging refinement, not a requirement (§6, I-C).

When a role is active, `modify()` swaps the **role framing** into the system prompt while keeping the shared rule block; deactivate it and ⌘K reverts. Concretely:

- **Default.** `SYSTEM_PROMPT = SYSTEM_PROMPTS[PRODUCT_KIND] || SYSTEM_PROMPTS.document` (seed `~:2553`). The per-kind framing wraps the shared `SYSTEM_PROMPT_RULES` (tool rules, frozen-zone rules, `data-rwa-id` guidance) — one source of truth across kinds.
- **Active intelligence.** `runtime.agents.setActive(role)` makes that role's `system_prompt` the active framing; `getActiveActor()` returns `'agents:' + role` (seed `~:5586`), so every edit it drives is attributed in `rwa_hist` under that actor; `invokeSkill(…, {agentRole})` narrows vault access to the role's `vault_namespace_set`.
- **Removed.** `uninstall` / `setActive(null)` returns ⌘K to the per-kind default. **No agent is active by default** — a freshly opened file is its own kind's baseline, not a kind-less floor.

This is the corrected "two real states." A key-bearing (or keyless-local) session can modify, through whatever role is active; a session with no reachable backend renders and runs the file but can't ⌘K. There is no third hidden state, and the only thing a removed intelligence reverts *to* is the kind's default prompt — which **is** kind-aware, because the per-kind registry is built (contra `intelligence/0.1` §1).

---

## 2. Dropping a carrier rwa — on the install/marketplace path that already exists, not a localStorage bus

`intelligence/0.1` "rode the embed bus" of core §5.5/§5.6 — but that null-origin localStorage bus was **removed in core v0.7** ("the runtime is no longer in localStorage"; isolation is per-container IDB plus the opt-in `runtime.shared.*` surface). The hybrid carrier (§1) does not need it. An intelligence is a single file you hand to a target, and the actions layer already ships everything the drop routes to:

- **Drop = extract + verify + install, behind consent.** The carrier rwa holds its signed record in its frozen `#rwa-agents` zone; dropping it onto a target makes the target read those bytes, verify the signature, and route them to `runtime.agents.install` / `runtime.agents.showInstallDialog` — the dedicated agent-record dialog (role, author key, vault namespaces, ≤200-char prompt preview), which offers install only for a **verified, gate-passing** record. The install dialog is the trust anchor: the human consents to what the role can do. *(The literal file-drop-to-extract gesture is now built — `handleCarrierDrop` claims a dropped carrier in the capture phase, extracts its record, and routes to the dialog; §5, pinned by `tests/intelligence-drop.mjs`.)*
- **Or discover it.** The signed-skill **marketplace index** (`runtime.discoverSkills` → `runtime.fetchSkillFromIndex` → client-side WebCrypto verify → install) carries the same signed records; an intelligence catalog is just carriers (or their bare records) published to it. TOFU author identity (`_skFingerprint`) tells you "first time seeing this author" vs. "trusted, N installs."

Two properties the `0.1` draft wanted now hold for **real, enforced** reasons — and the hybrid makes "travels in the file" true on *both* sides:

- **Copy, not link — and re-consented on change.** Install writes a **snapshot** of the record into the target's frozen `#rwa-agents` zone. Editing the carrier later does not reach back, and a *new* version cannot install silently: the update path re-runs the install dialog with an added/removed diff and a re-affirmation step (I10). Copy-not-link is structural; the update window is guarded.
- **Travels in the file — carrier and target both.** `#rwa-agents` is a frozen zone *inside the document* (`data-rwa-frozen`), so ⌘S's `buildFile` serializes it with `INLINE_DOC` like any other content. The **carrier** ships its record as one self-contained `.html`; the **target**, post-install, carries its installed copy the same way. No separate channel, no re-fetch, single-file invariant intact on both.

The runtime-block "preserve the registry" worry of `0.1` §3 is answered here mechanically: the frozen `#rwa-skills` / `#rwa-agents` zones are written **only** by `runtimeRegionCommit` (seed `~:7707`, `~:7771` `buildAgentZone`), under `reachability:'frozen'`. The agent's `apply_edits` / `replace_document` never pass the bypass flag, so an active intelligence **cannot rewrite the registry that defines it.**

---

## 3. The guardrails are hard, layered, and enforced — not one soft clause

`intelligence/0.1` named a single soft guardrail: "preserve `<script id="re-write-able-runtime">`", trusted not verified. That block **does not exist** (it was removed; the seed has `0×` of it) and the protection it imagined is replaced by a stack that the built runtime already enforces on every modify, regardless of which overlay is active:

1. **The agent never sees the bootstrap.** It receives only the document body. An overlay cannot reach the runtime, the loader, or `DOC_UUID`, because none of them are in the agent's context window. (Core v0.15 §5; the inline snapshot is the anchor.)
2. **Frozen zones are byte-validated.** Both marker-form (`<!-- rwa:frozen:begin … -->`) and attribute-form (`data-rwa-frozen`) zones are preserved by the rwa-edit/1 validator; an envelope that would touch one is rejected (`frozen_zone_violation`) before commit. The `#rwa-agents` / `#rwa-skills` registries are such zones.
3. **The overlay swaps framing, not rules.** A role contributes `system_prompt` *framing*; the shared `SYSTEM_PROMPT_RULES` (tool contract, frozen-zone rules, `data-rwa-id` discipline) ride in front of it and are not author-editable through the role. "Amend, not repeal" is **by construction**, not by trust.
4. **rwa-edit/1 validation is unconditional.** Structural-shape preservation, reserved-marker rejection, `data-rwa-id` preservation, size caps, retry budget 3, no silent escalation — all apply no matter which intelligence is active. (`data-rwa-id` exists and is central — `40×` in the seed — contra `0.1` §3.)
5. **Signed + verified + consented.** A tampered/unverified role installs `verified:false` and **cannot activate** (`unverified_agent`); activation and updates pass through the consent dialog.
6. **Capability narrowing.** An active role gates vault access to its declared `vault_namespace_set` — the role can only *narrow* what a skill it drives may reach, never widen it.

The honest residual softness is small and worth stating: the system prompt is still the place persona/tone/edit-preference live, and a sufficiently adversarial `system_prompt` can *bias* the agent's behavior within the rules — it just cannot escape (1)–(6). The ceiling is real and enforced; it is the rwa-edit/1 + frozen-zone + signing stack, not a single trusted line.

---

## 4. Affinity is part label, part real scope

There is now a real type system to bind to, so affinity is no longer "just a note that gates nothing":

- **Soft (label).** Which *document kind* an intelligence is tuned for (`document` / `presentation` / `workflow` / `skill-host` / …) is still a human-read hint today — nothing kind-gates which role you may activate. A catalog note, as `0.1` described, remains the right surface for that.
- **Hard (scope).** The role's `vault_namespace_set` genuinely gates: an active intelligence narrows vault reach to its declared namespaces. And the whole object is **legible by construction** — `parseAgentZone` surfaces an installed role through `self-description/1` as an affordance `{ agentId, kind:'agent', name:role, verified, provenance:'installed' }`, emitted live by `runtime.describe()` and statically by `rwa doc --json`. The "legible-on-hover binding" `0.1` quarantined as needing the self-description contract **is built**; you can already ask a file which intelligences it carries.

---

## 5. Buildable today, in full — because most of it is already shipped

Everything the core concept needs exists:

- The **overlay** is the v0.9 `rwa-agent/1` role: signed record, frozen `#rwa-agents` zone, `runtime.agents.{list,active,setActive,install,uninstall,message,showInstallDialog}`, role-framed `modify()`, actor attribution, vault narrowing — all browser-proven and shipped.
- **Transport** is the install dialog + the signed marketplace index (discover → verify → install), with copy-not-link and update re-affirmation already enforced.
- **Travel on export** is free: the frozen zone serializes with `INLINE_DOC` on ⌘S.
- **Revert to default** is `setActive(null)` → the per-kind `SYSTEM_PROMPT`.
- **Legibility** is `describe()` / `rwa doc --json`.

So `intelligence/0.2` is **almost entirely convention over built parts**: the carrier is a `skill-host` rwa (a kind that already owns the `#rwa-agents` zone, the install dialog, and `describe()` surfacing); the overlay is the v0.9 role; transport, travel, revert, and legibility are all shipped. Two surfaces were new on top of those. **(1)** the **file-drop bridge** — extract a carrier's signed record and route it to the existing `runtime.agents.install` — is now **BUILT** (seed: `extractAgentEnvelopesFromCarrier` un-escapes `INLINE_DOC` and parses the `#rwa-agents` zone exactly as `readTrustworthyAgents` does; `classifyInstallText` / `routeInstallFromText` dispatch carrier-`.html` vs bare-JSON envelopes; a capture-phase window `drop`/`dragover` claims a dropped carrier — size-capped at 32 MB, mirroring the image-ingest cap; the install picker is generalized to accept carriers; install stays behind the consent dialog — the trust anchor, which re-verifies the signature and only offers install for a verified, gate-passing record). **(2)** the optional structured model-recommendation channel (§6, I-A) — now **also built** (a carrier can apply its recommended model on activation, behind consent). Nothing else needs building.

A worked reference carrier — [`examples/intelligence-carrier/concise-editor.html`](../../examples/intelligence-carrier/concise-editor.html) — demonstrates this end-to-end: a real `skill-host` rwa carrying one genuinely-signed `concise-editor` role in its frozen `#rwa-agents` zone plus the self-describing card. It is verified (signature + `validateAgentInstall` + `parseAgentZone`) and **booted** (the runtime lists the role `verified:true`, `describe()` surfaces it as a `kind:'agent'` affordance, and it activates). It anchors this spec the way `hello.html` anchors the core spec. The file-drop gesture that consumes it is built too: `tests/intelligence-drop.mjs` (13/13) drops this exact carrier onto a target and installs the role through the consent dialog.

---

## 6. Forward design — quarantined, each blocked on its actual substrate

Far shorter than `0.1`'s §6, because most of that list shipped. **I-A and I-E are now built too**; what remains is I-B…I-D.

- **I-A — Structured model recommendation. BUILT.** A non-secret `recommended_model` / `recommended_backend` rides on the `rwa-agent/1` **envelope** — *outside* the signed `agent`, so `canonicalAgent` is unchanged and the signature still verifies (this stays seed-only, and a carrier can add the field **without re-signing**). On activation — `runtime.agents.activate(role)`, or the Activity panel's *Intelligences → Activate* — the runtime **offers** to apply it to `sessionStorage` behind a one-line consent: never auto-applied, only `rwa_model` / `rwa_backend` (backend enum-validated), **never** a base-URL override or the API key. So the invariant holds — the file stores no credential, a recommendation is a suggestion. Seed: `getRecommendation` / `applyRecommendation` / `offerRecommendedModel` / `runtimeActivateAgent`; pinned by `tests/intelligence-model-rec.mjs` (22/0); the carrier example carries one. *Deviation from the original sketch:* the field is on the envelope (unsigned), not inside the signed canon — a deliberate choice so adding it never breaks a deployed signature; consent + non-secret + enum-validation make an unsigned recommendation safe.
- **I-B — Cross-machine model/backend portability.** Carrying *working* backend config (base-URL overrides, a chosen local model) that survives export and re-hydrates on another machine. *Blocked on:* the same sessionStorage-only invariant — would require a non-secret, explicitly-consented config channel distinct from the credential path. Design, not just plumbing.
- **I-C — Intelligence as a first-class kind/wire-type.** Whether to keep reusing `rwa-agent/1` or mint an `intelligence/1` artifact type with its own install dialog copy and catalog facets. *Blocked on:* a product decision, not a substrate gap. Reusing `rwa-agent/1` is the cheaper, shipped path; a distinct type buys clearer UX at the cost of a second registry.
- **I-D — Kind-gated affinity.** Letting a document kind *require/refuse* certain intelligences (e.g. a `workflow` won't activate a prose-tuned role). *Blocked on:* a policy layer over the kind table + self-description; affinity is a soft note until then (§4).
- **I-E — Blended / multiple active overlays. BUILT** (merge model **B: primary + advisory**, per `docs/plans/2026-06-27-intelligence-blended-overlays-design.md`). The single `activeAgentRole` stays the **primary** (framing / actor / vault, unchanged); a new in-memory `advisorRoles` set (verified-only, capped at 3, ephemeral) contributes advisory **prose** to `resolveSystemPrompt()` as a clearly-subordinate block. **Vault stays primary-only by construction** — the vault gate (`_agVaultAllowed`) reads the active record, never advisors, so stacking a role can't widen capabilities (the reason A/C were rejected). Empty advisor set → the single-role prompt is byte-identical. Seed: `runtimeAddAdvisor`/`runtimeRemoveAdvisor`/`runtimeListAdvisors` + `runtime.agents.{addAdvisor,removeAdvisor,advisors}` + `_agAdvisorBlock` + the Activity-panel *Intelligences* advisor controls; actor stays `agents:<primary>`. Pinned by `tests/intelligence-blend.mjs` (19/0). *Deferred nicety:* recording the advisor set in the commit `lensMeta` for audit.

The discipline holds, just against the real baseline: an item leaves this section when the spec section it cites can be opened in the built repo. Most of `0.1`'s §6 already qualified — and has been deleted from it.

---

## Close

The buildable core, corrected: an intelligence is a **small rewritable that carries a signed `rwa-agent/1` role** — a self-describing carrier file you can open and read, whose modify-prompt overlay installs behind consent, lives in the frozen `#rwa-agents` zone, travels on export, is copy-not-link with re-affirmed updates, narrows the vault to its namespaces, is legible through `describe()`, and reverts to the per-kind default when deactivated — **paired with a model that the file may recommend but never carries**, because the key and model are `sessionStorage`-only by invariant. The guardrails are the enforced rwa-edit/1 + frozen-zone + signing stack, not a single trusted clause. The file-drop bridge that consumes a carrier — the one buildable-today surface §5 named — is **built and pinned** (`tests/intelligence-drop.mjs`, 13/13). The forward work is no longer "wait for the substrate" — the substrate is poured, and both I-A (recommend-a-model-on-activation) and I-E (blended overlays — primary + advisory) are now built too. What remains in §6 is the narrower set: cross-machine config portability, a possible first-class artifact type, and kind-gated affinity.

---

*`intelligence/0.2`, grounded on `re-write-able-spec` **v0.15**, **rwa-edit/1** (v1.6), the actions/skill layer **v0.8 + v0.9** (built/shipped), and **`self-description/1`**. Packaged as the **hybrid carrier**: a small `skill-host` rwa that holds the signed record in its own frozen `#rwa-agents` zone and renders a self-describing card, dropped onto a target via a thin file-drop→extract→`runtime.agents.install` bridge that is now **built** (`extractAgentEnvelopesFromCarrier`/`handleCarrierDrop` in the seed; `tests/intelligence-drop.mjs` 13/13). Buildable on the built runtime because the overlay half is the v0.9 `rwa-agent/1` role: signed record in the frozen `#rwa-agents` zone (runtime-sole-writer via `runtimeRegionCommit`), installed behind the consent dialog or the signed marketplace index, role-framed `modify()` over the shared `SYSTEM_PROMPT_RULES`, actor-attributed in `rwa_hist`, vault-narrowed by `vault_namespace_set`, legible via `runtime.describe()` / `rwa doc --json`, revertible to `SYSTEM_PROMPTS[PRODUCT_KIND]`. The model is `sessionStorage`-only (`rwa_model`/`rwa_backend`/`rwa_apikey`) and never enters the file — so an intelligence recommends a model, it does not carry one. Guardrails are hard and unconditional: agent never sees the bootstrap, frozen-zone byte-validation, framing-not-rules overlay composition, full rwa-edit/1 validation, signature + install consent, vault narrowing. I-A (structured model recommendation, applied on activation behind consent) is built too — unsigned envelope field, seed-only, `tests/intelligence-model-rec.mjs`. I-E (blended overlays — a primary role plus capped, verified, prose-only advisors; vault stays primary-only) is built — `tests/intelligence-blend.mjs`. Forward design (§6) now: cross-machine config portability, first-class artifact type, kind-gated affinity.*
