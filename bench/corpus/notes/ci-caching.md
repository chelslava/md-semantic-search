---
title: CI pipeline caching
aliases: [build cache, pipeline speed]
tags: [ci, build, performance]
type: reference
status: current
---

# CI pipeline caching

## Dependency caches

### Package manager stores

pnpm keeps a global content-addressable store; restoring it by key
`pnpm-${{ hashFiles('pnpm-lock.yaml') }}` turns a 90-second install
into a 9-second link. npm needs `~/.npm`, pip needs `~/.cache/pip`,
and each language runner has its own canonical path — restoring the
wrong path silently caches nothing.

### Lockfile-keyed invalidation

Key caches on the lockfile hash, never on the branch name: a lockfile
key survives merges and is shared across pull requests, a branch key
forks the cache and pays the full install on every branch.

## Docker layer caches

### Registry-backed build cache

`docker buildx` can push intermediate layers to a registry with
`--cache-to type=registry` and pull them with `--cache-from`. This
is the only way to share layer caches between ephemeral runners;
local disk caches die with the machine.

### Cache mount vs layer copy

`RUN --mount=type=cache,target=/root/.npm` keeps the package cache
out of the image layers entirely: faster rebuilds and a slimmer
image, at the cost of a cache that only exists on that builder.

## Test result caching

Re-running 40 minutes of integration tests on a docs-only change is
the classic pipeline waste. Path filters skip the job when only
`docs/**` changed, and `--test-output-on-failure` plus per-suite
timings keep the rerun surface small when a real failure does land.

## Cache poisoning

A cache restored from an untrusted fork PR can carry a malicious
build artifact. Scope restore keys to the base repository, and never
let a first-time contributor's build write into the main cache
namespace.
