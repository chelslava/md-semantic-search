# Raycast extension — MDSS Semantic Notes Search

A [Raycast](https://www.raycast.com) command: live semantic search over your
local Markdown notes via the `mdss serve` daemon, with an inline detail view
and one-keystroke "open note" / "copy snippet".

## Setup

1. Run the daemon:

   ```bash
   mdss serve --db /path/to/notes --watch
   ```

2. Development mode:

   ```bash
   cd integrations/raycast && npm install && npm run dev
   ```

   (Requires the Raycast desktop app; `npm run dev` opens the command in it.)

3. Preferences:

   | Preference | Meaning | Default |
   |---|---|---|
   | Daemon URL | daemon address | `http://127.0.0.1:8747` |
   | API Key | Bearer token when the daemon runs with `--api-key` | unset |

Wire contract is shared with every other launcher via
[`../shared/search-client.mjs`](../shared/search-client.mjs); the pure
request/response helpers live in
[`src/helpers.mjs`](./src/helpers.mjs) and are unit-tested in
[`test/raycast.test.mjs`](../../test/raycast.test.mjs).

## Publishing

Manual store submission — see the parent
[README](../README.md#raycast-manual-store-steps): fork `raycast/extensions`,
copy this folder in, open a PR.
