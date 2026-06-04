// TDD — increment 8: runtime.vault (v0.8 §6). PBKDF2-200k + AES-256-GCM, IDB rwa_vault,
// session-key in sessionStorage, the §6 error vocabulary. (The bridge:vault namespace gate
// + the worker round-trip are browser-verified separately — jsdom has no Workers.)
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
  const w = dom.window; const t0 = Date.now();
  while (Date.now() - t0 < 4000) { if (w.runtime && w.runtime.vault) break; await new Promise(r => setTimeout(r, 5)); }
  return w;
}

console.log('== increment 8: runtime.vault ==');
const w = await boot();
const v = w.runtime.vault;
check('runtime.vault present with the §6 surface', v && ['get','set','has','namespaces','unlock','lock','isLocked'].every(k => typeof v[k] === 'function'));
check('starts LOCKED', v.isLocked() === true);

// get on a locked vault → null (not an error)
check('get on a locked vault → null', (await v.get('github', 'token')) === null);
// set on a locked vault → vault_locked
let setLockedErr = null; try { await v.set('github', 'token', 'x'); } catch (e) { setLockedErr = e.message; }
check('set on a locked vault throws vault_locked', setLockedErr === 'vault_locked');

// unlock → set/get round-trip (PBKDF2 + AES-GCM)
check('unlock returns true', (await v.unlock('correct horse')) === true);
check('isLocked false after unlock', v.isLocked() === false);
check('set returns true when unlocked', (await v.set('github', 'token', { t: 'ghp_secret', n: 42 })) === true);
const got = await v.get('github', 'token');
check('get round-trips the decrypted value', got && got.t === 'ghp_secret' && got.n === 42);
check('has(present) true / has(absent) false', (await v.has('github', 'token')) === true && (await v.has('github', 'nope')) === false);
check('get on a missing key → null', (await v.get('github', 'missing')) === null);
await v.set('stripe', 'sk', 'sk_x');
check('namespaces() lists distinct namespaces', JSON.stringify((await v.namespaces()).sort()) === JSON.stringify(['github', 'stripe']));

// lock → get returns null again; re-unlock with the SAME passphrase recovers the value (persisted)
v.lock();
check('after lock, isLocked true + get → null', v.isLocked() === true && (await v.get('github', 'token')) === null);
check('re-unlock with the correct passphrase succeeds', (await v.unlock('correct horse')) === true);
const got2 = await v.get('github', 'token');
check('value survives lock/unlock (encrypted at rest)', got2 && got2.t === 'ghp_secret');

// wrong passphrase → vault_bad_passphrase (the verifier check fails), vault stays locked
v.lock();
let badErr = null; try { await v.unlock('WRONG passphrase'); } catch (e) { badErr = e.message; }
check('wrong passphrase → vault_bad_passphrase', badErr === 'vault_bad_passphrase');
check('vault stays locked after a bad passphrase', v.isLocked() === true);

console.log(`\n== ${pass} pass, ${fail} fail ==`);
process.exit(fail ? 1 : 0);
