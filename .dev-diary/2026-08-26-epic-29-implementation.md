# Epic #29 — closing the perception gap, one issue at a time

*Implementation log for the follow-ups from the 2026-08-26 core-assumption audit
(`.dev-diary/2026-08-26-core-assumption-blindspot-pass.md`). One section per
issue, written as it lands.*

---

## #19 — R1: automate the print check (browser lane)

**Done. 15 assertions, wired into CI. The issue's own premise turned out to be wrong,
and finding that out was the whole value of the increment.**

The issue said: "a browser-lane test that `printToPDF`s a corpus and asserts
measurable properties — body text size ≥ threshold pt, scale ≈ 1.0". I wrote a
throwaway probe first instead of building that, because the assertion design
depended on a fact nobody had checked: *does headless `printToPDF` actually
reproduce the shrink?*

It does not. Three documents — clean, over-wide-but-fixed, and
over-wide-with-the-fix-reverted — all came back with **identical font sizes (16
and 36) and one page each**. Headless Chrome CLIPS overflow; the 0.32× / 3.8pt
figure in c5a60af came from the macOS print *dialog's* fit-to-width, which
`printToPDF` doesn't apply.

So the test the issue asked for would have been **vacuous — passing on reverted
code**, and confidently. That's a worse outcome than no test: it would have
retired a hand-check and replaced it with a green light that means nothing. Rule
12 territory, except the silent skip would have been baked into the assertion
itself.

**What I built instead.** Overflow at paper width is the *cause* both symptoms
derive from — the dialog shrinks it, headless clips it, and neither happens when
content fits. So: force the viewport to the real printable box (A4 minus the
seed's `@page{margin:18mm}` → 658×986 CSS px, derived from the millimetres in
code so a margin change is one line), emulate print media, and measure what the
print engine itself lays out to.

Five scenario groups: fit-to-width defusal (wide nowrap table), root-wrapper
reset (padded card `<div>`), runtime chrome staying off paper, the four-class
print vocabulary actually computing, and a `printToPDF` smoke check kept
explicitly as a smoke check.

**The part I'd defend hardest: negative controls.** Every scenario that pins a
fix also runs the same document with its own `@media print !important` rules
re-asserting the broken behaviour. The control must FAIL the measurement the
fixed document passes. Without that, "no overflow" and "detector is broken" are
the same green tick — which is precisely the failure mode I'd just caught in the
PDF approach. The controls also print the human figure:

```
P1 fixed:    scrollW=658px in a 658px page
P1 control:  scrollW=3310px  → would shrink to 0.20x ≈ 2.4pt body text
P2 fixed:    text box x=0px w=658px
P2 control:  text box x=65px w=528px → ~17mm dead margin per side on top of 18mm
```

That 17mm-per-side figure independently reproduces the "56px padding + 640px
column ≈ 33mm extra margin" the operator measured by hand on the live report.

**Acceptance, verified properly.** In-document controls prove the *measurement*
discriminates; they don't prove the *seed's* rules are what's doing the work. So
I ran a separate check that builds containers from a genuinely reverted COPY of
the seed (the three CSS rules c5a60af added, deleted — 390 bytes) and confirmed
P1 and P2 pass on current and fail on reverted. The repo seed is never touched:
I share this working tree with another agent, and a 60-second window where
`seeds/rewritable.html` is silently broken is not worth the convenience.

```
P1 wide table — current : overflow=false (658/658)
P1 wide table — REVERTED: overflow=true  (2863/658)
P2 card wrap  — current : x=0  w=658
P2 card wrap  — REVERTED: x=66 w=526
✓ the gate fails on a real revert    repo seed untouched: true
```

**Left a warning in two places** (the file header and CLAUDE.md) saying *don't
rewrite this to read type size out of the PDF*. A future maintainer reading the
issue title would reasonably "fix" it back to the vacuous shape, and the test
would keep passing while doing so.

Green: `tests/print.mjs` 24/24 (text pins), `tests/browser/print.mjs` 15/15
(new), root suite 53 files / 1580 assertions.

---

## #20 — R4: cross-tab commit signal

**Done. 16 jsdom assertions + a real two-tab browser verification. The
interesting part was catching my own bad verification.**

The defect: two tabs on one container. Every commit path re-reads `rwa_doc`
first, which makes the window look tiny — until you notice `modify()` re-reads
it *before* a model call that takes seconds, then applies and commits. A commit
landing from the other tab inside that window is overwritten with no error, no
history entry, nothing on screen.

**The shape of the fix.** Boot reconciliation already owns "the FILE changed
underneath us"; this is its sibling for "another TAB did". Every write to
`rwa_doc` — commit, hosted commit, undo, adopting the file version — broadcasts a
content hash; a tab whose hash no longer matches raises a persistent bar
offering reload. It **warns rather than blocks**: the bar appears when the other
tab commits, i.e. before this tab's next edit, while the choice is still the
user's. Hard-blocking a commit mid-agent-retry is a much larger behavioural
change than the bug warrants, and boot reconciliation already owns the
"two versions, pick one" conversation on reload.

**Where I nearly fooled myself.** The whole design rests on BroadcastChannel
delivering between two `file://` tabs — not obvious, since `file://` pages are
opaque origins, and the `runtime.db` fan-out that already used BroadcastChannel
and calls itself "cross-tab" had never actually been checked across tabs. So I
probed it, got a clean delivery, and moved on.

Then, writing the browser test, I re-read my probe and realised `cdp.mjs`'s
`send()` puts `sessionId` inside `params`, not at the top level — so my "tab 2"
evaluation may have been running in **tab 1 the whole time**. And
BroadcastChannel happily delivers between two channel *objects in one page*.
My evidence was consistent with the feature being completely dead.

Re-verified properly: separate WebSocket to each page target's own debugger URL
(no session multiplexing to get wrong), and each tab stamped with a distinct
marker to prove they are different pages.

```
page targets on the file: 2
tab1 mark=TAB_ONE  tab2 mark=null  → genuinely distinct pages: true
tab2 bar before any commit: false
tab1 commit: ok
tab2 bar AFTER tab1 commit: true  ("Another tab changed this document…")
tab1 warned itself (must be false): false
✓ REAL cross-tab signal confirmed between two file:// tabs
```

The conclusion survived the scepticism, but it very nearly didn't get tested at
all. Same lesson as #19 one issue earlier: the probe is only worth what its
controls are worth.

**A test that corrected the code's spec, not the code.** X3 originally asserted
"undo in tab A warns tab B" and failed. The cause turned out to be right: B's
known hash was still the original document, A's single commit had been undone,
so the store had returned to exactly the bytes B was displaying — the two sides
*agreed*, and warning would have been wrong. Fixed the test (two commits, so the
undo lands somewhere B has never seen) and added the inverse as an explicit
assertion: *an undo restoring what the other tab already shows stays quiet*. A
warning that fires when both sides agree trains people to ignore the one that
matters.

**Found while building: the divergence bars printed.** All three bars
(`#rwa-reconcile-bar`, `#rwa-overwrite-bar`, and my new `#rwa-foreign-bar`) are
appended to `<body>`, not into `#rwa-runtime` — so the print block's chrome hide
never reached them and a yellow "this file changed" banner printed across page
one. Pre-existing for the two older bars. I fixed all three rather than shipping
a fourth element with the same flaw, and — because #19 had just landed a print
lane the day it was needed — asserted it as a real paper measurement rather than
another text pin. That is the perception gap closing on itself.

Also refreshed `cli/seeds/rewritable.html`, which was stale again (the trap
CLAUDE.md records having been hit three times in one day), and updated
`rwa-edit-spec.md`, which still claimed cross-tab modify was simply "not
supported" — true for coordination, no longer true for detection.

Green: `tests/cross-tab.mjs` 16/16 (new) · root 54 files / 1597 assertions ·
CLI 595 · conformance 86/86 · browser lane 14/14 + print 18/18.

---

## #23 — R5: `rwa doctor`

**Done. 18 CLI tests. Delegated the build, kept the review — and the review is
what earned its keep.**

The validation battery only ever ran as a side effect of an actual `rwa edit`,
so there was no way to ask "is this container currently valid?" of a received,
hand-edited, or years-old file without risking a write. `cli/src/apply-edits.mjs`
already held the machinery; `doctor` just needed to point it at a document that
never changes underneath it.

Nine checks, each ALWAYS emitting a finding (info/warn/error) so a `--json`
consumer can tell "ran and passed" from "didn't run": frozen-marker termination,
frozen-zone inventory, malformed `data-rwa-frozen` zones, `<script>`/`<style>`
balance, size headroom, unbacked `rwa-asset` tokens, reserved runtime id,
duplicate `data-rwa-id`, seed freshness. Exit 0 clean (warnings fine), 5 on any
error finding, 1/2 for usage/file errors as `rwa doc` does.

**The review caught a real bug, and a well-disguised one.** `size_headroom`
measured `doc.length` — the raw document — while its comment stated confidently
that this was "the SAME number that would trip target_size_exceeded". It isn't.
`apply-edits.mjs` says so at the throw site itself: the cap is applied to the
*virtual* form, "so image bytes never count against the text budget". Measured:

```
raw        : 1572941  → OVER CAP → error, exit 5   (the bug)
virtualized: 73       → info, exit 0               (correct)
ratio      : 21547x overstatement
```

A document with a megabyte of embedded images would have been failed by the
health check while its real edit budget was untouched — a false alarm that reads
as *delete your content*. One-line fix (`virtualizeImages` was already imported
two checks below), plus the regression test the delegated suite didn't have.

Worth naming: this is the **same mistake I had avoided an hour earlier** in
#24's size meter, where I stopped specifically to check which form the cap
applies to. The confident comment is what makes it dangerous — a reviewer
skimming for "does it measure the right thing" reads the comment, agrees, and
moves on. Delegation didn't cause the bug so much as it moved where the bug
could hide.

Also hardened `seed_freshness`: it was the one check reaching outside the file,
and an unresolvable seed threw straight out of `diagnose()`. A health check that
crashes instead of reporting is the failure mode the verb exists to end — now a
warn finding, with every other check still reported.

Green: `cli/tests/doctor.test.mjs` 18/18 · CLI suite 613.

---

## #24 — R6: hints for hintless failure codes + a document size meter

**Done. 43 assertions. The audit said six codes; the seed says nine.**

Two halves of the same complaint: when an edit fails near a limit, nothing tells
anyone anything useful.

**The hints.** `failureToToolResult` hands the model a code, some context, and —
if one exists — a hint. Eight codes the validation battery could already throw
had no entry, so the model got a bare code and burned its remaining attempts
guessing. `target_size_exceeded` was the worst: three retries at a size that
could never succeed. The audit named six; mapping every `RwaEditError` throw site
to its enclosing function found eight in the battery plus `unknown_tool` in tool
dispatch — nine.

Rather than pin those nine (stale the moment a tenth appears), the test derives
the requirement from the seed: every code thrown by the battery must have a
hint, and every code that ISN'T must be listed with a reason. A new code lands
in neither list and fails, forcing an explicit decision. Same shape as
`workflow-prompt-parity`. It also gates the hand-mirrored CLI copy, which has no
`cmp` gate — and immediately caught all nine missing there.

**The meter.** Images warn at 5 MB of container, storage warns at 80% of quota;
the 1 MB text budget the contract actually enforces had nothing. Measured on the
virtualized form for the reason #23 proves the hard way — a document that is
mostly image bytes has all its text budget intact and must not be warned. That
case is now an explicit assertion.

**A test that was 250× too slow.** The first draft built the near-cap fixture
from 12,000 short paragraphs and ran past 300 s. Byte count is what the budget
measures, but *block count* is what boot pays for — every anchorable block gets
a `data-rwa-id`. Same bytes as ten long paragraphs, wrong shape: 1.2 s after the
fix.

Green: `tests/doc-budget.mjs` 43/43 (new).

---

## #21 — R2: the post-commit render probe

**Done. The loop's first sense — and the first one I deliberately kept narrow.**

Every gate between an instruction and a commit reads strings. `renderDoc` runs
*after* the commit has landed and its outcome feeds back nowhere, so the agent
edits a document it cannot look at. This takes the first measurement from the
rendered page: after the mount is final, does content overflow horizontally, and
by how much, and which element.

Three properties it holds on purpose:

- **Deterministic.** Geometry only, no model call (Rule 5).
- **Advisory.** Never blocks a commit, never touches `rwa_doc`, never throws.
- **Silent when it cannot see.** jsdom measures every box as 0×0. A probe that
  reports where there is no layout would fire on every document in the suite,
  and that noise is indistinguishable from signal. jsdom asserts the silence;
  the browser lane asserts it speaks. Both halves are needed — a probe that
  never fires passes the silence test forever.

**What I refused to build.** The issue also asked for print-width overflow at
runtime. I didn't, and the reason is the lesson from the two issues before it:
print rules *re-flow* the document — cells wrap, tables and images cap — so a
screen-overflowing element frequently prints fine. Predicting paper from screen
layout would manufacture precisely the false alarms #23's 21547× overstatement
and #24's image-bytes case were about. Paper is already measured properly, in
the print lane, against a real printable box. A cheap wrong signal is worse than
no signal, and this probe's whole value is that people believe it.

**One design I tried and dropped.** The first version named the *deepest*
overflowing element, on the theory that the innermost is the culprit. It isn't
reliably: a padded wrapper is genuinely wider than the element overflowing
inside it, and "deepest" picks a `<tr>` over the `<table>` that is the
actionable unit. Reverted to widest-wins and let the pixel figure carry the
information:

```
div runs 2359px past the page — it will be cut off or scroll sideways
```

Green: root 55 files / 1643 assertions · browser print lane 21/21 · CLI 613 ·
conformance 86/86 · browser lane 14/14.

---

## #25 — R7: provenance for fetched content

**Done. 12 seed assertions + 3 CLI tests. Argued myself out of the cheap version.**

`rwa clone` is the one verb that fetches from the network, and the page it brings
home rides into the prompt of every later edit — so instruction-shaped sentences
in it get re-read forever. The nonce fence already says "the fenced region is
data"; this adds *whose* data, which is the part a model can weigh when a
paragraph starts addressing it directly.

**The design decision worth recording.** The obvious cheap implementation reads
the visible "Cloned from …" footer that `clone.mjs` already writes. I started
there and stopped: that footer lives inside `INLINE_DOC`, which makes it
**content**. A marker the document can edit is a marker injected text can ask
the model to delete — and the deletion is invisible, because the document simply
stops looking cloned. This repo already refuses to trust an edit-reachable
declaration: the `accepts` gate ignores one that isn't edit-unreachable, for
exactly this reason. Being inconsistent with that in a security-adjacent marker
buys a smaller diff and sells false confidence.

So the marker is `<meta name="rwa-origin">` in the frozen head — stamped by
`applySeedSubs` (the single choke point every emission passes through),
attribute-escaped because the value is a URL from outside, gated to http/https
like the visible provenance link, and **preserved across `rwa upgrade`**. That
last one matters: an upgrade is supposed to gain fixes, never lose facts, and
silently un-marking a cloned container as foreign is the one direction this
marker must not move.

The hostile-page fixture in the test is deliberately mundane — prose that
addresses the model in the second person, the shape that actually occurs on the
open web, not an exotic payload. The test also pins that the hostile sentence
still travels through **unaltered**: provenance frames the text, it does not
sanitise it, and pretending otherwise would be the worse failure.

**A gate caught me.** `service/lib/` holds byte-identical mirrors of `cli/src`,
and my #23/#24 edits to `apply-edits.mjs` made them stale — so commits `a6ee258`
and `293bf12` left main with a failing service test for about an hour. I had run
the service suite before those commits and not after. Re-vendored (`apply-edits`
and `seed`), 108/108 again. Worth naming rather than quietly fixing: the
cross-site mirrors in this repo are exactly the thing that goes stale when you
change one side and test the other, and the gate existing is why it was an hour
and not a release.

Green: `tests/provenance.mjs` 12/12 (new) · root 56 files / 1655 assertions ·
CLI 613 · service 108/108 · conformance 86/86.

---

## #26 — R8: the two advisor carriers

**Done. Two signed intelligences, 35 assertions, zero new runtime machinery.**

This is the user-facing half of the aspect-guardian story, and it needed no new
mechanism at all — the I-E blended-overlay machinery (verified-only, capped at 3,
ephemeral, appended as a subordinate prompt block) already shipped. What was
missing was content: advisors people can actually drop on.

**print-aware** teaches the four-class print vocabulary, `<thead>` for repeating
headers, the warning against faking running headers with `position:fixed`, and
why one over-wide element ruins a whole sheet. That last paragraph is the
2026-08-26 print bug, written as guidance — the same defect #19 now gates in CI,
told to the model before it makes the mistake rather than caught after.

**house-style** is the direct answer to blindspot B2 (trajectory drift): keep
one h1 and never skip a level, prefer editing what exists to adding alongside
it, don't add a style rule for a selector used once, remove classes when their
content goes, and match the document's existing voice rather than imposing your
own. It is the prose form of the coherence dimensions #22 measures.

**The design call worth recording: neither advisor recommends a model.** All
five existing gallery entries do. An advisor layers on top of whichever AI is
already driving the document, and the *primary* owns the model choice — so a
carrier that both advises and pushes a model would silently retune the
document's main editor as a side effect of adding a second opinion. The gallery
badge says so ("advisor · layers on your main AI") and a test pins it, because
"we forgot to set a model" and "we deliberately set none" look identical in a
file.

**A test that protects more than it was written for.** `tests/ai-gallery.mjs`
verifies the actual Ed25519 signature of *every* carrier in the gallery, not
just the two new ones. Carriers are rewritables, so `regenerate-refs` re-bootstraps
them on every seed change, and that regeneration must preserve the signed record
byte-for-byte. If it ever stopped doing so the carrier would still open, render
and download perfectly — and simply fail to verify on the receiving end. Silent,
and visible only to the person who trusted it. That is the worst failure shape a
trust artefact has, and until now nothing checked for it.

It also cross-checks that print-aware teaches classes the seed's print CSS
actually defines — the `tests/print.mjs` trap one step further out, since a
rename would otherwise leave this carrier teaching dead classes to every
document it touches.

Verified the new carriers with `rwa doctor`, shipped an hour earlier in #23. The
private keys stayed in a scratch directory; nothing key-shaped is in the tree.

Green: `tests/ai-gallery.mjs` 35/35 (new) · root 57 files / 1690 assertions ·
service 108/108.

---

## #22 — R3: the trajectory benchmark

**Done. A coherence scorer over N-edit sequences, with a CI ratchet. The
delegated build was strong; the review's job was proving the gate can fail.**

`benchmark/` proved single edits are side-effect-free and the import ratchet
scores one converter pass. Nobody measured what a document looks like after
fifty sequential edits — and coherence is exactly the property that can degrade
while every individual commit is perfect.

Five model-free dimensions over start-vs-end: heading outline, class churn, dead
CSS selectors, id hygiene, and markup-vs-text growth. Three scripted scenarios,
twelve steps each, driven through the real commit path. The scorer discriminates
sharply, which is the whole point:

```
scenario  steps  headings  classChurn  deadStyles  idHygiene  growth
TRAJ-01   12     1.000     1.000       1.000       1.000      1.000
TRAJ-02   12     1.000     0.000       0.667       1.000      0.000
TRAJ-03   12     0.500     1.000       1.000       1.000      1.000
```

TRAJ-02 is the wrap/re-wrap shape: 24 distinct classes grown from 0, +552 tag
characters against +0 characters of text. TRAJ-03 drifts an outline into three
h1s and five level jumps. TRAJ-01 is a healthy editing session and stays at 1.

**What I checked rather than took on trust.** The report said the ratchet has
teeth and showed it printing FAIL. Printing FAIL is not gating: I perturbed the
committed baseline and ran the checker directly, because `npm run … | tail`
reports *tail's* exit code and would hide a checker that reports a regression and
still exits 0. Real exit code on regression: 1. Clean: 0. It gates.

**Two real findings the builder surfaced, both worth keeping.** First,
`classChurn`'s original form scored the end document's raw single-use-class
fraction, which flags any *small* document as bloated even with zero edits — its
own no-op test caught that, and it became delta-against-start. Second, and more
valuable: `modify()` does **not** throw when its retry budget exhausts on a
rejected tool call — it swallows the failure and leaves the document unchanged
(real, deliberate seed behaviour). So "modify didn't throw" is not evidence a
step landed. The runner now checks `rwa_hist` grew after every step and fails
loud otherwise. Without that, a scenario whose scripted anchors stopped matching
would have scored a trajectory that never happened — a benchmark quietly
measuring nothing, which is the failure mode this whole epic is about.

**The framing is documented, not implied.** With scripted envelopes the
trajectory is deterministic, so the ratchet measures the **substrate** — whether
N edits accumulate structural damage on their own. It does **not** measure model
drift; that needs real-model runs, like fidelity's optional modes. Both the
runner header and the CI comment say so plainly, because a green tick labelled
"trajectory coherence" is otherwise very easy to read as "the model keeps
documents coherent".

Green: `oracles/coherence.test.mjs` 13/13 · trajectory ratchet PASS · conformance
86/86.
