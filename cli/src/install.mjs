// `rwa install <skill.rwa-skill.json> <skill-host.html>` (v0.9 open-items spec §3 / I11).
//
// The offline, headless counterpart of the seed's interactive install dialog
// (seeds/rewritable.html showSkillInstallDialog / runtimeInstallSkill). It gates a
// skill envelope through the SAME trust checks as the seed — Ed25519 signature
// verify, validateInstall (unsigned-capability / compute-with-perms / permission
// grammar), and the dynamic-import() hard-reject — then splices the verified
// envelope into the frozen `<div data-rwa-frozen id="rwa-skills">` zone inside
// INLINE_DOC and re-bakes the file atomically.
//
// The CLI is the sole AUDITED exception to runtime-sole-writer (Invariant 19/39):
// applyEdits would REJECT a frozen-zone write, so install does a direct zone splice
// + replaceInlineDoc re-bake — writing the byte-identical zone form the seed's
// runtimeRegionCommit produces (skillId-sorted, base64(JSON(envelope)) blocks), so
// it re-verifies at the seed's boot. There is no dialog to consent in, so an
// explicit `--yes` is required; gate failures are final and `--yes` cannot override
// them.
//
// buildSkillZone here is a hand-mirror of the seed's buildSkillZone (there is no CLI
// zone-builder elsewhere — parseSkillZone in skill-manifest.mjs only READS). Same
// mirror discipline as cli/src/apply-edits.mjs mirrors the seed apply path.

import { readFile } from 'node:fs/promises';
import { skillId, verifyEnvelope, validateInstall, parseSkillZone, levenshtein, skeletonDistance, normalizeName } from './skill-manifest.mjs';
import { extractInlineDoc, replaceInlineDoc } from './seed.mjs';
import { tagHasFrozenAttr } from './apply-edits.mjs';
import { CliError } from './edit.mjs';
import { atomicWrite } from './atomic-write.mjs';

const SKILL_BLOCK_RE = /<script\s+type="application\/rwa-skill\+json">([\s\S]*?)<\/script>/g;

/** Mirror of the seed's _skCodeForbidden — refuse dynamic import() before any install.
 *  The seed enforces this at install AND invoke; the CLI enforces it at install (it never
 *  invokes). A code-loading channel the bridge/CSP can't see, so it is refused outright. */
export function codeForbidden(code) {
  return /\bimport\s*\(/.test(String(code || '')) ? 'dynamic_import_forbidden' : null;
}

/** Hand-mirror of the seed buildSkillZone: CANONICAL — sorted by skillId so the bytes are
 *  install-order-independent; each envelope re-emitted as utf-8 base64 inside its <script>
 *  block (matches parseSkillZone's read format) so it re-verifies at the seed's boot. */
export function buildSkillZone(envelopes) {
  const blocks = envelopes
    .map((e) => ({ id: skillId(e.skill.name, e.skill.author_pubkey), e }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((x) => '<script type="application/rwa-skill+json">' + Buffer.from(JSON.stringify(x.e)).toString('base64') + '</script>')
    .join('');
  return '<div data-rwa-frozen id="rwa-skills">' + blocks + '</div>';
}

/** Locate the frozen #rwa-skills zone — mirror of the seed's _skSkillsRegion.select():
 *  base64 content has no '<', so the first </div> after the open tag is the real close.
 *  STRICT data-rwa-frozen attribute-NAME check (mirror of the trust-read extractRwaSkillsZone):
 *  refuse to write into an editable lookalike `<div id="rwa-skills">` BEFORE any write, so the
 *  caller gets a clean no_skill_zone (exit 2) instead of a stray inert splice + a later
 *  durability throw. The kind gate already restricts to skill-host; this is defence in depth. */
function locateZone(doc) {
  const open = /<div\b[^>]*\bid="rwa-skills"[^>]*>/i.exec(doc);
  if (!open || !tagHasFrozenAttr(open[0])) return null;
  const close = doc.indexOf('</div>', open.index + open[0].length);
  if (close < 0) return null;
  return { start: open.index, innerStart: open.index + open[0].length, innerEnd: close, end: close + 6 };
}

/** The FULL existing envelopes in the zone (parseSkillZone returns projections only — we need
 *  the envelopes to merge). Malformed blocks are skipped (never block siblings). */
function zoneEnvelopes(doc) {
  const z = locateZone(doc);
  if (!z) return null;
  const out = [];
  for (const m of doc.slice(z.innerStart, z.innerEnd).matchAll(SKILL_BLOCK_RE)) {
    try { out.push(JSON.parse(Buffer.from(m[1].trim(), 'base64').toString('utf8'))); } catch { /* skip */ }
  }
  return out;
}

/** Non-blocking lookalike scan — mirror of the seed runtimeReviewSkill (seeds/rewritable.html
 *  ~6700-6706): a DIFFERENT author key bearing an exact (d===0) or near (Levenshtein 1-2, both
 *  names ≥4 chars) name is impersonation. The trust anchor is the KEY, not the name (Invariant
 *  10), so this only WARNS — install still proceeds (Invariant 23, non-blocking). */
function scanLookalike(existing, skill) {
  for (const e of existing) {
    const es = e.skill || {};
    const d = levenshtein(es.name, skill.name);
    const exact = d === 0;
    const near = d >= 1 && d <= 2 && String(skill.name).length >= 4 && String(es.name).length >= 4;
    if (es.author_pubkey !== skill.author_pubkey && (exact || near)) return es.name;
  }
  return null;
}

/** I5 (v0.9 §4) — Unicode-confusable (skeleton) scan. Catches homoglyph squatting that ASCII
 *  Levenshtein misses: a name whose RFC 7954 skeleton folds (≤1 edit) to a DIFFERENT author's
 *  installed name renders identically to a human. Returns the matched installed name or null.
 *  The discriminator is `skeleton < normalized-Levenshtein`: confusable folding must have
 *  COLLAPSED a real byte difference (cross-script glyphs). An honest ASCII near-miss (skeleton ==
 *  Levenshtein) is NOT a homoglyph — it stays the non-blocking Levenshtein warning (Invariant 10,
 *  and the I5 acceptance: "ASCII exact name, diff key → warning, install allowed"). Same author
 *  (a rebrand) never matches — restyling your own name is not impersonation. */
function scanSkeleton(existing, skill) {
  for (const e of existing) {
    const es = e.skill || {};
    if (es.author_pubkey === skill.author_pubkey) continue;
    const sd = skeletonDistance(es.name, skill.name);
    const ld = levenshtein(normalizeName(es.name), normalizeName(skill.name));
    if (sd <= 1 && sd < ld) return es.name; // folding made them confusable → impersonation
  }
  return null;
}

/**
 * Pure core: gate an envelope, merge it into the host's INLINE_DOC zone, return the new doc body.
 * No file I/O — installSkillFile owns that.
 * @returns {{ newDoc:string, result:object, changed:boolean }}
 * @throws {CliError} 3 envelope_error (gates) · 1 usage_error (no consent) · 2 file_error (no zone)
 */
export function installEnvelopeIntoDoc(inlineDoc, envelope, { consent } = {}) {
  if (!envelope || envelope.format !== 'rwa-skill/1' || !envelope.skill || typeof envelope.skill.name !== 'string') {
    throw new CliError(3, 'malformed_envelope', {});
  }
  const skill = envelope.skill;
  const { signed, verified } = verifyEnvelope(envelope);
  // Trust gates FIRST and FINAL — a gate failure throws before the consent check, so --yes
  // (or its absence) can never turn a refused skill into an installed one.
  const gate = validateInstall(envelope, { signed, verified });
  if (!gate.ok) throw new CliError(3, gate.errors[0], { errors: gate.errors });
  const forbidden = codeForbidden(skill.code);
  if (forbidden) throw new CliError(3, forbidden, {});
  // Consent: no dialog to review in → an explicit --yes is the offline review signal.
  if (!consent) throw new CliError(1, 'interactive_install_deferred', { skill: skill.name });

  const existing = zoneEnvelopes(inlineDoc);
  if (existing === null) throw new CliError(2, 'no_skill_zone', {}); // not a skill-host body
  const id = skillId(skill.name, skill.author_pubkey);
  // I5 (v0.9 §4) — Unicode-confusable HARD block. A signed skill (it carries capability to
  // escalate) whose name skeleton-folds to a DIFFERENT author's installed skill is impersonation:
  // refuse before any code is registered. Unsigned skills can't escalate → warn only (below).
  const skeletonMatch = scanSkeleton(existing, skill);
  if (skeletonMatch && signed) throw new CliError(3, 'lookalike_skeleton_blocked', { match: skeletonMatch });
  const lookalike = scanLookalike(existing, skill) || skeletonMatch; // non-blocking warning (Inv 10/23)
  const prevIdx = existing.findIndex((e) => skillId(e.skill.name, e.skill.author_pubkey) === id);
  const prev = prevIdx >= 0 ? existing[prevIdx] : null;

  // Same id + byte-identical envelope → already installed, no write.
  if (prev && JSON.stringify(prev) === JSON.stringify(envelope)) {
    return { newDoc: inlineDoc, changed: false, result: { skillId: id, name: skill.name, kind: skill.kind, verified, provenance: 'installed', status: 'already_installed', lookalike } };
  }

  const merged = prev ? existing.map((e, i) => (i === prevIdx ? envelope : e)) : existing.concat([envelope]);
  const z = locateZone(inlineDoc);
  const newDoc = inlineDoc.slice(0, z.start) + buildSkillZone(merged) + inlineDoc.slice(z.end);

  let update;
  if (prev) {
    const oldP = Array.isArray(prev.skill.permissions) ? prev.skill.permissions : [];
    const newP = Array.isArray(skill.permissions) ? skill.permissions : [];
    const oS = new Set(oldP), nS = new Set(newP);
    update = { isUpdate: true, added: newP.filter((p) => !oS.has(p)), removed: oldP.filter((p) => !nS.has(p)) };
  }
  return { newDoc, changed: true, result: { skillId: id, name: skill.name, kind: skill.kind, verified, provenance: 'installed', status: prev ? 'updated' : 'installed', lookalike, ...(update ? { update } : {}) } };
}

/**
 * Read an envelope + a skill-host container, gate + splice + write atomically, re-parse for durability.
 * @returns {Promise<object>} { skillId, name, kind, verified, provenance, status, update? }
 * @throws {CliError} 1 usage_error · 2 file_error · 3 envelope_error
 */
export async function installSkillFile(envPath, hostPath, { consent } = {}) {
  let envText;
  try { envText = await readFile(envPath, 'utf8'); }
  catch (e) { throw new CliError(2, e && e.code === 'ENOENT' ? 'not_found' : 'read_error', { path: envPath, errno: e && e.code }); }
  let hostBytes;
  try { hostBytes = await readFile(hostPath, 'utf8'); }
  catch (e) { throw new CliError(2, e && e.code === 'ENOENT' ? 'not_found' : 'read_error', { path: hostPath, errno: e && e.code }); }

  let envelope;
  try { envelope = JSON.parse(envText); }
  catch { throw new CliError(3, 'invalid_json', { path: envPath }); }

  let inlineDoc;
  try { inlineDoc = extractInlineDoc(hostBytes); }
  catch { throw new CliError(2, 'not_a_rewritable', { path: hostPath }); }

  // Kind gate — only a skill-host carries the frozen skill zone (mirror of detectProductKind).
  const km = hostBytes.match(/const PRODUCT_KIND = '([^']*)';/);
  const kind = km ? km[1] : null;
  if (kind !== 'skill-host') throw new CliError(2, 'wrong_kind', { kind, expected: 'skill-host' });

  const { newDoc, changed, result } = installEnvelopeIntoDoc(inlineDoc, envelope, { consent });
  if (changed) {
    await atomicWrite(hostPath, replaceInlineDoc(hostBytes, newDoc));
    // Durability re-parse — the bytes on disk must contain the verified skill (Rule 12).
    let reread;
    try { reread = await readFile(hostPath, 'utf8'); }
    catch (e) { throw new CliError(2, 'install_not_durable', { skillId: result.skillId, message: e && e.message }); }
    if (!parseSkillZone(extractInlineDoc(reread)).some((p) => p.skillId === result.skillId)) {
      throw new CliError(2, 'install_not_durable', { skillId: result.skillId });
    }
  }
  return result;
}
