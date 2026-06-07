// Tests for bot.mjs — the `handleUpdate` dispatch core.
//
// `handleUpdate(update, deps)` is PURE DISPATCH over injected deps: a fake
// Telegram `api` (recording sendMessage/getFile/downloadFile/sendChatAction),
// a fake `exec` (returning scripted rwa-exec result objects), a fake
// `writeTemp`/`rateLimit`/`log`. So the whole suite runs offline — no token, no
// network, no real subprocess, no real disk. No Math.random / Date.now.
//
// Each test encodes WHY the branch matters (Rule 9). The security-relevant
// branches assert the NEGATIVE: that exec is NOT spawned when the path is gated
// (no backend key), rate-limited, the file is too large, or the type is
// disallowed — a test that merely checked the reply text couldn't fail if
// someone deleted the guard and let the spawn through.

import test from 'node:test';
import assert from 'node:assert/strict';
import { handleUpdate, HELP, replyForResult } from './bot.mjs';
import { TelegramError } from './telegram-api.mjs';

// A fake Telegram api that records every call and replays scripted results for
// getFile / downloadFile (the two that return / throw).
function makeFakeApi({ getFile, downloadFile } = {}) {
  const calls = { sendMessage: [], sendChatAction: [], getFile: [], downloadFile: [] };
  return {
    calls,
    async sendMessage(chatId, text) { calls.sendMessage.push({ chatId, text }); },
    async sendChatAction(chatId, action) { calls.sendChatAction.push({ chatId, action }); },
    async getFile(fileId) {
      calls.getFile.push({ fileId });
      if (getFile instanceof Error) throw getFile;
      return getFile ?? { file_path: 'documents/file_0.md', file_size: 10 };
    },
    async downloadFile(filePath, destPath, opts) {
      calls.downloadFile.push({ filePath, destPath, opts });
      if (downloadFile instanceof Error) throw downloadFile;
      return destPath;
    },
  };
}

// A fake exec recording calls and replaying a scripted result (or throwing).
function makeFakeExec({ importResult, createResult } = {}) {
  const calls = { rwaImportPublish: [], rwaCreatePublish: [] };
  return {
    calls,
    async rwaImportPublish(filePath, deps) {
      calls.rwaImportPublish.push({ filePath, deps });
      if (importResult instanceof Error) throw importResult;
      return importResult ?? { ok: true, url: 'https://abc.rewritable.ikangai.com/' };
    },
    async rwaCreatePublish(prompt, deps) {
      calls.rwaCreatePublish.push({ prompt, deps });
      if (createResult instanceof Error) throw createResult;
      return createResult ?? { ok: true, url: 'https://abc.rewritable.ikangai.com/' };
    },
  };
}

// Default test deps: key present, never rate-limited, writeTemp records + returns
// a fixed path, log records args.
function makeDeps(over = {}) {
  const api = over.api ?? makeFakeApi();
  const exec = over.exec ?? makeFakeExec();
  const writeTempCalls = [];
  const logged = [];
  return {
    deps: {
      api,
      exec,
      writeTemp: over.writeTemp ?? ((content, ext) => {
        writeTempCalls.push({ content, ext });
        return `/fake-tmp/u.${ext.replace(/^\./, '')}`;
      }),
      hasBackendKey: over.hasBackendKey ?? true,
      rateLimit: over.rateLimit ?? (() => true),
      log: over.log ?? ((...a) => { logged.push(a); }),
    },
    api,
    exec,
    writeTempCalls,
    logged,
  };
}

function textUpdate(text) {
  return { update_id: 1, message: { chat: { id: 42 }, text } };
}

// ── /start ───────────────────────────────────────────────────────────────────
// WHY: /start is the bot's front door; it must always answer with help and must
// never spawn work — answering help is free and shouldn't burn rate budget/spawn.
test('/start replies HELP, no exec', async () => {
  const { deps, api, exec } = makeDeps();
  await handleUpdate(textUpdate('/start'), deps);
  assert.equal(api.calls.sendMessage.length, 1);
  assert.equal(api.calls.sendMessage[0].text, HELP);
  assert.equal(exec.calls.rwaImportPublish.length, 0);
  assert.equal(exec.calls.rwaCreatePublish.length, 0);
});

test('/start with trailing args still replies HELP', async () => {
  const { deps, api } = makeDeps();
  await handleUpdate(textUpdate('/start anything'), deps);
  assert.equal(api.calls.sendMessage[0].text, HELP);
});

// ── /new (agent-fill) ──────────────────────────────────────────────────────────
// WHY: with a key, /new must reach rwaCreatePublish with the EXACT prompt text
// (one argv element downstream) and show a typing indicator during the slow gen,
// and the success reply must carry the link + the 24h-expiry warning (the share
// is ephemeral — failing to say so misleads the user).
test('/new X with key → rwaCreatePublish(X), typing action, success reply has url + 24h', async () => {
  const { deps, api, exec } = makeDeps();
  await handleUpdate(textUpdate('/new a doc about otters'), deps);
  assert.equal(exec.calls.rwaCreatePublish.length, 1);
  assert.equal(exec.calls.rwaCreatePublish[0].prompt, 'a doc about otters');
  assert.deepEqual(api.calls.sendChatAction[0], { chatId: 42, action: 'typing' });
  const reply = api.calls.sendMessage[0].text;
  assert.match(reply, /https:\/\/abc\.rewritable\.ikangai\.com\//);
  assert.match(reply, /24h/);
});

// WHY (SECURITY/gate): no backend key means agent-fill is unavailable — we must
// tell the user AND prove the spawn never happened (rwaCreatePublish gates too,
// but the cheaper boundary gate here must hold independently).
test('/new X without key → "not configured", rwaCreatePublish NEVER called', async () => {
  const { deps, api, exec } = makeDeps({ hasBackendKey: false });
  await handleUpdate(textUpdate('/new something'), deps);
  assert.equal(exec.calls.rwaCreatePublish.length, 0);
  assert.match(api.calls.sendMessage[0].text, /isn't configured|not configured/i);
});

// WHY: an empty /new is a user mistake, not an error — guide them, don't spawn.
test('/new with no prompt → friendly "give me a topic", no exec', async () => {
  const { deps, api, exec } = makeDeps();
  await handleUpdate(textUpdate('/new'), deps);
  assert.equal(exec.calls.rwaCreatePublish.length, 0);
  assert.match(api.calls.sendMessage[0].text, /topic/i);
});

test('/new with only spaces → friendly "give me a topic", no exec', async () => {
  const { deps, api, exec } = makeDeps();
  await handleUpdate(textUpdate('/new    '), deps);
  assert.equal(exec.calls.rwaCreatePublish.length, 0);
  assert.match(api.calls.sendMessage[0].text, /topic/i);
});

// ── plain text → wrap ──────────────────────────────────────────────────────────
// WHY: a plain message is the no-key wrap path; the text must be written to a
// temp .md file and THAT path handed to import — proving content becomes a file,
// never a parsed command (the security model from rwa-exec).
test('plain text → writeTemp(text, .md) then rwaImportPublish(thatPath)', async () => {
  const { deps, api, exec, writeTempCalls } = makeDeps();
  await handleUpdate(textUpdate('hello **world**'), deps);
  assert.equal(writeTempCalls.length, 1);
  assert.equal(writeTempCalls[0].content, 'hello **world**');
  assert.equal(writeTempCalls[0].ext, '.md');
  assert.equal(exec.calls.rwaImportPublish.length, 1);
  assert.equal(exec.calls.rwaImportPublish[0].filePath, '/fake-tmp/u.md');
  assert.match(api.calls.sendMessage[0].text, /https:\/\//);
});

// ── document → download + wrap ───────────────────────────────────────────────
function docUpdate(document) {
  return { update_id: 1, message: { chat: { id: 42 }, document } };
}

// WHY: an allowed document within size limits is the document wrap path —
// getFile → downloadFile → import; the downloaded temp dest is what import sees.
test('document, allowed type, within size → getFile + downloadFile + import; success', async () => {
  const api = makeFakeApi({ getFile: { file_path: 'documents/x.pdf', file_size: 100 } });
  const { deps, exec } = makeDeps({ api });
  await handleUpdate(docUpdate({ file_id: 'F1', file_name: 'report.pdf', mime_type: 'application/pdf' }), deps);
  assert.equal(api.calls.getFile.length, 1);
  assert.equal(api.calls.getFile[0].fileId, 'F1');
  assert.equal(api.calls.downloadFile.length, 1);
  assert.equal(exec.calls.rwaImportPublish.length, 1);
  // import gets the local temp dest the download wrote, not the remote file_path.
  assert.equal(exec.calls.rwaImportPublish[0].filePath, api.calls.downloadFile[0].destPath);
  assert.match(api.calls.sendMessage[0].text, /https:\/\//);
});

// WHY (SECURITY): a too-large file must not be imported. downloadFile enforces
// the cap and throws file_too_large; we surface a friendly reply and prove import
// was NOT reached (a bot must not be coerced into doing work on an oversized file).
test('document too large → downloadFile throws → friendly reply, import NOT called', async () => {
  const api = makeFakeApi({
    getFile: { file_path: 'documents/big.pdf', file_size: 99999999 },
    downloadFile: new TelegramError('file_too_large', { code: 'file_too_large' }),
  });
  const { deps, exec } = makeDeps({ api });
  await handleUpdate(docUpdate({ file_id: 'F1', file_name: 'big.pdf', mime_type: 'application/pdf' }), deps);
  assert.equal(api.calls.downloadFile.length, 1);
  assert.equal(exec.calls.rwaImportPublish.length, 0);
  assert.match(api.calls.sendMessage[0].text, /too big|too large/i);
});

// WHY (SECURITY): a disallowed type must be rejected BEFORE any network — assert
// neither getFile nor downloadFile ran. The allowlist is the gate; bypassing it
// to download an arbitrary type defeats the point.
test('document disallowed type → friendly reply, NO getFile/downloadFile/import', async () => {
  const api = makeFakeApi();
  const { deps, exec } = makeDeps({ api });
  await handleUpdate(docUpdate({ file_id: 'F1', file_name: 'evil.exe', mime_type: 'application/octet-stream' }), deps);
  assert.equal(api.calls.getFile.length, 0);
  assert.equal(api.calls.downloadFile.length, 0);
  assert.equal(exec.calls.rwaImportPublish.length, 0);
  assert.match(api.calls.sendMessage[0].text, /can't read that file type|file type/i);
});

// ── fallback ─────────────────────────────────────────────────────────────────
// WHY: stickers/photos/empty updates are out of scope — guide the user toward
// what IS supported, and never spawn work for them.
test('junk (sticker) → fallback reply, no exec', async () => {
  const api = makeFakeApi();
  const { deps, exec } = makeDeps({ api });
  await handleUpdate({ update_id: 1, message: { chat: { id: 42 }, sticker: { file_id: 'S1' } } }, deps);
  assert.equal(exec.calls.rwaImportPublish.length, 0);
  assert.equal(exec.calls.rwaCreatePublish.length, 0);
  assert.match(api.calls.sendMessage[0].text, /send me text|markdown file|\/new/i);
});

// ── rate limit ───────────────────────────────────────────────────────────────
// WHY (SECURITY/token-burn): over-limit work paths must reply slow-down and NOT
// spawn — the rate limit is the abuse wall; a reply without the spawn-block is no
// limit at all.
test('rate-limited plain text → slow-down reply, no exec', async () => {
  const { deps, api, exec } = makeDeps({ rateLimit: () => false });
  await handleUpdate(textUpdate('wrap me'), deps);
  assert.equal(exec.calls.rwaImportPublish.length, 0);
  assert.match(api.calls.sendMessage[0].text, /slow down|too many|wait/i);
});

test('rate-limited /new → slow-down reply, no create spawn', async () => {
  const { deps, api, exec } = makeDeps({ rateLimit: () => false });
  await handleUpdate(textUpdate('/new x'), deps);
  assert.equal(exec.calls.rwaCreatePublish.length, 0);
  assert.match(api.calls.sendMessage[0].text, /slow down|too many|wait/i);
});

// WHY: /start must NOT be rate-limited — the help reply is free and a user who
// hit the limit still needs to be able to read what's going on.
test('rate-limited /start still replies HELP', async () => {
  const { deps, api } = makeDeps({ rateLimit: () => false });
  await handleUpdate(textUpdate('/start'), deps);
  assert.equal(api.calls.sendMessage[0].text, HELP);
});

// ── honest errors ────────────────────────────────────────────────────────────
// WHY (Rule 12, honest host / friendly user): a CLI failure must show the user a
// friendly per-step line while the RAW stderr goes to the host log — NOT to the
// user. Leaking stderr to the user is noise+possible info-leak; hiding it from
// the host is a silent swallow. Assert both directions.
test('exec import failure {code:2,step:import,stderr} → friendly reply + raw stderr logged (not sent)', async () => {
  const exec = makeFakeExec({ importResult: { ok: false, code: 2, step: 'import', stderr: 'boom-detail' } });
  const { deps, api, logged } = makeDeps({ exec });
  await handleUpdate(textUpdate('content'), deps);
  const reply = api.calls.sendMessage[0].text;
  assert.match(reply, /couldn't read that document|couldn't read/i);
  assert.doesNotMatch(reply, /boom-detail/); // raw stderr NOT sent to the user
  assert.ok(logged.some((a) => a.some((x) => String(x).includes('boom-detail'))));
});

// WHY: a thrown handler must never escape — the future poll loop must survive one
// bad message. Assert the call RESOLVES (no rethrow) and the user gets a generic
// "try again" while the error is logged host-side.
test('exec throws → "something went wrong" reply + logged, no rethrow', async () => {
  const exec = makeFakeExec({ importResult: new Error('kaboom') });
  const { deps, api, logged } = makeDeps({ exec });
  await handleUpdate(textUpdate('content'), deps); // must not reject
  assert.match(api.calls.sendMessage[0].text, /something went wrong|try again/i);
  assert.ok(logged.length >= 1);
});

// ── replyForResult unit coverage (every code) ────────────────────────────────
// WHY: replyForResult is the single map from result-object → user text; each code
// has a distinct contract and getting one wrong sends the wrong message.
test('replyForResult covers every code', () => {
  const ok = replyForResult({ ok: true, url: 'https://x/' });
  assert.match(ok.text, /https:\/\/x\//);
  assert.match(ok.text, /24h/);

  assert.match(replyForResult({ ok: false, code: 'agent_not_configured' }).text, /configured/i);
  assert.match(replyForResult({ ok: false, code: 'bad_prompt' }).text, /dash/i);
  assert.match(replyForResult({ ok: false, code: 'no_url' }).text, /couldn't read the link|try again/i);

  const importFail = replyForResult({ ok: false, code: 2, step: 'import', stderr: 's1' });
  assert.match(importFail.text, /couldn't read that document/i);
  assert.equal(importFail.logStderr, 's1');

  const createFail = replyForResult({ ok: false, code: 3, step: 'create', stderr: 's2' });
  assert.match(createFail.text, /couldn't generate/i);
  assert.equal(createFail.logStderr, 's2');

  const publishFail = replyForResult({ ok: false, code: 1, step: 'publish', stderr: 's3' });
  assert.match(publishFail.text, /something went wrong|couldn't publish/i);
  assert.equal(publishFail.logStderr, 's3');
});
