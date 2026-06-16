// Workspace live autodiscovery over runtime.bus.
//
// Run: node tests/workspace-presence.mjs

import jsdomPkg from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applySeedSubs, kindOverrides, replaceInlineDoc } from '../cli/src/seed.mjs';
import { buildWorkspaceBody } from '../cli/src/workspace.mjs';

const { JSDOM, VirtualConsole } = jsdomPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(__dirname, '..', 'seeds', 'rewritable.html');
const seed = fs.readFileSync(SEED, 'utf8');

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log('  OK  ', label); }
  else      { fail++; console.log('  FAIL', label); }
}
const tick = () => new Promise(r => setTimeout(r, 0));
async function waitFor(pred, ms = 2500) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await tick(); }
  return pred();
}

function buildKind(kind, body, fileMeta) {
  const ov = kindOverrides(kind);
  let html = applySeedSubs(seed, {
    uuid: crypto.randomUUID(),
    title: fileMeta || kind,
    fileMeta: fileMeta || kind + '.html',
    productKind: kind,
    lensPlaceholder: ov.lensPlaceholder,
    palPlaceholder: ov.palPlaceholder,
    productHeader: ov.productHeader,
    lensClickToAnchor: ov.lensClickToAnchor,
  });
  return replaceInlineDoc(html, body == null ? ov.body : body);
}

async function boot(html, url) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => console.error('[jsdomError]', e?.detail?.stack || e?.detail || e));
  const dom = new JSDOM(html, {
    url,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.indexedDB = indexedDB;
      window.IDBKeyRange = IDBKeyRange;
      window.BroadcastChannel = globalThis.BroadcastChannel;
      window.fetch = () => Promise.reject(new Error('no network in workspace presence test'));
      Object.defineProperty(window.navigator, 'storage', { value: { persist: () => Promise.resolve(false) }, configurable: true });
      Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true });
    },
  });
  await waitFor(() => dom.window.runtime && dom.window.getDoc);
  await new Promise(r => setTimeout(r, 50));
  return dom;
}

console.log('== Workspace presence bus ==');

const indexHtml = buildKind(
  'workspace',
  buildWorkspaceBody({ name: 'Knowledge Base', docs: [] }),
  'rwa-index.html',
);
const sameDirHtml = buildKind(
  'document',
  '<article><h1>Shared Note</h1><p>Saved into the workspace folder.</p></article>',
  'shared-note.html',
);
const otherDirHtml = buildKind(
  'document',
  '<article><h1>Outside Note</h1><p>Not in this workspace folder.</p></article>',
  'outside-note.html',
);

const index = await boot(indexHtml, 'https://kb.local/work/rwa-index.html');
const sibling = await boot(sameDirHtml, 'https://kb.local/work/shared-note.html');
const outside = await boot(otherDirHtml, 'https://kb.local/other/outside-note.html');

check('runtime.bus exposes publish/subscribe', typeof index.window.runtime.bus.publish === 'function' && typeof index.window.runtime.bus.subscribe === 'function');
let reserved = null;
try { index.window.runtime.bus.subscribe('rwa:internal', () => {}); } catch (e) { reserved = e; }
check('runtime.bus rejects reserved rwa topics', !!reserved && /reserved/i.test(reserved.message));

await waitFor(() => /Shared Note/.test(index.window.document.querySelector('[data-rwa-workspace-live]')?.textContent || ''));
const liveText = index.window.document.querySelector('[data-rwa-workspace-live]')?.textContent || '';
check('workspace index discovers open sibling rewritable', /Shared Note/.test(liveText));
check('live sibling is marked new until workspace sync indexes it', /new since sync/i.test(liveText));
check('workspace index ignores open rewritable outside its directory', !/Outside Note/.test(liveText));

// ── XSS hardening (security review 2026-06-16): a presence peer's url is untrusted —
// anyone in the origin can publish to the public 'workspace:presence' topic. The card
// href must be a scheme-validated, parser-normalized URL, never the raw peer string;
// escaping blocks attribute breakout but NOT a `javascript:` scheme, which would
// execute on click. Pins the sink so a future refactor of the dir gate can't reopen it.
const evilDir = 'https://kb.local/work/';
sibling.window.runtime.bus.publish('workspace:presence', {
  schema: 'rwa-presence/1', action: 'hello', uuid: 'evil-newline',
  kind: 'document', title: 'Injected Peer', file: 'injected.html',
  url: evilDir + '\njavascript:alert(1)', affordances: [],
});
sibling.window.runtime.bus.publish('workspace:presence', {
  schema: 'rwa-presence/1', action: 'hello', uuid: 'evil-pure',
  kind: 'document', title: 'Pure JS Peer', file: 'purejs.html',
  url: 'javascript:alert(1)', affordances: [],
});
await waitFor(() => /Injected Peer/.test(index.window.document.querySelector('[data-rwa-workspace-live-grid]')?.textContent || ''));
const liveCards = [...index.window.document.querySelectorAll('[data-rwa-workspace-live-grid] a.rwa-ws-card')];
const injected = liveCards.find(a => /Injected Peer/.test(a.textContent || ''));
check('newline-laced peer url that passes the dir gate still renders (the href sink is exercised)', !!injected);
const injHref = injected ? injected.getAttribute('href') : '';
check('presence card href is parser-normalized — no raw control chars echoed from the peer string', !!injHref && !/[\n\r\t]/.test(injHref));
check('no presence card ever emits a script-executing href (javascript:/data:/vbscript:)',
  liveCards.length > 0 && liveCards.every(a => !/^\s*(?:javascript|data|vbscript):/i.test(a.getAttribute('href') || '')));

index.window.close();
sibling.window.close();
outside.window.close();

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
