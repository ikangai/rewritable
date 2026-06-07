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
import { handleUpdate, HELP, HELP_PHASE_B, replyForResult, MAX_DOC_BYTES } from './bot.mjs';
import { TelegramError } from './telegram-api.mjs';
import { FoundationError } from './foundation-api.mjs';

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

// WHY (review I1): /new must NOT match /newsletter — a bare startsWith('/new')
// matched it, routing to agent-fill with a mangled prompt ("sletter about cats")
// AND burning a real spawn + rate budget. It must fall through to the plain-text
// wrap path: written verbatim to a temp .md, then imported (never parsed/spawned).
test('/newsletter … does NOT agent-fill; falls through to wrap path', async () => {
  const { deps, api, exec, writeTempCalls } = makeDeps();
  await handleUpdate(textUpdate('/newsletter about cats'), deps);
  assert.equal(exec.calls.rwaCreatePublish.length, 0);
  assert.equal(writeTempCalls.length, 1);
  assert.equal(writeTempCalls[0].content, '/newsletter about cats');
  assert.equal(writeTempCalls[0].ext, '.md');
  assert.equal(exec.calls.rwaImportPublish.length, 1);
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
  // file_size within the cap → must not trip the pre-getFile gate.
  await handleUpdate(docUpdate({ file_id: 'F1', file_name: 'report.pdf', mime_type: 'application/pdf', file_size: 100 }), deps);
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

// WHY (SECURITY, M1): the design caps oversized docs BEFORE the getFile round-trip,
// using the free message.document.file_size. A too-large file_size must short-circuit
// with the friendly reply and reach NO network/import at all — pins "cap before getFile".
test('document file_size over cap → too-big reply BEFORE getFile; no getFile/downloadFile/import', async () => {
  const api = makeFakeApi();
  const { deps, exec } = makeDeps({ api });
  await handleUpdate(docUpdate({ file_id: 'F1', file_name: 'big.pdf', mime_type: 'application/pdf', file_size: MAX_DOC_BYTES + 1 }), deps);
  assert.equal(api.calls.getFile.length, 0);
  assert.equal(api.calls.downloadFile.length, 0);
  assert.equal(exec.calls.rwaImportPublish.length, 0);
  assert.match(api.calls.sendMessage[0].text, /too big|too large/i);
});

// WHY (ROBUSTNESS, L1): getFile can return a result without a file_path. Passing
// undefined to downloadFile would GET .../bot<token>/undefined and 404 into a
// confusing generic error — reply friendly and prove downloadFile was never called.
test('getFile returns no file_path → "couldn\'t fetch" reply; downloadFile NOT called', async () => {
  const api = makeFakeApi({ getFile: {} });
  const { deps, exec } = makeDeps({ api });
  await handleUpdate(docUpdate({ file_id: 'F1', file_name: 'report.pdf', mime_type: 'application/pdf', file_size: 100 }), deps);
  assert.equal(api.calls.getFile.length, 1);
  assert.equal(api.calls.downloadFile.length, 0);
  assert.equal(exec.calls.rwaImportPublish.length, 0);
  assert.match(api.calls.sendMessage[0].text, /couldn't fetch/i);
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

// ═══════════════════════════════════════════════════════════════════════════════
// Phase B — foundation-gated create-editable + in-chat edit
// ═══════════════════════════════════════════════════════════════════════════════
// `handleUpdate` gains deps.foundation (the foundation HTTP client), deps.state
// (the per-chat binding store), and deps.foundationEnabled. When the gate is OFF
// the EXISTING Phase A path runs unchanged and the foundation/state are NEVER
// touched (the no-regression pin). When ON, a chat binds to ONE hosted editable
// rewritable: a create-y message (or /new) BUILDS a container locally then POSTs
// the BYTES to the foundation (createDoc) and binds; a plain message against an
// active binding is an EDIT (readDoc→exportDoc→rwaEdit→modify).
//
// SECURITY pins (Rule 9): the capability TOKEN is a secret — it must never appear
// in any sendMessage text or log arg (only the URL, which is the user's edit link,
// is replied, to the owning chat). A leading-dash edit instruction must be rejected
// pre-spawn. No backend key → both create-agent-fill and edit refuse with no spawn.

const TOKEN = 'cap-tok-SECRET-7f3a';
const URL = 'https://abc.rewritable.ikangai.com/#k=' + TOKEN;

// A fake foundation recording every call + replaying scripted results/errors.
// `modify` can be a function (to script per-attempt behavior, e.g. 409-then-200).
function makeFakeFoundation(over = {}) {
  const calls = { createDoc: [], readDoc: [], exportDoc: [], describe: [], modify: [] };
  return {
    calls,
    async createDoc(bytes) {
      calls.createDoc.push({ bytes });
      if (over.createDoc instanceof Error) throw over.createDoc;
      return over.createDoc ?? { id: 'doc1', token: TOKEN, url: URL };
    },
    async readDoc(id, token) {
      calls.readDoc.push({ id, token });
      if (over.readDoc instanceof Error) throw over.readDoc;
      return over.readDoc ?? { doc: 'OLD BODY', baseHash: 'hash-' + calls.readDoc.length, selfDescription: { title: 'Doc' } };
    },
    async exportDoc(id, token) {
      calls.exportDoc.push({ id, token });
      if (over.exportDoc instanceof Error) throw over.exportDoc;
      return over.exportDoc ?? '<html>EXPORTED</html>';
    },
    async describe(id, token) {
      calls.describe.push({ id, token });
      if (over.describe instanceof Error) throw over.describe;
      return over.describe ?? { title: 'My Doc', kind: 'document' };
    },
    async modify(id, token, payload) {
      calls.modify.push({ id, token, payload });
      const m = over.modify;
      if (typeof m === 'function') return m(calls.modify.length, { id, token, payload });
      if (m instanceof Error) throw m;
      return m ?? { doc: 'NEW BODY', baseHash: 'hash-new', selfDescription: { title: 'Doc' }, histLen: 2 };
    },
  };
}

// A fake state store (the per-chat binding). `initial` seeds an existing binding.
function makeFakeState(initial) {
  const map = new Map();
  if (initial) map.set(String(42), initial);
  const calls = { get: [], set: [], clear: [] };
  return {
    calls,
    map,
    get(chatId) { calls.get.push(String(chatId)); return map.get(String(chatId)); },
    set(chatId, binding) { calls.set.push({ chatId: String(chatId), binding }); map.set(String(chatId), binding); },
    clear(chatId) { calls.clear.push(String(chatId)); map.delete(String(chatId)); },
  };
}

// A fake exec extended with the Phase B build + edit functions.
function makeFakeExecB(over = {}) {
  const calls = { rwaImportPublish: [], rwaCreatePublish: [], rwaImportBuild: [], rwaCreateBuild: [], rwaEdit: [] };
  const replay = (val, dflt) => { if (val instanceof Error) throw val; return val ?? dflt; };
  return {
    calls,
    async rwaImportPublish(filePath, deps) { calls.rwaImportPublish.push({ filePath, deps }); return replay(over.importPublish, { ok: true, url: URL }); },
    async rwaCreatePublish(prompt, deps) { calls.rwaCreatePublish.push({ prompt, deps }); return replay(over.createPublish, { ok: true, url: URL }); },
    async rwaImportBuild(filePath, deps) { calls.rwaImportBuild.push({ filePath, deps }); return replay(over.importBuild, { ok: true, bytes: '<html>BUILT</html>' }); },
    async rwaCreateBuild(prompt, deps) { calls.rwaCreateBuild.push({ prompt, deps }); return replay(over.createBuild, { ok: true, bytes: '<html>GEN</html>' }); },
    async rwaEdit(filePath, instruction, deps) { calls.rwaEdit.push({ filePath, instruction, deps }); return replay(over.edit, { ok: true, doc: 'NEW BODY' }); },
  };
}

// Phase B deps. `foundationEnabled` defaults TRUE here (these tests exercise B).
function makeDepsB(over = {}) {
  const api = over.api ?? makeFakeApi();
  const exec = over.exec ?? makeFakeExecB();
  const foundation = over.foundation ?? makeFakeFoundation();
  const state = over.state ?? makeFakeState();
  const writeTempCalls = [];
  const logged = [];
  return {
    deps: {
      api, exec, foundation, state,
      foundationEnabled: over.foundationEnabled ?? true,
      writeTemp: over.writeTemp ?? ((content, ext) => { writeTempCalls.push({ content, ext }); return `/fake-tmp/u${ext}`; }),
      hasBackendKey: over.hasBackendKey ?? true,
      rateLimit: over.rateLimit ?? (() => true),
      log: over.log ?? ((...a) => { logged.push(a); }),
    },
    api, exec, foundation, state, writeTempCalls, logged,
  };
}

// An update carrying a `from.id` (the actor source) so actor:'telegram:<uid>' is testable.
function textUpdateFrom(text, fromId = 777) {
  return { update_id: 1, message: { chat: { id: 42 }, from: { id: fromId }, text } };
}

// Assert a value (recursively) does NOT contain the capability token anywhere.
function assertNoToken(value, where) {
  const s = JSON.stringify(value) ?? String(value);
  assert.ok(!s.includes(TOKEN), `${where} must not contain the capability token`);
}

// ── gate OFF — no regression, foundation/state untouched ─────────────────────
// WHY: the activation gate is the no-regression guarantee. With foundationEnabled
// false the bot is byte-for-byte Phase A: it publishes ephemeral and NEVER touches
// the foundation or the state store. A test that only checked the reply couldn't
// catch a leak that called the foundation behind the user's back.
test('gate OFF: plain text → Phase A ephemeral publish; foundation/state NEVER touched', async () => {
  const { deps, exec, foundation, state, writeTempCalls } = makeDepsB({ foundationEnabled: false });
  await handleUpdate(textUpdateFrom('hello'), deps);
  assert.equal(exec.calls.rwaImportPublish.length, 1);          // Phase A wrap ran
  assert.equal(writeTempCalls.length, 1);
  assert.equal(exec.calls.rwaImportBuild.length, 0);            // Phase B build did NOT
  assert.equal(foundation.calls.createDoc.length, 0);
  assert.equal(foundation.calls.modify.length, 0);
  assert.equal(state.calls.get.length, 0);
  assert.equal(state.calls.set.length, 0);
});

test('gate OFF: /new → Phase A create-publish; foundation/state NEVER touched', async () => {
  const { deps, exec, foundation, state } = makeDepsB({ foundationEnabled: false });
  await handleUpdate(textUpdateFrom('/new otters'), deps);
  assert.equal(exec.calls.rwaCreatePublish.length, 1);
  assert.equal(foundation.calls.createDoc.length, 0);
  assert.equal(state.calls.set.length, 0);
});

// ── /start (Phase B aware help) ──────────────────────────────────────────────
test('Phase B /start replies HELP_PHASE_B, no foundation/state touched, no rate-limit', async () => {
  const { deps, api, foundation, state } = makeDepsB({ rateLimit: () => false });
  await handleUpdate(textUpdateFrom('/start'), deps);
  assert.equal(api.calls.sendMessage[0].text, HELP_PHASE_B);
  assert.equal(foundation.calls.createDoc.length, 0);
  assert.equal(state.calls.set.length, 0);
});

// ── CREATE (agent-fill /new) ─────────────────────────────────────────────────
// WHY: the whole point of Phase B create is BUILD-then-createDoc(bytes)-then-bind.
// We pin that the BUILT bytes (not a path, not a publish) reach createDoc, the
// returned {id,token,url} is saved to state, and the reply carries the url.
test('CREATE /new X: build → createDoc(bytes) → state.set({id,token,url}) → reply has url', async () => {
  const { deps, api, exec, foundation, state } = makeDepsB();
  await handleUpdate(textUpdateFrom('/new a doc about otters'), deps);
  assert.equal(exec.calls.rwaCreateBuild.length, 1);
  assert.equal(exec.calls.rwaCreateBuild[0].prompt, 'a doc about otters');
  assert.equal(exec.calls.rwaCreatePublish.length, 0, 'Phase B must not ephemeral-publish');
  // The BYTES from the build go to createDoc.
  assert.equal(foundation.calls.createDoc.length, 1);
  assert.equal(foundation.calls.createDoc[0].bytes, '<html>GEN</html>');
  // The returned binding is persisted.
  assert.equal(state.calls.set.length, 1);
  assert.deepEqual(state.calls.set[0].binding, { id: 'doc1', token: TOKEN, url: URL });
  // The url is replied (the capability link).
  assert.ok(api.calls.sendMessage.some((m) => m.text.includes(URL)));
});

test('CREATE plain text (no binding): import-build → createDoc(bytes) → bind → url', async () => {
  const { deps, api, exec, foundation, state, writeTempCalls } = makeDepsB();
  await handleUpdate(textUpdateFrom('wrap this prose'), deps);
  // text is written to a temp .md then BUILT via import (no publish).
  assert.equal(writeTempCalls.length, 1);
  assert.equal(writeTempCalls[0].content, 'wrap this prose');
  assert.equal(exec.calls.rwaImportBuild.length, 1);
  assert.equal(exec.calls.rwaImportPublish.length, 0);
  assert.equal(foundation.calls.createDoc[0].bytes, '<html>BUILT</html>');
  assert.equal(state.calls.set.length, 1);
  assert.ok(api.calls.sendMessage.some((m) => m.text.includes(URL)));
});

test('CREATE document (no binding): download → import-build → createDoc → bind', async () => {
  const api = makeFakeApi({ getFile: { file_path: 'documents/x.pdf', file_size: 100 } });
  const { deps, exec, foundation, state } = makeDepsB({ api });
  await handleUpdate({ update_id: 1, message: { chat: { id: 42 }, from: { id: 9 }, document: { file_id: 'F1', file_name: 'report.pdf', mime_type: 'application/pdf', file_size: 100 } } }, deps);
  assert.equal(api.calls.downloadFile.length, 1);
  assert.equal(exec.calls.rwaImportBuild.length, 1);
  // import-build sees the downloaded temp dest, not the remote path.
  assert.equal(exec.calls.rwaImportBuild[0].filePath, api.calls.downloadFile[0].destPath);
  assert.equal(foundation.calls.createDoc.length, 1);
  assert.equal(state.calls.set.length, 1);
});

// WHY (gate): agent-fill needs a backend key. No key → friendly "needs a backend"
// and NO build/createDoc spawn (the cheap boundary gate independent of the build).
test('CREATE /new without key → "needs a backend", no build, no createDoc', async () => {
  const { deps, api, exec, foundation } = makeDepsB({ hasBackendKey: false });
  await handleUpdate(textUpdateFrom('/new x'), deps);
  assert.equal(exec.calls.rwaCreateBuild.length, 0);
  assert.equal(foundation.calls.createDoc.length, 0);
  assert.match(api.calls.sendMessage[0].text, /backend|not configured|isn't configured/i);
});

// WHY: /new ALWAYS creates+rebinds fresh — even when a binding already exists. A
// stale binding must not cause /new to be misrouted to the edit path.
test('CREATE /new with an EXISTING binding still creates fresh (rebind), no edit', async () => {
  const state = makeFakeState({ id: 'old', token: 'old-tok', url: 'https://old/' });
  const { deps, exec, foundation } = makeDepsB({ state });
  await handleUpdate(textUpdateFrom('/new fresh doc'), deps);
  assert.equal(exec.calls.rwaCreateBuild.length, 1);
  assert.equal(foundation.calls.createDoc.length, 1);
  assert.equal(foundation.calls.modify.length, 0, '/new must not edit the old doc');
  assert.equal(state.calls.set.length, 1);
});

// ── EDIT (active binding + plain message) ────────────────────────────────────
// WHY: this is the heart of Phase B. The exact pipeline + the EXACT modify payload
// are load-bearing: a wrong envelope version, a missing baseHash, or a wrong actor
// would corrupt the optimistic-concurrency chain or mis-attribute the edit.
test('EDIT active binding + plain message: readDoc→exportDoc→rwaEdit→modify(EXACT payload)→url', async () => {
  const state = makeFakeState({ id: 'doc1', token: TOKEN, url: URL });
  const { deps, api, exec, foundation } = makeDepsB({ state });
  await handleUpdate(textUpdateFrom('make the title bigger', 777), deps);

  // 1) readDoc, 2) exportDoc both with (id, token).
  assert.deepEqual(foundation.calls.readDoc[0], { id: 'doc1', token: TOKEN });
  assert.deepEqual(foundation.calls.exportDoc[0], { id: 'doc1', token: TOKEN });
  // 3) rwaEdit on the exported temp container with the raw instruction.
  assert.equal(exec.calls.rwaEdit.length, 1);
  assert.equal(exec.calls.rwaEdit[0].instruction, 'make the title bigger');
  // 4) modify with the EXACT payload.
  assert.equal(foundation.calls.modify.length, 1);
  assert.deepEqual(foundation.calls.modify[0], {
    id: 'doc1',
    token: TOKEN,
    payload: {
      envelope: { version: 'rwa-edit/1', doc: 'NEW BODY', reason: 'make the title bigger' },
      baseHash: 'hash-1',
      actor: 'telegram:777',
    },
  });
  // reply carries the url.
  assert.ok(api.calls.sendMessage.some((m) => m.text.includes(URL)));
});

// WHY (security): a leading-dash edit instruction is rejected by rwaEdit pre-spawn;
// the bot must surface a friendly reply and NEVER reach modify (a flag-smuggling
// instruction must not silently turn into a no-op edit or a backend redirect).
test('EDIT leading-dash instruction → bad_instruction friendly reply, modify NEVER called', async () => {
  const state = makeFakeState({ id: 'doc1', token: TOKEN, url: URL });
  const exec = makeFakeExecB({ edit: { ok: false, code: 'bad_instruction' } });
  const { deps, api, foundation } = makeDepsB({ state, exec });
  await handleUpdate(textUpdateFrom('-rm everything'), deps);
  assert.equal(foundation.calls.modify.length, 0);
  assert.match(api.calls.sendMessage[0].text, /dash/i);
});

// WHY: an edit also needs a backend key (the agent runs adapter-side). No key →
// friendly "needs a backend" and NO rwaEdit spawn / NO modify.
test('EDIT without backend key → "needs a backend", no rwaEdit, no modify', async () => {
  const state = makeFakeState({ id: 'doc1', token: TOKEN, url: URL });
  const { deps, api, exec, foundation } = makeDepsB({ state, hasBackendKey: false });
  await handleUpdate(textUpdateFrom('change it'), deps);
  assert.equal(exec.calls.rwaEdit.length, 0);
  assert.equal(foundation.calls.modify.length, 0);
  assert.match(api.calls.sendMessage[0].text, /backend|not configured|isn't configured/i);
});

// WHY: a non-bad_instruction rwaEdit failure (the agent gave up, a CLI error) is a
// friendly "couldn't apply that edit" to the user while the raw stderr goes to the
// host log only — same honest-host/friendly-user discipline as Phase A.
test('EDIT rwaEdit fails (agent gave up) → friendly reply + stderr logged, no modify', async () => {
  const state = makeFakeState({ id: 'doc1', token: TOKEN, url: URL });
  const exec = makeFakeExecB({ edit: { ok: false, step: 'edit', code: 4, stderr: 'agent-detail-XYZ' } });
  const { deps, api, foundation, logged } = makeDepsB({ state, exec });
  await handleUpdate(textUpdateFrom('do a thing'), deps);
  assert.equal(foundation.calls.modify.length, 0);
  assert.doesNotMatch(api.calls.sendMessage[0].text, /agent-detail-XYZ/);
  assert.ok(logged.some((a) => a.some((x) => String(x).includes('agent-detail-XYZ'))));
});

// ── 409 stale_base retry-once ────────────────────────────────────────────────
// WHY: optimistic concurrency. A 409 means the doc moved under us; we re-read the
// fresh baseHash and retry modify ONCE. This pins the retry actually re-reads
// (uses the NEW baseHash) and succeeds — a retry against the stale hash would loop.
test('EDIT 409 once then 200: re-readDoc + retry modify once → success reply', async () => {
  const state = makeFakeState({ id: 'doc1', token: TOKEN, url: URL });
  const foundation = makeFakeFoundation({
    modify: (n) => {
      if (n === 1) throw new FoundationError('stale_base', { status: 409, currentHash: 'fresh-hash' });
      return { doc: 'NEW BODY', baseHash: 'hash-after', selfDescription: {}, histLen: 3 };
    },
  });
  const { deps, api } = makeDepsB({ state, foundation });
  await handleUpdate(textUpdateFrom('edit me'), deps);
  // two modify attempts, two readDocs (initial + the re-read on 409).
  assert.equal(foundation.calls.modify.length, 2);
  assert.equal(foundation.calls.readDoc.length, 2);
  // the retry used the FRESH baseHash from the second readDoc (hash-2), not the stale one.
  assert.equal(foundation.calls.modify[1].payload.baseHash, 'hash-2');
  assert.ok(api.calls.sendMessage.some((m) => m.text.includes(URL)));
});

test('EDIT 409 twice: re-read + one retry, still stale → friendly give-up reply', async () => {
  const state = makeFakeState({ id: 'doc1', token: TOKEN, url: URL });
  const foundation = makeFakeFoundation({
    modify: () => { throw new FoundationError('stale_base', { status: 409, currentHash: 'h' }); },
  });
  const { deps, api } = makeDepsB({ state, foundation });
  await handleUpdate(textUpdateFrom('edit me'), deps);
  assert.equal(foundation.calls.modify.length, 2, 'exactly one retry, then give up');
  assert.match(api.calls.sendMessage[0].text, /changed underneath|try again/i);
});

// ── 404 → clear binding ──────────────────────────────────────────────────────
// WHY: a 404 means the hosted doc is gone (expired/swept). The stale binding must
// be CLEARED so the next message creates a fresh doc instead of looping on a dead id.
test('EDIT modify 404 → state.clear(chatId) + friendly "no longer exists"', async () => {
  const state = makeFakeState({ id: 'doc1', token: TOKEN, url: URL });
  const foundation = makeFakeFoundation({
    modify: () => { throw new FoundationError('not_found', { status: 404 }); },
  });
  const { deps, api } = makeDepsB({ state, foundation });
  await handleUpdate(textUpdateFrom('edit me'), deps);
  assert.deepEqual(state.calls.clear, ['42']);
  assert.match(api.calls.sendMessage[0].text, /no longer exists|gone/i);
});

test('EDIT readDoc 404 → state.clear + friendly reply (gone before we even read)', async () => {
  const state = makeFakeState({ id: 'doc1', token: TOKEN, url: URL });
  const foundation = makeFakeFoundation({ readDoc: new FoundationError('not_found', { status: 404 }) });
  const { deps, api } = makeDepsB({ state, foundation });
  await handleUpdate(textUpdateFrom('edit me'), deps);
  assert.deepEqual(state.calls.clear, ['42']);
  assert.match(api.calls.sendMessage[0].text, /no longer exists|gone/i);
});

// ── 401 / 422 friendly mapping ───────────────────────────────────────────────
test('EDIT 401 unauthorized → "edit link expired"', async () => {
  const state = makeFakeState({ id: 'doc1', token: TOKEN, url: URL });
  const foundation = makeFakeFoundation({
    modify: () => { throw new FoundationError('unauthorized', { status: 401 }); },
  });
  const { deps, api } = makeDepsB({ state, foundation });
  await handleUpdate(textUpdateFrom('edit me'), deps);
  assert.match(api.calls.sendMessage[0].text, /expired|link/i);
});

// WHY: a 422 subcode (frozen_zone_violation/find_not_found/…) gets a friendly reply;
// the raw `detail` is HOST-only (it can be verbose/internal) — never sent to the user.
test('EDIT 422 frozen_zone_violation → friendly reply; raw detail logged, NOT sent', async () => {
  const state = makeFakeState({ id: 'doc1', token: TOKEN, url: URL });
  const foundation = makeFakeFoundation({
    modify: () => { throw new FoundationError('frozen_zone_violation', { status: 422, detail: 'raw-internal-DETAIL' }); },
  });
  const { deps, api, logged } = makeDepsB({ state, foundation });
  await handleUpdate(textUpdateFrom('edit me'), deps);
  assert.doesNotMatch(api.calls.sendMessage[0].text, /raw-internal-DETAIL/);
  assert.ok(logged.some((a) => a.some((x) => String(x).includes('raw-internal-DETAIL'))));
});

test('EDIT 400 bad_request → generic "couldn\'t reach the doc service" + log', async () => {
  const state = makeFakeState({ id: 'doc1', token: TOKEN, url: URL });
  const foundation = makeFakeFoundation({
    modify: () => { throw new FoundationError('bad_request', { status: 400 }); },
  });
  const { deps, api } = makeDepsB({ state, foundation });
  await handleUpdate(textUpdateFrom('edit me'), deps);
  assert.match(api.calls.sendMessage[0].text, /couldn't reach|try again/i);
});

test('CREATE createDoc unreachable (request_failed) → friendly reply, no binding saved', async () => {
  const foundation = makeFakeFoundation({ createDoc: new FoundationError('request_failed', { status: 0 }) });
  const { deps, api, state } = makeDepsB({ foundation });
  await handleUpdate(textUpdateFrom('/new x'), deps);
  assert.equal(state.calls.set.length, 0, 'no binding for a doc that was never created');
  assert.match(api.calls.sendMessage[0].text, /couldn't reach|try again/i);
});

// ── /show and /export ────────────────────────────────────────────────────────
test('/show with active binding → describe → reply url + title', async () => {
  const state = makeFakeState({ id: 'doc1', token: TOKEN, url: URL });
  const foundation = makeFakeFoundation({ describe: { title: 'Otter Facts', kind: 'document' } });
  const { deps, api } = makeDepsB({ state, foundation });
  await handleUpdate(textUpdateFrom('/show'), deps);
  assert.deepEqual(foundation.calls.describe[0], { id: 'doc1', token: TOKEN });
  const reply = api.calls.sendMessage[0].text;
  assert.ok(reply.includes(URL));
  assert.match(reply, /Otter Facts/);
});

test('/show with NO active binding → "no active doc" guidance, no describe', async () => {
  const { deps, api, foundation } = makeDepsB();
  await handleUpdate(textUpdateFrom('/show'), deps);
  assert.equal(foundation.calls.describe.length, 0);
  assert.match(api.calls.sendMessage[0].text, /no active doc|send something/i);
});

test('/export with active binding → exportDoc → send the bytes as a document', async () => {
  const sentDocs = [];
  const api = makeFakeApi();
  api.sendDocument = async (chatId, bytes, name) => { sentDocs.push({ chatId, bytes, name }); };
  const state = makeFakeState({ id: 'doc1', token: TOKEN, url: URL });
  const foundation = makeFakeFoundation({ exportDoc: '<html>THE FILE</html>' });
  const { deps } = makeDepsB({ state, foundation, api });
  await handleUpdate(textUpdateFrom('/export'), deps);
  assert.deepEqual(foundation.calls.exportDoc[0], { id: 'doc1', token: TOKEN });
  assert.equal(sentDocs.length, 1);
  assert.equal(sentDocs[0].bytes, '<html>THE FILE</html>');
});

test('/export with NO active binding → "no active doc", no exportDoc', async () => {
  const { deps, api, foundation } = makeDepsB();
  await handleUpdate(textUpdateFrom('/export'), deps);
  assert.equal(foundation.calls.exportDoc.length, 0);
  assert.match(api.calls.sendMessage[0].text, /no active doc|send something/i);
});

// ── rate-limit on the Phase B work paths ─────────────────────────────────────
test('Phase B rate-limited create → slow-down, no build / no createDoc', async () => {
  const { deps, api, exec, foundation } = makeDepsB({ rateLimit: () => false });
  await handleUpdate(textUpdateFrom('wrap me'), deps);
  assert.equal(exec.calls.rwaImportBuild.length, 0);
  assert.equal(foundation.calls.createDoc.length, 0);
  assert.match(api.calls.sendMessage[0].text, /slow down|too many|wait/i);
});

test('Phase B rate-limited edit → slow-down, no rwaEdit / no modify', async () => {
  const state = makeFakeState({ id: 'doc1', token: TOKEN, url: URL });
  const { deps, api, exec, foundation } = makeDepsB({ state, rateLimit: () => false });
  await handleUpdate(textUpdateFrom('edit me'), deps);
  assert.equal(exec.calls.rwaEdit.length, 0);
  assert.equal(foundation.calls.modify.length, 0);
  assert.match(api.calls.sendMessage[0].text, /slow down|too many|wait/i);
});

// ── SECURITY: capability token never replied or logged ───────────────────────
// WHY: the token === write access. The URL (which embeds #k=<token>) is the user's
// edit link and IS replied to the owning chat — but the token must never appear in
// a LOG arg, and no OTHER reply (errors, /show) may interpolate it bare. We scan
// every log arg across create + edit + /show + an error path.
test('SECURITY: capability token never appears in any LOG across create/edit/show/error', async () => {
  // create
  {
    const { deps, logged } = makeDepsB();
    await handleUpdate(textUpdateFrom('/new x'), deps);
    for (const a of logged) assertNoToken(a, 'create log');
  }
  // edit (success)
  {
    const state = makeFakeState({ id: 'doc1', token: TOKEN, url: URL });
    const { deps, logged } = makeDepsB({ state });
    await handleUpdate(textUpdateFrom('edit me'), deps);
    for (const a of logged) assertNoToken(a, 'edit log');
  }
  // /show
  {
    const state = makeFakeState({ id: 'doc1', token: TOKEN, url: URL });
    const { deps, logged } = makeDepsB({ state });
    await handleUpdate(textUpdateFrom('/show'), deps);
    for (const a of logged) assertNoToken(a, 'show log');
  }
  // an error path (422 detail logged) — the token still must not ride along.
  {
    const state = makeFakeState({ id: 'doc1', token: TOKEN, url: URL });
    const foundation = makeFakeFoundation({
      modify: () => { throw new FoundationError('frozen_zone_violation', { status: 422, detail: 'd' }); },
    });
    const { deps, logged } = makeDepsB({ state, foundation });
    await handleUpdate(textUpdateFrom('edit me'), deps);
    for (const a of logged) assertNoToken(a, 'error log');
  }
});

// ── loop survival: a thrown error in Phase B is caught, generic reply, no rethrow ─
test('Phase B: an unexpected throw (state.get blows up) → generic reply + log, no rethrow', async () => {
  const state = makeFakeState({ id: 'doc1', token: TOKEN, url: URL });
  state.get = () => { throw new Error('state kaboom'); };
  const { deps, api, logged } = makeDepsB({ state });
  await handleUpdate(textUpdateFrom('anything'), deps); // must not reject
  assert.match(api.calls.sendMessage[0].text, /something went wrong|try again/i);
  assert.ok(logged.length >= 1);
});
