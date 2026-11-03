# Markdown Semantic Search for VS Code

Official extension for **[md-semantic-search](https://github.com/chelslava/md-semantic-search)** — fast, local, 100% private semantic vector search over Markdown workspace notes.

## Features
- **Semantic QuickPick**: Press `Ctrl+Shift+P` (or `Cmd+Shift+P`), select `MDSS: Semantic Search Notes`, and search documentation by concept, topic, or question.
- **Line & Heading Navigation**: Clicking a search hit opens the exact Markdown file and jumps directly to the matching heading and line number.
- **Sidebar Search View**: Dedicated sidebar panel for persistent interactive querying with live Markdown snippet preview.
- **Ask the notes** (issue #199): the sidebar streams a grounded answer token-by-token over `POST /ask` — start the daemon with `--llm-endpoint` (llama.cpp, LM Studio, vLLM, Ollama) and get cited answers with an optional multi-turn **chat** mode; requests route through the Extension Host, so `mdss.daemonUrl` and the SecretStorage API key apply uniformly.

## Requirements
Ensure the local `mdss serve` daemon is running:
```bash
mdss serve --db ./your-notes
```
