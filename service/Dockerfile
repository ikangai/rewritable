FROM node:22-alpine

WORKDIR /app

# Build context is the repo root (see service/docker-compose*.yml).
# server.js reads the seed via path.join(__dirname, '..', 'seeds') so the
# in-image layout mirrors the on-disk layout.
COPY service/server.js ./service/
COPY service/public/ ./service/public/
COPY seeds/ ./seeds/
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
