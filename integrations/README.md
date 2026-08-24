# Editor & launcher integrations

Each subdirectory is a standalone integration for `mdss serve`
(loopback HTTP daemon). All of them speak the same protocol — see
[`shared/search-client.mjs`](./shared/search-client.mjs) for the canonical
client and [`test/integrations-client.test.mjs`](../../test/integrations-client.test.mjs)
for the pinned contract.

| Integration | Kind | Release automation |
|---|---|---|
| `vscode/` | VS Code extension | Tag `integrations/vscode/vX.Y.Z` → CI builds the VSIX from source, attaches it to a GitHub Release; marketplace publish runs **only** when the repo secret `VSCE_PAT` exists |
| `obsidian/` | Obsidian plugin (BRAT/manual) | Tag `integrations/obsidian/vX.Y.Z` → CI verifies `manifest.json` version, zips plugin files, attaches to a GitHub Release |
| `raycast/` | Raycast extension | Manual store submission (below) |
| `alfred/` | Alfred workflow | Manual packaging (below) |
| `windows/` | Windows tray companion (PowerShell + WinForms) | Manual script — no packaging |

## Releasing VS Code

```bash
# 1. bump integrations/vscode/package.json "version"
git commit -am "chore(vscode): release X.Y.Z"
git tag integrations/vscode/vX.Y.Z && git push origin integrations/vscode/vX.Y.Z
```

CI builds the `.vsix` reproducibly from source. To also publish to the
Marketplace, add a repo secret `VSCE_PAT` (Azure DevOps PAT with
Marketplace → Manage); without the secret the step is skipped with a notice.

## Releasing Obsidian

Same tag flow: `integrations/obsidian/vX.Y.Z`. The workflow checks that
`manifest.json.version` matches the tag and uploads
`mdss-obsidian-X.Y.Z.zip`. Install via BRAT or by unpacking into
`.obsidian/plugins/mdss-obsidian/`.

## Raycast (manual store steps)

1. `cd integrations/raycast && npm install` — develop against a running
   `mdss serve`.
2. Follow the [Raycast publishing guide](https://developers.raycast.com/basics/publish-an-extension):
   fork `raycast/extensions`, copy this folder in, open a PR.
3. After merge, updates ship through the Raycast Store — no repo automation.

## Alfred (manual packaging)

1. Bump the version inside `info.plist` (`version` + `webcontent` keys).
2. `cd integrations/alfred && zip -r mdss.alfredworkflow . -x '.git*'`
3. Attach `mdss.alfredworkflow` to a GitHub Release created manually, or to an
   `integrations/alfred vX.Y.Z` tag using the obsidian job as a template.

## Windows tray companion (`windows/mdss-tray.ps1`)

A zero-dependency system tray icon for `mdss serve`: green = healthy,
yellow = searches in flight, gray = unreachable. Hovering shows chunk count,
model, index age and watch state; a balloon pops whenever the knowledge base
gets re-indexed (`built` timestamp changes). Pure PowerShell + .NET WinForms —
built into Windows, no npm packages added.

```powershell
# attach to an already-running daemon:
powershell -ExecutionPolicy Bypass -File integrations\windows\mdss-tray.ps1

# or let the tray spawn a hidden `mdss serve --watch` (owned by the tray):
powershell -ExecutionPolicy Bypass -File integrations\windows\mdss-tray.ps1 -Db D:\Notes -Launch
```

Menu: Open Web UI / Show status / Start serve (hidden) / Stop serve / Exit.
Headless self-test for scripts and CI: add `-CheckHealth` — prints one status
line, exit 0 when healthy, 1 when unreachable. If the daemon requires auth,
pass `-ApiKey <token>` or set `MDSS_API_KEY`.
