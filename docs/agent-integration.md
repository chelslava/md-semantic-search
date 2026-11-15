# Using mdss with AI agents

`md-semantic-search` gives coding assistants and LLM agents **persistent local
memory**: your Markdown notes, decisions, wikis and docs become searchable by
meaning, citable down to the line, and answerable with grounded RAG — entirely
on-device. Nothing leaves the machine unless you explicitly configure an
opt-in endpoint (`--llm-endpoint`, `--embedder`).

The agent-facing artifact of record is
[`integrations/agent-skill/SKILL.md`](../integrations/agent-skill/SKILL.md) —
drop it into any agent that loads skills (Claude Code style) or paste its
rules into your agent's system prompt. It ships inside the npm package:
`mdss skill` (or `npx md-semantic-search skill`) prints it, and the MCP
server's `initialize` result carries a short `instructions` block teaching
the same workflow to clients that never saw a skill. This page is the human
companion: what to register, what the agent gets, and the honest limitations.

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

Other hosts — the same stdio server:

**Codex CLI** (`~/.codex/config.toml`):

```toml
[mcp_servers.mdss]
command = "npx"
args = ["-y", "md-semantic-search", "mcp"]
env = { "MDSS_DB" = "D:\\Notes" }
```

**Gemini CLI** (`~/.gemini/settings.json` or project `.gemini/settings.json`):

```json
{
  "mcpServers": {
    "mdss": {
      "command": "npx",
      "args": ["-y", "md-semantic-search", "mcp"],
      "env": { "MDSS_DB": "./notes" }
    }
  }
}
```

**Zed** (`~/.config/zed/settings.json`) — see the
[Zed integration analysis](#zed--integration-analysis-issue-275) for why no
Zed extension is needed:

```json
{
  "context_servers": {
    "mdss": {
      "source": "custom",
      "command": "npx",
      "args": ["-y", "md-semantic-search", "mcp"],
      "env": { "MDSS_DB": "./notes" }
    }
  }
}
```

**Universal workflow recipe (any AGENTS.md host — OpenCode, Codex CLI, Gemini
CLI, Zed, …):** the skill pack ships inside the npm package, so one line
teaches the agent the retrieval workflow:

```bash
npx md-semantic-search skill >> AGENTS.md
```

Host-native packaging: a **ZCode plugin** lives in
[`integrations/zcode/`](../integrations/zcode) (a marketplace root bundling
the MCP registration, the agent skill and an `/mdss-index` command) and
**OpenCode** templates in [`integrations/opencode/`](../integrations/opencode)
(the `opencode.json` `mcp` block plus `/mdss-search` and `/mdss-index`
commands and the AGENTS.md recipe).

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

**9 tools** (all `structuredContent`; every one `readOnly`/`idempotent` except `reindex`):

| Tool | Purpose |
|---|---|
| `search_markdown` | hybrid semantic + BM25F + fuzzy search; `path` glob, `tag`/`filter` DSL, `graphBoost`, `k`, plus the `/search` tuning parity: `semanticOnly`, `rerank`/`rerankModel`, `recency`, `maxPerFile`, `dimensions` |
| `get_chunk` | exact section by `file` + `heading` |
| `get_lines` | exact line span (`fromLine`, `maxLines`) — citation-precision reads; an omitted `maxLines` caps at 200 lines and reports `truncated` |
| `related_notes` | graph (outgoing/backlinks/2-hop) + semantic neighbors of a note |
| `facets` | value→count maps for frontmatter fields (`tags`, `type`, `status`, `project`, `custom.<key>`) — the discovery layer behind `filter:` building, same contract as `GET /facets` |
| `list_files` | indexed inventory with chunk counts |
| `index_status` | health: chunk/file counts, model, build timestamp, `ageSeconds`, `stale` |
| `reindex` | **the one mutating tool** (`readOnly: false`): incremental rebuild under the index lock, reloads the served generation, notifies subscribers — the freshness loop for clients without shell access |
| `ask_knowledge_base` | grounded Q&A synthesis with citations; `chat: true` mints a persistent session server-side; uses **client sampling** when the client declares the capability, else the built-in extractive answerer |

**Subscriptions (issue #274):** `resources/subscribe` with `mdss://status` —
the daemon emits `notifications/resources/updated` after every watch
re-index (and the `reindex` tool notifies the same way), so long-lived
agents stop polling `index_status`. Notes are static snapshots and are not
subscribable. First builds also emit `notifications/progress` (best-effort;
stderr stays the universal fallback).

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

## Zed — integration analysis (issue #275)

Zed needs **no extension** to use mdss. Its Agent Panel speaks MCP natively,
and the `context_servers` settings block above registers the same 9 tools the
other hosts get — including `reindex` and the `mdss://status` subscriptions
over the daemon transport. Workflow guidance goes into `AGENTS.md`/`.rules`
(Zed has no skill loader — use the universal
`npx md-semantic-search skill >> AGENTS.md` recipe).

A **native Zed extension** (a Rust crate compiled to WASM against
`zed_extension_api`, distributed through the `zed-industries/extensions`
registry) was analyzed and **deferred**:

- What it could add: install-and-go server lifecycle bundling, a settings
  surface for the notes path, and registry discoverability.
- Why deferred: mdss ships no binaries — `npx` resolves everything at runtime,
  so the extension would be a thin wrapper around a settings block; every
  mdss release would then ride the extension's review/release cycle instead
  of npm; and the `context_servers` path is already one paste. Revisit if the
  Zed extension registry becomes a discovery channel that justifies the
  release coupling.

## Registration in the MCP Registry

The published listing:
[`io.github.chelslava/md-semantic-search`](https://registry.modelcontextprotocol.io)
(npm stdio transport, version-synced with the npm package). Re-publication is
automated per release — see CONTRIBUTING, "Releasing to the MCP Registry".
