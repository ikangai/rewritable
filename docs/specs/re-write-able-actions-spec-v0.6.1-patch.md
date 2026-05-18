# re-write-able: actions, skills, and workflows — v0.6.1 patch

*A focused revision of v0.6 addressing the issues identified in the v0.6 review. Five localized changes; no architectural shifts. The next substantive revision is v0.7, which lands the §11.9 + §11.10 + §11.12 cluster.*

This document records the changes; apply them in place against v0.6.

---

## 1. §11.12 — Worker pool reset semantics

**Problem.** v0.6 claimed pooled Workers are "reset to the skill's load state between invocations." That promises something JavaScript doesn't natively support — once skill code has run, module-level closures, timers, subscription handles, and reference graphs may persist in ways the runtime cannot fully unwind short of terminating and respawning the Worker, which defeats pooling.

**Resolution.** Drop the reset claim. Module-level state persists across pooled invocations within a session. Skills needing fresh state per invocation either initialize inside their handler (the normal pattern) or opt out of pooling via a manifest flag.

**§2.1** gains an optional manifest field:

- A **pool opt-out flag** — `pool: false` declares that the skill should not be pooled across invocations. The runtime terminates the Worker after each invocation and spawns a fresh one for the next. Default is `pool: true` (the runtime may pool). Skills that hold expensive setup state typically leave the default; skills with strict per-invocation isolation needs opt out.

**§11.12 Worker instance semantics is rewritten as:**

Each skill *instance* runs in its own dedicated Web Worker. "Dedicated" distinguishes from Service Worker (which is shared across pages) and means each running invocation has a Worker scoped to that invocation. The runtime is permitted to **pool and reuse** Workers across invocations of the same skill within the same container session, provided two conditions hold:

1. **Identity-at-boundary** is preserved: a pooled Worker is reused only for the same skill that originally loaded it, and messages from that Worker continue to authenticate as coming from that one skill.
2. **The skill's manifest does not declare `pool: false`**. Skills declaring `pool: false` get a fresh Worker per invocation; the runtime terminates the prior Worker between invocations.

The runtime does **not** attempt to reset a pooled Worker's module-level state between invocations. Module-level closures, timers, and other long-lived state persist across pooled invocations within a session. Skills that need fresh state per invocation either initialize inside their handler (the normal pattern, recommended) or opt out of pooling. The previous v0.6 phrase "reset to skill-load state between invocations" overpromised what the runtime can actually deliver and is removed.

**v0.7 open question** (added to the §11.12 list): full Worker instance lifecycle, including the exact contract for `pool: false` Workers (termination timing, whether a Worker can finish in-flight async work before termination), and the bounds in "§11.12 Worker pool lifetime" below.

---

## 2. §11.12 — Worker pool lifetime

**Problem.** v0.6 didn't bound how long pooled Workers stay alive. Without an outer bound, a runtime can hold skill state in memory indefinitely beyond the user's expectation.

**Resolution.** v0.6.1 adds:

**Worker pool lifetime.** Pooled Workers must be released no later than tab close. The runtime should release pooled Workers earlier under memory pressure (the platform's `pressure` signals where available) or after an idle timeout (current direction: 5 minutes idle, tunable). The exact idle timeout is an implementation detail, but the bound is not — pooled Workers must not be retained across sessions, and indefinite in-session retention is not permitted. Skills that need long-lived state across periods longer than a single session should use `runtime.workflow.state` (per-container, persists across sessions) rather than relying on pooled-Worker module state.

---

## 3. §5.5 / §8.2 — Composition audit cross-reference

**Problem.** A workflow running a sub-workflow as one of its nodes raises the question of whose `RunResult.tokens_used` counts whose tokens. §8.2 makes caps per-container, which answers the cap question, but doesn't address how the parent observes sub-workflow results.

**Resolution.** Add one sentence to §5.5, after the `RunResult` shape:

When a workflow runs a sub-workflow as one of its nodes, the parent's `RunResult.tokens_used` counts only the parent's own LLM calls — sub-workflow tokens are not aggregated. Each sub-workflow has its own `RunResult` accessible within its container, and the parent observes whatever the sub-workflow chooses to publish through the sub-bus (§8.2). Composition-aware audit is by reference, not aggregation; workflows that need composition-wide observation coordinate via the bus the same way they coordinate composition-wide budgets (§8.2).

---

## 4. §5.4 — In-edit timeout language

**Problem.** v0.6's "any user input that had been accepted into the lens before the timeout is preserved as an unsubmitted draft" was ambiguous between typed-but-not-yet-submitted text (literal lens contents) and the submitted prompt that became the timed-out batch.

**Resolution.** Replace the sentence with:

When the in-edit timeout fires, the submitted prompt that became the timed-out batch is preserved as an unsubmitted draft in the lens, ready for retry. The user can retry the prompt, edit it, or discard it. Autonomous runs never wait indefinitely on a non-responsive LLM call.

---

## 5. §11.12 — Forced-Worker × tested_modes interaction (added to v0.7 list)

**Problem.** §11.12's v0.7 open list includes "whether some permission combinations trigger a Worker-mode requirement regardless of import status." If v0.7 lands this, the install dialog will sometimes encounter skills whose author declared `execution: 'default'` and whose `tested_modes` is `['default']` only, but where the permission combination forces Worker mode.

**Resolution.** Note in the v0.7 open list, threading it into the §4.1 mode-mismatch rule rather than inventing a new path:

When a permission combination forces Worker mode but the skill is declared and tested only for default mode, the install is rejected per §4.1's mode-mismatch rule. The runtime surfaces the gap explicitly: the user sees that the permission combination requires Worker mode, that the skill's author declared and tested default mode only, and the options available (edit the manifest to declare `execution: 'worker'` and accept the untested-in-Worker risk, drop the permission that forced Worker mode, or decline to install). The forced-Worker policy is initiated from the permission side rather than the manifest side, but the resolution mechanism is the same: never silently downgrade, never silently force-upgrade, always surface the mismatch and require explicit user action.

---

## v0.7 framing — the cluster as install-flow UX

A framing note worth carrying into v0.7, surfaced by the v0.6 review:

The v0.7 cluster (§11.9 skill share format + §11.10 permission pattern syntax + §11.12 full Worker-mode design) is technically about three architectural open seams. But it is also implicitly the design pass for **what the install flow feels like as a user experience**. Provenance metadata (§11.9), Worker-mode pre-selection (§11.12), and permission patterns the user can actually read (§11.10) together determine whether the install dialog is a wall of technical text users click through or a meaningful security checkpoint.

The trust anchor (invariant 10) is install-time review. That anchor only works if first-time users encountering an imported skill can make a real decision. v0.7 should specify the cluster such that the output is testable as: "open `.rwa-skill.json` from your downloads folder, see this exact dialog, with this exact information visible at this exact place, and make a real decision about whether to install." If the architecture interlocks correctly but the dialog is unreadable, the cluster isn't done.

This isn't a new commitment in v0.6.1; it's a framing note carried forward to v0.7. The architectural pieces have to interlock — and the user experience is what proves they did.

---

*Patch v0.6.1 — drops the unimplementable "reset to skill-load state" claim from §11.12 and adds the `pool: false` opt-out (§2.1); bounds Worker pool lifetime to within-session (§11.12); cross-references composition audit between §5.5 and §8.2; disambiguates §5.4's in-edit timeout language; threads forced-Worker × `tested_modes` into v0.7's §4.1-consistent reject path. Carries an install-flow-UX framing note into v0.7's three-item cluster. No invariant changes; the architectural commitments from v0.6 are unchanged.*
