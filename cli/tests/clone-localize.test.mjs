// Tests for `rwa clone --localize-images`: inlining remote <img src> as data:
// URIs so a clone is self-contained. Network is fully mocked via the injected
// deps ({lookup, fetchImpl}) that fetch-page.mjs already exposes — no real I/O.
//
// WHY (Rule 9): the localize pass must be GRACEFUL — one unreachable / oversized
// / non-image URL leaves that <img> remote and warns, never failing the clone —
// and must keep the SSRF guards (a relative src resolving to a private host is
// blocked by the shared fetchValidatedBytes core).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { localizeImages, cloneFromHtml } from '../src/clone.mjs';
import { inspectDoc } from '../src/doc.mjs';

// Minimal 1x1 PNG.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BYTES = Uint8Array.from(atob(PNG_B64), c => c.charCodeAt(0));
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

// A deps factory: fetchImpl returns an image Response for any URL, with the
// given content-type and bytes (default the 1x1 PNG).
function imgDeps({ type = 'image/png', bytes = PNG_BYTES, status = 200 } = {}) {
  return {
    lookup: publicLookup,
    fetchImpl: async () => new Response(bytes, { status, headers: { 'content-type': type } }),
  };
}

test('localizeImages inlines a remote <img src> as a data: URI', async () => {
  const html = '<p>before</p><img src="https://cdn.example.com/pic.png" alt="x"><p>after</p>';
  const r = await localizeImages(html, 'https://example.com/post/', { deps: imgDeps() });
  assert.equal(r.inlined, 1);
  assert.match(r.html, /<img src="data:image\/png;base64,[A-Za-z0-9+/=]+" alt="x">/);
  assert.ok(!r.html.includes('https://cdn.example.com'), 'remote URL replaced');
  assert.equal(r.warnings.length, 0);
});

test('localizeImages resolves a RELATIVE src against the page URL', async () => {
  const seen = [];
  const deps = {
    lookup: publicLookup,
    fetchImpl: async (url) => { seen.push(url); return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } }); },
  };
  const r = await localizeImages('<img src="/img/a.png">', 'https://example.com/blog/post/', { deps });
  assert.equal(seen[0], 'https://example.com/img/a.png', 'relative src resolved against origin');
  assert.equal(r.inlined, 1);
});

test('localizeImages dedupes a repeated src (one fetch, both rewritten)', async () => {
  let calls = 0;
  const deps = {
    lookup: publicLookup,
    fetchImpl: async () => { calls++; return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } }); },
  };
  const html = '<img src="https://e.com/a.png"><img src="https://e.com/a.png">';
  const r = await localizeImages(html, 'https://e.com/', { deps });
  assert.equal(calls, 1, 'a repeated src is fetched once');
  assert.equal((r.html.match(/data:image\/png/g) || []).length, 2, 'both <img> rewritten');
});

test('localizeImages is graceful: an HTTP error leaves the remote URL + warns', async () => {
  const deps = { lookup: publicLookup, fetchImpl: async () => new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } }) };
  const r = await localizeImages('<img src="https://e.com/missing.png">', 'https://e.com/', { deps });
  assert.equal(r.inlined, 0);
  assert.ok(r.html.includes('https://e.com/missing.png'), 'remote URL preserved on failure');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /missing\.png/);
});

test('localizeImages is graceful: a non-image content-type is left remote', async () => {
  const deps = imgDeps({ type: 'text/html' });
  const r = await localizeImages('<img src="https://e.com/notreally.png">', 'https://e.com/', { deps });
  assert.equal(r.inlined, 0);
  assert.ok(r.html.includes('https://e.com/notreally.png'));
  assert.match(r.warnings[0], /not_image/);
});

test('localizeImages enforces the per-image cap (oversized image left remote)', async () => {
  const big = new Uint8Array(3 * 1024 * 1024); // 3 MB > 2 MB per-image cap
  const deps = imgDeps({ bytes: big });
  const r = await localizeImages('<img src="https://e.com/huge.png">', 'https://e.com/', { deps, perImage: 2 * 1024 * 1024 });
  assert.equal(r.inlined, 0);
  assert.match(r.warnings[0], /too_large/);
});

test('localizeImages stops at the total container budget', async () => {
  // Two ~1.5 MB images, total cap 2 MB → first inlines, second is over budget.
  const img = new Uint8Array(1.5 * 1024 * 1024);
  const deps = imgDeps({ bytes: img });
  const html = '<img src="https://e.com/a.png"><img src="https://e.com/b.png">';
  const r = await localizeImages(html, 'https://e.com/', { deps, perImage: 2 * 1024 * 1024, totalCap: 2 * 1024 * 1024 });
  assert.equal(r.inlined, 1, 'only the first image fits the total budget');
  // The second is skipped: either the pre-fetch budget gate (budget exhausted)
  // or the shrunken remaining allowance (too_large) — both are budget-bound.
  assert.ok(r.warnings.some(w => /budget|too_large/.test(w)), 'second image skipped for budget reasons');
});

test('localizeImages leaves a data: URI src untouched (already inline)', async () => {
  const html = '<img src="data:image/png;base64,AAAA">';
  const r = await localizeImages(html, 'https://e.com/', { deps: imgDeps() });
  assert.equal(r.inlined, 0, 'data: URIs are not remote — nothing to fetch');
  assert.equal(r.html, html);
});

test('cloneFromHtml --localize-images produces a self-contained clone (no remote img)', async () => {
  const page = '<html><head><title>Pics</title></head><body><article>'
    + '<h1>Gallery</h1><p>Look:</p><img src="https://cdn.example.com/shot.png" alt="shot">'
    + '</article></body></html>';
  const out = '/tmp/clone-localize-' + process.pid + '.html';
  try {
    await cloneFromHtml(page, out, 'https://example.com/gallery/', { localizeImages: true, deps: imgDeps() });
    const info = await inspectDoc(out);
    assert.ok(info.doc.includes('data:image/png;base64,'), 'image inlined into the clone body');
    assert.ok(!info.doc.includes('https://cdn.example.com'), 'no remote image URL remains');
  } finally { rmSync(out, { force: true }); }
});

test('cloneFromHtml WITHOUT the flag keeps the remote URL (default unchanged)', async () => {
  const page = '<html><body><article><h1>G</h1><img src="https://cdn.example.com/shot.png"></article></body></html>';
  const out = '/tmp/clone-nolocalize-' + process.pid + '.html';
  try {
    await cloneFromHtml(page, out, 'https://example.com/');
    const info = await inspectDoc(out);
    assert.ok(info.doc.includes('https://cdn.example.com/shot.png'), 'default leaves remote URLs');
  } finally { rmSync(out, { force: true }); }
});
