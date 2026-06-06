// 7b — the worker-scoped CSP that structurally closes F1 (dynamic import() as a
// remote-code / exfil channel a classic Worker's global-removal cannot shut).
//
// Spec: docs/specs/re-write-able-actions-spec-v0.8.md §7 / §12.5; Invariant 18.
//
// WHY a STATIC <meta> CSP and not a boot-injected connect-src union:
//   • Blob Workers have no independent CSP — they INHERIT the creator document's
//     policy (CSP3 §2.5.5). So a page <meta> CSP governs the skill Workers too.
//     (Empirically verified in real Chromium at file:// — see commit notes.)
//   • The ONLY worker network channel that the §5a global-removal can't close is
//     `import()` (a syntactic operator, not a `self` property). `import()` is
//     governed by `script-src`. So `script-src` (omitting remote) is the wall.
//   • `connect-src` is BOTH infeasible (backend base-URLs are runtime-configurable
//     — a static allowlist can't know the user's custom ollama/lmstudio host, and
//     a `default-src`/`connect-src` policy was measured to BREAK ⌘K) AND redundant
//     (the worker has no direct fetch; tool-skill fetch is gated per-manifest by
//     the main-thread bridge). So 7b sets NO connect-src.
//   • No runtime-derived data → the CSP is STATIC, baked into the frozen <head>
//     (edit-unreachable: above the bootstrap <script>, above INLINE_DOC and the
//     #rwa-doc-mount), so the agent/lens can never weaken it.
//
// This test pins the load-bearing ARTIFACT (the seed + every emitted container +
// the regenerated references carry the exact, non-over-constrained CSP, in the
// edit-unreachable frozen head). CSP *enforcement* is browser-only (jsdom does not
// enforce CSP) and is verified empirically — see the probe results in the commit.
//
// Run directly:  node tests/csp-boot.mjs

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applySeedSubs, kindOverrides, replaceInlineDoc } from '../cli/src/seed.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(__dirname, '..');
const SEED = path.join(repo, 'seeds', 'rewritable.html');

// The exact policy — the empirically-verified minimal F1 wall.
const CSP_META =
  `<meta http-equiv="Content-Security-Policy" content="script-src 'unsafe-inline' blob:; worker-src blob:; object-src 'none'">`;

let pass = 0, fail = 0;
const check = (label, cond) => {
  if (cond) { pass++; console.log('  OK  ', label); }
  else      { fail++; console.log('  FAIL', label); }
};

const seed = fs.readFileSync(SEED, 'utf8');

// 1. The wall exists, byte-exact.
check('seed carries the exact CSP <meta>', seed.includes(CSP_META));

// 2. Edit-unreachable: in the frozen <head>, above the bootstrap script, above the
//    editable document snapshot and its mount — so neither agent nor lens can reach it.
const iCsp   = seed.indexOf('Content-Security-Policy');
const iBoot  = seed.indexOf('<script id="rwa-bootstrap">');
const iInline = seed.indexOf('const INLINE_DOC = `');
const iMount = seed.indexOf('<div id="rwa-doc-mount">');
check('CSP is before the bootstrap <script>', iCsp > -1 && iBoot > -1 && iCsp < iBoot);
check('CSP is before INLINE_DOC (not in the editable snapshot)', iCsp > -1 && iInline > -1 && iCsp < iInline);
check('CSP is before #rwa-doc-mount (not in the agent-reachable doc)', iCsp > -1 && iMount > -1 && iCsp < iMount);
check('CSP is inside <head>', iCsp > -1 && iCsp < seed.indexOf('</head>'));

// 3. NOT over-constrained — the two directives proven to break the product are absent.
//    connect-src would break ⌘K to runtime-configurable backends; default-src would
//    cascade to style-src (breaking inline styles + skins) and connect-src.
const cspContent = (seed.match(/Content-Security-Policy" content="([^"]*)"/) || [])[1] || '';
check('CSP has NO connect-src (⌘K to custom backends must survive)', !/connect-src/.test(cspContent));
check('CSP has NO default-src (inline styles + skins must survive)', !/default-src/.test(cspContent));

// 4. The directives that DO the work.
check("script-src is 'unsafe-inline' blob: (inline boot + blob worker code run; remote import blocked)",
  /script-src\s+'unsafe-inline'\s+blob:/.test(cspContent));
check('worker-src is blob: (blob workers spawn; remote workers blocked)',
  /worker-src\s+blob:/.test(cspContent));
check("object-src 'none' (plugin/embed script vector closed)",
  /object-src\s+'none'/.test(cspContent));

// 4b. The two ways script-src could be silently re-opened — pinned shut.
//     'unsafe-eval' would re-admit eval/Function/string-timeout (the F1 evasion);
//     a remote scheme in script-src would re-admit remote import().
check("CSP has NO 'unsafe-eval' (eval/Function/string-timeout evasion stays closed)",
  !/unsafe-eval/.test(cspContent));
const scriptSrc = (cspContent.match(/script-src([^;]*)/) || [])[1] || '';
check('script-src admits NO remote scheme (no http:/https:/ws:/*) — remote import() stays blocked',
  !/(https?:|wss?:|\*)/.test(scriptSrc));
// Exactness: script-src sources are EXACTLY {'unsafe-inline', blob:} — nothing else
// (no 'self', no 'nonce-…', no 'sha…', no 'strict-dynamic') could silently widen it.
const scriptSrcTokens = scriptSrc.trim().split(/\s+/).filter(Boolean).sort();
check("script-src sources are EXACTLY 'unsafe-inline' + blob: (no 'self'/nonce/hash widening)",
  JSON.stringify(scriptSrcTokens) === JSON.stringify(["'unsafe-inline'", 'blob:']));

// 4c. Worker sandbox defense-in-depth: the §5a global-removal prologue must neutralize
//     WebAssembly too (CSP already blocks WASM in Chromium via no 'wasm-unsafe-eval', but
//     the global-removal makes the block browser-independent — matches the eval/Function pattern).
check('SKILL_WORKER_PROLOGUE removes WebAssembly (browser-independent WASM block)',
  /var REMOVE = \[[^\]]*'WebAssembly'[^\]]*\]/.test(seed));

// 5. The exported references carry the identical wall (regen invariant).
for (const ref of ['hello.html', 're-write-able-spec.html']) {
  const p = path.join(repo, ref);
  if (fs.existsSync(p)) {
    check(`${ref} carries the exact CSP <meta>`, fs.readFileSync(p, 'utf8').includes(CSP_META));
  } else {
    check(`${ref} exists`, false);
  }
}

// 6. Every CLI-emitted container carries the wall — the seed substitution path must
//    not strip/relocate it (the install-dialog network-boundary claim holds for ALL
//    containers, not just the pristine seed).
for (const kind of ['document', 'presentation', 'skill-host']) {
  const ov = kindOverrides(kind);
  let html = applySeedSubs(seed, {
    uuid: crypto.randomUUID(), title: 'CSP', fileMeta: 'csp.html', productKind: kind,
    lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder,
    productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor,
  });
  html = replaceInlineDoc(html, '<article><h1>x</h1></article>');
  check(`rwa new --kind ${kind} emits a container with the CSP`, html.includes(CSP_META));
}

console.log(`\n== ${pass} pass, ${fail} fail ==`);
process.exit(fail ? 1 : 0);
