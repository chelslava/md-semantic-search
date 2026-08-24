# mdss on Windows — tray icon & quick start

Everything in this folder is **zero-dependency**: plain PowerShell + .NET
WinForms that ship with Windows. No npm packages are added beyond mdss itself.

## What you get

- 🟢🟡⚪ a **tray icon** mirroring daemon state: green = healthy, yellow =
  searches in flight, gray = unreachable;
- hover tooltip with **indexing info**: chunk count, model, dimension, index
  age, watch status;
- a **balloon notification** whenever your knowledge base gets re-indexed;
- menu: *Open Web UI* · *Show status* · *Start serve (hidden)* · *Stop serve* ·
  *Exit*.

## Quick start (one command)

```cmd
start-mdss.cmd D:\Notes
```

Double-clickable too. The launcher:

1. checks `http://127.0.0.1:8747/health` — reuses a running daemon if present;
2. otherwise spawns a hidden `mdss serve --db D:\Notes --watch`
   (`mdss` from PATH, or `npx md-semantic-search` as fallback);
3. waits until the model is warm and reports chunk counts;
4. starts the single-instance tray icon.

Open **http://127.0.0.1:8747/** for the search page.

## Manual alternatives

```powershell
# tray only, attached to an already-running daemon:
powershell -ExecutionPolicy Bypass -File integrations\windows\mdss-tray.ps1

# tray that owns its daemon (stops it on Exit):
powershell -ExecutionPolicy Bypass -File integrations\windows\mdss-tray.ps1 -Db D:\Notes -Launch
```

## Autostart at Windows login

Put a one-liner `.vbs` into `Win+R → shell:startup` (hidden window, no console
flash):

```vbscript
' %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\mdss-start.vbs
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""C:\path\to\repo\integrations\windows\Start-Mdss.ps1"" -Db ""D:\Notes""", 0, False
```

The tray is single-instance (named mutex) and the launcher is idempotent, so
autostart + manual runs never duplicate anything.

## Requirements & troubleshooting

| Symptom | Cause / fix |
|---|---|
| `http://127.0.0.1:8747/` shows JSON endpoint list | a **stale daemon** started before the web UI shipped is still in memory — kill the old `node … cli.mjs serve` process and start again; current builds always serve the UI at `/` |
| Tray stays gray | daemon not up yet (cold model load ≈ up to a minute) or wrong port; run `mdss-tray.ps1 -CheckHealth` for the exact status line |
| `401 unauthorized` in logs / no data | daemon uses `--api-key`; pass `-ApiKey <token>` (or set `MDSS_API_KEY`) to both scripts |
| Port busy error on spawn | another daemon already owns the port — the launcher would have reused it; check `netstat -ano | findstr 8747` |
| Two tray icons appear | versions older than v1.0.3 lack the single-instance mutex — update |

Requirements: Node ≥ 18 for the daemon itself; Windows PowerShell 5.1 or newer
(built into Windows 10/11).
