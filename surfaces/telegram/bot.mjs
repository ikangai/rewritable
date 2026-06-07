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

import { TelegramError, makeTelegramApi } from './telegram-api.mjs';
import { rwaImportPublish, rwaCreatePublish } from './rwa-exec.mjs';

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

/**
 * Dispatch one Telegram update. Pure over injected deps; never throws.
 *
 * @param {object} update  a Telegram Update (we read `message.{chat.id,text,document}`).
 * @param {{
 *   api: { sendMessage:Function, sendChatAction:Function, getFile:Function, downloadFile:Function },
 *   exec: { rwaImportPublish:Function, rwaCreatePublish:Function },
 *   writeTemp: (content:string, ext:string) => string,
 *   hasBackendKey: boolean,
 *   rateLimit: (chatId:any) => boolean,
 *   log: (...args:any[]) => void,
 * }} deps
 */
export async function handleUpdate(update, deps) {
  const { api, exec, writeTemp, hasBackendKey, rateLimit, log } = deps;
  const message = update && update.message;
  if (!message || !message.chat || message.chat.id == null) {
    // No chat to reply to — log and bail (can't message a faceless update).
    log('handleUpdate: update without a chat', update && update.update_id);
    return;
  }
  const chatId = message.chat.id;
  const text = message.text;

  try {
    // 1. /start — always answers help; not rate-limited, no work spawned.
    if (typeof text === 'string' && (text === '/start' || text.startsWith('/start '))) {
      await api.sendMessage(chatId, HELP);
      return;
    }

    // 2. /new <prompt> — agent-fill. Gated on key (cheap boundary gate) THEN
    //    rate limit, both BEFORE any spawn.
    if (typeof text === 'string' && (text === '/new' || text.startsWith('/new '))) {
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
        await api.sendMessage(chatId, "you're going too fast — please slow down and try again in a bit.");
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
        await api.sendMessage(chatId, "you're going too fast — please slow down and try again in a bit.");
        return;
      }
      const file = await api.getFile(document.file_id);
      const dest = writeTemp('', '.' + (extOf(document.file_name) || 'bin'));
      try {
        await api.downloadFile(file.file_path, dest, { maxBytes: MAX_DOC_BYTES });
      } catch (err) {
        if (err instanceof TelegramError && err.code === 'file_too_large') {
          await api.sendMessage(chatId, `that file's too big (max ${MAX_DOC_MB} MB).`);
          return;
        }
        throw err; // other download failures → generic catch below.
      }
      const result = await exec.rwaImportPublish(dest, {});
      await sendResult(api, chatId, result, log);
      return;
    }

    // 4. plain text — wrap. Rate-limited.
    if (typeof text === 'string' && text.length > 0) {
      if (!rateLimit(chatId)) {
        await api.sendMessage(chatId, "you're going too fast — please slow down and try again in a bit.");
        return;
      }
      const path = writeTemp(text, '.md');
      const result = await exec.rwaImportPublish(path, {});
      await sendResult(api, chatId, result, log);
      return;
    }

    // 5. anything else — fallback.
    await api.sendMessage(chatId, 'send me text, a markdown file, or /new <prompt>.');
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
 *
 * @param {{
 *   api: { getUpdates: (offset:number|undefined) => Promise<any[]> },
 *   loadOffset: () => number|undefined,
 *   saveOffset: (n:number) => void,
 *   handle: (update:object) => Promise<void>,
 *   shouldStop: () => boolean,
 *   log: (...args:any[]) => void,
 * }} deps
 */
export async function runPoll(deps) {
  const { api, loadOffset, saveOffset, handle, shouldStop, log } = deps;
  let offset = loadOffset();
  while (!shouldStop()) {
    const updates = (await api.getUpdates(offset)) || [];
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
    hits.set(chatId, arr);
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
  // the current iteration rather than mid-handle.
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
// imports runPoll/handleUpdate does not start the bot).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
