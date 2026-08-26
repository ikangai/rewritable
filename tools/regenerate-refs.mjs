#!/usr/bin/env node
// tools/regenerate-refs.mjs — regenerate hello.html, re-write-able-spec.html, and
// the intelligence-carrier example from seeds/rewritable.html, preserving each
// reference's DOC_UUID, INLINE_DOC, and FILE. A ref with a non-default `kind`
// (e.g. the skill-host carrier) also gets its kind regions re-applied via
// applySeedSubs/kindOverrides — otherwise it would regenerate as a plain document.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySeedSubs, kindOverrides, seedIdentity, pruneForeignKindPrompts } from '../cli/src/seed.mjs';

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
  // The curated AI Gallery carriers (service/public/ai/carriers/). Each is a
  // skill-host rwa carrying one signed rwa-agent/1 record in its frozen
  // #rwa-agents zone — same discipline as the example above: the record lives in
  // INLINE_DOC and survives regen unchanged (it depends only on the agent canon,
  // not the seed bytes). Re-sign only when the RECORD changes, never for a seed bump.
  { path: path.join(repoRoot, 'service', 'public', 'ai', 'carriers', 'concise-editor.intelligence.html'), file: 'concise-editor.intelligence.html', kind: 'skill-host' },
  { path: path.join(repoRoot, 'service', 'public', 'ai', 'carriers', 'proofreader.intelligence.html'), file: 'proofreader.intelligence.html', kind: 'skill-host' },
  { path: path.join(repoRoot, 'service', 'public', 'ai', 'carriers', 'translator.intelligence.html'), file: 'translator.intelligence.html', kind: 'skill-host' },
  { path: path.join(repoRoot, 'service', 'public', 'ai', 'carriers', 'presentation-coach.intelligence.html'), file: 'presentation-coach.intelligence.html', kind: 'skill-host' },
  { path: path.join(repoRoot, 'service', 'public', 'ai', 'carriers', 'playful-rewriter.intelligence.html'), file: 'playful-rewriter.intelligence.html', kind: 'skill-host' },
  // The two ADVISOR carriers (#26). Same discipline as the roles above — the
  // signed record is preserved, so a seed change re-bootstraps the carrier
  // without invalidating its signature.
  { path: path.join(repoRoot, 'service', 'public', 'ai', 'carriers', 'print-aware.intelligence.html'), file: 'print-aware.intelligence.html', kind: 'skill-host' },
  { path: path.join(repoRoot, 'service', 'public', 'ai', 'carriers', 'house-style.intelligence.html'), file: 'house-style.intelligence.html', kind: 'skill-host' },
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
    // The document-kind path bypasses applySeedSubs, so it must stamp the derived
    // seed identity itself (#12) — otherwise references ship the placeholder, which
    // is precisely the "looks authoritative, identifies nothing" failure the marker
    // exists to fix. Hash the seed as read, matching applySeedSubs exactly.
    const seedId = seedIdentity(seed);
    out = seed
      .replace(/(<meta name="rwa-seed" content=")[^"]*(">)/, (_m, pre, post) => `${pre}${seedId}${post}`)
      .replace(/const DOC_UUID\s*=\s*'[^']+'/, `const DOC_UUID = '${uuid}'`)
      .replace(/FILE\s*:\s*'[^']+'/, `FILE:'${ref.file}'`);
    // This path bypasses applySeedSubs, so it must prune foreign-kind
    // SYSTEM_PROMPTS itself — same reason it stamps the seed id itself.
    out = pruneForeignKindPrompts(out, 'document');
  }
  if (out.includes('0000000000pl')) {
    console.error(`${ref.path}: rwa-seed placeholder survived substitution`);
    process.exit(1);
  }
  // Replace the seed's INLINE_DOC body with the reference's (already-escaped) body.
  const seedInline = extractInlineDoc(out);
  if (!seedInline) { console.error('Could not find INLINE_DOC in seed'); process.exit(1); }
  out = out.slice(0, seedInline.start) + inline.body + out.slice(seedInline.end);
  fs.writeFileSync(ref.path, out, 'utf8');
  console.log(`Regenerated ${ref.path} (uuid=${uuid}, file=${ref.file}${ref.kind ? ', kind=' + ref.kind : ''})`);
}
