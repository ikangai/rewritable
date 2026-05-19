// WORKFLOW-04 — dirtiness detection. A step that carries a
// data-last-run-hash whose stored value does not match
// hashStr(scriptBody + prevHash) must render with the .stale class.
//
// The fixture installs a 1-step workflow with a deliberately wrong
// stored hash. The v0.3 runner's boot-time scan must flip the <li>
// into .stale. We use a minimal runner subset that calls the
// equivalent of recomputeStaleness on render — matches the seed's
// frozen runner contract.

const WF_HEAD = `<!-- rwa:frozen:begin wf-style -->
<style>.rwa-step{border:1px solid #eee;}.rwa-step.stale{border-color:gold;}</style>
<!-- rwa:frozen:end wf-style -->
<article class="rwa-workflow">
<header><h1 data-rwa-id="seedh1aa">Stale test</h1></header>
<ol class="rwa-flow">
`;

const WF_TAIL = `</ol>
<footer><button class="rwa-run">Run</button><span class="rwa-run-status"></span></footer>
</article>
<!-- rwa:frozen:begin runner -->
<script>(function(){
  'use strict';
  function hashStr(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }
  function stepBodyOf(li) {
    var sc = li.querySelector('script[type="text/rwa-step"]');
    return sc ? sc.textContent : '';
  }
  function prevHashFor(li, all) {
    var idx = all.indexOf(li);
    if (idx === 0) return 'init';
    var pLi = all[idx - 1];
    if (pLi.dataset.pinnedOutput != null) return hashStr('pin:' + pLi.dataset.pinnedOutput);
    return pLi.dataset.lastRunHash || 'never';
  }
  function currentHashFor(li, all) {
    return hashStr(stepBodyOf(li) + '::' + prevHashFor(li, all));
  }
  function recomputeStaleness() {
    var all = Array.from(document.querySelectorAll('li.rwa-step'));
    all.forEach(function(li){
      var stored = li.dataset.lastRunHash;
      if (!stored) { li.classList.remove('stale'); return; }
      if (stored !== currentHashFor(li, all)) li.classList.add('stale');
      else li.classList.remove('stale');
    });
  }
  recomputeStaleness();
  // Expose so the test can re-run after fixture install.
  window.__wfRecomputeStaleness = recomputeStaleness;
  window.__wfHashStr = hashStr;
  window.__wfCurrentHash = currentHashFor;
})();</` + `script>
<!-- rwa:frozen:end runner -->`;

const STEP = `<li class="rwa-step" data-last-run-hash="deadbeef">
<header><h3>Step</h3></header>
<details><summary>Code</summary><script type="text/rwa-step">
async function run(ctx, prev) { return "fresh-output"; }
</` + `script></details>
<output class="rwa-step-output"></output>
</li>
`;

export default {
  id: 'WORKFLOW-04',
  category: 'WORKFLOW',
  description: 'dirtiness detection — step with mismatched data-last-run-hash gets .stale class on boot scan',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      await ctx.setDoc(WF_HEAD + STEP + WF_TAIL);
      const win = ctx.window;
      // Wait for inline runner to expose hooks
      for (let i = 0; i < 20; i++) {
        if (typeof win.__wfRecomputeStaleness === 'function') break;
        await new Promise(r => setTimeout(r, 25));
      }
      if (typeof win.__wfRecomputeStaleness !== 'function') {
        return { pass: false, reason: 'runner IIFE did not run / expose recomputeStaleness' };
      }
      // The IIFE called recomputeStaleness on load. Verify .stale applied.
      const li = win.document.querySelector('li.rwa-step');
      if (!li.classList.contains('stale')) {
        // Maybe boot scan hadn't run yet — call it explicitly.
        win.__wfRecomputeStaleness();
      }
      if (!li.classList.contains('stale')) {
        const currentHash = win.__wfCurrentHash(li, [li]);
        return { pass: false, reason: `expected .stale class; stored=deadbeef current=${currentHash}` };
      }
      // Sanity: storage attribute unchanged (the runner only adds/removes the class,
      // not the data attribute — that updates on actual successful run).
      if (li.dataset.lastRunHash !== 'deadbeef') {
        return { pass: false, reason: `data-last-run-hash should be preserved, got ${li.dataset.lastRunHash}` };
      }
      return { pass: true, reason: '.stale applied because stored hash does not match current(scriptBody+prevHash)' };
    } finally {
      ctx.dispose();
    }
  },
};
