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
