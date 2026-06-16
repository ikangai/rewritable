#!/usr/bin/env node
// tools/self-description.mjs — reference implementation of the `self-description/1`
// contract (docs/specs/rwa-self-description-spec.md).
//
// Computes the STATIC projection of a rewritable's self-description from its file
// text (no JS executed), and validates any self-description object (static OR
// live) against the schema. The runtime producer (`runtime.describe()`) and the
// CLI consumer (`rwa doc`) both check their output against this one
// implementation so the two surfaces cannot drift (§7, SD-01..07).
//
// Usage:
//   node tools/self-description.mjs --check <file.html>   # compute static + validate, exit 0/1
//   node tools/self-description.mjs --validate <obj.json> # validate a static|live object, exit 0/1
//   import { computeSelfDescription, validateSelfDescription, KIND_PROVIDERS, ... }

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extractInlineDoc } from '../cli/src/seed.mjs';
import { findFrozenZones, tagHasFrozenAttr } from '../cli/src/apply-edits.mjs';
import { parseSkillZone } from '../cli/src/skill-manifest.mjs';

export const SCHEMA_TAG = 'self-description/1';
export const AFFORDANCE_KINDS = ['view', 'edit-surface', 'tool', 'compute', 'hook'];
export const PROVENANCES = ['first-party', 'installed'];
export const SOURCES = ['static', 'live', 'declared'];

// kind -> registered provider bundle (spec §4): the read-time face of the design
// doc's type manifest. Each provider is {kind, name, label}; `provenance` is
// added per emit (always 'first-party' for bootstrap-resident providers). SINGLE
// SOURCE — the seed runtime and the CLI mirror this (keep in step). The
// presentation entry mirrors seed presentationProvider {name:'presentation',
// label:'Present'} (seeds/rewritable.html:3542-3543) so static == live by
// construction.
export const KIND_PROVIDERS = {
  // ONLY kinds the runtime FIRST-PARTY-provides, so the static kind→affordances
  // guess is honest. CUSTOM kinds (datatable, application, …) are consumer-built
  // via runtime.provide() / the #rwa-affordances declaration — NOT first-party,
  // so the static tier cannot honestly guess them (the real datatable proved an
  // illustrative guess WRONG: 2 views + edit-surface + compute, no tool). For a
  // custom kind, computeSelfDescription returns [] (honest "I don't know"); the
  // LIVE registry or a trustworthy `declared` projection carries the real answer
  // (precedence declared > live > static, spec §3.1 — don't trade a guess for a lie).
  document: [],
  presentation: [{ kind: 'view', name: 'presentation', label: 'Present' }],
  workflow: [],
  // A skill-host has NO first-party affordances; everything it offers is an
  // INSTALLED skill (provenance:'installed'), emitted by parseSkillZone (§8) from
  // the frozen #rwa-skills zone, not from this table. Explicit [] (not the ||[]
  // fallback) so a missing kind is still distinguishable from "no providers".
  workspace: [],
  'skill-host': [],
};

// Substrate-universal ops — the SAME for every container regardless of kind
// (spec §2 "Substrate-universal capabilities are not affordances"). This is the
// home for the "what can be done with me" data without polluting `affordances`
// (which stays kernel-pure: a base document is []). `history` is undo-only —
// there is no redo (re-write-able-spec Invariant 7). Static and live emit this
// block identically (it is constant), so they agree trivially.
export const SUBSTRATE_BASELINE = Object.freeze({
  edit: ['lens'],
  tools: ['apply_dsl_plan', 'apply_edits', 'replace_document'],
  export: ['html', 'print'],
  history: ['undo'],
});

// Mirror of cli/src/doc.mjs UUID_RE / PRODUCT_KIND_RE (themselves mirrors of
// seed.mjs). Keep in step.
const UUID_RE = /const DOC_UUID = '([0-9a-f-]{36})';/;
const PRODUCT_KIND_RE = /const PRODUCT_KIND = '([^']*)';/;

/** The affordance KINDS a first-party container of `kind` should register (§4). */
export function affordanceKindsForKind(kind) {
  return (KIND_PROVIDERS[kind] || []).map((p) => p.kind);
}

function staticTitle(doc) {
  const m = doc.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!m) return null;
  const text = m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  return text || null;
}

/**
 * Compute the STATIC self-description projection (spec §3) from a rewritable's
 * file text. `source: 'static'`; no `activeView`; affordances are kind-derived
 * (§4) and all `first-party` (a file on disk holds no installed providers, §6).
 *
 * @param {string} fileText — full .html source of the container
 * @returns {object} a `source:'static'` self-description (spec §2)
 * @throws {Error} 'not_a_rewritable' if the inline document cannot be extracted
 */
export function computeSelfDescription(fileText) {
  let doc;
  try {
    doc = extractInlineDoc(fileText);
  } catch (_e) {
    const err = new Error('not_a_rewritable');
    err.code = 'not_a_rewritable';
    throw err;
  }
  const uuid = (fileText.match(UUID_RE) || [])[1] || null;
  // Unknown/absent kind ⇒ 'document', matching SYSTEM_PROMPTS resolution and
  // cli/src/doc.mjs.
  const kind = (fileText.match(PRODUCT_KIND_RE) || [])[1] || 'document';
  // Affordances are DERIVED from kind (§4), never stamped (§5). Each provider
  // ships first-party. Unknown kinds fall back to [] — a type the reader has no
  // manifest for offers no affordances it can vouch for.
  // First-party (kind-derived) affordances + INSTALLED skills parsed from the
  // frozen #rwa-skills zone (§8). Installed entries carry provenance:'installed'
  // + skillId + verified (re-checked signature), so static == live == CLI.
  const affordances = [
    ...(KIND_PROVIDERS[kind] || []).map((p) => ({ ...p, provenance: 'first-party' })),
    ...parseSkillZone(doc),
  ];
  // frozenZones: same call cli/src/doc.mjs makes, so static and CLI agree (SD-04).
  const frozenZones = findFrozenZones(doc).map((z) => z.name);
  const blocks = (doc.match(/\bdata-rwa-id\b/g) || []).length;
  return {
    rwa: SCHEMA_TAG,
    source: 'static',
    uuid,
    kind,
    title: staticTitle(doc),
    blocks,
    affordances,
    frozenZones,
    baseline: { ...SUBSTRATE_BASELINE },
  };
}

const isStrArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * Validate a self-description object (static or live) against the §2 schema.
 * @param {any} obj
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateSelfDescription(obj) {
  const errors = [];
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: false, errors: ['not an object'] };
  }
  if (obj.rwa !== SCHEMA_TAG) errors.push(`rwa must be "${SCHEMA_TAG}" (got ${JSON.stringify(obj.rwa)})`);
  if (!SOURCES.includes(obj.source)) errors.push(`source must be one of ${SOURCES.join(' | ')}`);
  // A `declared` object is the author's affordance claim; `uuid`/`frozenZones`
  // are CONTAINER facts the reader fills from DOC_UUID / the bytes, so they are
  // optional in a declaration. For static/live (machine-emitted) they're required.
  if (obj.source === 'declared') {
    if ('uuid' in obj && obj.uuid !== null && typeof obj.uuid !== 'string') errors.push('uuid, if present, must be a string or null');
  } else if (!('uuid' in obj) || (obj.uuid !== null && typeof obj.uuid !== 'string')) {
    errors.push('uuid must be a string or null');
  }
  if (typeof obj.kind !== 'string' || obj.kind.length === 0) errors.push('kind must be a non-empty string');
  if ('title' in obj && obj.title !== null && typeof obj.title !== 'string') errors.push('title must be a string or null');
  if ('blocks' in obj && (typeof obj.blocks !== 'number' || !Number.isFinite(obj.blocks))) errors.push('blocks must be a number');

  if (!Array.isArray(obj.affordances)) {
    errors.push('affordances must be an array');
  } else {
    obj.affordances.forEach((a, i) => {
      if (a === null || typeof a !== 'object' || Array.isArray(a)) { errors.push(`affordances[${i}] must be an object`); return; }
      if (!AFFORDANCE_KINDS.includes(a.kind)) errors.push(`affordances[${i}].kind unknown: ${JSON.stringify(a.kind)}`);
      if (typeof a.name !== 'string' || !a.name) errors.push(`affordances[${i}].name must be a non-empty string`);
      if ('label' in a && typeof a.label !== 'string') errors.push(`affordances[${i}].label must be a string`);
      if (!PROVENANCES.includes(a.provenance)) errors.push(`affordances[${i}].provenance must be one of ${PROVENANCES.join(' | ')}`);
      // Optional per-affordance detail (v1.1): edit-surface {surface,target},
      // compute {inputs,output}. `verified` marks a live registry-confirmed
      // affordance vs an author-declared one (the registry∪declaration union).
      if ('surface' in a && typeof a.surface !== 'string') errors.push(`affordances[${i}].surface must be a string`);
      if ('target' in a && typeof a.target !== 'string') errors.push(`affordances[${i}].target must be a string`);
      if ('output' in a && typeof a.output !== 'string') errors.push(`affordances[${i}].output must be a string`);
      if ('inputs' in a && !isStrArray(a.inputs)) errors.push(`affordances[${i}].inputs must be an array of strings`);
      if ('verified' in a && typeof a.verified !== 'boolean') errors.push(`affordances[${i}].verified must be a boolean`);
    });
  }
  if ('data' in obj && obj.data !== null && typeof obj.data !== 'string') errors.push('data must be a string or null (a selector/pointer to the file\'s data element)');

  if ('frozenZones' in obj) {
    if (!isStrArray(obj.frozenZones)) errors.push('frozenZones must be an array of strings');
  } else if (obj.source !== 'declared') {
    errors.push('frozenZones must be an array of strings');
  }

  if ('baseline' in obj) {
    const b = obj.baseline;
    if (b === null || typeof b !== 'object' || Array.isArray(b)) {
      errors.push('baseline must be an object');
    } else {
      for (const k of ['edit', 'tools', 'export', 'history', 'view']) {
        if (k in b && !isStrArray(b[k])) errors.push(`baseline.${k}, if present, must be an array of strings`);
      }
      if (Array.isArray(b.history) && b.history.includes('redo')) {
        errors.push('baseline.history must not claim "redo" — the runtime has none (Invariant 7)');
      }
    }
  }

  // Live-only fields must not appear in a static projection (SD-05).
  if (obj.source === 'static' && 'activeView' in obj) {
    errors.push('static projection must omit activeView (it is live-only)');
  }
  if ('activeView' in obj && obj.activeView !== null && typeof obj.activeView !== 'string') {
    errors.push('activeView must be a string or null');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Cross-check that the first-party affordance KINDS match the kind→providers
 * table (SD-03). Installed affordances (not kind-derivable) are ignored. Earns
 * its keep against a LIVE projection whose affordances came from the registry.
 *
 * @param {{ kind: string, affordances: Array<{kind:string, provenance:string}> }} obj
 * @returns {{ ok: boolean, expected: string[]|null, got: string[] }}
 */
export function checkAffordanceAgreement(obj) {
  const got = (Array.isArray(obj.affordances) ? obj.affordances : [])
    .filter((a) => a && a.provenance === 'first-party')
    .map((a) => a.kind)
    .sort();
  const table = KIND_PROVIDERS[obj.kind];
  if (!table) return { ok: true, expected: null, got }; // unknown kind: nothing to check
  const expected = table.map((p) => p.kind).sort();
  // SUBSET, not equality: every NORMATIVE first-party provider must be PRESENT,
  // but a file may REGISTER more than its kind's template (the registry allows
  // provide() on any kind). A missing normative provider (a presentation that
  // lost its view) still fails; an extra registered provider does not.
  const ok = expected.every((k) => got.includes(k));
  return { ok, expected, got };
}

// ── The `declared` projection (v1.1) ──────────────────────────────────────
// A file may carry its own self-description as an inert
// `<script type="application/rwa-affordances+json" id="rwa-affordances">` block.
// This is the author's claim — honest for a custom-affordance file the kind
// table can only guess at, but only TRUSTWORTHY if it is unreachable by the edit
// path (else the lens/agent could have drifted it). The oracle returns FACTS;
// each reader applies trust per its own enforcement capability.

const DECL_RE = /<script\b[^>]*\bid=["']rwa-affordances["'][^>]*>([\s\S]*?)<\/script\s*>/i;

// A declaration in the BODY lives inside INLINE_DOC, where its `</script>` is
// escaped in the raw bytes — so we must search the UNescaped document, not the
// file text. A declaration in immutable chrome (outside INLINE_DOC) is found in
// the raw bytes. Return both so a reader can tell which (edit-reachability).
function declarationLocus(fileText) {
  let body = null;
  try { body = extractInlineDoc(fileText); } catch { /* not a rewritable */ }
  if (body && DECL_RE.test(body)) return { hay: body, inEditableBody: true };
  return { hay: fileText, inEditableBody: false };
}

/**
 * Extract the embedded #rwa-affordances declaration, if any (from the unescaped
 * INLINE_DOC for a body declaration, or the raw bytes for a chrome declaration).
 * @param {string} fileText
 * @returns {{ declaration: object|null, raw: string|null, error: string|null }}
 */
export function parseDeclaration(fileText) {
  const m = declarationLocus(fileText).hay.match(DECL_RE);
  if (!m) return { declaration: null, raw: null, error: null };
  try {
    return { declaration: JSON.parse(m[1]), raw: m[1], error: null };
  } catch (e) {
    return { declaration: null, raw: m[1], error: 'invalid JSON: ' + (e && e.message) };
  }
}

/**
 * Edit-reachability FACTS for the declaration (spec §"declared"). A declaration
 * is trustworthy iff edit-unreachable: `!inEditableBody` (it lives in immutable
 * chrome) OR `frozenAttr` (it carries data-rwa-frozen — enforced by the lens
 * today, by the CLI once attribute-form enforcement lands). `frozenZones` is NOT
 * consulted: it is marker-form only on both surfaces (newton, SD-04), so it never
 * covers an attribute-form declaration. Readers apply policy per capability.
 * @param {string} fileText
 * @returns {{ found: boolean, inEditableBody: boolean, frozenAttr: boolean }}
 */
export function declarationFacts(fileText) {
  const { hay, inEditableBody } = declarationLocus(fileText);
  const m = hay.match(DECL_RE);
  if (!m) return { found: false, inEditableBody: false, frozenAttr: false };
  const openTag = m[0].slice(0, m[0].indexOf('>') + 1);
  // DOM-accurate: data-rwa-frozen must be a real attribute NAME, not a value
  // mention (title="data-rwa-frozen") or a longer name (data-rwa-frozen-note).
  // Mirrors the seed's tagHasFrozenAttr + the CLI enforcement so trust-detection
  // never over-trusts a declaration the lens/agent can actually drift (euler's
  // cross-surface finding; the safeguard "declared only if edit-unreachable").
  return { found: true, inEditableBody, frozenAttr: tagHasFrozenAttr(openTag) };
}

async function main(argv) {
  const checkIdx = argv.indexOf('--check');
  const valIdx = argv.indexOf('--validate');
  if (checkIdx !== -1 && argv[checkIdx + 1]) {
    let text;
    try { text = await readFile(argv[checkIdx + 1], 'utf8'); }
    catch (e) { process.stderr.write(`cannot read ${argv[checkIdx + 1]}: ${e && e.message}\n`); return 2; }
    let sd;
    try { sd = computeSelfDescription(text); }
    catch (e) { process.stderr.write(`${argv[checkIdx + 1]}: ${e && e.code === 'not_a_rewritable' ? 'not a rewritable' : (e && e.message)}\n`); return 1; }
    process.stdout.write(JSON.stringify(sd, null, 2) + '\n');
    const { valid, errors } = validateSelfDescription(sd);
    const agree = checkAffordanceAgreement(sd);
    if (!valid) { process.stderr.write('INVALID:\n' + errors.map((e) => '  - ' + e).join('\n') + '\n'); return 1; }
    if (!agree.ok) { process.stderr.write(`AFFORDANCE MISMATCH: kind=${sd.kind} expected [${agree.expected}] got [${agree.got}]\n`); return 1; }
    process.stderr.write(`OK (${sd.source}): ${sd.kind} · affordances=[${sd.affordances.map((a) => a.kind)}] · ${sd.frozenZones.length} frozen zone(s)\n`);
    return 0;
  }
  if (valIdx !== -1 && argv[valIdx + 1]) {
    let obj;
    try { obj = JSON.parse(await readFile(argv[valIdx + 1], 'utf8')); }
    catch (e) { process.stderr.write(`cannot read/parse ${argv[valIdx + 1]}: ${e && e.message}\n`); return 2; }
    const { valid, errors } = validateSelfDescription(obj);
    const agree = checkAffordanceAgreement(obj);
    if (!valid) { process.stderr.write('INVALID:\n' + errors.map((e) => '  - ' + e).join('\n') + '\n'); return 1; }
    if (!agree.ok) { process.stderr.write(`AFFORDANCE MISMATCH: kind=${obj.kind} expected [${agree.expected}] got [${agree.got}]\n`); return 1; }
    process.stderr.write(`OK (${obj.source}): valid self-description/1\n`);
    return 0;
  }
  process.stderr.write('usage: node tools/self-description.mjs --check <file.html> | --validate <obj.json>\n');
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
