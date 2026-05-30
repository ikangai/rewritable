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
import { findFrozenZones } from './apply-edits.mjs';
import { buildSelfDescription } from './identity.mjs';
import { CliError } from './edit.mjs';

// The bootstrap bakes both consts at emit time (cli/src/seed.mjs applySeedSubs).
// Reading them back is how we recover identity (uuid) and editing framing
// (kind) without a full HTML parse. Patterns mirror seed.mjs UUID_RE /
// PRODUCT_KIND_RE and rwa.mjs detectProductKind — keep them in step.
const UUID_RE = /const DOC_UUID = '([0-9a-f-]{36})';/;
const PRODUCT_KIND_RE = /const PRODUCT_KIND = '([^']*)';/;

/**
 * Read a rewritable's editable document body, contract metadata, and the static
 * `self-description/1` projection (the "what is this?" surface, computed from the
 * bytes — kind/affordances/title/blocks/baseline; `source:"static"`, no live
 * block). See ./identity.mjs and docs/specs/rwa-self-description-spec.md.
 *
 * @param {string} filePath — path to the target .html
 * @returns {Promise<{doc: string, uuid: string|null, kind: string, frozenZones: string[], self: object}>}
 * @throws {CliError} exitCode 2 on file / non-rewritable errors
 */
export async function inspectDoc(filePath) {
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
  // The static self-description/1 projection — "what is this, what can be done
  // with it" — assembled from the facts already parsed above (one file parse).
  const self = buildSelfDescription({ doc, uuid, kind, frozenZones });

  return { doc, uuid, kind, frozenZones, self };
}
