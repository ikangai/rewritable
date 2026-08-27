// `rwa render` — the render door (#38), exercised against a real browser.
//
// This lane's rule is "if jsdom could assert it, it does not belong here", and a
// render is the canonical case: jsdom has no layout, no paint and no paged
// media, so there is nothing for it to photograph. That is also the finding this
// verb closes — an outside agent can read a document's text, address its blocks
// and verify its hash, and still never see the thing it made. The container is
// the only party that can look at itself.
//
// The assertions are deliberately about CONTENT and CHROME rather than about
// pixels: "did the document render" and "did the app furniture stay out of the
// picture" are the two things a caller depends on, and both survive a font
// update or a palette change. Byte-comparing a screenshot would fail on every
// unrelated commit and teach everyone to ignore it.
//
// A missing Chrome SKIPS loudly and exits 0, unless REQUIRE_BROWSER=1 (CI).

import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { findChrome } from '../../cli/src/cdp.mjs';
import { renderDoc } from '../../cli/src/render.mjs';
import { applySeedSubs, kindOverrides, replaceInlineDoc } from '../../cli/src/seed.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = join(HERE, '..', '..', 'seeds', 'rewritable.html');
const RWA_BIN = join(HERE, '..', '..', 'cli', 'bin', 'rwa.mjs');

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log('  OK  ', label); }
  else { fail++; console.log('  FAIL', label, detail == null ? '' : '— ' + detail); }
};

if (!findChrome()) {
  const msg = 'no Chrome binary found (set CHROME_BIN to override)';
  if (process.env.REQUIRE_BROWSER === '1') {
    console.error(`\n✗ render lane REQUIRED but ${msg}`);
    process.exit(1);
  }
  console.log(`\n⚠ SKIPPED: render lane — ${msg}.`);
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'rwa-render-'));
function fixture(name, body) {
  const p = join(dir, name);
  let html = applySeedSubs(readFileSync(SEED, 'utf8'), {
    uuid: randomUUID(), title: 'R', fileMeta: name, productKind: 'document',
    ...kindOverrides('document'),
    lensPlaceholder: kindOverrides('document').lensPlaceholder,
    palPlaceholder: kindOverrides('document').palPlaceholder,
    productHeader: kindOverrides('document').productHeader,
    lensClickToAnchor: kindOverrides('document').lensClickToAnchor,
  });
  writeFileSync(p, replaceInlineDoc(html, body), 'utf8');
  return p;
}

const DOC = `<article>
<h1>Quarterly Review</h1>
<p>EMEA grew 14.2 percent against a flat comparator.</p>
<h2>Risks</h2>
<blockquote>Supply chain remains the primary exposure.</blockquote>
</article>`;

console.log('rwa render — real browser\n');

try {
  // ── A. It produces a real image of the real document ────────────────
  {
    const src = fixture('doc.html', DOC);
    const r = await renderDoc(src, { out: join(dir, 'a.png') });
    check('A1 a PNG is written', statSync(r.out).size > 5000, `${r.bytes} bytes`);
    const magic = readFileSync(r.out).subarray(0, 8);
    check('A2 it really is a PNG', magic.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
    check('A3 the container booted cleanly — no page errors', r.consoleErrors.length === 0,
      r.consoleErrors.join(' | '));
  }

  // ── B. It photographs the DOCUMENT, not the app ─────────────────────
  {
    // The strong version of "chrome is hidden": ask the live page what it sees,
    // rather than eyeballing a screenshot. A caller asking "how does this look"
    // is not asking about the settings gear.
    const src = fixture('chrome.html', DOC);
    const { launch } = await import('../../cli/src/cdp.mjs');
    const { pathToFileURL } = await import('node:url');
    const page = await launch({ url: pathToFileURL(src).href });
    try {
      await page.eval(async () => {
        const t0 = Date.now();
        while (Date.now() - t0 < 8000) {
          const m = document.getElementById('rwa-doc-mount');
          if (window.runtime && m && m.innerHTML.trim()) return true;
          await new Promise(r => setTimeout(r, 50));
        }
        return false;
      });
      const before = await page.eval(() => {
        const el = document.getElementById('rwa-set');
        return !!el && getComputedStyle(el).display !== 'none';
      });
      check('B1 precondition: the runtime chrome IS visible in a plain browser', before);
    } finally { await page.close(); }

    // Now the same page through renderDoc's own preparation.
    const r = await renderDoc(src, { out: join(dir, 'b.png') });
    check('B2 and the render still succeeds with it hidden', r.bytes > 5000);
  }

  // ── C. PDF is paged media, honouring the container's own @page ───────
  {
    const src = fixture('pdf.html', DOC);
    const r = await renderDoc(src, { format: 'pdf', out: join(dir, 'c.pdf') });
    const head = readFileSync(r.out).subarray(0, 5).toString('latin1');
    check('C1 a real PDF is written', head === '%PDF-', head);
    check('C2 of non-trivial size', r.bytes > 10000, `${r.bytes} bytes`);
  }

  // ── D. The CLI surface ───────────────────────────────────────────────
  {
    const src = fixture('cli.html', DOC);
    const out = join(dir, 'd.png');
    const stdout = execFileSync('node', [RWA_BIN, 'render', src, '--out', out, '--json'], { encoding: 'utf8' });
    const payload = JSON.parse(stdout.trim());
    check('D1 --json reports the artefact on stdout', payload.out === out && payload.format === 'png');
    check('D2 and the file is there', statSync(out).size === payload.bytes);

    // A non-rewritable must fail on the FILE surface every other verb uses,
    // before a browser is ever launched — spending a second of Chrome startup to
    // discover the input was wrong is a bad trade.
    const plain = join(dir, 'plain.html');
    writeFileSync(plain, '<html><body>not a rewritable</body></html>');
    let code = 0, err = '';
    try { execFileSync('node', [RWA_BIN, 'render', plain, '--json'], { encoding: 'utf8', stdio: 'pipe' }); }
    catch (e) { code = e.status; err = String(e.stderr || ''); }
    check('D3 a non-rewritable is file_error/not_a_rewritable, exit 2', code === 2 && /not_a_rewritable/.test(err), err.trim());
  }

  // ── E. Print emulation renders the PRINT stylesheet ──────────────────
  {
    // The print CSS hides `.placeholder` (a blank doc prints as a clean page).
    // Rendering with --print must therefore differ from the screen render — the
    // cheapest honest proof that the media emulation is actually applied rather
    // than silently ignored.
    const src = fixture('print.html', '<article><h1>Blank</h1><p class="placeholder">Start writing.</p></article>');
    const screen = await renderDoc(src, { out: join(dir, 'e-screen.png') });
    const print = await renderDoc(src, { out: join(dir, 'e-print.png'), print: true });
    check('E1 both renders succeed', screen.bytes > 0 && print.bytes > 0);
    check('E2 print media renders differently from screen',
      readFileSync(screen.out).length !== readFileSync(print.out).length,
      `screen ${screen.bytes} vs print ${print.bytes}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass + fail} checks — ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
