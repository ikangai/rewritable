#!/usr/bin/env node
// tools/compose-artifact.mjs — splice an INLINE_DOC body into the canonical
// seed and write a new container. The body file holds the contents that go
// inside the seed's INLINE_DOC template literal (the document fragment that
// will be rendered into #rwa-doc-mount). DOC_UUID and RWA.FILE are
// substituted; the body is escaped for safe re-embedding in the template
// literal using the same rules the runtime's escapeTL applies on commit.
//
// Usage:
//   tools/compose-artifact.mjs <seed> <body> <uuid> <fileName> <out>
//
// Example:
//   node tools/compose-artifact.mjs \
//     seeds/rewritable.html \
//     /tmp/invoice-tracker-body.html \
//     $(node -e 'console.log(crypto.randomUUID())') \
//     invoice-tracker.html \
//     demo/invoice-tracker.html

import fs from 'node:fs';

const [, , seedPath, bodyPath, uuid, fileName, outPath] = process.argv;
if (!seedPath || !bodyPath || !uuid || !fileName || !outPath) {
  console.error('usage: compose-artifact.mjs <seed> <body> <uuid> <fileName> <out>');
  process.exit(1);
}

const canonLF = s => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
const escapeTL = s => canonLF(s)
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$\{/g, '\\${')
  .replace(/<\/script/gi, '<\\/script');

// Find the closing backtick of the seed's INLINE_DOC template literal,
// walking forward from `bodyStart` and honoring backslash escapes and
// ${...} substitutions (matches the same locator used in
// tools/regenerate-refs.mjs and the runtime's commit path).
function findInlineDocEnd(html, bodyStart) {
  let i = bodyStart;
  let inSubst = 0;
  while (i < html.length) {
    const c = html[i];
    if (c === '\\') { i += 2; continue; }
    if (inSubst > 0) {
      if (c === '{') inSubst++;
      else if (c === '}') inSubst--;
      i++; continue;
    }
    if (c === '$' && html[i + 1] === '{') { inSubst = 1; i += 2; continue; }
    if (c === '`') return i;
    i++;
  }
  return -1;
}

const seed = fs.readFileSync(seedPath, 'utf8');
const body = fs.readFileSync(bodyPath, 'utf8');

const inlineStart = seed.indexOf('const INLINE_DOC = `');
if (inlineStart < 0) { console.error('seed missing INLINE_DOC'); process.exit(1); }
const bodyStart = inlineStart + 'const INLINE_DOC = `'.length;
const bodyEnd = findInlineDocEnd(seed, bodyStart);
if (bodyEnd < 0) { console.error('seed missing INLINE_DOC closing backtick'); process.exit(1); }

let out = seed.slice(0, bodyStart) + escapeTL(body) + seed.slice(bodyEnd);
out = out
  .replace(/const DOC_UUID\s*=\s*'[^']+'/, `const DOC_UUID = '${uuid}'`)
  .replace(/FILE\s*:\s*'[^']+'/, `FILE:'${fileName}'`);

fs.writeFileSync(outPath, out, 'utf8');
console.log(`wrote ${outPath} (uuid=${uuid}, file=${fileName})`);
