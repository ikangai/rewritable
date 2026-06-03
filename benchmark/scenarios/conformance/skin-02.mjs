// SKIN-02 — the ✦ gallery chrome: clicking the skin button opens the panel with
// one swatch per preset + a reset; clicking a swatch dispatches applySkin (one
// deterministic commit, the block lands in the doc); reopening marks the active
// card from the live data-rwa-skin. Verifies the runtime chrome wiring end-to-end
// in jsdom — no real browser needed. WHY: the gallery is the discoverability
// surface (the whole point of skins for non-power-users); a broken button
// handler, panel build, or swatch dispatch would silently strand them.
const tick = () => new Promise(r => setTimeout(r, 0));

export default {
  id: 'SKIN-02',
  category: 'SKIN',
  weight: 1,
  description: 'gallery: ✦ opens the panel, swatch click applies, active card reflects state',

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      const w = ctx.window, d = w.document;
      const btn = d.getElementById('rwa-st-skin');
      if (!btn) return { pass: false, reason: 'no ✦ skin button in the chrome row' };

      btn.click(); // → openSkinPanel
      const panel = d.getElementById('rwa-skin-panel');
      if (!panel || !panel.classList.contains('open')) return { pass: false, reason: 'gallery panel did not open' };

      const swatches = [...panel.querySelectorAll('.rwa-skin-sw')];
      if (swatches.length < 5) return { pass: false, reason: `expected >=5 swatches, got ${swatches.length}` };
      if (!panel.querySelector('[data-skin-reset]')) return { pass: false, reason: 'no reset affordance' };

      const target = swatches.find(b => b.getAttribute('data-skin') === 'editorial-serif');
      if (!target) return { pass: false, reason: 'no editorial-serif swatch' };

      target.click(); // → applySkin('editorial-serif') (async, not awaited by the handler)
      let doc = '';
      for (let i = 0; i < 50; i++) { await tick(); doc = await ctx.getDoc(); if (/data-rwa-skin="editorial-serif"/.test(doc)) break; }
      if (!/data-rwa-skin="editorial-serif"/.test(doc)) return { pass: false, reason: 'swatch click did not apply the skin' };

      // reopen → the active card is marked from the live skin
      btn.click();
      const active = d.querySelector('#rwa-skin-panel .rwa-skin-sw[aria-current="true"]');
      if (!active || active.getAttribute('data-skin') !== 'editorial-serif') {
        return { pass: false, reason: 'active card not marked from the applied skin' };
      }
      return { pass: true, reason: 'gallery renders swatches, click applies, active card reflects state' };
    } finally { ctx.dispose(); }
  },
};
