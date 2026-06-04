import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertFetchableUrl } from '../src/fetch-page.mjs';

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
