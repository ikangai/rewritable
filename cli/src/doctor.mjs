// `rwa doctor <path>` — standalone, offline, READ-ONLY health check for a
// rewritable container (issue #23).
//
// Why this verb exists: the edit-validation battery (frozen-zone integrity,
// size caps, asset tokens, structural balance) today only runs as a SIDE
// EFFECT of an actual `rwa edit` — there is no way to ask "is this container
// currently valid?" of a received, hand-edited, or years-old file without
// risking a write. `doctor` runs the same battery `apply-edits.mjs` already
// enforces (plus a couple of static-only checks `rwa edit` has no reason to
// run) against a document that never changes underneath it.
//
// Shape mirrors ./doc.mjs (the closest sibling read-path entry): read the
// file, extract INLINE_DOC, recover uuid/kind by regex, throw CliError(2, …)
// on file/non-rewritable errors. Where doc.mjs returns the body, doctor.mjs
// returns a `findings` list — one entry per check, ALWAYS present (never
// silently omitted, Rule 12), so a --json consumer can tell "this check ran
// and passed" apart from "this check didn't run".
//
// NEVER writes. Every helper reused below (findFrozenZones,
// unterminatedFrozenMarker, dataRwaFrozenSnapshot, tagHasFrozenAttr,
// matchingCloseEnd, VOID_ELEMENTS, virtualizeImages, MAX_DOC) is imported
// from ./apply-edits.mjs rather than re-derived — that module is the
// hand-mirror of the seed's validation battery; re-deriving any of this
// logic here would be a second, driftable copy of subtle matching rules.

import { readFile } from 'node:fs/promises';
import { extractInlineDoc, loadSeed, seedIdentity } from './seed.mjs';
import { SEED_CANDIDATES } from './commands.mjs';
import { CliError } from './edit.mjs';
import { readOfferedRole } from './skill-manifest.mjs';
import {
  findFrozenZones, unterminatedFrozenMarker, dataRwaFrozenSnapshot,
  tagHasFrozenAttr, matchingCloseEnd, VOID_ELEMENTS, virtualizeImages, MAX_DOC,
} from './apply-edits.mjs';

// Mirrors seed.mjs UUID_RE/PRODUCT_KIND_RE and doc.mjs's own copies — the
// bootstrap bakes both consts at emit time (cli/src/seed.mjs applySeedSubs).
// Keep in step with doc.mjs/upgrade.mjs/rwa.mjs detectProductKind.
const UUID_RE = /const DOC_UUID = '([0-9a-f-]{36})';/;
const PRODUCT_KIND_RE = /const PRODUCT_KIND = '([^']*)';/;
// Mirrors upgrade.mjs SEED_ID_VALUE_RE — the derived seed identity stamped by
// applySeedSubs, read back to compare against the CLI's current seed.
const SEED_ID_VALUE_RE = /<meta name="rwa-seed" content="([0-9a-f]{12})">/;
// Mirrors edit.mjs assertFrozenPreserved's reserved-id guard — the runtime
// mount id must never appear inside the editable body.
const RESERVED_ID_RE = /\bid\s*=\s*["']?rwa-doc-mount(?=["'\s/>]|$)/i;
// Mirrors apply-edits.mjs/edit.mjs's rwa-id-strict id scan.
const BLOCK_ID_RE = /\sdata-rwa-id\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function ok(id, title, detail, facts = {}) {
  return { id, severity: 'info', title, detail, ...facts };
}
function warn(id, title, detail, facts = {}) {
  return { id, severity: 'warn', title, detail, ...facts };
}
function err(id, title, detail, facts = {}) {
  return { id, severity: 'error', title, detail, ...facts };
}

// ─── tag_balance — parser-free <script>/<style> open/close count check ────
// Mirror of the seed's tagBalance (seeds/rewritable.html, search
// `function tagBalance` / `tag_imbalance`): symmetric lookaheads so a custom
// element (<script-foo>, <style-bar>) is counted as neither an open nor a
// close. Kept parser-free on purpose — the CLI is parser-free by design
// (rwa-edit-spec.md's documented v1 scope-down; see apply-edits.mjs header).
function tagBalance(doc) {
  const opens = {
    script: (doc.match(/<script(?=[\s>/])/gi) || []).length,
    style: (doc.match(/<style(?=[\s>/])/gi) || []).length,
  };
  const closes = {
    script: (doc.match(/<\/script(?=[\s>])/gi) || []).length,
    style: (doc.match(/<\/style(?=[\s>])/gi) || []).length,
  };
  const mismatches = [];
  for (const tag of ['script', 'style']) {
    if (opens[tag] !== closes[tag]) mismatches.push({ tag, opens: opens[tag], closes: closes[tag] });
  }
  return { opens, closes, mismatches };
}

// ─── frozen_attr malformed detection ───────────────────────────────────────
// dataRwaFrozenSnapshot (apply-edits.mjs) is best-effort: given an
// UNTERMINATED data-rwa-frozen element (no matching close tag) it silently
// snapshots "rest of document" rather than flagging the problem — correct for
// its job (a relative before/after diff, where a consistent mis-scan of an
// unchanged element still compares equal) but useless for a health check,
// which has no "before" to diff against. This walks the same open-tag scan
// dataRwaFrozenSnapshot/markerZoneRangesIn use and calls out matchingCloseEnd
// directly so a genuinely unterminated frozen attribute zone is reported by
// name instead of silently accepted.
function findMalformedFrozenAttrs(doc) {
  const bad = [];
  const openRe = /<([a-zA-Z][A-Za-z0-9-]*)\b[^>]*\bdata-rwa-frozen\b[^>]*>/g;
  let m;
  while ((m = openRe.exec(doc)) !== null) {
    const tag = m[1].toLowerCase();
    const openTag = m[0];
    if (!tagHasFrozenAttr(openTag)) continue; // value/longer-name false positive
    if (VOID_ELEMENTS.has(tag) || /\/>\s*$/.test(openTag)) continue; // self-contained, no close expected
    const closeEnd = matchingCloseEnd(doc, tag, m.index + openTag.length);
    if (closeEnd === -1) bad.push(tag);
  }
  return bad;
}

/**
 * Run the offline, read-only health-check battery against a rewritable's
 * editable body. NEVER writes to `filePath`.
 *
 * @param {string} filePath
 * @returns {Promise<{ok: boolean, uuid: string|null, kind: string,
 *   findings: Array<{id: string, severity: 'error'|'warn'|'info',
 *   title: string, detail: string|null, [fact: string]: any}>}>}
 * @throws {CliError} exitCode 2 on file / non-rewritable errors, mirroring
 *   doc.mjs's inspectDoc exactly (not_found, read_error, not_a_rewritable).
 */
export async function diagnose(filePath) {
  let fileText;
  try {
    fileText = await readFile(filePath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') throw new CliError(2, 'not_found', { path: filePath });
    throw new CliError(2, 'read_error', { path: filePath, errno: e && e.code, message: e && e.message });
  }

  let doc;
  try {
    doc = extractInlineDoc(fileText);
  } catch (_e) {
    throw new CliError(2, 'not_a_rewritable', { path: filePath });
  }

  const uuid = (fileText.match(UUID_RE) || [])[1] || null;
  const kind = (fileText.match(PRODUCT_KIND_RE) || [])[1] || 'document';

  const findings = [];

  // ── frozen_unterminated ────────────────────────────────────────────────
  const unterminated = unterminatedFrozenMarker(doc);
  findings.push(unterminated
    ? err('frozen_unterminated', 'Unterminated frozen-zone marker',
        `Zone "${unterminated}" has a begin marker with no matching end marker — the runtime would treat everything after it as frozen, silently rejecting unrelated edits.`,
        { zone: unterminated })
    : ok('frozen_unterminated', 'No unterminated frozen-zone markers', null));

  // ── frozen_zones (info — inventory, not a defect) ─────────────────────
  const zones = findFrozenZones(doc).map(z => z.name);
  findings.push(ok('frozen_zones',
    zones.length ? `${zones.length} frozen zone${zones.length === 1 ? '' : 's'}` : 'No frozen zones',
    zones.length ? zones.join(', ') : 'This document declares no marker-form frozen zones.',
    { zones }));

  // ── frozen_attr — malformed data-rwa-frozen attribute-form zones ──────
  let malformedAttrs = [];
  let attrSnapshotError = null;
  try {
    dataRwaFrozenSnapshot(doc);
    malformedAttrs = findMalformedFrozenAttrs(doc);
  } catch (e) {
    attrSnapshotError = (e && e.message) || String(e);
  }
  if (attrSnapshotError) {
    findings.push(err('frozen_attr', 'data-rwa-frozen attribute scan failed', attrSnapshotError));
  } else if (malformedAttrs.length) {
    findings.push(err('frozen_attr', 'Malformed data-rwa-frozen attribute-form zone',
      `Element(s) with data-rwa-frozen have no matching close tag: ${malformedAttrs.join(', ')}.`,
      { elements: malformedAttrs }));
  } else {
    findings.push(ok('frozen_attr', 'No malformed data-rwa-frozen attribute zones', null));
  }

  // ── tag_balance ─────────────────────────────────────────────────────
  const balance = tagBalance(doc);
  findings.push(balance.mismatches.length
    ? err('tag_balance', '<script>/<style> tag counts disagree',
        balance.mismatches.map(m => `${m.tag}: ${m.opens} open / ${m.closes} close`).join('; '),
        { opens: balance.opens, closes: balance.closes })
    : ok('tag_balance', '<script>/<style> tags balanced', null, { opens: balance.opens, closes: balance.closes }));

  // ── agent_references — who is spending the document's budget (#45) ──
  // A carried reference lives inside the frozen #rwa-agents zone, which is inside
  // INLINE_DOC, so its bytes count against the SAME cap size_headroom reports
  // below. Without attribution the failure mode is genuinely baffling: an
  // ordinary edit to an ordinary paragraph fails with target_size_exceeded, and
  // nothing in that message mentions a skill reference bundled by whoever
  // authored the carrier. "your references are 400 KB of your 1 MB budget" is
  // the only form of it anyone can act on.
  {
    const offered = readOfferedRole(doc);
    const refBytes = offered.offered.reduce((n, o) => n + (o.referenceBytes || 0), 0);
    const refCount = offered.offered.reduce((n, o) => n + (o.referenceCount || 0), 0);
    if (refCount > 0) {
      const share = Math.round((refBytes / MAX_DOC) * 1000) / 10;
      const detail = `${refCount} reference${refCount === 1 ? '' : 's'}, ${refBytes} bytes — ${share}% of the ${MAX_DOC}-byte document budget.`;
      // Warn, never error: carrying references is the point of a carrier. The
      // finding exists to make the cost visible, not to discourage it.
      findings.push(share >= 25
        ? warn('agent_references', 'Carried references take a large share of the document budget', detail,
          { count: refCount, bytes: refBytes, cap: MAX_DOC, pct: share })
        : ok('agent_references', 'Carried references are within a modest share of the budget', detail,
          { count: refCount, bytes: refBytes, cap: MAX_DOC, pct: share }));
    }
  }

  // ── size_headroom ──────────────────────────────────────────────────
  // Measured on the VIRTUALIZED form, which is what applyEdits actually caps:
  // "measured on the final working copy — the virtual/token form under
  // images-v1, so image bytes never count against the text budget"
  // (apply-edits.mjs, at the target_size_exceeded throw). Measuring the raw doc
  // instead would report a document holding 1.2 MB of embedded images as 117%
  // of cap and fail it, while its real edit budget was untouched — a false
  // alarm that reads as "delete your content". Units are UTF-16 code units,
  // the unit the enforced cap uses, so `pct` tracks the same number that would
  // trip target_size_exceeded on the next edit.
  const bytes = virtualizeImages(doc).doc.length;
  const pct = Math.round((bytes / MAX_DOC) * 1000) / 10; // one decimal place
  if (bytes > MAX_DOC) {
    findings.push(err('size_headroom', 'Document exceeds the size cap',
      `${bytes} of ${MAX_DOC} (${pct}%) — apply_edits/replace_document will reject any further growth with target_size_exceeded.`,
      { bytes, cap: MAX_DOC, pct }));
  } else if (pct >= 80) {
    findings.push(warn('size_headroom', 'Document is close to the size cap',
      `${bytes} of ${MAX_DOC} (${pct}%).`,
      { bytes, cap: MAX_DOC, pct }));
  } else {
    findings.push(ok('size_headroom', 'Document has size headroom',
      `${bytes} of ${MAX_DOC} (${pct}%).`,
      { bytes, cap: MAX_DOC, pct }));
  }

  // ── asset_tokens — rwa-asset:<hash8> tokens with no backing bytes ────
  // rwa-edit-spec.md §19 "orphan tolerance": a token already present in the
  // STORED document (as opposed to one minted transiently at an agent
  // boundary) maps to nothing — it renders as a broken image. virtualizeImages
  // computes exactly this "orphans" set from the raw doc; reuse it verbatim
  // rather than re-deriving the token grammar.
  const { orphans } = virtualizeImages(doc);
  const orphanTokens = [...orphans];
  findings.push(orphanTokens.length
    ? err('asset_tokens', 'Unbacked rwa-asset image token(s)',
        `${orphanTokens.length} token(s) have no backing image bytes and will render as a broken image: ${orphanTokens.join(', ')}.`,
        { tokens: orphanTokens })
    : ok('asset_tokens', 'No unbacked rwa-asset tokens', null, { tokens: [] }));

  // ── reserved_id ────────────────────────────────────────────────────
  findings.push(RESERVED_ID_RE.test(doc)
    ? err('reserved_id', 'Reserved runtime id used in the document body',
        'id="rwa-doc-mount" appears inside the editable body — it would shadow/hijack the runtime mount.')
    : ok('reserved_id', 'No reserved runtime id in the document body', null));

  // ── block_ids — duplicate data-rwa-id values ─────────────────────────
  const idCounts = new Map();
  let bm;
  BLOCK_ID_RE.lastIndex = 0;
  while ((bm = BLOCK_ID_RE.exec(doc)) !== null) {
    const id = bm[1] != null ? bm[1] : bm[2];
    idCounts.set(id, (idCounts.get(id) || 0) + 1);
  }
  const dupIds = [...idCounts.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  findings.push(dupIds.length
    ? warn('block_ids', 'Duplicate data-rwa-id values',
        `Anchors that reference these ids may resolve to the wrong block: ${dupIds.join(', ')}.`,
        { duplicates: dupIds })
    : ok('block_ids', 'No duplicate data-rwa-id values', null, { duplicates: [] }));

  // ── alt_text / heading_outline (#28) ──────────────────────────────
  // Accessibility of the AUTHORED document, decided in scope 2026-08-26: these
  // containers exist to be shared, and a shared document meets a reader who may
  // arrive with a screen reader. Reported, never enforced — `rwa doctor` is a
  // health check, and an author is allowed to ship a document it complains
  // about. Both checks are warn-severity for that reason: they never fail a
  // build, they only make the state visible. The runtime teaches the same two
  // rules to the agent (SYSTEM_PROMPT_RULES, "Accessibility"), so the common
  // case is that nothing here ever fires.
  const imgs = [...doc.matchAll(/<img\b[^>]*>/gi)].map(m => m[0]);
  const noAlt = imgs.filter(t => !/\balt\s*=/i.test(t));
  findings.push(noAlt.length
    ? warn('alt_text', 'Image(s) without an alt attribute',
        `${noAlt.length} of ${imgs.length} <img> tag(s) carry no alt — a screen reader announces the file name, or nothing. Use alt="" only for purely decorative images.`,
        { images: imgs.length, missing: noAlt.length })
    : ok('alt_text', imgs.length ? 'Every image has an alt attribute' : 'No images to describe', null,
        { images: imgs.length, missing: 0 }));

  // Outline well-formedness: one h1, no level skipped going down. Same rule the
  // trajectory scorer's `headings` dimension measures, applied to one document
  // instead of a sequence.
  const levels = [...doc.matchAll(/<h([1-6])\b/gi)].map(m => Number(m[1]));
  const h1s = levels.filter(l => l === 1).length;
  const jumps = levels.reduce((n, l, i) => (i > 0 && l > levels[i - 1] + 1 ? n + 1 : n), 0);
  const outlineProblems = [];
  if (h1s > 1) outlineProblems.push(`${h1s} h1 elements (expected at most 1)`);
  if (jumps > 0) outlineProblems.push(`${jumps} skipped heading level(s)`);
  findings.push(outlineProblems.length
    ? warn('heading_outline', 'Heading outline is not well formed',
        `${outlineProblems.join('; ')} — screen-reader users navigate by this outline.`,
        { headings: levels.length, h1: h1s, jumps })
    : ok('heading_outline', levels.length ? 'Heading outline is well formed' : 'No headings', null,
        { headings: levels.length, h1: h1s, jumps: 0 }));

  // ── seed_freshness ────────────────────────────────────────────────
  // Reuses upgrade.mjs's approach (same SEED_CANDIDATES resolution +
  // seedIdentity hash) rather than a new staleness check — see
  // cli/src/upgrade.mjs for the full rationale on why the in-package seed
  // candidate can shadow the repo-canonical one.
  const currentSeedId = (fileText.match(SEED_ID_VALUE_RE) || [])[1] || null;
  // A health check must not crash on the one check that reaches outside the
  // file. If no seed can be resolved, say so and keep the other findings —
  // reporting nothing at all would be the failure mode this verb exists to end.
  let targetSeedId = null, seedLoadError = null;
  try {
    targetSeedId = seedIdentity(await loadSeed(SEED_CANDIDATES));
  } catch (e) {
    seedLoadError = (e && e.message) || String(e);
  }
  if (seedLoadError) {
    findings.push(warn('seed_freshness', 'Could not resolve a seed to compare against',
      `${seedLoadError} — freshness unverified; every other check above still ran.`,
      { currentSeedId, targetSeedId: null }));
  } else if (currentSeedId == null) {
    findings.push(warn('seed_freshness', 'No stamped seed identity found',
      'This container predates <meta name="rwa-seed">, so freshness cannot be verified. `rwa upgrade` will re-bootstrap it onto the current seed.',
      { currentSeedId: null, targetSeedId }));
  } else if (currentSeedId !== targetSeedId) {
    findings.push(warn('seed_freshness', 'Container is behind the current seed',
      `Stamped seed ${currentSeedId} differs from the CLI's current seed ${targetSeedId}. Run \`rwa upgrade\` to pick up bootstrap fixes.`,
      { currentSeedId, targetSeedId }));
  } else {
    findings.push(ok('seed_freshness', 'Container is at the current seed', null,
      { currentSeedId, targetSeedId }));
  }

  const hasError = findings.some(f => f.severity === 'error');
  return { ok: !hasError, uuid, kind, findings };
}

/**
 * Render a diagnose() result as a compact, human-readable report: one line
 * per finding, severity-prefixed, plus a summary footer. Exported (mirrors
 * ls.mjs's formatRows) so the formatter is testable independent of the CLI
 * process.
 *
 * @param {string} filePath
 * @param {{ok: boolean, uuid: string|null, kind: string, findings: object[]}} result
 * @returns {string}
 */
export function formatReport(filePath, result) {
  const lines = [];
  lines.push(`rwa doctor: ${filePath} (kind=${result.kind}, uuid=${result.uuid || '—'})`);
  for (const f of result.findings) {
    const tag = `[${f.severity.toUpperCase()}]`;
    let line = `${tag} ${f.id}: ${f.title}`;
    if (f.detail) line += ` — ${f.detail}`;
    lines.push(line);
  }
  const errors = result.findings.filter(f => f.severity === 'error').length;
  const warnings = result.findings.filter(f => f.severity === 'warn').length;
  lines.push('');
  lines.push(result.ok
    ? `OK — ${result.findings.length} checks, 0 errors, ${warnings} warning${warnings === 1 ? '' : 's'}`
    : `FAIL — ${result.findings.length} checks, ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`);
  return lines.join('\n');
}
