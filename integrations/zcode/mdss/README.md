# mdss — ZCode plugin (issue #275)

Bundles `md-semantic-search` as a one-command install for ZCode:

| Component | What it gives the agent |
|---|---|
| `.mcp.json` | the `mdss` MCP server (stdio, `npx -y md-semantic-search mcp`) — 9 tools: hybrid search, line-precision reads, graph neighbors, facets, grounded ask with sampling/abstention, index status, reindex |
| `skills/mdss-notes-search/` | the agent skill pack — the retrieval workflow (search → read → cite), `answerMode` semantics, CLI fallbacks (byte-identical copy of [`integrations/agent-skill/SKILL.md`](../../agent-skill/SKILL.md), drift-guarded by `test/agent-skill.test.mjs`) |
| `commands/mdss-index.md` | `/mdss-index <folder>` — build/refresh the index and report stats |

## Setup

The MCP server needs to know where the notes live. In order of precedence:

1. **User environment variable (recommended — survives plugin updates)**:
   `setx MDSS_DB "D:\\Notes"` (Windows) or `export MDSS_DB=...` (Unix). The
   bundled `.mcp.json` deliberately carries no `env` block, so the server
   inherits it — a marketplace refresh/reinstall never loses the path.
2. **Per-install pin**: add an `env` block in `.mcp.json` —
   `"env": { "MDSS_DB": "D:\\Notes" }` (Windows paths need escaped
   backslashes in JSON). Note this overrides the environment variable and is
   overwritten by plugin updates.
3. **Config discovery**: with neither set, mdss discovers `.mdssrc.json`
   upward from the session's working directory.

The first `mdss` call downloads the embedding model (~300 MB) once, then
everything stays local and offline.

## Distribution

`integrations/zcode/` is a ZCode marketplace root (`.claude-plugin/marketplace.json`
lists the `mdss` plugin with `source: ./mdss`). Add the folder as a local
plugin marketplace in ZCode (**Plugin Marketplace → Add → Add Plugin
Marketplace**), install `mdss` from it, then try `/mdss-index <your notes
folder>`. The marketplace entry's version follows `.zcode-plugin/plugin.json`.

For a public marketplace later, publish this root the same way — the plugin
has no build step and no binaries; everything resolves through npx at runtime.
