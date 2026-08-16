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

Any new high or critical vulnerabilities introduced outside this baseline immediately fail the CI audit build.

---

## Model Security & Custom Model Boundary

When passing custom Hugging Face model IDs or downloading remote ONNX weights, only use models from trusted repositories. Model files are executed locally via ONNX Runtime WebAssembly/Node sessions.
