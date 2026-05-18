# re-write-able v0.7 working-method addendum — patch

*Two refinements to the v0.7 working-method addendum. Thread point 1 to point 6 so the merit check has a concrete first pass; expand point 3 from "at least one adversarial case" to a named set of attack shapes the cluster decides for or against. No structural changes to the method.*

This patch is applied in place against the addendum.

---

## 1. Point 1 — thread to point 6

**Problem.** Point 1's two-question merit check ("is the architecture this sentence proposes correct on the merits?" before "does it read well?") is open-ended on what "the merits" means. Without a concrete first pass, the cluster might draft a sentence whose architectural proposal sounds clean but quietly re-litigates a closed commitment — by-trigger persistence (invariant 12), defense-in-depth proxies (§2.4), or any of the other four scope-fenced items in point 6.

**Resolution.** Add to point 1, after the two-question list:

The "merits" check has a concrete first pass: **does this architectural proposal respect the scope fences in point 6?** The closed commitments (invariants 10 and 12, defense-in-depth proxies + capability scan, the vault namespace boundary, bus-as-composition-surface, skills-cannot-install-skills) are not reopened by drafting. If a proposed sentence implies an architecture that conflicts with any of them, the draft is wrong by point 6 — even if it reads beautifully. Only proposals that pass the scope fences earn the harder merit check on their own terms.

This converts the merit check from "is the architecture right?" — open-ended — into a two-step: scope-fence test first, then the open-ended merit question. Most failure modes the dialog-first method enables are scope-fence violations dressed in plausible prose; catching them at the first step is fast and keeps the second-step discussion focused on genuinely open architectural choices.

## 2. Point 3 — name the attack shapes

**Problem.** "At least one adversarial test case is mandatory; the cluster may add more" is a floor that practice will treat as a ceiling. A single fixture catches one attack shape; the dialog has to defend against multiple, and "may add more" doesn't force the cluster to consciously decide which.

**Resolution.** Replace point 3's "at least one" framing with the following list, naming five attack shapes the cluster decides for or against:

The cluster designs against a named set of attack shapes, explicitly committing for each whether the dialog defends against it or whether the shape is acknowledged as outside architectural reach:

**Shape A — permission-vs-code mismatch.** A skill declares narrow permissions but the code reaches wider. The example from the addendum: declared `vault:wordpress-personal` and `network:api.wordpress.com`, code uses dynamic property indexing to read other vault namespaces. §4.1's capability scan is the architectural mechanism; the dialog's job is to make scan results *legible*, not just present them. **Cluster commits to defending against this shape.**

**Shape B — plausible permissions, malicious within them.** A skill declares `vault:wordpress-personal + network:api.wordpress.com` and uses both as declared — but exfiltrates the credentials to the legitimately-authorized domain. Every architectural check passes; the code is doing exactly what the permissions allow. The compound semantics are the threat, and no architectural mechanism short of full data-flow analysis can detect this case. **Cluster acknowledges this shape is outside architectural reach.** The dialog should not pretend to defend against it; install-time human review of the skill's purpose (does this skill *need* to do what it does?) is the only available defense, and the dialog's job is to make that question askable, not to answer it.

**Shape C — update that quietly expands capability.** The diff-against-previous-version is already in §4.1's install dialog. The threat is an update that adds a domain to `network:`, a namespace to `vault:`, or a write scope to `bus:` — surfaced as one line in a JSON diff the user has to parse. **Cluster commits to defending against this shape.** The dialog has to surface capability expansion as legible prose ("this update lets the skill reach `<new domain>`" or "this update lets the skill write to bus topic `<topic>`"), not as a diff fragment the user must read structurally. §4.1's update-diff rendering is the specific architectural item this commitment falls on.

**Shape D — plausible-source forgery.** A §11.9 question. If provenance surfaces a source name that resembles a familiar one — a Cyrillic lookalike, a near-spelling, a different domain under the same TLD — the recipient may approve based on visual familiarity. **Cluster commits to partial defense against this shape.** The provenance design in §11.9 should resist plausible-name attacks via stable identifiers (a fingerprint-style identity rendering, or count-based familiarity signals like "you have installed N skills from this source before") rather than free-form name display. Partial because no architectural defense fully closes the social-engineering surface — a user determined to install a forged-source skill can do so — but the dialog should not make the attack easy.

**Shape E — permission combination compound risk.** A §11.10 question. `vault:*` is risky; `network:*` is risky; their combination is risky in a way that doesn't decompose into the sum of the parts. **Cluster commits to defending against this shape.** The dialog has to summarize compound permissions such that emergent risk is visible, not just the individual items. The specific architectural item: §11.10's pattern grammar should support a small set of recognizable combinations (e.g. "vault access + network access" as a category the dialog renders distinctly), and the install UI should escalate visibility when a skill requests one.

The cluster runs at least one concrete test case per defended shape (A, C, D, E) as a running fixture during the dialog-draft cycles. Shape B has no test case because the cluster acknowledges it's not architecturally defendable; the dialog draft is tested against B only to confirm it doesn't *falsely* claim defense against this shape.

The four committed shapes are floors, not ceilings. The cluster may identify additional attack shapes during drafting and add fixtures for them; each addition follows the same rule (decide for or against, name the architectural mechanism if for, acknowledge the limit if against).

---

## What this patch does not change

- The cluster scope: §11.9 + §11.10 + §11.12 + four v0.6.1 carry-overs.
- The working method's inversion: UX as co-driver, dialog-first.
- The success criterion: "open this file, see this dialog, make a real decision."
- The other six refinements in the v0.7 addendum (bounded vocabulary, other dialog cases mapped, iteration budget, scope fences, pool disclosure inside the dialog loop, failure framing).
- The failure framing's commitment: available, readable, actionable. Shape B is the architectural ceiling beneath that commitment — the substance the user must engage to defend against B is *available*, but no architecture forces engagement.

---

*Patch to the v0.7 working-method addendum. Threads point 1's merit check through point 6's scope fences (concrete first pass: "does this proposal respect the closed commitments?"). Expands point 3's adversarial verification from a single mandatory case to a named set of five attack shapes (A: permission-vs-code mismatch, defended; B: plausible permissions used maliciously, acknowledged outside reach; C: update with quiet capability expansion, defended; D: plausible-source forgery, partial defense; E: compound permission risk, defended). The cluster runs fixtures for the four defended shapes during drafting cycles. No architectural changes; the cluster scope and commitments through v0.6.1 + the v0.7 working method are unchanged.*
