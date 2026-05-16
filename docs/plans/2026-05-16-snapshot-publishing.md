# Snapshot Publishing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users publish a snapshot of a rewritable to `rewritable.ikangai.com/s/<short>` from the `/new` and `/import` pages, with anonymous 24h expiry, no accounts.

**Architecture:** Add a `POST /publish` endpoint to `service/server.js` that accepts a rewritable `.html` body, generates a short code, substitutes a fresh `DOC_UUID`, and stores the bytes plus a metadata sidecar on local disk (`/app/data/`). A `GET /s/<short>` endpoint serves the stored bytes with full CSP-relaxed HTML headers. A startup + hourly sweep deletes anything older than 24h. The service stays zero-dependency Node `http`. UI integration on `/new` and `/import` adds a "Publish & Share" affordance that POSTs the same bytes the user would otherwise download. Same-origin `/s/<short>` is the v1 trust model — viewers' edits land in their own browser's IDB scoped to `rwa_<DOC_UUID>` for that share, never propagate back.

**Tech Stack:** Node `http`, local filesystem, no new deps.

**Out of scope for v1:** accounts (everything is anonymous + 24h), paywall / password, custom subdomains, subdomain-level origin isolation (viewers of two different shares share `rewritable.ikangai.com` origin — fine for v1 because IDB is namespaced by per-share UUID, but OPFS could leak across; documented as a known gap), CLI `rwa publish`, in-container "Share" button (later).

---

### Task 1: Storage helpers — short codes, paths, write/read/expire

**Files:**
- Modify: `service/server.js` (add helpers near the top, before the request handler)

**Behavior:**
- `DATA_DIR = process.env.RWA_DATA_DIR || path.join(__dirname, 'data')`. Create at startup if missing.
- `SHORT_RE = /^[0-9a-z]{8}$/` — 8 chars from `0-9a-z` = ~41 bits, unguessable enough for the 24h window and avoids casing/URL issues. Generate via `crypto.randomBytes` mapped through the alphabet, retry on filename collision.
- Two files per share: `<short>.html` (the bytes) and `<short>.json` (metadata: `{createdAt, sizeBytes, ip}`). Keeping them separate avoids parsing HTML to find creation time during cleanup sweeps.
- `expiredAt(meta) = meta.createdAt + 24*60*60*1000`. Use ms epoch consistently.

**Validation predicate** for uploaded bytes:
- Must be UTF-8 decodable.
- Must contain exactly one `const DOC_UUID = '...';` line matching the seed pattern (so we can substitute).
- Must contain `<script id="rwa-bootstrap">` (the runtime anchor).
- Must contain `const INLINE_DOC = ` (the document marker).
- Max size 25 MB (rwa containers can carry inline images; 25 MB is comfortable but caps abuse).

---

### Task 2: POST /publish endpoint

**Files:**
- Modify: `service/server.js`

Switch the `req.method !== 'GET' && !isHead` early-out to allow `POST /publish`. Everything else still 405s on non-GET.

Handler:
1. Cap body at 25 MB streaming (track total, abort if exceeded).
2. Decode as UTF-8, run the validation predicate. On failure → `400 application/json {error, detail}`.
3. Substitute `DOC_UUID` with a fresh `crypto.randomUUID()` (so each share has its own per-container IDB namespace).
4. Generate short code, retry on collision (≤5 tries).
5. Write `<short>.html` atomically (`fs.writeFile` to `<short>.html.tmp` then `rename`).
6. Write `<short>.json` with `{createdAt: Date.now(), sizeBytes, ip: req.socket.remoteAddress}` (atomic too).
7. Respond `201 application/json {short, url: 'https://' + req.headers.host + '/s/' + short, expiresAt}` with the same SECURITY_HEADERS.

**Rate limit (sliding window in-memory):** per-IP map of timestamps, allow 10 publishes per hour. Reject with `429 {error: 'rate_limited', retryAfterSec}`. Clear stale buckets on every request to avoid unbounded growth.

---

### Task 3: GET /s/<short> endpoint

**Files:**
- Modify: `service/server.js`

Match `^/s/([0-9a-z]{8})$`. Anything else under `/s/` → 404.

1. Validate short against `SHORT_RE`. 404 on malformed.
2. `fs.readFile('<short>.json')` → if ENOENT, 404 with `text/plain "not found\n"`.
3. If `Date.now() > expiredAt(meta)`, 410 Gone with `text/plain "expired\n"`. (Don't delete inline — the sweep handles it.)
4. `fs.readFile('<short>.html')` → 200 `text/html; charset=utf-8`. Headers: SECURITY_HEADERS plus `Cache-Control: public, max-age=300` (each share is immutable; 5 min lets CDN cache while still letting an expired share flip to 410 quickly).

**Why HEAD must work:** existing handler closes over `isHead`. Just plumb the same `send()` through this branch.

---

### Task 4: Expiry sweep on startup + hourly

**Files:**
- Modify: `service/server.js`

After `loadDemoTree`, run `sweepExpired()` once. Then `setInterval(sweepExpired, 60*60*1000)`. The interval is `.unref()`'d so it doesn't keep the event loop alive past `SIGTERM`.

`sweepExpired()`:
- `readdirSync(DATA_DIR)`, group by short code.
- For each, read the `.json`; if expired or `.json` missing for orphaned `.html`, unlink both. Log `expired N (kept M)`.
- Wrap in try/catch — sweep errors must not crash the server.

---

### Task 5: Volume mount + Dockerfile

**Files:**
- Modify: `service/Dockerfile`, `service/docker-compose.prod.yml`, `service/docker-compose.yml`
- Add: `service/data/.gitkeep`, update `.gitignore` to exclude `service/data/*` except `.gitkeep`

- `Dockerfile`: `RUN mkdir -p /app/service/data` and a `VOLUME ["/app/service/data"]`.
- `docker-compose.prod.yml`: named volume `rwa_shares:/app/service/data`.
- `docker-compose.yml` (dev): bind-mount `./data:/app/service/data` so local runs persist across `down/up`.
- `.gitignore`: `service/data/*\n!service/data/.gitkeep` so the dir exists in checkouts but the contents stay untracked.

---

### Task 6: UI — Publish & Share on /import

**Files:**
- Modify: `service/public/import.html`

After successful import (currently triggers a download), keep the download but additionally surface a "Publish & Share" button. On click: POST the same bytes (already in memory as the spliced seed) to `/publish`, on `201` show the share URL + a "copy" button, on error show the failure code.

Layout: stash the `success` status, replace the status area with a small share card (URL in a readonly input, copy button, "expires in 24h" hint). On copy, briefly flip the button label.

---

### Task 7: UI — Publish & Share on /new

**Files:**
- Modify: `service/public/new.html`

Currently `/new` auto-clicks the download link. Preserve that. Below the existing "if your download did not start..." line, add a "publish this version online" link/button. On click: `fetch('/rewritable.html')` to grab a fresh container, then POST to `/publish` and surface the share card.

Trade-off acknowledged in the page text: "publishing fetches a fresh container — the published version's UUID won't match your downloaded copy." That keeps each share's IDB namespace unique.

---

### Task 8: CLAUDE.md update

**Files:**
- Modify: `CLAUDE.md`

- Update the `service/` description to mention `/publish` and `/s/<short>`.
- Note the new reserved URL prefix (`/s/`) in conventions.
- Note that the service now writes to `service/data/` and that local dev uses a bind-mount.
- Add `service/data/` to the reserved namespaces section if appropriate.

---

### Task 9: Manual verification (curl + browser)

No automated test harness exists for the service. Verify with:

1. `docker compose -f service/docker-compose.yml up --build` (or run server directly: `cd service && node server.js`).
2. `curl -X POST --data-binary @hello.html -H 'Content-Type: text/html' http://localhost/publish` → expect `201 {short, url, expiresAt}`.
3. `curl -i http://localhost/s/<short>` → expect `200 text/html` with body matching uploaded bytes but with a different `DOC_UUID`.
4. `curl -i http://localhost/s/zzzzzzzz` → expect `404`.
5. `curl -X POST --data-binary @service/Dockerfile http://localhost/publish` → expect `400 {error: 'validation_failed', detail: ...}`.
6. Send 11 valid POSTs rapidly → expect 11th to return `429`.
7. Browser: open `http://localhost/import`, drop a small `.md`, click Publish, click the share URL, confirm the doc renders.
8. Browser: open `http://localhost/new`, click "publish this version online", confirm a share URL appears and resolves.
9. Restart the container with the dev compose file → existing shares still served (verifies volume mount).

---

### Task 10: Commit

One commit covering all of the above:

```
feat(service): snapshot publishing — POST /publish + GET /s/<short>

Adds anonymous 24h snapshot hosting at rewritable.ikangai.com/s/<short>.
A fresh DOC_UUID is substituted per share so viewers' edits land in an
isolated per-share IDB namespace. Hourly sweep + startup sweep delete
expired files; rate-limited to 10 publishes/hour per IP. Volume mount
persists shares across container restarts.

UI: /import and /new pages gain a "Publish & Share" button alongside
the existing download flow. Same-origin /s/<short> is the v1 trust model
— viewers' edits stay in their browser, never propagate back to the
publisher.

Spec / docs: CLAUDE.md updated to reflect the new endpoints and reserved
URL prefix.
```

---

## Risks / non-obvious points

- **Same-origin OPFS leakage.** Two shares on the same origin share OPFS (`_rwa/` paths). The per-container IDB namespace (`rwa_<DOC_UUID>`) isolates structured stores, but OPFS is shared null-namespace within an origin. v1 is documented as known-gap; subdomain isolation (`<short>.s.rewritable.ikangai.com`) is the eventual fix and would require Traefik wildcard routing + cert.
- **No content moderation.** Anyone can publish anything; 24h expiry is the only mitigation. Acceptable for v1, but a takedown path should exist (operator-only manual delete of `<short>.{html,json}`).
- **Body size limit.** 25 MB caps inline-image-heavy containers but keeps abuse bounded. If users hit it, raise — don't add chunked uploads.
- **No CSRF protection.** `/publish` accepts cross-origin POSTs. The published bytes are public anyway and rate-limited per IP, so CSRF doesn't yield privileged action — acceptable.
- **UUID substitution + bytes-don't-match-publisher.** Documented in the UI text on /new. The user's downloaded copy and the published version are intentionally different containers.
