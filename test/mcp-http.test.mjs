import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { buildIndex } from '../dist/indexer.js';
import { createServe } from '../dist/serve.js';

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

/** JSON-RPC POST helper carrying the session id. */
function mcpPost(url, body, sessionId, key = 'sekret') {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = { 'content-type': 'application/json' };
    if (key) headers.authorization = `Bearer ${key}`;
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const req = http.request({ hostname: u.hostname, port: u.port, path: '/mcp', method: 'POST', headers }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: d ? JSON.parse(d) : null,
      }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('mcp-http: initialize → tools/list → tools/call over Streamable HTTP behind auth (issue #123)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-mcph-'));
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# Coffee\n\ncoffee beans roasted ground notes here\n');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: path.join(dir, '.c'), modelName: 'e5-base', embedFn: fakeEmbed });
    const svc = await createServe({
      indexDir: idx, cacheDir: path.join(dir, '.c'), embedFn: fakeEmbed,
      mcp: true, apiKey: 'sekret', ui: false,
    });
    await new Promise((r) => svc.server.listen(0, r));
    const url = `http://127.0.0.1:${svc.server.address().port}`;
    try {
    const denied = await mcpPost(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, null, null);
    assert.equal(denied.status, 401, 'no token → 401 on /mcp');

    // initialize negotiates the requested supported version + mints session id
    const init = await mcpPost(url, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    });
    assert.equal(init.status, 200);
    assert.match(init.headers['content-type'], /json/);
    assert.equal(init.body.result.protocolVersion, '2025-03-26', 'supported requested version echoed');
    const sid = init.headers['mcp-session-id'];
    assert.ok(sid, 'session id minted');

    // unsupported version falls back to latest we support
    const init2 = await mcpPost(url, {
      jsonrpc: '2.0', id: 2, method: 'initialize',
      params: { protocolVersion: '1999-01-01' },
    }, sid);
    assert.equal(init2.body.result.protocolVersion, '2025-03-26');

    // tools/list over the session
    const list = await mcpPost(url, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, sid);
    const names = list.body.result.tools.map((t) => t.name);
    assert.ok(names.includes('search_markdown'), 'search_markdown advertised');

    // tools/call actually searches and returns structuredContent
    const call = await mcpPost(url, {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'search_markdown', arguments: { query: 'coffee', k: 3 } },
    }, sid);
    assert.equal(call.status, 200);
    const text = call.body.result.content?.[0]?.text || '';
    assert.ok(/coffee/i.test(text), 'tool returned search content');
    assert.ok(Array.isArray(call.body.result.structuredContent), 'tool returned structuredContent');
    assert.equal(call.body.result.isError ?? false, false);

    // resources/list and resources/read over HTTP
    const resList = await mcpPost(url, { jsonrpc: '2.0', id: 5, method: 'resources/list' }, sid);
    assert.equal(resList.status, 200);
    assert.ok(resList.body.result.resources.some((r) => r.uri.includes('a.md')));

    const resRead = await mcpPost(url, {
      jsonrpc: '2.0', id: 6, method: 'resources/read', params: { uri: 'mdss://note/a.md' },
    }, sid);
    assert.equal(resRead.status, 200);
    assert.ok(resRead.body.result.contents[0].text.includes('# Coffee'));

    // prompts/list and prompts/get over HTTP
    const pList = await mcpPost(url, { jsonrpc: '2.0', id: 7, method: 'prompts/list' }, sid);
    assert.equal(pList.status, 200);
    assert.ok(pList.body.result.prompts.some((p) => p.name === 'search-and-cite'));

    const pGet = await mcpPost(url, {
      jsonrpc: '2.0', id: 8, method: 'prompts/get', params: { name: 'summarize-note', arguments: { note: 'a.md' } },
    }, sid);
    assert.equal(pGet.status, 200);
    assert.ok(pGet.body.result.messages[0].content.text.includes('mdss://note/a.md'));

    // notifications → 202 empty
    const note = await mcpPost(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid);
    assert.equal(note.status, 202);
    assert.equal(note.body, null);

    // GET opens the SSE server-channel
    const sse = await new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      const u = new URL(url);
      const req = http.request(
        { hostname: u.hostname, port: u.port, path: '/mcp', method: 'GET', headers: { 'mcp-session-id': sid, authorization: 'Bearer sekret' } },
        (res) => {
          const info = { status: res.statusCode, type: res.headers['content-type'] };
          res.once('data', () => done(info)); // first byte of the stream proves it's live
          res.resume();
          setTimeout(() => done(info), 800);
        },
      );
      req.on('error', () => done(null));
      req.end();
    });
    assert.ok(sse && String(sse.type).includes('text/event-stream'), 'GET /mcp is SSE');

    const del = await new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = http.request(
        { hostname: u.hostname, port: u.port, path: '/mcp', method: 'DELETE', headers: { authorization: 'Bearer sekret' } },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(del, 204, 'DELETE terminates with 204');
    } finally {
      await svc.close();
    }
  } finally {
    safeRm(dir);
  }
});

test('mcp-http: transport is opt-in — /mcp is 404 without --mcp; stdio untouched (issue #123)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-mcph-off-'));
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# Tea\n\ntea leaves notes\n');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: path.join(dir, '.c'), modelName: 'e5-base', embedFn: fakeEmbed });
    const svc = await createServe({ indexDir: idx, cacheDir: path.join(dir, '.c'), embedFn: fakeEmbed });
    await new Promise((r) => svc.server.listen(0, r));
    const url = `http://127.0.0.1:${svc.server.address().port}`;
    const r = await mcpPost(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, null, null);
    assert.equal(r.status, 404, '/mcp absent unless opted in');
    await svc.close();
  } finally {
    safeRm(dir);
  }
});
