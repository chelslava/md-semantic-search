---
description: Search the local Markdown knowledge base with mdss (semantic + BM25, citations down to the line)
---
Search the user's local notes for: $ARGUMENTS

Prefer the `mdss` MCP tools when they are registered: `search_markdown` finds
the passages (hits carry `file`, `heading`, `startLine`/`endLine`) →
`get_lines` pulls the exact span → cite as `file.md#Heading` with the line
range. Cite only what a tool actually returned — never from memory.

Without MCP transport, fall back to the CLI:

```bash
npx md-semantic-search search --db <folder> --json "<query>"
```

Everything runs locally; do not enable `--llm-endpoint`/`--embedder` without
asking the user first.
