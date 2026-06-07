// Tests for `rwa host <file>` — the network-bearing INGEST client for a hosted
// runtime's `POST /r` (service/server.js handleHostedCreate). It reads a local
// rewritable's bytes and POSTs them; the server mints an id + capability token
// and returns `{id, token, url}` (the url carries the token in its `#k=`
// fragment). `rwa host` is the foundation for round-trip hosted editing.
//
// The transport (an HTTP POST) is a real network side-effect, so hostFile takes
// a deps seam ({transport, env}) — mirrors publish-site's ({execFile, env})
// seam. These tests inject a FAKE transport that records the request and returns
// a controlled response, so nothing touches the real network (offline, Rule:
// offline-first excludes `host` only because it's network-bearing in prod).
//
// What these pin (the contract a user/agent relies on, per Rule 9):
//   - the file's bytes go over the wire as the POST body with text/html
//   - fail-fast LOCALLY (exit 2) on a non-rewritable BEFORE any POST (assert the
//     fake transport was never called) — ingesting a non-rewritable is a no-op
//   - a missing url (no --url, no $RWA_HOST_URL) is a named config_error (exit 1)
//   - on 200 {id,token,url} we return/print those fields; --json emits them as
//     one object on stdout (the url is the only way the user keeps editing)
//   - any transport throw or non-200 status is exit 4 host_error carrying the
//     server's status/body verbatim (the user must see WHY ingest failed)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replaceInlineDoc } from '../src/seed.mjs';
import { hostFile } from '../src/host.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RWA_BIN = join(__dirname, '..', 'bin', 'rwa.mjs');

// A real rewritable on disk (same approach as publish-site.test.mjs / doc.test.mjs):
// `rwa new` lays a valid bootstrap, replaceInlineDoc swaps the body via the
// production splice. Returns a path + cleanup.
function mkFixture(name = 'test.html', body = '<article><h1>Hi</h1><p>Body.</p></article>') {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-host-'));
  const path = join(dir, name);
  execFileSync('node', [RWA_BIN, 'new', path], { stdio: 'pipe' });
  writeFileSync(path, replaceInlineDoc(readFileSync(path, 'utf8'), body), 'utf8');
  return { path, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const OK = { id: 'abc12345', token: 'cap-tok-XYZ', url: 'http://host/r/abc12345#k=cap-tok-XYZ' };

// A fake transport that records calls and resolves a canned (status, body).
// Signature mirrors the real default: (url, {body, headers}) => {status, body}.
function fakeTransport({ status = 200, json = OK } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return { status, body: json === null ? '' : JSON.stringify(json) };
  };
  return { fn, calls };
}

const URL_OPT = { url: 'http://hosted.example' };

// ─── hostFile() unit contract (injected transport, no bin) ────────────────

test('success: POSTs the file bytes to <url>/r as text/html, returns {id,token,url}', async () => {
  const MARKER = 'UNIQUE-HOST-MARKER-9C2D';
  const fx = mkFixture('test.html', `<article><h1>${MARKER}</h1></article>`);
  const { fn, calls } = fakeTransport();
  try {
    const r = await hostFile(fx.path, { transport: fn, url: 'http://hosted.example' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://hosted.example/r', 'POST target is <base>/r');
    assert.equal(calls[0].opts.method, 'POST');
    assert.match(calls[0].opts.headers['Content-Type'], /text\/html/);
    assert.ok(calls[0].opts.body.includes(MARKER), 'the file bytes go over the wire');
    assert.deepEqual(r, OK);
  } finally { fx.cleanup(); }
});

test('fail-fast: a non-rewritable is rejected (exit 2) BEFORE any POST', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-host-'));
  const path = join(dir, 'plain.html');
  writeFileSync(path, '<!doctype html><p>not a rewritable</p>', 'utf8');
  const { fn, calls } = fakeTransport();
  try {
    await assert.rejects(
      () => hostFile(path, { transport: fn, ...URL_OPT }),
      (e) => e.exitCode === 2 && e.subcode === 'not_a_rewritable',
    );
    assert.equal(calls.length, 0, 'must not POST a non-rewritable');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('missing file → not_found (exit 2), transport never called', async () => {
  const { fn, calls } = fakeTransport();
  await assert.rejects(
    () => hostFile('/no/such/host-file.html', { transport: fn, ...URL_OPT }),
    (e) => e.exitCode === 2 && e.subcode === 'not_found',
  );
  assert.equal(calls.length, 0);
});

test('no url (no flag, no env) → config_error (exit 1), transport never called', async () => {
  const fx = mkFixture();
  const { fn, calls } = fakeTransport();
  try {
    await assert.rejects(
      () => hostFile(fx.path, { transport: fn, env: {} }), // no url, empty env
      (e) => e.exitCode === 1 && e.subcode === 'config_error'
        && e.details.missing.includes('RWA_HOST_URL'),
    );
    assert.equal(calls.length, 0, 'no target → no round trip');
  } finally { fx.cleanup(); }
});

test('url resolution: --url-style opt beats $RWA_HOST_URL', async () => {
  const fx = mkFixture();
  const { fn, calls } = fakeTransport();
  try {
    await hostFile(fx.path, { transport: fn, url: 'http://flag.host', env: { RWA_HOST_URL: 'http://env.host' } });
    assert.ok(calls[0].url.startsWith('http://flag.host/r'), 'flag url wins over env');
  } finally { fx.cleanup(); }
});

test('url resolution: $RWA_HOST_URL is used when no opt url is given', async () => {
  const fx = mkFixture();
  const { fn, calls } = fakeTransport();
  try {
    await hostFile(fx.path, { transport: fn, env: { RWA_HOST_URL: 'http://env.host' } });
    assert.equal(calls[0].url, 'http://env.host/r');
  } finally { fx.cleanup(); }
});

test('trailing slash in the base url is normalized (no //r)', async () => {
  const fx = mkFixture();
  const { fn, calls } = fakeTransport();
  try {
    await hostFile(fx.path, { transport: fn, url: 'http://hosted.example/' });
    assert.equal(calls[0].url, 'http://hosted.example/r');
  } finally { fx.cleanup(); }
});

test('transport throw (connection error) → host_error (exit 4) carrying the cause', async () => {
  const fx = mkFixture();
  const fn = async () => { throw new Error('ECONNREFUSED 127.0.0.1:1'); };
  try {
    await assert.rejects(
      () => hostFile(fx.path, { transport: fn, ...URL_OPT }),
      (e) => e.exitCode === 4 && e.subcode === 'network_error'
        && /ECONNREFUSED/.test(e.details.message),
    );
  } finally { fx.cleanup(); }
});

test('non-200 (400 not_a_rewritable from server) → host_error (exit 4) carrying status + server error', async () => {
  const fx = mkFixture();
  const { fn } = fakeTransport({ status: 400, json: { error: 'not_a_rewritable' } });
  try {
    await assert.rejects(
      () => hostFile(fx.path, { transport: fn, ...URL_OPT }),
      (e) => e.exitCode === 4 && e.subcode === 'server_error'
        && e.details.status === 400 && e.details.error === 'not_a_rewritable',
    );
  } finally { fx.cleanup(); }
});

test('413 body_too_large → host_error (exit 4) with the named subcode', async () => {
  const fx = mkFixture();
  const { fn } = fakeTransport({ status: 413, json: { error: 'body_too_large', maxBytes: 1024 } });
  try {
    await assert.rejects(
      () => hostFile(fx.path, { transport: fn, ...URL_OPT }),
      (e) => e.exitCode === 4 && e.subcode === 'body_too_large' && e.details.maxBytes === 1024,
    );
  } finally { fx.cleanup(); }
});

test('200 with a malformed body (missing fields) → host_error (exit 4) malformed_success_response', async () => {
  const fx = mkFixture();
  const { fn } = fakeTransport({ status: 200, json: { id: 'x' } }); // no token/url
  try {
    await assert.rejects(
      () => hostFile(fx.path, { transport: fn, ...URL_OPT }),
      (e) => e.exitCode === 4 && e.subcode === 'malformed_success_response',
    );
  } finally { fx.cleanup(); }
});

// ─── bin integration: `rwa host` (real default transport over a node:http stub) ─

function runRwa(args, env = {}) {
  return new Promise(res => {
    const c = spawn('node', [RWA_BIN, ...args], { env: { ...process.env, ...env } });
    let stdout = '', stderr = '';
    c.stdout.on('data', d => stdout += d); c.stderr.on('data', d => stderr += d);
    c.stdin.end(); c.on('close', code => res({ code, stdout, stderr }));
  });
}

// Ephemeral /r stub — exercises the REAL default node:http transport end-to-end
// (the bin can't take an injected transport, so this is the only place a real
// socket is used; it's a loopback stub, never the real network).
function startStub({ status = 200, json = OK } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, host: req.headers.host,
        contentType: req.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(json !== null ? JSON.stringify(json) : '');
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, requests, close: () => new Promise(r => server.close(r)) });
    });
  });
}

test('bin: 200 → exit 0, prints id/token/url; the url keeps the editing fragment', async () => {
  const stub = await startStub({ status: 200, json: OK });
  const fx = mkFixture();
  try {
    const { code, stdout } = await runRwa(['host', fx.path, '--url', stub.url]);
    assert.equal(code, 0);
    assert.match(stdout, /abc12345/);
    assert.match(stdout, /#k=cap-tok-XYZ/, 'the capability url must be printed verbatim');
    assert.equal(stub.requests.length, 1);
    assert.equal(stub.requests[0].method, 'POST');
    assert.match(stub.requests[0].url, /\/r$/);
    assert.match(stub.requests[0].contentType, /text\/html/);
  } finally { fx.cleanup(); await stub.close(); }
});

test('bin: --json emits the {id,token,url} object on stdout', async () => {
  const stub = await startStub({ status: 200, json: OK });
  const fx = mkFixture();
  try {
    const { code, stdout } = await runRwa(['host', fx.path, '--url', stub.url, '--json']);
    assert.equal(code, 0);
    const payload = JSON.parse(stdout.trim());
    assert.deepEqual(payload, OK);
  } finally { fx.cleanup(); await stub.close(); }
});

test('bin: $RWA_HOST_URL is used when --url is absent', async () => {
  const stub = await startStub({ status: 200, json: OK });
  const fx = mkFixture();
  try {
    const { code } = await runRwa(['host', fx.path], { RWA_HOST_URL: stub.url });
    assert.equal(code, 0);
    assert.equal(stub.requests.length, 1);
  } finally { fx.cleanup(); await stub.close(); }
});

test('bin: no file arg → usage_error (exit 1)', async () => {
  const r = await runRwa(['host']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /rwa host: usage_error\/missing_file_arg/);
});

test('bin: no url (no flag, no env) → config_error (exit 1), nothing sent', async () => {
  const fx = mkFixture();
  const r = await runRwa(['host', fx.path], { RWA_HOST_URL: '' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /rwa host: usage_error\/config_error/);
  fx.cleanup();
});

test('bin: non-rewritable → exit 2 not_a_rewritable, no network call', async () => {
  const stub = await startStub({ status: 200, json: OK });
  const dir = mkdtempSync(join(tmpdir(), 'rwa-host-'));
  const path = join(dir, 'plain.html');
  writeFileSync(path, '<!doctype html><p>just a page</p>', 'utf8');
  try {
    const { code, stdout, stderr } = await runRwa(['host', path, '--url', stub.url]);
    assert.equal(code, 2);
    assert.match(stderr, /not_a_rewritable/);
    assert.equal(stdout, '');
    assert.equal(stub.requests.length, 0, 'must not POST a non-rewritable');
  } finally { rmSync(dir, { recursive: true, force: true }); await stub.close(); }
});

test('bin: HTTP 400 → exit 4 host_error/server_error on stderr; stdout clean', async () => {
  const stub = await startStub({ status: 400, json: { error: 'not_a_rewritable' } });
  const fx = mkFixture();
  try {
    const { code, stdout, stderr } = await runRwa(['host', fx.path, '--url', stub.url]);
    assert.equal(code, 4);
    assert.equal(stdout, '');
    assert.match(stderr, /host_error/);
    assert.match(stderr, /server_error/);
  } finally { fx.cleanup(); await stub.close(); }
});

test('bin: connection refused → exit 4 host_error/network_error', async () => {
  const stub = await startStub();
  const deadUrl = stub.url;
  await stub.close(); // nothing listens now
  const fx = mkFixture();
  try {
    const { code, stderr } = await runRwa(['host', fx.path, '--url', deadUrl]);
    assert.equal(code, 4);
    assert.match(stderr, /network_error/);
  } finally { fx.cleanup(); }
});

test('bin: --json error is structured JSON on stderr (not stdout)', async () => {
  const stub = await startStub({ status: 400, json: { error: 'not_a_rewritable' } });
  const fx = mkFixture();
  try {
    const { code, stdout, stderr } = await runRwa(['host', fx.path, '--url', stub.url, '--json']);
    assert.equal(code, 4);
    assert.equal(stdout, '');
    const payload = JSON.parse(stderr.trim());
    assert.equal(payload.code, 'host_error');
    assert.equal(payload.subcode, 'server_error');
  } finally { fx.cleanup(); await stub.close(); }
});
