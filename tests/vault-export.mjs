// TDD — I13 (v0.9 §14) portable vault export/import (offline; escrow + account service deferred to
// v1). WHY (Rule 9): the machine-local vault is the default (v0.8 §6 honesty: a 2nd machine sees
// null); I13 lets the user CHOOSE to move credentials, under a SEPARATE transport passphrase, in a
// self-contained version-tagged file that decrypts on another machine with NO server. Load-bearing:
// the export is encrypted (ciphertext ≠ plaintext); a wrong passphrase fails before any write; the
// round-trip restores the original on a different container; accountIdentity stays opt-in (null).
import jsdomPkg from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import fs from 'node:fs';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applySeedSubs, kindOverrides, replaceInlineDoc } from '../cli/src/seed.mjs';

const { JSDOM, VirtualConsole } = jsdomPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(__dirname, '..', 'seeds', 'rewritable.html');
let pass = 0, fail = 0;
const check = (m, c) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  ✗   ' + m); } };

async function boot() {
  const ov = kindOverrides('skill-host');
  let html = fs.readFileSync(SEED, 'utf8');
  html = applySeedSubs(html, { uuid: webcrypto.randomUUID(), title: 'V', fileMeta: 'v.html', productKind: 'skill-host', lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder, productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor });
  html = replaceInlineDoc(html, ov.body);
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { const s = e?.detail?.message || ''; if (!/Not implemented: navigation/.test(s)) console.error('[jsdomError]', s); });
  const dom = new JSDOM(html, { url: 'https://v.local/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      window.indexedDB = indexedDB; window.IDBKeyRange = IDBKeyRange;
      window.fetch = async () => { throw new Error('no network'); };
      Object.defineProperty(window.navigator, 'storage', { value: { persist: () => Promise.resolve(false) }, configurable: true });
      Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
      window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
    } });
  const w = dom.window, t0 = Date.now();
  while (Date.now() - t0 < 4000) { if (w.runtime && w.runtime.vault) break; await new Promise(r => setTimeout(r, 5)); }
  return w;
}

console.log('== I13: portable vault export/import ==');
// Machine A: unlock, store a credential, export it under a transport passphrase.
const A = await boot();
await A.runtime.vault.unlock('machine-A-pass');
await A.runtime.vault.set('github-prod', 'token', 'ghp_secret_value');
await A.runtime.vault.set('github-prod', 'user', 'octocat');
check('export/import exposed on runtime.vault', typeof A.runtime.vault.export === 'function' && typeof A.runtime.vault.import === 'function');
const exp = await A.runtime.vault.export('transport-pass-123', ['github-prod']);
check('export is a version-tagged rwa-vault-export/1 carrying the namespace', exp.rwa === 'rwa-vault-export/1' && exp.namespaces.includes('github-prod') && exp.entries['github-prod'].items.length === 2);
check('export ciphertext is NOT the plaintext (encrypted under the transport passphrase)', !JSON.stringify(exp).includes('ghp_secret_value'));
check('accountIdentity is null by default (opt-in; machine-local is the default)', A.runtime.describe().accountIdentity === null);

// Machine B: a DIFFERENT container (own uuid → own vault). Import + round-trip.
const B = await boot();
await B.runtime.vault.unlock('machine-B-different-pass');
check('B starts without A\'s credential (vaults are machine/container-local)', (await B.runtime.vault.get('github-prod', 'token')) === null);
const res = await B.runtime.vault.import(exp, 'transport-pass-123');
check('import restores the namespace (imported≥2) + flags the container mismatch', res.imported === 2 && res.containerMismatch === true);
check('round-trip: B.vault.get returns A\'s original credential', (await B.runtime.vault.get('github-prod', 'token')) === 'ghp_secret_value' && (await B.runtime.vault.get('github-prod', 'user')) === 'octocat');

// A wrong transport passphrase fails BEFORE any write (the check verifier).
let wrong = null;
try { await B.runtime.vault.import(exp, 'WRONG-pass'); } catch (e) { wrong = e; }
check('a wrong transport passphrase → vault_decrypt_failed (no partial import)', wrong && /vault_decrypt_failed/.test(String(wrong.message || wrong)));
// A malformed export is rejected.
let mal = null;
try { await B.runtime.vault.import({ rwa: 'not-an-export' }, 'x'); } catch (e) { mal = e; }
check('a malformed export → account_export_malformed', mal && /account_export_malformed/.test(String(mal.message || mal)));
// Importing the same export again without overwrite skips existing entries (no clobber).
const again = await B.runtime.vault.import(exp, 'transport-pass-123');
check('re-import without overwrite skips existing entries (no silent clobber)', again.imported === 0 && again.skipped === 2);

console.log(`\n== ${pass} pass, ${fail} fail ==`);
process.exit(fail ? 1 : 0);
