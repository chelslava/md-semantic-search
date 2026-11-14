# Using mdss with AI agents

`md-semantic-search` gives coding assistants and LLM agents **persistent local
memory**: your Markdown notes, decisions, wikis and docs become searchable by
meaning, citable down to the line, and answerable with grounded RAG — entirely
on-device. Nothing leaves the machine unless you explicitly configure an
opt-in endpoint (`--llm-endpoint`, `--embedder`).

The agent-facing artifact of record is
[`integrations/agent-skill/SKILL.md`](../integrations/agent-skill/SKILL.md) —
drop it into any agent that loads skills (Claude Code style) or paste its
rules into your agent's system prompt. This page is the human companion:
what to register, what the agent gets, and the honest limitations.

## Setup paths (pick one)

| Path | When | Cost per query |
|---|---|---|
| **A. stdio MCP** (`mdss mcp`) | personal use, one agent, no daemon wanted | model loads per invocation — fine for occasional queries |
| **B. daemon + HTTP MCP** (`mdss serve --watch --mcp`) | heavy agent use, live re-indexing wanted | milliseconds — model and index stay warm |
| **C. raw HTTP** (`/search`, `/ask`, `/facets`, `/related`) | custom agents, scripts, non-MCP clients | milliseconds — same daemon |

### A. stdio MCP (default transport)

Claude Code:

```bash
claude mcp add mdss -- npx -y md-semantic-search mcp --db "D:\Notes"
```

Project-scoped `.mcp.json` (Claude Code, Cline, and most MCP clients):

```json
{
  "mcpServers": {
    "mdss": {
      "command": "npx",
      "args": ["-y", "md-semantic-search", "mcp", "--db", "./notes"]
    }
  }
}
```

Claude Desktop and Cursor configs are in the
[README MCP section](../README.md#4-mcp-server-claude-desktop-cursor-copilot-antigravity).

### B. daemon + Streamable HTTP MCP

```bash
mdss serve --db D:\Notes --watch --mcp          # loopback 127.0.0.1:8747
```

Point an MCP-capable client that speaks HTTP transports at `http://127.0.0.1:8747/mcp`
(POST JSON-RPC, SSE on GET, `Mcp-Session-Id` sessions). The mount sits behind
the same auth, Host-allowlist, CSRF and rate-limit gates as `/search`; for
LAN/remote exposure see [Securing remote deployments](#securing-remote-deployments).

### C. raw HTTP for custom agents

```bash
curl -s http://127.0.0.1:8747/search -H "Content-Type: application/json" \
  -d '{"query":"why did we reject worker_threads","k":5,"maxPerDoc":2}'
```

Response hits carry `file`, `title`, `heading`, `snippet`, `score` and
`startLine`/`endLine` — everything needed for verifiable citations.
`POST /ask` streams an SSE RAG answer (`sources` → `delta` → `done`) with a
citation manifest. `GET /facets` returns tag/type/status value counts for
building filter chips. Full reference: [docs/api-reference.md](api-reference.md).

## What the agent gets

**7 tools** (all `readOnly`, `idempotent`, `structuredContent`):

| Tool | Purpose |
|---|---|
| `search_markdown` | hybrid semantic + BM25F + fuzzy search; `path` glob, `tag`/`filter` DSL, `graphBoost`, `k` |
| `get_chunk` | exact section by `file` + `heading` |
| `get_lines` | exact line span (`fromLine`, `maxLines`) — citation-precision reads |
| `related_notes` | graph (outgoing/backlinks/2-hop) + semantic neighbors of a note |
| `list_files` | indexed inventory with chunk counts |
| `index_status` | health: chunk count, model, staleness |
| `ask_knowledge_base` | grounded Q&A synthesis with citations; uses **client sampling** when the client declares the capability (answer written by the client's own model), else the built-in extractive answerer |

**Resources:** `mdss://note/{path}`, `mdss://note/{path}?fromLine=1&maxLines=50`,
`mdss://vault/{vault}`, `mdss://status`.
**Prompts:** `search-and-cite`, `summarize-note`, `compare-notes`,
`find-contradictions`, `timeline`.

## Patterns that work

1. **Search → read → cite.** `search_markdown` finds the passage;
   `get_lines` pulls the exact span; cite `file.md#Heading` with the line
   range. Never cite from memory.
2. **Trust `answerMode`.** `ask_knowledge_base` returns `sampling`,
   `extractive` or **`abstained`**. `abstained` means no passage carried real
   support — the honest move is "your notes don't cover this", not an
   invented answer (the extractive answerer already refuses by design).
3. **Graph before deep dive.** `related_notes` on a promising hit surfaces
   backlinks and 2-hop neighbors — cheaper than three speculative searches.
4. **Staleness check.** `index_status` reports the build timestamp; if the
   user edited notes since, re-index (`mdss index --db …`) or run the daemon
   with `--watch`.

## Honest limitations

- **Snapshot semantics** — unindexed edits are invisible; `--watch` closes the gap.
- **Multilingual by design** — the default embedder
  (`granite-multilingual-311m`) is RU/EN-strong and cross-lingual; other
  models trade quality/size (`mdss models`).
- **No writes** — mdss is read-only retrieval; agents never mutate notes.
- **Egress is opt-in and loud** — the CLI prints a one-time stderr banner
  before the first content-bearing request to `--llm-endpoint`/`--embedder`
  (see SECURITY.md, "Data egress").

## Securing remote deployments

The daemon binds loopback by default. For team/LAN exposure:
`--host <ip>` **requires** `--api-key-file <path>` (the server refuses to
start otherwise), plus `--trust-proxy <ip|cidr>` behind a reverse proxy for
per-client rate limiting. See [Securing remote deployments](../README.md#securing-remote-deployments)
and [SECURITY.md](../SECURITY.md).

## Registration in the MCP Registry

The published listing:
[`io.github.chelslava/md-semantic-search`](https://registry.modelcontextprotocol.io)
(npm stdio transport, version-synced with the npm package). Re-publication is
automated per release — see CONTRIBUTING, "Releasing to the MCP Registry".
