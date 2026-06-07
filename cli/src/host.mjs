// `rwa host <file>` — ingest a local rewritable into a hosted runtime's `POST /r`
// (service/server.js handleHostedCreate) and print the `{id, token, url}` the
// server mints. The url carries the capability token in its `#k=` fragment — the
// only way the user keeps editing the hosted copy — so it is printed verbatim.
//
// This is the network-bearing INGEST client (the round-trip-edit foundation),
// the way `rwa publish` is the ephemeral-share client. Online by design (the
// offline-first invariant of new/import does not apply to a host action), so —
// like `clone`/`publish-site` — it is excluded from the offline-first rule.
//
// Design parity:
//   - flags-over-env config (--url > $RWA_HOST_URL), nothing baked in — like
//     publish-site's RWA_SITE_*.
//   - injected transport ({transport, env}) so tests run offline — the same
//     deps-seam shape publish-site uses for {execFile, env}. The default
//     transport is a real node:http/node:https POST.
//   - CliError exit codes: 2 file_error (not_found/read_error/not_a_rewritable),
//     1 config_error (no url), 4 host_error (transport/HTTP failure, carrying the
//     server's status/body verbatim). The bin labels exit 4 `host_error`.
//
// Security: only the file bytes are sent — a rewritable carries NO secret (the
// API key is sessionStorage-only, never in the file). The returned token is
// surfaced to stdout (the bin) and nowhere else.

import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { extractInlineDoc } from './seed.mjs';
import { CliError } from './edit.mjs';

// Default transport: a single POST over node:http / node:https. Returns the raw
// status + body text; hostFile owns all status/JSON interpretation so the seam
// stays dumb and the contract lives in one place. Network failures reject — the
// caller maps them to host_error/network_error.
//
// @param {string} url — the full POST target (already includes the /r path)
// @param {{method:string, headers:object, body:string}} opts
// @returns {Promise<{status:number, body:string}>}
function defaultTransport(url, { method, headers, body }) {
  const u = new URL(url);
  const request = u.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(u, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

/**
 * Read, locally validate, and POST a rewritable's bytes to `<baseUrl>/r`.
 *
 * @param {string} filePath
 * @param {{url?:string, transport?:Function, env?:object}} [deps]
 *   url      — base url override (flag); falls back to env.RWA_HOST_URL
 *   transport— injection seam ((url, opts) => {status, body}); defaults to a
 *              real node:http/https POST
 *   env      — env source (tests inject); defaults to process.env
 * @returns {Promise<{id:string, token:string, url:string}>} the server's 200 object
 * @throws {CliError} 2 file_error · 1 config_error · 4 host_error
 */
export async function hostFile(filePath, deps = {}) {
  const env = deps.env || process.env;
  const transport = deps.transport || defaultTransport;

  // 1. Read — identical CliError file_error surface to publish.mjs / publish-site.mjs.
  let bytes;
  try {
    bytes = await readFile(filePath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') throw new CliError(2, 'not_found', { path: filePath });
    throw new CliError(2, 'read_error', { path: filePath, errno: e && e.code, message: e && e.message });
  }

  // 2. Local fail-fast: is this even a rewritable? Same gate as `rwa publish`.
  // The server re-validates authoritatively (it returns 400 not_a_rewritable);
  // this just avoids a wasted round trip and gives an offline-detectable error.
  try {
    extractInlineDoc(bytes);
  } catch {
    throw new CliError(2, 'not_a_rewritable', { path: filePath });
  }

  // 3. Config: flag url > $RWA_HOST_URL; nothing is baked into the package.
  const urlBase = deps.url || env.RWA_HOST_URL;
  if (!urlBase) throw new CliError(1, 'config_error', { missing: ['RWA_HOST_URL'] });

  // 4. POST the raw bytes to <base>/r. text/html is the honest label for the
  // payload (the server reads the body raw; service/server.js ignores
  // content-type but is honest about what we send).
  const endpoint = `${urlBase.replace(/\/+$/, '')}/r`;
  let res;
  try {
    res = await transport(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: bytes,
    });
  } catch (e) {
    throw new CliError(4, 'network_error', { url: endpoint, message: (e && e.message) || String(e) });
  }

  // Body may be empty or non-JSON on some error paths — parse defensively.
  let payload = null;
  if (res.body) { try { payload = JSON.parse(res.body); } catch { payload = null; } }

  if (res.status === 200) {
    if (!payload || typeof payload.id !== 'string' || typeof payload.token !== 'string' || typeof payload.url !== 'string') {
      throw new CliError(4, 'malformed_success_response', { status: 200 });
    }
    return { id: payload.id, token: payload.token, url: payload.url };
  }

  // Map the server's error envelope to an honest subcode. Prefer the server's
  // own `error` name when present; carry the status + maxBytes verbatim so the
  // user sees WHY ingest failed.
  const errName = payload && typeof payload.error === 'string' ? payload.error : null;
  if (res.status === 413 || errName === 'body_too_large') {
    throw new CliError(4, 'body_too_large', { maxBytes: payload && payload.maxBytes });
  }
  throw new CliError(4, 'server_error', { status: res.status, error: errName });
}
