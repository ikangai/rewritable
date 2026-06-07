// Tests for foundation-api.mjs — the zero-dep hosted-edit foundation HTTP client.
//
// Every test injects a fake `fetchImpl` so the suite runs fully offline — no real
// network, no real disk. Assertions check the RECORDED url + method + headers +
// parsed body shape, not merely that a call didn't throw: the whole point of this
// module is putting the right request on the wire against godel's fixed
// contract-of-record, so a test that can't observe the wire can't fail when the
// wire shape drifts (Rule 9).
//
// The foundation contract is FIXED. These tests pin the EXACT shapes:
//   - per-rwa auth: `Authorization: Bearer <token>` on every call
//   - modify body is EXACTLY {envelope, baseHash, actor} (actor omitted if undefined)
//   - the full error-status map: 409 stale_base(+currentHash) / 422 <subcode>(+detail)
//     / 401 unauthorized / 404 not_found / 400 bad_request — each carrying `status`
//   - SECURITY: the per-rwa token NEVER reaches a thrown error's message/stack/String.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFoundationApi, FoundationError } from './foundation-api.mjs';

const BASE = 'https://foundation.example.test';
const TOKEN = 'fnd_live_super-secret-per-rwa-token-DEADBEEF';

// A fake fetch that records each call and replays a queued scripted response.
// Each scripted entry is either a Response-like object or a function returning one
// (or throwing, to drive the raw-rejection path).
function makeFakeFetch(scripts) {
  const calls = [];
  const queue = [...scripts];
  const fetchImpl = async (url, opts = {}) => {
    let parsedBody;
    if (opts.body != null) {
      try { parsedBody = JSON.parse(opts.body); } catch { parsedBody = opts.body; }
    }
    calls.push({ url, method: opts.method, headers: opts.headers, body: parsedBody, rawBody: opts.body });
    const next = queue.shift();
    if (next === undefined) throw new Error('fake fetch: no scripted response left');
    if (typeof next === 'function') return next();
    return next;
  };
  return { fetchImpl, calls };
}

// Response-like for JSON endpoints.
function jsonResponse(payload, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([['content-type', 'application/json']]),
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

// Response-like for the export endpoint (text/html body, not json).
function textResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([['content-type', 'text/html']]),
    text: async () => body,
    json: async () => { throw new Error('not json'); },
  };
}

// Read a header regardless of Headers/Map (.get) or plain object.
function hdr(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

// --- createDoc -------------------------------------------------------------

test('createDoc POSTs raw html bytes as text/html and returns {id,token,url}', async () => {
  const bytes = '<!doctype html><html>...rewritable...</html>';
  const { fetchImpl, calls } = makeFakeFetch([
    jsonResponse({ id: 'abc123', token: 'tok_new', url: `${BASE}/r/abc123` }),
  ]);
  const api = makeFoundationApi(BASE, { fetchImpl });

  const result = await api.createDoc(bytes);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${BASE}/r`);
  assert.equal(calls[0].method, 'POST');
  assert.equal(hdr(calls[0].headers, 'content-type'), 'text/html');
  assert.equal(calls[0].rawBody, bytes, 'body must be the raw bytes, not JSON-wrapped');
  assert.deepEqual(result, { id: 'abc123', token: 'tok_new', url: `${BASE}/r/abc123` });
});

test('createDoc maps 400 to FoundationError code not_a_rewritable carrying status', async () => {
  const { fetchImpl } = makeFakeFetch([
    jsonResponse({ error: 'not_a_rewritable' }, { status: 400 }),
  ]);
  const api = makeFoundationApi(BASE, { fetchImpl });

  await assert.rejects(
    () => api.createDoc('<html>not a rwa</html>'),
    (err) => {
      assert.ok(err instanceof FoundationError);
      assert.equal(err.code, 'not_a_rewritable');
      assert.equal(err.status, 400);
      return true;
    },
  );
});

// --- readDoc ---------------------------------------------------------------

test('readDoc GETs /r/<id>/doc with Bearer auth and returns {doc,baseHash,selfDescription}', async () => {
  const payload = { doc: 'line1\nline2', baseHash: 'a'.repeat(64), selfDescription: { rwa: 'self-description/1' } };
  const { fetchImpl, calls } = makeFakeFetch([jsonResponse(payload)]);
  const api = makeFoundationApi(BASE, { fetchImpl });

  const result = await api.readDoc('abc123', TOKEN);

  assert.equal(calls[0].url, `${BASE}/r/abc123/doc`);
  assert.equal(calls[0].method, 'GET');
  assert.equal(hdr(calls[0].headers, 'authorization'), `Bearer ${TOKEN}`);
  assert.deepEqual(result, payload);
});

// --- describe --------------------------------------------------------------

test('describe GETs /r/<id>/describe with Bearer auth and returns the object', async () => {
  const sd = { rwa: 'self-description/1', kind: 'document', affordances: [] };
  const { fetchImpl, calls } = makeFakeFetch([jsonResponse(sd)]);
  const api = makeFoundationApi(BASE, { fetchImpl });

  const result = await api.describe('abc123', TOKEN);

  assert.equal(calls[0].url, `${BASE}/r/abc123/describe`);
  assert.equal(calls[0].method, 'GET');
  assert.equal(hdr(calls[0].headers, 'authorization'), `Bearer ${TOKEN}`);
  assert.deepEqual(result, sd);
});

// --- exportDoc -------------------------------------------------------------

test('exportDoc GETs /r/<id>/export with Bearer auth and returns the TEXT body (not json)', async () => {
  const html = '<!doctype html><html>canonical export bytes</html>';
  const { fetchImpl, calls } = makeFakeFetch([textResponse(html)]);
  const api = makeFoundationApi(BASE, { fetchImpl });

  const result = await api.exportDoc('abc123', TOKEN);

  assert.equal(calls[0].url, `${BASE}/r/abc123/export`);
  assert.equal(calls[0].method, 'GET');
  assert.equal(hdr(calls[0].headers, 'authorization'), `Bearer ${TOKEN}`);
  assert.equal(result, html, 'export returns the raw text body, never parsed as JSON');
});

// --- modify ----------------------------------------------------------------

test('modify POSTs EXACTLY {envelope,baseHash,actor} and returns the modify result', async () => {
  const envelope = { tool: 'apply_edits', edits: [{ find: 'a', replace: 'b' }] };
  const out = { doc: 'b\n', baseHash: 'b'.repeat(64), selfDescription: { rwa: 'self-description/1' }, histLen: 3 };
  const { fetchImpl, calls } = makeFakeFetch([jsonResponse(out)]);
  const api = makeFoundationApi(BASE, { fetchImpl });

  const result = await api.modify('abc123', TOKEN, { envelope, baseHash: 'a'.repeat(64), actor: 'bridge:claude-p' });

  assert.equal(calls[0].url, `${BASE}/r/abc123/modify`);
  assert.equal(calls[0].method, 'POST');
  assert.equal(hdr(calls[0].headers, 'authorization'), `Bearer ${TOKEN}`);
  assert.equal(hdr(calls[0].headers, 'content-type'), 'application/json');
  assert.deepEqual(calls[0].body, { envelope, baseHash: 'a'.repeat(64), actor: 'bridge:claude-p' });
  // The body must be EXACTLY those three keys.
  assert.deepEqual(Object.keys(calls[0].body).sort(), ['actor', 'baseHash', 'envelope']);
  assert.deepEqual(result, out);
});

test('modify omits actor from the body when it is undefined', async () => {
  const envelope = { tool: 'apply_edits', edits: [] };
  const { fetchImpl, calls } = makeFakeFetch([
    jsonResponse({ doc: 'x', baseHash: 'c'.repeat(64), selfDescription: {}, histLen: 1 }),
  ]);
  const api = makeFoundationApi(BASE, { fetchImpl });

  await api.modify('abc123', TOKEN, { envelope, baseHash: 'a'.repeat(64) });

  assert.deepEqual(Object.keys(calls[0].body).sort(), ['baseHash', 'envelope']);
  assert.ok(!('actor' in calls[0].body), 'actor must be absent, not present-and-undefined');
});

test('modify maps 409 to stale_base carrying currentHash and status', async () => {
  const current = 'f'.repeat(64);
  const { fetchImpl } = makeFakeFetch([
    jsonResponse({ error: 'stale_base', currentHash: current }, { status: 409 }),
  ]);
  const api = makeFoundationApi(BASE, { fetchImpl });

  await assert.rejects(
    () => api.modify('abc123', TOKEN, { envelope: {}, baseHash: 'a'.repeat(64) }),
    (err) => {
      assert.ok(err instanceof FoundationError);
      assert.equal(err.code, 'stale_base');
      assert.equal(err.currentHash, current);
      assert.equal(err.status, 409);
      return true;
    },
  );
});

test('modify maps 422 to the subcode carrying detail and status', async () => {
  const { fetchImpl } = makeFakeFetch([
    jsonResponse({ error: 'frozen_zone_violation', detail: 'zone "header" is immutable' }, { status: 422 }),
  ]);
  const api = makeFoundationApi(BASE, { fetchImpl });

  await assert.rejects(
    () => api.modify('abc123', TOKEN, { envelope: {}, baseHash: 'a'.repeat(64) }),
    (err) => {
      assert.ok(err instanceof FoundationError);
      assert.equal(err.code, 'frozen_zone_violation');
      assert.equal(err.detail, 'zone "header" is immutable');
      assert.equal(err.status, 422);
      return true;
    },
  );
});

test('modify maps 401 to unauthorized, 404 to not_found, 400 to bad_request (each with status)', async () => {
  for (const [status, payload, code] of [
    [401, { error: 'unauthorized' }, 'unauthorized'],
    [404, '', 'not_found'],
    [400, { error: 'bad_request' }, 'bad_request'],
  ]) {
    const resp = typeof payload === 'string'
      ? { ok: false, status, headers: new Map(), json: async () => { throw new Error('no json'); }, text: async () => payload }
      : jsonResponse(payload, { status });
    const { fetchImpl } = makeFakeFetch([resp]);
    const api = makeFoundationApi(BASE, { fetchImpl });
    const err = await api.modify('abc123', TOKEN, { envelope: {}, baseHash: 'h' }).then(() => null, (e) => e);
    assert.ok(err instanceof FoundationError, `status ${status} should throw FoundationError`);
    assert.equal(err.code, code, `status ${status} should map to ${code}`);
    assert.equal(err.status, status, `status ${status} should be carried`);
  }
});

// --- token redaction (load-bearing) ---------------------------------------

test('the per-rwa token never appears in a thrown error (HTTP-error path)', async () => {
  // An auth failure on an authed endpoint — the canonical HTTP-error path.
  const { fetchImpl } = makeFakeFetch([jsonResponse({ error: 'unauthorized' }, { status: 401 })]);
  const api = makeFoundationApi(BASE, { fetchImpl });

  const err = await api.readDoc('abc123', TOKEN).then(() => null, (e) => e);
  assert.ok(err instanceof FoundationError, 'expected FoundationError');
  assert.ok(!String(err).includes(TOKEN), 'String(err) leaked token (http)');
  assert.ok(!err.message.includes(TOKEN), 'err.message leaked token (http)');
  assert.ok(!String(err.stack || '').includes(TOKEN), 'err.stack leaked token (http)');
});

test('the per-rwa token never appears in a thrown error (raw fetch rejection re-wrap)', async () => {
  // A raw fetch rejection can carry the request URL/headers — which on authed
  // calls bear the token. The re-wrap must NOT re-throw the raw error verbatim.
  const leaky = () => {
    throw new Error(`ECONNRESET while fetching with Authorization: Bearer ${TOKEN}`);
  };
  const { fetchImpl } = makeFakeFetch([leaky]);
  const api = makeFoundationApi(BASE, { fetchImpl });

  const err = await api.readDoc('abc123', TOKEN).then(() => null, (e) => e);
  assert.ok(err instanceof FoundationError, 'raw rejection must surface as FoundationError, not a raw error');
  assert.ok(!String(err).includes(TOKEN), 'String(err) leaked token (raw reject)');
  assert.ok(!err.message.includes(TOKEN), 'err.message leaked token (raw reject)');
  assert.ok(!String(err.stack || '').includes(TOKEN), 'err.stack leaked token (raw reject)');
});

test('token redaction also holds on a raw rejection from a body-bearing POST (modify)', async () => {
  // POST paths interpolate nothing, but the raw rejection still bears the token
  // via the request it was fetching — re-wrap on the POST path too.
  const leaky = () => { throw new Error(`socket hang up Bearer ${TOKEN}`); };
  const { fetchImpl } = makeFakeFetch([leaky]);
  const api = makeFoundationApi(BASE, { fetchImpl });

  const err = await api.modify('abc123', TOKEN, { envelope: {}, baseHash: 'h' }).then(() => null, (e) => e);
  assert.ok(err instanceof FoundationError, 'raw rejection must surface as FoundationError');
  assert.ok(!String(err).includes(TOKEN), 'String(err) leaked token (modify raw reject)');
  assert.ok(!err.message.includes(TOKEN), 'err.message leaked token (modify raw reject)');
});

test('exportDoc body-read rejection is re-wrapped and never leaks the token', async () => {
  // A 200 export whose body read (res.text()) throws — the rejection can carry the
  // token-bearing request. exportDoc must re-wrap, not surface the raw error. This
  // is the one re-wrap site the other tests don't exercise (body-read, not fetch).
  const okButUnreadable = {
    ok: true,
    status: 200,
    headers: new Map([['content-type', 'text/html']]),
    text: async () => { throw new Error(`stream aborted mid-body Bearer ${TOKEN}`); },
    json: async () => { throw new Error('not json'); },
  };
  const { fetchImpl } = makeFakeFetch([okButUnreadable]);
  const api = makeFoundationApi(BASE, { fetchImpl });

  const err = await api.exportDoc('abc123', TOKEN).then(() => null, (e) => e);
  assert.ok(err instanceof FoundationError, 'body-read rejection must surface as FoundationError');
  assert.equal(err.code, 'read_failed', 'export body-read failure has code read_failed');
  assert.ok(!String(err).includes(TOKEN), 'String(err) leaked token (export read reject)');
  assert.ok(!err.message.includes(TOKEN), 'err.message leaked token (export read reject)');
  assert.ok(!String(err.stack || '').includes(TOKEN), 'err.stack leaked token (export read reject)');
});
