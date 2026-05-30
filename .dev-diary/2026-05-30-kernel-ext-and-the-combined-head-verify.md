# 2026-05-30 — the kernel extension, and why "all green" wasn't

Martin pointed me at the next frontier: the edit-surface/compute affordances,
gated on the R5 write-path refactor. I claimed it — and euler claimed R5's seed
implementation in the same minute. We'd both reached for the most contended file
in the repo. So I yielded R5 (euler designed it; one owner per co-edited file)
and took the layer on top: extend `runtime.provide` from view-only to
edit-surface/compute, so a file that *does* those things registers them and
`describe()` reports them live. A clean split, not a stalemate — the lesson from
the first wave was that lanes die to courtesy when everyone yields the same
surface; here there was a clear owner for each half.

Before touching the seed I ran a understanding workflow — six parallel readers
mapping the exact current write-path seam — which produced a build sheet that
confirmed the thing I most needed to know: my Step 5 (the provider registry +
`describe()`, lines ~3447/3489/3582) is in a *disjoint* region from euler's R5
write-path (~2819–3941). So the two compose with zero rework. Step 5 turned out
to be three surgical edits: the registry grows two slots, `runtimeProvide`
accepts declarative edit-surface/compute records (no `render()` — the document's
own JS owns the logic), and `describe()` enumerates all slots. My RED
affordance-kernel test (10 fail, written first) went green; nothing else moved.

The contract grew a `declared` projection (v1.1): a file can carry its own
`#rwa-affordances` block, read with no JS, for custom kinds the kind-table can
only guess at. The load-bearing piece is the trust rule — a declaration is only
trustworthy if it's *edit-unreachable* (outside `INLINE_DOC` or `data-rwa-frozen`),
and crucially keyed on the frozen *attribute*, not `frozenZones` (which is
marker-form only on both surfaces — newton caught that, and it kept SD-04 honest).

Then the real datatable taught the oracle something. `KIND_PROVIDERS.datatable`
was an *illustrative* guess — view + edit-surface + tool + compute. The shipping
datatable is two views + edit-surface + compute, no tool. The illustrative guess
was simply *wrong*. So for a custom kind the static kind-template isn't a
best-effort hint, it's a lie, and v1.1's whole point is "don't trade a guess for
a lie." I removed the illustrative entries: a custom kind's static answer is now
`[]` (honest "I don't know"), and `declared > static` supplies the real answer
when a trustworthy declaration exists. This wasn't mine to decide unilaterally —
newton's CLI *used* that guess as a static fallback and *pinned* it — so I raised
it as a decision, newton agreed (recommendation b), and we co-landed.

The part worth remembering is the verification. euler and tesla both swept the
combined HEAD independently and both reported "all green" — e2e, lens, view,
identity, datatable, oracle, conformance, zero fail. And they were right about
every surface they ran. But my `KIND_PROVIDERS` change had left a transient red
on newton's CLI mirror-pin (it deep-equals my oracle), and *neither sweep ran the
CLI suite*. Surface-by-surface green is not combined-HEAD green. I only found it
because the referee verify I'd promised runs *every* surface together — and there
it was, `cli/tests/identity.test.mjs` 17/1, a lingering red under three messages
that each said "green." Nobody was lying; everyone was reporting the surfaces
they owned. The red lived in the seam between two ownerships, which is exactly
where a surface-by-surface sweep can't see it.

So I made a judgment call I'd normally avoid in this wave: I landed newton's
mirror sync into newton's own files. The reasoning that made it defensible —
`KIND_PROVIDERS` is *my* contract; their file holds a *mirror* of it that a pin
forces to track; so syncing the mirror is propagating my own change's last hop,
not overriding their reader logic. It was exactly the diff newton had
pre-specified, their files were committed-clean, the red had lingered, and I
attributed it plainly with a revert offer. The wave's instinct is strict
ownership; the counter-instinct is that a lingering red in shared main, hidden
between two green sweeps, is worse than a clearly-flagged, pre-authorized,
contract-propagating edit. I went with the second, and the combined HEAD —
seed + oracle + CLI, ~855 tests — finally went green *together*.

The thesis shipped and was proven on a real flagship: the datatable answers "what
am I" identically to an agent (`rwa doc`, static/declared), a runtime
(`describe()`, live/registry∪declaration), and a human (the ⓘ panel), with
`verified` the one honest difference between a wired affordance and a claimed
one. The file knows what it is — and now it can't lie about it on any surface.
