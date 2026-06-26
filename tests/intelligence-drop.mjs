// TDD — intelligence/0.2 file-drop bridge (docs/specs/rwa-intelligence-spec.md §5).
// The overlay half (rwa-agent/1 role) is already built; the one buildable-today gap
// is the bridge that takes a CARRIER .html (a skill-host rwa carrying a signed
// rwa-agent/1 record in its frozen #rwa-agents zone), extracts the record, and
// routes it to the existing consent dialog + runtime.agents.install.
//
// In a carrier's RAW bytes the record lives inside INLINE_DOC, so its </script>
// close is escaped to <\/script> (the zone <div>/</div> delimiters are not). The
// bridge must extract INLINE_DOC, un-escape it, then parse the zone — mirroring
// the boot-time readTrustworthyAgents trust path.
//
// New seed surface under test (exposed as test hooks):
//   window.__rwaExtractAgentCarrier(html)  -> [{agent, signature}, ...]
//   window.__rwaClassifyInstallText(text)  -> {kind, ...}
//   window.__rwaHandleCarrierDrop(event)   -> async; drives the drop gesture
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
const CARRIER = path.join(__dirname, '..', 'examples', 'intelligence-carrier', 'concise-editor.html');
let pass = 0, fail = 0;
const check = (m, c) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  ✗   ' + m); } };

const article = '<article><h1>Target</h1><p>An ordinary rewritable that can receive an intelligence.</p></article>\n';

async function boot(body) {
  const ov = kindOverrides('skill-host');
  let html = fs.readFileSync(SEED, 'utf8');
  html = applySeedSubs(html, { uuid: webcrypto.randomUUID(), title: 'Target', fileMeta: 't.html', productKind: 'skill-host', lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder, productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor });
  html = replaceInlineDoc(html, body);
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { const s = e?.detail?.message || ''; if (!/Not implemented: navigation/.test(s)) console.error('[jsdomError]', s); });
  const dom = new JSDOM(html, { url: 'https://t.local/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      window.indexedDB = indexedDB; window.IDBKeyRange = IDBKeyRange;
      window.fetch = async () => { throw new Error('no network'); };
      Object.defineProperty(window.navigator, 'storage', { value: { persist: () => Promise.resolve(false) }, configurable: true });
      Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
      window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
    } });
  const w = dom.window, t0 = Date.now();
  while (Date.now() - t0 < 5000) { if (w.runtime && w.runtime.agents && w.runtime.agents.list) break; await new Promise(r => setTimeout(r, 5)); }
  await new Promise(r => setTimeout(r, 150));
  return w;
}

const carrierHtml = fs.readFileSync(CARRIER, 'utf8');

console.log('== intelligence/0.2 file-drop bridge ==');

// A — extraction: pull the signed record out of a carrier's raw bytes
{
  const w = await boot(article);
  const envs = w.__rwaExtractAgentCarrier(carrierHtml);
  check('A1: extracts exactly one agent record from the carrier', Array.isArray(envs) && envs.length === 1);
  check('A2: the record is the concise-editor role with a signature', !!envs[0] && envs[0].agent && envs[0].agent.role === 'concise-editor' && typeof envs[0].signature === 'string' && envs[0].signature.length > 0);
  check('A3: a non-carrier (no #rwa-agents zone) extracts nothing', w.__rwaExtractAgentCarrier('<!doctype html><article><h1>hi</h1></article>').length === 0);
}

// B — install-readiness: the extracted record installs as VERIFIED via the built path
{
  const w = await boot(article);
  const env = w.__rwaExtractAgentCarrier(carrierHtml)[0];
  const r = await w.runtime.agents.install(env);
  check('B1: extracted record installs ok', r && r.ok === true);
  check('B2: it verifies live (signature intact through extraction)', r && r.verified === true);
  const a = w.runtime.agents.list().find(x => x.role === 'concise-editor');
  check('B3: runtime.agents.list() now shows concise-editor verified', !!a && a.verified === true);
}

// C — classify: route carriers vs bare JSON vs nothing
{
  const w = await boot(article);
  const env = w.__rwaExtractAgentCarrier(carrierHtml)[0];
  check('C1: a carrier .html classifies as agent-carrier', w.__rwaClassifyInstallText(carrierHtml).kind === 'agent-carrier');
  check('C2: a bare agent envelope JSON classifies as json-agent', w.__rwaClassifyInstallText(JSON.stringify(env)).kind === 'json-agent');
  check('C3: unrelated html classifies as none', w.__rwaClassifyInstallText('<html><body><p>nothing here</p></body></html>').kind === 'none');
}

// D — the drop gesture, end to end: drop a carrier file -> consent dialog -> install
{
  const w = await boot(article);
  const file = new w.File([carrierHtml], 'concise-editor.html', { type: 'text/html' });
  const ev = { dataTransfer: { files: [file], items: [{ kind: 'file' }], types: ['Files'] }, preventDefault() {}, stopPropagation() {} };
  await w.__rwaHandleCarrierDrop(ev);
  await new Promise(r => setTimeout(r, 120)); // async file read + signature verify
  const overlay = w.document.getElementById('rwa-agent-install');
  check('D1: dropping a carrier opens the agent consent dialog', !!overlay);
  check('D2: the dialog names the concise-editor role', !!overlay && /concise-editor/.test(overlay.textContent));
  const installBtn = overlay && overlay.querySelector('[data-act=install]');
  check('D3: a verified role offers an install button (the consent action)', !!installBtn);
  installBtn.click();
  await new Promise(r => setTimeout(r, 120));
  const a = w.runtime.agents.list().find(x => x.role === 'concise-editor');
  check('D4: consenting installs the intelligence (verified)', !!a && a.verified === true);
}

console.log(`\n== ${pass} pass, ${fail} fail ==`);
process.exit(fail ? 1 : 0);
