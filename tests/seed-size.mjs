// Seed byte budget — the ratchet on runtime growth.
//
// WHY this matters: every rewritable carries the full runtime forever — seed
// bytes are a per-document, per-copy, per-recipient tax, and the process that
// builds this repo only ever ADDS (agents ship increments; deletion has no
// green checkmark). The seed grew 112 KB → 654 KB between 2026-05-15 and
// 2026-08-08 with no gate; retired UI (the docked lens card) still ships in
// every document. This test is the counter-pressure: growth beyond the budget
// must be a DELIBERATE diff to the number below — with the byte cost argued in
// the commit — never a silent drift.
//
// If you hit this limit: first look for something to delete or inline more
// cheaply; only then raise the budget, in its own visible change.
//
// Run:  (cd tests && node seed-size.mjs)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySeedSubs, kindOverrides } from '../cli/src/seed.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(__dirname, '..', 'seeds', 'rewritable.html');

// 700 KiB. Set 2026-08-10 with the seed at 656,355 bytes (~91% of budget) —
// deliberately snug: about one more quarter's unexamined growth, not three.
const BUDGET_BYTES = 700 * 1024;

let pass = 0, fail = 0;
const check = (label, cond) => {
  if (cond) { pass++; console.log('  OK  ', label); }
  else      { fail++; console.log('  FAIL', label); }
};

console.log('== Seed byte budget ==');

const bytes = fs.statSync(SEED).size;
const pct = ((bytes / BUDGET_BYTES) * 100).toFixed(1);
console.log(`  seed: ${bytes.toLocaleString('en-US')} bytes — ${pct}% of the ${BUDGET_BYTES.toLocaleString('en-US')}-byte budget`);

check(`seed stays within its byte budget (${bytes} <= ${BUDGET_BYTES})`, bytes <= BUDGET_BYTES);

// Early warning at 95% so the deliberate conversation happens BEFORE the gate
// blocks someone's unrelated change.
if (bytes <= BUDGET_BYTES && bytes > BUDGET_BYTES * 0.95) {
  console.log('  WARN  seed is above 95% of budget — plan a deletion pass or a deliberate budget raise now');
}

// What users actually carry: an EMITTED document, which prunes foreign-kind
// SYSTEM_PROMPTS (2026-08-12). The source seed keeps every kind — this pins
// that the per-document tax stays meaningfully below the template.
const ov = kindOverrides('document');
const emitted = applySeedSubs(fs.readFileSync(SEED, 'utf8'), {
  uuid: '00000000-0000-4000-8000-000000000000', title: 'S', fileMeta: 's.html', productKind: 'document',
  lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder,
  productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor,
});
const emittedBytes = Buffer.byteLength(emitted);
console.log(`  emitted document: ${emittedBytes.toLocaleString('en-US')} bytes (${(bytes - emittedBytes).toLocaleString('en-US')} pruned at emission)`);
check('an emitted document is at least 10 KB lighter than the template', bytes - emittedBytes >= 10 * 1024);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
