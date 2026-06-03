// `rwa skin <file> NAME` — the deterministic, model-free theme-swap command.
// It applies a preset's <style data-rwa-skin> block to an existing rewritable
// through the canonical applyPlan write path, so it inherits atomic write,
// frozen-zone safety, and the file-error surface (not_found/read_error/
// not_a_rewritable, exit 2) identically to `rwa edit` / `rwa doc`.
//
// Envelope choice is forced by the structural-shape guard (apply_edits rejects a
// change to the <style>/<script> count):
//   - block ABSENT  → INSERT: adding a <style> changes the count, so route the
//                     first skin through replace_document (the shape-exempt path),
//                     block prepended as the leading child of INLINE_DOC.
//   - block PRESENT → SWAP: rewrite the one block's bytes; <style> count is
//                     unchanged, so a surgical apply_edits (find=old, replace=new).
//   - reset         → remove the one block (count drops) via replace_document.
// Every write lands as ONE commit tagged actor `skin:NAME` / `skin:reset`.
// This is v1 (theme-only); the always-on content-aware L1 restyle is a later
// phase (see docs/plans/2026-06-03-skinning-design.md).

import { readFile } from 'node:fs/promises';
import { extractInlineDoc } from './seed.mjs';
import { applyPlan, CliError } from './edit.mjs';
import { skinByName } from './skins.mjs';

// The single skin block (any data-rwa-skin value). CSS cannot contain a literal
// </style>, so the non-greedy match is exact; the `data-rwa-skin=` requirement
// means an author's own <style> is never matched.
const SKIN_BLOCK_RE = /<style\b[^>]*\bdata-rwa-skin=["'][^"']*["'][^>]*>[\s\S]*?<\/style>/i;
// Same, plus an optional trailing newline, so reset removes the block cleanly.
const SKIN_BLOCK_TRAIL_RE = /<style\b[^>]*\bdata-rwa-skin=["'][^"']*["'][^>]*>[\s\S]*?<\/style>\n?/i;

/**
 * Apply a named preset (or `reset`) to a rewritable on disk, deterministically.
 *
 * @param {string} filePath — path to the target .html
 * @param {string} action — a skin name (see cli/src/skins.mjs) or the literal `reset`
 * @returns {Promise<{exitCode:0, mode:'insert'|'swap'|'reset'|'noop', skin:string|null}>}
 * @throws {CliError} exit 2 on file / non-rewritable / unknown-skin errors
 */
export async function skinCmd(filePath, action) {
  // Read + validate the target identically to edit.mjs/doc.mjs (file errors first).
  let fileText;
  try {
    fileText = await readFile(filePath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') throw new CliError(2, 'not_found', { path: filePath });
    throw new CliError(2, 'read_error', { path: filePath, errno: e && e.code, message: e && e.message });
  }
  let currentDoc;
  try {
    currentDoc = extractInlineDoc(fileText);
  } catch (_e) {
    throw new CliError(2, 'not_a_rewritable', { path: filePath });
  }

  const existing = currentDoc.match(SKIN_BLOCK_RE);

  if (action === 'reset') {
    if (!existing) return { exitCode: 0, mode: 'noop', skin: null };
    const newDoc = currentDoc.replace(SKIN_BLOCK_TRAIL_RE, '');
    await applyPlan(filePath, { version: 'rwa-edit/1', doc: newDoc, reason: 'skin:reset' });
    return { exitCode: 0, mode: 'reset', skin: null };
  }

  const skin = skinByName(action); // throws exit-2 on unknown name

  if (existing) {
    await applyPlan(filePath, {
      version: 'rwa-edit/1',
      edits: [{ find: existing[0], replace: skin.theme }],
    });
    return { exitCode: 0, mode: 'swap', skin: skin.name };
  }

  const newDoc = skin.theme + '\n' + currentDoc;
  await applyPlan(filePath, { version: 'rwa-edit/1', doc: newDoc, reason: `skin:${skin.name}` });
  return { exitCode: 0, mode: 'insert', skin: skin.name };
}
