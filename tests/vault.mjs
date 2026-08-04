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
import { extractArgon2 } from './lib/argon2-fallback.mjs';

const { JSDOM, VirtualConsole } = jsdomPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(__dirname, '..', 'seeds', 'rewritable.html');
// I9: new vaults default to Argon2id (v1); jsdom has no Worker → inject the sync fallback.
const argon2idForPage = extractArgon2(fs.readFileSync(SEED, 'utf8')).forPage;
let pass = 0, fail = 0;
const check = (m, c) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  ✗   ' + m); } };

async function boot(uuid = webcrypto.randomUUID()) {
  const ov = kindOverrides('skill-host');
  let html = fs.readFileSync(SEED, 'utf8');
  html = applySeedSubs(html, { uuid, title: 'V', fileMeta: 'v.html', productKind: 'skill-host', lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder, productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor });
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
      window._argon2id = argon2idForPage; // jsdom has no Worker; sync Argon2id fallback (I9)
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

// ── Session-key non-persistence (docs/received-container-threat-model-2026-08-04.md, option B)
//
// WHY this matters, not just what it does: the derived AES key used to be exported and cached in
// sessionStorage so an unlocked vault survived a reload. That put the raw key in the single most
// readable place in the browser — a received container's own inline script reads it with one
// getItem, no runtime call needed, and then decrypts EVERY namespace regardless of which ones any
// skill was granted. These checks fail the moment that caching is reintroduced.
console.log('\n== session-key non-persistence ==');
{
  const uuid = webcrypto.randomUUID();
  const w2 = await boot(uuid);
  const v2 = w2.runtime.vault;
  await v2.unlock('correct horse battery staple');
  check('unlock succeeds (precondition)', v2.isLocked() === false);
  await v2.set('ns', 'k', 'secret');
  check('an unlocked vault still round-trips', (await v2.get('ns', 'k')) === 'secret');

  let cached = 'ABSENT';
  try { cached = w2.sessionStorage.getItem('rwa_vault_key'); } catch (_) { cached = null; }
  check('the derived key is NOT written to sessionStorage', cached === null);
  const anyVaultish = Object.keys(w2.sessionStorage).filter(k => /vault/i.test(k));
  check('no sessionStorage key mentions the vault at all', anyVaultish.length === 0);

  // The user-visible consequence of the above: a reload re-prompts. Same DOC_UUID, so the same
  // IDB record — only the in-memory key is gone.
  const w3 = await boot(uuid);
  check('a reloaded container starts LOCKED (re-prompt, not restore)', w3.runtime.vault.isLocked() === true);
  check('the vault RECORD survived the reload — only the key was lost',
    (await w3.runtime.vault.has('ns', 'k')) === true);
  check('locked reads return null rather than throwing', (await w3.runtime.vault.get('ns', 'k')) === null);

  // Cover the EXISTING-vault unlock path too, not just the new-vault one. unlock() assigns the
  // key at three separate sites (new vault / KDF migration / existing vault); an assertion that
  // only exercises the first would pass while caching was reintroduced on either of the others.
  // Found by checking that this test can actually fail.
  await w3.runtime.vault.unlock('correct horse battery staple');
  check('re-unlocking an EXISTING vault succeeds', w3.runtime.vault.isLocked() === false);
  check('value decrypts after the reload+unlock', (await w3.runtime.vault.get('ns', 'k')) === 'secret');
  let cached3 = 'ABSENT';
  try { cached3 = w3.sessionStorage.getItem('rwa_vault_key'); } catch (_) { cached3 = null; }
  check('existing-vault unlock ALSO writes no session key', cached3 === null);
}
// NOT covered here: the RWA.VAULT_IDLE_MS auto-lock actually firing. jsdom would have to sit
// through the real 15-minute timer, and shortening it needs a seam this change deliberately did
// not add. The lock PATH is covered by the existing lock() checks above; the timer wiring is
// browser-verifiable only. Stated rather than silently skipped.

console.log(`\n== ${pass} pass, ${fail} fail ==`);
process.exit(fail ? 1 : 0);
