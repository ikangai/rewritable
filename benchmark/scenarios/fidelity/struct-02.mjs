// STRUCT-02 — for_each_match: append a <footer> to every <section>.
// Exercises iteration over a class of structural elements. DSL form would
// be a single op like `append_to_each(selector: 'section', content: ...)`;
// today the stub enumerates the three section anchors.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const S1 = '<section id="s1"><h2>Alpha</h2><p>Alpha body.</p></section>';
const S2 = '<section id="s2"><h2>Beta</h2><p>Beta body.</p></section>';
const S3 = '<section id="s3"><h2>Gamma</h2><p>Gamma body.</p></section>';

const FOOTER = '<footer class="section-footer">—</footer>';

const FIXTURE = `<article>
<h1>Sections</h1>
${S1}
${S2}
${S3}
</article>`;

export default {
  id: 'STRUCT-02',
  category: 'STRUCT',
  tag: 'structural_regular',
  description: 'for_each_match: append <footer class="section-footer"> inside every <section>',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Append a <footer class="section-footer">—</footer> to the inside-end of every <section>, just before its closing </section> tag. Three sections exist; each gets the same footer. Body content stays unchanged.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: {
      version: 'rwa-edit/1',
      edits: [
        { find: S1, replace: S1.replace('</section>', `${FOOTER}</section>`) },
        { find: S2, replace: S2.replace('</section>', `${FOOTER}</section>`) },
        { find: S3, replace: S3.replace('</section>', `${FOOTER}</section>`) },
      ],
    } },
  ]),
  expectedDslPlan: {
    version: 'rwa-edit-dsl/1',
    ops: [
      { op: 'replace', find: S1, replace: S1.replace('</section>', `${FOOTER}</section>`) },
      { op: 'replace', find: S2, replace: S2.replace('</section>', `${FOOTER}</section>`) },
      { op: 'replace', find: S3, replace: S3.replace('</section>', `${FOOTER}</section>`) },
    ],
  },
  success: async (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelectorAll('section > footer.section-footer').length === 3, label: '3 sections each got a footer' },
    { fn: (d) => d.querySelectorAll('article > section').length === 3, label: 'still 3 sections (no extras introduced)' },
    { fn: (d) => d.querySelector('#s1 > p')?.textContent === 'Alpha body.', label: 's1 body preserved' },
    { fn: (d) => d.querySelector('#s2 > p')?.textContent === 'Beta body.', label: 's2 body preserved' },
    { fn: (d) => d.querySelector('#s3 > p')?.textContent === 'Gamma body.', label: 's3 body preserved' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const regions = [
      regionOfLiteral(fixture, S1),
      regionOfLiteral(fixture, S2),
      regionOfLiteral(fixture, S3),
    ].filter(Boolean);
    const d = computeDriftFromEdits(fixture, envelope.edits, regions);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
