// SSRF-safe page fetcher for `rwa clone <url>`. The fetch layer only — the
// article extractor and the bootstrap wiring are separate modules.
//
// A user (or an agent) can pass any URL, so without guards `rwa clone
// http://169.254.169.254/…` or `http://127.0.0.1:…` could reach cloud-metadata
// endpoints or internal services. Defence is in three layers:
//   1. scheme allowlist (http/https only)            — assertFetchableUrl
//   2. IP-literal classification (block private/etc.) — assertPublicIp
//   3. DNS-rebinding defence: resolve the hostname and re-classify EVERY
//      resolved address; manual per-hop redirect re-validation (no
//      redirect:'follow' — that would bypass the per-hop checks).
//
// Error surface (all exitCode 2 so the CLI maps them to the file/fetch class):
//   subcode: 'bad_scheme', 'blocked_host', 'too_many_redirects', 'http_error',
//            'not_html', 'too_large', 'fetch_failed'.
//
// Mirrors the rigor of the seed bridge SSRF block (redirect:'error' +
// private-range rejection). Only node: built-ins + global fetch.

import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

export class CloneError extends Error {
  constructor(exitCode, subcode, details = {}) {
    super(subcode);
    this.exitCode = exitCode;
    this.subcode = subcode;
    this.details = details;
  }
}

// --- IP classification ------------------------------------------------------

// Parse a dotted-quad into four octets, or null if it is not a v4 literal.
function parseV4(host) {
  if (isIP(host) !== 4) return null;
  const parts = host.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return parts;
}

// True if a v4 address falls in any range we refuse to fetch. Categories are
// returned (not just a boolean) so the error message can name the reason.
function v4Category([a, b, c]) {
  if (a === 0) return 'unspecified';            // 0.0.0.0/8
  if (a === 10) return 'private';               // 10/8
  if (a === 127) return 'loopback';             // 127/8
  if (a === 169 && b === 254) return 'link-local'; // 169.254/16 (incl. metadata)
  if (a === 172 && b >= 16 && b <= 31) return 'private'; // 172.16/12
  if (a === 192 && b === 168) return 'private'; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return 'reserved'; // 100.64/10 CGNAT
  if (a === 192 && b === 0 && c === 2) return 'reserved'; // 192.0.2/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return 'reserved'; // 198.18/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return 'reserved'; // 198.51.100/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return 'reserved'; // 203.0.113/24 TEST-NET-3
  if (a === 192 && b === 88 && c === 99) return 'reserved'; // 192.88.99/24 6to4 anycast
  if (a >= 224) return 'reserved';              // 224/4 multicast + 240/4 reserved
  return null;
}

// Expand an IPv6 literal into its full 16 bytes, dep-free: handles `::`
// compression and an embedded dotted-quad tail (::ffff:a.b.c.d / ::a.b.c.d).
// Returns a 16-element byte array, or null if it does not parse as v6. Operating
// on bytes (not string regexes) makes the dotted and hex spellings of the same
// address — e.g. ::ffff:127.0.0.1 and ::ffff:7f00:1 — classify identically.
function expandV6(host) {
  if (isIP(host) !== 6) return null;
  let s = host.toLowerCase();
  // Split out an embedded IPv4 tail (last group with dots) into two hex groups.
  const dot = s.lastIndexOf(':');
  const tail = s.slice(dot + 1);
  let v4Bytes = null;
  if (tail.includes('.')) {
    const quad = parseV4(tail);
    if (!quad) return null;
    v4Bytes = quad;
    s = s.slice(0, dot + 1); // keep trailing ':' so the group count stays right
  }
  // Split around the `::` compression point (at most one). The length-mismatch
  // and multiple-`::` guards below are belt-and-suspenders — isIP() already
  // rejected malformed literals, but we re-check on raw bytes for defence-in-depth.
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const splitGroups = (part) => (part === '' ? [] : part.split(':').filter((g) => g !== ''));
  const head = splitGroups(halves[0]);
  const tailGroups = halves.length === 2 ? splitGroups(halves[1]) : [];
  // Each remaining group is one 16-bit hex word; the v4 tail (if any) is 2 words.
  const v4Words = v4Bytes ? 2 : 0;
  const words = [];
  for (const g of head) words.push(parseInt(g, 16));
  if (halves.length === 2) {
    const fill = 8 - head.length - tailGroups.length - v4Words;
    if (fill < 0) return null;
    for (let i = 0; i < fill; i++) words.push(0);
  }
  for (const g of tailGroups) words.push(parseInt(g, 16));
  if (words.length !== 8 - v4Words) return null;
  const bytes = [];
  for (const w of words) { bytes.push((w >> 8) & 0xff, w & 0xff); }
  if (v4Bytes) bytes.push(...v4Bytes);
  if (bytes.length !== 16) return null;
  return bytes;
}

// Normalize a v6 literal: returns a category string if it must be blocked, or
// 'mapped:<v4>' to signal an IPv4-mapped (or -compatible) address whose embedded
// v4 must be re-checked through the v4 category logic, or null for a public v6.
function v6Category(host) {
  const b = expandV6(host);
  if (!b) return null;
  const allZeroThrough = (n) => b.slice(0, n).every((x) => x === 0);
  // IPv4-mapped ::ffff:a.b.c.d — first 10 bytes zero, bytes 11-12 = 0xff,0xff.
  if (allZeroThrough(10) && b[10] === 0xff && b[11] === 0xff) {
    return `mapped:${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
  }
  // ::1 loopback / :: unspecified (must come before the v4-compatible check).
  if (allZeroThrough(15) && b[15] === 1) return 'loopback';
  if (b.every((x) => x === 0)) return 'unspecified';
  // Deprecated IPv4-compatible ::a.b.c.d — first 12 bytes zero, low 32 bits a
  // real v4. Re-check the embedded v4 the same way as the mapped form.
  if (allZeroThrough(12)) {
    return `mapped:${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
  }
  // ff00::/8 — IPv6 multicast (mirrors the v4 224/4 block; closes the asymmetry).
  if (b[0] === 0xff) return 'reserved';
  // fc00::/7 — Unique Local Addresses (fc.. and fd..).
  if ((b[0] & 0xfe) === 0xfc) return 'private';
  // fe80::/10 — link-local.
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return 'link-local';
  // 2001:db8::/32 — documentation range (RFC 3849), never routable.
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return 'reserved';
  // NAT64 64:ff9b::/96 — bytes 0-1 = 00 64, 2-3 = ff 9b, bytes 4-11 zero, the
  // embedded v4 in bytes 12-15 is reachable through a NAT64 gateway. Re-check it.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b &&
      b.slice(4, 12).every((x) => x === 0)) {
    return `mapped:${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
  }
  // 6to4 2002::/16 — bytes 0-1 = 20 02, the embedded v4 is bytes 2-5; reachable
  // through a 6to4 relay. Re-check the embedded v4.
  if (b[0] === 0x20 && b[1] === 0x02) {
    return `mapped:${b[2]}.${b[3]}.${b[4]}.${b[5]}`;
  }
  return null;
}

// Classify a single IP literal (v4 or v6). Throws CloneError(blocked_host) for
// any non-public address; returns silently for a public address. Shared by the
// sync URL check and the async DNS-rebinding check.
function assertPublicIp(ip, host = ip) {
  const fam = isIP(ip);
  if (fam === 4) {
    const cat = v4Category(parseV4(ip));
    if (cat) throw new CloneError(2, 'blocked_host', { host, ip, category: cat,
      message: `blocked ${cat} address ${ip}` });
    return;
  }
  if (fam === 6) {
    const cat = v6Category(ip);
    if (cat && cat.startsWith('mapped:')) {
      const v4 = cat.slice('mapped:'.length);
      // [255,255] sentinel: if the embedded quad somehow fails to re-parse, force
      // a blocking category (255 ⇒ a>=224 'reserved') rather than failing open.
      const c4 = v4Category(parseV4(v4) || [255, 255]);
      if (c4) throw new CloneError(2, 'blocked_host', { host, ip, category: c4,
        message: `blocked ${c4} address ${v4} (IPv4-mapped IPv6)` });
      return; // public IPv4-mapped v6
    }
    if (cat) throw new CloneError(2, 'blocked_host', { host, ip, category: cat,
      message: `blocked ${cat} address ${ip}` });
    return;
  }
  // Not an IP literal — caller decides (sync path returns, DNS path won't hit).
}

// --- URL gate (sync) --------------------------------------------------------

// Strip surrounding brackets from an IPv6 URL hostname.
function bareHost(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

// Synchronous pre-flight: scheme + IP-literal classification only. DNS is async
// and lives in fetchPage. Returns the parsed URL on success.
export function assertFetchableUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new CloneError(2, 'bad_scheme', { url, message: 'unparseable URL (no valid scheme)' });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CloneError(2, 'bad_scheme', { url, protocol: parsed.protocol,
      message: `unsupported scheme ${parsed.protocol} — only http/https allowed` });
  }
  const host = bareHost(parsed.hostname);
  if (host.toLowerCase() === 'localhost') {
    throw new CloneError(2, 'blocked_host', { host, category: 'loopback',
      message: 'blocked loopback host localhost' });
  }
  if (isIP(host)) assertPublicIp(host);
  return parsed;
}

// --- fetch (async) ----------------------------------------------------------

// Resolve a non-literal hostname and re-classify every resolved address, so a
// public-looking name that resolves to a private IP (DNS rebinding) is blocked.
async function assertHostResolvesPublic(host, lookupImpl = lookup) {
  if (isIP(host)) return; // already validated as a literal
  let addrs;
  try {
    addrs = await lookupImpl(host, { all: true });
  } catch (err) {
    throw new CloneError(2, 'fetch_failed', { host, message: `DNS lookup failed: ${err.message}` });
  }
  if (!addrs.length) {
    throw new CloneError(2, 'fetch_failed', { host, message: 'DNS lookup returned no addresses' });
  }
  for (const { address } of addrs) assertPublicIp(address, host);
}

// Shared SSRF-guarded fetch core for fetchPage (HTML) and fetchImageDataUri
// (images). Validates the URL + every redirect hop (DNS-rebinding re-resolution,
// never redirect:'follow'), streams with a hard byte cap, and returns the raw
// bytes + matched mime + final URL. Content-type policy is the CALLER's job
// (this core is media-agnostic) — the one place the two fetchers differ, plus
// the `accept` header. Keeping the security machinery here means the image path
// can never drift from the audited HTML path.
async function fetchValidatedBytes(url, { maxBytes, timeoutMs, maxRedirects, accept, deps }) {
  const lookupImpl = deps.lookup || lookup;
  const fetchImpl = deps.fetchImpl || fetch;

  let current = assertFetchableUrl(url);
  await assertHostResolvesPublic(bareHost(current.hostname), lookupImpl);

  let response;
  for (let hop = 0; ; hop++) {
    try {
      response = await fetchImpl(current.href, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'user-agent': 'rwa-clone/1.0 (+https://rewritable.ikangai.com)',
          'accept': accept,
        },
      });
    } catch (err) {
      throw new CloneError(2, 'fetch_failed', { url: current.href, message: err.message });
    }

    // 3xx with a Location → manual per-hop revalidation (NEVER redirect:'follow').
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      if (hop >= maxRedirects) {
        throw new CloneError(2, 'too_many_redirects', { url: current.href, hops: hop + 1 });
      }
      let next;
      try {
        next = new URL(response.headers.get('location'), current.href);
      } catch {
        throw new CloneError(2, 'fetch_failed', { url: current.href, message: 'malformed redirect Location' });
      }
      current = assertFetchableUrl(next.href);
      await assertHostResolvesPublic(bareHost(current.hostname), lookupImpl);
      continue;
    }
    break;
  }

  if (!response.ok) {
    throw new CloneError(2, 'http_error', { url: current.href, status: response.status });
  }

  const contentType = response.headers.get('content-type') || '';
  // Match the media type only — an unanchored substring test would wrongly pass
  // e.g. `image/svg+xml; charset=text/html` (a parameter that mentions text/html).
  const mime = contentType.split(';')[0].trim().toLowerCase();

  // content-length is advisory; we still cap the streamed bytes below.
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new CloneError(2, 'too_large', { url: current.href, contentLength: declared, maxBytes });
  }

  // Stream and cap — a lying or absent content-length cannot exhaust memory.
  if (!response.body) {
    const buf = await response.arrayBuffer();
    if (buf.byteLength > maxBytes) {
      throw new CloneError(2, 'too_large', { url: current.href, maxBytes });
    }
    return { bytes: new Uint8Array(buf), mime, url: current.href };
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new CloneError(2, 'too_large', { url: current.href, maxBytes });
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof CloneError) throw err;
    throw new CloneError(2, 'fetch_failed', { url: current.href, message: err.message });
  }

  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return { bytes: out, mime, url: current.href };
}

export async function fetchPage(url, { maxBytes = 3_000_000, timeoutMs = 15000, maxRedirects = 5, deps = {} } = {}) {
  // Injection seam (testing only): defaults are the real node:dns lookup and the
  // global fetch, so the public call signature is unchanged for real callers.
  const { bytes, mime, url: finalUrl } = await fetchValidatedBytes(url, {
    maxBytes, timeoutMs, maxRedirects, accept: 'text/html,application/xhtml+xml', deps,
  });
  if (mime !== 'text/html' && mime !== 'application/xhtml+xml') {
    throw new CloneError(2, 'not_html', { url: finalUrl, contentType: mime });
  }
  return new TextDecoder('utf-8').decode(bytes);
}

// Image localization (rwa clone --localize-images). Fetch ONE image URL through
// the same SSRF-guarded core and return it as a `data:image/<type>;base64,…`
// URI, or throw CloneError. image/* only (raster + svg+xml — `<img src>` renders
// SVG in no-script image mode, the same allowance import.mjs makes). The CLI has
// no canvas, so bytes are inlined RAW (no recompression) — bounded by maxBytes.
const IMG_MIME_RE = /^image\/(png|jpeg|gif|webp|avif|svg\+xml|bmp|x-icon|vnd\.microsoft\.icon)$/;
export async function fetchImageDataUri(url, { maxBytes = 2_000_000, timeoutMs = 15000, maxRedirects = 5, deps = {} } = {}) {
  const { bytes, mime, url: finalUrl } = await fetchValidatedBytes(url, {
    maxBytes, timeoutMs, maxRedirects, accept: 'image/*', deps,
  });
  if (!IMG_MIME_RE.test(mime)) {
    throw new CloneError(2, 'not_image', { url: finalUrl, contentType: mime });
  }
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}
