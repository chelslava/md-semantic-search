# Database failover

## Failover runbook

1. Check replication lag on the standby.
2. Promote the standby with `pg_ctl promote`.
3. Re-point the application connection string to the new primary.
4. Verify writes before announcing recovery.
5. Demote the old primary to standby and rejoin the replica set.

## Read-only mode

During failover, route reads to the replica and reject writes with a
clear 503. Never half-write to two primaries.

## Split-brain avoidance

Only one node may accept writes at a time. Use a fencing token or a
lease that expires, never a manual flag.
