# R5 — the non-agent write path: shared-entry mutex + reentrant commit (+ staged overlay)

*Design, 2026-05-30, euler. The gate before any `edit-surface` / `compute`
provider is safe in the seed. Follows
`docs/plans/2026-05-29-rwa-affordance-skill-kernel-design.md` §"Write-path"
(L106-149, L260-268), which named this the central unresolved item and flagged
the ordering claim as unenforceable at the current `modify()` seam. The
`view` affordance ships (§5.10); `edit-surface`/`compute` are blocked on this.
A design for the team to tear apart — **not yet implemented.***

---

## 1. What's actually broken

The substrate has exactly one writer model: a mutex-guarded read → transform →
atomic commit. Two surfaces want to write *without* an LLM in the loop:

- **`edit-surface`** — a human types into a grid cell / drags a row. No agent.
- **`compute`** — a derived cell recomputes when its inputs change. No agent.

Today the only non-agent writer is `runtime.applyEnvelope` →
`synthesizeAndCommit` (`seeds/rewritable.html:833`, `:2819`), which pays a
**full IDB commit per call**. That is fine for a one-shot gesture (tesla's
datatable uses it; 25/0). It is *not* fine for high-frequency editing (a cell
keystroke cannot pay a `commitDoc` each character), and — the load-bearing
problem — there is **no seam that guarantees the agent never reads a doc with
uncommitted non-agent edits pending.**

Two distinct problems, often conflated:

1. **Ordering (correctness).** If an `edit-surface` holds an uncommitted edit
   and the user hits ⌘K, the agent must see the *flushed* doc, not a stale one.
   This must hold for **both** agent backends.
2. **Efficiency (latency).** High-frequency edits (per-keystroke compute,
   live-typed cells) can't each pay an atomic IDB commit. They need batching.

Problem 1 is mandatory for *any* `edit-surface`. Problem 2 is mandatory only if
the consumer's edit frequency is high — a per-*blur* datatable does not need it.
**Scope to the consumer's real granularity (Rule 2).** (Asked tesla: does the
datatable commit per-keystroke or per-blur? That decides whether Step 2 ships
now or is deferred.)

## 2. The current seam — why the ordering claim is unenforceable

Three places acquire `modifyMutex`, and they do not share an entry:

| Site | Line | Acquires mutex… | Reads doc |
|---|---|---|---|
| `modify()` (openrouter/ollama/lmstudio) | 3786 | at **:3813**, *after* the bridge dispatch | `getDoc()` :3820 |
| `modifyViaBridge()` | 3935 | at **:3941** (its own) | inside |
| `synthesizeAndCommit()` (non-agent) | 2819 | at **:2831**; **throws** `concurrent_modify` if already held (:2830) | inside |

The killers:

- **Bridge bypass.** `modify()` dispatches `return modifyViaBridge(...)` at
  **:3797 — before it ever touches the mutex at :3813.** A flush hook placed at
  the top of `modify()`'s mutex block never runs for the bridge backend. There
  is no single "agent is about to read the doc" point covering both backends.
- **Reentrancy wall.** A `flushPendingOverlays()` running *inside* a held agent
  mutex cannot commit through `synthesizeAndCommit` — it would hit the
  `if (modifyMutex) throw concurrent_modify` guard at **:2830**. So the natural
  "flush, then let the agent read" sequence is structurally impossible today.

This is why the kernel-design downgraded "flush acquires the mutex, so it can't
race the agent" from a guarantee to a flagged hole.

## 3. The fix — two independently-landable steps

### Step 1 — shared-entry mutex + reentrant commit core (the ordering gate)

**Goal:** one place where, for *every* agent path, the mutex is acquired and any
pending non-agent edits are flushed *before* the doc is read. Make non-agent
writes safe; needs no overlay and no new consumer to land + test.

1. **Extract `commitCore(envelope, surface, meta)`** from `synthesizeAndCommit`
   — the read-merge-`commitDoc`-rerender body **without** the mutex
   check/acquire (:2830-2831) and without the test-seam shim. `commitCore`
   assumes the mutex is already held.
   - `synthesizeAndCommit` becomes: `if (modifyMutex) throw concurrent_modify;
     modifyMutex = true; try { return await commitCore(...) } finally {
     modifyMutex = false }` — behaviour byte-identical to today for existing
     callers (the test seam stays on `synthesizeAndCommit`).
   - `flushPendingOverlays()` calls `commitCore` directly — reentrant, no throw.

2. **Single shared agent entry.** Refactor so `modify()` acquires the mutex
   **once, before** the `cfg.kind === 'bridge'` dispatch (currently :3797), runs
   `await flushPendingOverlays()` inside it, then dispatches to an inner
   `runOpenAiModify` / `runBridgeModify` that **assume the mutex is held** (drop
   their own acquire at :3813 / :3941). The API-key precheck (:3800) stays
   *before* acquisition so a missing key doesn't strand the mutex.
   - Net: exactly one acquire per agent modify, one flush seam, both backends
     covered. `undo()` (:4064) and `runtime.setView` (:3510) already gate on
     `modifyMutex` and are unaffected.

3. **No overlay yet:** `flushPendingOverlays()` is a no-op until Step 2 registers
   a buffer. Step 1 is pure refactor + reentrancy plumbing — and is independently
   verifiable: existing suites (e2e/lens/bridge) must stay green, plus a new test
   that a registered "pending edit" is committed before `getDoc()` is read by
   both backends.

### Step 2 — staged live-region overlay + boundary flush (the efficiency layer)

*Only if the consumer needs sub-commit-granularity edits (tesla's answer gates
this).* `edit-surface`/`compute` writes mutate a tracked in-memory overlay on the
rendered region (not IDB). The overlay flushes to `currentDoc` via `commitCore`
at boundaries: **blur** of the edit region, **idle-debounce** (N ms), **before
any agent `modify()`** (the Step-1 seam — already wired), **⌘S**, and
best-effort on **tab hide/unload** (iOS-eviction safety). Reconciliation
serializes the overlay back into LF-canonical text and runs the normal atomic
commit with actor attribution (`user:cell`, `compute:derived`).

Open within Step 2 (defer with it): overlay representation (DOM-diff vs
structured cell model); `renderDoc` is full-replace, so an edit-surface owning
*uncommitted* DOM needs a capture/restore hook in `renderDoc` that does not
exist yet (kernel-design open item — the real `edit-surface` risk, not the
`:849` branch); `compute` dependency ordering + cycle detection.

## 4. Invariants this must preserve

- `currentDoc` (LF text in IDB) stays the source of truth; commits stay atomic
  `(rwa_doc, rwa_undo, rwa_hist)`; commits carry no undo state.
- Frozen zones are out of bounds for `edit-surface` regions (declared regions
  must lie outside frozen zones); `data-rwa-id` backfilled at flush as on the
  existing commit path.
- Bootstrap byte-identical except `INLINE_DOC` (Invariant 1) — this is a runtime
  refactor; no new baked region, no commit-stamp.
- `rwa_hist.actor` attributes non-agent writes (`user:cell`, `compute:derived`)
  as first-class, exactly as `user:lens` is today.

## 5. Why split the steps

Step 1 is a **contained, testable refactor with no new surface** — it closes the
ordering hole and makes the *existing* `applyEnvelope`/datatable path safe under
concurrent ⌘K, valuable on its own. Step 2 is the larger, consumer-shaped piece
and carries the genuine unknowns (transient-DOM hook, compute graph). Landing
Step 1 first means the risky overlay work builds on a proven ordering seam, and
we never ship Step 2 speculatively — it ships when (and shaped how) a real
consumer needs it. If tesla's datatable commits per-blur, **Step 1 alone may be
the whole of R5 for now**, and Step 2 waits for a consumer that types live.

## 6. Success criteria

- **Step 1:** all existing suites green (e2e 291, lens 246, bridge 8, view 17,
  identity 42, conformance 79/79); new tests: (a) a registered pending-flush
  commits before `getDoc()` for **both** openrouter and bridge paths; (b)
  `commitCore` invoked under a held mutex does not throw; (c) `synthesizeAndCommit`
  external behaviour unchanged (still throws on concurrent entry).
- **Step 2 (if scoped in):** a high-frequency edit-surface fixture commits once
  per boundary (not per keystroke); the agent reads a flushed doc; frozen zones
  and `data-rwa-id` survive a flush; undo steps back one boundary, not one
  keystroke.

## 7. Open items (for the team)

- tesla: datatable edit granularity → does Step 2 ship now or defer?
- Is the shared-entry refactor of `modify()`/`modifyViaBridge()` better as (a)
  moving the acquire above the dispatch, or (b) a thin `runAgentModify(instr,
  meta, runner)` wrapper that owns acquire+flush+release and calls a
  backend-specific `runner`? (b) is cleaner but a larger diff; (a) is more
  surgical. Leaning (b) for one honest seam; want review.
- Does `commitCore` extraction disturb the post-commit re-anchor logic
  (`prevAnchorStart`, :2838) that currently lives inside `synthesizeAndCommit`'s
  mutex block? That anchor bookkeeping is lens-specific and should stay in
  `synthesizeAndCommit`, *not* migrate into `commitCore` (compute/cell flushes
  have no lens anchor). Needs care at extraction.

## 8. Update — tesla's consumer data (datatable, #57) sharpens the scope

The real consumer answered, and it tightens R5 to its minimum:

- **Granularity = commit-on-blur/Enter, not per-keystroke.** So **Step 2 (staged
  overlay + debounce) is out of scope for R5-v1** — confirmed, not just deferred.
  Build it only when a consumer edits live; the datatable does not.
- **The dominant pain is reentrancy, sharper than §1's "agent reads stale doc."**
  `synthesizeAndCommit` runs `renderDoc` *inside* the held mutex and releases only
  in `finally`, so an observer sees the edit land in the DOM while the mutex is
  still held; a rapid **2nd non-agent commit throws `concurrent_modify`** rather
  than waiting its turn. tesla had to hand-roll a `window.__dtBusy` serialized
  chain. **R5's real job: make non-agent commits safely QUEUE, so a consumer
  never hand-serializes.**
- **So Step 1 reframes from "shared-entry flush" to "a serialized commit queue."**
  Replace the throw-on-held-mutex (`:2830`) for non-agent writers with an
  enqueue: a write awaits the in-flight commit's promise, then runs `commitCore`.
  The agent paths (⌘K) join the same queue at one shared entry (covering the
  bridge bypass, §2) and flush pending non-agent work before reading the doc.
  Concurrent **non-agent** commits serialize instead of throwing; whether a 2nd
  **agent** ⌘K still rejects (today's UX) or also queues is a review question
  (lean: agent still rejects with its user-facing message — its UI serializes —
  while non-agent commits queue; one queue, two admission policies).
- **Additive sub-fix (independent, small): `actor` passthrough.**
  `synthesizeAndCommit` hardcodes `actor:'user:lens'` (~:2826); `applyEnvelope`
  should accept `{actor}` and thread it (default `'user:lens'` for back-compat)
  so an `edit-surface` self-attributes in `rwa_hist` (`'user:edit-surface'`,
  `'compute:derived'`) instead of being distinguishable only by `surface`. This
  can land *before* the queue refactor as a 3-line additive change.
- **Acceptance fixture (tesla owns):** a seed-free `tests/` characterization test
  — two `applyEnvelope` calls without serialization → today `concurrent_modify`;
  after R5 → both commit in order, `rwa_hist` grows by 2. "Make this pass" is the
  R5-Step-1 done-signal. I design the seam against it; tesla brings the failing
  test; we pair as a fresh coordinated iteration.

Revised Step-1 success criterion: tesla's two-concurrent-`applyEnvelope` fixture
passes (both land, ordered, no `concurrent_modify`); `__dtBusy`-style consumer
hand-serialization becomes unnecessary; all existing suites stay green; the
`actor` passthrough lets an edit-surface self-attribute.

---

## 9. As-built (LANDED) — simpler than designed

Implemented and verified. The build came in **smaller than §3's Step-1**: the
"shared-entry mutex + flush" machinery turned out to be **unnecessary**. Two
facts (confirmed by an exhaustive caller/mutex map + adversarial review):

- Non-agent commits write **straight to IDB** (`commitCore`→`applyEdits`→
  `commitDoc`); there is **no buffer to flush**, so there is nothing the agent
  must flush before reading. The whole flush/shared-entry idea only mattered for
  the (deferred) Step-2 overlay.
- The agent path (`modify`/`modifyViaBridge`/`runAnchoredCommand`) commits inside
  **its own** `modifyMutex` and never routes through `synthesizeAndCommit`; both
  agent backends already check `modifyMutex` before reading the doc, so the
  "bridge bypass" was a non-issue once there is no flush hook to miss.

So R5-v1 = **three surgical changes** to `seeds/rewritable.html`, nothing more:
1. `let nonAgentCommitChain = Promise.resolve();` (module scope).
2. `synthesizeAndCommit` → test-seam + a promise-chain queue (`run = () =>
   commitCore(...)`, `p = chain.then(run, run)`, `chain = p.catch(()=>{})`,
   `return p`) wrapping the extracted reentrant `commitCore(envelope, surface,
   instruction, actor)`. `commitCore` keeps `if (modifyMutex) throw` — which now
   fires **only** when an agent loop holds the mutex (the queue prevents
   non-agent overlap).
3. `runtimeApplyEnvelope` threads `options.actor`; `lensMeta.actor =
   actor || 'user:lens'` (back-compat default).

**Admission policy (deliberate):** non-agent-vs-non-agent serializes; non-agent
arriving during an agent loop still rejects `concurrent_modify` (unchanged — the
agent loop stays the exclusive writer). The agent ⌘K path still rejects a
concurrent ⌘K (its UI serializes).

**Verified:** tests/write-path.mjs 10/0 + tests/r5-concurrent-commit.mjs 3/0
(both RED→GREEN); e2e 291, lens 246 (incl. the test seam, R4.11 re-entrancy, and
the L9.1 actor/surface/scope assertions), view 17, identity 42, datatable 32
(tesla's burst still green — the runtime queue composes with the consumer's
`__dtBusy`, which is now redundant), bridge 8, conformance 79/79 — **0 regressions**.
The pre-existing affordance-kernel 5-fail (the not-yet-built `provide('edit-surface'/
'compute')`) is untouched and is exactly what R5 now unblocks for bohr's kernel-ext.

**Known residual (flagged, not fixed — out of minimal scope):** `commitCore`
keeps the lens re-anchor/scope block verbatim; for a non-lens `applyEnvelope`
commit fired *while a lens anchor is live*, it reads `lensState.anchor` (a
pre-existing behavior of the old `synthesizeAndCommit`, preserved not introduced).
The §7 suggestion to gate it on `actor === 'user:lens'` is a follow-up.

---

*Status: **LANDED** (R5 Step-1). Serialized-commit-queue + reentrant `commitCore`
+ `actor` passthrough — three surgical seed edits, no shared-entry-mutex/flush
needed. Step-2 (staged overlay) remains out of scope until a live-typing consumer
exists. Validated by an exhaustive map + 3-lens adversarial review (one of which
implemented it on a temp copy and ran the full matrix) before landing. Cites the
seam at `seeds/rewritable.html` :2819/:2830/:3072/:3786/:3797/:3813/:3935/:3941.*
