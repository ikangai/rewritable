// Minimal Chrome DevTools Protocol client — zero dependencies (#9).
//
// WHY no Playwright/Puppeteer: this repo's whole thesis is single-file, no-build, no-npm-deps, and
// its existing browser proofs (tests/skill-exec-probe.mjs) are hand-opened HTML artifacts precisely
// to avoid a driver dependency. A test lane that contradicts the project's own constraint is a lane
// nobody keeps. Node 22+ ships a global WebSocket, and Chrome speaks CDP over it, so the driver is
// ~100 lines and installs nothing.
//
// Scope is deliberately narrow: launch, evaluate, dispatch input, read console. Everything jsdom
// already covers stays in jsdom — this exists only for what jsdom structurally cannot do (layout,
// real pointer/touch input, actual rendering).

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export function findChrome() {
  return CHROME_CANDIDATES.find((p) => { try { return existsSync(p); } catch { return false; } }) || null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Startup budget. 6s was too tight: a loaded CI runner intermittently failed here with "CDP
// endpoint never came up" while passing on the next run — a flaky lane is worse than a slow one,
// and this is pure waiting, so it costs nothing when Chrome is quick. `diag` carries Chrome's own
// stderr so a genuine launch failure (missing library, bad flag) is reported as itself rather than
// disguised as a timeout.
async function fetchJson(url, tries = 120, diag = () => '') {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    await sleep(150);
  }
  const stderr = diag().trim().split('\n').slice(-6).join('\n');
  throw new Error(`CDP endpoint never came up: ${url}` + (stderr ? `\nchrome stderr:\n${stderr}` : ''));
}

export async function launch({ url = 'about:blank', headless = true } = {}) {
  const bin = findChrome();
  if (!bin) throw new Error('no Chrome binary found');
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'rwa-cdp-'));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-sync', '--mute-audio',
    // file:// containers read/write IndexedDB; keep the profile real but disposable.
    ...(headless ? ['--headless=new'] : []),
    // CI only. GitHub's runners execute as root inside a container, where Chrome's setuid sandbox
    // refuses to start and the debugging port never opens — which surfaces as "CDP endpoint never
    // came up" rather than anything mentioning sandboxing. --disable-dev-shm-usage avoids the
    // small /dev/shm those containers provide, a separate crash with the same symptom.
    //
    // Deliberately NOT applied locally: the sandbox works fine on a dev machine, and weakening it
    // by default would be a real reduction for no benefit. This harness launches its own
    // disposable-profile Chrome against a local file it just wrote, so the CI relaxation is
    // bounded to that.
    ...(process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] : []),
    url,
  ];
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let chromeErr = '';
  child.stderr.on('data', (d) => { chromeErr += d; });
  child.on('error', (e) => { chromeErr += '\nspawn error: ' + e.message; });

  await fetchJson(`http://127.0.0.1:${port}/json/version`, 120, () => chromeErr);
  // Find the page target for our URL (Chrome may also expose other targets).
  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    const list = await fetchJson(`http://127.0.0.1:${port}/json/list`);
    target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!target) await sleep(150);
  }
  if (!target) throw new Error('no page target');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP websocket failed')), { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const consoleErrors = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || 'cdp error'));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(msg.params?.exceptionDetails?.text || 'exception');
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      consoleErrors.push((msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
    }
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Runtime.enable');
  await send('Page.enable');

  const page = {
    send,
    consoleErrors,
    async goto(target_) {
      await send('Page.navigate', { url: target_ });
      await sleep(400);
    },
    // Evaluate in the page and return a JSON-serializable value. Throws on page-side error so a
    // broken assertion surfaces rather than silently returning undefined.
    //
    // NOTE: this is not JavaScript's eval(). It serialises a function THIS FILE defines and hands
    // it to Chrome's `Runtime.evaluate` over the debugging protocol — the standard mechanism every
    // browser driver uses, and the only way to read layout out of a real page. Nothing here
    // executes untrusted input: the expressions come from the test files in this directory, and the
    // page under test is a local container the test itself just built.
    async eval(fn, ...args) {
      const expression = `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})`;
      const r = await send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true,
      });
      if (r.exceptionDetails) {
        throw new Error('page eval threw: ' + (r.exceptionDetails.text || '') + ' ' +
          (r.exceptionDetails.exception?.description || ''));
      }
      return r.result?.value;
    },
    async clickAt(x, y) {
      const base = { x, y, button: 'left', clickCount: 1 };
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
      await sleep(120);
    },
    async moveTo(x, y) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await sleep(60);
    },
    // Put the page into touch-device mode. Chrome only synthesises the compatibility click that
    // follows a real tap when the target is actually a touch target, so a raw dispatchTouchEvent on
    // a mouse-mode page fires touch handlers but never the click — which looks exactly like a
    // product bug and is not one. Call this before tapAt.
    async enableTouch() {
      await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      await sleep(60);
    },
    // Real key events. Needed because this lane cannot use the seed's `window.__*` test hooks —
    // they are jsdom-gated by design, so in a real browser they are undefined and calling them is a
    // silent no-op. Drive the UI the way a person does.
    async pressKey(key, code, keyCode) {
      const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await sleep(120);
    },
    async tapAt(x, y) {
      // A real touch sequence — the thing jsdom cannot produce at all.
      await send('Input.dispatchTouchEvent', {
        type: 'touchStart', touchPoints: [{ x, y, id: 0 }],
      });
      await sleep(40);
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(160);
    },
    async close() {
      try { ws.close(); } catch { /* already gone */ }
      try { child.kill(); } catch { /* already gone */ }
      await sleep(150);
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
  return page;
}
