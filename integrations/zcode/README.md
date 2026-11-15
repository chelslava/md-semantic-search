# ZCode plugin marketplace root (issue #275)

This directory is a **ZCode plugin marketplace root** for `md-semantic-search`:

```
.claude-plugin/marketplace.json   ← the catalog (lists the `mdss` plugin, source ./mdss)
mdss/                             ← the plugin
  .zcode-plugin/plugin.json       ← manifest: skills + commands + mcpServers
  .mcp.json                       ← the mdss MCP server registration (set MDSS_DB!)
  skills/mdss-notes-search/       ← the agent skill (drift-guarded copy of integrations/agent-skill/SKILL.md)
  commands/mdss-index.md          ← /mdss-index <folder>
  README.md                       ← setup + distribution notes
```

## Install (manual UI steps)

1. Open **Plugin Marketplace → Add → Add Plugin Marketplace** and paste this
   directory's absolute path (e.g. `D:\Repo\md-semantic-search\integrations\zcode`).
2. **Personal → mdss-market → mdss → Install**.
3. Point the bundled MCP server at your notes — the `.mcp.json` ships with no
   `env` block on purpose: set the user-level variable
   `setx MDSS_DB "D:\\Notes"` (recommended; survives plugin updates), or add
   an `env` block to `mdss/.mcp.json` per install, or rely on
   `.mdssrc.json` discovery from the session's working directory.
4. Trial: run `/mdss-index <your notes folder>` — expect the index build
   report (chunk/file counts, build timestamp), then ask a question about your
   notes and expect a cited answer with `file.md#Heading` line references.

See [`mdss/README.md`](./mdss/README.md) for details.
