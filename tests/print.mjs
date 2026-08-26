// Print contract pins (2026-08-26).
//
// WHY this exists: the print stylesheet and the system prompt teach the same
// four-class print vocabulary (print-break / print-keep / no-print /
// print-only). Those are two sites in one file that can drift independently —
// a rename in the CSS that skips the prompt leaves the agent teaching classes
// that no longer exist, which is invisible until someone prints. This file is
// the cross-site gate, plus pins for the print-layout fixes that shipped from
// the 2026-08-26 print audit (root-wrapper reset, fit-to-width defusal, 12pt
// baseline), which jsdom cannot exercise (no paged media) but CAN pin as text.
//
// Deliberately parser-free text assertions over the seed source: the rules
// live in the FROZEN head, outside INLINE_DOC, so no boot is needed and the
// pins hold for every emitted container.
//
// Run:  (cd tests && node print.mjs)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const seed = fs.readFileSync(path.join(__dirname, '..', 'seeds', 'rewritable.html'), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok) => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}`);
  ok ? pass++ : fail++;
};

// ── The print block itself ──────────────────────────────────────────────────
const printBlock = (() => {
  const start = seed.indexOf('@media print{');
  if (start < 0) return '';
  // The block ends before the </style> that closes the bootstrap stylesheet;
  // a coarse slice is fine for substring pins.
  const end = seed.indexOf('</style>', start);
  return seed.slice(start, end);
})();
check('seed has an @media print block', printBlock.length > 0);
check('@page owns the paper margin', /@page\{margin:18mm;\}/.test(seed));

// ── 2026-08-26 print-audit fixes ────────────────────────────────────────────
check('root <article> card reset prints clean (pre-existing policy)',
  printBlock.includes(':where(#rwa-doc-mount) article{margin:0 auto!important;padding:0!important;max-width:none!important'));
check('root-level wrapper (<div>/<main>/<section>) joins the card-becomes-page reset',
  printBlock.includes(':where(#rwa-doc-mount)>div,:where(#rwa-doc-mount)>main,:where(#rwa-doc-mount)>section{margin:0 auto!important;padding:0!important;max-width:none!important'));
check('root container pinned to the 12pt print baseline',
  printBlock.includes(':where(#rwa-doc-mount)>article,:where(#rwa-doc-mount)>div,:where(#rwa-doc-mount)>main,:where(#rwa-doc-mount)>section{font-size:12pt!important;}'));
check('table cells wrap on paper (fit-to-width shrink defused)',
  printBlock.includes(':where(#rwa-doc-mount) td,:where(#rwa-doc-mount) th{white-space:normal!important;overflow-wrap:anywhere;}'));
check('tables cap at page width', printBlock.includes(':where(#rwa-doc-mount) table{max-width:100%!important;}'));
check('images cap at page width, ratio kept',
  printBlock.includes(':where(#rwa-doc-mount) img{max-width:100%!important;height:auto!important;}'));

// ── Print vocabulary: CSS half ──────────────────────────────────────────────
check('.print-break forces a page break in print',
  printBlock.includes('.print-break{break-before:page!important;page-break-before:always!important;}'));
check('.print-keep keeps a block on one page in print',
  printBlock.includes('.print-keep{break-inside:avoid!important;page-break-inside:avoid!important;}'));
check('.no-print hides in print', printBlock.includes('.no-print{display:none!important;}'));
check('.print-only reverts to visible in print', printBlock.includes('.print-only{display:revert!important;}'));
check('.print-only hidden on screen (outside the print block)',
  seed.indexOf(':where(#rwa-doc-mount) .print-only{display:none;}') > 0 &&
  seed.indexOf(':where(#rwa-doc-mount) .print-only{display:none;}') < seed.indexOf('@media print{'));

// ── Print vocabulary: prompt half (the cross-site gate) ─────────────────────
const rulesStart = seed.indexOf('rwa:extract:begin SYSTEM_PROMPT_RULES');
const rulesEnd = seed.indexOf('rwa:extract:end SYSTEM_PROMPT_RULES');
const rules = rulesStart >= 0 && rulesEnd > rulesStart ? seed.slice(rulesStart, rulesEnd) : '';
check('SYSTEM_PROMPT_RULES extract markers present', rules.length > 0);
for (const cls of ['print-break', 'print-keep', 'no-print', 'print-only']) {
  check(`prompt teaches class "${cls}"`, rules.includes(`class="${cls}"`));
}
check('prompt teaches <thead> for repeating table headers', rules.includes('<thead>'));
check('prompt forbids simulating running headers with position:fixed', rules.includes('position:fixed'));

// Every class the prompt teaches must have a rule in the print block — the
// direction a rename is most likely to miss.
for (const cls of ['print-break', 'print-keep', 'no-print', 'print-only']) {
  check(`prompt-taught class "${cls}" has a print-CSS rule`, printBlock.includes(`.${cls}{`));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
