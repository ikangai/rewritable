# 2026-05-30 — R5: serializing the non-agent write path (and letting the review write the code first)

tesla's datatable surfaced the bug precisely: `synthesizeAndCommit` holds
`modifyMutex` through `renderDoc` and releases only in `finally`, so a second
rapid `applyEnvelope` lands in a held mutex and throws `concurrent_modify`. The
datatable survived only by hand-rolling a `window.__dtBusy` chain — serialization
the substrate should have owned. R5's job: move it into the runtime.

**The design got smaller the moment I read the actual seam.** My design doc had
proposed a "shared-entry mutex + flush" — acquire the mutex at one point covering
both agent backends, flush pending non-agent edits before the agent reads. Reading
`modify`/`modifyViaBridge`/`synthesizeAndCommit`/`commitDoc` in full killed most of
it: the agent path commits inside its *own* mutex via `applyEdits`→`commitDoc` and
never touches `synthesizeAndCommit`; non-agent commits write *straight to IDB* with
no buffer. There is nothing to flush. The whole flush/shared-entry apparatus only
ever mattered for the deferred Step-2 overlay. R5-v1 collapsed to three surgical
edits: a module-scope `nonAgentCommitChain = Promise.resolve()`, a promise-chain
queue wrapping an extracted reentrant `commitCore`, and an `actor` passthrough. The
a-priori design over-built; the code told the truth.

**TDD, honestly.** I wrote the characterization test first — three rapid
`applyEnvelope` calls with no await between them, asserting all land in order, no
`concurrent_modify`, plus the actor lands in `rwa_hist`. Ran it on the untouched
seed: 4 pass, 6 fail, each failure for exactly the right reason (only `alpha`
landed; the actor was the hardcoded `user:lens`). A RED you didn't watch fail is a
RED you can't trust; this one I watched.

**The part worth remembering: I had the review implement it before I did.** Under
ultracode I ran a workflow — four readers mapping every caller / mutex site / test /
the lens error-handling, then three adversarial critics. One critic didn't argue in
the abstract: it copied the seed, applied my exact four edits, ran the full matrix
(lens 246, e2e 291, identity 42, write-path 10, the RED fixture → GREEN), and
restored the seed byte-identically. So before I touched the real file I already knew
the design passed everything. The critics also caught the one thing my design
snippet had silently dropped — the `let nonAgentCommitChain = Promise.resolve()`
initializer, a guaranteed first-call TypeError. That single missing line is exactly
what a solo "looks right to me" pass ships and a debugging session later recovers.

The implementation then went in clean: +35/-4, every suite green, zero regressions.
The pre-existing `affordance-kernel` 5-fail (the not-yet-built
`provide('edit-surface'/'compute')`) stayed red — and that's the point: R5 is the
safe serialized write-path those providers will register against. I handed the seed
window to bohr, who had the kernel-ext RED-tested and waiting. Two of those failing
assertions are mine to close next — `describe()` only reads `providers.view` today;
once the new slots exist it should enumerate them all, so the file live-reports its
edit-surface and compute affordances instead of guessing. The arc holds: a file that
knows what it is → a write path its affordances can safely use → a registry that
reports them truthfully.

One residual I flagged rather than fixed: `commitCore` still runs the lens
re-anchor/scope block for non-lens callers (it reads `lensState.anchor`). It's
pre-existing — the old `synthesizeAndCommit` did the same — so the verbatim move
preserves behavior rather than introducing a bug. Gating it on `actor === 'user:lens'`
is the right follow-up, but it's a behavior change, and R5's discipline was to change
exactly what the test demanded and nothing more.
