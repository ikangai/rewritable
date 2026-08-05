// Real-browser lane (#9) — the assertions jsdom structurally cannot make.
//
// 42 of 45 root test files run in jsdom, which has no layout, no real pointer or touch input, and
// no rendering. That shape of testing reports impressive numbers while being blind to a whole class
// of defect, and it demonstrably was: the docked lens card was retired to `display:none` and every
// suite stayed green, because jsdom cannot tell a visible element from a hidden one. #10 (the whole
// document prompt losing its only tap target) is the same blind spot.
//
// So this lane deliberately does NOT re-test logic. Everything provable in jsdom stays in jsdom.
// The rule for adding a case here: if jsdom could assert it, it does not belong.
//
// Zero dependencies — see cdp.mjs for why. Run: node tests/browser/run.mjs
// A missing Chrome SKIPS loudly and exits 0, unless REQUIRE_BROWSER=1 (CI), where it FAILS —
// a lane that silently skips itself is worse than no lane.

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
    console.error(`\n✗ browser lane REQUIRED but ${msg}`);
    process.exit(1);
  }
  console.log(`\n⚠ SKIPPED: browser lane — ${msg}.`);
  console.log('  This lane covers layout and real input, which jsdom cannot. Set REQUIRE_BROWSER=1 to make a missing browser fail.');
  process.exit(0);
}

// Build a real container on disk and open it from file:// — the origin containers actually run at.
function buildContainer(dir, kind, name) {
  const ov = kindOverrides(kind);
  let html = readFileSync(join(REPO, 'seeds', 'rewritable.html'), 'utf8');
  html = applySeedSubs(html, {
    uuid: randomUUID(), title: name, fileMeta: name, productKind: kind,
    lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder,
    productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor,
  });
  html = replaceInlineDoc(html, ov.body);
  const p = join(dir, name);
  writeFileSync(p, html, 'utf8');
  return 'file://' + p;
}

const dir = mkdtempSync(join(tmpdir(), 'rwa-browser-'));
let page;
try {
  const docUrl = buildContainer(dir, 'document', 'doc.html');
  page = await launch({ url: docUrl });
  await page.eval(() => new Promise((r) => setTimeout(r, 800)));

  console.log('\n== B1: the container boots in a real browser ==');
  {
    const booted = await page.eval(() => !!window.runtime);
    check('runtime is exposed after a real boot', booted === true);
    const mode = await page.eval(() => window.runtime.mode);
    check('a document kind boots edit-first', mode === 'edit');
    const errs = page.consoleErrors.filter((e) => !/favicon/i.test(e));
    check('boot produced no console errors', errs.length === 0);
    if (errs.length) console.log('       ' + errs.slice(0, 3).join(' | '));
  }

  // The class of defect jsdom is blind to. jsdom reports elements as present regardless of CSS, so
  // an element retired to display:none stays "there" forever from its point of view.
  console.log('\n== B2: layout truth — visible vs merely present ==');
  {
    const lens = await page.eval(() => {
      const el = document.getElementById('rwa-lens');
      if (!el) return { present: false };
      const r = el.getBoundingClientRect();
      return { present: true, w: r.width, h: r.height };
    });
    check('the retired lens card is still in the DOM (jsdom sees this much)', lens.present === true);
    check('but it occupies NO layout — the retirement is real', lens.w === 0 && lens.h === 0);

    const ask = await page.eval(() => {
      const el = document.getElementById('rwa-st-ask');
      if (!el) return { present: false };
      const r = el.getBoundingClientRect();
      return { present: true, w: r.width, h: r.height };
    });
    check('the "/" ask button exists (#10)', ask.present === true);
    check('and it is ACTUALLY VISIBLE — non-zero box', ask.w > 0 && ask.h > 0);
  }

  console.log('\n== B3: a real mouse click reaches the prompt (#10) ==');
  {
    const box = await page.eval(() => {
      const r = document.getElementById('rwa-st-ask').getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    await page.clickAt(box.x, box.y);
    const open = await page.eval(() => document.getElementById('rwa-pal').classList.contains('open'));
    check('clicking "/" at real coordinates opens the pal', open === true);
    const visible = await page.eval(() => {
      const r = document.getElementById('rwa-pal').getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    check('the pal is actually rendered, not just class-toggled', visible === true);
    const focused = await page.eval(() => document.activeElement && document.activeElement.id);
    check('focus lands in the prompt input', focused === 'rwa-pal-inp');
    // Close it the way a person does. NOT via window.__closePal: the seed's `__*` hooks are
    // jsdom-gated, so in a real browser they are undefined and calling them silently does nothing —
    // which is exactly what made B4 look like a product bug on the first run of this lane.
    await page.pressKey('Escape', 'Escape', 27);
    const closed = await page.eval(() => !document.getElementById('rwa-pal').classList.contains('open'));
    check('Escape closes the pal (real key, no test hook)', closed === true);
  }

  console.log('\n== B4: a real TOUCH tap reaches the prompt (#10) ==');
  {
    // jsdom cannot dispatch touch at all, so this path had no coverage of any kind.
    await page.enableTouch();
    const box = await page.eval(() => {
      const r = document.getElementById('rwa-st-ask').getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    await page.tapAt(box.x, box.y);
    const open = await page.eval(() => document.getElementById('rwa-pal').classList.contains('open'));
    check('tapping "/" with a real touch event opens the pal', open === true);
  }

  console.log('\n== B5: a view-first kind renders its reading view ==');
  {
    const presUrl = buildContainer(dir, 'presentation', 'deck.html');
    await page.goto(presUrl);
    await page.eval(() => new Promise((r) => setTimeout(r, 800)));
    const mode = await page.eval(() => window.runtime && window.runtime.mode);
    check('presentation boots in Document (reading) mode', mode === 'document');
    const seg = await page.eval(() => {
      const v = document.getElementById('rwa-st-view');
      const r = v ? v.getBoundingClientRect() : null;
      return r ? { on: v.classList.contains('on'), w: r.width } : null;
    });
    check('the View segment is visibly active', !!seg && seg.on === true && seg.w > 0);
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
