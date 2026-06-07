// Pins the CLI's L1 (content-aware restyle) building blocks BYTE-IDENTICAL to
// seeds/rewritable.html — the canonical site (the browser ✦ gallery's always-on
// L1 reads them there). Same manual-mirror discipline as skins-seed-mirror.mjs /
// apply-edits.mjs / identity.mjs. Two things are mirrored:
//
//   1. RWA_SKIN_L1_PREAMBLE + RWA_SKIN_RECIPES (the per-preset agent
//      instructions) — exact string-value compare, no normalization. These are
//      pure data, so a single character of drift is a real, user-visible change.
//
//   2. spliceSkinBlock + deskinDoc (+ its parser-free helpers) — the
//      deterministic de-skin/splice logic the L1 compose path runs. Compared
//      with two DOCUMENTED, cosmetic normalizations applied to BOTH sides:
//        - per-line leading whitespace stripped (the seed nests the functions one
//          indent level deeper inside the bootstrap IIFE);
//        - the seed names the two regexes RWA_SKIN_BLOCK_RE /
//          RWA_SKIN_BLOCK_TRAIL_RE; the CLI declares them without the RWA_ prefix
//          (its module-local convention) — and the CLI exports deskinDoc.
//      Everything else (logic, comments, string literals) must match verbatim;
//      otherwise the test fails loudly and you must re-copy from the seed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RWA_SKIN_L1_PREAMBLE, RWA_SKIN_RECIPES, SKIN_NAMES } from '../src/skins.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SEED = join(here, '..', '..', 'seeds', 'rewritable.html');
const SKIN = join(here, '..', 'src', 'skin.mjs');

test('CLI RWA_SKIN_L1_PREAMBLE is byte-identical to the seed', () => {
  const seed = readFileSync(SEED, 'utf8');
  const tag = 'const RWA_SKIN_L1_PREAMBLE =\n`';
  const i = seed.indexOf(tag);
  assert.ok(i >= 0, 'seed must declare RWA_SKIN_L1_PREAMBLE');
  const vStart = i + tag.length;
  // The preamble's OWN closing backtick — robust to whatever const follows it (v3
  // inserted RWA_SKIN_GENERIC_RECIPE between the preamble and RWA_SKIN_RECIPES). The
  // preamble text contains no backticks, so the first `;\n after vStart is its close.
  const vEnd = seed.indexOf('`;\n', vStart);
  assert.ok(vEnd >= 0, 'seed RWA_SKIN_L1_PREAMBLE must be a closed template literal');
  const seedPreamble = seed.slice(vStart, vEnd);
  assert.equal(
    RWA_SKIN_L1_PREAMBLE, seedPreamble,
    'cli/src/skins.mjs RWA_SKIN_L1_PREAMBLE drifted from the seed — re-copy it',
  );
});

test('CLI RWA_SKIN_RECIPES are byte-identical to the seed (every preset)', () => {
  const seed = readFileSync(SEED, 'utf8');
  // Seed recipes share the SKINS preset names — they must match exactly.
  for (const n of SKIN_NAMES) {
    assert.ok(n in RWA_SKIN_RECIPES, `every preset must have an L1 recipe (${n})`);
  }
  assert.deepEqual(
    Object.keys(RWA_SKIN_RECIPES).sort(), [...SKIN_NAMES].sort(),
    'RWA_SKIN_RECIPES keys must exactly match the preset names',
  );
  for (const n of SKIN_NAMES) {
    // Seed builds each as: `    "<n>": RWA_SKIN_L1_PREAMBLE +\n`...suffix...`,`
    const tag = '    ' + JSON.stringify(n).replace(/"/g, "'") + ': RWA_SKIN_L1_PREAMBLE +\n`';
    const idx = seed.indexOf(tag);
    assert.ok(idx >= 0, `seed must declare recipe for ${n}`);
    const vStart = idx + tag.length;
    const vEnd = seed.indexOf('`,\n', vStart);
    const seedFull = RWA_SKIN_L1_PREAMBLE + seed.slice(vStart, vEnd);
    assert.equal(
      RWA_SKIN_RECIPES[n], seedFull,
      `cli/src/skins.mjs RWA_SKIN_RECIPES['${n}'] drifted from the seed — re-copy it`,
    );
  }
});

// Documented cosmetic normalization (see header): per-line leading-ws strip +
// regex-name prefix + export keyword. Logic / comments / string-literal content
// is otherwise compared verbatim.
function normalize(src) {
  return src
    .replace(/RWA_SKIN_BLOCK_RE/g, 'SKIN_BLOCK_RE')
    .replace(/RWA_SKIN_BLOCK_TRAIL_RE/g, 'SKIN_BLOCK_TRAIL_RE')
    .replace(/^export function deskinDoc/m, 'function deskinDoc')
    .split('\n').map(l => l.replace(/^\s+/, '')).join('\n');
}

test('CLI deskinDoc + spliceSkinBlock helpers mirror the seed verbatim', () => {
  const seed = readFileSync(SEED, 'utf8');
  const cli = readFileSync(SKIN, 'utf8');

  // Seed block: from `function spliceSkinBlock` through the end of `function deskinDoc`.
  const sStart = seed.indexOf('  function spliceSkinBlock(doc, theme) {');
  assert.ok(sStart >= 0, 'seed must declare spliceSkinBlock');
  const sDeskinEnd = seed.indexOf('  }', seed.indexOf('  function deskinDoc(doc) {'));
  assert.ok(sDeskinEnd >= 0, 'seed must declare deskinDoc');
  const seedBlock = seed.slice(sStart, sDeskinEnd + 3);

  // CLI block: spliceSkinBlock through the end of (exported) deskinDoc.
  const cStart = cli.indexOf('function spliceSkinBlock(doc, theme) {');
  assert.ok(cStart >= 0, 'cli must declare spliceSkinBlock');
  const cDeskinEnd = cli.indexOf('\n}', cli.indexOf('export function deskinDoc(doc) {'));
  assert.ok(cDeskinEnd >= 0, 'cli must export deskinDoc');
  const cliBlock = cli.slice(cStart, cDeskinEnd + 2);

  assert.equal(
    normalize(cliBlock), normalize(seedBlock),
    'cli/src/skin.mjs deskinDoc/spliceSkinBlock drifted from the seed — re-copy them',
  );
});
