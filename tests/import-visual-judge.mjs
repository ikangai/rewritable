// Headless harness for the import VISUAL JUDGE (increment 2b) in service/public/import.html.
// The repo has no puppeteer; the established pattern is a driver that reads a verdict. Here we eval
// the (trusted, in-repo) fidelity block from import.html into a jsdom window and drive
// buildFidelityCompare — verifying the per-page strip, worst-page default, the slider/flicker DOM,
// the window.__fidProbe verdict, and graceful degradation when rasterization is unavailable.
// (Actual pdf.js pixel rasterization + the visual slip needs a real browser — operator-verified.)
import jsdomPkg from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { JSDOM } = jsdomPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(__dirname, '..', 'service', 'public', 'import.html');
let pass = 0, fail = 0;
const check = (m, c) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  ✗   ' + m); } };

const src = fs.readFileSync(HTML, 'utf8');
const start = src.indexOf('function _fidBadChars');
const end = src.indexOf('// --- UI wiring ---');
if (start < 0 || end <= start) { console.error('could not locate the fidelity block in import.html'); process.exit(1); }
const block = src.slice(start, end);

const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://t.local/' });
const win = dom.window, doc = win.document;
win.pdfjs = undefined; // force rasterize to degrade (no real canvas in jsdom) — exercises the fallback
// block is a slice of our own committed import.html (trusted) — no untrusted interpolation.
const api = new Function('window', 'document', 'PDF_PAGE_STYLE', block + '\nreturn { structuralScoreByPage, buildFidelityCompare };')(win, doc, '');

const pageHtml = (t) => '<div class="rwa-pdf-page"><span class="rwa-pdf-t">' + t + '</span></div>';
const dense = 'The quarterly report shows revenue up twelve percent across all regions this year.';
const garbled = 'Introduction to the system output'.split('').map((c, i) => (i % 3 === 0 ? '�' : c)).join('');
const fidelityInput = { pages: 2, perPage: [{ sourceText: dense, html: pageHtml(dense) }, { sourceText: garbled, html: pageHtml(garbled) }] };
const fakeFile = { arrayBuffer: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer }; // "%PDF" — rasterize will throw (no pdfjs) → degrade

console.log('== import visual judge (2b) — jsdom harness ==');

const panel = doc.createElement('div');
doc.body.appendChild(panel);
const by = await api.buildFidelityCompare(panel, { file: fakeFile, fidelityInput });

check('builds a per-page strip (one chip per page)', panel.querySelectorAll('.fid-page').length === 2);
check('a low page is flagged (page 2 garbled)', !!panel.querySelector('.fid-page.low'));
check('the compare area renders a slider + flicker + wrap', !!panel.querySelector('.fid-slider') && !!panel.querySelector('.fid-flick') && !!panel.querySelector('.fid-wrap'));
check('defaults to the WORST page (page 2)', win.__fidProbe && win.__fidProbe.defaultPage === 2);
check('the verdict reports per-page scores', win.__fidProbe && win.__fidProbe.pages.length === 2 && win.__fidProbe.pages[0].score > 0.9 && win.__fidProbe.pages[1].score < 0.85);
check('the verdict lists the low pages', JSON.stringify(win.__fidProbe.lowPages) === JSON.stringify([2]));
check('rasterization degraded gracefully (no canvas in jsdom) — scores-only, still built', win.__fidProbe.originalsRendered === 0 && /original render unavailable/.test(panel.textContent));
check('the import layer renders the page content', /quarterly|Introduction|system/.test(panel.querySelector('.fid-imp').textContent) || panel.querySelector('.fid-imp').innerHTML.length > 0);

// the slider drives the curtain clip
const slider = panel.querySelector('.fid-slider'); slider.value = '20'; slider.oninput();
check('dragging the slider clips the original layer', /inset\(0 80% 0 0\)/.test(panel.querySelector('.fid-orig').style.clipPath));

// clicking a strip chip switches the active page
panel.querySelectorAll('.fid-page')[0].onclick();
check('clicking a page chip switches the active page (chip marked on)', panel.querySelectorAll('.fid-page')[0].classList.contains('on'));

// --- M1: the consent gate — confirm=false must NOT touch the network ---
// The VLM judge is the only network path on the import page; "decline consent → no call" is the
// property that makes it safe. Give rasterizeOriginal a stub pdfjs so the original canvas exists
// (orig truthy), so the handler reaches the consent check; with confirm=false it must return BEFORE
// getJudgeKey / rasterizeImport / fetch.
win.pdfjs = { getDocument: () => ({ promise: Promise.resolve({ numPages: 1, getPage: () => Promise.resolve({ getViewport: () => ({ width: 50, height: 50 }), render: () => ({ promise: Promise.resolve() }) }), destroy: () => Promise.resolve() }) }) };
let fetchCalled = false, promptCalled = false;
win.fetch = () => { fetchCalled = true; return Promise.resolve({ ok: true, json: async () => ({}) }); };
win.prompt = () => { promptCalled = true; return 'sk-should-not-be-asked'; };
win.confirm = () => false;
const panel2 = doc.createElement('div'); doc.body.appendChild(panel2);
await api.buildFidelityCompare(panel2, { file: fakeFile, fidelityInput });
check('stubbed pdfjs makes the original canvas available (judge is reachable)', win.__fidProbe.originalsRendered === 1);
const jbtn = panel2.querySelector('.fid-judge');
await jbtn.onclick();
check('CONSENT GATE: confirm=false → no network call and no key prompt (judge aborted)', fetchCalled === false && promptCalled === false);

console.log(`\n== ${pass} pass, ${fail} fail ==`);
process.exit(fail ? 1 : 0);
