// Tests for telegram-api.mjs — the zero-dep Bot API client.
//
// Every test injects a fake `fetchImpl` (and, for downloadFile, a `writeFile`
// seam) so the suite runs fully offline — no real network, no real disk. The
// assertions check the RECORDED url + parsed body shape, not merely that a call
// didn't throw: the whole point of this module is putting the right request on
// the wire, so a test that can't observe the wire can't fail when the wire shape
// changes (Rule 9).

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTelegramApi, TelegramError } from './telegram-api.mjs';

const TOKEN = '123456:AAuper-secret-bot-token-DEADBEEF';

// A fake fetch that records each call and replays a queued scripted response.
// Each scripted entry is either a JSON payload (wrapped into a Response-like
// object) or a fully-formed Response-like object (for header-driven cases).
function makeFakeFetch(scripts) {
  const calls = [];
  const queue = [...scripts];
  const fetchImpl = async (url, opts = {}) => {
    let body;
    if (opts.body != null) {
      try { body = JSON.parse(opts.body); } catch { body = opts.body; }
    }
    calls.push({ url, method: opts.method, headers: opts.headers, body });
    const next = queue.shift();
    if (next === undefined) throw new Error('fake fetch: no scripted response left');
    if (typeof next === 'function') return next();
    return next;
  };
  return { fetchImpl, calls };
}

// A minimal Response-like for the JSON API methods.
function jsonResponse(payload, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([['content-type', 'application/json']]),
    json: async () => payload,
  };
}

// A Response-like for downloadFile: carries headers + an arrayBuffer/body.
function binResponse(bytes, { status = 200, headers = {} } = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: h,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

test('getUpdates posts the right url + body and returns result array', async () => {
  const updates = [{ update_id: 1 }, { update_id: 2 }];
  const { fetchImpl, calls } = makeFakeFetch([jsonResponse({ ok: true, result: updates })]);
  const api = makeTelegramApi(TOKEN, { fetchImpl });

  const result = await api.getUpdates(42);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/getUpdates`);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers['content-type'], 'application/json');
  assert.deepEqual(calls[0].body, { offset: 42, timeout: 50 });
  assert.deepEqual(result, updates);
});

test('getUpdates throws TelegramError carrying description on ok:false', async () => {
  const { fetchImpl } = makeFakeFetch([
    jsonResponse({ ok: false, description: 'Unauthorized' }),
  ]);
  const api = makeTelegramApi(TOKEN, { fetchImpl });

  await assert.rejects(
    () => api.getUpdates(0),
    (err) => {
      assert.ok(err instanceof TelegramError);
      assert.equal(err.description, 'Unauthorized');
      return true;
    },
  );
});

test('sendMessage posts chat_id + text and returns result', async () => {
  const msg = { message_id: 7, text: 'hi' };
  const { fetchImpl, calls } = makeFakeFetch([jsonResponse({ ok: true, result: msg })]);
  const api = makeTelegramApi(TOKEN, { fetchImpl });

  const result = await api.sendMessage(555, 'hi there');

  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body.chat_id, 555);
  assert.equal(calls[0].body.text, 'hi there');
  assert.deepEqual(result, msg);
});

test('getFile posts file_id and returns {file_path, file_size}', async () => {
  const { fetchImpl, calls } = makeFakeFetch([
    jsonResponse({ ok: true, result: { file_id: 'abc', file_path: 'photos/x.jpg', file_size: 1234 } }),
  ]);
  const api = makeTelegramApi(TOKEN, { fetchImpl });

  const result = await api.getFile('abc');

  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/getFile`);
  assert.deepEqual(calls[0].body, { file_id: 'abc' });
  assert.deepEqual(result, { file_path: 'photos/x.jpg', file_size: 1234 });
});

test('sendChatAction posts chat_id + action', async () => {
  const { fetchImpl, calls } = makeFakeFetch([jsonResponse({ ok: true, result: true })]);
  const api = makeTelegramApi(TOKEN, { fetchImpl });

  await api.sendChatAction(99, 'typing');

  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendChatAction`);
  assert.deepEqual(calls[0].body, { chat_id: 99, action: 'typing' });
});

test('downloadFile GETs the file url and writes bytes via the writeFile seam', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const { fetchImpl, calls } = makeFakeFetch([
    binResponse(bytes, { headers: { 'content-length': '5' } }),
  ]);
  const writes = [];
  const writeFile = async (dest, data) => { writes.push({ dest, data }); };
  const api = makeTelegramApi(TOKEN, { fetchImpl, writeFile });

  await api.downloadFile('photos/x.jpg', '/tmp/out.jpg', { maxBytes: 100 });

  assert.equal(calls[0].url, `https://api.telegram.org/file/bot${TOKEN}/photos/x.jpg`);
  assert.equal(calls[0].method, 'GET');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].dest, '/tmp/out.jpg');
  assert.deepEqual(new Uint8Array(writes[0].data), bytes);
});

test('downloadFile throws too-large and does NOT write when content-length exceeds maxBytes', async () => {
  const bytes = new Uint8Array(1000);
  const { fetchImpl } = makeFakeFetch([
    binResponse(bytes, { headers: { 'content-length': '1000' } }),
  ]);
  const writes = [];
  const writeFile = async (dest, data) => { writes.push({ dest, data }); };
  const api = makeTelegramApi(TOKEN, { fetchImpl, writeFile });

  await assert.rejects(
    () => api.downloadFile('photos/big.jpg', '/tmp/big.jpg', { maxBytes: 100 }),
    (err) => {
      assert.ok(err instanceof TelegramError);
      // a code/description that signals too-large (impl uses 'file_too_large')
      assert.match(`${err.code || ''} ${err.description || ''}`, /too.?large/i);
      return true;
    },
  );
  assert.equal(writes.length, 0, 'must not write the file when it is too large');
});

test('the bot token never appears in a thrown error message or stack', async () => {
  // Drive a few distinct failure paths and assert the token is absent each time.

  // 1. Telegram ok:false on a JSON method.
  {
    const { fetchImpl } = makeFakeFetch([jsonResponse({ ok: false, description: 'Bad' })]);
    const api = makeTelegramApi(TOKEN, { fetchImpl });
    const err = await api.sendMessage(1, 'x').then(() => null, (e) => e);
    assert.ok(err, 'expected throw');
    assert.ok(!String(err).includes(TOKEN), 'String(err) leaked token');
    assert.ok(!err.message.includes(TOKEN), 'err.message leaked token');
    assert.ok(!String(err.stack || '').includes(TOKEN), 'err.stack leaked token');
  }

  // 2. Non-2xx HTTP status.
  {
    const { fetchImpl } = makeFakeFetch([jsonResponse({ ok: false }, { status: 500 })]);
    const api = makeTelegramApi(TOKEN, { fetchImpl });
    const err = await api.getUpdates(0).then(() => null, (e) => e);
    assert.ok(err, 'expected throw');
    assert.ok(!String(err).includes(TOKEN), 'String(err) leaked token (http)');
    assert.ok(!err.message.includes(TOKEN), 'err.message leaked token (http)');
  }

  // 3. Underlying fetch rejection (network error) — the url (with token) must
  //    not be re-thrown verbatim.
  {
    const { fetchImpl } = makeFakeFetch([() => { throw new Error('ECONNREFUSED'); }]);
    const api = makeTelegramApi(TOKEN, { fetchImpl });
    const err = await api.getFile('x').then(() => null, (e) => e);
    assert.ok(err, 'expected throw');
    assert.ok(!String(err).includes(TOKEN), 'String(err) leaked token (fetch fail)');
    assert.ok(!err.message.includes(TOKEN), 'err.message leaked token (fetch fail)');
  }

  // 4. downloadFile too-large.
  {
    const { fetchImpl } = makeFakeFetch([
      binResponse(new Uint8Array(10), { headers: { 'content-length': '10' } }),
    ]);
    const api = makeTelegramApi(TOKEN, { fetchImpl, writeFile: async () => {} });
    const err = await api.downloadFile('big.jpg', '/tmp/x', { maxBytes: 1 }).then(() => null, (e) => e);
    assert.ok(err, 'expected throw');
    assert.ok(!String(err).includes(TOKEN), 'String(err) leaked token (download)');
    assert.ok(!err.message.includes(TOKEN), 'err.message leaked token (download)');
  }

  // 5. downloadFile body-read rejection — res.arrayBuffer() rejects. The raw
  //    rejection's message carries the token-bearing file URL; it must NOT escape
  //    as a raw error (the one await that used to be unguarded — review I1).
  {
    const leaky = {
      ok: true,
      status: 200,
      headers: new Map(),
      arrayBuffer: async () => {
        throw new Error(`boom https://api.telegram.org/file/bot${TOKEN}/big.jpg`);
      },
    };
    const { fetchImpl } = makeFakeFetch([leaky]);
    const api = makeTelegramApi(TOKEN, { fetchImpl, writeFile: async () => {} });
    const err = await api.downloadFile('big.jpg', '/tmp/x').then(() => null, (e) => e);
    assert.ok(err, 'expected throw');
    assert.ok(err instanceof TelegramError, 'body-read rejection must surface as TelegramError, not a raw error');
    assert.ok(!String(err).includes(TOKEN), 'String(err) leaked token (download read)');
    assert.ok(!err.message.includes(TOKEN), 'err.message leaked token (download read)');
    assert.ok(!String(err.stack || '').includes(TOKEN), 'err.stack leaked token (download read)');
  }
});
