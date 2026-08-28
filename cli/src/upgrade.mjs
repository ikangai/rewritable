// `rwa upgrade <path>` — re-bootstrap an existing container onto the current
// seed (issue #12). By Invariant 1 a shipped container's bootstrap is frozen
// forever, so a bug fixed in seeds/rewritable.html after a file ships is
// fixed only for NEW files. This closes that gap for an existing file: it
// swaps everything EXCEPT what makes the file THAT container.
//
// PRESERVE (from the existing container):
//   - DOC_UUID   — CRITICAL. Names the container's IndexedDB (rwa_<DOC_UUID>);
//                  changing it orphans all local state.
//   - INLINE_DOC — verbatim (frozen zones, skill/agent zones, and signed
//                  records all live inside it, so preserving the body
//                  preserves them).
//   - PRODUCT_KIND, <title>, and RWA.FILE
// REPLACE: everything else — the whole bootstrap comes from the current seed.
//
// Mirrors tools/regenerate-refs.mjs's approach (read it alongside this): the
// 'document' kind (the seed's own default) is a direct DOC_UUID/rwa-seed-id
// substitution; every other kind must re-apply its kind regions via
// applySeedSubs/kindOverrides, or it would regenerate as a plain document and
// lose its PRODUCT_KIND framing (a skill-host/workflow/presentation
// container must keep its kind regions).
//
// The load-bearing guard (Rule 12 — fail loud): after rebuilding, DOC_UUID
// and INLINE_DOC are re-extracted from the REBUILT text and compared
// byte-for-byte against the originals. A mismatch refuses to write — a
// silent content-mangling upgrade is far worse than no upgrade at all.

import { readFile } from 'node:fs/promises';
import { atomicWrite } from './atomic-write.mjs';
import { CliError } from './edit.mjs';
import { SEED_CANDIDATES } from './commands.mjs';
import { loadSeed, applySeedSubs, kindOverrides, replaceInlineDoc, extractInlineDoc, seedIdentity } from './seed.mjs';

const INLINE_DOC_MARKER = 'const INLINE_DOC = `';
const UUID_RE = /const DOC_UUID = '([0-9a-f-]{36})';/;
const PRODUCT_KIND_RE = /const PRODUCT_KIND = '([^']*)';/;
const TITLE_TAG_RE = /<title>([\s\S]*?)<\/title>/i;
const FILE_KV_RE = /(FILE\s*:\s*)'([^']*)'/;
const SEED_ID_TAG_RE = /(<meta name="rwa-seed" content=")[^"]*(">)/;
// #25 — provenance, preserved across an upgrade like <title> and RWA.FILE.
// Two forms: the value capture (what the old container says) and the tag
// capture (where to write it back).
const ORIGIN_TAG_RE = /(<meta name="rwa-origin" content=")[^"]*(">)/;
const ORIGIN_VALUE_RE = /<meta name="rwa-origin" content="([^"]*)">/;
const SEED_ID_VALUE_RE = /<meta name="rwa-seed" content="([0-9a-f]{12})">/;

// Rebuild the bootstrap for `kind` from the current `seed`, preserving
// uuid/titleRaw/fileRaw/currentDoc. `titleRaw`/`fileRaw` are the EXACT bytes
// captured from the existing container (already HTML/JS-string-escaped) —
// spliced back in directly rather than round-tripped through applySeedSubs's
// escapeHtml/escapeJsString, which expect a raw display string and would
// double-escape an already-escaped value.
function buildUpgraded({ seed, uuid, kind, titleRaw, fileRaw, originRaw, currentDoc }) {
  let out;
  if (kind === 'document') {
    const seedId = seedIdentity(seed);
    out = seed
      .replace(SEED_ID_TAG_RE, (_m, pre, post) => `${pre}${seedId}${post}`)
      .replace(UUID_RE, () => `const DOC_UUID = '${uuid}';`);
  } else {
    let ov;
    try {
      ov = kindOverrides(kind);
    } catch (e) {
      const err = new Error(e.message);
      err.unknownKind = true;
      throw err;
    }
    out = applySeedSubs(seed, {
      uuid,
      productKind: kind,
      lensPlaceholder: ov.lensPlaceholder,
      palPlaceholder: ov.palPlaceholder,
      productHeader: ov.productHeader,
      lensClickToAnchor: ov.lensClickToAnchor,
    });
  }
  if (titleRaw != null) out = out.replace(TITLE_TAG_RE, () => `<title>${titleRaw}</title>`);
  if (fileRaw != null) out = out.replace(FILE_KV_RE, (_m, prefix) => `${prefix}'${fileRaw}'`);
  // #25 — provenance survives an upgrade. Dropping it would silently un-mark a
  // cloned container as foreign, which is the one direction this marker must
  // never move: an upgrade is supposed to gain fixes, not lose facts. Spliced
  // raw, like title/file, because the captured bytes are already escaped.
  if (originRaw) out = out.replace(ORIGIN_TAG_RE, (_m, pre, post) => `${pre}${originRaw}${post}`);
  return replaceInlineDoc(out, currentDoc);
}

/**
 * Re-bootstrap `filePath` onto the CLI's current seed, preserving DOC_UUID,
 * INLINE_DOC (verbatim), PRODUCT_KIND, <title>, and RWA.FILE.
 *
 * @param {string} filePath
 * @param {{mode?: 'write'|'check'|'dry-run'}} [opts] — 'check': report only,
 *   never writes. 'dry-run': also rebuilds + verifies in memory, never
 *   writes. 'write' (default): writes in place when an upgrade is needed.
 * @returns {Promise<{path:string, uuid:string, kind:string, title:string|null,
 *   file:string|null, currentSeedId:string|null, targetSeedId:string,
 *   needsUpgrade:boolean, mode:'noop'|'checked'|'dry-run'|'upgraded', written:boolean}>}
 * @throws {CliError} exitCode 2 on file / non-rewritable / verify failures
 */
export async function upgradeCmd(filePath, { mode = 'write' } = {}) {
  let fileText;
  try {
    fileText = await readFile(filePath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') throw new CliError(2, 'not_found', { path: filePath });
    throw new CliError(2, 'read_error', { path: filePath, errno: e && e.code, message: e && e.message });
  }

  // A plain-text or non-rewritable target is refused up front — cheap marker
  // checks before attempting the backtick walk (mirrors template.mjs's own
  // "is this an rwa file?" gate).
  if (!fileText.includes('id="rwa-bootstrap"') || !fileText.includes(INLINE_DOC_MARKER)) {
    throw new CliError(2, 'not_a_rewritable', { path: filePath });
  }

  // Both markers are present, so the only remaining failure mode here is an
  // unterminated template-literal — a distinct subcode from "not a
  // rewritable at all".
  let currentDoc;
  try {
    currentDoc = extractInlineDoc(fileText);
  } catch (e) {
    throw new CliError(2, 'inline_doc_unterminated', { path: filePath, message: e.message });
  }

  const uuidMatch = fileText.match(UUID_RE);
  if (!uuidMatch) throw new CliError(2, 'not_a_rewritable', { path: filePath, reason: 'missing DOC_UUID' });
  const uuid = uuidMatch[1];

  // Pre-PRODUCT_KIND containers default to 'document', matching how the
  // runtime and `rwa edit`/`rwa doc` resolve it elsewhere.
  const kind = (fileText.match(PRODUCT_KIND_RE) || [])[1] || 'document';
  const titleRaw = (fileText.match(TITLE_TAG_RE) || [])[1] ?? null;
  const fileMatch = fileText.match(FILE_KV_RE);
  const fileRaw = fileMatch ? fileMatch[2] : null;
  const currentSeedId = (fileText.match(SEED_ID_VALUE_RE) || [])[1] || null;
  // Absent in every container emitted before #25 — treated as "no origin", which
  // is the honest answer for a container whose source was never recorded.
  const originRaw = (fileText.match(ORIGIN_VALUE_RE) || [])[1] || null;

  const seed = await loadSeed(SEED_CANDIDATES);
  const targetSeedId = seedIdentity(seed);

  // This verb used to refuse with `seed_ambiguous` when two different seeds were
  // resolvable, because SEED_CANDIDATES preferred the gitignored in-package copy
  // and a leftover one would make `rwa upgrade` rewrite a container onto an OLDER
  // bootstrap — the inverse of its purpose. That was observed, not hypothetical:
  // this checkout's leftover was stale by an entire week of shipped work.
  //
  // The refusal is gone because its premise is (#49). SEED_CANDIDATES now
  // resolves exactly one seed — the repo-canonical one in a dev checkout, the
  // in-package copy in a published package — so a stale `cli/seeds/` cannot be
  // the seed this upgrades onto. Removed rather than kept as a defensive assert:
  // a guard that can no longer fire reads as protection while providing none,
  // and the reorder is the stronger form of the same protection.
  //
  // What replaces it is `cli/tests/seed-resolution.test.mjs`, which pins that a
  // dev checkout resolves the canonical seed even when a DIFFERENT `cli/seeds/`
  // copy sits beside it — the exact condition this refusal existed to catch.
  const needsUpgrade = currentSeedId !== targetSeedId;

  const base = { path: filePath, uuid, kind, title: titleRaw, file: fileRaw, currentSeedId, targetSeedId, needsUpgrade };

  if (!needsUpgrade) return { ...base, mode: 'noop', written: false };
  if (mode === 'check') return { ...base, mode: 'checked', written: false };

  let rebuilt;
  try {
    rebuilt = buildUpgraded({ seed, uuid, kind, titleRaw, fileRaw, originRaw, currentDoc });
  } catch (e) {
    if (e && e.unknownKind) throw new CliError(2, 'unknown_kind', { kind, message: e.message });
    throw e;
  }

  // The guard that matters (Rule 12): re-extract DOC_UUID + INLINE_DOC from
  // the REBUILT text and assert byte-for-byte equality with the originals.
  // A mismatch refuses to write, full stop — never ship mangled content.
  let rebuiltUuid, rebuiltDoc;
  try {
    rebuiltUuid = (rebuilt.match(UUID_RE) || [])[1];
    rebuiltDoc = extractInlineDoc(rebuilt);
  } catch (_e) {
    throw new CliError(2, 'upgrade_verify_failed', {
      path: filePath,
      reason: 'rebuilt container INLINE_DOC could not be re-extracted',
    });
  }
  if (rebuiltUuid !== uuid || rebuiltDoc !== currentDoc) {
    throw new CliError(2, 'upgrade_verify_failed', {
      path: filePath,
      reason: 'rebuilt container does not round-trip DOC_UUID/INLINE_DOC byte-for-byte',
    });
  }

  if (mode === 'dry-run') return { ...base, mode: 'dry-run', written: false };

  await atomicWrite(filePath, rebuilt);
  return { ...base, mode: 'upgraded', written: true };
}
