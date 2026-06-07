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
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import http from 'node:http';

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
async function startServer(extraEnv = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'rwa-hosted-srv-'));
  const port = await freePort();
  const child = spawn('node', [join(SERVICE, 'server.js')], {
    env: { ...process.env, PORT: String(port), RWA_DATA_DIR: dataDir, ...extraEnv },
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

// ─── 2. HANDLER: POST /r/:id/modify — the authoritative write endpoint ──────
//
// WHY these matter (Rule 9): /modify is the SINGLE deterministic, model-free,
// audited write path for a hosted rwa. The contract a Phase-B client builds
// against is pinned: optimistic concurrency via baseHash (409 on stale, NO
// write), the frozen-zone wall holding server-side (4xx, NO write), a per-id
// write lock that serializes concurrent writes (no lost update), byte-parity
// with the local seed/CLI apply (one contract, one more door), and a durable
// forward audit log (history.jsonl). Each is its own assertion.

const { applyPlan } = await import(join(SERVICE, 'lib', 'edit.mjs'));
const { replaceInlineDoc } = await import(join(SERVICE, 'lib', 'seed.mjs'));

// Create a hosted rwa and return {id, token, doc, baseHash} fetched from /doc.
async function createAndRead(base, rwa) {
  const createRes = await fetch(base + '/r', {
    method: 'POST', headers: { 'Content-Type': 'text/html' }, body: rwa,
  });
  assert.equal(createRes.status, 200, 'create returns 200');
  const { id, token } = await createRes.json();
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const docRes = await fetch(`${base}/r/${id}/doc`, auth);
  assert.equal(docRes.status, 200);
  const { doc, baseHash } = await docRes.json();
  return { id, token, doc, baseHash, auth };
}

function postModify(base, id, token, payload) {
  return fetch(`${base}/r/${id}/modify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

const MODIFY_BODY = '<article><h1>Old Title</h1><p>Some unique body text here.</p></article>';
const MODIFY_RWA = makeRewritable('33333333-3333-4333-8333-333333333333', MODIFY_BODY);
const SIMPLE_EDIT = { version: 'rwa-edit/1', edits: [{ find: 'Old Title', replace: 'New Title' }] };

test('POST /r/:id/modify applies an apply_edits envelope; persists; returns the pinned shape', async () => {
  const srv = await startServer();
  try {
    const { id, token, doc, baseHash } = await createAndRead(srv.base, MODIFY_RWA);
    assert.ok(doc.includes('Old Title'), 'starting body has the anchor');

    const res = await postModify(srv.base, id, token, {
      envelope: SIMPLE_EDIT, baseHash, actor: 'web:test',
    });
    assert.equal(res.status, 200, 'a valid modify returns 200');
    const out = await res.json();

    // Pinned response shape: {doc, baseHash, selfDescription, histLen, undoLen}.
    assert.equal(typeof out.doc, 'string');
    assert.ok(out.doc.includes('New Title'), 'returned doc reflects the edit');
    assert.ok(!out.doc.includes('Old Title'), 'old anchor is gone');
    assert.equal(out.baseHash, sha256hex(out.doc),
      'returned baseHash must be sha256 of the new doc (so the client can chain)');
    assert.notEqual(out.baseHash, baseHash, 'the hash advanced');
    assert.equal(out.selfDescription.rwa, 'self-description/1');
    assert.equal(out.histLen, 1, 'first commit → histLen 1 (forward-audit count)');
    assert.equal(out.undoLen, 1, 'first commit → undoLen 1 (undo-stack depth)');

    // Persistence: /export must show the edit in the stored bytes.
    const exp = await fetch(`${srv.base}/r/${id}/export`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const exported = await exp.text();
    assert.ok(exported.includes('New Title'), 'stored bytes carry the edit');
    assert.ok(!exported.includes('Old Title'), 'stored bytes no longer have the old anchor');

    // /doc now reports the new baseHash too (the client could re-read instead of
    // chaining from the modify response).
    const docRes = await fetch(`${srv.base}/r/${id}/doc`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const docJson = await docRes.json();
    assert.equal(docJson.baseHash, out.baseHash, '/doc and /modify agree on the new baseHash');
  } finally {
    await srv.stop();
  }
});

test('byte-parity: /modify result equals the local seed/CLI apply of the same envelope', async () => {
  const srv = await startServer();
  try {
    const { id, token, baseHash } = await createAndRead(srv.base, MODIFY_RWA);

    // Apply the SAME envelope to a local copy of the SAME starting bytes using
    // the vendored applyPlan, then compare editable bodies. This is the "one
    // contract, one more door" guarantee: the hosted door produces identical
    // bytes to the local file door.
    const localDir = mkdtempSync(join(tmpdir(), 'rwa-modify-parity-'));
    try {
      // The hosted copy rotated DOC_UUID at ingest, but the editable body is
      // unchanged — so we compare BODIES, not whole files. Start the local copy
      // from the exact stored bytes so the splice path is identical.
      const stored = readFileSync(join(srv.dataDir, 'r', id, 'current.html'), 'utf8');
      const localPath = join(localDir, 'local.html');
      writeFileSync(localPath, stored, 'utf8');
      const localRes = await applyPlan(localPath, structuredClone(SIMPLE_EDIT));
      assert.equal(localRes.exitCode, 0);
      const localBytes = readFileSync(localPath, 'utf8');

      const res = await postModify(srv.base, id, token, { envelope: SIMPLE_EDIT, baseHash });
      assert.equal(res.status, 200);
      const out = await res.json();

      const hostedBytes = readFileSync(join(srv.dataDir, 'r', id, 'current.html'), 'utf8');
      assert.equal(hostedBytes, localBytes,
        'hosted /modify produced byte-identical container to the local applyPlan');
      // And the returned doc body equals the local editable body (LF-canonical).
      const { extractInlineDoc } = await import(join(SERVICE, 'lib', 'seed.mjs'));
      const localBody = hosted.canonLF(extractInlineDoc(localBytes));
      assert.equal(out.doc, localBody, 'returned doc equals the local apply body');
    } finally {
      rmSync(localDir, { recursive: true, force: true });
    }
  } finally {
    await srv.stop();
  }
});

test('stale baseHash → 409 stale_base, NO write', async () => {
  const srv = await startServer();
  try {
    const { id, token, baseHash } = await createAndRead(srv.base, MODIFY_RWA);

    const res = await postModify(srv.base, id, token, {
      envelope: SIMPLE_EDIT,
      baseHash: 'f'.repeat(64), // well-formed but wrong
    });
    assert.equal(res.status, 409, 'a stale baseHash is a 409');
    const out = await res.json();
    assert.equal(out.error, 'stale_base');
    assert.equal(out.currentHash, baseHash, '409 reports the actual current hash');

    // No write: /export still shows the original body.
    const exp = await fetch(`${srv.base}/r/${id}/export`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const exported = await exp.text();
    assert.ok(exported.includes('Old Title'), 'stale modify left the bytes UNCHANGED');
    assert.ok(!exported.includes('New Title'));

    // No history record was written.
    assert.ok(!existsSync(join(srv.dataDir, 'r', id, 'history.jsonl')),
      'a rejected (stale) modify writes no history');
  } finally {
    await srv.stop();
  }
});

test('frozen-zone-violating envelope → 4xx frozen_zone_violation, NO write', async () => {
  const srv = await startServer();
  try {
    // A rewritable whose body carries a marker-form frozen zone.
    const frozenBody =
      '<article>a<!-- rwa:frozen:begin lock --><h2>locked</h2><!-- rwa:frozen:end lock -->z</article>';
    const rwa = makeRewritable('44444444-4444-4444-8444-444444444444', frozenBody);
    const { id, token, baseHash } = await createAndRead(srv.base, rwa);

    // replace_document escape hatch attempting to drift the frozen zone.
    const envelope = {
      version: 'rwa-edit/1',
      doc: '<article>a<!-- rwa:frozen:begin lock --><h2>tampered</h2><!-- rwa:frozen:end lock -->z</article>',
      reason: 'attempt to drift a frozen zone server-side',
    };
    const res = await postModify(srv.base, id, token, { envelope, baseHash });
    assert.ok(res.status >= 400 && res.status < 500, 'apply failure is a 4xx');
    assert.equal(res.status, 422, 'envelope/apply failure uses 422');
    const out = await res.json();
    assert.equal(out.error, 'frozen_zone_violation',
      'the frozen wall holds server-side with the right subcode');

    // No write: the frozen content is intact in the stored bytes.
    const exp = await fetch(`${srv.base}/r/${id}/export`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const exported = await exp.text();
    assert.ok(exported.includes('<h2>locked</h2>'), 'frozen content unchanged');
    assert.ok(!exported.includes('<h2>tampered</h2>'));
    assert.ok(!existsSync(join(srv.dataDir, 'r', id, 'history.jsonl')),
      'a rejected (frozen) modify writes no history');
  } finally {
    await srv.stop();
  }
});

test('modify auth + bad-request: 401 / 404 / 400', async () => {
  const srv = await startServer();
  try {
    const { id, token, baseHash } = await createAndRead(srv.base, MODIFY_RWA);
    const goodBody = JSON.stringify({ envelope: SIMPLE_EDIT, baseHash });

    // Missing token → 401, NO write.
    const noAuth = await fetch(`${srv.base}/r/${id}/modify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: goodBody,
    });
    assert.equal(noAuth.status, 401);
    assert.equal((await noAuth.json()).error, 'unauthorized');

    // Wrong token → 401.
    const wrong = await fetch(`${srv.base}/r/${id}/modify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hosted.mintToken()}` },
      body: goodBody,
    });
    assert.equal(wrong.status, 401);

    // Unknown id (valid-shaped token) → 404.
    const unknown = await fetch(`${srv.base}/r/zzzzzzzz/modify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: goodBody,
    });
    assert.equal(unknown.status, 404);

    // Missing baseHash → 400 bad_request.
    const noBase = await postModify(srv.base, id, token, { envelope: SIMPLE_EDIT });
    assert.equal(noBase.status, 400);
    assert.equal((await noBase.json()).error, 'bad_request');

    // Garbage (non-JSON) body → 400 bad_request.
    const garbage = await fetch(`${srv.base}/r/${id}/modify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: 'this is not json {',
    });
    assert.equal(garbage.status, 400);
    assert.equal((await garbage.json()).error, 'bad_request');

    // Missing envelope → 400 bad_request.
    const noEnv = await postModify(srv.base, id, token, { baseHash });
    assert.equal(noEnv.status, 400);

    // Through all of that: NO write happened.
    const exp = await fetch(`${srv.base}/r/${id}/export`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.ok((await exp.text()).includes('Old Title'), 'no failed modify wrote anything');
  } finally {
    await srv.stop();
  }
});

test('concurrency: two simultaneous /modify for one id serialize — no lost update', async () => {
  const srv = await startServer();
  try {
    const { id, token, baseHash } = await createAndRead(srv.base, MODIFY_RWA);

    // Both fire with the SAME (current) baseHash. The per-id lock serializes
    // them: the first to acquire applies; the second, now seeing the first's
    // result as the current state, must EITHER 409 (its base is now stale) or —
    // if its edit is still anchor-valid against the new state — apply. With a
    // find/replace whose anchor 'Old Title' is consumed by the first apply, the
    // second is guaranteed stale → 409. Either way: no corruption, no lost
    // update; exactly one body change lands.
    const editA = { version: 'rwa-edit/1', edits: [{ find: 'Old Title', replace: 'Title A' }] };
    const editB = { version: 'rwa-edit/1', edits: [{ find: 'Old Title', replace: 'Title B' }] };

    const [rA, rB] = await Promise.all([
      postModify(srv.base, id, token, { envelope: editA, baseHash, actor: 'A' }),
      postModify(srv.base, id, token, { envelope: editB, baseHash, actor: 'B' }),
    ]);
    const statuses = [rA.status, rB.status].sort();
    assert.deepEqual(statuses, [200, 409],
      'exactly one applies (200), the other sees stale base (409) — serialized, no lost update');

    // The stored bytes are a clean single application of whichever won — never a
    // mangled interleave.
    const exp = await fetch(`${srv.base}/r/${id}/export`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const exported = await exp.text();
    assert.ok(!exported.includes('Old Title'), 'the old anchor was consumed exactly once');
    const hasA = exported.includes('Title A');
    const hasB = exported.includes('Title B');
    assert.ok(hasA !== hasB, 'exactly one winner is present, not both (no interleave)');

    // History reflects exactly one successful commit.
    const histPath = join(srv.dataDir, 'r', id, 'history.jsonl');
    const lines = readFileSync(histPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'exactly one history record for one successful apply');
  } finally {
    await srv.stop();
  }
});

test('history.jsonl: two successful edits → two parseable forward records, actor-attributed', async () => {
  const srv = await startServer();
  try {
    const { id, token, baseHash: h0, doc: doc0 } = await createAndRead(srv.base, MODIFY_RWA);

    // First edit.
    const r1 = await postModify(srv.base, id, token, {
      envelope: { version: 'rwa-edit/1', edits: [{ find: 'Old Title', replace: 'Title One' }] },
      baseHash: h0, actor: 'web:alice',
    });
    assert.equal(r1.status, 200);
    const o1 = await r1.json();
    assert.equal(o1.histLen, 1);

    // Second edit, chaining off the first's returned baseHash.
    const r2 = await postModify(srv.base, id, token, {
      envelope: { version: 'rwa-edit/1', edits: [{ find: 'Title One', replace: 'Title Two' }] },
      baseHash: o1.baseHash, actor: 'web:bob',
    });
    assert.equal(r2.status, 200);
    const o2 = await r2.json();
    assert.equal(o2.histLen, 2);

    const histPath = join(srv.dataDir, 'r', id, 'history.jsonl');
    const lines = readFileSync(histPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 2, 'two forward records, one per line');

    const recs = lines.map((l) => JSON.parse(l));
    assert.equal(recs[0].actor, 'web:alice');
    assert.equal(recs[1].actor, 'web:bob');
    for (const rec of recs) {
      assert.equal(typeof rec.ts, 'number');
      assert.equal(rec.kind, 'edit_batch', 'apply_edits records as edit_batch');
      assert.match(rec.baseHash, /^[0-9a-f]{64}$/);
      assert.match(rec.resultHash, /^[0-9a-f]{64}$/);
      assert.ok(rec.envelope, 'the forward envelope is recorded');
    }
    // The chain is consistent: rec[0].baseHash is the original, rec[1].baseHash
    // is rec[0].resultHash (forward audit chain).
    assert.equal(recs[0].baseHash, sha256hex(doc0));
    assert.equal(recs[1].baseHash, recs[0].resultHash, 'forward audit chain links');
    assert.equal(recs[1].resultHash, o2.baseHash);

    // A replace_document envelope records kind:'replace_document' with reason.
    const r3 = await postModify(srv.base, id, token, {
      envelope: {
        version: 'rwa-edit/1',
        doc: '<article><h1>Replaced Whole</h1><p>New body.</p></article>',
        reason: 'wholesale replace test',
      },
      baseHash: o2.baseHash, actor: 'web:carol',
    });
    assert.equal(r3.status, 200);
    const o3 = await r3.json();
    assert.equal(o3.histLen, 3);
    const recs3 = readFileSync(histPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(recs3[2].kind, 'replace_document');
    assert.equal(recs3[2].reason, 'wholesale replace test');
    assert.equal(recs3[2].actor, 'web:carol');
  } finally {
    await srv.stop();
  }
});

test('modify with no actor defaults to web:anon in history', async () => {
  const srv = await startServer();
  try {
    const { id, token, baseHash } = await createAndRead(srv.base, MODIFY_RWA);
    const res = await postModify(srv.base, id, token, { envelope: SIMPLE_EDIT, baseHash });
    assert.equal(res.status, 200);
    const histPath = join(srv.dataDir, 'r', id, 'history.jsonl');
    const rec = JSON.parse(readFileSync(histPath, 'utf8').trim().split('\n')[0]);
    assert.equal(rec.actor, 'web:anon', 'absent actor defaults to web:anon');
  } finally {
    await srv.stop();
  }
});

// ─── history kind mirrors the COMPILED tool shape (review Fix 1) ─────────────
//
// WHY this matters (Rule 9): `rwa_hist.kind` is a RESERVED, cross-surface
// vocabulary — only `edit_batch` / `replace_document` (CLAUDE.md "Reserved
// namespaces"), and the DSL spec §5 mandates the audit log records the COMPILED
// form, not the wire form. A raw `apply_dsl_plan` whose sole op is a
// `replace_document` escape compiles (via compileDslPlan) to a
// `replace_document` envelope; the substrate/seed records that as
// kind:'replace_document'. If the hosted log instead keyed off the raw envelope
// shape (ops-shaped → edit_batch) the hosted audit trail would DISAGREE with the
// substrate for the identical operation. These cases pin kind to the compiled
// tool across all four wire shapes.

const DSL_ESCAPE_PLAN = {
  version: 'rwa-edit-dsl/1',
  ops: [{
    op: 'replace_document',
    doc: '<article><h1>DSL Escaped</h1><p>Wholesale replace via the DSL escape op.</p></article>',
    reason: 'irregular structural change — escape via DSL replace_document op',
  }],
};
const DSL_EDITS_PLAN = {
  version: 'rwa-edit-dsl/1',
  ops: [{ op: 'replace', find: 'Old Title', replace: 'DSL Edit Title' }],
};

test('history kind: a raw apply_dsl_plan that compiles to a replace_document escape → replace_document', async () => {
  const srv = await startServer();
  try {
    const { id, token, baseHash } = await createAndRead(srv.base, MODIFY_RWA);
    // The wire envelope is ops-shaped (apply_dsl_plan). The naive raw-shape
    // heuristic would record edit_batch; the compiled tool is replace_document.
    const res = await postModify(srv.base, id, token, {
      envelope: DSL_ESCAPE_PLAN, baseHash, actor: 'web:dsl',
    });
    assert.equal(res.status, 200, 'the DSL escape plan applies');
    const histPath = join(srv.dataDir, 'r', id, 'history.jsonl');
    const rec = JSON.parse(readFileSync(histPath, 'utf8').trim().split('\n')[0]);
    assert.equal(rec.kind, 'replace_document',
      'a DSL escape op records the COMPILED tool (replace_document), not the raw ops shape');
    assert.equal(rec.reason, DSL_ESCAPE_PLAN.ops[0].reason,
      'a replace_document record carries the compiled reason');
  } finally {
    await srv.stop();
  }
});

test('history kind: a raw apply_dsl_plan that compiles to apply_edits → edit_batch', async () => {
  const srv = await startServer();
  try {
    const { id, token, baseHash } = await createAndRead(srv.base, MODIFY_RWA);
    const res = await postModify(srv.base, id, token, {
      envelope: DSL_EDITS_PLAN, baseHash, actor: 'web:dsl',
    });
    assert.equal(res.status, 200, 'the DSL edit plan applies');
    const histPath = join(srv.dataDir, 'r', id, 'history.jsonl');
    const rec = JSON.parse(readFileSync(histPath, 'utf8').trim().split('\n')[0]);
    assert.equal(rec.kind, 'edit_batch',
      'a DSL plan that compiles to apply_edits records as edit_batch');
    assert.ok(rec.envelope, 'the forward envelope is recorded for an edit_batch');
  } finally {
    await srv.stop();
  }
});

// (raw apply_edits → edit_batch and raw replace_document → replace_document are
// already pinned by the "two successful edits"/r3 test above.)

// ─── actor length cap (review Fix 2) ────────────────────────────────────────
//
// WHY this matters (Rule 12 fail loud): actor is taken verbatim from the request
// body into the durable audit log. An unbounded / newline-bearing actor would
// let a client bloat or corrupt the JSONL audit trail (a newline forges a record
// boundary). Cap at 128 chars and reject newlines with 400 bad_request — no
// write — rather than silently truncating.

test('modify rejects an over-long actor (>128 chars) with 400, NO write', async () => {
  const srv = await startServer();
  try {
    const { id, token, baseHash } = await createAndRead(srv.base, MODIFY_RWA);
    const res = await postModify(srv.base, id, token, {
      envelope: SIMPLE_EDIT, baseHash, actor: 'x'.repeat(129),
    });
    assert.equal(res.status, 400, 'an actor longer than 128 chars is rejected');
    assert.equal((await res.json()).error, 'bad_request');
    // No write: history was never created, bytes unchanged.
    assert.ok(!existsSync(join(srv.dataDir, 'r', id, 'history.jsonl')),
      'a rejected (over-long actor) modify writes no history');
    const exp = await fetch(`${srv.base}/r/${id}/export`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.ok((await exp.text()).includes('Old Title'), 'over-long-actor modify left bytes unchanged');
  } finally {
    await srv.stop();
  }
});

test('modify rejects an actor containing a newline with 400', async () => {
  const srv = await startServer();
  try {
    const { id, token, baseHash } = await createAndRead(srv.base, MODIFY_RWA);
    const res = await postModify(srv.base, id, token, {
      envelope: SIMPLE_EDIT, baseHash, actor: 'web:evil\nforged record boundary',
    });
    assert.equal(res.status, 400, 'a newline in actor is rejected (audit-log integrity)');
    assert.equal((await res.json()).error, 'bad_request');
  } finally {
    await srv.stop();
  }
});

test('modify accepts an actor of exactly 128 chars (boundary)', async () => {
  const srv = await startServer();
  try {
    const { id, token, baseHash } = await createAndRead(srv.base, MODIFY_RWA);
    const actor = 'a'.repeat(128);
    const res = await postModify(srv.base, id, token, { envelope: SIMPLE_EDIT, baseHash, actor });
    assert.equal(res.status, 200, 'exactly 128 chars is accepted (the cap is inclusive)');
    const histPath = join(srv.dataDir, 'r', id, 'history.jsonl');
    const rec = JSON.parse(readFileSync(histPath, 'utf8').trim().split('\n')[0]);
    assert.equal(rec.actor, actor, 'a 128-char actor is recorded verbatim');
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

// ─── 3. LIFECYCLE: undo / rotate / delete / 90d sweep / per-token rate limit ──
//
// WHY these matter (Rule 9): these four endpoints + the sweep round out the
// hosted lifecycle. The load-bearing invariants each get their own assertion:
//   - undo is CRASH-SAFE — it restores from a PRE-IMAGE written before the
//     /modify rename, NOT by replaying the forward history.jsonl (which can be
//     one record ahead of current.html and stores only `reason` for a
//     replace_document, so it can't rebuild bytes). The crash-safety test
//     truncates the last history line and confirms undo still restores.
//   - undo is COMPOSABLE down to the original ingested state and 409s when empty.
//   - rotate invalidates the old token (the cap IS the access control).
//   - delete removes the subtree; every later op 404s.
//   - the 90d sweep removes idle hosted dirs but NEVER touches /s/ shares.
//   - the per-token rate limit caps writes per cap independently of the per-IP
//     limit, keyed by capHash (never the raw token).

// Helper: do one successful modify (find→replace) and return the new baseHash.
async function modifyOnce(base, id, token, find, replace, baseHash) {
  const res = await postModify(base, id, token, {
    envelope: { version: 'rwa-edit/1', edits: [{ find, replace }] }, baseHash,
  });
  assert.equal(res.status, 200, `modify ${find}→${replace} should apply`);
  return (await res.json()).baseHash;
}

function postUndo(base, id, token) {
  return fetch(`${base}/r/${id}/undo`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

test('POST /r/:id/undo restores the pre-edit body (single undo)', async () => {
  const srv = await startServer();
  try {
    const { id, token, doc: doc0, baseHash } = await createAndRead(srv.base, MODIFY_RWA);
    assert.ok(doc0.includes('Old Title'));

    await modifyOnce(srv.base, id, token, 'Old Title', 'New Title', baseHash);

    // /export confirms the edit landed.
    let exported = await (await fetch(`${srv.base}/r/${id}/export`, { headers: { Authorization: `Bearer ${token}` } })).text();
    assert.ok(exported.includes('New Title') && !exported.includes('Old Title'));

    const u = await postUndo(srv.base, id, token);
    assert.equal(u.status, 200, 'undo of one edit returns 200');
    const out = await u.json();
    // Pinned undo shape: {doc, baseHash, selfDescription, histLen, undoLen}.
    assert.equal(typeof out.doc, 'string');
    assert.ok(out.doc.includes('Old Title'), 'undo restored the pre-edit body');
    assert.ok(!out.doc.includes('New Title'));
    assert.equal(out.doc, doc0, 'undo restores the exact original body');
    assert.equal(out.baseHash, sha256hex(out.doc), 'undo baseHash is sha256 of the restored doc');
    assert.equal(out.baseHash, baseHash, 'restored baseHash equals the original');
    assert.equal(out.selfDescription.rwa, 'self-description/1');
    // histLen is the forward-audit count — undo does NOT mutate history.jsonl, so
    // after undoing the only edit it stays 1 (the one forward record), while the
    // undo-stack depth drops to 0.
    assert.equal(out.histLen, 1, 'undo leaves the forward-audit count at 1 (history.jsonl unchanged)');
    assert.equal(out.undoLen, 0, 'after undoing the only edit, undo-stack depth is 0');

    // Persistence: the stored bytes reflect the restore.
    exported = await (await fetch(`${srv.base}/r/${id}/export`, { headers: { Authorization: `Bearer ${token}` } })).text();
    assert.ok(exported.includes('Old Title') && !exported.includes('New Title'),
      'undo persisted the restored bytes');
  } finally {
    await srv.stop();
  }
});

test('undo is composable: undo N edits walks back to the original ingested state', async () => {
  const srv = await startServer();
  try {
    const { id, token, doc: doc0, baseHash: h0 } = await createAndRead(srv.base, MODIFY_RWA);

    const h1 = await modifyOnce(srv.base, id, token, 'Old Title', 'Title A', h0);
    const h2 = await modifyOnce(srv.base, id, token, 'Title A', 'Title B', h1);
    const h3 = await modifyOnce(srv.base, id, token, 'Title B', 'Title C', h2);

    const exported = await (await fetch(`${srv.base}/r/${id}/export`, { headers: { Authorization: `Bearer ${token}` } })).text();
    assert.ok(exported.includes('Title C'), 'three edits landed');

    // Undo three times: C→B→A→Old. The forward-audit count (histLen) stays at 3
    // throughout — undo never mutates history.jsonl — while the undo-stack depth
    // (undoLen) walks 2→1→0.
    const u3 = await (await postUndo(srv.base, id, token)).json();      // back to Title B
    assert.ok(u3.doc.includes('Title B'));
    assert.equal(u3.histLen, 3, 'forward-audit count unchanged by undo');
    assert.equal(u3.undoLen, 2);
    const u2 = await (await postUndo(srv.base, id, token)).json();      // back to Title A
    assert.ok(u2.doc.includes('Title A'));
    assert.equal(u2.histLen, 3, 'forward-audit count unchanged by undo');
    assert.equal(u2.undoLen, 1);
    const u1 = await (await postUndo(srv.base, id, token)).json();      // back to Old Title
    assert.equal(u1.doc, doc0, 'composing all undos restores the original ingested body');
    assert.equal(u1.baseHash, h0);
    assert.equal(u1.histLen, 3, 'forward-audit count unchanged by undo');
    assert.equal(u1.undoLen, 0);

    // One more undo with an empty stack → 409 nothing_to_undo.
    const empty = await postUndo(srv.base, id, token);
    assert.equal(empty.status, 409);
    assert.equal((await empty.json()).error, 'nothing_to_undo');
  } finally {
    await srv.stop();
  }
});

// WHY this matters (Rule 9): histLen (forward-audit count) and undoLen (undo-stack
// depth) DIVERGE the moment any undo happens — undo restores a pre-image but never
// rewinds the append-only forward audit. Before the fix both fields were called
// `histLen` but meant different things across /modify (forward count) and /undo
// (stack depth), so a client couldn't read one field consistently. This test
// proves the two are now independent + correct on BOTH endpoints: modify×2 → undo
// → modify yields histLen===3 (three forward commits) and undoLen===2 (two
// undoable pre-images on the stack). If a future change re-conflated them, this
// fails.
test('histLen vs undoLen diverge correctly: modify×2 → undo → modify ⇒ histLen=3, undoLen=2', async () => {
  const srv = await startServer();
  try {
    const { id, token, baseHash: h0 } = await createAndRead(srv.base, MODIFY_RWA);

    // modify #1 — forward count 1, undo depth 1.
    const r1 = await postModify(srv.base, id, token, {
      envelope: { version: 'rwa-edit/1', edits: [{ find: 'Old Title', replace: 'Title A' }] },
      baseHash: h0,
    });
    const o1 = await r1.json();
    assert.equal(o1.histLen, 1);
    assert.equal(o1.undoLen, 1);

    // modify #2 — forward count 2, undo depth 2.
    const r2 = await postModify(srv.base, id, token, {
      envelope: { version: 'rwa-edit/1', edits: [{ find: 'Title A', replace: 'Title B' }] },
      baseHash: o1.baseHash,
    });
    const o2 = await r2.json();
    assert.equal(o2.histLen, 2);
    assert.equal(o2.undoLen, 2);

    // undo ×1 — forward count UNCHANGED at 2 (history.jsonl is append-only),
    // undo depth drops to 1. The two fields have now diverged.
    const ur = await postUndo(srv.base, id, token);
    const uo = await ur.json();
    assert.equal(uo.histLen, 2, '/undo reports the forward-audit count, NOT the undo depth');
    assert.equal(uo.undoLen, 1, '/undo reports the remaining undo depth');
    assert.notEqual(uo.histLen, uo.undoLen, 'the two fields are independent post-undo');
    assert.ok(uo.doc.includes('Title A'), 'undo restored the prior body');

    // modify #3 (chaining off the undo-restored baseHash) — forward count 3,
    // undo depth back to 2. The headline divergence assertion.
    const r3 = await postModify(srv.base, id, token, {
      envelope: { version: 'rwa-edit/1', edits: [{ find: 'Title A', replace: 'Title C' }] },
      baseHash: uo.baseHash,
    });
    const o3 = await r3.json();
    assert.equal(o3.histLen, 3, 'three forward commits recorded (2 + the post-undo one)');
    assert.equal(o3.undoLen, 2, 'two undoable pre-images on the stack (depth 1 + the new push)');
    assert.notEqual(o3.histLen, o3.undoLen,
      'histLen and undoLen are now unambiguous + independent across /modify and /undo');
  } finally {
    await srv.stop();
  }
});

test('undo with no prior edits → 409 nothing_to_undo (fresh ingest)', async () => {
  const srv = await startServer();
  try {
    const { id, token } = await createAndRead(srv.base, MODIFY_RWA);
    const res = await postUndo(srv.base, id, token);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, 'nothing_to_undo');
  } finally {
    await srv.stop();
  }
});

test('undo auth: 401 on missing/wrong token, 404 on unknown id', async () => {
  const srv = await startServer();
  try {
    const { id, token, baseHash } = await createAndRead(srv.base, MODIFY_RWA);
    await modifyOnce(srv.base, id, token, 'Old Title', 'New Title', baseHash);

    const noAuth = await fetch(`${srv.base}/r/${id}/undo`, { method: 'POST' });
    assert.equal(noAuth.status, 401);
    const wrong = await fetch(`${srv.base}/r/${id}/undo`, {
      method: 'POST', headers: { Authorization: `Bearer ${hosted.mintToken()}` },
    });
    assert.equal(wrong.status, 401);
    const unknown = await fetch(`${srv.base}/r/zzzzzzzz/undo`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(unknown.status, 404);

    // The pre-image is still intact: a valid undo still works after the failures.
    const ok = await postUndo(srv.base, id, token);
    assert.equal(ok.status, 200);
  } finally {
    await srv.stop();
  }
});

test('undo is crash-safe: a truncated last history.jsonl line does NOT break undo', async () => {
  // The crash-safety guarantee: undo restores from the PRE-IMAGE stack, never by
  // replaying history.jsonl. We simulate the documented crash window (history one
  // record ahead / a torn final line) by corrupting the last history line, then
  // assert undo STILL restores the correct pre-edit bytes.
  const srv = await startServer();
  try {
    const { id, token, doc: doc0, baseHash } = await createAndRead(srv.base, MODIFY_RWA);
    await modifyOnce(srv.base, id, token, 'Old Title', 'New Title', baseHash);

    // Corrupt the forward log: truncate its last line to half-written garbage.
    const histPath = join(srv.dataDir, 'r', id, 'history.jsonl');
    const raw = readFileSync(histPath, 'utf8');
    writeFileSync(histPath, raw.slice(0, Math.max(1, raw.length - 12)) + '{"ts":12', 'utf8');

    // Undo must STILL work — it reads the pre-image, not the (now corrupt) log.
    const u = await postUndo(srv.base, id, token);
    assert.equal(u.status, 200, 'undo works despite a corrupt history.jsonl');
    const out = await u.json();
    assert.equal(out.doc, doc0, 'undo restored the original body from the pre-image, not the log');
  } finally {
    await srv.stop();
  }
});

test('undo crash-safety: pre-image is written BEFORE the modify rename (durable independent of history)', () => {
  // White-box: a successful modify must leave a pre-image file on disk that is a
  // byte-copy of the PRIOR current.html — proving the undo state exists
  // independent of history.jsonl. We drive the pure store directly.
  const dir = mkdtempSync(join(tmpdir(), 'rwa-undo-preimage-'));
  try {
    const { id } = hosted.ingest(MODIFY_RWA, { dataDir: dir });
    const before = readFileSync(join(dir, 'r', id, 'current.html'), 'utf8');

    // pushUndo must durably persist `before` to the undo stack.
    hosted.pushUndo(id, { dataDir: dir }, before);
    assert.equal(hosted.undoLen(id, { dataDir: dir }), 1, 'one pre-image on the stack');

    // popUndo returns the exact prior bytes and decrements the stack.
    const restored = hosted.popUndo(id, { dataDir: dir });
    assert.equal(restored, before, 'popUndo returns the exact pre-image bytes');
    assert.equal(hosted.undoLen(id, { dataDir: dir }), 0, 'stack emptied after pop');
    // Empty stack → null (the caller maps that to 409 nothing_to_undo).
    assert.equal(hosted.popUndo(id, { dataDir: dir }), null, 'pop on an empty stack returns null');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── rotate ──────────────────────────────────────────────────────────────────

test('POST /r/:id/rotate mints a new token; the OLD token now 401s', async () => {
  const srv = await startServer();
  try {
    const { id, token: oldToken } = await createAndRead(srv.base, MODIFY_RWA);

    // Old token works before rotation.
    assert.equal((await fetch(`${srv.base}/r/${id}/describe`, { headers: { Authorization: `Bearer ${oldToken}` } })).status, 200);

    const rot = await fetch(`${srv.base}/r/${id}/rotate`, {
      method: 'POST', headers: { Authorization: `Bearer ${oldToken}` },
    });
    assert.equal(rot.status, 200, 'rotate returns 200 with the new token');
    const { token: newToken } = await rot.json();
    assert.equal(typeof newToken, 'string');
    assert.equal(newToken.length, 43, 'new token is a fresh 43-char cap');
    assert.notEqual(newToken, oldToken, 'the token actually changed');

    // OLD token → 401 on every op.
    assert.equal((await fetch(`${srv.base}/r/${id}/describe`, { headers: { Authorization: `Bearer ${oldToken}` } })).status, 401);
    assert.equal((await fetch(`${srv.base}/r/${id}/export`, { headers: { Authorization: `Bearer ${oldToken}` } })).status, 401);
    // NEW token → 200.
    assert.equal((await fetch(`${srv.base}/r/${id}/describe`, { headers: { Authorization: `Bearer ${newToken}` } })).status, 200);

    // owner.json stores only the NEW capHash, never either raw token.
    const owner = JSON.parse(readFileSync(join(srv.dataDir, 'r', id, 'owner.json'), 'utf8'));
    assert.equal(owner.capHash, sha256hex(newToken), 'owner.json carries the new capHash');
    assert.notEqual(owner.capHash, sha256hex(oldToken));
    assert.ok(!JSON.stringify(owner).includes(newToken), 'owner.json never stores the raw token');
  } finally {
    await srv.stop();
  }
});

test('rotate auth: 401 on wrong token, 404 on unknown id', async () => {
  const srv = await startServer();
  try {
    const { id, token } = await createAndRead(srv.base, MODIFY_RWA);
    const wrong = await fetch(`${srv.base}/r/${id}/rotate`, {
      method: 'POST', headers: { Authorization: `Bearer ${hosted.mintToken()}` },
    });
    assert.equal(wrong.status, 401);
    const unknown = await fetch(`${srv.base}/r/zzzzzzzz/rotate`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(unknown.status, 404);
  } finally {
    await srv.stop();
  }
});

// ─── delete ────────────────────────────────────────────────────────────────

test('DELETE /r/:id removes the rwa; every later op 404s', async () => {
  const srv = await startServer();
  try {
    const { id, token } = await createAndRead(srv.base, MODIFY_RWA);
    assert.ok(existsSync(join(srv.dataDir, 'r', id)), 'the dir exists before delete');

    const del = await fetch(`${srv.base}/r/${id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(del.status, 200);
    assert.equal((await del.json()).deleted, true);

    // The subtree is gone.
    assert.ok(!existsSync(join(srv.dataDir, 'r', id)), 'the dir was removed recursively');

    // Every later op → 404.
    assert.equal((await fetch(`${srv.base}/r/${id}/describe`, { headers: { Authorization: `Bearer ${token}` } })).status, 404);
    assert.equal((await fetch(`${srv.base}/r/${id}/export`, { headers: { Authorization: `Bearer ${token}` } })).status, 404);
    assert.equal((await fetch(`${srv.base}/r/${id}/doc`, { headers: { Authorization: `Bearer ${token}` } })).status, 404);
    assert.equal((await postUndo(srv.base, id, token)).status, 404);
  } finally {
    await srv.stop();
  }
});

test('delete auth: 401 on wrong token, 404 on unknown id; a wrong token does NOT delete', async () => {
  const srv = await startServer();
  try {
    const { id, token } = await createAndRead(srv.base, MODIFY_RWA);

    const wrong = await fetch(`${srv.base}/r/${id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${hosted.mintToken()}` },
    });
    assert.equal(wrong.status, 401);
    assert.ok(existsSync(join(srv.dataDir, 'r', id)), 'a wrong-token delete must NOT remove the dir');

    const unknown = await fetch(`${srv.base}/r/zzzzzzzz`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(unknown.status, 404);

    // The owner can still delete.
    const ok = await fetch(`${srv.base}/r/${id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(ok.status, 200);
  } finally {
    await srv.stop();
  }
});

// ─── 90-day inactivity sweep (pure function) ────────────────────────────────

test('sweepHosted removes dirs idle > 90 days, keeps fresh ones, NEVER touches /s/', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-sweep-'));
  try {
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;

    // Two hosted rwas: one stale (idle 100 days), one fresh (idle 1 day).
    const stale = hosted.ingest(MODIFY_RWA, { dataDir: dir });
    const fresh = hosted.ingest(MODIFY_RWA, { dataDir: dir });
    // Backdate lastAccess by rewriting owner.json with synthetic timestamps.
    const setLastAccess = (id, ms) => {
      const p = join(dir, 'r', id, 'owner.json');
      const o = JSON.parse(readFileSync(p, 'utf8'));
      o.lastAccess = ms;
      writeFileSync(p, JSON.stringify(o));
    };
    setLastAccess(stale.id, now - 100 * DAY);
    setLastAccess(fresh.id, now - 1 * DAY);

    // A /s/ share file in the SAME DATA_DIR — the sweep must not touch it.
    const sharePath = join(dir, 'aaaaaaaa.html');
    const shareMetaPath = join(dir, 'aaaaaaaa.json');
    writeFileSync(sharePath, '<html>share</html>');
    writeFileSync(shareMetaPath, JSON.stringify({ createdAt: now }));

    const removed = hosted.sweepHosted(now, { dataDir: dir });

    assert.deepEqual(removed, [stale.id], 'only the stale hosted rwa is removed');
    assert.ok(!existsSync(join(dir, 'r', stale.id)), 'stale hosted dir gone');
    assert.ok(existsSync(join(dir, 'r', fresh.id)), 'fresh hosted dir kept');
    // /s/ share files are UNTOUCHED.
    assert.ok(existsSync(sharePath), 'sweepHosted never removes /s/ share .html');
    assert.ok(existsSync(shareMetaPath), 'sweepHosted never removes /s/ share .json');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sweepHosted tolerates a missing r/ dir and a malformed owner.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-sweep-edge-'));
  try {
    const now = Date.now();
    // No r/ subtree yet → empty result, no throw.
    assert.deepEqual(hosted.sweepHosted(now, { dataDir: dir }), []);

    // A dir with a corrupt owner.json is treated as stale (removed), not crashed.
    const bad = hosted.ingest(MODIFY_RWA, { dataDir: dir });
    writeFileSync(join(dir, 'r', bad.id, 'owner.json'), 'not json {');
    const removed = hosted.sweepHosted(now, { dataDir: dir });
    assert.deepEqual(removed, [bad.id], 'a corrupt owner.json dir is swept (treated as expired)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── per-token rate limit on /modify ────────────────────────────────────────

test('per-token rate limit: the N+1th /modify within the window → 429 rate_limited', async () => {
  // The limit is keyed by capHash, separate from the per-IP limit. We drive
  // RWA_MODIFY_RATE_LIMIT (a small N for the test) so we don't fire 60 requests.
  const dataDir = mkdtempSync(join(tmpdir(), 'rwa-tokenlimit-'));
  const port = await freePort();
  const N = 3;
  const child = spawn('node', [join(SERVICE, 'server.js')], {
    env: { ...process.env, PORT: String(port), RWA_DATA_DIR: dataDir, RWA_MODIFY_RATE_LIMIT: String(N) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let buf = '';
    const onData = (d) => { buf += d.toString(); if (/listening on :/.test(buf)) { child.stdout.off('data', onData); resolve(); } };
    child.stdout.on('data', onData);
    child.on('exit', (code) => reject(new Error('server exited early ' + code + '\n' + buf)));
    setTimeout(() => reject(new Error('server did not start\n' + buf)), 8000);
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    const { id, token, baseHash } = await createAndRead(base, MODIFY_RWA);

    // N successful modifies (each chains the next baseHash so they all apply).
    let h = baseHash, find = 'Old Title';
    for (let i = 0; i < N; i++) {
      const replace = `Title ${i}`;
      h = await modifyOnce(base, id, token, find, replace, h);
      find = replace;
    }

    // The N+1th within the window → 429, keyed by the token (capHash), BEFORE
    // any apply (so the body is untouched).
    const over = await postModify(base, id, token, {
      envelope: { version: 'rwa-edit/1', edits: [{ find, replace: 'Title overflow' }] }, baseHash: h,
    });
    assert.equal(over.status, 429, 'the N+1th write for this token is rate-limited');
    assert.equal((await over.json()).error, 'rate_limited');

    // The rejected write did NOT apply: the body still has the Nth title.
    const exported = await (await fetch(`${base}/r/${id}/export`, { headers: { Authorization: `Bearer ${token}` } })).text();
    assert.ok(exported.includes(find), 'rate-limited write was rejected before applying');
    assert.ok(!exported.includes('Title overflow'));

    // A DIFFERENT token (different cap) is NOT rate-limited by the first's bucket.
    const other = await createAndRead(base, MODIFY_RWA);
    const r = await postModify(base, other.id, other.token, {
      envelope: { version: 'rwa-edit/1', edits: [{ find: 'Old Title', replace: 'Other' }] },
      baseHash: other.baseHash,
    });
    assert.equal(r.status, 200, 'a different token has its own bucket (per-cap, not global)');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ─── Document size cap (MAX_DOC) — enforced server-side ──────────────────────
//
// WHY these matter (Rule 9): the vendored apply pipeline only COMMENTS the
// MAX_DOC cap (a CLI scope-down), so without a server-side gate an authorized
// token-holder could grow a hosted doc to the 25MB body cap (× unbounded undo
// pre-images). The build-design claims "size caps hold server-side"; these tests
// make that TRUE. The cap is enforced on the LF-canonical editable body at the
// SAME bound the seed uses in-page (RWA_EDIT.MAX_DOC), so hosted == substrate.
// Both doors are gated: /modify (post-apply, before any commit) and ingest.
// RWA_HOSTED_MAX_DOC lets the test trip the cap without a 1MiB request (same
// pattern as the rate-limit test's RWA_MODIFY_RATE_LIMIT).

test('/modify whose result would exceed MAX_DOC → 422 target_size_exceeded, NO write', async () => {
  // Small cap so a single edit can overshoot it. MODIFY_BODY is ~73 chars; the
  // cap is set just above it, and the edit grows the body well past the cap.
  const CAP = 120;
  const srv = await startServer({ RWA_HOSTED_MAX_DOC: String(CAP) });
  try {
    const { id, token, doc, baseHash } = await createAndRead(srv.base, MODIFY_RWA);
    assert.ok(doc.length <= CAP, 'precondition: the starting body is within the cap');

    const huge = 'X'.repeat(CAP * 2); // pushes the body well over the cap
    const res = await postModify(srv.base, id, token, {
      envelope: { version: 'rwa-edit/1', edits: [{ find: 'Old Title', replace: huge }] },
      baseHash,
    });
    assert.equal(res.status, 422, 'an over-cap result is a 422 (same status apply-failures use)');
    assert.equal((await res.json()).error, 'target_size_exceeded',
      'the error code matches the seed RwaEditError("target_size_exceeded")');

    // NO write: /export still shows the original body, unchanged.
    const exported = await (await fetch(`${srv.base}/r/${id}/export`, {
      headers: { Authorization: `Bearer ${token}` },
    })).text();
    assert.ok(exported.includes('Old Title'), 'over-cap modify left the bytes UNCHANGED');
    assert.ok(!exported.includes(huge), 'the oversized body was never committed');

    // NO history record, NO undo pre-image (the cap rejects BEFORE either).
    assert.ok(!existsSync(join(srv.dataDir, 'r', id, 'history.jsonl')),
      'a cap-rejected modify writes no history');
    const docRes = await fetch(`${srv.base}/r/${id}/doc`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal((await docRes.json()).baseHash, baseHash, '/doc baseHash unchanged (no commit)');
  } finally {
    await srv.stop();
  }
});

test('/modify still applies when the result stays within MAX_DOC (cap is a ceiling, not a block)', async () => {
  // Same small cap; a short edit that keeps the body within it must still apply —
  // proving the cap rejects only OVER-cap results, not all writes.
  const srv = await startServer({ RWA_HOSTED_MAX_DOC: '4000' });
  try {
    const { id, token, baseHash } = await createAndRead(srv.base, MODIFY_RWA);
    const res = await postModify(srv.base, id, token, {
      envelope: SIMPLE_EDIT, baseHash, actor: 'web:test',
    });
    assert.equal(res.status, 200, 'a within-cap edit still applies');
    assert.ok((await res.json()).doc.includes('New Title'));
  } finally {
    await srv.stop();
  }
});

test('ingest (POST /r) of a container whose body already exceeds MAX_DOC → 400 target_size_exceeded', async () => {
  const CAP = 200;
  const srv = await startServer({ RWA_HOSTED_MAX_DOC: String(CAP) });
  try {
    // A valid rewritable whose editable body is over the cap on its own.
    const bigBody = '<article><h1>Big</h1><p>' + 'Y'.repeat(CAP * 2) + '</p></article>';
    const oversized = makeRewritable('44444444-4444-4444-8444-444444444444', bigBody);
    const res = await fetch(srv.base + '/r', {
      method: 'POST', headers: { 'Content-Type': 'text/html' }, body: oversized,
    });
    assert.equal(res.status, 400, 'an oversized ingest is rejected (so the doc is never un-editable)');
    assert.equal((await res.json()).error, 'target_size_exceeded');

    // A within-cap rewritable still ingests fine (the gate is a ceiling).
    const ok = await fetch(srv.base + '/r', {
      method: 'POST', headers: { 'Content-Type': 'text/html' },
      body: makeRewritable('55555555-5555-4555-8555-555555555555'),
    });
    assert.equal(ok.status, 200, 'a within-cap container ingests normally');
  } finally {
    await srv.stop();
  }
});

// ─── 3. Task 6: GET /r/:id — the LIVE EDITABLE web projection ────────────────
//
// WHY these matter (Rule 9): GET /r/:id is the user-facing door. It serves the
// REAL stored current.html (full seed lens/⌘K UI, unchanged) with ONE injected
// shim that redirects the seed's commit to the authoritative server via the
// Task-1 seam (window.__rwaCommitSink). Three invariants are load-bearing:
//   (A) The shim parses BEFORE the bootstrap. If the bootstrap's IIFE ran first
//       it would openDB the stale per-container IDB before the shim could delete
//       it (reload-sync), and getDoc() prefers rwa_doc over INLINE_DOC — a
//       returning visitor would see STALE content shadowing the served-latest.
//   (B) The token never reaches the server. It rides the #k= URL fragment (not
//       sent on navigation); the shim reads it client-side and authenticates the
//       subsequent /modify + /undo. A token in a query string would land in logs.
//   (C) The sink FAILS LOUD on a malformed server reply. commitDoc mirrors the
//       sink's return via idbPut(RWA.DOC, serverDoc); a non-string/empty doc must
//       throw at the boundary, never silently corrupt the local mirror.

test('GET /r/:id serves current.html with the shim injected BEFORE the bootstrap, templated with id+uuid; unknown id → 404', async () => {
  const srv = await startServer();
  try {
    // Create with a known input UUID; the server rotates it on ingest, so the
    // shim must be templated with the STORED (rotated) uuid, not the input one.
    const createRes = await fetch(srv.base + '/r', {
      method: 'POST', headers: { 'Content-Type': 'text/html' }, body: RWA,
    });
    const { id } = await createRes.json();

    // The served projection — no Bearer needed (token rides #k=, server never sees it).
    const res = await fetch(`${srv.base}/r/${id}`);
    assert.equal(res.status, 200, 'GET /r/:id → 200');
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    // noindex: a leaked unguessable id must not get crawler-indexed.
    assert.match(res.headers.get('x-robots-tag') || '', /noindex/,
      'the hosted projection is served noindex');
    const html = await res.text();

    // The shim <script> must appear, and STRICTLY BEFORE the bootstrap so it runs
    // first (reload-sync deletes the stale IDB before openDB).
    const shimIdx = html.indexOf('id="rwa-hosted-shim"');
    const bootIdx = html.indexOf('<script id="rwa-bootstrap">');
    assert.ok(shimIdx >= 0, 'the shim <script id="rwa-hosted-shim"> is present');
    assert.ok(bootIdx >= 0, 'the bootstrap <script> is present (real rewritable served)');
    assert.ok(shimIdx < bootIdx, 'the shim is injected BEFORE the bootstrap');

    // Templated with THIS id. The shim builds its API URLs at runtime by
    // concatenation ('/r/' + RWA_ID + '/modify' | '/undo'), so the load-bearing
    // substitution in the served bytes is the RWA_ID assignment — every
    // /r/<id>/modify + /r/<id>/undo call resolves from it. Assert the exact
    // substituted assignment (not a bare html.includes(id), which is trivially
    // true: id is an 8-char substring always present). This FAILS if
    // id-substitution regresses (the __RWA_HOSTED_ID__ placeholder would remain).
    assert.ok(html.includes(`var RWA_ID = '${id}';`),
      'the shim is templated with this rwa id (RWA_ID — the source of its /modify + /undo URLs)');

    // Templated with the STORED (rotated) DOC_UUID — so deleteDatabase targets the
    // right per-container IDB. Read it back from the stored bytes.
    const onDisk = readFileSync(join(srv.dataDir, 'r', id, 'current.html'), 'utf8');
    const storedUuid = (onDisk.match(/const DOC_UUID = '([0-9a-f-]{36})';/) || [])[1];
    assert.ok(storedUuid, 'stored bytes carry a DOC_UUID');
    assert.notEqual(storedUuid, '22222222-2222-4222-8222-222222222222', 'uuid was rotated on ingest');
    assert.ok(html.includes(storedUuid),
      'the shim is templated with the STORED (rotated) DOC_UUID for reload-sync deleteDatabase');

    // The placeholders must be fully substituted — no template tokens leak.
    assert.ok(!html.includes('__RWA_HOSTED_ID__'), 'no id placeholder leaks');
    assert.ok(!html.includes('__RWA_HOSTED_UUID__'), 'no uuid placeholder leaks');

    // The served bytes are the REAL current.html (the shim is additive, the
    // bootstrap + INLINE_DOC are intact).
    assert.ok(html.includes('Hosted Test Doc'), 'served body is the real rewritable content');

    // Unknown id → 404.
    const unknown = await fetch(`${srv.base}/r/zzzzzzzz`);
    assert.equal(unknown.status, 404, 'unknown id → 404');
  } finally {
    await srv.stop();
  }
});

// WHY (Rule 9): ingest's gate (BOOTSTRAP_RE = /<script id="rwa-bootstrap"/, no
// closing '>') ACCEPTS a bootstrap tag carrying attributes (e.g. `defer`), but
// the projection must SERVE everything ingest accepts. A literal-string splice on
// '<script id="rwa-bootstrap">' would miss the attributed form → 500. This pins
// the two gates to agree on "has a bootstrap": a container that passes ingest
// must render a 200 projection with the shim injected before that tag.
test('GET /r/:id serves a container whose bootstrap tag carries an attribute (no 500) — projection splice agrees with the ingest gate', async () => {
  const srv = await startServer();
  try {
    // Same shape as makeRewritable but the bootstrap open tag carries `defer`.
    // This passes ingest (BOOTSTRAP_RE has no closing '>') yet a literal
    // indexOf('<script id="rwa-bootstrap">') splice would return -1 → 500.
    const attributed = makeRewritable('55555555-5555-4555-8555-555555555555')
      .replace('<script id="rwa-bootstrap">', '<script id="rwa-bootstrap" defer>');
    assert.ok(attributed.includes('<script id="rwa-bootstrap" defer>'),
      'fixture actually carries the attributed bootstrap tag');

    const createRes = await fetch(srv.base + '/r', {
      method: 'POST', headers: { 'Content-Type': 'text/html' }, body: attributed,
    });
    assert.equal(createRes.status, 200, 'attributed bootstrap passes ingest → 200');
    const { id } = await createRes.json();

    const res = await fetch(`${srv.base}/r/${id}`);
    assert.equal(res.status, 200, 'GET /r/:id → 200 for an attributed bootstrap (not 500)');
    const html = await res.text();

    // The shim is injected, and STRICTLY BEFORE the (attributed) bootstrap tag.
    const shimIdx = html.indexOf('id="rwa-hosted-shim"');
    const bootIdx = html.indexOf('<script id="rwa-bootstrap" defer>');
    assert.ok(shimIdx >= 0, 'the shim <script> is present');
    assert.ok(bootIdx >= 0, 'the attributed bootstrap tag is preserved in the output');
    assert.ok(shimIdx < bootIdx, 'the shim is injected BEFORE the attributed bootstrap');
    assert.ok(!html.includes('__RWA_HOSTED_ID__'), 'no id placeholder leaks');
  } finally {
    await srv.stop();
  }
});

test('GET /r/:id is apex-only — a share host does not serve the projection', async () => {
  // Drive the server with a share-host Host header. The share-host branch returns
  // 404 for everything but its own bytes + robots.txt; /r/:id must NOT leak there.
  // node's fetch (undici) silently DROPS a custom Host header (it's forbidden), so
  // we issue a raw http.request to control the Host the server matches SHORT_HOST_RE on.
  const srv = await startServer();
  try {
    const createRes = await fetch(srv.base + '/r', {
      method: 'POST', headers: { 'Content-Type': 'text/html' }, body: RWA,
    });
    const { id } = await createRes.json();
    const u = new URL(srv.base);
    const status = await new Promise((resolve, reject) => {
      const r = http.request({
        hostname: u.hostname, port: u.port, path: `/r/${id}`, method: 'GET',
        headers: { Host: 'abcd1234.rewritable.ikangai.com' },
      }, (resp) => { resp.resume(); resolve(resp.statusCode); });
      r.on('error', reject);
      r.end();
    });
    assert.equal(status, 404, 'a share host does not serve /r/:id (only its own bytes + robots)');
  } finally {
    await srv.stop();
  }
});

// ─── 3b. Shim PURE LOGIC + reload-sync (jsdom + fake-indexeddb) ──────────────
//
// The shim is plain browser JS. Its pure logic (token parse/strip, sink request
// build, response interpretation, Undo, undoLen gating) is exposed for tests via
// window.__rwaHostedShimTestApi — ONLY when window.__RWA_SHIM_TEST__ is set, so a
// production page never exposes the internals (same convention as the seed's
// `window.injectMissingBlockIds = …; // expose for tests`). We run the templated
// shim inside jsdom and drive that test API.
//
// fake-indexeddb + jsdom live in benchmark/node_modules (the seed harness in
// tests/ resolves them the same way); resolve via a benchmark-scoped require.

const benchRequire = createRequire(join(SERVICE, '..', 'benchmark', 'package.json'));
const { JSDOM } = benchRequire('jsdom');
const fakeIdb = benchRequire('fake-indexeddb');

const SHIM_PATH = join(SERVICE, 'public', 'hosted-shim.js');
const SHIM_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SHIM_ID = 'abcd1234';

// Build the templated shim source exactly as the server would (id + uuid subs).
function templatedShim() {
  const raw = readFileSync(SHIM_PATH, 'utf8');
  return raw
    .replaceAll('__RWA_HOSTED_ID__', SHIM_ID)
    .replaceAll('__RWA_HOSTED_UUID__', SHIM_UUID);
}

// Boot a jsdom window with the templated shim run as a real <script>. fetch +
// location are injected so the pure logic is observable. The shim must set
// window.__rwaCommitSink and (test mode) window.__rwaHostedShimTestApi.
function bootShim({ hash = '', fetchImpl, reloadSpy, replaceStateSpy } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><body><div id="rwa-runtime"></div></body></html>`,
    {
      url: `https://rwa.example/r/${SHIM_ID}${hash}`,
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    }
  );
  const { window } = dom;
  window.indexedDB = fakeIdb.indexedDB;
  window.IDBKeyRange = fakeIdb.IDBKeyRange;
  // jsdom (outside-only) lacks TextEncoder + crypto.subtle, which a real browser
  // provides globally. The shim's sha256hex needs both — inject node's globals so
  // the pure logic runs exactly as it would in a browser. window.crypto is a
  // read-only getter in jsdom, so override via defineProperty.
  if (!window.TextEncoder) window.TextEncoder = globalThis.TextEncoder;
  if (!window.crypto || !window.crypto.subtle) {
    Object.defineProperty(window, 'crypto', { value: globalThis.crypto, configurable: true });
  }
  // jsdom (outside-only) has no Response constructor; node's global one is a fine
  // stand-in for the fetch responses the fetchImpl mocks return.
  if (!window.Response) window.Response = globalThis.Response;
  window.__RWA_SHIM_TEST__ = true;
  if (fetchImpl) window.fetch = fetchImpl;
  // jsdom's location.reload is non-configurable, so the shim honors a test-only,
  // gated reload override (window.__rwaHostedReload) when __RWA_SHIM_TEST__ is set.
  if (reloadSpy) window.__rwaHostedReload = reloadSpy;
  if (replaceStateSpy) window.history.replaceState = replaceStateSpy;
  // Run the shim as the page would (it is the prepended <script>).
  window.eval(templatedShim());
  return window;
}

test('shim: token parsed from #k=, stored in sessionStorage keyed by id, stripped from the URL', () => {
  const calls = [];
  const win = bootShim({
    hash: '#k=secret-token-xyz',
    replaceStateSpy: (...a) => calls.push(a),
  });
  const api = win.__rwaHostedShimTestApi;
  assert.ok(api, 'test API is exposed under window.__RWA_SHIM_TEST__');
  assert.equal(api.getToken(), 'secret-token-xyz', 'token read from #k= fragment');
  assert.equal(win.sessionStorage.getItem('rwa_hosted_token_' + SHIM_ID), 'secret-token-xyz',
    'token stored in sessionStorage keyed by id');
  assert.ok(calls.length >= 1, 'history.replaceState called to strip #k=');
  // The replaceState URL must not carry the token fragment.
  const lastUrl = String(calls[calls.length - 1][2] || '');
  assert.ok(!lastUrl.includes('k=secret-token-xyz'), 'stripped URL no longer carries the token');
});

test('shim: a returning visitor with the token in sessionStorage (no #k=) still authenticates', () => {
  const dom = new JSDOM(`<!doctype html><html><body></body></html>`, {
    url: `https://rwa.example/r/${SHIM_ID}`, runScripts: 'outside-only',
  });
  const { window } = dom;
  window.indexedDB = fakeIdb.indexedDB;
  window.IDBKeyRange = fakeIdb.IDBKeyRange;
  window.__RWA_SHIM_TEST__ = true;
  window.sessionStorage.setItem('rwa_hosted_token_' + SHIM_ID, 'persisted-token');
  window.eval(templatedShim());
  assert.equal(window.__rwaHostedShimTestApi.getToken(), 'persisted-token',
    'falls back to the sessionStorage token when no #k= present');
});

test('shim: deleteDatabase("rwa_"+uuid) is invoked on load (reload-sync) BEFORE any open', () => {
  const deletes = [];
  const realDelete = fakeIdb.indexedDB.deleteDatabase.bind(fakeIdb.indexedDB);
  const dom = new JSDOM(`<!doctype html><html><body></body></html>`, {
    url: `https://rwa.example/r/${SHIM_ID}#k=t`, runScripts: 'outside-only',
  });
  const { window } = dom;
  // Wrap deleteDatabase to record the name the shim targets.
  window.indexedDB = Object.create(fakeIdb.indexedDB);
  window.indexedDB.deleteDatabase = (name) => { deletes.push(name); return realDelete(name); };
  window.indexedDB.open = fakeIdb.indexedDB.open.bind(fakeIdb.indexedDB);
  window.IDBKeyRange = fakeIdb.IDBKeyRange;
  window.__RWA_SHIM_TEST__ = true;
  window.history.replaceState = () => {};
  window.eval(templatedShim());
  assert.deepEqual(deletes, ['rwa_' + SHIM_UUID],
    'the shim deletes exactly the per-container IDB for THIS uuid on load');
});

test('shim sink: builds POST /r/<id>/modify {envelope, baseHash} with Bearer; baseHash = sha256(canonLF(baseDoc))', async () => {
  const captured = [];
  const win = bootShim({
    hash: '#k=tok',
    fetchImpl: async (url, opts) => {
      captured.push({ url, opts });
      return new win.Response(JSON.stringify({ doc: 'SERVER-DOC', undoLen: 1, histLen: 1 }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    },
    replaceStateSpy: () => {},
  });
  const sink = win.__rwaCommitSink;
  assert.equal(typeof sink, 'function', 'the seam hook is installed');

  const envelope = { version: 'rwa-edit/1', edits: [{ find: 'a', replace: 'b' }] };
  // baseDoc with CRLF to prove canonLF runs before hashing.
  const baseDoc = 'line1\r\nline2\r\n';
  const out = await sink(envelope, { kind: 'edit_batch' }, baseDoc);
  assert.equal(out, 'SERVER-DOC', 'sink returns the server doc on 200');

  assert.equal(captured.length, 1);
  const { url, opts } = captured[0];
  assert.match(String(url), new RegExp(`/r/${SHIM_ID}/modify$`), 'POSTs to /r/<id>/modify');
  assert.equal(opts.method, 'POST');
  assert.equal(opts.headers.Authorization, 'Bearer tok', 'Bearer token on the write');
  const body = JSON.parse(opts.body);
  assert.deepEqual(body.envelope, envelope, 'envelope forwarded verbatim');
  // baseHash must equal sha256 of the LF-canonical base body (server's baseBodyHash).
  const expected = sha256hex('line1\nline2\n');
  assert.equal(body.baseHash, expected, 'baseHash = sha256(canonLF(baseDoc)) — matches server baseBodyHash');
});

test('shim sink: FAIL LOUD on a malformed 200 (non-string or empty doc throws — never corrupts the mirror)', async () => {
  for (const bad of [{ doc: 123 }, { doc: '' }, { notdoc: 'x' }, {}]) {
    let win;
    win = bootShim({
      hash: '#k=t',
      fetchImpl: async () => new win.Response(JSON.stringify(bad), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
      replaceStateSpy: () => {},
    });
    await assert.rejects(
      () => win.__rwaCommitSink({ version: 'rwa-edit/1', edits: [] }, { kind: 'edit_batch' }, 'd'),
      /doc/i,
      `malformed 200 (${JSON.stringify(bad)}) must throw`
    );
  }
});

test('shim sink: 409 stale_base → reload + throw', async () => {
  let reloaded = 0;
  const win = bootShim({
    hash: '#k=t',
    fetchImpl: async () => new win.Response(JSON.stringify({ error: 'stale_base' }), {
      status: 409, headers: { 'Content-Type': 'application/json' },
    }),
    replaceStateSpy: () => {},
    reloadSpy: () => { reloaded++; },
  });
  await assert.rejects(
    () => win.__rwaCommitSink({ version: 'rwa-edit/1', edits: [] }, { kind: 'edit_batch' }, 'd'),
    /stale|changed|409/i,
    '409 must throw so the seed does not advance local state'
  );
  assert.equal(reloaded, 1, '409 triggers a reload to re-fetch authoritative bytes');
});

test('shim sink: 401 invalid token → surface + throw (no reload)', async () => {
  let reloaded = 0;
  const win = bootShim({
    hash: '#k=t',
    fetchImpl: async () => new win.Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    }),
    replaceStateSpy: () => {},
    reloadSpy: () => { reloaded++; },
  });
  await assert.rejects(
    () => win.__rwaCommitSink({ version: 'rwa-edit/1', edits: [] }, { kind: 'edit_batch' }, 'd'),
    /token|401|unauthor/i,
    '401 must throw'
  );
  assert.equal(reloaded, 0, '401 does not reload (the bytes are fine, the token is not)');
});

test('shim sink: 422 rwa-edit failure subcode → surface the subcode + throw', async () => {
  let thrown;
  const win = bootShim({
    hash: '#k=t',
    fetchImpl: async () => new win.Response(JSON.stringify({ error: 'find_not_found', detail: 'no anchor' }), {
      status: 422, headers: { 'Content-Type': 'application/json' },
    }),
    replaceStateSpy: () => {},
  });
  try { await win.__rwaCommitSink({ version: 'rwa-edit/1', edits: [] }, { kind: 'edit_batch' }, 'd'); }
  catch (e) { thrown = e; }
  assert.ok(thrown, '422 throws');
  assert.match(String(thrown.message), /find_not_found/, 'the rwa-edit subcode is surfaced to the user');
});

test('shim sink: 5xx / network → surface "server error" + throw', async () => {
  const win = bootShim({
    hash: '#k=t',
    fetchImpl: async () => new win.Response(JSON.stringify({ error: 'internal_error' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    }),
    replaceStateSpy: () => {},
  });
  await assert.rejects(
    () => win.__rwaCommitSink({ version: 'rwa-edit/1', edits: [] }, { kind: 'edit_batch' }, 'd'),
    /server/i, '5xx throws a server-error'
  );
  // Network failure (fetch rejects) → also throws.
  const win2 = bootShim({
    hash: '#k=t', fetchImpl: async () => { throw new Error('network down'); }, replaceStateSpy: () => {},
  });
  await assert.rejects(
    () => win2.__rwaCommitSink({ version: 'rwa-edit/1', edits: [] }, { kind: 'edit_batch' }, 'd'),
    /server|network/i, 'a network failure throws'
  );
});

test('shim Undo: POST /r/<id>/undo with Bearer; 200 → reload; undoLen===0 disables the button', async () => {
  const captured = [];
  let reloaded = 0;
  const win = bootShim({
    hash: '#k=tok',
    fetchImpl: async (url, opts) => {
      captured.push({ url, opts });
      return new win.Response(JSON.stringify({ undoLen: 0, histLen: 1 }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    },
    replaceStateSpy: () => {},
    reloadSpy: () => { reloaded++; },
  });
  const api = win.__rwaHostedShimTestApi;
  assert.equal(typeof api.doUndo, 'function', 'undo action exposed');

  await api.doUndo();
  assert.equal(captured.length, 1);
  assert.match(String(captured[0].url), new RegExp(`/r/${SHIM_ID}/undo$`), 'POSTs to /undo');
  assert.equal(captured[0].opts.method, 'POST');
  assert.equal(captured[0].opts.headers.Authorization, 'Bearer tok', 'Bearer on undo');
  assert.equal(reloaded, 1, '200 undo reloads (server reverted current.html)');

  // The shim must render a real Undo button and reflect undoLen state.
  const btn = win.document.getElementById('rwa-hosted-undo');
  assert.ok(btn, 'a server-Undo button is injected into the page');
  // After an undo that returns undoLen 0, the button is disabled.
  assert.equal(api.getUndoLen(), 0, 'undoLen tracked from the /undo response');
  assert.ok(btn.disabled, 'Undo button disabled when undoLen === 0');
});

test('shim Undo: 409 nothing_to_undo → button disabled, no reload', async () => {
  let reloaded = 0;
  const win = bootShim({
    hash: '#k=t',
    fetchImpl: async () => new win.Response(JSON.stringify({ error: 'nothing_to_undo' }), {
      status: 409, headers: { 'Content-Type': 'application/json' },
    }),
    replaceStateSpy: () => {},
    reloadSpy: () => { reloaded++; },
  });
  const api = win.__rwaHostedShimTestApi;
  await api.doUndo();
  assert.equal(reloaded, 0, 'nothing_to_undo does not reload');
  const btn = win.document.getElementById('rwa-hosted-undo');
  assert.ok(btn.disabled, 'Undo disabled after nothing_to_undo');
});

test('shim Undo: on load (undoLen unknown) the button is OPTIMISTICALLY enabled — self-corrects on 409', () => {
  // No GET returns the undo depth, so on load undoLen is unknown (null). The button
  // starts enabled (a click will 409→disable if the stack is empty); it must NOT be
  // falsely disabled when there may be prior server-side history to undo.
  const win = bootShim({ hash: '#k=t', fetchImpl: async () => { throw new Error('unused'); }, replaceStateSpy: () => {} });
  const api = win.__rwaHostedShimTestApi;
  assert.equal(api.getUndoLen(), null, 'undoLen is unknown on load (no GET reports it)');
  const btn = win.document.getElementById('rwa-hosted-undo');
  assert.equal(btn.disabled, false, 'Undo optimistically enabled when undoLen is unknown');
  // Once the server reports a count, the button strictly reflects it.
  api.setUndoLen(0);
  assert.ok(btn.disabled, 'disabled once undoLen is known to be 0');
  api.setUndoLen(2);
  assert.equal(btn.disabled, false, 'enabled when undoLen > 0');
});

// ─── 3c. RELOAD-SYNC integration: a STALE rwa_doc must NOT shadow the served body
//
// The load-bearing correctness point. The seed's getDoc() prefers IDB rwa_doc
// over INLINE_DOC. The server serves the LATEST current.html as INLINE_DOC on
// every GET. So a stale rwa_doc in rwa_<uuid> would shadow the served-latest and
// show old content. The shim's deleteDatabase('rwa_'+uuid) at the very top must
// clear it BEFORE the bootstrap's openDB seeds fresh from INLINE_DOC. We prove
// the IDB ordering directly with fake-indexeddb: write a stale rwa_doc, run the
// shim's delete, then assert a subsequent open sees an EMPTY db (no rwa_doc).

test('reload-sync: a stale rwa_doc is cleared by the shim delete before a fresh open (fake-indexeddb ordering)', async () => {
  const dbName = 'rwa_' + SHIM_UUID;
  // Seed a STALE rwa_doc into the per-container IDB (as a returning browser would have).
  await new Promise((resolve, reject) => {
    const req = fakeIdb.indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('rwa_doc');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('rwa_doc', 'readwrite');
      tx.objectStore('rwa_doc').put('<article>STALE LOCAL CONTENT</article>', 'self');
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });

  // Run the shim (it calls deleteDatabase(dbName) at the top), then await the
  // delete request the shim issued via the test API.
  const dom = new JSDOM(`<!doctype html><html><body></body></html>`, {
    url: `https://rwa.example/r/${SHIM_ID}#k=t`, runScripts: 'outside-only',
  });
  const { window } = dom;
  window.indexedDB = fakeIdb.indexedDB;
  window.IDBKeyRange = fakeIdb.IDBKeyRange;
  window.__RWA_SHIM_TEST__ = true;
  window.history.replaceState = () => {};
  window.eval(templatedShim());
  // The shim exposes its delete request promise so a test can await ordering.
  await window.__rwaHostedShimTestApi.deletePromise;

  // Now open the db as the bootstrap would. The store must be gone (fresh db) OR
  // present-but-empty — either way, NO stale rwa_doc value survives to shadow
  // INLINE_DOC. fake-indexeddb serializes the delete before this open.
  const after = await new Promise((resolve, reject) => {
    const req = fakeIdb.indexedDB.open(dbName);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('rwa_doc')) { db.close(); return resolve(null); }
      const tx = db.transaction('rwa_doc', 'readonly');
      const g = tx.objectStore('rwa_doc').get('self');
      g.onsuccess = () => { const v = g.result; db.close(); resolve(v == null ? null : v); };
      g.onerror = () => { db.close(); reject(g.error); };
    };
    req.onerror = () => reject(req.error);
  });
  assert.equal(after, null,
    'the stale rwa_doc did NOT survive the shim delete — the bootstrap will seed from the served INLINE_DOC');
});
