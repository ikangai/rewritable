// End-to-end smoke test for rwa-edit/1 in seeds/rewritable.html.
//
// Loads the seed in jsdom, stubs window.fetch to simulate OpenRouter tool-call
// responses, drives modify() through each scenario in the spec, and asserts on
// IDB state and DOM after each.
//
// Run from this directory:
//   npm install
//   npm test
//
// Or from the repo root:
//   (cd tests && npm install && npm test)
//
// The test exits non-zero if any assertion fails.

import jsdomPkg from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { JSDOM, VirtualConsole } = jsdomPkg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(__dirname, '..', 'seeds', 'rewritable.html');
const html = fs.readFileSync(SEED, 'utf8');

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log('  OK ', label); }
  else      { fail++; console.log('  FAIL', label); }
}

// Stubbable fetch — set this before each scenario.
let fetchHandler = async () => { throw new Error('no fetchHandler set'); };

const virtualConsole = new VirtualConsole();
// Forward jsdomError; suppress runtime console.error noise (rwa-edit retry exhaustion logs).
virtualConsole.on('jsdomError', e => console.error('[jsdomError]', e?.detail?.stack || e?.detail || e));

const dom = new JSDOM(html, {
  url: 'https://rwa-test.local/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole,
  beforeParse(window) {
    window.indexedDB = indexedDB;
    window.IDBKeyRange = IDBKeyRange;
    window.sessionStorage.setItem('rwa_apikey', 'test-key');
    window.sessionStorage.setItem('rwa_model', 'test-model');
    window.fetch = (...args) => fetchHandler(...args);
    Object.defineProperty(window.navigator, 'storage', {
      value: { persist: () => Promise.resolve(false) }, configurable: true,
    });
    Object.defineProperty(window.navigator, 'platform', {
      value: 'MacIntel', configurable: true,
    });
  },
});

const window = dom.window;

// Wait for the bootstrap IIFE to settle.
await new Promise(r => setTimeout(r, 200));

console.log('== Bootstrap loaded ==');
// Note: top-level `const` declarations don't go on `window` in script mode, so we can
// only directly check `function`-declared globals. The const helpers (canonLF, RWA_EDIT,
// SYSTEM_PROMPT, TOOL_SCHEMAS) are exercised indirectly by the modify() tests below.
check('window.modify is a function', typeof window.modify === 'function');
check('window.applyEdits is a function', typeof window.applyEdits === 'function');
check('window.replaceDocument is a function', typeof window.replaceDocument === 'function');
check('mount has rendered content', window.document.getElementById('rwa-doc-mount')?.innerHTML.includes('Hello, world.'));

const initialDoc = await window.getDoc();
check('initial doc contains Hello, world.', initialDoc.includes('Hello, world.'));

// Test 1: apply_edits success path.
console.log('\n== Test 1: apply_edits success path ==');
fetchHandler = async () => ({
  ok: true,
  json: async () => ({
    choices: [{
      message: {
        role: 'assistant', content: '',
        tool_calls: [{
          id: 'call_1', type: 'function',
          function: {
            name: 'apply_edits',
            arguments: JSON.stringify({
              version: 'rwa-edit/1',
              edits: [{ find: 'Hello, world.', replace: 'Goodbye, world.' }],
            }),
          },
        }],
      },
    }],
  }),
});

await window.modify('replace the greeting');
await new Promise(r => setTimeout(r, 100));

const docAfter1 = await window.getDoc();
check('doc was edited (Goodbye, world. present)', docAfter1.includes('Goodbye, world.'));
check('doc was edited (Hello, world. removed)', !docAfter1.includes('Hello, world.'));
check('mount re-rendered', window.document.getElementById('rwa-doc-mount').innerHTML.includes('Goodbye, world.'));

const undoStack = await new Promise((res, rej) => {
  window.openDB().then(db => {
    const r = db.transaction('rwa_undo').objectStore('rwa_undo').get('self');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
});
check('undo stack has prior doc', Array.isArray(undoStack) && undoStack.length === 1 && undoStack[0].includes('Hello, world.'));

// Test 2: find_not_unique → multi-turn retry → success.
console.log('\n== Test 2: find_not_unique → retry → success ==');
let callCount = 0;
fetchHandler = async (url, opts) => {
  callCount++;
  if (callCount === 1) {
    // First attempt: ambiguous anchor — `font-family` appears in 4 CSS rules.
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            role: 'assistant', content: '',
            tool_calls: [{
              id: 'call_a', type: 'function',
              function: {
                name: 'apply_edits',
                arguments: JSON.stringify({
                  version: 'rwa-edit/1',
                  edits: [{ find: 'font-family', replace: 'FONT-FAMILY' }],
                }),
              },
            }],
          },
        }],
      }),
    };
  }
  // Second attempt: assert the runtime fed the failure back as a tool_result.
  const body = JSON.parse(opts.body);
  const last = body.messages.at(-1);
  check('retry message is role=tool', last.role === 'tool');
  const payload = JSON.parse(last.content);
  check('retry payload has find_not_unique', payload.code === 'find_not_unique');
  check('retry payload has count >= 2', (payload.count ?? 0) >= 2);
  check('retry payload has hints array', Array.isArray(payload.hints));
  return {
    ok: true,
    json: async () => ({
      choices: [{
        message: {
          role: 'assistant', content: '',
          tool_calls: [{
            id: 'call_b', type: 'function',
            function: {
              name: 'apply_edits',
              arguments: JSON.stringify({
                version: 'rwa-edit/1',
                edits: [{ find: 'Goodbye, world.', replace: 'Bonjour, monde.' }],
              }),
            },
          }],
        },
      }],
    }),
  };
};

await window.modify('uppercase the world');
await new Promise(r => setTimeout(r, 100));
check('used 2 fetch calls (1 fail, 1 success)', callCount === 2);
const docAfter2 = await window.getDoc();
check('retry succeeded (Bonjour, monde. present)', docAfter2.includes('Bonjour, monde.'));

// Test 3: frozen_zone_violation rejected (replace contains data-rwa-frozen).
console.log('\n== Test 3: frozen_zone_violation rejected ==');
fetchHandler = async () => ({
  ok: true,
  json: async () => ({
    choices: [{
      message: {
        role: 'assistant', content: '',
        tool_calls: [{
          id: 'call_v', type: 'function',
          function: {
            name: 'apply_edits',
            arguments: JSON.stringify({
              version: 'rwa-edit/1',
              edits: [{ find: 'monde', replace: 'data-rwa-frozen monde' }],
            }),
          },
        }],
      },
    }],
  }),
});

const docBefore3 = await window.getDoc();
await window.modify('try to add reserved attribute');
await new Promise(r => setTimeout(r, 100));
check('frozen-zone violation: doc unchanged', (await window.getDoc()) === docBefore3);

// Test 4: structural_shape_changed rejected (added <script>).
console.log('\n== Test 4: structural_shape_changed rejected (added <script>) ==');
fetchHandler = async () => ({
  ok: true,
  json: async () => ({
    choices: [{
      message: {
        role: 'assistant', content: '',
        tool_calls: [{
          id: 'call_s', type: 'function',
          function: {
            name: 'apply_edits',
            arguments: JSON.stringify({
              version: 'rwa-edit/1',
              edits: [{ find: 'Bonjour, monde.', replace: 'Bonjour, monde.<script>x=1</script>' }],
            }),
          },
        }],
      },
    }],
  }),
});

const docBefore4 = await window.getDoc();
await window.modify('add a script');
await new Promise(r => setTimeout(r, 100));
check('shape change rejected: doc unchanged', (await window.getDoc()) === docBefore4);

// Test 5: replace_document success path.
console.log('\n== Test 5: replace_document success path ==');
fetchHandler = async () => ({
  ok: true,
  json: async () => ({
    choices: [{
      message: {
        role: 'assistant', content: '',
        tool_calls: [{
          id: 'call_r', type: 'function',
          function: {
            name: 'replace_document',
            arguments: JSON.stringify({
              version: 'rwa-edit/1',
              doc: '<style>.x{color:red}</style>\n<div>fresh document</div>',
              reason: 'user requested wholesale rewrite',
            }),
          },
        }],
      },
    }],
  }),
});

await window.modify('rewrite');
await new Promise(r => setTimeout(r, 100));
const docAfter5 = await window.getDoc();
check('replace_document succeeded', docAfter5.includes('fresh document'));
check('replace_document removed prior content', !docAfter5.includes('Bonjour, monde.'));

// Test 6: malformed envelope → retry budget exhaustion (3 attempts, no fallback).
console.log('\n== Test 6: malformed envelope → retry budget exhaustion ==');
let attempts = 0;
fetchHandler = async () => {
  attempts++;
  return {
    ok: true,
    json: async () => ({
      choices: [{
        message: {
          role: 'assistant', content: '',
          tool_calls: [{
            id: 'call_m' + attempts, type: 'function',
            function: { name: 'apply_edits', arguments: '<<<not json>>>' },
          }],
        },
      }],
    }),
  };
};

const docBefore6 = await window.getDoc();
await window.modify('cause failures');
await new Promise(r => setTimeout(r, 100));
check('exhausted retry budget (3 attempts)', attempts === 3);
check('retry exhaustion: doc unchanged', (await window.getDoc()) === docBefore6);

// Test 7: model declined (text-only response, no tool_calls).
console.log('\n== Test 7: model declined (text only, no tool_calls) ==');
fetchHandler = async () => ({
  ok: true,
  json: async () => ({
    choices: [{ message: { role: 'assistant', content: 'Could you clarify what you mean?' } }],
  }),
});

const docBefore7 = await window.getDoc();
await window.modify('be ambiguous');
await new Promise(r => setTimeout(r, 100));
check('decline: doc unchanged', (await window.getDoc()) === docBefore7);

// Test 8: rwa_hist contains typed records, newest-first.
console.log('\n== Test 8: rwa_hist contains typed records ==');
const histStack = await new Promise((res, rej) => {
  window.openDB().then(db => {
    const r = db.transaction('rwa_hist').objectStore('rwa_hist').get('self');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
});
check('hist is array', Array.isArray(histStack));
check('hist has typed records', histStack.every(r => typeof r === 'object' && (r.kind === 'edit_batch' || r.kind === 'replace_document')));
check('newest first (replace_document on top)', histStack[0]?.kind === 'replace_document');

// Test 9: frozen_zone_corrupted on attempted addition via replace_document.
// Spec §6 rule 3: the set of frozen-zone names must equal the prior set.
console.log('\n== Test 9: replace_document cannot introduce new frozen zones ==');
fetchHandler = async () => ({
  ok: true,
  json: async () => ({
    choices: [{
      message: {
        role: 'assistant', content: '',
        tool_calls: [{
          id: 'call_fzc', type: 'function',
          function: {
            name: 'replace_document',
            arguments: JSON.stringify({
              version: 'rwa-edit/1',
              doc: '<style>\n/* rwa:frozen:begin theme */\n:root { --x: 1; }\n/* rwa:frozen:end theme */\n</style>\n<div>doc</div>',
              reason: 'try to inject a frozen zone',
            }),
          },
        }],
      },
    }],
  }),
});

const docBefore9 = await window.getDoc();
await window.modify('inject a frozen zone');
await new Promise(r => setTimeout(r, 100));
check('addition of new frozen zone rejected', (await window.getDoc()) === docBefore9);

console.log('\n== Summary ==');
console.log(`pass: ${pass}, fail: ${fail}`);
process.exit(fail > 0 ? 1 : 0);
