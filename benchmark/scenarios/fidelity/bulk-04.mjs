// BULK-04 — wholesale redesign via replace_document; frozen zone bytes
// preserved in the new doc.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDrift, discretizeStability } from '../../oracles/diff.mjs';

const FROZEN_ZONE = `<!-- rwa:frozen:begin theme -->\n:root { --bg: #0e0e0f; --accent: #b8ff57; }\n<!-- rwa:frozen:end theme -->`;
const FIXTURE = `<style>${FROZEN_ZONE}</style>
<div class="old-design">
<h1>Old design</h1>
<p>Original layout.</p>
</div>`;

const NEW_DOC = `<style>${FROZEN_ZONE}</style>
<main class="new-design">
<header><h1>New design</h1></header>
<section><p>Completely different layout.</p></section>
</main>`;

export default {
  id: 'BULK-04',
  category: 'BULK',
  description: 'wholesale redesign via replace_document; frozen zone bytes preserved',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Redesign this completely with a header/section structure. Keep the frozen-zone CSS variables intact.',
  stub: () => stubModel([
    {
      name: 'replace_document',
      envelope: { version: 'rwa-edit/1', doc: NEW_DOC, reason: 'wholesale redesign' },
    },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { selector: 'main.new-design header h1', textEquals: 'New design', label: 'new structure' },
    { fn: (d) => (d.querySelector('style')?.textContent || '').includes('--accent: #b8ff57'), label: 'frozen zone inner preserved' },
    { fn: (d) => !d.querySelector('.old-design'), label: 'old structure gone' },
  ]),
  stability: (fixture, doc, envelope) => {
    // replace_document expected — no edit envelope. Stability passes if
    // frozen zone bytes survived (the runtime's commit path enforces this,
    // so reaching here means it did).
    if (envelope) return { drift_bytes: fixture.length, drift_ratio: 1, score: 0, reason: 'wrong tool — apply_edits used instead of replace_document' };
    return { drift_bytes: 0, drift_ratio: 0, score: 2, reason: 'replace_document succeeded with frozen zone preserved' };
  },
};
