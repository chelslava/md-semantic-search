# Alfred workflow — MDSS Semantic Search

A [Script Filter](https://www.alfredapp.com/help/workflows/inputs/script-filter/)
for Alfred 4/5: type a query, get semantic matches from your local
`mdss serve` daemon, `↩` opens the note, `⌘Y` quick-looks it, `⌘C` copies the
passage.

## Setup

1. Run the daemon (in any terminal or the Windows tray companion):

   ```bash
   mdss serve --db /path/to/notes --watch
   ```

2. Install the workflow: `zip -r mdss.alfredworkflow . -x '.git*'` from this
   directory, then double-click the archive (or grab it from the latest
   GitHub Release). Requires Node.js ≥ 20 on the machine running Alfred.

3. Configure the keyword in the workflow editor (default: `mdss`).

## Configuration

| Env var | Meaning | Default |
|---|---|---|
| `MDSS_DAEMON_URL` | daemon address | `http://127.0.0.1:8747` |
| `MDSS_API_KEY` | Bearer token when the daemon runs with `--api-key` | unset |

Set them in the workflow's Script Filter object (or a login shell profile —
Alfred inherits the environment Alfred itself was launched with).

The script speaks the same wire contract as every other launcher via
[`../shared/search-client.mjs`](../shared/search-client.mjs) (legacy bare-array
and modern `{results:[...]}` daemon envelopes both accepted). Errors surface
as a result row telling you to start `mdss serve`.

## Packaging

See the parent [README](../README.md#alfred-manual-packaging) — bump
`info.plist`, zip, attach to a release.
