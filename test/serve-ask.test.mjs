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

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mdss-ask-${prefix}-`));
}

function safeRm(p) {
  if (!p) return;
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {}
}

/** Local OpenAI-compatible SSE chat server (the #199 wire format). */
async function startFakeChat() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push({ url: req.url, body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const words = ['Rotated ', 'tokens ', 'keep ', 'access ', 'tight.'];
      let i = 0;
      // drip the answer word by word so the SSE framing is real
      const timer = setInterval(() => {
        if (i < words.length) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: words[i++] } }] })}\n\n`);
        } else {
          clearInterval(timer);
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }, 5);
      res.on('close', () => clearInterval(timer));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    calls,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => { server.close(); server.closeAllConnections?.(); },
  };
}

/** POST /ask and collect the SSE stream as [{event, data}]. */
async function postAsk(url, body, apiKey) {
  const res = await fetch(`${url}/ask`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'connection': 'close',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    return { status: res.status, data: await res.json() };
  }
  const frames = [];
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      const dataLines = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      if (dataLines.length) frames.push({ event, data: JSON.parse(dataLines.join('\n')) });
    }
  }
  return { status: res.status, frames };
}

test('serve: POST /ask streams sources → deltas → done over SSE (issue #199)', async () => {
  const dir = tempDir('e2e');
  const idx = path.join(dir, '.mdss');
  const fake = await startFakeChat();
  try {
    fs.writeFileSync(
      path.join(dir, 'security.md'),
      '# Security Guide\n\n## Token Rotation\n\nAPI tokens must be rotated every 90 days to keep access tight.\n'
    );
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    const svc = await createServe({ indexDir: idx, cacheDir: dir, embedFn: fakeEmbed, llmEndpoint: fake.url });
    await new Promise((r) => svc.server.listen(0, r));
    const url = `http://127.0.0.1:${svc.server.address().port}`;
    try {
      const { status, frames } = await postAsk(url, { query: 'token rotation policy', k: 3 });
      assert.equal(status, 200);
      const events = frames.map((f) => f.event);
      assert.equal(events[0], 'sources', 'sources frame comes first');
      assert.ok(frames[0].data.citations.length >= 1, 'citations ride the sources frame');
      assert.equal(frames[0].data.citations[0].file, 'security.md');

      const deltas = frames.filter((f) => f.event === 'delta');
      assert.ok(deltas.length >= 2, `several delta frames, got ${deltas.length}`);
      assert.deepEqual(
        deltas.map((f) => f.data.text).join(''),
        'Rotated tokens keep access tight.',
        'deltas concatenate to the full answer'
      );

      const done = frames.find((f) => f.event === 'done');
      assert.ok(done, 'a done frame terminates the stream');
      assert.equal(done.data.answer, 'Rotated tokens keep access tight.');
      assert.equal(done.data.mode, 'endpoint');
      assert.ok(Array.isArray(done.data.citations));
      assert.ok(Array.isArray(done.data.citationsUsed), 'citationsUsed rides the done frame');
      assert.ok(done.data.citationsUsed.length <= done.data.citations.length);

      // the daemon actually called the chat endpoint with the OpenAI wire format
      assert.equal(fake.calls.length, 1);
      assert.ok(fake.calls[0].url.endsWith('/chat/completions'));
      assert.equal(fake.calls[0].body.stream, true);
    } finally {
      await svc.close();
    }
  } finally {
    fake.close();
    safeRm(dir);
  }
});

test('serve: POST /ask without --llm-endpoint is a 400, never a silent degrade (issue #199)', async () => {
  const dir = tempDir('noend');
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# Note\n\nsome grounded content here for the index\n');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    const svc = await createServe({ indexDir: idx, cacheDir: dir, embedFn: fakeEmbed });
    await new Promise((r) => svc.server.listen(0, r));
    try {
      const { status, data } = await postAsk(`http://127.0.0.1:${svc.server.address().port}`, { query: 'q' });
      assert.equal(status, 400);
      assert.match(data.error, /--llm-endpoint/);
    } finally {
      await svc.close();
    }
  } finally {
    safeRm(dir);
  }
});

test('serve: POST /ask validation — bad JSON, missing query, oversized body (issue #199)', async () => {
  const dir = tempDir('valid');
  const idx = path.join(dir, '.mdss');
  const fake = await startFakeChat();
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# Note\n\nsome grounded content here for the index\n');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    const svc = await createServe({ indexDir: idx, cacheDir: dir, embedFn: fakeEmbed, llmEndpoint: fake.url });
    await new Promise((r) => svc.server.listen(0, r));
    const base = `http://127.0.0.1:${svc.server.address().port}`;
    try {
      const bad = await fetch(`${base}/ask`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'connection': 'close' },
        body: '{not json',
      });
      assert.equal(bad.status, 400);

      const noQuery = await postAsk(base, { k: 3 });
      assert.equal(noQuery.status, 400);

      const long = await postAsk(base, { query: 'x'.repeat(2049) });
      assert.equal(long.status, 400);

      assert.equal(fake.calls.length, 0, 'rejected requests never reach the LLM');
    } finally {
      await svc.close();
    }
  } finally {
    fake.close();
    safeRm(dir);
  }
});

// ── issue #199 follow-up: chat mode (persistent sessions over SSE) ──

test('serve: POST /ask chat:true starts a persisted session; sessionId continues it (issue #199)', async () => {
  const dir = tempDir('chat');
  const idx = path.join(dir, '.mdss');
  const fake = await startFakeChat();
  try {
    fs.writeFileSync(
      path.join(dir, 'security.md'),
      '# Security Guide\n\n## Token Rotation\n\nAPI tokens must be rotated every 90 days to keep access tight.\n'
    );
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    const svc = await createServe({ indexDir: idx, cacheDir: dir, db: dir, embedFn: fakeEmbed, llmEndpoint: fake.url });
    await new Promise((r) => svc.server.listen(0, r));
    const url = `http://127.0.0.1:${svc.server.address().port}`;
    try {
      // turn 1: chat:true → new session
      const first = await postAsk(url, { query: 'token rotation policy', chat: true });
      assert.equal(first.status, 200);
      const sessionFrame = first.frames.find((f) => f.event === 'session');
      assert.ok(sessionFrame, 'a session frame opens a chat stream');
      assert.equal(sessionFrame.data.turns, 0);
      const done1 = first.frames.find((f) => f.event === 'done');
      assert.ok(done1.data.sessionId, 'done frame carries the session id');
      assert.equal(done1.data.turnsCount, 1);
      assert.ok(Array.isArray(done1.data.manifest) && done1.data.manifest.length >= 1, 'manifest rides the done frame');
      assert.ok(Array.isArray(done1.data.citationsUsed));
      const sid = done1.data.sessionId;

      // session persisted to the same store `mdss chat` uses
      const sessionJson = JSON.parse(fs.readFileSync(path.join(idx, 'sessions', `${sid}.json`), 'utf8'));
      assert.equal(sessionJson.turns.length, 1);

      // turn 2: same sessionId → context carries over
      const second = await postAsk(url, { query: 'and what about the expiry window?', sessionId: sid });
      assert.equal(second.status, 200);
      const sessionFrame2 = second.frames.find((f) => f.event === 'session');
      assert.equal(sessionFrame2.data.id, sid);
      assert.equal(sessionFrame2.data.turns, 1, 'previous turn visible in the session frame');
      const done2 = second.frames.find((f) => f.event === 'done');
      assert.equal(done2.data.turnsCount, 2);
      assert.equal(done2.data.sessionId, sid);

      const sessionJson2 = JSON.parse(fs.readFileSync(path.join(idx, 'sessions', `${sid}.json`), 'utf8'));
      assert.equal(sessionJson2.turns.length, 2);
    } finally {
      await svc.close();
    }
  } finally {
    fake.close();
    safeRm(dir);
  }
});

test('serve: POST /ask rejects an unsafe sessionId with 400 before the stream opens (issue #149 discipline)', async () => {
  const dir = tempDir('badsid');
  const idx = path.join(dir, '.mdss');
  const fake = await startFakeChat();
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# Note\n\nsome grounded content here for the index\n');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    const svc = await createServe({ indexDir: idx, cacheDir: dir, embedFn: fakeEmbed, llmEndpoint: fake.url });
    await new Promise((r) => svc.server.listen(0, r));
    try {
      const res = await fetch(`http://127.0.0.1:${svc.server.address().port}/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'connection': 'close' },
        body: JSON.stringify({ query: 'q', sessionId: '../evil' }),
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /invalid sessionId/);
      assert.equal(fake.calls.length, 0, 'rejected request never reaches the LLM');
      assert.equal(fs.existsSync(path.join(dir, 'evil.json')), false, 'no traversal write');
    } finally {
      await svc.close();
    }
  } finally {
    fake.close();
    safeRm(dir);
  }
});
