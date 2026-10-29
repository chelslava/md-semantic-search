# Security Policy

## Reporting Security Vulnerabilities

If you discover a security vulnerability in `md-semantic-search`, please report it by opening a private GitHub Security Advisory or contacting the maintainer directly.

---

## Supply-Chain & Dependency Hygiene

`md-semantic-search` runs fully locally on your machine: the default pipeline (local transformers.js embedder, no LLM bridge) makes **no external cloud API calls and transmits no data**. Two explicit opt-in paths can send note content off-machine — see [Data egress](#data-egress-issue-183) below.

### Data egress (issue #183)

| Opt-in | What leaves the machine | Where to | How to stay local |
|---|---|---|---|
| `--embedder openai` (or a non-loopback `--embedder-base-url`, incl. `OLLAMA_HOST`) | request texts — queries and note passages — as embedding input | the configured embeddings endpoint (default `https://api.openai.com/v1/embeddings`) | omit `--embedder` (local transformers.js), or point the embedder at a loopback URL (`http://127.0.0.1:11434` Ollama) |
| `mdss ask --llm-endpoint` / `mdss chat --llm-endpoint` / `--expand hyde` | full RAG context blocks (note contents) + the question, assembled into one prompt; note the documented prompt-injection surface — the LLM receives note text verbatim | the configured chat endpoint (Ollama `/api/generate` or any OpenAI-compatible endpoint) | omit `--llm-endpoint` (extractive answers), or use a loopback endpoint (local Ollama/llama.cpp) |

Behavior:

- The CLI prints a **one-time stderr notice** before the first send naming the destination (`⚠ data egress: … sends NOTE CONTENT to <endpoint>`). Loopback endpoints never trigger it.
- Suppress the notice with `MDSS_NO_EGRESS_WARNING=1` (for scripted/CI use where you have already made the choice).
- Model *downloads* (the local embedder from the Hugging Face hub on first use) are separate: only model files flow in, **no note content ever flows out** on that path.
- `--offline` disables all remote model fetches; combined with the defaults it makes the tool fully air-gapped.

### Transitive Production Advisories & Baseline

Continuous Integration runs `node scripts/audit-ci.mjs` on every commit to audit production dependencies (`npm audit --omit=dev --json`).

The production dependency tree is currently clean (0 known high/critical advisories):
`@huggingface/transformers` 4.3.x pulls `onnxruntime-node` 1.30.x (`adm-zip` ^0.6.0,
resolving the adm-zip advisory baseline) and `sharp` 0.35.5 (resolving the
libvips/libheif/librsvg advisory baseline). No waivers are active.

Any new high or critical vulnerability immediately fails the CI audit build,
the weekly scheduled audit sweep (cron in ci.yml), and blocks `npm publish`.
Re-triage then either upgrades the affected dependency or codifies a **dated
waiver** in `scripts/audit-ci.mjs` (issue #122): each waiver carries a `reason`
and an `expires` date; an expired waiver FAILS the audit gate and forces
conscious re-triage.

---

## Model Security & Custom Model Boundary

When passing custom Hugging Face model IDs or downloading remote ONNX weights, only use models from trusted repositories. Model files are executed locally via ONNX Runtime WebAssembly/Node sessions.

---

## Path Traversal Guards & Input Validation

- **Path Canonicalization**: `--db` and `--index-dir` inputs resolve to canonical absolute paths (`fs.realpathSync`) and are validated against allowed root directories (current working directory and user homedir by default, or explicitly configured via `MDSS_ROOT_GUARD`).
- **Query Length Cap**: Query strings in `searchIndex` and `POST /search` are capped at 2048 characters to prevent excessive computation or memory consumption.
- **Glob Validation**: `--ignore` and `--path` globs are validated for control or injection characters (such as `|`, `(`, `)`, `$`, `{`, `}`) before RegExp compilation.

---

## Config Trust Policy & Supply-Chain Boundaries

`mdss` discovers `.mdssrc.json` hierarchically from the working directory upwards. To protect against malicious repositories checking in hostile configs:
- Project-local configs are restricted from executing commands or loading arbitrary code.
- Keys are partitioned into machine-auditable trust tiers (`local-safe`, `network`, `exec`).
- `mdss check --json` audits config keys and fails on unrecognized or ungoverned keys.
- See [CONTRIBUTING.md](./CONTRIBUTING.md#dev-setup) for policy details.



