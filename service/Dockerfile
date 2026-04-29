FROM node:22-alpine

WORKDIR /app

COPY server.js ./
COPY public/ ./public/

ENV NODE_ENV=production
ENV PORT=80

HEALTHCHECK --interval=30s --timeout=3s --retries=2 \
  CMD wget -q -O- http://localhost/health || exit 1

EXPOSE 80

CMD ["node", "server.js"]
