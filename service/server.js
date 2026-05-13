'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 80;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SEEDS_DIR = path.join(__dirname, '..', 'seeds');

// Read static assets once at startup. Updates require restart (rebuild+redeploy).
const TRIGGER_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'new.html'));
const IMPORT_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'import.html'));
const SEED_TEMPLATE = fs.readFileSync(path.join(SEEDS_DIR, 'rewritable.html'), 'utf8');

// pdf.js is self-hosted (not loaded from cdnjs) because the inline
// `<script type="module">` import doesn't validate SRI on the imported URL —
// integrity= only fires for `<script src=>`. Serving same-origin removes the
// CDN-trust dependency entirely. Files are copied from cli/node_modules/
// pdfjs-dist/build/ at the matching version; bumping the CLI's pdfjs-dist
// version means re-copying these files (and updating cdnjs SRI for the other
// libs that DO load via classic script).
const PDFJS_MAIN = fs.readFileSync(path.join(PUBLIC_DIR, 'pdf', 'pdf.min.mjs'));
const PDFJS_WORKER = fs.readFileSync(path.join(PUBLIC_DIR, 'pdf', 'pdf.worker.min.mjs'));

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

// Static demo content — the `demo/html-effectiveness/` index plus the
// 20 original pages and their `rwa import`-generated rewritable counterparts.
// Loaded once at startup; the request handler hits the in-memory Map and
// never touches the filesystem per request. The Dockerfile COPYs the
// demo subdir into the image, so files are baked into the artifact.
const DEMO_ROOT = path.join(__dirname, '..', 'demo', 'html-effectiveness');
const DEMO_ASSETS = new Map();
function loadDemoTree(absDir, urlPrefix) {
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const absPath = path.join(absDir, entry.name);
    const urlPath = urlPrefix + '/' + entry.name;
    if (entry.isDirectory()) { loadDemoTree(absPath, urlPath); continue; }
    DEMO_ASSETS.set(urlPath, fs.readFileSync(absPath));
  }
}
loadDemoTree(DEMO_ROOT, '/demo/html-effectiveness');
console.log(`demo: loaded ${DEMO_ASSETS.size} files`);

function contentTypeFor(name) {
  if (name.endsWith('.html')) return 'text/html; charset=utf-8';
  if (name.endsWith('.md'))   return 'text/markdown; charset=utf-8';
  if (name.endsWith('.css'))  return 'text/css; charset=utf-8';
  if (name.endsWith('.js'))   return 'text/javascript; charset=utf-8';
  if (name.endsWith('.svg'))  return 'image/svg+xml; charset=utf-8';
  return 'application/octet-stream';
}

const server = http.createServer((req, res) => {
  // Per RFC 9110 §9.3.2: HEAD must return identical headers to GET but no body.
  // Closure over `req.method` so every send() call honours this automatically.
  const isHead = req.method === 'HEAD';
  const send = (status, headers, body) => {
    res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
    res.end(isHead ? undefined : body);
  };

  if (req.method !== 'GET' && !isHead) {
    return send(405, { 'Allow': 'GET, HEAD', 'Content-Type': 'text/plain' }, 'method not allowed\n');
  }

  const url = req.url.split('?')[0];

  if (url === '/health') {
    return send(200, { 'Content-Type': 'text/plain' }, 'ok\n');
  }
  if (url === '/') {
    return send(302, { 'Location': '/new' }, '');
  }
  if (url === '/new') {
    return send(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    }, TRIGGER_HTML);
  }
  if (url === '/import') {
    return send(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    }, IMPORT_HTML);
  }
  if (url === '/pdf/pdf.min.mjs') {
    return send(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    }, PDFJS_MAIN);
  }
  if (url === '/pdf/pdf.worker.min.mjs') {
    return send(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    }, PDFJS_WORKER);
  }
  // Static demo tree. Three layers:
  //   /demo, /demo/, /demo/html-effectiveness → 302 → /demo/html-effectiveness/
  //   /demo/html-effectiveness/                → serve the index page
  //   /demo/html-effectiveness/<sub>           → serve from the in-memory map
  // X-Frame-Options is overridden to SAMEORIGIN so the index can iframe the
  // sibling original/ and rewritable/ pages — the global DENY would block it.
  if (url === '/demo' || url === '/demo/' || url === '/demo/html-effectiveness') {
    return send(302, { 'Location': '/demo/html-effectiveness/' }, '');
  }
  if (url === '/demo/html-effectiveness/') {
    const body = DEMO_ASSETS.get('/demo/html-effectiveness/index.html');
    if (body) {
      return send(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Frame-Options': 'SAMEORIGIN',
        'Cache-Control': 'public, max-age=300',
      }, body);
    }
  }
  if (url.startsWith('/demo/html-effectiveness/')) {
    const body = DEMO_ASSETS.get(url);
    if (body) {
      return send(200, {
        'Content-Type': contentTypeFor(url),
        'X-Frame-Options': 'SAMEORIGIN',
        'Cache-Control': 'public, max-age=300',
      }, body);
    }
  }

  if (url === '/rewritable.html') {
    const uuid = crypto.randomUUID();
    const body = SEED_TEMPLATE.replace(UUID_RE, `const DOC_UUID = '${uuid}';`);
    // no-store: each download has a unique UUID, caching defeats the isolation.
    return send(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': 'attachment; filename="rewritable.html"',
      'Cache-Control': 'no-store',
    }, body);
  }
  send(404, { 'Content-Type': 'text/plain' }, 'not found\n');
});

server.listen(PORT, () => {
  console.log(`rewritable-new listening on :${PORT}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
