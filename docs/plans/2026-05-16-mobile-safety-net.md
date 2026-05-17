# Mobile Safety Net Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the three mobile-safety gaps the spec already promises but the seed never delivered — count-based commit nudge, 80% quota warning, and private-mode detection with a blocking banner — so iOS Safari users stop silently losing data.

**Architecture:** Three independent surfaces wired into the existing `seeds/rewritable.html` runtime. Each rides existing infrastructure: the commit-nudge persists a tiny counter in `rwa_<DOC_UUID>` next to `rwa_doc` and surfaces via the existing `.rwa-lens-toast` element; the quota warning calls `navigator.storage.estimate()` from the bootstrap IIFE and after every successful modify, surfacing via the existing `setPalSt('warn', …)` status palette; private-mode detection runs once at boot, checks two signals (IDB open failure + `navigator.storage.estimate().quota < 50 MB`), and renders a full-viewport blocking overlay when positive. Spec citations: `re-write-able-spec.md` §5.3 (quota warning), §5.6 (commit nudge), §9.1 (private-mode message). No spec changes required — these implement existing text.

**Tech Stack:** Vanilla HTML/CSS/JS inside the canonical seed (no build step). Tests via `tests/lens.mjs`-style jsdom + fake-indexeddb harness. Reference regeneration via `node tools/regenerate-refs.mjs`.

---

## Pre-flight

Before starting any task:

1. **Read the spec passages this plan implements.** Open `re-write-able-spec.md`, jump to §5.3 ("Quota awareness"), §5.6 ("Commit and Export" — the dirty-state nudge paragraph), and §9.1 ("The iOS Safari Problem"). Spend 2 minutes per passage. These are the contract; the implementation must match the wording, not improvise.

2. **Confirm the seed's existing surfaces.** Run:
   ```
   grep -nE "setPalSt|setDirty|rwa-lens-toast|rwa-lens-hint|navigator\.storage" seeds/rewritable.html
   ```
   You should see `setPalSt` (line ~510), `setDirty` (line ~511), `.rwa-lens-toast` CSS (line ~85), `#rwa-lens-hint` div (line ~369), and `navigator.storage.persist()` call (line ~2484). Line numbers drift; verify before editing.

3. **Decide on worktree isolation.** This change touches one file (`seeds/rewritable.html`) plus tests plus generated references. If you want isolation, create a worktree via the `superpowers:using-git-worktrees` skill before Task 1. If you're comfortable in `main`, skip.

4. **Verify the test harness boots.** Run:
   ```
   cd tests && npm install && node lens.mjs | tail -5
   ```
   Expected: existing test suite passes, "OK …" lines, exit 0. If it fails, fix that first — your new tests won't run cleanly until the existing ones do.

---

## Task 1: Commit-count nudge (smallest, most isolated)

**Why first:** Pure state machine. No platform API stubbing. Tests cleanly in jsdom. If this lands correctly, the architecture for the other two tasks is validated.

**Spec text being implemented (`re-write-able-spec.md` §5.6):**

> The runtime tracks dirty state — number of modifications since last commit — and surfaces a status indicator. After 5 uncommitted modifications it nudges: *"You have 5 uncommitted changes. ⌘S to commit."*

**Files:**
- Modify: `seeds/rewritable.html` (RWA config block ~line 134; modify-success and commit-success sites; bootstrap IIFE for counter rehydrate)
- Modify: `tests/lens.mjs` (append a new `== Phase: commit-nudge ==` block at the end before `process.exit`)

### Step 1.1: Write the failing tests

Append to `tests/lens.mjs` immediately before the `process.exit(fail > 0 ? 1 : 0);` line:

```js
// === Phase: commit-count nudge (spec §5.6) ===
console.log('\n== Test M1.1: dirtyCount increments on each successful modify ==');
{
  // Reset to a known state.
  await window.rwaResetDirtyCount?.();
  check('rwaGetDirtyCount exists', typeof window.rwaGetDirtyCount === 'function');
  check('starts at 0', (await window.rwaGetDirtyCount()) === 0);

  // Simulate three successful modifies by calling the internal hook.
  await window.rwaBumpDirtyCount(); // 1
  await window.rwaBumpDirtyCount(); // 2
  await window.rwaBumpDirtyCount(); // 3
  check('count is 3 after three bumps', (await window.rwaGetDirtyCount()) === 3);
}

console.log('\n== Test M1.2: nudge toast appears at threshold (5) ==');
{
  await window.rwaResetDirtyCount();
  for (let i = 0; i < 4; i++) await window.rwaBumpDirtyCount();
  check('no toast at count=4',
    !window.document.querySelector('.rwa-lens-toast[data-kind="commit-nudge"]'));
  await window.rwaBumpDirtyCount(); // crosses 5
  const toast = window.document.querySelector('.rwa-lens-toast[data-kind="commit-nudge"]');
  check('toast appears at count=5', !!toast);
  check('toast mentions 5 uncommitted changes',
    /5 uncommitted/i.test(toast?.textContent || ''));
  check('toast mentions ⌘S', /⌘S|cmd.?s/i.test(toast?.textContent || ''));
}

console.log('\n== Test M1.3: commit resets the counter and clears toast ==');
{
  // Counter still at >=5 from previous test.
  await window.rwaResetOnCommit();
  check('count is 0 after reset', (await window.rwaGetDirtyCount()) === 0);
  check('toast removed',
    !window.document.querySelector('.rwa-lens-toast[data-kind="commit-nudge"]'));
}

console.log('\n== Test M1.4: counter survives reload (persisted to IDB) ==');
{
  await window.rwaResetDirtyCount();
  await window.rwaBumpDirtyCount();
  await window.rwaBumpDirtyCount();
  // Read the raw IDB record under rwa_state (or whichever store the impl uses).
  const stored = await window.rwaGetDirtyCount();
  check('count persists at 2', stored === 2);
}
```

The tests rely on three new internal hooks (`rwaBumpDirtyCount`, `rwaResetOnCommit`, `rwaGetDirtyCount`, `rwaResetDirtyCount`) that the implementation must expose on `window` for tests only. Existing seed code follows this pattern (e.g., `window.buildSourcePositionMap` at line ~815).

### Step 1.2: Run tests to verify they fail

```
cd tests && node lens.mjs 2>&1 | tail -25
```

Expected: previous tests pass; four new `FAIL` lines under `Test M1.1`–`M1.4`; nonzero exit. Each failure reads "function not defined" or similar.

### Step 1.3: Implement the counter

In `seeds/rewritable.html`:

**3a. Extend the RWA config block (~line 134-138):**

Find the existing config object:
```js
const RWA = {
  DOC:'rwa_doc', UNDO:'rwa_undo', HIST:'rwa_hist', FSA:'rwa_fsa',
  UNDO_CAP:10, HIST_CAP:1000,
  …
};
```

Add a new store name and threshold:
```js
const RWA = {
  DOC:'rwa_doc', UNDO:'rwa_undo', HIST:'rwa_hist', FSA:'rwa_fsa', STATE:'rwa_state',
  UNDO_CAP:10, HIST_CAP:1000, NUDGE_THRESHOLD:5,
  …
};
```

**3b. Add `rwa_state` store to the IDB upgrade path.** Find the `onupgradeneeded` handler (search for `r.onupgradeneeded` or `createObjectStore`). Add:
```js
if (!db.objectStoreNames.contains(RWA.STATE)) db.createObjectStore(RWA.STATE);
```
Reserved-store check: `rwa_state` matches the `rwa_*` reserved pattern already declared in `re-write-able-spec.md` §5.3; no spec change needed.

**3c. Add the counter helpers near other state helpers (~line 510 area):**

```js
// Spec §5.6: dirty-state nudge. Counter survives reload by living in IDB.
async function rwaGetDirtyCount() {
  return (await idbGet(RWA.STATE, 'dirty_count')) || 0;
}
async function rwaSetDirtyCount(n) {
  await idbPut(RWA.STATE, 'dirty_count', n);
  if (n >= RWA.NUDGE_THRESHOLD) showCommitNudge(n);
  else clearCommitNudge();
}
async function rwaBumpDirtyCount() {
  const n = (await rwaGetDirtyCount()) + 1;
  await rwaSetDirtyCount(n);
  return n;
}
async function rwaResetDirtyCount() { await rwaSetDirtyCount(0); }
async function rwaResetOnCommit()   { await rwaResetDirtyCount(); }

function showCommitNudge(n) {
  let t = document.querySelector('.rwa-lens-toast[data-kind="commit-nudge"]');
  if (!t) {
    t = document.createElement('div');
    t.className = 'rwa-lens-toast';
    t.setAttribute('data-kind', 'commit-nudge');
    document.body.appendChild(t);
  }
  t.textContent = `You have ${n} uncommitted changes. ⌘S to commit.`;
}
function clearCommitNudge() {
  document.querySelector('.rwa-lens-toast[data-kind="commit-nudge"]')?.remove();
}

// Expose for tests only — production code uses the hooks below.
window.rwaGetDirtyCount = rwaGetDirtyCount;
window.rwaBumpDirtyCount = rwaBumpDirtyCount;
window.rwaResetDirtyCount = rwaResetDirtyCount;
window.rwaResetOnCommit = rwaResetOnCommit;
```

Note: `idbGet`/`idbPut` are the existing helpers in the seed; if your seed uses different names (e.g., `idbGetStore`), keep the call shape but match the existing API.

**3d. Wire the counter into modify-success sites.** Find every place that calls `setDirty(true)` after a successful modify (grep gives lines 2285, 2374, 2430 today). After each `setDirty(true)` add:
```js
await rwaBumpDirtyCount();
```

**3e. Wire the reset into commit-success sites.** Find every place that calls `setDirty(false)` after a successful commit (grep gives lines 2455, 2466 today). After each `setDirty(false)` add:
```js
await rwaResetOnCommit();
```

**3f. Rehydrate the nudge on bootstrap.** In the bootstrap IIFE near `navigator.storage.persist()` (~line 2484), add:
```js
const initialCount = await rwaGetDirtyCount();
if (initialCount >= RWA.NUDGE_THRESHOLD) showCommitNudge(initialCount);
```
This ensures the nudge survives a tab reload when uncommitted changes remain.

### Step 1.4: Run tests to verify they pass

```
cd tests && node lens.mjs 2>&1 | grep -E "(FAIL|Test M)" | head -20
```

Expected: zero `FAIL` lines. All four `Test M1.*` blocks report only `OK …`.

If a test fails, do not skip it. Inspect the assertion, fix the seed, re-run.

### Step 1.5: Commit

```
git add seeds/rewritable.html tests/lens.mjs
git commit -m "feat(safety): count-based commit nudge after 5 uncommitted (spec §5.6)"
```

---

## Task 2: Storage quota warning at 80%

**Spec text being implemented (`re-write-able-spec.md` §5.3, end of "Quota awareness"):**

> The runtime checks available storage on boot and after each rewrite and surfaces a warning above 80% usage.

**Files:**
- Modify: `seeds/rewritable.html` (new helper + bootstrap IIFE + modify-success sites)
- Modify: `tests/lens.mjs` (append `== Phase: quota warning ==`)

### Step 2.1: Write the failing tests

Append to `tests/lens.mjs`:

```js
// === Phase: quota warning (spec §5.3) ===
console.log('\n== Test M2.1: warning fires when usage > 80% ==');
{
  const origEstimate = window.navigator.storage.estimate?.bind(window.navigator.storage);
  window.navigator.storage.estimate = async () => ({ usage: 81 * 1024 * 1024, quota: 100 * 1024 * 1024 });
  await window.rwaCheckQuota();
  const pal = window.document.getElementById('rwa-pal-st');
  check('palette shows warn class', pal?.className === 'warn');
  check('message mentions storage / quota / 80%',
    /storage|quota|80%/i.test(pal?.textContent || ''));
  if (origEstimate) window.navigator.storage.estimate = origEstimate;
}

console.log('\n== Test M2.2: no warning when usage < 80% ==');
{
  window.navigator.storage.estimate = async () => ({ usage: 10 * 1024 * 1024, quota: 100 * 1024 * 1024 });
  // Clear any prior warn state.
  const pal = window.document.getElementById('rwa-pal-st');
  if (pal) { pal.className = ''; pal.textContent = ''; }
  await window.rwaCheckQuota();
  check('palette not in warn state', pal?.className !== 'warn');
}

console.log('\n== Test M2.3: estimate() unsupported is a no-op ==');
{
  window.navigator.storage.estimate = undefined;
  const pal = window.document.getElementById('rwa-pal-st');
  if (pal) { pal.className = ''; pal.textContent = ''; }
  let threw = false;
  try { await window.rwaCheckQuota(); } catch (_) { threw = true; }
  check('no exception on missing estimate()', !threw);
  check('no warning surfaced', pal?.className !== 'warn');
}
```

### Step 2.2: Run tests to verify they fail

```
cd tests && node lens.mjs 2>&1 | grep -E "Test M2" -A 4 | head -20
```

Expected: three failing assertions per missing `window.rwaCheckQuota`.

### Step 2.3: Implement the quota check

In `seeds/rewritable.html`, near the other state helpers (just below the commit-nudge code from Task 1):

```js
// Spec §5.3: quota awareness. Surface a warning above 80% usage.
async function rwaCheckQuota() {
  if (!navigator.storage || !navigator.storage.estimate) return;
  let est;
  try { est = await navigator.storage.estimate(); } catch (_) { return; }
  if (!est || !est.quota || !est.usage) return;
  const ratio = est.usage / est.quota;
  if (ratio > 0.8) {
    const usedMB = Math.round(est.usage / (1024 * 1024));
    const quotaMB = Math.round(est.quota / (1024 * 1024));
    setPalSt('warn', `storage ${usedMB}/${quotaMB} MB (>80%) — commit & close idle tabs`);
  }
}
window.rwaCheckQuota = rwaCheckQuota;
```

Note the spec says "surfaces a warning above 80% usage" — wording is open. The phrasing above keeps it actionable on iOS where committing to disk relieves IDB pressure.

### Step 2.4: Wire the call into bootstrap + post-modify

**In the bootstrap IIFE (~line 2484, near `navigator.storage.persist()`):**
```js
rwaCheckQuota();  // fire-and-forget; non-blocking
```

**After every successful modify-commit transaction** (same sites as Task 1, after `setDirty(true)` + `rwaBumpDirtyCount()`):
```js
rwaCheckQuota();
```

### Step 2.5: Run tests to verify they pass

```
cd tests && node lens.mjs 2>&1 | grep -E "(FAIL|Test M2)" | head -10
```

Expected: zero `FAIL` lines under M2.

### Step 2.6: Commit

```
git add seeds/rewritable.html tests/lens.mjs
git commit -m "feat(safety): 80% storage quota warning on boot and post-modify (spec §5.3)"
```

---

## Task 3: Private-mode detection + blocking banner

**Spec text being implemented (`re-write-able-spec.md` §9.1):**

> **Private/incognito mode is unsupported.** The runtime detects it and shows a clear message: *"re-write-able requires normal browsing mode."*

**Detection strategy:** Two signals, OR'd together. Either makes the verdict positive.

1. **Catastrophic:** the IDB open in the bootstrap path throws or yields a permanently-failing connection.
2. **Probable:** `navigator.storage.estimate().quota < 50 * 1024 * 1024` (50 MB). iOS Safari private mode reports quota in single-digit MB; the threshold is wide enough to avoid false positives on real low-disk devices but tight enough to catch iOS private.

When positive, render a full-viewport blocking overlay. The runtime should not continue past detection — modify/commit are unsafe in private mode by spec.

**Files:**
- Modify: `seeds/rewritable.html` (new helper, CSS, banner injection, bootstrap IIFE early-exit)
- Modify: `tests/lens.mjs` (append `== Phase: private-mode detection ==`)

### Step 3.1: Write the failing tests

Append to `tests/lens.mjs`:

```js
// === Phase: private-mode detection (spec §9.1) ===
console.log('\n== Test M3.1: detectPrivateMode returns true on tiny quota ==');
{
  window.navigator.storage.estimate = async () => ({ usage: 0, quota: 1 * 1024 * 1024 });
  const verdict = await window.rwaDetectPrivateMode();
  check('verdict is true for 1 MB quota', verdict === true);
}

console.log('\n== Test M3.2: detectPrivateMode returns false on normal quota ==');
{
  window.navigator.storage.estimate = async () => ({ usage: 100, quota: 5 * 1024 * 1024 * 1024 });
  const verdict = await window.rwaDetectPrivateMode();
  check('verdict is false for 5 GB quota', verdict === false);
}

console.log('\n== Test M3.3: showPrivateModeBanner renders blocking overlay ==');
{
  // Clear any prior banner.
  document.getElementById('rwa-private-mode-banner')?.remove();
  window.rwaShowPrivateModeBanner();
  const banner = window.document.getElementById('rwa-private-mode-banner');
  check('banner exists', !!banner);
  check('banner contains spec wording',
    /requires normal browsing mode/i.test(banner?.textContent || ''));
  // Aria role for screen readers / explicit semantics.
  check('banner has role=alert', banner?.getAttribute('role') === 'alert');
}

console.log('\n== Test M3.4: estimate() unsupported defaults to safe (false) ==');
{
  const orig = window.navigator.storage.estimate;
  window.navigator.storage.estimate = undefined;
  const verdict = await window.rwaDetectPrivateMode();
  check('verdict is false when estimate() unsupported', verdict === false);
  window.navigator.storage.estimate = orig;
}
```

Note: the "IDB open throws" signal is harder to test cleanly under fake-indexeddb without restructuring the harness. Test M3.1 + M3.2 + M3.4 cover the quota-heuristic path, which is the load-bearing iOS Safari signal. The IDB-throws path is exercised by the manual smoke test in Task 4.

### Step 3.2: Run tests to verify they fail

```
cd tests && node lens.mjs 2>&1 | grep -E "Test M3" -A 4 | head -20
```

Expected: four failing assertions per missing helpers.

### Step 3.3: Implement detection + banner

**3a. CSS — add near the other lens chrome (~line 85, after `.rwa-lens-toast`):**

```css
#rwa-private-mode-banner{position:fixed;inset:0;background:rgba(255,255,255,0.98);z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px;font-family:var(--font-ui);}
#rwa-private-mode-banner .rwa-pm-card{max-width:480px;text-align:center;padding:32px;border:1px solid var(--gray-200);border-radius:var(--radius);background:var(--white);box-shadow:0 8px 32px rgba(0,0,0,0.08);}
#rwa-private-mode-banner h2{font-size:18px;font-weight:600;color:var(--gray-900);margin:0 0 12px;}
#rwa-private-mode-banner p{font-size:14px;color:var(--gray-700);margin:0 0 8px;line-height:1.5;}
#rwa-private-mode-banner .rwa-pm-detail{font-size:12px;color:var(--gray-500);font-family:var(--font-mono);}
```

**3b. JS — add near the other safety helpers:**

```js
// Spec §9.1: private/incognito mode is unsupported.
async function rwaDetectPrivateMode() {
  if (!navigator.storage || !navigator.storage.estimate) return false;
  let est;
  try { est = await navigator.storage.estimate(); } catch (_) { return false; }
  if (!est || !est.quota) return false;
  // iOS Safari private mode caps quota at single-digit MB.
  // 50 MB threshold catches private while leaving real low-disk devices alone.
  return est.quota < 50 * 1024 * 1024;
}

function rwaShowPrivateModeBanner() {
  if (document.getElementById('rwa-private-mode-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'rwa-private-mode-banner';
  banner.setAttribute('role', 'alert');
  banner.innerHTML = `
    <div class="rwa-pm-card">
      <h2>re-write-able requires normal browsing mode</h2>
      <p>Your browser is in private or incognito mode. Storage is severely limited and may be cleared at any time without warning.</p>
      <p>Reopen this document in a normal browser window to continue.</p>
      <p class="rwa-pm-detail">Your work-in-progress is safe in the file on disk — nothing has been lost.</p>
    </div>`;
  document.body.appendChild(banner);
}

window.rwaDetectPrivateMode = rwaDetectPrivateMode;
window.rwaShowPrivateModeBanner = rwaShowPrivateModeBanner;
```

**3c. Wire into bootstrap IIFE — earliest practical point, before the modify pathway is exposed.** Find the bootstrap IIFE's startup block (~line 2480-2486 area, just before `navigator.storage.persist()`). Insert at the top:

```js
if (await rwaDetectPrivateMode()) {
  rwaShowPrivateModeBanner();
  return;  // do not initialize the rest of the runtime
}
```

**Also wrap the IDB-open path in a try/catch** (find the `openDB()` / `idbOpen()` call in the bootstrap). On failure:
```js
try {
  await openDB();
} catch (err) {
  console.warn('rwa: IDB open failed', err);
  rwaShowPrivateModeBanner();
  return;
}
```

Exact site depends on your seed structure; the principle is: if IDB cannot be opened, the runtime cannot function, and the user must see a clear message rather than a silently-broken document.

### Step 3.4: Run tests to verify they pass

```
cd tests && node lens.mjs 2>&1 | grep -E "(FAIL|Test M3)" | head -15
```

Expected: zero `FAIL` lines under M3.

### Step 3.5: Commit

```
git add seeds/rewritable.html tests/lens.mjs
git commit -m "feat(safety): detect private-mode + show blocking banner (spec §9.1)"
```

---

## Task 4: Regenerate references and smoke-test in browser

**Why:** The seed is canonical, but `hello.html` and `re-write-able-spec.html` carry their own copies of the bootstrap. CLAUDE.md is explicit: after any seed change, regenerate them. The browser smoke is the only way to validate the iOS Safari path, which jsdom cannot simulate.

**Files:**
- Modify: `hello.html` (regenerated)
- Modify: `re-write-able-spec.html` (regenerated)

### Step 4.1: Regenerate references

```
node tools/regenerate-refs.mjs
```

Expected: stdout reports both files rewritten. The script reads the seed, substitutes each reference's `DOC_UUID`, `RWA.FILE`, and `INLINE_DOC` body, and writes back.

Verify the regeneration kept each reference's unique `DOC_UUID`:
```
grep -E "DOC_UUID:'[a-f0-9-]+'" seeds/rewritable.html hello.html re-write-able-spec.html
```

Expected: three distinct UUIDs (one per file). If two match, the regeneration script clobbered an ID — stop and investigate before committing.

### Step 4.2: Run full test suite to confirm nothing regressed

```
cd tests && node lens.mjs 2>&1 | tail -3
cd .. && cd benchmark && npm run conformance 2>&1 | tail -3
```

Expected: both report success. Conformance must stay 42/42.

### Step 4.3: Manual browser smoke (5 minutes)

The jsdom tests cover state machines; only a real browser can verify the visual surfaces.

**Test 4.3a — normal mode, no warnings:**
1. Open `hello.html` in a regular Chrome window.
2. Verify: no private-mode banner, no quota warning, document renders normally.
3. Press ⌘K, make any modification, commit (⌘S). Verify dirty counter rests at 0.

**Test 4.3b — private-mode banner:**
1. Open a Chrome incognito window.
2. Open `hello.html`.
3. Verify: blocking banner appears with the spec wording "requires normal browsing mode". Lens is not interactive. No console errors that aren't documented.

   If Chrome incognito does NOT trigger (Chrome desktop incognito has a larger quota than iOS Safari private), open in Safari iOS private mode via the iOS Simulator or a real device. The 50 MB threshold should catch it. If it doesn't, raise the threshold and re-test.

**Test 4.3c — commit nudge:**
1. Open `hello.html` in normal Chrome.
2. Make 5 separate modifications via ⌘K (any small edits) without committing.
3. After the 5th modify, the toast `You have 5 uncommitted changes. ⌘S to commit.` should appear above the lens.
4. Press ⌘S. Toast disappears.
5. Reload the page after 4 uncommitted: counter should persist, toast should NOT appear (still below threshold).
6. Reload after 5 uncommitted: counter persists, toast reappears on boot.

**Test 4.3d — quota warning (synthetic):**
1. In DevTools Console on a loaded container: `navigator.storage.estimate = async () => ({usage: 90e6, quota: 100e6}); await window.rwaCheckQuota();`
2. Verify: status palette shows `storage 86/95 MB (>80%) — commit & close idle tabs` (or similar).

### Step 4.4: Commit regenerated references

```
git add hello.html re-write-able-spec.html
git commit -m "chore: regenerate references against mobile-safety seed"
```

---

## Done criteria

- [ ] `cd tests && node lens.mjs` exits 0 with zero `FAIL` lines, including the three new `Phase` blocks.
- [ ] `cd benchmark && npm run conformance` exits 0 with 42/42 passing.
- [ ] Manual browser smoke (Test 4.3a–4.3d) all pass.
- [ ] No spec edit required — verify `re-write-able-spec.md` §5.3, §5.6, §9.1 already describe the implemented behavior (they should).
- [ ] Three commits land (one per task) plus the regeneration commit.

## Out of scope

Deliberately not in this plan:
- **OPFS quota.** OPFS is not yet implemented in the seed; quota counting only covers IDB.
- **Eviction recovery.** When iOS evicts the IDB despite `persist()`, the user reloads and the bootstrap rehydrates from `INLINE_DOC`. The committed file is the only durable artifact (spec §9.1). No new code needed.
- **Cross-tab nudge sync.** Two tabs of the same container can each show a nudge; that's correct — each tab tracks its own uncommitted changes. Cross-tab modify-lock is a separate gap (#4 in the analysis) and a separate plan.
- **i18n.** Banner wording is English-only. The spec doesn't translate the message; deferred.
- **A11y polish beyond `role="alert"`.** Banner is dismissible only via browser navigation by design (the user must leave private mode). No focus trap because there's nothing focusable. If a future banner adds buttons, revisit.

## File-touch summary

```
seeds/rewritable.html          — 3 task edits + 1 CSS block
tests/lens.mjs                 — 3 new test phases appended
hello.html                     — regenerated
re-write-able-spec.html        — regenerated
```

No spec files change. No CLI / service files change. No benchmark scenarios change.
