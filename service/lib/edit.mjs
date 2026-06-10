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
import {
  applyEdits, RwaEditError, dataRwaFrozenSnapshot, FAILURE_HINTS,
  virtualizeImages, expandImages, assertNoNewAssetTokens, mapEnvelopeImages, MAX_DOC_EXPANDED,
  extractFrozenZones3, lockedRangesIn, markerZoneRangesIn,
} from './apply-edits.mjs';
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
// find/replace path. MARKER-form zones (all three fence forms) must survive
// byte-identically by name (mirror of seed replaceDocument's extractFrozenZones/
// frozenZonesIntact check); the set of ATTRIBUTE-form data-rwa-frozen elements
// must be unchanged (snapshot equality, mirror of seed dataRwaFrozenSnapshot).
// Without this the escape hatch would let an agent drift a frozen self-
// description declaration that apply_edits protects.
function assertFrozenPreserved(currentDoc, newDoc) {
  // Class-lock coverage (rwa-lens/1 spec §7; seed replaceDocument class_lock_uncovered).
  // A bare .rwa-locked block in the CURRENT doc cannot survive a wholesale rewrite —
  // the wrapper can be reshaped, attribute-mutated, or dropped. Locks are only safe
  // under replace_document if their source range is entirely contained within a
  // marker-form frozen zone (markers wrap or equal the lock — NOT the inverse).
  // Precondition on the current doc: if any lock is uncovered, NO replace_document
  // is allowed, regardless of the new doc. markerZoneRangesIn is 3-fence-form, and
  // the byte-preservation scan below is too (extractFrozenZones3) — so a lock the
  // coverage check accepts as covered by a /* */ or // zone is a zone the
  // preservation check actually protects. The two agree on the fence-form axis.
  const lockRanges = lockedRangesIn(currentDoc);
  if (lockRanges.length) {
    const markerRanges = markerZoneRangesIn(currentDoc);
    for (const [ls, le] of lockRanges) {
      const covered = markerRanges.some(([ms, me]) => ms <= ls && le <= me);
      if (!covered) throw new CliError(3, 'class_lock_uncovered', { lockRange: [ls, le] });
    }
  }
  // Marker-form frozen zones — all three fence forms, with unterminated AND
  // duplicate detection (faithful mirror of the seed's extractFrozenZones +
  // frozenZonesIntact). One scan feeds byte-preservation, add-rejection, the
  // half-open-fence check, and the shadow-duplicate check, so a /* */ or // zone
  // can't be silently dropped, minted, half-opened, or duplicated via the escape
  // hatch — and a duplicate-name pair can't smuggle a tampered copy past a
  // last-wins Map. The CLI surfaces frozen_zone_violation (its replace-path
  // convention) where the seed throws frozen_zone_corrupted.
  const oldZones = extractFrozenZones3(currentDoc);
  const newZones = extractFrozenZones3(newDoc);
  const orphan = newZones.find(z => z.error === 'unterminated');
  if (orphan) {
    throw new CliError(3, 'frozen_zone_violation', {
      zone: orphan.name,
      reason: 'replace_document must not leave an unterminated frozen-zone marker',
    });
  }
  const dup = newZones.find(z => z.error === 'duplicate') || oldZones.find(z => z.error === 'duplicate');
  if (dup) {
    throw new CliError(3, 'frozen_zone_violation', {
      zone: dup.name,
      reason: 'duplicate frozen-zone name (a tampered shadow copy could hide behind a last-wins match)',
    });
  }
  const oldByName = new Map(oldZones.map(z => [z.name, z.inner]));
  const newByName = new Map(newZones.map(z => [z.name, z.inner]));
  // Preserve byte-identically by name (the seed compares inner content; marker
  // text is fixed grammar, the name is the key).
  for (const [name, inner] of oldByName) {
    if (!newByName.has(name) || newByName.get(name) !== inner) {
      throw new CliError(3, 'frozen_zone_violation', {
        zone: name,
        reason: 'replace_document must preserve frozen zones byte-identically',
      });
    }
  }
  // …and must not ADD a new marker-form zone (mint an author-invariant). The
  // attribute-form add/remove is caught by the dataRwaFrozenSnapshot check below.
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
  // Reserved HTML id: the escape hatch must not inject id="rwa-doc-mount" (it
  // would shadow/hijack the runtime mount). Parser-free mirror of the seed's
  // findReservedIdViolation (querySelector('#rwa-doc-mount')).
  if (/\bid\s*=\s*["']?rwa-doc-mount(?=["'\s/>]|$)/i.test(newDoc)) {
    throw new CliError(3, 'reserved_id_used', { id: 'rwa-doc-mount' });
  }
  // #5 opt-in (rwa-id-strict): the escape hatch must not lose an existing
  // data-rwa-id when the container declares <meta name="rwa-id-strict">.
  if (/<meta\s+name\s*=\s*["']?rwa-id-strict\b/i.test(currentDoc)) {
    const ids = (s) => new Set([...s.matchAll(/\sdata-rwa-id\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => (m[1] != null ? m[1] : m[2])));
    const after = ids(newDoc);
    for (const id of ids(currentDoc)) if (!after.has(id)) throw new CliError(3, 'rwa_id_stripped', { id });
  }
}

// String.prototype.isWellFormed (Node 22+) — false for an unpaired UTF-16
// surrogate. Mirror of the seed's isWellFormed lone-surrogate guard.
const isWellFormedStr = (s) => typeof s !== 'string' || typeof s.isWellFormed !== 'function' || s.isWellFormed();

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
  // Lone-surrogate guard (mirror seed isWellFormed): an unpaired UTF-16 surrogate
  // in doc/reason corrupts the durable file on encode.
  if (hasDoc && (!isWellFormedStr(env.doc) || !isWellFormedStr(env.reason))) {
    throw new CliError(3, 'malformed_envelope', { reason: 'lone_surrogate' });
  }
  return hasEdits ? 'apply_edits' : hasOps ? 'apply_dsl_plan' : 'replace_document';
}

/**
 * Apply a tool-envelope to a rewritable .html on disk.
 *
 * @param {string} filePath — absolute or relative path to the target .html
 * @param {object} envelope — apply_edits / apply_dsl_plan / replace_document envelope
 * @param {object} [opts]
 * @param {boolean} [opts.virtualImages] — the envelope speaks rwa-asset token
 *   form (rwa-edit-spec.md §19): the agent saw the VIRTUAL doc, so apply on the
 *   virtual form and expand tokens back before the file write. Hash-keyed
 *   tokens make the map re-derivable from the doc bytes — no map threading.
 *   Raw paths (piped envelope / --plan) leave this unset: real bytes, plus the
 *   fail-loud guard against introducing a NEW token with no bytes behind it.
 * @returns {Promise<{exitCode: 0}>}
 * @throws {CliError} on any validation, compile, or apply failure
 */
export async function applyPlan(filePath, envelope, opts = {}) {
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

  // images-v1 (rwa-edit-spec.md §19) — two virtualization modes:
  //  • opts.virtualImages: the envelope is ALREADY token-form (agent/CLI path).
  //    Virtualize the stored doc so token anchors match, apply, expand.
  //  • opts.virtualizeEnvelope: the envelope is EXPANDED (real data: URIs) —
  //    the hosted /modify relay. Seed a map from the stored doc, then tokenize
  //    the incoming envelope into the SAME map (registering new image bytes),
  //    so the apply runs on the token form (caps = text budget) and expansion
  //    resolves both existing and new images.
  // Either way all guards below (frozen zones, snapshots) run virtual-vs-virtual.
  const vimg = (opts.virtualImages || opts.virtualizeEnvelope) ? virtualizeImages(currentDoc) : null;
  if (opts.virtualizeEnvelope) envelope = mapEnvelopeImages(envelope, vimg.assets);
  const workDoc = vimg ? vimg.doc : currentDoc;

  // 4. Compute the new doc per shape.
  let newDoc;
  if (shape === 'replace_document') {
    newDoc = envelope.doc;
    assertFrozenPreserved(workDoc, newDoc);
  } else if (shape === 'apply_dsl_plan') {
    let compiled;
    try {
      compiled = compileDslPlan(envelope, workDoc);
    } catch (e) {
      // Pass e.op through: DslCompileError carries the offending DSL op, which
      // --json consumers need to point at the failing step (was dropped).
      throw new CliError(3, e.code || 'dsl_compile_error', { message: e.message, op: e.op });
    }
    if (compiled.tool === 'replace_document') {
      newDoc = compiled.envelope.doc;
      assertFrozenPreserved(workDoc, newDoc); // the DSL escape op must not bypass frozen zones either
    } else {
      try {
        newDoc = applyEdits(workDoc, compiled.envelope.edits);
      } catch (e) {
        if (e instanceof RwaEditError) {
          throw new CliError(3, e.code, { editIndex: e.editIndex, ...e.context });
        }
        throw e;
      }
    }
  } else {
    try {
      newDoc = applyEdits(workDoc, envelope.edits);
    } catch (e) {
      if (e instanceof RwaEditError) {
        throw new CliError(3, e.code, { editIndex: e.editIndex, ...e.context });
      }
      throw e;
    }
  }

  // images-v1: expand token-form output to real bytes (an invented token
  // rejects here, before anything is written); raw paths get the fail-loud
  // guard against minting a NEW token with no bytes behind it.
  try {
    if (vimg) newDoc = expandImages(newDoc, vimg.assets, vimg.orphans);
    else assertNoNewAssetTokens(currentDoc, newDoc);
  } catch (e) {
    if (e instanceof RwaEditError) throw new CliError(3, e.code, { ...e.context });
    throw e;
  }

  // Expanded-size guard (image paths only): MAX_DOC measured the VIRTUAL form,
  // so cap the REAL doc here — the DoS bound that the per-edit byte cap no
  // longer provides once image bytes are tokenized. Mirrors the GUI's 10 MB
  // container budget; authoritative server-side on the hosted /modify path.
  if (vimg && newDoc.length > MAX_DOC_EXPANDED) {
    throw new CliError(3, 'target_size_exceeded', { expanded: true, length: newDoc.length, cap: MAX_DOC_EXPANDED });
  }

  // 5. Splice the new doc back into the bootstrap and write atomically (temp +
  // fsync + rename(2)); the temp is removed on any failure. See ./atomic-write.mjs.
  const newFileText = replaceInlineDoc(fileText, newDoc);
  await atomicWrite(filePath, newFileText);
  return { exitCode: 0 };
}
