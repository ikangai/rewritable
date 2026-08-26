// Print lane — the paper assertions jsdom structurally cannot make (#19).
//
// WHY this exists: print bugs have reached real users three times (3877e6f card
// chrome framing every page, c5a60af dead margins + 3.8pt text). Every one was
// found by a person holding paper, fixed by hand, and verified by hand with
// Page.printToPDF. `tests/print.mjs` pins the CSS and the prompt vocabulary as
// TEXT — it proves the rules are spelled right, never that paper comes out
// right. This lane closes that gap the way 20ffe90 closed two others: turn the
// hand-verification into a gate.
//
// WHY NOT "printToPDF and measure the type size", which is what the issue asked
// for: it does not work, and quietly. Probed 2026-08-26 across three documents —
// clean, over-wide-but-fixed, and over-wide-with-the-fix-reverted — headless
// printToPDF emitted the SAME font sizes (16 and 36) for all three. Headless
// Chrome CLIPS overflow; it does not reproduce the print dialog's fit-to-width
// shrink, which is where the 0.32x / 3.8pt report came from. A test that read
// type size out of the PDF would therefore have passed on the reverted code —
// vacuous, and vacuous in the confident direction. Do not "fix" this file back
// to that shape.
//
// WHAT IS ASSERTED INSTEAD: overflow at paper width, which is the CAUSE both
// symptoms derive from — the dialog shrinks it, headless clips it, and neither
// happens when the content fits. Layout is measured with the viewport forced to
// the real printable box (A4 minus the @page margin) and print media emulated,
// so the numbers are the ones the print engine itself lays out to.
//
// Every scenario that pins a fix also runs a NEGATIVE CONTROL: the same document
// with its own @media print !important rules re-asserting the broken behaviour,
// standing in for a revert of the seed fix. The control must FAIL the same
// measurement the fixed document passes. Without it, "no overflow" could mean
// "the detector is broken" and read exactly like success. Nothing here reverts
// or edits the seed; the control lives in the test document's own CSS.
//
// Zero dependencies — see cdp.mjs. Run: node tests/browser/print.mjs
// A missing Chrome SKIPS loudly and exits 0, unless REQUIRE_BROWSER=1 (CI).

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { launch, findChrome } from './cdp.mjs';
import { applySeedSubs, kindOverrides, replaceInlineDoc } from '../../cli/src/seed.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

let pass = 0, fail = 0;
const check = (m, c) => { if (c) { pass++; console.log('  OK   ' + m); } else { fail++; console.log('  FAIL ' + m); } };

if (!findChrome()) {
  const msg = 'no Chrome binary found (set CHROME_BIN to override)';
  if (process.env.REQUIRE_BROWSER === '1') {
    console.error(`\n✗ print lane REQUIRED but ${msg}`);
    process.exit(1);
  }
  console.log(`\n⚠ SKIPPED: print lane — ${msg}.`);
  console.log('  This lane covers paged-media layout, which jsdom cannot. Set REQUIRE_BROWSER=1 to make a missing browser fail.');
  process.exit(0);
}

// The printable box the seed actually targets: A4 (210x297mm) minus the
// @page{margin:18mm} the seed ships, in CSS px at the 96dpi CSS reference.
// Keep these derived from the millimetre figures rather than hardcoded pixels,
// so a change to @page in the seed is a one-line change here and the arithmetic
// stays auditable.
const MM_PER_IN = 25.4, CSS_DPI = 96;
const mm = (v) => Math.round((v / MM_PER_IN) * CSS_DPI);
const PAGE_MARGIN_MM = 18;
const PRINTABLE_W = mm(210 - 2 * PAGE_MARGIN_MM);  // 658
const PRINTABLE_H = mm(297 - 2 * PAGE_MARGIN_MM);  // 986

// Build a real container on disk from the canonical seed and open it from
// file:// — the origin containers actually run at.
function buildContainer(dir, name, body) {
  const ov = kindOverrides('document');
  let html = readFileSync(join(REPO, 'seeds', 'rewritable.html'), 'utf8');
  html = applySeedSubs(html, {
    uuid: randomUUID(), title: name, fileMeta: name, productKind: 'document',
    lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder,
    productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor,
  });
  html = replaceInlineDoc(html, body);
  const p = join(dir, name);
  writeFileSync(p, html, 'utf8');
  return 'file://' + p;
}

// ── Documents under test ────────────────────────────────────────────────────
// Real content, never lorem — these are the two shapes that actually reached
// users, plus the vocabulary the prompt teaches.

const PARA = '<p id="probe">Quarterly figures are reconciled against the ledger before publication.</p>';

// The wide-table shape (c5a60af): unbreakable reference tokens in a nowrap row.
// Its min-content width is far past the page, so before the fix the whole sheet
// was scaled to fit — measured 0.32x, about 3.8pt body text.
const WIDE_CELLS = Array.from({ length: 9 },
  (_, i) => `<td>REF-${i}-0123456789ABCDEF0123456789ABCDEF</td>`).join('');
const WIDE_TABLE = `<article><h1>Ledger references</h1>${PARA}
<table><tbody><tr>${WIDE_CELLS}</tr></tbody></table></article>`;

// NEGATIVE CONTROL for the above: the document re-asserts nowrap in print with
// !important, which is what the paper looked like before the seed fix landed.
const WIDE_TABLE_REVERTED = `<article><h1>Ledger references</h1>
<style>@media print{#rwa-doc-mount td,#rwa-doc-mount th{white-space:nowrap!important;overflow-wrap:normal!important;}#rwa-doc-mount table{max-width:none!important;}}</style>
${PARA}<table><tbody><tr>${WIDE_CELLS}</tr></tbody></table></article>`;

// The card-wrapper shape (c5a60af): imported and AI-drafted documents build the
// page card as a padded root <div> rather than an <article>, and that screen
// chrome printed as a wide dead border inside the @page margin.
const CARD = `<div class="card" style="max-width:640px;margin:40px auto;padding:56px;border:1px solid #ddd;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.1)">
<h1>Field report</h1>${PARA}</div>`;

const CARD_REVERTED = `<div class="card" style="max-width:640px;margin:40px auto;padding:56px">
<style>@media print{#rwa-doc-mount>div{max-width:640px!important;padding:56px!important;}}</style>
<h1>Field report</h1>${PARA}</div>`;

// The four classes f5b0f5c teaches the agent. A rename that lands in the CSS but
// not the prompt is caught as text by tests/print.mjs; that the rules actually
// COMPUTE on paper is only observable here.
const VOCAB = `<article><h1>Appendix handling</h1>${PARA}
<p class="no-print" id="np">Screen-only navigation note.</p>
<p class="print-only" id="po">Printed-only filing reference.</p>
<h2 class="print-break" id="pb">Appendix A</h2>
<div class="print-keep" id="pk"><p>A block that must not split across pages.</p></div>
</article>`;

// ── Measurement ─────────────────────────────────────────────────────────────
// Force the viewport to the printable box and emulate print media, so layout is
// resolved the way the print engine resolves it. Measuring at window size with
// print media emulated would be a different (and much wider) page, which is how
// an overflow test quietly stops testing anything.
async function measure(page, url) {
  await page.goto(url);
  await page.eval(() => new Promise((r) => setTimeout(r, 900)));
  await page.send('Emulation.setEmulatedMedia', { media: 'print' });
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: PRINTABLE_W, height: PRINTABLE_H, deviceScaleFactor: 1, mobile: false,
  });
  await page.eval(() => new Promise((r) => setTimeout(r, 300)));
  const m = await page.eval(() => {
    const g = (id) => document.getElementById(id);
    const box = (id) => {
      const e = g(id); if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const disp = (id) => { const e = g(id); return e ? getComputedStyle(e).display : null; };
    const mount = g('rwa-doc-mount');
    const probe = g('probe');
    const root = mount && mount.firstElementChild;
    return {
      innerW: window.innerWidth,
      scrollW: document.documentElement.scrollWidth,
      mountScrollW: mount ? mount.scrollWidth : -1,
      probe: box('probe'),
      probeFontPx: probe ? parseFloat(getComputedStyle(probe).fontSize) : -1,
      rootFontPx: root ? parseFloat(getComputedStyle(root).fontSize) : -1,
      runtime: box('rwa-runtime'),
      lens: box('rwa-lens'),
      noPrint: disp('np'),
      printOnly: disp('po'),
      breakBefore: g('pb') ? getComputedStyle(g('pb')).breakBefore : null,
      breakInside: g('pk') ? getComputedStyle(g('pk')).breakInside : null,
    };
  });
  await page.send('Emulation.clearDeviceMetricsOverride');
  await page.send('Emulation.setEmulatedMedia', { media: '' });
  return m;
}

// Overflow is the single cause both paper symptoms derive from. One CSS pixel of
// slack absorbs sub-pixel rounding in the layout numbers without admitting a real
// overflow — the reverted control below misses by thousands, not by ones.
const overflows = (m) => m.scrollW > m.innerW + 1 || m.mountScrollW > m.innerW + 1;

const dir = mkdtempSync(join(tmpdir(), 'rwa-print-'));
let page;
try {
  const urls = {
    wide: buildContainer(dir, 'wide-table.html', WIDE_TABLE),
    wideRev: buildContainer(dir, 'wide-table-reverted.html', WIDE_TABLE_REVERTED),
    card: buildContainer(dir, 'card.html', CARD),
    cardRev: buildContainer(dir, 'card-reverted.html', CARD_REVERTED),
    vocab: buildContainer(dir, 'vocabulary.html', VOCAB),
  };
  page = await launch({ url: urls.wide });
  await page.eval(() => new Promise((r) => setTimeout(r, 800)));

  console.log(`\n== P1: fit-to-width defusal — a wide nowrap table (printable box ${PRINTABLE_W}x${PRINTABLE_H}px) ==`);
  {
    const m = await measure(page, urls.wide);
    check('the document fits the printable width — nothing to shrink or clip',
      !overflows(m));
    check('body text holds the 12pt print baseline (16px === 12pt)',
      m.probeFontPx === 16);
    console.log(`       measured: scrollW=${m.mountScrollW}px in a ${m.innerW}px page, body ${m.probeFontPx}px`);

    const rev = await measure(page, urls.wideRev);
    check('NEGATIVE CONTROL: with the fix reverted the same table DOES overflow (the gate has teeth)',
      overflows(rev));
    console.log(`       measured: scrollW=${rev.mountScrollW}px in a ${rev.innerW}px page` +
      `  →  would shrink to ${(rev.innerW / rev.mountScrollW).toFixed(2)}x` +
      ` ≈ ${(12 * rev.innerW / rev.mountScrollW).toFixed(1)}pt body text`);
  }

  console.log('\n== P2: root-wrapper reset — a padded card <div> as the page root ==');
  {
    const m = await measure(page, urls.card);
    check('card chrome does not print — content starts at the page edge',
      m.probe !== null && m.probe.x <= 2);
    check('content spans the full printable width, no dead border',
      m.probe !== null && m.probe.w >= PRINTABLE_W - 4);
    check('root container pinned to the 12pt print baseline',
      m.rootFontPx === 16);
    console.log(`       measured: text box x=${m.probe.x}px w=${m.probe.w}px of ${PRINTABLE_W}px`);

    const rev = await measure(page, urls.cardRev);
    const deadMm = Math.round((rev.probe.x / CSS_DPI) * MM_PER_IN);
    check('NEGATIVE CONTROL: with the reset reverted the card DOES eat the page',
      rev.probe.x > 2 && rev.probe.w < PRINTABLE_W - 4);
    console.log(`       measured: text box x=${rev.probe.x}px w=${rev.probe.w}px` +
      `  →  ~${deadMm}mm of dead margin per side on top of the 18mm @page margin`);
  }

  console.log('\n== P3: runtime chrome never reaches paper ==');
  {
    const m = await measure(page, urls.vocab);
    check('#rwa-runtime occupies no space in print',
      m.runtime !== null && m.runtime.w === 0 && m.runtime.h === 0);
    // releaseAnchor() reparents #rwa-lens to <body>, escaping the transitive
    // hide — the seed hides it explicitly for exactly this reason, so measure it
    // rather than trusting the containment.
    check('#rwa-lens occupies no space in print even though it can be reparented to <body>',
      m.lens !== null && m.lens.w === 0 && m.lens.h === 0);
  }

  console.log('\n== P4: the print vocabulary the agent is taught actually computes ==');
  {
    const m = await measure(page, urls.vocab);
    check('.no-print is hidden on paper', m.noPrint === 'none');
    check('.print-only becomes visible on paper', m.printOnly === 'block');
    check('.print-break forces a page break', m.breakBefore === 'page');
    check('.print-keep avoids splitting across pages', m.breakInside === 'avoid');
  }

  console.log('\n== P5: printToPDF smoke — the document still prints at all ==');
  {
    // Deliberately a smoke check, not a measurement. See the header: headless
    // printToPDF reports identical type sizes for fixed and broken documents, so
    // it can prove that printing produces a real PDF and cannot prove it is a
    // good one. Page count guards the other direction — a layout accident that
    // explodes one screen of prose across many sheets.
    await page.goto(urls.card);
    await page.eval(() => new Promise((r) => setTimeout(r, 900)));
    const pdf = await page.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
    const buf = Buffer.from(pdf.data, 'base64');
    check('printing yields a well-formed PDF', buf.slice(0, 5).toString('latin1') === '%PDF-');
    const pages = [...buf.toString('latin1').matchAll(/\/Type\s*\/Page[^s]/g)].length;
    check(`a one-screen document prints on a sane number of sheets (got ${pages})`,
      pages >= 1 && pages <= 3);
  }
} catch (e) {
  fail++;
  console.log('  FAIL harness error: ' + (e && e.message));
} finally {
  if (page) await page.close();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
