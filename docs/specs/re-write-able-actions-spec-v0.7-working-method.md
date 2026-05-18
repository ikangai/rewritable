# re-write-able: actions, skills, and workflows — v0.7 working-method preamble

*A short note on how v0.7 should be designed, before the cluster work begins. Not a spec revision; a design-method document to set the working pattern for the §11.9 + §11.10 + §11.12 cluster.*

---

## What changes about the working method

The previous six revisions worked as architecture-then-refinement. Each pass specified a structural commitment (vault namespacing, by-trigger persistence, install-as-trust-anchor, defense-in-depth proxies, Worker-mode as opt-in, trust-mechanism collapse) and the next review surfaced what the prose was overpromising relative to what the architecture could deliver. Refinement was iterative against the architecture's own constraints — invariants, single-file rule, ownership model.

v0.7 has those same architectural constraints. It also has a binding downstream consumer that has its own constraints: the install dialog, and a real person making a real decision about an imported skill in finite cognitive bandwidth. The trust anchor (invariant 10) is install-time review; that anchor only works if first-time users can actually read what they're approving.

This means the install dialog is not downstream of the v0.7 cluster — it is a co-constraint *on* the cluster. The three sections (§11.9 skill share format, §11.10 permission pattern syntax, §11.12 full Worker-mode design) each have degrees of freedom that the UX bar narrows:

- If **§11.10's permission patterns** allow full regex or complex glob, the dialog cannot summarize "what this skill can reach" in language the user can evaluate. The UX bar argues for a constrained pattern language even at the cost of expressiveness.
- If **§11.9's provenance metadata** is technically robust but surfaces as `signed by cn=author@example.com`, that's not meaningful to a non-technical recipient. The UX bar pushes toward provenance signals that compose into a sentence the user can act on — *"you have installed three skills from this same source before, all of which you kept"* — rather than identifiers the user has no basis to evaluate.
- If **§11.12's Worker-mode disclosure** surfaces eight independent toggles, the user gives up and clicks through. The UX bar pushes toward a small number of high-leverage choices with clear defaults.

The architecture serves the dialog. Treating UX as a downstream consumer would give it veto power but no design influence; treating it as a co-equal driver lets it shape the architectural choices early, while they're still cheap to change.

## The working pattern for v0.7

**Draft the dialog first.** Write the text a user will see when opening an imported `.rwa-skill.json` from their downloads folder. Not pseudocode; the actual sentences, layout, and decision points. Aim for the dialog to fit on one screen with no scrolling, and for every piece of information present to be either (a) something the user can act on or (b) something a knowledgeable reviewer would check before approving.

**Identify which architectural choice each sentence depends on.** If the dialog says "this skill will reach `api.wordpress.com` only," that's §11.10 saying "network patterns are exact hostnames or anchored wildcards, no regex." If the dialog says "this skill was published by Source X, from whom you have installed N skills previously," that's §11.9 saying provenance is a stable identifier the runtime can count installs against, not a free-form signature label. If the dialog says "this skill will run in Worker mode" or "we recommend Worker mode here," that's §11.12 saying the mode choice is one selectable item with a sensible default, not a panel of toggles.

**Design the architectural choice to make the sentence true and short.** This is the inversion of the previous six passes. Previously: architecture commits, prose follows. Now: prose commits, architecture follows. The unit of correctness is the dialog-plus-architecture pair, not either one in isolation.

**Verify by reading the dialog back.** If the dialog requires the user to understand more than three concepts to make a decision, the architecture is too expressive somewhere. If the dialog has language that only makes sense to someone who has read the spec, the architecture has leaked technical surface. If the dialog defaults are wrong on first read, the architecture's defaults are wrong.

**Iterate.** Draft → identify → design → re-read → redraft. Expect at least one full cycle where the dialog forces an architectural change that wasn't visible from the architecture side alone.

## Success criterion for v0.7

The output is testable as:

> Open `.rwa-skill.json` from your downloads folder. See this exact dialog, with this exact information visible at this exact place. Make a real decision about whether to install.

If the architecture interlocks correctly but the dialog is unreadable, the cluster is not done. If the dialog is readable but the architecture under it doesn't deliver what the dialog promises, the cluster is also not done. The two have to land together.

## What this is not

This is not a new constraint that displaces the existing architectural ones. The invariants from v0.6 still hold. The single-file rule still holds. The trust-anchor commitment (invariant 10) still holds. What's changing is the *method* by which v0.7's three open seams are filled — not the architecture they're filling.

This is also not a UX spec. The dialog draft is a *design tool* for the architectural work, not a UI specification. The actual install dialog as built will likely look different from the draft used during design; what survives is the architectural commitments the draft surfaced.

## Concrete v0.7 work items inherited from v0.6.1

Beyond the three cluster sections, v0.7 also lands:

1. **§11.12 Worker pool full lifecycle.** Including the `pool: false` termination contract — the runtime waits for the invocation's returned Promise to resolve, then sends a `shutdown` message to which the Worker must ack within a short timeout (current direction: 1–2s) before termination. Skills wanting fire-and-forget background work that outlives the main result either don't use `pool: false`, or surface the background work as part of the returned Promise. The distinction between "background work" and "invocation isn't done yet" becomes the skill author's explicit choice.

2. **§11.12 idle-timeout commitment.** Pool lifetime is bounded by session close (v0.6.1), but the in-session idle timeout needs a concrete default for the spec. Current direction: 5 minutes idle, runtime may tune down under platform pressure signals (Compute Pressure API where available; idle alone where not). The upper bound is the commitment; the tuning is implementation.

3. **§5.4 lens lock cross-reference.** The in-edit timeout disambiguation in v0.6.1 assumes the v0.10 lens spec locks the lens while a `rwa-edit/1` or `rwa-graph/1` batch is in flight. v0.7 adds an explicit cross-reference so the user-input-across-timeout behavior in §5.4 doesn't depend on an implicit assumption.

4. **§4.1 / §11.12 dialog pool-behavior disclosure.** The install dialog should surface pool behavior at the right level — neither hidden nor technical. Current direction: a one-sentence summary like "this skill keeps state between invocations within a session; the author has marked this as appropriate" (for `pool: true` skills) or "this skill is reset between invocations" (for `pool: false`). The dialog draft for v0.7 picks the right level.

These four items are localized enough that they could land in a patch on their own, but they interact closely with the cluster work — the pool-behavior disclosure is a piece of the install dialog the cluster is designing — so v0.7 picks them up together.

## What stays carry-over to v0.8 and beyond

- **§11.1** common skill set contents — needs the cluster work to land first (the skills the format ships with need to fit through the dialog the cluster designs).
- **§11.7** local-LLM config surface — independent of the cluster; ready to design on its own once v0.7 ships.
- **§11.8** Argon2id parameter pinning — wants a separate review pass against a current threat model; not blocked by anything in v0.7.

## The trajectory observation

The previous six revisions produced a spec that gets shorter per feature as it gets more precise. v0.7's working method may break that pattern locally — UX-driven architecture is harder to verify incrementally, and the cluster will likely produce a longer §11.9 + §11.10 + §11.12 in absolute terms than the rest of the spec's density would predict, because the cluster is doing three things that interlock plus their interaction with a fourth surface (the dialog) all at once.

This is acceptable. The condensation pattern from the previous passes happened because each pass was refining one architectural commitment at a time. v0.7 is refining three architectural commitments and a UX surface in coordinated fashion. The longer cluster section is the price of doing the cluster correctly; the alternative is a shorter v0.7 that produces an unreadable dialog, which would be the more expensive outcome.

---

*Working-method preamble for v0.7 — captures the structural shift from architecture-then-UX to UX-as-co-driver for the §11.9 + §11.10 + §11.12 cluster. Records four concrete carry-over items from v0.6.1 (pool full lifecycle, idle timeout default, lens lock cross-reference, dialog pool disclosure) that land in v0.7 alongside the cluster. No architectural changes; the invariants and commitments from v0.6 are unchanged.*
