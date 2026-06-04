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
  if (a === 192 && b === 0 && c === 2) return 'reserved'; // 192.0.2/24 TEST-NET
  if (a >= 224) return 'reserved';              // 224/4 multicast + 240/4 reserved
  return null;
}

// Normalize a v6 literal: returns a category string if it must be blocked, or
// 'mapped:<v4>' to signal an IPv4-mapped address whose embedded v4 must be
// re-checked, or null if it is a public v6 address.
function v6Category(host) {
  const lower = host.toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d, optionally ::ffff:0:a.b.c.d) — must re-check
  // the embedded v4 so ::ffff:127.0.0.1 cannot smuggle loopback past us.
  const mapped = lower.match(/:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped && /::ffff:/.test(lower)) return `mapped:${mapped[1]}`;
  if (lower === '::1') return 'loopback';
  if (lower === '::') return 'unspecified';
  // fc00::/7 — Unique Local Addresses (fc.. and fd..).
  if (/^f[cd][0-9a-f]*:/.test(lower) || lower === 'fc00::1') return 'private';
  // fe80::/10 — link-local (fe80..febf).
  if (/^fe[89ab][0-9a-f]*:/.test(lower)) return 'link-local';
  return null;
}

// Classify a single IP literal (v4 or v6). Throws CloneError(blocked_host) for
// any non-public address; returns silently for a public address. Shared by the
// sync URL check and the async DNS-rebinding check.
export function assertPublicIp(ip, host = ip) {
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
async function assertHostResolvesPublic(host) {
  if (isIP(host)) return; // already validated as a literal
  let addrs;
  try {
    addrs = await lookup(host, { all: true });
  } catch (err) {
    throw new CloneError(2, 'fetch_failed', { host, message: `DNS lookup failed: ${err.message}` });
  }
  if (!addrs.length) {
    throw new CloneError(2, 'fetch_failed', { host, message: 'DNS lookup returned no addresses' });
  }
  for (const { address } of addrs) assertPublicIp(address, host);
}

export async function fetchPage(url, { maxBytes = 3_000_000, timeoutMs = 15000, maxRedirects = 5 } = {}) {
  let current = assertFetchableUrl(url);
  await assertHostResolvesPublic(bareHost(current.hostname));

  let response;
  for (let hop = 0; ; hop++) {
    try {
      response = await fetch(current.href, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'user-agent': 'rwa-clone/1.0 (+https://rewritable.ikangai.com)',
          'accept': 'text/html,application/xhtml+xml',
        },
      });
    } catch (err) {
      throw new CloneError(2, 'fetch_failed', { url: current.href, message: err.message });
    }

    // 3xx with a Location → manual per-hop revalidation (NEVER redirect:'follow').
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      if (hop >= maxRedirects) {
        throw new CloneError(2, 'too_many_redirects', { url, hops: hop + 1 });
      }
      let next;
      try {
        next = new URL(response.headers.get('location'), current.href);
      } catch {
        throw new CloneError(2, 'fetch_failed', { url: current.href, message: 'malformed redirect Location' });
      }
      current = assertFetchableUrl(next.href);
      await assertHostResolvesPublic(bareHost(current.hostname));
      continue;
    }
    break;
  }

  if (!response.ok) {
    throw new CloneError(2, 'http_error', { url: current.href, status: response.status });
  }

  const contentType = response.headers.get('content-type') || '';
  if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
    throw new CloneError(2, 'not_html', { url: current.href, contentType });
  }

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
    return new TextDecoder('utf-8').decode(buf);
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
  return new TextDecoder('utf-8').decode(out);
}
