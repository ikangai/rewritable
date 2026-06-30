// Headless test for the import VLM JUDGE (increment 2c) in service/public/import.html.
// judgePage/parseJudge are inlined in import.html (browser-only; the CLI has no renderer). We eval
// the (trusted, in-repo) fidelity block and drive judgePage with a STUB fetch — so the request
// shape (vision model, two images, the score+findings prompt, Bearer auth) and the response parsing
// (JSON extraction, score clamp, findings normalization, error paths) are verified OFFLINE.
// The actual rasterization + the real OpenRouter call are operator/key-verified.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(__dirname, '..', 'service', 'public', 'import.html');
let pass = 0, fail = 0;
const check = (m, c) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  ✗   ' + m); } };

const src = fs.readFileSync(HTML, 'utf8');
const start = src.indexOf('function _fidBadChars');
const end = src.indexOf('// --- UI wiring ---');
if (start < 0 || end <= start) { console.error('could not locate the fidelity block in import.html'); process.exit(1); }
const block = src.slice(start, end);
// block is a slice of our own committed import.html (trusted) — no untrusted interpolation.
const api = new Function('window', 'document', 'PDF_PAGE_STYLE', block + '\nreturn { judgePage, parseJudge };')({}, null, '');

console.log('== import VLM judge (2c) — stub-fetch harness ==');

// --- parseJudge: pure response parsing ---
check('parseJudge: clean JSON → score + findings', (() => {
  const r = api.parseJudge('{"score": 82, "findings": ["missing border", "header heavier"]}');
  return r.score === 82 && r.findings.length === 2;
})());
check('parseJudge: fenced/prose-wrapped JSON still parses', (() => {
  const r = api.parseJudge('Sure!\n```json\n{"score": 70, "findings": ["shifted column"]}\n```');
  return r.score === 70 && r.findings[0] === 'shifted column';
})());
check('parseJudge: score is clamped to 0..100', api.parseJudge('{"score": 150, "findings": []}').score === 100 && api.parseJudge('{"score": -9, "findings": []}').score === 0);
check('parseJudge: non-JSON → null score, empty findings (no throw)', (() => {
  const r = api.parseJudge('I cannot do that');
  return r.score === null && Array.isArray(r.findings) && r.findings.length === 0;
})());
check('parseJudge: non-array findings → []', Array.isArray(api.parseJudge('{"score": 50, "findings": "nope"}').findings) && api.parseJudge('{"score": 50, "findings": "nope"}').findings.length === 0);

// --- judgePage: request shape + parsing, via a stub fetch ---
let captured = null;
const stubFetch = async (url, opts) => {
  captured = { url, opts };
  return { ok: true, json: async () => ({ choices: [{ message: { content: '{"score": 88, "findings": ["wrong font on the title", "rule missing under the header"]}' } }] }) };
};

const res = await api.judgePage('data:image/png;base64,AAAA', 'data:image/png;base64,BBBB', { key: 'sk-test', model: 'google/gemini-2.5-flash', fetch: stubFetch });
check('judgePage: returns the parsed score + findings', res.score === 88 && res.findings.length === 2);
check('judgePage: POSTs with Bearer auth', captured && captured.opts.method === 'POST' && /^Bearer sk-test$/.test(captured.opts.headers.Authorization));
check('judgePage: sends the chosen vision model', JSON.parse(captured.opts.body).model === 'google/gemini-2.5-flash');
check('judgePage: sends a prompt + BOTH page images (original first, import second)', (() => {
  const content = JSON.parse(captured.opts.body).messages[0].content;
  const imgs = content.filter(c => c.type === 'image_url');
  return content.some(c => c.type === 'text') && imgs.length === 2 && imgs[0].image_url.url === 'data:image/png;base64,AAAA' && imgs[1].image_url.url === 'data:image/png;base64,BBBB';
})());

let threwNoKey = false;
try { await api.judgePage('a', 'b', { fetch: stubFetch }); } catch (_) { threwNoKey = true; }
check('judgePage: no key → throws (never silently calls the network)', threwNoKey);

let threwHttp = false;
try { await api.judgePage('a', 'b', { key: 'k', fetch: async () => ({ ok: false, status: 429 }) }); } catch (e) { threwHttp = /429/.test(e.message); }
check('judgePage: non-OK HTTP → throws with the status', threwHttp);

console.log(`\n== ${pass} pass, ${fail} fail ==`);
process.exit(fail ? 1 : 0);
