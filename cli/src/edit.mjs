// Plan-path entry for `rwa edit`. Composes the three foundation modules
// (dsl-compiler, apply-edits, seed splice helpers) into a single function
// that takes a target .html and a tool-envelope, applies the edit
// deterministically, and atomically writes the file back.
//
// Error surface (load-bearing — Task 5's --json output keys on these):
//   exitCode 2 / subcode: 'not_found', 'not_a_rewritable'
//   exitCode 3 / subcode: 'not_an_object', 'unknown_shape',
//                         'ambiguous_envelope', 'missing_version',
//                         'version_mismatch', 'missing_reason',
//                         plus DslCompileError.code or RwaEditError.code
//                         from the underlying modules.

import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { applyEdits, RwaEditError } from './apply-edits.mjs';
import { compileDslPlan } from './dsl-compiler.mjs';
import { extractInlineDoc, replaceInlineDoc } from './seed.mjs';

export class CliError extends Error {
  constructor(exitCode, subcode, details = {}) {
    super(subcode);
    this.exitCode = exitCode;
    this.subcode = subcode;
    this.details = details;
  }
}

// Inspect the envelope's discriminator set and assert version invariants.
// Returns the canonical tool name on success.
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
    throw new CliError(2, 'not_found', { path: filePath, errno: e && e.code });
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
  } else if (shape === 'apply_dsl_plan') {
    let compiled;
    try {
      compiled = compileDslPlan(envelope, currentDoc);
    } catch (e) {
      throw new CliError(3, e.code || 'dsl_compile_error', { message: e.message });
    }
    if (compiled.tool === 'replace_document') {
      newDoc = compiled.envelope.doc;
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

  // 5. Splice the new doc back into the bootstrap and write atomically.
  // POSIX rename(2) gives crash-safety on the same filesystem — readers
  // either see the old file or the new one, never a half-written byte stream.
  const newFileText = replaceInlineDoc(fileText, newDoc);
  const tmp = `${filePath}.rwa-tmp-${process.pid}`;
  await writeFile(tmp, newFileText, 'utf8');
  try {
    await rename(tmp, filePath);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
  return { exitCode: 0 };
}
