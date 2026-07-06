// Tests for the /ai gallery — the curated drop-in-AI storefront (plan T2.3/2.4).
//
// WHY these matter (Rule 9): the gallery is how a non-author acquires an
// intelligence. The load-bearing invariants are:
//   • GET /ai serves a real page that names every curated role AND links to the
//     maker CTA — a card that doesn't list a role, or a page with no path to
//     author one, is a broken storefront;
//   • each carrier download is served as an ATTACHMENT (a rewritable is a file
//     you save + drop, never a page you view) and is a REAL signed carrier
//     (the rwa-agent+json record must be in the bytes, or dropping it installs
//     nothing);
//   • an unknown /ai/<name> must 404 (not leak, not 500) and traversal
//     (/ai/..%2fserver.js) must NOT reach disk — the carrier Map IS the
//     allowlist, so a decoded key that isn't a carrier resolves to nothing and
//     the server source is never served;
//   • the landing rename is complete: the new AI-gallery link exists, the demo
//     link is relabelled Examples, and the old ">Gallery<" label is fully gone
//     (a half-done rename leaves two competing "Gallery" meanings).
//
// Harness mirrors share.test.mjs: spawn the real server.js on a concrete
// ephemeral port with a temp DATA_DIR and drive it over fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICE = join(__dirname, '..');

const ROLES = ['concise-editor', 'proofreader', 'translator', 'presentation-coach', 'playful-rewriter'];

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

async function startServer() {
  const dataDir = mkdtempSync(join(tmpdir(), 'rwa-ai-srv-'));
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
    async stop() {
      child.kill('SIGTERM');
      await new Promise((r) => child.on('exit', r));
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// ─── 1. The gallery page ─────────────────────────────────────────────────────

test('GET /ai serves the gallery page: hero, every role, and the maker CTA', async () => {
  const srv = await startServer();
  try {
    const res = await fetch(srv.base + '/ai');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    const body = await res.text();
    assert.ok(body.includes('Drop-in AI'), 'hero names the product');
    for (const role of ROLES) {
      assert.ok(body.includes(role), `gallery lists ${role}`);
    }
    assert.ok(body.includes('href="/ai/maker"'), 'gallery links to the maker CTA');
  } finally { await srv.stop(); }
});

// ─── 2. Carrier download — real, signed, served as an attachment ─────────────

test('GET /ai/<role>.intelligence.html downloads the real signed carrier as an attachment', async () => {
  const srv = await startServer();
  try {
    const res = await fetch(srv.base + '/ai/proofreader.intelligence.html');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') || '', /attachment/);
    const body = await res.text();
    assert.ok(body.includes('rwa-agent+json'), 'a real carrier carries the signed rwa-agent record');
  } finally { await srv.stop(); }
});

// ─── 3. Unknown carrier 404s ─────────────────────────────────────────────────

test('GET /ai/nope.intelligence.html → 404 (not in the carrier allowlist)', async () => {
  const srv = await startServer();
  try {
    const res = await fetch(srv.base + '/ai/nope.intelligence.html');
    assert.equal(res.status, 404);
  } finally { await srv.stop(); }
});

// ─── 4. Traversal is structurally impossible (Map-as-allowlist) ─────────────

test('GET /ai/..%2fserver.js → 404 and never leaks server source', async () => {
  const srv = await startServer();
  try {
    // %2f stays encoded through the URL parser, so this is a single path
    // segment "..%2fserver.js" — not a carrier key, so it 404s and the
    // server source (never a disk read at request time) is never served.
    const res = await fetch(srv.base + '/ai/..%2fserver.js');
    assert.equal(res.status, 404);
    const body = await res.text();
    assert.ok(!body.includes('createServer'), 'server source must not be served');
  } finally { await srv.stop(); }
});

// ─── 5. Landing rename: Gallery → Examples + new AI Gallery link ────────────

test('GET / — landing links to /ai, relabels the demo Examples, and drops the old Gallery label', async () => {
  const srv = await startServer();
  try {
    const res = await fetch(srv.base + '/');
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes('href="/ai"'), 'landing links to the AI gallery');
    assert.ok(body.includes('Examples'), 'the demo link is relabelled Examples');
    assert.ok(!body.includes('>Gallery<'), 'the old demo "Gallery" label is gone');
  } finally { await srv.stop(); }
});
