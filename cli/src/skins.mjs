// The canonical preset library — the SINGLE SOURCE the CLI reads skins from
// (and, later, the runtime gallery + service `/import` mirror, pinned by test).
// Zero-dep, pure data, so the in-package CLI reads it offline and a mirror can
// embed just the bytes. See docs/plans/2026-06-03-skinning-design.md.
//
// A skin's `theme` is ONE self-contained `<style data-rwa-skin="NAME">` block:
// CSS-variable + element rules scoped to `#rwa-doc-mount` (NOT `:root`, so the
// runtime chrome keeps the frozen light palette — a dark skin re-tints only the
// document). System fonts only; no web fonts, no external refs (self-contained).
//
// v1 is deterministic THEME-ONLY: the blocks below carry no `sk-*` L1 hook
// rules — those land with the always-on content-aware restyle (v2), when the
// markup pass actually attaches the hook classes. Keeping v1 hook-free avoids
// shipping dead CSS. Values mirror docs/plans/2026-06-03-skinning-design.md
// (Preset Library), re-scoped from the illustrative `.rwa-skin-NAME` form to the
// canonical `#rwa-doc-mount` model.

export const SKINS = Object.freeze({
  'notion-clean': {
    name: 'notion-clean',
    label: 'Notion Clean',
    swatch: ['#ffffff', '#37352f', '#2383e2'],
    theme: `<style data-rwa-skin="notion-clean">
#rwa-doc-mount{
  --nc-ink:#37352f; --nc-soft:#6b6b6b; --nc-faint:#9b9a97; --nc-line:#ededec;
  --nc-bg:#ffffff; --nc-tint:#f7f6f3; --nc-accent:#2383e2;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  color:var(--nc-ink); line-height:1.7;
}
#rwa-doc-mount article{max-width:740px;margin:72px auto;padding:0 40px;}
#rwa-doc-mount h1{font-size:2.5rem;font-weight:700;letter-spacing:-.02em;line-height:1.15;margin:1.4em 0 .3em;color:var(--nc-ink);}
#rwa-doc-mount h2{font-size:1.5rem;font-weight:600;letter-spacing:-.01em;margin:2em 0 .3em;color:var(--nc-ink);}
#rwa-doc-mount h3{font-size:1.2rem;font-weight:600;margin:1.6em 0 .25em;color:var(--nc-ink);}
#rwa-doc-mount h4,#rwa-doc-mount h5,#rwa-doc-mount h6{font-weight:600;color:var(--nc-soft);margin:1.3em 0 .2em;}
#rwa-doc-mount p{font-size:1rem;color:var(--nc-ink);margin:0 0 .9em;}
#rwa-doc-mount a{color:var(--nc-ink);text-decoration:underline;text-decoration-color:var(--nc-faint);text-underline-offset:3px;}
#rwa-doc-mount a:hover{text-decoration-color:var(--nc-accent);color:var(--nc-accent);}
#rwa-doc-mount ul,#rwa-doc-mount ol{margin:0 0 .9em;padding-left:1.6em;color:var(--nc-ink);}
#rwa-doc-mount li{margin:.25em 0;}
#rwa-doc-mount blockquote{margin:1.2em 0;padding:.2em 0 .2em 1em;border-left:3px solid var(--nc-ink);color:var(--nc-soft);font-style:normal;}
#rwa-doc-mount hr{border:0;border-top:1px solid var(--nc-line);margin:2.4em 0;}
#rwa-doc-mount code{font-family:'SF Mono',Menlo,Monaco,ui-monospace,monospace;font-size:.85em;background:var(--nc-tint);color:#eb5757;padding:.15em .4em;border-radius:4px;}
#rwa-doc-mount pre{background:var(--nc-tint);border:1px solid var(--nc-line);border-radius:8px;padding:16px 18px;}
#rwa-doc-mount table{font-size:.95em;}
#rwa-doc-mount th,#rwa-doc-mount td{border-bottom:1px solid var(--nc-line);padding:.55em .8em;}
#rwa-doc-mount th{background:var(--nc-tint);color:var(--nc-soft);font-weight:600;}
#rwa-doc-mount .sk-eyebrow{font-size:.8rem;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--nc-accent);margin:0 0 .4em;}
#rwa-doc-mount .sk-callout{margin:1.4em 0;padding:14px 18px;background:var(--nc-tint);border:1px solid var(--nc-line);border-radius:8px;color:var(--nc-soft);}
</style>`,
  },

  'linear-dark': {
    name: 'linear-dark',
    label: 'Linear Dark',
    swatch: ['#08090d', '#e9eaee', '#7c6cff'],
    theme: `<style data-rwa-skin="linear-dark">
#rwa-doc-mount{
  --ld-bg:#08090d; --ld-surf:#101117; --ld-line:#23252f;
  --ld-ink:#e9eaee; --ld-soft:#a0a3ad; --ld-faint:#6a6d78;
  --ld-accent:#7c6cff; --ld-accent-2:#5e6ad2;
  background:var(--ld-bg); color:var(--ld-ink);
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  line-height:1.65;
}
#rwa-doc-mount article{max-width:720px;margin:56px auto;padding:0 36px;}
#rwa-doc-mount h1{font-size:2.2rem;font-weight:600;letter-spacing:-.025em;line-height:1.15;color:#fff;margin:1.3em 0 .35em;}
#rwa-doc-mount h2{font-size:1.4rem;font-weight:600;letter-spacing:-.01em;color:var(--ld-ink);margin:2em 0 .35em;}
#rwa-doc-mount h3{font-size:1.12rem;font-weight:600;color:var(--ld-soft);margin:1.6em 0 .3em;}
#rwa-doc-mount h4,#rwa-doc-mount h5,#rwa-doc-mount h6{font-family:'SF Mono',Menlo,monospace;font-size:.78rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ld-faint);margin:1.4em 0 .3em;}
#rwa-doc-mount p{color:var(--ld-soft);margin:0 0 1em;}
#rwa-doc-mount a{color:var(--ld-accent);text-decoration:none;}
#rwa-doc-mount a:hover{color:#9b8eff;text-decoration:underline;text-underline-offset:3px;}
#rwa-doc-mount ul,#rwa-doc-mount ol{color:var(--ld-soft);padding-left:1.5em;margin:0 0 1em;}
#rwa-doc-mount li{margin:.3em 0;}
#rwa-doc-mount li::marker{color:var(--ld-faint);}
#rwa-doc-mount blockquote{margin:1.2em 0;padding:.4em 0 .4em 1em;border-left:2px solid var(--ld-accent);color:var(--ld-soft);font-style:normal;}
#rwa-doc-mount hr{border:0;border-top:1px solid var(--ld-line);margin:2.2em 0;}
#rwa-doc-mount code{font-family:'SF Mono',Menlo,monospace;font-size:.85em;background:var(--ld-surf);color:#c9c4ff;border:1px solid var(--ld-line);padding:.12em .4em;border-radius:5px;}
#rwa-doc-mount pre{background:var(--ld-surf);border:1px solid var(--ld-line);border-radius:10px;padding:16px 18px;color:var(--ld-ink);}
#rwa-doc-mount pre code{background:transparent;border:0;color:inherit;}
#rwa-doc-mount table{font-size:.92em;}
#rwa-doc-mount th{background:var(--ld-surf);color:var(--ld-soft);font-weight:600;border-bottom:1px solid var(--ld-line);padding:.55em .8em;}
#rwa-doc-mount td{border-bottom:1px solid var(--ld-line);padding:.55em .8em;color:var(--ld-soft);}
#rwa-doc-mount .sk-eyebrow{font-family:'SF Mono',Menlo,monospace;font-size:.72rem;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--ld-accent);margin:0 0 .6em;}
#rwa-doc-mount .sk-stat-row{display:flex;flex-wrap:wrap;gap:14px;margin:1.6em 0;}
#rwa-doc-mount .sk-stat{display:flex;flex-direction:column;gap:2px;padding:12px 16px;background:var(--ld-surf);border:1px solid var(--ld-line);border-radius:10px;}
#rwa-doc-mount .sk-stat b{font-size:1.45rem;font-weight:600;color:#fff;}
#rwa-doc-mount .sk-stat span{font-family:'SF Mono',Menlo,monospace;font-size:.68rem;letter-spacing:.08em;text-transform:uppercase;color:var(--ld-faint);}
</style>`,
  },

  'editorial-serif': {
    name: 'editorial-serif',
    label: 'Editorial Serif',
    swatch: ['#fbfaf7', '#1c1a17', '#9a1b1b'],
    theme: `<style data-rwa-skin="editorial-serif">
#rwa-doc-mount{
  --es-paper:#fbfaf7; --es-ink:#1c1a17; --es-soft:#4a463f; --es-faint:#857f74;
  --es-line:#e0dbd0; --es-accent:#9a1b1b; --es-rule:#c8c0b2;
  background:var(--es-paper);
  font-family:Georgia,Cambria,'Times New Roman',Times,serif;
  color:var(--es-ink); line-height:1.7;
}
#rwa-doc-mount article{max-width:680px;margin:80px auto;padding:0 36px;background:var(--es-paper);}
#rwa-doc-mount h1{font-size:3rem;font-weight:700;line-height:1.08;letter-spacing:-.01em;color:var(--es-ink);margin:.3em 0 .35em;}
#rwa-doc-mount h2{font-size:1.7rem;font-weight:700;color:var(--es-ink);margin:2em 0 .4em;line-height:1.2;}
#rwa-doc-mount h3{font-size:1.3rem;font-weight:700;font-style:italic;color:var(--es-soft);margin:1.6em 0 .3em;}
#rwa-doc-mount p{font-size:1.12rem;color:var(--es-ink);margin:0 0 1.1em;hyphens:auto;}
#rwa-doc-mount a{color:var(--es-accent);text-decoration:underline;text-underline-offset:2px;text-decoration-thickness:1px;}
#rwa-doc-mount a:hover{text-decoration-thickness:2px;}
#rwa-doc-mount ul,#rwa-doc-mount ol{color:var(--es-ink);padding-left:1.4em;margin:0 0 1.1em;}
#rwa-doc-mount li{margin:.35em 0;}
#rwa-doc-mount blockquote{margin:1.5em 0;padding:.8em 1.2em;border-left:0;border-top:1px solid var(--es-rule);border-bottom:1px solid var(--es-rule);font-size:1.45rem;line-height:1.4;font-style:italic;color:var(--es-soft);text-align:center;}
#rwa-doc-mount hr{border:0;border-top:1px solid var(--es-rule);margin:2.4em auto;width:120px;}
#rwa-doc-mount code{font-family:'SF Mono',Menlo,monospace;font-size:.85em;background:#f1ede4;color:var(--es-accent);padding:.1em .35em;border-radius:3px;}
#rwa-doc-mount pre{font-family:'SF Mono',Menlo,monospace;background:#f1ede4;border:1px solid var(--es-line);border-radius:4px;padding:14px 16px;font-size:.85rem;}
#rwa-doc-mount table{font-size:.98em;}
#rwa-doc-mount th{font-family:Georgia,serif;font-variant:small-caps;letter-spacing:.04em;color:var(--es-soft);border-bottom:2px solid var(--es-ink);background:transparent;padding:.5em .7em;}
#rwa-doc-mount td{border-bottom:1px solid var(--es-line);padding:.5em .7em;}
#rwa-doc-mount .sk-kicker{font-size:.8rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--es-accent);margin:0 0 .5em;}
#rwa-doc-mount .sk-byline{font-style:italic;color:var(--es-faint);font-size:.95rem;margin:0 0 1.4em;}
#rwa-doc-mount .sk-lede p::first-letter{float:left;font-size:3.4em;line-height:.82;font-weight:700;padding:.04em .1em 0 0;color:var(--es-ink);}
#rwa-doc-mount .sk-pull{margin:1.5em 0;font-size:1.45rem;line-height:1.4;font-style:italic;text-align:center;color:var(--es-soft);}
</style>`,
  },

  'stripe-docs': {
    name: 'stripe-docs',
    label: 'Stripe Docs',
    swatch: ['#ffffff', '#1a1f36', '#635bff'],
    theme: `<style data-rwa-skin="stripe-docs">
#rwa-doc-mount{
  --sd-ink:#1a1f36; --sd-soft:#3c4257; --sd-faint:#697386; --sd-line:#e3e8ee;
  --sd-bg:#ffffff; --sd-tint:#f6f9fc; --sd-accent:#635bff; --sd-accent-2:#0073e6;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  color:var(--sd-ink); line-height:1.65;
}
#rwa-doc-mount article{max-width:760px;margin:64px auto;padding:0 36px;}
#rwa-doc-mount h1{font-size:2.3rem;font-weight:700;letter-spacing:-.02em;line-height:1.15;color:var(--sd-ink);margin:1.4em 0 .4em;}
#rwa-doc-mount h2{font-size:1.45rem;font-weight:600;color:var(--sd-ink);margin:2em 0 .4em;padding-bottom:.3em;border-bottom:1px solid var(--sd-line);}
#rwa-doc-mount h3{font-size:1.15rem;font-weight:600;color:var(--sd-soft);margin:1.6em 0 .3em;}
#rwa-doc-mount p{color:var(--sd-soft);margin:0 0 1em;}
#rwa-doc-mount a{color:var(--sd-accent);text-decoration:none;font-weight:500;}
#rwa-doc-mount a:hover{color:var(--sd-accent-2);text-decoration:underline;text-underline-offset:2px;}
#rwa-doc-mount ul,#rwa-doc-mount ol{color:var(--sd-soft);padding-left:1.5em;margin:0 0 1em;}
#rwa-doc-mount li{margin:.3em 0;}
#rwa-doc-mount blockquote{margin:1.2em 0;padding:12px 16px;background:var(--sd-tint);border-left:3px solid var(--sd-accent);border-radius:0 6px 6px 0;color:var(--sd-soft);font-style:normal;}
#rwa-doc-mount hr{border:0;border-top:1px solid var(--sd-line);margin:2.2em 0;}
#rwa-doc-mount code{font-family:'SF Mono',Menlo,Monaco,ui-monospace,monospace;font-size:.85em;background:var(--sd-tint);color:var(--sd-accent);border:1px solid var(--sd-line);padding:.1em .4em;border-radius:5px;}
#rwa-doc-mount pre{background:#0a2540;color:#f6f9fc;border:0;border-radius:10px;padding:18px 20px;box-shadow:0 2px 6px rgba(10,37,64,.18);}
#rwa-doc-mount pre code{background:transparent;border:0;color:inherit;}
#rwa-doc-mount table{font-size:.92em;border:1px solid var(--sd-line);border-radius:8px;overflow:hidden;}
#rwa-doc-mount th{background:var(--sd-tint);color:var(--sd-faint);font-weight:600;text-transform:uppercase;letter-spacing:.04em;font-size:.78rem;border-bottom:1px solid var(--sd-line);padding:.55em .85em;}
#rwa-doc-mount td{border-bottom:1px solid var(--sd-line);padding:.55em .85em;color:var(--sd-soft);}
#rwa-doc-mount .sk-hero{margin:0 0 2em;padding:0 0 1.4em;border-bottom:1px solid var(--sd-line);}
#rwa-doc-mount .sk-hero h1{margin-top:0;}
#rwa-doc-mount .sk-pill{display:inline-block;font-size:.72rem;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--sd-accent);background:var(--sd-tint);border:1px solid var(--sd-line);border-radius:999px;padding:.25em .7em;margin:0 0 .8em;}
</style>`,
  },

  'terminal-mono': {
    name: 'terminal-mono',
    label: 'Terminal',
    swatch: ['#080a08', '#9ee69e', '#39ff14'],
    theme: `<style data-rwa-skin="terminal-mono">
#rwa-doc-mount{
  --gray-50:#0c0f0c;--gray-100:#101410;--gray-200:#1b241b;--gray-300:#2c3b2c;
  --gray-400:#4f7a4f;--gray-500:#6fae6f;--gray-600:#86cd86;--gray-700:#9ee69e;
  --gray-800:#b6f5b6;--gray-900:#d6ffd6;--white:#080a08;
  --green:#39ff14;--yellow:#e8e84a;--red:#ff5f56;--blue:#5fd7ff;
  --radius:0px;--radius-sm:0px;
  background:#080a08;color:#9ee69e;
  font-family:var(--font-mono);
  font-size:15px;line-height:1.55;
}
#rwa-doc-mount article{max-width:74ch;margin:40px auto;padding:0 28px;}
#rwa-doc-mount h1,#rwa-doc-mount h2,#rwa-doc-mount h3,#rwa-doc-mount h4,#rwa-doc-mount h5,#rwa-doc-mount h6{font-family:var(--font-mono);font-weight:700;letter-spacing:0;color:#d6ffd6;text-transform:none;}
#rwa-doc-mount h1{font-size:1.7rem;}
#rwa-doc-mount h1::before{content:"# ";color:#4f7a4f;}
#rwa-doc-mount h2{font-size:1.35rem;}
#rwa-doc-mount h2::before{content:"## ";color:#4f7a4f;}
#rwa-doc-mount h3::before{content:"### ";color:#4f7a4f;}
#rwa-doc-mount p{color:#9ee69e;}
#rwa-doc-mount a{color:#5fd7ff;text-decoration:underline;text-underline-offset:3px;}
#rwa-doc-mount a:hover{background:#5fd7ff;color:#080a08;text-decoration:none;}
#rwa-doc-mount ul,#rwa-doc-mount ol{padding-left:2ch;}
#rwa-doc-mount ul li{list-style:none;}
#rwa-doc-mount ul li::before{content:"\\203A ";color:#39ff14;margin-left:-2ch;}
#rwa-doc-mount blockquote{border-left:0;padding:.4em 1ch;color:#86cd86;font-style:normal;background:#101410;border:1px solid #2c3b2c;}
#rwa-doc-mount hr{border-top:1px dashed #2c3b2c;}
#rwa-doc-mount code{background:#101410;color:#39ff14;border-radius:0;padding:.05em .4ch;}
#rwa-doc-mount pre{background:#0c0f0c;border:1px solid #2c3b2c;border-radius:0;color:#9ee69e;box-shadow:inset 0 0 0 1px #101410;}
#rwa-doc-mount table{font-size:.95em;}
#rwa-doc-mount th,#rwa-doc-mount td{border-bottom:1px solid #2c3b2c;}
#rwa-doc-mount th{background:#101410;color:#39ff14;text-transform:uppercase;letter-spacing:.08em;font-weight:700;}
#rwa-doc-mount .sk-hero{margin:0 0 1.6em;padding:.6em 1ch;border:1px solid #2c3b2c;background:#0c0f0c;}
#rwa-doc-mount .sk-byline{color:#6fae6f;font-size:.85em;}
#rwa-doc-mount .sk-stat-row{display:flex;flex-wrap:wrap;gap:1ch;margin:1.4em 0;}
#rwa-doc-mount .sk-stat{display:flex;flex-direction:column;border:1px solid #2c3b2c;padding:.5em 1ch;background:#101410;}
#rwa-doc-mount .sk-stat-num{font-size:1.4rem;font-weight:700;color:#39ff14;}
#rwa-doc-mount .sk-stat-label{font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;color:#6fae6f;}
#rwa-doc-mount .sk-blink{color:#39ff14;animation:sk-blink 1s step-end infinite;}
@keyframes sk-blink{50%{opacity:0;}}
@media (prefers-reduced-motion:reduce){#rwa-doc-mount .sk-blink{animation:none;}}
</style>`,
  },
});

export const SKIN_NAMES = Object.keys(SKINS);

/**
 * Look up a preset by name. Throws an exit-2 error (listing known skins) on an
 * unknown name, mirroring the CLI's `not_found`-class file errors so the bin
 * dispatcher and tests get a consistent, actionable failure.
 *
 * @param {string} name
 * @returns {{name:string,label:string,swatch:string[],theme:string}}
 */
export function skinByName(name) {
  const s = SKINS[name];
  if (!s) {
    const e = new Error(`unknown skin "${name}". Known skins: ${SKIN_NAMES.join(', ')}`);
    e.exitCode = 2;
    e.subcode = 'unknown_skin';
    throw e;
  }
  return s;
}
