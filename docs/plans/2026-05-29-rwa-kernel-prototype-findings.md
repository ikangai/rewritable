# rwa affordance/skill kernel — prototype-validation findings

*2026-05-29. Findings from prototyping the smallest end-to-end kernel slice —
`presentation` as a single first-party `view` provider — against the real
runtime in `seeds/rewritable.html`, BEFORE the provider taxonomy in
`docs/plans/2026-05-29-rwa-affordance-skill-kernel-design.md` is hardened into a
spec. This is a learnings record, not a design change: it does not edit the
kernel doc or the seed. Its job is to feed corrections back into the kernel doc's
open items (lines 170-186) before code or spec is committed. Verdicts below were
produced across four review lenses (invariants, security, write-path, render) and
ground-truthed against the seed line-by-line; line numbers here are re-verified
against the current `seeds/rewritable.html`.*

---

## 1. Summary

The `view` kind IS the correct smallest slice, and the core registration-API
decision survives contact with the runtime: a declarative `view` spec with a
single pure `render(doc) → html` slot drops into the existing
`m.innerHTML = html` seam at `seeds/rewritable.html:849`, registered via two new
`window.runtime` members (`provide`, `setView`) added to the plain object literal
at `:3694`, touching zero writer code in the success-path sense. What did NOT
survive is the slice's confidence that the render path is a clean, isolated seam:
the render path is **fused** to the agent-context source map (`setSourceMap` at
`:866`), to the click-to-anchor ordinal walks (`:2179`, `:2201`), to form-state
round-trip (`:843-861`), and — via the script re-execution loop at `:850-855` —
to arbitrary main-thread code execution with no CSP. The slice's two strongest
claims ("zero writer code touched" and "click-to-anchor cleanly suspended") are
both false as written, and one is a blocker. The taxonomy should NOT be hardened
until the `view` contract is rewritten to be (a) agent-invisible *by
construction* rather than by parameter-naming discipline, (b) self-contained
against the form-state/post-mount/print seams the slice assumed it inherited "for
free," and (c) honest that `compute`/`edit-surface` write-path ordering — which
this slice cited but did not exercise — is *not enforceable* at the seam the
kernel doc assumes (kernel doc lines 94, 102-103).

## 2. What survived contact with the real runtime

These are confirmed-correct and should be carried forward into the spec as
validated decisions:

- **Declarative-for-`view`, not imperative callbacks.** The render path is
  already a "give me HTML, I mount it with capture/restore/script-rerun"
  pipeline (`seeds/rewritable.html:829-873`). A pure `render(doc) → html` slot is
  the right shape; a free callback bag would force every provider to re-derive
  *when* to render. No correction.
- **`runtime.provide` as a new top-level member, not a new event type.** The
  event registry (`runtimeEvents`, `:728-732`) is a static whitelist; a `view` is
  a render-strategy swap, not an event subscriber. Adding members to the literal
  at `:3694-3715` is correct. (See §3 for the one false *reason* attached to this
  correct conclusion.)
- **Agent invisibility of the provider code itself.** Provider code is
  bootstrap-resident in `FROZEN`, never serialized into `INLINE_DOC` (`buildFile`
  rewrites only the `INLINE_DOC` literal body, `:902-922`), never in IDB. The
  agent prompt is built from `getDoc()` text + frozen-zone names only. The
  *provider* is structurally invisible. (The provider's *output* is a separate,
  unsolved problem — §3, security lens.)
- **Persisted-doc / `data-rwa-id` / frozen-zone invariants hold.**
  `injectMissingBlockIds` (`:2836-2868`) and `commitDoc` backfill operate on the
  doc *text* via regex surgery; they never read the live mount. Slide `<section>`
  wrappers exist only in the mounted DOM, so commit and `data-rwa-id` backfill
  never see them. This is a genuine non-issue — but the slice's stated *reason* is
  wrong (§3).
- **The synchronous `activeView` read inside `renderDoc` is race-free.**
  `renderDoc` is fully synchronous (`:829-873`, no `await`); `setView` mutates
  `activeView` in a separate task. No interleaving. The slice's insistence that
  `render` stays synchronous (forbidding async `render`) is exactly what keeps
  this safe — carry forward.
- **A view is byte-identical to today when `activeView === null`.** The toggle
  model (additive, gated branch) means the inactive path is unchanged. Correct.

## 3. Confirmed blocker / major issues and the design changes they force

Grouped by review lens. Each is real (verified against the seed), with the design
change it forces.

### Invariants lens

**[BLOCKER] Source-map / ordinal desync is NOT mitigated by "suspend the click
listener."** `renderDoc` unconditionally calls `setSourceMap(html)` (`:866`) and
`rebuildLockedRanges(html)` (`:867`) on the raw doc text, while the live mount is
section-wrapped. `liveNodeForEntry` (`:2201-2221`) and `anchorableOrdinal`
(`:2179-2195`) walk the **live mount** with outer-wins descent; if
`wrapIntoSlides` reorders content, the *i*-th live anchorable no longer
corresponds to `sourceMap[i]`. Critically, the write path is **not** untouched:
`runAnchoredCommand` calls `renderDoc(result)` (`:2548`) then
`handlePostCommitAnchor` → `anchorTo` → `liveNodeForEntry` (`:2566`, `:2230`)
against the wrapped DOM. A held anchor that survives a view switch (the slice
never clears `lensState.anchor`) re-anchors against a reordered mount → wrong
block highlighted or mis-spliced edit.
*Design change forced:* the `view` contract must (a) `releaseAnchor()` on
`setView` into any whole-mount view, (b) gate `handlePostCommitAnchor`/`anchorTo`
on `activeView === null`, and (c) **forbid `render` from reordering** (1:1
wrap-in-place only — `SECTION` is non-anchorable, so document-order section
nesting is transparent to the ordinal walks, see render lens) OR build a
view-aware ordinal map. "Skip the click listener" alone is insufficient because
the anchored-modify render path bypasses that guard entirely.

**[MAJOR] The slice's *reason* for invariant preservation is wrong (right answer,
wrong mechanism).** §4 of the design claims `data-rwa-id` survives because
"render only ADDS `<section>` wrappers, attributes ride along." That is not the
mechanism: `render` output is assigned to `m.innerHTML` (`:849`) and **thrown
away** — it never reaches IDB. Preservation is guaranteed because `render` output
is mount-only and `commitDoc` (`:2890`) operates on the doc *text*, independent
of render.
*Design change forced:* restate the mechanism as "render output is display-only
and structurally never read back into `currentDoc`," and make that a hard
contract clause ("`render(doc) → html` is a one-way transform; its output MUST
NOT be read back into `currentDoc`"), asserted at the C2 seam.

**[MAJOR] Form-state capture/restore breaks if `render` reshapes which elements
exist.** `renderDoc` captures id-keyed form values from the old mount
(`:843-848`) and restores by `m.querySelector('#'+id)` into the new mount
(`:856-861`). This survives only if every id-keyed element is present in the DOM
on every render. A natural deck optimization — render only the active slide —
silently drops other slides' input values, reproducing the APP-01/APP-02
regression the capture code exists to prevent.
*Design change forced:* hard rule in the `view` contract — `render` MUST emit ALL
id-keyed interactive elements into the mount on every render (may hide via CSS;
must not omit from DOM). Not an optional note.

### Security lens

**[MAJOR] `render` output is privileged-executed; the "free" script-rerun is the
isolation hole.** `m.innerHTML = html` at `:849` is immediately followed by a
loop (`:850-855`) that recreates and executes EVERY `<script>` in the mounted
HTML. There is no CSP in the seed (verified: zero matches). So a `view`'s
`render` output — including arbitrary `<script>` — runs with full main-thread
privileges (reaches `runtime.db`, `runtime.fs`, the API key in sessionStorage).
For first-party presentation this is fine, but the design frames inheriting
script-rerun "for free" as a pure win and never names that this is exactly why a
third-party `view` is un-sandboxable: it is arbitrary code-exec by construction,
not merely "DOM UI."
*Design change forced:* name the concrete mechanism (script-rerun at `:850-855`,
no CSP) wherever the kernel doc says `view`/`edit-surface` "cannot be
Worker-isolated" (kernel doc lines 63-70). The installed-path install-dialog
disclosure (kernel doc lines 66-67) must read "this skill can run arbitrary code
on the page," not the softer "renders its own UI." Additionally, since
presentation has no need to emit scripts, the first-party `view` contract should
strip/neutralize (or assert-absent) `<script>` in `render` output, so the
contract a future third-party path inherits is "no scripts" rather than "all
scripts run" — matching CLAUDE.md Rule 12 (fail loud).

**[MAJOR] Agent anchored-context invisibility is by convention, not by
construction.** The anchored prompt is built from `currentDocCache`, set by
`setSourceMap(html)` at `:866` (cache assignment at `:1903-1905`).
`buildAnchoredContextWindow` (`:2040`) slices `currentDocCache`; `resolveAnchorFind`
(`:1989`) reads it to compute the `find` splice. The slice's C2 introduces
`out = activeView.render(html)` and keeps `setSourceMap` on `html` — correct as
written, but one keystroke from catastrophic: the idiomatic transform shape is
`html = activeView.render(html)` (reassigning the parameter), which would feed
slide-wrapped HTML into `setSourceMap`. The agent would then see
`<section class="rwa-slide">` wrappers in its context (a breach of "agent sees
only document text," `re-write-able-spec.md:86`) and emit `find` strings absent
from `rwa_doc`.
*Design change forced:* make agent-facing source structurally independent of the
view. `renderDoc` should take `(docText)`, compute
`const mountHtml = activeView ? activeView.render(docText, ctx()) : docText;`,
assign that to `innerHTML`, but call `setSourceMap(docText)` /
`rebuildLockedRanges(docText)` on `docText`. Add a test asserting that with an
active view, `currentDocCache` contains no `rwa-slide` substring. Convert
"invisible by convention" into "invisible by construction."

**[minor, but record] `viewCtx` over-exposes.** The slice's `ctx` is
`{ docUuid, status, frozenZoneNames }`, yet presentation (splits on
headings/`<hr>`) needs none of them. Handing frozen-zone topology to a render
provider is a new read surface that contradicts the kernel's "capability: none"
binding (kernel doc line 51) and CLAUDE.md Rule 2 (nothing speculative).
*Design change forced:* trim `ctx` to what the one provider consumes (`docUuid`
at most). Decide frozen-zone read surface explicitly when the installed path is
designed, not by first-party convenience inheritance.

**[minor, but record] "capability: none" is aspirational, not enforced.** A
main-thread first-party `view` shares the bootstrap closure and can reach
`runtime.modify`/`db`/`fs`. The binding (kernel doc line 51) is a convention.
*Design change forced:* state this honestly in the spec; optionally add a
`rendering` re-entrancy guard so a buggy `render` that calls `modify` fails loud
rather than mutating mid-render.

### Write-path lens

**[MAJOR] The flush-before-agent-modify ordering the kernel cites is NOT
enforceable at the seam this slice promises not to touch.** The kernel doc claims
flush "acquires `modifyMutex`, so it cannot race the agent; the
before-agent-modify boundary guarantees ordering" (lines 94, 102-103). But
`modify()` acquires the mutex at `seeds/rewritable.html:3313` and reads
`getDoc()` at `:3320`; there is no atomic flush-then-acquire seam between "called"
and "mutex held." Worse, `modify()` dispatches to the bridge at `:3297`
(`return modifyViaBridge`) **before** the mutex check at `:3308`, so any
top-of-`modify` flush hook is bypassed on the bridge backend.
*Design change forced (NOT for this slice — for the next kind):* either retract
the kernel's ordering guarantee and mark it a known design hole, OR refactor
`modify()`/`modifyViaBridge()` to take the mutex at one shared entry (before the
`:3297` bridge branch) and run `await flushPendingOverlays()` inside the held
mutex (reusing it, not re-acquiring — requires a reentrant commit path so flush's
`commitDoc` does not re-check the boolean). The kernel cannot honestly claim "the
write path is untouched" AND "ordering is enforceable."

**[MAJOR] `setView` re-render races an in-flight `modify()` (TOCTOU on
`getDoc()`).** `setView` is user-triggered, takes no mutex, and does
`renderDoc(await getDoc())`. `modify()` holds `modifyMutex` from `:3313` but does
not write `rwa_doc` until `commitDoc` (`:2904`) at the end. If the user toggles
mid-modify, `setView` renders the stale pre-edit doc as slides; if `modify()`
then THROWS on retry exhaustion (`:3411` does NOT `renderDoc`), the stale-doc
slide view is the final state with `activeView` set but never reconciled.
*Design change forced (for THIS slice):* guard `setView` like `undo` does —
`if (modifyMutex) { setStatus('err','✗ modify in progress'); return; }` (mirror
the guard pattern; `undo` and `runAnchoredCommand` both check `modifyMutex`,
e.g. `:2504`). State this in the view-activation contract.

**[minor, but record] The `:849` seam is proven for read-only views ONLY.** The
kernel's write-path model keeps uncommitted `edit-surface`/`compute` edits in a
"tracked live overlay" (kernel doc lines 88-90); `renderDoc` is full-replace and
blows away the mount, and the form-capture mechanism round-trips only id-keyed
*values* (`:844`), not overlay annotations / compute decorations / half-typed
cells. The slice's per-view sessionStorage workaround for slide index is bespoke,
not a kernel mechanism.
*Design change forced:* scope the claim — the seam is validated for read-only
views; a view/edit-surface owning uncommitted transient DOM needs a
`renderDoc` capture/restore hook that does not exist yet. That hook, not the
`:849` branch, is the real `edit-surface` risk.

**[minor, but record] Undo granularity: slide index diverges from the doc undo
timeline.** `undo()` (`:3565-3580`) pops `rwa_undo` and `renderDoc(p)`,
re-deriving slide boundaries from the reverted doc; the sessionStorage slide
index was computed against the post-edit doc. If the undone edit added/removed a
heading/`<hr>` boundary, the index mis-positions the deck.
*Design change forced:* clamp the restored index to `[0, slideCount-1]`, or key
restore by the stable `data-rwa-id` of the slide-starting heading (which IS
undo-consistent). "Ephemeral" is the wrong word for a content-derived coordinate.

### Render lens

**[MAJOR] `render` returns a string but there is no post-mount seam to restore
slide-index UI state.** `render(doc)` returns the same full HTML every time; the
slice's sessionStorage slide index has nowhere to be consumed — `renderDoc`'s
only post-mount work is form-restore/script-rerun/source-map/listener. After
every modify/undo the deck snaps back to slide 0. The form-state-capture parallel
the design invokes actually *disproves* the claim: form state survives because
`renderDoc` has explicit post-mount restore code; the view has no equivalent.
*Design change forced:* add an optional post-mount provider callback to the spec
and to `renderDoc` — after `m.innerHTML` and after script-rerun/form-restore,
`if (activeView && activeView.mounted) activeView.mounted(m, ctx())`. `render`
stays the pure string slot; `mounted()` is the impure DOM-touch slot (read
sessionStorage index, add `.active`, `scrollIntoView`). This makes §2.2's
sessionStorage restore reachable.

**[MAJOR] Print fallback claim is false: the lens escapes `#rwa-runtime`.** The
print block hides only `#rwa-runtime` (`:171`); there is no `#rwa-lens` print
rule (verified). The lens starts inside `#rwa-runtime` (hidden transitively) but
`releaseAnchor` does `document.body.appendChild(lens)` (`:2270`), permanently
reparenting it to `body` after any anchor cycle. The design's chrome()-placement
guidance ("in `#rwa-runtime` ⇒ hidden in print ⇒ free") rests on this false
premise, and a deck is exactly what users print.
*Design change forced:* (1) add `@media print{ #rwa-lens{display:none!important;} }`
near `:171` (a pre-existing bug, independent of this slice); (2) the `view`
contract must not trust transitive hiding — provider chrome needs an explicit
`@media print` hide. Drop the "for free" claim in the design.

**[minor — actually relaxes the blocker mitigation] `SECTION` is non-anchorable,
so wrapping is transparent to the ordinal walks.** `ANCHORABLE_TAGS` (`:264`)
excludes `SECTION`; both ordinal walks recurse *through* non-anchorables and only
count anchorables (`:2185`, `:2213`). So wrap-in-place (no reorder) does NOT
desync ordinals — only `buildAnchoredContextWindow`'s byte-offset slice (`:2040`)
needs the suspend.
*Design change forced:* state in the contract that `render` MUST NOT use any
`ANCHORABLE_TAGS` element as a wrapper (`SECTION` safe; `ASIDE`/`FIGURE` not) and
MUST preserve every block's `data-rwa-id`. This narrows the §3 blocker fix:
1:1 wrap-in-place in `SECTION` keeps ordinals aligned; only the context-window
byte slice must be suspended.

**[minor] `LENS_CLICK_TO_ANCHOR` is a `const` and cannot be the runtime toggle.**
The slice says "skip the click listener" but `LENS_CLICK_TO_ANCHOR` (`:229`) is a
build-time const read at `handleMountClick` (`:2148`). Runtime suspension needs
NEW mutable state (`let anchoringSuspended`), and the slice under-enumerates its
read sites: `handleMountClick` (`:2142`), the lens-submit dispatch, and
`runAnchoredCommand` (`:2504`) — the last reachable from a stale `lensState.anchor`
even with no fresh click.
*Design change forced:* name the variable and enumerate all three read sites in
the contract; on entering a suspending view, set `anchoringSuspended = true` AND
`releaseAnchor()`.

**[minor] "frozen-shape `window.runtime`" is factually wrong.** §1.2 / C4 claim
the object is "frozen-shape at bootstrap (`:3694`, confirmed)." Verified: there is
NO `Object.freeze` in the seed; the literal at `:3694-3715` is plain, and only
`status` is `configurable:false` via `defineProperty` (`:3719-3722`).
*Design change forced:* correct the premise to "plain (non-frozen) object literal;
only `status` is non-configurable." The conclusion (add `provide`/`setView` as
literal members) is unaffected — but the false "confirmed frozen" claim
undermines the deliverable's credibility as a verified validation, and would
mislead an implementer into thinking post-hoc assignment throws. If sealing is
desired, `defineProperty` the new members `configurable:false` like `status`.

**[minor] `render` output must not contain reserved ids.** `m.innerHTML = html`
would create a duplicate `#rwa-lens` if a deck author copies such markup;
`getElementById('rwa-lens')` returns the first in document order, silently
breaking lens identity.
*Design change forced:* contract clause — `render` output MUST NOT contain
reserved ids (`#rwa-lens`, `#rwa-set*`, `#rwa-runtime`, `#rwa-doc-mount`) or
reserved marker substrings (the same constraint `apply_edits` already enforces).
Validate once at `provide`/`setView` time (cheap `indexOf`) and throw fail-loud.

## 4. Concrete recommended edits to the kernel design doc

These target `docs/plans/2026-05-29-rwa-affordance-skill-kernel-design.md`. The
slice document (the design deliverable) is the prototype write-up; these edits
harden the **kernel doc** (the taxonomy/contract that becomes a spec) with what
the prototype learned. Each quotes the section and states the exact change.

1. **Open item "Render-mode contract (R4)" — lines 175-177.** Currently:
   > **Render-mode contract (R4)** — how a `view` owns a mount and re-renders,
   > replacing/coexisting with the current single-mount full-replace. Touches
   > the bootstrap render contract → spec amendment before code.

   Change: replace the single bullet with the validated contract clauses the
   prototype established, namely — (a) `render(doc) → html` is a one-way,
   synchronous, display-only transform whose output MUST NOT be read back into
   `currentDoc`; (b) the agent-facing source (`setSourceMap`/`currentDocCache`)
   MUST derive from `docText`, never from the mounted value (invisible by
   construction); (c) `render` MUST emit all id-keyed elements every render and
   MUST NOT reorder, use `ANCHORABLE_TAGS` wrappers, strip `data-rwa-id`, or emit
   reserved ids/markers; (d) a separate optional `mounted(m, ctx)` post-mount
   slot owns transient UI state; (e) `setView` MUST guard on `modifyMutex` and
   `releaseAnchor()` on activation. Note explicitly that "suspend the click
   listener" is insufficient and that the anchored-modify render path
   (`:2548 → :2566`) must be gated on `activeView === null`.

2. **Taxonomy table — line 51 ("**view** … none — pure render of doc state").**
   Append a footnote/qualifier: for a main-thread first-party `view`,
   "capability: none" is an unenforced convention — the provider shares the
   bootstrap closure and can reach `runtime.modify`/`db`/`fs`; enforcement
   requires passing only `docText` + a frozen read-only `ctx` and not closing
   over runtime writers, or a re-entrancy guard. Do not present the binding as
   runtime-enforced.

3. **"Load-bearing finding: thread-affinity gates trust" — lines 63-70.**
   Currently the disclosure is:
   > the install dialog must say so explicitly ("this skill renders its own UI on
   > the main page and cannot be isolated").

   Change: name the concrete mechanism and strengthen the disclosure wording. Add:
   "The mechanism is unconditional: `render`/`edit-surface` output flows through
   `m.innerHTML` + the script re-execution loop (`seeds/rewritable.html:850-855`)
   with no CSP, so it is arbitrary main-thread code execution, not merely 'DOM
   UI.' The install-dialog disclosure for a third-party `view`/`edit-surface`
   must read 'this skill can run arbitrary code on the page,' not 'renders its own
   UI.'"

4. **Write-path — lines 102-103.** Currently:
   > Flush **acquires `modifyMutex`**, so it cannot race the agent; the
   > before-agent-modify boundary guarantees ordering.

   Change: this is NOT enforceable at the current `modify()` structure. Replace
   with a flagged design hole: "`modify()` acquires the mutex at
   `seeds/rewritable.html:3313` after dispatching the bridge backend at `:3297`,
   and there is no atomic flush-then-acquire seam. Enforcing the
   before-agent-modify boundary requires refactoring `modify()`/`modifyViaBridge()`
   to take the mutex at one shared entry (before `:3297`) and run
   `flushPendingOverlays()` inside the held mutex via a reentrant commit path.
   Until then, this ordering is a design hole, not a guarantee." This also
   corrects the false implication that the write path is untouchable while the
   ordering holds.

5. **Invariants — lines 152-154 (bootstrap-resident / agent-invisible).**
   Currently:
   > Provider code is bootstrap-resident for first-party; agent still sees only
   > the document.

   Change: add that agent-invisibility of provider *output* is NOT automatic —
   it holds only if the agent-facing source (`setSourceMap`/`currentDocCache`,
   `seeds/rewritable.html:866`/`:1903`) is derived from `docText` rather than the
   mounted (possibly transformed) value. Cite this as a construction requirement,
   not a property.

6. **"The type manifest" — lines 144-148 (`providers[]` into `KIND_TABLE`).**
   Add a sequencing note from the prototype: do NOT wire `providers[]` into
   `KIND_TABLE`/`kindOverrides()` (`cli/src/seed.mjs`) until the registration API
   is validated; the prototype registers the provider directly in the bootstrap,
   precisely to avoid coupling two unproven things. This is a "next step after,
   not concurrent" ordering constraint.

7. **Open item "Lifecycle & load order" — lines 178-180.** Add the concrete
   fail-loud cases the prototype surfaced: unknown provider kind throws; second
   `provide('view', …)` in one session must either replace or reject (pick one —
   the prototype implies single-slot replace); reserved-id/marker in `render`
   output throws at `provide`/`setView` time; `setView` during `modifyMutex` is
   rejected with status, not silently queued.

## 5. Open items: now resolved vs still open

**Resolved by this prototype (feed back into the kernel doc):**

- **Concrete registration API shape (kernel doc lines 172-174).** Resolved:
  declarative spec with one pure `render` slot (plus an optional impure
  `mounted` slot, per §3 render lens), registered via `runtime.provide(kind, spec)`
  returning an `unregister` closure; `setView` toggles. Single nullable slot for
  first-party; persisted `Map` deferred to the installed path.
- **Render-mode contract direction (kernel doc lines 175-177).** Resolved at the
  contract-clause level (see §4 item 1); the seam is `:849`, the agent-facing
  source must be `docText`, and the post-mount slot is required for stateful views.
- **First-party provenance half (kernel doc lines 117-120).** Validated:
  bootstrap-resident, re-registered each load, no persistence, stamped
  first-party. The installed half (lines 122-128) is untouched and still open.
- **"`view` cannot be Worker-isolated" — now with a concrete mechanism**
  (kernel doc lines 63-70): the script-rerun loop at `:850-855`, no CSP.

**Still open (NOT resolved — the prototype deliberately did not exercise these):**

- **Write-path flush ordering (R5; kernel doc lines 81-111).** A `view` never
  writes, so the overlay/flush/`modifyMutex`-on-flush machinery was not
  exercised. The prototype found the cited ordering guarantee unenforceable
  (§3 write-path) but did not build the fix. Still open.
- **Actor-split attribution (R8; kernel doc line 37, `user:cell`/`compute:derived`).**
  Not exercised — `view` is read-only.
- **`compute` dependency model (kernel doc line 181).** Untouched.
- **Worker message contract for providers (kernel doc lines 182-183).** Untouched.
- **Installed / third-party provider path (kernel doc lines 121-128).** No
  `.rwa-skill.json`, no install dialog, no `rwa_state['providers']` persistence.
  The prototype's security findings (script-rerun = arbitrary code-exec) sharpen
  what this path must disclose, but the path itself is unbuilt.
- **`region`/`match` partial views and a view-aware ordinal map.** Presentation
  owns the whole mount; per-region views (the `datatable` case) need a
  source-map-aware sub-mount strategy. Open.
- **Edit-surface transient-DOM capture/restore hook in `renderDoc`.** Identified
  as the real `edit-surface` risk (§3 write-path) but not designed.
