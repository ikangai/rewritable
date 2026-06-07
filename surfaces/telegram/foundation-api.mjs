// Zero-dep HTTP client for the hosted-edit foundation service (Telegram Phase B).
// The foundation is plain HTTPS+JSON, so this is just typed `fetch` wrappers — no
// npm deps, only node built-ins + global fetch. The contract is godel's fixed
// contract-of-record; this client builds to those exact wire shapes.
//
// One seam keeps the whole thing offline-testable (mirroring `telegram-api.mjs`):
// `fetchImpl` (default `globalThis.fetch`). `baseUrl` is the foundation origin.
//
// SECURITY — token redaction: every per-rwa call carries a bearer token in the
// `Authorization` header (a leaked token === write access to that rwa). The token
// must NEVER reach a thrown error's message or stack. So no error string ever
// interpolates the token, the URL, or the headers — errors name the foundation's
// own `error` subcode + HTTP status only. A raw fetch rejection is especially
// dangerous: its message can carry the token-bearing request, so every `await`
// against the wire is re-wrapped, never re-thrown raw. Enforced by
// `foundation-api.test.mjs`, which asserts the token is absent across both an
// HTTP-error path and a raw-rejection path.

export class FoundationError extends Error {
  // `code` is the foundation's `error` subcode (e.g. 'stale_base',
  // 'frozen_zone_violation', 'unauthorized') or a client-side code. `status` is
  // the HTTP status. `detail`/`currentHash` are carried when the contract sends
  // them (422 detail, 409 currentHash). The message is the code only — never the
  // URL/token/headers.
  constructor(code, { status, detail, currentHash } = {}) {
    super(code == null ? 'foundation_error' : String(code));
    this.name = 'FoundationError';
    this.code = code;
    if (status !== undefined) this.status = status;
    if (detail !== undefined) this.detail = detail;
    if (currentHash !== undefined) this.currentHash = currentHash;
  }
}

export function makeFoundationApi(baseUrl, { fetchImpl = globalThis.fetch } = {}) {
  // Trim a single trailing slash so `${base}/r` never doubles up.
  const base = String(baseUrl).replace(/\/+$/, '');

  // Parse a response body as JSON; null on any failure (empty body, non-JSON).
  // Used only to read the `error`/`detail`/`currentHash` envelope on error paths
  // and the success payloads — never interpolated into an error string.
  async function readJson(res) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  // Map a non-2xx response to a FoundationError. `fallbackCode` is used when the
  // body carries no `error` subcode (or there is no body at all, e.g. a bare
  // 404). The message names only the code + status — never the URL/token.
  function errorFromResponse(res, data, fallbackCode) {
    const code = (data && typeof data.error === 'string') ? data.error : fallbackCode;
    return new FoundationError(code, {
      status: res.status,
      detail: data ? data.detail : undefined,
      currentHash: data ? data.currentHash : undefined,
    });
  }

  // Perform a request and return the raw Response. Re-wraps a raw fetch
  // rejection: the raw error can carry the token-bearing URL/headers, so it must
  // never escape verbatim. Names the operation only.
  async function doFetch(url, opts, op) {
    try {
      return await fetchImpl(url, opts);
    } catch {
      throw new FoundationError('request_failed', { status: 0, detail: op });
    }
  }

  // CREATE: POST raw .html bytes as text/html → { id, token, url }.
  // 400 → not_a_rewritable. No auth (this mints the token).
  async function createDoc(bytes) {
    const res = await doFetch(`${base}/r`, {
      method: 'POST',
      headers: { 'content-type': 'text/html' },
      body: bytes,
    }, 'create');
    const data = await readJson(res);
    if (!res.ok) throw errorFromResponse(res, data, 'create_failed');
    return data;
  }

  // Shared authed GET returning parsed JSON.
  async function authedGetJson(id, token, path, op) {
    const res = await doFetch(`${base}/r/${id}/${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    }, op);
    const data = await readJson(res);
    if (!res.ok) throw errorFromResponse(res, data, `${op}_failed`);
    return data;
  }

  // READ: GET /r/<id>/doc → { doc, baseHash, selfDescription }.
  async function readDoc(id, token) {
    return authedGetJson(id, token, 'doc', 'read');
  }

  // DESCRIBE: GET /r/<id>/describe → <self-description/1 obj>.
  async function describe(id, token) {
    return authedGetJson(id, token, 'describe', 'describe');
  }

  // EXPORT: GET /r/<id>/export → canonical .html bytes (TEXT body, NOT json).
  async function exportDoc(id, token) {
    const res = await doFetch(`${base}/r/${id}/export`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    }, 'export');
    if (!res.ok) {
      const data = await readJson(res);
      throw errorFromResponse(res, data, 'export_failed');
    }
    try {
      return await res.text();
    } catch {
      // A body-read rejection can carry the token-bearing request — re-wrap.
      throw new FoundationError('read_failed', { status: res.status, detail: 'export' });
    }
  }

  // MODIFY: POST /r/<id>/modify, body EXACTLY { envelope, baseHash, actor }
  // (actor omitted if undefined) → { doc, baseHash, selfDescription, histLen }.
  // Error map: 409 stale_base(+currentHash) / 422 <subcode>(+detail) /
  // 401 unauthorized / 404 not_found / 400 bad_request — each carrying status.
  async function modify(id, token, { envelope, baseHash, actor } = {}) {
    const payload = { envelope, baseHash };
    if (actor !== undefined) payload.actor = actor;
    const res = await doFetch(`${base}/r/${id}/modify`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    }, 'modify');
    const data = await readJson(res);
    if (!res.ok) {
      // The contract's subcodes (stale_base/frozen_zone_violation/find_not_found/
      // unauthorized/bad_request) ride in `data.error`; a bare 404 has no body, so
      // map by status. errorFromResponse prefers data.error, falling back to the
      // per-status default below.
      const byStatus = { 409: 'stale_base', 422: 'modify_failed', 401: 'unauthorized', 404: 'not_found', 400: 'bad_request' };
      throw errorFromResponse(res, data, byStatus[res.status] ?? 'modify_failed');
    }
    return data;
  }

  return { createDoc, readDoc, describe, exportDoc, modify };
}
