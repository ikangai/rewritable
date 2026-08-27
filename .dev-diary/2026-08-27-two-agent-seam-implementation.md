# Building the two-agent seam

*2026-08-27, agent-191. Implementation of Epic #43 — the fourteen issues that came out of the morning's agent-surface audit. Branch `feat/two-agent-seam`, 14 commits, not on main, not pushed.*

## What this was

The audit earlier today found that the agent surface was built for the model *inside* the container, not the agent *outside* it. The operator then reframed it, correctly: it isn't one agent using a file, it's **two agents dividing one job** — the external one supplies model, key, task and world context; the internal `rwa-agent/1` supplies the document, the render, the invariants and the kind framing. Neither is redundant. The audit was re-pitched around that, filed as thirteen issues, and this is the build.

Everything shipped. One issue (#38) is half-shipped and deliberately still open; one new issue (#44) was found mid-build, filed, and then also closed.

## The order mattered more than I expected

Phase 1 was the return channel, and it turned out to be load-bearing in a way I hadn't planned for. `rwa edit --json` gained a success object (#30) — mostly so a delegating agent could confirm what happened without re-reading. But the `bodyHash` it introduced became the staleness token for #31's compare-and-swap, then the identity `rwa doc` reports, then the thing #34's outline carries, then a field in #39's audit log where the hashes **chain** and the last one equals the file's current body. One decision, made for a small reason, ended up being what four later features hang off.

The decision that made that work was insisting the hash be *the same definition the hosted runtime already used*. Two independently-written functions now have to agree, so `service/tests/hash-parity.test.mjs` pins it across CRLF, NFD, image-bearing and frozen-zone bodies. Without that, every cross-surface staleness check would silently have become a coin flip — each surface self-consistent, and wrong about the other.

## Where the tests fought back, correctly

Three times a gate caught something I'd have shipped.

**The vendored-apply byte-identity gate (#32).** Backfilling `data-rwa-id` broke it instantly, because block ids are random and two runs mint different ones. The tempting fix was to normalise ids away and weaken the gate. The right fix was `opts.rand` — injectable randomness — which made the comparison *stricter* than before: identical logic must now produce identical bytes, ids included. Where no shared RNG can cross a boundary (the hosted `/modify` parity test, conformance HOST-01), ids are normalised with the reason recorded, and the hosted test gained a negative control so a silently-absent backfill can't read as agreement.

**The exit-code guard (#38).** Adding exit 6 for `rwa render` failed a test asserting all `CliError` codes were in 0–4 — beside a `codeName` I had already extended. The guard was asserting a stale copy of the answer. It now reads the allowed set *out of* `codeName`, keeping the real invariant (the two agree) and dropping the false one (there are exactly five codes).

**The image-assets suite (#33).** My first `virtual_form_mismatch` guard was too broad: it flagged tokens in `replace` as well as `find`. The existing test for "introducing a NEW rwa-asset token without bytes rejects" failed, which was exactly right — an unknown token in `replace` is the caller *inventing* an image, which `assertNoNewAssetTokens` already rejects with a better message. Only an anchor can tell you which projection was read. The guard is `find`-only now, with two false-positive controls.

## The keystone was smaller than it looked

#36 — back-delegation with real multi-turn tool use — read like the big architectural item. It wasn't, and finding out why was the most useful hour of the day.

Back-delegation was already shipped, twice: `bridge` and `bridge-session` have been first-class settings choices in the seed for months. And four places in the seed explicitly refuse them:

```js
// L1 needs a multi-turn tool-use backend. bridge / bridge-session are
// single-shot, so fall back to deterministic theme-only (L0)
if (!recipe || cfg.kind === 'bridge' || cfg.kind === 'bridge-session')
```

So it was never blocked by architecture. It was blocked by **transport**: `claude -p` returns text, not a tool-use stream. `rwa proxy --agent` is a translator — OpenAI-compatible toward the container, agent-native toward the local agent, synthesizing genuine `tool_calls`. The container sees an ordinary local backend, `cfg.kind` is `'ollama'`, and the guards simply stop applying. **Zero seed changes.**

Multi-turn falls out of it for free, which I didn't anticipate. `claude -p` is stateless, but the *container* drives the loop and re-sends the whole `messages` array each turn, including the `tool` role carrying a structured apply failure. Rendering that history back into the prompt *is* the multi-turn support. There's no session to keep.

I verified it against the real container over a real HTTP round trip — jsdom booting the seed, Node's `fetch`, a listening proxy — rather than stubbing `fetch`. Stubbing would only have proved my handler returns the right shape, not that the container accepts it. The agent's first answer is deliberately wrong, so the apply fails, the container feeds the failure back, and the agent corrects itself. And skin L1 lands the agent's `sk-*` wrapper instead of degrading to theme-only, which is the whole point made literal.

## What I refused to build

**`invoke` (#38's other half).** The issue assumed `rwa run` was a missing *door*. It isn't — there's no callable behind the door either. Compute affordances are registered as declarations: `{kind:'compute', name, label}`. A name and a label, no function. Only `view` providers carry executable `render()`. So `describe()` advertises compute affordances with **no invocation contract anywhere**, not merely no CLI entry point.

Building `rwa run` today would mean inventing that contract inside a CLI verb — a substrate decision in the wrong layer, producing a shape the seed doesn't honour. It needs a spec decision on `compute spec.run(args)`, then a `runtime.invoke()` dispatcher obeying the modify mutex, and only then a thin verb. #38 stays open with that recorded.

The render half *is* built, and it closes the other finding: an outside agent authoring a document was permanently blind to it.

## Two design calls I want on the record

**Where the audit log lives (#39).** Three options were real. An in-`INLINE_DOC` frozen zone works mechanically — it's exactly how skills and agents persist — but the cost *compounds*: `replace_document` must reproduce every frozen zone byte-identically, so the escape hatch would have to echo the entire audit log, growing with the document's age, on every wholesale rewrite. A frozen-head element breaks "the bootstrap is byte-identical except for `INLINE_DOC` contents". So: a sidecar, using the same record shape the hosted runtime already writes. The honest cost is stated in the help and the module — the log doesn't travel with the file.

**Stop hand-vendoring the skill (#42).** Before touching anything I measured: six of nine vendored modules and the seed had drifted, three weeks after the last careful re-vendor. #18 had already tried a better copy discipline for the three in-repo seed copies; this was the fourth copy it never reached. The answer isn't a better procedure — it's to stop copying. The repo owns the skill's own files; everything vendored is generated. Building it immediately surfaced that `rwa-lite`'s read door lagged the CLI by the entire epic — no `baseHash`, no `--outline`, no `--virtual`, silent success. Now that the glue is repo-owned, that got fixed too.

## The thing I nearly missed

#44 exists because #36's end-to-end test failed in a way I almost dismissed. The CLI returned `find_not_found` where the container, over the same backend in the same test, recovered on a second turn. `runAgentLoop` returned on the first *parseable envelope* and never fed *apply* failures back — so the retry budget of 3 only ever covered envelope-extraction problems.

Which means `findClosestAnchor` and the entire `FAILURE_HINTS` table — built precisely so a model can fix its own anchor in one retry — had **no consumer at all** on the CLI path. Two features quietly doing nothing, on the surface the epic had just made primary. Filed rather than smuggled into #36, then built: opt-in `apply` callback, exit-3 failures only, document untouched between attempts, and budget exhaustion reporting the last *real* failure rather than a generic one.

## Two traps worth remembering

`spawnSync` **deadlocks** against a mock backend running in the same process — it blocks the event loop, so the server can never answer. It looks exactly like a product hang, and it cost me two debugging rounds across #39 and #44. Both test files now say so beside the async spawn.

And unescaped backticks inside the `HELP` template literal are a syntax error that surfaces as *every test failing at ~40ms* — a cascade with no obvious cause. `node -c cli/bin/rwa.mjs` after every help edit.

## Where it stands

14 commits on `feat/two-agent-seam`, 71 files, +6,669/−406. All six CI-job equivalents green: root 60 files / 1,810 assertions, CLI 712, service 115, browser 14 + 21 + 12 + 8, conformance 86/86, plus trajectory, import-fidelity and the new agent-surface ratchets. References in sync, `cli/seeds` refreshed, `service/lib` re-vendored, skill built and current.

Not pushed, not merged, not deployed. The seed changed (agent banner, provenance sentence, affordance vocabulary), so prod will want a redeploy whenever this lands.
