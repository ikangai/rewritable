import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertFetchableUrl, fetchPage } from '../src/fetch-page.mjs';

test('rejects non-http(s) schemes', () => {
  assert.throws(() => assertFetchableUrl('file:///etc/passwd'), /scheme/i);
  assert.throws(() => assertFetchableUrl('ftp://host/x'), /scheme/i);
  assert.throws(() => assertFetchableUrl('gopher://host/'), /scheme/i);
});

test('rejects loopback + private + link-local + metadata hosts (literals)', () => {
  for (const u of ['http://127.0.0.1/', 'http://127.5.5.5/', 'http://localhost/',
                   'http://10.0.0.1/', 'http://172.16.0.1/', 'http://192.168.1.1/',
                   'http://169.254.169.254/', 'http://0.0.0.0/', 'http://[::1]/',
                   'http://[fd00::1]/', 'http://[fe80::1]/']) {
    assert.throws(() => assertFetchableUrl(u), /blocked|private|loopback|link-local|reserved/i, u);
  }
});

test('allows a normal public https url', () => {
  assert.doesNotThrow(() => assertFetchableUrl('https://www.ikangai.com/some-post/'));
  assert.doesNotThrow(() => assertFetchableUrl('http://example.com/'));
});

// new URL() normalizes ::ffff:127.0.0.1 to compressed hex ::ffff:7f00:1, so a
// dotted-decimal-only check on the IPv4-mapped form lets the loopback/metadata
// address through. Both spellings must classify identically (byte-based parse).
test('blocks IPv4-mapped IPv6 in BOTH spellings (URL-normalized hex form is the real risk)', () => {
  for (const u of [
    'http://[::ffff:127.0.0.1]/',        // loopback, mapped
    'http://[::ffff:169.254.169.254]/',  // cloud metadata, mapped
    'http://[::ffff:10.0.0.1]/',         // private, mapped
    'http://[::ffff:7f00:1]/',           // loopback, hex spelling (what new URL produces)
  ]) {
    assert.throws(() => assertFetchableUrl(u), /blocked|private|loopback|link-local|reserved/i, u);
  }
});

// The IPv4-compatible (deprecated) form ::a.b.c.d must also re-check its
// embedded v4 — it normalizes to ::7f00:1 etc. just like the mapped form.
test('blocks IPv4-compatible IPv6 with private embedded v4', () => {
  for (const u of ['http://[::127.0.0.1]/', 'http://[::169.254.169.254]/']) {
    assert.throws(() => assertFetchableUrl(u), /blocked|private|loopback|link-local|reserved/i, u);
  }
});

test('still allows a public IPv4-mapped and public v6', () => {
  assert.doesNotThrow(() => assertFetchableUrl('http://[::ffff:93.184.216.34]/')); // public, mapped
  assert.doesNotThrow(() => assertFetchableUrl('https://[2606:4700:4700::1111]/')); // public v6
});

// NAT64 (64:ff9b::/96) and 6to4 (2002::/16) embed an arbitrary IPv4 that, on a
// network with such gateways, reaches the embedded v4 destination. The embedded
// v4 must be re-classified — an internal v4 wrapped in either prefix is blocked.
test('blocks NAT64 / 6to4 embedded internal IPv4', () => {
  for (const u of ['http://[64:ff9b::169.254.169.254]/','http://[64:ff9b::a9fe:a9fe]/',
                   'http://[64:ff9b::a00:1]/','http://[2002:7f00:1::]/','http://[2002:a9fe:a9fe::]/']) {
    assert.throws(() => assertFetchableUrl(u), /blocked|private|loopback|link-local|reserved/i, u);
  }
});
test('allows NAT64/6to4 wrapping a PUBLIC v4', () => {
  assert.doesNotThrow(() => assertFetchableUrl('http://[64:ff9b::93.184.216.34]/'));
});
// v4 multicast (224/4) is blocked; v6 multicast (ff00::/8) must be too — close
// the asymmetry. ff02::1 is the all-nodes link-local multicast address.
test('blocks IPv6 multicast', () => {
  assert.throws(() => assertFetchableUrl('http://[ff02::1]/'), /reserved|blocked/i);
});
// new URL() normalizes decimal/octal/hex/short-form IPv4 literals to dotted-quad,
// so a naive string check would miss them; assertPublicIp sees the normalized v4.
test('blocks decimal/octal/hex/short-form IPv4 literals (new URL normalizes them)', () => {
  for (const u of ['http://2130706433/','http://0x7f.0.0.1/','http://0177.0.0.1/','http://127.1/']) {
    assert.throws(() => assertFetchableUrl(u), /blocked|private|loopback|reserved/i, u);
  }
});

// --- async fetchPage coverage (via injected deps; no real network) ----------

// A 302 whose Location points at an internal address must be re-validated and
// blocked on the redirect hop — redirect:'manual' + per-hop assertFetchableUrl.
test('fetchPage blocks a redirect to an internal address', async () => {
  const deps = {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async () => new Response(null, {
      status: 302,
      headers: { location: 'http://127.0.0.1/' },
    }),
  };
  await assert.rejects(
    () => fetchPage('https://public.example/', { deps }),
    (e) => e.subcode === 'blocked_host',
  );
});

// A public-looking hostname that resolves to a private address (DNS rebinding)
// must be blocked by assertHostResolvesPublic before any fetch is issued.
test('fetchPage blocks DNS rebinding (host resolves to private)', async () => {
  let fetched = false;
  const deps = {
    lookup: async () => [{ address: '10.0.0.1', family: 4 }],
    fetchImpl: async () => { fetched = true; return new Response('<html></html>', { status: 200 }); },
  };
  await assert.rejects(
    () => fetchPage('https://rebind.example/', { deps }),
    (e) => e.subcode === 'blocked_host',
  );
  assert.equal(fetched, false, 'fetch must not be issued when host resolves private');
});

// Happy path: public resolution + 200 text/html → returns the HTML string.
test('fetchPage returns HTML on the happy path', async () => {
  const body = '<html><body><h1>hi</h1></body></html>';
  const deps = {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
  };
  const out = await fetchPage('https://public.example/', { deps });
  assert.equal(out, body);
});

// Anchored content-type: a crafted header whose media type is svg but carries a
// `; charset=text/html` parameter must NOT pass as HTML (unanchored substring bug).
test('fetchPage rejects non-html content-type with html-looking parameters', async () => {
  const deps = {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async () => new Response('<svg/>', {
      status: 200,
      headers: { 'content-type': 'image/svg+xml; charset=text/html' },
    }),
  };
  await assert.rejects(
    () => fetchPage('https://public.example/', { deps }),
    (e) => e.subcode === 'not_html',
  );
});
