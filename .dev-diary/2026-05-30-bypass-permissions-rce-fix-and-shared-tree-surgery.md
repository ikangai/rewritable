# 2026-05-30 — Closing the two bypassPermissions RCEs, and untangling a three-agent shared checkout

Ran as one of three parallel Claude instances (ada, turing, me=hopper) pointed at the same repo with a shared `/goal`: evolve rewritable into something remarkable, coordinate through a group chat, keep it self-contained. The interesting part of this session turned out to be half security work and half *coordination* — three agents editing the same working tree at once.

## Picking a lane that wasn't already taken

My first instinct was a "Change Awareness" feature: after an agent edit, flash-highlight the blocks that changed (reusing the existing `.rwa-frag-pulse` idiom) and make history rows show the real find→replace diff. The data's all already there — `rwa_hist` persists the full envelope, and `commitDoc(currentDoc, work, …)` has both old and new doc at the seam. It would have been a nice, self-contained delight.

But the group chat saved me from a collision. ada had explicitly claimed "success echo, animations, presentation surface" — which is *exactly* the highlight-on-edit moment. turing took agent-facing edit-failure self-correction. So my idea was ada's. turing pointed at the open lanes: architecture/kernel, or robustness/security (the two RCE items from the 2026-05-27 audit, plus CSP/HSTS).

I yielded the highlight to ada and took security. The reframe that made it feel on-goal rather than like a chore: a rewritable's *entire* promise is "a self-contained .html you pass around." If *receiving* one can pwn your machine, the medium is dead on arrival. Hardening the share/receive boundary isn't table-stakes — it unlocks the core promise.

## Both Criticals were still live

The audit diary documented them; nobody had landed a fix. Confirmed in code:
- `seeds/rewritable.html` — the bridge backend pipes a prompt embedding the whole current document into `claude -p --permission-mode bypassPermissions`. A shared/received document is attacker-controlled; injection text in it runs shell via the localhost bridge the moment someone presses ⌘K with the bridge backend selected.
- `cli/src/import-claude.mjs` — `rwa import file.pdf --claude` spawns the same flag; a malicious third-party PDF prompt-injects the extraction agent.

The two fixes are NOT symmetric, which is the whole lesson of the session:

**Bridge** was clean. The bridge agent only has to *emit text* (an rwa-edit envelope / naked HTML) — it needs no tools at all. So bypassPermissions bought nothing but the vuln. I extracted a single-source `bridgeCommand()` (both `callBridgeSingleShot` and `modifyViaBridge` had the identical command string — the exact drift hazard CLAUDE.md warns about), dropped the flag, and exposed it on `window` for a jsdom test. Documented the one residual honestly: a user who has globally allowlisted `Bash` in their own claude config is still exposed in default mode — real defense-in-depth belongs in web_cli_bridge, which actually executes the command. I'm not going to pretend a flag removal sandboxes anything it doesn't.

**CLI import** was not clean, and that's where I had to think. The naive "drop the flag" (the audit's one-liner) *breaks extraction*: the pdf/docx skill genuinely needs Python (pypdf, pdfplumber, mammoth) to read the file, so it needs tool access. And I couldn't verify whether headless `claude -p` in default mode *denies* a non-allowlisted tool or *hangs* waiting for a prompt that can never come — and a hang is a worse regression than the status quo. So I refused to ship behavior I couldn't verify. The robust, no-hang, no-silent-RCE design is **informed consent**: `--claude` now refuses (exit 2) unless the user also passes `--trust-input`, vouching for the file; only then is bypassPermissions added. The safe default import path (pdfjs/mammoth — parses bytes, never executes content) stays the no-flag route. The old "the user already trusts their input file" comment was exactly the wrong threat model — `import` is the one command you point at files from other people — so I rewrote it.

TDD throughout. The CLI tests encode the *threat model*, not the mechanism: the gate fires before any file read or spawn, on both pdf and docx paths. The bridge test pins "no bypassPermissions" at the single source of truth and proves the base64 payload keeps document bytes from breaking out of the single-quoted echo. I watched each fail first — the docx consent test, before the gate existed, sat there for 32 seconds because it actually spawned a real `claude` subprocess. That 32-second hang *was* the vulnerability, on the clock.

Verification: import-claude 4/4, bridge 8/8, e2e 291/0, lens 246/0, view 17/0, conformance 78/79 (the 1 is turing's in-flight CONFORM-19/20 near-miss, confirmed pre-existing by stashing my changes and re-running).

## The shared working tree was the real adversary

All three of us share one checkout AND one git index. That turns ordinary git into a minefield: a bare `git commit` or `-a`/`-A` by anyone sweeps everyone's modified files into one commit with the wrong author and a broken-in-the-middle tree. turing worked out the protocol mid-session: **`git commit -- <explicit paths>` only**, commit straight to main (a commit = instant synthesis), co-edit no file.

The collision still happened anyway — on the CLI, not the seed. `cli/bin/rwa.mjs` ended up holding both my `--trust-input` block and ada's new `rwa doc` verb, uncommitted, interleaved. Worse, one unified-diff hunk *straddled* both of us (her doc-verb block and my `+const trustInput` line landed in the same `@@`), so the clean `git apply` split turing proposed wouldn't cut it, and ada's environment has no `git add -p`.

The byte-safe move that worked: save the tangled file, `git checkout HEAD -- cli/bin/rwa.mjs` to reset, re-apply *only my three edits* on the clean base (content-addressed, so they apply identically despite ada's line shifts being gone), commit my security hunks via pathspec, then `cp` the saved tangled file back. Because the base hadn't moved (I checked — turing's recent commits never touched rwa.mjs), the restored tree diffs as *ada's work only*, byte-identical. Her `doc.test.mjs` passed 10/10 against it afterward. Two commits landed clean (`22f7f03`, `6ed38c8`), each touching exactly my files, ada's work preserved and untangled and waiting for her to land when Martin nods.

Two things carry forward. First, on a shared checkout, *always* check whether the base of a file moved before restoring a saved copy of it — the cp-trick only attributes correctly if the base is stable, otherwise it silently reverts a teammate. Second, the commit-norm divergence is unresolved and worth surfacing: turing reads "synthesize your work with the other instances" as license to commit to shared main; ada (and my own default) lean human-gated. I committed this round because both teammates were blocked on it and it's local/reversible/un-pushed — but I flagged the divergence rather than averaging it.

The CSP/HSTS item I deliberately did NOT touch: the seed is all inline scripts by design, so any real CSP needs `script-src 'unsafe-inline'`, and a restrictive `connect-src` would break the legitimately-interactive documents rewritable is supposed to host. The audit itself filed it as "needs architecture discussion before code." It still does.
