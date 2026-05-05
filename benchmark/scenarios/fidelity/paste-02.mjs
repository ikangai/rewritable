// PASTE-02 — paste a CSV table verbatim. Tests preservation of whitespace
// and structure in tabular data; the model must not reformat into a <table>.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const CSV_CONTENT = `region,sales_q1,sales_q2,sales_q3,sales_q4,growth_yoy
EMEA,4823,5102,5417,5894,0.142
APAC,7651,8203,8902,9617,0.196
NAM,11342,11891,12234,12876,0.087
LATAM,2104,2287,2456,2693,0.118
MEA,1567,1689,1812,1978,0.143
ANZ,3245,3398,3567,3812,0.097`;

const FIXTURE = `<article>
<h1>Q4 sales review</h1>
<p>Regional revenue figures, year-end totals.</p>
<div id="data-block">CSV_PLACEHOLDER_PASTE_02</div>
<p>Notes on year-over-year growth follow.</p>
</article>`;

const PASTE_BLOCK = `<pre>${CSV_CONTENT}</pre>`;

export default {
  id: 'PASTE-02',
  category: 'PASTE',
  tag: 'paste',
  description: 'paste CSV verbatim into <pre>; whitespace and rows byte-identical',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: `The user pasted this CSV. Embed it verbatim inside a <pre> element at the marked location. Don't convert to <table>, don't reformat, don't add columns or rows. Replace CSV_PLACEHOLDER_PASTE_02 with the pre-wrapped CSV.\n\n${CSV_CONTENT}`,
  stub: () => stubModel([
    { name: 'apply_edits', envelope: {
      version: 'rwa-edit/1',
      edits: [{ find: 'CSV_PLACEHOLDER_PASTE_02', replace: PASTE_BLOCK }],
    } },
  ]),
  success: async (doc) => {
    const out = runSelectorOracle(doc, [
      { selector: '#data-block pre', label: 'pre wrapper present' },
      { fn: (d) => !d.body.textContent.includes('CSV_PLACEHOLDER_PASTE_02'), label: 'marker removed' },
      { fn: (d) => d.querySelector('#data-block pre')?.textContent === CSV_CONTENT, label: 'CSV textContent byte-identical' },
      { fn: (d) => d.querySelector('table') === null, label: 'no <table> introduced (verbatim, not reformatted)' },
    ]);
    out.total++;
    const byteIdentical = doc.includes(PASTE_BLOCK);
    out.results.push({ label: 'CSV block present byte-identical in raw doc', ok: byteIdentical, reason: byteIdentical ? 'byte-identical' : 'block missing or altered' });
    if (byteIdentical) out.passed++;
    out.score = out.passed === out.total ? 2 : (out.passed > 0 ? 1 : 0);
    return out;
  },
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'CSV_PLACEHOLDER_PASTE_02');
    if (!region) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
