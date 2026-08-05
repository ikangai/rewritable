// Aggregate usage counters — GET /metrics (#15).
//
// WHY (Rule 9): the service recorded nothing. No telemetry, by choice — but also no request
// logging, so there was no evidence about whether ANY feature is used: skins, workflows, the
// artifact bus, the AI gallery, hosted edit. Every roadmap decision was intuition, and the
// project's own "no spec for unmeasured problems" discipline cannot distinguish "this doesn't
// need solving" from "we have no way to know".
//
// The privacy shape is the load-bearing part and is what these assertions actually defend: route
// FAMILY totals only, in memory, with no per-user dimension. A future change that starts recording
// an IP, a user agent, a referrer, or a per-container id turns an operational counter into
// tracking, which is a different thing than what was agreed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const SERVICE = join(dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function startServer() {
  const dataDir = mkdtempSync(join(tmpdir(), 'rwa-metrics-'));
  const port = await freePort();
  const child = spawn('node', [join(SERVICE, 'server.js')], {
    env: { ...process.env, PORT: String(port), RWA_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 8000);
    child.stdout.on('data', (d) => {
      if (/listening on/.test(String(d))) { clearTimeout(t); resolve(); }
    });
    child.on('exit', (c) => { clearTimeout(t); reject(new Error('server exited ' + c)); });
  });
  const base = `http://127.0.0.1:${port}`;
  return { base, stop: () => child.kill() };
}

test('/metrics counts route families and exposes nothing about anyone', async () => {
  const srv = await startServer();
  try {
    const zero = await (await fetch(`${srv.base}/metrics`)).json();
    assert.equal(zero.since, 'process-start');
    assert.equal(typeof zero.counts, 'object');

    await fetch(`${srv.base}/`);
    await fetch(`${srv.base}/`);
    await fetch(`${srv.base}/ai`);

    const after = await (await fetch(`${srv.base}/metrics`)).json();
    assert.equal(after.counts.landing, 2, 'landing hits counted');
    assert.equal(after.counts.ai, 1, 'ai hits counted');

    // The privacy contract: aggregate integers keyed by route family, nothing else. If a future
    // change adds an ip/ua/referrer/container dimension, this fails — which is the point.
    for (const [key, value] of Object.entries(after.counts)) {
      assert.match(key, /^[a-z-]+$/, `counter key "${key}" should be a route family, not an identifier`);
      assert.equal(typeof value, 'number', `counter "${key}" should be a plain count`);
    }
    const serialized = JSON.stringify(after);
    for (const forbidden of ['127.0.0.1', 'ip', 'userAgent', 'referer', 'referrer', 'uuid']) {
      assert.ok(!serialized.toLowerCase().includes(forbidden.toLowerCase()),
        `/metrics must not expose "${forbidden}"`);
    }
  } finally { srv.stop(); }
});

test('static assets and unknown paths are not counted', async () => {
  const srv = await startServer();
  try {
    await fetch(`${srv.base}/definitely-not-a-route-xyz`);
    const m = await (await fetch(`${srv.base}/metrics`)).json();
    assert.equal(Object.keys(m.counts).length, 0,
      'a 404 should not create a counter — only known route families are interesting');
  } finally { srv.stop(); }
});
