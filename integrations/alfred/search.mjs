#!/usr/bin/env node
/**
 * Alfred Script Filter for MDSS Semantic Search (issue #99).
 * Outputs JSON format consumed by Alfred 5 / Alfred 4 Workflow Script Filter.
 *
 * Issue #230 parity: talks to the daemon through the shared client so
 * `MDSS_DAEMON_URL` and `MDSS_API_KEY` (Bearer auth) behave exactly like the
 * other launchers, and both the legacy bare-array and the current
 * `{results: [...]}` daemon envelopes are accepted.
 */
import { createSearchClient } from '../shared/search-client.mjs';
import { idleItem, noMatchesItem, errorItem, queryFromArgv, toAlfredItems } from './helpers.mjs';

const query = queryFromArgv(process.argv.slice(2));
const daemonUrl = process.env.MDSS_DAEMON_URL || 'http://127.0.0.1:8747';
const apiKey = process.env.MDSS_API_KEY || undefined;

if (!query) {
  process.stdout.write(JSON.stringify(idleItem()));
  process.exit(0);
}

try {
  const client = createSearchClient({ baseUrl: daemonUrl, apiKey });
  const results = await client.search(query, { k: 9 });

  if (!Array.isArray(results) || results.length === 0) {
    process.stdout.write(JSON.stringify(noMatchesItem(query)));
    process.exit(0);
  }

  process.stdout.write(JSON.stringify({ items: toAlfredItems(results) }));
} catch (err) {
  process.stdout.write(JSON.stringify(errorItem(err.message)));
}
