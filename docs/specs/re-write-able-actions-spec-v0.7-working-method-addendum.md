# re-write-able v0.7 working-method addendum

*A focused revision to the v0.7 working-method preamble. Refines six points before the cluster work begins. No new structural commitments; the inversion (UX as co-driver, dialog-first method) and the cluster scope (§11.9 + §11.10 + §11.12 + four v0.6.1 carry-overs) are unchanged.*

---

## 1. The dialog draft is itself an architecture proposal

The preamble framed the dialog draft as a "design tool" for the architecture, not a UI spec. This is right but needs the second half spelled out: every sentence in the draft commits to architectural choices in prose form. The draft is not neutral.

Take the example sentence used in the preamble: *"you have installed three skills from this same source before, all of which you kept."* That sentence presupposes:

- The runtime tracks **per-source install counts**.
- The runtime tracks **uninstalls separately** so it can say "all of which you kept" rather than "three installed historically."
- The user thinks of "**the same source**" as one concept — not "the same author key," "the same email," "the same domain," "the same publisher entity," or "the same signing identity." The English word commits §11.9's provenance design.
- Source identity is **durable enough that "the same source" means something across time** — a renamed publisher, a rotated signing key, an author who changes hosting, all have to still resolve to the same source for the count to be meaningful.

The sentence reads as obvious UX language, but it implicitly proposes a §11.9 design. The draft-first method is therefore also a proposal-first method, and the "design the architecture to make the sentence true" step has a hidden first question: **is the architecture this sentence implies actually the right one on the merits, or does it just sound obvious in prose?**

The corrective is small but load-bearing. When a draft sentence forces an architectural choice, the cluster work has to ask **both** of these questions in order:

1. Is the architecture this sentence proposes correct on the merits?
2. Does this sentence read well?

Question 1 has to come first. Otherwise the method degrades into UX-driven cargo-culting where the architecture is whatever sounds natural in English — and English makes implausible architectures sound natural all the time. Sometimes the better architecture produces a slightly worse sentence, and that's the right trade.

This is not a major revision to the method — the working pattern stays draft → identify → design → re-read → redraft. What changes is that the "design" step is explicitly two-part: design what the prose presupposes is right (architecture on the merits), then redraft to make the resulting architecture readable. The cluster should treat dialog drafts as architectural proposals dressed in English, not as user-facing copy that has architectural side effects.

## 2. Bounded vocabulary, not "more than three concepts"

The preamble's "if the dialog requires the user to understand more than three concepts to make a decision, the architecture is too expressive somewhere" was unjustified as a hard number and "concepts" was undefined enough to mean almost anything. Permission alone is a concept; manifest-as-contract is another; Worker-vs-default is a third; the user is already at three before provenance, source identity, or pool behavior enter the picture.

Replace with: **the dialog should be readable with a small bounded vocabulary. If the cluster keeps introducing new concepts the user has to learn, the architecture is leaking technical surface.** The number isn't load-bearing; the constraint is.

The working test during drafting: when a draft sentence introduces a term the user hasn't seen before in this dialog or in normal computer use, that term is a vocabulary admission. Count the admissions. If the count is rising as the draft matures, the architecture is leaking surface and the cluster should look for a piece to constrain (probably in §11.10 — permission patterns are the easiest source of vocabulary).

## 3. Verification — the adversarial thought experiment

"Make a real decision" can fail three ways:

a. User clicks Install without reading.
b. User clicks Cancel because confused, even when Install would have been correct.
c. User decides on surface signals (a familiar-sounding source name, an unthreatening permission summary) without engaging the substance.

Naming the failure modes makes the success criterion testable. The verification mechanism the cluster commits to:

**Design at least one adversarial test case during the cluster work, and run the dialog draft against it as the architecture iterates.** A worked example: *a skill that declares `vault:wordpress-personal` and `network:api.wordpress.com`, looks structurally normal, but contains code that uses dynamic property indexing to read other vault namespaces. The skill's `description` is benign-sounding. Does the dialog as drafted give the user enough to refuse this install?*

The test case isn't a one-time check at the end. It's a running fixture: every dialog draft revision passes through it, and any draft that lets the test case install without surfacing the issue is incomplete. The capability scan (§4.1) is the place where the dynamic-indexing pattern should surface; the test confirms the dialog *makes that surfacing legible*, not just present.

At least one adversarial case is mandatory. The cluster may add more as it identifies attack shapes that aren't covered by the running fixture.

## 4. Other dialog cases

The preamble centered on first-time encounter with an imported `.rwa-skill.json` from a downloads folder. That's the right primary case — it's the hardest — but the dialog also handles four other cases that need explicit treatment:

- **⌘K-generated library skills.** The user authored it (described it to the LLM in the viewer); trust posture is different because the LLM is the proximate code source, but the user remains the install reviewer. Subset of the import case.
- **In-place edits in the library viewer.** Same trust posture as ⌘K-generated. Subset of the import case.
- **Updates from any source.** Same dialog plus a diff against the previous version. Subset of the import case with one extra panel.
- **Mode-mismatch rejection** (a `worker`-declared skill on a runtime without Worker support; see v0.6.1 §1). A **rejection surface**, not an install dialog. Different shape entirely — the user can't proceed and the dialog's job is to explain what's needed (install a newer runtime or edit the manifest) without burying it in spec-internal language.
- **Forced-Worker × `tested_modes` mismatch** (v0.6.1 §5). Same shape as mode-mismatch rejection but initiated from the permission side rather than the manifest side. Same rejection surface; same need for legible explanation.

The cluster designs the import case carefully and lets the three subsets inherit from it. The two rejection surfaces get their own brief treatment to ensure rejections don't degrade into the same wall-of-text failure mode the install case is being designed away from.

## 5. Iteration budget and stop criterion

The preamble acknowledged incremental verification is harder for v0.7 but didn't budget for it. Commit: **expect at least two full cycles of draft → identify → design → re-read → redraft, and ship when the third cycle changes nothing material.**

"Nothing material" means: no architectural choices change, no new vocabulary admissions are added or removed, the adversarial test case continues to surface correctly, the rejection-surface treatments don't acquire new edge cases. Cosmetic edits to the prose don't count — they can continue and they don't gate the ship.

This gives a stop criterion that isn't "until it feels done." It also implicitly budgets two cycles of architectural rework, not just one — the cluster shouldn't ship after the first draft even if it reads well, because the test of the method is whether the architecture survives the second pass intact, not whether the first pass sounds plausible.

## 6. Scope fences — what v0.7 does not revisit

The dialog-first method has a tendency to re-open architectural questions that were correctly closed in earlier passes. Enumerate the closed ones so the cluster doesn't drift:

- **Invariant 10** — installation is the privileged moment, runtime enforcement is defense-in-depth. The cluster designs the dialog *through which* invariant 10 is enacted; it does not revisit whether install-time review is the trust anchor.
- **Invariant 12** — self-modifications persist only on manual triggers with explicit ⌘S. Persistence semantics for workflow runs are settled.
- **§2.4 defense-in-depth proxies + capability scan** — the proxies are not a sandbox, the scan is layered defense, the human is the reviewer. The cluster designs the dialog *that surfaces* the scan's results; it does not revisit whether the scan exists or what it covers.
- **Vault namespace boundary (§3)** — namespace-scoped, never travels with the file, recipient's namespaces are separate from publisher's. The dialog discloses namespace requests; it does not redesign the access model.
- **Bus-as-composition-surface (§5.7 main spec, §8.2)** — cross-container coordination goes through the bus, not through state. The dialog doesn't design composition; it discloses what a workflow's sub-bus pattern looks like only insofar as that's part of a skill's declared permissions.
- **Skills cannot install skills (§4.3)** — the back door is closed. The cluster does not introduce skill-driven install paths.

These are settled and the cluster takes them as given. If the dialog draft starts asking the user to make a decision that any of these closed commitments already decided, the draft is wrong, not the architecture.

## 7. Pool-behavior disclosure inside the dialog loop

The v0.6.1 carry-over items are well-characterized, but their ordering matters. Items 1–3 (full Worker pool lifecycle, idle-timeout commitment, lens lock cross-reference) are smaller and can be specified in isolation, in parallel with the cluster work. **Item 4 (pool-behavior disclosure in the install dialog) lives in the dialog itself and must be designed inside the cluster's dialog loop, not specified separately and integrated afterward.**

If pool-behavior disclosure is being designed in coordination with the rest of the dialog, it lands at the right level of language and visibility. The one-sentence summary, where it appears in the layout, whether it's expandable, whether it interacts with the user's mode choice — all of these decisions are downstream of the dialog's overall language and rhythm. If it's specified separately and the dialog tries to incorporate it after, the integration will be awkward and probably end up either too technical or buried.

The other three items can land in parallel with the cluster, as ordinary spec additions. Item 4 ships as part of the cluster.

## 8. Failure framing — the limit of what the cluster can deliver

The success criterion ("open the file, see the dialog, make a real decision") is concrete. Failure at this layer is also concrete and worth naming honestly:

**Failure is: the architecture interlocks correctly, the dialog is readable, the adversarial test case passes — and a first-time user still clicks Install without engaging the substance.**

The trust anchor (invariant 10) holds only if users do the review the architecture invites. The cluster can do everything right and the anchor can still fail at the human layer. No architecture can fix that. The cluster's commitment is:

1. The substance is **available** — the information needed to make a real decision is in the dialog, not buried in spec annexes.
2. The substance is **readable** — the information is in language a non-spec-fluent user can engage with.
3. The substance is **actionable** — the dialog offers decisions the user can actually make (accept, decline, edit) without dead-end paths.

Beyond that, the format's contract is with whoever does the review, not with whoever clicks the button. A user who declines to read what's in front of them has stepped outside the trust model the format provides — and that's a known limit, not a flaw to be designed around. Designing around it would mean adding friction beyond what the substance requires (mandatory wait timers, comprehension quizzes, theatrical complexity) which makes the dialog worse for users who *do* engage.

The cluster commits to the three properties above. Beyond them, the spec's reach ends and the user's begins. v0.7 should say this plainly so future readers don't mistake "user clicked through" for a cluster defect.

---

## What this addendum does not change

- The cluster scope: §11.9 + §11.10 + §11.12 + four v0.6.1 carry-overs.
- The working method's inversion: UX as co-driver, dialog-first.
- The success criterion: "open this file, see this dialog, make a real decision."
- The trajectory acknowledgment: v0.7 likely breaks the per-feature brevity trend in absolute terms, and that's acceptable.
- The carry-over discipline: §11.1 (common skill set), §11.7 (local-LLM), §11.8 (Argon2id parameters) remain deferred to v0.8.

The eight refinements above sharpen *how* the cluster is designed without changing *what* the cluster delivers.

---

*v0.7 working-method addendum — sharpens six points in the preamble: dialog drafts are architecture proposals (commit to architecture-on-the-merits before redrafting for prose), bounded-vocabulary replaces the three-concepts rule, the adversarial thought experiment is the running verification fixture, other dialog cases are mapped (three subsets, two rejection surfaces), iteration budgets at two cycles with a stop criterion of "third cycle changes nothing material," scope fences enumerate the six closed commitments the cluster takes as given, pool-behavior disclosure ships inside the dialog loop rather than separately, and failure at the human layer is named as a limit of the cluster's reach rather than a defect to design around. No architectural changes; the invariants and commitments through v0.6.1 are unchanged.*
