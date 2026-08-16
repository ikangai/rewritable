#!/usr/bin/env node
// Reproducible vendoring of Argon2id for the I9 vault KDF (docs/specs/
// re-write-able-actions-spec-v0.9-open-items.md §13). Bundles @noble/hashes'
// pure-JS argon2id into a single self-contained IIFE that assigns
// `globalThis._argon2id(pwBytes, saltBytes, {t,m,p,dkLen,key?,ad?})` — no WASM,
// no eval, no runtime dependency. The seed inlines the OUTPUT of this script
// between `// rwa:argon2:begin` / `// rwa:argon2:end` markers as a string
// constant `ARGON2_SRC` (the blob: Worker is built from it; the jsdom test
// extracts + RFC-9106-pins it). Pure-JS keeps the frozen CSP unchanged
// (Inv 26/44/18 held), unlike the abandoned WASM path.
//
// Usage:  node tools/vendor-argon2.mjs           # prints the ARGON2_SRC block
//         node tools/vendor-argon2.mjs --raw     # prints just the bundle source
// Requires network the first time (npm install into an OS temp dir). The
// RFC-9106 vector in tests/vault-kdf.mjs is the drift guard on the inlined bytes.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const NOBLE_VERSION = '2.2.0'; // pinned; bump deliberately + re-run + re-pin the test

const dir = mkdtempSync(path.join(tmpdir(), 'rwa-argon2-'));
writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ private: true }));
writeFileSync(path.join(dir, 'entry.mjs'),
  `import { argon2id } from "@noble/hashes/argon2.js";\n` +
  `globalThis._argon2id = function (pw, salt, o) {\n` +
  `  o = o || {};\n` +
  `  return argon2id(pw, salt, { t: o.t, m: o.m, p: o.p, dkLen: o.dkLen || 32, key: o.key, personalization: o.ad });\n` +
  `};\n`);

execFileSync('npm', ['install', '--no-audit', '--no-fund', '--silent',
  `@noble/hashes@${NOBLE_VERSION}`, 'esbuild'], { cwd: dir, stdio: 'inherit' });

execFileSync(path.join(dir, 'node_modules', '.bin', 'esbuild'),
  ['entry.mjs', '--bundle', '--format=iife', '--minify', '--legal-comments=none',
   '--outfile=argon2.bundle.js'], { cwd: dir, stdio: 'inherit' });

const bundle = readFileSync(path.join(dir, 'argon2.bundle.js'), 'utf8').trim();
if (bundle.includes('</script')) throw new Error('bundle contains </script — unsafe to inline');

if (process.argv.includes('--raw')) { process.stdout.write(bundle + '\n'); process.exit(0); }

// The upstream notice, verbatim from @noble/hashes' LICENSE. esbuild runs with
// --legal-comments=none (keeping the bundle bytes minimal and the RFC-9106 pin
// stable), so the notice does not survive bundling and must be reproduced here:
// MIT requires it to travel with the copy, and the seed is redistributed verbatim
// inside every emitted rewritable. Keep this in step with NOBLE_VERSION.
const NOBLE_NOTICE = [
  'The MIT License (MIT)',
  '',
  'Copyright (c) 2022 Paul Miller (https://paulmillr.com)',
  '',
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
  'of this software and associated documentation files (the “Software”), to deal',
  'in the Software without restriction, including without limitation the rights',
  'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
  'copies of the Software, and to permit persons to whom the Software is',
  'furnished to do so, subject to the following conditions:',
  '',
  'The above copyright notice and this permission notice shall be included in',
  'all copies or substantial portions of the Software.',
  '',
  'THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
  'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
  'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
  'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
  'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
  'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN',
  'THE SOFTWARE.',
].map((l) => (l ? `//   ${l}` : '//')).join('\n');

// The seed-ready block: a string constant (no main-thread eval; CSP-safe).
const block =
  `// rwa:argon2:begin ARGON2_SRC\n` +
  `// Vendored Argon2id (pure JS) — @noble/hashes@${NOBLE_VERSION}, MIT. Bundled by\n` +
  `// tools/vendor-argon2.mjs (esbuild iife/min). Assigns globalThis._argon2id(pw,salt,\n` +
  `// {t,m,p,dkLen,key?,ad?}). Used to build the blob: Worker in _argon2idViaWorker; the\n` +
  `// frozen CSP is unchanged (no WASM, no eval). RFC-9106-pinned by tests/vault-kdf.mjs.\n` +
  `//\n` +
  `// ARGON2_SRC below is a verbatim copy of @noble/hashes. Its notice, as required:\n` +
  `//\n` +
  `${NOBLE_NOTICE}\n` +
  `const ARGON2_SRC = ${JSON.stringify(bundle)};\n` +
  `// rwa:argon2:end ARGON2_SRC`;
process.stdout.write(block + '\n');
