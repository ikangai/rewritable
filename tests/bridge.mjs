// Security test for the `bridge` backend shell command in seeds/rewritable.html.
//
// WHY this matters (audit 2026-05-27): the bridge backend builds a shell command
// and POSTs it to a localhost shim (web_cli_bridge) that runs it. The command
// pipes a prompt — which EMBEDS THE WHOLE CURRENT DOCUMENT — into `claude -p`.
// When the document is one you received/opened from someone else, its body is
// attacker-controlled. The old command ran with `--permission-mode
// bypassPermissions`, so prompt-injection text in the document became remote code
// execution: a shared .html could silently run shell on the opener's machine the
// moment they pressed ⌘K with the bridge backend selected. The bridge agent only
// needs to EMIT TEXT (an rwa-edit envelope / naked HTML) — it needs no tools — so
// the fix removes bypassPermissions entirely.
//
// This test pins the security property at the single source of truth
// (bridgeCommand), so reintroducing the bypass anywhere the bridge runs fails CI.
//
// Run:  (cd tests && npm install && npm run test:bridge)
// Exits non-zero on any failure.

import jsdomPkg from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { JSDOM, VirtualConsole } = jsdomPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(__dirname, '..', 'seeds', 'rewritable.html');
const html = fs.readFileSync(SEED, 'utf8');

let pass = 0, fail = 0;
const check = (label, cond) => {
  if (cond) { pass++; console.log('  OK  ', label); }
  else      { fail++; console.log('  FAIL', label); }
};

const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', e => console.error('[jsdomError]', e?.detail?.stack || e?.detail || e));

const dom = new JSDOM(html, {
  url: 'https://rwa-test.local/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole,
  beforeParse(window) {
    window.indexedDB = indexedDB;
    window.IDBKeyRange = IDBKeyRange;
    window.sessionStorage.setItem('rwa_apikey', 'test-key');
    window.sessionStorage.setItem('rwa_model', 'test-model');
    window.fetch = async () => { throw new Error('no network in this test'); };
    window.BroadcastChannel = globalThis.BroadcastChannel;
    Object.defineProperty(window.navigator, 'storage', { value: { persist: () => Promise.resolve(false) }, configurable: true });
    Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true });
  },
});

const { window } = dom;
await new Promise(r => setTimeout(r, 200)); // let the bootstrap IIFE settle

console.log('== Bridge backend security (audit 2026-05-27) ==');

check('bridgeCommand is exposed by the runtime', typeof window.bridgeCommand === 'function');

const cmd = window.bridgeCommand('hello world');

// The load-bearing assertion: the bridge must NEVER grant the agent unattended
// tool access, because the prompt carries an attacker-controllable document.
check('command does NOT use --permission-mode bypassPermissions (RCE via shared doc)',
  typeof cmd === 'string' && !/bypasspermissions/i.test(cmd) && !/--permission-mode/.test(cmd));

check('command still invokes the claude CLI in print mode', /claude -p\b/.test(cmd));
check('command decodes its base64 payload', /base64 -d/.test(cmd));

// Shell-safety: a malicious document full of quotes/backticks/$()/newlines must
// not be able to break out of the single-quoted echo. base64 output is drawn
// only from [A-Za-z0-9+/=], none of which are shell-special inside single quotes.
const nasty = `'; rm -rf ~ #\n$(touch /tmp/pwned)\n\`whoami\` "$HOME" \${X}`;
const nastyCmd = window.bridgeCommand(nasty);
const quoted = nastyCmd.match(/echo '([^']*)'/);
check('payload is wrapped in a single-quoted echo (no breakout point)', !!quoted);
check('quoted payload is pure base64 — document bytes cannot reach the shell',
  !!quoted && /^[A-Za-z0-9+/=]+$/.test(quoted[1]));

// Round-trip: the fix must not corrupt the prompt. Decode the base64 back and
// confirm it equals the original (incl. non-ASCII, which the seed UTF-8 encodes).
const roundtrip = (s) => {
  const m = window.bridgeCommand(s).match(/echo '([^']*)'/);
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : null;
};
check('base64 round-trips an ASCII prompt unchanged', roundtrip('plain ascii prompt') === 'plain ascii prompt');
check('base64 round-trips a unicode prompt unchanged', roundtrip('café — 日本語 — 🎉') === 'café — 日本語 — 🎉');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
