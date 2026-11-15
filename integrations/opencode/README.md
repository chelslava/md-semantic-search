# OpenCode integration (issue #275)

Two artifacts, both copy-in:

| File | Where it goes |
|---|---|
| [`opencode.json`](./opencode.json) | merge the `mcp` block into your project `opencode.json` or global `~/.config/opencode/opencode.json`; set `MDSS_DB` to the real notes folder (absolute path recommended) |
| [`command/mdss-search.md`](./command/mdss-search.md), [`command/mdss-index.md`](./command/mdss-index.md) | copy into your project's `.opencode/command/` — the filenames become the `/mdss-search` and `/mdss-index` commands |

## Workflow guidance (AGENTS.md)

OpenCode has no skill loader — put the retrieval rules into `AGENTS.md`.
The skill pack ships inside the npm package, so one line appends it:

```bash
npx md-semantic-search skill >> AGENTS.md
```

That teaches the agent the search → read → cite workflow, `answerMode`
semantics (`abstained` = say the notes don't cover it) and the CLI fallbacks.

## Notes

- The first `mdss` call downloads the embedding model (~300 MB) once; every
  later run is local and offline.
- For heavy sessions prefer the warm daemon:
  `npx md-semantic-search serve --db <folder> --watch --mcp` — the index stays
  fresh and queries are milliseconds. It also enables MCP subscriptions
  (`notifications/resources/updated` on re-index, issue #274).
- The `mcp` block is the whole integration — the 9 tools (search, line reads,
  graph, facets, grounded ask with client-side sampling, status, reindex) come
  from the same server Claude Code and Zed register.
