// Functional test for the `bridge-session` backend in seeds/rewritable.html
// (modifyViaSession): the persistent-claude path through web_cli_bridge's
// /session/* endpoints. Drives a full turn against a MOCKED bridge (create ->
// stream SSE -> get-envelope) and asserts the envelope is applied through the
// same apply* machinery as every other backend, plus the session lifecycle
// (cache + reuse + recreate), the gen-sentinel strip, and the no-envelope and
// missing-config error paths.
//
// Run:  (cd tests && npm install && node session.mjs)
// Exits non-zero on any failure.

import jsdomPkg from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { JSDOM, VirtualConsole } = jsdomPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(__dirname, '..', 'seeds', 'rewritable.html');
const html = fs.readFileSync(SEED, 'utf8');
const DOC_UUID = '00000000-0000-0000-0000-000000000000';   // seed default
const UUID = '11111111-2222-3333-4444-555555555555';

let pass = 0, fail = 0;
const check = (label, cond) => {
  if (cond) { pass++; console.log('  OK  ', label); }
  else      { fail++; console.log('  FAIL', label); }
};

const sse = (events) =>
  events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');

// A stream response whose body.getReader() yields the SSE bytes in 3 chunks,
// cut mid-frame and across a '\n\n' separator — exercises the real-browser
// streaming-reader branch of consumeSessionStream (the other mocks omit `body`
// and so hit the resp.text() fallback).
function chunkedStream(sseStr) {
  const bytes = new TextEncoder().encode(sseStr);
  const c1 = Math.max(1, Math.floor(bytes.length * 0.3));
  const c2 = Math.max(c1 + 1, Math.floor(bytes.length * 0.7));
  const chunks = [bytes.slice(0, c1), bytes.slice(c1, c2), bytes.slice(c2)];
  let i = 0;
  return { ok: true, status: 200, body: { getReader: () => ({
    read: () => Promise.resolve(i < chunks.length
      ? { value: chunks[i++], done: false } : { value: undefined, done: true }),
  }) } };
}

const RESP = {
  create: () => ({ ok: true, status: 200,
    json: async () => ({ session_id: 'a'.repeat(32), cap: 'c'.repeat(64),
                         rendezvous_dir: '/x', created_at: 1 }) }),
  stream: () => ({ ok: true, status: 200, text: async () => sse([
    ['state', { state: 'thinking' }],
    ['done', { reason: 'idle', turn_uuid: UUID, alive: true, state: 'idle', log_offset: 0 }],
  ]) }),
  env: () => ({ ok: true, status: 200, text: async () => JSON.stringify({
    tool: 'replace_document',
    envelope: { version: 'rwa-edit/1', doc: '<p>SESSION_OK</p>', reason: 't' },
    turn_uuid: UUID, gen: UUID }) }),
};
const mock = { calls: [], lastHeaders: null, create: RESP.create, stream: RESP.stream, env: RESP.env };
const resetResponses = () => { mock.create = RESP.create; mock.stream = RESP.stream; mock.env = RESP.env; };

function router(url, opts) {
  const u = new URL(typeof url === 'string' ? url : url.url);
  mock.calls.push(u.pathname);
  mock.lastHeaders = (opts && opts.headers) || null;
  if (u.pathname === '/session/create') return mock.create();
  if (u.pathname === '/session/stream') return mock.stream();
  if (u.pathname === '/session/get-envelope') return mock.env();
  return { ok: false, status: 404, json: async () => ({ error: 'not found' }), text: async () => '' };
}

const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', e => console.error('[jsdomError]', e?.detail?.stack || e?.detail || e));

const dom = new JSDOM(html, {
  url: 'https://rwa-test.local/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole,
  beforeParse(window) {
    window.indexedDB = indexedDB;
    window.IDBKeyRange = IDBKeyRange;
    window.sessionStorage.setItem('rwa_backend', 'bridge-session');
    window.sessionStorage.setItem('rwa_bridge_token', 'tok');
    window.sessionStorage.setItem('rwa_bridge_cwd', '/tmp/sess');
    window.fetch = async (url, opts) => router(url, opts);
    window.TextDecoder = globalThis.TextDecoder;   // for the getReader streaming path
    window.TextEncoder = globalThis.TextEncoder;
    window.BroadcastChannel = globalThis.BroadcastChannel;
    Object.defineProperty(window.navigator, 'storage', {
      value: { persist: () => Promise.resolve(false),
               estimate: () => Promise.resolve({ usage: 0, quota: 1e9 }) },
      configurable: true });
    Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true });
  },
});

const { window } = dom;
await new Promise(r => setTimeout(r, 250));   // let the bootstrap IIFE settle

const SESSION_KEY = 'rwa_bridge_session_' + DOC_UUID;
const progText = () => (window.document.querySelector('#rwa-lens-progress .rwa-lens-prog-text')?.textContent) || '';
const mountHtml = () => window.document.getElementById('rwa-doc-mount').innerHTML;
const clearSession = () => window.sessionStorage.removeItem(SESSION_KEY);
const createCalls = () => mock.calls.filter(p => p === '/session/create').length;

console.log('== bridge-session backend (modifyViaSession) ==');

check('modifyViaSession is exposed by the runtime', typeof window.modifyViaSession === 'function');
check('buildSessionInstruction is exposed', typeof window.buildSessionInstruction === 'function');

// 1. Full replace_document turn: create -> stream -> get-envelope -> apply.
clearSession(); mock.calls = []; resetResponses();
await window.modifyViaSession('rewrite the document');
check('1. replace_document applied — mount shows the new content', /SESSION_OK/.test(mountHtml()));
check('1. create called exactly once', createCalls() === 1);
check('1. stream + get-envelope both called',
  mock.calls.includes('/session/stream') && mock.calls.includes('/session/get-envelope'));

// 2. The session is cached per DOC_UUID: a second turn reuses it (no new create).
mock.calls = [];
await window.modifyViaSession('again');
check('2. second turn reuses the cached session (no new create)', createCalls() === 0);

// 3. A gen sentinel echoed in a replace_document doc is stripped before storing.
clearSession(); mock.calls = [];
mock.env = () => ({ ok: true, status: 200, text: async () => JSON.stringify({
  tool: 'replace_document',
  envelope: { version: 'rwa-edit/1', doc: '<p>CLEAN</p>\n<!-- rwa:gen ' + UUID + ' -->\n', reason: 't' },
  turn_uuid: UUID, gen: UUID }) });
await window.modifyViaSession('rewrite with a sentinel');
check('3. replace_document content stored', /CLEAN/.test(mountHtml()));
check('3. gen sentinel stripped from the stored doc', !/rwa:gen/.test(mountHtml()));
resetResponses();

// 4. idle_no_envelope: surface an error, never fetch an envelope, doc unchanged.
clearSession(); mock.calls = [];
const before = mountHtml();
mock.stream = () => ({ ok: true, status: 200, text: async () => sse([
  ['done', { reason: 'idle_no_envelope', turn_uuid: UUID, alive: true, state: 'idle_no_envelope' }],
]) });
await window.modifyViaSession('a no-op turn');
check('4. idle_no_envelope: get-envelope NOT called', !mock.calls.includes('/session/get-envelope'));
check('4. idle_no_envelope: doc left unchanged', mountHtml() === before);
check('4. idle_no_envelope: error surfaced', /no envelope/i.test(progText()));
resetResponses();

// 5. A stale session (404 on stream) is recreated once, then the turn succeeds.
clearSession(); mock.calls = [];
let streamN = 0;
mock.stream = () => {
  streamN++;
  if (streamN === 1) return { ok: false, status: 404, json: async () => ({ error: 'session not found' }), text: async () => '' };
  return { ok: true, status: 200, text: async () => sse([
    ['done', { reason: 'idle', turn_uuid: UUID, alive: true, state: 'idle' }]]) };
};
mock.env = () => ({ ok: true, status: 200, text: async () => JSON.stringify({
  tool: 'replace_document',
  envelope: { version: 'rwa-edit/1', doc: '<p>RECREATED</p>', reason: 't' },
  turn_uuid: UUID, gen: UUID }) });
await window.modifyViaSession('after a restart');
check('5. 404 on stream recreates the session (create called twice)', createCalls() === 2);
check('5. 404 recovery: the edit applies on the fresh session', /RECREATED/.test(mountHtml()));
resetResponses();

// 6. buildSessionInstruction: max-fidelity (doc + rules) minus the single-shot channel.
const inst = window.buildSessionInstruction('do x', '<p>BODY_MARKER</p>', []);
check('6. instruction embeds the document (max-fidelity choice)', inst.includes('BODY_MARKER'));
check('6. instruction carries the rwa edit rules', /rwa-edit/.test(inst) && /apply_edits/.test(inst));
check('6. instruction drops the single-shot "as your last response" channel line',
  !/as your last response/i.test(inst));

// 7. Missing Session Dir surfaces a clear, actionable error (no silent failure).
clearSession(); mock.calls = [];
window.sessionStorage.removeItem('rwa_bridge_cwd');
await window.modifyViaSession('x');
check('7. missing Session Dir: a clear error is surfaced', /Session Dir/i.test(progText()));
check('7. missing Session Dir: no /session/create attempted', createCalls() === 0);
window.sessionStorage.setItem('rwa_bridge_cwd', '/tmp/sess');

// 8. The gen sentinel is ALSO stripped on the DSL-compiled replace_document
// escape (apply_dsl_plan -> sole-op replace_document), not only the direct path.
clearSession(); mock.calls = [];
mock.env = () => ({ ok: true, status: 200, text: async () => JSON.stringify({
  tool: 'apply_dsl_plan',
  envelope: { version: 'rwa-edit-dsl/1', ops: [
    { op: 'replace_document', doc: '<p>DSL_CLEAN</p>\n<!-- rwa:gen ' + UUID + ' -->\n', reason: 't' }] },
  turn_uuid: UUID, gen: UUID }) });
await window.modifyViaSession('dsl rewrite with a sentinel');
check('8. DSL replace_document content stored', /DSL_CLEAN/.test(mountHtml()));
check('8. DSL-escape path ALSO strips the gen sentinel', !/rwa:gen/.test(mountHtml()));
resetResponses();

// 9. The real-browser streaming reader path (resp.body.getReader) parses SSE
// split across chunk boundaries — not just the resp.text() fallback.
clearSession(); mock.calls = [];
mock.stream = () => chunkedStream(sse([
  ['state', { state: 'thinking' }],
  ['done', { reason: 'idle', turn_uuid: UUID, alive: true, state: 'idle' }]]));
mock.env = () => ({ ok: true, status: 200, text: async () => JSON.stringify({
  tool: 'replace_document',
  envelope: { version: 'rwa-edit/1', doc: '<p>STREAMED</p>', reason: 't' },
  turn_uuid: UUID, gen: UUID }) });
await window.modifyViaSession('a streamed turn');
check('9. getReader path parsed chunked SSE and applied the edit', /STREAMED/.test(mountHtml()));
resetResponses();

// 10. A malformed /session/create 200 (missing session_id/cap) fails loud and is
// NOT cached (no poisoned session that 400s every later call).
clearSession(); mock.calls = [];
mock.create = () => ({ ok: true, status: 200, json: async () => ({ rendezvous_dir: '/x' }) });
await window.modifyViaSession('malformed create');
check('10. malformed create surfaces an error', /malformed session/i.test(progText()));
check('10. malformed create was not cached', !window.sessionStorage.getItem(SESSION_KEY));
resetResponses();

// 11. The configured bearer token is sent on /session/* requests.
clearSession(); mock.calls = []; mock.lastHeaders = null;
await window.modifyViaSession('token check');
check('11. Authorization: Bearer <token> sent on /session/* calls',
  !!mock.lastHeaders && mock.lastHeaders.Authorization === 'Bearer tok');
resetResponses();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
