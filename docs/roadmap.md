# Product Roadmap: Towards v1.0.0

`md-semantic-search` has evolved from a single-file script into a hybrid, multi-modal Markdown retrieval engine with pure TypeScript compilation, Spherical K-Means IVF clustering, an official Obsidian plugin, and a dedicated static documentation site.

This document outlines the strategic analysis, architectural milestones, and delivery roadmap leading to the **v1.0.0 LTS (Long-Term Support)** release.

---

## 🎯 Vision & Guiding Principles

1. **100% Local & Zero-Cloud**: No API keys, no telemetry, no cloud vector databases. All computations execute on device.
2. **Native Markdown First**: Full awareness of Markdown semantics — frontmatter YAML, heading hierarchies, code blocks, tables, and Obsidian `[[wikilinks]]`.
3. **Instant Latency & Low Memory**: Cold searches within single-digit milliseconds; memory-efficient vector compression and zero-copy binary indexing.
4. **Frictionless Integration**: Seamless workflows across CLI, TUI, Obsidian, VS Code, MCP (Model Context Protocol), and local LLMs (RAG).

---

## 🗺️ Release Roadmap to v1.0.0

```text
v0.5.0 (Current) ──► v0.6.0 (Graph & Contextual Retrieval)
                          │
                          ▼
                     v0.7.0 (Zero-Copy mmap & Multi-Vault Federation)
                          │
                          ▼
                     v0.8.0 (VS Code & IDE Ecosystem)
                          │
                          ▼
                     v0.9.0 (Local Offline RAG & Synthesis)
                          │
                          ▼
                     v1.0.0 (Production LTS & Spec Freeze)
```

---

### 📍 Milestone 1: v0.6.0 — Graph-Augmented & Contextual Retrieval

**Goal**: Transform lexical + vector retrieval into a connected knowledge-graph search with deep contextual awareness.

- [ ] **Graph-Augmented Ranking (PageRank & 2-Hop Spreading)**:
  - Incorporate Obsidian `[[wikilinks]]` directly into retrieval scoring.
  - Compute in-memory PageRank / link-centrality priors to boost authoritative hub notes.
  - 2-hop neighborhood expansion: surface contextually linked chunks when direct query similarity is borderline.
- [ ] **Contextual Chunker 2.0 (Anthropic-Style Context Injection)**:
  - Prepend document metadata (title, top-level headings, tags) to chunk bodies before embedding to prevent context loss in isolated sub-sections.
  - Protected block parsers: ensure Markdown tables, callout admonitions (`> [!NOTE]`), and fenced code blocks are never split across chunk boundaries.
- [ ] **Rich Frontmatter Filter Expressions**:
  - Expressive query filters: `--filter "tag:engineering AND status != archived AND date >= 2026-01-01"`.

---

### 📍 Milestone 2: v0.7.0 — Zero-Copy Storage & Multi-Vault Federation

**Goal**: Scale horizontally to $500\text{k}+$ chunks with sub-millisecond cold starts and multi-directory support.

- [ ] **Zero-Copy Memory-Mapped Index (`vectors.bin`)**:
  - Binary index format supporting `mmap` / typed array views without JSON parse overhead.
  - Near-instantaneous daemon and CLI startup times on multi-gigabyte vaults.
- [ ] **Scalar & Product Quantization (Int8 / Bit-Vectors)**:
  - Compress Float32 embeddings by $4\times$ (down to 1 byte per dimension) with $<1\%$ loss in nDCG@10.
  - SIMD-accelerated dot product loops for int8 quantization.
- [ ] **Multi-Vault & Workspace Federation**:
  - Aggregate searching across multiple discrete Markdown repositories:
    ```bash
    mdss search --vault ./wiki --vault ./work-notes --vault ./research "query"
    ```

---

### 📍 Milestone 3: v0.8.0 — Ecosystem & IDE Integrations

**Goal**: Bring semantic search to every developer environment and knowledge workspace.

- [ ] **Official VS Code Extension**:
  - Sidebar search panel with markdown syntax highlighting, keyboard shortcuts, and inline passage peek.
  - Command palette quick-open: `MDSS: Semantic Search Notes`.
- [ ] **Desktop Launchers (Raycast / Alfred / Flow Launcher)**:
  - Raycast script commands and extensions for instant OS-level note discovery.
- [ ] **Real-Time Cross-Platform File Watcher**:
  - Zero-polling event integration (`fsevents` on macOS, `ReadDirectoryChangesW` on Windows, `inotify` on Linux) with smart write-burst debouncing.

---

### 📍 Milestone 4: v0.9.0 — Local Offline RAG & Answer Synthesis

**Goal**: Enable private, zero-network question answering and note synthesis directly from the CLI and MCP.

- [ ] **Offline Question Answering (`mdss ask "query"`)**:
  - Integrated local LLM inference via Transformers.js / ONNX Runtime Web or local runners (Ollama / llama.cpp bridge).
  - Accurate citations: synthesizes answers strictly grounded in retrieved chunks with exact file/heading provenance.
- [ ] **Auto-Summarization & Semantic Tagging**:
  - Automatic note summary generation and keyword tagging on index build.
- [ ] **Interactive RAG Mode in TUI**:
  - Chat interface inside the TUI (`mdss tui --rag`) allowing interactive conversation with the vault.

---

### 📍 Milestone 5: v1.0.0 — Production LTS & API Specification Freeze

**Goal**: Enterprise-grade stability, long-term support, and reproducible evaluation.

- [ ] **API & Schema v4 LTS Freeze**:
  - Guaranteed backward compatibility for index formats, CLI arguments, and TypeScript library APIs.
- [ ] **Comprehensive 1M-Chunk Benchmark Suite**:
  - Rigorous latency, RAM, and nDCG@10 evaluation against Qdrant, ChromaDB, and ripgrep on large-scale real-world corpora.
- [ ] **Zero-Vulnerability Production Security Audit**:
  - Upstream dependency hardening and isolated execution sandboxing.
- [ ] **Complete Multi-Language Documentation**:
  - Interactive tutorials, video walkthroughs, and developer SDK documentation.

---

## 📊 Summary of Target Milestones

| Version | Focus Area | Key Deliverables | Estimated Release |
| :--- | :--- | :--- | :--- |
| **v0.6.0** | **Graph & Context** | Wikilink PageRank ranking, Contextual Chunking 2.0, Frontmatter DSL filters | Q3 2026 |
| **v0.7.0** | **Scale & Storage** | Memory-mapped `vectors.bin`, Int8 quantization, Multi-vault federation | Q3 2026 |
| **v0.8.0** | **Integrations** | VS Code extension, Raycast extension, OS-native file watchers | Q4 2026 |
| **v0.9.0** | **Local RAG** | Offline `mdss ask`, Local LLM answer synthesis, TUI Chat | Q4 2026 |
| **v1.0.0** | **LTS Stability** | Schema v4 LTS freeze, 1M chunk benchmarks, Security certification | Q1 2027 |
