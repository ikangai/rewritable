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

export const SCHEMA_TAG = 'self-description/1';

// kind -> registered provider bundle (spec §4). Each provider is {kind,name,label};
// `provenance:'first-party'` is added per emit (bootstrap-resident providers).
// The presentation entry mirrors the seed presentationProvider {name:'presentation',
// label:'Present'} (seeds/rewritable.html:3542-3543) so static == live by construction.
export const KIND_PROVIDERS = {
  document: [],
  presentation: [{ kind: 'view', name: 'presentation', label: 'Present' }],
  workflow: [],
  // illustrative / reserved — not yet shipping as registered providers:
  datatable: [
    { kind: 'view', name: 'grid', label: 'Grid' },
    { kind: 'edit-surface', name: 'cell', label: 'Edit cells' },
    { kind: 'tool', name: 'derive', label: 'Derive column' },
    { kind: 'compute', name: 'recalc', label: 'Recompute' },
  ],
  application: [
    { kind: 'view', name: 'app', label: 'App' },
    { kind: 'edit-surface', name: 'form', label: 'Edit' },
    { kind: 'tool', name: 'command', label: 'Run command' },
  ],
};

// Substrate-universal ops — the SAME for every container regardless of kind. The
// "what can be done with me" data that is NOT an affordance (affordances stay
// kernel-pure: a base document is []). `history` is undo-only — there is no redo
// (re-write-able-spec Invariant 7).
export const SUBSTRATE_BASELINE = Object.freeze({
  edit: ['lens'],
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
  const affordances = (KIND_PROVIDERS[kind] || []).map((p) => ({ ...p, provenance: 'first-party' }));
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
