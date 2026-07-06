# AI Gallery — curated intelligence carriers

`carriers/` holds the downloadable **intelligence carriers** the AI Gallery serves.
Each carrier is a self-contained `skill-host` rewritable that carries a signed
`rwa-agent/1` record (an *intelligence* — `docs/specs/rwa-intelligence-spec.md`,
`intelligence/0.2`). A user drops a carrier onto any rewritable to install its AI,
then activates it from the Activity panel's *Intelligences* section. Because a
carrier is itself a skill-host, the role is already installed in the carrier —
open one and try it directly.

Each was minted with the CLI:

```
node cli/bin/rwa.mjs intelligence new <role> \
  --prompt "<system prompt>" --description "<one-liner>" \
  [--model <id>] [--backend <name>] [--affinity <kind>] \
  --out service/public/ai/carriers/<role>.intelligence.html
```

The carrier ships only the **public key + signature**. The recommended
model/backend and affinity ride *outside* the signed `agent` record (unsigned
envelope fields), so the signature verifies unchanged and the model is only ever
*recommended* (applied to `sessionStorage` behind consent — never a key, never a
base URL).

## The five roles

| Role | Description | Recommended model | Backend | Affinity | Author fingerprint |
|---|---|---|---|---|---|
| `proofreader` | Fixes errors. Never rewrites. | `google/gemini-3.5-flash` | `openrouter` | — | `6974bb8053df731a` |
| `translator` | German ↔ English, tone-preserving. | `google/gemini-3.5-flash` | `openrouter` | — | `96a2b1fb2c481dc6` |
| `presentation-coach` | Sharper slides, one idea each. | `google/gemini-3.5-flash` | `openrouter` | `presentation` | `6f14101570d15ec7` |
| `playful-rewriter` | Adds wit. Keeps the facts. | `google/gemini-3.5-flash` | `openrouter` | — | `1ed40dc7307feefc` |
| `concise-editor` | Tightens prose — shorter sentences, fewer hedges, meaning preserved. | `anthropic/claude-sonnet-4-6` | `openrouter` | — | `8a1063343bc3a89b` |

`concise-editor` is copied from `examples/intelligence-carrier/concise-editor.html`
(the worked example); the other four were minted fresh for the gallery.

## Key custody — the rule

The Ed25519 **private keys never enter this repo.** `rwa intelligence new` writes
each private key to a sibling `<role>.intelligence.key.json` (chmod 0600); those
files are moved immediately to the author's offline store at `~/rwa-gallery-keys/`
and are covered by the repo-root `.gitignore` (`*.key.json`) as a backstop.

Re-signing an update to a carrier — i.e. changing its **record** (system prompt,
description, role, vault namespaces) — requires the matching private key. Without
it, the fingerprint would change and the intelligence would read as a different
author. The `concise-editor` key belongs to the original example author.

## Regeneration

These carriers **embed the seed bootstrap** (they are full rewritables). When the
seed changes, they must be regenerated so the carrier runtime stays current — a
later task wires them into `tools/regenerate-refs.mjs`, which regenerates them
from the seed while **preserving the signed record** (no re-mint, no re-sign; the
record is copied through untouched).

**Only re-mint / re-sign when the RECORD itself changes** (a new system prompt,
description, model recommendation, or affinity) — that needs the matching private
key from `~/rwa-gallery-keys/`. A seed refresh alone never touches the record.
