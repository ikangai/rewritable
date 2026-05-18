# re-write-able v0.7 working-method addendum — patch revision 2

*Four refinements to the addendum patch (revision 1). Shape B's "doesn't pretend to defend" constraint is converted from absence into active design work; Shape D's "partial defense" is made specific about which half; Shape E's recognizable-combinations list inherits §4.1's curation pattern; Shape B's negative-space test is pinned to a concrete check. No structural changes; cluster scope and working method are unchanged.*

This patch revises the v0.7 working-method addendum patch (revision 1).

---

## 1. Shape B — active constraint, not absent defense

**Problem.** Revision 1's Shape B treatment said "the dialog should not pretend to defend" against this attack shape, but framed the constraint as absence — *don't add defense language*. The failure path runs through implicit defense: the dialog lists declared permissions, the user reads them, infers "if the permissions are narrow, the skill is safe," and approves. That is exactly the Shape B failure path, and the dialog enabled it by surfacing permission narrowness as a positive signal. The constraint has to be active, not just absent.

**Resolution.** Replace Shape B's "the dialog should not pretend to defend against it" sentence with:

Defending the dialog against falsely-claiming-defense for Shape B is itself a piece of design work, not the absence of defense language. The failure path runs through *implicit* defense: a dialog that lists narrow permissions cleanly invites the inference "narrow permissions → safe skill," which is the exact inference Shape B exploits. The dialog must therefore actively avoid presenting permission narrowness as a safety signal. Two specific design constraints follow:

- **Permission display is not reassurance.** The dialog renders declared permissions as a factual statement of capability, not as a measure of safety. Language like "this skill only accesses your blog credentials" is wrong because it implicitly endorses the skill via the narrowness; "this skill can read and write `wordpress-personal` credentials and reach `api.wordpress.com`" is right because it states capability without endorsement.
- **The purpose-evaluation prompt appears at the decision point, not buried in the manifest disclosure.** Near the Install/Cancel buttons, the dialog asks an explicit question the user must consciously answer: *"This skill can do anything its permissions allow. Have you confirmed the skill should do what its declared purpose says?"* — or whatever language the cluster's drafting cycles arrive at. The prompt isn't a checkbox the user dismisses; it's a question whose presence at the decision point makes the user's role in the trust model legible.

Without these two constraints, "the dialog should not pretend to defend" reads as a permission to be silent — which is the cheapest way to fail the Shape B test, because silence on Shape B *combined with* visible defense against Shapes A, C, D, and E reads as implicit defense against Shape B by extension ("the dialog defended against four attack shapes, so it must defend against this one too"). The Shape B constraint has to be active to prevent that inference.

## 2. Shape D — which half of "partial"

**Problem.** Revision 1's Shape D commits to "partial defense" without saying which half is defended and which isn't. "Partial" can mean almost anything, and the cluster will need a concrete framing of what `§11.9`'s provenance design covers vs. what it doesn't.

**Resolution.** Add to Shape D, after "Cluster commits to partial defense against this shape":

The partial defense covers two specific cases:

- **Visual-lookalike attacks** the runtime can detect — Cyrillic substitutions, near-spellings, homograph attacks against known source identifiers. The provenance rendering normalizes for these and surfaces a warning when a source name resembles one the user has previously trusted.
- **First-encounter prompting** — when provenance resolves to a source the user has not installed from before, the dialog says so explicitly ("This is the first skill you have installed from this source"). The familiarity signal from point 1 of the addendum requires this — "you have installed N skills from this source before" only carries weight if N=0 is also surfaced clearly.

The partial defense does **not** cover novel-source attacks where the source has a stable, technically-correct identity the user has no prior signal about. A malicious skill from a previously-unseen source with a valid signature passes every architectural check — the dialog's job is to surface "first encounter," not to defend against the encounter being malicious. The cluster acknowledges this limit explicitly; it's the same shape of architectural limit as Shape B, scoped to the source-identity surface.

## 3. Shape E — curation lineage to §4.1

**Problem.** Revision 1's Shape E commits to "a small set of recognizable combinations" the dialog renders distinctly, but doesn't say who maintains the set. Without a maintenance model, the recognizable-combinations list is an unowned dependency.

**Resolution.** Add to Shape E, after the architectural item naming:

The recognizable-combinations list inherits the curation pattern from §4.1's capability scan: the runtime maintains it, and the list grows with attack discovery. The pattern is the same — a curated, runtime-owned list that surfaces specific high-risk shapes during install review. Specific membership of the initial list is part of v0.7's cluster work; the maintenance model is shared with §4.1 so the runtime has one curation surface rather than two.

This connects Shape E's defense mechanism to a maintenance lineage that's already in the spec, rather than introducing a new owner-of-a-list seam the cluster would have to resolve separately.

## 4. Shape B — negative-space test specificity

**Problem.** Revision 1 said Shape B's fixture exists "only to confirm [the dialog] doesn't falsely claim defense." This is a different test shape than the defended ones — a negative-space check rather than a "does it catch X" check — and the patch didn't specify what the check actually verifies. Without specificity, the negative-space test becomes squishy.

**Resolution.** Replace Shape B's "the dialog draft is tested against B only to confirm it doesn't falsely claim defense against this shape" sentence with:

The dialog draft is tested against Shape B by a negative-space check with two specific clauses:

- **No language in the dialog can be read as defending against the skill doing what its permissions allow.** Specifically: no sentence that frames declared permissions as a safety property, no rendering that surfaces narrowness as reassurance, no architectural claim about capability scope that implies behavioral constraint.
- **The purpose-evaluation prompt is present at the decision point.** Not buried in the manifest disclosure, not in a "more details" expansion, not separated from Install/Cancel by other content. The prompt is what makes the user's role in the trust model legible; if it's absent or obscured, the test fails.

Both clauses must hold for the Shape B test to pass. A dialog that does either one fails the test even if the other clause is satisfied — they're not interchangeable.

---

## What this patch does not change

- The cluster scope: §11.9 + §11.10 + §11.12 + four v0.6.1 carry-overs.
- The working method's inversion: UX as co-driver, dialog-first.
- The five attack shapes (A defended, B acknowledged outside reach with active constraint, C defended, D partial defense specified, E defended with §4.1 curation lineage).
- The success criterion: "open this file, see this dialog, make a real decision."
- The failure framing's three properties: available, readable, actionable.

---

*Revision 2 of the v0.7 working-method addendum patch — converts Shape B's "doesn't pretend to defend" from absence to active design constraint (permission display is not reassurance; purpose-evaluation prompt appears at the decision point); specifies Shape D's partial defense (visual lookalikes and first-encounter prompting defended; novel-source attacks acknowledged outside reach); connects Shape E's recognizable-combinations list to §4.1's curation pattern (shared maintenance model, runtime-owned, grows with attack discovery); pins Shape B's negative-space test to two specific clauses (no implicit defense language; purpose-evaluation prompt at decision point). No architectural changes; the cluster is now ready for v0.7 proper.*
