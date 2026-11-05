---
title: Postgres vacuum and bloat
aliases: [autovacuum tuning, table bloat]
tags: [postgres, maintenance]
type: reference
status: current
---

# Postgres vacuum and bloat

## Why vacuum exists

UPDATE and DELETE leave dead tuples behind; VACUUM reclaims the space
for reuse. It does not return space to the OS — only VACUUM FULL does,
and it takes an exclusive lock, so it is a maintenance-window tool.

## Autovacuum

### Trigger thresholds

A table is autovacuumed after `autovacuum_vacuum_threshold` plus
`autovacuum_vacuum_scale_factor` × row count dead tuples. For a
50-million-row table the default 20% scale factor means 10 million
dead tuples before the first pass — per-table overrides exist for a
reason.

### Cost limiting

Autovacuum throttles itself with a cost budget so it does not crowd
out production queries. Raising `autovacuum_vacuum_cost_limit` makes
vacuum faster and louder; raising `autovacuum_vacuum_cost_delay`
stretches it quieter and longer.

## Bloat diagnosis

### Estimating dead tuples

`pg_stat_user_tables` gives `n_dead_tup` from statistics; the
`pgstattuple` extension measures it exactly but scans the whole
relation. Start with the estimate, confirm with pgstattuple only on
the suspects.

### Wraparound pressure

Transaction ID wraparound is the emergency that makes vacuum
non-optional: when `age(datfrozenxid)` approaches 2 billion, Postgres
stops accepting writes. Monitor the oldest xid; aggressive vacuum on
the largest tables is the standard response.

## Long-running transactions

An idle-in-transaction session pins the xmin horizon: vacuum cannot
advance past it and dead tuples accumulate everywhere. Kill sessions
older than an hour with `pg_terminate_backend`; `idle_in_transaction_
session_timeout` prevents the recurrence.
