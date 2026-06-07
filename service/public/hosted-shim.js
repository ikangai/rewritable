/* rwa: hosted-edit projection shim (Task 6).
 *
 * The server serves the REAL stored current.html (a full rewritable, the seed's
 * lens/⌘K UI unchanged) with THIS script injected immediately BEFORE
 * <script id="rwa-bootstrap"> so it parses and runs FIRST. It does four things:
 *
 *   1. RELOAD-SYNC. The server is the durable truth; local IndexedDB is throwaway
 *      view state. The seed's getDoc() prefers IDB rwa_doc over INLINE_DOC, and
 *      the server re-serves the LATEST current.html as INLINE_DOC on every load.
 *      So a returning visitor (or after an Undo reload, or after another device
 *      edited) whose browser still has a stale rwa_doc would SHADOW the
 *      served-latest. We deleteDatabase('rwa_<uuid>') at the very top — before the
 *      bootstrap's openDB() — so the bootstrap seeds fresh from the served
 *      INLINE_DOC each load. IndexedDB serializes the delete before a later open
 *      on the same db name.
 *
 *   2. COMMIT SINK. window.__rwaCommitSink (the seed's Task-1 seam in commitDoc)
 *      redirects every ⌘K/lens commit to the authoritative server. The agent
 *      still runs CLIENT-SIDE (the user's own key, exactly as today) → produces
 *      an rwa-edit/1 envelope → the seam hands it to this sink → the sink POSTs to
 *      /r/<id>/modify → the server applies authoritatively and returns its
 *      canonical new doc → the sink returns that string → the seed mirrors it to
 *      IDB and re-renders. The service only ever APPLIES envelopes; it never sees
 *      a model key.
 *
 *   3. SERVER-UNDO. A small floating button → POST /r/<id>/undo → reload (the
 *      server reverted current.html; reload re-serves it). Disabled at undoLen 0.
 *
 *   4. TOKEN PLUMBING. The capability token rides the URL fragment (#k=<token>),
 *      which is NOT sent to the server (never hits server logs). We read it,
 *      stash it in sessionStorage keyed by id, strip #k= from the visible URL,
 *      and send it as Authorization: Bearer on /modify + /undo.
 *
 * id-blessing note: in hosted/sink mode the seed's BOOT-time data-rwa-id blessing
 * is suppressed via window.__rwaSuppressBlockIds (set below, before the bootstrap
 * IIFE parses). The server is the authoritative store and serves its un-blessed
 * body verbatim, so suppressing keeps the hosted body un-blessed and the client's
 * baseHash equal to the server's baseBodyHash — a fresh edit 200s instead of
 * false-409ing. The commit-path backfill is also inert here (commitDoc returns
 * early through the sink). The doc self-blesses on the first LOCAL (file://) open
 * after export, where this flag is unset.
 *
 * Plain browser JS, no build, no deps. Templated per request: __RWA_HOSTED_ID__
 * and __RWA_HOSTED_UUID__ are substituted with this rwa's id + stored DOC_UUID.
 */
(function () {
  'use strict';

  // Suppress the seed's BOOT-time data-rwa-id blessing BEFORE the bootstrap IIFE
  // parses (this shim is prepended before <script id="rwa-bootstrap">, so it runs
  // first). Keeps the hosted body un-blessed → client baseHash === server
  // baseBodyHash. See the id-blessing note in the header comment.
  window.__rwaSuppressBlockIds = true;

  var RWA_ID = '__RWA_HOSTED_ID__';
  var RWA_UUID = '__RWA_HOSTED_UUID__';
  var TOKEN_KEY = 'rwa_hosted_token_' + RWA_ID;
  var TEST = typeof window !== 'undefined' && window.__RWA_SHIM_TEST__ === true;

  // ── 1. Reload-sync: drop the stale per-container IDB before the bootstrap opens
  //    it. Request issued synchronously at the top; the bootstrap's later open()
  //    on the same db name is serialized behind it by the IndexedDB spec.
  var deletePromise = Promise.resolve();
  try {
    var delReq = window.indexedDB.deleteDatabase('rwa_' + RWA_UUID);
    deletePromise = new Promise(function (resolve) {
      delReq.onsuccess = delReq.onerror = delReq.onblocked = function () { resolve(); };
    });
  } catch (_e) { /* no IDB → nothing to clear; the bootstrap handles absence */ }

  // ── 4. Token: prefer the #k= fragment, then sessionStorage (returning visitor).
  function readFragmentToken() {
    var h = window.location.hash || '';
    var m = h.match(/[#&]k=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }
  var token = readFragmentToken();
  if (token) {
    try { window.sessionStorage.setItem(TOKEN_KEY, token); } catch (_e) {}
    // Strip #k= from the visible URL so the token isn't in the address bar / not
    // copy-pasted by accident. Fragments never reach the server, but this keeps
    // the secret out of the visible chrome. Drop the whole fragment.
    try {
      var clean = window.location.pathname + window.location.search;
      window.history.replaceState(null, '', clean);
    } catch (_e) {}
  } else {
    try { token = window.sessionStorage.getItem(TOKEN_KEY); } catch (_e) { token = null; }
  }
  function getToken() {
    if (token) return token;
    try { return window.sessionStorage.getItem(TOKEN_KEY); } catch (_e) { return null; }
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  var canonLF = function (s) {
    return s == null ? '' : String(s).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  };
  async function sha256hex(s) {
    var bytes = new TextEncoder().encode(s);
    var buf = await window.crypto.subtle.digest('SHA-256', bytes);
    var arr = Array.from(new Uint8Array(buf));
    return arr.map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  function authHeaders() {
    var t = getToken();
    var h = { 'Content-Type': 'application/json' };
    if (t) h.Authorization = 'Bearer ' + t;
    return h;
  }
  function doReload() {
    // jsdom's location.reload is non-configurable; honor a test-only override.
    if (TEST && typeof window.__rwaHostedReload === 'function') return window.__rwaHostedReload();
    window.location.reload();
  }
  function notice(msg) {
    if (TEST) return; // tests assert via thrown errors / spies, not visible DOM toasts
    try {
      var n = document.createElement('div');
      n.setAttribute('role', 'status');
      n.style.cssText = 'position:fixed;left:50%;bottom:84px;transform:translateX(-50%);' +
        'background:#1a1a1a;color:#fff;padding:10px 16px;border-radius:10px;font:14px/1.4 ' +
        '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;z-index:2147483646;' +
        'box-shadow:0 4px 16px rgba(0,0,0,.25);max-width:80vw;';
      n.textContent = msg;
      // body may be null on a very early commit (before <body> parses) — fall
      // back to documentElement so the user-facing toast is never silently lost.
      (document.body || document.documentElement).appendChild(n);
      setTimeout(function () { try { n.remove(); } catch (_e) {} }, 4000);
    } catch (_e) {}
  }

  // ── 2. Commit sink: the seed's Task-1 seam. (envelope, histRecord, baseDoc) →
  //    POST /modify → return the server's canonical doc (the seam mirrors it). The
  //    baseHash MUST equal the server's baseBodyHash = sha256(canonLF(editable
  //    body)) so a fresh edit → 200, never a false 409.
  window.__rwaCommitSink = async function (envelope, histRecord, baseDoc) {
    var baseHash = await sha256hex(canonLF(baseDoc));
    var res;
    try {
      res = await window.fetch('/r/' + RWA_ID + '/modify', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ envelope: envelope, baseHash: baseHash }),
      });
    } catch (netErr) {
      notice('Server error — your edit was not saved. Check your connection.');
      throw new Error('hosted modify: server error (network: ' + (netErr && netErr.message) + ')');
    }

    var status = res.status;
    var data = null;
    try { data = await res.json(); } catch (_e) { data = null; }

    if (status === 200) {
      // FAIL LOUD: commitDoc mirrors this return via idbPut(RWA.DOC, serverDoc).
      // A non-string / empty doc must throw at the boundary, never corrupt the
      // local mirror.
      if (!data || typeof data.doc !== 'string' || data.doc.length === 0) {
        throw new Error('hosted modify: malformed server reply (expected a non-empty string doc)');
      }
      if (typeof data.undoLen === 'number') setUndoLen(data.undoLen);
      return data.doc; // seam: idbPut(RWA.DOC, doc) + renderDoc(doc)
    }

    if (status === 409) {
      // Concurrent / stale base — the server advanced. Re-fetch authoritative
      // bytes and throw so the seed shows the edit didn't land.
      notice('This document changed on the server — reloading…');
      doReload();
      throw new Error('hosted modify: stale_base (409) — reloading from server');
    }

    if (status === 401) {
      notice('Your edit token is invalid or expired.');
      throw new Error('hosted modify: unauthorized (401) — edit token invalid/expired');
    }

    // 4xx (422 rwa-edit failure vocab, 400, 413, 429, …): surface the subcode so
    // the user sees WHY. The seed preserves the lens input on a rejected commit.
    if (status >= 400 && status < 500) {
      var sub = (data && data.error) || ('http_' + status);
      var detail = data && data.detail ? ' — ' + data.detail : '';
      notice('Edit rejected: ' + sub + detail);
      throw new Error('hosted modify: ' + sub + ' (' + status + ')' + detail);
    }

    // 5xx
    notice('Server error — your edit was not saved.');
    throw new Error('hosted modify: server error (' + status + ')');
  };

  // ── 3. Server-Undo button + undoLen tracking ────────────────────────────────
  // undoLen is the authoritative remaining undo-stack depth. The server reports it
  // on every /modify + /undo reply. It is UNKNOWN on first load (no GET returns it
  // — see initUndoState), so the button starts OPTIMISTICALLY ENABLED and
  // self-corrects: a /undo on an empty stack → 409 nothing_to_undo → setUndoLen(0)
  // → disabled. Once known (number), the button strictly reflects undoLen > 0.
  var undoLen = null; // null = unknown (optimistic-enable); number = authoritative
  var undoBtn = null;

  function setUndoLen(n) {
    undoLen = n;
    if (undoBtn) undoBtn.disabled = (typeof undoLen === 'number') ? !(undoLen > 0) : false;
  }

  async function doUndo() {
    var res;
    try {
      res = await window.fetch('/r/' + RWA_ID + '/undo', {
        method: 'POST', headers: authHeaders(),
      });
    } catch (_e) {
      notice('Server error — could not undo.');
      return;
    }
    var data = null;
    try { data = await res.json(); } catch (_e) { data = null; }
    if (res.status === 200) {
      if (data && typeof data.undoLen === 'number') setUndoLen(data.undoLen);
      doReload(); // server reverted current.html; reload re-serves it
      return;
    }
    if (res.status === 409) { // nothing_to_undo
      setUndoLen(0);
      notice('Nothing to undo.');
      return;
    }
    if (res.status === 401) { notice('Your edit token is invalid or expired.'); return; }
    notice('Could not undo (' + res.status + ').');
  }

  function mountUndoButton() {
    if (undoBtn) return;
    undoBtn = document.createElement('button');
    undoBtn.id = 'rwa-hosted-undo';
    undoBtn.type = 'button';
    undoBtn.textContent = 'Undo';
    undoBtn.title = 'Undo the last server-saved edit';
    undoBtn.style.cssText = 'position:fixed;left:24px;bottom:24px;z-index:2147483645;' +
      'padding:8px 14px;border:1px solid #d4d4d4;border-radius:10px;background:#fff;' +
      'color:#171717;font:14px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
      'cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.08);';
    // undoLen unknown(null) on load → optimistically enabled; a click on an empty
    // stack returns 409 → disabled. number → strictly undoLen > 0.
    undoBtn.disabled = (typeof undoLen === 'number') ? !(undoLen > 0) : false;
    undoBtn.addEventListener('click', function () { doUndo(); });
    document.body.appendChild(undoBtn);
  }

  // Initial undoLen on load: there is NO GET that returns the undo depth (/doc
  // carries {doc, baseHash, selfDescription}, not undoLen), so we cannot
  // pre-populate it without a server change (out of Task-6 scope: route + shim +
  // tests only). Rather than guess, the button starts optimistically ENABLED and
  // self-corrects on the first click: a /undo on an empty stack → 409
  // nothing_to_undo → undoLen=0 → disabled. After any /modify or /undo the count
  // is authoritative. (Phase-B may add undoLen to /doc to make the load state
  // exact instead of optimistic.)
  function initUndoState() { /* optimistic — see comment above */ }

  function boot() {
    mountUndoButton();
    initUndoState();
  }
  if (!TEST) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
  } else {
    // In test mode the harness DOM is ready; mount immediately so tests can read
    // the button without a DOMContentLoaded round-trip.
    mountUndoButton();
  }

  // ── Test-only API (gated on window.__RWA_SHIM_TEST__) ────────────────────────
  // Mirrors the seed's `window.injectMissingBlockIds = …; // expose for tests`
  // convention. A production page NEVER exposes these internals.
  if (TEST) {
    window.__rwaHostedShimTestApi = {
      getToken: getToken,
      doUndo: doUndo,
      getUndoLen: function () { return undoLen; },
      setUndoLen: setUndoLen,
      deletePromise: deletePromise,
      sha256hex: sha256hex,
      canonLF: canonLF,
    };
  }
})();
