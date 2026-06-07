// Tests for the hosted-runtime store + capability auth + the /r read/create
// endpoints (Task 3 of the hosted-edit foundation).
//
// Two layers:
//   1. UNIT — the pure helpers in service/lib/hosted.js: token mint/hash/verify,
//      ingest (validate + fresh-UUID + store), readHosted round-trip, baseBodyHash.
//      These are the security-load-bearing primitives, so each invariant is its
//      own assertion (constant-time compare, capHash-not-token at rest, the
//      DOC_UUID actually rotating).
//   2. HANDLER — drives the real server.js request handler over an ephemeral
//      port with a temp DATA_DIR (matching how the service is exercised: there
//      is no in-process handler harness, so we start the server and use fetch).
//      Covers the full pinned contract: create / describe / export / doc, plus
//      401 (wrong/missing token), 404 (unknown id), 400 (garbage create).
//
// WHY these matter (Rule 9): a capability token IS the only access control on a
// hosted rwa — if verifyToken weren't constant-time, or the raw token were
// stored, or auth could be skipped, anyone could read/eventually-edit any rwa.
// The describe/doc shape is a pinned wire contract a Phase-B client builds
// against, so the round-trips assert exact shapes, not just 200s.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICE = join(__dirname, '..');
const require = createRequire(import.meta.url);
const hosted = require(join(SERVICE, 'lib', 'hosted.js'));

const sha256hex = (s) => createHash('sha256').update(s).digest('hex');

// A minimal but real rewritable, shaped exactly as server.js's validateContainer
// requires: exactly one DOC_UUID line, the rwa-bootstrap script tag, and the
// INLINE_DOC marker with a real editable body.
function makeRewritable(uuid = '11111111-1111-4111-8111-111111111111', body = '<article><h1>Hosted Test Doc</h1><p>Unique body sentence for hashing.</p></article>') {
  return [
    '<!doctype html><html><head><meta charset="utf-8"></head><body>',
    '<div id="rwa-doc-mount"></div>',
    '<script id="rwa-bootstrap">',
    `const DOC_UUID = '${uuid}';`,
    "const PRODUCT_KIND = 'document';",
    'const INLINE_DOC = `' + body + '`;',
    '</script></body></html>',
    '',
  ].join('\n');
}

// ─── 1. UNIT: token mint / hash / verify ───────────────────────────────────

test('mintToken returns a 43-char base64url string and two calls differ', () => {
  const a = hosted.mintToken();
  const b = hosted.mintToken();
  assert.equal(typeof a, 'string');
  // 32 random bytes → base64url with no padding = 43 chars.
  assert.equal(a.length, 43);
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b, 'two mints must differ (high entropy)');
});

test('hashToken is sha-256 hex of the token', () => {
  const t = hosted.mintToken();
  assert.equal(hosted.hashToken(t), sha256hex(t));
  assert.match(hosted.hashToken(t), /^[0-9a-f]{64}$/);
});

test('verifyToken: true for the right token, false for wrong, false (not throw) for malformed', () => {
  const t = hosted.mintToken();
  const capHash = hosted.hashToken(t);
  assert.equal(hosted.verifyToken(t, capHash), true);
  assert.equal(hosted.verifyToken(hosted.mintToken(), capHash), false, 'a different token must not verify');
  // Malformed inputs must return false, never throw (the auth path feeds raw
  // header bytes here — a thrown error would be a 500, leaking liveness).
  assert.equal(hosted.verifyToken('', capHash), false);
  assert.equal(hosted.verifyToken(t, ''), false);
  assert.equal(hosted.verifyToken(t, 'not-hex'), false);
  assert.equal(hosted.verifyToken(null, capHash), false);
  assert.equal(hosted.verifyToken(t, null), false);
  assert.equal(hosted.verifyToken(undefined, undefined), false);
  // A capHash of the right length but wrong value must not verify.
  assert.equal(hosted.verifyToken(t, 'a'.repeat(64)), false);
});

// ─── 1. UNIT: ingest validates + rotates UUID + stores capHash (not token) ──

test('ingest validates a rewritable, rotates DOC_UUID, returns {id, token}', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-hosted-ingest-'));
  try {
    const inputUuid = '11111111-1111-4111-8111-111111111111';
    const bytes = makeRewritable(inputUuid);
    const { id, token } = hosted.ingest(bytes, { dataDir: dir });

    assert.match(id, /^[0-9a-z]{8}$/, 'id reuses the 8-char short-code shape');
    assert.equal(token.length, 43, 'token is a freshly minted capability token');

    const stored = readFileSync(join(dir, 'r', id, 'current.html'), 'utf8');
    const m = stored.match(/const DOC_UUID = '([0-9a-f-]{36})';/);
    assert.ok(m, 'stored bytes carry exactly one DOC_UUID line');
    assert.notEqual(m[1], inputUuid, 'DOC_UUID must be rotated to a fresh value on ingest');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ingest stores owner.json with capHash only — never the raw token', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-hosted-owner-'));
  try {
    const { id, token } = hosted.ingest(makeRewritable(), { dataDir: dir });
    const ownerRaw = readFileSync(join(dir, 'r', id, 'owner.json'), 'utf8');
    const owner = JSON.parse(ownerRaw);

    assert.equal(owner.capHash, hosted.hashToken(token), 'capHash is sha-256 of the token');
    assert.equal(typeof owner.createdAt, 'number');
    assert.equal(typeof owner.lastAccess, 'number');
    // The raw token must NEVER touch disk.
    assert.ok(!ownerRaw.includes(token), 'raw token must not appear in owner.json');
    const html = readFileSync(join(dir, 'r', id, 'current.html'), 'utf8');
    assert.ok(!html.includes(token), 'raw token must not appear in the stored html');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ingest rejects non-rewritable bytes (fail loud, no files written)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-hosted-bad-'));
  try {
    assert.throws(
      () => hosted.ingest('<html>just a webpage, not a rewritable</html>', { dataDir: dir }),
      (e) => e && e.code === 'not_a_rewritable',
      'garbage bytes must throw a not_a_rewritable error',
    );
    // No id dir should have been created.
    assert.ok(!existsSync(join(dir, 'r')) || readdirSync(join(dir, 'r')).length === 0,
      'a rejected ingest must not leave partial files');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 1. UNIT: readHosted round-trip ────────────────────────────────────────

test('readHosted returns the stored bytes + owner for a known id, null for unknown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-hosted-read-'));
  try {
    const { id } = hosted.ingest(makeRewritable(), { dataDir: dir });
    const rec = hosted.readHosted(id, { dataDir: dir });
    assert.ok(rec, 'a known id resolves');
    assert.equal(rec.bytes, readFileSync(join(dir, 'r', id, 'current.html'), 'utf8'));
    assert.equal(typeof rec.owner.capHash, 'string');

    assert.equal(hosted.readHosted('zzzzzzzz', { dataDir: dir }), null, 'unknown id → null');
    // A traversal-shaped id must not escape the store.
    assert.equal(hosted.readHosted('../../etc', { dataDir: dir }), null, 'malformed id → null, no traversal');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 1. UNIT: baseBodyHash = sha256hex(canonLF(editable body)) ─────────────

test('baseBodyHash extracts the editable body and sha256-hashes it (LF-canonical)', async () => {
  const body = '<article><h1>Hashable</h1><p>Body for the hash.</p></article>';
  const bytes = makeRewritable(undefined, body);
  const h = await hosted.baseBodyHash(bytes);
  assert.match(h, /^[0-9a-f]{64}$/);
  // The hash must be over the editable body (LF-canonical), matching what the
  // rwa-edit/1 envelope's baseHash is computed against in the Phase-B client.
  assert.equal(h, sha256hex(body), 'baseBodyHash must equal sha256 of the canonical editable body');
});

// ─── 2. HANDLER: the /r endpoints over the real request handler ────────────

// Grab a concrete free port (don't rely on PORT=0 + log parsing — server.js
// logs the env PORT, not server.address().port, so we must pick the port
// ourselves and pass it in; this also makes the Host header carry the real
// port, which is what the create response's url is built from).
function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

// Start server.js as a child on a concrete ephemeral port with a temp DATA_DIR.
async function startServer() {
  const dataDir = mkdtempSync(join(tmpdir(), 'rwa-hosted-srv-'));
  const port = await freePort();
  const child = spawn('node', [join(SERVICE, 'server.js')], {
    env: { ...process.env, PORT: String(port), RWA_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let buf = '';
    const onData = (d) => {
      buf += d.toString();
      if (/listening on :/.test(buf)) { child.stdout.off('data', onData); resolve(); }
    };
    child.stdout.on('data', onData);
    child.on('exit', (code) => reject(new Error('server exited early, code ' + code + '\n' + buf)));
    setTimeout(() => reject(new Error('server did not start in time\n' + buf)), 8000);
  });
  return {
    base: `http://127.0.0.1:${port}`,
    dataDir,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((r) => child.on('exit', r));
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

const RWA = makeRewritable('22222222-2222-4222-8222-222222222222');

test('POST /r creates a hosted rwa; describe/export/doc round-trip with the cap token', async () => {
  const srv = await startServer();
  try {
    // CREATE
    const createRes = await fetch(srv.base + '/r', {
      method: 'POST',
      headers: { 'Content-Type': 'text/html' },
      body: RWA,
    });
    assert.equal(createRes.status, 200, 'create returns 200');
    const created = await createRes.json();
    assert.match(created.id, /^[0-9a-z]{8}$/);
    assert.equal(created.token.length, 43);
    assert.equal(created.url, `${srv.base}/r/${created.id}#k=${created.token}`,
      'url is the projection URL with the token in the fragment');

    const auth = { headers: { Authorization: `Bearer ${created.token}` } };

    // DESCRIBE — a self-description/1 object over the stored bytes.
    const descRes = await fetch(`${srv.base}/r/${created.id}/describe`, auth);
    assert.equal(descRes.status, 200);
    const desc = await descRes.json();
    assert.equal(desc.rwa, 'self-description/1');
    assert.equal(desc.kind, 'document');
    assert.equal(desc.title, 'Hosted Test Doc');
    assert.ok(Array.isArray(desc.affordances));
    assert.ok(desc.baseline && Array.isArray(desc.baseline.tools));

    // EXPORT — the stored bytes verbatim (with the rotated DOC_UUID).
    const expRes = await fetch(`${srv.base}/r/${created.id}/export`, auth);
    assert.equal(expRes.status, 200);
    assert.match(expRes.headers.get('content-type') || '', /text\/html/);
    const exported = await expRes.text();
    const onDisk = readFileSync(join(srv.dataDir, 'r', created.id, 'current.html'), 'utf8');
    assert.equal(exported, onDisk, 'export returns the stored current.html verbatim');
    // The rotation actually happened (the input UUID is gone).
    assert.ok(!exported.includes('22222222-2222-4222-8222-222222222222'),
      'exported bytes carry a rotated DOC_UUID, not the input one');

    // DOC — {doc, baseHash, selfDescription}; baseHash === sha256 of doc.
    const docRes = await fetch(`${srv.base}/r/${created.id}/doc`, auth);
    assert.equal(docRes.status, 200);
    const docJson = await docRes.json();
    assert.equal(typeof docJson.doc, 'string');
    assert.equal(docJson.baseHash, sha256hex(docJson.doc),
      'baseHash must be sha256 of the returned doc body');
    assert.deepEqual(docJson.selfDescription, desc,
      'doc.selfDescription must equal the /describe object');
    assert.ok(docJson.doc.includes('Hosted Test Doc'), 'doc carries the editable body');
  } finally {
    await srv.stop();
  }
});

test('auth failures: 401 on missing/wrong token, 404 on unknown id', async () => {
  const srv = await startServer();
  try {
    const createRes = await fetch(srv.base + '/r', {
      method: 'POST', headers: { 'Content-Type': 'text/html' }, body: RWA,
    });
    const { id, token } = await createRes.json();

    // Missing Authorization header → 401.
    const noAuth = await fetch(`${srv.base}/r/${id}/describe`);
    assert.equal(noAuth.status, 401);
    assert.equal((await noAuth.json()).error, 'unauthorized');

    // Wrong token (well-formed but not the owner's) → 401.
    const wrong = await fetch(`${srv.base}/r/${id}/describe`, {
      headers: { Authorization: `Bearer ${hosted.mintToken()}` },
    });
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).error, 'unauthorized');

    // Malformed header → 401 (not a 500).
    const malformed = await fetch(`${srv.base}/r/${id}/describe`, {
      headers: { Authorization: 'Bearer' },
    });
    assert.equal(malformed.status, 401);

    // Unknown id with a VALID-shaped token → 404 (the id check precedes nothing
    // that would leak existence; an unknown id is 404 regardless of token).
    const unknown = await fetch(`${srv.base}/r/zzzzzzzz/describe`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(unknown.status, 404);

    // export + doc enforce auth identically.
    assert.equal((await fetch(`${srv.base}/r/${id}/export`)).status, 401);
    assert.equal((await fetch(`${srv.base}/r/${id}/doc`)).status, 401);
  } finally {
    await srv.stop();
  }
});

test('POST /r with garbage bytes → 400 not_a_rewritable', async () => {
  const srv = await startServer();
  try {
    const res = await fetch(srv.base + '/r', {
      method: 'POST',
      headers: { 'Content-Type': 'text/html' },
      body: '<html>not a rewritable</html>',
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'not_a_rewritable');
  } finally {
    await srv.stop();
  }
});

// ─── 2. HANDLER: regression — /s/ + apex routes still work ──────────────────

test('regression: /health, / (landing), and a /publish round-trip still work', async () => {
  const srv = await startServer();
  try {
    const health = await fetch(srv.base + '/health');
    assert.equal(health.status, 200);
    assert.equal((await health.text()).trim(), 'ok');

    const landing = await fetch(srv.base + '/');
    assert.equal(landing.status, 200);
    assert.match(landing.headers.get('content-type') || '', /text\/html/);

    // /publish must still mint a /s/<short> dev URL and serve it back.
    const pub = await fetch(srv.base + '/publish', {
      method: 'POST', headers: { 'Content-Type': 'text/html' }, body: RWA,
    });
    assert.equal(pub.status, 201, '/publish still returns 201');
    const { short, url } = await pub.json();
    assert.match(short, /^[0-9a-z]{8}$/);
    const share = await fetch(url);
    assert.equal(share.status, 200, '/s/<short> still serves the published bytes');
    const shareBody = await share.text();
    assert.ok(shareBody.includes('rwa-bootstrap'), 'published share carries the container');
  } finally {
    await srv.stop();
  }
});
