// Tests for the connected-share route family (/share, /share/:short) — the
// stable-URL sibling of the ephemeral POST /publish (which must stay
// byte-untouched). Design: docs/plans/2026-06-11-connected-share-plan.md.
//
// WHY these matter (Rule 9): a connected share is a *capability-updatable*
// public artifact. The load-bearing invariants are:
//   • the update token is the ONLY thing that lets anyone re-publish or delete
//     a share — capHash (never the raw token) at rest, Bearer verify on write;
//   • every publish rotates DOC_UUID, or a receiver who opened an earlier
//     version would silently see their stale IDB state instead of the update
//     (the receiver-side inversion the feature exists to avoid);
//   • CORS must admit the seed's file:// (null-origin) fetch — without ACAO on
//     every /share* response the whole chrome affordance is dead in the water;
//   • connected shares must NOT die at the ephemeral 24h sweep, and ephemeral
//     shares must still die at 24h (two TTL classes, one DATA_DIR).
//
// Harness mirrors hosted.test.mjs: spawn the real server.js on a concrete
// ephemeral port with a temp DATA_DIR and drive it over fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICE = join(__dirname, '..');

const sha256hex = (s) => createHash('sha256').update(s).digest('hex');

// Minimal valid rewritable, exactly what validateContainer requires.
function makeRewritable(uuid = '11111111-1111-4111-8111-111111111111', body = '<article><h1>Share Test Doc</h1><p>Version one body.</p></article>') {
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

// Start server.js on an ephemeral port with a temp DATA_DIR. `seedFiles` lets a
// test pre-plant share files so the STARTUP sweep is what's under test.
async function startServer({ seedFiles = null, extraEnv = {} } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'rwa-share-srv-'));
  if (seedFiles) for (const [name, content] of Object.entries(seedFiles)) {
    writeFileSync(join(dataDir, name), content);
  }
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

const CONTAINER = makeRewritable('22222222-2222-4222-8222-222222222222');

async function createShare(base, body = CONTAINER) {
  const res = await fetch(base + '/share', {
    method: 'POST', headers: { 'Content-Type': 'text/html' }, body,
  });
  return res;
}

// ─── 1. CORS preflight ──────────────────────────────────────────────────────

test('OPTIONS /share and /share/:short answer the preflight the file:// seed needs', async () => {
  const srv = await startServer();
  try {
    for (const path of ['/share', '/share/abcd1234']) {
      const res = await fetch(srv.base + path, { method: 'OPTIONS' });
      assert.equal(res.status, 204, `${path} preflight is 204`);
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
      const methods = res.headers.get('access-control-allow-methods') || '';
      assert.ok(methods.includes('POST') && methods.includes('DELETE'), 'allows POST and DELETE');
      assert.match(res.headers.get('access-control-allow-headers') || '', /authorization/i,
        'the Bearer update path needs the authorization header through preflight');
    }
  } finally { await srv.stop(); }
});

// ─── 2. Create ──────────────────────────────────────────────────────────────

test('POST /share creates a connected share: token returned once, capHash at rest, UUID rotated', async () => {
  const srv = await startServer();
  try {
    const res = await createShare(srv.base);
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('access-control-allow-origin'), '*',
      'create response must be CORS-readable from a null origin');
    const created = await res.json();
    assert.match(created.short, /^[0-9a-z]{8}$/);
    assert.equal(created.kind, 'connected');
    assert.equal(created.token.length, 43, 'a freshly minted capability token');
    assert.ok(created.url.includes(created.short), 'url names the short');

    // Metadata: connected class, capHash only — the raw token never at rest.
    const metaRaw = readFileSync(join(srv.dataDir, `${created.short}.json`), 'utf8');
    const meta = JSON.parse(metaRaw);
    assert.equal(meta.kind, 'connected');
    assert.equal(meta.capHash, sha256hex(created.token));
    assert.equal(typeof meta.createdAt, 'number');
    assert.equal(meta.updatedAt, meta.createdAt);
    assert.equal(meta.lastActivity, meta.createdAt);
    assert.ok(!metaRaw.includes(created.token), 'raw token must not appear in metadata');

    // Stored bytes: DOC_UUID rotated (receiver-side IDB isolation).
    const html = readFileSync(join(srv.dataDir, `${created.short}.html`), 'utf8');
    assert.ok(!html.includes('22222222-2222-4222-8222-222222222222'),
      'publish must rotate DOC_UUID');
    assert.ok(html.includes('Version one body.'), 'stored bytes carry the document');
    assert.ok(!html.includes(created.token), 'raw token must not appear in stored html');

    // And the share actually serves.
    const got = await fetch(`${srv.base}/s/${created.short}`);
    assert.equal(got.status, 200);
    assert.equal(await got.text(), html, 'GET /s/:short serves the stored bytes');
  } finally { await srv.stop(); }
});

test('POST /share rejects a non-rewritable with 400 validation_failed (CORS-readable)', async () => {
  const srv = await startServer();
  try {
    const res = await createShare(srv.base, '<html>not a rewritable</html>');
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const err = await res.json();
    assert.equal(err.error, 'validation_failed');
  } finally { await srv.stop(); }
});

// ─── 3. Update (the point of a CONNECTED share: same URL, new version) ──────

test('POST /share/:short with the token re-publishes to the same short', async () => {
  const srv = await startServer();
  try {
    const { short, token } = await (await createShare(srv.base)).json();
    const v1Html = readFileSync(join(srv.dataDir, `${short}.html`), 'utf8');
    const metaBefore = JSON.parse(readFileSync(join(srv.dataDir, `${short}.json`), 'utf8'));

    const v2 = makeRewritable('33333333-3333-4333-8333-333333333333',
      '<article><h1>Share Test Doc</h1><p>Version two body.</p></article>');
    const res = await fetch(`${srv.base}/share/${short}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/html', Authorization: `Bearer ${token}` },
      body: v2,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const out = await res.json();
    assert.equal(out.short, short, 'the short — and so the URL — is stable across updates');
    assert.equal(typeof out.updatedAt, 'number');

    const v2Html = readFileSync(join(srv.dataDir, `${short}.html`), 'utf8');
    assert.ok(v2Html.includes('Version two body.'), 'stored bytes are the new version');
    assert.ok(!v2Html.includes('Version one body.'), 'the old version is fully replaced');
    assert.notEqual(v2Html, v1Html);
    // UUID rotates on EVERY publish, and never echoes the poster's.
    assert.ok(!v2Html.includes('33333333-3333-4333-8333-333333333333'));

    const metaAfter = JSON.parse(readFileSync(join(srv.dataDir, `${short}.json`), 'utf8'));
    assert.equal(metaAfter.capHash, metaBefore.capHash, 'the capability survives updates');
    assert.equal(metaAfter.createdAt, metaBefore.createdAt);
    assert.ok(metaAfter.updatedAt >= metaBefore.updatedAt);
    assert.ok(metaAfter.lastActivity >= metaBefore.lastActivity);
  } finally { await srv.stop(); }
});

test('update auth: 401 missing/wrong token; 404 unknown short; 404 for an ephemeral /publish short', async () => {
  const srv = await startServer();
  try {
    const { short, token } = await (await createShare(srv.base)).json();

    const noAuth = await fetch(`${srv.base}/share/${short}`, {
      method: 'POST', headers: { 'Content-Type': 'text/html' }, body: CONTAINER,
    });
    assert.equal(noAuth.status, 401);
    assert.equal(noAuth.headers.get('access-control-allow-origin'), '*');

    const wrong = await fetch(`${srv.base}/share/${short}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/html', Authorization: 'Bearer ' + 'x'.repeat(43) },
      body: CONTAINER,
    });
    assert.equal(wrong.status, 401);
    const v1Html = readFileSync(join(srv.dataDir, `${short}.html`), 'utf8');
    assert.ok(v1Html.includes('Version one body.'), 'a rejected update must not touch the bytes');

    const unknown = await fetch(`${srv.base}/share/zzzzzzzz`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/html', Authorization: `Bearer ${token}` },
      body: CONTAINER,
    });
    assert.equal(unknown.status, 404);

    // An ephemeral /publish share has no capability — it must not be
    // updatable even with SOME valid connected-share token in hand.
    const pub = await (await fetch(srv.base + '/publish', {
      method: 'POST', headers: { 'Content-Type': 'text/html' }, body: CONTAINER,
    })).json();
    const ephem = await fetch(`${srv.base}/share/${pub.short}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/html', Authorization: `Bearer ${token}` },
      body: CONTAINER,
    });
    assert.equal(ephem.status, 404, 'ephemeral shares are not connected — 404, not 401');
  } finally { await srv.stop(); }
});

test('update with a garbage body: 400 validation_failed, stored bytes untouched', async () => {
  const srv = await startServer();
  try {
    const { short, token } = await (await createShare(srv.base)).json();
    const before = readFileSync(join(srv.dataDir, `${short}.html`), 'utf8');
    const res = await fetch(`${srv.base}/share/${short}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/html', Authorization: `Bearer ${token}` },
      body: '<html>garbage</html>',
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'validation_failed');
    assert.equal(readFileSync(join(srv.dataDir, `${short}.html`), 'utf8'), before);
  } finally { await srv.stop(); }
});
