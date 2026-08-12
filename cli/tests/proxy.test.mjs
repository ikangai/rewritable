// `rwa proxy` — local OpenRouter key broker (2026-08-12).
//
// WHY: the container posture keeps the API key per-tab (sessionStorage) because
// a received document's script can read anything the page reaches — the cost is
// re-pasting the key in every tab. The broker removes the key from the browser
// entirely; these tests pin the three properties that make that SAFE:
//   1. upstream only ever sees OUR key — a client-supplied Authorization is
//      discarded, never forwarded;
//   2. web origins are refused (a drive-by https page cannot spend the key)
//      while file:// containers (Origin: null) and local tools pass;
//   3. the key at rest is 600 in a 700 dir, and set-key never touches argv.
// Everything runs against a local stub upstream — no network.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { startProxy, resolveProxyKey, writeKeyFile, setKeyCmd, defaultKeyFile, validateKey } from '../src/proxy.mjs';

let stub, stubPort, proxy, seen;

before(async () => {
  seen = [];
  stub = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    seen.push({ url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ upstream: req.url, gotAuth: req.headers.authorization }));
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  stubPort = stub.address().port;
  proxy = await startProxy({
    port: 0,
    key: 'sk-test-broker',
    upstream: `http://127.0.0.1:${stubPort}`,
    allowOrigins: ['https://ok.example'],
  });
});

after(async () => {
  await proxy.close();
  await new Promise((r) => stub.close(r));
});

const call = (p, opts = {}) => fetch(`http://127.0.0.1:${proxy.port}${p}`, opts);

test('injects the broker key upstream', async () => {
  const r = await call('/v1/models');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.gotAuth, 'Bearer sk-test-broker');
  assert.equal(j.upstream, '/models');
});

test('a client-supplied Authorization is discarded, never forwarded', async () => {
  await call('/v1/models', { headers: { Authorization: 'Bearer sk-CLIENT-LEAK' } });
  const last = seen[seen.length - 1];
  assert.equal(last.auth, 'Bearer sk-test-broker');
});

test('file:// containers (Origin: null) pass with CORS', async () => {
  const r = await call('/v1/models', { headers: { Origin: 'null' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), 'null');
});

test('an arbitrary web origin is refused before reaching upstream', async () => {
  const n = seen.length;
  const r = await call('/v1/chat/completions', {
    method: 'POST',
    headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(r.status, 403);
  assert.equal(seen.length, n, 'upstream must not be contacted');
});

test('an allowlisted origin passes', async () => {
  const r = await call('/v1/models', { headers: { Origin: 'https://ok.example' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://ok.example');
});

test('preflight answers 204 with the CORS contract', async () => {
  const r = await call('/v1/chat/completions', { method: 'OPTIONS', headers: { Origin: 'null' } });
  assert.equal(r.status, 204);
  assert.match(r.headers.get('access-control-allow-headers'), /Content-Type/);
});

test('POST bodies round-trip through the pipe', async () => {
  const body = JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi ü' }] });
  const r = await call('/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  });
  assert.equal(r.status, 200);
  assert.equal(seen[seen.length - 1].body, body);
  assert.equal(seen[seen.length - 1].url, '/chat/completions');
});

test('DNS-rebinding shape (foreign Host, no Origin) is refused before upstream', async () => {
  const n = seen.length;
  // fetch() pins Host to the URL, so speak raw HTTP to forge the header.
  const status = await new Promise((resolve, reject) => {
    const sock = http.request({
      host: '127.0.0.1', port: proxy.port, path: '/v1/models', method: 'GET',
      headers: { Host: `attacker.example:${proxy.port}` },
    }, (res) => resolve(res.statusCode));
    sock.on('error', reject);
    sock.end();
  });
  assert.equal(status, 403);
  assert.equal(seen.length, n, 'upstream must not be contacted');
});

test('--no-null-origin refuses sandboxed-iframe-shaped callers', async () => {
  const strict = await startProxy({
    port: 0, key: 'sk-strict', upstream: `http://127.0.0.1:${stubPort}`, allowNullOrigin: false,
  });
  try {
    const r = await fetch(`http://127.0.0.1:${strict.port}/v1/models`, { headers: { Origin: 'null' } });
    assert.equal(r.status, 403);
    const ok = await fetch(`http://127.0.0.1:${strict.port}/v1/models`);
    assert.equal(ok.status, 200, 'local tools still pass under strict mode');
  } finally {
    await strict.close();
  }
});

test('unknown paths 404 without touching upstream', async () => {
  const n = seen.length;
  const r = await call('/v1/embeddings', { method: 'POST', body: '{}' });
  assert.equal(r.status, 404);
  assert.equal(seen.length, n);
});

test('key resolution: env beats file, file beats nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rwa-proxy-'));
  const kf = path.join(dir, 'openrouter-key');
  assert.equal(resolveProxyKey({ env: {}, keyFile: kf }), null);
  writeKeyFile(kf, 'sk-from-file');
  assert.deepEqual(resolveProxyKey({ env: {}, keyFile: kf }), { key: 'sk-from-file', source: kf, conflict: false });
  assert.equal(resolveProxyKey({ env: { RWA_OPENROUTER_KEY: 'sk-env' }, keyFile: kf }).key, 'sk-env');
});

test('a shadowing env key that differs from the stored key is flagged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rwa-proxy-'));
  const kf = path.join(dir, 'openrouter-key');
  writeKeyFile(kf, 'sk-fresh');
  const r = resolveProxyKey({ env: { OPENROUTER_API_KEY: 'sk-stale-env' }, keyFile: kf });
  assert.equal(r.source, 'env');
  assert.equal(r.conflict, true, 'the dead-env-key-shadows-fresh-file trap must be visible');
  const same = resolveProxyKey({ env: { OPENROUTER_API_KEY: 'sk-fresh' }, keyFile: kf });
  assert.equal(same.conflict, false);
});

test('validateKey distinguishes a live key from a dead one', async () => {
  const auth = http.createServer((req, res) => {
    if (req.url === '/auth/key' && req.headers.authorization === 'Bearer sk-live') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{"data":{}}');
    }
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{"error":{"message":"User not found."}}');
  });
  await new Promise((r) => auth.listen(0, '127.0.0.1', r));
  const u = `http://127.0.0.1:${auth.address().port}`;
  try {
    assert.equal((await validateKey({ key: 'sk-live', upstream: u })).ok, true);
    const dead = await validateKey({ key: 'sk-dead', upstream: u });
    assert.equal(dead.ok, false);
    assert.equal(dead.status, 401);
    assert.match(dead.message, /User not found/);
  } finally {
    await new Promise((r) => auth.close(r));
  }
});

test('key file lands 600 in a 700 dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rwa-proxy-'));
  const kf = path.join(dir, 'sub', 'openrouter-key');
  writeKeyFile(kf, 'sk-perms');
  assert.equal(fs.statSync(kf).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(kf)).mode & 0o777, 0o700);
});

test('set-key reads stdin (non-TTY) and stores the first line', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rwa-proxy-'));
  const kf = path.join(dir, 'openrouter-key');
  const input = Readable.from(['sk-piped-key\nrest ignored\n']);
  input.isTTY = false;
  await setKeyCmd({ keyFile: kf, input, output: { write: () => {} } });
  assert.equal(fs.readFileSync(kf, 'utf8').trim(), 'sk-piped-key');
});

test('RWA_HOME steers the default key file location', () => {
  assert.equal(defaultKeyFile({ RWA_HOME: '/x/y' }), path.join('/x/y', 'openrouter-key'));
});
