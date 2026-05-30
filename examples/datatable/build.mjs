// Regenerate examples/datatable/datatable.html from _source.html + the canonical
// seed. The datatable is a rewritable, so it must carry a current bootstrap; we
// build from seeds/rewritable.html directly (NOT the CLI's in-package publish
// copy, which can lag) so the artifact always has the latest runtime — notably
// runtime.applyEnvelope (the model-free edit path) and window.getCurrentDocCache.
//
//   node examples/datatable/build.mjs [seed-path]
//
// Default seed: seeds/rewritable.html. Pass a path to pin a specific seed (e.g.
// a clean HEAD copy while a teammate has the working-tree seed mid-edit).
//
// Mirrors the CLI import ordering (CLAUDE.md): seed-level subs FIRST, then drop
// the converted body into INLINE_DOC — reversed order lets DOC_UUID false-match
// imported content.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applySeedSubs, kindOverrides, replaceInlineDoc } from '../../cli/src/seed.mjs';
import { convert } from '../../cli/src/import.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const seedPath = process.argv[2] || path.join(ROOT, 'seeds', 'rewritable.html');
const SRC = path.join(__dirname, '_source.html');
const OUT = path.join(__dirname, 'datatable.html');

const { html: body, warnings } = await convert('html', fs.readFileSync(SRC));
for (const w of warnings) process.stderr.write('note: ' + w + '\n');

// PRODUCT_KIND='datatable' is an honest self-identification. The seed tolerates
// unknown kinds (SYSTEM_PROMPTS falls back to document; the presentation gate
// stays off), so the runtime behaves as a document while the file truthfully
// reports `kind: "datatable"` to `rwa doc` and self-description/1.
const ov = kindOverrides('document');
let html = fs.readFileSync(seedPath, 'utf8');
html = applySeedSubs(html, {
  uuid: crypto.randomUUID(),
  title: 'Q1 2026 — Marketing Budget',
  fileMeta: 'datatable.html',
  productKind: 'datatable',
  lensPlaceholder: ov.lensPlaceholder,
  palPlaceholder: ov.palPlaceholder,
  productHeader: ov.productHeader,
  lensClickToAnchor: ov.lensClickToAnchor,
});
html = replaceInlineDoc(html, body);
fs.writeFileSync(OUT, html);
process.stderr.write('wrote ' + path.relative(ROOT, OUT) + '  (seed: ' + path.relative(ROOT, seedPath) + ')\n');
