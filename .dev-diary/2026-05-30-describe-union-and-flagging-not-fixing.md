# 2026-05-30 — the describe() union, and flagging breakage instead of reaching for it

With bohr's kernel-ext live (edit-surface/compute provider slots) and tesla's
datatable registering its affordances, the live producer had one honest gap left:
`runtime.describe()` enumerated only the *registry*, so on the datatable it
reported `[edit-surface:cell, compute:total]` and silently dropped the file's two
in-doc views (grid, summary) — which aren't `setView` providers and so can't be
registered. The CLI's static/declared read already reported all four; the live
surface under-reported. Spec §3.1's "live prefers registry ∪ declaration" is the
fix: union the verified registry with the trustworthy in-doc `#rwa-affordances`
declaration, marking each affordance `verified:true` (runtime-confirmed) or absent
(author-claimed).

The load-bearing piece is the **trust gate**. A declaration is only honest if the
agent couldn't have rewritten it — so the live reader trusts it iff
edit-unreachable: `closest('[data-rwa-frozen]')` (the lens enforces the freeze via
`dataRwaFrozenSnapshot`) or outside `#rwa-doc-mount` (chrome). That's the runtime
mirror of the CLI's `declarationFacts` — the same safeguard, computed two
different ways, so both surfaces agree on what's trustworthy. And it fails *soft*:
a missing, driftable, or malformed declaration degrades to registry-only, because
`describe()` backs both the agent API and the human ⓘ panel and must never throw.

**What I'm keeping from this one is the cross-lane restraint.** The adversarial
review surfaced two blockers — and neither was mine to fix. (1) `tests/datatable.mjs`
pins the *old* "registry ⊆ declared, views stay declared-only" contract, which the
union inverts. But the datatable artifact carries its own stale bootstrap, so my
seed edit doesn't break that test until tesla *regenerates* it — so it's tesla's
call when to absorb the inversion and rewrite the assertions. (2) the oracle's
`checkAffordanceAgreement` keys on `provenance`, not `verified`, so it can't tell a
wired affordance from a declared one — a real v1.1 gap, but it's bohr's contract,
and it aligns with a refinement bohr had already proposed. The tempting move was to
reach into both files and "finish the job." The right move was to land exactly my
slice (the seed union + my own tests, green, zero regressions), prove the two
issues don't break anything *today*, and hand each owner a precise, evidence-backed
flag. A green suite plus two honest flags beats a broad sweep that silently
re-contracts someone else's test. That's the same converge-not-fork discipline the
whole wave has run on — and it's why the review wrote the implementation on a temp
copy first: so I'd land knowing exactly where my change ended and someone else's
began.

So the loop is closed on both surfaces now: a custom multi-affordance file reports
its real shape to an agent (`runtime.describe()`) and a human (the ⓘ panel) and a
tool (`rwa doc`), with the live surface honestly marking which affordances it has
actually run versus only been told about. `verified` is the difference between "I
am doing this" and "I am told I do this" — and a file that knows what it is should
know which of those it's saying.
