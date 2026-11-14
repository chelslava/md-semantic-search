---
name: mdss-notes-search
description: Search, cite and ask over the user's local Markdown knowledge base with mdss (hybrid semantic + BM25F retrieval, MCP tools and CLI). Use when the user asks about their notes, docs, decisions, wikis, or wants grounded answers from their own knowledge base — nothing leaves the machine.
---

# mdss — searching the user's local Markdown knowledge base

`md-semantic-search` (CLI: `mdss`) indexes the user's Markdown folders into a
local hybrid retrieval engine (dense embeddings + BM25F + fuzzy → RRF fusion,
ANN, optional reranker) and exposes it to agents over MCP and HTTP. Everything
runs on-device: no cloud, no API keys, no data egress by default.

## First steps in a session

1. Find the knowledge base directory (ask the user, or look for `.mdssrc.json`
   / an already-running daemon: `curl http://127.0.0.1:8747/health`).
2. Check what is indexed — `index_status` (MCP) or `mdss stats --json --db <dir>`:
   chunk count, model, staleness.
3. If nothing is indexed yet: `mdss index --db <dir>` (first run downloads the
   embedding model once, ~300 MB; every later run is incremental).

## Prefer MCP when the client provides it

If the client registered the `md-semantic-search` MCP server (registration
snippets: `docs/agent-integration.md`), use the tools instead of the CLI:

| Task | Tool |
|---|---|
| Find passages by meaning or keyword | `search_markdown` (`query`, `k`, `path` glob, `tag`/`filter`, `graphBoost`) |
| Read one section | `get_chunk` (`file` + `heading`) |
| Read exact lines (cite-precision) | `get_lines` (`file`, `fromLine`, `maxLines`) |
| Explore the graph around a note | `related_notes` (`file`, `direction`, `semantic`) |
| Inventory / health | `list_files`, `index_status` |
| Grounded answer with citations | `ask_knowledge_base` (`query`) |

Resources: `mdss://note/{path}` (full note), `mdss://note/{path}?fromLine=N&maxLines=M`,
`mdss://vault/{vault}`, `mdss://status`. Prompts: `search-and-cite`,
`summarize-note`, `compare-notes`, `find-contradictions`, `timeline`.

## CLI equivalents (when there is no MCP transport)

```bash
mdss search "how do we rotate the API keys" --db D:\Notes --json
mdss search "rotate API keys" --db D:\Notes --open 1      # jump to the line
mdss ask "what did we decide about rate limiting?" --db D:\Notes
mdss related docs/adr-007.md --db D:\Notes
mdss serve --db D:\Notes --watch --mcp                     # daemon + MCP over HTTP
```

## Citation discipline (do this every time)

- Cite as `file.md#Heading` (or `mdss://note/file.md` for resource-aware
  clients). Search hits carry `startLine`/`endLine` — quote them for
  verifiable references.
- Cite only passages you actually received from a tool result. Never attach
  citations from memory.

## Ask semantics — respect `answerMode`

`ask_knowledge_base` / `mdss ask` ground the answer in retrieved passages:

- `answerMode: "sampling"` — your own model (client sampling) wrote the
  synthesis from the grounded passages; keep the returned citations.
- `answerMode: "extractive"` — the built-in extractive answerer selected
  sentences from the notes.
- `answerMode: "abstained"` — **no passage carried real support**. The correct
  behavior is to tell the user "your notes don't cover this" and offer to
  search with different terms — never fabricate an answer or citations.

## Honesty constraints

- The index is a snapshot: notes edited after the last `mdss index` are not
  searchable yet (a running `mdss serve --watch` keeps it fresh).
- Retrieval is hybrid (dense + BM25F + fuzzy); exact identifiers (API names,
  error codes) are covered by the lexical channel — quote them verbatim in the
  query when relevant.
- Everything stays local. Only opt-in flags (`--llm-endpoint`, `--embedder`,
  `--hyde`) send note content to an endpoint the user configured explicitly;
  do not enable them without asking.

## Gotchas

- Windows paths in configs need escaped backslashes (`D:\\Notes`) in JSON.
- `--db` may point anywhere on disk; vault names in `mdss://vault/{vault}`
  resolve inside the daemon's trust domain only.
- For a long-running session prefer the daemon (`mdss serve --watch --mcp`):
  the model stays warm and queries are milliseconds instead of model-load
  seconds.
