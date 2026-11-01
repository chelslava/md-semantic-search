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

/**
 * Opens the GET /mcp SSE stream (issue #197: it doubles as the server→client
 * downlink) and exposes parsed JSON frames plus a small polling wait helper.
 */
function openSse(url, sessionId) {
  const frames = [];
  let buf = '';
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: '/mcp',
      method: 'GET',
      headers: { 'mcp-session-id': sessionId, authorization: 'Bearer sekret', accept: 'text/event-stream' },
    }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
          if (dataLine) {
            try { frames.push(JSON.parse(dataLine.slice(5).trim())); } catch { /* keep-alive comment frames etc. */ }
          }
        }
      });
      resolve({ res, frames });
    });
    req.on('error', reject);
    req.end();
  });
}

function waitForFrame(frames, predicate, what, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const found = frames.find(predicate);
      if (found) return resolve(found);
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 20);
    };
    tick();
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
      // issue #197: the negotiation matrix below fires a dozen+ POSTs from
      // one client — this test is about protocol behavior, not rate limiting
      rateLimit: 0,
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

    // unsupported version falls back to the newest we support (issue #197)
    const init2 = await mcpPost(url, {
      jsonrpc: '2.0', id: 2, method: 'initialize',
      params: { protocolVersion: '1999-01-01' },
    }, sid);
    assert.equal(init2.body.result.protocolVersion, '2025-11-25');

    // negotiation matrix over the wire: every supported version echoes…
    for (const [i, v] of ['2025-06-18', '2025-03-26', '2024-11-05'].entries()) {
      const r = await mcpPost(url, {
        jsonrpc: '2.0', id: 20 + i, method: 'initialize',
        params: { protocolVersion: v },
      }, sid);
      assert.equal(r.body.result.protocolVersion, v, `${v} echoed`);
    }

    // …and ping answers an empty result (issue #197)
    const ping = await mcpPost(url, { jsonrpc: '2.0', id: 30, method: 'ping' }, sid);
    assert.equal(ping.status, 200);
    assert.deepEqual(ping.body.result, {});

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
    assert.ok(Array.isArray(call.body.result.structuredContent?.results), 'tool returned object structuredContent (issue #205)');
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

test('mcp-http: session ids are server-minted; a foreign id is 404 before any tool runs (issue #182)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-mcph-sess-'));
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
      const init = await mcpPost(url, {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      });
      const sid = init.headers['mcp-session-id'];
      assert.ok(sid, 'server mints the session id');

      // foreign (attacker-chosen) id → 404, and NOT echoed back
      const foreign = await mcpPost(url, {
        jsonrpc: '2.0', id: 2, method: 'tools/list',
      }, 'attacker-controlled-session-id');
      assert.equal(foreign.status, 404, 'foreign session id rejected with 404');
      assert.notEqual(foreign.headers['mcp-session-id'], 'attacker-controlled-session-id', 'foreign id is never adopted');

      // the server's own id still works
      const own = await mcpPost(url, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, sid);
      assert.equal(own.status, 200);
      assert.equal(own.headers['mcp-session-id'], sid, 'own id echoed');
    } finally {
      await svc.close();
      safeRm(dir);
    }
  } finally {
    safeRm(dir);
  }
});

test('mcp-http: sampling round-trip — server drives client LLM over the SSE downlink (issue #197)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-mcph-smp-'));
  const idx = path.join(dir, '.mdss');
  const prevTimeout = process.env.MDSS_SAMPLING_TIMEOUT_MS;
  process.env.MDSS_SAMPLING_TIMEOUT_MS = '8000';
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
      const init = await mcpPost(url, {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: { sampling: {} }, clientInfo: { name: 't', version: '0' } },
      });
      assert.equal(init.body.result.protocolVersion, '2025-11-25');
      const sid = init.headers['mcp-session-id'];

      // the GET stream is the server→client downlink
      const sse = await openSse(url, sid);

      // tools/call blocks server-side until the sampled answer comes back
      const callPromise = mcpPost(url, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'ask_knowledge_base', arguments: { query: 'coffee' } },
      }, sid);

      const sampleReq = await waitForFrame(sse.frames, (f) => f.method === 'sampling/createMessage', 'sampling request frame');
      assert.ok(sampleReq.id, 'sampling request carries an id');
      assert.match(sampleReq.params.systemPrompt, /Markdown notes/);
      assert.equal(sampleReq.params.includeContext, 'thisServer');
      assert.ok(sampleReq.params.maxTokens >= 1);
      assert.equal(sampleReq.params.messages[0].role, 'user');
      assert.ok(sampleReq.params.messages[0].content.text.includes('coffee'), 'context + question in the user message');

      // client answers via plain POST carrying the sampling request id
      await mcpPost(url, {
        jsonrpc: '2.0',
        id: sampleReq.id,
        result: { role: 'assistant', content: { type: 'text', text: 'SAMPLED-HTTP: coffee is roasted beans' }, model: 'client-fake' },
      }, sid);

      const call = await callPromise;
      assert.equal(call.status, 200);
      assert.equal(call.body.result.structuredContent.answerMode, 'sampling');
      assert.ok(call.body.result.structuredContent.answer.includes('SAMPLED-HTTP'), 'client LLM answer surfaces over HTTP');

      sse.res.destroy();
    } finally {
      await svc.close();
      safeRm(dir);
    }
  } finally {
    if (prevTimeout === undefined) delete process.env.MDSS_SAMPLING_TIMEOUT_MS;
    else process.env.MDSS_SAMPLING_TIMEOUT_MS = prevTimeout;
    safeRm(dir);
  }
});

test('mcp-http: sampling stays best-effort — no SSE stream → extractive answer, no hang (issue #197)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-mcph-fb-'));
  const idx = path.join(dir, '.mdss');
  const prevTimeout = process.env.MDSS_SAMPLING_TIMEOUT_MS;
  process.env.MDSS_SAMPLING_TIMEOUT_MS = '1000';
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# Tea\n\ntea leaves steeped notes\n');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: path.join(dir, '.c'), modelName: 'e5-base', embedFn: fakeEmbed });
    const svc = await createServe({
      indexDir: idx, cacheDir: path.join(dir, '.c'), embedFn: fakeEmbed,
      mcp: true, apiKey: 'sekret', ui: false,
    });
    await new Promise((r) => svc.server.listen(0, r));
    const url = `http://127.0.0.1:${svc.server.address().port}`;
    try {
      // client declares sampling but never opens the GET /mcp downlink —
      // the server's send throws, the tool degrades, nothing hangs
      const init = await mcpPost(url, {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: { sampling: {} }, clientInfo: { name: 't', version: '0' } },
      });
      const sid = init.headers['mcp-session-id'];

      const call = await mcpPost(url, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'ask_knowledge_base', arguments: { query: 'tea' } },
      }, sid);
      assert.equal(call.status, 200);
      assert.equal(call.body.result.isError ?? false, false);
      assert.equal(call.body.result.structuredContent.answerMode, 'extractive');
      assert.ok(call.body.result.structuredContent.answer.length > 0);
    } finally {
      await svc.close();
      safeRm(dir);
    }
  } finally {
    if (prevTimeout === undefined) delete process.env.MDSS_SAMPLING_TIMEOUT_MS;
    else process.env.MDSS_SAMPLING_TIMEOUT_MS = prevTimeout;
    safeRm(dir);
  }
});
