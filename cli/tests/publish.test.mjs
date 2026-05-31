// Tests for the `rwa publish <file>` CLI verb — a thin client for the service's
// `POST /publish` snapshot-publishing endpoint (service/server.js).
//
// Why this verb exists: a rewritable created with `rwa new` and edited locally
// had no one-command path to a hosted share URL — the service's /publish was
// only reachable from the browser UIs (new.html / import.html), which publish a
// FRESH or NEWLY-CONVERTED container, never the user's edited file. `rwa publish`
// closes that: create → edit → publish → share URL.
//
// These tests pin the contract a user/agent relies on, not just the bytes:
//   - the EDITED INLINE_DOC bytes go over the wire (the whole point)
//   - fail-fast LOCALLY (exit 2) before any network call on a non-rewritable
//   - every remote failure is exit 4 with an honest `publish_error/<subcode>`
//   - target URL precedence: --url > RWA_PUBLISH_URL > hardcoded default
//
// No test touches the real network: network cases stand up an ephemeral
// node:http stub (same zero-dep stack as the service) and point --url /
// RWA_PUBLISH_URL at it. The real rewritable.ikangai.com default is never called.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replaceInlineDoc } from '../src/seed.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RWA_BIN = join(__dirname, '..', 'bin', 'rwa.mjs');

function runRwa(args, { env = {} } = {}) {
  return new Promise(resolve => {
    const child = spawn('node', [RWA_BIN, ...args], { env: { ...process.env, ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.stdin.end();
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

// Build a real rewritable fixture with a known INLINE_DOC body, exactly as
// doc.test.mjs does: `rwa new` lays down a valid bootstrap, replaceInlineDoc
// swaps in the body via the production splice.
function mkFixture(inlineDocBody = '<article><h1>Hello</h1><p>Body.</p></article>') {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-publish-test-'));
  const path = join(dir, 'test.html');
  execFileSync('node', [RWA_BIN, 'new', path], { stdio: 'pipe' });
  const current = readFileSync(path, 'utf8');
  writeFileSync(path, replaceInlineDoc(current, inlineDocBody), 'utf8');
  return { path, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Ephemeral /publish stub. Records every request (method, url, host, body) and
// returns a canned (status, json). `requests` lets a test assert what the CLI
// actually sent — and, for fail-fast, that it sent NOTHING.
function startStub({ status = 201, json = null } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        host: req.headers.host,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(json !== null ? JSON.stringify(json) : '');
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

const OK_BODY = {
  short: 'ab12cd34',
  url: 'https://ab12cd34.rewritable.ikangai.com/',
  expiresAt: 1748736000000,
};

// ─── Happy path ───────────────────────────────────────────────────────

test('201 → exit 0, prints the share URL', async () => {
  const stub = await startStub({ status: 201, json: OK_BODY });
  const fx = mkFixture('<article><h1>Publish Me</h1></article>');
  try {
    const { code, stdout } = await runRwa(['publish', fx.path, '--url', stub.url]);
    assert.equal(code, 0);
    // The user's whole reason for running this command is to get the URL.
    assert.match(stdout, /https:\/\/ab12cd34\.rewritable\.ikangai\.com\//);
  } finally { fx.cleanup(); await stub.close(); }
});

test('POSTs the EDITED INLINE_DOC bytes to /publish, not a fresh seed', async () => {
  // The defining behavior: publish must send the user's locally-edited document,
  // distinguishing this verb from new.html (fresh) / import.html (converted).
  const MARKER = 'UNIQUE-EDITED-MARKER-7F3A';
  const stub = await startStub({ status: 201, json: OK_BODY });
  const fx = mkFixture(`<article><h1>${MARKER}</h1><p>local edit</p></article>`);
  try {
    const { code } = await runRwa(['publish', fx.path, '--url', stub.url]);
    assert.equal(code, 0);
    assert.equal(stub.requests.length, 1);
    assert.equal(stub.requests[0].method, 'POST');
    assert.match(stub.requests[0].url, /\/publish$/);
    assert.ok(stub.requests[0].body.includes(MARKER),
      'the stub must receive the edited INLINE_DOC bytes');
  } finally { fx.cleanup(); await stub.close(); }
});

test('--json emits the server object verbatim on stdout', async () => {
  const stub = await startStub({ status: 201, json: OK_BODY });
  const fx = mkFixture();
  try {
    const { code, stdout } = await runRwa(['publish', fx.path, '--url', stub.url, '--json']);
    assert.equal(code, 0);
    const payload = JSON.parse(stdout.trim());
    assert.equal(payload.short, OK_BODY.short);
    assert.equal(payload.url, OK_BODY.url);
    assert.equal(payload.expiresAt, OK_BODY.expiresAt);
  } finally { fx.cleanup(); await stub.close(); }
});

// ─── Target URL resolution: --url > RWA_PUBLISH_URL > default ──────────

test('--url beats RWA_PUBLISH_URL', async () => {
  const live = await startStub({ status: 201, json: OK_BODY });
  const decoy = await startStub({ status: 500, json: { error: 'should_not_be_hit' } });
  const fx = mkFixture();
  try {
    const { code } = await runRwa(['publish', fx.path, '--url', live.url],
      { env: { RWA_PUBLISH_URL: decoy.url } });
    assert.equal(code, 0);
    assert.equal(live.requests.length, 1, '--url target must receive the POST');
    assert.equal(decoy.requests.length, 0, 'env target must be ignored when --url is set');
  } finally { fx.cleanup(); await live.close(); await decoy.close(); }
});

test('RWA_PUBLISH_URL is used when --url is absent', async () => {
  const stub = await startStub({ status: 201, json: OK_BODY });
  const fx = mkFixture();
  try {
    const { code } = await runRwa(['publish', fx.path], { env: { RWA_PUBLISH_URL: stub.url } });
    assert.equal(code, 0);
    assert.equal(stub.requests.length, 1);
  } finally { fx.cleanup(); await stub.close(); }
});

// ─── Local fail-fast (exit 2, no network) ─────────────────────────────

test('non-rewritable → exit 2 not_a_rewritable, and NO network call', async () => {
  // Fail-fast intent: a bad file is rejected locally before any round trip.
  const stub = await startStub({ status: 201, json: OK_BODY });
  const dir = mkdtempSync(join(tmpdir(), 'rwa-publish-test-'));
  const path = join(dir, 'plain.html');
  writeFileSync(path, '<!doctype html><html><body><p>just a page</p></body></html>', 'utf8');
  try {
    const { code, stdout, stderr } = await runRwa(['publish', path, '--url', stub.url]);
    assert.equal(code, 2);
    assert.match(stderr, /not_a_rewritable/);
    assert.equal(stdout, '');
    assert.equal(stub.requests.length, 0, 'must not POST a non-rewritable');
  } finally { rmSync(dir, { recursive: true, force: true }); await stub.close(); }
});

test('missing file → exit 2 not_found', async () => {
  const { code, stdout, stderr } = await runRwa(['publish', '/tmp/does-not-exist-rwa-pub.html']);
  assert.equal(code, 2);
  assert.match(stderr, /not_found/);
  assert.equal(stdout, '');
});

test('no file arg → exit 1 missing_file_arg', async () => {
  const { code, stderr } = await runRwa(['publish']);
  assert.equal(code, 1);
  assert.match(stderr, /missing_file_arg/);
});

// ─── Remote failures (exit 4, publish_error/<subcode>) ────────────────

for (const [status, body, subcode] of [
  [400, { error: 'validation_failed', detail: 'not a container' }, 'validation_failed'],
  [413, { error: 'body_too_large', maxBytes: 1024 }, 'body_too_large'],
  [429, { error: 'rate_limited', retryAfterSec: 60 }, 'rate_limited'],
  [500, { error: 'storage_failed' }, 'server_error'],
  [503, { error: 'collision' }, 'server_error'],
]) {
  test(`HTTP ${status} → exit 4 publish_error/${subcode}`, async () => {
    const stub = await startStub({ status, json: body });
    const fx = mkFixture();
    try {
      const { code, stdout, stderr } = await runRwa(['publish', fx.path, '--url', stub.url]);
      assert.equal(code, 4);
      assert.equal(stdout, '', 'errors go to stderr; stdout stays clean');
      assert.match(stderr, /publish_error/);
      assert.match(stderr, new RegExp(subcode));
    } finally { fx.cleanup(); await stub.close(); }
  });
}

test('connection refused → exit 4 publish_error/network_error', async () => {
  const stub = await startStub({ status: 201, json: OK_BODY });
  const deadUrl = stub.url;
  await stub.close(); // nothing listens on that port now
  const fx = mkFixture();
  try {
    const { code, stderr } = await runRwa(['publish', fx.path, '--url', deadUrl]);
    assert.equal(code, 4);
    assert.match(stderr, /network_error/);
  } finally { fx.cleanup(); }
});

test('--json error is structured JSON on stderr (not stdout)', async () => {
  const stub = await startStub({ status: 400, json: { error: 'validation_failed', detail: 'bad' } });
  const fx = mkFixture();
  try {
    const { code, stdout, stderr } = await runRwa(['publish', fx.path, '--url', stub.url, '--json']);
    assert.equal(code, 4);
    assert.equal(stdout, '');
    const payload = JSON.parse(stderr.trim());
    assert.equal(payload.code, 'publish_error');
    assert.equal(payload.subcode, 'validation_failed');
  } finally { fx.cleanup(); await stub.close(); }
});
