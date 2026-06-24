// TDD — I9 (v0.9 §13) Argon2id vault KDF. WHY (Rule 9): PBKDF2-200k is fast and
// GPU/ASIC-brute-forceable offline (the attacker holds the salt); Argon2id (m=64 MiB)
// is memory-hard (OWASP). The upgrade must (a) be REAL Argon2id — pinned against the
// RFC 9106 §5.3 vector, not merely deterministic; (b) default new vaults to v1 while a
// v0.8 vault keeps working untouched (forward-compat, no silent renumber); (c) migrate
// existing credentials with NO loss and re-derive under Argon2id on next unlock;
// (d) never silently downgrade (kdf_version>1 → vault_unknown_kdf_version); (e) leave
// the vault LOCKED and the stored record INTACT if a migration fails mid-way (atomic);
// (f) not break I13's PBKDF2 transport export. The pure-JS path keeps the frozen CSP
// unchanged (Inv 26/44/18 held) — the whole point of doing this without WASM.
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
const SEED_PATH = path.join(__dirname, '..', 'seeds', 'rewritable.html');
const SEED = fs.readFileSync(SEED_PATH, 'utf8');
let pass = 0, fail = 0;
const check = (m, c) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  ✗   ' + m); } };

// the vendored Argon2id extracted from the seed exactly as the runtime ships it (block A
// pins it against the RFC vector; the jsdom pages use forPage as their sync fallback).
const { ARGON2_SRC, argon2id: nobleArgon2id, forPage: argon2idForPage } = extractArgon2(SEED);

const hex = (u8) => Array.from(u8, b => b.toString(16).padStart(2, '0')).join('');

async function boot(uuid) {
  const ov = kindOverrides('skill-host');
  let html = applySeedSubs(SEED, { uuid, title: 'V', fileMeta: 'v.html', productKind: 'skill-host', lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder, productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor });
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
      // jsdom has no Worker → the runtime's _argon2idHash falls back to globalThis._argon2id.
      window._argon2id = argon2idForPage;
    } });
  const w = dom.window, t0 = Date.now();
  while (Date.now() - t0 < 4000) { if (w.runtime && w.runtime.vault) break; await new Promise(r => setTimeout(r, 5)); }
  return w;
}

// raw access to the shared fake-indexeddb record (simulates inspecting/planting on disk)
const dbName = (uuid) => 'rwa_' + uuid;
function idbRead(uuid) {
  return new Promise((res, rej) => {
    const r = indexedDB.open(dbName(uuid));
    r.onsuccess = () => { const db = r.result; const tx = db.transaction('rwa_vault'); const g = tx.objectStore('rwa_vault').get('self'); g.onsuccess = () => { res(g.result); db.close(); }; tx.onerror = () => rej(tx.error); };
    r.onerror = () => rej(r.error);
  });
}
function idbPlant(uuid, value) {
  return new Promise((res, rej) => {
    const r = indexedDB.open(dbName(uuid));
    r.onsuccess = () => { const db = r.result; const tx = db.transaction('rwa_vault', 'readwrite'); tx.objectStore('rwa_vault').put(value, 'self'); tx.oncomplete = () => { res(); db.close(); }; tx.onerror = () => rej(tx.error); };
    r.onerror = () => rej(r.error);
  });
}

console.log('== I9: Argon2id vault KDF ==');

// ── A — the inlined ARGON2_SRC is GENUINE Argon2id (RFC 9106 §5.3 vector) ──
{
  const pwd = new Uint8Array(32).fill(1), salt = new Uint8Array(16).fill(2), key = new Uint8Array(8).fill(3), ad = new Uint8Array(12).fill(4);
  const tag = nobleArgon2id(pwd, salt, { t: 3, m: 32, p: 4, key, ad, dkLen: 32 });
  check('A: seed ARGON2_SRC matches the RFC 9106 §5.3 Argon2id vector', hex(tag) === '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659');
  check('A: ARGON2_SRC carries no </script (safe to inline)', !ARGON2_SRC.includes('</script'));
}

// ── B — a NEW vault defaults to kdf_version 1 (Argon2id) and round-trips ──
{
  const U = webcrypto.randomUUID();
  const A = await boot(U);
  await A.runtime.vault.unlock('new-vault-pass');
  await A.runtime.vault.set('svc', 'tok', 'secret-1');
  const rec = await idbRead(U);
  check('B: new vault persisted kdf_version === 1', rec && rec.kdf_version === 1);
  const B = await boot(U);
  await B.runtime.vault.unlock('new-vault-pass');
  check('B: reload under Argon2id returns the stored credential', (await B.runtime.vault.get('svc', 'tok')) === 'secret-1');
}

// ── C — a v0.8 (PBKDF2) vault keeps working untouched (forward-compat) ──
const V2 = webcrypto.randomUUID();
{
  const A = await boot(V2);
  await A.runtime.vault.unlock('legacy-pass', { targetKdfVersion: 0 }); // create a genuine v0 (PBKDF2) vault
  await A.runtime.vault.set('git', 'pat', 'ghp_legacy');
  const rec = await idbRead(V2);
  check('C: v0 vault persisted kdf_version === 0 (PBKDF2)', rec && rec.kdf_version === 0);
  const B = await boot(V2);
  await B.runtime.vault.unlock('legacy-pass'); // no options → stays on PBKDF2
  check('C: v0 vault unlocks with no options and returns the credential', (await B.runtime.vault.get('git', 'pat')) === 'ghp_legacy');
  check('C: wrong passphrase on a v0 vault is rejected', await B.runtime.vault.unlock('wrong').then(() => false, e => /vault_bad_passphrase/.test(e.message)));
}

// ── D — explicit migration v0 → v1 re-encrypts all entries, no loss ──
{
  const C = await boot(V2);
  await C.runtime.vault.unlock('legacy-pass', { targetKdfVersion: 1 }); // migrate
  const rec = await idbRead(V2);
  check('D: migration persisted kdf_version === 1', rec && rec.kdf_version === 1);
  check('D: migrated credential is readable immediately', (await C.runtime.vault.get('git', 'pat')) === 'ghp_legacy');
  const D = await boot(V2);
  await D.runtime.vault.unlock('legacy-pass'); // no options → now derives under Argon2id
  check('D: after reload the credential decrypts under Argon2id', (await D.runtime.vault.get('git', 'pat')) === 'ghp_legacy');
  check('D: old passphrase still required after migration', await D.runtime.vault.unlock('legacy-pass').then(() => true));
}

// ── E — an unknown kdf_version is rejected, no silent downgrade ──
{
  const U = webcrypto.randomUUID();
  const A = await boot(U);
  await A.runtime.vault.unlock('x', { targetKdfVersion: 0 }); // create the DB + stores
  await idbPlant(U, { salt: A.btoa('AAAAAAAAAAAAAAAA'), kdf_version: 99, check: null, entries: {} });
  const B = await boot(U);
  check('E: kdf_version 99 → vault_unknown_kdf_version', await B.runtime.vault.unlock('x').then(() => false, e => /vault_unknown_kdf_version/.test(e.message)));
  check('E: vault stays locked after the rejection', B.runtime.vault.isLocked() === true);
}

// ── F — a mid-migration failure leaves the vault LOCKED and the stored record INTACT ──
{
  const U = webcrypto.randomUUID();
  const A = await boot(U);
  await A.runtime.vault.unlock('atomic-pass', { targetKdfVersion: 0 });
  await A.runtime.vault.set('s', 'k', 'before-migrate');
  const before = await idbRead(U);
  const B = await boot(U);
  B._argon2id = undefined; // force the Argon2id derive to fail (no Worker, no fallback)
  const rejected = await B.runtime.vault.unlock('atomic-pass', { targetKdfVersion: 1 }).then(() => false, () => true);
  check('F: a failed migration rejects', rejected);
  check('F: vault stays locked after a failed migration', B.runtime.vault.isLocked() === true);
  const after = await idbRead(U);
  check('F: stored record is unchanged (kdf_version still 0, no partial state)', after.kdf_version === 0 && JSON.stringify(after) === JSON.stringify(before));
  const C = await boot(U); // recover: argon2 available again
  await C.runtime.vault.unlock('atomic-pass');
  check('F: old credential still readable after the aborted migration', (await C.runtime.vault.get('s', 'k')) === 'before-migrate');
}

// ── G — auto-migrate-on-empty: a v0 record with no data adopts v1 on first unlock ──
{
  const U = webcrypto.randomUUID();
  const A = await boot(U);
  await A.runtime.vault.unlock('g', { targetKdfVersion: 0 });
  const salt0 = (await idbRead(U)).salt;
  await idbPlant(U, { salt: salt0, kdf_version: 0, check: null, entries: {} }); // v0 but EMPTY
  const B = await boot(U);
  await B.runtime.vault.unlock('g');
  check('G: empty v0 vault auto-adopts kdf_version 1 on unlock', (await idbRead(U)).kdf_version === 1);
}

// ── H — I13 export transport is still PBKDF2 (regression: _vaultDeriveKey default unchanged) ──
{
  const U = webcrypto.randomUUID();
  const A = await boot(U);
  await A.runtime.vault.unlock('host-pass'); // v1 vault
  await A.runtime.vault.set('ns', 'k', 'travel-me');
  const exp = await A.runtime.vault.export('transport-pass', ['ns']);
  // independently decrypt the export's check using a PBKDF2-200k key — proves the
  // transport KDF is PBKDF2 (kdfVersion default 0), untouched by I9.
  const e = exp.entries['ns'];
  const km = await webcrypto.subtle.importKey('raw', new TextEncoder().encode('transport-pass'), 'PBKDF2', false, ['deriveKey']);
  const tkey = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', salt: Uint8Array.from(atob(e.salt), c => c.charCodeAt(0)), iterations: 200000, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  let ok = false;
  try { const pt = new TextDecoder().decode(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: Uint8Array.from(atob(e.check.iv), c => c.charCodeAt(0)) }, tkey, Uint8Array.from(atob(e.check.ct), c => c.charCodeAt(0)))); ok = pt === 'rwa-vault-export-ok'; } catch (_) {}
  check('H: I13 export transport check decrypts under PBKDF2-200k (default KDF unchanged)', ok);
  const B = await boot(webcrypto.randomUUID());
  await B.runtime.vault.unlock('other-pass'); // a different v1 vault
  const res = await B.runtime.vault.import(exp, 'transport-pass');
  check('H: a PBKDF2 export imports into a v1 vault and round-trips', res.imported >= 1 && (await B.runtime.vault.get('ns', 'k')) === 'travel-me');
}

// ── I — the upgrade button is shown for skill-host, the API is wired ──
{
  const U = webcrypto.randomUUID();
  const A = await boot(U);
  const row = A.document.getElementById('rwa-set-row-vault-kdf');
  check('I: skill-host shows the Vault KDF upgrade row', !!row && row.style.display !== 'none');
  check('I: the upgrade button exists', !!A.document.getElementById('rwa-vault-upgrade'));
}

console.log('\n== ' + pass + ' pass, ' + fail + ' fail ==');
process.exit(fail ? 1 : 0);
