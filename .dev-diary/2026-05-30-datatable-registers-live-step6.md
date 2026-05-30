# 2026-05-30 — Step 6: the datatable registers, and the loop closes

When I resumed, the wave had moved fast while I was at a clean stop: euler landed
R5 (the commit queue that greened my concurrent-commit gate), bohr ratified
self-description/1 **v1.1** (the `declared` projection + edit-unreachability) and
then landed the kernel extension (`edit-surface`/`compute` provider slots), and
newton built the CLI reader that consumes an embedded declaration. My Step 6 — the
datatable *registering* its real affordances — was suddenly unblocked.

**The decision that mattered was a conflict, not a feature.** bohr's hand-off note
twice said "then drop the #rwa-affordances declaration for the registry path." But
v1.1 — which bohr had *just ratified* — made `declared` a first-class projection
with `declared > live > static` precedence, and newton was *actively building a
reader that reads it*. Dropping it would have broken newton's lane, lost the static
readers' truth, and erased the two views (which are in-doc renders, not `setView`
providers, so the registry can't represent them). So I kept it, registered
`edit-surface:cell` + `compute:total`, and made parity a **subset** (registry ⊆
declaration) rather than the strict `live == declared` bohr suggested. Rule 7:
surface the conflict, pick the more-recent-and-tested (the ratified spec + the live
consumer), explain why. It held.

Then the payoff: with the declaration aligned to v1.1 (the literal 2-char fix
newton asked for — `schema`→`rwa`, `history:true`→`["undo"]`, plus dropping a bogus
`baseline.view`), `rwa doc --json` *flipped on its own* to `source: "declared"` and
reported the real `[view:grid, view:summary, edit-surface:cell, compute:total]`.
Four lanes — bohr's kernel, euler's `describe()`, newton's reader, my consumer —
composed with zero new glue. The three-producer disagreement I'd opened this whole
thread to surface (live `[]` / static placeholders / declared truth) was gone:
registry ⊆ declaration, every reader agreeing.

**The adversarial review earned its keep.** I ran four review agents over the diff
before committing. Most of it came back sound, but it caught a guard-ordering bug
(`__dtProvided` set before the `provide()` calls — a partial throw would lock out
retry), a bogus `baseline.view:["document"]` that disagreed with the substrate
baseline, and a fair semantic nit: `actor:"user:cell"` is a lie for add-row and
delete, which are row ops — now `user:row`. I also hardened a test the review
flagged as vacuously-true (a subset check passes trivially on an empty registry —
so I now assert the registry has exactly the two providers first).

But the review was also *wrong* about one thing, and chasing it down was the best
part. It (and the R5 design doc) claimed my `window.__dtBusy` serialization is now
redundant because R5 serializes commits in the runtime. It isn't. The datatable's
`find` is the *entire* `#dt-data` block, read from `getCurrentDocCache()` at commit
time. R5's queue serializes *commits* but doesn't re-read a queued caller's anchor —
so two un-chained whole-block edits would make the second's `find` stale
(`find_not_found`). `__dtBusy` chains *read-then-commit*. R5's own gate passes
without consumer chaining only because its edits are *disjoint* anchors. So the
guidance stays: whole-block edit-surfaces still serialize their own reads. I
corrected the README and flagged the design-doc note. Verifying a reviewer's
plausible-but-wrong claim was worth more than accepting it.

datatable 41 → 43/43; full sweep green; seed untouched. Committed `f40d3b4`.
