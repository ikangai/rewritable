// assertSelfContained — the code-enforced self-containment guard for `rwa create`
// output (design 2026-05-31 §4.5). A created rewritable must open and run with ZERO
// external RUNTIME dependencies (Invariant 1). This is an ALLOWLIST over the full
// static fetch surface: a URL is allowed only if it is data:, a #fragment, an
// authority-less relative path, or a non-fetching scheme (mailto:/tel:). Anything
// that triggers a network fetch — http/https, protocol-relative //host, ftp/ws —
// is rejected. The surface scanned: src/href/xlink:href/poster/data attributes,
// srcset, and CSS url()/@import in inline <style> and style= attributes.
//
// SCOPE (honest, Rule 12): this is a STATIC markup/CSS guard. It does NOT inspect
// inline-JS runtime calls (fetch()/XHR/import()/new Image().src) — those are
// prompt-governed for v1, not caught here. findExternalRefs documents exactly what
// is covered; uncovered vectors are named, not silently passed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSelfContained, findExternalRefs } from '../src/self-contained.mjs';
import { CliError } from '../src/edit.mjs';

// ─── findExternalRefs: the pure detector ──────────────────────────────

test('a fully self-contained doc has no external refs', () => {
  const html = `<article><h1>Hi</h1>
    <img src="logo.png" alt="x">
    <a href="#section">jump</a>
    <a href="page2.html">next</a>
    <a href="mailto:x@y.com">mail</a>
    <a href="tel:+123">call</a>
    <img src="data:image/png;base64,iVBORw0KGgo=">
    <style>.b{background:url(local.png)}</style>
    <svg><use href="#icon"/></svg>
  </article>`;
  assert.deepEqual(findExternalRefs(html), []);
  assert.doesNotThrow(() => assertSelfContained(html));
});

test('rejects an http(s) <script src> (the canonical CDN tag)', () => {
  // WHY: a runtime CDN <script src> is THE thing that breaks "send the file, they
  // have everything" — it must fail loud, not ship.
  const html = `<div><script src="https://cdnjs.cloudflare.com/d3.min.js"></script></div>`;
  const refs = findExternalRefs(html);
  assert.equal(refs.length, 1);
  assert.match(refs[0].url, /cdnjs/);
});

test('rejects a protocol-relative //host reference (no scheme token, still fetches)', () => {
  // WHY: //cdn/x.js has no http/https token but the browser fetches it over the
  // page protocol — a scheme-denylist would miss it; the allowlist catches it.
  const html = `<link rel="stylesheet" href="//cdn.example.com/style.css">`;
  assert.equal(findExternalRefs(html).length, 1);
});

test('rejects external url() inside an inline <style> block', () => {
  // WHY: CSS @font-face/background can fetch over the network just like a src=.
  const html = `<style>@font-face{font-family:x;src:url(https://fonts.example/x.woff2)}</style>`;
  const refs = findExternalRefs(html);
  assert.equal(refs.length, 1);
  assert.match(refs[0].url, /fonts\.example/);
});

test('rejects external @import inside an inline <style> block', () => {
  const html = `<style>@import "https://cdn.example/reset.css";</style>`;
  assert.equal(findExternalRefs(html).length, 1);
});

test('rejects external url() inside an inline style= attribute', () => {
  const html = `<div style="background:url('https://cdn.example/bg.jpg')"></div>`;
  assert.equal(findExternalRefs(html).length, 1);
});

test('rejects an external entry inside a srcset list', () => {
  // WHY: srcset is comma-separated "url descriptor" pairs; a single external entry
  // among local ones still fetches.
  const html = `<img srcset="a.jpg 1x, https://cdn.example/b.jpg 2x" src="a.jpg">`;
  const refs = findExternalRefs(html);
  assert.equal(refs.length, 1);
  assert.match(refs[0].url, /cdn\.example/);
});

test('rejects external <source src>, <track src>, <object data>, <embed src>, <use xlink:href>', () => {
  // WHY: the fetch surface is wider than src/href — each of these can pull bytes.
  const html = `
    <video><source src="https://cdn.example/v.mp4"></video>
    <video><track src="https://cdn.example/c.vtt"></video>
    <object data="https://cdn.example/o.pdf"></object>
    <embed src="https://cdn.example/e.swf">
    <svg><use xlink:href="https://cdn.example/sprite.svg#i"/></svg>`;
  assert.equal(findExternalRefs(html).length, 5);
});

test('does NOT flag a data-* attribute that merely starts with "data"', () => {
  // WHY: <object data=> is a URL attribute, but data-rwa-id / data-anything are not.
  // The scan must not false-positive on the reserved runtime attributes.
  const html = `<div data-rwa-id="b3" data-config="https://example.com/x">ok</div>`;
  // data-config is a custom data-* attr, NOT the <object data> URL attribute → ignored.
  assert.deepEqual(findExternalRefs(html), []);
});

test('allows mailto:, tel:, data:, fragment, and relative — non-fetching or local', () => {
  const html = `
    <a href="mailto:a@b.co">m</a><a href="tel:+1">t</a>
    <a href="#x">f</a><a href="./rel/path.html">r</a>
    <img src="data:image/svg+xml,<svg/>">`;
  assert.deepEqual(findExternalRefs(html), []);
});

// ─── assertSelfContained: throws the load-bearing CliError ────────────

test('assertSelfContained throws CliError(4, not_self_contained) listing the offending url', () => {
  const html = `<script src="https://cdnjs.cloudflare.com/chart.js"></script>`;
  try {
    assertSelfContained(html);
    assert.fail('expected assertSelfContained to throw');
  } catch (e) {
    assert.ok(e instanceof CliError, 'must be a CliError so the CLI maps exit code 4');
    assert.equal(e.exitCode, 4);
    assert.equal(e.subcode, 'not_self_contained');
    assert.match(JSON.stringify(e.details), /cdnjs/);
  }
});

test('assertSelfContained is a no-op on a clean doc (returns, does not throw)', () => {
  assert.doesNotThrow(() => assertSelfContained('<article><p>just prose</p></article>'));
});
