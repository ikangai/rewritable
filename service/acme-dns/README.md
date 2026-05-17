# acme-dns deployment

Self-hosted DNS-01 challenge proxy for Let's Encrypt wildcard certs at
`*.rewritable.ikangai.com`. World4You (our DNS host for `ikangai.com`)
has no `lego` provider, so Traefik can't talk to them directly for the
DNS-01 challenge. acme-dns sidesteps that: World4You delegates one
subdomain to us, and Traefik talks to acme-dns instead.

This README is the runbook for Task 1 of
`docs/plans/2026-05-17-share-subdomain-isolation.md`. Run through it
once; the rest of the plan can ship on top.

## How it works

```
Let's Encrypt asks:  TXT _acme-challenge.rewritable.ikangai.com
                        │
World4You:              │  CNAME → <random>.acme-dns.ikangai.com.
                        ▼
World4You:              │  NS    → acme-dns.ikangai.com.
                        ▼
185.164.4.77:53 (acme-dns container):
                        TXT <random> = "<lego-supplied-value>"
                        ▲
                        │  Traefik POSTs the value here via HTTP API
                        │  on the docker network.
Traefik:               ─┘
```

World4You holds two new records: one A (the glue to find the
nameserver) and one NS (delegating the zone). Plus one CNAME per
delegated subdomain. None of these change after setup.

## Deploy

### 1. Copy files to the VPS

From the repo root:

```sh
rsync -av service/acme-dns/ root@185.164.4.77:/opt/docker/acme-dns/
```

### 2. Start the container

```sh
ssh root@185.164.4.77
cd /opt/docker/acme-dns
docker compose up -d
docker compose logs --tail=50 acme-dns
```

Confirm port 53 is bound on the public interface:

```sh
ss -tulpn | grep :53
# Expect a row with 0.0.0.0:53 and the container's process.
```

If something else owns the port (typically systemd-resolved), see
Troubleshooting below.

### 3. Add the delegation records at World4You

In World4You's DNS panel for `ikangai.com`, add **both**:

| Type | Name      | Value                          | TTL  |
|------|-----------|--------------------------------|------|
| A    | acme-dns  | `185.164.4.77`                 | 3600 |
| NS   | acme-dns  | `acme-dns.ikangai.com.`        | 3600 |

The trailing dot on the NS value is significant — it tells World4You
the value is a fully-qualified domain. Both records are required: the
NS delegates the zone, the A is the glue that tells resolvers where
the delegated nameserver actually lives.

Wait 5–30 minutes for propagation, then verify from a public resolver:

```sh
dig +short A acme-dns.ikangai.com @1.1.1.1
# Expect: 185.164.4.77

dig +short NS acme-dns.ikangai.com @1.1.1.1
# Expect: acme-dns.ikangai.com.

dig SOA test123.acme-dns.ikangai.com @1.1.1.1
# Expect: an SOA response from the acme-dns container, NOT an
# NXDOMAIN from World4You. If you see NXDOMAIN, the NS delegation
# hasn't propagated yet — wait longer.
```

### 4. Register the rewritable account

```sh
ssh root@185.164.4.77
curl -s -X POST http://127.0.0.1:8081/register | tee /tmp/acme-dns-rewritable.json
```

Response is JSON like:

```json
{
  "username":   "abc12345-d6f3-4b8c-...",
  "password":   "<long-random-string>",
  "fulldomain": "abc12345-d6f3-4b8c-....acme-dns.ikangai.com",
  "subdomain":  "abc12345-d6f3-4b8c-...",
  "allowfrom":  []
}
```

Keep this. Traefik needs the whole object as its acme-dns accounts
entry; you need `fulldomain` for the next step.

### 5. Add the CNAME at World4You

Using the `fulldomain` from step 4:

| Type  | Name                            | Value                                         | TTL  |
|-------|---------------------------------|-----------------------------------------------|------|
| CNAME | `_acme-challenge.rewritable`    | `<fulldomain>.` (trailing dot, from step 4)  | 3600 |

Verify:

```sh
dig +short CNAME _acme-challenge.rewritable.ikangai.com
# Expect: <fulldomain>.acme-dns.ikangai.com.

dig +short TXT _acme-challenge.rewritable.ikangai.com
# Expect: empty (no challenge in flight yet — but the resolution chain works)
```

### 6. Add the cert resolver to Traefik

Traefik on this host (`/opt/docker/router/docker-compose.yml`) is
configured via CLI flags inside the `command:` block, not a separate
static YAML file. Add the new resolver as additional flags, the lego
env vars as `environment:`, and mount the accounts JSON into the
existing `./letsencrypt` volume.

Edit `/opt/docker/router/docker-compose.yml`. The diff:

```yaml
services:
  traefik:
    image: traefik:v3.0
    restart: always
    command:
      - "--api.dashboard=false"
      - "--providers.docker=true"
      - "--providers.docker.exposedbydefault=false"
      - "--providers.docker.network=router_web"
      - "--entrypoints.web.address=:80"
      - "--entrypoints.websecure.address=:443"
      - "--entrypoints.web.http.redirections.entrypoint.to=websecure"
      # Existing HTTP-01 resolver — unchanged.
      - "--certificatesresolvers.letsencrypt.acme.httpchallenge=true"
      - "--certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web"
      - "--certificatesresolvers.letsencrypt.acme.email=mt@ikangai.com"
      - "--certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json"
      # ─── NEW: DNS-01 via acme-dns for wildcard certs ────────────────
      - "--certificatesresolvers.letsencrypt-dns.acme.dnschallenge=true"
      - "--certificatesresolvers.letsencrypt-dns.acme.dnschallenge.provider=acme-dns"
      - "--certificatesresolvers.letsencrypt-dns.acme.dnschallenge.resolvers=1.1.1.1:53,8.8.8.8:53"
      - "--certificatesresolvers.letsencrypt-dns.acme.email=mt@ikangai.com"
      - "--certificatesresolvers.letsencrypt-dns.acme.storage=/letsencrypt/acme-dns.json"
    # ─── NEW: lego env for the acme-dns provider ──────────────────────
    environment:
      - ACME_DNS_API_BASE=http://acme-dns/
      - ACME_DNS_STORAGE_PATH=/letsencrypt/acme-dns-accounts.json
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./letsencrypt:/letsencrypt
    networks:
      - web

networks:
  web:
    name: router_web
    driver: bridge
```

Drop the accounts file at `/opt/docker/router/letsencrypt/acme-dns-accounts.json`
(it'll be visible inside the container at `/letsencrypt/acme-dns-accounts.json`),
using the step-4 JSON:

```json
{
  "rewritable.ikangai.com": {
    "username":   "<from step 4>",
    "password":   "<from step 4>",
    "fulldomain": "<from step 4>",
    "subdomain":  "<from step 4>",
    "allowfrom":  []
  }
}
```

Permissions:

```sh
chmod 600 /opt/docker/router/letsencrypt/acme-dns-accounts.json
chown root:root /opt/docker/router/letsencrypt/acme-dns-accounts.json
```

The username/password let a holder write TXT records under the
registered acme-dns subdomain — limited blast radius, but treat them
like an API token.

Restart Traefik:

```sh
cd /opt/docker/router
docker compose up -d --force-recreate
docker compose logs --tail=50 -f traefik | grep -iE 'acme|error'
```

Traefik must be on the `router_web` network (it is, per the existing
compose file) so it can resolve `acme-dns` as a container hostname.

### 7. Test wildcard cert issuance

Add a throwaway second router to the existing rewritable container in
`/opt/docker/rewritable/docker-compose.yml` to force Traefik to issue
the wildcard cert. Append to the existing `labels:` list:

```yaml
      # Temporary — forces issuance of the *.rewritable.ikangai.com
      # wildcard cert via the new letsencrypt-dns resolver. Remove
      # after verification.
      - "traefik.http.routers.wildcard-test.rule=Host(`wildcard-test.rewritable.ikangai.com`)"
      - "traefik.http.routers.wildcard-test.entrypoints=websecure"
      - "traefik.http.routers.wildcard-test.tls.certresolver=letsencrypt-dns"
      - "traefik.http.routers.wildcard-test.tls.domains[0].main=rewritable.ikangai.com"
      - "traefik.http.routers.wildcard-test.tls.domains[0].sans=*.rewritable.ikangai.com"
      - "traefik.http.routers.wildcard-test.service=rewritable"
```

(The service name `rewritable` matches the existing
`traefik.http.services.rewritable.loadbalancer.server.port=80` label,
so the throwaway router reuses the existing backend.)

`docker compose up -d` the changed service. Watch Traefik's logs:

```sh
docker compose logs -f traefik 2>&1 | grep -i 'acme\|rewritable'
```

You want to see, in order:

```
[INFO] [rewritable.ikangai.com] acme: Obtaining bundled SAN certificate
[INFO] [rewritable.ikangai.com] acme: Trying to solve DNS-01
[INFO] [rewritable.ikangai.com] The server validated our request
[INFO] [rewritable.ikangai.com] Server responded with a certificate.
```

Confirm the cert from outside:

```sh
echo | openssl s_client -connect wildcard-test.rewritable.ikangai.com:443 -servername wildcard-test.rewritable.ikangai.com 2>/dev/null \
  | openssl x509 -noout -text | grep -A1 "Subject Alternative Name"
# Expect: DNS:*.rewritable.ikangai.com, DNS:rewritable.ikangai.com
```

If both SANs are present, you're done. Remove the throwaway router
from the compose file (`docker compose up -d` again) — the cert stays
in Traefik's `acme-dns.json` store and gets reused by the share router
in Task 4.

### 8. Lock down registration

Once step 7 is green, edit `/opt/docker/acme-dns/config.cfg`:

```ini
disable_registration = true
```

Restart:

```sh
cd /opt/docker/acme-dns
docker compose restart acme-dns
```

Existing credentials keep working; no new accounts can be registered.

## Backups

The acme-dns sqlite database is the source of truth for every
registered account. Losing it means re-registering and updating every
CNAME at World4You.

```sh
# On the VPS, weekly cron is plenty:
docker exec acme-dns sqlite3 /var/lib/acme-dns/acme-dns.db ".backup /var/lib/acme-dns/backup.db"
# Then copy backup.db off-host (rsync, restic, whatever).
```

For our single-CNAME case the practical impact of loss is small (one
re-registration, one CNAME update) but worth automating since it's
trivial.

## Troubleshooting

**`bind: address already in use` on port 53.** systemd-resolved is the
usual culprit. Check: `ss -tulpn | grep :53`. If something other than
the acme-dns container owns it on the public interface:

```sh
# Disable systemd-resolved's public listener (it usually only binds
# 127.0.0.53, which doesn't conflict — but if it binds 0.0.0.0, fix it):
sudo systemctl edit systemd-resolved
# Add: [Service]\nEnvironment="DNSStubListener=no"
sudo systemctl restart systemd-resolved
```

**`dig +short A acme-dns.ikangai.com` returns nothing after adding the
A record at World4You.** Propagation. World4You's default TTL can be
up to an hour. `dig +trace acme-dns.ikangai.com` shows the delegation
chain; if World4You's authoritative response doesn't include the new
record, wait.

**Traefik logs `acme-dns: authentication failed`.** The accounts JSON
isn't being read or the credentials are wrong. Verify
`ACME_DNS_STORAGE_PATH` matches the file path inside the Traefik
container, the file is readable, and the JSON top-level key
(`rewritable.ikangai.com`) matches the domain Traefik is requesting
the cert for.

**Traefik logs `acme: error: ... no record for _acme-challenge`.** The
CNAME at World4You hasn't propagated yet, or it points at the wrong
acme-dns subdomain. `dig +trace _acme-challenge.rewritable.ikangai.com`
should follow the CNAME all the way to the TXT response from
185.164.4.77.

**Cert issuance times out.** Most often the resolvers list in
Traefik's `dnsChallenge` is too narrow. Add public resolvers
(`1.1.1.1`, `8.8.8.8`, `9.9.9.9`) — without them, lego uses the host's
default resolver which may not see the new records due to caching.
