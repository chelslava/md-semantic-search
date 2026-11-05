---
title: Redis persistence
aliases: [rdb aof, redis durability]
tags: [redis, storage]
type: reference
status: current
---

# Redis persistence

## Snapshotting (RDB)

RDB writes a compact binary snapshot of the dataset on a schedule —
`save 900 1` means: after 900 seconds, if at least 1 key changed. A
fork performs the dump, so the main process only pays copy-on-write
memory during the save.

## Append-only file (AOF)

### Durability modes

`appendfsync always` fsyncs every write — safest, slowest.
`appendfsync everysec` batches fsyncs once per second: the default,
which can lose the last second on a crash. `appendfsync no` leaves
the timing to the OS.

### Rewrite

The AOF grows forever as the same keys are overwritten, so Redis
rewrites it: a fork builds a minimal command log from the current
dataset while new writes buffer into an `aof-rewrite-incremental-
fsync` tail. `auto-aof-rewrite-percentage 100` triggers a rewrite
when the file doubles since the last one.

## Replication interaction

Replicas apply the master's replication stream; persistence is a
master-side concern. A failover to a replica with persistence
disabled replays an empty dataset — always enable RDB or AOF on
replicas too, they become masters after a failover.

## Restoring

Stop Redis, replace `dump.rdb` (or the AOF files), start again. A
corrupt RDB loads until the first bad offset; `redis-check-rdb`
reports the exact damage before you decide between truncation and a
restore from backup.
