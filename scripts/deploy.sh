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
#   scripts/deploy.sh push        # rsync the four content paths (no rebuild)
#   scripts/deploy.sh deploy      # push + docker compose up -d --build + verify  (default)
#   scripts/deploy.sh verify      # curl the live site, assert it serves the seed
#
#   DRY_RUN=1 scripts/deploy.sh deploy   # show what rsync would change; no transfer/build
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
  local health seed_code seed_bytes tmp="/tmp/rwa-seed.$$"
  health="$(curl -fsS --max-time 15 "$SITE_URL/health" 2>/dev/null || echo 'UNREACHABLE')"
  echo "    /health         -> $health"
  seed_code="$(curl -s -o "$tmp" -w '%{http_code}' --max-time 20 "$SITE_URL/rewritable.html" || echo 000)"
  seed_bytes="$(wc -c < "$tmp" 2>/dev/null | tr -d ' ' || echo 0)"
  echo "    /rewritable.html-> HTTP $seed_code, ${seed_bytes} bytes"
  if [[ "$seed_code" == "200" ]] && grep -q 'id="rwa-bootstrap"' "$tmp" 2>/dev/null && (( seed_bytes > 100000 )); then
    rm -f "$tmp"
    log "OK — seed served, bootstrap present (${seed_bytes} bytes)"
  else
    rm -f "$tmp"
    die "verify FAILED — seed not served as expected (numbers above)"
  fi
}

main() {
  case "${1:-deploy}" in
    preflight) cmd_preflight ;;
    push)      cmd_push ;;
    build)     cmd_build ;;
    deploy)    cmd_push && cmd_build && cmd_verify ;;
    verify)    cmd_verify ;;
    *) die "unknown subcommand '${1:-}' — use: preflight | push | build | deploy | verify" ;;
  esac
}
main "$@"
