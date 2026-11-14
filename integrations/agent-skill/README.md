# Agent skill pack (issue #262)

Teaches AI agents how to use `md-semantic-search` as **persistent local
memory** — hybrid search with line-precision citations and abstention-aware
RAG over the user's Markdown, entirely on-device.

- **[`SKILL.md`](./SKILL.md)** — the agent-consumable recipe (frontmatter
  `name`/`description` + the workflow: search → read → cite, `answerMode`
  semantics, CLI/MCP duality, gotchas). Drop it into any skill-loading agent
  (Claude Code style) or paste its rules into a system prompt.
- **[`docs/agent-integration.md`](../../docs/agent-integration.md)** — the
  human companion: setup paths (stdio MCP, daemon + Streamable HTTP MCP, raw
  HTTP), tool/URI/prompt reference, honest limitations, security notes.

## Contract (drift-guarded)

`test/agent-skill.test.mjs` pins this pack to the real surface: every MCP
tool/URI/prompt name in the docs must exist in `src/mcp.ts`, every `mdss <cmd>`
recipe must exist in `--help`, and the README/npm-keywords links must stay in
place — docs drift fails the build.

## Validation

The recipe was validated end-to-end against the published npm package:
`npx -y md-semantic-search mcp --db <dir>` — `initialize` (protocol
`2025-11-25`), `tools/list` (7 tools), `resources/templates/list`
(`mdss://note/{path}`, `mdss://note/{path}{?fromLine,maxLines}`,
`mdss://vault/{vault}`, `mdss://status`), a real hybrid search whose hits
carry `startLine`/`endLine`, a `get_lines` citation read, and an extractive
`ask_knowledge_base` call with a citation manifest (`answerMode: extractive`).

No packaging or release automation — the pack ships with the repo and the npm
package's repository.
