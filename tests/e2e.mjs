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

// Test 10: ⌘Z during in-flight ⌘K is rejected — regression for the silent-undo-clobber bug.
// Without the modifyMutex check in undo(), a concurrent ⌘Z would pop+write rwa_doc,
// then modify()'s commitDoc would clobber it on resolve.
console.log('\n== Test 10: ⌘Z during in-flight ⌘K is rejected ==');
let modifyFetchResolve;
fetchHandler = () => new Promise(r => { modifyFetchResolve = r; });

const readUndo = () => new Promise((res, rej) => {
  window.openDB().then(db => {
    const r = db.transaction('rwa_undo').objectStore('rwa_undo').get('self');
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  });
});

const docBefore10 = await window.getDoc();
const undoBefore10 = await readUndo();

const modify10 = window.modify('start a slow modify');
// let modify() acquire the mutex and reach the awaited fetch
await new Promise(r => setTimeout(r, 30));

await window.undo();
check('undo during modify: doc unchanged', (await window.getDoc()) === docBefore10);
const undoDuring10 = await readUndo();
check('undo during modify: undo stack unchanged', undoDuring10.length === undoBefore10.length);

// release the fetch with a successful single-edit response so modify finishes cleanly
modifyFetchResolve({
  ok: true,
  json: async () => ({
    choices: [{
      message: {
        role: 'assistant', content: '',
        tool_calls: [{
          id: 'call_10', type: 'function',
          function: {
            name: 'apply_edits',
            arguments: JSON.stringify({
              version: 'rwa-edit/1',
              edits: [{ find: 'fresh document', replace: 'completed-after-undo-rejected' }],
            }),
          },
        }],
      },
    }],
  }),
});
await modify10;
await new Promise(r => setTimeout(r, 50));
check('modify completes after undo bailout', (await window.getDoc()).includes('completed-after-undo-rejected'));

// Test 11: parallel tool_calls — only the consumed tc is echoed back on retry.
// Without the fix, the assistant message echoed for retry contained ALL tool_calls
// the model emitted, but only one had a paired tool_result — providers reject this.
console.log('\n== Test 11: parallel tool_calls — only consumed tc echoed on retry ==');
let parallelCallCount = 0;
let parallelRetrySeen = false;
fetchHandler = async (url, opts) => {
  parallelCallCount++;
  if (parallelCallCount === 1) {
    // model returns TWO parallel tool_calls; runtime processes only [0]
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            role: 'assistant', content: '',
            tool_calls: [
              { id: 'parallel_a', type: 'function', function: { name: 'apply_edits',
                arguments: JSON.stringify({ version: 'rwa-edit/1',
                  edits: [{ find: 'NOT_IN_DOC_ANCHOR', replace: 'X' }] }) } },
              { id: 'parallel_b', type: 'function', function: { name: 'apply_edits',
                arguments: JSON.stringify({ version: 'rwa-edit/1',
                  edits: [{ find: 'completed-after-undo-rejected', replace: 'Y' }] }) } },
            ],
          },
        }],
      }),
    };
  }
  const body = JSON.parse(opts.body);
  const lastAssistant = [...body.messages].reverse().find(m => m.role === 'assistant');
  check('retry assistant has exactly 1 tool_call', lastAssistant?.tool_calls?.length === 1);
  check('retry tool_call id is the consumed one (parallel_a)', lastAssistant?.tool_calls?.[0]?.id === 'parallel_a');
  parallelRetrySeen = true;
  return {
    ok: true,
    json: async () => ({
      choices: [{
        message: {
          role: 'assistant', content: '',
          tool_calls: [{
            id: 'after_retry', type: 'function',
            function: {
              name: 'apply_edits',
              arguments: JSON.stringify({
                version: 'rwa-edit/1',
                edits: [{ find: 'completed-after-undo-rejected', replace: 'parallel-fixed' }],
              }),
            },
          }],
        },
      }],
    }),
  };
};
await window.modify('parallel tool_calls test');
await new Promise(r => setTimeout(r, 100));
check('parallel: retry path was exercised', parallelRetrySeen);
check('parallel: doc updated to retry result', (await window.getDoc()).includes('parallel-fixed'));

// Note: fix #2 (FSA permission denial purges the stored handle) is not exercised here.
// jsdom can't faithfully simulate FileSystemFileHandle: the structured-clone roundtrip
// through IDB drops functions, so a fake handle's queryPermission becomes undefined and
// the runtime hits a TypeError before reaching the new idbDel call. The fix is verified
// by code inspection; integration coverage requires a real Chromium harness.

// Test 12: replace_document with reserved id="rwa-doc-mount" is rejected.
console.log('\n== Test 12: reserved id="rwa-doc-mount" rejected ==');
fetchHandler = async () => ({
  ok: true,
  json: async () => ({
    choices: [{
      message: {
        role: 'assistant', content: '',
        tool_calls: [{
          id: 'call_id_mount', type: 'function',
          function: {
            name: 'replace_document',
            arguments: JSON.stringify({
              version: 'rwa-edit/1',
              doc: '<style>.x{color:red}</style>\n<div id="rwa-doc-mount">shadow mount</div>',
              reason: 'try to shadow the runtime mount',
            }),
          },
        }],
      },
    }],
  }),
});

const docBefore12 = await window.getDoc();
await window.modify('introduce a reserved mount id');
await new Promise(r => setTimeout(r, 100));
check('reserved-id replace_document rejected: doc unchanged', (await window.getDoc()) === docBefore12);

// Test 13: replace_document with reserved [data-rwa-id] is rejected.
console.log('\n== Test 13: reserved data-rwa-id rejected ==');
fetchHandler = async () => ({
  ok: true,
  json: async () => ({
    choices: [{
      message: {
        role: 'assistant', content: '',
        tool_calls: [{
          id: 'call_id_v2', type: 'function',
          function: {
            name: 'replace_document',
            arguments: JSON.stringify({
              version: 'rwa-edit/1',
              doc: '<style>.x{color:red}</style>\n<section data-rwa-id="claim">v2 squat</section>',
              reason: 'try to claim a v2-reserved attribute',
            }),
          },
        }],
      },
    }],
  }),
});

const docBefore13 = await window.getDoc();
await window.modify('claim data-rwa-id');
await new Promise(r => setTimeout(r, 100));
check('reserved-attr replace_document rejected: doc unchanged', (await window.getDoc()) === docBefore13);

// Test 14a: apply_edits cannot introduce a reserved id="rwa-doc-mount".
// Tests 12-13 verify replace_document rejects reserved IDs; this verifies
// that apply_edits enforces the same invariant via findReservedIdViolation
// after the splice — a refactor that drops that check would silently let
// the model shadow the runtime mount through a surgical anchor.
console.log('\n== Test 14a: apply_edits cannot introduce id="rwa-doc-mount" ==');
fetchHandler = async () => ({
  ok: true,
  json: async () => ({
    choices: [{
      message: {
        role: 'assistant', content: '',
        tool_calls: [{
          id: 'call_aerm', type: 'function',
          function: {
            name: 'apply_edits',
            arguments: JSON.stringify({
              version: 'rwa-edit/1',
              edits: [{ find: 'parallel-fixed', replace: '<span id="rwa-doc-mount">x</span>' }],
            }),
          },
        }],
      },
    }],
  }),
});

const docBefore14a = await window.getDoc();
await window.modify('apply_edits introducing reserved mount id');
await new Promise(r => setTimeout(r, 100));
check('apply_edits with reserved id rejected: doc unchanged', (await window.getDoc()) === docBefore14a);

// Test 14b: apply_edits cannot introduce data-rwa-id (v2 reserved attribute).
console.log('\n== Test 14b: apply_edits cannot introduce data-rwa-id ==');
fetchHandler = async () => ({
  ok: true,
  json: async () => ({
    choices: [{
      message: {
        role: 'assistant', content: '',
        tool_calls: [{
          id: 'call_aev2', type: 'function',
          function: {
            name: 'apply_edits',
            arguments: JSON.stringify({
              version: 'rwa-edit/1',
              edits: [{ find: 'parallel-fixed', replace: '<span data-rwa-id="claim">x</span>' }],
            }),
          },
        }],
      },
    }],
  }),
});

const docBefore14b = await window.getDoc();
await window.modify('apply_edits introducing data-rwa-id');
await new Promise(r => setTimeout(r, 100));
check('apply_edits with data-rwa-id rejected: doc unchanged', (await window.getDoc()) === docBefore14b);

// Test 14: replace string containing $& / $$ must be inserted literally.
// String.prototype.replace honors $&, $$, $`, $' patterns even when the search
// arg is a string — `work.replace('foo', '$$x$&y')` yields '$xfooy'. The runtime
// must splice replacements byte-for-byte so the model's intent is preserved.
console.log('\n== Test 14: $&/$$ in replace inserted literally ==');
fetchHandler = async () => ({
  ok: true,
  json: async () => ({
    choices: [{
      message: {
        role: 'assistant', content: '',
        tool_calls: [{
          id: 'call_dollar', type: 'function',
          function: {
            name: 'apply_edits',
            arguments: JSON.stringify({
              version: 'rwa-edit/1',
              edits: [{ find: 'parallel-fixed', replace: '$$amount $&literal' }],
            }),
          },
        }],
      },
    }],
  }),
});

await window.modify('test dollar literals');
await new Promise(r => setTimeout(r, 100));
const docAfter14 = await window.getDoc();
check('$$ inserted literally (not collapsed to $)', docAfter14.includes('$$amount'));
check('$& inserted literally (not expanded to find)', docAfter14.includes('$&literal'));
check('no expanded backreference artifact', !docAfter14.includes('parallel-fixedliteral'));

// Tests 15-16: apply_edits frozen-zone enforcement. Seed a doc that contains a
// frozen zone via raw IDB (frozen zones cannot be added through the modify
// pathway — only through bootstrap/seeds), then verify:
//   • edits whose anchor lands inside the zone change inner content -> rejected
//   • edits whose anchor lands outside the zone are allowed and leave the zone untouched
// Without this coverage, a runtime refactor that drops the post-apply
// frozenZonesIntact() check would let the model rewrite "author-declared
// invariants" silently — the worst kind of unintended change.
console.log('\n== Tests 15-16: apply_edits frozen-zone enforcement ==');
const frozenDoc = '<style>\n/* rwa:frozen:begin theme */\n:root { --frozen-knob: 1; }\n/* rwa:frozen:end theme */\n</style>\n<div>outside-zone-anchor</div>';
await new Promise((res, rej) => {
  window.openDB().then(db => {
    const r = db.transaction('rwa_doc', 'readwrite').objectStore('rwa_doc').put(frozenDoc, 'self');
    r.onsuccess = res;
    r.onerror = () => rej(r.error);
  });
});

// Test 15: apply_edits anchor inside frozen zone -> rejected (frozen_zone_corrupted).
fetchHandler = async () => ({
  ok: true,
  json: async () => ({
    choices: [{
      message: {
        role: 'assistant', content: '',
        tool_calls: [{
          id: 'call_inside_fz', type: 'function',
          function: {
            name: 'apply_edits',
            arguments: JSON.stringify({
              version: 'rwa-edit/1',
              edits: [{ find: '--frozen-knob: 1', replace: '--frozen-knob: 2' }],
            }),
          },
        }],
      },
    }],
  }),
});

const docBefore15 = await window.getDoc();
await window.modify('mutate inside frozen zone');
await new Promise(r => setTimeout(r, 100));
check('apply_edits inside frozen zone rejected: doc unchanged', (await window.getDoc()) === docBefore15);

// Test 16: apply_edits anchor outside frozen zone -> allowed, zone inner preserved.
fetchHandler = async () => ({
  ok: true,
  json: async () => ({
    choices: [{
      message: {
        role: 'assistant', content: '',
        tool_calls: [{
          id: 'call_outside_fz', type: 'function',
          function: {
            name: 'apply_edits',
            arguments: JSON.stringify({
              version: 'rwa-edit/1',
              edits: [{ find: 'outside-zone-anchor', replace: 'changed-outside' }],
            }),
          },
        }],
      },
    }],
  }),
});

await window.modify('mutate outside frozen zone');
await new Promise(r => setTimeout(r, 100));
const docAfter16 = await window.getDoc();
check('apply_edits outside frozen zone allowed', docAfter16.includes('changed-outside'));
check('zone inner content preserved across allowed edit', docAfter16.includes('--frozen-knob: 1'));

// Tests 17a-17b: multi-edit batch fidelity. Two properties matter:
//   (a) Atomicity — if edit[N] fails, edits[0..N-1] must NOT persist. The runtime
//       only commits to IDB after every edit in the batch is validated, so a
//       partial-batch commit would be a fidelity violation that silently
//       changed bytes without the user's intent.
//   (b) Sequential application — edit[i+1].find may anchor on text produced
//       by edit[i].replace. The runtime must apply edits in order against the
//       evolving working buffer, not against a frozen pre-batch snapshot.
console.log('\n== Test 17a: multi-edit batch atomicity ==');
fetchHandler = async () => ({
  ok: true,
  json: async () => ({
    choices: [{
      message: {
        role: 'assistant', content: '',
        tool_calls: [{
          id: 'call_atomic', type: 'function',
          function: {
            name: 'apply_edits',
            arguments: JSON.stringify({
              version: 'rwa-edit/1',
              edits: [
                { find: 'changed-outside', replace: 'PARTIAL_STEP_A' },
                { find: 'NEVER_PRESENT_ANCHOR', replace: 'PARTIAL_STEP_B' },
              ],
            }),
          },
        }],
      },
    }],
  }),
});

const docBefore17a = await window.getDoc();
await window.modify('multi-edit batch with edit[1] failing');
await new Promise(r => setTimeout(r, 200));
check('atomic batch: doc unchanged when edit[1] fails', (await window.getDoc()) === docBefore17a);
check('atomic batch: edit[0] result not persisted', !(await window.getDoc()).includes('PARTIAL_STEP_A'));

console.log('\n== Test 17b: sequential dependent edits ==');
fetchHandler = async () => ({
  ok: true,
  json: async () => ({
    choices: [{
      message: {
        role: 'assistant', content: '',
        tool_calls: [{
          id: 'call_seq', type: 'function',
          function: {
            name: 'apply_edits',
            arguments: JSON.stringify({
              version: 'rwa-edit/1',
              edits: [
                { find: 'changed-outside', replace: 'BRIDGE_TOKEN' },
                { find: 'BRIDGE_TOKEN', replace: 'FINAL_DESTINATION' },
              ],
            }),
          },
        }],
      },
    }],
  }),
});

await window.modify('sequential dependent edits');
await new Promise(r => setTimeout(r, 100));
const docAfter17b = await window.getDoc();
check('sequential edits: final state has FINAL_DESTINATION', docAfter17b.includes('FINAL_DESTINATION'));
check('sequential edits: intermediate BRIDGE_TOKEN consumed', !docAfter17b.includes('BRIDGE_TOKEN'));
check('sequential edits: original anchor consumed', !docAfter17b.includes('changed-outside'));

// Tests 18-21: pin down remaining validator error-code paths. Each test
// drives one malformed envelope through modify(), exhausts the 3-attempt
// retry budget (since the stub returns the same broken response each time),
// and asserts the doc stays byte-identical. A refactor that drops any of
// these checks would silently let the model's bad output slip through.

console.log('\n== Test 18: version_unsupported ==');
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'call_v', type: 'function', function: {
        name: 'apply_edits',
        arguments: JSON.stringify({ version: 'rwa-edit/99', edits: [{ find: 'FINAL_DESTINATION', replace: 'X' }] }),
      } }],
    } }],
  }),
});
const docBefore18 = await window.getDoc();
await window.modify('wrong protocol version');
await new Promise(r => setTimeout(r, 200));
check('version_unsupported: doc unchanged', (await window.getDoc()) === docBefore18);

console.log('\n== Test 19: unknown_tool ==');
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'call_u', type: 'function', function: {
        name: 'magic_rewrite',
        arguments: JSON.stringify({ version: 'rwa-edit/1' }),
      } }],
    } }],
  }),
});
const docBefore19 = await window.getDoc();
await window.modify('unknown tool name');
await new Promise(r => setTimeout(r, 200));
check('unknown_tool: doc unchanged', (await window.getDoc()) === docBefore19);

console.log('\n== Test 20: find_not_found ==');
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'call_nf', type: 'function', function: {
        name: 'apply_edits',
        arguments: JSON.stringify({ version: 'rwa-edit/1', edits: [{ find: 'absolutely_not_in_the_doc_xyz123', replace: 'X' }] }),
      } }],
    } }],
  }),
});
const docBefore20 = await window.getDoc();
await window.modify('anchor missing');
await new Promise(r => setTimeout(r, 200));
check('find_not_found: doc unchanged', (await window.getDoc()) === docBefore20);

console.log('\n== Test 21: empty_find ==');
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'call_ef', type: 'function', function: {
        name: 'apply_edits',
        arguments: JSON.stringify({ version: 'rwa-edit/1', edits: [{ find: '', replace: 'whatever' }] }),
      } }],
    } }],
  }),
});
const docBefore21 = await window.getDoc();
await window.modify('empty find anchor');
await new Promise(r => setTimeout(r, 200));
check('empty_find: doc unchanged', (await window.getDoc()) === docBefore21);

// Tests 22-24: size cap + replace_document envelope-shape rejection.
// MAX_REPLACE caps a single replace string at 8 KiB to bound damage from a
// runaway model. replace_document requires a non-empty reason and a string
// doc — both protect against accidental wholesale rewrites.

console.log('\n== Test 22: replace_too_large ==');
const HUGE_REPLACE = 'X'.repeat(8 * 1024 + 1);
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'call_huge', type: 'function', function: {
        name: 'apply_edits',
        arguments: JSON.stringify({ version: 'rwa-edit/1', edits: [{ find: 'FINAL_DESTINATION', replace: HUGE_REPLACE }] }),
      } }],
    } }],
  }),
});
const docBefore22 = await window.getDoc();
await window.modify('oversized replace string');
await new Promise(r => setTimeout(r, 200));
check('replace_too_large: doc unchanged', (await window.getDoc()) === docBefore22);

console.log('\n== Test 23: replace_document with empty reason rejected ==');
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'call_er', type: 'function', function: {
        name: 'replace_document',
        arguments: JSON.stringify({ version: 'rwa-edit/1', doc: '<div>x</div>', reason: '' }),
      } }],
    } }],
  }),
});
const docBefore23 = await window.getDoc();
await window.modify('replace_document with empty reason');
await new Promise(r => setTimeout(r, 200));
check('replace_document empty reason: doc unchanged', (await window.getDoc()) === docBefore23);

console.log('\n== Test 24: replace_document with missing doc rejected ==');
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'call_md', type: 'function', function: {
        name: 'replace_document',
        arguments: JSON.stringify({ version: 'rwa-edit/1', reason: 'no doc field' }),
      } }],
    } }],
  }),
});
const docBefore24 = await window.getDoc();
await window.modify('replace_document with missing doc');
await new Promise(r => setTimeout(r, 200));
check('replace_document missing doc: doc unchanged', (await window.getDoc()) === docBefore24);

// Tests 25-30: reserved-marker rejection in apply_edits replace strings.
// Test 3 covers data-rwa-frozen specifically; this expands to all six reserved
// substring forms the runtime guards (frozen-zone keyword pair + 3 comment
// prefixes + the data-* attribute). Adding a new comment form to the doc
// schema without updating RWA_EDIT.RESERVED would silently allow the model
// to inject reserved markers — these tests pin the current invariant down.
console.log('\n== Tests 25-30: reserved-marker rejection in replace ==');
const RESERVED_SAMPLES = [
  ['rwa:frozen:begin', 'rwa:frozen:begin theme'],
  ['rwa:frozen:end',   'rwa:frozen:end theme'],
  ['<!-- rwa:',        '<!-- rwa:custom -->'],
  ['/* rwa:',          '/* rwa:custom */'],
  ['// rwa:',          '// rwa:custom\n'],
  ['data-rwa-frozen',  'data-rwa-frozen="x"'],
];

for (const [label, payload] of RESERVED_SAMPLES) {
  fetchHandler = async () => ({
    ok: true, json: async () => ({
      choices: [{ message: {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'rsv_' + label.slice(0, 6), type: 'function', function: {
          name: 'apply_edits',
          arguments: JSON.stringify({
            version: 'rwa-edit/1',
            edits: [{ find: 'FINAL_DESTINATION', replace: payload }],
          }),
        } }],
      } }],
    }),
  });
  const before = await window.getDoc();
  await window.modify('reserved marker in replace: ' + label);
  await new Promise(r => setTimeout(r, 200));
  check('reserved marker rejected in replace: ' + label, (await window.getDoc()) === before);
}

// Tests 31-36: same reserved-marker rejection but on the find side. The model
// might try to anchor on a frozen-zone marker to splice content right next to
// it; the runtime must refuse so authors keep exclusive control of those
// substrings. Mirrors Tests 25-30.
console.log('\n== Tests 31-36: reserved-marker rejection in find ==');
for (const [label, payload] of RESERVED_SAMPLES) {
  fetchHandler = async () => ({
    ok: true, json: async () => ({
      choices: [{ message: {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'rfn_' + label.slice(0, 6), type: 'function', function: {
          name: 'apply_edits',
          arguments: JSON.stringify({
            version: 'rwa-edit/1',
            edits: [{ find: payload, replace: 'X' }],
          }),
        } }],
      } }],
    }),
  });
  const before = await window.getDoc();
  await window.modify('reserved marker in find: ' + label);
  await new Promise(r => setTimeout(r, 200));
  check('reserved marker rejected in find: ' + label, (await window.getDoc()) === before);
}

// Test 37: end-to-end byte-fidelity. Install a doc with multiple segments
// (text, unicode, emoji, exotic whitespace), apply a uniquely-anchored edit,
// and assert byte-equality with a hand-constructed expected string. This is
// the most direct possible test of "edits don't change unintended bytes" —
// any drift in the splice arithmetic, canonLF order, surrogate pair handling,
// or trailing-newline preservation would surface here.
console.log('\n== Test 37: end-to-end byte-fidelity (multi-segment + unicode) ==');
const fidelitySeed =
  '<p data-id="alpha">Alpha — Α — \u{1F600}</p>\n' +
  '<p data-id="beta">Beta · Β · \u{1F4A1}</p>\n' +
  '<p data-id="gamma">Gamma Γ \u{1F525}</p>\n' +
  '<!-- trailing comment with   LSEP -->\n';
await new Promise((res, rej) => {
  window.openDB().then(db => {
    const r = db.transaction('rwa_doc', 'readwrite').objectStore('rwa_doc').put(fidelitySeed, 'self');
    r.onsuccess = res;
    r.onerror = () => rej(r.error);
  });
});

const newBeta = '<p data-id="beta">Beta · Β · \u{1F4A1} (rewritten)</p>';
const expectedAfter37 =
  '<p data-id="alpha">Alpha — Α — \u{1F600}</p>\n' +
  newBeta + '\n' +
  '<p data-id="gamma">Gamma Γ \u{1F525}</p>\n' +
  '<!-- trailing comment with   LSEP -->\n';

fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'call_byte', type: 'function', function: {
        name: 'apply_edits',
        arguments: JSON.stringify({
          version: 'rwa-edit/1',
          edits: [{ find: '<p data-id="beta">Beta · Β · \u{1F4A1}</p>', replace: newBeta }],
        }),
      } }],
    } }],
  }),
});

await window.modify('rewrite beta paragraph');
await new Promise(r => setTimeout(r, 100));
const docAfter37 = await window.getDoc();
check('byte-fidelity: full doc equals expected exactly', docAfter37 === expectedAfter37);
check('byte-fidelity: alpha paragraph (incl. emoji) byte-identical', docAfter37.startsWith('<p data-id="alpha">Alpha — Α — \u{1F600}</p>\n'));
check('byte-fidelity: gamma paragraph (incl. NBSP+emoji) preserved verbatim', docAfter37.includes('<p data-id="gamma">Gamma Γ \u{1F525}</p>'));
check('byte-fidelity: trailing comment with U+2028 preserved', docAfter37.endsWith('<!-- trailing comment with   LSEP -->\n'));
check('byte-fidelity: replacement inserted verbatim', docAfter37.includes(newBeta));

// Tests 38a-e: undo() correctness on the success path. Test 1 only verified
// the undo stack accumulates entries; test 10 only verified undo() bails
// during in-flight ⌘K. Neither exercised the actual restoration semantics:
// after popping, the doc must equal the prior state byte-for-byte.
console.log('\n== Tests 38a-e: undo() restoration semantics ==');

// Clear undo stack to isolate from the dozens of prior modifies that
// stacked entries during tests 1-37.
await new Promise((res, rej) => {
  window.openDB().then(db => {
    const r = db.transaction('rwa_undo', 'readwrite').objectStore('rwa_undo').put([], 'self');
    r.onsuccess = res;
    r.onerror = () => rej(r.error);
  });
});

// 38a: undo on empty stack is a no-op (doc unchanged, no throw).
const doc38a = await window.getDoc();
await window.undo();
await new Promise(r => setTimeout(r, 50));
check('38a: undo on empty stack leaves doc byte-identical', (await window.getDoc()) === doc38a);

// 38b/c: a fresh modify then undo restores doc byte-equally.
const checkpoint38 = await window.getDoc();
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'call_u_b', type: 'function', function: {
        name: 'apply_edits',
        arguments: JSON.stringify({ version: 'rwa-edit/1',
          edits: [{ find: newBeta, replace: '<p data-id="beta">UNDO_38_TARGET</p>' }] }),
      } }],
    } }],
  }),
});
await window.modify('install undo target');
await new Promise(r => setTimeout(r, 100));
check('38b: modify took effect (UNDO_38_TARGET present)', (await window.getDoc()).includes('UNDO_38_TARGET'));

await window.undo();
await new Promise(r => setTimeout(r, 50));
const afterUndo38 = await window.getDoc();
check('38c: undo restored doc byte-equally to checkpoint', afterUndo38 === checkpoint38);
check('38c: undo target removed', !afterUndo38.includes('UNDO_38_TARGET'));

// 38d/e: stack is empty after the single undo; second undo is also a no-op.
const undoStackAfter = await new Promise((res, rej) => {
  window.openDB().then(db => {
    const r = db.transaction('rwa_undo').objectStore('rwa_undo').get('self');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
});
check('38d: undo stack drained to empty after pop', Array.isArray(undoStackAfter) && undoStackAfter.length === 0);

const doc38e = await window.getDoc();
await window.undo();
await new Promise(r => setTimeout(r, 50));
check('38e: second undo on now-empty stack is also a no-op', (await window.getDoc()) === doc38e);

// Tests 39a-c: frozen-zone enforcement across all three marker forms.
// Tests 15-16 cover the CSS form only. extractFrozenZones() also handles
// HTML <!-- --> and JS // forms; this exercises both reject-inside and
// allow-outside semantics for each, so a regression in any single form's
// regex would surface.
console.log('\n== Tests 39a-c: frozen-zone enforcement across HTML/CSS/JS forms ==');

const FZ_VARIANTS = [
  {
    tag: 'HTML',
    seed: '<div>before</div>\n<!-- rwa:frozen:begin htmlzone -->\nHTML_FROZEN_BODY\n<!-- rwa:frozen:end htmlzone -->\n<div>tail-html</div>',
    insideFind: 'HTML_FROZEN_BODY',
    insideReplace: 'HTML_MUTATED',
    outsideFind: 'tail-html',
    outsideReplace: 'tail-html-CHANGED',
  },
  {
    tag: 'CSS',
    seed: '<style>\n/* rwa:frozen:begin csszone */\n:root { --css-knob: 1; }\n/* rwa:frozen:end csszone */\n</style>\n<div>tail-css</div>',
    insideFind: '--css-knob: 1',
    insideReplace: '--css-knob: 999',
    outsideFind: 'tail-css',
    outsideReplace: 'tail-css-CHANGED',
  },
  {
    tag: 'JS',
    seed: '<script>\n// rwa:frozen:begin jszone\nconst JS_FROZEN_KNOB = 1;\n// rwa:frozen:end jszone\n</script>\n<div>tail-js</div>',
    insideFind: 'JS_FROZEN_KNOB = 1',
    insideReplace: 'JS_FROZEN_KNOB = 999',
    outsideFind: 'tail-js',
    outsideReplace: 'tail-js-CHANGED',
  },
];

const seedDoc = (s) => new Promise((res, rej) => {
  window.openDB().then(db => {
    const r = db.transaction('rwa_doc', 'readwrite').objectStore('rwa_doc').put(s, 'self');
    r.onsuccess = res;
    r.onerror = () => rej(r.error);
  });
});

for (const v of FZ_VARIANTS) {
  // (a) edit inside zone -> rejected
  await seedDoc(v.seed);
  fetchHandler = async () => ({
    ok: true, json: async () => ({
      choices: [{ message: {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'fzin_' + v.tag, type: 'function', function: {
          name: 'apply_edits',
          arguments: JSON.stringify({ version: 'rwa-edit/1',
            edits: [{ find: v.insideFind, replace: v.insideReplace }] }),
        } }],
      } }],
    }),
  });
  const docInBefore = await window.getDoc();
  await window.modify('mutate inside ' + v.tag + ' frozen zone');
  await new Promise(r => setTimeout(r, 200));
  check(v.tag + ' frozen-zone form: edit inside zone rejected', (await window.getDoc()) === docInBefore);

  // (b) edit outside zone -> allowed; zone inner preserved
  await seedDoc(v.seed);
  fetchHandler = async () => ({
    ok: true, json: async () => ({
      choices: [{ message: {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'fzout_' + v.tag, type: 'function', function: {
          name: 'apply_edits',
          arguments: JSON.stringify({ version: 'rwa-edit/1',
            edits: [{ find: v.outsideFind, replace: v.outsideReplace }] }),
        } }],
      } }],
    }),
  });
  await window.modify('mutate outside ' + v.tag + ' frozen zone');
  await new Promise(r => setTimeout(r, 100));
  const docOutAfter = await window.getDoc();
  check(v.tag + ' frozen-zone form: edit outside zone allowed', docOutAfter.includes(v.outsideReplace));
  check(v.tag + ' frozen-zone form: zone inner preserved across allowed edit', docOutAfter.includes(v.insideFind));
}

// Tests 40a-c: structural-shape invariant. Test 4 covers the added <script>
// case; here we cover the symmetric cases — added <style>, removed <script>,
// removed <style>. Any of these would let the model surreptitiously
// restructure the script/style boundary, which the rwa-edit/1 spec forbids.
console.log('\n== Tests 40a-c: structural-shape invariant additions/removals ==');

// 40a: adding a <style> via apply_edits is rejected.
await seedDoc('<div>shape-anchor-add-style</div>');
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'sh_a', type: 'function', function: {
        name: 'apply_edits',
        arguments: JSON.stringify({ version: 'rwa-edit/1',
          edits: [{ find: 'shape-anchor-add-style', replace: 'shape<style>.x{color:red}</style>' }] }),
      } }],
    } }],
  }),
});
const before40a = await window.getDoc();
await window.modify('add a style tag via apply_edits');
await new Promise(r => setTimeout(r, 200));
check('40a: added <style> via apply_edits rejected', (await window.getDoc()) === before40a);

// 40b: removing a <script> via apply_edits is rejected.
await seedDoc('<div>SHAPE_KEEP_B</div>\n<script>const X=1;</script>\n<div>tail-b</div>');
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'sh_b', type: 'function', function: {
        name: 'apply_edits',
        arguments: JSON.stringify({ version: 'rwa-edit/1',
          edits: [{ find: '<script>const X=1;</script>\n', replace: '' }] }),
      } }],
    } }],
  }),
});
const before40b = await window.getDoc();
await window.modify('remove a script tag via apply_edits');
await new Promise(r => setTimeout(r, 200));
check('40b: removed <script> via apply_edits rejected', (await window.getDoc()) === before40b);

// 40c: removing a <style> via apply_edits is rejected.
await seedDoc('<style>.s{color:red}</style>\n<div>shape-keep-c</div>');
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'sh_c', type: 'function', function: {
        name: 'apply_edits',
        arguments: JSON.stringify({ version: 'rwa-edit/1',
          edits: [{ find: '<style>.s{color:red}</style>\n', replace: '' }] }),
      } }],
    } }],
  }),
});
const before40c = await window.getDoc();
await window.modify('remove a style tag via apply_edits');
await new Promise(r => setTimeout(r, 200));
check('40c: removed <style> via apply_edits rejected', (await window.getDoc()) === before40c);

// Tests 41a-c: modify() preconditions. Each verifies that a precondition
// failure leaves the doc byte-identical and (where relevant) makes no API
// call. These are the early-exit safety nets that prevent silent rewrites.
console.log('\n== Tests 41a-c: modify() preconditions ==');

// 41a: missing API key — bail before any fetch.
const savedKey41 = window.sessionStorage.getItem('rwa_apikey');
window.sessionStorage.removeItem('rwa_apikey');
let fetchCalled41a = false;
fetchHandler = async () => { fetchCalled41a = true; throw new Error('unreachable'); };
const before41a = await window.getDoc();
await window.modify('without api key');
await new Promise(r => setTimeout(r, 50));
check('41a: modify without api key leaves doc unchanged', (await window.getDoc()) === before41a);
check('41a: modify without api key issues no fetch', fetchCalled41a === false);
window.sessionStorage.setItem('rwa_apikey', savedKey41 || 'test-key');

// 41b: modify-while-modify-in-flight — mutex rejects the second call cleanly.
let inFlightResolve41 = null;
let inFlightFetches41 = 0;
fetchHandler = () => { inFlightFetches41++; return new Promise(r => { inFlightResolve41 = r; }); };
const m1_41 = window.modify('first slow modify');
await new Promise(r => setTimeout(r, 30));
await window.modify('second concurrent modify');
check('41b: concurrent modify rejected — only the first fetch issued', inFlightFetches41 === 1);
// Release first cleanly: model returns a text-only "decline" so no commit happens.
inFlightResolve41({
  ok: true, json: async () => ({
    choices: [{ message: { role: 'assistant', content: 'never mind' } }],
  }),
});
await m1_41;

// 41c: HTTP error from upstream — doc unchanged, no commit.
fetchHandler = async () => ({
  ok: false, statusText: 'Bad Gateway',
  json: async () => ({ error: { message: 'upstream blew up' } }),
});
const before41c = await window.getDoc();
await window.modify('upstream http error');
await new Promise(r => setTimeout(r, 50));
check('41c: upstream HTTP error leaves doc unchanged', (await window.getDoc()) === before41c);

// Test 42: rwa_hist edit_batch record shape. Test 8 only verifies the kind
// field is present; this verifies the stored envelope is still readable so
// downstream tooling (a future "show me what the model did" UI) gets faithful
// audit trail data.
console.log('\n== Test 42: hist record content for edit_batch ==');
await seedDoc('<div>HIST_TEST_ANCHOR_42</div>');
const envelope42 = {
  version: 'rwa-edit/1',
  edits: [{ find: 'HIST_TEST_ANCHOR_42', replace: 'HIST_TEST_REPLACED_42' }],
};
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'call_hist42', type: 'function', function: {
        name: 'apply_edits',
        arguments: JSON.stringify(envelope42),
      } }],
    } }],
  }),
});
await window.modify('hist record check');
await new Promise(r => setTimeout(r, 100));

const hist42 = await new Promise((res, rej) => {
  window.openDB().then(db => {
    const r = db.transaction('rwa_hist').objectStore('rwa_hist').get('self');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
});
check('42: hist newest record kind=edit_batch', hist42[0]?.kind === 'edit_batch');
check('42: hist newest record envelope preserved (version)', hist42[0]?.envelope?.version === 'rwa-edit/1');
check('42: hist newest record envelope preserved (find)', hist42[0]?.envelope?.edits?.[0]?.find === 'HIST_TEST_ANCHOR_42');
check('42: hist newest record envelope preserved (replace)', hist42[0]?.envelope?.edits?.[0]?.replace === 'HIST_TEST_REPLACED_42');
check('42: hist newest record has numeric timestamp', typeof hist42[0]?.ts === 'number' && hist42[0].ts > 0);

// Tests 43a-c: malformed_envelope shapes beyond the JSON-parse path in test 6.
console.log('\n== Tests 43a-c: malformed_envelope shape variants ==');

// 43a: edits is not an array (object instead).
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'me_a', type: 'function', function: {
        name: 'apply_edits',
        arguments: JSON.stringify({ version: 'rwa-edit/1', edits: { wrong: 'shape' } }),
      } }],
    } }],
  }),
});
const before43a = await window.getDoc();
await window.modify('edits as object');
await new Promise(r => setTimeout(r, 200));
check('43a: edits-as-object rejected', (await window.getDoc()) === before43a);

// 43b: edits is an empty array.
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'me_b', type: 'function', function: {
        name: 'apply_edits',
        arguments: JSON.stringify({ version: 'rwa-edit/1', edits: [] }),
      } }],
    } }],
  }),
});
const before43b = await window.getDoc();
await window.modify('edits empty');
await new Promise(r => setTimeout(r, 200));
check('43b: empty edits array rejected', (await window.getDoc()) === before43b);

// 43c: envelope missing version field entirely.
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'me_c', type: 'function', function: {
        name: 'apply_edits',
        arguments: JSON.stringify({ edits: [{ find: 'X', replace: 'Y' }] }),
      } }],
    } }],
  }),
});
const before43c = await window.getDoc();
await window.modify('no version field');
await new Promise(r => setTimeout(r, 200));
check('43c: missing version rejected', (await window.getDoc()) === before43c);

// Tests 44a-d: replace_document frozen-zone preservation. Test 9 only covers
// "introducing a new frozen zone is rejected"; here we close the matrix —
// removal, rename, inner mutation, and the byte-equal preservation success
// path. Frozen zones are author-declared invariants — every mutation path
// other than identity must be rejected.
console.log('\n== Tests 44a-d: replace_document frozen-zone preservation ==');

const seed44 = '<style>\n/* rwa:frozen:begin themex */\n:root { --x: 1; }\n/* rwa:frozen:end themex */\n</style>\n<div>seed-44</div>';

// 44a: replace_document removing the existing frozen zone -> rejected.
await seedDoc(seed44);
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'rd44a', type: 'function', function: {
        name: 'replace_document',
        arguments: JSON.stringify({ version: 'rwa-edit/1', doc: '<div>no zone</div>', reason: 'remove zone' }),
      } }],
    } }],
  }),
});
const before44a = await window.getDoc();
await window.modify('remove existing frozen zone');
await new Promise(r => setTimeout(r, 200));
check('44a: replace_document removing zone rejected', (await window.getDoc()) === before44a);

// 44b: replace_document renaming the zone -> rejected (name set differs).
await seedDoc(seed44);
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'rd44b', type: 'function', function: {
        name: 'replace_document',
        arguments: JSON.stringify({ version: 'rwa-edit/1', doc: '<style>\n/* rwa:frozen:begin renamed */\n:root { --x: 1; }\n/* rwa:frozen:end renamed */\n</style>\n<div>x</div>', reason: 'rename zone' }),
      } }],
    } }],
  }),
});
const before44b = await window.getDoc();
await window.modify('rename frozen zone');
await new Promise(r => setTimeout(r, 200));
check('44b: replace_document renaming zone rejected', (await window.getDoc()) === before44b);

// 44c: replace_document mutating zone inner content -> rejected.
await seedDoc(seed44);
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'rd44c', type: 'function', function: {
        name: 'replace_document',
        arguments: JSON.stringify({ version: 'rwa-edit/1', doc: '<style>\n/* rwa:frozen:begin themex */\n:root { --x: 999; }\n/* rwa:frozen:end themex */\n</style>\n<div>y</div>', reason: 'mutate inner' }),
      } }],
    } }],
  }),
});
const before44c = await window.getDoc();
await window.modify('mutate inner of frozen zone');
await new Promise(r => setTimeout(r, 200));
check('44c: replace_document mutating zone inner rejected', (await window.getDoc()) === before44c);

// 44d: replace_document with byte-equal zone preservation -> allowed; outside-zone content updated.
await seedDoc(seed44);
const newDoc44d = '<style>\n/* rwa:frozen:begin themex */\n:root { --x: 1; }\n/* rwa:frozen:end themex */\n</style>\n<div>OK_44D_TAIL</div>';
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'rd44d', type: 'function', function: {
        name: 'replace_document',
        arguments: JSON.stringify({ version: 'rwa-edit/1', doc: newDoc44d, reason: 'preserve zone, replace tail' }),
      } }],
    } }],
  }),
});
await window.modify('preserve zone, replace tail');
await new Promise(r => setTimeout(r, 100));
check('44d: replace_document with preserved zone allowed', (await window.getDoc()) === newDoc44d);

// Tests 45a-c: data-rwa-frozen element-level preservation. The reserved-marker
// check rejects literal "data-rwa-frozen" in find/replace, but the
// element-snapshot check is what catches an edit whose anchor lands inside
// a data-rwa-frozen element via inner content. These tests exercise that
// post-apply snapshot diff.
console.log('\n== Tests 45a-c: data-rwa-frozen element preservation ==');

const seed45 = '<div data-rwa-frozen>FROZEN_ELEMENT_INNER</div>\n<div>outside-frozen-elem</div>';

// 45a: edit anchored on inner content of frozen element -> rejected.
await seedDoc(seed45);
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'fe45_a', type: 'function', function: {
        name: 'apply_edits',
        arguments: JSON.stringify({ version: 'rwa-edit/1',
          edits: [{ find: 'FROZEN_ELEMENT_INNER', replace: 'TAMPERED_INNER' }] }),
      } }],
    } }],
  }),
});
const before45a = await window.getDoc();
await window.modify('mutate inside data-rwa-frozen element');
await new Promise(r => setTimeout(r, 200));
check('45a: apply_edits inside data-rwa-frozen element rejected', (await window.getDoc()) === before45a);

// 45b: edit outside frozen element allowed; element preserved verbatim.
await seedDoc(seed45);
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'fe45_b', type: 'function', function: {
        name: 'apply_edits',
        arguments: JSON.stringify({ version: 'rwa-edit/1',
          edits: [{ find: 'outside-frozen-elem', replace: 'CHANGED_OUTSIDE_ELEM' }] }),
      } }],
    } }],
  }),
});
await window.modify('mutate outside data-rwa-frozen element');
await new Promise(r => setTimeout(r, 100));
const docAfter45b = await window.getDoc();
check('45b: apply_edits outside data-rwa-frozen element allowed', docAfter45b.includes('CHANGED_OUTSIDE_ELEM'));
check('45b: frozen element preserved verbatim', docAfter45b.includes('<div data-rwa-frozen>FROZEN_ELEMENT_INNER</div>'));

// Test 46: UNDO_CAP — undo stack capped at 10 entries; oldest dropped after >10 modifies.
console.log('\n== Test 46: UNDO_CAP behavior ==');
await seedDoc('<div>UNDO_CAP_SEED</div>');
await new Promise((res, rej) => {
  window.openDB().then(db => {
    const r = db.transaction('rwa_undo', 'readwrite').objectStore('rwa_undo').put([], 'self');
    r.onsuccess = res;
    r.onerror = () => rej(r.error);
  });
});

for (let i = 0; i < 12; i++) {
  const findText = i === 0 ? 'UNDO_CAP_SEED' : `STEP_${i}`;
  const replaceText = `STEP_${i+1}`;
  fetchHandler = async () => ({
    ok: true, json: async () => ({
      choices: [{ message: {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'cap_' + i, type: 'function', function: {
          name: 'apply_edits',
          arguments: JSON.stringify({ version: 'rwa-edit/1',
            edits: [{ find: findText, replace: replaceText }] }),
        } }],
      } }],
    }),
  });
  await window.modify('cap step ' + i);
  await new Promise(r => setTimeout(r, 50));
}

const undoFinal = await new Promise((res, rej) => {
  window.openDB().then(db => {
    const r = db.transaction('rwa_undo').objectStore('rwa_undo').get('self');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
});
check('46: undo stack capped at UNDO_CAP=10 after 12 successful modifies', Array.isArray(undoFinal) && undoFinal.length === 10);
check('46: oldest entries dropped (no UNDO_CAP_SEED in stack)', !undoFinal.some(d => d.includes('UNDO_CAP_SEED')));

// Test 47: HIST_CAP behavior — newest-first, capped at 15.
console.log('\n== Test 47: HIST_CAP behavior ==');
await seedDoc('<div>HIST_CAP_SEED</div>');
await new Promise((res, rej) => {
  window.openDB().then(db => {
    const r = db.transaction('rwa_hist', 'readwrite').objectStore('rwa_hist').put([], 'self');
    r.onsuccess = res;
    r.onerror = () => rej(r.error);
  });
});

for (let i = 0; i < 17; i++) {
  const findText = i === 0 ? 'HIST_CAP_SEED' : `HSTEP_${i}`;
  const replaceText = `HSTEP_${i+1}`;
  fetchHandler = async () => ({
    ok: true, json: async () => ({
      choices: [{ message: {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'hcap_' + i, type: 'function', function: {
          name: 'apply_edits',
          arguments: JSON.stringify({ version: 'rwa-edit/1',
            edits: [{ find: findText, replace: replaceText }] }),
        } }],
      } }],
    }),
  });
  await window.modify('hist step ' + i);
  await new Promise(r => setTimeout(r, 50));
}

const histFinal = await new Promise((res, rej) => {
  window.openDB().then(db => {
    const r = db.transaction('rwa_hist').objectStore('rwa_hist').get('self');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
});
check('47: hist capped at HIST_CAP=15 after 17 successful modifies', Array.isArray(histFinal) && histFinal.length === 15);

// Test 48: CRLF in find/replace canonicalized to LF before splice.
// The runtime stores docs as LF-canonical; model output may emit CRLF.
// Both sides are canonLF'd so the match still works and the stored doc
// stays LF-only — preserving the spec's normalization invariant.
console.log('\n== Test 48: CRLF in find/replace canonicalized ==');
await seedDoc('<p>line1</p>\n<p>CRLF_TEST_ANCHOR</p>\n<p>line3</p>');
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'crlf', type: 'function', function: {
        name: 'apply_edits',
        arguments: JSON.stringify({ version: 'rwa-edit/1',
          edits: [{ find: '<p>CRLF_TEST_ANCHOR</p>', replace: '<p>line2a</p>\r\n<p>line2b</p>' }] }),
      } }],
    } }],
  }),
});
await window.modify('crlf in replace');
await new Promise(r => setTimeout(r, 100));
const docCrlf = await window.getDoc();
check('48: edit with CRLF in replace succeeded', docCrlf.includes('<p>line2a</p>') && docCrlf.includes('<p>line2b</p>'));
check('48: stored doc is LF-only (no CR characters)', !docCrlf.includes('\r'));

// Test 49: replace_document is intentionally allowed to change script/style count.
// apply_edits enforces shape invariance, but replace_document is the escape
// hatch where shape may legitimately change. Pin this down so a future
// tightening doesn't accidentally apply the shape check to replace_document.
console.log('\n== Test 49: replace_document may change script/style count ==');
await seedDoc('<div>plain-49</div>');
const newDoc49 = '<style>.k{}</style>\n<script>const Y=1;</script>\n<div>after-rd-shape</div>';
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'rd49', type: 'function', function: {
        name: 'replace_document',
        arguments: JSON.stringify({ version: 'rwa-edit/1', doc: newDoc49, reason: 'add scaffolding' }),
      } }],
    } }],
  }),
});
await window.modify('replace_document scaffolding');
await new Promise(r => setTimeout(r, 100));
check('49: replace_document changing script/style count allowed', (await window.getDoc()) === newDoc49);

// Tests 50a-d: replace_document data-rwa-frozen element preservation matrix.
// Tests 45a-c cover the apply_edits side. The snapshot-equality check also
// guards replace_document. These four cover removal, inner mutation,
// addition, and the success case.
console.log('\n== Tests 50a-d: replace_document data-rwa-frozen preservation ==');

const seed50 = '<div data-rwa-frozen>FE_BODY</div>\n<div>tail-50</div>';

// 50a: remove the frozen element entirely -> rejected.
await seedDoc(seed50);
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'rd50_a', type: 'function', function: {
        name: 'replace_document',
        arguments: JSON.stringify({ version: 'rwa-edit/1', doc: '<div>just tail</div>', reason: 'remove frozen elem' }),
      } }],
    } }],
  }),
});
const before50a = await window.getDoc();
await window.modify('remove frozen elem via rd');
await new Promise(r => setTimeout(r, 200));
check('50a: removing data-rwa-frozen element via rd rejected', (await window.getDoc()) === before50a);

// 50b: mutate inner content of the frozen element -> rejected (outerHTML differs).
await seedDoc(seed50);
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'rd50_b', type: 'function', function: {
        name: 'replace_document',
        arguments: JSON.stringify({ version: 'rwa-edit/1', doc: '<div data-rwa-frozen>NEW_FE_BODY</div>\n<div>tail-50</div>', reason: 'mutate inner' }),
      } }],
    } }],
  }),
});
const before50b = await window.getDoc();
await window.modify('mutate frozen elem inner');
await new Promise(r => setTimeout(r, 200));
check('50b: mutating data-rwa-frozen inner via rd rejected', (await window.getDoc()) === before50b);

// 50c: introduce a NEW data-rwa-frozen element alongside the existing one -> rejected.
await seedDoc(seed50);
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'rd50_c', type: 'function', function: {
        name: 'replace_document',
        arguments: JSON.stringify({ version: 'rwa-edit/1', doc: '<div data-rwa-frozen>FE_BODY</div>\n<span data-rwa-frozen>NEW_FE</span>\n<div>tail-50</div>', reason: 'inject frozen elem' }),
      } }],
    } }],
  }),
});
const before50c = await window.getDoc();
await window.modify('inject another frozen elem');
await new Promise(r => setTimeout(r, 200));
check('50c: introducing additional data-rwa-frozen element via rd rejected', (await window.getDoc()) === before50c);

// 50d: preserve frozen element verbatim, change surrounding content -> allowed.
await seedDoc(seed50);
const newDoc50d = '<div data-rwa-frozen>FE_BODY</div>\n<div>NEW_TAIL_50D</div>';
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'rd50_d', type: 'function', function: {
        name: 'replace_document',
        arguments: JSON.stringify({ version: 'rwa-edit/1', doc: newDoc50d, reason: 'change tail only' }),
      } }],
    } }],
  }),
});
await window.modify('change tail, preserve frozen elem');
await new Promise(r => setTimeout(r, 100));
check('50d: replace_document preserving frozen elem allowed', (await window.getDoc()) === newDoc50d);

// Tests 51a-b: case-bypass defenses. The byte-level containsReservedMarker
// check is case-sensitive, but HTML normalizes attribute names to lowercase
// at parse time. So an upper-case "DATA-RWA-FROZEN" or "ID=" attribute slips
// past the marker check, then must be caught by the post-parse snapshot
// (frozen_zone_corrupted) or findReservedIdViolation. These tests verify the
// depth-of-defense holds.
console.log('\n== Tests 51a-b: case-bypass defense ==');

await seedDoc('<div data-rwa-frozen>FE_BODY</div>\n<div>BYPASS_ANCHOR</div>');

// 51a: uppercase DATA-RWA-FROZEN injection caught by snapshot count.
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'bp_a', type: 'function', function: {
        name: 'apply_edits',
        arguments: JSON.stringify({ version: 'rwa-edit/1',
          edits: [{ find: 'BYPASS_ANCHOR', replace: '<span DATA-RWA-FROZEN>injected</span>' }] }),
      } }],
    } }],
  }),
});
const before51a = await window.getDoc();
await window.modify('uppercase data-rwa-frozen bypass');
await new Promise(r => setTimeout(r, 200));
check('51a: uppercase DATA-RWA-FROZEN injection rejected by snapshot', (await window.getDoc()) === before51a);

// 51b: uppercase ID="rwa-doc-mount" caught by findReservedIdViolation.
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'bp_b', type: 'function', function: {
        name: 'apply_edits',
        arguments: JSON.stringify({ version: 'rwa-edit/1',
          edits: [{ find: 'BYPASS_ANCHOR', replace: '<span ID="rwa-doc-mount">x</span>' }] }),
      } }],
    } }],
  }),
});
const before51b = await window.getDoc();
await window.modify('uppercase ID mount-shadow bypass');
await new Promise(r => setTimeout(r, 200));
check('51b: uppercase ID="rwa-doc-mount" rejected by findReservedIdViolation', (await window.getDoc()) === before51b);

// Tests 52a-b: tool_call shape edge cases.
console.log('\n== Tests 52a-b: tool_call shape edge cases ==');

// 52a: tool_call with missing function field — runtime treats as unknown_tool
// (tc.function?.name is undefined, falls through to the else branch).
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'tc_a', type: 'function' }],
    } }],
  }),
});
const before52a = await window.getDoc();
await window.modify('missing function field');
await new Promise(r => setTimeout(r, 200));
check('52a: tool_call with missing function field rejected', (await window.getDoc()) === before52a);

// 52b: tool_call with whitespace-only arguments — JSON.parse throws,
// runtime catches and emits malformed_envelope.
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'tc_b', type: 'function', function: {
        name: 'apply_edits',
        arguments: '   ',
      } }],
    } }],
  }),
});
const before52b = await window.getDoc();
await window.modify('whitespace-only arguments');
await new Promise(r => setTimeout(r, 200));
check('52b: tool_call with whitespace-only arguments rejected', (await window.getDoc()) === before52b);

// Test 53: popUndo atomicity. Two concurrent undo() calls must each pop a
// distinct entry — without the atomic read+write inside popUndo(), both
// would observe the same stack snapshot and double-pop the same entry,
// leaving one entry orphaned. Regression for the "rapid ⌘Z" bug noted in
// popUndo()'s comment.
console.log('\n== Test 53: popUndo atomicity (rapid concurrent undo) ==');

await new Promise((res, rej) => {
  window.openDB().then(db => {
    const r = db.transaction('rwa_undo', 'readwrite').objectStore('rwa_undo').put([], 'self');
    r.onsuccess = res;
    r.onerror = () => rej(r.error);
  });
});
await seedDoc('<div>POPATOM_SEED</div>');

// Per-modify handlers — using one shared handler with a userMsgs counter
// always evaluates to 1 per fresh modify call (each modify builds messages
// from scratch).
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'pa_m1', type: 'function', function: {
        name: 'apply_edits',
        arguments: JSON.stringify({ version: 'rwa-edit/1',
          edits: [{ find: 'POPATOM_SEED', replace: 'POPATOM_S1' }] }),
      } }],
    } }],
  }),
});
await window.modify('m1');
await new Promise(r => setTimeout(r, 100));
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'pa_m2', type: 'function', function: {
        name: 'apply_edits',
        arguments: JSON.stringify({ version: 'rwa-edit/1',
          edits: [{ find: 'POPATOM_S1', replace: 'POPATOM_S2' }] }),
      } }],
    } }],
  }),
});
await window.modify('m2');
await new Promise(r => setTimeout(r, 100));

const stackBefore53 = await new Promise((res, rej) => {
  window.openDB().then(db => {
    const r = db.transaction('rwa_undo').objectStore('rwa_undo').get('self');
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  });
});
check('53: setup — undo stack has 2 entries before concurrent pops', stackBefore53.length === 2);

const u53_1 = window.undo();
const u53_2 = window.undo();
await Promise.all([u53_1, u53_2]);

const stackAfter53 = await new Promise((res, rej) => {
  window.openDB().then(db => {
    const r = db.transaction('rwa_undo').objectStore('rwa_undo').get('self');
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  });
});
check('53: 2 concurrent undos each popped a distinct entry (stack drained)', stackAfter53.length === 0);
check('53: doc restored to original seed', (await window.getDoc()).includes('POPATOM_SEED'));

// Test 54: no-op edit (find === replace) is a successful, byte-equal commit.
// The runtime allows this — occ=1 passes uniqueness, splice produces the
// identical string. It still pushes to undo and hist (as expected). Pin it
// down so a future "skip no-op" optimization doesn't silently change the
// hist record cadence.
console.log('\n== Test 54: no-op edit (find === replace) ==');
await seedDoc('<div>NOOP_SEED</div>');
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'noop', type: 'function', function: {
        name: 'apply_edits',
        arguments: JSON.stringify({ version: 'rwa-edit/1',
          edits: [{ find: 'NOOP_SEED', replace: 'NOOP_SEED' }] }),
      } }],
    } }],
  }),
});
const before54 = await window.getDoc();
await window.modify('no-op edit');
await new Promise(r => setTimeout(r, 100));
check('54: no-op edit succeeds with doc byte-equal', (await window.getDoc()) === before54);

// Test 55: progressive failure types across retry attempts. Test 2 covers
// a single retry of the same failure type; this exercises three distinct
// failure modes in sequence (find_not_unique → frozen_zone_violation →
// success). Each retry must feed back the correct error code so the model
// can change strategy mid-conversation.
console.log('\n== Test 55: progressive failure types across retries ==');
await seedDoc('<div>PROG_A</div>\n<div>PROG_A</div>\n<div>PROG_TARGET</div>');

let prog55Calls = 0;
fetchHandler = async (url, opts) => {
  prog55Calls++;
  if (prog55Calls === 1) {
    return {
      ok: true, json: async () => ({
        choices: [{ message: {
          role: 'assistant', content: '',
          tool_calls: [{ id: 'p55_1', type: 'function', function: {
            name: 'apply_edits',
            arguments: JSON.stringify({ version: 'rwa-edit/1',
              edits: [{ find: 'PROG_A', replace: 'X' }] }),
          } }],
        } }],
      }),
    };
  }
  if (prog55Calls === 2) {
    const body = JSON.parse(opts.body);
    const last = body.messages.at(-1);
    check('55: attempt 2 received prior failure as tool_result', last.role === 'tool');
    const payload = JSON.parse(last.content);
    check('55: attempt 2 saw find_not_unique code', payload.code === 'find_not_unique');
    return {
      ok: true, json: async () => ({
        choices: [{ message: {
          role: 'assistant', content: '',
          tool_calls: [{ id: 'p55_2', type: 'function', function: {
            name: 'apply_edits',
            arguments: JSON.stringify({ version: 'rwa-edit/1',
              edits: [{ find: 'PROG_TARGET', replace: 'data-rwa-frozen content' }] }),
          } }],
        } }],
      }),
    };
  }
  // attempt 3: success after a different failure feedback
  const body = JSON.parse(opts.body);
  const last = body.messages.at(-1);
  check('55: attempt 3 received prior failure as tool_result', last.role === 'tool');
  const payload = JSON.parse(last.content);
  check('55: attempt 3 saw frozen_zone_violation code', payload.code === 'frozen_zone_violation');
  return {
    ok: true, json: async () => ({
      choices: [{ message: {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'p55_3', type: 'function', function: {
          name: 'apply_edits',
          arguments: JSON.stringify({ version: 'rwa-edit/1',
            edits: [{ find: 'PROG_TARGET', replace: 'PROG_FINAL' }] }),
        } }],
      } }],
    }),
  };
};

await window.modify('progressive failures');
await new Promise(r => setTimeout(r, 200));
check('55: 3rd attempt succeeded — PROG_FINAL committed', (await window.getDoc()).includes('PROG_FINAL'));
check('55: exactly 3 fetches consumed (within retry budget)', prog55Calls === 3);

// Test 56: target_size_exceeded — replace_document with doc > MAX_DOC rejected.
console.log('\n== Test 56: target_size_exceeded (replace_document) ==');
await seedDoc('<div>SIZE_GUARD_SEED</div>');
const HUGE_DOC = '<div>' + 'X'.repeat(1024 * 1024) + '</div>';
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'tse', type: 'function', function: {
        name: 'replace_document',
        arguments: JSON.stringify({ version: 'rwa-edit/1', doc: HUGE_DOC, reason: 'over cap test' }),
      } }],
    } }],
  }),
});
const before56 = await window.getDoc();
await window.modify('huge replace_document');
await new Promise(r => setTimeout(r, 1000));
check('56: target_size_exceeded: huge replace_document rejected, doc unchanged', (await window.getDoc()) === before56);

// Test 57: replace at exactly MAX_REPLACE bytes is accepted (boundary case).
// Test 22 covers MAX_REPLACE+1 (rejected); 8192 itself must succeed.
console.log('\n== Test 57: replace at MAX_REPLACE boundary ==');
await seedDoc('<div>BOUNDARY_TARGET</div>');
const exactly8kb = 'Y'.repeat(8 * 1024);
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'bnd57', type: 'function', function: {
        name: 'apply_edits',
        arguments: JSON.stringify({ version: 'rwa-edit/1',
          edits: [{ find: 'BOUNDARY_TARGET', replace: exactly8kb }] }),
      } }],
    } }],
  }),
});
await window.modify('replace at MAX_REPLACE boundary');
await new Promise(r => setTimeout(r, 100));
const after57 = await window.getDoc();
check('57: replace at exactly MAX_REPLACE bytes (8192) accepted', after57.includes(exactly8kb));
check('57: original anchor consumed by boundary edit', !after57.includes('BOUNDARY_TARGET'));

// Test 58: hist newest-first ordering across mixed apply_edits / replace_document.
console.log('\n== Test 58: hist newest-first across mixed kinds ==');
await seedDoc('<div>HIST_ORDER_SEED</div>');
await new Promise((res, rej) => {
  window.openDB().then(db => {
    const r = db.transaction('rwa_hist', 'readwrite').objectStore('rwa_hist').put([], 'self');
    r.onsuccess = res;
    r.onerror = () => rej(r.error);
  });
});

// modify 1: apply_edits
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'h_e1', type: 'function', function: {
        name: 'apply_edits',
        arguments: JSON.stringify({ version: 'rwa-edit/1',
          edits: [{ find: 'HIST_ORDER_SEED', replace: 'HIST_AFTER_E1' }] }),
      } }],
    } }],
  }),
});
await window.modify('hist e1');
await new Promise(r => setTimeout(r, 100));

// modify 2: replace_document
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'h_rd', type: 'function', function: {
        name: 'replace_document',
        arguments: JSON.stringify({ version: 'rwa-edit/1', doc: '<div>HIST_AFTER_RD</div>', reason: 'hist test' }),
      } }],
    } }],
  }),
});
await window.modify('hist rd');
await new Promise(r => setTimeout(r, 100));

// modify 3: apply_edits
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'h_e2', type: 'function', function: {
        name: 'apply_edits',
        arguments: JSON.stringify({ version: 'rwa-edit/1',
          edits: [{ find: 'HIST_AFTER_RD', replace: 'HIST_AFTER_E2' }] }),
      } }],
    } }],
  }),
});
await window.modify('hist e2');
await new Promise(r => setTimeout(r, 100));

const histOrder = await new Promise((res, rej) => {
  window.openDB().then(db => {
    const r = db.transaction('rwa_hist').objectStore('rwa_hist').get('self');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
});
check('58: hist[0] is most-recent edit_batch (newest)', histOrder[0]?.kind === 'edit_batch');
check('58: hist[1] is replace_document (middle)', histOrder[1]?.kind === 'replace_document');
check('58: hist[2] is original edit_batch (oldest)', histOrder[2]?.kind === 'edit_batch');

// Test 59: multiple frozen zones in one doc — all preserved on outside-edit,
// edits inside any zone rejected. The runtime tracks zones in a Map keyed
// by name; this verifies that map is populated and consulted for every zone.
console.log('\n== Test 59: multiple frozen zones in one doc ==');
const multiZoneSeed =
  '<style>\n' +
  '/* rwa:frozen:begin colors */\n' +
  ':root { --primary-multi: blue; }\n' +
  '/* rwa:frozen:end colors */\n' +
  '/* rwa:frozen:begin spacing */\n' +
  ':root { --gap-multi: 12px; }\n' +
  '/* rwa:frozen:end spacing */\n' +
  '</style>\n' +
  '<div>multi-zone-tail</div>';

// 59a: edit OUTSIDE both zones allowed; both zone interiors preserved.
await seedDoc(multiZoneSeed);
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'mfz_a', type: 'function', function: {
        name: 'apply_edits',
        arguments: JSON.stringify({ version: 'rwa-edit/1',
          edits: [{ find: 'multi-zone-tail', replace: 'multi-zone-tail-CHANGED' }] }),
      } }],
    } }],
  }),
});
await window.modify('edit outside both zones');
await new Promise(r => setTimeout(r, 100));
const after59a = await window.getDoc();
check('59a: edit outside multiple zones allowed', after59a.includes('multi-zone-tail-CHANGED'));
check('59a: first zone (colors) inner preserved', after59a.includes('--primary-multi: blue'));
check('59a: second zone (spacing) inner preserved', after59a.includes('--gap-multi: 12px'));

// 59b: edit INSIDE the first zone (colors) rejected.
await seedDoc(multiZoneSeed);
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'mfz_b', type: 'function', function: {
        name: 'apply_edits',
        arguments: JSON.stringify({ version: 'rwa-edit/1',
          edits: [{ find: '--primary-multi: blue', replace: '--primary-multi: red' }] }),
      } }],
    } }],
  }),
});
const before59b = await window.getDoc();
await window.modify('mutate first zone');
await new Promise(r => setTimeout(r, 200));
check('59b: edit inside first zone (colors) rejected', (await window.getDoc()) === before59b);

// 59c: edit INSIDE the second zone (spacing) rejected.
await seedDoc(multiZoneSeed);
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'mfz_c', type: 'function', function: {
        name: 'apply_edits',
        arguments: JSON.stringify({ version: 'rwa-edit/1',
          edits: [{ find: '--gap-multi: 12px', replace: '--gap-multi: 99px' }] }),
      } }],
    } }],
  }),
});
const before59c = await window.getDoc();
await window.modify('mutate second zone');
await new Promise(r => setTimeout(r, 200));
check('59c: edit inside second zone (spacing) rejected', (await window.getDoc()) === before59c);

// Tests 60a-b: response-shape edge cases. Runtime throws "empty response"
// for missing choices/message; the outer try/catch leaves the doc unchanged.
console.log('\n== Tests 60a-b: response shape edge cases ==');

// 60a: empty choices array.
fetchHandler = async () => ({
  ok: true, json: async () => ({ choices: [] }),
});
const before60a = await window.getDoc();
await window.modify('empty choices');
await new Promise(r => setTimeout(r, 100));
check('60a: empty choices array — doc unchanged', (await window.getDoc()) === before60a);

// 60b: choice without message field.
fetchHandler = async () => ({
  ok: true, json: async () => ({ choices: [{}] }),
});
const before60b = await window.getDoc();
await window.modify('choice missing message');
await new Promise(r => setTimeout(r, 100));
check('60b: choice without message — doc unchanged', (await window.getDoc()) === before60b);

// Test 60c: hist envelope provenance — after a retry, the hist record must
// contain the SUCCESSFUL attempt's envelope, not the failed one. Without
// this, audit trail consumers would see anchors that never existed.
console.log('\n== Test 60c: hist envelope from successful attempt ==');
await seedDoc('<div>HIST_PROV_SEED</div>');
let r60Calls = 0;
fetchHandler = async () => {
  r60Calls++;
  if (r60Calls === 1) {
    return { ok: true, json: async () => ({
      choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'r60_1', type: 'function', function: {
        name: 'apply_edits',
        arguments: JSON.stringify({ version: 'rwa-edit/1', edits: [{ find: 'NOT_PRESENT_60', replace: 'X' }] }),
      } }] } }],
    }) };
  }
  return { ok: true, json: async () => ({
    choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'r60_2', type: 'function', function: {
      name: 'apply_edits',
      arguments: JSON.stringify({ version: 'rwa-edit/1', edits: [{ find: 'HIST_PROV_SEED', replace: 'HIST_PROV_FINAL' }] }),
    } }] } }],
  }) };
};
await window.modify('retry then success');
await new Promise(r => setTimeout(r, 200));
const histProv = await new Promise((res, rej) => {
  window.openDB().then(db => {
    const r = db.transaction('rwa_hist').objectStore('rwa_hist').get('self');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
});
check('60c: hist envelope find = successful attempt anchor', histProv[0]?.envelope?.edits?.[0]?.find === 'HIST_PROV_SEED');
check('60c: hist envelope replace = successful attempt replace', histProv[0]?.envelope?.edits?.[0]?.replace === 'HIST_PROV_FINAL');
check('60c: hist envelope NOT contaminated with failed attempt anchor', histProv[0]?.envelope?.edits?.[0]?.find !== 'NOT_PRESENT_60');

// Tests 61-62: cross-edit reserved-marker assembly. Each individual edit's
// find/replace passes the per-edit containsReservedMarker check, but the
// concatenated splice result contains a reserved substring or attribute.
// The per-edit byte check can't catch this — the post-apply
// extractFrozenZones / dataRwaFrozenSnapshot checks must.
console.log('\n== Tests 61-62: cross-edit reserved-marker assembly ==');

// 61: assemble "// rwa:frozen:begin sneaky\n" across two adjacent edits.
// Caught because the post-apply extractFrozenZones flags the new
// unterminated begin marker as error="unterminated".
await seedDoc('<div>FRAG_PARTA-FRAG_PARTB</div>');
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'asm61', type: 'function', function: {
        name: 'apply_edits',
        arguments: JSON.stringify({ version: 'rwa-edit/1',
          edits: [
            { find: 'FRAG_PARTA', replace: '// rw' },
            { find: '-FRAG_PARTB', replace: 'a:frozen:begin sneaky\n' },
          ] }),
      } }],
    } }],
  }),
});
const before61 = await window.getDoc();
await window.modify('cross-edit assembly of frozen-zone marker');
await new Promise(r => setTimeout(r, 200));
check('61: cross-edit assembly of // rwa:frozen:begin rejected', (await window.getDoc()) === before61);

// 62: assemble data-rwa-frozen attribute across two adjacent edits.
// Caught by post-apply dataRwaFrozenSnapshot count mismatch.
await seedDoc('<span FRAG2A-FRAG2B>cell</span>');
fetchHandler = async () => ({
  ok: true, json: async () => ({
    choices: [{ message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'asm62', type: 'function', function: {
        name: 'apply_edits',
        arguments: JSON.stringify({ version: 'rwa-edit/1',
          edits: [
            { find: 'FRAG2A', replace: 'data-rwa-fr' },
            { find: '-FRAG2B', replace: 'ozen' },
          ] }),
      } }],
    } }],
  }),
});
const before62 = await window.getDoc();
await window.modify('cross-edit assembly of data-rwa-frozen attr');
await new Promise(r => setTimeout(r, 200));
check('62: cross-edit assembly of data-rwa-frozen rejected', (await window.getDoc()) === before62);

console.log('\n== Summary ==');
console.log(`pass: ${pass}, fail: ${fail}`);
process.exit(fail > 0 ? 1 : 0);
