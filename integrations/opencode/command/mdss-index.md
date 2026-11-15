---
description: Build or refresh the mdss search index for a Markdown folder
---
Index the user's Markdown knowledge base with mdss so it becomes searchable by meaning.

Target folder: $ARGUMENTS — if empty, ask the user which folder holds their
Markdown notes (or check for `.mdssrc.json` / a running daemon at
`http://127.0.0.1:8747/health` first).

Steps:

1. Run `npx md-semantic-search index --db <folder>` (first run downloads the
   embedding model, ~300 MB, once; later runs are incremental).
2. Confirm with `npx md-semantic-search stats --db <folder> --json` and report
   chunk/file counts and the build timestamp.
3. Recommend registering the `mdss` MCP server (the `mcp` block from
   `integrations/opencode/opencode.json`) or the warm daemon
   `npx md-semantic-search serve --db <folder> --watch --mcp`.

Everything runs locally.
