// Plan-path entry for `rwa edit`. Composes the three foundation modules
// (dsl-compiler, apply-edits, seed splice helpers) into a single function
// that takes a target .html and a tool-envelope, applies the edit
// deterministically, and atomically writes the file back.
//
// Error surface (load-bearing — Task 5's --json output keys on these):
//   exitCode 2 / subcode: 'not_found', 'read_error', 'not_a_rewritable'
//   exitCode 3 / subcode: 'not_an_object', 'unknown_shape',
//                         'ambiguous_envelope', 'missing_version',
//                         'version_mismatch', 'missing_reason',
//                         'malformed_envelope', 'frozen_zone_violation',
//                         plus DslCompileError.code or RwaEditError.code
//                         from the underlying modules.

import { readFile } from 'node:fs/promises';
import { atomicWrite } from './atomic-write.mjs';
import { applyEdits, RwaEditError, findFrozenZones, dataRwaFrozenSnapshot, FAILURE_HINTS } from './apply-edits.mjs';
import { compileDslPlan } from './dsl-compiler.mjs';
import { extractInlineDoc, replaceInlineDoc } from './seed.mjs';

export class CliError extends Error {
  constructor(exitCode, subcode, details = {}) {
    super(subcode);
    this.exitCode = exitCode;
    this.subcode = subcode;
    this.details = details;
    // Self-documenting failures: attach a one-line, code-keyed recovery hint so
    // `rwa edit --json` consumers (agents, scripts) get actionable guidance, not
    // just a code. Mirrors the seed's failureToToolResult. Additive and keyed on
    // a limited table, so subcodes without a hint (e.g. doc.mjs read errors) are
    // untouched.
    if (FAILURE_HINTS[subcode] && this.details.hint == null) this.details.hint = FAILURE_HINTS[subcode];
  }
}

// Inspect the envelope's discriminator set and assert version invariants.
// Returns the canonical tool name on success.
// Frozen-zone preservation for wholesale-replacement paths (replace_document and
// the DSL escape op) — the equivalent of the guards applyEdits runs on the
// find/replace path. MARKER-form zones must survive byte-identically by name
// (mirror of seed replaceDocument ~:2938); the set of ATTRIBUTE-form
// data-rwa-frozen elements must be unchanged (snapshot equality, mirror of seed
// dataRwaFrozenSnapshot :2971). Without this the escape hatch would let an agent
// drift a frozen self-description declaration that apply_edits protects.
function assertFrozenPreserved(currentDoc, newDoc) {
  const oldByName = new Map(findFrozenZones(currentDoc).map(z => [z.name, currentDoc.slice(z.start, z.end)]));
  const newByName = new Map(findFrozenZones(newDoc).map(z => [z.name, newDoc.slice(z.start, z.end)]));
  for (const [name, originalBytes] of oldByName) {
    if (!newByName.has(name) || newByName.get(name) !== originalBytes) {
      throw new CliError(3, 'frozen_zone_violation', {
        zone: name,
        reason: 'replace_document must preserve frozen zones byte-identically',
      });
    }
  }
  // …and must not ADD new marker-form frozen zones (parity with the seed's
  // frozenZonesIntact zone-count check and the apply_edits path): an agent can't
  // mint new author-invariants via the escape hatch. (Attribute-form add/remove
  // is caught by the dataRwaFrozenSnapshot check below.)
  for (const name of newByName.keys()) {
    if (!oldByName.has(name)) {
      throw new CliError(3, 'frozen_zone_violation', {
        zone: name,
        reason: 'replace_document must not add a new frozen zone',
      });
    }
  }
  const a = dataRwaFrozenSnapshot(currentDoc);
  const b = dataRwaFrozenSnapshot(newDoc);
  if (a.length !== b.length || a.some((x, i) => x !== b[i])) {
    throw new CliError(3, 'frozen_zone_violation', {
      form: 'attribute',
      reason: 'replace_document must preserve data-rwa-frozen elements byte-identically',
    });
  }
}

function validateEnvelope(env) {
  if (typeof env !== 'object' || env === null || Array.isArray(env)) {
    throw new CliError(3, 'not_an_object');
  }
  const hasEdits = 'edits' in env;
  const hasOps = 'ops' in env;
  const hasDoc = 'doc' in env;
  const count = (hasEdits ? 1 : 0) + (hasOps ? 1 : 0) + (hasDoc ? 1 : 0);
  if (count === 0) throw new CliError(3, 'unknown_shape');
  if (count > 1) throw new CliError(3, 'ambiguous_envelope');
  if (typeof env.version !== 'string' || env.version.length === 0) {
    throw new CliError(3, 'missing_version');
  }
  if (hasEdits && env.version !== 'rwa-edit/1') {
    throw new CliError(3, 'version_mismatch', { expected: 'rwa-edit/1', got: env.version });
  }
  if (hasOps && env.version !== 'rwa-edit-dsl/1') {
    throw new CliError(3, 'version_mismatch', { expected: 'rwa-edit-dsl/1', got: env.version });
  }
  if (hasDoc && env.version !== 'rwa-edit/1') {
    throw new CliError(3, 'version_mismatch', { expected: 'rwa-edit/1', got: env.version });
  }
  // `'doc' in env` is true even when env.doc is undefined — without this type
  // check `replaceInlineDoc(fileText, undefined)` would silently write an
  // empty body (canonLF(undefined) → ''). Use `malformed_envelope` to match
  // the bootstrap's replaceDocument shape-check (seeds/rewritable.html
  // §replaceDocument, line ~2913).
  if (hasDoc && typeof env.doc !== 'string') {
    throw new CliError(3, 'malformed_envelope', { reason: 'doc must be a string' });
  }
  if (hasDoc && (typeof env.reason !== 'string' || env.reason.length === 0)) {
    throw new CliError(3, 'missing_reason');
  }
  return hasEdits ? 'apply_edits' : hasOps ? 'apply_dsl_plan' : 'replace_document';
}

/**
 * Apply a tool-envelope to a rewritable .html on disk.
 *
 * @param {string} filePath — absolute or relative path to the target .html
 * @param {object} envelope — apply_edits / apply_dsl_plan / replace_document envelope
 * @returns {Promise<{exitCode: 0}>}
 * @throws {CliError} on any validation, compile, or apply failure
 */
export async function applyPlan(filePath, envelope) {
  // 1. Read the file. Surfacing not_found before envelope validation matches
  // the user's mental model: file errors first, then plan errors.
  let fileText;
  try {
    fileText = await readFile(filePath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') throw new CliError(2, 'not_found', { path: filePath });
    // EACCES, EISDIR, EMFILE, etc. — "not_found" would mislead the user.
    throw new CliError(2, 'read_error', {
      path: filePath,
      errno: e && e.code,
      message: e && e.message,
    });
  }

  // 2. Extract INLINE_DOC body. A plain-text or non-rewritable target throws.
  let currentDoc;
  try {
    currentDoc = extractInlineDoc(fileText);
  } catch (_e) {
    throw new CliError(2, 'not_a_rewritable', { path: filePath });
  }

  // 3. Validate envelope shape + version.
  const shape = validateEnvelope(envelope);

  // 4. Compute the new doc per shape.
  let newDoc;
  if (shape === 'replace_document') {
    newDoc = envelope.doc;
    assertFrozenPreserved(currentDoc, newDoc);
  } else if (shape === 'apply_dsl_plan') {
    let compiled;
    try {
      compiled = compileDslPlan(envelope, currentDoc);
    } catch (e) {
      throw new CliError(3, e.code || 'dsl_compile_error', { message: e.message });
    }
    if (compiled.tool === 'replace_document') {
      newDoc = compiled.envelope.doc;
      assertFrozenPreserved(currentDoc, newDoc); // the DSL escape op must not bypass frozen zones either
    } else {
      try {
        newDoc = applyEdits(currentDoc, compiled.envelope.edits);
      } catch (e) {
        if (e instanceof RwaEditError) {
          throw new CliError(3, e.code, { editIndex: e.editIndex, ...e.context });
        }
        throw e;
      }
    }
  } else {
    try {
      newDoc = applyEdits(currentDoc, envelope.edits);
    } catch (e) {
      if (e instanceof RwaEditError) {
        throw new CliError(3, e.code, { editIndex: e.editIndex, ...e.context });
      }
      throw e;
    }
  }

  // 5. Splice the new doc back into the bootstrap and write atomically (temp +
  // fsync + rename(2)); the temp is removed on any failure. See ./atomic-write.mjs.
  const newFileText = replaceInlineDoc(fileText, newDoc);
  await atomicWrite(filePath, newFileText);
  return { exitCode: 0 };
}
