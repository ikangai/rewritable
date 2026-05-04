// benchmark/runners/harness.mjs — shared jsdom loader for conformance scenarios.
//
// Loads seeds/rewritable.html in a fresh jsdom window per scenario, waits for
// bootstrap to settle, and exposes the runtime's modify-pathway APIs as a
// scenario-friendly Context object. Mirrors tests/e2e.mjs setup.
//
// Each scenario obtains its own fresh Context — bootstrap re-runs, IDB is
// reset (fake-indexeddb is per-instance when imported fresh), and stubs are
// independent. The `dispose()` call on Context closes jsdom and releases
// resources.

import jsdomPkg from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { JSDOM, VirtualConsole } = jsdomPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.resolve(__dirname, '..', '..', 'seeds', 'rewritable.html');
const SEED_HTML = fs.readFileSync(SEED, 'utf8');

export const SEED_PATH = SEED;
export const SEED_BYTES = SEED_HTML;

// Re-import fake-indexeddb fresh per harness.fresh() so each scenario gets
// an isolated database. The default-exported `indexedDB` is shared across
// all importers, which would let one scenario's commit leak into the next.
// fake-indexeddb v6's `IDBFactory` constructor produces a fresh instance.
import * as fakeIDB from 'fake-indexeddb';

function freshIDB() {
  const FDBFactory = fakeIDB.IDBFactory || fakeIDB.default?.IDBFactory;
  if (FDBFactory) {
    return { indexedDB: new FDBFactory(), IDBKeyRange: fakeIDB.IDBKeyRange };
  }
  return { indexedDB: fakeIDB.indexedDB, IDBKeyRange: fakeIDB.IDBKeyRange };
}

/**
 * Spin up a fresh jsdom containing seeds/rewritable.html with the runtime
 * APIs (applyEdits, replaceDocument, modify, getDoc) exposed on `window`.
 *
 * @param {object} [opts]
 * @param {(...args: any[]) => any} [opts.fetchHandler] — called when the
 *   bootstrap's `fetch()` (the OpenRouter call) fires. Defaults to a
 *   throwing stub so accidental network calls fail loudly.
 * @returns {Promise<Context>}
 */
export async function fresh(opts = {}) {
  const { indexedDB, IDBKeyRange } = freshIDB();
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on('jsdomError', e => {
    errors.push(e?.detail?.stack || e?.detail || e);
  });

  let fetchHandler = opts.fetchHandler || (async () => {
    throw new Error('fetch called but no fetchHandler set on harness Context');
  });

  const dom = new JSDOM(SEED_HTML, {
    url: 'https://rwa-bench.local/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.indexedDB = indexedDB;
      window.IDBKeyRange = IDBKeyRange;
      window.sessionStorage.setItem('rwa_apikey', 'bench-key');
      window.sessionStorage.setItem('rwa_model', 'bench-model');
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

  // Wait for the bootstrap IIFE to settle. The bootstrap mounts content,
  // declares globals, and sets the ready status. tests/e2e.mjs uses 200ms.
  await new Promise(r => setTimeout(r, 250));

  if (typeof window.applyEdits !== 'function') {
    dom.window.close();
    throw new Error('runtime did not expose window.applyEdits — bootstrap failed');
  }

  /** @typedef {{
   *   window: any,
   *   applyEdits: (envelope: any, doc: string) => Promise<string>,
   *   replaceDocument: (envelope: any, doc: string) => Promise<string>,
   *   modify: (instr: string) => Promise<any>,
   *   getDoc: () => Promise<string>,
   *   getHistory: () => Promise<any[]>,
   *   getUndoStack: () => Promise<any[]>,
   *   setFetchHandler: (h: (...args: any[]) => any) => void,
   *   bootstrapErrors: () => any[],
   *   readSeedBytes: () => string,
   *   dispose: () => void,
   * }} Context */

  /** @type {Context} */
  const ctx = {
    window,
    applyEdits: (envelope, doc) => window.applyEdits(envelope, doc),
    replaceDocument: (envelope, doc) => window.replaceDocument(envelope, doc),
    modify: (instr) => window.modify(instr),
    getDoc: () => window.getDoc(),
    getHistory: () => readIDBStore(window, 'rwa_hist'),
    getUndoStack: () => readIDBStore(window, 'rwa_undo'),
    setFetchHandler(h) { fetchHandler = h; },
    bootstrapErrors: () => errors.slice(),
    readSeedBytes: () => SEED_HTML,
    dispose() { try { window.close(); } catch (_) { /* swallow */ } },
  };

  return ctx;
}

// Read a per-container IDB store directly. The runtime keeps everything
// under `rwa_<DOC_UUID>`. The seed has DOC_UUID === '00000000-...' so
// we know the DB name without parsing.
function readIDBStore(window, storeName) {
  return new Promise((resolve, reject) => {
    const dbName = 'rwa_00000000-0000-0000-0000-000000000000';
    const req = window.indexedDB.open(dbName);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(storeName)) {
        db.close();
        return resolve([]);
      }
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const all = store.get('self');
      all.onerror = () => { db.close(); reject(all.error); };
      all.onsuccess = () => {
        const v = all.result;
        db.close();
        // rwa_hist and rwa_undo are arrays stored under key 'self'
        resolve(Array.isArray(v) ? v : (v == null ? [] : [v]));
      };
    };
  });
}

/**
 * Helper: assert a Promise rejects with an RwaEditError having a specific code.
 * @param {Promise<any>} p
 * @param {string} expectedCode
 * @returns {Promise<{ pass: boolean, reason: string, error?: any }>}
 */
export async function expectRwaError(p, expectedCode) {
  try {
    const result = await p;
    return { pass: false, reason: `expected throw, got result (length ${String(result).length})` };
  } catch (err) {
    if (!err || typeof err !== 'object') {
      return { pass: false, reason: `threw non-object: ${err}` };
    }
    if (err.code !== expectedCode) {
      return { pass: false, reason: `expected code=${expectedCode}, got code=${err.code} (${err.message || ''})`, error: err };
    }
    return { pass: true, reason: `threw ${err.code}`, error: err };
  }
}
