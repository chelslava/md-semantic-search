import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { buildIndex } from '../dist/indexer.js';
import { createServe } from '../dist/serve.js';
import { WEBUI_JS } from '../dist/webui.js';

function fakeEmbed(texts, kind, model) {
  return texts.map((t) => {
    const dim = model?.dim > 0 ? model.dim : 8;
    const v = new Array(dim).fill(0);
    const words = t.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    for (const w of words) {
      let h = 7;
      for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
      v[h % dim] += 1;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  });
}

function safeRm(p) {
  if (!p) return;
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {}
}

async function startUiServe(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-ui-'));
  const idx = path.join(dir, '.mdss');
  fs.writeFileSync(path.join(dir, 'a.md'), '# Coffee\n\ncoffee beans roasted ground notes here\n');
  await buildIndex({ db: dir, indexDir: idx, cacheDir: path.join(dir, '.c'), modelName: 'e5-base', embedFn: fakeEmbed });
  const svc = await createServe({ indexDir: idx, cacheDir: path.join(dir, '.c'), embedFn: fakeEmbed, ...extra });
  await new Promise((r) => svc.server.listen(0, r));
  return { url: `http://127.0.0.1:${svc.server.address().port}`, close: async () => { await svc.close(); safeRm(dir); } };
}

function get(url, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: p, headers }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('webui: / serves the SPA shell with strict CSP and nosniff (issue #111)', async () => {
  const srv = await startUiServe();
  try {
    const r = await get(srv.url, '/');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/html/);
    const csp = r.headers['content-security-policy'] || '';
    for (const directive of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "frame-ancestors 'none'"]) {
      assert.ok(csp.includes(directive), `CSP has ${directive}`);
    }
    assert.equal(r.headers['x-content-type-options'], 'nosniff', 'nosniff on UI too');
    // shell references the split assets and carries the hooks a real E2E targets
    assert.ok(r.body.includes('href="./ui.css"'), 'css link');
    assert.ok(r.body.includes('src="./ui.js"'), 'js script');
    assert.ok(r.body.includes('id="q"') && r.body.includes('id="results"'), 'search box + results hooks');
    assert.ok(!/<script>/.test(r.body.replace('<script src="./ui.js" defer></script>', '')), 'no inline scripts');
  } finally {
    await srv.close();
  }
});

test('webui: /ui.js and /ui.css served with correct content types (issue #111)', async () => {
  const srv = await startUiServe();
  try {
    const js = await get(srv.url, '/ui.js');
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'], /javascript/);
    assert.ok(js.body.includes('/search'), 'client talks to /search');
    assert.ok(!/eval\(/.test(js.body), 'no eval anywhere');

    const css = await get(srv.url, '/ui.css');
    assert.equal(css.status, 200);
    assert.match(css.headers['content-type'], /text\/css/);
    assert.ok(css.body.includes('prefers-color-scheme'), 'dark/light follows system');
  } finally {
    await srv.close();
  }
});

test('webui: --no-ui restores pure JSON at / ; /help contract unchanged either way (issue #111)', async () => {
  const withUi = await startUiServe();
  try {
    const helpOn = await get(withUi.url, '/help');
    assert.equal(helpOn.status, 200);
    assert.match(helpOn.headers['content-type'], /json/);
    assert.ok(JSON.parse(helpOn.body).endpoints.some((e) => e.path === '/search'), '/help still documents /search');

    const searchOn = await get(withUi.url, '/search', {});
    void searchOn;
  } finally {
    await withUi.close();
  }

  const srv = await startUiServe({ ui: false });
  try {
    const root = await get(srv.url, '/');
    assert.equal(root.status, 200, 'disabled UI falls back to JSON help at /');
    assert.match(root.headers['content-type'], /json/);
    assert.ok(JSON.parse(root.body).endpoints, 'JSON API help shape intact');

    const missing = await get(srv.url, '/ui.js');
    assert.equal(missing.status, 404, 'assets gone when UI disabled');

    const health = await get(srv.url, '/health');
    assert.equal(health.status, 200, '/health unaffected');
  } finally {
    await srv.close();
  }
});

test('webui: UI sits behind Bearer auth like every other route (issue #111)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-ui-auth-'));
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# Coffee\n\ncoffee beans notes\n');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: path.join(dir, '.c'), modelName: 'e5-base', embedFn: fakeEmbed });
    const svc = await createServe({
      indexDir: idx, cacheDir: path.join(dir, '.c'), embedFn: fakeEmbed, apiKey: 'sekret',
    });
    await new Promise((r) => svc.server.listen(0, r));
    const url = `http://127.0.0.1:${svc.server.address().port}`;
    try {
      const denied = await get(url, '/');
      assert.equal(denied.status, 401, 'UI is NOT an auth bypass');

      // raw socket proves a browser-style request without auth gets 401 on /
      void net;
      const ok = await get(url, '/', { authorization: 'Bearer sekret' });
      assert.equal(ok.status, 200);
      assert.match(ok.headers['content-type'], /text\/html/);

      const search = new Promise((resolve2, reject2) => {
        const u = new URL(url);
        const req = http.request({
          hostname: u.hostname, port: u.port, path: '/search', method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer sekret' },
        }, (res) => {
          let d = '';
          res.on('data', (c) => { d += c; });
          res.on('end', () => resolve2({ status: res.statusCode, body: d }));
        });
        req.on('error', reject2);
        req.end(JSON.stringify({ query: 'coffee' }));
      });
      const sr = await search;
      assert.equal(sr.status, 200, 'JSON API contract unchanged behind key');
      assert.deepEqual(Object.keys(JSON.parse(sr.body)), ['query', 'k', 'count', 'results']);
    } finally {
      await svc.close();
    }
  } finally {
    safeRm(dir);
  }
});

test('webui: /ui.js includes AbortController and sequence counter guards for /search (issue #134)', async () => {
  const srv = await startUiServe();
  try {
    const js = await get(srv.url, '/ui.js');
    assert.equal(js.status, 200);
    assert.ok(js.body.includes('AbortController'), 'uses AbortController for in-flight search requests');
    assert.ok(js.body.includes('searchSeq') || js.body.includes('currentSeq'), 'uses monotonic sequence counter');
    assert.ok(js.body.includes('AbortError'), 'handles AbortError silently');
  } finally {
    await srv.close();
  }
});


test('webui: highlight survives regex metacharacters in the query (issue #182)', async () => {
  const { WEBUI_JS } = await import('../dist/webui.js');

  // extract the pure helper functions from the IIFE bundle and evaluate them
  const extract = (name) => {
    const start = WEBUI_JS.indexOf(`function ${name}(`);
    assert.ok(start !== -1, `function ${name} found in ui.js`);
    let depth = 0;
    let i = WEBUI_JS.indexOf('{', start);
    for (; i < WEBUI_JS.length; i++) {
      if (WEBUI_JS[i] === '{') depth++;
      else if (WEBUI_JS[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    return WEBUI_JS.slice(start, i + 1);
  };
  const sandbox = new Function(
    `${extract('esc')}\n${extract('escRe')}\n${extract('highlight')}\nreturn { esc, escRe, highlight };`
  )();
  const { highlight } = sandbox;

  // a "(" query used to throw SyntaxError and leave the UI broken
  assert.equal(highlight('coffee (beans) guide', ['(']), 'coffee <mark>(</mark>beans) guide');
  // metachar terms still match literal text
  assert.equal(highlight('a.b*c + d', ['.b*']), 'a<mark>.b*</mark>c + d');
  // HTML escaping still applies before highlighting
  assert.equal(highlight('<b>bold</b> guide', ['bold']), '&lt;b&gt;<mark>bold</mark>&lt;/b&gt; guide');
  // no terms → unchanged
  assert.equal(highlight('plain text', []), 'plain text');
});

// ---------------------------------------------------------------------------
// issue #245: the safe markdown renderer for RAG answers — escape-first with
// a pattern whitelist. XSS vectors must never survive; benign markdown must
// render. The function lives inside the WEBUI_JS template (an IIFE needing
// DOM), so the test extracts the three pure functions by brace matching.
// ---------------------------------------------------------------------------

// The renderer lives inside the WEBUI_JS template literal (an IIFE needing
// DOM), so the tests extract the three pure functions by slicing between
// stable "function X" markers — brace counting would break on {1,200} inside
// regex literals. The extracted source keeps the template-literal backtick
// escapes (\`), which are identity escapes inside regex literals and compile
// fine outside the template.
function sliceRegion(src, startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a);
  if (a === -1 || b === -1) throw new Error(`markers not found: ${startMarker} … ${endMarker}`);
  return src.slice(a, b);
}

function makeRenderer() {
  return new Function(
    sliceRegion(WEBUI_JS, 'function esc(s)', 'function escRe') +
    sliceRegion(WEBUI_JS, 'function renderMarkdown', 'function unescapeEntities') +
    sliceRegion(WEBUI_JS, 'function unescapeEntities', 'function askKey') +
    'return renderMarkdown;'
  )();
}

test('webui: renderMarkdown neutralizes XSS vectors (issue #245)', () => {
  const render = makeRenderer();

  const script = render('<script>alert(1)</script>');
  assert.ok(!script.includes('<script>'), 'raw script tags never pass through');
  assert.ok(script.includes('&lt;script&gt;'), 'they render escaped instead');

  const jsUrl = render('[click](javascript:alert(1))');
  assert.ok(!/<a [^>]*javascript:/i.test(jsUrl), 'javascript: URLs never become hrefs (plain text is fine)');

  const dataUrl = render('[x](data:text/html,<h1>)');
  assert.ok(!dataUrl.includes('<a '), 'data: URLs are not linked either');

  const onerror = render('<img src=x onerror=alert(1)>');
  assert.ok(!onerror.includes('<img'), 'event-handler markup stays escaped');

  const http = render('[docs](https://example.com/a)');
  assert.ok(http.includes('<a href="https://example.com/a"'), 'http(s) links are allowed');
  const rel = render('[doc](/doc?file=a.md)');
  assert.ok(rel.includes('<a href="/doc?file=a.md"'), 'same-origin relative links are allowed');
});

test('webui: renderMarkdown renders benign RAG markdown (issue #245)', () => {
  const render = makeRenderer();

  const code = render('Before:\n```js\nconst a = 1;\n```\nAfter');
  assert.ok(code.includes('<code>const a = 1;</code>'), 'fenced code becomes a code element (no trailing br)');
  assert.ok(!code.includes('```'), 'fences are consumed');

  const inline = render('run `mdss index` now');
  assert.ok(inline.includes('<code>mdss index</code>'), 'inline code renders');

  const wiki = render('see [[auth guide]] for tokens');
  assert.match(wiki, /<a href="\/doc\?file=auth%20guide"[^>]*>auth guide<\/a>/, 'wikilinks deep-link to /doc');

  const bold = render('**important** and *subtle*');
  assert.ok(bold.includes('<strong>important</strong>'));
  assert.ok(bold.includes('<em>subtle</em>'));
});
