# Public Runtime API Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expose `window.runtime` per `re-write-able-spec.md` §7 so documents can read/write their own structured stores, persist blobs, drive the modify loop programmatically, and react to commits — closing the gap that currently makes only pure-prose containers fully supported.

**Architecture:** A single global `window.runtime` object is constructed during the bootstrap IIFE, *after* private-mode detection and `openDB()` succeed but *before* the document is rendered. It thin-wraps existing internal helpers (`idbGet`/`idbPut`/`idbDel`, `modify()`, `commit()`, `undo()`) and adds three new surfaces: dynamic-schema IDB store creation (`db.open` re-opens the DB with a version bump), OPFS file I/O with per-container auto-namespacing (`_<DOC_UUID>/<path>`), and a minimal event emitter (`runtime.on('commit'|'modify'|'status', cb)`). The shared composition surface (`runtime.shared.*`) from spec §7 is deliberately **out of scope** — it depends on the unresolved open question §11.5.

**Tech Stack:** Vanilla JS inside the canonical seed. Tests via `tests/lens.mjs`-style jsdom + fake-indexeddb. OPFS testing in jsdom needs a stub (fake-indexeddb doesn't include OPFS); the real OPFS path is exercised by the manual browser smoke. Spec edits to `re-write-able-spec.md` close one known gap (OPFS namespacing, §5.7/§11.5).

---

## Pre-flight

Before starting any task:

1. **Read spec §7 and §5.3 of `re-write-able-spec.md`.** §7 is the API contract; §5.3 lists reserved namespaces the API must enforce. Also skim §5.7 (the OPFS namespacing gap this plan closes) and §11.5 (the `runtime.shared.*` open question this plan defers).

2. **Confirm the seed's existing internal surface.** Run:
   ```
   grep -nE "^(async )?function (openDB|modify|commit|undo|commitDoc|popUndo|getDoc)|^const idb" seeds/rewritable.html
   ```
   You should see:
   - `openDB()` (~line 172) — opens the per-container IDB
   - `idbGet`/`idbPut`/`idbDel` arrow helpers (~lines 208-216), all taking `(store, key|value, key=RWA.KEY)`
   - `getDoc()`, `popUndo()` (~lines 221-226)
   - `commitDoc(currentDoc, newDoc, histRecord)` (~line 1890)
   - `modify(instr, lensMeta)` (~line 2289), `modifyViaBridge(...)` (~line 2426)
   - `undo()` (~line 2541), `commit()` (~line 2553)
   - `const REQUIRED_STORES` (~line 171)

   Line numbers drift; always grep before editing.

3. **No worktree needed.** Same flow as the mobile-safety net — work on `main`. If you prefer isolation, create one via the `superpowers:using-git-worktrees` skill before Task 1.

4. **Verify the test harness boots:** `cd tests && node lens.mjs 2>&1 | tail -3`. Existing 172 lens-tests + 291 e2e-tests + 42 conformance scenarios must pass before you start.

5. **Scope clarification — read this once.** This plan ships the §7 surface MINUS `runtime.shared.*`. The plan also closes the OPFS namespacing gap (§5.7) by auto-prefixing all `runtime.fs` paths with `_<DOC_UUID>/`. This requires a small spec edit in Task 6.

---

## Task 1: `runtime` skeleton + `runtime.id` + `runtime.db.{get, put, del, all}`

**Why first:** Validates the architecture (where the object lives, when it's constructed, how reserved-name enforcement works) with minimal new surface area. Read-only/single-record ops only — store creation is Task 2.

**Files:**
- Modify: `seeds/rewritable.html` (new section after the existing IDB helpers ~line 220, bootstrap wire-up ~line 2620)
- Modify: `tests/lens.mjs` (append `=== Phase: runtime.db basics ===` before `process.exit`)

### Step 1.1: Write the failing tests

Append to `tests/lens.mjs` before `process.exit`:

```js
// === Phase: runtime.db basics (spec §7) ===
console.log('\n== Test R1.1: window.runtime exists with id + db ==');
{
  check('window.runtime is an object', typeof window.runtime === 'object' && window.runtime !== null);
  check('runtime.id is a UUID string',
    typeof window.runtime.id === 'string' && /^[0-9a-f-]{36}$/.test(window.runtime.id));
  check('runtime.db has get/put/del/all', ['get','put','del','all'].every(k => typeof window.runtime.db[k] === 'function'));
}

console.log('\n== Test R1.2: db.put then db.get round-trips ==');
{
  // Use a non-reserved store. We'll declare one inline for now by talking to the
  // underlying IDB — Task 2 adds runtime.db.open for proper dynamic declaration.
  // For Task 1, create a "user" store by appending it to REQUIRED_STORES before
  // openDB() runs — but that's bootstrap-time. So for Task 1, the test exercises
  // runtime.db against one of the EXISTING document-allowed stores. Since none
  // currently exist (all built-ins are rwa_*), Task 1 only verifies REJECTION
  // semantics. The round-trip tests land in Task 2 after db.open exists.

  let threw = null;
  try { await window.runtime.db.put('rwa_doc', 'test-key', { foo: 1 }); }
  catch (e) { threw = e; }
  check('writing to reserved rwa_* store rejects',
    threw !== null && /reserved/i.test(threw.message || ''));
}

console.log('\n== Test R1.3: db.get on missing key returns undefined ==');
{
  // Same reserved-only constraint — exercise the rejection branch.
  let threw = null;
  try { await window.runtime.db.get('rwa_undo', 'no-such-key'); }
  catch (e) { threw = e; }
  check('reading from reserved store rejects',
    threw !== null && /reserved/i.test(threw.message || ''));
}

console.log('\n== Test R1.4: db.del on reserved store rejects ==');
{
  let threw = null;
  try { await window.runtime.db.del('rwa_state', 'dirty_count'); }
  catch (e) { threw = e; }
  check('del on reserved rejects',
    threw !== null && /reserved/i.test(threw.message || ''));
}

console.log('\n== Test R1.5: db.all on reserved store rejects ==');
{
  let threw = null;
  try { await window.runtime.db.all('rwa_hist'); }
  catch (e) { threw = e; }
  check('all on reserved rejects',
    threw !== null && /reserved/i.test(threw.message || ''));
}
```

(Round-trip behavior moves to Task 2 once `db.open` exists so we can declare a non-reserved store.)

### Step 1.2: Run tests to fail

```
cd tests && node lens.mjs 2>&1 | grep -E "(FAIL|Test R1)" | head -15
```
Expect: failures on `window.runtime is an object`, etc.

### Step 1.3: Implement

Insert a new section in `seeds/rewritable.html` right after the existing `idbDel` helper (~line 220):

```js
// === Public runtime API (spec §7) ===========================================
// Exposed on window.runtime once the bootstrap IIFE successfully passes
// private-mode detection and openDB(). Documents read/write their own
// structured data through runtime.db.*, blobs through runtime.fs.*, drive the
// modify loop via runtime.modify/commit/undo, and observe state via
// runtime.status + runtime.on.
//
// Reserved-name enforcement: any store name matching ^rwa_ is rejected with
// RwaReservedError. The runtime owns rwa_doc/rwa_undo/rwa_hist/rwa_fsa/
// rwa_state and any future rwa_* (spec §5.3).

class RwaReservedError extends Error {
  constructor(name) { super(`store name '${name}' is reserved (rwa_* is runtime-only)`); this.name = 'RwaReservedError'; }
}

function assertRuntimeDbStore(name) {
  if (typeof name !== 'string' || !name) throw new TypeError('store name must be a non-empty string');
  if (/^rwa_/.test(name)) throw new RwaReservedError(name);
}

async function runtimeDbGet(store, key) {
  assertRuntimeDbStore(store);
  return idbGet(store, key);
}
async function runtimeDbPut(store, key, value) {
  assertRuntimeDbStore(store);
  return idbPut(store, value, key);   // internal idbPut keeps (store, value, key) order
}
async function runtimeDbDel(store, key) {
  assertRuntimeDbStore(store);
  return idbDel(store, key);
}
async function runtimeDbAll(store) {
  assertRuntimeDbStore(store);
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const os = tx.objectStore(store);
    const out = [];
    const req = os.openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return res(out);
      out.push({ key: cur.key, value: cur.value });
      cur.continue();
    };
    req.onerror = () => rej(req.error);
  });
}

// (db.open, db.subscribe, fs.*, modify/commit/undo wrappers, status, on
// land in later tasks of this plan.)
```

Construct `window.runtime` near the end of the bootstrap IIFE, AFTER `openDB()` succeeded but BEFORE document render. Find the place (~line 2620) where bootstrap finishes IDB setup, and add:

```js
window.runtime = {
  id: DOC_UUID,
  db: {
    get: runtimeDbGet,
    put: runtimeDbPut,
    del: runtimeDbDel,
    all: runtimeDbAll,
    // open, subscribe — Task 2
  },
  // fs — Task 5
  // modify/commit/undo/status/on — Task 4
};
```

The bootstrap's existing private-mode early-return (Task 3 of mobile-safety) is in front of this — in private mode `window.runtime` is never constructed, which is correct (no IDB available).

### Step 1.4: Run tests to pass

```
cd tests && node lens.mjs 2>&1 | grep -E "(FAIL|Test R1)" | head -10
```

Expect: zero FAIL under R1.*.

### Step 1.5: Commit

```
git add seeds/rewritable.html tests/lens.mjs
git commit -m "feat(api): runtime.id + runtime.db.{get,put,del,all} with reserved-name guard (spec §7)"
```

---

## Task 2: `runtime.db.open` + dynamic schema versioning

**Why:** Document code needs to declare its own stores. The current IDB connection has a fixed `REQUIRED_STORES` set; opening a new store requires a version bump. Without this, `runtime.db.put('mystore', …)` always fails because the store doesn't exist.

**Files:**
- Modify: `seeds/rewritable.html` (extend openDB infrastructure ~line 172; add `runtimeDbOpen`; expose on `runtime.db`)
- Modify: `tests/lens.mjs` (append `=== Phase: runtime.db.open ===`)

### Step 2.1: Failing tests

Append:

```js
// === Phase: runtime.db.open (spec §7) ===
console.log('\n== Test R2.1: open a new store, round-trip put/get ==');
{
  await window.runtime.db.open('tracker_tasks');
  await window.runtime.db.put('tracker_tasks', 'task-1', { title: 'first' });
  const got = await window.runtime.db.get('tracker_tasks', 'task-1');
  check('round-trip via runtime.db', got && got.title === 'first');
}

console.log('\n== Test R2.2: db.all iterates declared store ==');
{
  await window.runtime.db.put('tracker_tasks', 'task-2', { title: 'second' });
  const all = await window.runtime.db.all('tracker_tasks');
  check('db.all returns array', Array.isArray(all));
  check('contains both entries', all.length === 2 && all.every(e => e.key && e.value));
}

console.log('\n== Test R2.3: db.del removes a record ==');
{
  await window.runtime.db.del('tracker_tasks', 'task-1');
  const all = await window.runtime.db.all('tracker_tasks');
  check('only one entry remains', all.length === 1 && all[0].key === 'task-2');
}

console.log('\n== Test R2.4: db.open on reserved name rejects ==');
{
  let threw = null;
  try { await window.runtime.db.open('rwa_evil'); }
  catch (e) { threw = e; }
  check('reserved name rejects', threw !== null && /reserved/i.test(threw.message || ''));
}

console.log('\n== Test R2.5: db.open is idempotent ==');
{
  await window.runtime.db.open('tracker_tasks');  // second open
  const got = await window.runtime.db.get('tracker_tasks', 'task-2');
  check('existing data preserved across re-open', got && got.title === 'second');
}

console.log('\n== Test R2.6: db.open with autoIncrement ==');
{
  await window.runtime.db.open('events', { autoIncrement: true });
  // autoIncrement stores accept put with null/undefined key — runtime assigns.
  await window.runtime.db.put('events', null, { type: 'click' });
  await window.runtime.db.put('events', null, { type: 'scroll' });
  const all = await window.runtime.db.all('events');
  check('autoIncrement assigned keys', all.length === 2 && typeof all[0].key === 'number');
}
```

### Step 2.2: Run tests to fail

```
cd tests && node lens.mjs 2>&1 | grep -E "Test R2" | head -15
```
Expect: failures (no `runtime.db.open` exists).

### Step 2.3: Implement

In `seeds/rewritable.html`, near `openDB()` (~line 172), refactor to support dynamic version bumps. Strategy:

- Track requested user stores in a module-scoped `Set`.
- `runtimeDbOpen(name, opts)` reads the current DB. If the store is already in `db.objectStoreNames`, resolve immediately. Otherwise: close the current connection, increment version, re-open with the upgrade handler creating the new store.
- Persist user-store declarations to `rwa_state` (key `user_stores`) so they survive reload — on bootstrap, the upgrade handler reads this list and recreates all declared stores.

Add to the seed (after `idbDel`, before the existing public-API section):

```js
// User-declared store registry. Persisted to rwa_state so declarations survive
// reload. The upgrade handler recreates declared stores at version bump.
const userStoreDecls = new Map();  // name -> { autoIncrement: boolean }
let _dbVersionBumpInFlight = null; // Promise<void> when a bump is queued

async function loadUserStoreDecls() {
  const stored = await idbGet(RWA.STATE, 'user_stores');
  if (stored && typeof stored === 'object') {
    for (const [name, opts] of Object.entries(stored)) userStoreDecls.set(name, opts);
  }
}
async function persistUserStoreDecls() {
  const out = {};
  for (const [name, opts] of userStoreDecls) out[name] = opts;
  await idbPut(RWA.STATE, out, 'user_stores');
}

async function bumpVersionAndCreateStore(name, opts) {
  // Coalesce concurrent opens of the same/different stores into one bump.
  if (_dbVersionBumpInFlight) await _dbVersionBumpInFlight;
  _dbVersionBumpInFlight = (async () => {
    // Close the current connection so the new version can open.
    if (_db) { _db.close(); _db = null; }
    userStoreDecls.set(name, opts || {});
    // Re-open. Existing openDB reads REQUIRED_STORES at upgrade; extend it to
    // also create declared user stores.
    await openDB();
    await persistUserStoreDecls();
  })();
  try { await _dbVersionBumpInFlight; } finally { _dbVersionBumpInFlight = null; }
}

async function runtimeDbOpen(name, opts = {}) {
  assertRuntimeDbStore(name);
  const db = await openDB();
  if (db.objectStoreNames.contains(name)) return;
  await bumpVersionAndCreateStore(name, opts);
}
```

Modify the existing `openDB()` upgrade handler (~line 184) so it creates BOTH `REQUIRED_STORES` and any registered user stores:

```js
// Inside openDB's onupgradeneeded:
for (const name of REQUIRED_STORES) {
  if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
}
for (const [name, opts] of userStoreDecls) {
  if (!db.objectStoreNames.contains(name)) {
    db.createObjectStore(name, opts.autoIncrement ? { autoIncrement: true } : undefined);
  }
}
```

Make `openDB()`'s version computation dynamic — current `request = indexedDB.open(dbName, version)` should use a version equal to the maximum of (current DB version, current schema's required version). Strategy: open with version = `Date.now()` or with `version = previous + 1`. The simplest correct path is "open without version, then if missing stores, open again with `existingVersion + 1`":

```js
async function openDB() {
  if (_db) return _db;
  // Step 1: open without version to learn current version.
  const probe = await new Promise((res, rej) => {
    const r = indexedDB.open('rwa_' + DOC_UUID);
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
    r.onblocked = () => rej(new Error('db open blocked by another tab'));
  });
  const needsUpgrade =
    REQUIRED_STORES.some(s => !probe.objectStoreNames.contains(s)) ||
    [...userStoreDecls.keys()].some(s => !probe.objectStoreNames.contains(s));
  if (!needsUpgrade) { _db = probe; return _db; }
  const newVersion = probe.version + 1;
  probe.close();
  _db = await new Promise((res, rej) => {
    const r = indexedDB.open('rwa_' + DOC_UUID, newVersion);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const name of REQUIRED_STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
      for (const [name, opts] of userStoreDecls) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, opts.autoIncrement ? { autoIncrement: true } : undefined);
        }
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
    r.onblocked = () => rej(new Error('db upgrade blocked by another tab'));
  });
  return _db;
}
```

This replaces the existing `openDB()` body. Preserve any existing behavior (the `db open blocked by another tab` error message exists today). The schema-recreate logic from the old code path is folded into the upgrade handler.

In the bootstrap IIFE, after `openDB()` succeeds (and before constructing `window.runtime`):
```js
await loadUserStoreDecls();
```
If any declared stores aren't yet present, this triggers a bump on next `openDB()` call. To make sure they exist when document JS runs, call `openDB()` once more after `loadUserStoreDecls`:
```js
await loadUserStoreDecls();
if ([...userStoreDecls.keys()].some(s => !_db.objectStoreNames.contains(s))) {
  await bumpVersionAndCreateStore([...userStoreDecls.keys()][0], userStoreDecls.get([...userStoreDecls.keys()][0]) || {});
}
```

(The exact form may simplify after writing — the goal is: declared stores are present in `_db` before document code can call `runtime.db.put` on them.)

Wire `runtimeDbOpen` into the runtime object:
```js
window.runtime.db.open = runtimeDbOpen;
```

**Important:** `runtime.db.put` for autoIncrement stores must accept `(store, null, value)` (key is `null`/`undefined`, value follows). Update `runtimeDbPut`:
```js
async function runtimeDbPut(store, key, value) {
  assertRuntimeDbStore(store);
  // For autoIncrement stores, the caller passes a null/undefined key.
  if ((key === undefined || key === null) && userStoreDecls.get(store)?.autoIncrement) {
    // Pass through to a key-less put.
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).put(value);
      req.onsuccess = () => res(req.result);
      req.onerror   = () => rej(req.error);
    });
  }
  return idbPut(store, value, key);  // internal idbPut keeps (store, value, key) order
}
```

### Step 2.4: Run tests to pass

```
cd tests && node lens.mjs 2>&1 | grep -E "(FAIL|Test R2)" | head -15
```
Expect: zero FAIL under R2.*. Also confirm prior 172 lens tests still pass.

### Step 2.5: Commit

```
git add seeds/rewritable.html tests/lens.mjs
git commit -m "feat(api): runtime.db.open with dynamic version bump + autoIncrement"
```

---

## Task 3: `runtime.db.subscribe` via BroadcastChannel

**Why:** Documents need to react to data changes in their own stores (and across tabs). The spec says "BroadcastChannel-backed".

**Files:**
- Modify: `seeds/rewritable.html`
- Modify: `tests/lens.mjs`

### Step 3.1: Failing tests

```js
// === Phase: runtime.db.subscribe (spec §7) ===
console.log('\n== Test R3.1: subscribe fires on local put ==');
{
  await window.runtime.db.open('subscribe_test');
  let called = 0; let lastKey = null;
  const unsub = window.runtime.db.subscribe('subscribe_test', evt => {
    called++; lastKey = evt.key;
  });
  await window.runtime.db.put('subscribe_test', 'k1', { hi: 1 });
  // BroadcastChannel is async; allow a tick.
  await new Promise(r => setTimeout(r, 10));
  check('subscribe fired once', called === 1);
  check('event has key', lastKey === 'k1');
  unsub();
}

console.log('\n== Test R3.2: unsub stops the callback ==');
{
  let called = 0;
  const unsub = window.runtime.db.subscribe('subscribe_test', () => { called++; });
  unsub();
  await window.runtime.db.put('subscribe_test', 'k2', { hi: 2 });
  await new Promise(r => setTimeout(r, 10));
  check('callback not called after unsub', called === 0);
}

console.log('\n== Test R3.3: subscribe on reserved store rejects ==');
{
  let threw = null;
  try { window.runtime.db.subscribe('rwa_hist', () => {}); }
  catch (e) { threw = e; }
  check('reserved name rejects', threw !== null && /reserved/i.test(threw.message || ''));
}
```

### Step 3.2: Run to fail
```
cd tests && node lens.mjs 2>&1 | grep -E "Test R3" | head -10
```

### Step 3.3: Implement

Add to seed (near the other user-db helpers):

```js
const runtimeDbChannels = new Map(); // store -> BroadcastChannel

function getStoreChannel(store) {
  let ch = runtimeDbChannels.get(store);
  if (!ch) {
    ch = new BroadcastChannel('rwa_' + DOC_UUID + ':' + store);
    runtimeDbChannels.set(store, ch);
  }
  return ch;
}

function runtimeDbSubscribe(store, callback) {
  assertRuntimeDbStore(store);
  if (typeof callback !== 'function') throw new TypeError('callback must be a function');
  const ch = getStoreChannel(store);
  const handler = (msg) => { try { callback(msg.data); } catch (_) {} };
  ch.addEventListener('message', handler);
  return () => ch.removeEventListener('message', handler);
}
```

Wire `runtimeDbPut`/`runtimeDbDel` to publish events:

```js
async function runtimeDbPut(store, key, value) {
  assertRuntimeDbStore(store);
  let resolvedKey;
  if ((key === undefined || key === null) && userStoreDecls.get(store)?.autoIncrement) {
    const db = await openDB();
    resolvedKey = await new Promise((res, rej) => {
      const tx = db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).put(value);
      req.onsuccess = () => res(req.result);
      req.onerror   = () => rej(req.error);
    });
  } else {
    await idbPut(store, value, key);  // internal idbPut keeps (store, value, key) order
    resolvedKey = key;
  }
  getStoreChannel(store).postMessage({ kind: 'put', key: resolvedKey });
  return resolvedKey;
}

async function runtimeDbDel(store, key) {
  assertRuntimeDbStore(store);
  await idbDel(store, key);
  getStoreChannel(store).postMessage({ kind: 'del', key });
}
```

Expose:
```js
window.runtime.db.subscribe = runtimeDbSubscribe;
```

**Note on jsdom:** jsdom supports `BroadcastChannel` natively since v22, but messages to other tabs of the same DB don't actually cross — within a single jsdom instance, `BroadcastChannel.postMessage` fires `message` on other listeners of the same channel name. Verify this works in the harness; if not, add a same-channel synchronous dispatch fallback inside `runtimeDbPut`/`runtimeDbDel` (call `handler` synchronously after `postMessage`).

### Step 3.4: Run to pass + Step 3.5: Commit

```
git commit -m "feat(api): runtime.db.subscribe via BroadcastChannel"
```

---

## Task 4: `runtime.modify` / `commit` / `undo` + `status` + `on`

**Why:** Documents drive the modify loop and observe state. These wrap existing internals.

**Files:**
- Modify: `seeds/rewritable.html`
- Modify: `tests/lens.mjs`

### Step 4.1: Failing tests

```js
// === Phase: runtime.modify/commit/undo + status + on (spec §7) ===
console.log('\n== Test R4.1: runtime.status reads dirty/fsa/storage ==');
{
  const s = window.runtime.status;
  check('status is an object', typeof s === 'object' && s !== null);
  check('status.dirty is boolean', typeof s.dirty === 'boolean');
  check('status.fsa is enum',
    ['granted','prompt','denied','unsupported','lost'].includes(s.fsa));
  check('status.storage shape', s.storage && typeof s.storage.usage === 'number'
    || s.storage === null);  // null when estimate() unsupported is OK
}

console.log('\n== Test R4.2: runtime.on(\"modify\", cb) fires ==');
{
  let n = 0;
  const off = window.runtime.on('modify', () => n++);
  // Trigger via the existing test seam.
  await window.submitLens('Direct prose for runtime.modify test.');
  check('modify event fired', n === 1);
  off();
}

console.log('\n== Test R4.3: runtime.on(\"commit\", cb) fires on commit ==');
{
  let n = 0;
  const off = window.runtime.on('commit', () => n++);
  await window.runtime.commit();
  check('commit event fired', n === 1);
  off();
}

console.log('\n== Test R4.4: runtime.undo wraps internal undo ==');
{
  const before = (await window.__getDoc()) || '';
  await window.submitLens('Reversible append.');
  const after = (await window.__getDoc()) || '';
  check('doc changed', after.length > before.length);
  await window.runtime.undo();
  const restored = (await window.__getDoc()) || '';
  check('undo restored prior doc', restored === before);
}

console.log('\n== Test R4.5: runtime.on(\"status\", cb) fires on dirty change ==');
{
  let n = 0;
  const off = window.runtime.on('status', () => n++);
  await window.submitLens('Trigger dirty.');
  check('status fired', n >= 1);
  off();
}

console.log('\n== Test R4.6: unknown event name throws ==');
{
  let threw = null;
  try { window.runtime.on('not-an-event', () => {}); }
  catch (e) { threw = e; }
  check('unknown event rejects', threw !== null);
}
```

(Test R4.4 uses a hypothetical `window.__getDoc` helper — verify the seed already exposes this or use the existing IDB-direct read pattern from earlier tests.)

### Step 4.2: Run to fail

### Step 4.3: Implement

A minimal event emitter:

```js
const runtimeEvents = {
  commit: new Set(),
  modify: new Set(),
  status: new Set(),
};

function runtimeOn(event, callback) {
  if (!Object.prototype.hasOwnProperty.call(runtimeEvents, event)) {
    throw new Error(`unknown event '${event}' (use 'commit', 'modify', or 'status')`);
  }
  if (typeof callback !== 'function') throw new TypeError('callback must be a function');
  runtimeEvents[event].add(callback);
  return () => runtimeEvents[event].delete(callback);
}

function emitRuntimeEvent(event, payload) {
  for (const cb of runtimeEvents[event]) {
    try { cb(payload); } catch (_) { /* swallow user-cb errors */ }
  }
}
```

Wire emit into existing internals — every successful modify path and the two commit paths:

- After `setDirty(true); await rwaBumpDirtyCount().catch(() => {});` in all four modify-success sites: `emitRuntimeEvent('modify', { instruction: instr, lensMeta }); emitRuntimeEvent('status', getStatusSnapshot());`
- After `setDirty(false); await rwaResetOnCommit().catch(() => {});` in both commit-success sites: `emitRuntimeEvent('commit', null); emitRuntimeEvent('status', getStatusSnapshot());`

Status snapshot:

```js
let _fsaState = 'unsupported';
function getStatusSnapshot() {
  return {
    dirty: !!document.getElementById('rwa-st-commit')?.classList.contains('dirty'),
    fsa: _fsaState,
    storage: _storageStat || null,  // captured by rwaCheckQuota
  };
}
```

`_fsaState` should be tracked by the existing FSA flow — find where FSA permission state changes (lines ~2440+, search for `requestPermission`) and update `_fsaState` there. `_storageStat` can be set inside `rwaCheckQuota` (Task 2 of mobile-safety) — after computing usage/quota, store `_storageStat = { usage, quota }`.

Programmatic wrappers:

```js
async function runtimeModify(instruction) {
  return modify(instruction);  // existing internal
}
async function runtimeCommit() {
  return commit();
}
async function runtimeUndo() {
  return undo();
}
```

Wire:

```js
window.runtime.modify = runtimeModify;
window.runtime.commit = runtimeCommit;
window.runtime.undo   = runtimeUndo;
window.runtime.on     = runtimeOn;
Object.defineProperty(window.runtime, 'status', { get: getStatusSnapshot });
```

`status` is a getter so reads always return a fresh snapshot — no stale cached object.

### Step 4.4: Run to pass + Step 4.5: Commit

```
git commit -m "feat(api): runtime.modify/commit/undo + status getter + on('commit'|'modify'|'status')"
```

---

## Task 5: `runtime.fs.*` with per-container OPFS namespacing

**Why:** Spec §7 specifies blob storage via OPFS. The seed has no OPFS code. Per-container namespacing (`_<DOC_UUID>/<path>`) closes the gap from §5.7.

**Files:**
- Modify: `seeds/rewritable.html`
- Modify: `tests/lens.mjs` (OPFS-stub tests)

### Step 5.1: Failing tests

OPFS isn't available in jsdom. Stub `navigator.storage.getDirectory` to return an in-memory tree. Add at the top of the new test phase:

```js
// === Phase: runtime.fs (spec §7, OPFS namespacing) ===
console.log('\n== Test R5.0: install OPFS stub ==');
{
  // Minimal FileSystemDirectoryHandle / FileSystemFileHandle stub.
  // Tree: Map<path, Uint8Array>. Paths are slash-separated.
  const tree = new Map();
  function makeDirHandle(prefix) {
    return {
      kind: 'directory',
      async getDirectoryHandle(name, opts = {}) {
        const sub = prefix + name + '/';
        if (!opts.create && ![...tree.keys()].some(k => k.startsWith(sub))) throw new DOMException('NotFoundError');
        return makeDirHandle(sub);
      },
      async getFileHandle(name, opts = {}) {
        const key = prefix + name;
        if (!opts.create && !tree.has(key)) throw new DOMException('NotFoundError');
        return makeFileHandle(key);
      },
      async removeEntry(name) {
        const key = prefix + name;
        if (tree.has(key)) tree.delete(key);
        else {
          // Recursive removal of subdir
          for (const k of [...tree.keys()]) if (k.startsWith(prefix + name + '/')) tree.delete(k);
        }
      },
      async *entries() {
        const seen = new Set();
        for (const k of tree.keys()) {
          if (!k.startsWith(prefix)) continue;
          const rest = k.slice(prefix.length);
          const head = rest.split('/')[0];
          if (seen.has(head)) continue;
          seen.add(head);
          yield [head, rest.includes('/') ? makeDirHandle(prefix + head + '/') : makeFileHandle(prefix + head)];
        }
      },
    };
  }
  function makeFileHandle(key) {
    return {
      kind: 'file',
      async createWritable() {
        return {
          async write(blob) {
            const buf = await new Response(blob).arrayBuffer();
            tree.set(key, new Uint8Array(buf));
          },
          async close() {},
        };
      },
      async getFile() {
        const bytes = tree.get(key) || new Uint8Array(0);
        return new Blob([bytes]);
      },
    };
  }
  navigator.storage.getDirectory = async () => makeDirHandle('');
  check('opfs stub installed', typeof navigator.storage.getDirectory === 'function');
}

console.log('\n== Test R5.1: fs.write then fs.read round-trip ==');
{
  const blob = new Blob(['hello, world'], { type: 'text/plain' });
  await window.runtime.fs.write('docs/greeting.txt', blob);
  const out = await window.runtime.fs.read('docs/greeting.txt');
  const txt = await out.text();
  check('round-trip text matches', txt === 'hello, world');
}

console.log('\n== Test R5.2: fs.del removes the file ==');
{
  await window.runtime.fs.del('docs/greeting.txt');
  let threw = null;
  try { await window.runtime.fs.read('docs/greeting.txt'); }
  catch (e) { threw = e; }
  check('reading deleted file throws', threw !== null);
}

console.log('\n== Test R5.3: fs.list returns matching paths ==');
{
  await window.runtime.fs.write('a/one.txt', new Blob(['1']));
  await window.runtime.fs.write('a/two.txt', new Blob(['2']));
  await window.runtime.fs.write('b/three.txt', new Blob(['3']));
  const a = await window.runtime.fs.list('a/');
  check('list a/ returns 2 entries', a.length === 2);
}

console.log('\n== Test R5.4: fs.list with _rwa/ prefix rejects ==');
{
  let threw = null;
  try { await window.runtime.fs.list('_rwa/'); }
  catch (e) { threw = e; }
  check('list _rwa/ rejects', threw !== null && /reserved/i.test(threw.message || ''));
}

console.log('\n== Test R5.5: per-container namespacing (paths are isolated) ==');
{
  // Documents see "img/cat.png" but the runtime stores at "_<DOC_UUID>/img/cat.png".
  // Verify by reading the raw tree map for the underlying namespaced path.
  await window.runtime.fs.write('img/cat.png', new Blob(['CAT']));
  // The runtime should not allow a document to read another container's content.
  // We can verify the path got namespaced by listing from the root via the stub:
  const root = await navigator.storage.getDirectory();
  const rootDirs = [];
  for await (const [name, h] of root.entries()) {
    if (h.kind === 'directory') rootDirs.push(name);
  }
  check('root contains the per-container directory',
    rootDirs.some(n => n.startsWith('_' + window.runtime.id.slice(0, 8))));
}
```

### Step 5.2: Run to fail
### Step 5.3: Implement

```js
// === runtime.fs (OPFS-backed, per-container namespaced) ===

// Per-container namespace prefix. Documents see paths like "img/cat.png";
// the runtime stores at "_<DOC_UUID>/img/cat.png".
const OPFS_NS = '_' + DOC_UUID + '/';

function assertUserFsPath(path) {
  if (typeof path !== 'string') throw new TypeError('path must be a string');
  if (path.startsWith('_rwa/')) throw new Error("path '_rwa/' is reserved (runtime-only)");
  if (path.startsWith('/')) throw new Error("path must be relative (no leading slash)");
}

async function opfsRootForContainer() {
  if (!navigator.storage || !navigator.storage.getDirectory) {
    throw new Error('OPFS not supported in this environment');
  }
  const root = await navigator.storage.getDirectory();
  // Walk/create the per-container directory.
  return root.getDirectoryHandle(OPFS_NS.replace(/\/$/, ''), { create: true });
}

async function walkToFile(path, { create } = {}) {
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop();
  let dir = await opfsRootForContainer();
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
  return dir.getFileHandle(name, { create });
}

async function userFsWrite(path, blob) {
  assertUserFsPath(path);
  const handle = await walkToFile(path, { create: true });
  const writable = await handle.createWritable();
  try { await writable.write(blob); } finally { await writable.close(); }
}

async function userFsRead(path) {
  assertUserFsPath(path);
  const handle = await walkToFile(path);
  return handle.getFile();
}

async function userFsDel(path) {
  assertUserFsPath(path);
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop();
  let dir = await opfsRootForContainer();
  for (const p of parts) dir = await dir.getDirectoryHandle(p);
  await dir.removeEntry(name);
}

async function userFsList(prefix) {
  assertUserFsPath(prefix);
  const parts = prefix.split('/').filter(Boolean);
  let dir = await opfsRootForContainer();
  try {
    for (const p of parts) dir = await dir.getDirectoryHandle(p);
  } catch (_) { return []; }
  const out = [];
  for await (const [name, h] of dir.entries()) {
    out.push({ name, kind: h.kind });
  }
  return out;
}

window.runtime.fs = {
  read: userFsRead,
  write: userFsWrite,
  del: userFsDel,
  list: userFsList,
};
```

### Step 5.4: Run to pass + Step 5.5: Commit

```
git commit -m "feat(api): runtime.fs.* via OPFS with per-container _<DOC_UUID>/ namespace (closes §5.7 gap)"
```

---

## Task 6: Spec update + reference regeneration + browser smoke

### Step 6.1: Update `re-write-able-spec.md`

The OPFS namespacing closes a known gap. Make three small edits:

**§5.3 reserved-namespace table.** Find the OPFS row in the storage table:
> OPFS — Binary blobs — Async (sync handles inside Web Workers) — All modern — Document-driven

Add a sentence after the reserved-namespaces list (the one with "OPFS paths: anything under `_rwa/`"):
> Each container's OPFS is namespaced by `_<DOC_UUID>/`. The `runtime.fs.*` API auto-prefixes paths so documents see a private root. The legacy `_rwa/` reservation is still honored for any direct OPFS access that bypasses the runtime API.

**§5.7 last paragraph.** Find:
> OPFS is not yet namespaced — known gap (§11.5).

Replace with:
> Each container's OPFS lives under `_<DOC_UUID>/` and is exposed to the document through `runtime.fs.*`, which auto-prefixes paths. Documents see a clean private root; the on-disk OPFS keeps containers isolated the same way IDB does. Direct OPFS access bypassing the runtime API still shares the null-origin namespace — opt-in to isolation by going through `runtime.fs.*`.

**§11.5.** Find the "OPFS isolation" bullet and update to reflect closure:
> ~~**OPFS isolation.** Containers still share the null-origin OPFS namespace under `_rwa/`...~~ → **OPFS isolation** is closed as of bootstrap 0.10: `runtime.fs.*` namespaces paths under `_<DOC_UUID>/` automatically. (Direct OPFS access bypassing the runtime API is still shared — the API is the isolation boundary.)

**Closing summary.** Add or update the trailing summary paragraph in `re-write-able-spec.md` (`*Spec version 0.10 — public runtime API pass.*`) listing what changed: §7 surface (id, db, fs, modify/commit/undo, status, on), OPFS namespacing, `runtime.shared.*` still deferred to §11.5.

### Step 6.2: Regenerate references

```
node tools/regenerate-refs.mjs
```

Confirm three distinct DOC_UUIDs:
```
grep -E "DOC_UUID = '" seeds/rewritable.html hello.html re-write-able-spec.html
```

### Step 6.3: Full test sweep

```
cd tests && node lens.mjs 2>&1 | tail -5
cd tests && node e2e.mjs 2>&1 | tail -5
cd ../benchmark && npm run conformance 2>&1 | tail -3
```

Must show: lens 172+R-tests pass / 0 fail; e2e 291/0; conformance 42/42.

### Step 6.4: Commit spec + references

```
git add re-write-able-spec.md hello.html re-write-able-spec.html
git commit -m "spec(0.10): public runtime API + OPFS namespacing (regenerate refs)"
```

### Step 6.5: Manual browser smoke

The OPFS path can only be exercised in a real browser. Open `hello.html` in Chrome and in DevTools console:

```js
// Verify the surface exists.
runtime.id;                                   // → '4f6b3cdb-…'
runtime.db && runtime.fs && runtime.modify;   // → all truthy

// IDB round-trip.
await runtime.db.open('demo');
await runtime.db.put('demo', 'k1', { hi: 1 });
await runtime.db.get('demo', 'k1');           // → {hi: 1}
await runtime.db.all('demo');                 // → [{key:'k1',value:{hi:1}}]

// OPFS round-trip.
await runtime.fs.write('hello.txt', new Blob(['hi'], { type: 'text/plain' }));
const b = await runtime.fs.read('hello.txt');
await b.text();                                // → 'hi'

// Events.
const off = runtime.on('commit', () => console.log('committed'));
// ...trigger ⌘S...
off();

// Reserved-name rejection.
await runtime.db.put('rwa_doc', 'k', 'evil');  // → throws RwaReservedError
await runtime.fs.list('_rwa/');                // → throws

// Verify OPFS namespacing — check the actual OPFS root.
const root = await navigator.storage.getDirectory();
for await (const [name, h] of root.entries()) console.log(name, h.kind);
// → should see one directory matching '_' + runtime.id.slice(0,8) (or full DOC_UUID)
```

If any of these fail, file the discrepancy before merge.

---

## Done criteria

- [ ] Tests: 172 + ~22 new R-phase assertions pass; 291/0 e2e; 42/42 conformance.
- [ ] Spec bumped to v0.10; references regenerated; three distinct DOC_UUIDs preserved.
- [ ] Manual browser smoke validates IDB + OPFS paths in real Chrome.
- [ ] `runtime.shared.*` explicitly left unimplemented (still deferred to §11.5).
- [ ] One commit per task (6 total) plus the spec/regen commit (= 7).

## Out of scope (explicit)

- **`runtime.shared.*`** — cross-container composition. Depends on §11.5 (naming, conflict semantics, schema/discovery). Deferred until that question is resolved.
- **OPFS isolation for direct API access** — only `runtime.fs.*` is namespaced. Documents that call `navigator.storage.getDirectory()` directly still share the null-origin OPFS root. This is intentional — the API IS the isolation boundary.
- **Streaming reads/writes** — `runtime.fs.read/write` use Blob. A document that needs streaming (large media) can drop down to OPFS directly.
- **Transactions across stores** — `runtime.db.*` ops are individually atomic but not composable into multi-store transactions. Documents that need this can use raw IDB.
- **Per-event payload shapes are minimal.** `commit` and `status` payloads are nominal — refinement happens once a real document drives the API.

## File-touch summary

```
seeds/rewritable.html          — ~6 task edits (helpers + bootstrap wire-up)
tests/lens.mjs                 — 5 new test phases appended
re-write-able-spec.md          — §5.3, §5.7, §11.5 small edits + version bump
hello.html                     — regenerated
re-write-able-spec.html        — regenerated
```

No changes to CLI, service, benchmark, or other plans.
