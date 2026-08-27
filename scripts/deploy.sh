#!/usr/bin/env bash
#
# deploy.sh — sync the rewritable service to the production host and rebuild.
#
# WHY THIS EXISTS:
#   rewritable.ikangai.com is deployed by a manual rsync + docker rebuild.
#   There is NO CI on push. See the diary entry
#   .dev-diary/2026-05-22-print-css-deploy-flat-layout-gotcha.md.
#
# HOST LAYOUT (verified 2026-05-29 via `preflight`):
#   /opt/docker/rewritable/            <- docker build context (`build: .`)
#   ├── Dockerfile                     <- == repo service/Dockerfile (byte-identical)
#   ├── docker-compose.yml             <- the active prod compose (no -f flag needed)
#   ├── service/server.js              <- COPYed into image  (THE current server, 24 KB)
#   ├── service/lib/                   <- COPYed into image  (vendored apply pipeline — added with the hosted runtime; the Dockerfile COPYs it, so it MUST ship)
#   ├── service/public/                <- COPYed into image  (static assets)
#   ├── seeds/                         <- COPYed into image  (seed template)
#   ├── demo/html-effectiveness/       <- COPYed into image  (demo tree)
#   ├── server.js   (2.6 KB, 29 Apr)   <- DEAD CRUFT, nothing copies it. Leave it.
#   └── public/     (29 Apr)           <- DEAD CRUFT, nothing copies it. Leave it.
#
#   So this script ships ONLY the four content paths the Dockerfile COPYs,
#   to their exact host paths, then rebuilds. It does NOT touch Dockerfile or
#   docker-compose.yml: those live at the host top level (not under service/
#   as in the repo) and rarely change. If you change infra, see "INFRA" below.
#
# USAGE:
#   scripts/deploy.sh preflight   # read-only: show remote layout + container
#   scripts/deploy.sh status      # read-only: is prod behind this checkout? (exit 3 = stale)
#   scripts/deploy.sh push        # rsync the four content paths (no rebuild)
#   scripts/deploy.sh deploy      # push + docker compose up -d --build + verify  (default)
#   scripts/deploy.sh verify      # curl the live site, assert it serves the seed
#
#   DRY_RUN=1 scripts/deploy.sh deploy   # show what rsync would change; no transfer/build
#   STATUS_DEPTH=80 scripts/deploy.sh status   # widen the behind-vs-diverged commit walk
#
# INFRA (Dockerfile / docker-compose.yml changes — rare, do manually):
#   The host keeps these at the TOP level, not under service/. To update:
#     scp service/Dockerfile          root@<host>:/opt/docker/rewritable/Dockerfile
#     scp service/docker-compose.prod.yml root@<host>:/opt/docker/rewritable/docker-compose.yml
#   (the host compose uses `build: .`; the repo prod compose uses
#    `context: .. / dockerfile: service/Dockerfile` — functionally equivalent,
#    so don't blindly overwrite without re-checking the build: stanza.)
#
set -euo pipefail

# ---- config ----------------------------------------------------------------
REMOTE_HOST="${REMOTE_HOST:-root@185.164.4.77}"
REMOTE_DIR="${REMOTE_DIR:-/opt/docker/rewritable}"   # docker build context on host
SITE_URL="${SITE_URL:-https://rewritable.ikangai.com}"
# ----------------------------------------------------------------------------

# Resolve repo root from this script's location, regardless of CWD.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH=(ssh -o ConnectTimeout=15 "$REMOTE_HOST")

# The exact set the host's Dockerfile COPYs, as repo-relative paths. rsync -R
# preserves each path under $REMOTE_DIR, so they land at the host paths above.
SOURCES=(
  seeds
  service/server.js
  service/lib
  service/public
  demo/html-effectiveness
)

# data/ is a docker volume on the host; never sync it. Skip local cruft too.
RSYNC_EXCLUDES=(
  --exclude 'service/data'
  --exclude '.DS_Store'
)

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!! \033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx \033[0m %s\n' "$*" >&2; exit 1; }

cmd_preflight() {
  log "Remote layout — $REMOTE_HOST:$REMOTE_DIR"
  "${SSH[@]}" "
    echo '--- build context (top level) ---'
    ls -la '$REMOTE_DIR' 2>/dev/null || echo '(missing)'
    echo '--- service/ (server.js + public are the live ones) ---'
    ls -la '$REMOTE_DIR/service' 2>/dev/null || echo '(no service/ subdir)'
    echo '--- running container ---'
    docker ps --filter name=rewritable --format '{{.Names}}  {{.Status}}  {{.Image}}' || true
  "
  echo
  log "Local will ship (relative to $REPO_ROOT), via rsync -R into $REMOTE_DIR/:"
  printf '    %s\n' "${SOURCES[@]}"
}

cmd_status() {
  # WHY: nothing anywhere alerts when main moves ahead of prod. There is no CI
  # on push, `preflight` only lists the remote layout, and `verify` merely proves
  # SOMETHING is served — none of them answer "is what's live the current code?".
  # Prod once ran 4+ weeks stale (2026-07-06 -> 2026-08-08) with merged security
  # fixes unshipped while every internal signal stayed green. This is the check
  # that would have caught it: content hashes, both sides, read-only.
  #
  # It compares by CONTENT, not mtime/size as rsync does by default, and it
  # includes Dockerfile — which `push` deliberately never syncs (see INFRA), so
  # a forgotten Dockerfile is exactly the drift no other subcommand can see.
  cd "$REPO_ROOT"
  local SHA=(sha256sum)
  command -v sha256sum >/dev/null 2>&1 || SHA=(shasum -a 256)

  # NOT `local`: a RETURN trap runs after the frame's locals are popped, so a
  # local here would be unset by the time cleanup fires and `set -u` would turn
  # every successful status run into an exit-1.
  STATUS_TMP="$(mktemp -d)"
  trap 'rm -rf "$STATUS_TMP"' RETURN
  local lf="$STATUS_TMP/local" rf="$STATUS_TMP/remote" lp="$STATUS_TMP/lpaths" rp="$STATUS_TMP/rpaths" mod="$STATUS_TMP/mod"

  # "<path> <hash>", sorted. Repo service/Dockerfile is reported under the name
  # the host uses (bare Dockerfile at the build-context root).
  { find "${SOURCES[@]}" -type f ! -name '.DS_Store' -print0 | xargs -0 "${SHA[@]}"
    "${SHA[@]}" service/Dockerfile
  } | sed -E 's|^([0-9a-f]+)[[:space:]]+(.*)$|\2 \1|; s|^service/Dockerfile |Dockerfile |' \
    | sort > "$lf"

  log "currency check — $REMOTE_HOST:$REMOTE_DIR"
  "${SSH[@]}" "cd '$REMOTE_DIR' 2>/dev/null && find ${SOURCES[*]} Dockerfile -type f -print0 2>/dev/null | xargs -0 sha256sum" \
    2>/dev/null | sed -E 's|^([0-9a-f]+)[[:space:]]+(.*)$|\2 \1|' | sort > "$rf" || true
  [[ -s "$rf" ]] || die "no remote hashes — host unreachable, or $REMOTE_DIR missing"

  cut -d' ' -f1 "$lf" | sort > "$lp"
  cut -d' ' -f1 "$rf" | sort > "$rp"
  : > "$mod"
  local p lh rh
  while read -r p; do
    lh="$(awk -v p="$p" '$1==p{print $2; exit}' "$lf")"
    rh="$(awk -v p="$p" '$1==p{print $2; exit}' "$rf")"
    [[ "$lh" == "$rh" ]] || printf '%s %s\n' "$p" "$rh" >> "$mod"
  done < <(comm -12 "$lp" "$rp")

  local n_mod n_new n_orphan
  n_mod=$(wc -l < "$mod" | tr -d ' ')
  n_new=$(comm -23 "$lp" "$rp" | wc -l | tr -d ' ')
  n_orphan=$(comm -13 "$lp" "$rp" | wc -l | tr -d ' ')
  echo "    $(wc -l < "$lf" | tr -d ' ') image files compared (the Dockerfile COPY set + Dockerfile)"

  if (( n_mod == 0 && n_new == 0 )); then
    (( n_orphan > 0 )) && warn "$n_orphan host-only file(s) — unmanaged, not shipped by push:" && comm -13 "$lp" "$rp" | sed 's|^|      - |'
    log "prod is CURRENT — every image file matches this checkout"
    return 0
  fi

  # Classify each difference: is the host simply running an OLDER commit of this
  # file (normal staleness), or content that appears in no recent commit at all
  # (someone hand-edited prod — do NOT blindly rsync over that)?
  local depth="${STATUS_DEPTH:-40}" gp c found
  while read -r p rh; do
    gp="$p"; [[ "$p" == Dockerfile ]] && gp=service/Dockerfile
    found=""
    for c in $(git rev-list -n "$depth" HEAD -- "$gp" 2>/dev/null); do
      if [[ "$(git show "$c:$gp" 2>/dev/null | "${SHA[@]}" | cut -d' ' -f1)" == "$rh" ]]; then
        found="$c"; break
      fi
    done
    if [[ -n "$found" ]]; then
      printf '      M %-62shost = %s\n' "$p" "$(git show -s --format='%h  %ad' --date=short "$found")"
    else
      printf '      M %-62shost content is in NO commit within %s — DIVERGED, inspect before pushing\n' "$p" "$depth"
    fi
  done < "$mod"
  (( n_new > 0 ))    && { echo "    never shipped (in repo, absent on host):"; comm -23 "$lp" "$rp" | sed 's|^|      + |'; }
  (( n_orphan > 0 )) && { echo "    host-only (unmanaged, push leaves these):";  comm -13 "$lp" "$rp" | sed 's|^|      - |'; }

  warn "prod is STALE — $n_mod changed, $n_new missing.  Ship with: scripts/deploy.sh deploy"
  return 3
}

cmd_push() {
  cd "$REPO_ROOT"
  for s in "${SOURCES[@]}"; do
    [[ -e "$s" ]] || die "missing source: $s (run from a clean repo checkout)"
  done
  local dry=()
  [[ "${DRY_RUN:-}" == "1" ]] && { dry=(--dry-run); log "DRY RUN — itemizing only, no transfer"; }
  log "rsync -> $REMOTE_HOST:$REMOTE_DIR/"
  # -R keeps repo-relative paths; --itemize-changes shows exactly what moves.
  # --no-owner --no-group: deploy is content-only — docker COPY ignores host
  #   file ownership, so don't rewrite uid/gid on prod every run.
  # No --delete: orphaned old assets are harmless (server reads files by name);
  #   avoids any risk of removing host files this script doesn't manage.
  rsync -azR --no-owner --no-group --itemize-changes "${dry[@]}" "${RSYNC_EXCLUDES[@]}" \
    -e "ssh -o ConnectTimeout=15" \
    "${SOURCES[@]}" "$REMOTE_HOST:$REMOTE_DIR/"
  log "push complete"
}

cmd_build() {
  [[ "${DRY_RUN:-}" == "1" ]] && { warn "DRY RUN — skipping remote build"; return 0; }
  log "docker compose up -d --build  (in $REMOTE_DIR)"
  "${SSH[@]}" "cd '$REMOTE_DIR' && docker compose up -d --build"
  log "build complete"
}

cmd_verify() {
  log "verifying live site — $SITE_URL"
  # Poll, don't fire once: `docker compose up -d --build` recreates the
  # container, and Traefik needs a few seconds to re-register the new backend.
  # A single immediate curl races that window and reports a false 404 (Traefik's
  # 19-byte "404 page not found") even though the deploy succeeded. Retry until
  # the site is genuinely serving, and only fail after sustained failure.
  #
  # BOTH probes gate. /health was fetched and printed but never tested until
  # #48, so a deploy where Traefik still served the static seed while the Node
  # service was wedged printed "/health -> UNREACHABLE" and "OK" on adjacent
  # lines. Serving a file proves the proxy is up; only /health proves the
  # service behind it is.
  #
  # `== ok` rather than a non-empty check: curl runs with -f, so a 5xx or a
  # missing route exits non-zero and lands in $health as UNREACHABLE, while a
  # 200 carrying some other body (a maintenance page, a proxy error served with
  # the wrong status) can only be caught by comparing what came back. The
  # endpoint returns 'ok\n'; $(...) strips the trailing newline, so the literal
  # is exactly 'ok'.
  #
  # /health is structurally LATER than Traefik registration — on the deploy that
  # exposed this, the seed served on attempt 5 while /health was still
  # UNREACHABLE, then answered by hand seconds later. So it belongs INSIDE the
  # retry loop, never as a check after it: a gate that reds a deploy which was
  # merely slow gets weakened back out the first time it fires.
  local tmp="/tmp/rwa-seed.$$" attempts="${VERIFY_ATTEMPTS:-10}" delay="${VERIFY_DELAY:-6}"
  local i health seed_code seed_bytes
  for (( i=1; i<=attempts; i++ )); do
    health="$(curl -fsS --max-time 15 "$SITE_URL/health" 2>/dev/null || echo 'UNREACHABLE')"
    seed_code="$(curl -s -o "$tmp" -w '%{http_code}' --max-time 20 "$SITE_URL/rewritable.html" || echo 000)"
    seed_bytes="$(wc -c < "$tmp" 2>/dev/null | tr -d ' ' || echo 0)"
    if [[ "$health" == "ok" ]] && [[ "$seed_code" == "200" ]] && grep -q 'id="rwa-bootstrap"' "$tmp" 2>/dev/null && (( seed_bytes > 100000 )); then
      echo "    /health         -> $health"
      echo "    /rewritable.html-> HTTP $seed_code, ${seed_bytes} bytes"
      rm -f "$tmp"
      log "OK — seed served, bootstrap present (${seed_bytes} bytes)  [attempt $i/$attempts]"
      return 0
    fi
    if (( i < attempts )); then
      warn "not ready (attempt $i/$attempts: /health=$health, seed=HTTP $seed_code ${seed_bytes}b) — waiting ${delay}s for Traefik to re-register…"
      sleep "$delay"
    fi
  done
  echo "    /health         -> $health"
  echo "    /rewritable.html-> HTTP $seed_code, ${seed_bytes} bytes"
  rm -f "$tmp"
  # Steer the reader to the right fix before they reach for the wrong one.
  # Seed-good + health-bad has two very different causes: a genuinely wedged
  # service (the gate working), or /health simply not up yet within the budget
  # (the gate too impatient). Only the second is a reason to touch this script,
  # and the tempting "fix" for it is deleting the health term — which puts back
  # exactly the defect #48 closed. What the suite pins is that the PREDICATE can
  # fail; whether 10 x 6s is enough for a real container recreate is not pinned
  # by anything, so say so here rather than leave it to be rediscovered.
  if [[ "$health" != "ok" ]] && [[ "$seed_code" == "200" ]]; then
    warn "the seed served but /health did not answer 'ok'."
    warn "  → if the service is genuinely wedged, this is the gate doing its job (#48)."
    warn "  → if it is actually healthy, /health just lagged: it comes up AFTER Traefik"
    warn "    re-registers. Raise VERIFY_ATTEMPTS (now $attempts x ${delay}s) — do not drop the check."
  fi
  # Name both probes rather than asserting which one failed: with /health now
  # gating, "seed not served as expected" would be actively wrong for the case
  # where the seed served perfectly and the service was wedged.
  die "verify FAILED after $attempts attempts (~$(( attempts * delay ))s) — /health=$health, seed=HTTP $seed_code ${seed_bytes}b (numbers above)"
}

main() {
  case "${1:-deploy}" in
    preflight) cmd_preflight ;;
    status)    cmd_status ;;
    push)      cmd_push ;;
    build)     cmd_build ;;
    deploy)    cmd_push && cmd_build && cmd_verify ;;
    verify)    cmd_verify ;;
    *) die "unknown subcommand '${1:-}' — use: preflight | status | push | build | deploy | verify" ;;
  esac
}
main "$@"
