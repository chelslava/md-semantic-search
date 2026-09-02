/**
 * Markdown Semantic Search (MDSS) — Official VS Code Extension (issue #98).
 */
import * as vscode from 'vscode';
import * as path from 'node:path';

export interface SearchResultItem {
  file: string;
  title: string;
  heading: string;
  score: number;
  cosine: number;
  snippet: string;
  startLine?: number;
}

export function activate(context: vscode.ExtensionContext) {
  // Command 1: QuickPick semantic search across workspace
  const searchCommand = vscode.commands.registerCommand('mdss.search', async () => {
    const query = await vscode.window.showInputBox({
      prompt: 'Search notes by meaning (semantic search)',
      placeHolder: 'e.g. distributed caching and raft consensus',
    });

    if (!query || !query.trim()) return;

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showWarningMessage('No active workspace folder for MDSS note search.');
      return;
    }

    const config = vscode.workspace.getConfiguration('mdss');
    const daemonUrl = config.get<string>('daemonUrl', 'http://127.0.0.1:8747');
    const k = config.get<number>('k', 10);

    try {
      const resp = await fetch(`${daemonUrl}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.trim(), k }),
      });

      if (!resp.ok) {
        throw new Error(`Daemon returned HTTP ${resp.status}`);
      }

      const data = (await resp.json()) as any;
      const results: SearchResultItem[] = Array.isArray(data)
        ? data
        : Array.isArray(data?.results)
          ? data.results
          : [];
      if (!Array.isArray(results) || results.length === 0) {
        vscode.window.showInformationMessage(`No semantic matches for "${query}".`);
        return;
      }

      const quickPickItems: Array<vscode.QuickPickItem & { item: SearchResultItem }> = results.map((r) => ({
        label: `$(markdown) ${r.title} ${r.heading ? `› ${r.heading}` : ''}`,
        description: `[cos: ${(r.cosine ?? r.score ?? 0).toFixed(3)}] ${r.file}`,
        detail: r.snippet,
        item: r,
      }));

      const selected = await vscode.window.showQuickPick(quickPickItems, {
        matchOnDescription: true,
        matchOnDetail: true,
        placeHolder: `Top ${results.length} matches for "${query}"`,
      });

      if (selected) {
        const rootPath = workspaceFolders[0].uri.fsPath;
        const filePath = path.isAbsolute(selected.item.file)
          ? selected.item.file
          : path.join(rootPath, selected.item.file);

        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        const editor = await vscode.window.showTextDocument(doc);

        if (selected.item.startLine !== undefined && selected.item.startLine > 0) {
          const line = Math.max(0, selected.item.startLine - 1);
          const range = new vscode.Range(line, 0, line, 0);
          editor.selection = new vscode.Selection(line, 0, line, 0);
          editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        }
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(
        `MDSS search failed: ${err.message}. Ensure \`mdss serve\` is running at ${daemonUrl}.`
      );
    }
  });

  // Command 2: Rebuild semantic index across workspace
  const indexCommand = vscode.commands.registerCommand('mdss.index', async () => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showWarningMessage('No active workspace folder for MDSS note indexing.');
      return;
    }

    const rootPath = workspaceFolders[0].uri.fsPath;
    const terminal = vscode.window.createTerminal({
      name: 'MDSS Index',
      cwd: rootPath,
    });
    terminal.show();
    terminal.sendText('npx mdss index');
    vscode.window.showInformationMessage('MDSS: Rebuilding semantic index in terminal...');
  });

  // Register Webview View Provider for sidebar
  const sidebarProvider = new MdssSidebarProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('mdss-search-view', sidebarProvider),
    searchCommand,
    indexCommand
  );
}

export class MdssSidebarProvider implements vscode.WebviewViewProvider {
  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this._getHtmlForWebview();
  }

  private _getHtmlForWebview(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: var(--vscode-font-family); padding: 10px; color: var(--vscode-foreground); }
    input { width: 100%; box-sizing: border-box; padding: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 2px; }
    .btn { margin-top: 8px; width: 100%; padding: 6px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; border-radius: 2px; }
    .btn:hover { background: var(--vscode-button-hoverBackground); }
    #results { margin-top: 15px; }
    .hit { padding: 8px; margin-bottom: 8px; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 4px; }
    .hit-title { font-weight: bold; color: var(--vscode-textLink-foreground); }
    .hit-snippet { font-size: 0.9em; opacity: 0.85; margin-top: 4px; }
  </style>
</head>
<body>
  <input id="query" type="text" placeholder="Search Markdown notes by meaning..." />
  <button class="btn" onclick="doSearch()">Search</button>
  <div id="results"></div>
  <script>
    async function doSearch() {
      const q = document.getElementById('query').value;
      if (!q) return;
      const resDiv = document.getElementById('results');
      resDiv.innerHTML = '<p>Searching...</p>';
      try {
        const resp = await fetch('http://127.0.0.1:8747/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: q, k: 8 })
        });
        const raw = await resp.json();
        const items = Array.isArray(raw) ? raw : (Array.isArray(raw?.results) ? raw.results : []);
        if (!items || items.length === 0) {
          resDiv.innerHTML = '<p>No matches found.</p>';
          return;
        }
        resDiv.innerHTML = items.map(h => \`
          <div class="hit">
            <div class="hit-title">\${h.title} \${h.heading ? '› ' + h.heading : ''}</div>
            <div class="hit-snippet">\${h.snippet}</div>
          </div>
        \`).join('');
      } catch (e) {
        resDiv.innerHTML = '<p style="color:red">Failed to connect to mdss daemon.</p>';
      }
    }
  </script>
</body>
</html>`;
  }
}

export function deactivate() {}
