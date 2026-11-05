// Dedicated VS Code extension tests (issue #230) — moved out of
// integrations.test.mjs so each surface has one owner file. The extension
// module itself imports `vscode`, which Node cannot resolve; the behavioral
// parts that ARE testable in plain Node (pure webview functions extracted
// from source, manifest contracts, security-relevant source invariants)
// live here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EXT_DIR = path.join(ROOT, 'integrations', 'vscode');
const EXT_SRC = path.join(EXT_DIR, 'src', 'extension.ts');
const EXT_PKG = path.join(EXT_DIR, 'package.json');

const readSrc = () => fs.readFileSync(EXT_SRC, 'utf8');
const readPkg = () => JSON.parse(fs.readFileSync(EXT_PKG, 'utf8'));

test('vscode: manifest is valid and specifies contributions', () => {
  const pkg = readPkg();
  assert.equal(pkg.name, 'md-semantic-search-vscode');
  assert.ok(Array.isArray(pkg.contributes?.commands));
  assert.ok(pkg.contributes.commands.some((c) => c.command === 'mdss.search'));
  assert.ok(pkg.contributes.commands.some((c) => c.command === 'mdss.index'));
  assert.ok(pkg.contributes.viewsContainers?.activitybar?.length > 0);
  assert.ok(pkg.contributes.views?.['mdss-sidebar']?.length > 0);
});

test('vscode: source registers commands and exposes the envelope unwrapper (issue #151)', () => {
  const src = readSrc();
  assert.ok(src.includes("vscode.commands.registerCommand('mdss.search'"));
  assert.ok(src.includes("vscode.commands.registerCommand('mdss.index'"));
  assert.ok(src.includes('indexCommand'));
  assert.ok(src.includes('export function unwrapSearchEnvelope'));
});

// Issue #165: extract the webview's escapeHtml (a pure function inside the
// generated HTML) and evaluate it in Node for a real behavioral check.
function extractEscapeHtml(src) {
  const match = src.match(/function escapeHtml\(str\) \{[\s\S]*?\n {4}\}/);
  assert.ok(match, 'escapeHtml function found in the webview script');
  const fn = new Function(`return (${match[0]})`)();
  assert.equal(typeof fn, 'function');
  return fn;
}

test('vscode: webview escapes dangerous HTML in result fields (issue #165)', () => {
  const src = readSrc();
  const escapeHtml = extractEscapeHtml(src);

  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(escapeHtml('a & "b" \'c\''), 'a &amp; &quot;b&quot; &#39;c&#39;');
  assert.equal(escapeHtml(undefined), '', 'undefined renders as empty string');
  assert.equal(escapeHtml(null), '', 'null renders as empty string');

  for (const field of ['h.title', 'h.heading', 'h.snippet']) {
    assert.ok(src.includes(`escapeHtml(${field})`), `webview renders ${field} through escapeHtml`);
  }
  assert.ok(src.includes("escapeHtml(msg.message)"), 'webview escapes error messages');
});

test('vscode: sidebar search goes through the Extension Host with daemon settings (issue #165)', () => {
  const src = readSrc();
  const htmlStart = src.indexOf('_getHtmlForWebview');
  const webviewScript = src.slice(htmlStart);

  assert.ok(src.includes('vscode.postMessage({ type: \'search\', query: q })'), 'webview posts search intent');
  assert.ok(src.includes('onDidReceiveMessage'), 'Extension Host handles webview messages');
  assert.ok(src.includes("postMessage({ type: 'results', results })"), 'host returns results via postMessage');
  assert.ok(!webviewScript.includes('fetch('), 'webview script must not call fetch');

  assert.ok(src.includes('resolveApiKey('), 'apiKey resolved via SecretStorage-first helper (issue #182)');
  assert.ok(src.includes('headers.Authorization = `Bearer ${apiKey}`'), 'Authorization header on daemon requests');
  assert.ok(src.includes("config.get<string>('daemonUrl'"), 'daemonUrl read from settings');

  const pkg = readPkg();
  assert.ok(pkg.contributes.configuration.properties['mdss.apiKey'], 'mdss.apiKey setting declared');
});

test('vscode: webview ships a strict CSP with per-render nonce; key lives in SecretStorage (issue #182)', () => {
  const src = readSrc();

  assert.ok(src.includes('Content-Security-Policy'), 'webview HTML carries a CSP meta');
  assert.ok(src.includes("default-src 'none'"), 'CSP default-src none');
  assert.ok(src.includes("script-src 'nonce-${nonce}'"), 'scripts restricted to the per-render nonce');
  assert.ok(src.includes('<script nonce="${nonce}">'), 'the inline script is nonce-tagged');
  const scriptTags = (src.match(/<script/g) || []).length;
  const nonceTags = (src.match(/<script nonce=/g) || []).length;
  assert.equal(scriptTags, nonceTags, 'every script tag carries the nonce');

  assert.ok(src.includes("secrets?.get(API_KEY_SECRET)"), 'SecretStorage consulted first');
  assert.ok(src.includes('context.secrets.store(API_KEY_SECRET'), 'setApiKey command stores into SecretStorage');
  assert.ok(src.includes('resolveApiKey(context.secrets, config)'), 'QuickPick flow resolves via SecretStorage');

  const pkg = readPkg();
  const cmds = (pkg.contributes?.commands || []).map((c) => c.command);
  assert.ok(cmds.includes('mdss.setApiKey'), 'MDSS: Set API Key command declared');
  assert.ok(
    pkg.contributes.configuration.properties['mdss.apiKey'].deprecationMessage,
    'raw mdss.apiKey setting is marked deprecated',
  );
});

test('vscode: ask panel streams through the Extension Host and extractSseFrames parity (issue #230)', () => {
  const src = readSrc();
  // The Ask panel must consume the same SSE contract as the shared client
  // (frames: session/sources/delta/done) via the Extension Host, not the
  // webview's own network access.
  assert.ok(src.includes("type: 'delta'") || src.includes("'delta'"), 'delta frames forwarded to the webview');
  assert.ok(src.includes('askDaemon'), 'Extension Host streams via askDaemon');
  // buildAskRequest-shaped body: sessionId/chat persistence knobs present
  assert.ok(src.includes('sessionId') && src.includes('chat'), 'multi-turn chat knobs passed through');
});
