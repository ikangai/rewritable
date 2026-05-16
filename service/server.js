'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 80;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SEEDS_DIR = path.join(__dirname, '..', 'seeds');

// Snapshot-publishing storage. Anonymous shares live here for 24h.
// Per-share files are <short>.html (the bytes) + <short>.json (metadata).
// In production the path is volume-mounted; locally it's a sibling dir.
// Override with RWA_DATA_DIR for ad-hoc test runs.
const DATA_DIR = process.env.RWA_DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// Read static assets once at startup. Updates require restart (rebuild+redeploy).
const TRIGGER_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'new.html'));
const IMPORT_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'import.html'));
const SEED_TEMPLATE = fs.readFileSync(path.join(SEEDS_DIR, 'rewritable.html'), 'utf8');

// Landing page (/). Embeds the rewritable-building SKILL.md inline so the
// "Copy the rewritable skill" button works without an extra fetch. The skill
// file is bundled at service/public/build-skill.md and overridable via
// RWA_SKILL_PATH for ad-hoc swaps. Failure to read the skill is non-fatal —
// the landing still renders, the copy button just gets an empty payload.
const LANDING_TEMPLATE = fs.readFileSync(path.join(PUBLIC_DIR, 'landing.html'), 'utf8');
const SKILL_MARKER = '{{SKILL_MD}}';
const landingMarkerCount = LANDING_TEMPLATE.split(SKILL_MARKER).length - 1;
if (landingMarkerCount !== 1) {
  console.error(`fatal: landing.html must contain exactly one ${SKILL_MARKER}, found ${landingMarkerCount}`);
  process.exit(1);
}
const SKILL_PATH = process.env.RWA_SKILL_PATH || path.join(PUBLIC_DIR, 'build-skill.md');
let skillBody = '';
try { skillBody = fs.readFileSync(SKILL_PATH, 'utf8'); }
catch (err) { console.warn(`landing: skill file unreadable at ${SKILL_PATH}: ${err.message}`); }
// The skill lives inside <script type="text/markdown">…</script>. The only
// substring that can break that is a literal </script — defensively encode it.
const skillSafe = skillBody.replace(/<\/script/gi, '<\\/script');
const LANDING_HTML = LANDING_TEMPLATE.replace(SKILL_MARKER, skillSafe);

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

// ─── Snapshot publishing: helpers ────────────────────────────────────────
// /publish accepts a rewritable container, validates it looks like one,
// substitutes a fresh DOC_UUID (so the published share has its own
// per-container IDB namespace at this origin), and stores the bytes.
// /s/<short> serves them with a 5-minute CDN cache. Anonymous, 24h expiry.

const MAX_BODY_BYTES = 25 * 1024 * 1024;
const EXPIRY_MS = 24 * 60 * 60 * 1000;
const SHORT_RE = /^[0-9a-z]{8}$/;
const SHORT_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const BOOTSTRAP_RE = /<script id="rwa-bootstrap"/;
const INLINE_DOC_RE = /const INLINE_DOC = `/;

function generateShort() {
  // 8 chars from base36 = ~41 bits. crypto.randomBytes is uniform; the % 36
  // step introduces a ~6% bias toward 0-3 vs 4-9/a-z but the address space
  // is large enough relative to the 24h population that this is irrelevant
  // for collision resistance.
  for (let attempt = 0; attempt < 5; attempt++) {
    const bytes = crypto.randomBytes(8);
    let s = '';
    for (let i = 0; i < 8; i++) s += SHORT_ALPHABET[bytes[i] % 36];
    if (!fs.existsSync(path.join(DATA_DIR, `${s}.html`))) return s;
  }
  throw new Error('could not generate unique short code after 5 attempts');
}

function validateContainer(text) {
  const matches = text.match(new RegExp(UUID_RE.source, 'g')) || [];
  if (matches.length === 0) return { ok: false, detail: 'missing DOC_UUID line' };
  if (matches.length > 1) return { ok: false, detail: 'multiple DOC_UUID lines (must be exactly one)' };
  if (!BOOTSTRAP_RE.test(text)) return { ok: false, detail: 'missing rwa-bootstrap script tag' };
  if (!INLINE_DOC_RE.test(text)) return { ok: false, detail: 'missing INLINE_DOC marker' };
  return { ok: true };
}

function atomicWriteFile(filePath, data) {
  // tmp+rename guarantees a reader never sees a half-written file.
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        const err = new Error('body_too_large');
        err.code = 'BODY_TOO_LARGE';
        req.destroy();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Per-IP sliding-window rate limit. The bucket is the list of publish
// timestamps in the last hour; reject when its length hits the cap.
// Behind Traefik in prod the socket peer is the proxy, so we trust the
// leftmost X-Forwarded-For hop. Direct-to-port requests in dev get the
// real socket address. Spoofable if someone bypasses the proxy — fine
// for v1 abuse mitigation.
const RATE_LIMIT_PER_HOUR = 10;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const rateBuckets = new Map();

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function checkRateLimit(ip) {
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket) { bucket = []; rateBuckets.set(ip, bucket); }
  while (bucket.length && bucket[0] < now - RATE_WINDOW_MS) bucket.shift();
  if (bucket.length >= RATE_LIMIT_PER_HOUR) {
    return { ok: false, retryAfterSec: Math.ceil((bucket[0] + RATE_WINDOW_MS - now) / 1000) };
  }
  bucket.push(now);
  return { ok: true };
}

function sweepExpired() {
  let entries;
  try { entries = fs.readdirSync(DATA_DIR); }
  catch (err) { console.error('sweep: cannot read DATA_DIR', err.message); return; }

  const groups = new Map();
  for (const name of entries) {
    const m = name.match(/^([0-9a-z]{8})\.(html|json)$/);
    if (!m) continue;
    const [, short, ext] = m;
    if (!groups.has(short)) groups.set(short, {});
    groups.get(short)[ext] = name;
  }

  const now = Date.now();
  let deleted = 0, kept = 0;
  for (const [short, files] of groups) {
    let expired = false;
    if (!files.json) {
      // Orphan: html with no metadata. Treat as expired.
      expired = true;
    } else {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, files.json), 'utf8'));
        if (typeof meta.createdAt !== 'number' || now - meta.createdAt > EXPIRY_MS) expired = true;
      } catch { expired = true; }
    }
    if (expired) {
      for (const ext of ['html', 'json']) {
        try { fs.unlinkSync(path.join(DATA_DIR, `${short}.${ext}`)); } catch {}
      }
      deleted++;
    } else {
      kept++;
    }
  }

  // Prune empty rate-limit buckets opportunistically.
  for (const [k, v] of rateBuckets) {
    while (v.length && v[0] < now - RATE_WINDOW_MS) v.shift();
    if (v.length === 0) rateBuckets.delete(k);
  }

  if (deleted > 0 || kept > 0) console.log(`sweep: deleted ${deleted}, kept ${kept}`);
}

sweepExpired();
// Sweep cadence is hourly — frequent enough that expired shares 410 promptly,
// rare enough that the sweep cost is negligible.
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
setInterval(sweepExpired, SWEEP_INTERVAL_MS).unref();

async function handlePublish(req, send) {
  const ip = clientIp(req);
  const rl = checkRateLimit(ip);
  if (!rl.ok) {
    return send(429, {
      'Content-Type': 'application/json; charset=utf-8',
      'Retry-After': String(rl.retryAfterSec),
    }, JSON.stringify({ error: 'rate_limited', retryAfterSec: rl.retryAfterSec }) + '\n');
  }

  let buf;
  try { buf = await readBody(req, MAX_BODY_BYTES); }
  catch (err) {
    if (err && err.code === 'BODY_TOO_LARGE') {
      return send(413, { 'Content-Type': 'application/json; charset=utf-8' },
        JSON.stringify({ error: 'body_too_large', maxBytes: MAX_BODY_BYTES }) + '\n');
    }
    return send(400, { 'Content-Type': 'application/json; charset=utf-8' },
      JSON.stringify({ error: 'read_failed', detail: String(err && err.message || err) }) + '\n');
  }

  const text = buf.toString('utf8');
  const val = validateContainer(text);
  if (!val.ok) {
    return send(400, { 'Content-Type': 'application/json; charset=utf-8' },
      JSON.stringify({ error: 'validation_failed', detail: val.detail }) + '\n');
  }

  // Each share gets its own DOC_UUID — the publisher's local copy and the
  // hosted snapshot are intentionally distinct containers.
  const newUuid = crypto.randomUUID();
  const newText = text.replace(UUID_RE, `const DOC_UUID = '${newUuid}';`);

  let short;
  try { short = generateShort(); }
  catch (err) {
    console.error('publish: short generation failed', err);
    return send(503, { 'Content-Type': 'application/json; charset=utf-8' },
      JSON.stringify({ error: 'collision', detail: err.message }) + '\n');
  }

  const createdAt = Date.now();
  const meta = { createdAt, sizeBytes: Buffer.byteLength(newText, 'utf8'), ip };
  try {
    atomicWriteFile(path.join(DATA_DIR, `${short}.html`), newText);
    atomicWriteFile(path.join(DATA_DIR, `${short}.json`), JSON.stringify(meta));
  } catch (err) {
    console.error('publish: write failed', err);
    return send(500, { 'Content-Type': 'application/json; charset=utf-8' },
      JSON.stringify({ error: 'storage_failed' }) + '\n');
  }

  const scheme = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = req.headers.host || 'localhost';
  const shareUrl = `${scheme}://${host}/s/${short}`;
  return send(201, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }, JSON.stringify({ short, url: shareUrl, expiresAt: createdAt + EXPIRY_MS }) + '\n');
}

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

  const url = req.url.split('?')[0];

  // POST /publish is the only non-GET endpoint. Routed before the method
  // gate so the gate can stay simple. Errors inside the async handler
  // route through .catch so a thrown exception still responds.
  if (req.method === 'POST' && url === '/publish') {
    handlePublish(req, send).catch(err => {
      console.error('publish: unhandled error', err);
      if (!res.headersSent) {
        send(500, { 'Content-Type': 'application/json; charset=utf-8' },
          JSON.stringify({ error: 'internal_error' }) + '\n');
      }
    });
    return;
  }

  if (req.method !== 'GET' && !isHead) {
    return send(405, { 'Allow': 'GET, HEAD, POST', 'Content-Type': 'text/plain' }, 'method not allowed\n');
  }

  if (url === '/health') {
    return send(200, { 'Content-Type': 'text/plain' }, 'ok\n');
  }
  if (url === '/') {
    return send(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    }, LANDING_HTML);
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

  // Snapshot publishing: serve a published share's bytes.
  if (url.startsWith('/s/')) {
    const m = url.match(/^\/s\/([0-9a-z]{8})$/);
    if (!m) return send(404, { 'Content-Type': 'text/plain' }, 'not found\n');
    const short = m[1];
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${short}.json`), 'utf8')); }
    catch (err) {
      if (err.code === 'ENOENT') return send(404, { 'Content-Type': 'text/plain' }, 'not found\n');
      console.error('share: metadata read failed', err);
      return send(500, { 'Content-Type': 'text/plain' }, 'internal error\n');
    }
    if (typeof meta.createdAt !== 'number' || Date.now() - meta.createdAt > EXPIRY_MS) {
      return send(410, { 'Content-Type': 'text/plain' }, 'expired\n');
    }
    let body;
    try { body = fs.readFileSync(path.join(DATA_DIR, `${short}.html`)); }
    catch (err) {
      if (err.code === 'ENOENT') return send(404, { 'Content-Type': 'text/plain' }, 'not found\n');
      console.error('share: bytes read failed', err);
      return send(500, { 'Content-Type': 'text/plain' }, 'internal error\n');
    }
    return send(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    }, body);
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
