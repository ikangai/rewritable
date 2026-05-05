// GENRE-01 — form-heavy doc (tax-return shape): 30 input fields; user
// partially fills 25; trigger an edit that renames the legend on field 7's
// fieldset; field values for the other 29 persist; every <label for=>
// reference still resolves.
//
// We can't actually "fill" inputs and have them persist via apply_edits
// alone (DOM input.value isn't in the static HTML). Instead, this test
// asserts the structural property: edit a fieldset legend; all 30 fields
// retain their id+name attributes and label-for pairings.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

function buildFixture() {
  const fields = [];
  for (let i = 1; i <= 30; i++) {
    fields.push(`<label for="f${i}">Field ${i}</label><input id="f${i}" name="f${i}" type="text">`);
  }
  return `<form>
<fieldset id="fs7"><legend>OLD_LEGEND_7 Field 7 group</legend>
${fields.join('\n')}
</fieldset>
</form>`;
}

export default {
  id: 'GENRE-01',
  category: 'GENRE',
  tag: 'content',
  description: 'rename fieldset legend; 30 input id/label-for pairings preserved',
  weight: 1,
  N: 3,
  fixtureContent: buildFixture(),
  prompt: 'Rename the fieldset legend "OLD_LEGEND_7 Field 7 group" to "Updated group title". Don\'t touch any input or label elements.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'OLD_LEGEND_7 Field 7 group', replace: 'Updated group title' }] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { selector: 'legend', textEquals: 'Updated group title', label: 'legend renamed' },
    { fn: (d) => d.querySelectorAll('input').length === 30, label: '30 inputs preserved' },
    { fn: (d) => d.querySelectorAll('label').length === 30, label: '30 labels preserved' },
    { fn: (d) => Array.from(d.querySelectorAll('label')).every(l => {
      const forId = l.getAttribute('for');
      return forId && d.querySelector('#' + forId);
    }), label: 'every label-for resolves' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'OLD_LEGEND_7 Field 7 group');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
