// LIVE end-to-end: the rwa's modifyViaSession -> REAL web_cli_bridge -> REAL
// claude -> applyEdits. The whole loop with no mocks. Opt-in.
//
//   WCB_SESSION_LIVE=1 \
//   WCB_SESSION_LIVE_TOKEN=<the bridge's WEB_CLI_BRIDGE_TOKEN> \
//   WCB_SESSION_LIVE_CWD=<an existing dir on this host> \
//   node session-live.mjs
//
// The bridge must already be running with that token and with
// WCB_ALLOWED_ORIGINS including this harness's origin (https://rwa-test.local).
// Skips (exit 0) unless WCB_SESSION_LIVE=1.

import jsdomPkg from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.WCB_SESSION_LIVE !== '1') {
  console.log('SKIP session-live — set WCB_SESSION_LIVE=1 (needs a running bridge + real claude)');
  process.exit(0);
}
const TOKEN = process.env.WCB_SESSION_LIVE_TOKEN || '';
const CWD = process.env.WCB_SESSION_LIVE_CWD || '';
if (!TOKEN || !CWD) {
  console.error('need WCB_SESSION_LIVE_TOKEN + WCB_SESSION_LIVE_CWD');
  process.exit(1);
}

const { JSDOM, VirtualConsole } = jsdomPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let html = fs.readFileSync(path.join(__dirname, '..', 'seeds', 'rewritable.html'), 'utf8');
// Test-only: point the seed's hardcoded BRIDGE_URL at a spare port so this can
// run alongside an installed bridge on 8765 (no seed change).
const PORT = process.env.WCB_SESSION_LIVE_PORT || '8765';
if (PORT !== '8765') html = html.replace('http://127.0.0.1:8765/run', 'http://127.0.0.1:' + PORT + '/run');
const ORIGIN = 'https://rwa-test.local';

const vc = new VirtualConsole();
vc.on('jsdomError', e => console.error('[jsdomError]', e?.detail?.stack || e?.detail || e));

const dom = new JSDOM(html, {
  url: ORIGIN + '/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    window.indexedDB = indexedDB;
    window.IDBKeyRange = IDBKeyRange;
    window.sessionStorage.setItem('rwa_backend', 'bridge-session');
    window.sessionStorage.setItem('rwa_bridge_token', TOKEN);
    window.sessionStorage.setItem('rwa_bridge_cwd', CWD);
    // REAL network + the streaming primitives modifyViaSession's SSE reader uses.
    window.fetch = (...a) => globalThis.fetch(...a);
    window.ReadableStream = globalThis.ReadableStream;
    window.TextDecoder = globalThis.TextDecoder;
    window.TextEncoder = globalThis.TextEncoder;
    window.BroadcastChannel = globalThis.BroadcastChannel;
    Object.defineProperty(window.navigator, 'storage', {
      value: { persist: () => Promise.resolve(false),
               estimate: () => Promise.resolve({ usage: 0, quota: 1e9 }) },
      configurable: true });
    Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true });
  },
});

const { window } = dom;
await new Promise(r => setTimeout(r, 300));   // bootstrap IIFE

const mount = () => window.document.getElementById('rwa-doc-mount').innerHTML;
const prog = () => (window.document.querySelector('#rwa-lens-progress .rwa-lens-prog-text')?.textContent) || '';

console.log('== LIVE bridge-session e2e (real claude through web_cli_bridge) ==');
console.log('  before:', mount().replace(/\s+/g, ' ').trim().slice(0, 120));

const MARK = 'LIVE_SESSION_OK_' + Date.now();
const instruction = 'Append a new paragraph at the very end of the document containing exactly this text and nothing else: ' + MARK;
console.log('  instruction:', instruction);

await window.modifyViaSession(instruction);

console.log('  progress:', prog());
console.log('  after:', mount().replace(/\s+/g, ' ').trim().slice(0, 240));

const ok = mount().includes(MARK);
console.log(ok
  ? `\nPASS — real claude produced an envelope that modifyViaSession applied (${MARK} present in the doc)`
  : `\nFAIL — the marker did not land in the document (progress: ${prog()})`);
process.exit(ok ? 0 : 1);
