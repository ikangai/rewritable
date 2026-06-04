// clone-extract: locate the main article + title in a fetched webpage's HTML.
//
// This is the EXTRACTOR stage of `rwa clone <url>`: fetch (elsewhere) →
// extract (here) → sanitize (elsewhere) → bootstrap (elsewhere). It only
// LOCATES content; it does NOT strip scripts/attributes — a later sanitize
// task owns that. Pure and dependency-free (built-in JS only) so it can be
// mirrored to the browser /import path the way the rest of the CLI is.

// Decode the handful of named/numeric entities that show up in titles.
// Titles come from og:title / <title> / <h1>, which are entity-encoded in
// source HTML; we only need this minimal set for human-readable titles.
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x0*27;/gi, "'");
}

function stripTags(s) {
  return s.replace(/<[^>]*>/g, '');
}

// Title precedence: og:title → <title> (minus a " | Site" / " – Site" /
// " — Site" suffix) → first <h1> → 'Untitled'. og:title is the cleanest
// signal on the WordPress/OpenGraph pages we target; the <title> suffix
// strip removes the site-name tail that most CMSes append.
function extractTitle(html) {
  const og = html.match(
    /<meta[^>]*\bproperty\s*=\s*["']og:title["'][^>]*\bcontent\s*=\s*["']([^"']*)["']/i,
  ) || html.match(
    /<meta[^>]*\bcontent\s*=\s*["']([^"']*)["'][^>]*\bproperty\s*=\s*["']og:title["']/i,
  );
  if (og) return decodeEntities(og[1].trim());

  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title) {
    const raw = decodeEntities(stripTags(title[1]).trim());
    // Drop a trailing " | Site" / " – Site" / " — Site" separator + tail.
    const cut = raw.replace(/\s*[|–—]\s*[^|–—]*$/, '').trim();
    if (cut) return cut;
    if (raw) return raw;
  }

  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    const t = decodeEntities(stripTags(h1[1]).trim());
    if (t) return t;
  }

  return 'Untitled';
}

// Find the index of the opening tag for the element whose class attribute
// contains `cls`. Returns the index of the '<' or -1.
function findClassOpen(html, cls) {
  const re = new RegExp(
    `<([a-z][a-z0-9]*)\\b[^>]*\\bclass\\s*=\\s*["'][^"']*\\b${cls}\\b[^"']*["'][^>]*>`,
    'i',
  );
  const m = re.exec(html);
  return m ? { index: m.index, tag: m[1].toLowerCase(), openEnd: m.index + m[0].length } : null;
}

// THE CRUX — balanced extraction, parser-free.
//
// A naive non-greedy /(<div>)(.*?)(<\/div>)/ truncates at the FIRST nested
// </div>, which on a real WordPress entry-content (panel-grid wrappers,
// widget divs, tinymce divs — 6 nested <div>s deep in the fixture) cuts the
// body off after the first paragraph. So instead we walk forward from the
// opening tag tracking the open/close depth of `tagName` and stop at the
// MATCHING close. HTML comments are skipped (so `<!-- .entry-content -->`
// doesn't confuse the scan) and void/self-closing same-name tags don't
// bump depth (div/article are never void, but we guard anyway).
//
// Returns the INNER HTML of the container (between openEnd and the matching
// close), or null if no balanced close is found.
function balancedInner(html, tagName, startIndex) {
  // Locate end of the opening tag at startIndex.
  const openTagEnd = html.indexOf('>', startIndex);
  if (openTagEnd === -1) return null;
  const innerStart = openTagEnd + 1;

  const openRe = new RegExp(`<${tagName}\\b`, 'gi');
  const closeRe = new RegExp(`</${tagName}\\s*>`, 'gi');

  let depth = 1;
  let pos = innerStart;
  while (pos < html.length) {
    // Skip over HTML comments so markers like <!-- .entry-content --> and
    // any commented-out same-name tags don't perturb the depth count.
    if (html.startsWith('<!--', pos)) {
      const end = html.indexOf('-->', pos + 4);
      if (end === -1) break;
      pos = end + 3;
      continue;
    }
    openRe.lastIndex = pos;
    closeRe.lastIndex = pos;
    const o = openRe.exec(html);
    const c = closeRe.exec(html);
    if (!c) break; // unbalanced — no matching close
    if (o && o.index < c.index) {
      // Next event is a nested open of the same tag. Self-closing (<tag .../>)
      // wouldn't add depth; div/article aren't void so we treat all as nesting,
      // but guard the self-closing form just in case.
      const gt = html.indexOf('>', o.index);
      const selfClosing = gt !== -1 && html[gt - 1] === '/';
      if (!selfClosing) depth++;
      pos = (gt === -1 ? html.length : gt + 1);
    } else {
      depth--;
      pos = c.index + c[0].length;
      if (depth === 0) return html.slice(innerStart, c.index);
    }
  }
  return null;
}

// Generic density fallback: from <body>, scan top-level block elements and
// pick the subtree with the highest text-length ÷ tag-count ratio. Chrome
// (nav/header/footer/aside + class-matched menus/sidebars/comments/etc.) is
// excluded so the dense content block wins even when the page has no
// recognised content container. This is a heuristic, not a parser — good
// enough to find "the main blob of prose" on an unknown layout.
const CHROME_TAGS = /^(nav|header|footer|aside)$/i;
const CHROME_CLASS = /\b(nav|menu|sidebar|footer|header|comment|share|related)\b/i;

function isChrome(tag, attrs) {
  if (CHROME_TAGS.test(tag)) return true;
  const cls = attrs.match(/\bclass\s*=\s*["']([^"']*)["']/i);
  if (cls && CHROME_CLASS.test(cls[1])) return true;
  return false;
}

function density(inner) {
  const text = stripTags(inner).replace(/\s+/g, ' ').trim();
  const tags = (inner.match(/<[a-z][^>]*>/gi) || []).length || 1;
  return text.length / tags;
}

function genericFallback(html) {
  // Restrict to <body> when present.
  let scope = html;
  const bodyOpen = html.search(/<body\b[^>]*>/i);
  if (bodyOpen !== -1) {
    const bm = html.slice(bodyOpen).match(/<body\b[^>]*>/i);
    const start = bodyOpen + bm[0].length;
    const bodyClose = html.toLowerCase().indexOf('</body>', start);
    scope = html.slice(start, bodyClose === -1 ? html.length : bodyClose);
  }

  // Walk top-level block elements in scope. We re-scan from each element's
  // end (using its balanced close) so we only consider siblings, not nested
  // descendants — that keeps the density comparison apples-to-apples.
  const blockRe = /<([a-z][a-z0-9]*)\b([^>]*)>/gi;
  let best = null;
  let m;
  let cursor = 0;
  while ((m = blockRe.exec(scope))) {
    if (m.index < cursor) continue; // inside a subtree we already consumed
    const tag = m[1].toLowerCase();
    const attrs = m[2];
    const inner = balancedInner(scope, tag, m.index);
    if (inner == null) { continue; }
    // advance cursor past this whole element so its descendants are skipped
    const closeRe = new RegExp(`</${tag}\\s*>`, 'gi');
    closeRe.lastIndex = m.index + m[0].length + inner.length;
    const cm = closeRe.exec(scope);
    cursor = cm ? cm.index + cm[0].length : scope.length;
    if (isChrome(tag, attrs)) continue;
    const score = density(inner);
    if (!best || score > best.score) best = { score, inner };
  }
  return best ? best.inner : scope;
}

export function extractArticle(html) {
  const title = extractTitle(html);

  // Profile 1 — WordPress/ikangai: the element whose class contains
  // "entry-content" (appears once per post page).
  const ec = findClassOpen(html, 'entry-content');
  if (ec) {
    const inner = balancedInner(html, ec.tag, ec.index);
    if (inner != null) return { title, html: inner };
  }

  // Profile 2 — Generic semantic: first <article>…</article>.
  const art = html.search(/<article\b[^>]*>/i);
  if (art !== -1) {
    const inner = balancedInner(html, 'article', art);
    if (inner != null) return { title, html: inner };
  }

  // Fallback — density heuristic over <body> top-level blocks.
  return { title, html: genericFallback(html) };
}
