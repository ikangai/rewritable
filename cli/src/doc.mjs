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
import { findFrozenZones, virtualizeImages } from './apply-edits.mjs';
import { resolveSelfDescription } from './identity.mjs';
import { CliError, bodyHash } from './edit.mjs';

// The bootstrap bakes both consts at emit time (cli/src/seed.mjs applySeedSubs).
// Reading them back is how we recover identity (uuid) and editing framing
// (kind) without a full HTML parse. Patterns mirror seed.mjs UUID_RE /
// PRODUCT_KIND_RE and rwa.mjs detectProductKind — keep them in step.
const UUID_RE = /const DOC_UUID = '([0-9a-f-]{36})';/;
const PRODUCT_KIND_RE = /const PRODUCT_KIND = '([^']*)';/;

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

  return { doc: out, uuid, kind, frozenZones, self, baseHash, virtual: !!opts.virtual, assets };
}
