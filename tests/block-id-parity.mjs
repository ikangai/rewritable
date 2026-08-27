// Cross-surface parity for the data-rwa-id backfill (#32).
//
// `injectMissingBlockIds` now exists twice: in seeds/rewritable.html (the
// source) and hand-mirrored into cli/src/apply-edits.mjs (the copy), because
// before #32 no CLI path assigned block ids at all — a document created, filled,
// edited and published entirely by agents had none, forever, while the seed's
// SYSTEM_PROMPT_RULES (used verbatim by the CLI agent loop) told the model "the
// runtime backfills any block you produce without one."
//
// There is no cmp gate for this mirror and there cannot be a byte-equality one
// either, because ids are RANDOM. So parity is pinned by PROPERTY: given the
// same document, both implementations must choose the same BLOCKS to id, skip
// the same regions, and preserve every existing id. If the two ever disagree
// about which blocks are addressable, a delegating agent that names a block from
// a CLI read cannot find it in the browser — the id stops being a stable name,
// which is the only reason it exists.
//
// Run:  (cd tests && npm install && node block-id-parity.mjs)

import jsdomPkg from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applySeedSubs, kindOverrides, replaceInlineDoc } from '../cli/src/seed.mjs';
import { injectMissingBlockIds, ANCHORABLE_TAGS, generateBlockId } from '../cli/src/apply-edits.mjs';

const { JSDOM, VirtualConsole } = jsdomPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(__dirname, '..', 'seeds', 'rewritable.html');

let pass = 0, fail = 0;
const check = (label, cond) => {
  if (cond) { pass++; console.log('  OK  ', label); }
  else      { fail++; console.log('  FAIL', label); }
};
const tick = () => new Promise(r => setTimeout(r, 0));

async function boot() {
  const ov = kindOverrides('document');
  const uuid = crypto.randomUUID();
  let html = fs.readFileSync(SEED, 'utf8');
  html = applySeedSubs(html, {
    uuid, title: 'BIP', fileMeta: 'bip.html', productKind: 'document',
    lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder,
    productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor,
  });
  html = replaceInlineDoc(html, '<article><h1>Boot</h1></article>');
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', e => console.error('[jsdomError]', e?.detail?.stack || e?.detail || e));
  const dom = new JSDOM(html, {
    url: 'https://rwa-bip.local/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(window) {
      window.indexedDB = indexedDB;
      window.IDBKeyRange = IDBKeyRange;
      window.fetch = async () => { throw new Error('no network in this test'); };
      Object.defineProperty(window.navigator, 'storage', { value: { persist: () => Promise.resolve(false) }, configurable: true });
    },
  });
  const { window } = dom;
  const t0 = Date.now();
  while (Date.now() - t0 < 5000) {
    if (typeof window.injectMissingBlockIds === 'function') break;
    await tick();
  }
  return window;
}

// Which blocks got an id, identified by their SOURCE POSITION rather than by the
// id value (which is random on both sides). Two implementations agree iff they
// inserted at the same offsets.
const insertionOffsets = (before, after) => {
  const out = [];
  let bi = 0;
  for (let ai = 0; ai < after.length; ai++) {
    if (before[bi] === after[ai]) { bi++; continue; }
    const m = after.slice(ai).match(/^ data-rwa-id="[a-z2-7]{8}"/);
    if (!m) return null;            // a difference that is NOT an id insertion
    out.push(bi);
    ai += m[0].length - 1;
  }
  return bi === before.length ? out : null;
};

const CASES = {
  'plain prose': '<article>\n<h1>Title</h1>\n<p>One.</p>\n<p>Two.</p>\n</article>',
  'nested list (outer-wins on li)': '<article><ul><li>a</li><li>b<ul><li>nested</li></ul></li></ul></article>',
  'table keeps scanning into cells': '<article><table><tr><td>c1</td><td>c2</td></tr></table></article>',
  'marker-form frozen zone': '<article>\n<!-- rwa:frozen:begin legal -->\n<p>Locked.</p>\n<!-- rwa:frozen:end legal -->\n<p>Free.</p>\n</article>',
  'attribute-form frozen zone': '<article><div data-rwa-frozen><p>Locked.</p></div><p>Free.</p></article>',
  'style body that looks like markup': '<article><style>p { color: red } li { margin: 0 }</style><p>Real.</p></article>',
  'comment containing a close tag': '<article><!-- </p> not real --><p>Real.</p></article>',
  'already-identified blocks': '<article><p data-rwa-id="keepme00">Kept.</p><p>Fresh.</p></article>',
  'mixed anchorables': '<article><h2>H</h2><blockquote>Q</blockquote><pre>code</pre><aside>A</aside><figure>F</figure></article>',
  'nothing anchorable': '<article><div><span>no blocks here</span></div></article>',
};

const window = await boot();
if (typeof window.injectMissingBlockIds !== 'function') {
  console.log('  FAIL  seed did not expose injectMissingBlockIds');
  process.exit(1);
}

console.log('block-id parity — seed (jsdom) vs cli/src/apply-edits.mjs\n');

// ─── The tag set both sides scan for ───────────────────────────────────
const seedTags = [...window.ANCHORABLE_TAGS].sort();
const cliTags = [...ANCHORABLE_TAGS].sort();
check('ANCHORABLE_TAGS is identical on both surfaces',
  JSON.stringify(seedTags) === JSON.stringify(cliTags));

// ─── Same blocks chosen, same regions skipped ──────────────────────────
for (const [label, doc] of Object.entries(CASES)) {
  const seed = window.injectMissingBlockIds(doc);
  const cli = injectMissingBlockIds(doc);

  check(`${label}: same number of ids assigned (seed ${seed.assigned} / cli ${cli.assigned})`,
    seed.assigned === cli.assigned);

  const seedAt = insertionOffsets(doc, seed.text);
  const cliAt = insertionOffsets(doc, cli.text);
  check(`${label}: both surfaces changed NOTHING but insert ids`,
    seedAt !== null && cliAt !== null);
  check(`${label}: ids land at the same source offsets`,
    seedAt !== null && cliAt !== null && JSON.stringify(seedAt) === JSON.stringify(cliAt));
}

// ─── Format and idempotence ────────────────────────────────────────────
const ID_RE = /^[a-z2-7]{8}$/;
check('minted ids use the seed format (8 chars, base32 lowercase)',
  Array.from({ length: 200 }, () => generateBlockId()).every(id => ID_RE.test(id)));

const doc = CASES['plain prose'];
const once = injectMissingBlockIds(doc).text;
const twice = injectMissingBlockIds(once);
check('a second pass is a no-op — ids are assigned once and never renumbered',
  twice.assigned === 0 && twice.text === once);

const untouched = injectMissingBlockIds(CASES['nothing anchorable']);
check('a doc with no anchorable blocks is returned byte-identical',
  untouched.assigned === 0 && untouched.text === CASES['nothing anchorable']);

// The round trip that matters in practice: a file edited by the CLI, then opened
// in a browser, then edited by the CLI again. If either surface disagreed about
// what counts as "already identified", the second one would mint a duplicate for
// a block that already has a name — and a duplicate id silently breaks the
// fragment links that are the whole point of a stable id.
for (const [label, src] of Object.entries(CASES)) {
  const viaCli = injectMissingBlockIds(src).text;
  const thenSeed = window.injectMissingBlockIds(viaCli);
  check(`${label}: the seed adds nothing to a CLI-backfilled doc`,
    thenSeed.assigned === 0 && thenSeed.text === viaCli);

  const viaSeed = window.injectMissingBlockIds(src).text;
  const thenCli = injectMissingBlockIds(viaSeed);
  check(`${label}: the CLI adds nothing to a seed-backfilled doc`,
    thenCli.assigned === 0 && thenCli.text === viaSeed);
}

// ─── Existing ids are load-bearing (URL fragments link to them) ────────
const keep = injectMissingBlockIds(CASES['already-identified blocks']);
check('an existing id survives verbatim', keep.text.includes('data-rwa-id="keepme00"'));
check('minted ids never collide with one already in the document',
  !/data-rwa-id="keepme00"[\s\S]*data-rwa-id="keepme00"/.test(keep.text));

// A document already holding every id the RNG can produce must fail loudly
// rather than silently mint a duplicate that would shadow a live fragment link.
let exhausted = null;
try {
  injectMissingBlockIds('<article><p data-rwa-id="aaaaaaaa">x</p><p>y</p></article>', () => Buffer.from([0, 0, 0, 0, 0]));
} catch (e) { exhausted = e && e.code; }
check('a forced id collision fails loud instead of shadowing an existing id',
  exhausted === 'block_id_exhausted');

console.log(`\n${pass + fail} checks — ${pass} pass, ${fail} fail`);
window.close();
process.exit(fail ? 1 : 0);
