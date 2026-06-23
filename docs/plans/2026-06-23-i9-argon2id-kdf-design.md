# I9 — Argon2id vault KDF (pure-JS, CSP-unchanged)

Date: 2026-06-23
Spec: `docs/specs/re-write-able-actions-spec-v0.9-open-items.md` §13, invariants 42–44.

## The "fresh" decision

The build-status note staged I9 as *"revise the frozen CSP + vendor argon2 WASM."*
That plan **violates the spec's own invariants**: §0 ("CSP unchanged"), Inv 26 and
Inv 44 all forbid touching the static frozen `<head>` policy, and the frozen CSP
(`script-src 'unsafe-inline' blob:; worker-src blob:; object-src 'none'`) has **no
`'wasm-unsafe-eval'`** — so WASM instantiation is genuinely blocked, and the staged
fix would rewrite every container's frozen bytes + require amending Inv 26/44.

Fresh resolution: **a pure-JS Argon2id inline module needs no WASM and no CSP
change.** The normative contract already admits this — line 792 says *"single-file
WASM/**inline module** … CSP-safe `'unsafe-inline'`"*, and line 796's CSP clause is
conditional (*"if `'wasm-unsafe-eval'` is needed"*). Pure-JS satisfies **every**
normative MUST while keeping Inv 26/44/18 **held, not breached**. Memory-hardness is
an algorithm property, not an implementation one — pure-JS Argon2id at m=64 MiB still
forces an attacker to allocate 64 MiB per guess.

Cost: latency. Measured noble `argon2id` at m=64 MiB/t=3/p=4 is **~1.5 s** (V8;
browser ≈ similar) vs ~50–100 ms for WASM. This is a once-per-session unlock, behind a
worker + spinner. Accepted.

## Vendoring

- Source: `@noble/hashes/argon2.js` **v2.2.0** (MIT, audited, zero-dep pure-JS).
- Bundled to a self-contained IIFE exposing `globalThis._argon2id(pwBytes, saltBytes,
  {t, m, p, dkLen, key?, ad?})` (maps `ad`→noble `personalization`) via esbuild
  `--bundle --format=iife --minify`. **13 KB** minified. Passes the **RFC 9106 §5.3
  Argon2id test vector** exactly (pwd=01×32, salt=02×16, secret=03×8, ad=04×12,
  m=32,t=3,p=4 → `0d640df5…6b01e659`).
- Inlined in the seed as a **string constant** `ARGON2_SRC`, wrapped in
  `// rwa:argon2:begin` / `// rwa:argon2:end` markers (the test extracts and pins it).
- Regeneration: `tools/vendor-argon2.mjs` (dev-only, `npx esbuild`) emits the string;
  the seed inlines its output. The RFC-vector test is the drift guard.

## Why a string, not inline source

The Worker offload (chosen for anti-jank) needs the argon2 code as a string to build a
`blob:` worker — and the frozen CSP forbids `eval()` on the main thread (no
`'unsafe-eval'`), so the main thread can never turn a string back into code. Keeping
argon2 **only** as `ARGON2_SRC` means:
- **Browser:** `new Worker(blob([ARGON2_SRC, tail]))` — the browser parses the blob
  worker script (allowed by `script-src … blob:`, inherited per 7b). No eval, no WASM.
- **jsdom test (node, no CSP, no Worker):** the test eval's the extracted `ARGON2_SRC`
  into `window._argon2id` and the runtime's sync fallback uses it — same bytes, pinned
  against the RFC vector, no worker needed.

No duplication; the vendored code exists once.

## Runtime

```
ARGON2_SRC = "<13 KB minified IIFE>"                    // string, marker-wrapped

_argon2idViaWorker(pwBytes, saltBytes, params) -> Promise<Uint8Array(32)>
  build blob worker from ARGON2_SRC + handler; postMessage(pw,salt,params);
  15 s timeout; terminate on settle; worker/compute error -> 'vault_kdf_error'

_argon2idHash(pwBytes, saltBytes, params) -> Promise<Uint8Array(32)>
  Worker + Blob + URL available -> _argon2idViaWorker            (browser)
  else globalThis._argon2id is a function -> Promise.resolve(sync) (test/env)
  else throw 'vault_kdf_unavailable'

_vaultDeriveKey(passphrase, saltB64, kdfVersion=0) -> CryptoKey   // +kdfVersion arg
  0 -> PBKDF2-200k(SHA-256) -> AES-GCM-256        (UNCHANGED; I13 callers default here)
  1 -> hash = await _argon2idHash(utf8(pass), b64dec(salt), {t:3,m:65536,p:4,dkLen:32})
       -> importKey('raw', hash, AES-GCM, ['encrypt','decrypt'])
  else -> throw 'vault_unknown_kdf_version'
```

`m:65536` = 65536 KiB = 64 MiB. Workers are already a hard dependency of the skill
system, so a no-Worker browser simply can't use v1 (clear error) — consistent.

## Record + unlock

Record grows to `{salt, kdf_version, check, entries}`.

- `_vaultLoadRec`: stamp `kdf_version:1` **only** on brand-new creation (no IDB record).
  A loaded v0.8 record (no field) reads as `kdf_version || 0` — stays PBKDF2; never
  silently renumbered.
- `runtimeVaultUnlock(passphrase, options?)`:
  - validate `cur = rec.kdf_version || 0` ∈ {0,1} and `options.targetKdfVersion` ∈
    {0,1} or absent — else `_vaultKey=null` + `vault_unknown_kdf_version`.
  - **`check == null`** (empty/new vault): derive at v1 (default), create check, persist,
    set `kdf_version`. This single branch covers new-vault-default-v1 **and**
    auto-migrate-on-empty (the MAY). An explicit `targetKdfVersion` overrides.
  - **`check != null`** (existing vault): derive under `cur`, decrypt check
    (fail → `vault_bad_passphrase`).
    - `target > cur` → **migrate**: derive new key (same salt), decrypt check + every
      entry under old key, re-encrypt all under new key into a *fresh* record object,
      one `idbPut`; **only on put success** assign `_vaultRec`/`_vaultKey` + cache
      session. Put fail → `_vaultKey=null` + `vault_storage_error`; old record intact,
      vault locked. Atomic (one record, one put — attacker sees old-or-new, never
      hybrid; Inv 43).
    - else → cache key under `cur` (byte-equivalent to today for the no-options path).

I13 `runtimeVaultExport`/`Import` are untouched: they call `_vaultDeriveKey(pass, salt)`
with no version arg → PBKDF2 default. The `rwa-vault-export/1` transport format stays
PBKDF2 by design (regression-pinned).

## UI

Settings panel (`#rwa-set-panel`), gated to `PRODUCT_KIND === 'skill-host'`: a row
"Vault KDF" + button "Upgrade to Argon2id". Click → prompt passphrase (migration needs
it) → "Deriving key (Argon2id, ~1–2 s)…" → `runtime.vault.unlock(pass,
{targetKdfVersion:1})` → report success or error. Hidden on non-skill-host kinds.

## Tests — `tests/vault-kdf.mjs` (jsdom + fake-indexeddb)

WHY (Rule 9): the upgrade must produce **real Argon2id** (memory-hard), migrate
existing creds without loss, never silently downgrade, and never break the v0.8 vault or
I13 transport.

- **A** RFC 9106 §5.3 vector against the seed's extracted `ARGON2_SRC` (proves it's
  genuine Argon2id, not merely deterministic).
- **B** new vault → first unlock → `kdf_version===1`; store/retrieve round-trips across
  reload.
- **C** v0.8 record (no field, PBKDF2 check built in-test via WebCrypto) → unlock w/o
  options → succeeds on PBKDF2; round-trips (forward-compat).
- **D** migrate: v0.8-with-data → `unlock({targetKdfVersion:1})` → `kdf_version:1`
  persisted, all entries readable; fresh boot unlocks via Argon2id and reads the creds.
- **E** `kdf_version:99` → `vault_unknown_kdf_version`, vault stays locked.
- **F** atomicity: `idbPut` stubbed to throw during migration → `vault_storage_error`,
  vault locked, old record still unlockable under the old version.
- **G** auto-migrate-empty: record `{kdf_version:0, check:null}` → first unlock adopts
  v1 (the MAY).
- **H** I13 regression: export/import still PBKDF2 and round-trips.

Worker offload itself is browser-territory (jsdom has no `Worker`); the jsdom suite
drives the sync fallback. The worker path is verified in a real browser (Chromium) as
the completion gate.

## Spec / refs / scope

- Mark I9 **BUILT** in the v0.9-open-items spec (§13 + the build-status paragraph);
  record that the pure-JS resolution keeps Inv 26/44/18 held (no CSP change).
- Seed-only (no CLI/service vault mirror — confirmed). Regenerate `hello.html` +
  `re-write-able-spec.html` after the seed change (`node tools/regenerate-refs.mjs`).
- Out of scope: WASM, CSP edits, escrow/account (I13's deferred half), per-record param
  tuning.
```
