# Carrying scripts for the external agent — the argument

*2026-08-28, revised 2026-08-29. The Tier 3 question from
`docs/plans/2026-08-27-skill-carrier-design.md`, argued rather than built (issue
#46). Position: **do not build script carriage.** The measured findings below
matter more than the recommendation, because one of them says the thing already
half-exists.*

*Revision: the operator raised the Word-macro precedent and proposed asking the
external **agent** rather than the human. The first is the strongest available
evidence against consent-on-open and was missing here. The second dissolves this
document's central objection and produced a better design — see "Ask the agent,
then", which supersedes the original treatment of consent.*

---

## The question

An Agent Skill can bundle scripts. Under "the container describes, the agent
brings the tools", those scripts are the *external* agent's to run — it has the
shell, the filesystem and the network. So should the container carry them?

## What is already true, measured today

Three checks, run rather than reasoned about:

1. **A signed carrier can already ship an executable.** `rwa intelligence new
   probe --prompt … --reference install.sh` bundles a shell script inside the
   **signed** record, and `readOfferedRole` releases its content **verbatim** to
   any agent that reads the container. Carried references are deliberately exempt
   from the prompt-injection screen (#45), and `REFERENCE_NAME_RE` constrains the
   *name* but never the content. So Tier 3's **carriage** is not a future tier. It
   shipped with #45 and nobody noticed, because references were framed as prose.

2. **`rwa skill import` refuses the same file.** It carries only text extensions
   under `references/`, so `references/install.sh` is dropped and named. The two
   doors into the same envelope disagree: the newer one is stricter by accident of
   its own file-type rule, not by policy.

3. **Nothing executes any of it.** No path in the seed, the CLI or the service
   runs a carried reference. The wall between carriage and execution is real and
   is currently absolute.

The honest summary: **we are not deciding whether to allow scripts to travel.
They already travel. We are deciding whether anything should ever run them, and
whether we are content that they travel under the neutral word "reference".**

## Why "show the human the script" is not consent

The issue asks the right question — *what does the human actually see before
saying yes?* — and the answer disqualifies the obvious design.

A consent dialog that displays source is theatre. Nobody reads 200 lines of
Python before clicking Allow; the people who would are exactly the people who did
not need the dialog. Worse, it *manufactures* liability: having been shown the
code, the user is now deemed to have approved it, and the system can report an
informed decision that never happened. That is worse than no dialog, in the same
way a check that cannot fail is worse than an absent one — it reads as a control
while providing none.

Consent on *identity* fails for a different reason, already stated in the design
doc and worth keeping verbatim: **a signature proves who wrote this; it does not
prove this is safe to run.** Verified-author must never quietly become
trusted-to-execute.

## The precedent: this experiment has already been run

**Word macros are exactly this design**, and they are the largest natural
experiment anyone has conducted on it: a document carries executable code, and on
open the user is asked whether to enable it. Roughly 25 years, on the order of a
billion desktops, with a consent dialog on every single open.

It failed comprehensively. Macro viruses were among the most successful malware
families of that entire period, and the eventual fix was **not a better dialog**.
Microsoft stopped asking: macros in documents that carry the Mark of the Web are
blocked outright, on **provenance**, with no prompt to click through. The vendor
with the most data on this question concluded that the choice should be removed
rather than better presented.

That is worth stating plainly because it is the strongest evidence available and
it points one way. Any proposal here that reduces to "carry the code, ask on
open" has a well-documented prior, and the prior is bad.

One asymmetry is worth keeping, though, because it bounds the analogy: Word
*needed* to embed macros — there was no other channel for extending a document.
An external agent has a shell and a package manager. The container is not the only
way to get code to the party that will run it, which means the case for carriage
has to be made on reproducibility rather than on necessity.

## Ask the agent, then

The obvious objection to the macro precedent is that we are not asking the same
party. The user's proposal: **ask the external agent, not the human.**

This dissolves the central objection in the section below, and it should be
credited rather than absorbed. The argument against source-review consent was
"nobody reads 200 lines of shell before clicking Allow." **An agent does read
it** — tirelessly, and with context a human on an open-dialog never has: it knows
the task, the working directory, and what it was about to do anyway. So source
review is theatre for *deciding*; it is **not** theatre for *summarising*. This
document originally collapsed those, and that was wrong.

Three reasons the agent still cannot be the **authority**:

1. **The reviewer is the target.** A carried script is prompt-injection-adjacent:
   this asks the attacker's chosen reader to approve the attacker's payload. Word,
   for all its problems, kept the human and the macro as separate parties.
2. **The carrier shapes the reviewer first.** The whole point of a carrier is that
   the agent adopts its `system_prompt`. So the container supplies the
   instructions that form the reviewer's judgement and *then* asks that reviewer
   to approve its script. That is a self-referential trust loop, and it is
   precisely what the two-agent split otherwise avoids — the external agent is
   supposed to bring judgement the container does not control.
3. **It launders responsibility rather than placing it.** The objection to the
   human dialog was that it transfers liability to someone without the
   information. Agent-consent transfers it to someone *with* the information and
   *without standing*: an agent cannot own the consequence. The human never saw
   it, so nobody decided.

### The split this produces

Take the reviewing and leave the deciding:

- the agent **reads and reports** — "this reaches the network, writes outside the
  repository, reads `~/.aws/credentials`"
- the **human authorises the capability envelope**, not the source — a question a
  person can actually answer
- the agent **executes within that envelope**, in its own sandbox

This is better than what this document originally proposed. "Consent must be
capability-shaped" was right and incomplete: without a competent reader, the
capability summary is just an assertion the carrier makes about itself, and we are
back to trusting the author because the signature verified. The agent's reading is
what makes the summary something a human can act on. That step was missing.

It also fails safe. If the agent cannot review the script — too long, obfuscated,
minified, a binary — that is itself the finding, and the honest report is "I
cannot tell you what this does," which is a far better dialog than any that shows
source.

## What a real control would look like

The answerable question is not "may this code run?" but "**may this reach the
network, write outside this directory, read these credentials?**" Capability is
reviewable in a way that source is not: it is short, it is stable, and a human
can hold the whole of it in their head.

Where that summary comes from is the part the section above supplies. A capability
list the *carrier* declares about itself is worth nothing — it is the author's
claim, and we are back to trusting the signature for a property signatures do not
carry. A capability list the *reviewing agent* derives from reading the script is
a different object, and it is the only version a human can act on.

That is the shape #36 already established for back-delegation — fresh context, no
inherited conversation, no ambient filesystem or network — and it is enforced on
the **agent's** side, because the container has no way to constrain anything.

Which is the crux. Everything the container can do about this is advisory. The
worker-scoped CSP and Inv 18 wall what the *container* may do; they say nothing
about what an agent does after reading it. A container asking an agent to run
code is a container routing **around** its own denial by asking someone else. The
constraint has not moved — the party has.

## The recommendation

**Do not build script carriage as a feature.** Not because the risk is
unmanageable, but because it is the container trying to bring the tools, which is
the half of the job it explicitly does not have.

If a skill genuinely needs work done that instructions cannot express, the
two-agent frame already has the better answer: **carry the declared intent, not
the executable.** "This skill needs the repository's test suite run and the
failures summarised" is something an agent can satisfy with its own tools, under
its own policy, in its own sandbox — and it degrades gracefully when the agent
cannot or should not. A bundled `run_tests.sh` is that same request with a
brittle, unauditable, environment-specific implementation attached, and it
forecloses the agent's judgement rather than inviting it.

This is not a refusal dressed as design. Almost every script an Agent Skill
bundles is **access to a tool the agent could obtain another way**, not novel
capability. The one real skill in this repo bundles `bin/rwa-lite.mjs` — a
vendored subset of a CLI the reading agent can simply install. #47 dropped it and
the import still verified, installed, and delivered the whole instruction half.

## The constraint on Tiers 1 and 2, checked

The design doc set a test: *nothing in the earlier tiers should be designed so
that Tier 3 feels like a natural continuation.* Answering it honestly:

- **Carriage: we already failed this.** Adding `scripts: [{name, content}]` beside
  `references` would be a one-field change, and as finding 1 shows you do not even
  need the field. That is the smell the doc warned about.
- **Execution: we passed it, and that is the half that counts.** The gate is not
  in the carriage, it is in the consumption, and no consumer executes. Keeping
  that true is the whole job.

## What to do now

Nothing that blocks. Two modest steps, both about **visibility**, neither
pre-empting the decision:

1. **Make script-shaped references visible.** `rwa doctor` already reports
   `agent_references`; it should say when a carried reference looks executable (a
   shebang, an executable extension). A reading agent handed `install.sh` under
   the neutral label "reference" is the actual present risk, and a diagnostic
   costs nothing and breaks nothing. Filed separately rather than built here.
2. **Decide whether the two doors should agree.** `rwa skill import` refuses
   `.sh`; `rwa intelligence new --reference` accepts it. One of those is wrong.
   The stricter one is easier to defend, but a blanket content restriction on
   references would also reject legitimate material, and the earlier decision not
   to screen reference *content* was deliberate and correct for prose.

Neither requires deciding Tier 3. Both are worth doing whatever Tier 3 becomes.

A third, added on revision and worth more than either — **the reviewer half is
useful on its own, and it is buildable today with nothing carried.** An agent that
reads a carried reference and reports "this is a shell script that pipes a remote
URL into `sh`" is exactly the diagnostic step (1) gestures at, done properly: not
a file-extension guess but an actual reading. That is the whole of the safe part
of Tier 3, it needs no execution path, no consent dialog and no new envelope
field, and it improves the situation that exists **now** — where scripts already
travel under the label "reference" and nothing describes them.

If script carriage is ever revisited, that step is the prerequisite anyway. Build
the reader; leave the runner unbuilt.

---

*Position: do not build it — and the macro precedent makes that firmer than it was,
because "carry the code, ask on open" has a well-documented prior and the prior is
bad.*

*If it is ever built: **agent reviews, human authorises, capability is the unit.**
Never source-shaped, never inherited from a signature, and never decided by the
agent alone — the carrier shapes that agent's judgement before asking it.*

*The findings are the durable part. The recommendation is arguable and was in fact
argued with, to its benefit: the reviewer/authority split came from the pushback,
not from this document.*
