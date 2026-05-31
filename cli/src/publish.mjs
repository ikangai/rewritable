// `rwa publish <file>` — publish a local rewritable to the service's snapshot
// endpoint (`POST /publish`, service/server.js) and return the share URL.
//
// This is a THIN, honest client for an endpoint that already exists. The only
// first-class path for "share MY locally-edited file": create with `rwa new`,
// edit locally, `rwa publish`. The browser UIs (new.html / import.html) publish
// a fresh or newly-converted container — never the user's edited bytes.
//
// Unlike `rwa new`/`rwa import`, this command is intentionally ONLINE; the
// offline-first invariant does not apply to a publish action.
//
// Failure surface mirrors `rwa doc`/`rwa edit`: local file problems reuse the
// CliError `file_error` codes (exit 2); every remote/network failure is exit 4
// with an honest subcode (the bin labels exit 4 `publish_error`, not the shared
// `agent_error`). The server's own `validateContainer` stays the single source
// of validation truth — the local check here is only fail-fast.

import { readFile } from 'node:fs/promises';
import { extractInlineDoc } from './seed.mjs';
import { CliError } from './edit.mjs';

// Hardcoded production default. Overridable via --url (bin) or RWA_PUBLISH_URL.
export const DEFAULT_PUBLISH_URL = 'https://rewritable.ikangai.com';

/**
 * Read, locally validate, and POST a rewritable's bytes to `<baseUrl>/publish`.
 *
 * @param {string} filePath
 * @param {{ baseUrl?: string }} [opts] - baseUrl is the service ORIGIN; the
 *   `/publish` path is appended here. Falls back to DEFAULT_PUBLISH_URL.
 * @returns {Promise<{short:string, url:string, expiresAt:number}>} the server's
 *   success object on 201.
 * @throws {CliError} exit 2 (file_error: not_found/read_error/not_a_rewritable)
 *   before any network call; exit 4 on every remote/network failure.
 */
export async function publishCmd(filePath, { baseUrl } = {}) {
  // 1. Read — identical CliError file_error surface to doc.mjs.
  let bytes;
  try {
    bytes = await readFile(filePath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') throw new CliError(2, 'not_found', { path: filePath });
    throw new CliError(2, 'read_error', { path: filePath, errno: e && e.code, message: e && e.message });
  }

  // 2. Local fail-fast: is this even a rewritable? Same gate as `rwa doc`.
  // The server re-validates authoritatively; this just avoids a wasted round
  // trip and gives an offline-detectable error.
  try {
    extractInlineDoc(bytes);
  } catch {
    throw new CliError(2, 'not_a_rewritable', { path: filePath });
  }

  // 3. POST the raw bytes. The server reads the body raw and ignores
  // content-type; text/html is the honest label for the payload.
  const base = (baseUrl || DEFAULT_PUBLISH_URL).replace(/\/+$/, '');
  const endpoint = `${base}/publish`;
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: bytes,
    });
  } catch (e) {
    throw new CliError(4, 'network_error', { url: endpoint, message: (e && e.message) || String(e) });
  }

  // Body may be empty or non-JSON on some error paths — parse defensively.
  const text = await res.text();
  let payload = null;
  if (text) { try { payload = JSON.parse(text); } catch { payload = null; } }

  if (res.status === 201) {
    if (!payload || typeof payload.url !== 'string') {
      throw new CliError(4, 'server_error', { status: 201, error: 'malformed_success_response' });
    }
    return payload; // { short, url, expiresAt }
  }

  // Map the server's error envelope to an honest subcode. Prefer the server's
  // own `error` name when present, fall back to the HTTP status.
  const errName = payload && typeof payload.error === 'string' ? payload.error : null;
  if (res.status === 413 || errName === 'body_too_large') {
    throw new CliError(4, 'body_too_large', { maxBytes: payload && payload.maxBytes });
  }
  if (res.status === 429 || errName === 'rate_limited') {
    throw new CliError(4, 'rate_limited', { retryAfterSec: payload && payload.retryAfterSec });
  }
  if (res.status === 400) {
    throw new CliError(4, 'validation_failed', { detail: payload && payload.detail, error: errName });
  }
  if (res.status >= 500) {
    throw new CliError(4, 'server_error', { status: res.status, error: errName });
  }
  throw new CliError(4, 'unexpected_status', { status: res.status, error: errName });
}
