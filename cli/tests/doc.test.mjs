// Tests for the `rwa doc` CLI verb — the READ counterpart to `rwa edit`.
//
// Why this verb exists: the CLI can already WRITE a rewritable (`rwa edit`),
// but until now had no way to READ its editable body. An agent handed a
// `foo.html` had to parse ~4000 lines of bootstrap HTML to find the document
// it is allowed to edit. `rwa doc` closes that asymmetry: it prints the exact
// LF-canonical text the rwa-edit contract operates on, and `--json` returns
// the full editing contract (uuid, kind, frozen zones, length, doc) in one
// call. These tests pin the contract an agent relies on, not just the bytes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replaceInlineDoc, extractInlineDoc } from '../src/seed.mjs';
import { computeSelfDescription, validateSelfDescription, checkAffordanceAgreement, declarationFacts } from '../../tools/self-description.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RWA_BIN = join(__dirname, '..', 'bin', 'rwa.mjs');

function runRwa(args, { stdin = null } = {}) {
  return new Promise(resolve => {
    const child = spawn('node', [RWA_BIN, ...args]);
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    if (stdin !== null) { child.stdin.write(stdin); child.stdin.end(); } else { child.stdin.end(); }
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

// Build a real rewritable fixture with a caller-supplied INLINE_DOC body, the
// same way edit-plan.test.mjs does: `rwa new` lays down a valid bootstrap,
// then replaceInlineDoc swaps in the known body via the production splice.
function mkFixture(inlineDocBody = '<article><h1>Hello</h1><p>Body.</p></article>', { kind } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-doc-test-'));
  const path = join(dir, 'test.html');
  const newArgs = [RWA_BIN, 'new', path];
  if (kind) newArgs.push('--kind', kind);
  execFileSync('node', newArgs, { stdio: 'pipe' });
  if (inlineDocBody !== null) {
    const current = readFileSync(path, 'utf8');
    writeFileSync(path, replaceInlineDoc(current, inlineDocBody), 'utf8');
  }
  return { path, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ─── Plain mode: the exact editable body ──────────────────────────────

test('plain mode prints the document body an agent would edit', async () => {
  const body = '<article><h1>Quarterly Report</h1><p>Revenue up 12%.</p></article>';
  const fx = mkFixture(body);
  try {
    const { code, stdout } = await runRwa(['doc', fx.path]);
    assert.equal(code, 0);
    // The body must be present verbatim. Why: an agent computes find-anchors
    // against this text; if it differs from what `rwa edit` sees, every
    // apply_edits will fail find_not_found.
    const expected = extractInlineDoc(readFileSync(fx.path, 'utf8'));
    assert.equal(expected, body); // sanity: fixture round-trips
    // Plain mode is terminal/pipe friendly: the body, with at most one trailing
    // newline added for readability. Stripping a single trailing newline must
    // recover the exact body.
    assert.ok(stdout === body || stdout === body + '\n',
      `stdout should be the body (± one trailing newline); got: ${JSON.stringify(stdout)}`);
  } finally { fx.cleanup(); }
});

test('plain mode matches extractInlineDoc byte-for-byte (± trailing newline)', async () => {
  // Why: `rwa doc` is the read side of the SAME view of the document that
  // `rwa edit` writes. The two must agree, or anchors won't round-trip.
  const fx = mkFixture('<article><h1>Anchor Fidelity</h1>\n<p>Line with\ttab.</p></article>');
  try {
    const { stdout } = await runRwa(['doc', fx.path]);
    const body = extractInlineDoc(readFileSync(fx.path, 'utf8'));
    assert.equal(stdout.replace(/\n$/, ''), body.replace(/\n$/, ''));
  } finally { fx.cleanup(); }
});

test('plain mode writes nothing to stderr on success', async () => {
  // Why: agents pipe `rwa doc f | ...`; diagnostics on the success path would
  // be noise. stdout is the document, stderr is silent.
  const fx = mkFixture();
  try {
    const { code, stderr } = await runRwa(['doc', fx.path]);
    assert.equal(code, 0);
    assert.equal(stderr, '');
  } finally { fx.cleanup(); }
});

// ─── JSON mode: the full editing contract in one call ─────────────────

test('--json returns the editing contract {rewritable,uuid,kind,frozenZones,length,doc}', async () => {
  const body = '<article><h1>Contract</h1><p>One call, everything.</p></article>';
  const fx = mkFixture(body);
  try {
    const { code, stdout, stderr } = await runRwa(['doc', fx.path, '--json']);
    assert.equal(code, 0);
    assert.equal(stderr, '');
    const parsed = JSON.parse(stdout);
    // `rewritable:true` is the explicit "yes, this is a rewritable" marker so
    // an agent can branch on a parsed field, not just an exit code.
    assert.equal(parsed.rewritable, true);
    // doc is the byte-exact editable body (no newline munging — JSON is the
    // faithful machine path; plain mode is the human path).
    assert.equal(parsed.doc, body);
    // length is the char length of the doc, so an agent can sanity-check size
    // without re-measuring.
    assert.equal(parsed.length, body.length);
    // uuid is the container's DOC_UUID (lets an agent correlate edits/history).
    assert.match(parsed.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // kind selects the editing framing; default container is 'document'.
    assert.equal(parsed.kind, 'document');
    // frozenZones is always an array (empty here) — an agent must always be
    // able to read it without a null check.
    assert.ok(Array.isArray(parsed.frozenZones));
    assert.equal(parsed.frozenZones.length, 0);
  } finally { fx.cleanup(); }
});

test('--json lists marker-form frozen zones the agent must not touch', async () => {
  // Why: frozen zones are author-declared invariants; an edit that crosses one
  // is rejected (frozen_zone_violation). Surfacing the names lets the agent
  // steer clear up front instead of failing and retrying.
  const body = [
    '<article><h1>Doc</h1>',
    '<!-- rwa:frozen:begin signature -->',
    '<p>© 2026 — do not alter</p>',
    '<!-- rwa:frozen:end signature -->',
    '<p>Editable.</p></article>',
  ].join('\n');
  const fx = mkFixture(body);
  try {
    const { code, stdout } = await runRwa(['doc', fx.path, '--json']);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.deepEqual(parsed.frozenZones, ['signature']);
  } finally { fx.cleanup(); }
});

test('--json kind reflects the container PRODUCT_KIND', async () => {
  // Why: a presentation edits differently than a prose doc; the agent needs
  // the kind to pick the right system framing. `rwa new --kind presentation`
  // bakes PRODUCT_KIND='presentation'; `rwa doc --json` must read it back.
  const fx = mkFixture(null, { kind: 'presentation' });
  try {
    const { code, stdout } = await runRwa(['doc', fx.path, '--json']);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.kind, 'presentation');
  } finally { fx.cleanup(); }
});

// ─── Self-description: "what is this, what can be done with it" ───────
// Why: the read contract should let an agent answer identity + affordances in
// the same call, not just "give me the body". `rwa doc --json` emits the static
// self-description/1 projection as a superset of the edit contract. The proof
// that consumer == contract is to run the SAME bytes through the reference
// oracle (tools/self-description.mjs) and demand field-for-field agreement —
// the same tiebreaker the wave agreed on. This test fails loudly if the CLI
// ever drifts from the committed contract.

const SELF_KEYS = ['rwa', 'source', 'uuid', 'kind', 'title', 'blocks', 'affordances', 'frozenZones', 'baseline'];

for (const [label, mk] of [
  ['document', () => mkFixture('<article><h1>Quarterly Report</h1><p data-rwa-id="ab12cd34">Revenue up 12%.</p></article>')],
  ['presentation', () => mkFixture(null, { kind: 'presentation' })],
]) {
  test(`--json self-description matches the reference oracle for a ${label}`, async () => {
    const fx = mk();
    try {
      const { code, stdout } = await runRwa(['doc', fx.path, '--json']);
      assert.equal(code, 0);
      const payload = JSON.parse(stdout);
      const ref = computeSelfDescription(readFileSync(fx.path, 'utf8'));
      // Every self-description field the CLI emits equals the reference's.
      for (const k of SELF_KEYS) {
        assert.deepEqual(payload[k], ref[k], `field "${k}" diverged from the reference oracle`);
      }
      // The payload itself validates as a self-description/1 (extras ignored),
      // and the first-party affordances agree with the kind→providers table.
      const { valid, errors } = validateSelfDescription(payload);
      assert.ok(valid, `payload should validate; errors: ${errors.join('; ')}`);
      assert.ok(checkAffordanceAgreement(payload).ok, 'affordances must match the kind bundle');
    } finally { fx.cleanup(); }
  });
}

test('--json stays a superset: the edit-contract fields ride alongside the self-description', async () => {
  // Why: the identity surface is additive — agents that only read the body must
  // be unaffected. doc/length/rewritable remain exactly as before.
  const body = '<article><h1>Contract</h1><p>One call, everything.</p></article>';
  const fx = mkFixture(body);
  try {
    const { stdout } = await runRwa(['doc', fx.path, '--json']);
    const p = JSON.parse(stdout);
    assert.equal(p.rewritable, true);
    assert.equal(p.doc, body);
    assert.equal(p.length, body.length);
    assert.equal(p.source, 'static');
    assert.deepEqual(p.affordances, []);            // base document
    assert.equal(p.title, 'Contract');
    assert.deepEqual(p.baseline.history, ['undo']); // undo-only — never advertise redo
  } finally { fx.cleanup(); }
});

// ─── Declared projection: honest affordances for custom files (v1.1) ──
// When a real container carries a trustworthy embedded #rwa-affordances
// declaration, `rwa doc` must prefer it (source:'declared') over the kind guess —
// so a datatable reports its REAL affordances, not the placeholder. Tested on
// real containers (rwa new + replaceInlineDoc), where the declaration's
// </script> is escaped in the bytes and recovered from INLINE_DOC — the path
// the oracle and the CLI must agree on.

const ALIGNED_DECL_JSON = JSON.stringify({
  rwa: 'self-description/1', source: 'declared', kind: 'datatable', title: 'Q1 Budget', data: '#dt-data',
  affordances: [
    { kind: 'view', name: 'grid', label: 'Grid', provenance: 'first-party' },
    { kind: 'view', name: 'summary', label: 'Summary', provenance: 'first-party' },
    { kind: 'edit-surface', name: 'cell', label: 'Edit cells', provenance: 'first-party', surface: 'datatable:cell-edit', target: '#dt-data' },
    { kind: 'compute', name: 'total', label: 'Total', provenance: 'first-party', inputs: ['qty', 'unit_price'], output: 'total' },
  ],
  baseline: { edit: ['lens'], tools: ['apply_dsl_plan', 'apply_edits', 'replace_document'], export: ['html', 'print'], history: ['undo'] },
});
const declBody = (frozen) =>
  `<article><h1>Budget</h1>\n<script type="application/rwa-affordances+json" id="rwa-affordances"${frozen ? ' data-rwa-frozen' : ''}>${ALIGNED_DECL_JSON}</script>\n<div id="dt-data">[]</div></article>`;

test('--json prefers a trustworthy (frozen) declaration: source:declared, real affordances', async () => {
  const fx = mkFixture(declBody(true));
  try {
    const { code, stdout } = await runRwa(['doc', fx.path, '--json']);
    assert.equal(code, 0);
    const p = JSON.parse(stdout);
    assert.equal(p.source, 'declared');
    assert.equal(p.kind, 'datatable'); // the declaration's kind overrides PRODUCT_KIND='document'
    assert.deepEqual(p.affordances.map(a => a.kind), ['view', 'view', 'edit-surface', 'compute']);
    // uuid is the CONTAINER's DOC_UUID (a fact), not anything the author claimed.
    assert.match(p.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // The whole payload still validates as self-description/1 against the oracle.
    const { valid, errors } = validateSelfDescription(p);
    assert.ok(valid, `declared payload must validate; errors: ${errors.join('; ')}`);
    // And the oracle agrees the declaration is found + frozen-trustworthy.
    const f = declarationFacts(readFileSync(fx.path, 'utf8'));
    assert.deepEqual(f, { found: true, inEditableBody: true, frozenAttr: true });
  } finally { fx.cleanup(); }
});

test('--json does NOT trust an unfrozen body declaration: falls back to source:static', async () => {
  const fx = mkFixture(declBody(false));
  try {
    const { stdout } = await runRwa(['doc', fx.path, '--json']);
    const p = JSON.parse(stdout);
    assert.equal(p.source, 'static'); // edit-reachable claim is not trusted
    // PRODUCT_KIND is 'document' (rwa new default), so the static answer is a base doc.
    assert.equal(p.kind, 'document');
    assert.deepEqual(p.affordances, []);
    assert.ok(validateSelfDescription(p).valid);
  } finally { fx.cleanup(); }
});

// ─── Error surface (mirrors `rwa edit` file_error codes) ──────────────

test('exit 2 not_found — missing file', async () => {
  const { code, stdout, stderr } = await runRwa(['doc', '/tmp/does-not-exist-rwa.html']);
  assert.equal(code, 2);
  assert.match(stderr, /not_found/);
  // Why: stdout must stay empty on error so a downstream pipe never mistakes
  // an error message for document content.
  assert.equal(stdout, '');
});

test('exit 2 not_a_rewritable — a non-rewritable file', async () => {
  // Why: this gives agents a deterministic "is this a rewritable?" probe — a
  // clean non-zero exit, empty stdout — without false-positive content.
  const dir = mkdtempSync(join(tmpdir(), 'rwa-doc-test-'));
  const path = join(dir, 'plain.html');
  writeFileSync(path, '<!doctype html><html><body><p>just a page</p></body></html>', 'utf8');
  try {
    const { code, stdout, stderr } = await runRwa(['doc', path]);
    assert.equal(code, 2);
    assert.match(stderr, /not_a_rewritable/);
    assert.equal(stdout, '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('exit 1 missing_file_arg — no path given', async () => {
  const { code, stderr } = await runRwa(['doc']);
  assert.equal(code, 1);
  assert.match(stderr, /missing_file_arg/);
});

test('--json error is structured JSON on stderr (not stdout)', async () => {
  // Why: agents that run `rwa doc f --json` parse stdout for the contract;
  // when the call fails they parse stderr for {code,subcode}. Mirrors the
  // `rwa edit --json` failure surface so callers handle both verbs uniformly.
  const { code, stdout, stderr } = await runRwa(['doc', '/tmp/nope-rwa.html', '--json']);
  assert.equal(code, 2);
  assert.equal(stdout, '');
  const payload = JSON.parse(stderr.trim());
  assert.equal(payload.code, 'file_error');
  assert.equal(payload.subcode, 'not_found');
} );
