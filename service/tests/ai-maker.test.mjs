// Tests for /ai/template.html — the carrier template the AI Maker fetches to
// assemble a signed intelligence in the browser (plan T3.1/3.2).
//
// WHY these matter (Rule 9): the maker authors an AI client-side, then builds a
// carrier by string-replacing three markers into a server-provided template. The
// load-bearing invariants of that template are:
//   • it is a REAL rewritable (the bootstrap script must be in the bytes, or the
//     assembled carrier won't boot) served un-cacheable (no-store) so every
//     assembly starts from a fresh container;
//   • it is a skill-host (a carrier IS a skill-host — the same PRODUCT_KIND
//     literal a real signed carrier ships), so the injected role installs;
//   • it carries the three injection markers the client replaces — RWA_MAKER_CARD
//     and RWA_MAKER_ZONE inside INLINE_DOC (the card + the #rwa-agents zone go
//     there) and RWA_MAKER_ROLE in the title/FILE — a missing marker means the
//     client has nowhere to inject and silently ships a blank carrier;
//   • every request mints a FRESH DOC_UUID — two makers assembling at once must
//     not collide on the same per-container IDB namespace.
//
// Harness mirrors ai-gallery.test.mjs: spawn the real server.js on a concrete
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
  const dataDir = mkdtempSync(join(tmpdir(), 'rwa-ai-mkr-'));
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

// ─── 1. A real, un-cacheable, skill-host carrier template ────────────────────

test('GET /ai/template.html → 200 no-store, a real skill-host rewritable with the maker markers', async () => {
  const srv = await startServer();
  try {
    const res = await fetch(srv.base + '/ai/template.html');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control') || '', /no-store/);
    const body = await res.text();
    assert.ok(body.includes('rwa-bootstrap'), 'template is a real rewritable bootstrap');
    // The exact PRODUCT_KIND literal a real signed carrier ships.
    assert.ok(body.includes("const PRODUCT_KIND = 'skill-host'"), 'template is a skill-host carrier');
    assert.ok(body.includes('RWA_MAKER_CARD'), 'card injection marker present in INLINE_DOC');
    assert.ok(body.includes('RWA_MAKER_ZONE'), 'zone injection marker present in INLINE_DOC');
    assert.ok(body.includes('RWA_MAKER_ROLE'), 'role placeholder present in title/FILE');
  } finally { await srv.stop(); }
});

// ─── 2. Fresh DOC_UUID per request ───────────────────────────────────────────

test('GET /ai/template.html mints a fresh DOC_UUID each request', async () => {
  const srv = await startServer();
  try {
    const uuidOf = async () => {
      const body = await (await fetch(srv.base + '/ai/template.html')).text();
      const m = body.match(/const DOC_UUID = '([0-9a-f-]+)'/);
      assert.ok(m, 'template carries a DOC_UUID');
      return m[1];
    };
    const a = await uuidOf();
    const b = await uuidOf();
    assert.notEqual(a, b, 'two requests must not share a per-container UUID');
  } finally { await srv.stop(); }
});
