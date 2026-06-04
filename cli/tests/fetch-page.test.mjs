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
