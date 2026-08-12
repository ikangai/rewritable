// `rwa proxy` — local OpenRouter key broker.
//
// The container's security posture keeps the API key in sessionStorage: per
// tab, never persisted, because a received document's own script can read
// anything the page can reach (docs/received-container-threat-model). The
// cost is re-pasting the key in every tab. This broker removes the key from
// the browser ENTIRELY instead of persisting it there: a loopback HTTP
// service injects the Authorization header server-side, and containers talk
// to it through the existing KEYLESS local-backend path (Ollama/LM Studio
// preset + base URL override) — zero seed changes.
//
// Network-bearing by design, like `clone` and `publish-site` — the
// offline-first rule explicitly excludes it.
//
// Threat notes, stated honestly:
// - The key at rest: ~/.rwa/openrouter-key, mode 600 (dir 700), or env.
//   `rwa proxy set-key` reads it from stdin so it never lands in argv or
//   shell history.
// - While the broker runs, any LOCAL process and any file:// page on this
//   machine can spend through it (same exposure class as running Ollama).
//   Browser drive-by from the web is blocked by the Origin policy below.
// - Origin policy: requests with no Origin (curl, native), Origin "null"
//   (file:// containers — the primary consumer) and explicitly allowlisted
//   origins pass; any other web origin gets 403. A https page you happen to
//   visit cannot burn your credits.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { Readable } from 'node:stream';

export const DEFAULT_PORT = 11435;
export const DEFAULT_UPSTREAM = 'https://openrouter.ai/api/v1';

export function defaultKeyFile(env = process.env) {
  return path.join(env.RWA_HOME || path.join(os.homedir(), '.rwa'), 'openrouter-key');
}

// env wins over the key file: ephemeral overrides should not require touching
// the stored key. Returns null when neither is set — callers fail loud.
// `conflict` flags the trap this design was born from: a FORGOTTEN dead env
// key silently shadowing a fresh set-key file (observed live 2026-08-12 —
// the shell profile still carried a key revoked two days earlier).
export function resolveProxyKey({ env = process.env, keyFile = defaultKeyFile(env) } = {}) {
  const fromEnv = (env.RWA_OPENROUTER_KEY || env.OPENROUTER_API_KEY || '').trim();
  let fromFile = '';
  try { fromFile = fs.readFileSync(keyFile, 'utf8').trim(); } catch (_) { /* absent = not configured */ }
  if (fromEnv) return { key: fromEnv, source: 'env', conflict: !!fromFile && fromFile !== fromEnv };
  if (fromFile) return { key: fromFile, source: keyFile, conflict: false };
  return null;
}

// Prove the key actually authenticates before serving it to every container on
// this machine. OpenRouter's /models is public, so a dead key still "works"
// until the first completion — the exact silent failure the fidelity harness
// hit twice. GET /auth/key is the cheapest authenticated endpoint.
export async function validateKey({ key, upstream = DEFAULT_UPSTREAM } = {}) {
  const url = upstream.replace(/\/+$/, '') + '/auth/key';
  try {
    const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + key } });
    if (r.ok) return { ok: true };
    const body = await r.json().catch(() => ({}));
    return { ok: false, status: r.status, message: (body.error && body.error.message) || r.statusText };
  } catch (err) {
    return { ok: false, status: 0, message: 'upstream unreachable — ' + (err && err.message) };
  }
}

export function writeKeyFile(keyFile, key) {
  const dir = path.dirname(keyFile);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyFile, key.trim() + '\n', { mode: 0o600 });
  // mkdir/write modes are ignored if dir/file pre-existed — enforce.
  fs.chmodSync(dir, 0o700);
  fs.chmodSync(keyFile, 0o600);
}

// Host-header gate — always on. DNS rebinding turns a web page's fetch to
// http://attacker.example:PORT into a SAME-ORIGIN request that arrives here
// with no Origin header at all; the Host header still names the attacker's
// domain, so this check defeats the whole class regardless of origin policy.
function hostAllowed(host, port) {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`
    || (port === 80 && (host === '127.0.0.1' || host === 'localhost'));
}

// Origin: null is file:// containers — the primary consumer — but ALSO
// sandboxed iframes on arbitrary websites, so it is not proof of localness.
// Default allow (the tool exists for file:// pages; modern browsers gate
// public→loopback via Local Network Access on top), opt out with
// --no-null-origin for hosted-only setups.
function originAllowed(origin, allowlist, { allowNullOrigin = true } = {}) {
  if (origin === undefined || origin === '') return true; // native/local tools (Host gate already passed)
  if (origin === 'null') return allowNullOrigin;
  return allowlist.includes(origin);
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin === undefined || origin === '' ? '*' : origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

// Start the broker. Injectable upstream keeps the tests offline.
// Returns { server, port, close }.
export async function startProxy({ port = DEFAULT_PORT, key, upstream = DEFAULT_UPSTREAM, allowOrigins = [], allowNullOrigin = true, log = () => {} } = {}) {
  if (!key) throw new Error('startProxy: key is required');
  const base = upstream.replace(/\/+$/, '');

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const url = (req.url || '').split('?')[0];

    if (!hostAllowed(req.headers.host, server.address().port)) {
      log(`403 host ${req.headers.host} ${req.method} ${url} (DNS-rebinding shape)`);
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'host not allowed by rwa proxy', code: 403 } }));
    }
    if (!originAllowed(origin, allowOrigins, { allowNullOrigin })) {
      log(`403 origin ${origin} ${req.method} ${url}`);
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'origin not allowed by rwa proxy', code: 403 } }));
    }
    const cors = corsHeaders(origin);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      return res.end();
    }

    const routes = { 'GET /v1/models': '/models', 'POST /v1/chat/completions': '/chat/completions' };
    const target = routes[`${req.method} ${url}`];
    if (!target) {
      res.writeHead(404, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'rwa proxy serves /v1/models and /v1/chat/completions', code: 404 } }));
    }

    const chunks = [];
    for await (const c of req) chunks.push(c);
    try {
      const r = await fetch(base + target, {
        method: req.method,
        headers: {
          // The whole point: the ONLY Authorization upstream ever sees is ours.
          'Authorization': 'Bearer ' + key,
          ...(req.headers['content-type'] ? { 'Content-Type': req.headers['content-type'] } : {}),
          'HTTP-Referer': 'https://github.com/ikangai/rewritable',
          'X-Title': 're-write-able proxy',
        },
        body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
      });
      res.writeHead(r.status, {
        ...cors,
        'Content-Type': r.headers.get('content-type') || 'application/json',
      });
      if (r.body) Readable.fromWeb(r.body).pipe(res);
      else res.end();
      log(`${r.status} ${req.method} ${url}${origin !== undefined ? ' origin=' + origin : ''}`);
    } catch (err) {
      log(`upstream error ${req.method} ${url}: ${err && err.message}`);
      res.writeHead(502, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'rwa proxy: upstream unreachable — ' + (err && err.message), code: 502 } }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { server, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

// Prompt for the key without echoing it, then store it 600.
export async function setKeyCmd({ keyFile = defaultKeyFile(), input = process.stdin, output = process.stderr } = {}) {
  let key = '';
  if (input.isTTY) {
    output.write('Paste your OpenRouter key (input hidden): ');
    input.setRawMode(true);
    key = await new Promise((resolve) => {
      let buf = '';
      const onData = (ch) => {
        const s = ch.toString('utf8');
        for (const c of s) {
          if (c === '\n' || c === '\r') { input.setRawMode(false); input.off('data', onData); input.pause(); output.write('\n'); return resolve(buf); }
          if (c === '\u0003') { input.setRawMode(false); process.exit(130); } // Ctrl-C
          if (c === '\u007f' || c === '\b') { buf = buf.slice(0, -1); continue; } // Backspace/DEL
          buf += c;
        }
      };
      input.on('data', onData);
    });
  } else {
    key = await new Promise((resolve) => {
      let buf = '';
      input.on('data', (c) => { buf += c; });
      input.on('end', () => resolve(buf.split('\n')[0]));
    });
  }
  key = key.trim();
  if (!key) { const e = new Error('empty key'); e.exitCode = 1; e.subcode = 'empty_key'; throw e; }
  writeKeyFile(keyFile, key);
  return { keyFile };
}
