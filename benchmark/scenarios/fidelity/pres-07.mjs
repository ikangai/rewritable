// PRES-07 — financial table with caption, thead, tbody, tfoot; edit one
// line-item amount AND update tfoot total. The model must touch only two
// cells; the caption, column headers, row classes, currency formatting, and
// all other line items are byte-identical.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<table class="invoice-lines">
<caption>Invoice #2026-0419 — line items</caption>
<thead>
<tr><th class="text-left">Description</th><th class="text-right">Qty</th><th class="text-right">Unit</th><th class="text-right">Amount</th></tr>
</thead>
<tbody>
<tr class="line"><td>Consulting — January</td><td class="text-right">8</td><td class="text-right">$150.00</td><td class="text-right amt">$1,200.00</td></tr>
<tr class="line"><td>Consulting — February</td><td class="text-right">12</td><td class="text-right">$150.00</td><td class="text-right amt">$1,800.00</td></tr>
<tr class="line"><td>Hosting passthrough</td><td class="text-right">1</td><td class="text-right">$240.00</td><td class="text-right amt">$240.00</td></tr>
</tbody>
<tfoot>
<tr class="subtotal"><td colspan="3" class="text-right">Subtotal</td><td class="text-right amt">$3,240.00</td></tr>
<tr class="tax"><td colspan="3" class="text-right">VAT (19%)</td><td class="text-right amt">$615.60</td></tr>
<tr class="total"><td colspan="3" class="text-right"><strong>Total</strong></td><td class="text-right amt"><strong>$3,855.60</strong></td></tr>
</tfoot>
</table>`;

export default {
  id: 'PRES-07',
  category: 'PRES',
  tag: 'mixed',
  description: 'invoice table: update one line amount; subtotal/tax/total recompute; caption + thead + tfoot structure unchanged',
  weight: 2,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'The February consulting line is wrong: the quantity should be 10 hours, not 12, so the line amount becomes $1,500.00. Recompute Subtotal ($2,940.00), VAT 19% ($558.60), and Total ($3,498.60). Touch only the cells that change.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [
      { find: '<tr class="line"><td>Consulting — February</td><td class="text-right">12</td><td class="text-right">$150.00</td><td class="text-right amt">$1,800.00</td></tr>',
        replace: '<tr class="line"><td>Consulting — February</td><td class="text-right">10</td><td class="text-right">$150.00</td><td class="text-right amt">$1,500.00</td></tr>' },
      { find: '<tr class="subtotal"><td colspan="3" class="text-right">Subtotal</td><td class="text-right amt">$3,240.00</td></tr>',
        replace: '<tr class="subtotal"><td colspan="3" class="text-right">Subtotal</td><td class="text-right amt">$2,940.00</td></tr>' },
      { find: '<tr class="tax"><td colspan="3" class="text-right">VAT (19%)</td><td class="text-right amt">$615.60</td></tr>',
        replace: '<tr class="tax"><td colspan="3" class="text-right">VAT (19%)</td><td class="text-right amt">$558.60</td></tr>' },
      { find: '<tr class="total"><td colspan="3" class="text-right"><strong>Total</strong></td><td class="text-right amt"><strong>$3,855.60</strong></td></tr>',
        replace: '<tr class="total"><td colspan="3" class="text-right"><strong>Total</strong></td><td class="text-right amt"><strong>$3,498.60</strong></td></tr>' },
    ] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelector('caption')?.textContent === 'Invoice #2026-0419 — line items', label: 'caption preserved' },
    { fn: (d) => d.querySelectorAll('thead tr').length === 1, label: 'thead row count unchanged' },
    { fn: (d) => d.querySelectorAll('tbody tr.line').length === 3, label: 'still 3 line items' },
    { fn: (d) => d.querySelectorAll('tfoot tr').length === 3, label: 'tfoot still has subtotal/tax/total' },
    { fn: (d) => d.querySelector('tfoot tr.subtotal td.amt')?.textContent === '$2,940.00', label: 'subtotal updated' },
    { fn: (d) => d.querySelector('tfoot tr.tax td.amt')?.textContent === '$558.60', label: 'tax updated' },
    { fn: (d) => d.querySelector('tfoot tr.total td.amt strong')?.textContent === '$3,498.60', label: 'total updated and still wrapped in <strong>' },
    { fn: (d) => {
      // Verify the math is internally consistent: sum(line amounts) == subtotal, subtotal*1.19 ≈ total
      const parse = s => Number((s || '').replace(/[^0-9.]/g, ''));
      const lines = Array.from(d.querySelectorAll('tbody tr.line td.amt')).map(t => parse(t.textContent));
      const sub = parse(d.querySelector('tfoot tr.subtotal td.amt')?.textContent);
      const total = parse(d.querySelector('tfoot tr.total td.amt strong')?.textContent);
      const lineSum = lines.reduce((a, b) => a + b, 0);
      return Math.abs(lineSum - sub) < 0.01 && Math.abs(total - sub * 1.19) < 0.02;
    }, label: 'math is internally consistent (line sum = subtotal; subtotal × 1.19 ≈ total)' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const anchors = [
      '<tr class="line"><td>Consulting — February</td><td class="text-right">12</td><td class="text-right">$150.00</td><td class="text-right amt">$1,800.00</td></tr>',
      '<tr class="subtotal"><td colspan="3" class="text-right">Subtotal</td><td class="text-right amt">$3,240.00</td></tr>',
      '<tr class="tax"><td colspan="3" class="text-right">VAT (19%)</td><td class="text-right amt">$615.60</td></tr>',
      '<tr class="total"><td colspan="3" class="text-right"><strong>Total</strong></td><td class="text-right amt"><strong>$3,855.60</strong></td></tr>',
    ];
    const regions = anchors.map(a => regionOfLiteral(fixture, a)).filter(Boolean);
    const d = computeDriftFromEdits(fixture, envelope.edits, regions);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
