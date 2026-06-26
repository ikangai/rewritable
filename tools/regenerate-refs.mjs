#!/usr/bin/env node
// tools/regenerate-refs.mjs — regenerate hello.html, re-write-able-spec.html, and
// the intelligence-carrier example from seeds/rewritable.html, preserving each
// reference's DOC_UUID, INLINE_DOC, and FILE. A ref with a non-default `kind`
// (e.g. the skill-host carrier) also gets its kind regions re-applied via
// applySeedSubs/kindOverrides — otherwise it would regenerate as a plain document.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySeedSubs, kindOverrides } from '../cli/src/seed.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const seedPath = path.join(repoRoot, 'seeds', 'rewritable.html');
const refs = [
  { path: path.join(repoRoot, 'hello.html'), file: 'hello.html' },
  { path: path.join(repoRoot, 're-write-able-spec.html'), file: 're-write-able-spec.html' },
  // Optional: a working rewritable.html at the repo root (e.g. produced by
  // `rwa new` for ad-hoc testing). Skipped silently if absent.
  { path: path.join(repoRoot, 'rewritable.html'), file: 'rewritable.html', optional: true },
  // The intelligence-carrier worked example (docs/specs/rwa-intelligence-spec.md
  // reference artifact). It is a skill-host kind carrying a signed rwa-agent/1
  // record in its frozen #rwa-agents zone; the record is part of INLINE_DOC and
  // survives regen unchanged (it depends only on the agent canon, not seed bytes).
  { path: path.join(repoRoot, 'examples', 'intelligence-carrier', 'concise-editor.html'), file: 'concise-editor.html', kind: 'skill-host' },
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

function extractTitle(html) {
  const m = html.match(/<title>([\s\S]*?)<\/title>/i);
  return m ? m[1] : null;
}

for (const ref of refs) {
  if (ref.optional && !fs.existsSync(ref.path)) {
    console.log(`Skipped ${ref.path} (optional, not present)`);
    continue;
  }
  const refHtml = fs.readFileSync(ref.path, 'utf8');
  const uuid = extractDocUuid(refHtml);
  const inline = extractInlineDoc(refHtml);
  if (!uuid || !inline) {
    console.error(`Could not parse ${ref.path}`);
    process.exit(1);
  }
  // Substitute into the seed. A non-default kind re-applies its kind regions
  // (PRODUCT_KIND, lens placeholders, product header) via applySeedSubs, which
  // also requires a title — preserve the ref's own. Otherwise the simple
  // DOC_UUID + FILE substitution is enough (document kind = seed defaults).
  let out;
  if (ref.kind && ref.kind !== 'document') {
    const title = extractTitle(refHtml) || ref.file;
    const ov = kindOverrides(ref.kind);
    out = applySeedSubs(seed, {
      uuid, title, fileMeta: ref.file, productKind: ref.kind,
      lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder,
      productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor,
    });
  } else {
    out = seed
      .replace(/const DOC_UUID\s*=\s*'[^']+'/, `const DOC_UUID = '${uuid}'`)
      .replace(/FILE\s*:\s*'[^']+'/, `FILE:'${ref.file}'`);
  }
  // Replace the seed's INLINE_DOC body with the reference's (already-escaped) body.
  const seedInline = extractInlineDoc(out);
  if (!seedInline) { console.error('Could not find INLINE_DOC in seed'); process.exit(1); }
  out = out.slice(0, seedInline.start) + inline.body + out.slice(seedInline.end);
  fs.writeFileSync(ref.path, out, 'utf8');
  console.log(`Regenerated ${ref.path} (uuid=${uuid}, file=${ref.file}${ref.kind ? ', kind=' + ref.kind : ''})`);
}
