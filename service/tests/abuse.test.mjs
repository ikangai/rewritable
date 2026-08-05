// Abuse reporting + operator takedown for published documents (#13).
//
// WHY (Rule 9): the service hosts arbitrary anonymous HTML at *.rewritable.ikangai.com. A
// self-contained file with inline script that renders a full-fidelity document, on a domain with a
// wildcard cert, is an effective phishing vehicle — and until now there was no third-party route to
// report one and no operator route to remove one. An abuse endpoint DID exist, but only for the
// signed-skill marketplace, i.e. the thing almost nobody publishes.
// docs/plans/2026-05-16-snapshot-publishing.md flagged this on day one and it was never closed.
//
// The policy these assertions defend is as important as the mechanism:
//   - reporting NEVER auto-removes. An endpoint that lets an anonymous reporter unpublish someone
//     else's document is itself an abuse vector; a human decides.
//   - takedown requires an explicitly configured operator token, and when that token is absent the
//     route does not exist at all rather than degrading to something weaker.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const SERVICE = join(dirname(fileURLToPath(import.meta.url)), '..');

const CONTAINER = [
  '<!doctype html><html><head><meta charset="utf-8"></head><body>',
  '<div id="rwa-doc-mount"></div>',
  '<script id="rwa-bootstrap">',
  "const DOC_UUID = '11111111-1111-4111-8111-111111111111';",
  "const PRODUCT_KIND = 'document';",
  'const INLINE_DOC = `<article><h1>Abuse Test</h1></article>`;',
  '</script></body></html>',
].join('\n');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function startServer(extraEnv = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'rwa-abuse-'));
  const port = await freePort();
  const child = spawn('node', [join(SERVICE, 'server.js')], {
    env: { ...process.env, PORT: String(port), RWA_DATA_DIR: dataDir, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 8000);
    child.stdout.on('data', (d) => { if (/listening on/.test(String(d))) { clearTimeout(t); resolve(); } });
    child.on('exit', (c) => { clearTimeout(t); reject(new Error('server exited ' + c)); });
  });
  return { base: `http://127.0.0.1:${port}`, dataDir, stop: () => child.kill() };
}

const publish = async (base) => {
  const r = await fetch(`${base}/publish`, { method: 'POST', body: CONTAINER });
  return (await r.json()).short;
};

test('a published document can be reported, and reporting never removes it', async () => {
  const srv = await startServer({ RWA_ADMIN_TOKEN: 'tok' });
  try {
    const short = await publish(srv.base);
    assert.match(short, /^[0-9a-z]{8}$/);

    const noReason = await fetch(`${srv.base}/report/${short}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(noReason.status, 400, 'a report must say why');

    const ok = await fetch(`${srv.base}/report/${short}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'phishing' }),
    });
    assert.equal(ok.status, 201);

    // The load-bearing policy assertion: the document is STILL THERE after a report.
    assert.ok(existsSync(join(srv.dataDir, `${short}.html`)),
      'reporting must not remove anything — otherwise the report endpoint is the abuse vector');
    const queued = readFileSync(join(srv.dataDir, '_abuse_reports.log'), 'utf8');
    assert.match(queued, /phishing/);

    const unknown = await fetch(`${srv.base}/report/aaaaaaaa`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'x' }),
    });
    assert.equal(unknown.status, 404, 'reporting a non-existent share is a 404');
  } finally { srv.stop(); }
});

test('operator takedown requires the configured token and actually removes', async () => {
  const srv = await startServer({ RWA_ADMIN_TOKEN: 'tok' });
  try {
    const short = await publish(srv.base);
    assert.equal((await fetch(`${srv.base}/admin/takedown/${short}`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${srv.base}/admin/takedown/${short}`, {
      method: 'POST', headers: { authorization: 'Bearer wrong' },
    })).status, 401);
    assert.ok(existsSync(join(srv.dataDir, `${short}.html`)), 'a failed auth must not remove anything');

    const ok = await fetch(`${srv.base}/admin/takedown/${short}`, {
      method: 'POST', headers: { authorization: 'Bearer tok' },
    });
    assert.equal(ok.status, 200);
    assert.ok(!existsSync(join(srv.dataDir, `${short}.html`)), 'takedown removes the document');
    assert.match(readFileSync(join(srv.dataDir, '_takedowns.log'), 'utf8'), new RegExp(short));
  } finally { srv.stop(); }
});

test('without RWA_ADMIN_TOKEN the takedown route does not exist at all', async () => {
  // 404 rather than 401: an unconfigured deploy should not advertise an admin surface, and must not
  // fall back to anything weaker than "off".
  const srv = await startServer();
  try {
    const r = await fetch(`${srv.base}/admin/takedown/abcd1234`, {
      method: 'POST', headers: { authorization: 'Bearer anything' },
    });
    assert.equal(r.status, 404);
  } finally { srv.stop(); }
});
