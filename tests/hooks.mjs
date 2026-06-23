// TDD — I8 (v0.9 §9) hook firing. PHASE 2: installed `hook` skills fire on lifecycle events
// (on-commit ← the 'modify' edit-commit; on-mode-change ← setMode; on-open ← boot), compute-only,
// fire-and-forget, deterministic skillId order, re-entrancy-guarded, every run logged to
// rwa_hook_log. jsdom can't run Workers, so a fired hook logs an ERROR entry (Worker unavailable) —
// that still proves the FIRING path; the real Worker execution is browser-proven (skill-exec-probe).
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
const HOOK_CODE = 'async function run(i){return {saw:i&&i.event};}';

async function signHook(name, events, code = HOOK_CODE) {
  const kp = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pub = Buffer.from(new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey))).toString('base64');
  const manifest = { name, version: '1.0.0', kind: 'hook', permissions: events.map(e => 'hook:' + e), author_pubkey: pub };
  const sig = new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, signingMessage(manifest, code)));
  return { format: 'rwa-skill/1', skill: { ...manifest, code }, signature: Buffer.from(sig).toString('base64') };
}
const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));

async function boot() {
  const ov = kindOverrides('skill-host');
  let html = fs.readFileSync(SEED, 'utf8');
  html = applySeedSubs(html, { uuid: webcrypto.randomUUID(), title: 'H', fileMeta: 'h.html', productKind: 'skill-host', lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder, productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor });
  html = replaceInlineDoc(html, ov.body);
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { const s = e?.detail?.message || ''; if (!/Not implemented: navigation|Worker/.test(s)) console.error('[jsdomError]', s); });
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

console.log('== I8 phase 2: hook firing ==');
const w = await boot();
check('runtime exposes hookLog', typeof w.runtime.hookLog === 'function');

// registry: _hooksForEvent returns verified kind:hook skills declaring the event, sorted by skillId
{
  await w.runtime.installSkill(await signHook('audit-a', ['on-commit']));
  await w.runtime.installSkill(await signHook('audit-b', ['on-commit']));
  await w.runtime.installSkill(await signHook('opener', ['on-open']));
  await w.runtime.installSkill({ format: 'rwa-skill/1', skill: { name: 'plain', version: '1.0.0', kind: 'compute', permissions: [], author_pubkey: 'AAAA', code: HOOK_CODE } });
  const oc = w._hooksForEvent('on-commit');
  check('registry: _hooksForEvent(on-commit) returns the two on-commit hooks (not the compute/open ones)', oc.length === 2 && oc.every(h => h.kind === 'hook'));
  const ids = oc.map(h => h.skillId);
  check('registry: hooks fire in deterministic skillId order', ids.slice().sort().join() === ids.join());
}

// on-mode-change fires on a real setMode (emit('mode') → fireHooks); logs with {mode,previous}
{
  await w.runtime.installSkill(await signHook('mode-watch', ['on-mode-change']));
  const before = (await w.runtime.hookLog()).length;
  w.runtime.setMode('edit');
  await tick();
  const log = await w.runtime.hookLog();
  check('on-mode-change: a setMode fires the hook (a log entry was written)', log.length > before && log.some(e => e.event === 'on-mode-change'));
  const mc = log.filter(e => e.event === 'on-mode-change').pop();
  check('on-mode-change: the input carries {mode:edit, previous:document}', mc && mc.input && mc.input.mode === 'edit' && mc.input.previous === 'document');
  w.runtime.setMode('document');
}

// on-commit fires when an edit commits (emit('modify') → fireHooks) with the edit context
{
  const before = (await w.runtime.hookLog()).length;
  w.emitRuntimeEvent('modify', { instruction: 'tidy the intro', lensMeta: { surface: 'lens', actor: 'm' } });
  await tick();
  const log = await w.runtime.hookLog();
  const oc = log.filter(e => e.event === 'on-commit');
  check('on-commit: an edit commit fires the on-commit hooks', log.length > before && oc.length >= 2);
  check('on-commit: the input carries the edit context {event,instruction,lensMeta}', oc.some(e => e.input && e.input.event === 'on-commit' && e.input.instruction === 'tidy the intro'));
}

// re-entrancy: firing the same event twice synchronously fires each hook only once (activeHooks
// guard — the 2nd call sees the hook still active and skips it)
{
  const before = (await w.runtime.hookLog()).length;
  w.emitRuntimeEvent('modify', { instruction: 'A', lensMeta: {} });
  w.emitRuntimeEvent('modify', { instruction: 'B', lensMeta: {} }); // same microtask: hooks still active
  await tick();
  const added = (await w.runtime.hookLog()).length - before;
  check('re-entrancy: two synchronous fires of the same event run each hook once (not twice)', added === 2); // 2 on-commit hooks × 1
}

// a tampered hook is REJECTED at install (like a tool — hooks run autonomously, must verify), so it
// is never registered and never fires. (The firing-time `s.verified` filter is defense-in-depth for
// a boot-loaded zone hook whose re-verify flipped to false.)
{
  const env = await signHook('tampered-hook', ['on-mode-change']);
  const bad = { ...env, skill: { ...env.skill, code: 'async function run(i){return 99;}' } }; // breaks the signature
  const res = await w.runtime.installSkill(bad);
  check('a tampered hook is REJECTED at install (unsigned_capability), never registered', res.ok === false && res.errors.includes('unsigned_capability') && !w.runtime.listSkills().some(s => s.name === 'tampered-hook'));
}

console.log(`\n== ${pass} pass, ${fail} fail ==`);
process.exit(fail ? 1 : 0);
