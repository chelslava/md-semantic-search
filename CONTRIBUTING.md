# Contributing to md-semantic-search

Thanks for helping improve **mdss** — a local-first, private semantic search
engine over Markdown. This guide gets you from clone to green tests in a few
minutes and explains the conventions that keep the project healthy.

New here? Look for issues labeled **`good first issue`** — each one is scoped
with concrete files, steps, and test targets.

By participating in this project you agree to abide by the
[Code of Conduct](./CODE_OF_CONDUCT.md).

## Dev setup

Requirements: **Node ≥ 18** and npm. No other toolchain (no native builds — the
embedding runtime is pure ONNX via transformers.js).

```bash
git clone https://github.com/chelslava/md-semantic-search
cd md-semantic-search
npm install

npm run build     # tsc -p tsconfig.build.json → dist/
npm test          # builds first, then runs every node:test suite
```

Useful commands:

| Command | What it does |
|---|---|
| `npm run build` | Compile TypeScript (`src/` → `dist/`) |
| `npm test` | Build + full test suite (`node --test`) |
| `node --test test/<file>.mjs` | Run one suite (after a build) |
| `npm run test:coverage` | Tests with coverage gates: 85% lines / 85% functions / 80% branches |
| `npm run lint` | `tsc --noEmit` over everything + ESLint over `bin/ test/ bench/ scripts/` |
| `npm run docs:build` | Rebuild the docs site content |

Try your build end-to-end against any folder of notes:

```bash
node bin/cli.mjs index  --db /path/to/some/notes
node bin/cli.mjs search --db /path/to/some/notes "your question"
```

First run downloads the embedding model (~280 MB, quantized q8) into the cache
dir; after that everything is offline. CI runs the same gates plus nightly
real-model suites, so keeping local runs green is usually enough.

> Windows note: this repo develops cross-platform and carries a dedicated
> long-path/UNC hardening suite. Keep path handling portable — no hardcoded
> separators, respect the existing path utilities.

## Project tour

A user-facing overview lives in the README ("Architecture & Retrieval
Pipeline"); `docs/architecture.md` sketches the storage layout and ranking
math, and [ARCHITECTURE.md](./ARCHITECTURE.md) is the deeper contributor
internals guide (module map, format spec, extension points). The short
version:

| Area | Where | Notes |
|---|---|---|
| CLI entry | `bin/cli.mjs` | Arg parsing, command dispatch; also `src/completions.ts` generates shell completion tables (a unit test guards flag drift vs the parser) |
| Indexing pipeline | `src/markdown-parser.ts`, `src/frontmatter.ts`, `src/indexer.ts` | AST chunking → typed metadata → incremental build with checkpoints |
| Index formats | `src/index-format.ts`, `src/binary-format.ts` | `vectors.json` envelope + schema validation; `vectors.bin` binary vectors + sha256 sidecar |
| Retrieval | `src/search.ts`, `src/lexical.ts`, `src/ivf.ts`, `src/rerank.ts`, `src/collapse.ts`, `src/filter.ts`, `src/query-cache-disk.ts`, `src/wikilinks.ts`, `src/quantization.ts` | RRF fusion of dense + BM25F + fuzzy; ANN tier; cross-encoder rerank; frontmatter filter DSL |
| Serving & agents | `src/serve.ts`, `src/webui.ts`, `src/watcher.ts`, `src/mcp.ts`, `src/federation.ts`, `src/rag.ts`, `src/tui.ts`, `src/summarize.ts` | HTTP daemon with built-in web UI, watch loop, MCP transports, RAG bridge |
| Models & runtime | `src/models.ts`, `src/providers.ts`, `src/core.ts`, `src/download-progress.ts` | Model adapter registry, external embedders, embedding runtime |
| Editor integrations | `integrations/` | Obsidian plugin, VS Code, Raycast, Alfred |
| Tests & benches | `test/`, `e2e/`, `bench/` | Plain `node:test`; property-based fuzzing via fast-check |

Each source file starts with a header comment describing its role — when the
map above and reality disagree, trust the code and send a docs fix.

## Ground rules

1. **ESM only, Node ≥ 18 APIs.** `"type": "module"` everywhere; no polyfills,
   no build-time bundlers.
2. **Runtime dependencies are frozen by default.** The only runtime dep is
   `@huggingface/transformers`. Propose anything new in an issue first, with a
   strong justification.
3. **Strict TypeScript under `src/`.** Never silence the checker — no
   `as any`, no `@ts-ignore`.
4. **Index-format discipline.** Anything touching persisted formats must bump
   or explicitly handle `schemaVersion`, stay backward-readable, extend loader
   validation, and ship tests. Users' indexes must never break silently.
5. **README is contractual.** Flags, defaults, and documented behaviors must
   match the code. If you change the CLI surface, update README *and* the
   completion tables in `src/completions.ts` (the drift test will remind you).
6. **Security posture is non-negotiable.** The serve/MCP hardening (loopback
   defaults, auth, Host allowlist, rate limits, strict CSP) exists for real
   reasons — see [SECURITY.md](./SECURITY.md). Don't weaken it; report holes
   responsibly instead of opening public issues for them.
7. **Tests accompany changes.** Bugfixes reproduce the failure in a test first;
   features land with suites. Property-based fuzz coverage (fast-check) is very
   welcome for parsers and math helpers.
8. **Commit style:** conventional commits as seen in history —
   `feat(scope): …`, `fix(…): …`, `docs: …`, `perf(…): …`, `chore(ci): …`.

## Submitting changes

1. Fork / branch from `main`; keep PRs small and focused.
2. Run `npm run lint && npm test` locally.
3. Add a `CHANGELOG.md` entry under `## [Unreleased]` (Keep-a-Changelog format;
   reference the issue like existing entries do).
4. Update README/docs for behavior changes; fill in the PR checklist
   (template appears automatically).
5. For larger work, comment on the issue before starting so effort isn't
   duplicated — and comment "I'd like to work on this" on any issue you pick up.

## Reporting bugs

Use the **bug report** template: include `mdss --version`, OS, exact commands,
and stderr. Index problems get much easier with `mdss check --json` output.
For security-sensitive findings, follow [SECURITY.md](./SECURITY.md) rather
than filing a public issue.

## Licensing

By contributing, you agree that your contributions are licensed under the MIT
License that covers this project.
