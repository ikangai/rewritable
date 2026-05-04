// GENRE-06 — press release; date line, dateline location, headline,
// subhead, body, boilerplate, contact block. User updates one statistic
// in the body; date line, contact block, and boilerplate byte-identical.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<article class="press-release">
<p class="date">FOR IMMEDIATE RELEASE — May 12, 2026</p>
<p class="dateline">PORTLAND, OREGON</p>
<h1>Northwind Logistics announces Q2 milestone</h1>
<h2 class="subhead">Throughput up 47%, emissions down 23%</h2>
<p class="body">In Q2 we recorded a STAT_THROUGHPUT_47 throughput increase of 47% over Q1.</p>
<p class="boilerplate">About Northwind Logistics: A logistics company headquartered in Portland.</p>
<address class="contact">Contact: pr@northwind.example</address>
</article>`;

export default {
  id: 'GENRE-06',
  category: 'GENRE',
  description: 'update one body stat; date/contact/boilerplate byte-identical',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Update the throughput statistic in the body from "47%" to "52%". Leave date, contact, boilerplate, and subhead alone.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'STAT_THROUGHPUT_47 throughput increase of 47% over Q1.', replace: 'throughput increase of 52% over Q1.' }] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { selector: '.body', textContains: '52%', label: 'body stat updated' },
    { selector: '.date', textContains: 'May 12, 2026', label: 'date byte-identical' },
    { selector: '.contact', textContains: 'pr@northwind', label: 'contact byte-identical' },
    { selector: '.boilerplate', textContains: 'A logistics company', label: 'boilerplate byte-identical' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'STAT_THROUGHPUT_47 throughput increase of 47% over Q1.');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
