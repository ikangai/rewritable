// Selector oracle for fidelity success scoring.
//
// Spec §2.3: "Run a set of CSS or XPath assertions against the parsed
// post-edit doc. Score 2 = all assertions pass, 1 = at least one fails but
// the change is recognizably present, 0 = no assertion passes."
//
// We use jsdom (already in the harness) to parse and query. A scenario
// declares its assertions as an array of { selector, expect } objects.

import jsdomPkg from 'jsdom';
const { JSDOM } = jsdomPkg;

/**
 * @typedef {Object} Assertion
 * @property {string} [selector] — CSS selector to query
 * @property {boolean} [exists] — element must (true) or must not (false) be present
 * @property {string} [textContains] — element's textContent must include this
 * @property {string} [textEquals] — element's textContent (trimmed) must equal this
 * @property {Object<string, string>} [attrs] — { attrName: expectedValue } per selected element
 * @property {(doc: Document) => boolean} [fn] — custom predicate (alternative to selector form)
 * @property {string} [label] — optional human label for reporting
 */

/**
 * Run assertions against a doc string. Returns { score, total, passed, results }.
 *
 * Per spec §2.3:
 *   2 — all assertions pass
 *   1 — some pass, change is recognizably present
 *   0 — none pass
 *
 * Caller-supplied assertions encode the success oracle.
 *
 * @param {string} doc — post-edit doc HTML
 * @param {Assertion[]} assertions
 * @returns {{ score: 0 | 1 | 2, total: number, passed: number, results: Array<{ label: string, ok: boolean, reason?: string }> }}
 */
export function runSelectorOracle(doc, assertions) {
  const dom = new JSDOM('<!DOCTYPE html><html><body>' + doc + '</body></html>');
  const document = dom.window.document;
  const results = [];

  for (const a of assertions) {
    const label = a.label || a.selector || (a.fn ? 'fn' : 'unlabeled');
    try {
      if (typeof a.fn === 'function') {
        const ok = !!a.fn(document);
        results.push({ label, ok, reason: ok ? 'fn returned truthy' : 'fn returned falsy' });
        continue;
      }
      if (typeof a.selector !== 'string') {
        results.push({ label, ok: false, reason: 'no selector and no fn' });
        continue;
      }
      const el = document.querySelector(a.selector);
      if (a.exists === false) {
        results.push({ label, ok: el === null, reason: el ? 'element unexpectedly present' : 'absent as expected' });
        continue;
      }
      if (!el) {
        results.push({ label, ok: false, reason: `selector matched 0 elements` });
        continue;
      }
      if (a.exists === true) {
        results.push({ label, ok: true, reason: 'element present' });
        continue;
      }
      if (typeof a.textContains === 'string') {
        const text = el.textContent || '';
        const ok = text.includes(a.textContains);
        results.push({ label, ok, reason: ok ? 'text matches' : `text=${JSON.stringify(text.slice(0, 60))}` });
        continue;
      }
      if (typeof a.textEquals === 'string') {
        const text = (el.textContent || '').trim();
        const ok = text === a.textEquals;
        results.push({ label, ok, reason: ok ? 'text equals' : `text=${JSON.stringify(text.slice(0, 60))}` });
        continue;
      }
      if (a.attrs && typeof a.attrs === 'object') {
        let ok = true; let mismatch = '';
        for (const [name, expected] of Object.entries(a.attrs)) {
          const actual = el.getAttribute(name);
          if (actual !== expected) { ok = false; mismatch = `${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`; break; }
        }
        results.push({ label, ok, reason: ok ? 'attrs match' : mismatch });
        continue;
      }
      // Default if just selector given: existence check
      results.push({ label, ok: el !== null, reason: el ? 'element present (default check)' : 'no match' });
    } catch (err) {
      results.push({ label, ok: false, reason: `assertion threw: ${err.message}` });
    }
  }

  const passed = results.filter(r => r.ok).length;
  const total = results.length;
  let score;
  if (passed === total) score = 2;
  else if (passed > 0) score = 1;
  else score = 0;
  return { score, total, passed, results };
}
