FROM node:22-alpine

WORKDIR /app

# Build context is the repo root (see service/docker-compose*.yml).
# server.js reads the seed via path.join(__dirname, '..', 'seeds') so the
# in-image layout mirrors the on-disk layout.
COPY service/server.js ./service/
# Vendored CLI apply pipeline + self-description reader. server.js require()s
# ./lib/hosted.js at startup and the /r routes dynamic-import the vendored ESM
# modules (identity/seed/apply-edits), so lib/ must ship in the image.
COPY service/lib/ ./service/lib/
COPY service/public/ ./service/public/
COPY seeds/ ./seeds/

# Snapshot publishing writes <short>.html + <short>.json here. Declared as
# a VOLUME so a host bind-mount or named volume can persist shares across
# container restarts; without it, every `docker compose up` would wipe them.
RUN mkdir -p /app/service/data
VOLUME ["/app/service/data"]
# Demo tree served from /demo/html-effectiveness/. Scoped to the subdir
# (not all of demo/) so any local cruft like PDFs sitting in demo/ is
# never copied into the image.
COPY demo/html-effectiveness/ ./demo/html-effectiveness/

ENV NODE_ENV=production
ENV PORT=80

HEALTHCHECK --interval=30s --timeout=3s --retries=2 \
  CMD wget -q -O- http://localhost/health || exit 1

EXPOSE 80

CMD ["node", "service/server.js"]
