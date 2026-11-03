/**
 * Markdown Semantic Search (MDSS) — Official VS Code Extension (issue #98).
 *
 * Sidebar search runs through the Extension Host via postMessage (issue #165):
 * the webview never talks to the daemon directly, so `mdss.daemonUrl` and
 * `mdss.apiKey` apply uniformly, and all rendered result fields are HTML-
 * escaped to prevent stored XSS from note content.
 */
import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import * as path from 'node:path';

export const API_KEY_SECRET = 'mdss.apiKey';

export interface SearchResultItem {
  file: string;
  title: string;
  heading: string;
  score: number;
  cosine: number;
  snippet: string;
  startLine?: number;
}

/** Accepts both a bare result array and the `{ results }` envelope (issue #151). */
export function unwrapSearchEnvelope(data: unknown): SearchResultItem[] {
  if (Array.isArray(data)) return data as SearchResultItem[];
  if (data !== null && typeof data === 'object' && Array.isArray((data as any)?.results)) {
    return (data as any).results as SearchResultItem[];
  }
  return [];
}

export interface DaemonSearchParams {
  daemonUrl: string;
  apiKey?: string;
  query: string;
  k: number;
}

export interface AskFrame {
  event: 'session' | 'sources' | 'delta' | 'done' | 'error';
  data: any;
}

/** Splits raw SSE text into complete frames; returns finished frames + remainder. */
export function extractSseFrames(buffer: string): { frames: Array<{ event: string; data: string }>; rest: string } {
  const frames: Array<{ event: string; data: string }> = [];
  // normalize CR variants (CRLF frames, stray CR) to LF
  let rest = String(buffer ?? '').replace(/\r\n?/g, '\n');
  let idx: number;
  while ((idx = rest.indexOf('\n\n')) >= 0) {
    const raw = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of raw.split('\n')) {
      if (line.lastIndexOf('event:', 0) === 0) event = line.slice(6).trim();
      else if (line.lastIndexOf('data:', 0) === 0) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length) frames.push({ event, data: dataLines.join('\n') });
  }
  return { frames, rest };
}

/** Options for the streamed /ask call. */
export interface DaemonAskParams {
  daemonUrl: string;
  apiKey?: string;
  query: string;
  k?: number;
  /** Continue this persistent chat session (issue #199). */
  sessionId?: string;
  /** Start a fresh persistent session when no sessionId is known yet. */
  chat?: boolean;
  onFrame?: (frame: AskFrame) => void;
  signal?: AbortSignal;
}

/**
 * Streamed grounded QA over POST /ask (issue #199). The daemon must run with
 * --llm-endpoint; its 400 error text surfaces verbatim. Frames are forwarded
 * to onFrame as they arrive so the sidebar can render token-by-token.
 */
export async function askDaemon({
  daemonUrl, apiKey, query, k = 5, sessionId, chat, onFrame, signal,
}: DaemonAskParams): Promise<AskFrame | null> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const body: Record<string, unknown> = { query, k };
  const sid = String(sessionId ?? '').trim();
  if (sid) body.sessionId = sid;
  else if (chat) body.chat = true;

  const resp = await fetch(`${daemonUrl}/ask`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!resp.ok) {
    let detail = `Daemon returned HTTP ${resp.status}`;
    try {
      const j = await resp.json();
      if (j?.error) detail = j.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }
  if (!resp.body) {
    throw new Error('Daemon response has no readable stream (streaming unsupported)');
  }

  let buffer = '';
  let done: AskFrame | null = null;
  const consume = (event: string, data: string) => {
    let obj: any;
    try {
      obj = JSON.parse(data);
    } catch {
      return;
    }
    if (event === 'done') done = { event: 'done', data: obj };
    onFrame?.({ event: event as AskFrame['event'], data: obj });
  };
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { done: finished, value } = await reader.read();
    if (finished) break;
    buffer += dec.decode(value, { stream: true });
    const parsed = extractSseFrames(buffer);
    buffer = parsed.rest;
    for (const f of parsed.frames) consume(f.event, f.data);
  }
  // flush a trailing frame that ended without its blank line
  const tail = extractSseFrames(`${buffer}\n\n`);
  for (const f of tail.frames) consume(f.event, f.data);
  return done;
}

/** Shared daemon client used by both the QuickPick flow and the sidebar. */
export async function searchDaemon({ daemonUrl, apiKey, query, k }: DaemonSearchParams): Promise<SearchResultItem[]> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const resp = await fetch(`${daemonUrl}/search`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, k }),
  });
  if (!resp.ok) {
    throw new Error(`Daemon returned HTTP ${resp.status}`);
  }
  return unwrapSearchEnvelope(await resp.json());
}

/**
 * issue #182: the API key lives in SecretStorage (encrypted per-account by VS
 * Code), NOT in workspace settings — a literal `mdss.apiKey` in
 * `.vscode/settings.json` tends to end up committed. Resolution order:
 * SecretStorage first, then the (deprecated) config setting for backcompat.
 */
export async function resolveApiKey(secrets: vscode.SecretStorage | undefined, config: vscode.WorkspaceConfiguration): Promise<string | undefined> {
  const fromSecret = await secrets?.get(API_KEY_SECRET);
  if (fromSecret) return fromSecret;
  const fromConfig = config.get<string>('apiKey', '');
  return fromConfig || undefined;
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
    const apiKey = await resolveApiKey(context.secrets, config);
    const k = config.get<number>('k', 10);

    try {
      const results = await searchDaemon({ daemonUrl, apiKey, query: query.trim(), k });
      if (!results || results.length === 0) {
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
  const sidebarProvider = new MdssSidebarProvider(context.extensionUri, context.secrets);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('mdss-search-view', sidebarProvider),
    searchCommand,
    indexCommand
  );

  // issue #182: store/clear the API key in SecretStorage instead of settings
  context.subscriptions.push(
    vscode.commands.registerCommand('mdss.setApiKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'API key for the mdss daemon (stored encrypted in SecretStorage)',
        password: true,
      });
      if (key === undefined) return;
      if (!key.trim()) {
        await context.secrets.delete(API_KEY_SECRET);
        vscode.window.showInformationMessage('MDSS: API key cleared.');
        return;
      }
      await context.secrets.store(API_KEY_SECRET, key.trim());
      vscode.window.showInformationMessage('MDSS: API key stored in SecretStorage.');
    })
  );
}

export class MdssSidebarProvider implements vscode.WebviewViewProvider {
  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _secrets?: vscode.SecretStorage,
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this._getHtmlForWebview();

    // Issue #165: the webview posts search intents to the Extension Host,
    // which owns daemon settings (daemonUrl, apiKey, k) and returns results.
    // issue #199: `ask` intents stream SSE frames back as ask-frame messages.
    webviewView.webview.onDidReceiveMessage(async (msg: { type?: string; query?: unknown; sessionId?: unknown; chat?: unknown }) => {
      const config = vscode.workspace.getConfiguration('mdss');
      if (msg?.type === 'search') {
        if (typeof msg.query !== 'string' || !msg.query.trim()) return;
        try {
          const results = await searchDaemon({
            daemonUrl: config.get<string>('daemonUrl', 'http://127.0.0.1:8747'),
            apiKey: await resolveApiKey(this._secrets, config),
            query: msg.query.trim(),
            k: config.get<number>('k', 8),
          });
          void webviewView.webview.postMessage({ type: 'results', results });
        } catch (err: any) {
          void webviewView.webview.postMessage({
            type: 'error',
            message: `Failed to reach mdss daemon: ${err?.message ?? err}`,
          });
        }
        return;
      }
      if (msg?.type === 'ask') {
        if (typeof msg.query !== 'string' || !msg.query.trim()) return;
        try {
          await askDaemon({
            daemonUrl: config.get<string>('daemonUrl', 'http://127.0.0.1:8747'),
            apiKey: await resolveApiKey(this._secrets, config),
            query: msg.query.trim(),
            k: 5,
            sessionId: typeof msg.sessionId === 'string' ? msg.sessionId : undefined,
            chat: msg.chat === true,
            onFrame: (frame) => {
              void webviewView.webview.postMessage({ type: 'ask-frame', event: frame.event, data: frame.data });
            },
          });
          void webviewView.webview.postMessage({ type: 'ask-end' });
        } catch (err: any) {
          void webviewView.webview.postMessage({
            type: 'ask-error',
            message: String(err?.message ?? err),
          });
        }
        return;
      }
    });
  }

  private _getHtmlForWebview(): string {
    // issue #182: per-render nonce + strict CSP — the webview loads only its
    // own inline script and local inline styles, nothing else
    const nonce = crypto.randomUUID().replace(/-/g, '');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    body { font-family: var(--vscode-font-family); padding: 10px; color: var(--vscode-foreground); }
    input[type=text] { width: 100%; box-sizing: border-box; padding: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 2px; }
    .btn { margin-top: 8px; width: 100%; padding: 6px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; border-radius: 2px; }
    .btn:hover { background: var(--vscode-button-hoverBackground); }
    .btn:disabled { opacity: .55; cursor: wait; }
    #results { margin-top: 15px; }
    .hit { padding: 8px; margin-bottom: 8px; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 4px; }
    .hit-title { font-weight: bold; color: var(--vscode-textLink-foreground); }
    .hit-snippet { font-size: 0.9em; opacity: 0.85; margin-top: 4px; }
    .divider { margin-top: 18px; border-top: 1px solid var(--vscode-divider-background, var(--vscode-input-border)); padding-top: 10px; }
    .ask-controls { display: flex; gap: 10px; align-items: center; margin-top: 8px; font-size: .92em; }
    .ask-controls label { display: flex; gap: 4px; align-items: center; color: var(--vscode-descriptionForeground); cursor: pointer; }
    .newchat { background: transparent; color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-input-border); border-radius: 2px; cursor: pointer; padding: 2px 8px; }
    #answer { margin-top: 10px; padding: 8px; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 4px; white-space: pre-wrap; overflow-wrap: break-word; min-height: 20px; }
    #answer:empty::before { content: '—'; color: var(--vscode-descriptionForeground); }
    #asksources { margin-top: 8px; font-size: .88em; color: var(--vscode-descriptionForeground); }
    #askhistory { margin-top: 8px; }
    .turn { margin: 4px 0; padding: 4px 8px; border-left: 2px solid var(--vscode-input-border); font-size: .88em; }
    .turn .tq { display: block; color: var(--vscode-textLink-foreground); margin-bottom: 2px; }
    .turn .ta { display: block; white-space: pre-wrap; overflow-wrap: break-word; }
    .fallback-note { display: block; margin-top: 6px; font-size: .85em; color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
  <input id="query" type="text" placeholder="Search Markdown notes by meaning..." />
  <button class="btn" onclick="doSearch()">Search</button>
  <div id="results"></div>

  <div class="divider">
    <input id="askq" type="text" placeholder="Ask the notes — daemon needs --llm-endpoint..." />
    <button class="btn" id="askbtn" onclick="doAsk()">Ask</button>
    <div class="ask-controls">
      <label><input type="checkbox" id="chatmode" /> chat</label>
      <button class="newchat" id="newchat" style="display:none" onclick="resetChat()">new chat</button>
    </div>
    <div id="askhistory"></div>
    <div id="answer"></div>
    <div id="asksources"></div>
  </div>
  <script nonce="${nonce}">
    var vscode = acquireVsCodeApi();

    // Issue #165: every dynamic field is HTML-escaped before it reaches
    // innerHTML — note titles, headings, and snippets may contain markup.
    function escapeHtml(str) {
      return String(str === undefined || str === null ? '' : str).replace(/[&<>"']/g, function (m) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
      });
    }

    function doSearch() {
      var q = document.getElementById('query').value;
      if (!q) return;
      document.getElementById('results').innerHTML = '<p>Searching...</p>';
      vscode.postMessage({ type: 'search', query: q });
    }

    // ── Ask (issue #199): streamed grounded QA via the Extension Host ──
    var askTurns = [];
    var askSessionId = '';
    var askQueryPending = '';

    function renderHistory() {
      var el = document.getElementById('askhistory');
      var html = '';
      for (var i = 0; i < askTurns.length; i++) {
        html += '<div class="turn"><span class="tq">Q: ' + escapeHtml(askTurns[i].q) + '</span>'
          + '<span class="ta">' + escapeHtml(askTurns[i].a) + '</span></div>';
      }
      el.innerHTML = html;
    }

    function resetChat() {
      askTurns = [];
      askSessionId = '';
      renderHistory();
      document.getElementById('newchat').style.display = 'none';
      document.getElementById('answer').textContent = '';
      document.getElementById('asksources').innerHTML = '';
    }

    function doAsk() {
      var q = document.getElementById('askq').value;
      if (!q.trim()) return;
      askQueryPending = q.trim();
      document.getElementById('askbtn').disabled = true;
      var answer = document.getElementById('answer');
      answer.textContent = 'Thinking…';
      document.getElementById('asksources').innerHTML = '';
      var chatOn = document.getElementById('chatmode').checked;
      vscode.postMessage({
        type: 'ask',
        query: q.trim(),
        sessionId: chatOn && askSessionId ? askSessionId : undefined,
        chat: chatOn && !askSessionId
      });
    }

    function renderSources(citations) {
      var el = document.getElementById('asksources');
      if (!citations || !citations.length) { el.innerHTML = ''; return; }
      var html = '<strong>Sources:</strong> ';
      for (var i = 0; i < citations.length; i++) {
        var c = citations[i];
        html += escapeHtml(c.file) + (c.heading ? ' › ' + escapeHtml(c.heading) : '') + ' &nbsp; ';
      }
      el.innerHTML = html;
    }

    window.addEventListener('message', function (event) {
      var msg = event.data || {};
      var resDiv = document.getElementById('results');
      if (msg.type === 'results') {
        var items = Array.isArray(msg.results) ? msg.results : [];
        if (items.length === 0) {
          resDiv.innerHTML = '<p>No matches found.</p>';
          return;
        }
        var html = '';
        for (var i = 0; i < items.length; i++) {
          var h = items[i];
          html += '<div class="hit">'
            + '<div class="hit-title">' + escapeHtml(h.title) + (h.heading ? ' › ' + escapeHtml(h.heading) : '') + '</div>'
            + '<div class="hit-snippet">' + escapeHtml(h.snippet) + '</div>'
            + '</div>';
        }
        resDiv.innerHTML = html;
      } else if (msg.type === 'error') {
        resDiv.innerHTML = '<p style="color:red">' + escapeHtml(msg.message) + '</p>';
      } else if (msg.type === 'ask-frame') {
        var answer = document.getElementById('answer');
        var obj = msg.data || {};
        if (msg.event === 'session') {
          askSessionId = obj.id || askSessionId;
          if (askSessionId) document.getElementById('newchat').style.display = '';
        } else if (msg.event === 'delta') {
          if (answer.textContent === 'Thinking…') answer.textContent = '';
          answer.textContent += obj.text || '';
        } else if (msg.event === 'done') {
          if (obj.answer) answer.textContent = obj.answer;
          if (obj.mode === 'extractive') {
            answer.insertAdjacentHTML('beforeend', '<span class="fallback-note">LLM unavailable — extractive fallback shown.</span>');
          }
          renderSources(obj.citations);
          if (obj.sessionId) {
            askSessionId = obj.sessionId;
            document.getElementById('newchat').style.display = '';
            askTurns.push({ q: askQueryPending, a: obj.answer });
            renderHistory();
          }
          document.getElementById('askbtn').disabled = false;
        } else if (msg.event === 'error') {
          answer.textContent = obj.error || 'answer synthesis failed';
          document.getElementById('askbtn').disabled = false;
        }
      } else if (msg.type === 'ask-end') {
        document.getElementById('askbtn').disabled = false;
      } else if (msg.type === 'ask-error') {
        document.getElementById('answer').textContent = msg.message;
        document.getElementById('askbtn').disabled = false;
      }
    });
  </script>
</body>
</html>`;
  }
}

export function deactivate() {}
