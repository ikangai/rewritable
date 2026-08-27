// data-rwa-id backfill on the CLI commit path (#32).
//
// Before this, no CLI path assigned block ids. A document created by `rwa new`,
// filled by `rwa create`, edited by `rwa edit` and shipped by `rwa publish` had
// none — forever — and `rwa doc --json` reported `blocks: 0`, which reads as
// "empty document" to anything negotiating on the describe contract. Meanwhile
// the CLI agent loop hands the model the seed's SYSTEM_PROMPT_RULES verbatim,
// including "the runtime backfills any block you produce without one". That was
// simply false on this surface: a promise the runner did not keep.
//
// It matters beyond tidiness. Under delegation the external agent directs work
// on a document it has not read, so block ids are the NOUNS of the protocol —
// "rewrite k3f9a2" is the vocabulary. An id that only exists if a human happens
// to open the file in a browser is not a stable name.
//
// Seed-vs-CLI agreement on WHICH blocks get an id lives in
// tests/block-id-parity.mjs. This file pins the CLI commit path itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyPlan } from '../src/edit.mjs';
import { replaceInlineDoc, extractInlineDoc } from '../src/seed.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RWA_BIN = join(__dirname, '..', 'bin', 'rwa.mjs');

function mkFixture(body) {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-blockids-'));
  const path = join(dir, 'test.html');
  execFileSync('node', [RWA_BIN, 'new', path], { stdio: 'pipe' });
  writeFileSync(path, replaceInlineDoc(readFileSync(path, 'utf8'), body), 'utf8');
  return { path, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const bodyOf = (p) => extractInlineDoc(readFileSync(p, 'utf8'));
const idsIn = (s) => [...s.matchAll(/data-rwa-id="([a-z2-7]{8})"/g)].map(m => m[1]);

test('#32: every anchorable block carries an id after an edit', async () => {
  const fx = mkFixture('<article>\n<h1>Old</h1>\n<p>One.</p>\n<ul><li>a</li><li>b</li></ul>\n</article>');
  try {
    assert.equal(idsIn(bodyOf(fx.path)).length, 0, 'precondition: a CLI-authored doc starts with none');
    const result = await applyPlan(fx.path, { version: 'rwa-edit/1', edits: [{ find: 'Old', replace: 'New' }] });
    const body = bodyOf(fx.path);
    // h1 + p + 2 li. <article> and <ul> are not anchorable — they are
    // transparent wrappers whose anchorable children are identified instead.
    assert.equal(idsIn(body).length, 4);
    assert.equal(result.blockIdsAssigned, 4, 'the result reports how many it minted');
    for (const tag of ['h1', 'p', 'li']) {
      assert.match(body, new RegExp(`<${tag} data-rwa-id="`), `${tag} was identified`);
    }
  } finally { fx.cleanup(); }
});

test('#32: existing ids survive verbatim and are never renumbered', async () => {
  // URL fragments link to these. Renumbering silently breaks every inbound link.
  // The existing id uses the real base32 alphabet (a-z, 2-7) so idsIn() counts it.
  const fx = mkFixture('<article><h1 data-rwa-id="keepme22">Old</h1><p>Fresh.</p></article>');
  try {
    await applyPlan(fx.path, { version: 'rwa-edit/1', edits: [{ find: 'Old', replace: 'New' }] });
    const body = bodyOf(fx.path);
    assert.ok(body.includes('data-rwa-id="keepme22"'), 'the pre-existing id is byte-identical');
    assert.equal(idsIn(body).length, 2, 'and the unidentified sibling gained one');
  } finally { fx.cleanup(); }
});

test('#32: ids are unique across a whole-document backfill', async () => {
  const blocks = Array.from({ length: 120 }, (_, i) => `<p>Paragraph ${i}.</p>`).join('\n');
  const fx = mkFixture(`<article>\n<h1>Old</h1>\n${blocks}\n</article>`);
  try {
    await applyPlan(fx.path, { version: 'rwa-edit/1', edits: [{ find: 'Old', replace: 'New' }] });
    const ids = idsIn(bodyOf(fx.path));
    assert.equal(ids.length, 121);
    assert.equal(new Set(ids).size, ids.length, 'a duplicate id would shadow a live fragment link');
  } finally { fx.cleanup(); }
});

test('#32: frozen zones are not touched, in either form', async () => {
  // Injecting an attribute inside an author-declared invariant would both violate
  // the invariant and break dataRwaFrozenSnapshot on the very next edit.
  const fx = mkFixture(
    '<article>\n<!-- rwa:frozen:begin legal -->\n<p>Locked prose.</p>\n<!-- rwa:frozen:end legal -->\n' +
    '<div data-rwa-frozen><p>Also locked.</p></div>\n<h1>Old</h1>\n</article>',
  );
  try {
    await applyPlan(fx.path, { version: 'rwa-edit/1', edits: [{ find: 'Old', replace: 'New' }] });
    const body = bodyOf(fx.path);
    assert.ok(body.includes('<p>Locked prose.</p>'), 'marker-form zone byte-identical');
    assert.ok(body.includes('<div data-rwa-frozen><p>Also locked.</p></div>'), 'attribute-form zone byte-identical');
    assert.equal(idsIn(body).length, 1, 'only the free h1 was identified');
    // The real proof: a SECOND edit still passes the frozen-zone guards. If the
    // backfill had written inside a zone, this is where it would blow up.
    const again = await applyPlan(fx.path, { version: 'rwa-edit/1', edits: [{ find: 'New', replace: 'Newer' }] });
    assert.equal(again.ok, true);
  } finally { fx.cleanup(); }
});

test('#32: backfill is idempotent — a second edit mints nothing new', async () => {
  const fx = mkFixture('<article><h1>Old</h1><p>One.</p></article>');
  try {
    const first = await applyPlan(fx.path, { version: 'rwa-edit/1', edits: [{ find: 'Old', replace: 'Mid' }] });
    const before = idsIn(bodyOf(fx.path));
    const second = await applyPlan(fx.path, { version: 'rwa-edit/1', edits: [{ find: 'Mid', replace: 'New' }] });
    assert.equal(first.blockIdsAssigned, 2);
    assert.equal(second.blockIdsAssigned, 0, 'nothing left to identify');
    assert.deepEqual(idsIn(bodyOf(fx.path)), before, 'and the existing ids are untouched');
  } finally { fx.cleanup(); }
});

test('#32: the reported hash and size cover the ids that were written', async () => {
  // The backfill runs before hashing on purpose: a newHash that excluded the ids
  // would not match the file on disk, and #31's compare-and-swap would reject
  // every follow-up edit.
  const fx = mkFixture('<article><h1>Old</h1><p>One.</p></article>');
  try {
    const result = await applyPlan(fx.path, { version: 'rwa-edit/1', edits: [{ find: 'Old', replace: 'New' }] });
    const body = bodyOf(fx.path);
    assert.ok(result.blockIdsAssigned > 0);
    assert.equal(result.bytes, body.length);
    const next = await applyPlan(
      fx.path,
      { version: 'rwa-edit/1', edits: [{ find: 'New', replace: 'Newer' }] },
      { baseHash: result.newHash },
    );
    assert.equal(next.ok, true, 'the previous newHash is still a valid staleness token');
  } finally { fx.cleanup(); }
});

test('#32: rwa doc --json now reports a real block count', async () => {
  const fx = mkFixture('<article><h1>Old</h1><p>One.</p><p>Two.</p></article>');
  try {
    const before = JSON.parse(spawnSync('node', [RWA_BIN, 'doc', fx.path, '--json'], { encoding: 'utf8' }).stdout);
    assert.equal(before.blocks, 0, 'the gap this issue closes');
    await applyPlan(fx.path, { version: 'rwa-edit/1', edits: [{ find: 'Old', replace: 'New' }] });
    const after = JSON.parse(spawnSync('node', [RWA_BIN, 'doc', fx.path, '--json'], { encoding: 'utf8' }).stdout);
    assert.equal(after.blocks, 3, 'a describe consumer can now see the document has structure');
  } finally { fx.cleanup(); }
});

test('#32: replace_document also backfills, so the escape hatch is not a hole', async () => {
  const fx = mkFixture('<article><h1>Old</h1></article>');
  try {
    const result = await applyPlan(fx.path, {
      version: 'rwa-edit/1',
      doc: '<article>\n<h1>Rewritten</h1>\n<p>Wholly new content.</p>\n</article>',
      reason: 'testing the escape hatch',
    });
    assert.equal(result.blockIdsAssigned, 2);
    assert.equal(idsIn(bodyOf(fx.path)).length, 2);
  } finally { fx.cleanup(); }
});

test('#32: injected randomness makes the backfill reproducible for parity gates', async () => {
  // Not a production path — it exists so anything comparing two apply pipelines
  // byte-for-byte (the service vendored-apply gate) can hold the RNG still.
  const mk = () => mkFixture('<article><h1>Old</h1><p>One.</p></article>');
  const a = mk(); const b = mk();
  try {
    let n = 0;
    const rand = () => Buffer.from([0, 0, 0, 0, n++]);
    const env = { version: 'rwa-edit/1', edits: [{ find: 'Old', replace: 'New' }] };
    await applyPlan(a.path, structuredClone(env), { rand });
    n = 0;
    await applyPlan(b.path, structuredClone(env), { rand });
    assert.deepEqual(idsIn(bodyOf(a.path)), idsIn(bodyOf(b.path)));
  } finally { a.cleanup(); b.cleanup(); }
});
