// Tests for runPoll(deps) — the long-poll loop in bot.mjs.
//
// runPoll is pure-ish over injected deps: a fake `api.getUpdates`, fake
// `loadOffset`/`saveOffset`, a fake `handle` (recording + able to throw), a
// `shouldStop` that flips after N polls so the loop terminates, and a `log`
// sink. So the whole suite runs offline — no token, no network, no disk, no
// real subprocess, no timers.
//
// Each test encodes WHY the offset semantics matter (Rule 9). The two
// load-bearing invariants under test:
//   - OFFSET ADVANCES + PERSISTS to update_id+1 AFTER handling-or-error, so a
//     transient handler failure does NOT cause the same update to be reprocessed
//     forever (Telegram drops <= offset-1 on the next getUpdates).
//   - LOOP SURVIVAL: a thrown handler is caught + logged and the loop keeps
//     going (one bad message can't kill the bot) — a test that only checked the
//     reply couldn't fail if someone let the throw escape.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runPoll, resolveHasBackendKey } from './bot.mjs';

// shouldStop that returns false for the first `n` checks, then true. runPoll
// checks shouldStop() at the TOP of each iteration, so n=1 means "run exactly
// one getUpdates batch then stop".
function stopAfter(n) {
  let checks = 0;
  return () => checks++ >= n;
}

// A getUpdates that returns scripted batches in order, then [] forever.
function scriptedGetUpdates(batches) {
  const calls = [];
  let i = 0;
  return {
    calls,
    fn: async (offset) => {
      calls.push(offset);
      return i < batches.length ? batches[i++] : [];
    },
  };
}

function makeOffsetStore(initial) {
  let value = initial;
  const saves = [];
  return {
    saves,
    loadOffset: () => value,
    saveOffset: (n) => { value = n; saves.push(n); },
    get value() { return value; },
  };
}

test('each update in the batch is handled in order', async () => {
  const gu = scriptedGetUpdates([[{ update_id: 10 }, { update_id: 11 }]]);
  const handled = [];
  await runPoll({
    api: { getUpdates: gu.fn },
    loadOffset: () => undefined,
    saveOffset: () => {},
    handle: async (u) => { handled.push(u.update_id); },
    shouldStop: stopAfter(1),
    log: () => {},
  });
  // WHY: updates must be processed in the order Telegram delivered them — a
  // reorder would mis-advance the offset and could drop or duplicate work.
  assert.deepEqual(handled, [10, 11]);
});

test('offset seeds from loadOffset() on the first getUpdates call', async () => {
  const gu = scriptedGetUpdates([[{ update_id: 42 }]]);
  await runPoll({
    api: { getUpdates: gu.fn },
    loadOffset: () => 7,
    saveOffset: () => {},
    handle: async () => {},
    shouldStop: stopAfter(1),
    log: () => {},
  });
  // WHY: the persisted offset is the resume point — if the first poll ignored
  // it, every restart would re-deliver already-handled updates.
  assert.equal(gu.calls[0], 7);
});

test('saveOffset is called with maxUpdateId+1 after the batch', async () => {
  const gu = scriptedGetUpdates([[{ update_id: 10 }, { update_id: 11 }]]);
  const store = makeOffsetStore(undefined);
  await runPoll({
    api: { getUpdates: gu.fn },
    loadOffset: store.loadOffset,
    saveOffset: store.saveOffset,
    handle: async () => {},
    shouldStop: stopAfter(1),
    log: () => {},
  });
  // WHY: persisting update_id+1 is what tells Telegram "I'm done with <=11";
  // the last persisted value must be max+1 (11+1) or the next poll re-delivers.
  assert.equal(store.value, 12);
  assert.deepEqual(store.saves, [11, 12]);
});

test('a thrown handler does not stop the loop and offset still advances past it', async () => {
  const gu = scriptedGetUpdates([[{ update_id: 20 }, { update_id: 21 }]]);
  const store = makeOffsetStore(undefined);
  const handled = [];
  const logged = [];
  let first = true;
  await runPoll({
    api: { getUpdates: gu.fn },
    loadOffset: store.loadOffset,
    saveOffset: store.saveOffset,
    handle: async (u) => {
      if (first) { first = false; throw new Error('boom on first update'); }
      handled.push(u.update_id);
    },
    shouldStop: stopAfter(1),
    log: (...args) => logged.push(args),
  });
  // WHY (loop survival): the second update must still be handled even though
  // the first threw — one bad message can't kill the bot.
  assert.deepEqual(handled, [21]);
  // WHY (no infinite reprocess): the offset must advance PAST the thrown update
  // (to 21) and persist, so the failing update is not reprocessed forever.
  assert.equal(store.saves[0], 21);
  assert.equal(store.value, 22);
  // The throw is logged host-side, not swallowed silently (Rule 12).
  assert.ok(logged.length >= 1);
});

test('empty batch re-polls without saving, then stops', async () => {
  // Both polls return [] (scriptedGetUpdates returns [] past the end). With
  // stopAfter(2) the loop runs two iterations, both empty.
  const gu = scriptedGetUpdates([[]]);
  const store = makeOffsetStore(3);
  await runPoll({
    api: { getUpdates: gu.fn },
    loadOffset: store.loadOffset,
    saveOffset: store.saveOffset,
    handle: async () => {},
    shouldStop: stopAfter(2),
    log: () => {},
  });
  // WHY: an empty batch means "nothing new" — the loop must re-poll (>=2
  // getUpdates calls) and must NOT advance/persist the offset on emptiness.
  assert.ok(gu.calls.length >= 2);
  assert.deepEqual(store.saves, []);
  assert.equal(store.value, 3);
});

// ── resolveHasBackendKey(env) — agent-fill gate matches CLI capability ────────
// WHY: the gate must mirror the CLI's actual backend resolution. `rwa create`
// spawns with inherited env and no --backend flag, so it uses
// RWA_BACKEND||'openrouter'. A keyless backend (ollama/lmstudio) works there
// with NO api key — gating on an openrouter key would wrongly tell a keyless
// host "agent-fill isn't configured" (review concern #1). A test that only
// checked the openrouter case couldn't catch that regression.

test('resolveHasBackendKey: keyless backends are usable with no keys', () => {
  assert.equal(resolveHasBackendKey({ RWA_BACKEND: 'ollama' }), true);
  assert.equal(resolveHasBackendKey({ RWA_BACKEND: 'lmstudio' }), true);
});

test('resolveHasBackendKey: default backend (openrouter) requires a key', () => {
  // No RWA_BACKEND → defaults to openrouter, which needs a key.
  assert.equal(resolveHasBackendKey({}), false);
  assert.equal(resolveHasBackendKey({ RWA_OPENROUTER_KEY: 'k' }), true);
  assert.equal(resolveHasBackendKey({ OPENROUTER_API_KEY: 'k' }), true);
});

test('resolveHasBackendKey: explicit openrouter without a key is not usable', () => {
  assert.equal(resolveHasBackendKey({ RWA_BACKEND: 'openrouter' }), false);
});
