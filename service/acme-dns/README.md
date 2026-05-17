# Wildcard cert setup for `*.rewritable.ikangai.com`

How we get a Let's Encrypt wildcard cert for share subdomain isolation
(`<short>.rewritable.ikangai.com`). Context: `docs/plans/2026-05-17-share-subdomain-isolation.md`.

Wildcards require DNS-01 challenges (LE forbids HTTP-01 wildcards by
policy). World4You — our DNS host for `ikangai.com` — has no `lego`
provider and their self-serve GUI doesn't expose NS records, so native
DNS-01 against their API isn't an option. The fix: delegate just the
ACME-challenge subdomain to `auth.acme-dns.io`, the public acme-dns
service run by joohoi. Traefik's lego talks to that public service via
its HTTP API; World4You only holds one CNAME.

## What's deployed

```
                                 ┌─────────────────────────────────────────────┐
Let's Encrypt asks:              │ DNS resolution chain                        │
  TXT _acme-challenge            │                                             │
  .rewritable.ikangai.com        │  World4You: CNAME →                         │
       │                         │     <our-fulldomain>.auth.acme-dns.io.      │
       │                         │  joohoi:    TXT   →                         │
       └──── follows chain ──────│     <value Traefik POSTed via HTTP API>     │
                                 └─────────────────────────────────────────────┘
                                                  ▲
Traefik (DNS-01 lego provider):                   │
  POST https://auth.acme-dns.io/update {…}        └──────── writes TXT
```

## DNS records at World4You

| Type  | Name                            | Value                                                          |
|-------|---------------------------------|----------------------------------------------------------------|
| CNAME | `_acme-challenge.rewritable`    | `d3ca54a8-930b-4ba1-9e3d-390644b1ef7a.auth.acme-dns.io.`       |
| A     | `*` (under `rewritable`)        | `185.164.4.77` (wildcard for share hosts; pre-existing)        |

Both are stable — set once, never change unless the acme-dns registration is rotated.

## Traefik config (`/opt/docker/router/docker-compose.yml`)

Additions to the `traefik` service (existing HTTP-01 `letsencrypt`
resolver untouched):

```yaml
services:
  traefik:
    command:
      # … existing flags …
      - "--certificatesresolvers.letsencrypt-dns.acme.dnschallenge=true"
      - "--certificatesresolvers.letsencrypt-dns.acme.dnschallenge.provider=acme-dns"
      - "--certificatesresolvers.letsencrypt-dns.acme.dnschallenge.resolvers=1.1.1.1:53,8.8.8.8:53"
      - "--certificatesresolvers.letsencrypt-dns.acme.email=mt@ikangai.com"
      - "--certificatesresolvers.letsencrypt-dns.acme.storage=/letsencrypt/acme-dns.json"
    environment:
      - "ACME_DNS_API_BASE=https://auth.acme-dns.io"
      - "ACME_DNS_STORAGE_PATH=/letsencrypt/acme-dns-accounts.json"
```

A router that uses the new resolver looks like:

```yaml
labels:
  - "traefik.http.routers.<name>.tls.certresolver=letsencrypt-dns"
  - "traefik.http.routers.<name>.tls.domains[0].main=rewritable.ikangai.com"
  - "traefik.http.routers.<name>.tls.domains[0].sans=*.rewritable.ikangai.com"
```

The issued wildcard cert lands in `/opt/docker/router/letsencrypt/acme-dns.json` and is reused by every subsequent router that requests it — issuance is once-and-done; LE renews automatically every ~60 days.

## Credentials

The acme-dns registration response (username, password, fulldomain, subdomain) lives on the VPS at:

```
/root/acme-dns-rewritable-registration.json    (mode 600, root only)
```

The Traefik-facing copy lives at:

```
/opt/docker/router/letsencrypt/acme-dns-accounts.json    (mode 600)
```

Format is lego's domain-keyed structure:

```json
{
  "rewritable.ikangai.com": {
    "username":   "<from /register>",
    "password":   "<from /register>",
    "fulldomain": "<from /register>",
    "subdomain":  "<from /register>"
  }
}
```

The username/password let any holder write TXT records under the registered acme-dns subdomain. Blast radius is small (only that one subdomain), but treat them like API tokens — don't paste them anywhere they don't need to be.

## Trade-offs

The public `auth.acme-dns.io` instance is a third party in the cert renewal chain. If it goes down or is compromised, our renewals fail or someone else can mint certs for `*.rewritable.ikangai.com`. The service has run reliably for years and is operated by joohoi (the author of acme-dns). We accept the dependency for now because:

1. The alternative — self-hosting acme-dns on the VPS — needs an NS record at World4You delegating `acme-dns.ikangai.com` to the VPS. World4You's GUI doesn't expose NS records, and we didn't pursue a support ticket.
2. Cert renewals are once every ~60 days, so brief outages of the public service rarely matter; we'd see the renewal fail in Traefik logs and could pivot before the cert actually expires (30-day window).
3. Switching providers later is one-CNAME-and-one-Traefik-restart of work.

## Re-registering / recovering

If `/root/acme-dns-rewritable-registration.json` and `acme-dns-accounts.json` are both lost, the cert renewal stops working but the existing cert keeps serving until it expires (~60 days from issuance). To recover:

```sh
# 1. Register a new account
curl -s -X POST https://auth.acme-dns.io/register | tee /root/acme-dns-rewritable-registration.json

# 2. Update the CNAME at World4You to the new fulldomain
#    _acme-challenge.rewritable.ikangai.com → <new>.auth.acme-dns.io.

# 3. Drop the new credentials at /opt/docker/router/letsencrypt/acme-dns-accounts.json
#    (same JSON structure, new username/password/fulldomain/subdomain)
chmod 600 /opt/docker/router/letsencrypt/acme-dns-accounts.json

# 4. Restart Traefik
cd /opt/docker/router && docker compose up -d --force-recreate

# 5. Next renewal (or a forced one via a throwaway router) uses the new account.
```

## Rejected alternative: self-hosted acme-dns

We initially tried to self-host `joohoi/acme-dns` on the VPS at `acme-dns.ikangai.com` with NS delegation from World4You. The deploy artifacts existed briefly in this folder (`config.cfg`, `docker-compose.yml`) before we discovered World4You's GUI rejects NS records on subdomains. The container was stopped and removed (`docker compose down`) before any account was ever registered against it. If we ever migrate DNS to a provider that supports NS records (or pay for a support ticket at World4You to enable NS), the self-hosted path becomes viable again and gives us full control of the trust chain. For now, the public service is the pragmatic choice.
