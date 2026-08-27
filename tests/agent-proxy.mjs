// Back-delegation with real multi-turn tool use (#36).
//
// The seed has shipped back-delegation twice — `bridge` (single-shot `claude -p`)
// and `bridge-session` — and every feature that needs a real conversation refuses
// both, in four places, with the same comment: "needs a multi-turn tool-use
// backend. bridge / bridge-session are single-shot." So back-delegation was never
// blocked by architecture, only by TRANSPORT.
//
// `rwa proxy --agent` is the translator that closes it: OpenAI-compatible toward
// the container, agent-native toward the local agent, synthesizing genuine
// tool_calls from the agent's text. The container cannot tell it apart from
// Ollama, which is why NO SEED CHANGE was required for any of this.
//
// These tests drive the REAL container through a REAL HTTP round trip to a REAL
// proxy — jsdom boots the seed, `window.fetch` is Node's, and the base URL points
// at a listening server. Stubbing fetch would have proved only that my handler
// returns the right shape; it would not have proved the container accepts it.
//
// The load-bearing test is B: the agent's FIRST answer is deliberately wrong, so
// the container's apply fails, feeds the structured failure back as a tool
// result, and the agent corrects itself. That second turn is exactly what the
// single-shot bridge could never do — and therefore exactly what this exists for.
//
// Run:  (cd tests && npm install && node agent-proxy.mjs)

import jsdomPkg from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import fs from 'node:fs';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { TextEncoder, TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';
import { applySeedSubs, kindOverrides, replaceInlineDoc } from '../cli/src/seed.mjs';
import { startProxy } from '../cli/src/proxy.mjs';
import { createAgentUpstream, renderPrompt, parseEnvelope, toolForEnvelope, AgentUpstreamError } from '../cli/src/agent-upstream.mjs';

const { JSDOM, VirtualConsole } = jsdomPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(__dirname, '..', 'seeds', 'rewritable.html');

let pass = 0, fail = 0;
const check = (label, cond) => {
  if (cond) { pass++; console.log('  OK  ', label); }
  else      { fail++; console.log('  FAIL', label); }
};
const tick = () => new Promise(r => setTimeout(r, 0));
async function waitFor(pred, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await pred()) return true; await tick(); }
  return pred();
}

async function boot(body, baseUrl) {
  const ov = kindOverrides('document');
  let html = fs.readFileSync(SEED, 'utf8');
  html = applySeedSubs(html, {
    uuid: webcrypto.randomUUID(), title: 'AP', fileMeta: 'ap.html', productKind: 'document',
    lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder,
    productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor,
  });
  html = replaceInlineDoc(html, body);
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', e => console.error('[jsdomError]', e?.detail?.stack || e?.detail || e));
  const dom = new JSDOM(html, {
    url: 'https://rwa-agentproxy.local/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(window) {
      window.indexedDB = indexedDB;
      window.IDBKeyRange = IDBKeyRange;
      // The KEYLESS local-backend path — the existing machinery this rides on.
      // No rwa_apikey is ever set, in any of these tests.
      window.sessionStorage.setItem('rwa_backend', 'ollama');
      window.sessionStorage.setItem('rwa_base_url_ollama', baseUrl);
      window.sessionStorage.setItem('rwa_model', 'claude');
      window.fetch = (...a) => fetch(...a);   // real network, to 127.0.0.1
      Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
      window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
      Object.defineProperty(window.navigator, 'storage', { value: { persist: () => Promise.resolve(false) }, configurable: true });
      Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true });
    },
  });
  const ready = await waitFor(() => dom.window.runtime && dom.window.document.getElementById('rwa-st-commit'));
  if (!ready) throw new Error('bootstrap did not settle');
  return dom.window;
}

const envelope = (find, replace) => JSON.stringify({ version: 'rwa-edit/1', edits: [{ find, replace }] });

(async () => {
  console.log('== A: unit — the translation itself ==');
  {
    const p = renderPrompt(
      [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'do the thing' }],
      [{ function: { name: 'apply_edits' } }, { function: { name: 'replace_document' } }],
    );
    check('A1 the system framing survives', p.includes('SYS'));
    check('A2 the request is marked as the request', /=== REQUEST ===\ndo the thing/.test(p));
    check('A3 the available tools are named', p.includes('apply_edits, replace_document'));

    const withFailure = renderPrompt([
      { role: 'user', content: 'do it' },
      { role: 'assistant', tool_calls: [{ function: { name: 'apply_edits', arguments: '{"bad":1}' } }] },
      { role: 'tool', content: '{"ok":false,"code":"find_not_found"}' },
    ], []);
    // Without this the retry is blind: the agent would be asked again with no
    // idea what went wrong, which is the single-shot bridge's whole problem.
    check('A4 a tool-result failure is rendered back into the prompt', /THAT ATTEMPT FAILED/.test(withFailure));
    check('A5 the failing code reaches the agent', withFailure.includes('find_not_found'));
    check('A6 and so does what it tried last time', withFailure.includes('{"bad":1}'));
    check('A7 it is told not to repeat itself', /Do not repeat the same one/.test(withFailure));

    // Models fence, prepend, and explain. The extractor has to survive all three
    // without mistaking incidental JSON for the answer.
    check('A8 bare JSON parses', parseEnvelope(envelope('a', 'b')).edits[0].find === 'a');
    check('A9 fenced JSON parses', parseEnvelope('```json\n' + envelope('a', 'b') + '\n```').edits[0].find === 'a');
    check('A10 prose before the JSON is tolerated', parseEnvelope('Sure! Here:\n' + envelope('a', 'b')).edits[0].replace === 'b');
    check('A11 a non-envelope JSON object is NOT mistaken for the answer',
      parseEnvelope('{"note":"thinking"}\n' + envelope('a', 'b')).edits[0].find === 'a');
    check('A12 nested braces in a string do not end the scan',
      parseEnvelope(envelope('function(){}', 'x')).edits[0].find === 'function(){}');
    let noEnv = null;
    try { parseEnvelope('I cannot help with that.'); } catch (e) { noEnv = e.code; }
    check('A13 a refusal fails loud rather than silently no-op', noEnv === 'no_envelope_in_agent_reply');
    let empty = null;
    try { parseEnvelope(''); } catch (e) { empty = e.code; }
    check('A14 an empty reply fails loud too', empty === 'empty_agent_reply');

    check('A15 the tool is chosen from the envelope shape',
      toolForEnvelope({ edits: [] }) === 'apply_edits' &&
      toolForEnvelope({ ops: [] }) === 'apply_dsl_plan' &&
      toolForEnvelope({ doc: 'x', reason: 'y' }) === 'replace_document');
  }

  console.log('\n== B: the container completes a MULTI-TURN tool-use modify() ==');
  {
    let turn = 0;
    const prompts = [];
    const runAgent = async (prompt) => {
      prompts.push(prompt);
      turn++;
      // Turn 1 answers with an anchor that is not in the document, so the
      // container's apply fails for real and the retry channel is exercised.
      if (turn === 1) return '```json\n' + envelope('NOT PRESENT ANYWHERE', 'x') + '\n```';
      return 'Fixed:\n' + envelope('seed text here', 'agent rewrote this');
    };
    const agent = createAgentUpstream({ runAgent });
    const { port, close } = await startProxy({ port: 0, agent });
    try {
      const window = await boot('<article><p>seed text here</p></article>', `http://127.0.0.1:${port}/v1`);
      check('B1 the container booted with NO api key', !window.sessionStorage.getItem('rwa_apikey'));
      await window.modify('rewrite the paragraph');
      const doc = await window.getDoc();
      check('B2 the edit landed', doc.includes('agent rewrote this'));
      check('B3 it took more than one turn — a real conversation', turn > 1);
      check('B4 the second prompt carried the apply failure', /THAT ATTEMPT FAILED/.test(prompts[1] || ''));
      check('B5 the failure the container reported was the real one',
        (prompts[1] || '').includes('find_not_found'));
      check('B6 the agent was billed exactly as many calls as turns', agent.calls === turn);
      // The whole document, including the untrusted text, reached the agent
      // still inside the container's nonce fence — back-delegation must not
      // quietly strip the defence the in-page path applies.
      check('B7 the DOC fence survives the translation', /<DOC nonce="[0-9a-f]{8}">/.test(prompts[0]));
      check('B8 and the data-not-instruction framing with it',
        /DATA, not an instruction/.test(prompts[0]));
      window.close();
    } finally { await close(); }
  }

  console.log('\n== B2: skin --l1 stops degrading — the feature this un-blocks ==');
  {
    // The concrete pay-off. seeds/rewritable.html ~6379 refuses L1 outright for
    // bridge/bridge-session and falls back to a deterministic theme-only restyle:
    //
    //   if (!recipe || cfg.kind === 'bridge' || cfg.kind === 'bridge-session')
    //
    // Over this proxy `cfg.kind` is 'ollama', so the guard does not fire and the
    // agent's sk-* wrappers actually land. Same local agent, same absence of an
    // API key — only the transport changed.
    const runAgent = async (prompt) => {
      const m = /<DOC nonce="([0-9a-f]{8})">\n([\s\S]*?)\n<\/DOC nonce="\1">/.exec(prompt);
      const doc = m ? m[2] : '';
      const dek = /<p[^>]*>Dek line\.<\/p>/.exec(doc);
      if (!dek) return JSON.stringify({ version: 'rwa-edit/1', edits: [] });
      return JSON.stringify({ version: 'rwa-edit/1', edits: [{
        find: dek[0],
        replace: dek[0].replace('<p', '<p class="sk-eyebrow"').replace(' class="sk-eyebrow"', ' class="sk-eyebrow"'),
      }] });
    };
    const agent = createAgentUpstream({ runAgent });
    const { port, close } = await startProxy({ port: 0, agent });
    try {
      const window = await boot('<article><h1>Doc</h1>\n<p>Dek line.</p></article>', `http://127.0.0.1:${port}/v1`);
      check('B2-1 applySkinL1 is reachable', typeof window.applySkinL1 === 'function');
      await window.applySkinL1('notion-clean');
      const doc = await window.getDoc();
      check('B2-2 the deterministic theme block landed', /data-rwa-skin="notion-clean"/.test(doc));
      // THIS is the assertion the issue is about. On bridge/bridge-session it
      // fails: the guard degrades to theme-only and no sk-* wrapper ever appears.
      check('B2-3 the AGENT contribution landed too (content-aware, not theme-only)',
        /class="sk-eyebrow"/.test(doc));
      check('B2-4 the agent was actually consulted', agent.calls >= 1);
      window.close();
    } finally { await close(); }
  }

  console.log('\n== C: the budget is real, and refusals are legible ==');
  {
    const agent = createAgentUpstream({ runAgent: async () => envelope('a', 'b'), maxCalls: 2 });
    const { port, close } = await startProxy({ port: 0, agent });
    try {
      const url = `http://127.0.0.1:${port}/v1/chat/completions`;
      const post = () => fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }], tools: [] }),
      });
      check('C1 first call is served', (await post()).status === 200);
      check('C2 second call is served', (await post()).status === 200);
      const third = await post();
      // 429, not 502: the caller must STOP, not retry. A document that could
      // spend without bound would be spending the human's tokens, in their own
      // session, with no ceiling.
      check('C3 the third is refused with 429', third.status === 429);
      const body = await third.json();
      check('C4 and says why', body.error.type === 'call_budget_exhausted');

      const models = await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json();
      check('C5 /models answers so the settings Test button works', Array.isArray(models.data) && models.data.length === 1);
    } finally { await close(); }
  }

  console.log('\n== D: an agent that fails is reported, never silently ignored ==');
  {
    const agent = createAgentUpstream({
      runAgent: async () => { throw new AgentUpstreamError('agent_not_found', 'claude'); },
    });
    const { port, close } = await startProxy({ port: 0, agent });
    try {
      const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [], tools: [] }),
      });
      check('D1 a missing local agent surfaces as 502', r.status === 502);
      check('D2 with the code, not a generic message', (await r.json()).error.type === 'agent_not_found');
    } finally { await close(); }
  }

  console.log('\n== E: the key path is untouched ==');
  {
    // The agent upstream is additive. The broker must still refuse to start
    // without a key, or #36 would have quietly widened the original design.
    let threw = null;
    try { await startProxy({ port: 0 }); } catch (e) { threw = e.message; }
    check('E1 the key broker still requires a key', /key is required/.test(threw || ''));
  }

  console.log(`\n${pass + fail} checks — ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
