// `rwa render` — the render door (#38, the F2 half).
//
// An outside agent authoring a document is permanently blind to it. It can read
// the text, address the blocks, verify the hash — and never see the thing it
// made. That is the external twin of the perception gap #21 named for the edit
// loop, and it is the one capability the outside genuinely cannot replicate at
// any price: the container is the only party that can look at itself.
//
// `tests/browser/print.mjs` (#19) already proved the repo can measure a real
// render headlessly. This exposes the same capability as a verb rather than
// leaving it locked inside a test lane.
//
// ## Two deliberate constraints
//
// It drives a REAL browser. There is no second renderer here and there must not
// be: a headless approximation of the container's own layout would be a fourth
// implementation to keep in step, and it would be wrong in exactly the cases
// that matter (print, paged media, web-font-free system stacks).
//
// And it skips politely without Chrome — matching the browser lane's rule —
// because an agent that cannot render should learn that from a clean exit code,
// not from a stack trace.

import { readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { launch, findChrome } from './cdp.mjs';
import { extractInlineDoc } from './seed.mjs';
import { CliError } from './edit.mjs';

export const FORMATS = new Set(['png', 'pdf']);
/** How long to let the container settle before capturing. */
const SETTLE_MS = 900;

/**
 * Render a rewritable to an image or a PDF.
 *
 * @param {string} filePath
 * @param {object} [opts]
 * @param {'png'|'pdf'} [opts.format='png']
 * @param {string} [opts.out] — output path; defaults to the input with the
 *   format's extension
 * @param {number} [opts.width=1200] / [opts.height=1600] — screen viewport (png)
 * @param {boolean} [opts.fullPage=true] — capture past the fold (png)
 * @param {boolean} [opts.print=false] — render the PRINT stylesheet (png only;
 *   pdf is paged media by definition)
 * @returns {Promise<{out: string, format: string, bytes: number, consoleErrors: string[]}>}
 * @throws {CliError} 2 file errors · 6 `chrome_not_found` / `render_failed`
 */
export async function renderDoc(filePath, opts = {}) {
  const format = opts.format || 'png';
  if (!FORMATS.has(format)) {
    throw new CliError(1, 'unknown_format', { got: format, known: [...FORMATS] });
  }

  // Read + validate BEFORE launching a browser: spending ~1s of Chrome startup
  // to discover the file is not a rewritable is a bad trade, and the error is
  // the same `file_error` surface every other verb reports.
  let fileText;
  try {
    fileText = await readFile(filePath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') throw new CliError(2, 'not_found', { path: filePath });
    throw new CliError(2, 'read_error', { path: filePath, errno: e && e.code, message: e && e.message });
  }
  try { extractInlineDoc(fileText); }
  catch { throw new CliError(2, 'not_a_rewritable', { path: filePath }); }

  if (!findChrome()) {
    // Exit 6 rather than a generic failure: "you have no browser" is an
    // environment answer a caller can act on (install one, set CHROME_BIN, or
    // skip the step), not a defect in the document.
    throw new CliError(6, 'chrome_not_found', {
      hint: 'rwa render drives a real browser. Install Chrome/Chromium, or set CHROME_BIN to its path.',
    });
  }

  const abs = resolve(filePath);
  const out = opts.out || abs.replace(/\.html?$/i, '') + '.' + format;
  const width = opts.width || 1200;
  const height = opts.height || 1600;

  let page;
  try {
    page = await launch({ url: pathToFileURL(abs).href });
  } catch (e) {
    throw new CliError(6, 'render_failed', { stage: 'launch', message: e && e.message });
  }

  try {
    await page.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: opts.scale || 1, mobile: false,
    });

    // Wait for the RUNTIME, not just for load: the document is hydrated from
    // IndexedDB after boot, so capturing on load would photograph the inline
    // snapshot rather than what a reader actually sees.
    const ready = await page.eval(async (ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const mount = document.getElementById('rwa-doc-mount');
        if (window.runtime && mount && mount.innerHTML.trim().length > 0) return true;
        await new Promise(r => setTimeout(r, 50));
      }
      return false;
    }, 8000);
    if (!ready) throw new CliError(6, 'render_failed', { stage: 'boot', message: 'the container never finished booting' });

    // Hide the runtime chrome. A render is of the DOCUMENT — the settings gear
    // and status pills are the app, not the artefact, and an agent asking "how
    // does this look" is not asking about them. Print mode already hides them,
    // which is why this mirrors what @media print does.
    await page.eval(() => {
      const el = document.getElementById('rwa-runtime');
      if (el) el.style.display = 'none';
      for (const id of ['rwa-set', 'rwa-set-panel', 'rwa-ai-panel', 'rwa-info-panel', 'rwa-skin-panel', 'rwa-slash-hint', 'rwa-pal']) {
        const n = document.getElementById(id);
        if (n) n.style.display = 'none';
      }
    });

    if (opts.print) {
      await page.send('Emulation.setEmulatedMedia', { media: 'print' });
    }
    await new Promise(r => setTimeout(r, SETTLE_MS));

    let data;
    if (format === 'pdf') {
      const r = await page.send('Page.printToPDF', {
        printBackground: true,
        preferCSSPageSize: true,   // honour the container's own @page margins
      });
      data = r.data;
    } else {
      const r = await page.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: opts.fullPage !== false,
      });
      data = r.data;
    }
    const buf = Buffer.from(data, 'base64');
    writeFileSync(out, buf);
    return { out, format, bytes: buf.length, consoleErrors: page.consoleErrors.slice() };
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError(6, 'render_failed', { stage: 'capture', message: e && e.message });
  } finally {
    try { await page.close(); } catch { /* best effort */ }
  }
}
