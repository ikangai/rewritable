// rwa-runtime-region-commit/1 — the runtime-owned region commit primitive.
//
// Spec: docs/specs/rwa-runtime-region-commit-spec.md. This is the characterization
// test (§6) that pins the primitive. RED until runtimeRegionCommit lands in the
// seed; GREEN once the 'frozen' scoped-bypass + re-assert + region-only invariant
// are implemented.
//
// WHY this matters: the runtime must be able to rewrite ONE frozen region (the
// #rwa-skills zone, so installs persist + travel in the file) while the agent/lens
// edit path stays walled out of EVERY frozen zone. The load-bearing assertions are:
//   • a 'frozen' commit changes ONLY its named region — no other frozen zone, no
//     prose, no data-rwa-id (region-only invariant — the runtime can't smuggle a
//     document change behind a skill-zone write);
//   • the scoped bypass is per-identity — it cannot blanket-unlock other frozen
//     zones (frozen_zone_corrupted still fires on #other);
//   • the re-assert refuses to ship a region that lost its frozen marker
//     (region_not_refrozen — else next boot the skill zone is agent-writable);
//   • the AGENT edit path has NO bypass — applyEnvelope into the frozen zone still
//     rejects (the wall holds; frozenBypass is unreachable without this primitive).
//
// NOT wired into package.json until GREEN. Run directly:
//   (cd tests && node region-commit.mjs)

import jsdomPkg from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applySeedSubs, kindOverrides, replaceInlineDoc } from '../cli/src/seed.mjs';

const { JSDOM, VirtualConsole } = jsdomPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(__dirname, '..', 'seeds', 'rewritable.html');

let pass = 0, fail = 0;
const check = (label, cond) => {
  if (cond) { pass++; console.log('  OK  ', label); }
  else      { fail++; console.log('  FAIL', label); }
};
const tick = () => new Promise(r => setTimeout(r, 0));

async function boot(body) {
  const ov = kindOverrides('document');
  const uuid = crypto.randomUUID();
  let html = fs.readFileSync(SEED, 'utf8');
  html = applySeedSubs(html, {
    uuid, title: 'RC', fileMeta: 'rc.html', productKind: 'document',
    lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder,
    productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor,
  });
  html = replaceInlineDoc(html, body);
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', e => console.error('[jsdomError]', e?.detail?.stack || e?.detail || e));
  const dom = new JSDOM(html, {
    url: 'https://rwa-rc.local/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
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
    if (window.runtime && typeof window.getDoc === 'function') break;
    await tick();
  }
  return { window, document: window.document, uuid };
}

function readStore(uuid, store, key = 'self') {
  return new Promise((res, rej) => {
    const req = indexedDB.open('rwa_' + uuid);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction(store, 'readonly');
        const r = tx.objectStore(store).get(key);
        r.onsuccess = () => { res(r.result); db.close(); };
        r.onerror = () => { rej(r.error); db.close(); };
      } catch (e) { db.close(); rej(e); }
    };
    req.onerror = () => rej(req.error);
  });
}
const codeOf = (e) => (e && (e.code || e.message) || '').toString();

// A document with: editable prose (gets data-rwa-id), a non-frozen skin <style>
// (the edit-reachable region), and THREE frozen things — the attribute-form
// #rwa-skills target, a second attribute-form #other (must stay locked), and a
// marker-form `cfg` zone (must stay locked).
const BODY = [
  '<article>',
  '<p>intro prose paragraph</p>',
  '<style data-rwa-skin="">/* OLD-SKIN */</style>',
  '<div data-rwa-frozen id="rwa-skills">OLD-SKILLS</div>',
  '<div data-rwa-frozen id="other">KEEP-OTHER</div>',
  '<!-- rwa:frozen:begin cfg -->',
  'KEEP-CFG',
  '<!-- rwa:frozen:end cfg -->',
  '</article>',
].join('\n');

// The consumer's region descriptor for the #rwa-skills zone (shannon's buildSkillZone
// is the real builder; here a trivial flat-scan select + a string builder).
const selectSkills = (doc) => {
  const open = doc.indexOf('<div data-rwa-frozen id="rwa-skills"');
  if (open < 0) return null;
  const close = doc.indexOf('</div>', open);
  if (close < 0) return null;
  return [open, close + '</div>'.length];
};
const skillsRegion = (inner) => ({
  select: selectSkills,
  build: () => '<div data-rwa-frozen id="rwa-skills">' + inner + '</div>',
  frozenId: 'rwa-skills',
});

(async () => {
  console.log('== runtime-region-commit: privileged frozen-zone write (scoped) ==');

  // ── (a)+(b)+(c): a 'frozen' commit rewrites ONLY #rwa-skills ──
  const b = await boot(BODY);
  check('runtimeRegionCommit is exposed', typeof b.window.runtimeRegionCommit === 'function');
  const before = await b.window.getDoc();
  const idMatch = before.match(/data-rwa-id="([a-z2-7]+)"/);
  check('prose paragraph got a data-rwa-id at boot (fixture sanity)', !!idMatch);
  const proseId = idMatch && idMatch[1];
  const histBefore = ((await readStore(b.uuid, 'rwa_hist')) || []).length;

  await b.window.runtimeRegionCommit({
    regions: [skillsRegion('NEW-SKILLS-CONTENT')],
    actor: 'skill:install',
    reachability: 'frozen',
  });
  await tick(); await tick();
  const after = await b.window.getDoc();

  check('(a) #rwa-skills rewritten (NEW-SKILLS-CONTENT present, OLD-SKILLS gone)',
    /NEW-SKILLS-CONTENT/.test(after) && !/OLD-SKILLS/.test(after));
  check('(b1) #other frozen zone byte-identical (KEEP-OTHER intact)',
    /<div data-rwa-frozen id="other">KEEP-OTHER<\/div>/.test(after));
  check('(b2) marker-form cfg zone byte-identical (KEEP-CFG intact)', /KEEP-CFG/.test(after) &&
    /rwa:frozen:begin cfg/.test(after) && /rwa:frozen:end cfg/.test(after));
  check('(b3) editable prose + its data-rwa-id preserved verbatim',
    /intro prose paragraph/.test(after) && (!proseId || after.includes('data-rwa-id="' + proseId + '"')));
  check('(b4) skin <style> region untouched by a skills commit (/* OLD-SKIN */ intact)',
    /\/\* OLD-SKIN \*\//.test(after));

  const histAfter = (await readStore(b.uuid, 'rwa_hist')) || [];
  check('(c1) exactly one commit recorded for the region write', histAfter.length - histBefore === 1);
  check("(c2) the commit self-attributes actor:'skill:install'", histAfter[0] && histAfter[0].actor === 'skill:install');

  // ── (d): undo restores the prior zone ──
  await b.window.runtime.undo();
  await tick(); await tick();
  const undone = await b.window.getDoc();
  check('(d) undo restores OLD-SKILLS (one undo step for the whole region write)',
    /OLD-SKILLS/.test(undone) && !/NEW-SKILLS-CONTENT/.test(undone));

  // ── (e): determinism — a second identical call yields byte-identical output ──
  const e1 = await boot(BODY);
  await e1.window.runtimeRegionCommit({ regions: [skillsRegion('DET')], actor: 'skill:install', reachability: 'frozen' });
  await tick();
  const afterFirst = await e1.window.getDoc();
  await e1.window.runtimeRegionCommit({ regions: [skillsRegion('DET')], actor: 'skill:install', reachability: 'frozen' });
  await tick();
  const afterSecond = await e1.window.getDoc();
  check('(e) deterministic — re-running the same build is a no-op diff', afterFirst === afterSecond);

  // ── (f): a build that DROPS the frozen marker is refused (re-assert) ──
  const f = await boot(BODY);
  const fDocBefore = await f.window.getDoc();
  let fErr = null;
  await f.window.runtimeRegionCommit({
    regions: [{ select: selectSkills, build: () => '<div id="rwa-skills">UNFROZEN</div>', frozenId: 'rwa-skills' }],
    actor: 'skill:install', reachability: 'frozen',
  }).catch(e => { fErr = e; });
  check('(f1) dropping data-rwa-frozen rejects with region_not_refrozen', /region_not_refrozen/.test(codeOf(fErr)));
  check('(f2) and nothing landed — doc byte-identical', (await f.window.getDoc()) === fDocBefore);

  // ── (g): the bypass is SCOPED to the named id — it cannot introduce or alter
  // a DIFFERENT frozen zone. The build (spliced only into the rwa-skills range)
  // tries to smuggle a second data-rwa-frozen id="other": the snapshot still
  // compares every non-bypassed frozen element, so the extra #other → mismatch.
  const g = await boot(BODY);
  const gDocBefore = await g.window.getDoc();
  let gErr = null;
  await g.window.runtimeRegionCommit({
    regions: [{ select: selectSkills,
      build: () => '<div data-rwa-frozen id="rwa-skills">x</div><div data-rwa-frozen id="other">INJECTED</div>',
      frozenId: 'rwa-skills' }],
    actor: 'skill:install', reachability: 'frozen',
  }).catch(e => { gErr = e; });
  check('(g1) bypassing rwa-skills cannot smuggle a second frozen id → rejected',
    gErr !== null && /frozen_zone_corrupted/.test(codeOf(gErr)));
  check('(g2) and nothing landed — #other still the single KEEP-OTHER',
    (await g.window.getDoc()) === gDocBefore && !/INJECTED/.test(await g.window.getDoc()));

  // ── (h): edit-reachable mode rewrites a NON-frozen region with no bypass ──
  const h = await boot(BODY);
  await h.window.runtimeRegionCommit({
    regions: [{
      select: (doc) => { const o = doc.indexOf('<style data-rwa-skin'); if (o < 0) return null; const c = doc.indexOf('</style>', o); return c < 0 ? null : [o, c + '</style>'.length]; },
      build: () => '<style data-rwa-skin="linear">/* NEW-SKIN */</style>',
    }],
    actor: 'skin:linear', reachability: 'edit-reachable',
  });
  await tick();
  const hDoc = await h.window.getDoc();
  check('(h1) edit-reachable rewrites the skin region (/* NEW-SKIN */ present)',
    /\/\* NEW-SKIN \*\//.test(hDoc) && !/\/\* OLD-SKIN \*\//.test(hDoc));
  check('(h2) frozen zones untouched by an edit-reachable commit',
    /OLD-SKILLS/.test(hDoc) && /KEEP-OTHER/.test(hDoc) && /KEEP-CFG/.test(hDoc));
  const hHist = (await readStore(h.uuid, 'rwa_hist')) || [];
  check("(h3) edit-reachable self-attributes actor:'skin:linear'", hHist[0] && hHist[0].actor === 'skin:linear');

  // ── (i): THE WALL — the agent edit path has NO bypass ──
  const i = await boot(BODY);
  const iDocBefore = await i.window.getDoc();
  let iErr = null;
  await i.window.runtime.applyEnvelope(
    { version: 'rwa-edit/1', edits: [{ find: 'OLD-SKILLS', replace: 'AGENT-FORGED' }] },
    { surface: 'agent:attack' }).catch(e => { iErr = e; });
  check('(i1) the agent/applyEnvelope path STILL cannot edit the frozen skill zone',
    iErr !== null && /(frozen_zone_violation|frozen_zone_corrupted)/.test(codeOf(iErr)));
  check('(i2) the frozen zone is unchanged by the attempted forge', (await i.window.getDoc()) === iDocBefore);

  // ── (j): INSERT MODE — the FIRST install on a fresh skill-host has no
  // #rwa-skills div yet. select returns null → the primitive inserts build() at
  // insertAt(). This is the path shannon's incr-7 hits before any zone exists; it
  // must create a *frozen* zone (re-assert passes) and change nothing else.
  const FRESH = '<article>\n<p>fresh skill host</p>\n<div data-rwa-frozen id="other">KEEP-OTHER</div>\n</article>';
  const j = await boot(FRESH);
  const jBefore = await j.window.getDoc();
  check('(j0) fixture sanity: no #rwa-skills zone exists yet', !/id="rwa-skills"/.test(jBefore));
  const insertSkills = {
    select: (doc) => doc.includes('id="rwa-skills"') ? null /* would splice; absent here */ : null,
    insertAt: (doc) => { const at = doc.indexOf('</article>'); return at < 0 ? doc.length : at; },
    build: () => '<div data-rwa-frozen id="rwa-skills">FIRST-INSTALL</div>\n',
    frozenId: 'rwa-skills',
  };
  await j.window.runtimeRegionCommit({ regions: [insertSkills], actor: 'skill:install', reachability: 'frozen' });
  await tick(); await tick();
  const jAfter = await j.window.getDoc();
  check('(j1) the #rwa-skills zone was INSERTED (FIRST-INSTALL present)',
    /<div data-rwa-frozen id="rwa-skills">FIRST-INSTALL<\/div>/.test(jAfter));
  check('(j2) insert is region-only — prose + #other untouched',
    /fresh skill host/.test(jAfter) && /<div data-rwa-frozen id="other">KEEP-OTHER<\/div>/.test(jAfter));
  // Second install on the now-existing zone: select finds it → splice (not insert).
  await j.window.runtimeRegionCommit({
    regions: [{ select: selectSkills, build: () => '<div data-rwa-frozen id="rwa-skills">SECOND</div>', frozenId: 'rwa-skills' }],
    actor: 'skill:update', reachability: 'frozen',
  });
  await tick();
  const jUpdated = await j.window.getDoc();
  check('(j4) a follow-up install SPLICES the existing zone (insert→splice transition works)',
    /SECOND/.test(jUpdated) && !/FIRST-INSTALL/.test(jUpdated) && !/id="rwa-skills"[\s\S]*id="rwa-skills"/.test(jUpdated));

  console.log(`\n${pass} pass, ${fail} fail` + (fail ? '   ← RED until runtimeRegionCommit lands' : '   ← GREEN'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
