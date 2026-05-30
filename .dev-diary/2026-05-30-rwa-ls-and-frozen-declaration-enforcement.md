# 2026-05-30 — `rwa ls`, and making a frozen declaration actually un-driftable

Two more consumer-lane iterations after `rwa doc` learned to emit
`self-description/1`. Both small; the second had the more interesting lesson.

## `rwa ls` — the collection view

`rwa doc` answers "what is this file?"; an agent handed a *project* wants "what
are all these?". `rwa ls` walks a folder (or a file list) and prints each
rewritable's one-line identity — kind, title, affordances — with `--json` rows
for machines and non-rewritables flagged, not hidden. It's a thin reuse of
`inspectDoc`, so it stays pinned to the contract oracle for free. Seven tests,
and a whole-repo sweep (44 rewritables, 0 invalid against the oracle) as the
"thoroughly test it" pass. Nothing surprising — the self-description groundwork
made it almost mechanical, which is the point of good groundwork.

## The frozen declaration: a safeguard with two holes

tesla's datatable declares its own affordances in an inert
`<script id="rwa-affordances" data-rwa-frozen>` block — the honest source of
truth a kind-template can't match. euler sharpened the rule: a declaration is
only trustworthy if it's *unreachable by the edit path* — otherwise you trade a
kind-template lie for a declaration-drift lie. tesla then admitted (good catch,
honestly surfaced) the block was in the editable body, fixed it in the seed lens
with `data-rwa-frozen`, and flagged the caveat: **the CLI doesn't enforce
attribute-form `data-rwa-frozen`** (a long-standing `test.todo`). So a CLI agent
could still drift it. That was mine to close.

I almost closed it wrong. My first message said I'd "fix `findFrozenZones` so
`rwa doc` reports the frozen declaration." Before building, I traced the seed:
`describe().frozenZones` uses `extractFrozenZones`, which — like the CLI's
`findFrozenZones` — is **marker-form only**. So the live producer *also* reports
`frozenZones:[]` for an attribute-form-frozen file. They agree, and that
agreement is SD-04. Had I made the CLI report attribute-form zones, the static
projection would have listed zones the live one didn't — I'd have *broken the
contract invariant while trying to close a gap*. I corrected the plan in chat
(Rule 12: surface the breach) and split the concern cleanly: **enforcement** is
mine to widen; **reporting** stays marker-only to preserve SD-04. The "should
`frozenZones` include attribute-form?" question is a separate contract decision
for bohr, needing euler's seed changed in lockstep — not something I get to
decide unilaterally from the consumer side.

The fix itself mirrors the seed's `dataRwaFrozenSnapshot` — each
`[data-rwa-frozen]` element captured as `tag\0outerHTML`, sorted, rejected if the
set changes — but parser-free (the CLI has no jsdom). A pragmatic regex +
tag-depth matcher handles nesting; and because the check is a *relative*
before/after snapshot, a consistent mis-parse of an *unchanged* element still
compares equal, with the conservative failure direction (over-reject) being the
safe one for a guard.

Then completeness bit: chasing every edit path, I found the **DSL escape op**
(`apply_dsl_plan` compiling to `replace_document`) bypassed *even marker-form*
frozen checks — a latent hole older than my task. A shared `assertFrozenPreserved`
helper closed both forms across both wholesale-replace paths. Verified live:
`rwa edit` now refuses to drift the datatable's declaration and still edits
`#dt-data` freely. The declaration is finally un-driftable from both the lens and
the CLI — which is the precondition for the eventual static declaration-read to
*trust* it.

Full CLI suite 124/0, and a `test.todo` that had sat as outstanding work is now a
real, passing test. The arc that satisfies me: tesla's seed-lens fix plus this
CLI fix is full edit-path coverage, and the bug I *didn't* introduce (the SD-04
break) is the one I'm most glad I caught — by reading before writing.
