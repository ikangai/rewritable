// Affordance-kernel extension test for seeds/rewritable.html — the edit-surface /
// compute provider slots (Steps 5/7c of the R5 build sheet).
//
// RED until the kernel extension lands. It pins the "destination" euler framed
// (#63): a file that DOES edit-surface + compute (the datatable) must REGISTER
// those providers so runtime.describe() reports them LIVE — not guess from the
// kind, not rely only on the static #rwa-affordances declaration. Encodes WHY
// (Rule 9): an under-reporting describe() lies about what the file can do; a
// registry that silently accepts an unknown kind would let a file overclaim.
//
// Run:  (cd tests && node affordance-kernel.mjs)   — exits non-zero on any FAIL.
// NOT wired into package.json until GREEN (mirrors tests/r5-concurrent-commit.mjs).

import jsdomPkg from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applySeedSubs, kindOverrides, replaceInlineDoc } from '../cli/src/seed.mjs';
import { validateSelfDescription } from '../tools/self-description.mjs';

const { JSDOM, VirtualConsole } = jsdomPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(__dirname, '..', 'seeds', 'rewritable.html');

let pass = 0, fail = 0;
const check = (label, cond) => {
  if (cond) { pass++; console.log('  OK  ', label); }
  else      { fail++; console.log('  FAIL', label); }
};
const tick = () => new Promise(r => setTimeout(r, 0));

async function boot({ kind = 'document', title = 'Doc', body = null } = {}) {
  const ov = kindOverrides(kind);
  const uuid = crypto.randomUUID();
  let html = fs.readFileSync(SEED, 'utf8');
  html = applySeedSubs(html, {
    uuid, title, fileMeta: title.toLowerCase() + '.html',
    productKind: kind,
    lensPlaceholder: ov.lensPlaceholder,
    palPlaceholder: ov.palPlaceholder,
    productHeader: ov.productHeader,
    lensClickToAnchor: ov.lensClickToAnchor,
  });
  html = replaceInlineDoc(html, body != null ? body : ov.body);
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', e => console.error('[jsdomError]', e?.detail?.stack || e?.detail || e));
  const dom = new JSDOM(html, {
    url: 'https://rwa-kernel.local/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.indexedDB = indexedDB;
      window.IDBKeyRange = IDBKeyRange;
      window.sessionStorage.setItem('rwa_apikey', 'test-key');
      window.sessionStorage.setItem('rwa_model', 'test-model');
      window.fetch = async () => { throw new Error('no network in this test'); };
      Object.defineProperty(window.navigator, 'storage', { value: { persist: () => Promise.resolve(false) }, configurable: true });
      Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true });
    },
  });
  const { window } = dom;
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) {
    if (window.runtime && typeof window.runtime.describe === 'function') break;
    await tick();
  }
  return { window };
}

const tryProvide = (rt, kind, spec) => { try { return { ok: true, off: rt.provide(kind, spec) }; } catch (e) { return { ok: false, err: e }; } };

(async () => {
  console.log('== affordance kernel: edit-surface + compute provider slots ==');
  const { window } = await boot({ kind: 'document', title: 'Kernel' });
  const rt = window.runtime;
  check('runtime.provide is exposed', typeof rt?.provide === 'function');

  // A base document starts with no edit-surface/compute affordances.
  check('document describe() starts with no affordances', rt.describe().affordances.length === 0);

  // Register an edit-surface provider (declarative record — the document's own JS
  // owns the actual edit logic; the provider just makes describe() report it).
  const es = tryProvide(rt, 'edit-surface', { kind: 'edit-surface', name: 'cell', label: 'Edit cells directly (no model)' });
  check('runtime.provide("edit-surface", …) registers (returns an unregister fn)', es.ok && typeof es.off === 'function');

  const cp = tryProvide(rt, 'compute', { kind: 'compute', name: 'total', label: 'Total = qty × unit_price' });
  check('runtime.provide("compute", …) registers (returns an unregister fn)', cp.ok && typeof cp.off === 'function');

  // describe() must now LIVE-report the registered providers as {kind,name,label,provenance}.
  let d = rt.describe();
  const has = (k, n) => d.affordances.some(a => a.kind === k && a.name === n && a.provenance === 'first-party' && typeof a.label === 'string');
  check('describe() LIVE-reports the registered edit-surface provider', has('edit-surface', 'cell'));
  check('describe() LIVE-reports the registered compute provider', has('compute', 'total'));
  check('describe() with edit-surface+compute still validates against the oracle', validateSelfDescription(d).valid);

  // Unregistering removes it — describe() never reports a torn-down provider.
  if (es.ok) es.off();
  d = rt.describe();
  check('after unregister, describe() no longer reports the edit-surface provider', !d.affordances.some(a => a.kind === 'edit-surface'));
  check('compute provider survives the edit-surface unregister', d.affordances.some(a => a.kind === 'compute'));

  // The registry must still REJECT an unknown kind — a file must not be able to
  // register a phantom affordance the runtime can't account for (Rule 12).
  const bogus = tryProvide(rt, 'telepathy', { kind: 'telepathy', name: 'x', label: 'x' });
  check('runtime.provide rejects an unknown provider kind', !bogus.ok);

  console.log(`\n== ${pass} pass, ${fail} fail ==`);
  process.exit(fail ? 1 : 0);
})();
