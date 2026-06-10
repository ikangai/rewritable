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
import { fetchPage, fetchImageDataUri, CloneError } from './fetch-page.mjs';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// `rwa clone --localize-images`: make a clone truly self-contained by inlining
// each remote <img src> as a data: URI (the same form the GUI/import produce),
// so the saved file needs no network. Each image rides the SSRF-guarded
// fetchImageDataUri (image/* only, raw bytes — the CLI has no canvas to
// recompress). GRACEFUL by design: a fetch failure, SSRF block, non-image
// content-type, over-cap image, or exhausted total budget leaves that <img> at
// its remote URL and records a warning — one bad image never fails the clone.
// Caps: per-image 2 MB, total 8 MB (under the 10 MB container budget, leaving
// headroom for the prose). Relative src is resolved against the page URL.
const LOCALIZE_PER_IMAGE = 2 * 1024 * 1024;
const LOCALIZE_TOTAL = 8 * 1024 * 1024;
const IMG_SRC_RE = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])(https?:\/\/[^"']+|\/[^"']*|\.\.?\/[^"']*)\2/gi;

export async function localizeImages(html, sourceUrl, opts = {}) {
  const deps = opts.deps || {};
  const perImage = opts.perImage || LOCALIZE_PER_IMAGE;
  const totalCap = opts.totalCap || LOCALIZE_TOTAL;
  const warnings = [];
  let inlined = 0, totalBytes = 0;

  // Collect matches first (regex with async work can't run inside .replace).
  const matches = [];
  let m;
  IMG_SRC_RE.lastIndex = 0;
  while ((m = IMG_SRC_RE.exec(html)) !== null) {
    matches.push({ whole: m[0], pre: m[1], quote: m[2], src: m[3], index: m.index });
  }

  // Resolve + fetch each unique src once (a page often repeats an image).
  const resolved = new Map(); // original src -> data URI (or null = leave remote)
  for (const { src } of matches) {
    if (resolved.has(src)) continue;
    let abs;
    try { abs = new URL(src, sourceUrl).href; }
    catch { resolved.set(src, null); warnings.push(`skipped ${src} (unresolvable URL)`); continue; }
    if (totalBytes >= totalCap) { resolved.set(src, null); warnings.push(`skipped ${src} (container image budget reached)`); continue; }
    try {
      const remaining = Math.min(perImage, totalCap - totalBytes);
      const dataUri = await fetchImageDataUri(abs, { maxBytes: remaining, deps });
      // base64 is ~4/3 of the raw bytes; count the raw size toward the budget.
      totalBytes += Math.floor((dataUri.length - dataUri.indexOf(',') - 1) * 3 / 4);
      resolved.set(src, dataUri);
      inlined++;
    } catch (err) {
      resolved.set(src, null);
      warnings.push(`skipped ${src} (${err && err.subcode ? err.subcode : (err && err.message) || 'fetch failed'})`);
    }
  }

  const out = html.replace(IMG_SRC_RE, (whole, pre, quote, src) => {
    const dataUri = resolved.get(src);
    return dataUri ? pre + quote + dataUri + quote : whole;
  });
  return { html: out, inlined, warnings };
}

export async function cloneFromHtml(html, outPath, sourceUrl, opts = {}) {
  const { title, html: content } = extractArticle(html);
  // sanitizeImportedHtml returns { html, warnings }; we only need the cleaned body.
  let { html: clean } = sanitizeImportedHtml(content);

  // --localize-images: inline remote <img src> as data: URIs so the clone is
  // truly self-contained. Runs AFTER the sanitizer (its http/https/data:image
  // src allowlist already passed); swaps surviving remote URLs for data URIs.
  if (opts.localizeImages) {
    const r = await localizeImages(clean, sourceUrl, { deps: opts.deps });
    clean = r.html;
    if (r.inlined) console.error(`note: inlined ${r.inlined} image(s)`);
    for (const w of r.warnings) console.error('note: ' + w);
  }

  // Defence-in-depth: the wired path (cloneCmd → fetchPage) already validates
  // the scheme, but this exported fn must be safe-by-default for any caller.
  // Only http/https URLs become a live provenance <a href>; anything else
  // (javascript:, data:, file:, …) renders as plain escaped text — no href —
  // so a hostile scheme can never produce a clickable link in the cloned doc.
  const safeProvenance = /^https?:\/\//i.test(String(sourceUrl));
  const provenance = safeProvenance
    ? `<a href="${escapeHtml(sourceUrl)}">${escapeHtml(sourceUrl)}</a>`
    : escapeHtml(sourceUrl);

  const body = `<article>\n<h1>${escapeHtml(title)}</h1>\n${clean}\n`
    + `<footer><p><small>Cloned from ${provenance}</small></p></footer>\n</article>`;

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

export async function cloneCmd({ url, outPath, force, localizeImages: localize }) {
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

  await cloneFromHtml(html, resolvedOut, url, { localizeImages: localize });
  console.log('wrote ' + resolvedOut);
}
