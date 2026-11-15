---
description: Build or refresh the mdss search index for a Markdown folder
---

Index the user's Markdown knowledge base with mdss so it becomes searchable by meaning.

Target folder: $ARGUMENTS — if empty, ask the user which folder holds their
Markdown notes (or check for `.mdssrc.json` / a running daemon at
`http://127.0.0.1:8747/health` first, as the `mdss-notes-search` skill teaches).

Steps:

1. Run `npx md-semantic-search index --db <folder>` (first run downloads the
   embedding model, ~300 MB, once; every later run is incremental and cheap).
2. Confirm with `npx md-semantic-search stats --db <folder> --json` and report
   chunk/file counts and the build timestamp to the user.
3. If no MCP server is registered yet, tell the user the one-line registration:
   point the `mdss` MCP server (installed with this plugin) at the folder via
   `MDSS_DB`, or run the daemon `npx md-semantic-search serve --db <folder> --watch --mcp`
   for a warm, always-fresh index.

Everything runs locally — never enable `--llm-endpoint`/`--embedder` egress
without asking the user first.
