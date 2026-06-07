// Persisted per-chat binding store (Telegram Phase B).
//
// The Phase B bot binds each Telegram chat to ONE hosted rewritable:
// `chatId -> { id, token, url }` (the id + capability token + capability url
// minted by the foundation's POST /r). This store persists those bindings to a
// JSON file so a bot restart keeps them.
//
// One seam keeps it offline-testable (mirroring `telegram-api.mjs` / `foundation-api.mjs`):
// `fs` (default `node:fs`). The file is LOADED ONCE synchronously at construction
// and held in an in-memory map; every mutation rewrites the whole file.
//
// SECURITY — the binding carries a capability token (a leaked token === write
// access to that rwa). So the state file MUST NOT be world-readable: every write
// passes `{ mode: 0o600 }`. Pinned by `state.test.mjs`.
//
// FAIL-SOFT — a missing OR corrupt/unparseable file loads as EMPTY and never
// throws. A truncated/garbage state file must not brick the bot on restart; the
// next `set` overwrites it with valid data.
//
// KEY NORMALIZATION — Telegram chat ids arrive as NUMBERS, but JSON object keys
// are STRINGS. Every chatId is coerced to a string key so `get(123)` finds what
// `set('123', …)` (or the persisted file) stored, and vice versa.

import nodeFs from 'node:fs';

export function makeStateStore({ filePath, fs = nodeFs } = {}) {
  // Coerce any chatId (number or string) to a consistent string key.
  const key = (chatId) => String(chatId);

  // Load once. A missing file (ENOENT) or unparseable JSON → empty map.
  // We also guard the parsed value: JSON could legitimately parse to a non-object
  // (e.g. `null`, an array), which we treat as corrupt → empty.
  function load() {
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      return new Map();
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map();
      return new Map(Object.entries(parsed));
    } catch {
      return new Map();
    }
  }

  const map = load();

  // Persist the whole map as a JSON object. The 0600 mode is the load-bearing
  // secret-file property — never drop it.
  function persist() {
    const obj = Object.fromEntries(map);
    fs.writeFileSync(filePath, JSON.stringify(obj), { mode: 0o600 });
    // writeFileSync's mode applies only at CREATE on POSIX; an existing or
    // out-of-band-created file keeps its old perms. chmod every write so the
    // token-bearing file is always 0600 (the security invariant this store owns).
    fs.chmodSync(filePath, 0o600);
  }

  function get(chatId) {
    return map.get(key(chatId));
  }

  function set(chatId, binding) {
    map.set(key(chatId), binding);
    persist();
  }

  function clear(chatId) {
    map.delete(key(chatId));
    persist();
  }

  return { get, set, clear };
}
