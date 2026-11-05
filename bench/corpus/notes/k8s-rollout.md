---
title: Kubernetes rollouts
aliases: [deploy pipeline, progressive delivery]
tags: [kubernetes, deploy, release]
type: runbook
status: current
---

# Kubernetes rollouts

## Deployment anatomy

A Deployment drives ReplicaSets; every Pod template change creates a new
Revision. Revisions are kept up to `revisionHistoryLimit` (default 10) so
a rollback is a metadata operation, not a rebuild.

## Rollout strategies

### Rolling update

`maxSurge` controls how many extra Pods may exist during the rollout,
`maxUnavailable` how many may be missing. The default `25%/25%` favors
speed; for a user-facing API set `maxUnavailable: 0` so capacity never
drops mid-roll.

### Canary

A canary splits traffic between the stable and the canary Revision by
label selectors. Start with 5% of replicas, hold, then step up.

#### Analysis gates

Every promotion step must pass an analysis: p99 latency below the
SLO, error ratio under 1%, and no new alert firing on the canary
selector. A failed gate pauses the rollout — it never auto-rolls
forward past a red gate.

#### Traffic shifting

Shift traffic in fixed steps (5 → 25 → 50 → 100%). Each step waits
for the service mesh counters to flush, otherwise the error ratio
reads stale zero.

### Blue-green

Blue-green keeps two full ReplicaSets and flips the Service selector
once. The flip is atomic, but the fleet runs two versions of the image
at the same time — schema migrations must be backward compatible.

## Rollback

### Revision history

`kubectl rollout undo deployment/api` restores the previous Revision.
If more than one bad Revision landed, `--to-revision` pins the exact
one; check `kubectl rollout history` first.

### Database migrations on rollback

Rolling back the app does not roll back the schema. Forward-only
migrations are the policy: a rollback must run against the schema it
was written for, so never bind a migration to the app rollout in one
Job.

## Resource budgets

Requests are the scheduling promise, limits are the throttling bound.
A Pod without requests can starve neighbors; a Pod without limits can
starve the node. Set both, and equalize them for CPU-bound workers.
