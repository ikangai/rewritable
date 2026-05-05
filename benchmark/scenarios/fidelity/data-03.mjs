// DATA-03 — SVG with referenced gradients (url(#grad1)) + <defs>; edit a
// path's d attribute; gradient ref still resolves.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<svg viewBox="0 0 100 100">
<defs><linearGradient id="grad1"><stop offset="0%" stop-color="#fff"/><stop offset="100%" stop-color="#000"/></linearGradient></defs>
<path id="p1" d="M 10 10 L 90 10 L 50 90 Z" fill="url(#grad1)"/>
</svg>`;

export default {
  id: 'DATA-03',
  category: 'DATA',
  tag: 'content',
  description: 'edit path d attribute; <defs> gradient + ref preserved',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Change the path d attribute to a square path. Keep the gradient defs and the fill="url(#grad1)" reference intact.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{
      find: 'd="M 10 10 L 90 10 L 50 90 Z"',
      replace: 'd="M 10 10 L 90 10 L 90 90 L 10 90 Z"',
    }] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { selector: 'svg defs linearGradient#grad1', label: 'gradient defs preserved' },
    { selector: 'svg path[fill="url(#grad1)"]', label: 'gradient reference preserved' },
    { fn: (d) => d.querySelector('svg path')?.getAttribute('d') === 'M 10 10 L 90 10 L 90 90 L 10 90 Z', label: 'path d updated' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'd="M 10 10 L 90 10 L 50 90 Z"');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
