# Getting Started

**md-semantic-search (`mdss`)** is a fast, local semantic vector search engine and hybrid BM25 search daemon for Markdown notes, personal knowledge bases, and LLM context pipelines.

- **Local-first runtime**: Pure TypeScript engine; the ONNX Runtime dependency ships as prebuilt binaries — no compiler toolchain needed.
- **Privacy-first**: All embeddings run locally — zero cloud API calls or telemetry.
- **Hybrid Retrieval**: Dense vector search + BM25 reciprocal rank fusion (RRF) + cross-encoder reranking.
- **Incremental Caching**: SHA-256 chunk hashes + MD5 file fingerprints ensure instant rebuilds on note changes.

---

## Installation

Requires **Node.js ≥ 18**.

```bash
# Global CLI
npm install -g md-semantic-search

# Or run one-shot with npx
npx md-semantic-search --help
```

Headless server deployment via Docker is covered in [deploy.md](./deploy.md).

---

## 5-Minute Quick Start

### 1. Build an index over your Markdown directory
```bash
mdss index --db ~/Documents/Notes
```

### 2. Search your notes
```bash
mdss search --db ~/Documents/Notes "how to configure database connections in docker"
```

### 3. Run interactive TUI search
```bash
mdss -i --db ~/Documents/Notes
```

### 4. Start local HTTP daemon with live file watching
```bash
mdss serve --db ~/Documents/Notes --watch
```
