#!/usr/bin/env node
// tools/self-description.mjs — reference implementation of the `self-description/1`
// contract (docs/specs/rwa-self-description-spec.md).
//
// Computes the STATIC projection of a rewritable's self-description from its file
// text (no JS executed), and validates any self-description object against the
// schema. The runtime producer (`runtime.describe()`) and the CLI consumer
// (`rwa doc`) both check their output against this one implementation so the two
// surfaces cannot drift (§7, SD-01..05).
//
// Usage:
//   node tools/self-description.mjs --check <file.html>   # print + validate, exit 0/1
//   import { computeSelfDescription, validateSelfDescription, KIND_AFFORDANCES }

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extractInlineDoc } from '../cli/src/seed.mjs';
import { findFrozenZones } from '../cli/src/apply-edits.mjs';

// kind -> affordance bundle (spec §4): the read-time face of the design doc's
// type manifest. SINGLE SOURCE — the CLI mirrors this (keep in step, like the
// UUID_RE / PRODUCT_KIND_RE mirrors across seed.mjs / doc.mjs / rwa.mjs).
export const KIND_AFFORDANCES = {
  document: [],
  presentation: ['view'],
  workflow: [],
  // illustrative / reserved — not yet shipping as registered providers:
  datatable: ['view', 'edit-surface', 'tool', 'compute'],
  application: ['view', 'edit-surface', 'tool'],
};

export const AFFORDANCE_KINDS = ['view', 'edit-surface', 'tool', 'compute', 'hook'];
export const PROVENANCES = ['first-party', 'installed'];
export const SCHEMA_TAG = 'self-description/1';

// Mirror of cli/src/doc.mjs UUID_RE / PRODUCT_KIND_RE (themselves mirrors of
// seed.mjs). Keep in step.
const UUID_RE = /const DOC_UUID = '([0-9a-f-]{36})';/;
const PRODUCT_KIND_RE = /const PRODUCT_KIND = '([^']*)';/;

/**
 * Compute the STATIC self-description projection (spec §3) from a rewritable's
 * file text. No `live` block. `provenance` is always `"first-party"` for a
 * statically-read file (installed providers live in IDB, not the file — §6).
 *
 * @param {string} fileText — full .html source of the container
 * @returns {{ rwa: string, uuid: string|null, kind: string, affordances: string[],
 *            provenance: string, frozenZones: string[] }}
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
  // Affordances are DERIVED from kind (§4), never stamped (§5). Unknown kinds
  // fall back to [] — a container the reader has no manifest for offers no
  // affordances it can vouch for.
  const affordances = (KIND_AFFORDANCES[kind] || []).slice();
  // Computed by scanning the body — same call cli/src/doc.mjs makes, so the
  // static and CLI frozenZones agree by construction (SD-04).
  const frozenZones = findFrozenZones(doc).map(z => z.name);
  return {
    rwa: SCHEMA_TAG,
    uuid,
    kind,
    affordances,
    provenance: 'first-party',
    frozenZones,
  };
}

/**
 * Validate a self-description object against the §2 schema. Works on both the
 * static projection and a runtime projection (a `live` block is permitted).
 *
 * @param {any} obj
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateSelfDescription(obj) {
  const errors = [];
  const isStrArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: false, errors: ['not an object'] };
  }
  if (obj.rwa !== SCHEMA_TAG) errors.push(`rwa must be "${SCHEMA_TAG}" (got ${JSON.stringify(obj.rwa)})`);
  if (!('uuid' in obj) || (obj.uuid !== null && typeof obj.uuid !== 'string')) {
    errors.push('uuid must be a string or null');
  }
  if (typeof obj.kind !== 'string' || obj.kind.length === 0) errors.push('kind must be a non-empty string');
  if (!isStrArray(obj.affordances)) {
    errors.push('affordances must be an array of strings');
  } else {
    const bad = obj.affordances.filter((a) => !AFFORDANCE_KINDS.includes(a));
    if (bad.length) errors.push(`affordances has unknown kinds: ${bad.join(', ')}`);
  }
  if (!PROVENANCES.includes(obj.provenance)) {
    errors.push(`provenance must be one of ${PROVENANCES.join(' | ')} (got ${JSON.stringify(obj.provenance)})`);
  }
  if (!isStrArray(obj.frozenZones)) errors.push('frozenZones must be an array of strings');

  // Optional fields, validated only when present.
  if ('tools' in obj && !isStrArray(obj.tools)) errors.push('tools, if present, must be an array of strings');
  if ('stores' in obj && !isStrArray(obj.stores)) errors.push('stores, if present, must be an array of strings');
  if ('title' in obj && typeof obj.title !== 'string') errors.push('title, if present, must be a string');
  if ('live' in obj && (obj.live === null || typeof obj.live !== 'object' || Array.isArray(obj.live))) {
    errors.push('live, if present, must be an object');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Cross-check that a first-party container's declared affordances match the
 * kind→affordances table (SD-03). For statically-read files this is tautological
 * (compute uses the table); it earns its keep against a RUNTIME projection whose
 * affordances came from the live `providers` registry.
 *
 * @param {{ kind: string, affordances: string[], provenance: string }} obj
 * @returns {{ ok: boolean, expected: string[]|null, got: string[] }}
 */
export function checkAffordanceAgreement(obj) {
  const got = Array.isArray(obj.affordances) ? obj.affordances.slice().sort() : [];
  if (obj.provenance !== 'first-party') return { ok: true, expected: null, got }; // installed: not kind-derivable
  const table = KIND_AFFORDANCES[obj.kind];
  if (!table) return { ok: true, expected: null, got }; // unknown kind: nothing to check against
  const expected = table.slice().sort();
  const ok = expected.length === got.length && expected.every((v, i) => v === got[i]);
  return { ok, expected, got };
}

async function main(argv) {
  const checkIdx = argv.indexOf('--check');
  if (checkIdx === -1 || !argv[checkIdx + 1]) {
    process.stderr.write('usage: node tools/self-description.mjs --check <file.html>\n');
    return 2;
  }
  const file = argv[checkIdx + 1];
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    process.stderr.write(`cannot read ${file}: ${e && e.message}\n`);
    return 2;
  }
  let sd;
  try {
    sd = computeSelfDescription(text);
  } catch (e) {
    process.stderr.write(`${file}: ${e && e.code === 'not_a_rewritable' ? 'not a rewritable' : (e && e.message)}\n`);
    return 1;
  }
  const { valid, errors } = validateSelfDescription(sd);
  const agree = checkAffordanceAgreement(sd);
  process.stdout.write(JSON.stringify(sd, null, 2) + '\n');
  if (!valid) {
    process.stderr.write('INVALID:\n' + errors.map((e) => '  - ' + e).join('\n') + '\n');
    return 1;
  }
  if (!agree.ok) {
    process.stderr.write(`AFFORDANCE MISMATCH: kind=${sd.kind} expected [${agree.expected}] got [${agree.got}]\n`);
    return 1;
  }
  process.stderr.write(`OK: ${sd.kind} · affordances=[${sd.affordances}] · ${sd.frozenZones.length} frozen zone(s)\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
