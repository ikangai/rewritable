// GENRE-05 — real-time clock; user edits the clock's CSS color; after
// re-render the clock is still ticking, current time is reasonable.
//
// In jsdom, runScripts:'dangerously' runs script content. The runtime's
// renderDoc replaces script elements so they re-execute. We test that
// the post-edit doc still has a #clock element with the script wired up.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<style>#clock { color: #b8ff57; font: 32px monospace; }</style>
<div id="clock">--:--:--</div>
<script>
(function() {
  function tick() { document.getElementById('clock').textContent = new Date().toLocaleTimeString('en-US'); }
  tick(); setInterval(tick, 1000);
})();
</script>`;

export default {
  id: 'GENRE-05',
  category: 'GENRE',
  tag: 'content',
  description: 'edit clock CSS color; clock element + script preserved',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Change the clock color from #b8ff57 to #ff5757. Don\'t touch the clock element or the script.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'color: #b8ff57', replace: 'color: #ff5757' }] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => (d.querySelector('style')?.textContent || '').includes('color: #ff5757'), label: 'color updated' },
    { selector: '#clock', label: 'clock element preserved' },
    { selector: 'script', label: 'script preserved' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'color: #b8ff57');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
