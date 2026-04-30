# rwa

CLI for [re-write-able](https://github.com/ikangai/rewritable) — emit and import single-file rwa documents.

A re-writeable file is a self-contained `.html` that renders, stores, modifies, and commits itself with no server. Open it in a browser, press `⌘K`, and tell it what to become.

## Install

```sh
npx rewritable --help       # zero-install (one-time cost is the longer name)
npm i -g rewritable         # global; after this, the bin is `rwa` so daily use is `rwa <verb>`
```

Requires Node ≥ 18.

## Usage

```sh
rwa new [path]              # → ./rewritable.html (default)
rwa new my-notes.html       # → ./my-notes.html

rwa import notes.md         # → ./notes.html
rwa import page.html out.html
```

### `rwa new`

Writes a fresh rwa container with a unique per-file `DOC_UUID`, a filename-derived `<title>`, and the seed's "Hello, world." starter content. Press `⌘K` in the browser to make it become anything.

### `rwa import <input> [path]`

Embeds the input file's content as the document's initial state. Supported formats:

- `.md`, `.markdown` — converted via [`marked`](https://marked.js.org/) (GFM enabled)
- `.html`, `.htm` — `<!DOCTYPE>`/`<html>`/`<head>`/`<body>` shells stripped, `<style>` tags retained from `<head>`, body content kept as-is. **`<script>` tags are preserved** (rwa documents support inline JS); a stderr warning is printed when scripts are detected.
- `.txt` — paragraph-split on blank lines, HTML chars escaped

Output defaults to `<input-basename>.html` in the input's directory. Conversion is deterministic and offline — no API key, no network.

### Flags

| Flag | Effect |
|---|---|
| `--force`, `-f` | overwrite the destination if it exists |
| `--version` | print version |
| `--help`, `-h` | usage |

### Exit codes

- `0` — success
- `1` — generic error (read failure, bad seed, etc.)
- `2` — bad arguments / unsupported format / destination conflict

## Design

This CLI is **offline-first**. It ships with its own pinned copy of the bootstrap seed; nothing is fetched from a server. The bootstrap version embedded in any file you create is fixed at the moment of `rwa new` / `rwa import`. To upgrade an existing file's bootstrap to a newer version, see the project's `rwa upgrade` (planned).

The seed and the runtime in any file the CLI emits are byte-identical to the seed used by the hosted service at `rewritable.ikangai.com`. Files emitted by either channel are interchangeable.

## License

MIT
