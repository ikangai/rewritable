// Consumer-side static self-description for `self-description/1` — the answer to
// "what is this rewritable, and what can be done with it?" computed from the
// file BYTES, without executing the container's JS.
// Contract + reference: docs/specs/rwa-self-description-spec.md,
// tools/self-description.mjs (computeSelfDescription / validateSelfDescription).
//
// This is a PUBLISH-SAFE MIRROR of the reference's static computer. The CLI is a
// standalone npm package and cannot reach repo-root tools/ at runtime, so the
// kind→provider table, the substrate baseline, the title/blocks extraction, and
// the assembled object are duplicated here — the same pattern as
// cli/src/apply-edits.mjs mirroring the seed. The mirror is pinned to the single
// source by tests/identity.test.mjs (KIND_PROVIDERS / SUBSTRATE_BASELINE deep-equal
// the reference; the full assembled object deep-equals computeSelfDescription in
// doc.test.mjs). Drift fails loudly. KEEP IN STEP with tools/self-description.mjs.

import { tagHasFrozenAttr } from './apply-edits.mjs';
import { parseSkillZone, parseAgentZone } from './skill-manifest.mjs';

export const SCHEMA_TAG = 'self-description/1';
// Mirror of tools/self-description.mjs AFFORDANCE_KINDS / PROVENANCES — used by the
// declared-projection conformance gate (declaredIsConforming). Keep in step.
export const AFFORDANCE_KINDS = ['view', 'edit-surface', 'tool', 'compute', 'hook', 'agent'];
export const PROVENANCES = ['first-party', 'installed'];

// kind -> registered provider bundle (spec §4). Each provider is {kind,name,label};
// `provenance:'first-party'` is added per emit (bootstrap-resident providers).
// The presentation entry mirrors the seed presentationProvider {name:'presentation',
// label:'Present'} (seeds/rewritable.html:3542-3543) so static == live by construction.
// ONLY kinds the runtime FIRST-PARTY-provides — custom kinds (datatable, …) are
// consumer-built via provide()/the declaration, so their honest static answer is
// [] (declared > static supplies the real affordances when a declaration exists).
export const KIND_PROVIDERS = {
  document: [],
  presentation: [{ kind: 'view', name: 'presentation', label: 'Present' }],
  workflow: [],
  // skill-host: no first-party affordances; installed skills (provenance:'installed')
  // come from parseSkillZone (§8), not this table. Explicit [] mirrors the oracle.
  workspace: [],
  'skill-host': [],
};

// Substrate-universal ops — the SAME for every container regardless of kind. The
// "what can be done with me" data that is NOT an affordance (affordances stay
// kernel-pure: a base document is []). `history` is undo-only — there is no redo
// (re-write-able-spec Invariant 7).
export const SUBSTRATE_BASELINE = Object.freeze({
  // #41 — mirror of tools/self-description.mjs SUBSTRATE_BASELINE (see there
  // for why `lens` is gone). Deep-equal pinned by cli/tests/identity.test.mjs.
  edit: ['command', 'slash', 'inline', 'selection'],
  tools: ['apply_dsl_plan', 'apply_edits', 'replace_document'],
  export: ['html', 'print'],
  history: ['undo'],
});

/**
 * The document's human-readable title: the text of its first <h1>, or null.
 * Mirrors tools/self-description.mjs `staticTitle` exactly (so titles agree).
 * @param {string} doc — the LF-canonical editable body
 * @returns {string|null}
 */
export function extractTitle(doc) {
  const m = (doc || '').match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!m) return null;
  const text = m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  return text || null;
}

/**
 * Count of data-rwa-id-addressable blocks — a coarse "how structured" signal.
 * @param {string} doc — the LF-canonical editable body
 * @returns {number}
 */
export function countBlocks(doc) {
  return ((doc || '').match(/\bdata-rwa-id\b/g) || []).length;
}

/**
 * Assemble the STATIC self-description projection from a container's already-
 * extracted facts (so inspectDoc parses the file once). Equivalent to the
 * reference `computeSelfDescription(fileText)`, minus the file parsing.
 *
 * @param {{doc:string, uuid:string|null, kind:string, frozenZones:string[]}} facts
 * @returns {object} a `source:'static'` self-description/1 object (spec §2)
 */
export function buildSelfDescription({ doc, uuid, kind, frozenZones }) {
  // First-party (kind-derived) + INSTALLED skills from the frozen #rwa-skills zone
  // (§8). Mirrors tools/self-description.mjs computeSelfDescription exactly.
  const affordances = [
    ...(KIND_PROVIDERS[kind] || []).map((p) => ({ ...p, provenance: 'first-party' })),
    ...parseSkillZone(doc),
    ...parseAgentZone(doc), // I12/SD-04 — installed agents (kind:'agent', name:role)
  ];
  return {
    rwa: SCHEMA_TAG,
    source: 'static',
    uuid,
    kind,
    title: extractTitle(doc),
    blocks: countBlocks(doc),
    affordances,
    frozenZones,
    baseline: { ...SUBSTRATE_BASELINE },
  };
}

// ── The `declared` projection (v1.1, spec §3.1) ───────────────────────────────
// A custom-affordance file (a datatable the kind table can only GUESS for) may
// carry its own answer: an inert `<script id="rwa-affordances">` block with a
// `source:"declared"` self-description. The reader prefers it (declared > static)
// only if it is TRUSTWORTHY — edit-unreachable so the lens/agent can't have
// drifted it. Mirror of tools/self-description.mjs DECL_RE / parseDeclaration /
// declarationFacts (publish-safe; the CLI can't reach repo-root tools/ at runtime).
// The oracle takes only fileText and extractInlineDoc's it; the CLI passes the
// already-extracted `doc` (== extractInlineDoc(fileText)) so the two agree.
// KEEP IN STEP with tools/self-description.mjs.
const DECL_RE = /<script\b[^>]*\bid=["']rwa-affordances["'][^>]*>([\s\S]*?)<\/script\s*>/i;

// A body declaration lives inside INLINE_DOC (its </script> escaped in raw bytes),
// so it is found in `doc`; a chrome declaration (immutable, outside INLINE_DOC) is
// found in the raw file text. Return which, so the reader can judge edit-reachability.
function declarationLocus(fileText, doc) {
  if (doc && DECL_RE.test(doc)) return { hay: doc, inEditableBody: true };
  return { hay: fileText, inEditableBody: false };
}

/**
 * Extract the embedded #rwa-affordances declaration, if any.
 * @returns {{ declaration: object|null, raw: string|null, error: string|null }}
 */
export function parseDeclaration(fileText, doc) {
  const m = declarationLocus(fileText, doc).hay.match(DECL_RE);
  if (!m) return { declaration: null, raw: null, error: null };
  try {
    return { declaration: JSON.parse(m[1]), raw: m[1], error: null };
  } catch (e) {
    return { declaration: null, raw: m[1], error: 'invalid JSON: ' + (e && e.message) };
  }
}

/**
 * Edit-reachability facts for the declaration (spec §3.1). Trustworthy iff
 * `!inEditableBody` (chrome) OR `frozenAttr` (data-rwa-frozen — enforced by the
 * lens, and by the CLI as of attribute-form enforcement). `frozenZones` is NOT
 * consulted (marker-form only, SD-04).
 * @returns {{ found: boolean, inEditableBody: boolean, frozenAttr: boolean }}
 */
export function declarationFacts(fileText, doc) {
  const { hay, inEditableBody } = declarationLocus(fileText, doc);
  const m = hay.match(DECL_RE);
  if (!m) return { found: false, inEditableBody: false, frozenAttr: false };
  const openTag = m[0].slice(0, m[0].indexOf('>') + 1);
  // DOM-accurate: data-rwa-frozen must be a real attribute NAME (not a value-
  // mention / longer name), matching the seed's actual enforcement — else the
  // CLI would over-trust a declaration the lens can still drift (euler #112).
  return { found: true, inEditableBody, frozenAttr: tagHasFrozenAttr(openTag) };
}

export const SOURCES = ['static', 'live', 'declared'];
const isStrArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * Validate a self-description/1 object against the §2/§3.1 schema — a publish-safe
 * MIRROR of tools/self-description.mjs validateSelfDescription, so the reader can
 * guarantee it never emits a non-conforming declared answer without importing
 * repo-root tools/ at runtime. Pinned to the oracle by test (identity.test.mjs).
 * KEEP IN STEP with tools/self-description.mjs.
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateSelfDescription(obj) {
  const errors = [];
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return { valid: false, errors: ['not an object'] };
  if (obj.rwa !== SCHEMA_TAG) errors.push('rwa must be "' + SCHEMA_TAG + '"');
  if (!SOURCES.includes(obj.source)) errors.push('source must be one of ' + SOURCES.join(' | '));
  // uuid/frozenZones are container facts the reader fills, so optional in a declaration.
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
      if (a === null || typeof a !== 'object' || Array.isArray(a)) { errors.push('affordances[' + i + '] must be an object'); return; }
      if (!AFFORDANCE_KINDS.includes(a.kind)) errors.push('affordances[' + i + '].kind unknown');
      if (typeof a.name !== 'string' || !a.name) errors.push('affordances[' + i + '].name must be a non-empty string');
      if ('label' in a && typeof a.label !== 'string') errors.push('affordances[' + i + '].label must be a string');
      if (!PROVENANCES.includes(a.provenance)) errors.push('affordances[' + i + '].provenance must be first-party | installed');
      if ('surface' in a && typeof a.surface !== 'string') errors.push('affordances[' + i + '].surface must be a string');
      if ('target' in a && typeof a.target !== 'string') errors.push('affordances[' + i + '].target must be a string');
      if ('output' in a && typeof a.output !== 'string') errors.push('affordances[' + i + '].output must be a string');
      if ('inputs' in a && !isStrArray(a.inputs)) errors.push('affordances[' + i + '].inputs must be an array of strings');
      if ('verified' in a && typeof a.verified !== 'boolean') errors.push('affordances[' + i + '].verified must be a boolean');
    });
  }
  if ('data' in obj && obj.data !== null && typeof obj.data !== 'string') errors.push('data must be a string or null');
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
        if (k in b && !isStrArray(b[k])) errors.push('baseline.' + k + ', if present, must be an array of strings');
      }
      if (Array.isArray(b.history) && b.history.includes('redo')) errors.push('baseline.history must not claim "redo"');
    }
  }
  if (obj.source === 'static' && 'activeView' in obj) errors.push('static projection must omit activeView');
  if ('activeView' in obj && obj.activeView !== null && typeof obj.activeView !== 'string') errors.push('activeView must be a string or null');
  return { valid: errors.length === 0, errors };
}

/**
 * The reader's one answer (spec §3.1 precedence: declared > static). If the file
 * carries a TRUSTWORTHY (edit-unreachable) declaration that — once the reader
 * fills container facts (uuid/frozenZones/blocks from the bytes, authoritative
 * over any author claim) — VALIDATES, emit it as `source:'declared'`. Otherwise
 * emit the static kind-derived projection. Validating the assembled object before
 * trusting it guarantees the reader never emits a non-conforming answer (a subtly
 * malformed trustworthy declaration safely falls back to static). No `live`
 * registry on the static path, so there is no declared>live>static middle tier.
 *
 * @param {{fileText:string, doc:string, uuid:string|null, kind:string, frozenZones:string[]}} facts
 * @returns {object} a self-description/1 object (`source:'declared'` or `'static'`)
 */
export function resolveSelfDescription({ fileText, doc, uuid, kind, frozenZones }) {
  const f = declarationFacts(fileText, doc);
  if (f.found && (!f.inEditableBody || f.frozenAttr)) {
    const { declaration } = parseDeclaration(fileText, doc);
    if (declaration && typeof declaration === 'object' && !Array.isArray(declaration)) {
      // Fill ONLY container facts (uuid/frozenZones/blocks from the bytes —
      // authoritative over any author claim). Do NOT force rwa/source: the
      // discriminator and source are the author's claim and must already be
      // correct, or the declaration is non-conforming and we must not "repair"
      // it into a trusted answer (e.g. a `schema`-not-`rwa` pre-aligned block).
      // Union installed skills (parseSkillZone) into the declared affordances —
      // the static path does, so dropping them here made declared≠live (SD-04).
      // Declared providers win a (kind,name) collision; mirrors the seed's
      // runtimeDescribe registry→declared→installed precedence.
      const declAff = Array.isArray(declaration.affordances) ? declaration.affordances : [];
      const seen = new Set(declAff.map((a) => a.kind + '\0' + a.name));
      const candidate = {
        ...declaration,
        affordances: [...declAff, ...parseSkillZone(doc).filter((s) => !seen.has(s.kind + '\0' + s.name))],
        uuid,
        frozenZones,
        blocks: countBlocks(doc),
      };
      if (candidate.source === 'declared' && validateSelfDescription(candidate).valid) return candidate;
    }
  }
  return buildSelfDescription({ doc, uuid, kind, frozenZones });
}
