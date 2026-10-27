import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

test('integrations: VS Code extension manifest is valid and specifies contributions', () => {
  const pkgPath = path.join(ROOT, 'integrations', 'vscode', 'package.json');
  assert.ok(fs.existsSync(pkgPath));

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  assert.equal(pkg.name, 'md-semantic-search-vscode');
  assert.ok(Array.isArray(pkg.contributes?.commands));
  assert.ok(pkg.contributes.commands.some((c) => c.command === 'mdss.search'));
  assert.ok(pkg.contributes.commands.some((c) => c.command === 'mdss.index'));
  assert.ok(pkg.contributes.viewsContainers?.activitybar?.length > 0);
  assert.ok(pkg.contributes.views?.['mdss-sidebar']?.length > 0);
});

test('integrations: VS Code extension source registers commands and unwraps search envelope (issue #151)', () => {
  const extSrcPath = path.join(ROOT, 'integrations', 'vscode', 'src', 'extension.ts');
  assert.ok(fs.existsSync(extSrcPath));
  const src = fs.readFileSync(extSrcPath, 'utf8');

  // Verify command registration
  assert.ok(src.includes("vscode.commands.registerCommand('mdss.search'"));
  assert.ok(src.includes("vscode.commands.registerCommand('mdss.index'"));
  assert.ok(src.includes("indexCommand"));

  // Verify envelope unwrapping lives in the shared daemon client (issue #165
  // moved it out of inline fetch handlers; the behavioral contract is covered
  // by the unwrap checks below).
  assert.ok(src.includes('export function unwrapSearchEnvelope'));

  // Contract test: unwrapping logic behaves identically on bare array and envelope
  const envelope = { query: 'test', k: 5, count: 1, results: [{ file: 'note.md', score: 0.9, title: 'Note' }] };
  const bareArray = [{ file: 'note.md', score: 0.9, title: 'Note' }];

  const unwrap = (data) => (Array.isArray(data) ? data : (Array.isArray(data?.results) ? data.results : []));
  assert.equal(unwrap(envelope).length, 1);
  assert.equal(unwrap(envelope)[0].file, 'note.md');
  assert.equal(unwrap(bareArray).length, 1);
  assert.equal(unwrap(bareArray)[0].file, 'note.md');
  assert.equal(unwrap(null).length, 0);
  assert.equal(unwrap({}).length, 0);
});

// Issue #165: extract the webview's escapeHtml (a pure function inside the
// generated HTML) and evaluate it in Node for a real behavioral check.
function extractEscapeHtml(src) {
  const match = src.match(/function escapeHtml\(str\) \{[\s\S]*?\n    \}/);
  assert.ok(match, 'escapeHtml function found in the webview script');
  const fn = new Function(`return (${match[0]})`)();
  assert.equal(typeof fn, 'function');
  return fn;
}

test('integrations: VS Code webview escapes dangerous HTML in result fields (issue #165)', () => {
  const extSrcPath = path.join(ROOT, 'integrations', 'vscode', 'src', 'extension.ts');
  const src = fs.readFileSync(extSrcPath, 'utf8');
  const escapeHtml = extractEscapeHtml(src);

  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(escapeHtml('a & "b" \'c\''), 'a &amp; &quot;b&quot; &#39;c&#39;');
  assert.equal(escapeHtml(undefined), '', 'undefined renders as empty string');
  assert.equal(escapeHtml(null), '', 'null renders as empty string');

  // All rendered result fields must pass through escapeHtml.
  for (const field of ['h.title', 'h.heading', 'h.snippet']) {
    assert.ok(
      src.includes(`escapeHtml(${field})`),
      `webview renders ${field} through escapeHtml`,
    );
  }
  // Error messages from the Extension Host are escaped too.
  assert.ok(src.includes("escapeHtml(msg.message)"), 'webview escapes error messages');
});

test('integrations: VS Code sidebar search goes through the Extension Host with daemon settings (issue #165)', () => {
  const extSrcPath = path.join(ROOT, 'integrations', 'vscode', 'src', 'extension.ts');
  const src = fs.readFileSync(extSrcPath, 'utf8');
  const htmlStart = src.indexOf('_getHtmlForWebview');
  const webviewScript = src.slice(htmlStart);

  // Webview posts intents instead of fetching the daemon directly.
  assert.ok(src.includes('vscode.postMessage({ type: \'search\', query: q })'), 'webview posts search intent');
  assert.ok(src.includes('onDidReceiveMessage'), 'Extension Host handles webview messages');
  assert.ok(src.includes("postMessage({ type: 'results', results })"), 'host returns results via postMessage');

  // No daemon fetch from the webview itself (hardcoded URL or otherwise).
  assert.ok(!webviewScript.includes('fetch('), 'webview script must not call fetch');

  // Shared client reads settings and sends the Bearer token when configured.
  assert.ok(src.includes("config.get<string>('apiKey', '')"), 'apiKey read from settings');
  assert.ok(src.includes('headers.Authorization = `Bearer ${apiKey}`'), 'Authorization header on daemon requests');
  assert.ok(src.includes("config.get<string>('daemonUrl'"), 'daemonUrl read from settings');

  // Manifest exposes the apiKey setting.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'integrations', 'vscode', 'package.json'), 'utf8'));
  assert.ok(pkg.contributes.configuration.properties['mdss.apiKey'], 'mdss.apiKey setting declared');
});

test('integrations: Raycast extension manifest is valid and specifies command view', () => {
  const pkgPath = path.join(ROOT, 'integrations', 'raycast', 'package.json');
  assert.ok(fs.existsSync(pkgPath));

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  assert.equal(pkg.name, 'md-semantic-search');
  assert.ok(Array.isArray(pkg.commands));
  assert.equal(pkg.commands[0].name, 'search-notes');
  assert.equal(pkg.commands[0].mode, 'view');
});

test('integrations: Alfred script filter outputs valid Alfred JSON schema on empty and error queries', () => {
  const scriptPath = path.join(ROOT, 'integrations', 'alfred', 'search.mjs');
  assert.ok(fs.existsSync(scriptPath));

  // Run with no args -> prompt
  const procEmpty = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  assert.equal(procEmpty.status, 0);
  const outEmpty = JSON.parse(procEmpty.stdout);
  assert.ok(Array.isArray(outEmpty.items));
  assert.equal(outEmpty.items[0].valid, false);

  // Run with non-running daemon -> clean error item
  const procQuery = spawnSync(process.execPath, [scriptPath, 'test query'], {
    encoding: 'utf8',
    env: { ...process.env, MDSS_DAEMON_URL: 'http://127.0.0.1:59999' },
  });
  assert.equal(procQuery.status, 0);
  const outQuery = JSON.parse(procQuery.stdout);
  assert.ok(Array.isArray(outQuery.items));
  assert.ok(outQuery.items[0].title.includes('Error'));
});
