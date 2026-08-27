// `rwa doc --outline` and `--block <id>` (#34) — the partial read.
//
// `rwa doc` took exactly one flag. Whole document or nothing, on every turn, for
// every edit, so the only way to learn what was in a file was to pay for all of
// it. Under the two-agent split the external agent is not supposed to hold the
// body at all — which makes "there is no summary door" the thing that forces it
// to.
//
// The assertion that actually matters is the last one: an agent can compose and
// apply a valid edit having read only the outline and one block. Everything
// above it is the machinery that has to be true for that to work.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyPlan } from '../src/edit.mjs';
import { outlineDoc, readBlock } from '../src/doc.mjs';
import { replaceInlineDoc, extractInlineDoc } from '../src/seed.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RWA_BIN = join(__dirname, '..', 'bin', 'rwa.mjs');

const REPORT = `<article>
<h1>Quarterly Review</h1>
<p>Opening summary of the quarter, written at enough length that the default preview has to truncate it somewhere.</p>
<h2>Revenue</h2>
<p>EMEA grew 14%.</p>
<ul><li>North America flat</li><li>APAC up 9%</li></ul>
<h2>Risks</h2>
<blockquote>Supply chain remains the primary exposure.</blockquote>
<!-- rwa:frozen:begin legal -->
<p>Approved by Finance.</p>
<!-- rwa:frozen:end legal -->
</article>`;

// Long blocks, which is where an outline actually pays: a document of many SHORT
// blocks costs nearly as much to outline as to read, and the tests say so.
const LONG_REPORT = (() => {
  const out = ['<h1>Annual Report</h1>'];
  for (let i = 0; i < 30; i++) {
    out.push(`<h2>Section ${i}</h2>`);
    for (let j = 0; j < 6; j++) {
      out.push(`<p>Finding ${i}.${j}: ${'a sentence of realistic reporting prose. '.repeat(12)}</p>`);
    }
  }
  return `<article>\n${out.join('\n')}\n</article>`;
})();

function mkFixture(body, { commit = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-outline-'));
  const path = join(dir, 'test.html');
  execFileSync('node', [RWA_BIN, 'new', path], { stdio: 'pipe' });
  writeFileSync(path, replaceInlineDoc(readFileSync(path, 'utf8'), body), 'utf8');
  // One committed edit backfills the block ids, which is what gives the outline
  // its names. A fixture left uncommitted is the "no ids yet" case, tested too.
  //
  // The plan goes to a real temp FILE, never `--plan /dev/stdin`. That is what
  // this originally did, and it passes on darwin and fails on Linux with
  // `file_error/plan_read_error … ENXIO`: there `/dev/stdin` is
  // `/proc/self/fd/0`, and opening a pipe through that path is not permitted.
  // Every test in this file goes through this helper, so a single portable
  // assumption took all nine down in CI while the suite stayed green locally —
  // which is also the lesson: running the same COMMANDS as CI is not the same as
  // running on the same OS as CI.
  if (commit) {
    const seedPlan = join(dir, 'fixture-commit.json');
    writeFileSync(seedPlan, JSON.stringify({ version: 'rwa-edit/1', edits: [{ find: '<article>', replace: '<article>' }] }));
    execFileSync('node', [RWA_BIN, 'edit', path, '--plan', seedPlan], { stdio: ['pipe', 'pipe', 'pipe'] });
  }
  return { path, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const run = (args) => spawnSync('node', [RWA_BIN, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const bodyOf = (p) => extractInlineDoc(readFileSync(p, 'utf8'));

// ─── The outline ───────────────────────────────────────────────────────

test('#34: --outline lists every anchorable block with a stable name', async () => {
  const fx = mkFixture(REPORT);
  try {
    const r = await outlineDoc(fx.path);
    assert.equal(r.count, 9, 'h1 + 3 p + 2 li + 2 h2 + blockquote');
    assert.match(r.baseHash, /^[0-9a-f]{64}$/, 'the outline carries the staleness token too');
    assert.deepEqual(r.outline.map(b => b.tag), ['h1', 'p', 'h2', 'p', 'li', 'li', 'h2', 'blockquote', 'p']);
    for (const b of r.outline) {
      assert.equal(typeof b.chars, 'number');
      assert.ok(b.chars > 0);
    }
  } finally { fx.cleanup(); }
});

test('#34: a frozen block is listed and FLAGGED, never hidden', async () => {
  // A gap in the outline the caller cannot explain is worse than a block it is
  // told it may not edit.
  const fx = mkFixture(REPORT);
  try {
    const r = await outlineDoc(fx.path);
    const frozen = r.outline.filter(b => b.frozen);
    assert.equal(frozen.length, 1);
    assert.equal(frozen[0].preview, 'Approved by Finance.');
    assert.equal(frozen[0].id, null, 'the backfill skips frozen zones, so it has no name');
  } finally { fx.cleanup(); }
});

test('#34: a never-committed document reports null ids rather than pretending', async () => {
  const fx = mkFixture(REPORT, { commit: false });
  try {
    const r = await outlineDoc(fx.path);
    assert.ok(r.count > 0, 'the structure is still visible');
    assert.ok(r.outline.every(b => b.id === null), 'and the absence of names is stated, not papered over');
    const plain = run(['doc', fx.path, '--outline']).stdout;
    assert.match(plain, /without an id — commit once to backfill/);
  } finally { fx.cleanup(); }
});

test('#34: the preview is capped, and --preview budgets it', async () => {
  const fx = mkFixture(REPORT);
  try {
    const dflt = await outlineDoc(fx.path);
    const long = dflt.outline.find(b => b.preview.endsWith('…'));
    assert.ok(long, 'a long paragraph is truncated at the default cap');
    assert.ok(long.preview.length <= 80);

    const tight = await outlineDoc(fx.path, { preview: 20 });
    assert.ok(tight.outline.every(b => b.preview.length <= 20));

    // preview 0 is the structural skeleton. Guarded because `slice(0, cap - 1)`
    // at cap 0 silently means "drop one character", which made the skeleton the
    // LARGEST outline instead of the smallest.
    const skeleton = await outlineDoc(fx.path, { preview: 0 });
    assert.ok(skeleton.outline.every(b => b.preview === ''));
  } finally { fx.cleanup(); }
});

test('#34: on a document of substantial blocks the outline is a fraction of the body', async () => {
  const fx = mkFixture(LONG_REPORT);
  try {
    const full = run(['doc', fx.path]).stdout.length;
    const outline = run(['doc', fx.path, '--outline']).stdout.length;
    const skeleton = run(['doc', fx.path, '--outline', '--preview', '0']).stdout.length;
    assert.ok(outline < full * 0.35, `outline ${outline} vs body ${full}`);
    assert.ok(skeleton < full * 0.12, `skeleton ${skeleton} vs body ${full}`);
    // Honest about the shape of the cost: an outline is O(block count), not
    // O(document size), so the skeleton is the floor.
    assert.ok(skeleton < outline);
  } finally { fx.cleanup(); }
});

test('#34: the plain render indents by heading level', async () => {
  const fx = mkFixture(REPORT);
  try {
    const lines = run(['doc', fx.path, '--outline']).stdout.split('\n');
    const h1 = lines.find(l => / h1 /.test(l) || /\bh1\b/.test(l));
    const h2 = lines.find(l => /\bh2\b/.test(l));
    const nested = lines.find(l => /\bblockquote\b/.test(l));
    const indentOf = (l) => l.slice(l.indexOf('  ', 20)).match(/^ */)[0].length + l.length;
    assert.ok(h1 && h2 && nested);
    assert.ok(h2.indexOf('h2') > h1.indexOf('h1'), 'h2 sits deeper than h1');
    assert.ok(nested.indexOf('blockquote') > h2.indexOf('h2'), 'body copy sits under its heading');
    void indentOf;
  } finally { fx.cleanup(); }
});

// ─── Single-block reads ────────────────────────────────────────────────

test('#34: --block returns exactly that block, byte-identical to the stored source', async () => {
  const fx = mkFixture(REPORT);
  try {
    const r = await outlineDoc(fx.path);
    const target = r.outline.find(b => b.preview === 'EMEA grew 14%.');
    const got = await readBlock(fx.path, target.id);
    assert.equal(got.block.id, target.id);
    assert.equal(got.block.tag, 'p');
    assert.ok(bodyOf(fx.path).includes(got.block.source), 'the returned source is the stored bytes');
    assert.equal(got.baseHash, r.baseHash, 'and it carries the same staleness token');
  } finally { fx.cleanup(); }
});

test('#34: an unknown id is a usage error that points at --outline', () => {
  const fx = mkFixture(REPORT);
  try {
    const r = run(['doc', fx.path, '--block', 'zzzzzzzz', '--json']);
    assert.equal(r.status, 1);
    const err = JSON.parse(r.stderr.trim());
    assert.equal(err.subcode, 'unknown_block');
    assert.match(err.details.hint, /--outline/);
    assert.ok(err.details.identified > 0);
  } finally { fx.cleanup(); }
});

test('#34: a document with NO ids gets a different, more useful answer', () => {
  // "That id does not exist" and "this file has no ids at all" are different
  // problems with different fixes, and only one of them is the caller's typo.
  const fx = mkFixture(REPORT, { commit: false });
  try {
    const r = run(['doc', fx.path, '--block', 'zzzzzzzz', '--json']);
    assert.equal(r.status, 1);
    const err = JSON.parse(r.stderr.trim());
    assert.equal(err.details.identified, 0);
    assert.match(err.details.hint, /no block ids yet/);
  } finally { fx.cleanup(); }
});

test('#34: --block respects --virtual', async () => {
  const uri = 'data:image/png;base64,iVBORw0KGgo' + 'A'.repeat(4000);
  const fx = mkFixture(`<article><h1>Doc</h1><figure><img src="${uri}" alt="c"></figure></article>`);
  try {
    const r = await outlineDoc(fx.path, { virtual: true });
    const fig = r.outline.find(b => b.tag === 'figure');
    const got = await readBlock(fx.path, fig.id, { virtual: true });
    assert.match(got.block.source, /rwa-asset:[0-9a-f]{8}/);
    assert.doesNotMatch(got.block.source, /data:image\//, 'the reader is not handed the bytes');
  } finally { fx.cleanup(); }
});

// ─── The point of all of it ────────────────────────────────────────────

test('#34: an agent edits correctly having read only the outline and one block', async () => {
  const fx = mkFixture(LONG_REPORT);
  try {
    const fullCost = run(['doc', fx.path]).stdout.length;

    // 1. Skeleton — find the section to work on without reading any prose.
    const skeleton = await outlineDoc(fx.path, { preview: 40 });
    const target = skeleton.outline.find(b => b.preview.startsWith('Finding 7.2'));
    assert.ok(target, 'the outline was enough to locate the block');

    // 2. One block — the only prose this agent ever holds.
    const one = await readBlock(fx.path, target.id);

    // 3. Compose an anchored edit from exactly those bytes, and carry the
    //    staleness token from the read (#31) rather than re-reading.
    const r = await applyPlan(
      fx.path,
      {
        version: 'rwa-edit/1',
        edits: [{ find: one.block.source, replace: one.block.source.replace('Finding 7.2', 'Finding 7.2 (revised)') }],
      },
      { baseHash: one.baseHash },
    );
    assert.equal(r.ok, true);
    assert.ok(bodyOf(fx.path).includes('Finding 7.2 (revised)'));

    const paid = JSON.stringify(skeleton).length + one.block.source.length;
    assert.ok(paid < fullCost * 0.6, `read ${paid} chars instead of ${fullCost} to make one edit`);
  } finally { fx.cleanup(); }
});
