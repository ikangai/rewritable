// bot.mjs — the Telegram adapter's dispatch core.
//
// `handleUpdate(update, deps)` is PURE DISPATCH over injected deps so it is fully
// offline-testable: it never touches the network, disk, env, clock, or RNG
// directly — every effect is a seam in `deps`. The poll loop + `main()` wiring
// (the real `writeTemp`/`rateLimit`/transport) live in the NEXT task; this file
// is dispatch + the constants/helpers it needs only.
//
// Two honesty disciplines run through this file (Rule 12):
//   - FRIENDLY user-side, HONEST host-side: a CLI failure shows the user a
//     short per-step line; the RAW stderr goes to `deps.log` (host), never to the
//     chat. (`replyForResult` returns `{ text, logStderr? }` to keep the two
//     streams separate.)
//   - The loop must survive a bad message: ANY thrown error in handling is
//     caught, logged, and answered with a generic reply — never rethrown.
//
// SECURITY (mirrors the design doc §Security): work paths are gated. agent-fill
// is gated on a backend key AND a per-chat rate limit; the wrap paths are
// rate-limited; documents pass an extension/MIME allowlist BEFORE any network and
// a size cap (enforced by `api.downloadFile`). Each gate's negative is pinned by
// a test that asserts the spawn did NOT happen — not just that the reply differs.

import { pathToFileURL } from 'node:url';
import { TelegramError, makeTelegramApi } from './telegram-api.mjs';
import { rwaImportPublish, rwaCreatePublish } from './rwa-exec.mjs';
import { FoundationError } from './foundation-api.mjs';

// Max document size we accept, in bytes (mirrors telegram-api's downloadFile
// default; passed explicitly so the friendly "max N MB" message stays truthful).
const MAX_DOC_BYTES = 20 * 1024 * 1024;
const MAX_DOC_MB = Math.round(MAX_DOC_BYTES / (1024 * 1024));

// Allowed document types — `rwa import` owns converters for exactly these.
// Matched by file extension (from file_name) OR mime type, whichever is present.
const ALLOWED_EXTS = ['pdf', 'docx', 'csv', 'txt', 'md', 'html'];
const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/csv',
  'text/plain',
  'text/markdown',
  'text/html',
]);

export const HELP = [
  'Hi! I turn what you send me into a shareable web page.',
  '',
  '• Send me text or a markdown file — I wrap it into a page.',
  '• Send a document (pdf, docx, csv, txt, md, html) — same thing.',
  '• /new <topic> — I generate a page from a prompt (if agent-fill is enabled).',
  '',
  'Each share is a link that expires in 24h.',
].join('\n');

// Phase-B help. When editing is enabled a chat keeps ONE active page and plain
// messages become edits to it. /show and /export surface the active page. Replied
// by /start when `foundationEnabled` is true (the same `/start` front door).
export const HELP_PHASE_B = [
  'Hi! I turn what you send me into an editable web page.',
  '',
  '• Send me text, a markdown file, or a document — I create a page and give you a link.',
  '• /new <topic> — generate a page from a prompt (needs a backend configured).',
  '• Once you have a page, just send me changes (e.g. "make the title bigger") and I edit it.',
  '• /new always starts a fresh page.',
  '• /show — show your current page; /export — get the .html file.',
  '',
  'The link is your private edit link — keep it to yourself.',
].join('\n');

// Map an rwa-exec result object to user-facing text (+ optional host-only
// stderr). The ONLY place result codes become words — one contract per code.
// Returns `{ text, logStderr? }`: `text` goes to the chat, `logStderr` (when
// set) goes to `deps.log` and NEVER to the chat (honest host / friendly user).
export function replyForResult(result) {
  if (result && result.ok) {
    return { text: `Here's your page:\n${result.url}\n\n⚠️ expires in 24h` };
  }
  const code = result ? result.code : undefined;
  if (code === 'agent_not_configured') {
    return { text: "agent-fill isn't configured on this bot." };
  }
  if (code === 'bad_prompt') {
    return { text: 'please start your prompt with a word, not a dash.' };
  }
  if (code === 'no_url') {
    return { text: "published but couldn't read the link — try again." };
  }
  // Numeric exit code → a friendly per-step line; the raw stderr is host-only.
  const step = result ? result.step : undefined;
  let text;
  if (step === 'import') text = "sorry, I couldn't read that document.";
  else if (step === 'create') text = "sorry, I couldn't generate that — try a different prompt.";
  else text = "something went wrong publishing that — try again.";
  return { text, logStderr: (result && result.stderr) || '' };
}

// Lowercase extension from a file name (no leading dot), or '' if none.
function extOf(fileName) {
  if (typeof fileName !== 'string') return '';
  const i = fileName.lastIndexOf('.');
  return i >= 0 ? fileName.slice(i + 1).toLowerCase() : '';
}

function isAllowedDocument(document) {
  const ext = extOf(document.file_name);
  if (ext && ALLOWED_EXTS.includes(ext)) return true;
  if (document.mime_type && ALLOWED_MIME.has(document.mime_type)) return true;
  return false;
}

// Send `replyForResult`'s output: friendly text to the chat, raw stderr (if any)
// to the host log only.
async function sendResult(api, chatId, result, log) {
  const { text, logStderr } = replyForResult(result);
  if (logStderr) log('rwa-exec stderr:', logStderr);
  await api.sendMessage(chatId, text);
}

// Shared rate-limit "slow down" reply — one string so Phase A and Phase B agree.
const SLOW_DOWN = "you're going too fast — please slow down and try again in a bit.";

// Match a slash command (`/cmd` or `/cmd <args>`) WITHOUT matching a longer word
// (e.g. /new must not match /newsletter). The trailing-space requirement is the
// word boundary (review I1 in Phase A); `text === cmd` covers the bare command.
function isCommand(text, cmd) {
  return typeof text === 'string' && (text === cmd || text.startsWith(cmd + ' '));
}

/**
 * Dispatch one Telegram update. Pure over injected deps; never throws.
 *
 * Two modes, gated by `deps.foundationEnabled`:
 *   - FALSE → Phase A (`dispatchPhaseA`): create-and-publish to the ephemeral
 *     service, exactly as before. The foundation + state are NEVER touched.
 *   - TRUE  → Phase B (`dispatchPhaseB`): each chat binds to ONE editable hosted
 *     rewritable; create-y messages build+`createDoc`, plain messages edit.
 *
 * The message-validity check and the loop-survival try/catch live here so BOTH
 * dispatchers get the same "never rethrow" guarantee (the poll loop must survive
 * one bad message).
 *
 * @param {object} update  a Telegram Update (we read `message.{chat.id,from.id,text,document}`).
 * @param {{
 *   api: { sendMessage:Function, sendChatAction:Function, getFile:Function, downloadFile:Function, sendDocument?:Function },
 *   exec: { rwaImportPublish:Function, rwaCreatePublish:Function, rwaImportBuild:Function, rwaCreateBuild:Function, rwaEdit:Function },
 *   foundation?: { createDoc:Function, readDoc:Function, exportDoc:Function, describe:Function, modify:Function },
 *   state?: { get:Function, set:Function, clear:Function },
 *   foundationEnabled?: boolean,
 *   writeTemp: (content:string, ext:string) => string,
 *   hasBackendKey: boolean,
 *   rateLimit: (chatId:any) => boolean,
 *   log: (...args:any[]) => void,
 * }} deps
 */
export async function handleUpdate(update, deps) {
  const { api, log } = deps;
  const message = update && update.message;
  if (!message || !message.chat || message.chat.id == null) {
    // No chat to reply to — log and bail (can't message a faceless update).
    log('handleUpdate: update without a chat', update && update.update_id);
    return;
  }
  const chatId = message.chat.id;

  try {
    if (deps.foundationEnabled) {
      await dispatchPhaseB(message, chatId, deps);
    } else {
      await dispatchPhaseA(message, chatId, deps);
    }
  } catch (err) {
    // Loop-survival contract: never let a thrown error escape. Log host-side,
    // answer the user generically. (Best-effort: if the reply itself throws,
    // swallow — we still must not rethrow.)
    log(err);
    try {
      await api.sendMessage(chatId, 'something went wrong, try again.');
    } catch (replyErr) {
      log('handleUpdate: failed to send error reply', replyErr);
    }
  }
}

// ── Phase A dispatch (foundationEnabled === false) ───────────────────────────
// Byte-intact create-and-publish-ephemeral path. Touches ONLY api/exec/writeTemp/
// rateLimit/hasBackendKey/log — never the foundation or the state store (the
// no-regression guarantee, pinned by the gate-off tests).
async function dispatchPhaseA(message, chatId, deps) {
  const { api, exec, writeTemp, hasBackendKey, rateLimit, log } = deps;
  const text = message.text;

  // 1. /start — always answers help; not rate-limited, no work spawned.
  if (isCommand(text, '/start')) {
    await api.sendMessage(chatId, HELP);
    return;
  }

  // 2. /new <prompt> — agent-fill. Gated on key (cheap boundary gate) THEN
  //    rate limit, both BEFORE any spawn.
  if (isCommand(text, '/new')) {
    const prompt = text.slice('/new'.length).trim();
    if (!prompt) {
      await api.sendMessage(chatId, 'give me a topic, e.g. /new a doc about otters');
      return;
    }
    if (!hasBackendKey) {
      await api.sendMessage(chatId, "agent-fill isn't configured on this bot.");
      return;
    }
    if (!rateLimit(chatId)) {
      await api.sendMessage(chatId, SLOW_DOWN);
      return;
    }
    await api.sendChatAction(chatId, 'typing');
    const result = await exec.rwaCreatePublish(prompt, { hasBackendKey });
    await sendResult(api, chatId, result, log);
    return;
  }

  // 3. document — download (allowlist + size cap) then wrap. Rate-limited.
  if (message.document) {
    const document = message.document;
    if (!isAllowedDocument(document)) {
      await api.sendMessage(chatId, "I can't read that file type. Send a pdf, docx, csv, txt, md, or html.");
      return;
    }
    if (!rateLimit(chatId)) {
      await api.sendMessage(chatId, SLOW_DOWN);
      return;
    }
    const dest = await downloadDocumentToTemp(message.document, chatId, deps);
    if (dest == null) return; // a friendly reply was already sent.
    const result = await exec.rwaImportPublish(dest, {});
    await sendResult(api, chatId, result, log);
    return;
  }

  // 4. plain text — wrap. Rate-limited.
  if (typeof text === 'string' && text.length > 0) {
    if (!rateLimit(chatId)) {
      await api.sendMessage(chatId, SLOW_DOWN);
      return;
    }
    const path = writeTemp(text, '.md');
    const result = await exec.rwaImportPublish(path, {});
    await sendResult(api, chatId, result, log);
    return;
  }

  // 5. anything else — fallback.
  await api.sendMessage(chatId, 'send me text, a markdown file, or /new <prompt>.');
}

// Download an allowed Telegram document into a fresh temp file and return its
// path, or null after sending the user a friendly reply (too-big / fetch-failed).
// Shared by Phase A (wrap) and Phase B (build) so the size cap + missing-path
// guards stay in one place. Caps BEFORE the getFile round-trip using the free
// message.document.file_size (downloadFile keeps its own cap as defense-in-depth).
async function downloadDocumentToTemp(document, chatId, deps) {
  const { api, writeTemp } = deps;
  if (typeof document.file_size === 'number' && document.file_size > MAX_DOC_BYTES) {
    await api.sendMessage(chatId, `that file's too big (max ${MAX_DOC_MB} MB).`);
    return null;
  }
  const file = await api.getFile(document.file_id);
  if (!file || !file.file_path) {
    await api.sendMessage(chatId, "couldn't fetch that file, try again.");
    return null;
  }
  const dest = writeTemp('', '.' + (extOf(document.file_name) || 'bin'));
  try {
    await api.downloadFile(file.file_path, dest, { maxBytes: MAX_DOC_BYTES });
  } catch (err) {
    if (err instanceof TelegramError && err.code === 'file_too_large') {
      await api.sendMessage(chatId, `that file's too big (max ${MAX_DOC_MB} MB).`);
      return null;
    }
    throw err; // other download failures → generic catch in handleUpdate.
  }
  return dest;
}

// ── Phase B dispatch (foundationEnabled === true) ────────────────────────────
// Each chat binds to ONE editable hosted rewritable. /new (or a create-y message
// with no binding) BUILDS a container locally then POSTs the BYTES to the
// foundation; a plain message against an active binding is an EDIT. The capability
// token in the binding is a SECRET — only the url is ever replied (and only to the
// owning chat), never logged.
async function dispatchPhaseB(message, chatId, deps) {
  const { api, foundation, state, hasBackendKey, rateLimit } = deps;
  const text = message.text;

  // /start — always answers Phase-B help; not rate-limited, no work spawned.
  if (isCommand(text, '/start')) {
    await api.sendMessage(chatId, HELP_PHASE_B);
    return;
  }

  // /show — surface the active doc (url + title via describe). No binding → guide.
  if (isCommand(text, '/show')) {
    const binding = state.get(chatId);
    if (!binding) {
      await api.sendMessage(chatId, 'no active doc — send me something to create one.');
      return;
    }
    const sd = await foundation.describe(binding.id, binding.token);
    const title = (sd && sd.title) ? sd.title : '(untitled)';
    await api.sendMessage(chatId, `${title}\n${binding.url}`);
    return;
  }

  // /export — send the canonical .html file (the offline escape hatch).
  if (isCommand(text, '/export')) {
    const binding = state.get(chatId);
    if (!binding) {
      await api.sendMessage(chatId, 'no active doc — send me something to create one.');
      return;
    }
    const bytes = await foundation.exportDoc(binding.id, binding.token);
    if (typeof api.sendDocument === 'function') {
      await api.sendDocument(chatId, bytes, 'page.html');
    } else {
      // No document transport — fall back to the url (still the user's artifact).
      await api.sendMessage(chatId, `here's your page:\n${binding.url}`);
    }
    return;
  }

  // /new ALWAYS creates+rebinds fresh — even if a binding exists. Otherwise, an
  // existing binding makes a plain message an EDIT and a fresh chat a CREATE.
  const isNew = isCommand(text, '/new');
  const binding = isNew ? null : state.get(chatId);

  if (!isNew && binding) {
    await editActiveDoc(message, chatId, binding, deps);
    return;
  }

  // CREATE path. Rate-limit the work BEFORE any spawn.
  if (isNew) {
    const prompt = text.slice('/new'.length).trim();
    if (!prompt) {
      await api.sendMessage(chatId, 'give me a topic, e.g. /new a doc about otters');
      return;
    }
    if (!hasBackendKey) {
      await api.sendMessage(chatId, 'agent-fill needs a backend configured on this bot.');
      return;
    }
    if (!rateLimit(chatId)) {
      await api.sendMessage(chatId, SLOW_DOWN);
      return;
    }
    await api.sendChatAction(chatId, 'typing');
    const built = await deps.exec.rwaCreateBuild(prompt, { hasBackendKey });
    await createFromBuild(built, chatId, deps);
    return;
  }

  // Create from a document (download → import-build → createDoc).
  if (message.document) {
    const document = message.document;
    if (!isAllowedDocument(document)) {
      await api.sendMessage(chatId, "I can't read that file type. Send a pdf, docx, csv, txt, md, or html.");
      return;
    }
    if (!rateLimit(chatId)) {
      await api.sendMessage(chatId, SLOW_DOWN);
      return;
    }
    const dest = await downloadDocumentToTemp(document, chatId, deps);
    if (dest == null) return;
    const built = await deps.exec.rwaImportBuild(dest, {});
    await createFromBuild(built, chatId, deps);
    return;
  }

  // Create from plain text (temp .md → import-build → createDoc).
  if (typeof text === 'string' && text.length > 0) {
    if (!rateLimit(chatId)) {
      await api.sendMessage(chatId, SLOW_DOWN);
      return;
    }
    const path = deps.writeTemp(text, '.md');
    const built = await deps.exec.rwaImportBuild(path, {});
    await createFromBuild(built, chatId, deps);
    return;
  }

  // Anything else — fallback guidance.
  await api.sendMessage(chatId, 'send me text, a markdown file, a document, or /new <prompt>.');
}

// Given a build result (`{ok:true,bytes}` or a failure object), POST the bytes to
// the foundation, bind the chat to the returned {id,token,url}, and reply the url.
// A build failure becomes the same friendly reply Phase A uses (replyForResult).
async function createFromBuild(built, chatId, deps) {
  const { api, foundation, state, log } = deps;
  if (!built || !built.ok) {
    await sendResult(api, chatId, built, log); // friendly per-step line; stderr host-only.
    return;
  }
  const created = await foundation.createDoc(built.bytes);
  // Persist the binding (carries the capability token — never logged/replied bare).
  state.set(chatId, { id: created.id, token: created.token, url: created.url });
  await api.sendMessage(
    chatId,
    `here's your page — you can keep editing it, just send me changes:\n${created.url}`,
  );
}

// EDIT an active hosted doc: readDoc(baseHash) → exportDoc(temp) → rwaEdit →
// modify(replace_document). The instruction is attacker-controlled (rwaEdit rejects
// a leading dash pre-spawn); the agent needs a backend key. Optimistic concurrency:
// a 409 stale_base re-reads the fresh baseHash and retries modify ONCE.
async function editActiveDoc(message, chatId, binding, deps) {
  const { api, exec, foundation, hasBackendKey, rateLimit, writeTemp, log } = deps;
  const text = message.text;

  // Only a non-empty plain message is an edit instruction.
  if (typeof text !== 'string' || text.length === 0) {
    await api.sendMessage(chatId, 'send me a change to make (e.g. "make the title bigger"), or /new to start over.');
    return;
  }
  if (!hasBackendKey) {
    await api.sendMessage(chatId, 'editing needs a backend configured on this bot.');
    return;
  }
  if (!rateLimit(chatId)) {
    await api.sendMessage(chatId, SLOW_DOWN);
    return;
  }

  await api.sendChatAction(chatId, 'typing');

  // 1. Read the current doc (for the baseHash that anchors optimistic concurrency).
  let read;
  try {
    read = await foundation.readDoc(binding.id, binding.token);
  } catch (err) {
    await handleFoundationError(err, chatId, deps, { stage: 'read' });
    return;
  }

  // 2. Export the canonical container to a temp .html the local agent can edit.
  let tempPath;
  try {
    const bytes = await foundation.exportDoc(binding.id, binding.token);
    tempPath = writeTemp(bytes, '.html');
  } catch (err) {
    await handleFoundationError(err, chatId, deps, { stage: 'export' });
    return;
  }

  try {
    // 3. Apply the edit locally via the rwa CLI (leading-dash-guarded inside rwaEdit).
    const edited = await exec.rwaEdit(tempPath, text, {});
    if (!edited || !edited.ok) {
      if (edited && edited.code === 'bad_instruction') {
        await api.sendMessage(chatId, "please don't start an edit with a dash — try rewording it.");
      } else {
        if (edited && edited.stderr) log('rwa-exec stderr:', edited.stderr);
        await api.sendMessage(chatId, "sorry, I couldn't apply that edit — try rewording it.");
      }
      return;
    }

    // 4. Commit the whole new body via replace_document, with 409 retry-once.
    await modifyWithRetry(binding, read.baseHash, text, edited.doc, message, chatId, deps);
  } finally {
    // 5. Clean the exported temp container (writeTemp is a real file in main()).
    if (deps.unlinkTemp) {
      try { await deps.unlinkTemp(tempPath); } catch (e) { log('editActiveDoc: temp cleanup failed', e); }
    }
  }
}

// Build the rwa-edit/1 replace_document envelope + actor, POST /modify, and on a
// 409 stale_base re-read the fresh baseHash and retry exactly ONCE.
async function modifyWithRetry(binding, baseHash, instruction, newBody, message, chatId, deps) {
  const { api, foundation } = deps;
  const actor = 'telegram:' + ((message.from && message.from.id) ?? 'unknown');
  const buildPayload = (hash) => ({
    envelope: { version: 'rwa-edit/1', doc: newBody, reason: instruction },
    baseHash: hash,
    actor,
  });

  try {
    await foundation.modify(binding.id, binding.token, buildPayload(baseHash));
    await api.sendMessage(chatId, `✓ updated — ${binding.url}`);
    return;
  } catch (err) {
    if (!(err instanceof FoundationError) || err.code !== 'stale_base') {
      await handleFoundationError(err, chatId, deps, { stage: 'modify' });
      return;
    }
    // 409: the doc moved under us. Re-read the fresh baseHash and retry ONCE.
  }

  let fresh;
  try {
    fresh = await foundation.readDoc(binding.id, binding.token);
  } catch (err) {
    await handleFoundationError(err, chatId, deps, { stage: 'read' });
    return;
  }
  try {
    await foundation.modify(binding.id, binding.token, buildPayload(fresh.baseHash));
    await api.sendMessage(chatId, `✓ updated — ${binding.url}`);
  } catch (err) {
    if (err instanceof FoundationError && err.code === 'stale_base') {
      await api.sendMessage(chatId, 'the doc changed underneath me — try again.');
      return;
    }
    await handleFoundationError(err, chatId, deps, { stage: 'modify' });
  }
}

// Map a FoundationError (by `.code`) to a friendly reply. The raw `detail` and the
// error object go to `log` (host-only) — NEVER to the user (it can be verbose /
// internal). A 404 clears the now-dead chat binding so the next message creates
// fresh. The capability token is never in `log` here (we never log the binding).
async function handleFoundationError(err, chatId, deps, { stage } = {}) {
  const { api, state, log } = deps;
  const code = err instanceof FoundationError ? err.code : undefined;

  if (code === 'unauthorized') {
    await api.sendMessage(chatId, "this doc's edit link expired — start over with /new.");
    return;
  }
  if (code === 'not_found') {
    state.clear(chatId);
    await api.sendMessage(chatId, 'that doc no longer exists — send me something to create a new one.');
    return;
  }
  // A 422 subcode (frozen_zone_violation / find_not_found / …): friendly + log detail.
  if (err instanceof FoundationError && err.status === 422) {
    log('foundation modify rejected:', code, err.detail);
    await api.sendMessage(chatId, friendly422(code));
    return;
  }
  // bad_request / request_failed / non-JSON / anything else → generic + log.
  log('foundation error', stage, code, err instanceof FoundationError ? err.detail : err);
  await api.sendMessage(chatId, "couldn't reach the doc service — try again.");
}

// Per-subcode friendly text for a 422. Unknown subcodes get a safe generic line.
function friendly422(code) {
  if (code === 'frozen_zone_violation') return "that change touches a locked part of the page — I couldn't make it.";
  if (code === 'find_not_found') return "I couldn't find what to change — try describing it differently.";
  if (code === 'find_not_unique') return 'that matched more than one place — be more specific.';
  return "I couldn't apply that edit — try rewording it.";
}

// Re-export so the wiring + tests can reference the same cap handleUpdate uses
// (one source of truth for the document size limit).
export { MAX_DOC_BYTES };

/**
 * The long-poll loop. Pure-ish over injected deps so it is fully offline-
 * testable: every effect (network, persistence, dispatch, clock/stop signal,
 * logging) is a seam in `deps`.
 *
 * Offset semantics (mirrors the design's "Data flow, lifecycle"):
 *   1. Seed `offset` ONCE from `loadOffset()` at start — the resume point.
 *   2. Each iteration: `getUpdates(offset)` returns a batch; for each update IN
 *      ORDER, `handle(update)` inside try/catch. A thrown handler is LOGGED and
 *      does NOT stop the loop (loop survival — one bad message can't kill the
 *      bot). AFTER handling-or-error, advance `offset = update_id + 1` and
 *      `saveOffset(offset)`. Persisting past a thrown update is deliberate: a
 *      transient failure must not cause that update to be reprocessed forever
 *      (Telegram drops <= offset-1 on the next getUpdates).
 *   3. An empty batch → re-poll (no offset change, no save).
 *   4. `shouldStop()` is checked at the top of each iteration so the loop can be
 *      terminated cleanly (tests; SIGINT/SIGTERM in `main`).
 *   5. A `getUpdates` REJECTION (network blip / Telegram 5xx) is LOGGED, backed
 *      off (`sleep(errorBackoffMs)`), and the loop `continue`s — NOTHING was
 *      handled so the offset is neither advanced nor saved. This mirrors the
 *      per-update throw-survival above: a transient poll failure must not be
 *      fatal (unhandled rejection → process death). `sleep`/`errorBackoffMs` are
 *      seams so tests apply the backoff with no real timers.
 *
 * @param {{
 *   api: { getUpdates: (offset:number|undefined) => Promise<any[]> },
 *   loadOffset: () => number|undefined,
 *   saveOffset: (n:number) => void,
 *   handle: (update:object) => Promise<void>,
 *   shouldStop: () => boolean,
 *   log: (...args:any[]) => void,
 *   sleep?: (ms:number) => Promise<void>,
 *   errorBackoffMs?: number,
 * }} deps
 */
export async function runPoll(deps) {
  const {
    api, loadOffset, saveOffset, handle, shouldStop, log,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    errorBackoffMs = 3000,
  } = deps;
  let offset = loadOffset();
  while (!shouldStop()) {
    let updates;
    try {
      updates = (await api.getUpdates(offset)) || [];
    } catch (err) {
      // getUpdates rejection (network blip / Telegram 5xx): log host-side
      // (TelegramError is already token-redacted), back off, then re-poll. Do
      // NOT advance/save the offset — nothing was handled.
      log('runPoll: getUpdates failed', err);
      await sleep(errorBackoffMs);
      continue;
    }
    for (const update of updates) {
      try {
        await handle(update);
      } catch (err) {
        // Loop survival: log host-side, never rethrow — the loop continues and
        // the offset still advances past this update below.
        log('runPoll: handler threw', err);
      }
      // Advance + persist AFTER handling-or-error so a transient failure is not
      // reprocessed forever. update_id+1 is the next-poll resume point.
      if (update && typeof update.update_id === 'number') {
        offset = update.update_id + 1;
        saveOffset(offset);
      }
    }
    // Empty batch falls through to re-poll with the same offset (no save).
  }
}

// ── main(): real-dependency wiring ───────────────────────────────────────────
// NOT unit-tested (it touches env, the network, disk, and process signals); it
// is GUARDED below so importing this module for tests does not start polling.

// Read the persisted offset from a small file (best-effort). Default undefined
// so the first getUpdates resumes from Telegram's own backlog. Path is
// configurable via RWA_TG_OFFSET_FILE, else os.tmpdir()/rwa-tg-offset.
function makeOffsetPersistence(fs, os, path) {
  const file = process.env.RWA_TG_OFFSET_FILE
    || path.join(os.tmpdir(), 'rwa-tg-offset');
  return {
    loadOffset() {
      try {
        const n = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
        return Number.isFinite(n) ? n : undefined;
      } catch {
        return undefined; // no file yet / unreadable → start fresh.
      }
    },
    saveOffset(n) {
      try {
        fs.writeFileSync(file, String(n), 'utf8');
      } catch (err) {
        // Persistence is best-effort; a failure to save only risks re-delivery
        // of already-handled updates on the next restart, not data loss.
        console.error('offset save failed', err);
      }
    },
  };
}

// A simple in-memory sliding-window rate limiter: at most `max` calls per
// `windowMs` per chat. No deps, no RNG. Returns true if the call is allowed.
function makeRateLimit(max = 5, windowMs = 60_000) {
  const hits = new Map(); // chatId -> number[] (timestamps)
  return function rateLimit(chatId) {
    const now = Date.now();
    const arr = (hits.get(chatId) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      hits.set(chatId, arr);
      return false;
    }
    arr.push(now);
    if (arr.length === 0) hits.delete(chatId); else hits.set(chatId, arr);
    return true;
  };
}

// agent-fill (rwa create) is usable when the resolved backend is keyless
// (ollama/lmstudio) OR a key is present for the key-requiring backend
// (openrouter). Mirrors cli backend resolution (cli/src/create.mjs:217 default +
// cli/src/backend.mjs resolveApiKey/envBaseUrl: openrouter is the only
// key-requiring backend, ollama/lmstudio are keyless) so the bot's gate matches
// the CLI's actual capability (a keyless host shouldn't be told "not configured").
export function resolveHasBackendKey(env = process.env) {
  const backend = (env.RWA_BACKEND || 'openrouter').toLowerCase();
  if (backend === 'ollama' || backend === 'lmstudio') return true;        // keyless
  if (backend === 'openrouter') return !!(env.RWA_OPENROUTER_KEY || env.OPENROUTER_API_KEY);
  // unknown backend: require *some* key env to be safe (conservative)
  return !!(env.RWA_OPENROUTER_KEY || env.OPENROUTER_API_KEY);
}

export async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('error: TELEGRAM_BOT_TOKEN is not set. Export it and retry.');
    process.exit(1);
  }

  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const crypto = await import('node:crypto');

  const api = makeTelegramApi(token);

  // agent-fill is enabled when the resolved backend is usable: keyless backends
  // (ollama/lmstudio) always, openrouter only with a key. Mirrors the CLI's own
  // backend resolution so a keyless host isn't wrongly told "not configured".
  const hasBackendKey = resolveHasBackendKey();

  // Real writeTemp: a unique name under os.tmpdir() (crypto.randomUUID, never
  // Math.random) + the given extension. These are small text files; cleanup is
  // best-effort (OS tmp reaping).
  // TODO(phase-a): wrap-path input temp files written here are left for
  // best-effort OS reaping; an explicit unlink-after-handle is a later tidy-up
  // (rwa-exec already cleans its own output dirs).
  function writeTemp(content, ext) {
    const dest = path.join(os.tmpdir(), `rwa-tg-${crypto.randomUUID()}${ext}`);
    fs.writeFileSync(dest, content, 'utf8');
    return dest;
  }

  const rateLimit = makeRateLimit();
  const log = (...args) => console.error(...args);

  const { loadOffset, saveOffset } = makeOffsetPersistence(fs, os, path);

  const handle = (u) => handleUpdate(u, {
    api,
    exec: { rwaImportPublish, rwaCreatePublish },
    writeTemp,
    hasBackendKey,
    rateLimit,
    log,
  });

  // Clean shutdown: a SIGINT/SIGTERM flips the stop flag so runPoll exits after
  // the current iteration rather than mid-handle. Shutdown lag is bounded by the
  // long-poll `timeout` (~50s) the in-flight getUpdates is waiting on — not a
  // hang; the loop ends as soon as that poll returns and shouldStop() is checked.
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  log(`rwa telegram bot started (agent-fill: ${hasBackendKey ? 'on' : 'off'})`);
  await runPoll({
    api,
    loadOffset,
    saveOffset,
    handle,
    shouldStop: () => stopping,
    log,
  });
}

// Guard: only poll when run directly, never on import (so the test suite that
// imports runPoll/handleUpdate does not start the bot). pathToFileURL(argv[1])
// matches import.meta.url's percent-encoding + triple-slash form, so the guard
// still fires on a script path containing spaces (e.g. "Application Support")
// instead of silently never launching (Rule 12).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
