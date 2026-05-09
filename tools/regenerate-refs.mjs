#!/usr/bin/env node
// tools/regenerate-refs.mjs — regenerate hello.html and re-write-able-spec.html
// from seeds/rewritable.html, preserving each reference's DOC_UUID, INLINE_DOC,
// and FILE.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const seedPath = path.join(repoRoot, 'seeds', 'rewritable.html');
const refs = [
  { path: path.join(repoRoot, 'hello.html'), file: 'hello.html' },
  { path: path.join(repoRoot, 're-write-able-spec.html'), file: 're-write-able-spec.html' },
];

const seed = fs.readFileSync(seedPath, 'utf8');

// Find an INLINE_DOC body in a doc (or seed) — between `const INLINE_DOC = \`` and the closing backtick.
// The closing backtick must honor the existing template-literal escape: \`, \\, ${.
function extractInlineDoc(html) {
  const start = html.indexOf('const INLINE_DOC = `');
  if (start < 0) return null;
  const bodyStart = start + 'const INLINE_DOC = `'.length;
  // Walk forward, honoring backslash escapes and ${ openers.
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
    if (c === '$' && html[i+1] === '{') { inSubst = 1; i += 2; continue; }
    if (c === '`') return { start: bodyStart, end: i, body: html.slice(bodyStart, i) };
    i++;
  }
  return null;
}

function extractDocUuid(html) {
  const m = html.match(/const DOC_UUID\s*=\s*'([^']+)'/);
  return m ? m[1] : null;
}

function extractFile(html) {
  // RWA = { ... FILE:'hello.html', ... }
  const m = html.match(/FILE\s*:\s*'([^']+)'/);
  return m ? m[1] : null;
}

for (const ref of refs) {
  const refHtml = fs.readFileSync(ref.path, 'utf8');
  const uuid = extractDocUuid(refHtml);
  const inline = extractInlineDoc(refHtml);
  if (!uuid || !inline) {
    console.error(`Could not parse ${ref.path}`);
    process.exit(1);
  }
  // Substitute into the seed.
  let out = seed
    .replace(/const DOC_UUID\s*=\s*'[^']+'/, `const DOC_UUID = '${uuid}'`)
    .replace(/FILE\s*:\s*'[^']+'/, `FILE:'${ref.file}'`);
  // Replace the seed's INLINE_DOC body with the reference's body.
  const seedInline = extractInlineDoc(out);
  if (!seedInline) { console.error('Could not find INLINE_DOC in seed'); process.exit(1); }
  out = out.slice(0, seedInline.start) + inline.body + out.slice(seedInline.end);
  fs.writeFileSync(ref.path, out, 'utf8');
  console.log(`Regenerated ${ref.path} (uuid=${uuid}, file=${ref.file})`);
}
