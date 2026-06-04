// `rwa clone <url>` bootstrap wiring. Turns a fetched web page into a saved
// rewritable by reusing the EXACT import pipeline: extract the article body,
// run it through the same sanitiser the import path uses, then drop it into a
// fresh seed via applySeedSubs + replaceInlineDoc.
//
// Why prepend an <h1>: inspectDoc derives the document title from the body's
// first <h1>, not the <title> tag. A WordPress post's <h1> lives outside
// .entry-content, so the extracted content carries no heading — without this
// the cloned doc would render as "Untitled". The extracted page title is the
// honest source, so we prepend it.

import { access } from 'node:fs/promises';
import { basename } from 'node:path';

import { extractArticle } from './clone-extract.mjs';
import { sanitizeImportedHtml } from './import.mjs';
import { loadSeed, applySeedSubs, replaceInlineDoc } from './seed.mjs';
import { SEED_CANDIDATES } from './commands.mjs';
import { atomicWrite } from './atomic-write.mjs';
import { fetchPage, CloneError } from './fetch-page.mjs';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function cloneFromHtml(html, outPath, sourceUrl) {
  const { title, html: content } = extractArticle(html);
  // sanitizeImportedHtml returns { html, warnings }; we only need the cleaned body.
  const { html: clean } = sanitizeImportedHtml(content);

  const body = `<article>\n<h1>${escapeHtml(title)}</h1>\n${clean}\n`
    + `<footer><p><small>Cloned from <a href="${escapeHtml(sourceUrl)}">${escapeHtml(sourceUrl)}</a></small></p></footer>\n</article>`;

  const seed = await loadSeed(SEED_CANDIDATES);
  // Order matches the `rwa import` lesson: seed-level substitutions on the
  // pristine seed FIRST, then inject the body — so DOC_UUID can't false-match
  // inside imported content.
  const subbed = applySeedSubs(seed, {
    uuid: crypto.randomUUID(),
    title,
    fileMeta: basename(outPath),
  });
  const result = replaceInlineDoc(subbed, body);
  await atomicWrite(outPath, result);
  return { outPath, title };
}

// Derive a filename slug from the URL's last non-empty path segment.
function slugFromUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'clone';
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  const last = segments.length ? segments[segments.length - 1] : '';
  const slug = last.replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '');
  return slug || 'clone';
}

export async function cloneCmd({ url, outPath, force }) {
  const html = await fetchPage(url);
  const resolvedOut = outPath || `./${slugFromUrl(url)}.html`;

  if (!force) {
    let exists = true;
    try {
      await access(resolvedOut);
    } catch {
      exists = false;
    }
    if (exists) {
      throw new CloneError(2, 'exists', { path: resolvedOut,
        message: `destination exists: ${resolvedOut} (use --force to overwrite)` });
    }
  }

  await cloneFromHtml(html, resolvedOut, url);
  console.log('wrote ' + resolvedOut);
}
