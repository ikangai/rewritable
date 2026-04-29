import fs from 'node:fs/promises';

export async function loadSeed(candidates) {
  for (const p of candidates) {
    try {
      return await fs.readFile(p, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  throw new Error(`seed not found in any of: ${candidates.join(', ')}`);
}

const UUID_RE = /const DOC_UUID = '[0-9a-f-]{36}';/;
const TITLE_RE = /<title>[^<]*<\/title>/;
const FILE_RE = /(FILE\s*:\s*)'[^']*'/;

export function applySeedSubs(seed, { uuid, title, fileMeta }) {
  const uuidMatches = seed.match(new RegExp(UUID_RE.source, 'g')) || [];
  if (uuidMatches.length !== 1) {
    throw new Error(`seed must contain exactly one DOC_UUID line, found ${uuidMatches.length}`);
  }
  let out = seed.replace(UUID_RE, `const DOC_UUID = '${uuid}';`);
  if (title != null) out = out.replace(TITLE_RE, `<title>${escapeHtml(title)}</title>`);
  if (fileMeta != null) out = out.replace(FILE_RE, (_m, prefix) => `${prefix}'${escapeJsString(fileMeta)}'`);
  return out;
}

// Mirrors the bootstrap's escapeTL — keep in sync with seeds/rewritable.html.
const escapeTL = s => s
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$\{/g, '\\${')
  .replace(/<\/script/gi, '<\\/script');

const INLINE_DOC_MARKER = 'const INLINE_DOC = `';

export function replaceInlineDoc(seed, newDoc) {
  const start = seed.indexOf(INLINE_DOC_MARKER);
  if (start < 0) throw new Error('cannot locate INLINE_DOC marker in seed');
  const cs = start + INLINE_DOC_MARKER.length;
  let i = cs;
  while (i < seed.length) {
    if (seed[i] === '\\') { i += 2; continue; }
    if (seed[i] === '`') break;
    i++;
  }
  if (i >= seed.length) throw new Error('unterminated INLINE_DOC literal in seed');
  return seed.slice(0, cs) + escapeTL(newDoc) + seed.slice(i);
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeJsString(s) {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
