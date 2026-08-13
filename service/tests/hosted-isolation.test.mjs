// Hosted-edit per-subdomain origin isolation (the /r/ deploy gate, phase 1).
// Design: docs/plans/2026-08-13-hosted-regular-user-flow-design.md §4.1.
//
// WHY: a hosted projection can contain arbitrary interactive <script> (anyone
// can POST /r), and its capability token lives in the projection's
// sessionStorage. Served path-keyed on the apex, all hosted docs shared ONE
// origin, so a hostile /r/A could read /r/B's token. The fix mirrors /s/
// shares: each hosted rwa gets its own origin <id>.rewritable.<tld>, a 12-char
// label DISJOINT from the 8-char share pattern. These tests pin the
// host-dispatch — the browser's same-origin policy does the actual isolating
// once Traefik routes the subdomain (the deploy-gated part, not tested here).
//
// fetch() cannot set the Host header (forbidden), so the subdomain requests are
// made with raw http.request against the loopback server, forging Host — the
// same shape the proxy tests use. Node-logic coverage; the Traefik/DNS/TLS
// routing is the operator's staged deploy step.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const SERVICE = join(dirname(fileURLToPath(import.meta.url)), '..');

function makeRewritable(uuid) {
  return [
    '<!doctype html><html><head><meta charset="utf-8"></head><body>',
    '<div id="rwa-doc-mount"></div>',
    `<script id="rwa-bootstrap">const DOC_UUID = '${uuid}';`,
    'const INLINE_DOC = `<article><p>hosted body</p></article>`;',
    '</script></body></html>',
  ].join('\n');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function startServer(extraEnv = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'rwa-hosted-iso-'));
  const port = await freePort();
  const child = spawn('node', [join(SERVICE, 'server.js')], {
    env: { ...process.env, PORT: String(port), RWA_DATA_DIR: dataDir, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let buf = '';
    const onData = (d) => { buf += d.toString(); if (/listening on :/.test(buf)) { child.stdout.off('data', onData); resolve(); } };
    child.stdout.on('data', onData);
    child.on('exit', (code) => reject(new Error('server exited early ' + code + '\n' + buf)));
    setTimeout(() => reject(new Error('server did not start\n' + buf)), 8000);
  });
  return {
    port, base: `http://127.0.0.1:${port}`,
    async stop() { child.kill('SIGTERM'); await new Promise((r) => child.on('exit', r)); rmSync(dataDir, { recursive: true, force: true }); },
  };
}

// Raw request with a forged Host header (fetch forbids setting Host).
function reqHost(port, { method = 'GET', path = '/', host, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { Host: host, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

async function createHosted(srv) {
  const res = await fetch(srv.base + '/r', { method: 'POST', headers: { 'Content-Type': 'text/html' }, body: makeRewritable('22222222-2222-4222-8222-222222222222') });
  assert.equal(res.status, 200, 'create ok');
  return res.json();
}

test('hosted subdomain serves its own projection at / and its own reads', async () => {
  const srv = await startServer();
  try {
    const { id, token } = await createHosted(srv);
    const H = `${id}.rewritable.ikangai.com`;

    const proj = await reqHost(srv.port, { path: '/', host: H });
    assert.equal(proj.status, 200, 'GET / on the hosted subdomain serves the projection');
    assert.match(proj.body, /rwa-hosted-shim/, 'projection carries the injected hosted shim');
    assert.match(proj.body, /hosted body/, 'projection carries the stored document');

    const desc = await reqHost(srv.port, { path: `/r/${id}/describe`, host: H, headers: { Authorization: `Bearer ${token}` } });
    assert.equal(desc.status, 200, 'own-id read succeeds on the hosted subdomain');
  } finally { await srv.stop(); }
});

test('a hosted subdomain is a clean origin — no apex content, no cross-id access', async () => {
  const srv = await startServer();
  try {
    const { id, token } = await createHosted(srv);
    const other = await createHosted(srv);
    const H = `${id}.rewritable.ikangai.com`;

    // Apex content must not be reachable on the hosted origin.
    for (const path of ['/new', '/import', '/metrics', '/skills/index']) {
      const r = await reqHost(srv.port, { path, host: H });
      assert.equal(r.status, 404, `apex ${path} must 404 on a hosted origin (clean origin)`);
    }
    // Minting endpoints must not bounce off the hosted origin.
    const pub = await reqHost(srv.port, { method: 'POST', path: '/publish', host: H, headers: { 'Content-Type': 'text/html' }, body: makeRewritable('33333333-3333-4333-8333-333333333333') });
    assert.notEqual(pub.status, 201, 'POST /publish must not mint on a hosted origin');
    const cre = await reqHost(srv.port, { method: 'POST', path: '/r', host: H, headers: { 'Content-Type': 'text/html' }, body: makeRewritable('44444444-4444-4444-8444-444444444444') });
    assert.notEqual(cre.status, 200, 'POST /r must not create on a hosted origin');

    // Cross-id access on this origin is refused even with a valid token.
    const cross = await reqHost(srv.port, { path: `/r/${other.id}/describe`, host: H, headers: { Authorization: `Bearer ${other.token}` } });
    assert.equal(cross.status, 404, 'a hosted origin serves ONLY its own id');
    const crossW = await reqHost(srv.port, { method: 'POST', path: `/r/${other.id}/modify`, host: H, headers: { Authorization: `Bearer ${other.token}`, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(crossW.status, 404, 'a hosted origin writes ONLY its own id');
  } finally { await srv.stop(); }
});

test('production apex redirects the projection to the isolated subdomain', async () => {
  const srv = await startServer();
  try {
    const { id } = await createHosted(srv);
    // A non-local Host (prod shape) + forwarded https → 301 to the subdomain.
    const r = await reqHost(srv.port, { path: `/r/${id}`, host: 'rewritable.ikangai.com', headers: { 'X-Forwarded-Proto': 'https' } });
    assert.equal(r.status, 301, 'apex projection redirects in production');
    assert.equal(r.headers.location, `https://${id}.rewritable.ikangai.com/`, 'redirect targets the isolated origin (fragment reattaches client-side)');
  } finally { await srv.stop(); }
});

test('local dev still serves the projection path-keyed (wildcard DNS is not local)', async () => {
  const srv = await startServer();
  try {
    const { id } = await createHosted(srv);
    // 127.0.0.1 is local → path-keyed serve, no redirect (the create url proved this too).
    const r = await fetch(`${srv.base}/r/${id}`);
    assert.equal(r.status, 200, 'dev path-keyed projection still works');
    assert.match(await r.text(), /rwa-hosted-shim/);
  } finally { await srv.stop(); }
});
