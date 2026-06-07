// Zero-dep Telegram Bot API client. The Bot API is plain HTTPS+JSON, so this is
// just typed `fetch` wrappers — no npm deps, only node built-ins + global fetch.
//
// Two seams keep the whole thing offline-testable (mirroring the `deps` style of
// `cli/src/fetch-page.mjs`): `fetchImpl` (default `globalThis.fetch`) and
// `writeFile` (default `node:fs/promises` writeFile, lazily imported only when a
// real download happens). `baseUrl` is overridable for tests.
//
// SECURITY — token redaction: the bot token lives in every request URL
// (`/bot<token>/…`). It must NEVER reach a thrown error's message or stack: a
// leaked token === a hijacked bot. So no error string interpolates the URL or
// token — errors name the API method + Telegram's `description` only. The seam
// here is a discipline, enforced by `telegram-api.test.mjs` which asserts the
// token is absent across every failure path.

export class TelegramError extends Error {
  // `description` mirrors Telegram's own error field (or our own code string for
  // client-side failures like file_too_large). `code` is an optional short tag.
  // The message is deliberately the description only — never the URL/token.
  constructor(description, { code } = {}) {
    super(description == null ? 'telegram_error' : String(description));
    this.name = 'TelegramError';
    this.description = description;
    if (code !== undefined) this.code = code;
  }
}

export function makeTelegramApi(token, {
  fetchImpl = globalThis.fetch,
  baseUrl = 'https://api.telegram.org',
  writeFile,
} = {}) {
  // The token-bearing bases. These are never put into any error string.
  const apiBase = `${baseUrl}/bot${token}`;
  const fileBase = `${baseUrl}/file/bot${token}`;

  // Read a header from either a Headers/Map (.get) or a plain object.
  function header(headers, name) {
    if (!headers) return null;
    if (typeof headers.get === 'function') return headers.get(name);
    return headers[name] ?? headers[name.toLowerCase()] ?? null;
  }

  // POST a JSON payload to an API method and return its `result`. Throws a
  // TelegramError (naming only the method + Telegram's description) on transport
  // failure, non-2xx status, or a Telegram `{ ok:false }` envelope.
  async function callMethod(method, payload) {
    let res;
    try {
      res = await fetchImpl(`${apiBase}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      // Re-wrap: a raw fetch error can carry the request URL (with the token).
      throw new TelegramError(`request failed (${method})`, { code: 'fetch_failed' });
    }

    let data;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (data && data.ok === false) {
      throw new TelegramError(data.description ?? `${method} failed`, { code: 'telegram_api' });
    }
    if (!res.ok) {
      // Non-2xx without a usable envelope — name the method + status, never the URL.
      throw new TelegramError(`${method} failed (HTTP ${res.status})`, { code: 'http_error' });
    }
    return data ? data.result : undefined;
  }

  async function getUpdates(offset) {
    return callMethod('getUpdates', { offset, timeout: 50 });
  }

  async function sendMessage(chatId, text) {
    return callMethod('sendMessage', {
      chat_id: chatId,
      text,
      disable_web_page_preview: false,
    });
  }

  async function getFile(fileId) {
    const result = await callMethod('getFile', { file_id: fileId });
    return { file_path: result?.file_path, file_size: result?.file_size };
  }

  async function sendChatAction(chatId, action) {
    return callMethod('sendChatAction', { chat_id: chatId, action });
  }

  // GET a file from the file endpoint and write it to disk via the writeFile
  // seam. If the advertised content-length exceeds maxBytes we throw BEFORE
  // writing anything — a bot must not be coerced into filling its disk.
  async function downloadFile(filePath, destPath, { maxBytes = 20 * 1024 * 1024 } = {}) {
    let res;
    try {
      res = await fetchImpl(`${fileBase}/${filePath}`, { method: 'GET' });
    } catch (err) {
      throw new TelegramError('file download request failed', { code: 'fetch_failed' });
    }
    if (!res.ok) {
      throw new TelegramError(`file download failed (HTTP ${res.status})`, { code: 'http_error' });
    }

    const declared = Number(header(res.headers, 'content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new TelegramError('file_too_large', { code: 'file_too_large' });
    }

    const buf = await res.arrayBuffer();
    // Belt-and-suspenders: a lying/absent content-length must not let an
    // oversized body slip through after the header check.
    if (buf.byteLength > maxBytes) {
      throw new TelegramError('file_too_large', { code: 'file_too_large' });
    }

    const write = writeFile || (await import('node:fs/promises')).writeFile;
    await write(destPath, Buffer.from(buf));
    return destPath;
  }

  return { getUpdates, sendMessage, getFile, downloadFile, sendChatAction };
}
