// PASTE-03 — paste a long prose excerpt verbatim. Tests the most common
// failure mode: the model "tightens", paraphrases, or summarizes pasted prose
// instead of inserting it as-is. ~400 words, multi-paragraph, with em-dashes
// and ordinary punctuation that paraphrasers often "improve".

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const PROSE_CONTENT = `In 1983, the world's first widely-known computer worm — Elk Cloner — appeared on Apple II computers. It was written by Rich Skrenta, a fifteen-year-old high school student in Pittsburgh, as a prank to torment friends who played pirated games on his computer. The worm spread via floppy disk: when an infected disk was used to boot a clean Apple II, the worm copied itself into the system, and from there it would copy itself onto every floppy inserted into that machine.

The worm was largely benign. Every fiftieth time someone booted from an infected disk, the screen would clear and display a short poem Skrenta had written. The poem began "Elk Cloner: The program with a personality" and continued for several more lines. Then the system would resume booting normally, leaving the user puzzled but unharmed.

What made Elk Cloner historically significant was not its payload — it caused no real damage — but its method of propagation. Earlier viruses had spread through the deliberate execution of infected programs. Elk Cloner was the first to use a boot sector as its host, which meant it could spread without the user knowingly executing anything malicious. It also marked the first time a self-replicating program had escaped a laboratory and reached real users at scale.

Skrenta later said he was surprised at how much trouble the worm caused. Friends and acquaintances complained for years afterwards. Computer security as a field did not yet exist; antivirus software was unknown. The worm continued to spread for years, long after its author had moved on to college and other projects.`;

const FIXTURE = `<article>
<h1>History notes</h1>
<p>The user pasted an excerpt below.</p>
<div id="excerpt">PROSE_PLACEHOLDER_PASTE_03</div>
<p>The excerpt should be cited and discussed in the next section.</p>
</article>`;

const PASTE_BLOCK = `<blockquote class="paste">${PROSE_CONTENT.split('\n\n').map(p => `<p>${p}</p>`).join('\n')}</blockquote>`;

export default {
  id: 'PASTE-03',
  category: 'PASTE',
  tag: 'paste',
  description: 'paste 400-word prose excerpt verbatim; resist paraphrase/tightening',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: `The user pasted this excerpt. Embed it verbatim inside a <blockquote class="paste"> at the marked location. Each paragraph (separated by blank lines in the source) becomes a <p>. Do NOT paraphrase, tighten, summarize, fix grammar, or change wording. Replace PROSE_PLACEHOLDER_PASTE_03 with the wrapped excerpt.\n\n${PROSE_CONTENT}`,
  stub: () => stubModel([
    { name: 'apply_edits', envelope: {
      version: 'rwa-edit/1',
      edits: [{ find: 'PROSE_PLACEHOLDER_PASTE_03', replace: PASTE_BLOCK }],
    } },
  ]),
  success: async (doc) => {
    const expectedParas = PROSE_CONTENT.split('\n\n');
    const out = runSelectorOracle(doc, [
      { selector: '#excerpt blockquote.paste', label: 'blockquote.paste wrapper present' },
      { fn: (d) => !d.body.textContent.includes('PROSE_PLACEHOLDER_PASTE_03'), label: 'marker removed' },
      { fn: (d) => d.querySelectorAll('#excerpt blockquote.paste > p').length === expectedParas.length, label: `${expectedParas.length} <p> elements inside blockquote` },
      { fn: (d) => {
          const ps = [...d.querySelectorAll('#excerpt blockquote.paste > p')];
          return ps.length === expectedParas.length && ps.every((p, i) => p.textContent === expectedParas[i]);
        }, label: 'all paragraphs match source byte-identical' },
    ]);
    out.total++;
    const byteIdentical = doc.includes(PASTE_BLOCK);
    out.results.push({ label: 'excerpt block present byte-identical in raw doc', ok: byteIdentical, reason: byteIdentical ? 'byte-identical' : 'block missing or altered' });
    if (byteIdentical) out.passed++;
    out.score = out.passed === out.total ? 2 : (out.passed > 0 ? 1 : 0);
    return out;
  },
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'PROSE_PLACEHOLDER_PASTE_03');
    if (!region) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
