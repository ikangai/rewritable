// TDD — increment 9: the install dialog's LOGIC (v0.8 §1). runtime.reviewSkill (the structured
// trust info the dialog renders) + runtime.installSkill (validate-gates + Ed25519 verify + register
// in-memory). The dialog DOM + the visual layout are browser-verified separately (jsdom has no
// layout). Signs with the CLI signingMessage so seed-live verify == CLI-static.
import jsdomPkg from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import fs from 'node:fs';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applySeedSubs, kindOverrides, replaceInlineDoc } from '../cli/src/seed.mjs';
import { signingMessage } from '../cli/src/skill-manifest.mjs';

const { JSDOM, VirtualConsole } = jsdomPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(__dirname, '..', 'seeds', 'rewritable.html');
let pass = 0, fail = 0;
const check = (m, c) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  ✗   ' + m); } };

async function makeSigned(name, kind, permissions, code) {
  const kp = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const rawPub = new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey));
  const author_pubkey = Buffer.from(rawPub).toString('base64');
  const manifest = { name, version: '1.0.0', kind, permissions, author_pubkey };
  const sig = new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, signingMessage(manifest, code)));
  return { format: 'rwa-skill/1', skill: { ...manifest, code }, signature: Buffer.from(sig).toString('base64') };
}
const unsigned = (name, kind, permissions, code) => ({ format: 'rwa-skill/1', skill: { name, version: '1.0.0', kind, permissions, author_pubkey: 'AAAA', code } });
// Raw-IDB store clear — to simulate an IDB-cleared reload for the name_history rebuild test.
// Uses the same fake-indexeddb instance the seed runs on (set via beforeParse), keyed by DOC_UUID.
function clearStore(w, store) {
  return new Promise((res, rej) => {
    const req = indexedDB.open('rwa_' + w.runtime.id);
    req.onsuccess = () => { const db = req.result; const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).clear(); tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => rej(tx.error); };
    req.onerror = () => rej(req.error);
  });
}

async function boot() {
  const ov = kindOverrides('skill-host');
  let html = fs.readFileSync(SEED, 'utf8');
  html = applySeedSubs(html, { uuid: webcrypto.randomUUID(), title: 'H', fileMeta: 'h.html', productKind: 'skill-host', lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder, productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor });
  html = replaceInlineDoc(html, ov.body);
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { const s = e?.detail?.message || ''; if (!/Not implemented: navigation/.test(s)) console.error('[jsdomError]', s); });
  const dom = new JSDOM(html, { url: 'https://h.local/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      window.indexedDB = indexedDB; window.IDBKeyRange = IDBKeyRange;
      window.fetch = async () => { throw new Error('no network'); };
      Object.defineProperty(window.navigator, 'storage', { value: { persist: () => Promise.resolve(false) }, configurable: true });
      Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
      window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
    } });
  const w = dom.window, t0 = Date.now();
  while (Date.now() - t0 < 4000) { if (w.runtime && w.runtime.installSkill) break; await new Promise(r => setTimeout(r, 5)); }
  return w;
}

console.log('== increment 9: install dialog logic ==');
const w = await boot();
check('runtime exposes reviewSkill + installSkill', typeof w.runtime?.reviewSkill === 'function' && typeof w.runtime?.installSkill === 'function');

// reviewSkill: a signed tool with vault + network → prose, compound-risk, signed/verified, gates ok
{
  const env = await makeSigned('gh-sync', 'tool', ['vault:github', 'network:api.github.com'], 'async function run(i,r){return 1}');
  const rv = await w.runtime.reviewSkill(env);
  check('review: permissions rendered as prose', rv.permissions.length === 2 && /credentials stored under/i.test(rv.permissions.find(p => p.perm.startsWith('vault')).prose));
  check('review: compound-risk fires on vault+network', typeof rv.compoundRisk === 'string' && /credential/i.test(rv.compoundRisk));
  check('review: signed tool verifies', rv.signed === true && rv.verified === true);
  check('review: a signed tool with valid perms passes the gates', rv.gates.ok === true);
}
// reviewSkill: an unsigned compute with permissions → both gate failures
{
  const rv = await w.runtime.reviewSkill(unsigned('bad', 'compute', ['network:x.com'], 'async function run(){}'));
  check('review: unsigned+compute+perms fails gates with the right codes', rv.gates.ok === false && rv.gates.errors.includes('unsigned_with_permissions') && rv.gates.errors.includes('compute_with_permissions'));
  check('review: unsigned → verified false', rv.verified === false);
}
// installSkill: a valid signed no-perm compute → registered in-memory (describe/listSkills see it)
{
  const env = await makeSigned('counter', 'compute', [], 'async function run(i){return i.length}');
  const res = await w.runtime.installSkill(env);
  check('install: valid skill returns ok + skillId', res.ok === true && typeof res.skillId === 'string');
  check('install: the skill is now in listSkills()', w.runtime.listSkills().some(s => s.name === 'counter'));
  check('install: describe() unions the just-installed skill', w.runtime.describe().affordances.some(a => a.name === 'counter' && a.provenance === 'installed'));
}
// installSkill: a gate-failing skill is refused (no register)
{
  const res = await w.runtime.installSkill(unsigned('nope', 'tool', ['network:x.com'], 'async function run(){}'));
  check('install: gate-failing skill refused with errors', res.ok === false && Array.isArray(res.errors) && res.errors.length > 0);
  check('install: refused skill is NOT registered', !w.runtime.listSkills().some(s => s.name === 'nope'));
}
// lookalike: install A (key1); review A' (distance 1, key2) → lookalike warning naming A
{
  const a = await makeSigned('github-helper', 'compute', [], 'async function run(){}');
  await w.runtime.installSkill(a);
  const aprime = await makeSigned('github-helpr', 'compute', [], 'async function run(){}'); // distance 1, different key
  const rv = await w.runtime.reviewSkill(aprime);
  check('review: a lookalike name from a different key is flagged', rv.lookalike === 'github-helper');
  // F4: EXACT-name impersonation (distance 0, DIFFERENT key) is the strongest spoof — must fire too
  const exactImpostor = await makeSigned('github-helper', 'compute', [], 'async function run(){return 666}');
  const rv2 = await w.runtime.reviewSkill(exactImpostor);
  check('review: an EXACT-name skill from a DIFFERENT key is flagged as a lookalike (F4)', rv2.lookalike === 'github-helper');
  // a genuine self-update (SAME key, same name) must NOT false-fire as a lookalike
  const selfUpdate = { ...a, skill: { ...a.skill, code: 'async function run(){return 1}' } };
  const rv3 = await w.runtime.reviewSkill(selfUpdate);
  check('review: a same-key same-name update is NOT a lookalike (no false positive)', rv3.lookalike === null);
}

// I10 (v0.9 open-items §2): update prose-diff + re-affirmation (Shape C). reviewSkill MUST expose
// the added/removed permission delta against the INSTALLED version, and the dialog MUST render it
// + change the affirm button on escalation — so a v2 that silently gains network:tracker.y is
// impossible to grant without seeing it. Closes the only unguarded permission-escalation window.
console.log('\n== I10: update prose-diff + re-affirmation ==');
{
  const k = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pub = Buffer.from(new Uint8Array(await webcrypto.subtle.exportKey('raw', k.publicKey))).toString('base64');
  const signv = async (perms, code, version) => {
    const manifest = { name: 'gh-sync', version, kind: 'tool', permissions: perms, author_pubkey: pub };
    const sig = new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, k.privateKey, signingMessage(manifest, code)));
    return { format: 'rwa-skill/1', skill: { ...manifest, code }, signature: Buffer.from(sig).toString('base64') };
  };
  const CODE = 'async function run(i,r){return 1}';
  await w.runtime.installSkill(await signv(['network:api.github.com'], CODE, '1.0.0'));

  // a never-installed skill is not an update
  const rvFresh = await w.runtime.reviewSkill(await makeSigned('brand-new', 'tool', ['network:x.com'], CODE));
  check('I10: a fresh install reports update.isUpdate=false', !!rvFresh.update && rvFresh.update.isUpdate === false && rvFresh.update.changed === false);

  // escalating update (+network:tracker.y): the added perm is surfaced with prose; nothing removed
  const rvUp = await w.runtime.reviewSkill(await signv(['network:api.github.com', 'network:tracker.y'], CODE, '2.0.0'));
  check('I10: an update is detected (same skillId → isUpdate)', rvUp.update.isUpdate === true);
  check('I10: the ADDED permission is surfaced with prose', rvUp.update.changed === true && rvUp.update.added.length === 1 && rvUp.update.added[0].perm === 'network:tracker.y' && /tracker\.y/.test(rvUp.update.added[0].prose));
  check('I10: an unchanged permission is NOT in the diff, removed is empty', !rvUp.update.added.some(p => p.perm === 'network:api.github.com') && rvUp.update.removed.length === 0);

  // downgrade (drop the only perm): the removed perm is surfaced, added empty, still changed
  const rvDown = await w.runtime.reviewSkill(await signv([], CODE, '3.0.0'));
  check('I10: a downgrade surfaces the REMOVED permission', rvDown.update.changed === true && rvDown.update.removed.some(p => p.perm === 'network:api.github.com') && rvDown.update.added.length === 0);

  // same perms, new code: an update, but NOT a permission change (code alone never escalates)
  const rvSame = await w.runtime.reviewSkill(await signv(['network:api.github.com'], 'async function run(i,r){return 2}', '4.0.0'));
  check('I10: a same-permissions update reports changed=false', rvSame.update.isUpdate === true && rvSame.update.changed === false);

  // an update ADDING an unknown permission tier (fsa:) is gate-rejected — forward-compat: an
  // unknown v0.9 tier must fail cleanly at install, not slip through on an otherwise-valid update.
  const rvUnknown = await w.runtime.reviewSkill(await signv(['network:api.github.com', 'webcam:capture'], CODE, '5.0.0'));
  check('I10: an update adding an UNKNOWN tier (hook:) is gate-rejected (unknown_permission_tier)', rvUnknown.gates.ok === false && rvUnknown.gates.errors.includes('unknown_permission_tier'));

  // a MIXED update (one perm added, one removed) surfaces BOTH sides of the diff
  const rvMix = await w.runtime.reviewSkill(await signv(['network:tracker.y'], CODE, '6.0.0'));
  check('I10: a mixed update surfaces BOTH the added and the removed permission', rvMix.update.added.some(p => p.perm === 'network:tracker.y') && rvMix.update.removed.some(p => p.perm === 'network:api.github.com'));

  // the DIALOG renders the diff + escalation button, and showing it does NOT auto-install
  const v2env = await signv(['network:api.github.com', 'network:tracker.y'], CODE, '2.0.0');
  w.runtime.showInstallDialog(v2env);
  await new Promise(r => setTimeout(r, 30));
  const card = w.document.getElementById('rwa-skill-install');
  const html = card ? card.innerHTML : '';
  check('I10 dialog: an escalating update renders the added permission', /tracker\.y/.test(html));
  check('I10 dialog: the affirm button asks the user to review the NEW permissions', /new permissions/i.test(html));
  const cancel = card && card.querySelector('[data-act=cancel]'); if (cancel) cancel.onclick();
  // no silent escalation: showing (and cancelling) the dialog must NOT have installed v2 — so
  // re-reviewing v2 STILL reports tracker.y as added (v1 is still the installed version).
  const reReview = await w.runtime.reviewSkill(v2env);
  check('I10 dialog: showing the dialog does NOT auto-install the new perms (no silent escalation)', reReview.update.isUpdate === true && reReview.update.added.some(p => p.perm === 'network:tracker.y'));
}

// F7/F8/F9: install-gate hardening (mirror cli validateInstall).
console.log('\n== F7/F8/F9: install gates ==');
check('F7: rejects an invalid permission VALUE, not just the tier',
  w._skValidateInstall({ name: 'x', kind: 'tool', permissions: ['network:*evil.com'] }, { signed: true, verified: true }).errors.includes('invalid_permission'));
check('F7: a valid network/vault permission still passes the value check',
  !w._skValidateInstall({ name: 'x', kind: 'tool', permissions: ['network:*.example.com', 'vault:creds'] }, { signed: true, verified: true }).errors.includes('invalid_permission'));
check('F9: rejects a non-array permissions field (no silent coerce to [])',
  w._skValidateInstall({ name: 'x', kind: 'compute', permissions: 'network:*' }, { signed: false, verified: false }).errors.includes('invalid_permission'));
check('F8: rejects a NUL byte in the skill name (skillId ambiguity)',
  w._skValidateInstall({ name: 'a b', kind: 'compute', permissions: [] }, { signed: false, verified: false }).errors.includes('invalid_skill_id'));

// I1 (v0.9 §5) — the bus: permission tier as it surfaces through reviewSkill / _skValidateInstall
// (grammar + prose + gates + compound). The Worker publish bridge is browser-proven separately
// (tests/skill-exec-probe.mjs — jsdom has no Workers/BroadcastChannel delivery).
console.log('\n== I1: bus permission tier ==');
{
  const rv = await w.runtime.reviewSkill(await makeSigned('echo-agent', 'tool', ['bus:agent:pings'], 'async function run(i,r){return 1}'));
  check('I1: a signed bus tool passes the install gates', rv.gates.ok === true);
  check('I1: a bus permission renders human prose (channel)', rv.permissions.some(p => p.perm === 'bus:agent:pings' && /channel/i.test(p.prose)));
  check('I1: an unsigned bus skill is rejected (unsigned_with_permissions)',
    w._skValidateInstall(unsigned('echo', 'tool', ['bus:agent:pings'], 'x').skill, { signed: false, verified: false }).errors.includes('unsigned_with_permissions'));
  check('I1: a reserved bus topic (workspace:) is invalid_permission',
    w._skValidateInstall({ name: 'x', kind: 'tool', permissions: ['bus:workspace:presence'] }, { signed: true, verified: true }).errors.includes('invalid_permission'));
  const comp = await w.runtime.reviewSkill(await makeSigned('coord', 'tool', ['bus:agent:pings', 'network:api.github.com'], 'async function run(i,r){return 1}'));
  check('I1: bus + network triggers the compound-risk callout', typeof comp.compoundRisk === 'string' && /coordinate|workspace/i.test(comp.compoundRisk));
}

// I3/I4 (v0.9 §6/§7) — fsa:/idb: tiers as they surface through reviewSkill / _skValidateInstall.
// The Worker fs/idb bridges are browser-proven separately (tests/skill-exec-probe.mjs).
console.log('\n== I3/I4: fsa: + idb: permission tiers ==');
{
  const rvFs = await w.runtime.reviewSkill(await makeSigned('indexer', 'tool', ['fsa:data'], 'async function run(i,r){return 1}'));
  check('I3: a signed fsa tool passes the gates + prose mentions files', rvFs.gates.ok === true && rvFs.permissions.some(p => p.perm === 'fsa:data' && /file/i.test(p.prose)));
  check('I3: a traversal fsa scope is invalid_permission', w._skValidateInstall({ name: 'x', kind: 'tool', permissions: ['fsa:..'] }, { signed: true, verified: true }).errors.includes('invalid_permission'));
  check('I3: compute + fsa is compute_with_permissions', w._skValidateInstall({ name: 'x', kind: 'compute', permissions: ['fsa:data'] }, { signed: true, verified: true }).errors.includes('compute_with_permissions'));
  const rvDb = await w.runtime.reviewSkill(await makeSigned('cacher', 'tool', ['idb:cache'], 'async function run(i,r){return 1}'));
  check('I4: a signed idb tool passes the gates + prose mentions the store', rvDb.gates.ok === true && rvDb.permissions.some(p => p.perm === 'idb:cache' && /store|data/i.test(p.prose)));
  check('I4: a reserved idb store surfaces idb_reserved_store', w._skValidateInstall({ name: 'x', kind: 'tool', permissions: ['idb:rwa_x'] }, { signed: true, verified: true }).errors.includes('idb_reserved_store'));
  check('I4: the vault store is idb_vault_store_forbidden', w._skValidateInstall({ name: 'x', kind: 'tool', permissions: ['idb:rwa_vault'] }, { signed: true, verified: true }).errors.includes('idb_vault_store_forbidden'));
  check('I4: a wildcard idb store is invalid_permission', w._skValidateInstall({ name: 'x', kind: 'tool', permissions: ['idb:*'] }, { signed: true, verified: true }).errors.includes('invalid_permission'));
  const comp = await w.runtime.reviewSkill(await makeSigned('exfil', 'tool', ['fsa:data', 'network:api.github.com'], 'async function run(i,r){return 1}'));
  check('I3/I4: storage + a sink triggers the compound-risk callout', typeof comp.compoundRisk === 'string' && /local data/i.test(comp.compoundRisk));
}

// I5 (v0.9 §4) — Unicode-confusable (skeleton) install BLOCK. ASCII Levenshtein misses homoglyph
// squatting (Cyrillic а→a) that renders identically but differs in bytes. A SIGNED skill (carries
// capability) whose skeleton folds to a DIFFERENT author's installed name is impersonation → hard
// block (lookalike_skeleton_blocked) before any code is registered. Honest ASCII near-misses still
// only WARN (Invariant 10); unsigned homoglyphs can't escalate → warn only; same-author rebrands
// neither block nor warn. Discriminator: skeleton < normalized-Levenshtein (folding collapsed a
// real cross-script difference) — so it never false-fires on a plain ASCII edit.
console.log('\n== I5: Unicode-confusable skeleton block ==');
{
  const CODE = 'async function run(i,r){return 1}';
  await w.runtime.installSkill(await makeSigned('analytics', 'tool', ['network:api.x.com'], CODE));
  const HOMO = 'аnаlуtіcѕ'; // "analytics" w/ Cyrillic а а у і ѕ — Levenshtein 5 (evades near≤2), skeleton 0
  const rv = await w.runtime.reviewSkill(await makeSigned(HOMO, 'tool', ['network:evil.com'], CODE));
  check('I5: review flags a signed homoglyph as a BLOCKING skeleton lookalike',
    rv.lookalikeBlock === true && rv.lookalikeKind === 'skeleton' && rv.lookalike === 'analytics');
  const insB = await w.runtime.installSkill(await makeSigned(HOMO, 'tool', ['network:evil.com'], CODE));
  check('I5: installSkill BLOCKS the signed homoglyph (lookalike_skeleton_blocked)',
    insB.ok === false && Array.isArray(insB.errors) && insB.errors.includes('lookalike_skeleton_blocked'));
  check('I5: the blocked homoglyph is NOT registered', !w.runtime.listSkills().some(s => s.name === HOMO));
  // the dialog must SHOW the homoglyph block (not silently refuse) and suppress the install button
  w.runtime.showInstallDialog(await makeSigned(HOMO, 'tool', ['network:evil.com'], CODE));
  await new Promise(r => setTimeout(r, 30));
  const card = w.document.getElementById('rwa-skill-install');
  const html = card ? card.innerHTML : '';
  check('I5 dialog: a signed homoglyph shows a "look identical" impersonation notice naming the trusted skill',
    /look identical/i.test(html) && /analytics/.test(html));
  check('I5 dialog: the install button is suppressed for a blocked homoglyph',
    !!card && !card.querySelector('[data-act=install]'));
  const cancelBtn = card && card.querySelector('[data-act=cancel]'); if (cancelBtn) cancelBtn.onclick();
  const rvAscii = await w.runtime.reviewSkill(await makeSigned('analytic', 'tool', ['network:x.com'], CODE));
  check('I5: an honest ASCII near-miss is NOT skeleton-blocked, only warns (Levenshtein)',
    rvAscii.lookalikeBlock === false && rvAscii.lookalikeKind === 'levenshtein' && rvAscii.lookalike === 'analytics');
  const rvUns = await w.runtime.reviewSkill(unsigned(HOMO, 'compute', [], CODE));
  check('I5: an unsigned homoglyph warns but is NOT blocked (no capability to escalate)',
    rvUns.lookalikeBlock === false && rvUns.lookalike === 'analytics');
  const insUns = await w.runtime.installSkill(unsigned(HOMO, 'compute', [], CODE));
  check('I5: the unsigned homoglyph still installs (non-blocking warning)', insUns.ok === true);
  // same-author rebrand homoglyph: SAME key publishes a Cyrillic restyle → not impersonation
  const k = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pub = Buffer.from(new Uint8Array(await webcrypto.subtle.exportKey('raw', k.publicKey))).toString('base64');
  const signSame = async (name) => {
    const m = { name, version: '1.0.0', kind: 'tool', permissions: ['network:api.x.com'], author_pubkey: pub };
    const sig = new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, k.privateKey, signingMessage(m, CODE)));
    return { format: 'rwa-skill/1', skill: { ...m, code: CODE }, signature: Buffer.from(sig).toString('base64') };
  };
  await w.runtime.installSkill(await signSame('data-sync'));
  const rvSame = await w.runtime.reviewSkill(await signSame('dаta-sync')); // Cyrillic а, SAME key
  check('I5: a same-author rebrand homoglyph neither blocks nor warns',
    rvSame.lookalikeBlock === false && rvSame.lookalike === null);
}

// I5 (v0.9 §4) — per-author name_history. An append-only record, per public key, of the names this
// author has published (IDB rwa_sources), reconciled at boot from the frozen-zone manifests. Lets
// the install dialog surface a same-key RENAME — anchoring identity on the key across name changes
// (lowers friction for legit updates; the homoglyph block above is what handles impersonation).
console.log('\n== I5: per-author name_history ==');
{
  const CODE = 'async function run(i,r){return 1}';
  const k = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pub = Buffer.from(new Uint8Array(await webcrypto.subtle.exportKey('raw', k.publicKey))).toString('base64');
  const sign = async (name) => {
    const m = { name, version: '1.0.0', kind: 'tool', permissions: ['network:api.github.com'], author_pubkey: pub };
    const sig = new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, k.privateKey, signingMessage(m, CODE)));
    return { format: 'rwa-skill/1', skill: { ...m, code: CODE }, signature: Buffer.from(sig).toString('base64') };
  };
  const insA = await w.runtime.installSkill(await sign('gh-sync'));
  check('I5 name_history: baseline install ok', insA.ok === true);
  const rvFreshKey = await w.runtime.reviewSkill(await makeSigned('totally-new', 'tool', ['network:x.com'], CODE));
  check('I5 name_history: a brand-new author has no prior names and no rename note',
    Array.isArray(rvFreshKey.priorNames) && rvFreshKey.priorNames.length === 0 && !rvFreshKey.nameChange);
  const rvRename = await w.runtime.reviewSkill(await sign('github-sync')); // SAME key, NEW name
  check('I5 name_history: a same-key rename surfaces the prior name', rvRename.priorNames.some(p => p.name === 'gh-sync'));
  check('I5 name_history: the rename note names the previous skill + carries a date',
    rvRename.nameChange && rvRename.nameChange.prev && rvRename.nameChange.prev.name === 'gh-sync' && typeof rvRename.nameChange.prev.date === 'number');
  w.runtime.showInstallDialog(await sign('github-sync'));
  await new Promise(r => setTimeout(r, 30));
  const card = w.document.getElementById('rwa-skill-install');
  const html = card ? card.innerHTML : '';
  check('I5 name_history dialog: the rename note appears ("previously published" + old name)',
    /previously published/i.test(html) && /gh-sync/.test(html));
  const cancelNh = card && card.querySelector('[data-act=cancel]'); if (cancelNh) cancelNh.onclick();
  const insB = await w.runtime.installSkill(await sign('github-sync'));
  check('I5 name_history: installing the rename succeeds', insB.ok === true);
  // boot reconcile: an IDB-cleared reload restores name_history from the in-file manifests
  await clearStore(w, 'rwa_sources');
  await w.runtimeBuildSourceIndex();
  const rvAfterRebuild = await w.runtime.reviewSkill(await sign('gh-sync-v3'));
  check('I5 name_history: runtimeBuildSourceIndex restores prior names from the in-file manifests',
    rvAfterRebuild.priorNames.some(p => p.name === 'gh-sync') && rvAfterRebuild.priorNames.some(p => p.name === 'github-sync'));
}

// I8 (v0.9 §9) — the hook skill kind as it surfaces through reviewSkill / _skValidateInstall /
// installSkill. A hook is signed + compute-only (only hook:<event> perms); it installs like a skill
// and self-describes as kind:'hook' (the FIRING integration is exercised in tests/hooks.mjs).
console.log('\n== I8: hook kind grammar + install ==');
{
  const CODE = 'async function run(i,r){return 1}';
  const rv = await w.runtime.reviewSkill(await makeSigned('auditor', 'hook', ['hook:on-commit'], CODE));
  check('I8: a signed hook:on-commit passes the gates', rv.gates.ok === true);
  check('I8: a hook permission renders human prose (runs automatically)', rv.permissions.some(p => p.perm === 'hook:on-commit' && /automatically/i.test(p.prose)));
  check('I8: a hook with a non-hook perm is compute_with_permissions', w._skValidateInstall({ name: 'x', kind: 'hook', permissions: ['hook:on-commit', 'network:api.x.com'] }, { signed: true, verified: true }).errors.includes('compute_with_permissions'));
  check('I8: an unknown hook event is unknown_permission_tier', w._skValidateInstall({ name: 'x', kind: 'hook', permissions: ['hook:on-render'] }, { signed: true, verified: true }).errors.includes('unknown_permission_tier'));
  check('I8: an unsigned hook is rejected (unsigned_capability)', w._skValidateInstall({ name: 'x', kind: 'hook', permissions: ['hook:on-commit'] }, { signed: false, verified: false }).errors.includes('unsigned_capability'));
  const ins = await w.runtime.installSkill(await makeSigned('auditor', 'hook', ['hook:on-commit'], CODE));
  check('I8: a signed hook installs + lists as kind:hook', ins.ok === true && w.runtime.listSkills().some(s => s.name === 'auditor' && s.kind === 'hook'));
  check('I8: an installed hook self-describes (kind:hook, provenance:installed)', w.runtime.describe().affordances.some(a => a.kind === 'hook' && a.name === 'auditor' && a.provenance === 'installed'));
}

// I7 (v0.9 §8) — view / edit-surface (DOM-authoring) skills: new kinds, zero-capability (no perms),
// typed output contract. They install like skills and self-describe; EXECUTION (render in a Worker,
// transform → applyEnvelope) is browser-proven (tests/skill-exec-probe.mjs). Unsigned is OK.
console.log('\n== I7: view / edit-surface kinds ==');
{
  const CODE = 'async function run(i,r){return "<p>view</p>";}';
  const rvView = await w.runtime.reviewSkill(unsigned('grid', 'view', [], CODE));
  check('I7: an unsigned view skill (output html-render, no perms) passes the gates',
    w._skValidateInstall({ name: 'grid', kind: 'view', permissions: [], output: { kind: 'html-render' } }, { signed: false, verified: false }).ok === true);
  check('I7: a view/edit-surface with ANY permission is rejected (output_skill_with_permissions)',
    w._skValidateInstall({ name: 'leaky', kind: 'view', permissions: ['network:x'], output: { kind: 'html-render' } }, { signed: true, verified: true }).errors.includes('output_skill_with_permissions'));
  check('I7: a missing/mismatched output.kind is rejected (invalid_output_kind)',
    w._skValidateInstall({ name: 'v', kind: 'edit-surface', permissions: [], output: { kind: 'html-render' } }, { signed: true, verified: true }).errors.includes('invalid_output_kind'));
  // install + self-describe (kind surfaces via parseSkillZone; AFFORDANCE_KINDS already has view/edit-surface)
  const env = { format: 'rwa-skill/1', skill: { name: 'grid', version: '1.0.0', kind: 'view', permissions: [], output: { kind: 'html-render' }, author_pubkey: 'AAAA', code: CODE } };
  const ins = await w.runtime.installSkill(env);
  check('I7: a view skill installs + lists as kind:view (unsigned, verified:false)', ins.ok === true && w.runtime.listSkills().some(s => s.name === 'grid' && s.kind === 'view'));
  check('I7: an installed view self-describes (kind:view, provenance:installed)', w.runtime.describe().affordances.some(a => a.kind === 'view' && a.name === 'grid' && a.provenance === 'installed'));
  check('I7: runtime exposes invokeEditSurface', typeof w.runtime.invokeEditSurface === 'function');
}

// I2 (v0.9 §10) — compute-Worker pool. jsdom can't run Workers, so this pins the seed-level API:
// the pool starts empty, the code-hash key is deterministic + code-sensitive, and pooling is OFF by
// default. Reuse / cap / idle-eviction / shutdown are browser-proven (tests/skill-exec-probe.mjs).
console.log('\n== I2: compute-Worker pool (seed-level API) ==');
{
  check('I2: runtime exposes poolStats', typeof w.runtime.poolStats === 'function');
  const st = w.runtime.poolStats();
  check('I2: the pool starts empty (live:0) with a hardware-bounded cap', st.live === 0 && st.cap >= 1 && st.cap <= 4 && typeof st.pools === 'object');
  const h1 = await w._skCodeHash('sk1', 'async function run(i){return 1}');
  const h1b = await w._skCodeHash('sk1', 'async function run(i){return 1}');
  const h2 = await w._skCodeHash('sk1', 'async function run(i){return 2}'); // code changed
  const h3 = await w._skCodeHash('sk2', 'async function run(i){return 1}'); // skillId changed
  check('I2: code-hash is deterministic for the same skillId+code', h1 === h1b);
  check('I2: code-hash changes when the code changes (pool invalidation key)', h1 !== h2);
  check('I2: code-hash changes when the skillId changes', h1 !== h3);
}

console.log(`\n== ${pass} pass, ${fail} fail ==`);
process.exit(fail ? 1 : 0);
