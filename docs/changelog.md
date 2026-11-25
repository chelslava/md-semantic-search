# Changelog

For complete release notes, see [`CHANGELOG.md`](https://github.com/chelslava/md-semantic-search/blob/main/CHANGELOG.md).

### Latest Highlights

- **v3.1.1**:
  - Wikilink graph fixes: a note name shared by several files resolves to the nearest note (own folder first, then the closest ancestor) instead of the alphabetically-first match; path-qualified links work without the `.md` extension, by a unique path suffix and relative to the linking note.
- **v3.1.0**:
  - MCP tool surface 7 → 9: new `facets` (filter-value discovery) and `reindex` (first non-readOnly tool — incremental rebuild under the index lock).
  - Living MCP: `resources/subscribe` on `mdss://status` — watch re-indexes push `notifications/resources/updated`; `chat: true` mints ask sessions server-side; `notifications/progress` on first build.
  - Agent onboarding: `initialize` carries the retrieval-workflow `instructions`; the npm tarball ships the skill pack; `mdss skill` prints it.
  - `search_markdown` tuning parity with `POST /search` (`semanticOnly`, `rerank`, `recency`, `maxPerFile`, `dimensions`); `index_status` reports staleness.
  - Context hygiene: `get_lines` defaults to a 200-line cap with `truncated: true`; tool text is compact JSON.
  - Host-native packaging: ZCode plugin marketplace root, OpenCode templates, Zed/Codex/Gemini CLI snippets; Node 26 in CI and the Docker image.
- **v0.4.0**:
  - Pure-TS Spherical K-Means IVF approximate nearest-neighbour tier (`--ann`, `--nprobe`).
  - Concurrency workers for parallel batch embeddings (`--workers N`).
  - Obsidian live semantic search panel plugin integration.
  - Interactive full-terminal TUI (`mdss -i` / `mdss --interactive`).
  - Knowledge graph relationship extraction and backlink mapping (`extractLinks`, `buildRelationshipGraph`).
  - Standalone dedicated documentation site.
