# Carrying scripts for the external agent — the argument

*2026-08-28. The Tier 3 question from `docs/plans/2026-08-27-skill-carrier-design.md`,
argued rather than built (issue #46). Position: **do not build script carriage.**
The measured findings below matter more than the recommendation, because one of
them says the thing already half-exists.*

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

## What a real control would look like

The answerable question is not "may this code run?" but "**may this reach the
network, write outside this directory, read these credentials?**" Capability is
reviewable in a way that source is not: it is short, it is stable, and a human
can hold the whole of it in their head.

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

---

*Position: do not build it. If it is ever built, consent must be capability-shaped
and enforced agent-side, never source-shaped and never inherited from a signature.
The findings above are the durable part; the recommendation is arguable and is
meant to be argued with.*
