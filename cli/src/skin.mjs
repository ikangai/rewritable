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
import { skinByName, RWA_SKIN_RECIPES } from './skins.mjs';
import { applyEdits, RwaEditError, findFrozenZones } from './apply-edits.mjs';
import { compileDslPlan } from './dsl-compiler.mjs';

// The single skin block (any data-rwa-skin value). CSS cannot contain a literal
// </style>, so the non-greedy match is exact; the `data-rwa-skin=` requirement
// means an author's own <style> is never matched. These mirror the seed's
// RWA_SKIN_BLOCK_RE / RWA_SKIN_BLOCK_TRAIL_RE (seeds/rewritable.html ~:2729).
const SKIN_BLOCK_RE = /<style\b[^>]*\bdata-rwa-skin=["'][^"']*["'][^>]*>[\s\S]*?<\/style>/i;
// Same, plus an optional trailing newline, so reset removes the block cleanly.
const SKIN_BLOCK_TRAIL_RE = /<style\b[^>]*\bdata-rwa-skin=["'][^"']*["'][^>]*>[\s\S]*?<\/style>\n?/i;

// ── deskin + splice (MANUAL MIRROR of seeds/rewritable.html ~:2731–2851) ──────
// spliceSkinBlock / deskinDoc (+ its parser-free helpers) are copied
// BYTE-IDENTICAL from the seed (the canonical site for the browser ✦ gallery's
// L1). No cmp gate; the pin test cli/tests/skin-l1-seed-mirror.test.mjs extracts
// the function bodies from the seed and compares them against these so drift
// fails the suite loudly. When the seed changes, re-copy here. The seed names
// the two regexes RWA_SKIN_BLOCK_RE / RWA_SKIN_BLOCK_TRAIL_RE; the CLI declares
// them above without the RWA_ prefix — the mirror test normalizes that prefix.

// spliceSkinBlock — swap an existing <style data-rwa-skin> block for `theme`, or
// prepend it. Splice-based (not String.replace) so theme bytes land verbatim
// (a $-sequence in CSS would otherwise be mangled). Shared by the L1 compose
// transform in applySkinL1; mirrors applySkin's deterministic L0 swap/insert.
function spliceSkinBlock(doc, theme) {
  const m = doc.match(SKIN_BLOCK_RE);
  if (!m) return theme + '\n' + doc;
  const i = doc.indexOf(m[0]);
  return doc.slice(0, i) + theme + doc.slice(i + m[0].length);
}
// deskinDoc — deterministically strip a PRIOR skin so a re-skin/reset starts clean,
// regardless of model compliance (closes the v2 best-effort de-skin limitation):
//   1. remove the <style data-rwa-skin> block; 2. balanced-tag UNWRAP pure sk-*
//   div/span wrappers (keep inner — handles nesting like sk-stat-row > sk-stat);
//   3. strip sk-* tokens from mixed class attrs. Parser-free, idempotent, byte-exact
//   for non-sk content. applySkinL1 runs the agent on deskinDoc(cur); resetSkin
//   commits deskinDoc(doc). (Stat-tile recipes split text, so their unwrap joins it —
//   a known minor lossiness, far better than orphan-wrapper accumulation.)
const SK_TOKEN_RE = /^sk-[a-z][a-z0-9-]*$/;
const isSkToken = (tok) => SK_TOKEN_RE.test(tok);
function readClassAttr(tagInner) {
  const m = /(^|\s)class\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tagInner);
  if (!m) return null;
  return m[3] !== undefined ? m[3] : m[4];
}
function classIsPureSk(classValue) {
  const toks = classValue.trim().split(/\s+/).filter(Boolean);
  return toks.length > 0 && toks.every(isSkToken);
}
// quote-aware: a `>` inside a quoted attr value is skipped. Returns index past `>`.
function skEndOfTag(s, lt) {
  let quote = null;
  for (let i = lt + 1; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote) quote = null; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i + 1;
  }
  return -1;
}
function skReadTagName(s, start) {
  let i = start, name = '';
  while (i < s.length) {
    const c = s[i];
    if (/[a-zA-Z0-9]/.test(c) || c === '-' || c === ':') { name += c; i++; } else break;
  }
  return name === '' ? null : name;
}
// balanced same-name close, accounting for nested same-name opens.
function skFindMatchingClose(s, openTagEnd, tag) {
  let depth = 1, i = openTagEnd;
  const tlc = tag.toLowerCase();
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt === -1) return null;
    const after = s[lt + 1];
    if (after === '/') {
      const name = skReadTagName(s, lt + 2);
      const tagEnd = skEndOfTag(s, lt);
      if (tagEnd === -1) return null;
      if (name !== null && name.toLowerCase() === tlc) { depth--; if (depth === 0) return { closeStart: lt, closeEnd: tagEnd }; }
      i = tagEnd;
    } else if (after === '!') {
      if (s.startsWith('<!--', lt)) { const ce = s.indexOf('-->', lt + 4); i = ce === -1 ? s.length : ce + 3; }
      else { const tagEnd = skEndOfTag(s, lt); i = tagEnd === -1 ? s.length : tagEnd; }
    } else {
      const name = skReadTagName(s, lt + 1);
      const tagEnd = skEndOfTag(s, lt);
      if (tagEnd === -1) return null;
      if (name !== null && name.toLowerCase() === tlc) depth++;
      i = tagEnd;
    }
  }
  return null;
}
function unwrapPureSkWrappers(doc) {
  let s = doc, i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt === -1) break;
    const after = s[lt + 1];
    if (after === '/' || after === '!' || after === '?') {
      if (s.startsWith('<!--', lt)) { const ce = s.indexOf('-->', lt + 4); i = ce === -1 ? s.length : ce + 3; }
      else { const te = skEndOfTag(s, lt); i = te === -1 ? s.length : te; }
      continue;
    }
    const name = skReadTagName(s, lt + 1);
    const tagEnd = skEndOfTag(s, lt);
    if (name === null || tagEnd === -1) { i = lt + 1; continue; }
    const lname = name.toLowerCase();
    if (lname === 'div' || lname === 'span') {
      const tagInner = s.slice(lt + 1 + name.length, tagEnd - 1);
      const classValue = readClassAttr(tagInner);
      if (classValue !== null && classIsPureSk(classValue)) {
        const match = skFindMatchingClose(s, tagEnd, lname);
        if (match) {
          s = s.slice(0, lt) + s.slice(tagEnd, match.closeStart) + s.slice(match.closeEnd);
          i = lt; // restart at exposed inner (may begin with a nested wrapper)
          continue;
        }
      }
    }
    i = tagEnd;
  }
  return s;
}
function stripSkClassTokens(doc) {
  return doc.replace(/(\s*)class\s*=\s*("([^"]*)"|'([^']*)')/gi, (full, lead, quoted, dq, sq) => {
    const quoteChar = dq !== undefined ? '"' : "'";
    const value = dq !== undefined ? dq : sq;
    const kept = value.split(/\s+/).filter(Boolean).filter((t) => !isSkToken(t));
    return kept.length === 0 ? '' : lead + 'class=' + quoteChar + kept.join(' ') + quoteChar;
  });
}
export function deskinDoc(doc) {
  if (typeof doc !== 'string') return doc;
  let s = doc.replace(SKIN_BLOCK_TRAIL_RE, '');
  s = unwrapPureSkWrappers(s);
  s = stripSkClassTokens(s);
  return s;
}

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
    // reset now mirrors the seed's resetSkin: deskinDoc clears the theme block
    // AND any sk-* wrappers/classes a prior L1 restyle left, regardless of the
    // --l1 flag. A doc with no theme block and no sk-* hooks is byte-unchanged
    // by deskinDoc → noop (no write), preserving the idempotent reset contract.
    const newDoc = deskinDoc(currentDoc);
    if (newDoc === currentDoc) return { exitCode: 0, mode: 'noop', skin: null };
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

/**
 * Apply a named preset with the opt-in L1 (agent-driven, content-aware) restyle.
 * Mirrors the seed's applySkinL1 (seeds/rewritable.html ~:2908) but adapted to
 * the CLI's no-mid-stream-tool-call agent loop (runAgentLoop returns the
 * envelope WITHOUT writing — that IS the seed's noCommit accumulate seam):
 *
 *   1. deskinDoc(currentDoc) → cleanBase  (deterministic, so a re-skin starts
 *      clean regardless of model compliance).
 *   2. runAgentLoop(recipe, cleanBase) → an apply_edits / DSL envelope (additive
 *      sk-* hooks). Applied IN MEMORY against cleanBase via applyEdits — NOT
 *      applyPlan, so nothing is written yet. replace_document is refused (the
 *      agent must not rewrite wholesale), mirroring the seed's
 *      compose_requires_apply_edits guard.
 *   3. spliceSkinBlock(agentDoc, theme) → finalDoc.
 *   4. ONE applyPlan(filePath, {doc: finalDoc, reason}) — a single replace_document
 *      commit (theme + wrappers land together; one undo frame in the browser).
 *
 * Graceful fallback: if the agent declines / produces nothing usable, the theme
 * is still spliced onto cleanBase and committed once (theme-only), so a skin
 * always lands. The ONLY loud failure is a missing/unreachable backend — that is
 * surfaced to the caller (bin maps it to exit 4) rather than silently degrading,
 * matching how `rwa edit`'s instruction path treats a missing backend.
 *
 * @param {string} filePath — path to the target .html
 * @param {string} name — a skin name (see cli/src/skins.mjs); `reset` is not an L1 action
 * @param {object} agentOpts — { systemPrompt, toolSchemas, backend, frozenZoneNames?, onRetry? }
 *   — the same shape bin/rwa.mjs builds for `rwa edit`'s instruction path.
 * @returns {Promise<{exitCode:0, mode:'l1'|'theme-only', skin:string, degraded?:boolean}>}
 * @throws {CliError} exit 2 (file / non-rewritable / unknown-skin); exit 4 (backend)
 */
export async function skinCmdL1(filePath, name, agentOpts) {
  // File + non-rewritable validation, same surface as skinCmd.
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

  const skin = skinByName(name);           // throws exit-2 on unknown name
  const recipe = RWA_SKIN_RECIPES[name];   // every shipped preset has one

  // Deterministically de-skin any PRIOR skin first, so re-skin starts clean
  // (the seed runs deskinDoc on the base before driving the agent).
  const cleanBase = deskinDoc(currentDoc);

  // Drive the agent over cleanBase. runAgentLoop does NOT write — it returns the
  // first valid envelope. Frozen-zone names come from the CURRENT doc so the
  // model sees the same list the apply guard enforces.
  const { runAgentLoop, AgentError } = await import('./agent-loop.mjs');
  let agentDoc = null;     // the agent's restyled doc (in memory), or null on decline/failure
  let degraded = false;    // true when we fell back to theme-only
  try {
    const { envelope, toolName } = await runAgentLoop({
      systemPrompt: agentOpts.systemPrompt,
      toolSchemas: agentOpts.toolSchemas,
      currentDoc: cleanBase,
      instruction: recipe,
      frozenZoneNames: agentOpts.frozenZoneNames || findFrozenZones(cleanBase).map(z => z.name),
      backend: agentOpts.backend,
      onRetry: agentOpts.onRetry,
    });
    agentDoc = composeAgentDoc(envelope, toolName, cleanBase);
  } catch (e) {
    // Split the two failure classes the way the task spec (and CLI convention)
    // requires:
    //   - backend_error (no key handled upstream / unreachable host / HTTP error)
    //     → LOUD. Propagate so bin maps it to exit 4. The seed can degrade an
    //     unreachable backend to theme-only because it has a bridge fallback; the
    //     CLI has none, so "L1 with no usable backend" is a real error, matching
    //     how `rwa edit`'s instruction path treats a missing/unreachable backend.
    //   - no_envelope_after_retries (backend WAS reached but the model never
    //     produced a usable envelope — declined / invalid JSON every turn) → the
    //     "agent declines / produces nothing usable" case: GRACEFUL theme-only,
    //     so the skin still lands. Mirrors the seed's model_declined degrade.
    if (e && e.subcode === 'backend_error') {
      throw new CliError(4, e.subcode, e.details);
    }
    if (e && e.subcode === 'no_envelope_after_retries') { agentDoc = null; degraded = true; }
    else if (e instanceof CliError) throw e;
    // A compose-stage RwaEditError (agent edits invalid against cleanBase) is a
    // graceful theme-only fallback — the skin still lands. Mirrors the seed,
    // where an invalid agent edit degrades to a theme-only commit.
    else if (e instanceof RwaEditError) { agentDoc = null; degraded = true; }
    else throw e;
  }
  if (agentDoc === null) degraded = true;

  // compose-then-commit: splice the deterministic theme block onto the agent's
  // output (or onto cleanBase when degraded) and commit ONCE. replace_document
  // is shape-exempt so the runtime-added <style> is allowed (the agent's
  // in-memory apply_edits could not add one — structuralShape blocked it).
  const finalDoc = spliceSkinBlock(agentDoc !== null ? agentDoc : cleanBase, skin.theme);
  await applyPlan(filePath, {
    version: 'rwa-edit/1',
    doc: finalDoc,
    reason: `skin:${skin.name} (theme+L1)`,
  });
  return { exitCode: 0, mode: degraded ? 'theme-only' : 'l1', skin: skin.name, degraded };
}

// composeAgentDoc — apply the agent's envelope IN MEMORY against cleanBase
// (no write). Mirrors the seed's compose-mode dispatch in modify(): apply_edits
// and the DSL's apply_edits compile path are allowed; replace_document (raw or a
// DSL escape op) is refused with compose_requires_apply_edits so the agent can't
// rewrite wholesale and bypass the additive / structural-shape guard. Returns
// the restyled doc string. Throws RwaEditError on an invalid edit (caught by the
// caller → graceful theme-only fallback) or compose_requires_apply_edits.
function composeAgentDoc(envelope, toolName, cleanBase) {
  if (toolName === 'apply_dsl_plan') {
    let compiled;
    try {
      compiled = compileDslPlan(envelope, cleanBase);
    } catch (e) {
      throw new RwaEditError(e.code || 'dsl_compile_error', null, { message: e.message });
    }
    if (compiled.tool === 'replace_document') {
      throw new RwaEditError('compose_requires_apply_edits');
    }
    return applyEdits(cleanBase, compiled.envelope.edits);
  }
  if (toolName === 'apply_edits') {
    return applyEdits(cleanBase, envelope.edits);
  }
  // replace_document (or any other tool) — refused in compose mode.
  throw new RwaEditError('compose_requires_apply_edits');
}
