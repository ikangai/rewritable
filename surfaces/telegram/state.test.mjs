// Tests for state.mjs — the persisted per-chat binding store (Telegram Phase B).
//
// Every test injects a FAKE in-memory `fs` so the suite runs fully offline — no
// real disk. The fake records each write (path, data, options) so assertions can
// observe not just that a write happened but its EXACT options — the whole point
// of this module is that a token-bearing state file lands on disk `0600`, so a
// test that can't see the write options can't fail when someone drops the mode
// (Rule 9).
//
// Load-bearing properties pinned here:
//   - round-trip: set then get returns the stored binding (the whole {id,token,url})
//   - num/str key equivalence: set(123) is found by get('123') AND get(123). Real
//     bug source — Telegram chat ids arrive as NUMBERS but JSON object keys are
//     STRINGS, so a naive map would silently miss after a reload.
//   - clear removes and persists.
//   - SECURITY: every persist passes { mode: 0o600 } — the secret-file property.
//   - fail-soft: a missing OR corrupt file → empty store, never throws; a set
//     after a corrupt load still works + persists (the bot must survive a
//     truncated/garbage state file across a restart).
//   - persistence shape: the recorded write data parses back to all bindings.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStateStore } from './state.mjs';

const PATH = '/tmp/telegram-state.json';
const BINDING_A = { id: 'abc123', token: 'fnd_live_secret-A', url: 'https://f.test/r/abc123' };
const BINDING_B = { id: 'def456', token: 'fnd_live_secret-B', url: 'https://f.test/r/def456' };

// A fake fs backed by an in-memory file table. Records every write (path, data,
// options). `seed` pre-populates a file so a constructor can "load" it. Throwing
// readers/writers are scripted via `failRead`/`failWrite`.
function makeFakeFs({ seed = {}, failWrite = false } = {}) {
  const files = { ...seed };
  const writes = [];
  const chmods = [];
  return {
    files,
    writes,
    chmods,
    readFileSync(path) {
      if (!(path in files)) {
        const err = new Error(`ENOENT: no such file '${path}'`);
        err.code = 'ENOENT';
        throw err;
      }
      return files[path];
    },
    writeFileSync(path, data, options) {
      if (failWrite) throw new Error('EACCES: write blocked');
      files[path] = data;
      writes.push({ path, data, options });
    },
    chmodSync(path, mode) {
      chmods.push({ path, mode });
    },
  };
}

// --- round-trip ------------------------------------------------------------

test('set then get round-trips the whole binding object', () => {
  const fs = makeFakeFs();
  const store = makeStateStore({ filePath: PATH, fs });

  store.set('100', BINDING_A);

  assert.deepEqual(store.get('100'), BINDING_A);
});

test('get for an unknown chat returns undefined', () => {
  const fs = makeFakeFs();
  const store = makeStateStore({ filePath: PATH, fs });

  assert.equal(store.get('does-not-exist'), undefined);
});

// --- number/string key equivalence (load-bearing) --------------------------

test('set(123) is found by both get("123") and get(123) — chat-id normalization', () => {
  // Telegram chat ids arrive as numbers; JSON object keys are strings. If the
  // store keyed on the raw value, a numeric set would be invisible to a string
  // get after a reload (and vice versa). Both lookups must hit.
  const fs = makeFakeFs();
  const store = makeStateStore({ filePath: PATH, fs });

  store.set(123, BINDING_A);

  assert.deepEqual(store.get('123'), BINDING_A, 'string get must find a numeric set');
  assert.deepEqual(store.get(123), BINDING_A, 'numeric get must find a numeric set');
});

test('a binding set with a string key reloads and is found by a numeric get', () => {
  // The reload path: the persisted JSON has STRING keys. A fresh store loading
  // that file must still answer a numeric get(123).
  const fs = makeFakeFs();
  const first = makeStateStore({ filePath: PATH, fs });
  first.set('123', BINDING_A);

  // Reconstruct over the same fake fs (the file the first store persisted).
  const reloaded = makeStateStore({ filePath: PATH, fs });
  assert.deepEqual(reloaded.get(123), BINDING_A, 'numeric get must find a string-keyed persisted binding');
});

// --- clear -----------------------------------------------------------------

test('clear removes the entry (subsequent get → undefined) and persists', () => {
  const fs = makeFakeFs();
  const store = makeStateStore({ filePath: PATH, fs });
  store.set('100', BINDING_A);
  const writesBefore = fs.writes.length;

  store.clear('100');

  assert.equal(store.get('100'), undefined);
  assert.ok(fs.writes.length > writesBefore, 'clear must persist');
  // The persisted file must no longer contain the entry.
  const persisted = JSON.parse(fs.writes[fs.writes.length - 1].data);
  assert.ok(!('100' in persisted), 'cleared key must be gone from the persisted file');
});

test('clear of an unknown chat persists without throwing', () => {
  const fs = makeFakeFs();
  const store = makeStateStore({ filePath: PATH, fs });

  assert.doesNotThrow(() => store.clear('nope'));
});

// --- 0600 (load-bearing secret-file property) ------------------------------

test('every persist call passes { mode: 0o600 } — token-bearing file is not world-readable', () => {
  const fs = makeFakeFs();
  const store = makeStateStore({ filePath: PATH, fs });

  store.set('1', BINDING_A);
  store.set('2', BINDING_B);
  store.clear('1');

  assert.ok(fs.writes.length >= 3, 'expected a write per mutation');
  for (const w of fs.writes) {
    assert.ok(w.options && w.options.mode === 0o600,
      `every write must carry mode 0o600; got ${JSON.stringify(w.options)}`);
  }

  // writeFileSync's mode is CREATE-only on POSIX; an existing/out-of-band file
  // keeps its old perms. So every persist must ALSO chmod 0600 — that closes
  // the create-only gap and makes the invariant hold on every write, not just
  // the first. One chmod(filePath, 0o600) per mutation (set + set + clear).
  assert.equal(fs.chmods.length, fs.writes.length,
    'every write must be paired with a chmod');
  for (const c of fs.chmods) {
    assert.deepEqual(c, { path: PATH, mode: 0o600 },
      `every chmod must be (filePath, 0o600); got ${JSON.stringify(c)}`);
  }
});

// --- fail-soft load (load-bearing) -----------------------------------------

test('constructing over a missing file → empty store, no throw', () => {
  const fs = makeFakeFs(); // no seed → readFileSync throws ENOENT
  let store;
  assert.doesNotThrow(() => { store = makeStateStore({ filePath: PATH, fs }); });
  assert.equal(store.get('anything'), undefined);
});

test('constructing over a corrupt file → empty store, no throw, and a set still works + persists', () => {
  // A truncated/garbage state file must not brick the bot on restart.
  const fs = makeFakeFs({ seed: { [PATH]: '{not json' } });
  let store;
  assert.doesNotThrow(() => { store = makeStateStore({ filePath: PATH, fs }); });
  assert.equal(store.get('100'), undefined, 'corrupt file loads as empty');

  store.set('100', BINDING_A);
  assert.deepEqual(store.get('100'), BINDING_A, 'set works after a corrupt load');
  const persisted = JSON.parse(fs.writes[fs.writes.length - 1].data);
  assert.deepEqual(persisted['100'], BINDING_A, 'corrupt file is overwritten with valid data');
});

test('constructing over a file that parses to a non-object → empty store, no throw, set still works', () => {
  // JSON can legitimately parse to a non-object (null, an array, a primitive).
  // `new Map(Object.entries(null))` throws; the load() guard
  // (!parsed || typeof !== 'object' || Array.isArray) catches all of these and
  // returns an empty map. This pins that guard, which would otherwise be untested.
  for (const raw of ['null', '[]', '42', '"a string"']) {
    const fs = makeFakeFs({ seed: { [PATH]: raw } });
    let store;
    assert.doesNotThrow(() => { store = makeStateStore({ filePath: PATH, fs }); },
      `non-object JSON ${raw} must load fail-soft`);
    assert.equal(store.get('100'), undefined, `${raw} loads as empty`);

    store.set('100', BINDING_A);
    assert.deepEqual(store.get('100'), BINDING_A, `set works after loading ${raw}`);
  }
});

// --- persistence shape -----------------------------------------------------

test('after two sets the persisted data parses back to both bindings', () => {
  const fs = makeFakeFs();
  const store = makeStateStore({ filePath: PATH, fs });

  store.set('100', BINDING_A);
  store.set('200', BINDING_B);

  const persisted = JSON.parse(fs.writes[fs.writes.length - 1].data);
  assert.deepEqual(persisted, { '100': BINDING_A, '200': BINDING_B });
});

test('default fs is node:fs when not injected (smoke — does not write)', () => {
  // Constructing without an injected fs must default to node:fs (no throw on a
  // missing file thanks to fail-soft). This pins the default seam without
  // touching real disk: a path under os.tmpdir that does not exist loads empty.
  const store = makeStateStore({ filePath: '/nonexistent-rwa-telegram-state-xyz.json' });
  assert.equal(store.get('anything'), undefined);
});
