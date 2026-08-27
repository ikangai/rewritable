// The agent signing canon exists THREE times. This pins all three (#45).
//
//   1. cli/src/skill-manifest.mjs  `canonicalAgent`   (+ the service/lib vendor)
//   2. service/public/ai/maker.html `canonicalAgent`  (byte-mirror, gated by
//      service/tests/maker-parity.test.mjs)
//   3. seeds/rewritable.html       `_agCanonicalAgent` (the browser verifier)
//
// Copy 3 had NO gate. That is how #45's version branch was nearly shipped with
// the seed left behind — a v2 carrier would have verified in the CLI and silently
// failed in the browser, because a canon mismatch does not raise an error. The
// signature simply stops matching. There is nothing to read, nothing to search
// for, and the symptom ("this carrier says unverified") points at the carrier
// rather than at the verifier.
//
// A byte-comparison of the source would be the wrong test: the three are written
// in different styles for different environments (exported ESM, a browser
// one-liner, a `<script>` body) and would fail on formatting while proving
// nothing. What must agree is the OUTPUT — the exact string that gets hashed and
// signed. So this feeds identical records to all three and compares the bytes
// they produce.
//
// Run:  (cd tests && node agent-canon-parity.mjs)

import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { canonicalAgent as cliCanon } from '../cli/src/skill-manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(__dirname, '..', 'seeds', 'rewritable.html');
const MAKER = path.join(__dirname, '..', 'service', 'public', 'ai', 'maker.html');

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log('  OK  ', label); }
  else { fail++; console.log('  FAIL', label, detail == null ? '' : '— ' + detail); }
};

// Extract a marker-delimited canon region and run it in an isolated vm context.
//
// Marker-delimited, not regex-guessed: `// rwa:agent-canon:begin/end` in the seed
// and `// rwa:maker-canon:begin/end` in the maker make the boundary explicit and
// reviewable, matching the convention `cli/src/seed-extract.mjs` and
// `service/tests/maker-parity.test.mjs` already use. A regex that hunts for
// `function NAME(` silently matches the wrong thing the day someone reformats.
//
// `node:vm` with an empty context, not `new Function`: the region is evaluated
// with no access to this module's scope, so the test cannot accidentally satisfy
// itself from its own environment. The input is repo source read from disk —
// anyone who can write to it already controls the seed.
function loadCanonRegion(file, beginMarker, endMarker, names) {
  const src = readFileSync(file, 'utf8');
  const i = src.indexOf(beginMarker);
  const j = src.indexOf(endMarker);
  if (i < 0 || j <= i) throw new Error(`${path.basename(file)} is missing the ${beginMarker} region`);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(
    src.slice(i + beginMarker.length, j) + `\n;globalThis.__canon = { ${names.join(', ')} };\n`,
    sandbox,
    { filename: path.basename(file) + ':canon' },
  );
  return sandbox.__canon;
}

const seedFns = loadCanonRegion(SEED, '// rwa:agent-canon:begin', '// rwa:agent-canon:end',
  ['_agCanonicalReferences', '_agCanonicalAgent']);
const makerFns = loadCanonRegion(MAKER, '// rwa:maker-canon:begin', '// rwa:maker-canon:end',
  ['canonicalAgent']);

const V1 = { author_pubkey: 'QUJD', description: 'd', role: 'r', system_prompt: 'p', vault_namespace_set: [], version: 'rwa-agent/1' };

const CASES = {
  'v1 — the shape every shipped carrier uses': V1,
  'v1 — missing optional fields': { role: 'r', system_prompt: 'p' },
  'v1 — a vault set': { ...V1, vault_namespace_set: ['vault:a', 'vault:b'] },
  'v1 — unicode and escapes': { ...V1, description: 'Ünï — "q"', system_prompt: 'de↔en \\ / \n\t 日本語' },
  // The bytes that matter most: a v1 record must be UNAFFECTED by a stray
  // references field, or an attacker could smuggle unsigned bytes past a v1
  // signature by relying on a verifier that reads them.
  'v1 — a stray references field is not signed': { ...V1, references: [{ name: 'x.md', content: 'smuggled' }] },
  'v2 — with references': { ...V1, version: 'rwa-agent/2', references: [{ name: 'a.md', content: '# H\n```js\nconst t = `x ${y}`;\n```' }] },
  'v2 — empty references array': { ...V1, version: 'rwa-agent/2', references: [] },
  'v2 — references absent entirely': { ...V1, version: 'rwa-agent/2' },
  'v2 — a malformed reference entry': { ...V1, version: 'rwa-agent/2', references: [{ name: 'a.md' }, null, { content: 'c' }] },
  'v2 — key order of the input must not matter': { version: 'rwa-agent/2', system_prompt: 'p', references: [{ content: 'c', name: 'n' }], role: 'r', description: 'd', author_pubkey: 'QUJD', vault_namespace_set: [] },
  'unknown future version falls back to the v1 canon': { ...V1, version: 'rwa-agent/9' },
};

console.log('agent signing canon — three implementations, one output\n');

for (const [label, agent] of Object.entries(CASES)) {
  const a = cliCanon(agent);
  const b = seedFns._agCanonicalAgent(agent);
  const c = makerFns.canonicalAgent(agent);
  check(`${label} — seed matches CLI`, a === b, `\n      cli:  ${a}\n      seed: ${b}`);
  check(`${label} — maker matches CLI`, a === c, `\n      cli:   ${a}\n      maker: ${c}`);
}

// The property the whole branch exists to protect.
const v1Canon = cliCanon(V1);
check('a v1 record canonicalizes identically with and without references',
  v1Canon === cliCanon({ ...V1, references: [{ name: 'x', content: 'y' }] }));
check('and v2 genuinely differs from v1 for the same fields',
  cliCanon({ ...V1, version: 'rwa-agent/2' }) !== v1Canon);

// A negative control: the lift must be reading real code, not silently matching
// an empty string and comparing '' to ''.
check('the lifted implementations are real (negative control)',
  typeof seedFns._agCanonicalAgent === 'function' &&
  typeof makerFns.canonicalAgent === 'function' &&
  seedFns._agCanonicalAgent(V1).includes('rwa-agent/1') &&
  makerFns.canonicalAgent(V1).includes('rwa-agent/1'));

console.log(`\n${pass + fail} checks — ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
