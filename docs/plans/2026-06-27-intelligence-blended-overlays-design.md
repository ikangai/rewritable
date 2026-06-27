# intelligence/0.2 I-E — blended / multiple active overlays (design)

Date: 2026-06-27. Status: **design approved, not yet implemented.** Owning spec: `docs/specs/rwa-intelligence-spec.md` §6 (I-E). This turns the §6 "blended overlays" forward stub into a buildable design.

## Problem

Today exactly **one** intelligence role is active: `activeAgentRole` is a single string that drives the `modify()` framing, the actor (`agents:<role>`), and the vault scope. You cannot stack two — e.g. a `concise-editor` *and* a `legal-tone` role so ⌘K edits are both concise *and* legally-toned. The §6 stub flagged the blocker: combining two `system_prompt` framings needs a precedence/merge model so one role doesn't silently swamp the other or produce incoherent instructions.

## Decision — merge model B: primary + advisory

Three models were considered:

- **A — ordered prompt composition** (one call; roles concatenated with an "earlier wins" rule).
- **B — primary + advisory secondaries** (one role drives; others are weaker hints). ← **chosen**
- **C — sequential pipeline** (apply each role's edit pass in turn; 2×+ model calls; big change to the modify loop).

**B** was chosen because it resolves the hardest sub-problems for free: clean, unambiguous precedence (the primary always dominates), no prompt-merge magic, and — decisively — **advisors never carry capabilities**, so stacking a role can never widen vault access (the escalation risk A and C both raise). The blend is lighter than A/C, which is an accepted trade for safety and simplicity.

## The model

Additive and minimal-risk: keep today's single `activeAgentRole` as the **primary**, byte-unchanged in behaviour. Add one new piece of **in-memory, ephemeral** session state, `advisorRoles` (a small Set of role names). Advisors contribute *only* advisory prose to the prompt.

- **Vault = primary-only.** The `invokeSkill` vault gate stays bound to the primary's `vault_namespace_set`. Advisors are prompt hints, not capability-bearing — no union, no escalation. *(This is the security win B buys.)*
- **Advisors must be verified.** An advisor's `system_prompt` influences the agent, so it is held to the same trust bar as the primary: only verified/signed roles can be added; an unverified role is rejected (mirrors `unverified_agent` for activation).
- **Ephemeral, like the active role.** `advisorRoles` lives in memory only — never serialized into the file snapshot (the active/session state is not in the bytes; open a fresh file → no advisors).
- **Bounded.** Cap of **3** advisors, to keep the assembled prompt coherent and its size sane.
- **I-A unchanged.** Only the *primary's* recommended model is offered on activation; advisors never touch the model.

## Prompt assembly (load-bearing)

The base framing is unchanged: the primary's `system_prompt` (or the per-kind default if no primary), wrapping the shared `SYSTEM_PROMPT_RULES`. After the base framing, one clearly-subordinate block is inserted:

```
Additional advisory lenses (secondary — apply only where they don't conflict with the above):
- <advisor role>: <advisor system_prompt>
```

Safe by construction: advisor `system_prompt`s are verified installed agents whose prompts already passed the install-time `agentPromptInjectionRisk` guard (no backtick / `${` / `<DOC>`), so injecting them into the template is exactly as safe as injecting the primary's. The block is omitted entirely when `advisorRoles` is empty (the single-role path is byte-identical to today).

**Base framing when there is no primary.** Advisors layer on top of whatever the base framing is — the primary if set, otherwise the per-kind default prompt. So advisors are useful even with no primary (vault is then none, as today). The UI still presents "primary" as the lead concept.

## API + UI

`runtime.agents` gains `addAdvisor(role)` / `removeAdvisor(role)` / `advisors()`. `setActive` / `activate` stay the primary path, unchanged.

The Activity-panel *Intelligences* rows reflect state per role:
- **Primary** (the active role) — badge + *Deactivate*.
- **Advisor** — badge + *Remove advisor*.
- **Neither** — *Activate* (make primary) + *Add advisor*.

A role is primary **xor** advisor **xor** neither — never double-counted (adding the primary as an advisor is a no-op; activating an advisor promotes it to primary and drops it from `advisorRoles`). At the cap (3 advisors), *Add advisor* is disabled with a note. Only verified roles show the advisor control.

## Attribution + history

Actor stays `agents:<primary>` (clean, unchanged — the primary drives the edit). The advisor set is recorded in the commit's `lensMeta` for audit (e.g. `advisors: ['legal-tone']`), not folded into the actor string (keeps actor parsing stable).

## Edge cases

- Deactivating the primary (`setActive(null)`) leaves advisors in place; they then layer on the per-kind default framing.
- Uninstalling a role drops it from `advisorRoles` too (no dangling advisor).
- A mode switch / view activation does not change advisors (they are orthogonal session state).

## Testing (`tests/intelligence-blend.mjs`, jsdom)

- `addAdvisor`/`removeAdvisor` manage the set; the **4th add is rejected** (cap 3).
- An **unverified** role cannot be added as an advisor.
- The assembled `modify()` system prompt contains the advisor block, **labeled secondary**, with the shared RULES intact; empty advisor set → byte-identical single-role prompt.
- **Security:** an advisor declaring `vault_namespace_set` does **not** widen the vault gate — access stays the primary's set (or none).
- Actor is `agents:<primary>`; advisors appear in `lensMeta`, not the actor.
- A role is never simultaneously primary and advisor.
- Ephemeral: `advisorRoles` is not present in the rebuilt file bytes.
- Panel: badges + Add/Remove controls + cap-disable; browser-verify the UX.

## Scope

Seed-only (runtime session state + `modify()` prompt assembly + the Activity panel). No CLI/service mirror. Regenerate references after the seed change. Browser-verify the panel.

## What this does NOT do

- No multi-primary, no prompt *merging* (A/C explicitly rejected) — exactly one primary, advisors are subordinate prose.
- Advisors are session-only and never persisted (matching the active-role invariant).
- Does not address the other §6 items: I-B (cross-machine config — recommended *against* on key-leak grounds), I-C (first-class `intelligence` kind), I-D (kind-gated affinity).

## Implementation seams (for the build)

- `activeAgentRole` + a new `advisorRoles` Set near the agent state (`installedAgents`).
- The `modify()` role-framing injection site (the v0.9 I12 seam that swaps the active role's framing) — append the advisory block there.
- `runtimeSetActiveAgent` / the agents API object (`runtime.agents`) — add advisor methods.
- `renderActionsModePanel` *Intelligences* section — primary/advisor controls.
- `runtimeUninstallAgent` — also drop from `advisorRoles`.
