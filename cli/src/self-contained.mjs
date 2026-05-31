// Self-containment guard for `rwa create` output (design 2026-05-31 §4.5).
//
// A created rewritable must open and run with ZERO external RUNTIME dependencies
// (Invariant 1 — "send the file, they have everything"). The create-path prompt
// forbids runtime CDN references; this is the code-level tripwire behind that
// prompt (defense in depth, Rule 5): the model can't ship a CDN tag even if it
// ignores the instruction.
//
// ALLOWLIST, not a scheme-denylist (a denylist misses protocol-relative //host
// and unknown schemes). A URL is self-contained iff it is one of:
//   • empty / a #fragment            (no resource)
//   • data:…                         (inlined bytes)
//   • an authority-less relative path (no scheme, no leading //)
//   • mailto: / tel:                 (non-fetching; a click handler, not a load)
// Everything else — http(s), protocol-relative //, ftp/ws/blob/javascript, any
// other scheme — triggers (or implies) an external load and is rejected.
//
// SCOPE (honest, Rule 12): a STATIC markup/CSS scan. It covers the attribute and
// CSS fetch surface enumerated below; it does NOT inspect inline-JS runtime calls
// (fetch()/XHR/import()/new Image().src). Those remain prompt-governed for v1 —
// named here, not silently passed.

import { CliError } from './edit.mjs';

// Schemes that name an action handler rather than a resource load. A link to one
// of these does not fetch bytes when the file opens, so it does not break
// self-containment.
const NON_FETCHING_SCHEMES = new Set(['mailto', 'tel']);

/**
 * Is this attribute/CSS value an external runtime fetch?
 * @param {string} raw — a single URL value (already unquoted/trimmed by the caller)
 * @returns {boolean}
 */
function isExternalFetch(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (s === '' || s.startsWith('#')) return false;     // no resource
  if (/^data:/i.test(s)) return false;                 // inlined bytes
  if (s.startsWith('//')) return true;                 // protocol-relative → network
  const m = s.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);    // leading scheme?
  if (!m) return false;                                // authority-less relative → local
  return !NON_FETCHING_SCHEMES.has(m[1].toLowerCase());
}

// URL-bearing HTML attributes. `data` is the <object data=> URL attribute; the
// (?<![-\w]) lookbehind keeps it from matching data-* custom attributes (and keeps
// `href`/`src` from matching inside longer names). srcset is handled separately
// because its value is a comma-separated "url descriptor" list, not a bare URL.
const URL_ATTR_RE = /(?<![-\w])(src|href|xlink:href|poster|data)\s*=\s*("([^"]*)"|'([^']*)')/gi;
const SRCSET_RE = /(?<![-\w])srcset\s*=\s*("([^"]*)"|'([^']*)')/gi;
// CSS url(...) — bare, single-, or double-quoted — anywhere (inline <style> or style=).
const CSS_URL_RE = /url\(\s*("([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/gi;
// CSS @import "x"  /  @import 'x'  (the @import url(...) form is caught by CSS_URL_RE).
const CSS_IMPORT_RE = /@import\s+("([^"]*)"|'([^']*)')/gi;

/**
 * Find every external runtime reference in an HTML body. Pure; never throws.
 * @param {string} html — the document body (INLINE_DOC text)
 * @returns {Array<{url: string, kind: string}>} one entry per external ref
 */
export function findExternalRefs(html) {
  const text = String(html == null ? '' : html);
  const refs = [];
  let m;

  URL_ATTR_RE.lastIndex = 0;
  while ((m = URL_ATTR_RE.exec(text))) {
    const val = m[3] != null ? m[3] : m[4];
    if (isExternalFetch(val)) refs.push({ url: val.trim(), kind: `attr:${m[1].toLowerCase()}` });
  }

  SRCSET_RE.lastIndex = 0;
  while ((m = SRCSET_RE.exec(text))) {
    // SRCSET_RE has no leading name group, so the quoted-value inner groups are
    // m[2] (double) / m[3] (single) — unlike URL_ATTR_RE which is shifted by +1.
    const list = (m[2] != null ? m[2] : m[3]) || '';
    // Each candidate is "url [descriptor]"; the URL is the first whitespace-delimited token.
    for (const entry of list.split(',')) {
      const url = entry.trim().split(/\s+/)[0];
      if (isExternalFetch(url)) refs.push({ url, kind: 'attr:srcset' });
    }
  }

  CSS_URL_RE.lastIndex = 0;
  while ((m = CSS_URL_RE.exec(text))) {
    const val = m[2] != null ? m[2] : (m[3] != null ? m[3] : m[4]);
    if (isExternalFetch(val)) refs.push({ url: val.trim(), kind: 'css:url' });
  }

  CSS_IMPORT_RE.lastIndex = 0;
  while ((m = CSS_IMPORT_RE.exec(text))) {
    // Same group layout as SRCSET_RE: no name group, so inner = m[2]/m[3].
    const val = m[2] != null ? m[2] : m[3];
    if (isExternalFetch(val)) refs.push({ url: val.trim(), kind: 'css:import' });
  }

  return refs;
}

/**
 * Assert that an HTML body is self-contained. No-op on clean input; on any
 * external runtime reference, throws CliError(4, 'not_self_contained') so the
 * CLI surfaces exit code 4 (agent) — the created artifact is never written.
 * @param {string} html — the document body to check
 * @throws {CliError} exitCode 4 / subcode 'not_self_contained'
 */
export function assertSelfContained(html) {
  const refs = findExternalRefs(html);
  if (refs.length === 0) return;
  throw new CliError(4, 'not_self_contained', {
    count: refs.length,
    refs: refs.slice(0, 10), // cap the detail payload; the count is exact
    reason: 'created artifact must have no external runtime dependencies (no CDN/remote src/href, @import, url(), or srcset)',
  });
}
