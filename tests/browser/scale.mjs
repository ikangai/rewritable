// Scale budgets (#8) — measured in a REAL browser, which is the only instrument that means
// anything here.
//
// The fidelity/conformance corpus tops out at 2.2 KB against a 1 MB MAX_DOC, and the spec targets
// "documents in the 50-100 KB range" while warning that past ~200 KB full-content rewrites get
// slow. None of that was measured. Recent features land documents squarely in the unmeasured zone:
// PDF geometry reconstruction, and `rwa clone --localize-images` which permits up to 8 MB of data
// URIs.
//
// WHY not jsdom: the first attempt at this ran in jsdom and was still crawling after four minutes,
// which measures jsdom rather than the product. Render cost is a property of the engine actually
// executing it. #9's lane exists, so this uses it.
//
// PREDICTION OUTCOME, recorded honestly. The remediation plan predicted that
// `buildSourcePositionMap` would dominate at 200 KB, on the reasoning that it does a fresh
// DOMParser parse plus a full regex scan on every render while the commit writes once. That was
// WRONG, and by a wide margin — at 800 KB the sourcemap costs 8 ms while renderDoc costs ~2800 ms,
// roughly 350x. The commit path (whole-document IDB put plus the undo push) was the other suspect
// and is also not the problem: 185 ms at 800 KB, scaling sub-linearly. Had this been "optimised"
// without measuring, the work would have gone into the two cheapest paths.
//
// The actual wall is renderDoc — innerHTML plus script re-execution plus block-id backfill — and it
// runs on every commit, so it sets the ceiling for interactive editing. Boot cost is essentially
// render cost.
//
// Run: node tests/browser/scale.mjs

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { launch, findChrome } from './cdp.mjs';
import { applySeedSubs, kindOverrides, replaceInlineDoc } from '../../cli/src/seed.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

let pass = 0, fail = 0;
const check = (m, c) => { if (c) { pass++; console.log('  OK   ' + m); } else { fail++; console.log('  FAIL ' + m); } };

if (!findChrome()) {
  if (process.env.REQUIRE_BROWSER === '1') { console.error('✗ scale budgets REQUIRE a browser'); process.exit(1); }
  console.log('⚠ SKIPPED: scale budgets — no Chrome. Set REQUIRE_BROWSER=1 to make this fail.');
  process.exit(0);
}

// Ceilings, not targets. Set well above the measured values on a dev machine so a CI runner's
// slower hardware does not produce noise, while still catching an order-of-magnitude regression —
// which is the failure mode that matters (an accidental O(n^2), a per-block reflow).
// Measured 2026-08-05, headless Chrome, M-series: 200 KB → boot 252ms, render 179ms, smap 2ms,
// commit 49ms.
const BUDGETS = [
  { kb: 50, boot: 3000, render: 1500, commit: 1500 },
  { kb: 200, boot: 6000, render: 3000, commit: 3000 },
];

function body(bytes) {
  let s = '', i = 0;
  while (s.length < bytes) {
    s += `<p>Paragraph ${i} with enough prose to resemble a real document sentence about invoices and totals.</p>\n`;
    i++;
  }
  return '<article>\n' + s + '</article>';
}

function build(dir, bytes, name) {
  const ov = kindOverrides('document');
  let html = readFileSync(join(REPO, 'seeds', 'rewritable.html'), 'utf8');
  html = applySeedSubs(html, {
    uuid: randomUUID(), title: 'Scale', fileMeta: name, productKind: 'document',
    lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder,
    productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor,
  });
  html = replaceInlineDoc(html, body(bytes));
  const p = join(dir, name);
  writeFileSync(p, html, 'utf8');
  return 'file://' + p;
}

const dir = mkdtempSync(join(tmpdir(), 'rwa-scale-'));
try {
  console.log('\n== Scale budgets (real browser) ==');
  console.log('  size |   boot | render | smap | commit');
  for (const b of BUDGETS) {
    const page = await launch({ url: build(dir, b.kb * 1024, `s${b.kb}.html`) });
    try {
      const t = await page.eval(async () => {
        const t0 = performance.now();
        while (!window.runtime && performance.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 10));
        const boot = performance.now() - t0;
        if (!window.runtime) return { boot: -1 };
        const doc = await window.getDoc();
        const r0 = performance.now(); for (let i = 0; i < 3; i++) window.renderDoc(doc);
        const render = (performance.now() - r0) / 3;
        const s0 = performance.now();
        for (let i = 0; i < 3; i++) if (window.buildSourcePositionMap) window.buildSourcePositionMap(doc);
        const smap = (performance.now() - s0) / 3;
        const c0 = performance.now();
        await window.runtime.applyEnvelope(
          { version: 'rwa-edit/1', edits: [{ find: 'Paragraph 0 ', replace: 'Paragraph zero ' }] },
          { surface: 'perf' });
        const commit = performance.now() - c0;
        return { boot, render, smap, commit, len: doc.length };
      });
      console.log(`  ${String(b.kb).padStart(4)}K | ${String(Math.round(t.boot)).padStart(5)}ms | ${String(Math.round(t.render)).padStart(5)}ms | ${String(Math.round(t.smap)).padStart(3)}ms | ${String(Math.round(t.commit)).padStart(5)}ms`);
      check(`${b.kb} KB boots (< ${b.boot}ms)`, t.boot > 0 && t.boot < b.boot);
      check(`${b.kb} KB renders (< ${b.render}ms)`, t.render < b.render);
      check(`${b.kb} KB commits (< ${b.commit}ms)`, t.commit < b.commit);
      // The shape claim, not just the magnitude: the sourcemap must stay far cheaper than render.
      // If this ever inverts, the assumption this file records has changed and the budgets above
      // were set against the wrong bottleneck.
      check(`${b.kb} KB: sourcemap stays cheaper than render (the measured shape)`, t.smap <= t.render + 1);
    } finally { await page.close(); }
  }
} catch (e) {
  fail++; console.log('  FAIL harness error: ' + (e && e.message));
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
