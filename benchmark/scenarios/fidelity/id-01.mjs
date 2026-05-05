// ID-01 — element id attributes on unedited elements byte-identical;
// edited element's id unchanged unless prompt asked.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<article>
<section id="intro"><p>Intro text.</p></section>
<section id="body"><p>BODY_TEXT Initial body.</p></section>
<section id="outro"><p>Outro text.</p></section>
</article>`;

export default {
  id: 'ID-01',
  category: 'ID',
  tag: 'content',
  description: 'edit body text; section ids byte-identical',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Rewrite the body section\'s paragraph text. Don\'t change any section ids.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'BODY_TEXT Initial body.', replace: 'Updated body content.' }] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { selector: '#intro', label: '#intro present' },
    { selector: '#body', label: '#body present' },
    { selector: '#outro', label: '#outro present' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'BODY_TEXT Initial body.');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
