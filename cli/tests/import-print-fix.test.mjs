// Regression + mirror guard for the PDF-import print fix (A4-correct export-to-PDF).
//
// Geometry PDF imports used to print with huge margins: the seed's @page{margin:18mm}
// double-framed a page that already carries its own margins, and the page box — sized
// in PDF points but rendered as CSS px (72→96 dpi) — drew at 75% of physical size. The
// fix is two coupled, print-only corrections in the emitter: a `zoom` (96/72) on the
// page box, and a per-document @page matching the source page size with margin:0.
//
// The BEHAVIOUR is proven by a headless print-to-PDF of a real import (one A4 page, edge
// to edge — see docs/plans/2026-07-02-pdf-structural-reconstruction-design.md). This test
// pins the two emit sites so the fix can't silently regress OR drift out of sync — the
// PDF geometry block in service/public/import.html is a byte-mirror of cli/src/import.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sites = {
  'cli/src/import.mjs': readFileSync(join(root, 'cli/src/import.mjs'), 'utf8'),
  'service/public/import.html': readFileSync(join(root, 'service/public/import.html'), 'utf8'),
};

for (const [name, src] of Object.entries(sites)) {
  test(`${name}: geometry page box is zoom-corrected (72->96 dpi) in @media print`, () => {
    assert.ok(
      src.includes('.rwa-pdf-page{box-shadow:none;zoom:1.3333}'),
      'expected the print-only zoom that undoes the points-as-px 75% shrink',
    );
  });

  test(`${name}: emits a per-document @page sized in pt with margin:0`, () => {
    assert.ok(
      src.includes('@page{size:${dims[1]}pt ${dims[2]}pt;margin:0}'),
      'expected a per-doc @page matching the source page size, overriding @page{margin:18mm}',
    );
    assert.ok(
      src.includes('width:([\\d.]+)px;height:([\\d.]+)px'),
      'expected the page-box dims extraction that feeds the @page size',
    );
  });
}
