// The seed runtime embeds RWA_SKINS so the in-app ✦ gallery / lens can apply
// presets offline. That embed is a MIRROR of cli/src/skins.mjs (the canonical
// source). This test pins them byte-identical — same discipline as the
// apply-edits.mjs / identity.mjs mirrors. If skins.mjs changes, regenerate the
// seed embed and this passes again; otherwise it fails loudly.
//
// We pin by REGENERATING the canonical embed string from skins.mjs and asserting
// the seed contains it verbatim — a pure string compare, no eval of file bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKINS, SKIN_NAMES } from '../src/skins.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SEED = join(here, '..', '..', 'seeds', 'rewritable.html');

// Mirror the seed's escapeForTL: \ ` ${ </script must be escaped to survive
// inside the bootstrap <script> + a template literal. Keep in lockstep with the
// embed generator documented in docs/plans/2026-06-03-skinning-seed-half-plan.md.
const escTL = (s) => s
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$\{/g, '\\${')
  .replace(/<\/script/gi, '<\\/script');

function canonicalEmbed() {
  let out = '  const RWA_SKINS = {\n';
  for (const n of SKIN_NAMES) {
    const s = SKINS[n];
    out += `    ${JSON.stringify(n)}: { name: ${JSON.stringify(s.name)}, label: ${JSON.stringify(s.label)}, swatch: ${JSON.stringify(s.swatch)}, theme: \`${escTL(s.theme)}\` },\n`;
  }
  out += '  };\n';
  return out;
}

test('seed RWA_SKINS embed is byte-identical to the canonical cli/src/skins.mjs', () => {
  const seed = readFileSync(SEED, 'utf8');
  assert.ok(
    seed.includes(canonicalEmbed()),
    'seed RWA_SKINS drifted from cli/src/skins.mjs (or its embed format) — regenerate the embed',
  );
});
