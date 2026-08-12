// Print stylesheet contract (first pinned 2026-08-11).
//
// WHY this matters: "save as PDF" is a primary exit for a rewritable — the
// exported PDF is what recipients see, and print bugs are invisible to every
// other test (jsdom does not evaluate @media print; the browser lane does not
// print). The seed's print philosophy: THE CARD BECOMES THE PAGE. Documents
// style their root <article> as a screen card (max-width, padding, shadow,
// border on a gray desk); in print that chrome must vanish or it renders as a
// hard hairline frame around the content on every page —
// print-color-adjust:exact forces shadows/borders to print. Reported live
// 2026-08-11 (steuerberater.html); root cause was the article reset covering
// margin/padding/max-width but not box-shadow/border.
//
// jsdom cannot COMPUTE print styles, so this pins the stylesheet TEXT — the
// real-browser proof lives in the report's before/after PDFs. If you touch the
// print block, keep every assertion here true or update the contract visibly.
//
// Run:  (cd tests && node print-css.mjs)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const seed = fs.readFileSync(path.join(__dirname, '..', 'seeds', 'rewritable.html'), 'utf8');

let pass = 0, fail = 0;
const check = (label, cond) => {
  if (cond) { pass++; console.log('  OK  ', label); }
  else      { fail++; console.log('  FAIL', label); }
};

console.log('== Print stylesheet contract ==');

// Isolate the main @media print block (the one hiding the runtime).
const start = seed.indexOf('@media print{');
check('a @media print block exists', start >= 0);
const block = seed.slice(start, seed.indexOf('\n}', start) + 2);

check('runtime chrome never prints', /#rwa-runtime\{display:none!important;\}/.test(block));
check('the reparented lens never prints (releaseAnchor escapes #rwa-runtime)', /#rwa-lens\{display:none!important;\}/.test(block));
check('page prints black-on-white regardless of theme', /body\{[^}]*background:#fff!important/.test(block));
check('colors print exactly (backgrounds/fills are content)', /print-color-adjust:exact/.test(block));

// The card-becomes-the-page reset on the ROOT article. All six properties are
// one contract: the screen card's geometry AND its chrome (shadow prints as a
// hairline frame; a root-article border is card chrome since its padding is
// force-removed anyway). Inner-element borders/fills stay content.
const articleReset = block.match(/:where\(#rwa-doc-mount\) article\{([^}]*)\}/);
check('root-article print reset exists', !!articleReset);
for (const prop of ['margin:0 auto!important', 'padding:0!important', 'max-width:none!important',
                    'box-shadow:none!important', 'border:none!important', 'border-radius:0!important']) {
  check(`article reset carries ${prop.split(':')[0]}`, !!articleReset && articleReset[1].includes(prop));
}

check('@page sets the print margin', /@page\s*\{\s*margin:18mm/.test(seed));
check('blank-doc placeholder never prints', /@media print\{\.placeholder\{display:none;\}\}/.test(seed));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
