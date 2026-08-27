// Pins the cross-surface document-hash identity (#30 / #31).
//
// The CLI reports `baseHash`/`newHash` from `bodyHash()` in the vendored
// `lib/edit.mjs`. The hosted runtime reports `baseHash` from
// `hosted.baseBodyHash()` / `hosted.sha256hex(canonLF(doc))` in `lib/hosted.js`.
// These are two independently-written functions that MUST produce the same
// value for the same container, because an agent is expected to read from one
// surface and write to the other:
//
//     rwa doc  →  baseHash                  (local file)
//     GET /r/:id/doc  →  baseHash           (hosted projection)
//     POST /r/:id/modify { baseHash }       (409 on mismatch)
//     rwa edit --base-hash <hex>            (#31, refuses on mismatch)
//
// If the two definitions ever diverge — a different canonicalization, a
// different slice of the file, a different digest — every staleness check
// silently becomes a coin flip: the hosted runtime would 409 a perfectly fresh
// edit, or worse, accept a stale one. Nothing else in the suite would notice,
// because each surface is self-consistent. That is exactly why this pin exists
// as its own file rather than as an aside in either surface's tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { bodyHash, applyPlan } from '../lib/edit.mjs';
import { extractInlineDoc, replaceInlineDoc } from '../lib/seed.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const hosted = require('../lib/hosted.js');
const RWA_BIN = join(__dirname, '..', '..', 'cli', 'bin', 'rwa.mjs');

function mkContainer(body) {
  const dir = mkdtempSync(join(tmpdir(), 'rwa-hashparity-'));
  const path = join(dir, 'c.html');
  execFileSync('node', [RWA_BIN, 'new', path], { stdio: 'pipe' });
  if (body) writeFileSync(path, replaceInlineDoc(readFileSync(path, 'utf8'), body), 'utf8');
  return { path, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const BODIES = {
  'a plain document': '<article><h1>Report</h1><p>One paragraph.</p></article>',
  'CRLF line endings': '<article>\r\n<h1>Report</h1>\r\n<p>Windows-authored.</p>\r\n</article>',
  'NFD-composed accents': '<article><h1>Café notes</h1><p>Decomposed é.</p></article>',
  'an embedded image': `<article><h1>Photo</h1><img src="data:image/png;base64,iVBORw0KGgo${'A'.repeat(200)}" alt="chart"></article>`,
  'a frozen zone': '<article><!-- rwa:frozen:begin legal -->\n<p>Do not edit.</p>\n<!-- rwa:frozen:end legal -->\n<h1>Report</h1></article>',
};

for (const [label, body] of Object.entries(BODIES)) {
  test(`#30: CLI bodyHash === hosted baseBodyHash — ${label}`, async () => {
    const fx = mkContainer(body);
    try {
      const bytes = readFileSync(fx.path, 'utf8');
      const cli = bodyHash(extractInlineDoc(bytes));
      const svc = await hosted.baseBodyHash(bytes);
      assert.match(cli, /^[0-9a-f]{64}$/);
      assert.equal(
        cli, svc,
        'the local and hosted surfaces must agree on what this document IS — ' +
        'otherwise every staleness check across them is meaningless',
      );
    } finally { fx.cleanup(); }
  });
}

test('#30: the hash the hosted /doc would serve equals the hash a CLI edit reports', async () => {
  // The end-to-end shape of the contract: edit locally, then ask the hosted
  // formula what it thinks the document is now. A caller carrying newHash
  // forward to `POST /modify { baseHash }` must not be 409'd.
  const fx = mkContainer('<article><h1>Old</h1></article>');
  try {
    const result = await applyPlan(fx.path, {
      version: 'rwa-edit/1',
      edits: [{ find: 'Old', replace: 'New' }],
    });
    const svcAfter = await hosted.baseBodyHash(readFileSync(fx.path, 'utf8'));
    assert.equal(result.newHash, svcAfter);
  } finally { fx.cleanup(); }
});

test('#30: the hash is over the editable body only — bootstrap bytes do not move it', async () => {
  // Two containers with identical bodies but different DOC_UUIDs (and therefore
  // different file bytes) must hash the same. If the bootstrap leaked into the
  // hash, every freshly emitted container would look "changed" to a caller.
  const a = mkContainer('<article><h1>Same</h1></article>');
  const b = mkContainer('<article><h1>Same</h1></article>');
  try {
    const bytesA = readFileSync(a.path, 'utf8');
    const bytesB = readFileSync(b.path, 'utf8');
    assert.notEqual(bytesA, bytesB, 'the two containers really do differ on disk (fresh UUIDs)');
    assert.equal(bodyHash(extractInlineDoc(bytesA)), bodyHash(extractInlineDoc(bytesB)));
  } finally { a.cleanup(); b.cleanup(); }
});
