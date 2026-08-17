#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const docsDir = path.join(root, 'docs');
const siteDir = path.join(root, 'site');

// 1. Generate CLI reference doc
spawnSync(process.execPath, [path.join(root, 'scripts', 'generate-cli-docs.mjs')], {
  stdio: 'inherit',
});

fs.mkdirSync(siteDir, { recursive: true });

const NAV_ITEMS = [
  { id: 'index', title: 'Getting Started', file: 'index.md', out: 'index.html' },
  { id: 'cli-reference', title: 'CLI Reference', file: 'cli-reference.md', out: 'cli-reference.html' },
  { id: 'api-reference', title: 'Library API', file: 'api-reference.md', out: 'api-reference.html' },
  { id: 'models', title: 'Models & Adapters', file: 'models.md', out: 'models.html' },
  { id: 'architecture', title: 'Architecture', file: 'architecture.md', out: 'architecture.html' },
  { id: 'benchmarks', title: 'Research & Benchmarks', file: 'benchmarks.md', out: 'benchmarks.html' },
  { id: 'roadmap', title: 'Roadmap to v1.0', file: 'roadmap.md', out: 'roadmap.html' },
  { id: 'changelog', title: 'Changelog', file: 'changelog.md', out: 'changelog.html' },
];

function markdownToHtml(md) {
  let html = md
    // Escape HTML special chars except inside markdown blocks
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Code blocks ```lang\ncode\n```
  html = html.replace(/```([a-z0-9_-]*)\n([\s\S]*?)```/gm, (_match, lang, code) => {
    return `<pre class="code-block"><code class="language-${lang}">${code.trim()}</code></pre>`;
  });

  // Inline code `code`
  html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

  // Headings #, ##, ###
  html = html.replace(/^### (.*$)/gim, '<h3 id="$1">$1</h3>');
  html = html.replace(/^## (.*$)/gim, '<h2 id="$1">$1</h2>');
  html = html.replace(/^# (.*$)/gim, '<h1 id="$1">$1</h1>');

  // Bold & Italic
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Unordered list items - item
  html = html.replace(/^\s*-\s+(.*)$/gim, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>)/gms, '<ul>$1</ul>');
  html = html.replace(/<\/ul>\s*<ul>/g, '');

  // Tables | a | b |
  const lines = html.split('\n');
  const outLines = [];
  let inTable = false;
  let tableHeaderDone = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const cells = trimmed
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim());
      if (cells.every((c) => /^:?-+:?$/.test(c))) {
        tableHeaderDone = true;
        continue;
      }
      if (!inTable) {
        inTable = true;
        tableHeaderDone = false;
        outLines.push('<div class="table-wrapper"><table><tbody>');
      }
      const tag = tableHeaderDone ? 'td' : 'th';
      const row = `<tr>${cells.map((c) => `<${tag}>${c}</${tag}>`).join('')}</tr>`;
      outLines.push(row);
    } else {
      if (inTable) {
        outLines.push('</tbody></table></div>');
        inTable = false;
        tableHeaderDone = false;
      }
      outLines.push(line);
    }
  }
  if (inTable) outLines.push('</tbody></table></div>');

  // Paragraphs
  return outLines
    .join('\n')
    .split(/\n{2,}/)
    .map((chunk) => {
      const trimmed = chunk.trim();
      if (!trimmed) return '';
      if (
        trimmed.startsWith('<h') ||
        trimmed.startsWith('<pre') ||
        trimmed.startsWith('<ul') ||
        trimmed.startsWith('<div') ||
        trimmed.startsWith('<hr')
      ) {
        return trimmed;
      }
      if (trimmed === '---') return '<hr />';
      return `<p>${trimmed}</p>`;
    })
    .join('\n');
}

function renderPage(item, contentHtml) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const navHtml = NAV_ITEMS.map((n) => {
    const active = n.id === item.id ? ' active' : '';
    return `<a class="nav-link${active}" href="${n.out}">${n.title}</a>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${item.title} — md-semantic-search</title>
  <meta name="description" content="Local, zero-dependency Markdown semantic vector search engine and hybrid BM25 search daemon.">
  <style>
    :root {
      --bg: #0d1117;
      --bg-surface: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --text-heading: #f0f6fc;
      --text-muted: #8b949e;
      --primary: #58a6ff;
      --primary-hover: #79c0ff;
      --code-bg: #1f242c;
      --accent: #238636;
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font);
      line-height: 1.6;
      display: flex;
      min-height: 100vh;
    }
    aside {
      width: 280px;
      background: var(--bg-surface);
      border-right: 1px solid var(--border);
      padding: 24px 16px;
      display: flex;
      flex-direction: column;
      position: sticky;
      top: 0;
      height: 100vh;
    }
    .brand {
      font-size: 1.1rem;
      font-weight: 700;
      color: var(--text-heading);
      margin-bottom: 24px;
      display: flex;
      align-items: center;
      gap: 8px;
      text-decoration: none;
    }
    .badge {
      font-size: 0.75rem;
      background: #1f6feb33;
      color: var(--primary);
      padding: 2px 6px;
      border-radius: 12px;
      border: 1px solid #1f6feb66;
    }
    .nav-link {
      display: block;
      color: var(--text-muted);
      text-decoration: none;
      padding: 8px 12px;
      border-radius: 6px;
      margin-bottom: 4px;
      font-size: 0.95rem;
      transition: all 0.15s ease;
    }
    .nav-link:hover {
      color: var(--text-heading);
      background: rgba(255,255,255,0.05);
    }
    .nav-link.active {
      color: var(--primary);
      background: rgba(88, 166, 255, 0.1);
      font-weight: 600;
    }
    main {
      flex: 1;
      max-width: 900px;
      padding: 40px 48px;
      overflow-y: auto;
    }
    h1, h2, h3 {
      color: var(--text-heading);
      margin-top: 1.5em;
      margin-bottom: 0.6em;
      line-height: 1.3;
    }
    h1 { font-size: 2rem; margin-top: 0; border-bottom: 1px solid var(--border); padding-bottom: 12px; }
    h2 { font-size: 1.4rem; border-bottom: 1px solid rgba(48, 54, 61, 0.5); padding-bottom: 6px; }
    h3 { font-size: 1.15rem; }
    p { margin-bottom: 1em; }
    a { color: var(--primary); text-decoration: none; }
    a:hover { text-decoration: underline; }
    pre.code-block {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
      overflow-x: auto;
      margin: 16px 0;
      font-family: var(--mono);
      font-size: 0.9rem;
      line-height: 1.5;
    }
    code.inline-code {
      background: var(--code-bg);
      padding: 2px 6px;
      border-radius: 4px;
      font-family: var(--mono);
      font-size: 0.85em;
      color: #79c0ff;
    }
    ul { margin: 12px 0 16px 24px; }
    li { margin-bottom: 6px; }
    hr { border: 0; border-top: 1px solid var(--border); margin: 32px 0; }
    .table-wrapper { overflow-x: auto; margin: 16px 0; }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 0.9rem; }
    th, td { padding: 10px 14px; border: 1px solid var(--border); }
    th { background: var(--bg-surface); color: var(--text-heading); font-weight: 600; }
    @media (max-width: 768px) {
      body { flex-direction: column; }
      aside { width: 100%; height: auto; position: static; }
      main { padding: 24px; }
    }
  </style>
</head>
<body>
  <aside>
    <a href="index.html" class="brand">
      md-semantic-search <span class="badge">v${pkg.version}</span>
    </a>
    <nav>
      ${navHtml}
    </nav>
  </aside>
  <main>
    ${contentHtml}
  </main>
</body>
</html>`;
}

for (const item of NAV_ITEMS) {
  const filePath = path.join(docsDir, item.file);
  const md = fs.readFileSync(filePath, 'utf8');
  const htmlContent = markdownToHtml(md);
  const fullHtml = renderPage(item, htmlContent);
  fs.writeFileSync(path.join(siteDir, item.out), fullHtml, 'utf8');
}

console.log(`Generated ${NAV_ITEMS.length} documentation pages into ${siteDir}`);
