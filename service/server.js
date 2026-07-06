'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Hosted-runtime store + capability auth for the /r endpoints (Task 3). Pure
// CJS helpers (token mint/hash/verify, ingest, readHosted, baseBodyHash); the
// self-description reader they pair with is the vendored ESM identity.mjs,
// dynamically imported from the async route handlers below.
const hosted = require('./lib/hosted.js');

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

// AI gallery (/ai). The static storefront page plus the downloadable
// intelligence carriers under public/ai/carriers/. The carrier Map IS the
// allowlist — a request-time path is never concatenated into a disk read, so
// traversal (/ai/..%2fserver.js) is structurally impossible: the decoded key
// simply isn't in the Map and the request falls through to 404.
const AI_INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'ai', 'index.html'));
const AI_CARRIERS = new Map();
for (const f of fs.readdirSync(path.join(PUBLIC_DIR, 'ai', 'carriers'))) {
  // role name is [a-z0-9-] (note hyphens: presentation-coach), suffix .intelligence.html
  if (/^[a-z0-9-]+\.intelligence\.html$/.test(f)) {
    AI_CARRIERS.set(f, fs.readFileSync(path.join(PUBLIC_DIR, 'ai', 'carriers', f)));
  }
}

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

// Skill bundle (/skill.zip). Same SKILL.md the copy button serves, plus a
// couple of worked INLINE_DOC body fragments under examples/. Built once at
// startup; the buffer is small (~30 KB) so STORED (no compression) keeps the
// code minimal and the bytes deterministic across restarts.
const SKILL_DIR = path.join(PUBLIC_DIR, 'skill');
const skillBundleFiles = [['SKILL.md', skillBody || '']];
try {
  for (const name of fs.readdirSync(path.join(SKILL_DIR, 'examples')).sort()) {
    if (!name.endsWith('.html')) continue;
    const buf = fs.readFileSync(path.join(SKILL_DIR, 'examples', name));
    skillBundleFiles.push([`examples/${name}`, buf]);
  }
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
  console.warn(`skill.zip: examples dir missing at ${SKILL_DIR}/examples — bundle will ship SKILL.md only`);
}
const SKILL_ZIP = buildStoredZip(skillBundleFiles);
console.log(`skill.zip: built ${SKILL_ZIP.length} bytes from ${skillBundleFiles.length} entries`);

// Minimal STORED-only zip writer. Format ref: PKZIP APPNOTE.TXT §4.
// Uses node:zlib.crc32 (Node 18.5+) for the required entry CRCs. Mtime is
// pinned so successive restarts emit byte-identical archives — lets the
// landing page cache the link without ETag plumbing.
function buildStoredZip(entries) {
  const zlib = require('node:zlib');
  const DOS_TIME = 0;
  const DOS_DATE = 23728; // 2026-05-16 00:00, deterministic
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const dataBuf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const crc = zlib.crc32(dataBuf);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);     // local file header signature
    lh.writeUInt16LE(20, 4);              // version needed
    lh.writeUInt16LE(0, 6);               // general purpose flags
    lh.writeUInt16LE(0, 8);               // method: STORED
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(dataBuf.length, 18); // compressed size
    lh.writeUInt32LE(dataBuf.length, 22); // uncompressed size
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);              // extra field length
    parts.push(lh, nameBuf, dataBuf);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);      // central directory header signature
    ch.writeUInt16LE(0x031e, 4);          // version made by (Unix, v2.0)
    ch.writeUInt16LE(20, 6);              // version needed
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(dataBuf.length, 20);
    ch.writeUInt32LE(dataBuf.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0x81a40000, 38);     // external attrs: regular file, mode 0644
    ch.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([ch, nameBuf]));

    offset += lh.length + nameBuf.length + dataBuf.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);      // end of central dir signature
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cd, eocd]);
}

// pdf.js is self-hosted (not loaded from cdnjs) because the inline
// `<script type="module">` import doesn't validate SRI on the imported URL —
// integrity= only fires for `<script src=>`. Serving same-origin removes the
// CDN-trust dependency entirely. Files are copied from cli/node_modules/
// pdfjs-dist/build/ at the matching version; bumping the CLI's pdfjs-dist
// version means re-copying these files (and updating cdnjs SRI for the other
// libs that DO load via classic script).
const PDFJS_MAIN = fs.readFileSync(path.join(PUBLIC_DIR, 'pdf', 'pdf.min.mjs'));
const PDFJS_WORKER = fs.readFileSync(path.join(PUBLIC_DIR, 'pdf', 'pdf.worker.min.mjs'));

// Hosted live-editable projection shim (Task 6). Read once at startup like the
// other static assets; templated per request with __RWA_HOSTED_ID__ +
// __RWA_HOSTED_UUID__ and injected before <script id="rwa-bootstrap"> in GET
// /r/:id so it parses/runs first (reload-sync + commit sink + Undo + token).
const HOSTED_SHIM = fs.readFileSync(path.join(PUBLIC_DIR, 'hosted-shim.js'), 'utf8');

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

// Share hosts: <short>.rewritable.<tld...>. Each share lives at its own
// origin so the browser's same-origin policy isolates per-share IDB +
// sessionStorage + OPFS. The regex tolerates any apex domain (matches dev
// hostnames like `abc12345.rewritable.local` as well as production
// `abc12345.rewritable.ikangai.com`).
const SHORT_HOST_RE = /^([0-9a-z]{8})\.rewritable\./;
const ROBOTS_TXT = 'User-agent: *\nDisallow: /\n';

// Local dev: wildcard DNS doesn't resolve against localhost, so dev keeps
// the path-keyed `/s/<short>` URL shape working. Production always uses
// host-keyed share URLs.
function isLocalHost(host) {
  if (!host) return true;
  const h = host.split(':')[0];
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.local');
}

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

// Per-CAPABILITY-TOKEN sliding-window write limit on /modify. Separate from the
// per-IP limit above (a single IP may legitimately drive many distinct rwas;
// this caps writes per rwa-cap). In-memory, same shape as the per-IP limiter.
// Keyed by the token's capHash — NEVER the raw token — so the limiter map can't
// leak a credential. Default 60 writes/hour; overridable for tests via
// RWA_MODIFY_RATE_LIMIT so a test can hit the cap without firing 60 requests.
const MODIFY_RATE_LIMIT = Number(process.env.RWA_MODIFY_RATE_LIMIT) || 60;
const modifyRateBuckets = new Map();

// Server-side document size cap. The vendored apply pipeline (cli/src parity)
// only COMMENTS the MAX_DOC cap (a CLI scope-down), so an authorized token-holder
// could otherwise grow a hosted doc to the 25MB body cap. We enforce it here so
// hosted bounds == substrate bounds: the seed's RWA_EDIT.MAX_DOC (1MiB) on the
// LF-canonical editable body, both on /modify (post-apply) and at ingest. The
// rejection code matches the seed's RwaEditError('target_size_exceeded').
// Overridable via RWA_HOSTED_MAX_DOC so a test can trip the cap without a 1MiB
// request (same pattern as RWA_MODIFY_RATE_LIMIT above).
const HOSTED_MAX_DOC = Number(process.env.RWA_HOSTED_MAX_DOC) || (1024 * 1024);

function checkModifyRateLimit(capHash) {
  const now = Date.now();
  let bucket = modifyRateBuckets.get(capHash);
  if (!bucket) { bucket = []; modifyRateBuckets.set(capHash, bucket); }
  while (bucket.length && bucket[0] < now - RATE_WINDOW_MS) bucket.shift();
  if (bucket.length >= MODIFY_RATE_LIMIT) {
    return { ok: false, retryAfterSec: Math.ceil((bucket[0] + RATE_WINDOW_MS - now) / 1000) };
  }
  bucket.push(now);
  return { ok: true };
}

// Two TTL classes share DATA_DIR: ephemeral /publish snapshots die 24h after
// creation (unchanged); kind:'connected' shares are durable while active —
// they die only after 90 days without an update or a view (NINETY_DAYS_MS
// from hosted.js, the same constant the /r runtime sweeps on).
function shareExpired(meta, now) {
  if (meta && meta.kind === 'connected') {
    return typeof meta.lastActivity !== 'number' || now - meta.lastActivity > hosted.NINETY_DAYS_MS;
  }
  return !meta || typeof meta.createdAt !== 'number' || now - meta.createdAt > EXPIRY_MS;
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
        expired = shareExpired(meta, now);
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
  for (const [k, v] of modifyRateBuckets) {
    while (v.length && v[0] < now - RATE_WINDOW_MS) v.shift();
    if (v.length === 0) modifyRateBuckets.delete(k);
  }

  if (deleted > 0 || kept > 0) console.log(`sweep: deleted ${deleted}, kept ${kept}`);

  // Hosted runtime (/r) 90-day inactivity sweep — disjoint from the /s/ share
  // files above (it scans ONLY the DATA_DIR/r/ subtree). Same hourly cadence.
  try {
    const removedHosted = hosted.sweepHosted(now, { dataDir: DATA_DIR });
    if (removedHosted.length > 0) console.log(`sweep: hosted removed ${removedHosted.length}`);
  } catch (err) {
    console.error('sweep: hosted sweep failed', err && err.message);
  }
}

sweepExpired();
// Sweep cadence is hourly — frequent enough that expired shares 410 promptly,
// rare enough that the sweep cost is negligible.
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
setInterval(sweepExpired, SWEEP_INTERVAL_MS).unref();

// Serve the bytes of a published share. Used both by host-keyed share
// requests (the normal production path) and the path-keyed dev fallback.
function serveShare(short, send) {
  let meta;
  try { meta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${short}.json`), 'utf8')); }
  catch (err) {
    if (err.code === 'ENOENT') return send(404, { 'Content-Type': 'text/plain' }, 'not found\n');
    console.error('share: metadata read failed', err);
    return send(500, { 'Content-Type': 'text/plain' }, 'internal error\n');
  }
  if (shareExpired(meta, Date.now())) {
    return send(410, { 'Content-Type': 'text/plain' }, 'expired\n');
  }
  let body;
  try { body = fs.readFileSync(path.join(DATA_DIR, `${short}.html`)); }
  catch (err) {
    if (err.code === 'ENOENT') return send(404, { 'Content-Type': 'text/plain' }, 'not found\n');
    console.error('share: bytes read failed', err);
    return send(500, { 'Content-Type': 'text/plain' }, 'internal error\n');
  }
  if (meta.kind === 'connected') {
    // A view refreshes the inactivity clock (durable WHILE ACTIVE). Best
    // effort: a failed bump must never fail the read.
    try {
      atomicWriteFile(path.join(DATA_DIR, `${short}.json`),
        JSON.stringify({ ...meta, lastActivity: Date.now() }));
    } catch (err) { console.error('share: lastActivity bump failed', err.message); }
  }
  return send(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
  }, body);
}

// ── I6 (v0.9 §11) — signed-skill marketplace: a read-only index of signed skills with TOFU
// author-key trust + cryptographic revocation. Distinct from /publish (ephemeral doc snapshots):
// skill-specific, signed, durable, queryable. Install-time human review stays the trust anchor —
// the index only informs; the seed verifies the signature client-side and the dialog walls.
const SKILLS_DIR = path.join(DATA_DIR, 'skills');
fs.mkdirSync(SKILLS_DIR, { recursive: true });
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const SKILL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/; // base64url skillId; also the path-traversal guard
// Index/detail are PUBLIC read-only data → CORS-open so the seed's discover chrome can fetch from
// file:// (null origin) or any host; safe because there's no per-user data (counters are aggregates).
const SKILL_READ_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'max-age=300', 'Access-Control-Allow-Origin': '*' };
function sendSkillJson(send, status, obj, extra) {
  send(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extra || {}), JSON.stringify(obj) + '\n');
}
function skillFingerprint(pubkeyB64) { return crypto.createHash('sha256').update(Buffer.from(String(pubkeyB64), 'utf8')).digest('hex').slice(0, 16); }
function skillRecordPath(id) { return path.join(SKILLS_DIR, id + '.json'); }
function readSkillRecord(id) { try { const r = JSON.parse(fs.readFileSync(skillRecordPath(id), 'utf8')); r.id = id; return r; } catch { return null; } }
function writeSkillRecord(id, rec) { const { id: _drop, ...body } = rec; atomicWriteFile(skillRecordPath(id), JSON.stringify(body)); }
function listSkillRecords() {
  let files = []; try { files = fs.readdirSync(SKILLS_DIR); } catch { /* no skills yet */ }
  return files.filter(f => f.endsWith('.json') && !f.startsWith('_')).map(f => readSkillRecord(f.slice(0, -5))).filter(Boolean);
}
// Generic Ed25519 verify of an arbitrary message (revocation proof) by a raw base64 pubkey.
function verifyEd25519(message, sigB64, pubkeyB64) {
  try {
    const raw = Buffer.from(String(pubkeyB64), 'base64');
    const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(String(message), 'utf8'), key, Buffer.from(String(sigB64), 'base64'));
  } catch { return false; }
}
function indexEntry(rec) {
  const s = rec.envelope.skill, m = rec.metadata || {};
  return {
    skillId: rec.id, name: s.name, version: s.version, author_pubkey: s.author_pubkey, kind: s.kind,
    permissions_summary: [...new Set((Array.isArray(s.permissions) ? s.permissions : []).map(p => String(p).split(':')[0]))],
    verified_count: m.verified ? 1 : 0, verified: !!m.verified, created_at: m.first_published_at, updated_at: m.updated_at,
  };
}
async function handleSkillPublish(req, send) {
  const rl = checkRateLimit(clientIp(req));
  if (!rl.ok) return sendSkillJson(send, 429, { error: 'rate_limited', retryAfterSec: rl.retryAfterSec }, { 'Retry-After': String(rl.retryAfterSec) });
  let buf; try { buf = await readBody(req, MAX_BODY_BYTES); }
  catch (err) { return sendSkillJson(send, err && err.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: err && err.code === 'BODY_TOO_LARGE' ? 'body_too_large' : 'read_failed' }); }
  let env; try { env = JSON.parse(buf.toString('utf8')); } catch { return sendSkillJson(send, 400, { error: 'invalid_json' }); }
  if (!env || env.format !== 'rwa-skill/1' || !env.skill || typeof env.skill.name !== 'string') return sendSkillJson(send, 422, { error: 'malformed_envelope' });
  const sm = await import('./lib/skill-manifest.mjs');
  const { signed, verified } = sm.verifyEnvelope(env);
  const gate = sm.validateInstall(env, { signed, verified }); // unsigned tool → unsigned_capability; compute+perms → compute_with_permissions
  if (!gate.ok) return sendSkillJson(send, 422, { error: gate.errors[0], errors: gate.errors });
  const skill = env.skill, id = sm.skillId(skill.name, skill.author_pubkey), prev = readSkillRecord(id);
  if (prev && prev.metadata && prev.metadata.revoked_at) return sendSkillJson(send, 410, { error: 'revoked', revoked_at: prev.metadata.revoked_at });
  const now = Date.now();
  const metadata = {
    first_published_at: (prev && prev.metadata && prev.metadata.first_published_at) || now,
    updated_at: now, author_fingerprint: skillFingerprint(skill.author_pubkey), verified,
    installations_visible: (prev && prev.metadata && prev.metadata.installations_visible) || 0,
  };
  writeSkillRecord(id, { envelope: env, metadata });
  return sendSkillJson(send, 201, { skillId: id, registryUrl: '/skills/index/' + id, verified });
}
function handleSkillIndex(rawUrl, send) {
  const u = new URL(rawUrl, 'http://x'), q = u.searchParams;
  const kind = q.get('kind'), author = q.get('author'), search = (q.get('search') || '').toLowerCase(), verifiedOnly = q.get('verified_only') === 'true';
  let page = parseInt(q.get('page') || '1', 10); if (!(page >= 1)) page = 1;
  let limit = parseInt(q.get('limit') || '50', 10); if (!(limit >= 1)) limit = 50; if (limit > 200) limit = 200;
  let recs = listSkillRecords().filter(r => !(r.metadata && r.metadata.revoked_at));
  if (kind) recs = recs.filter(r => r.envelope.skill.kind === kind);
  if (author) recs = recs.filter(r => r.envelope.skill.author_pubkey === author);
  if (verifiedOnly) recs = recs.filter(r => r.metadata && r.metadata.verified);
  if (search) recs = recs.filter(r => String(r.envelope.skill.name).toLowerCase().includes(search));
  recs.sort((a, b) => { const A = a.envelope.skill, B = b.envelope.skill; return (A.name < B.name ? -1 : A.name > B.name ? 1 : 0) || (String(A.version) < String(B.version) ? -1 : String(A.version) > String(B.version) ? 1 : 0) || (A.author_pubkey < B.author_pubkey ? -1 : A.author_pubkey > B.author_pubkey ? 1 : 0); });
  const total = recs.length, entries = recs.slice((page - 1) * limit, (page - 1) * limit + limit).map(indexEntry);
  return sendSkillJson(send, 200, { entries, total, page, limit }, SKILL_READ_HEADERS);
}
function handleSkillDetail(id, send) {
  if (!SKILL_ID_RE.test(id)) return sendSkillJson(send, 404, { error: 'not_found' }, SKILL_READ_HEADERS);
  const rec = readSkillRecord(id);
  if (!rec) return sendSkillJson(send, 404, { error: 'not_found' }, SKILL_READ_HEADERS);
  if (rec.metadata && rec.metadata.revoked_at) return sendSkillJson(send, 410, { error: 'revoked', revoked_at: rec.metadata.revoked_at }, SKILL_READ_HEADERS);
  return sendSkillJson(send, 200, { envelope: rec.envelope, metadata: rec.metadata }, SKILL_READ_HEADERS);
}
async function handleSkillRevoke(req, id, send) {
  if (!SKILL_ID_RE.test(id)) return sendSkillJson(send, 404, { error: 'not_found' });
  const rec = readSkillRecord(id);
  if (!rec) return sendSkillJson(send, 404, { error: 'not_found' });
  if (rec.metadata && rec.metadata.revoked_at) return sendSkillJson(send, 200, { revoked_at: rec.metadata.revoked_at }); // permanent + idempotent
  let buf; try { buf = await readBody(req, 64 * 1024); } catch { return sendSkillJson(send, 400, { error: 'read_failed' }); }
  let body; try { body = JSON.parse(buf.toString('utf8')); } catch { return sendSkillJson(send, 400, { error: 'invalid_json' }); }
  const ts = body && body.timestamp, sig = body && body.signature;
  if (typeof ts !== 'number' || typeof sig !== 'string') return sendSkillJson(send, 400, { error: 'missing_fields' });
  // Signature MUST be by the registered author key over 'REVOKE:'||skillId||timestampMs (§11).
  if (!verifyEd25519('REVOKE:' + id + ts, sig, rec.envelope.skill.author_pubkey)) return sendSkillJson(send, 403, { error: 'invalid_signature' });
  rec.metadata.revoked_at = Date.now(); rec.metadata.revocation_signature = sig;
  writeSkillRecord(id, rec);
  try { fs.appendFileSync(path.join(SKILLS_DIR, '_revocations.log'), JSON.stringify({ skillId: id, at: rec.metadata.revoked_at }) + '\n'); } catch { /* audit best-effort */ }
  return sendSkillJson(send, 200, { revoked_at: rec.metadata.revoked_at });
}
async function handleSkillReport(req, id, send) {
  if (!SKILL_ID_RE.test(id)) return sendSkillJson(send, 404, { error: 'not_found' });
  const rl = checkRateLimit(clientIp(req)); // abuse-rate-limited; no auto-block (human review gate, Shape B)
  if (!rl.ok) return sendSkillJson(send, 429, { error: 'rate_limited', retryAfterSec: rl.retryAfterSec }, { 'Retry-After': String(rl.retryAfterSec) });
  let buf; try { buf = await readBody(req, 64 * 1024); } catch { return sendSkillJson(send, 400, { error: 'read_failed' }); }
  let body; try { body = JSON.parse(buf.toString('utf8')); } catch { return sendSkillJson(send, 400, { error: 'invalid_json' }); }
  const reason = String((body && body.reason) || '').slice(0, 256);
  if (!reason) return sendSkillJson(send, 400, { error: 'missing_reason' });
  const at = Date.now();
  try { fs.appendFileSync(path.join(SKILLS_DIR, '_reports.log'), JSON.stringify({ skillId: id, reason, evidence_url: (body && body.evidence_url) || null, at }) + '\n'); } catch { /* best-effort queue */ }
  return sendSkillJson(send, 201, { reported_at: at });
}

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
  // Production: host-keyed share URL so each share gets its own origin.
  // Local dev: path-keyed fallback (wildcard DNS doesn't resolve against
  // localhost).
  const shareUrl = isLocalHost(host)
    ? `${scheme}://${host}/s/${short}`
    : `${scheme}://${short}.${host}/`;
  return send(201, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }, JSON.stringify({ short, url: shareUrl, expiresAt: createdAt + EXPIRY_MS }) + '\n');
}

// ─── Hosted runtime (/r): store + capability auth + read endpoints ─────────
// A hosted rwa is stored under DATA_DIR/r/<id>/ (disjoint from the /s/ share
// files). Reads are gated by a per-rwa capability token (Authorization: Bearer
// <token>); only the token's sha-256 hash is persisted (hosted.js). The /modify
// WRITE endpoint is Task 4 — not built here. The token is NEVER logged.

const JSON_CT = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const sendJson = (send, status, obj) => send(status, JSON_CT, JSON.stringify(obj) + '\n');

// Container-fact extraction regexes. Module scope (not per-request) so they
// aren't recompiled on every hosted read/write. UUID_RE_LOCAL has a capture
// group (the apex UUID_RE above is bare) — the two are intentionally distinct.
const UUID_RE_LOCAL = /const DOC_UUID = '([0-9a-f-]{36})';/;
const PRODUCT_KIND_RE = /const PRODUCT_KIND = '([^']*)';/;

// Pull the Bearer token out of the Authorization header. Returns null for a
// missing or malformed header (→ caller responds 401, never 500).
function bearerToken(req) {
  const h = req.headers['authorization'];
  if (!h || typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(\S+)$/);
  return m ? m[1] : null;
}

// ─── Connected shares (/share route family) ────────────────────────────────
// The stable-URL sibling of POST /publish (which stays untouched): create
// returns an update token; re-publishing to the same short is Bearer-gated.
// Storage reuses the publish files (DATA_DIR/<short>.{html,json}) with a
// kind:'connected' metadata class — durable while active, swept after 90 days
// of inactivity instead of the ephemeral 24h rule.
// Design: docs/plans/2026-06-11-save-affordance-framings.md §7c.
//
// CORS: the consumer is the seed's share chrome running at file:// (null
// origin), so every /share* response — success, error, and preflight — must
// carry Access-Control-Allow-Origin. Wide-open is safe here: no cookies, the
// only credential is the capability token the caller explicitly presents.
const SHARE_CORS = { 'Access-Control-Allow-Origin': '*' };
const sendShareJson = (send, status, obj) =>
  send(status, { ...JSON_CT, ...SHARE_CORS }, JSON.stringify(obj) + '\n');

function handleSharePreflight(send) {
  return send(204, {
    ...SHARE_CORS,
    'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Max-Age': '86400',
  }, '');
}

// URL shape is identical to /publish: host-keyed per-share origin in
// production, path-keyed fallback in local dev.
function shareUrlFor(req, short) {
  const scheme = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = req.headers.host || 'localhost';
  return isLocalHost(host) ? `${scheme}://${host}/s/${short}` : `${scheme}://${short}.${host}/`;
}

// Shared body-read + container validation for create/update. Resolves to the
// UTF-8 text or null after having sent the error response itself.
async function readShareContainer(req, send) {
  let buf;
  try { buf = await readBody(req, MAX_BODY_BYTES); }
  catch (err) {
    if (err && err.code === 'BODY_TOO_LARGE') {
      sendShareJson(send, 413, { error: 'body_too_large', maxBytes: MAX_BODY_BYTES });
    } else {
      sendShareJson(send, 400, { error: 'read_failed', detail: String(err && err.message || err) });
    }
    return null;
  }
  const text = buf.toString('utf8');
  const val = validateContainer(text);
  if (!val.ok) {
    sendShareJson(send, 400, { error: 'validation_failed', detail: val.detail });
    return null;
  }
  return text;
}

async function handleShareCreate(req, send) {
  const ip = clientIp(req);
  const rl = checkRateLimit(ip);   // shared per-IP bucket with /publish
  if (!rl.ok) {
    return send(429, { ...JSON_CT, ...SHARE_CORS, 'Retry-After': String(rl.retryAfterSec) },
      JSON.stringify({ error: 'rate_limited', retryAfterSec: rl.retryAfterSec }) + '\n');
  }
  const text = await readShareContainer(req, send);
  if (text == null) return;

  // Every publish rotates DOC_UUID — a receiver who once opened an earlier
  // version of this share must not have their stale per-UUID IDB shadow the
  // update (the receiver-side inversion, framings doc §7b).
  const newText = text.replace(UUID_RE, `const DOC_UUID = '${crypto.randomUUID()}';`);

  let short;
  try { short = generateShort(); }
  catch (err) {
    console.error('share: short generation failed', err);
    return sendShareJson(send, 503, { error: 'collision', detail: err.message });
  }

  const token = hosted.mintToken();
  const createdAt = Date.now();
  const meta = {
    kind: 'connected',
    capHash: hosted.hashToken(token),   // the raw token is never at rest
    createdAt, updatedAt: createdAt, lastActivity: createdAt,
    sizeBytes: Buffer.byteLength(newText, 'utf8'), ip,
  };
  try {
    atomicWriteFile(path.join(DATA_DIR, `${short}.html`), newText);
    atomicWriteFile(path.join(DATA_DIR, `${short}.json`), JSON.stringify(meta));
  } catch (err) {
    console.error('share: write failed', err);
    return sendShareJson(send, 500, { error: 'storage_failed' });
  }
  return sendShareJson(send, 201, { short, url: shareUrlFor(req, short), token, kind: 'connected' });
}

// Read + gate a connected share's metadata for a Bearer-authenticated write.
// Returns the meta object, or null after having sent the error itself.
// Unknown short and known-but-ephemeral short are BOTH 404 — an ephemeral
// /publish snapshot has no update capability, and the distinction would only
// leak which class a code belongs to.
function authConnectedShare(req, send, short) {
  // The route gate already constrains the shape, but the filename invariant
  // belongs HERE too — a future caller must not be able to reach the
  // path.join below with traversal-shaped input.
  if (!SHORT_RE.test(short)) { sendShareJson(send, 404, { error: 'not_found' }); return null; }
  let meta;
  try { meta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${short}.json`), 'utf8')); }
  catch { sendShareJson(send, 404, { error: 'not_found' }); return null; }
  if (meta.kind !== 'connected' || typeof meta.capHash !== 'string') {
    sendShareJson(send, 404, { error: 'not_found' });
    return null;
  }
  const token = bearerToken(req);
  if (!hosted.verifyToken(token, meta.capHash)) {
    send(401, { ...JSON_CT, ...SHARE_CORS, 'WWW-Authenticate': 'Bearer' },
      JSON.stringify({ error: 'unauthorized' }) + '\n');
    return null;
  }
  return meta;
}

async function handleShareDelete(req, send, short) {
  const meta = authConnectedShare(req, send, short);
  if (!meta) return;
  for (const ext of ['html', 'json']) {
    try { fs.unlinkSync(path.join(DATA_DIR, `${short}.${ext}`)); } catch {}
  }
  return send(204, SHARE_CORS, '');
}

async function handleShareUpdate(req, send, short) {
  const meta = authConnectedShare(req, send, short);
  if (!meta) return;
  // Per-capability write limit (shared limiter map with hosted /modify —
  // distinct hashes, same policy: a leaked-URL flood can't grind the disk).
  const rl = checkModifyRateLimit(meta.capHash);
  if (!rl.ok) {
    return send(429, { ...JSON_CT, ...SHARE_CORS, 'Retry-After': String(rl.retryAfterSec) },
      JSON.stringify({ error: 'rate_limited', retryAfterSec: rl.retryAfterSec }) + '\n');
  }
  const text = await readShareContainer(req, send);
  if (text == null) return;

  const newText = text.replace(UUID_RE, `const DOC_UUID = '${crypto.randomUUID()}';`);
  const now = Date.now();
  const newMeta = {
    ...meta,
    updatedAt: now, lastActivity: now,
    sizeBytes: Buffer.byteLength(newText, 'utf8'),
  };
  try {
    atomicWriteFile(path.join(DATA_DIR, `${short}.html`), newText);
    atomicWriteFile(path.join(DATA_DIR, `${short}.json`), JSON.stringify(newMeta));
  } catch (err) {
    console.error('share: update write failed', err);
    return sendShareJson(send, 500, { error: 'storage_failed' });
  }
  return sendShareJson(send, 200, { short, url: shareUrlFor(req, short), updatedAt: now });
}

// POST /r — create a hosted rwa from raw .html bytes. Anonymous (creating).
async function handleHostedCreate(req, send) {
  let buf;
  try { buf = await readBody(req, MAX_BODY_BYTES); }
  catch (err) {
    if (err && err.code === 'BODY_TOO_LARGE') {
      return sendJson(send, 413, { error: 'body_too_large', maxBytes: MAX_BODY_BYTES });
    }
    return sendJson(send, 400, { error: 'read_failed' });
  }

  // Reject a container whose editable body already exceeds MAX_DOC, so you can't
  // seed an oversized doc the cap would then forbid editing. Measured on the
  // LF-canonical body via the vendored extractInlineDoc (same backtick-walk the
  // apply path uses). A non-rewritable / extractor failure falls through to
  // hosted.ingest's own validation (which returns 400 not_a_rewritable).
  const bytesStr = buf.toString('utf8');
  try {
    const { extractInlineDoc } = await import('./lib/seed.mjs');
    const body = hosted.canonLF(extractInlineDoc(bytesStr));
    if (body.length > HOSTED_MAX_DOC) {
      return sendJson(send, 400, { error: 'target_size_exceeded' });
    }
  } catch { /* not extractable here → ingest's validation surfaces the real error */ }

  let id, token;
  try {
    ({ id, token } = hosted.ingest(bytesStr, { dataDir: DATA_DIR }));
  } catch (err) {
    if (err && err.code === 'not_a_rewritable') {
      return sendJson(send, 400, { error: 'not_a_rewritable' });
    }
    console.error('hosted: ingest failed', err && err.message);
    return sendJson(send, 500, { error: 'storage_failed' });
  }

  // Projection URL: <base>/r/<id>#k=<token>. The token rides the fragment so it
  // never reaches the server on a navigation (Task 6 builds the projection page).
  const scheme = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = req.headers.host || 'localhost';
  const base = `${scheme}://${host}`;
  return sendJson(send, 200, { id, token, url: `${base}/r/${id}#k=${token}` });
}

// Compute the self-description/1 projection over a container's bytes + its
// already-extracted editable body. Shared by the describe/doc reads AND the
// /modify response so the post-edit self-description is byte-for-byte the same
// projection a subsequent /describe would return. The reader is the vendored
// ESM identity.mjs (+ apply-edits.mjs for frozen zones); dynamic-import from
// these async handlers (CJS can't static-import ESM). Mirrors cli/src/doc.mjs.
async function selfDescriptionFor(bytes, doc) {
  const { resolveSelfDescription } = await import('./lib/identity.mjs');
  const { findFrozenZones } = await import('./lib/apply-edits.mjs');
  const uuid = (bytes.match(UUID_RE_LOCAL) || [])[1] || null;
  const kind = (bytes.match(PRODUCT_KIND_RE) || [])[1] || 'document';
  const frozenZones = findFrozenZones(doc).map((z) => z.name);
  return resolveSelfDescription({ fileText: bytes, doc, uuid, kind, frozenZones });
}

// GET /r/:id/{describe,export,doc} — authenticated reads over the stored bytes.
async function handleHostedRead(id, action, req, send) {
  const rec = hosted.readHosted(id, { dataDir: DATA_DIR });
  // Unknown id → 404. Bad/missing token → 401. Order: a present-but-unauthorized
  // caller learns nothing about existence beyond the id they already named.
  if (!rec) return sendJson(send, 404, { error: 'not_found' });

  const token = bearerToken(req);
  if (!hosted.verifyToken(token, rec.owner.capHash)) {
    return sendJson(send, 401, { error: 'unauthorized' });
  }

  // Authorized: touch lastAccess (best-effort, non-fatal).
  hosted.touchAccess(id, { dataDir: DATA_DIR }, rec.owner);

  if (action === 'export') {
    // The stored bytes verbatim.
    return send(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, rec.bytes);
  }

  // describe + doc both need the self-description/1 projection over the bytes.
  // The editable-body reader is the vendored ESM seed.mjs; dynamic-import from
  // this async handler (CJS can't static-import ESM). Mirrors cli/src/doc.mjs.
  const { extractInlineDoc } = await import('./lib/seed.mjs');

  let doc;
  try { doc = extractInlineDoc(rec.bytes); }
  catch { return sendJson(send, 500, { error: 'corrupt_container' }); }

  const selfDescription = await selfDescriptionFor(rec.bytes, doc);

  if (action === 'describe') {
    return sendJson(send, 200, selfDescription);
  }

  // doc: the LF-canonical editable body + its sha-256 + the self-description.
  // baseHash is what a Phase-B client feeds the agent + sends as the envelope
  // baseHash. canonLF so the hash is over exactly the edit-contract bytes.
  const canonDoc = hosted.canonLF(doc);
  return sendJson(send, 200, {
    doc: canonDoc,
    baseHash: hosted.sha256hex(canonDoc),
    selfDescription,
  });
}

// ─── Per-id write lock ──────────────────────────────────────────────────────
// /modify (and future /undo) for the SAME id must serialize: applyPlan writes
// current.html in place, so two concurrent writers could lose an update or
// interleave. We chain each write behind the prior one's promise per id (the
// in-process mirror of the seed's modifyMutex). Single-process service, so an
// in-memory Map is sufficient; a multi-process deploy would need a file lock
// (not in scope — the deploy is one node process).
const writeLocks = new Map();

function withWriteLock(id, fn) {
  const prev = writeLocks.get(id) || Promise.resolve();
  // The next link runs fn() AFTER prev settles, regardless of prev's outcome
  // (a prior failure must not wedge the chain). prev is already guarded, so
  // .catch here is belt-and-suspenders.
  const next = prev.catch(() => {}).then(fn);
  // Keep the chain tip current; clear the entry once this link settles and no
  // newer writer has taken over, so the Map doesn't grow unboundedly.
  writeLocks.set(id, next);
  next.catch(() => {}).finally(() => {
    if (writeLocks.get(id) === next) writeLocks.delete(id);
  });
  return next;
}

// Map an applyPlan CliError to the HTTP status. Envelope/apply failures (exit 3)
// are 422 (the request is well-formed but its envelope can't apply to the
// current bytes); a file error (exit 2) on OUR own temp copy is an internal
// fault → 500. The subcode (e.g. frozen_zone_violation, find_not_found) is the
// {error} the client sees — same vocabulary as `rwa edit --json`.
function modifyErrorStatus(err) {
  if (err && err.exitCode === 3) return 422;
  return 500;
}

// POST /r/:id/modify — the authoritative, model-free, audited WRITE endpoint.
// Applies an rwa-edit/1 envelope to the stored bytes via the vendored applyPlan,
// under optimistic concurrency (baseHash) + a per-id write lock, and appends a
// forward audit record. The server NEVER trusts a client-supplied doc — it
// applies the envelope to ITS OWN current.html; baseHash is only a staleness
// check, not the bytes to write. Model-free: it only APPLIES (never calls an LLM).
async function handleHostedModify(id, req, send) {
  // Auth + existence first (cheap, no lock needed — these don't write).
  const rec0 = hosted.readHosted(id, { dataDir: DATA_DIR });
  if (!rec0) return sendJson(send, 404, { error: 'not_found' });
  const token = bearerToken(req);
  if (!hosted.verifyToken(token, rec0.owner.capHash)) {
    return sendJson(send, 401, { error: 'unauthorized' });
  }

  // Per-token write rate limit — keyed by the verified capHash (never the raw
  // token), checked BEFORE acquiring the write lock or applying. The N+1th write
  // for this cap within the window → 429, no lock, no write.
  const rl = checkModifyRateLimit(rec0.owner.capHash);
  if (!rl.ok) {
    return send(429, { ...JSON_CT, 'Retry-After': String(rl.retryAfterSec) },
      JSON.stringify({ error: 'rate_limited', retryAfterSec: rl.retryAfterSec }) + '\n');
  }

  // Parse + validate the request body (bad input → 400, no lock, no write).
  let buf;
  try { buf = await readBody(req, MAX_BODY_BYTES); }
  catch (err) {
    if (err && err.code === 'BODY_TOO_LARGE') {
      return sendJson(send, 413, { error: 'body_too_large', maxBytes: MAX_BODY_BYTES });
    }
    return sendJson(send, 400, { error: 'bad_request' });
  }
  let body;
  try { body = JSON.parse(buf.toString('utf8')); }
  catch { return sendJson(send, 400, { error: 'bad_request' }); }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return sendJson(send, 400, { error: 'bad_request' });
  }
  const { envelope, baseHash } = body;
  // actor rides verbatim into the durable JSONL audit log, so cap it (fail loud,
  // not silent-truncate): >128 chars bloats the log, a newline forges a record
  // boundary. Reject either with 400. Absent/empty → web:anon default.
  if (body.actor != null && typeof body.actor !== 'string') {
    return sendJson(send, 400, { error: 'bad_request' });
  }
  if (typeof body.actor === 'string' && (body.actor.length > 128 || /[\r\n]/.test(body.actor))) {
    return sendJson(send, 400, { error: 'bad_request' });
  }
  const actor = typeof body.actor === 'string' && body.actor.length > 0 ? body.actor : 'web:anon';
  if (typeof envelope !== 'object' || envelope === null) {
    return sendJson(send, 400, { error: 'bad_request' });
  }
  if (typeof baseHash !== 'string' || !/^[0-9a-f]{64}$/.test(baseHash)) {
    return sendJson(send, 400, { error: 'bad_request' });
  }

  // The apply lifecycle runs UNDER the per-id write lock so concurrent /modify
  // for the same id serialize (no lost update / no interleave). The lock wraps
  // the staleness check too — a writer must not read a baseHash that a queued
  // write is about to invalidate.
  return withWriteLock(id, async () => {
    // Re-read under the lock — current.html may have advanced while we queued.
    const rec = hosted.readHosted(id, { dataDir: DATA_DIR });
    if (!rec) return sendJson(send, 404, { error: 'not_found' });

    const { applyPlan, CliError } = await import('./lib/edit.mjs');
    const { compileDslPlan } = await import('./lib/dsl-compiler.mjs');
    const { extractInlineDoc } = await import('./lib/seed.mjs');

    // Optimistic concurrency: the posted baseHash must match the CURRENT body
    // hash. Mismatch → 409, NO write. (hosted.baseBodyHash = sha256 of the
    // LF-canonical editable body — the same value /doc returns as baseHash.)
    const currentHash = await hosted.baseBodyHash(rec.bytes);
    if (currentHash !== baseHash) {
      return sendJson(send, 409, { error: 'stale_base', currentHash });
    }

    // Apply against a TEMP COPY of current.html (never current.html directly):
    // applyPlan reads + atomically writes the path it's given, so on failure
    // current.html is untouched and we just delete the temp.
    const dir = hosted.idDir(DATA_DIR, id);
    const tmpPath = path.join(dir, `.modify-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
    try { fs.writeFileSync(tmpPath, rec.bytes); }
    catch (err) {
      console.error('hosted: modify temp write failed', err && err.message);
      return sendJson(send, 500, { error: 'storage_failed' });
    }

    try {
      // images-v1 (rwa-edit-spec.md §19): the hosted projection relays an
      // EXPANDED envelope (real data: URIs) from a browser. virtualizeEnvelope
      // tokenizes it + the stored doc into one map so the per-edit cap measures
      // the text budget (not image bytes); the expanded-size guard (10 MB) is
      // the DoS bound. The only caller that sets this — only this surface relays
      // browser-authored image bytes server-side.
      await applyPlan(tmpPath, envelope, { virtualizeEnvelope: true });
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
      if (err instanceof CliError) {
        const status = modifyErrorStatus(err);
        const payload = { error: err.subcode };
        // Surface a one-line hint if the apply pipeline attached one (additive).
        if (err.details && err.details.hint) payload.detail = err.details.hint;
        return sendJson(send, status, payload);
      }
      console.error('hosted: modify apply unexpected error', err && err.message);
      return sendJson(send, 500, { error: 'internal_error' });
    }

    // Apply succeeded → the new bytes are at tmpPath. Read back the new editable
    // body (same extractor + canonLF the edit contract operates on) and its hash.
    let newBytes, newBody;
    try {
      newBytes = fs.readFileSync(tmpPath, 'utf8');
      newBody = hosted.canonLF(extractInlineDoc(newBytes));
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch {}
      console.error('hosted: modify readback failed', err && err.message);
      return sendJson(send, 500, { error: 'internal_error' });
    }
    const resultHash = hosted.sha256hex(newBody);

    // Server-side document size cap (the vendored apply only comments it). If the
    // edited body would exceed MAX_DOC, reject with the SAME status apply-failures
    // use (422) and the seed's error code — BEFORE any history/undo/commit — and
    // delete the temp so current.html is untouched. This makes hosted bounds ==
    // substrate bounds (the seed enforces the same cap in-page).
    if (newBody.length > HOSTED_MAX_DOC) {
      try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
      return sendJson(send, 422, { error: 'target_size_exceeded' });
    }

    // Forward audit record (the rwa_hist mirror). `kind` is the RESERVED
    // cross-surface vocabulary (edit_batch / replace_document, CLAUDE.md
    // "Reserved namespaces") and the DSL spec §5 mandates the audit log records
    // the COMPILED form, not the wire form — so we derive `kind` from the
    // compiled tool shape, exactly as the seed/substrate does. A DSL plan whose
    // sole op is a replace_document escape is ops-shaped on the wire but compiles
    // to a replace_document envelope (compiled.tool === 'replace_document'); a
    // raw-shape heuristic would wrongly record it as edit_batch and disagree with
    // the substrate. We mirror applyPlan's discriminator ('ops' → DSL plan,
    // 'doc' → raw replace_document, else apply_edits) so the audit kind can never
    // disagree with what was applied.
    let isReplace;
    let replaceReason; // the compiled/raw reason for a replace_document record
    if ('ops' in envelope) {
      // DSL plan (rwa-edit-dsl/1). Compile against the SAME body input applyPlan
      // uses (extractInlineDoc on the current bytes, pre-canonLF) to read the
      // compiled tool + reason. Recompiling here (applyPlan already compiled this
      // exact plan against this exact body above) is wasteful but acceptable for
      // v1 — the alternative, threading the kind back out of the vendored
      // applyPlan, would mutate a byte-identical mirror, which we must not do. A
      // compile failure here is impossible: the same compile succeeded above.
      const compiled = compileDslPlan(envelope, extractInlineDoc(rec.bytes));
      isReplace = compiled.tool === 'replace_document';
      if (isReplace) replaceReason = compiled.envelope.reason;
    } else {
      // Raw envelope: 'doc' (+reason) → replace_document, else apply_edits.
      isReplace = 'doc' in envelope && !('edits' in envelope);
      if (isReplace) replaceReason = envelope.reason;
    }
    const record = {
      ts: Date.now(),
      actor,
      kind: isReplace ? 'replace_document' : 'edit_batch',
      baseHash,
      resultHash,
    };
    // replace_document records carry the (compiled or raw) reason; edit_batch
    // records carry the forward envelope (the DSL form for a DSL plan, matching
    // the spec's note that the originating plan MAY be retained as metadata).
    if (isReplace) record.reason = replaceReason;
    else record.envelope = envelope;

    // CRASH WINDOW (acceptable for v1): we append the forward audit record
    // BEFORE renaming the new bytes into place. If the process dies between the
    // append and the rename, history.jsonl is one record ahead of current.html.
    // history is forward-only (never used to reconstruct bytes here), and the
    // next successful write re-establishes consistency; a torn append can't
    // corrupt current.html. We append-then-rename (not rename-then-append) so
    // the rename — the durable, user-visible commit — is the LAST step. A torn
    // FINAL history line is likewise harmless: it's a forward-only artifact never
    // parsed to rebuild bytes, so historyLen's non-empty-line count just skips
    // it and the next append starts cleanly on a fresh line.
    try {
      hosted.appendHistory(id, { dataDir: DATA_DIR }, record);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch {}
      console.error('hosted: modify history append failed', err && err.message);
      return sendJson(send, 500, { error: 'storage_failed' });
    }

    // UNDO PRE-IMAGE: durably push the PRE-edit current.html bytes onto the undo
    // stack BEFORE the commit rename. This is the crash-safe reversible state —
    // /undo restores from this pre-image, never by replaying the forward
    // history.jsonl (which can be one record ahead and can't rebuild
    // replace_document bytes). Written before the rename, so a crash between the
    // push and the rename at worst leaves a pre-image for a commit that didn't
    // land (harmless: the next undo would restore bytes already current). A push
    // failure aborts the commit (the new bytes would otherwise be un-undoable).
    try {
      hosted.pushUndo(id, { dataDir: DATA_DIR }, rec.bytes);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch {}
      console.error('hosted: modify undo-preimage push failed', err && err.message);
      return sendJson(send, 500, { error: 'storage_failed' });
    }

    // Atomically move the new bytes into place (rename(2) over current.html).
    try {
      fs.renameSync(tmpPath, path.join(dir, 'current.html'));
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch {}
      console.error('hosted: modify commit rename failed', err && err.message);
      return sendJson(send, 500, { error: 'storage_failed' });
    }

    // Best-effort lastAccess touch + the post-edit self-description (same
    // projection /describe returns over the NEW bytes).
    hosted.touchAccess(id, { dataDir: DATA_DIR }, rec.owner);
    const selfDescription = await selfDescriptionFor(newBytes, newBody);
    // Consistent pair on BOTH /modify and /undo: histLen is the forward-audit
    // record count (monotonic; never decreases), undoLen is the remaining
    // undo-stack depth (a client gates "can I undo again?" on undoLen > 0).
    const histLen = hosted.historyLen(id, { dataDir: DATA_DIR });
    const undoLen = hosted.undoLen(id, { dataDir: DATA_DIR });

    return sendJson(send, 200, {
      doc: newBody,
      baseHash: resultHash,
      selfDescription,
      histLen,
      undoLen,
    });
  });
}

// POST /r/:id/undo — pop the most-recent pre-image and restore it as current.html.
// Crash-safe + composable: the reversible state is the per-id undo pre-image stack
// (written before each /modify rename), NEVER a replay of the forward
// history.jsonl. history.jsonl is NOT mutated here — it stays an append-only
// forward audit; the undo stack alone is the reversible state. Runs under the
// per-id write lock so it serializes with /modify (and another /undo). The
// response carries the SAME {histLen, undoLen} pair as /modify: `histLen` is the
// forward-audit record count (monotonic; undo does NOT mutate history.jsonl, so
// after an undo histLen stays the full forward count — correct and intended), and
// `undoLen` is the REMAINING undo-stack depth (undoable edits left) — a client
// gates "can I undo again?" on undoLen > 0 (the next undo 409s at undoLen 0).
async function handleHostedUndo(id, req, send) {
  const rec0 = hosted.readHosted(id, { dataDir: DATA_DIR });
  if (!rec0) return sendJson(send, 404, { error: 'not_found' });
  const token = bearerToken(req);
  if (!hosted.verifyToken(token, rec0.owner.capHash)) {
    return sendJson(send, 401, { error: 'unauthorized' });
  }

  return withWriteLock(id, async () => {
    // Re-confirm existence under the lock (a concurrent DELETE may have removed it).
    const rec = hosted.readHosted(id, { dataDir: DATA_DIR });
    if (!rec) return sendJson(send, 404, { error: 'not_found' });

    // Pop the most-recent pre-image. Empty stack → 409 nothing_to_undo, NO write.
    let preImage;
    try { preImage = hosted.popUndo(id, { dataDir: DATA_DIR }); }
    catch (err) {
      console.error('hosted: undo pop failed', err && err.message);
      return sendJson(send, 500, { error: 'storage_failed' });
    }
    if (preImage == null) return sendJson(send, 409, { error: 'nothing_to_undo' });

    // Atomically restore the pre-image as current.html.
    const dir = hosted.idDir(DATA_DIR, id);
    try { atomicWriteFile(path.join(dir, 'current.html'), preImage); }
    catch (err) {
      console.error('hosted: undo restore write failed', err && err.message);
      return sendJson(send, 500, { error: 'storage_failed' });
    }

    // Build the response over the restored bytes (same projection /doc returns).
    const { extractInlineDoc } = await import('./lib/seed.mjs');
    let doc;
    try { doc = hosted.canonLF(extractInlineDoc(preImage)); }
    catch { return sendJson(send, 500, { error: 'corrupt_container' }); }
    const baseHash = hosted.sha256hex(doc);
    const selfDescription = await selfDescriptionFor(preImage, doc);

    hosted.touchAccess(id, { dataDir: DATA_DIR }, rec.owner);
    // Same pair as /modify: histLen = forward-audit count (unchanged by undo —
    // history.jsonl is append-only), undoLen = remaining undo-stack depth.
    const histLen = hosted.historyLen(id, { dataDir: DATA_DIR });
    const undoLen = hosted.undoLen(id, { dataDir: DATA_DIR }); // remaining undo depth

    return sendJson(send, 200, { doc, baseHash, selfDescription, histLen, undoLen });
  });
}

// POST /r/:id/rotate — mint a new capability token, replace owner.json.capHash.
// The old token now fails verifyToken (401). Under the write lock so it can't
// race a /modify's owner.json touch.
async function handleHostedRotate(id, req, send) {
  const rec0 = hosted.readHosted(id, { dataDir: DATA_DIR });
  if (!rec0) return sendJson(send, 404, { error: 'not_found' });
  const token = bearerToken(req);
  if (!hosted.verifyToken(token, rec0.owner.capHash)) {
    return sendJson(send, 401, { error: 'unauthorized' });
  }

  return withWriteLock(id, async () => {
    const rec = hosted.readHosted(id, { dataDir: DATA_DIR });
    if (!rec) return sendJson(send, 404, { error: 'not_found' });
    let out;
    try { out = hosted.rotateToken(id, { dataDir: DATA_DIR }, rec.owner); }
    catch (err) {
      console.error('hosted: rotate failed', err && err.message);
      return sendJson(send, 500, { error: 'storage_failed' });
    }
    // The new token is revealed ONCE here (never logged).
    return sendJson(send, 200, { token: out.token });
  });
}

// DELETE /r/:id — remove the rwa subtree recursively. Under the write lock so it
// serializes with /modify + /undo (a queued write sees the dir gone → 404).
async function handleHostedDelete(id, req, send) {
  const rec0 = hosted.readHosted(id, { dataDir: DATA_DIR });
  if (!rec0) return sendJson(send, 404, { error: 'not_found' });
  const token = bearerToken(req);
  if (!hosted.verifyToken(token, rec0.owner.capHash)) {
    return sendJson(send, 401, { error: 'unauthorized' });
  }

  return withWriteLock(id, async () => {
    try { hosted.deleteHosted(id, { dataDir: DATA_DIR }); }
    catch (err) {
      console.error('hosted: delete failed', err && err.message);
      return sendJson(send, 500, { error: 'storage_failed' });
    }
    return sendJson(send, 200, { deleted: true });
  });
}

// GET /r/:id — the LIVE EDITABLE web projection. Serve the REAL stored
// current.html (a full rewritable, the seed's lens/⌘K UI unchanged) with the
// hosted shim injected IMMEDIATELY BEFORE <script id="rwa-bootstrap"> so it
// parses/runs FIRST (reload-sync deletes the stale per-container IDB before the
// bootstrap's openDB; the shim then installs the commit sink + Undo button).
//
// No Bearer needed on the GET itself — the capability token rides the #k=
// fragment (which the server NEVER sees), read client-side by the shim and used
// as Bearer on the subsequent /modify + /undo. Unknown id → 404. Apex-only (the
// router only reaches here on the apex host). The served bytes carry the seed's
// own frozen-<head> CSP (script-src 'unsafe-inline'), which allows the inline
// shim — we don't add headers that would fight it.
function handleHostedProjection(id, send) {
  const rec = hosted.readHosted(id, { dataDir: DATA_DIR });
  if (!rec) return sendJson(send, 404, { error: 'not_found' });

  const bytes = rec.bytes;
  // The stored DOC_UUID is a container fact (ingest rotated it). The shim needs
  // it to deleteDatabase('rwa_<uuid>') for reload-sync. ingest validated DOC_UUID
  // exists, but be defensive — a missing uuid means we can't safely template.
  const uuid = (bytes.match(UUID_RE_LOCAL) || [])[1];
  // Find the bootstrap-script start with the SAME pattern ingest validated
  // against (BOOTSTRAP_RE = /<script id="rwa-bootstrap"/, no closing '>'), so
  // anything ingest accepts — including an attributed open tag like
  // `<script id="rwa-bootstrap" defer>` — can be served. Inject immediately
  // before the matched `<script` start.
  const bm = bytes.match(BOOTSTRAP_RE);
  const at = bm ? bm.index : -1;
  if (!uuid || at < 0) {
    console.error('hosted: projection cannot template (uuid/bootstrap missing)', id);
    return sendJson(send, 500, { error: 'corrupt_container' });
  }

  const shim = '<script id="rwa-hosted-shim">\n'
    + HOSTED_SHIM.replaceAll('__RWA_HOSTED_ID__', id).replaceAll('__RWA_HOSTED_UUID__', uuid)
    + '\n</script>\n';
  const out = bytes.slice(0, at) + shim + bytes.slice(at);

  hosted.touchAccess(id, { dataDir: DATA_DIR }, rec.owner);
  // noindex: a hosted projection is reachable by its unguessable id; keep a leaked
  // id out of search indexes (the editing token still rides the URL fragment).
  return send(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex',
  }, out);
}

function contentTypeFor(name) {
  if (name.endsWith('.html')) return 'text/html; charset=utf-8';
  if (name.endsWith('.md'))   return 'text/markdown; charset=utf-8';
  if (name.endsWith('.css'))  return 'text/css; charset=utf-8';
  if (name.endsWith('.js'))   return 'text/javascript; charset=utf-8';
  if (name.endsWith('.svg'))  return 'image/svg+xml; charset=utf-8';
  return 'application/octet-stream';
}

// GET /ai/template.html — the fresh skill-host carrier template the AI Maker
// fetches and injects into (plan T3.2). The seed subs are the same ones the CLI
// uses to scaffold an intelligence carrier (cli/src/intelligence.mjs), reached
// here via the byte-identical ESM mirror in ./lib/seed.mjs. `applySeedSubs`
// enforces exactly-one-match per region on the pristine SEED_TEMPLATE — the CLI
// proves this combination succeeds on the same seed. The three RWA_MAKER_*
// markers are placeholders the client string-replaces to assemble the carrier.
async function handleAiTemplate(send) {
  const { applySeedSubs, kindOverrides, replaceInlineDoc } = await import('./lib/seed.mjs');
  const ov = kindOverrides('skill-host');
  let t = applySeedSubs(SEED_TEMPLATE, {
    uuid: crypto.randomUUID(),
    title: 'Intelligence — RWA_MAKER_ROLE',
    fileMeta: 'RWA_MAKER_ROLE.intelligence.html',
    productKind: 'skill-host',
    lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder,
    productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor,
  });
  t = replaceInlineDoc(t, '<!--RWA_MAKER_CARD-->\n<!--RWA_MAKER_ZONE-->');
  return send(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  }, t);
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
  const reqHost = (req.headers.host || '').toLowerCase();
  const hostShort = reqHost.match(SHORT_HOST_RE);
  const isShareHost = !!hostShort;

  // Connected shares (/share family). Apex-only like /publish (same
  // wrong-host-URL-minting concern). OPTIONS answers the CORS preflight the
  // seed's file:// share chrome triggers (Authorization header → preflighted).
  if (!isShareHost && (url === '/share' || /^\/share\/[0-9a-z]{8}$/.test(url))) {
    if (req.method === 'OPTIONS') return handleSharePreflight(send);
    if (req.method === 'POST' && url === '/share') {
      handleShareCreate(req, send).catch(err => {
        console.error('share: create unhandled error', err);
        if (!res.headersSent) sendShareJson(send, 500, { error: 'internal_error' });
      });
      return;
    }
    if ((req.method === 'POST' || req.method === 'DELETE') && url !== '/share') {
      const short = url.slice('/share/'.length);
      const handler = req.method === 'POST' ? handleShareUpdate : handleShareDelete;
      handler(req, send, short).catch(err => {
        console.error('share: write unhandled error', err);
        if (!res.headersSent) sendShareJson(send, 500, { error: 'internal_error' });
      });
      return;
    }
  }

  // I6 — signed-skill marketplace (/skills/*). Apex-only (like /publish): a read-only index plus
  // publish/revoke/report. GET reads are cacheable + nosniff; writes are rate-limited.
  if (!isShareHost && (url === '/skills/publish' || url === '/skills/index' || url.startsWith('/skills/index/') || url.startsWith('/skills/revoke/') || url.startsWith('/skills/report/'))) {
    const fail = (err) => { console.error('skills: unhandled error', err); if (!res.headersSent) sendSkillJson(send, 500, { error: 'internal_error' }); };
    if (req.method === 'POST' && url === '/skills/publish') { handleSkillPublish(req, send).catch(fail); return; }
    if (req.method === 'GET' && url === '/skills/index') { handleSkillIndex(req.url, send); return; }
    if (req.method === 'GET' && url.startsWith('/skills/index/')) { handleSkillDetail(url.slice('/skills/index/'.length), send); return; }
    if (req.method === 'POST' && url.startsWith('/skills/revoke/')) { handleSkillRevoke(req, url.slice('/skills/revoke/'.length), send).catch(fail); return; }
    if (req.method === 'POST' && url.startsWith('/skills/report/')) { handleSkillReport(req, url.slice('/skills/report/'.length), send).catch(fail); return; }
    return sendSkillJson(send, 405, { error: 'method_not_allowed' });
  }

  // POST /publish is the only non-GET endpoint. It lives only on the apex
  // host — a malicious publisher must not be able to bounce /publish off
  // a share host and have us mint a URL relative to that wrong host.
  if (req.method === 'POST' && url === '/publish' && !isShareHost) {
    handlePublish(req, send).catch(err => {
      console.error('publish: unhandled error', err);
      if (!res.headersSent) {
        send(500, { 'Content-Type': 'application/json; charset=utf-8' },
          JSON.stringify({ error: 'internal_error' }) + '\n');
      }
    });
    return;
  }

  // POST /r — create a hosted rwa. Apex-only, like /publish (a share host must
  // not be able to bounce a create off it and have us mint a wrong-origin URL).
  if (req.method === 'POST' && url === '/r' && !isShareHost) {
    handleHostedCreate(req, send).catch(err => {
      console.error('hosted: create unhandled error', err);
      if (!res.headersSent) {
        send(500, { 'Content-Type': 'application/json; charset=utf-8' },
          JSON.stringify({ error: 'internal_error' }) + '\n');
      }
    });
    return;
  }

  // POST /r/:id/{modify,undo,rotate} — the authoritative hosted WRITE/lifecycle
  // endpoints. Apex-only (a share host must not be able to bounce a write off
  // it). Bearer-auth inside each handler; modify/undo run under the per-id write
  // lock (rotate too, to serialize with a /modify owner.json touch).
  if (req.method === 'POST' && !isShareHost) {
    const m = url.match(/^\/r\/([0-9a-z]{8})\/(modify|undo|rotate)$/);
    if (m) {
      const action = m[2];
      const handler = action === 'modify' ? handleHostedModify
        : action === 'undo' ? handleHostedUndo
        : handleHostedRotate;
      handler(m[1], req, send).catch(err => {
        console.error(`hosted: ${action} unhandled error`, err);
        if (!res.headersSent) {
          send(500, { 'Content-Type': 'application/json; charset=utf-8' },
            JSON.stringify({ error: 'internal_error' }) + '\n');
        }
      });
      return;
    }
  }

  // DELETE /r/:id — remove the hosted rwa subtree. Apex-only, Bearer-auth, under
  // the per-id write lock (serializes with modify/undo).
  if (req.method === 'DELETE' && !isShareHost) {
    const m = url.match(/^\/r\/([0-9a-z]{8})$/);
    if (m) {
      handleHostedDelete(m[1], req, send).catch(err => {
        console.error('hosted: delete unhandled error', err);
        if (!res.headersSent) {
          send(500, { 'Content-Type': 'application/json; charset=utf-8' },
            JSON.stringify({ error: 'internal_error' }) + '\n');
        }
      });
      return;
    }
  }

  if (req.method !== 'GET' && !isHead) {
    return send(405, { 'Allow': 'GET, HEAD, POST, DELETE', 'Content-Type': 'text/plain' }, 'method not allowed\n');
  }

  // Share host (<short>.rewritable.<tld>): serves *only* its own bytes
  // (plus robots.txt). No apex routes are reachable here — the origin must
  // stay clean of apex content so the browser's same-origin policy isolates
  // every share's structured storage. Everything else 404s.
  if (isShareHost) {
    if (url === '/robots.txt') {
      return send(200, { 'Content-Type': 'text/plain; charset=utf-8' }, ROBOTS_TXT);
    }
    if (url === '/' || url === '') {
      return serveShare(hostShort[1], send);
    }
    return send(404, { 'Content-Type': 'text/plain' }, 'not found\n');
  }

  // GET /r/:id/{describe,export,doc} — authenticated hosted reads. Apex-only
  // (the share-host branch above already returned for share origins). /r is a
  // NEW reserved prefix, disjoint from /s/.
  {
    const m = url.match(/^\/r\/([0-9a-z]{8})\/(describe|export|doc)$/);
    if (m) {
      handleHostedRead(m[1], m[2], req, send).catch(err => {
        console.error('hosted: read unhandled error', err);
        if (!res.headersSent) {
          send(500, { 'Content-Type': 'application/json; charset=utf-8' },
            JSON.stringify({ error: 'internal_error' }) + '\n');
        }
      });
      return;
    }
  }

  // GET /r/:id — the live editable web projection (current.html + injected shim).
  // Apex-only (share-host branch returned above). Synchronous: no body read, no
  // dynamic import — just template the in-memory shim into the stored bytes.
  {
    const m = url.match(/^\/r\/([0-9a-z]{8})$/);
    if (m) {
      try { return handleHostedProjection(m[1], send); }
      catch (err) {
        console.error('hosted: projection unhandled error', err);
        if (!res.headersSent) {
          send(500, { 'Content-Type': 'application/json; charset=utf-8' },
            JSON.stringify({ error: 'internal_error' }) + '\n');
        }
        return;
      }
    }
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
  if (url === '/skill.zip') {
    return send(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="rewritable-skill.zip"',
      'Content-Length': String(SKILL_ZIP.length),
      'Cache-Control': 'public, max-age=300',
    }, SKILL_ZIP);
  }
  // AI gallery. Apex-only by construction (the share-host branch already
  // returned). The page at /ai; carriers at /ai/<role>.intelligence.html.
  if (url === '/ai') {
    return send(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    }, AI_INDEX_HTML);
  }
  // The carrier TEMPLATE the AI Maker fetches, then string-replaces the three
  // markers (card + #rwa-agents zone into INLINE_DOC, role into title/FILE) to
  // assemble a signed intelligence client-side. A FRESH skill-host rewritable
  // per request (new DOC_UUID) — no-store so two assemblies never collide.
  // Explicit-before-general: matched here, ahead of the /ai/<role> carrier map.
  // Delegated to an async helper because the seed subs live in an ESM lib the
  // CJS main handler can only reach via `await import` (mirrors /publish, /r).
  if (url === '/ai/template.html') {
    handleAiTemplate(send).catch(err => {
      console.error('ai: template unhandled error', err);
      if (!res.headersSent) {
        send(500, { 'Content-Type': 'text/plain; charset=utf-8' }, 'internal_error\n');
      }
    });
    return;
  }
  if (url.startsWith('/ai/')) {
    const name = url.slice('/ai/'.length);
    const body = AI_CARRIERS.get(name);
    if (body) {
      return send(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': 'attachment; filename="' + name + '"',
        'Cache-Control': 'public, max-age=300',
      }, body);
    }
    // A miss FALLS THROUGH (not an early 404) so later tasks can add sibling
    // /ai/* routes (e.g. /ai/maker, /ai/template.html) after this block.
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

  // Legacy /s/<short> URLs (pre-2026-05-17). In production, 301 to the
  // host-keyed form so the new origin model takes effect; in local dev,
  // serve path-keyed because wildcard DNS doesn't resolve against
  // localhost. The Cache-Control on the 301 lets browsers and caches
  // store the redirect for the 24h share-expiry window.
  if (url.startsWith('/s/')) {
    const m = url.match(/^\/s\/([0-9a-z]{8})$/);
    if (!m) return send(404, { 'Content-Type': 'text/plain' }, 'not found\n');
    if (isLocalHost(reqHost)) return serveShare(m[1], send);
    const scheme = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    return send(301, {
      'Location': `${scheme}://${m[1]}.${reqHost}/`,
      'Cache-Control': 'public, max-age=86400',
    }, '');
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
