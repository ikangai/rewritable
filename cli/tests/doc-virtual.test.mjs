// `rwa doc --virtual` and its paired `rwa edit --virtual` (#33).
//
// `rwa doc` was the last read door still handing over embedded image bytes. The
// seed's modify(), the CLI's own agent loop and `rwa doctor` have always
// virtualized to `rwa-asset:<hash8>` tokens; the door documented as "the read
// counterpart to rwa edit" did not. In the audit, one 60 KB image made a
// four-line document cost 60,151 characters to read — and the second-order risk
// is worse than the cost: a reader that then reaches for `replace_document` has
// to echo every one of those bytes back, which no model does faithfully.
//
// The two flags are ONE contract, which is why the mismatch tests below matter
// as much as the projection tests. A token-form read with a raw-form write means
// anchors stop matching around images; that already failed, but as a bare
// `find_not_found`, which sends the caller off shortening its anchor when the
// real problem is that it read one projection and wrote against another.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyPlan, CliError } from '../src/edit.mjs';
import { replaceInlineDoc, extractInlineDoc } from '../src/seed.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RWA_BIN = join(__dirname, '..', 'bin', 'rwa.mjs');

// ~60 KB of base64 — the size that made the audit's read unusable.
const URI = 'data:image/png;base64,iVBORw0KGgo' + 'A'.repeat(60000);
const IMG_BODY = `<article>\n<h1>Photo report</h1>\n<p>Intro.</p>\n<img src="${URI}" alt="chart">\n<p>Closing.</p>\n</article>`;

function mkFixture(body) {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-docvirt-'));
  const path = join(dir, 'test.html');
  execFileSync('node', [RWA_BIN, 'new', path], { stdio: 'pipe' });
  writeFileSync(path, replaceInlineDoc(readFileSync(path, 'utf8'), body), 'utf8');
  return { path, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const run = (args) => spawnSync('node', [RWA_BIN, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const bodyOf = (p) => extractInlineDoc(readFileSync(p, 'utf8'));
const writePlan = (dir, name, env) => { const p = join(dir, name); writeFileSync(p, JSON.stringify(env)); return p; };

// ─── The projection ────────────────────────────────────────────────────

test('#33: --virtual replaces image bytes with tokens', () => {
  const fx = mkFixture(IMG_BODY);
  try {
    const raw = run(['doc', fx.path]).stdout;
    const virt = run(['doc', fx.path, '--virtual']).stdout;
    assert.ok(raw.length > 60000, 'precondition: the raw read is the expensive one');
    assert.ok(virt.length < 300, `the virtual read is small (was ${virt.length})`);
    assert.match(virt, /rwa-asset:[0-9a-f]{8}/);
    assert.doesNotMatch(virt, /data:image\//, 'no image bytes reach the reader');
    // The prose is untouched — only the src changed.
    assert.match(virt, /<h1[^>]*>Photo report<\/h1>/);
    assert.match(virt, /alt="chart"/);
  } finally { fx.cleanup(); }
});

test('#33: baseHash names the DOCUMENT, not the projection', () => {
  // If the hash moved with the projection, a caller that read virtually could
  // never use --base-hash against a document the hosted runtime also knows —
  // the number would be self-consistent and agree with nothing else.
  const fx = mkFixture(IMG_BODY);
  try {
    const raw = JSON.parse(run(['doc', fx.path, '--json']).stdout);
    const virt = JSON.parse(run(['doc', fx.path, '--virtual', '--json']).stdout);
    assert.equal(virt.baseHash, raw.baseHash);
    assert.notEqual(virt.length, raw.length, 'but the projections really do differ');
  } finally { fx.cleanup(); }
});

test('#33: --json labels the projection it handed over', () => {
  const fx = mkFixture(IMG_BODY);
  try {
    const virt = JSON.parse(run(['doc', fx.path, '--virtual', '--json']).stdout);
    assert.equal(virt.virtual, true);
    assert.equal(virt.assets, 1);
    assert.equal(virt.length, virt.doc.length);

    const raw = JSON.parse(run(['doc', fx.path, '--json']).stdout);
    assert.equal(raw.virtual, false);
    assert.equal(raw.assets, undefined, 'no asset count is claimed for a raw read');
  } finally { fx.cleanup(); }
});

test('#33: --virtual on an image-free document changes nothing', () => {
  // Negative control: the flag must not be a silent rewrite of ordinary prose.
  const fx = mkFixture('<article><h1>Plain</h1><p>No images here.</p></article>');
  try {
    assert.equal(run(['doc', fx.path, '--virtual']).stdout, run(['doc', fx.path]).stdout);
  } finally { fx.cleanup(); }
});

// ─── The paired write ──────────────────────────────────────────────────

test('#33: read virtual, edit virtual — image bytes survive, tokens do not persist', () => {
  const fx = mkFixture(IMG_BODY);
  try {
    const virt = run(['doc', fx.path, '--virtual']).stdout;
    const token = virt.match(/rwa-asset:[0-9a-f]{8}/)[0];
    // Anchor on the token exactly as it was read — the whole point of the pairing.
    const plan = writePlan(fx.dir, 'p.json', {
      version: 'rwa-edit/1',
      edits: [{ find: `<img src="${token}" alt="chart">`, replace: `<img src="${token}" alt="quarterly chart">` }],
    });
    const r = run(['edit', fx.path, '--plan', plan, '--virtual', '--json']);
    assert.equal(r.status, 0, r.stderr);

    const body = bodyOf(fx.path);
    assert.ok(body.includes(URI), 'the real image bytes are still on disk');
    assert.doesNotMatch(body, /rwa-asset:/, 'no token leaked into the stored document');
    assert.match(body, /alt="quarterly chart"/, 'and the edit landed');
  } finally { fx.cleanup(); }
});

// ─── Mismatched pairs fail with a diagnosis, not an anchor miss ────────

test('#33: token anchors written RAW are named, not left as find_not_found', async () => {
  const fx = mkFixture(IMG_BODY);
  try {
    const untouched = readFileSync(fx.path, 'utf8');
    let err;
    try {
      await applyPlan(fx.path, {
        version: 'rwa-edit/1',
        edits: [{ find: '<img src="rwa-asset:5bee33d9" alt="chart">', replace: '<p>gone</p>' }],
      });
    } catch (e) { err = e; }
    assert.ok(err instanceof CliError);
    assert.equal(err.subcode, 'virtual_form_mismatch');
    assert.equal(err.details.expected, 'raw');
    assert.match(err.details.hint, /--virtual/);
    assert.equal(readFileSync(fx.path, 'utf8'), untouched, 'nothing was written');
  } finally { fx.cleanup(); }
});

test('#33: raw anchors written VIRTUAL are named too', async () => {
  const fx = mkFixture(IMG_BODY);
  try {
    let err;
    try {
      await applyPlan(
        fx.path,
        { version: 'rwa-edit/1', edits: [{ find: `<img src="${URI}" alt="chart">`, replace: '<p>gone</p>' }] },
        { virtualImages: true },
      );
    } catch (e) { err = e; }
    assert.equal(err.subcode, 'virtual_form_mismatch');
    assert.equal(err.details.expected, 'virtual');
  } finally { fx.cleanup(); }
});

test('#33: the guard does not fire on a pre-existing orphan token', async () => {
  // False-positive control. A document that arrived from outside the protocol
  // (hand edit, import) can legitimately carry an rwa-asset token with no bytes
  // behind it, and rwa-edit-spec §19 says moving one around stays legal. The
  // mismatch guard must not turn that supported edit into an error.
  const fx = mkFixture(`<article>\n<p>a</p>\n<img src="rwa-asset:cafebabe" alt="pre">\n<img src="${URI}" alt="real">\n</article>`);
  try {
    const r = await applyPlan(fx.path, {
      version: 'rwa-edit/1',
      edits: [{
        find: '<p>a</p>\n<img src="rwa-asset:cafebabe" alt="pre">',
        replace: '<img src="rwa-asset:cafebabe" alt="pre">\n<p>a</p>',
      }],
    });
    assert.equal(r.ok, true, 'moving a pre-existing orphan token is still allowed');
  } finally { fx.cleanup(); }
});

test('#33: the guard does not fire on a document with no images at all', async () => {
  const fx = mkFixture('<article><p>Mentions rwa-asset:deadbeef as prose.</p></article>');
  try {
    const r = await applyPlan(fx.path, {
      version: 'rwa-edit/1',
      edits: [{ find: 'as prose', replace: 'as literal prose' }],
    });
    assert.equal(r.ok, true);
  } finally { fx.cleanup(); }
});
