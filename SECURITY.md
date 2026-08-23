# Security Policy

## Reporting Security Vulnerabilities

If you discover a security vulnerability in `md-semantic-search`, please report it by opening a private GitHub Security Advisory or contacting the maintainer directly.

---

## Supply-Chain & Dependency Hygiene

`md-semantic-search` runs fully locally on your machine with no external cloud API calls or remote data transmission.

### Transitive Production Advisories & Baseline

Continuous Integration runs `node scripts/audit-ci.mjs` on every commit to audit production dependencies (`npm audit --omit=dev --json`).

The following known transitive upstream advisories currently exist in third-party ONNX Runtime / Transformers.js dependencies without upstream patch releases:

| Advisory ID | Package | Upstream Parent | Exposure & Mitigation |
|---|---|---|---|
| `GHSA-xcpc-8h2w-3j85` | `adm-zip` (<0.6.0) | `onnxruntime-node` | mdss does not accept or extract untrusted ZIP files. |
| `GHSA-f88m-g3jw-g9cj` | `sharp` (<0.35.0) | `@huggingface/transformers` | mdss does not decode image files. |

These advisories are codified as **dated waivers** in `scripts/audit-ci.mjs`
(issue #122): each carries a `reason` and an `expires` date; an expired waiver
FAILS the audit gate and forces re-triage. Any new high or critical vulnerability
outside this baseline immediately fails the CI audit build, the weekly scheduled
audit sweep (cron in ci.yml), and blocks `npm publish`.

---

## Model Security & Custom Model Boundary

When passing custom Hugging Face model IDs or downloading remote ONNX weights, only use models from trusted repositories. Model files are executed locally via ONNX Runtime WebAssembly/Node sessions.

---

## Path Traversal Guards & Input Validation

- **Path Canonicalization**: `--db` and `--index-dir` inputs resolve to canonical absolute paths (`fs.realpathSync`) and are validated against allowed root directories (current working directory and user homedir by default, or explicitly configured via `MDSS_ROOT_GUARD`).
- **Query Length Cap**: Query strings in `searchIndex` and `POST /search` are capped at 2048 characters to prevent excessive computation or memory consumption.
- **Glob Validation**: `--ignore` and `--path` globs are validated for control or injection characters (such as `|`, `(`, `)`, `$`, `{`, `}`) before RegExp compilation.



