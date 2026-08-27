// Read-path entry for `rwa doc` — the counterpart to `rwa edit`'s applyPlan.
// Where applyPlan WRITES the editable body of a rewritable, inspectDoc READS
// it: it returns the exact LF-canonical text the rwa-edit contract operates
// on, plus the metadata an agent needs to edit safely (uuid, product kind,
// frozen-zone names).
//
// Error surface mirrors edit.mjs so callers dedupe file-error handling across
// read and write:
//   exitCode 2 / subcode: 'not_found', 'read_error', 'not_a_rewritable'

import { readFile } from 'node:fs/promises';
import { extractInlineDoc } from './seed.mjs';
import { findFrozenZones, virtualizeImages, listBlocks } from './apply-edits.mjs';
import { resolveSelfDescription } from './identity.mjs';
import { CliError, bodyHash } from './edit.mjs';

// The bootstrap bakes both consts at emit time (cli/src/seed.mjs applySeedSubs).
// Reading them back is how we recover identity (uuid) and editing framing
// (kind) without a full HTML parse. Patterns mirror seed.mjs UUID_RE /
// PRODUCT_KIND_RE and rwa.mjs detectProductKind — keep them in step.
const UUID_RE = /const DOC_UUID = '([0-9a-f-]{36})';/;
const PRODUCT_KIND_RE = /const PRODUCT_KIND = '([^']*)';/;
// #35 — provenance, read from the FROZEN head (never the body: a marker the
// document can edit is a marker injected text can delete).
const ORIGIN_RE = /<meta name="rwa-origin" content="([^"]*)">/;

/**
 * Read a rewritable's editable document body, contract metadata, and the
 * `self-description/1` projection (the "what is this?" surface, computed from the
 * bytes — kind/affordances/title/blocks/baseline). The projection applies the
 * v1.1 precedence (declared > static): a trustworthy embedded #rwa-affordances
 * declaration (edit-unreachable) wins over the kind-template guess
 * (`source:"declared"`); otherwise the static kind-derived projection
 * (`source:"static"`). No `live` block (the CLI executes no JS). See
 * ./identity.mjs and docs/specs/rwa-self-description-spec.md §3.1.
 *
 * @param {string} filePath — path to the target .html
 * @returns {Promise<{doc: string, uuid: string|null, kind: string, frozenZones: string[], self: object}>}
 * @throws {CliError} exitCode 2 on file / non-rewritable errors
 */
export async function inspectDoc(filePath, opts = {}) {
  let fileText;
  try {
    fileText = await readFile(filePath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') throw new CliError(2, 'not_found', { path: filePath });
    throw new CliError(2, 'read_error', { path: filePath, errno: e && e.code, message: e && e.message });
  }

  // A plain-text or non-rewritable target throws here — the same gate `rwa
  // edit` uses. Surfacing it as not_a_rewritable gives agents a deterministic
  // "is this a rewritable?" probe (clean non-zero exit, empty stdout).
  let doc;
  try {
    doc = extractInlineDoc(fileText);
  } catch (_e) {
    throw new CliError(2, 'not_a_rewritable', { path: filePath });
  }

  const uuid = (fileText.match(UUID_RE) || [])[1] || null;
  // Pre-PRODUCT_KIND containers (and any unknown kind) default to 'document',
  // matching how the runtime and `rwa edit` resolve SYSTEM_PROMPTS.
  const kind = (fileText.match(PRODUCT_KIND_RE) || [])[1] || 'document';
  const frozenZones = findFrozenZones(doc).map(z => z.name);
  // The self-description/1 projection — "what is this, what can be done with it".
  // resolveSelfDescription applies the v1.1 precedence (declared > static): a
  // trustworthy embedded #rwa-affordances declaration (edit-unreachable) wins over
  // the kind-template guess; otherwise the static kind-derived projection.
  const self = resolveSelfDescription({ fileText, doc, uuid, kind, frozenZones });
  // The staleness token (#31): the version of the document this read saw. A
  // caller feeds it straight back as `rwa edit --base-hash` and the edit is
  // refused if anyone wrote in between. Without a hash ON THE READ, a
  // compare-and-swap on the write is unusable — there is nothing to compare to.
  // Same value the hosted GET /r/:id/doc reports, so a read here is a valid
  // token there and vice versa.
  // NOTE: over the REAL body, always — even when the caller asked for the
  // virtualized projection below. baseHash names the document, and `rwa edit
  // --base-hash` compares it against the stored bytes; a hash over the token
  // form would be self-consistent and agree with nothing else.
  const baseHash = bodyHash(doc);
  // Surfaced on the read (#35) so an EXTERNAL agent — which composes its own
  // prompt and never sees buildUserPrompt's provenance line — can tell that the
  // text it is about to hold is foreign. Null for a container the user authored.
  const origin = (fileText.match(ORIGIN_RE) || [])[1] || null;

  // images-v1 (#33): the virtualized projection replaces each embedded image's
  // data: URI with an opaque `rwa-asset:<hash8>` token. This is the form the
  // seed's modify(), the CLI agent loop and `rwa doctor` have always used — a
  // single 60 KB image otherwise costs a reader ~60,000 characters of base64 it
  // can do nothing with. `rwa doc` was the last read door still handing over the
  // bytes. Opt-in for now, and PAIRED with `rwa edit --virtual`: a token-form
  // read with a raw-form write means anchors silently stop matching around
  // images, so applyPlan refuses that combination rather than mis-anchoring.
  let assets = 0;
  let out = doc;
  if (opts.virtual) {
    const v = virtualizeImages(doc);
    out = v.doc;
    assets = v.assets ? v.assets.size : 0;
  }

  return { doc: out, uuid, kind, frozenZones, self, baseHash, origin, virtual: !!opts.virtual, assets };
}

/**
 * The document's OUTLINE (#34) — what a delegating agent reads instead of the
 * body.
 *
 * `rwa doc` was whole-document-or-nothing: the only way to learn what was in a
 * file was to pay for all of it, on every turn, for every edit. Under the
 * two-agent split the external agent is not supposed to hold the body at all, so
 * it needs a summary cheap enough to direct work from — a block list with stable
 * names (`data-rwa-id`), sizes to budget against, and enough text to recognise a
 * block without reproducing it.
 *
 * `preview` is capped hard on purpose. An outline that grew with the document
 * would just be the document again with extra steps.
 *
 * @param {string} filePath
 * @param {object} [opts] — `virtual` (token form), `preview` (chars, default 80)
 * @returns {Promise<{uuid: string|null, kind: string, baseHash: string,
 *   count: number, outline: Array<object>}>}
 */
export async function outlineDoc(filePath, opts = {}) {
  const info = await inspectDoc(filePath, opts);
  const cap = Number.isFinite(opts.preview) ? Math.max(0, opts.preview) : 80;
  const outline = listBlocks(info.doc).map((b) => ({
    id: b.id,
    tag: b.tag,
    chars: b.chars,
    ...(b.frozen ? { frozen: true } : {}),
    // cap 0 means "no preview at all" — the structural skeleton. Guard the
    // slice: `slice(0, cap - 1)` at cap 0 is `slice(0, -1)`, which drops one
    // character instead of all of them and makes the skeleton the LARGEST
    // outline rather than the smallest.
    preview: cap === 0 ? '' : (b.text.length > cap ? b.text.slice(0, cap - 1) + '…' : b.text),
  }));
  return { uuid: info.uuid, kind: info.kind, baseHash: info.baseHash, count: outline.length, outline };
}

/**
 * One block's source, by `data-rwa-id` (#34). With `outlineDoc` above and the
 * `baseHash` from #31 this closes a read-modify-write cycle whose cost is
 * proportional to the EDIT rather than to the document.
 *
 * @throws {CliError} exitCode 1 / `unknown_block` — including the case where the
 *   document has no ids at all, which is its own distinct answer: the file has
 *   never been committed through a surface that assigns them.
 */
export async function readBlock(filePath, id, opts = {}) {
  const info = await inspectDoc(filePath, opts);
  const blocks = listBlocks(info.doc);
  const hit = blocks.find((b) => b.id === id);
  if (!hit) {
    const identified = blocks.filter((b) => b.id).length;
    throw new CliError(1, 'unknown_block', {
      id,
      blocks: blocks.length,
      identified,
      hint: identified === 0
        ? 'This document has no block ids yet — nothing has committed through a surface that assigns them. Run any edit (or open it once in a browser) and they will be backfilled.'
        : 'Run `rwa doc <file> --outline` to list the ids this document actually has.',
    });
  }
  return {
    uuid: info.uuid,
    baseHash: info.baseHash,
    block: {
      id: hit.id, tag: hit.tag, chars: hit.chars, frozen: hit.frozen,
      source: info.doc.slice(hit.start, hit.end),
    },
  };
}
