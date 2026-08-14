# Backup schedule

## Nightly backups

The production database is dumped every night at 02:00 UTC to an
encrypted archive. Retention: 7 daily, 4 weekly, 6 monthly.

## Restore drill

A restore drill runs on the first Monday of every month into a sandbox
cluster. The drill is not a success until the sandbox answers a real
query from the restored data.

## Off-site copy

One weekly archive is copied to a second region. Keep the off-site key
out of the main credentials vault.
