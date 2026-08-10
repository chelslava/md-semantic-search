# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately through
[GitHub Security Advisories](https://github.com/chelslava/md-semantic-search/security/advisories/new).
Do not include exploit details in a public issue before a fix is available.

## Known dependency advisories

As of 2026-08-10, `npm audit --omit=dev` reports four high-severity findings in
the production dependency tree of `@huggingface/transformers@4.2.0`. npm reports
no compatible automatic fix. CI runs the audit as a non-blocking reporting job
until upstream publishes dependency ranges compatible with this project's Node
18 minimum.

### `adm-zip@0.5.18`

- Advisory: [GHSA-xcpc-8h2w-3j85](https://github.com/advisories/GHSA-xcpc-8h2w-3j85)
- Impact: a crafted ZIP can trigger a multi-gigabyte allocation and denial of
  service.
- Exposure: mdss does not accept or extract user-supplied ZIP archives. The
  package is transitive through `onnxruntime-node` and is used while obtaining
  native runtime artifacts, so the remaining risk is a compromised upstream
  artifact or model supply chain rather than Markdown input.
- Remediation status: fixed in `adm-zip@0.6.0`, but current
  `onnxruntime-node` releases still request the `0.5.x` range. A root override
  would exceed the upstream compatibility contract and is not applied without
  upstream support and real-model regression testing.

### `sharp@0.34.5`

- Advisory: [GHSA-f88m-g3jw-g9cj](https://github.com/lovell/sharp/security/advisories/GHSA-f88m-g3jw-g9cj)
- Impact: inherited libvips vulnerabilities affect malformed image decoding.
- Exposure: mdss indexes Markdown text and does not decode image contents. The
  vulnerable code path is not reachable through the current CLI or HTTP API.
- Remediation status: fixed in `sharp@0.35.0` and later, which require Node
  20.9 or later. Forcing that version would violate the documented Node 18
  support contract.

## Mitigations

- Prefer registry model aliases and pin custom model revisions with
  `--model id@revision`.
- Warm the model cache from a trusted network, then use `--offline` or
  `MDSS_OFFLINE=1` in sensitive environments.
- Review the non-blocking `audit` CI job after dependency updates. Issue #17
  remains open until the production dependency tree has no high findings.
