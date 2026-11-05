# Shared daemon client

Single source of truth for the HTTP contract of `mdss serve`, used by every
launcher integration (`vscode/`, `obsidian/`, `alfred/`, `raycast/`).

[`search-client.mjs`](./search-client.mjs) exposes:

- `createSearchClient({ baseUrl, apiKey, fetchImpl })` — `search(query, {k})`
  (accepts both the modern `{results:[...]}` envelope and the legacy bare
  array), `health()`, and `ask(query, {k, sessionId, chat, onFrame, signal})`
  streaming SSE over `POST /ask` (issue #199);
- `extractSseFrames(buffer)` — incremental SSE frame splitter
  (`session`/`sources`/`delta`/`done` frames; CR-normalized);
- `SEARCH_HIT_FIELDS` — the documented hit field list.

Configuration parity across launchers (issue #230):

| Launcher | Daemon URL | API key |
|---|---|---|
| VS Code | `mdss.daemonUrl` setting | `mdss.setApiKey` → SecretStorage (issue #182) |
| Alfred | `MDSS_DAEMON_URL` env | `MDSS_API_KEY` env |
| Raycast | daemonUrl preference | apiKey preference (password field) |

The behavioral contract is pinned by [`test/integrations-client.test.mjs`](../../test/integrations-client.test.mjs).
