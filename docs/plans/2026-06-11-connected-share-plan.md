# Connected Share Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A rewritable can be connected to a stable share URL: a Share button in the seed chrome publishes the current bytes to `<short>.rewritable.ikangai.com`, "Publish this version" re-publishes to the same URL (Bearer update token), shares live until unshared (90-day inactivity backstop).

**Architecture:** New `/share` route family on the zero-dep service (sibling of `POST /publish`, which stays byte-untouched for ephemeral 24h shares), reusing the existing publish storage (`DATA_DIR/<short>.{html,json}`) with a `kind:'connected'` metadata class and the hosted runtime's token primitives (`mintToken`/`hashToken`/`verifyToken`). Seed gains a `↗` status-bar button + share panel (same pattern as the ⓘ/⚙/✦ panels) and a machine-local connection record in `rwa_state` (`share_conn` — short, url, token, publishedHash). The token never enters the document or the file; network I/O happens only on explicit share gestures (offline-first preserved).

**Design rationale:** `docs/plans/2026-06-11-save-affordance-framings.md` §7c (local-first framing; TTL decision: durable while active; explicit update only; copy must say *version*, not live share).

**Tech stack:** Node `http` (zero-dep service), `node:test` for service tests, jsdom + fake-indexeddb harness for seed tests.

---

## Wire contract (pinned by tests)

| Route | Auth | Success | Errors |
|---|---|---|---|
| `OPTIONS /share`, `OPTIONS /share/<short>` | — | 204 + CORS preflight headers | — |
| `POST /share` (apex only) | — (per-IP rate limit, shared bucket with /publish) | 201 `{short, url, token, kind:'connected'}` | 400 `validation_failed`, 413, 429, 500, 503 |
| `POST /share/<short>` (apex) | `Authorization: Bearer <token>` (per-capHash rate limit) | 200 `{short, url, updatedAt}` | 401 (missing/bad token), 404 (unknown OR non-connected short), 400, 413, 429 |
| `DELETE /share/<short>` (apex) | Bearer | 204 | 401, 404 |

- Every `/share*` response (including errors and preflight) carries `Access-Control-Allow-Origin: *` — the seed posts from `file://` (null origin). Preflight additionally: `Access-Control-Allow-Methods: POST, DELETE, OPTIONS`, `Access-Control-Allow-Headers: authorization, content-type`, `Access-Control-Max-Age: 86400`. Safe with `*`: no cookies, capability-token auth only.
- Connected metadata JSON: `{kind:'connected', capHash, createdAt, updatedAt, lastActivity, sizeBytes, ip}`. Raw token is NEVER stored (capHash = sha256hex, same as hosted).
- Every publish/update substitutes a fresh `DOC_UUID` (same reason as `/publish`: receiver-side IDB isolation).
- Serve policy (`serveShare`): `kind:'connected'` ignores the 24h `EXPIRY_MS`; instead 410 when `now - lastActivity > NINETY_DAYS_MS` (import from `hosted.js`). A successful GET bumps `lastActivity` (best-effort atomic write). Ephemeral shares (no `kind`) keep exact current behavior.
- Sweep policy (`sweepExpired`): connected → delete when `lastActivity` stale > 90d (or meta unreadable); ephemeral → unchanged 24h on `createdAt`.

## Seed contract (pinned by tests)

- `RWA` constants: `SHARE_BASE:'https://rewritable.ikangai.com'`, `K_SHARE_BASE:'rwa_share_base'` (sessionStorage override, same pattern as `K_BASE_URL_OLLAMA`).
- `rwa_state` key `share_conn`: `{short, url, token, publishedHash, publishedAt}`. Reserved store — runtime-only by existing rules; the record (and the token) never appears in `buildFile()` output because the bootstrap only serializes `INLINE_DOC`.
- New chrome: `↗` button `id="rwa-st-share"` between ✦ and ⌘S; `#rwa-share-panel` styled like `#rwa-info-panel`; all four panels mutually exclusive.
- Copy (the naming hazard is the point — say *version*):
  - Disconnected: heading "Share at a link", body "Anyone with the link sees the version you publish — not your live edits.", button **Create share link**.
  - Connected: the URL (click = copy), line "Published <relative-time> · <this version | behind your latest edits>", buttons **Publish this version** / **Copy link** / **Stop sharing**.
  - Update failure 401/404: record cleared, panel shows "This link can no longer be updated — create a new one." Network failure: record kept, "Sharing service unreachable."
- Freshness = sha-256 hex (via `crypto.subtle`, mirror `_skSha256` :5607) of the current doc vs `publishedHash`.
- No `modifyMutex` guard (share reads committed doc state, same semantics as ⌘S).

---

### Task 1: Service — `POST /share` create + CORS preflight

**Files:**
- Test: `service/tests/share.test.mjs` (new)
- Modify: `service/server.js` (helpers near `handlePublish` :415; routing near :1054)

**Step 1:** Read `service/tests/hosted.test.mjs` top-to-bottom once — copy its spawn-server-on-ephemeral-port + temp `DATA_DIR` harness and its minimal-valid-container fixture verbatim into `share.test.mjs`.

**Step 2:** Write failing tests (each its own `test()`, with a WHY header comment per repo convention — Rule 9):
1. `OPTIONS /share` → 204, headers include ACAO `*`, allow-methods containing POST and DELETE, allow-headers containing `authorization`.
2. `POST /share` with valid container → 201; body `{short, url, token, kind:'connected'}`; `short` matches `/^[0-9a-z]{8}$/`; response has ACAO `*`.
3. Stored `<short>.json`: `kind === 'connected'`, `capHash === sha256hex(token)`, raw token absent from the file; `<short>.html` has a DOC_UUID **different** from the posted container's.
4. `GET /s/<short>` → 200 with the stored bytes.
5. `POST /share` with garbage body → 400 `validation_failed` (+ ACAO).

**Step 3:** Run `node --test service/tests/share.test.mjs` → expect FAIL (404s — route absent).

**Step 4:** Implement in `server.js`:
- `const CORS_SHARE = { 'Access-Control-Allow-Origin': '*' };` and a `sendShareJson(send, status, obj)` that merges `CORS_SHARE` + `JSON_CT`.
- `handleSharePreflight(send)` → `send(204, {...CORS_SHARE, 'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Max-Age': '86400'}, '')`.
- `handleShareCreate(req, send)` — clone `handlePublish`'s body (rate limit via `checkRateLimit`, `readBody`, `validateContainer`, fresh-UUID substitution, `generateShort`, atomic writes) with: `const token = hosted.mintToken(); const capHash = hosted.hashToken(token);` meta `{kind:'connected', capHash, createdAt, updatedAt: createdAt, lastActivity: createdAt, sizeBytes, ip}`; respond 201 `{short, url, token, kind:'connected'}` with ACAO. URL shape identical to publish (host-keyed prod / path-keyed dev).
- Routing (beside the `POST /publish` branch :1060, apex-only): `OPTIONS` on `/share` or `/share/<short>` → preflight; `POST /share` → create. Check `hosted.js` module.exports includes `mintToken`/`hashToken` (hosted.test.mjs exercises them as unit exports — they should already be there; if not, add to the export list).

**Step 5:** Run → PASS. Also `node --test service/tests/hosted.test.mjs service/tests/vendored-apply.test.mjs` → still green.

**Step 6:** Commit: `git commit -m "feat(service): POST /share — connected share create (capHash metadata, CORS)" -- service/server.js service/tests/share.test.mjs` (+ `service/lib/hosted.js` only if exports changed).

### Task 2: Service — `POST /share/<short>` update

**Files:** same two.

**Step 1:** Failing tests:
1. Update with Bearer → 200 `{short, url, updatedAt}`; stored html replaced (assert new marker string present, old absent); DOC_UUID rotated again (differs from both previous stored and posted); `updatedAt`/`lastActivity` bumped, `capHash`/`createdAt` unchanged.
2. Missing token → 401; wrong token → 401 (use a minted-but-different token).
3. Unknown short → 404. Updating an **ephemeral** `/publish` share → 404 (publish one via `POST /publish` in the test, then attempt update).
4. Garbage body with valid token → 400 `validation_failed`, stored bytes untouched.

**Step 2:** Run → FAIL.

**Step 3:** Implement `handleShareUpdate(req, send, short)`:
- `SHORT_RE` gate (else 404). Read `<short>.json`; missing or `meta.kind !== 'connected'` → 404.
- `bearerToken(req)` + `hosted.verifyToken(token, meta.capHash)` → else 401 (preserve `WWW-Authenticate: Bearer` convention if the /r/ handlers set it — mirror them).
- Per-token rate limit: `checkModifyRateLimit(meta.capHash)` → 429.
- Body read + `validateContainer` + fresh-UUID substitution; atomic-write html; meta `updatedAt = lastActivity = Date.now()` (keep other fields); atomic-write json; respond 200 with the same URL shape.
- Routing: `POST /share/<short>` apex-only.

**Step 4:** Run → PASS. **Step 5:** Commit: `git commit -m "feat(service): POST /share/:short — Bearer-authenticated re-publish to a stable short" -- service/server.js service/tests/share.test.mjs`.

### Task 3: Service — `DELETE /share/<short>` + durable-while-active serve/sweep

**Files:** same two.

**Step 1:** Failing tests:
1. DELETE with Bearer → 204; `GET /s/<short>` → 404; files gone. Wrong token → 401 and files remain. DELETE ephemeral short → 404.
2. Hand-write fixtures into DATA_DIR before server start: (a) connected, `createdAt` 3 days ago, `lastActivity` 1 day ago → after startup sweep, files present and `GET /s/<short>` → 200 (the 24h rule must NOT kill connected shares); (b) connected, `lastActivity` 91 days ago → startup sweep deletes; (c) ephemeral, `createdAt` 25h ago → startup sweep deletes (regression pin).
3. GET of a connected share bumps `lastActivity` (read json before/after).

**Step 2:** Run → FAIL (24h logic kills fixture (a)).

**Step 3:** Implement:
- Import `NINETY_DAYS_MS` from `./lib/hosted.js` (already exported).
- `shareExpired(meta, now)` helper: connected → `typeof meta.lastActivity !== 'number' || now - meta.lastActivity > NINETY_DAYS_MS`; else existing `createdAt`/24h rule. Use it in BOTH `sweepExpired` and `serveShare` (replacing the inline checks).
- `serveShare`: on successful connected read, best-effort `atomicWriteFile` of meta with `lastActivity: Date.now()` (wrap in try/catch — a failed bump must not fail the GET).
- `handleShareDelete(req, send, short)`: meta+kind gate → 404; Bearer verify → 401; unlink both files; 204 with ACAO.

**Step 4:** Run → PASS (all three service test files). **Step 5:** Commit: `git commit -m "feat(service): connected shares live while active — 90d-inactivity sweep, DELETE /share/:short" -- service/server.js service/tests/share.test.mjs`.

### Task 4: Seed — connection record + share client (logic before chrome)

**Files:**
- Test: `tests/share.mjs` (new) + a `test:share` script line in `tests/package.json`
- Modify: `seeds/rewritable.html` (RWA constants :348; new "Connected share" block after the info-panel section ~:6155)

**Step 1:** Read one existing seed test end-to-end (`tests/view.mjs`) and the harness crypto wiring in `tests/vault.mjs` (the seed's `crypto.subtle` use must already be satisfied there — copy that setup). Note how tests stub `window.fetch` (bridge.mjs stubs network — check it).

**Step 2:** Write failing tests (blocks, repo style, WHY headers):
- A: clicking `↗` opens `#rwa-share-panel` with the disconnected copy ("Create share link" present; the word "version" present); other panels closed.
- B: stub `window.fetch` → capture request; click Create → exactly one `POST <base>/share`; request body contains `const DOC_UUID` (i.e. full `buildFile` output, not the bare doc); resolve 201 `{short:'abcd1234', url:'https://abcd1234.rewritable.ikangai.com/', token:'tok_test', kind:'connected'}` → panel shows the URL and "Publish this version".
- C: reopen the panel (close/open) → still connected (record persisted in IDB across renders).
- D: click "Publish this version" → `POST <base>/share/abcd1234` with header `Authorization: Bearer tok_test`.
- E: freshness — after B the panel says "this version"; make one edit via the model-free path (`runtime.applyEnvelope` with a tiny `apply_edits`, as write-path.mjs does) → reopen panel → "behind your latest edits".
- F: update resolving 404 → record cleared (reopen → disconnected + "no longer be updated" message). Update rejecting (network error) → record kept.
- G: "Stop sharing" → `DELETE /share/abcd1234` with Bearer; panel → disconnected.
- H: leakage pin — after B, `buildFile(currentDoc)` output does NOT contain `tok_test`, and `#rwa-share-panel.innerHTML` does not contain `tok_test`.
- I: `sessionStorage.rwa_share_base = 'http://127.0.0.1:9999'` → Create posts there (override honored).

**Step 3:** Run `cd tests && node share.mjs` → FAIL (no button).

**Step 4:** Implement the seed logic block (marker comment `// ─── Connected share (chrome affordance) ───`):

```js
const shareBaseUrl = () =>
  (sessionStorage.getItem(RWA.K_SHARE_BASE) || '').trim() || RWA.SHARE_BASE;
async function shareDocHashHex() {
  const d = await getDoc();
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(d));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const getShareConn  = () => idbGet(RWA.STATE, 'share_conn');
const setShareConn  = v  => idbPut(RWA.STATE, v, 'share_conn');
const clearShareConn = () => idbDel(RWA.STATE, 'share_conn');
class ShareError extends Error { constructor(code, msg) { super(msg || code); this.code = code; } }
async function shareRequest(path, { method = 'POST', token, body } = {}) {
  let res;
  try {
    res = await fetch(shareBaseUrl() + path, {
      method,
      headers: { 'Content-Type': 'text/html', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body,
    });
  } catch (e) { throw new ShareError('share_unreachable', 'Sharing service unreachable.'); }
  return res;
}
async function shareCreate() { /* buildFile(await getDoc()) → POST /share → 201 else ShareError('share_failed') → setShareConn({short,url,token,publishedHash:await shareDocHashHex(),publishedAt:Date.now()}) → return conn */ }
async function shareUpdate() { /* conn = await getShareConn(); POST /share/<short> Bearer; 401|404|410 → await clearShareConn() + throw ShareError('share_connection_lost'); ok → setShareConn({...conn, publishedHash, publishedAt: Date.now()}) */ }
async function shareUnshare() { /* DELETE Bearer; on ok OR 401/404 clearShareConn(); network error → keep record, rethrow */ }
```

(Write the bodies in full — the comments above are the contract. `idbDel(store, key)` — check the existing helper signature at its definition before using.)

**Step 5:** Implement minimal chrome so the tests can drive it (full styling polish is Task 5): button + panel div + `renderSharePanel()` + wiring. Run → PASS.

**Step 6:** Commit: `git commit -m "feat(seed): connected-share client — share_conn record, create/update/unshare against /share" -- seeds/rewritable.html tests/share.mjs tests/package.json`.

### Task 5: Seed — share panel chrome polish

**Files:** `seeds/rewritable.html` (CSS block near `#rwa-info-panel` :66-90; `buildUI` :1092-1132; panel handlers :1289-1311), `tests/share.mjs` (assert mutual exclusion).

**Steps:** failing test for mutual exclusion (share open closes ⚙/ⓘ/✦ and vice versa — extend each existing handler) → implement: `#rwa-share-panel` CSS cloned from info-panel; busy state (buttons disabled while a request is in flight); click-URL-to-copy via `navigator.clipboard.writeText` with a "copied ✓" flash (guard `navigator.clipboard?` — jsdom); relative-time formatter for "Published <when>" (minutes/hours/days — small inline helper, no dependency). Run full `tests/share.mjs` → PASS. Then the neighbor suites: `node view.mjs && node lens.mjs && node e2e.mjs && node inline-edit.mjs` → green (chrome additions must not disturb them). Commit: `git commit -m "feat(seed): share panel chrome — ↗ button, version copy, copy-link, stop sharing" -- seeds/rewritable.html tests/share.mjs`.

### Task 6: References + spec + CLAUDE.md

**Files:** `hello.html`, `re-write-able-spec.html` (regenerated), `re-write-able-spec.md`, `CLAUDE.md`.

**Steps:**
1. `node tools/regenerate-refs.mjs` (mandatory after any seed change).
2. `re-write-able-spec.md`: add §5.11 "Connected share": the chrome affordance; `share_conn` as a reserved `rwa_state` key; token is machine-local capability, never serialized into the file (the bootstrap only rewrites `INLINE_DOC` — invariant 1 covers it); fresh `DOC_UUID` per publish (receiver isolation); network I/O only on explicit share gestures; the version-not-live naming rule. Bump the spec version + closing summary line (current pattern: trailing italic block).
3. `CLAUDE.md`: routing entry "**Sharing (connected share / share URL)**" → `docs/plans/2026-06-11-save-affordance-framings.md` (rationale) AND `service/server.js` (/share routes) AND `seeds/rewritable.html` (connected-share block) AND `tests/share.mjs` + `service/tests/share.test.mjs`; service-conventions bullet for the `/share` route family (CORS rationale, two sweep classes, `/publish` untouched).
4. Commit: `git commit -m "docs(spec): §5.11 connected share + routing; regenerate references" -- re-write-able-spec.md CLAUDE.md hello.html re-write-able-spec.html`.

### Task 7: Full battery + merge

**Steps:**
1. `cd tests && npm test && node view.mjs && node lens.mjs && node share.mjs && node inline-edit.mjs && node write-path.mjs && node image-assets.mjs && node skin-compose.mjs` (the suites that boot the full chrome).
2. `node --test service/tests/` — all three files.
3. `cd benchmark && npm run conformance` — 86/86 (chrome addition must not move it).
4. REQUIRED SUB-SKILL superpowers:verification-before-completion — paste actual outputs, no claims without runs.
5. Merge `feat/connected-share` → local main with `--no-ff` (repo convention; UNPUSHED — Martin pushes). Announce in group chat with file list.
