# mdss-obsidian

Official Obsidian plugin for **[md-semantic-search (`mdss`)](https://github.com/chelslava/md-semantic-search)** — private, local semantic search inside your Obsidian vault.

## Features

- **Live Semantic Search Panel**: Right-hand sidebar view with debounced real-time queries.
- **Deep Note Navigation**: Clicking a hit opens the note and navigates directly to the matched heading (`note.md#Heading`).
- **Score & Snippet Preview**: Displays cosine relevance score and matching context snippet.
- **Configurable Settings**: Host, port, API key authentication, `k`, cross-encoder reranker, and ANN acceleration toggles.
- **Local & Private**: Searches through your local `mdss serve` daemon — zero cloud dependencies or telemetry.

## Getting Started

1. Start `mdss serve` in your Obsidian vault root:
   ```bash
   npx md-semantic-search serve --watch
   ```
2. In Obsidian:
   - Copy `manifest.json`, `main.js`, and `styles.css` into `<vault>/.obsidian/plugins/mdss-obsidian/`.
   - Enable **Markdown Semantic Search** in **Settings → Community plugins**.
3. Open the search panel from the ribbon search icon or command palette (`Ctrl+P` → *Open semantic search panel*).
