// `rwa schema` — the wire contracts, reachable from the tool (#40).
//
// The envelope grammar is the one thing a capable agent needs in order to skip a
// second model call and emit the plan itself. It lived only in a 711-line spec
// the agent has no reason to know exists, and not in `--help`. So the fast path
// was undiscoverable and the slow path (hand the CLI an instruction and let it
// run its own model) was the only one anybody could find.
//
// ## Why this reads the SEED rather than restating anything
//
// `TOOL_SCHEMAS` in seeds/rewritable.html is not documentation about the
// contract — it IS the contract, the exact JSON Schema handed to the model on
// every call, extracted by `seed-extract.mjs` and used verbatim by the CLI agent
// loop. Emitting that means `rwa schema` cannot drift from what the tools
// actually accept: there is no second copy to fall out of step.
//
// Everything else here is the surface the schemas do NOT describe — which tool
// to reach for, and what the failure codes mean — kept deliberately short.

import { loadSeed } from './seed.mjs';
import { extractFromSeed } from './seed-extract.mjs';
import { FAILURE_HINTS } from './apply-edits.mjs';

/** Exit-code contract, uniform across every operation (rwa-operations-api.md). */
const EXIT_CODES = {
  0: 'success',
  1: 'usage_error — the invocation was wrong (bad flag, missing argument)',
  2: 'file_error — not_found / read_error / not_a_rewritable',
  3: 'envelope_error — the plan was rejected; see `subcode` and `hint`',
  4: 'agent_error — the backend or the agent loop failed',
  5: 'doctor_findings — `rwa doctor` found an error-severity problem',
  6: 'browser_error — no browser available, or it failed to drive (rwa render, rwa run)',
};

const TOOL_ORDER = [
  ['apply_dsl_plan', 'Structural transforms. Compiles deterministically to apply_edits. Prefer it when the change is structural.'],
  ['apply_edits', 'Content transforms: (find, replace) pairs on unique anchors. The default for prose changes.'],
  ['replace_document', 'The escape hatch. Requires a reason, and must preserve every frozen zone byte-identically.'],
];

/**
 * Assemble the contract document.
 *
 * @param {string[]} seedCandidates
 * @returns {Promise<object>} `{version, tools, wire, exitCodes, failures, reading}`
 */
export async function buildSchema(seedCandidates) {
  const { SYSTEM_PROMPTS, TOOL_SCHEMAS } = extractFromSeed(await loadSeed(seedCandidates));
  const byName = new Map((TOOL_SCHEMAS || []).map(t => [t?.function?.name, t]));
  return {
    rwa: 'rwa-schema/1',
    wire: {
      // The three load-bearing version strings (rwa-operations-api.md). An
      // envelope carrying the wrong one is rejected as version_mismatch — the
      // discriminator is the shape, but the version must still agree.
      apply_edits: 'rwa-edit/1',
      apply_dsl_plan: 'rwa-edit-dsl/1',
      replace_document: 'rwa-edit/1',
      describe: 'self-description/1',
    },
    tools: TOOL_ORDER.map(([name, when]) => ({
      name,
      when,
      schema: byName.get(name) || null,
    })).filter(t => t.schema),
    exitCodes: EXIT_CODES,
    // The recovery hints keyed by failure subcode — the same table the CLI
    // attaches to every structured failure, so a caller can pre-read what it
    // will be told rather than discovering the vocabulary one error at a time.
    failures: { ...FAILURE_HINTS },
    kinds: Object.keys(SYSTEM_PROMPTS || {}).sort(),
    reading: {
      body: 'rwa doc <file>',
      outline: 'rwa doc <file> --outline [--preview N]',
      block: 'rwa doc <file> --block <data-rwa-id>',
      contract: 'rwa doc <file> --json',
      staleness: 'the baseHash from any read feeds `rwa edit --base-hash <hex>`',
    },
  };
}

/** Human rendering — short by design; the JSON is the reference. */
export function formatSchema(s) {
  const out = [];
  out.push('rwa wire contracts (' + s.rwa + ')');
  out.push('');
  out.push('TOOLS — in preference order');
  for (const t of s.tools) {
    out.push(`  ${t.name}  [${s.wire[t.name]}]`);
    out.push(`    ${t.when}`);
  }
  out.push('');
  out.push('READING — cheapest first');
  for (const [k, v] of Object.entries(s.reading)) out.push(`  ${k.padEnd(10)} ${v}`);
  out.push('');
  out.push('EXIT CODES');
  for (const [k, v] of Object.entries(s.exitCodes)) out.push(`  ${k}  ${v}`);
  out.push('');
  out.push(`Product kinds: ${s.kinds.join(', ')}`);
  out.push(`Failure subcodes with recovery hints: ${Object.keys(s.failures).length} (see --json)`);
  out.push('');
  out.push('Full JSON Schema for each tool: rwa schema --json');
  return out.join('\n');
}
