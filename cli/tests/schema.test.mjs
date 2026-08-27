// `rwa schema` and the agent banner (#40) — making the format discoverable.
//
// The envelope grammar is the one thing a capable agent needs in order to emit a
// plan itself rather than paying for a second model call. It lived only in a
// 711-line spec the agent has no reason to know exists, and not in `--help`. So
// the fast path was undiscoverable and the slow path was the only one anybody
// could find.
//
// The point of these tests is that `rwa schema` cannot DRIFT. It reads the
// seed's own `TOOL_SCHEMAS` — the exact schemas handed to the model on every
// call — so there is no second copy to fall out of step with the tools. A test
// that merely checked "the output mentions apply_edits" would pass forever while
// the real contract moved underneath it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSchema } from '../src/schema.mjs';
import { loadSeed } from '../src/seed.mjs';
import { extractFromSeed } from '../src/seed-extract.mjs';
import { FAILURE_HINTS } from '../src/apply-edits.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RWA_BIN = join(__dirname, '..', 'bin', 'rwa.mjs');
const SEED = join(__dirname, '..', '..', 'seeds', 'rewritable.html');
const SEEDS = [SEED];
const run = (args) => spawnSync('node', [RWA_BIN, ...args], { encoding: 'utf8', input: '' });

test('#40: the emitted tool schemas ARE the seed schemas, byte-for-byte', async () => {
  // The anti-drift property, asserted directly rather than by proxy. If someone
  // changes a tool's schema in the seed, this stays true automatically; if
  // someone hand-copies a schema into schema.mjs, it breaks.
  const { TOOL_SCHEMAS } = extractFromSeed(await loadSeed(SEEDS));
  const s = await buildSchema(SEEDS);
  assert.equal(s.tools.length, 3);
  for (const t of s.tools) {
    const fromSeed = TOOL_SCHEMAS.find(x => x?.function?.name === t.name);
    assert.ok(fromSeed, `${t.name} exists in the seed`);
    assert.deepEqual(t.schema, fromSeed, `${t.name} schema is the seed's, not a copy`);
  }
});

test('#40: every tool the seed defines is reported — none silently dropped', async () => {
  const { TOOL_SCHEMAS } = extractFromSeed(await loadSeed(SEEDS));
  const s = await buildSchema(SEEDS);
  assert.deepEqual(
    s.tools.map(t => t.name).sort(),
    TOOL_SCHEMAS.map(t => t.function.name).sort(),
    'a tool added to the seed must appear here, not fall through the ordering table',
  );
});

test('#40: the wire version strings match what applyPlan enforces', async () => {
  const s = await buildSchema(SEEDS);
  assert.equal(s.wire.apply_edits, 'rwa-edit/1');
  assert.equal(s.wire.apply_dsl_plan, 'rwa-edit-dsl/1');
  assert.equal(s.wire.replace_document, 'rwa-edit/1');
  assert.equal(s.wire.describe, 'self-description/1');
});

test('#40: the failure vocabulary is the real table, not a summary of it', async () => {
  // A caller can read every subcode and its recovery hint UP FRONT rather than
  // discovering the vocabulary one error at a time.
  const s = await buildSchema(SEEDS);
  assert.deepEqual(Object.keys(s.failures).sort(), Object.keys(FAILURE_HINTS).sort());
  assert.equal(s.failures.find_not_found, FAILURE_HINTS.find_not_found);
});

test('#40: the exit-code table covers every code the CLI can actually return', async () => {
  const s = await buildSchema(SEEDS);
  const bin = readFileSync(RWA_BIN, 'utf8');
  const fn = /function codeName\(n\) \{[\s\S]*?\n\}/.exec(bin)[0];
  for (const m of fn.matchAll(/case\s+(\d+):/g)) {
    assert.ok(s.exitCodes[m[1]], `exit ${m[1]} is documented in rwa schema`);
  }
});

test('#40: --json is machine-readable and plain mode is short', () => {
  const j = run(['schema', '--json']);
  assert.equal(j.status, 0);
  const parsed = JSON.parse(j.stdout);
  assert.equal(parsed.rwa, 'rwa-schema/1');
  assert.ok(parsed.tools[0].schema.function.parameters, 'the JSON Schema itself is present');

  const plain = run(['schema']);
  assert.equal(plain.status, 0);
  assert.ok(plain.stdout.split('\n').length < 40, 'plain mode stays scannable');
  assert.match(plain.stdout, /apply_edits/);
  assert.match(plain.stdout, /--base-hash/, 'the staleness token is advertised where an agent will look');
});

test('#40: the seed carries an agent banner in its first lines', () => {
  // An agent reaching for a generic Read tool sees the head first. Before this,
  // line 5 opened a twelve-line essay about worker-scoped CSP.
  const head = readFileSync(SEED, 'utf8').split('\n').slice(0, 25).join('\n');
  assert.match(head, /FOR AGENTS AND TOOLS/);
  assert.match(head, /rwa doc/, 'it names the read door');
  assert.match(head, /rwa edit/, 'and the write door');
  assert.match(head, /rwa schema/, 'and where the grammar is');
  assert.match(head, /INLINE_DOC/, 'and what the document actually is');
  assert.match(head, /[Dd]o NOT hand-edit/, 'and the hazard');
});

test('#40: the banner reaches an emitted container, not just the seed', () => {
  // The seed is the source; what matters is that a file a user actually holds
  // carries it. `rwa new` goes through applySeedSubs, which is where a
  // mis-scoped substitution would eat it.
  const dir = mkdtempSync(join(tmpdir(), 'rwa-banner-'));
  const out = join(dir, 'x.html');
  try {
    assert.equal(run(['new', out]).status, 0);
    const head = readFileSync(out, 'utf8').split('\n').slice(0, 25).join('\n');
    assert.match(head, /FOR AGENTS AND TOOLS/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#40: AGENTS.md exists and points at the doors that exist', () => {
  // A stale entry point is worse than none: it teaches a verb that is not there.
  const md = readFileSync(join(__dirname, '..', '..', 'AGENTS.md'), 'utf8');
  const helpText = run(['--help']).stdout;
  for (const verb of ['doc', 'edit', 'doctor', 'render', 'log', 'schema', 'new', 'import']) {
    assert.match(md, new RegExp('rwa ' + verb + '\\b'), `AGENTS.md mentions rwa ${verb}`);
    assert.match(helpText, new RegExp('rwa ' + verb + '\\b'), `and rwa ${verb} really exists`);
  }
  for (const flag of ['--outline', '--block', '--base-hash', '--virtual', '--actor']) {
    assert.match(md, new RegExp(flag.replace(/-/g, '\\-')), `AGENTS.md mentions ${flag}`);
    assert.match(helpText, new RegExp(flag.replace(/-/g, '\\-')), `and ${flag} really exists`);
  }
});
