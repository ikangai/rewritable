'use strict';

// Hosted-runtime store + capability auth for the /r endpoints (Task 3).
//
// A "hosted rwa" is a rewritable the service stores on the publisher's behalf
// so it can be read (and, in Task 4, edited) over HTTP. Access is gated by a
// single high-entropy capability token minted at create time:
//   - the token is returned ONCE to the creator (in the create response + the
//     projection URL fragment) and NEVER stored;
//   - only its sha-256 hash (capHash) is persisted, in owner.json;
//   - every authenticated read compares the presented token to capHash with a
//     constant-time digest compare.
//
// Store layout (under DATA_DIR/r/, disjoint from the /s/ share files):
//   DATA_DIR/r/<id>/current.html   canonical bytes (a real rewritable)
//   DATA_DIR/r/<id>/owner.json     { capHash, createdAt, lastAccess }
//
// Zero npm deps; node: builtins only. The self-description reader the describe/
// doc routes need is the vendored ESM identity.mjs, imported from the (async)
// route handlers, not here — this module stays the pure store + auth primitives.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ─── Container validation (shared with /publish's rules) ────────────────────
// Identical to server.js's validateContainer / UUID_RE: a rewritable carries
// exactly one DOC_UUID line, the rwa-bootstrap script tag, and the INLINE_DOC
// marker. Exported so server.js's /r path uses ONE validator (server.js's
// /publish keeps its own byte-stable copy — these must stay in step).
const UUID_RE = /const DOC_UUID = '[0-9a-f-]{36}';/;
const BOOTSTRAP_RE = /<script id="rwa-bootstrap"/;
const INLINE_DOC_RE = /const INLINE_DOC = `/;

function validateContainer(text) {
  const matches = text.match(new RegExp(UUID_RE.source, 'g')) || [];
  if (matches.length === 0) return { ok: false, detail: 'missing DOC_UUID line' };
  if (matches.length > 1) return { ok: false, detail: 'multiple DOC_UUID lines (must be exactly one)' };
  if (!BOOTSTRAP_RE.test(text)) return { ok: false, detail: 'missing rwa-bootstrap script tag' };
  if (!INLINE_DOC_RE.test(text)) return { ok: false, detail: 'missing INLINE_DOC marker' };
  return { ok: true };
}

// ─── Id generation ──────────────────────────────────────────────────────────
// Hosted ids are 12-char base36 — a DIFFERENT length from the 8-char /s/ share
// short codes ON PURPOSE. Per-subdomain origin isolation (the /r/ deploy gate,
// docs/plans/2026-08-13-hosted-regular-user-flow-design.md §4.1) serves each
// hosted rwa at <id>.rewritable.<tld>; distinct lengths keep the hosted host
// pattern disjoint from the share host pattern under one wildcard cert, so the
// two Traefik HostRegexp rules ({8} vs {12}) can never both match a host.
const HOSTED_ID_LEN = 12;
// Traversal guard for readHosted: lenient on length (8..20) so any pre-existing
// short id still resolves; the exact-12 constraint lives in the host router.
const ID_RE = /^[0-9a-z]{8,20}$/;
const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function hostedRoot(dataDir) {
  return path.join(dataDir, 'r');
}

function idDir(dataDir, id) {
  return path.join(hostedRoot(dataDir), id);
}

function generateId(dataDir) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const bytes = crypto.randomBytes(HOSTED_ID_LEN);
    let s = '';
    for (let i = 0; i < HOSTED_ID_LEN; i++) s += ID_ALPHABET[bytes[i] % 36];
    if (!fs.existsSync(idDir(dataDir, s))) return s;
  }
  throw new Error('could not generate unique hosted id after 5 attempts');
}

// ─── Capability tokens ──────────────────────────────────────────────────────

// 32 random bytes → base64url with no padding = 43 chars. ~256 bits of entropy:
// unguessable, so the token alone is the access control.
function mintToken() {
  return crypto.randomBytes(32).toString('base64url');
}

// The at-rest form of a token. owner.json stores ONLY this, never the token.
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Constant-time compare of a presented token against a stored capHash. Returns
// false (never throws) for any malformed input — the auth path feeds raw header
// bytes here and a thrown error would surface as a 500. We compare the HASHES
// (fixed 32-byte digests) so timingSafeEqual always sees equal-length buffers.
function verifyToken(token, capHash) {
  if (typeof token !== 'string' || token.length === 0) return false;
  if (typeof capHash !== 'string' || !/^[0-9a-f]{64}$/.test(capHash)) return false;
  const presented = Buffer.from(hashToken(token), 'hex');
  const stored = Buffer.from(capHash, 'hex');
  if (presented.length !== stored.length) return false;
  return crypto.timingSafeEqual(presented, stored);
}

// ─── Atomic write (mirrors server.js atomicWriteFile) ──────────────────────
function atomicWriteFile(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

// ─── ingest: validate → rotate DOC_UUID → store ─────────────────────────────

class HostedError extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Validate raw .html bytes as a rewritable, rotate its DOC_UUID to a fresh
 * value (so the hosted copy is its own container at this origin), mint a
 * capability token, and write current.html + owner.json under dataDir/r/<id>/.
 *
 * @param {string|Buffer} bytes — raw container bytes
 * @param {{dataDir:string}} opts
 * @returns {{id:string, token:string, url?:string}} the new id + the one-time token
 * @throws {HostedError} code:'not_a_rewritable' if validation fails
 */
function ingest(bytes, { dataDir }) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
  const val = validateContainer(text);
  if (!val.ok) throw new HostedError('not_a_rewritable', val.detail);

  // Each hosted copy gets its own DOC_UUID — the publisher's local file and the
  // hosted snapshot are intentionally distinct containers (same rule as /publish).
  const newUuid = crypto.randomUUID();
  const newText = text.replace(UUID_RE, `const DOC_UUID = '${newUuid}';`);

  const id = generateId(dataDir);
  const dir = idDir(dataDir, id);
  fs.mkdirSync(dir, { recursive: true });

  const token = mintToken();
  const now = Date.now();
  const owner = { capHash: hashToken(token), createdAt: now, lastAccess: now };

  // current.html first, then owner.json: owner.json is the existence marker the
  // read path keys on, so writing it last avoids a window where an id resolves
  // but its bytes aren't there yet.
  atomicWriteFile(path.join(dir, 'current.html'), newText);
  atomicWriteFile(path.join(dir, 'owner.json'), JSON.stringify(owner));

  return { id, token };
}

// ─── readHosted: store lookup ───────────────────────────────────────────────

/**
 * Load a hosted record by id. Returns null (not throws) for an unknown or
 * malformed id — the id is validated against ID_RE so a traversal-shaped id can
 * never escape the store directory.
 *
 * @param {string} id
 * @param {{dataDir:string}} opts
 * @returns {{id:string, bytes:string, owner:object}|null}
 */
function readHosted(id, { dataDir }) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  const dir = idDir(dataDir, id);
  let ownerRaw, bytes;
  try {
    ownerRaw = fs.readFileSync(path.join(dir, 'owner.json'), 'utf8');
    bytes = fs.readFileSync(path.join(dir, 'current.html'), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  let owner;
  try { owner = JSON.parse(ownerRaw); }
  catch { return null; }
  return { id, bytes, owner };
}

/**
 * Persist a touched lastAccess on an authorized read. Best-effort: a write
 * failure here must not fail the read, so callers ignore the return.
 */
function touchAccess(id, { dataDir }, owner) {
  try {
    const next = { ...owner, lastAccess: Date.now() };
    atomicWriteFile(path.join(idDir(dataDir, id), 'owner.json'), JSON.stringify(next));
  } catch { /* non-fatal */ }
}

// ─── baseBodyHash: sha256 of the canonical (LF + NFC) editable body ─────────

// Must match the seed's canonLF exactly — the in-page commit sink hashes with
// the seed's copy and /modify compares against this one.
const canonLF = (s) => (s == null ? '' : String(s).replace(/\r\n/g, '\n').replace(/\r/g, '\n').normalize('NFC'));

// Lazy-load the vendored ESM seed module once (CJS can't top-level import ESM).
let _seedModPromise = null;
function seedMod() {
  if (!_seedModPromise) _seedModPromise = import('./seed.mjs');
  return _seedModPromise;
}

/**
 * The sha-256 hex of the rewritable's LF-canonical editable body — the value a
 * Phase-B client uses as the rwa-edit/1 envelope's baseHash. Reuses the vendored
 * extractInlineDoc (the same backtick-walk the apply path uses), so the hash is
 * over exactly the bytes the edit contract operates on. Async because the
 * extractor is the vendored ESM module.
 *
 * @param {string|Buffer} bytes — raw container bytes
 * @returns {Promise<string>} 64-char sha-256 hex
 */
async function baseBodyHash(bytes) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
  const { extractInlineDoc } = await seedMod();
  const doc = canonLF(extractInlineDoc(text));
  return crypto.createHash('sha256').update(doc).digest('hex');
}

/** sha-256 hex of an arbitrary string (the doc body returned by /doc). */
function sha256hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// ─── Forward audit log (history.jsonl) ──────────────────────────────────────
// The rwa_hist mirror for hosted edits: an append-only JSONL file, one record
// per successful commit, under DATA_DIR/r/<id>/history.jsonl. This is the
// FORWARD log only — auditable + actor-attributed. Undo STORAGE (the reverse
// patch needed for /undo) is Task 5's concern; we never reconstruct prior bytes
// from this file, so a forward record is enough for v1.

function historyPath(dataDir, id) {
  return path.join(idDir(dataDir, id), 'history.jsonl');
}

/**
 * Append one forward audit record (a single line of JSON) to the id's
 * history.jsonl. The caller has already committed the new bytes; this is the
 * audit-trail write. `appendFileSync` is atomic per line for the small payloads
 * we write (well under PIPE_BUF), so concurrent appends — already serialized by
 * the per-id write lock in server.js — never interleave.
 *
 * @param {string} id
 * @param {{dataDir:string}} opts
 * @param {object} record — { ts, actor, kind, envelope|reason, baseHash, resultHash }
 */
function appendHistory(id, { dataDir }, record) {
  fs.appendFileSync(historyPath(dataDir, id), JSON.stringify(record) + '\n');
}

/**
 * Number of records in the id's history.jsonl (0 if the file doesn't exist yet).
 * Counts non-empty lines so a trailing newline isn't miscounted.
 *
 * @param {string} id
 * @param {{dataDir:string}} opts
 * @returns {number}
 */
function historyLen(id, { dataDir }) {
  let raw;
  try { raw = fs.readFileSync(historyPath(dataDir, id), 'utf8'); }
  catch (err) {
    if (err && err.code === 'ENOENT') return 0;
    throw err;
  }
  let n = 0;
  for (const line of raw.split('\n')) if (line.length > 0) n++;
  return n;
}

// ─── Undo pre-image stack (the REVERSIBLE state) ────────────────────────────
// Crash-safe, composable undo is built on a per-id PRE-IMAGE stack — NOT on
// replaying the forward history.jsonl. The forward log is unusable for restoring
// bytes: (1) it can be one record ahead of current.html (the documented
// append-then-rename crash window in server.js's /modify), and (2) a
// replace_document record stores only `reason`, never the doc, so forward replay
// can't rebuild bytes. Instead, /modify pushes the PRE-edit current.html bytes
// onto this stack BEFORE the atomic rename, so the undo state is durable
// independent of (and ahead of) the commit it reverses.
//
// Storage form: DATA_DIR/r/<id>/undo/<seq>.html — one whole-document snapshot
// per file, where <seq> is a zero-padded monotonically increasing counter. The
// simplest crash-safe form: each pre-image is a self-contained file, written via
// tmp+rename (atomic, no torn snapshot), pushed before the modify commit. Undo
// pops the highest-seq file (the most-recent pre-image), restores it, and deletes
// it. Composable: repeated pops walk the stack back to the original ingested
// state. We do NOT mutate history.jsonl on undo — it stays an append-only forward
// audit; the undo stack alone is the reversible state.

function undoDir(dataDir, id) {
  return path.join(idDir(dataDir, id), 'undo');
}

// The undo-stack sequence files, sorted ascending (oldest pre-image first).
// 8-digit zero-padded names so lexical order == numeric order for the lifetime
// of any realistic edit history (10^8 edits).
function undoSeqFiles(dataDir, id) {
  let names;
  try { names = fs.readdirSync(undoDir(dataDir, id)); }
  catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  return names.filter((n) => /^[0-9]{8}\.html$/.test(n)).sort();
}

/**
 * Push a pre-image (the PRE-edit current.html bytes) onto the id's undo stack.
 * Atomic (tmp+rename), so a crash can never leave a torn snapshot. The caller
 * (/modify) MUST call this BEFORE the atomic rename that commits the new bytes,
 * so the reversible state is durable independent of the commit.
 *
 * @param {string} id
 * @param {{dataDir:string}} opts
 * @param {string|Buffer} preImageBytes — the bytes to restore on a later undo
 */
function pushUndo(id, { dataDir }, preImageBytes) {
  const dir = undoDir(dataDir, id);
  fs.mkdirSync(dir, { recursive: true });
  const existing = undoSeqFiles(dataDir, id);
  const lastSeq = existing.length ? parseInt(existing[existing.length - 1], 10) : 0;
  const seq = String(lastSeq + 1).padStart(8, '0');
  atomicWriteFile(path.join(dir, `${seq}.html`), preImageBytes);
}

/**
 * Pop the most-recent pre-image off the id's undo stack and return its bytes.
 * Returns null when the stack is empty (the caller maps that to 409
 * nothing_to_undo). Deletes the popped file AFTER reading it so a crash between
 * read and unlink at worst leaves a recoverable extra pre-image, never loses one.
 *
 * @param {string} id
 * @param {{dataDir:string}} opts
 * @returns {string|null} the pre-image bytes (utf8), or null if the stack is empty
 */
function popUndo(id, { dataDir }) {
  const files = undoSeqFiles(dataDir, id);
  if (files.length === 0) return null;
  const top = files[files.length - 1];
  const topPath = path.join(undoDir(dataDir, id), top);
  const bytes = fs.readFileSync(topPath, 'utf8');
  fs.unlinkSync(topPath);
  return bytes;
}

/**
 * Depth of the id's undo stack (number of undoable edits remaining). Surfaced as
 * `undoLen` in BOTH the /modify and /undo responses — a client gates "can I undo
 * again?" on undoLen > 0 (the next undo 409s once it reaches 0). Distinct from
 * `historyLen` (the monotonic forward-audit count, surfaced as `histLen`).
 *
 * @param {string} id
 * @param {{dataDir:string}} opts
 * @returns {number}
 */
function undoLen(id, { dataDir }) {
  return undoSeqFiles(dataDir, id).length;
}

// ─── rotate: replace the capability token ───────────────────────────────────

/**
 * Mint a new capability token and atomically replace owner.json.capHash with its
 * hash. The old token's hash is gone, so the old token now fails verifyToken
 * (401). Returns the NEW raw token (the only time it's revealed). The caller
 * holds the per-id write lock so this can't race a /modify's owner.json touch.
 *
 * @param {string} id
 * @param {{dataDir:string}} opts
 * @param {object} owner — the current owner record (already loaded by the caller)
 * @returns {{token:string}} the new one-time token
 */
function rotateToken(id, { dataDir }, owner) {
  const token = mintToken();
  const next = { ...owner, capHash: hashToken(token) };
  atomicWriteFile(path.join(idDir(dataDir, id), 'owner.json'), JSON.stringify(next));
  return { token };
}

// ─── delete: remove the rwa subtree ─────────────────────────────────────────

/**
 * Remove DATA_DIR/r/<id>/ recursively. Idempotent (a missing dir is a no-op).
 * The caller holds the per-id write lock so this serializes with /modify + /undo.
 *
 * @param {string} id
 * @param {{dataDir:string}} opts
 */
function deleteHosted(id, { dataDir }) {
  fs.rmSync(idDir(dataDir, id), { recursive: true, force: true });
}

// ─── Orphan cleanup (the hosted r/ subtree ONLY) ────────────────────────────
// Retained + exported because the CONNECTED-SHARE expiry (server.js shareExpired)
// reuses it for its own 90-day inactivity class — hosted /r no longer uses it.
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
// Hosted rwas are kept INDEFINITELY (operator decision 2026-08-14). There is no
// age-based expiry: a creator removes their own copy with DELETE /r/:id (its
// capability token), and nothing else deletes it. This sweep therefore only
// clears FAILED-INGEST ORPHANS — a dir whose owner.json is missing or has no
// capHash, which no creator could ever authenticate against to delete (ingest
// writes owner.json last, so such a dir is a crashed mid-write, not a real
// rwa). NEVER touches the /s/ share files (they live directly under DATA_DIR,
// not in the r/ subtree this scans). Synchronous + testable. The `now` arg is
// retained for call-site/signature stability but is unused — nothing expires.
//
// Storage note (the tradeoff of "keep indefinitely"): valid hosted rwas grow
// without bound; the only GC is creator-initiated DELETE. Acceptable per the
// decision — revisit with a quota if the data volume ever demands it.
function sweepHosted(now, { dataDir }) {
  const root = hostedRoot(dataDir);
  let entries;
  try { entries = fs.readdirSync(root); }
  catch (err) {
    if (err && err.code === 'ENOENT') return []; // no r/ subtree yet — nothing to sweep
    throw err;
  }
  const removed = [];
  for (const id of entries) {
    if (!ID_RE.test(id)) continue; // skip anything not a hosted id (defensive)
    let orphaned = false;
    try {
      const owner = JSON.parse(fs.readFileSync(path.join(root, id, 'owner.json'), 'utf8'));
      if (!owner || typeof owner.capHash !== 'string') orphaned = true; // unusable — no creator can delete it
    } catch {
      orphaned = true; // missing/corrupt owner.json → a crashed mid-ingest, not a real rwa
    }
    if (orphaned) {
      try { fs.rmSync(path.join(root, id), { recursive: true, force: true }); removed.push(id); }
      catch { /* best-effort; a failed unlink is retried next sweep */ }
    }
  }
  return removed;
}

module.exports = {
  // validation
  UUID_RE,
  validateContainer,
  // ids
  ID_RE,
  generateId,
  hostedRoot,
  idDir,
  // tokens
  mintToken,
  hashToken,
  verifyToken,
  // store
  ingest,
  readHosted,
  touchAccess,
  // hashing
  baseBodyHash,
  sha256hex,
  canonLF,
  // forward audit log
  historyPath,
  appendHistory,
  historyLen,
  // undo pre-image stack
  undoDir,
  pushUndo,
  popUndo,
  undoLen,
  // lifecycle
  rotateToken,
  deleteHosted,
  sweepHosted,
  NINETY_DAYS_MS,
  // error
  HostedError,
};
