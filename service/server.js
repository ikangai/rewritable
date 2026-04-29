'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 80;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Read static assets once at startup. Updates require restart (rebuild+redeploy).
const TRIGGER_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'new.html'));
const SEED_TEMPLATE = fs.readFileSync(path.join(PUBLIC_DIR, 'rewritable.html'), 'utf8');

// Per-container UUID injection. The seed ships with a placeholder DOC_UUID;
// every download gets a fresh randomUUID() substituted in. Without this, two
// downloads on the same machine would share state under file:// (the v0.7
// isolation guarantee — see re-write-able-spec.md §5.7).
const UUID_RE = /const DOC_UUID = '[0-9a-f-]{36}';/;
const seedMatches = SEED_TEMPLATE.match(new RegExp(UUID_RE.source, 'g')) || [];
if (seedMatches.length !== 1) {
  console.error(`fatal: seed must contain exactly one DOC_UUID line, found ${seedMatches.length}`);
  process.exit(1);
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

function send(res, status, headers, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { 'Allow': 'GET, HEAD', 'Content-Type': 'text/plain' }, 'method not allowed\n');
  }

  const url = req.url.split('?')[0];

  if (url === '/health') {
    return send(res, 200, { 'Content-Type': 'text/plain' }, 'ok\n');
  }
  if (url === '/') {
    return send(res, 302, { 'Location': '/new' }, '');
  }
  if (url === '/new') {
    return send(res, 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    }, TRIGGER_HTML);
  }
  if (url === '/rewritable.html') {
    const uuid = crypto.randomUUID();
    const body = SEED_TEMPLATE.replace(UUID_RE, `const DOC_UUID = '${uuid}';`);
    // no-store: each download has a unique UUID, caching defeats the isolation.
    return send(res, 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': 'attachment; filename="rewritable.html"',
      'Cache-Control': 'no-store',
    }, body);
  }
  send(res, 404, { 'Content-Type': 'text/plain' }, 'not found\n');
});

server.listen(PORT, () => {
  console.log(`rewritable-new listening on :${PORT}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
