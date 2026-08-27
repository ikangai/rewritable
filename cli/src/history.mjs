// `rwa log` — a durable, auditable record of what was done to a container (#39).
//
// ## The gap
//
// `rwa_hist` is IndexedDB-only, and the `actor` field it carries never reaches
// disk. So across sessions — or on a file someone sent you — an agent asked
// "what happened to this document?" has nothing but git, if the file happens to
// be in git. Under two agents that matters more than it did under one: the
// external agent delegates, never reads the body, and therefore has only the
// report and the record to audit.
//
// ## Where it lives, and why not in the file
//
// The issue asked for this design decision explicitly. Three options were real:
//
// 1. **A frozen zone inside INLINE_DOC.** Mechanically fine — it is exactly how
//    skills and agents persist, runtime-sole-writer via a `data-rwa-frozen`
//    region. Rejected because the cost COMPOUNDS: `replace_document` must
//    reproduce every frozen zone byte-identically, so the escape hatch would
//    have to echo the entire audit log, growing with the document's age, on
//    every wholesale rewrite. It would also land in every `rwa doc` read.
//
// 2. **An element in the frozen head.** Rejected outright: "the bootstrap is
//    byte-identical except for INLINE_DOC contents" is a stated load-bearing
//    invariant, and this would mutate the head on every commit.
//
// 3. **A sidecar.** Chosen. No invariant tension, no escape-hatch burden, no
//    read pollution — and, decisively, the hosted runtime ALREADY keeps exactly
//    this: an append-only `history.jsonl` per id (`service/lib/hosted.js`). Using
//    the same shape makes the local and hosted surfaces agree about what an
//    audit record IS, the same way #30 made them agree about what a document is.
//
// **The honest cost:** the log does not travel with the file. A published or
// emailed rewritable carries no history. If history-must-travel ever becomes a
// requirement, option 1 is the way back — and the `replace_document` burden is
// the problem to solve first, not to discover later.
//
// ## The actor is a PAIR
//
// A single free-form string cannot answer both "who decided this" and "who
// typed it", and under back-delegation (#36) both parties have a claim to it:
// the external agent chose the edit, the local runner produced the envelope.
// `principal` is who decided; `operator` is the surface that wrote.

import { appendFileSync, readFileSync } from 'node:fs';

/** Sidecar path for a container. Sits beside the file, named after it. */
export function historyPath(filePath) {
  return String(filePath).replace(/\.html?$/i, '') + '.rwa-log.jsonl';
}

/**
 * Append one forward audit record. Mirrors the hosted `appendHistory` — one line
 * of JSON per successful commit, append-only, never rewritten.
 *
 * Forward-only by design: this is an audit trail, not an undo stack. It records
 * hashes, never envelope bodies, so the log stays small and can never become a
 * second copy of the document (or a second copy of a document's secrets).
 *
 * Best-effort: a failure to write the log must never fail an edit that already
 * succeeded on disk. The caller gets `false` and can report it.
 *
 * @param {string} filePath — the container
 * @param {object} record — `{tool, applied, baseHash, newHash, bytes, actor}`
 * @param {string} [ts] — injectable timestamp, so tests are deterministic
 * @returns {boolean} whether the line was written
 */
export function appendHistory(filePath, record, ts) {
  const line = JSON.stringify({
    ts: ts || new Date().toISOString(),
    ...record,
  });
  try {
    appendFileSync(historyPath(filePath), line + '\n');
    return true;
  } catch {
    return false;   // an unwritable sidecar must not fail a completed edit
  }
}

/**
 * Read the log back, newest last.
 *
 * A malformed line is SKIPPED and counted rather than throwing: a truncated
 * final line (a process killed mid-append) must not make the whole history
 * unreadable, and silently returning fewer records than exist would be worse
 * than saying so.
 *
 * @returns {{records: object[], skipped: number, path: string, exists: boolean}}
 */
export function readHistory(filePath) {
  const p = historyPath(filePath);
  let raw;
  try { raw = readFileSync(p, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { records: [], skipped: 0, path: p, exists: false };
    throw e;
  }
  const records = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); }
    catch { skipped++; }
  }
  return { records, skipped, path: p, exists: true };
}

/**
 * Build the actor pair for a CLI write.
 *
 * `principal` — who DECIDED. Supplied by the caller (`--actor`, or
 * `RWA_PRINCIPAL`), because the CLI genuinely cannot know: an agent driving it
 * is the only party that can say who it is acting for. Absent rather than
 * guessed when unset — a fabricated principal is worse than none.
 *
 * `operator` — who TYPED. Always known: the surface that produced the write.
 */
export function actorPair({ principal, operator, model } = {}) {
  const out = { principal: principal || null, operator };
  if (model) out.model = model;
  return out;
}

/** One log line, rendered for a human. */
export function formatHistory({ records, skipped, exists, path }) {
  if (!exists) return `no log yet (${path})`;
  if (!records.length) return `log is empty (${path})`;
  const lines = records.map((r) => {
    const who = r.actor
      ? (r.actor.principal ? r.actor.principal + ' via ' + r.actor.operator : r.actor.operator)
      : '—';
    const what = r.compiledTo ? `${r.tool}→${r.compiledTo}` : r.tool;
    const n = r.applied == null ? '' : ` ${r.applied} edit${r.applied === 1 ? '' : 's'}`;
    return `${r.ts}  ${String(r.newHash || '').slice(0, 12)}  ${what}${n}  ${who}`;
  });
  lines.push('');
  lines.push(`${records.length} record${records.length === 1 ? '' : 's'}` +
    (skipped ? `  ·  ${skipped} unreadable line${skipped === 1 ? '' : 's'} skipped` : ''));
  return lines.join('\n');
}
