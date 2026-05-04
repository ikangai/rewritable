// ID-04 — <label for="email"> paired with <input id="email"> — both
// attributes survive a layout edit elsewhere.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<form>
<label for="email">Email</label>
<input id="email" type="email" name="email">
<p class="layout-note">LAYOUT_TEXT Original layout note.</p>
</form>`;

export default {
  id: 'ID-04',
  category: 'ID',
  description: 'layout edit elsewhere; label/input id pairing intact',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Rewrite the layout note paragraph. Don\'t touch the form fields.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'LAYOUT_TEXT Original layout note.', replace: 'Tightened layout note.' }] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { selector: 'label[for="email"]', textEquals: 'Email', label: 'label for=email present' },
    { selector: 'input#email[type="email"]', label: 'input#email present' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'LAYOUT_TEXT Original layout note.');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
