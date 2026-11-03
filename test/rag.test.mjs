import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { buildIndex } from '../dist/indexer.js';
import {
  askQuestion, synthesizeAnswer, extractAnswerFallback,
  chatTurn, saveChatSession, loadChatSession, listChatSessions,
  extractUsedCitations, DEFAULT_RAG_SYSTEM_PROMPT,
} from '../dist/rag.js';

function safeRm(p) {
  if (!p) return;
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {}
}

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

test('rag: extractAnswerFallback builds grounded sentences with citations', () => {
  const passages = [
    {
      file: 'auth.md',
      heading: 'Tokens',
      title: 'Authentication Guide',
      score: 0.92,
      cosine: 0.92,
      snippet: 'API tokens must be rotated every 90 days to maintain compliance.',
      body: 'API tokens must be rotated every 90 days to maintain compliance.',
    },
  ];

  const answer = extractAnswerFallback('rotate tokens', passages);
  assert.ok(answer.includes('API tokens must be rotated every 90 days'));
  assert.ok(answer.includes('[auth.md › Tokens]'));
});

test('rag: synthesizeAnswer uses custom llmFn when supplied', async () => {
  const passages = [
    {
      file: 'config.md',
      heading: 'Database',
      title: 'Database Setup',
      score: 0.88,
      cosine: 0.88,
      snippet: 'The database connection pool maximum size is 25.',
    },
  ];

  let receivedPrompt = '';
  const result = await synthesizeAnswer('What is the pool size?', passages, {
    llmFn: async (prompt) => {
      receivedPrompt = prompt;
      return 'The connection pool size is 25 [config.md#Database].';
    },
  });

  assert.ok(receivedPrompt.includes('The database connection pool maximum size is 25.'));
  assert.equal(result.answer, 'The connection pool size is 25 [config.md#Database].');
  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0].file, 'config.md');
  assert.equal(result.mode, 'llm');
});

test('rag: synthesizeAnswer llmRequestFn gets a system/user split and degrades on failure (issue #197)', async () => {
  const passages = [
    {
      file: 'config.md',
      heading: 'Database',
      title: 'Database Setup',
      score: 0.88,
      cosine: 0.88,
      snippet: 'The database connection pool maximum size is 25.',
    },
  ];

  let received;
  const result = await synthesizeAnswer('What is the pool size?', passages, {
    systemPrompt: 'SYS-PROMPT-MARKER',
    conversationHistory: 'User: hi\nAssistant: hello',
    llmRequestFn: async (req) => {
      received = req;
      return 'Structured answer 25.';
    },
  });

  assert.ok(received.system.includes('SYS-PROMPT-MARKER'), 'system prompt rides the system field');
  assert.equal(received.system.includes('connection pool'), false, 'context stays out of system');
  assert.ok(received.user.includes('Conversation History:'), 'history rides the user field');
  assert.ok(received.user.includes('The database connection pool maximum size is 25.'));
  assert.ok(received.user.includes('What is the pool size?'));
  assert.equal(result.answer, 'Structured answer 25.');
  assert.equal(result.mode, 'llm');

  // system+user concatenation reproduces the historical single-string prompt
  let flat = '';
  await synthesizeAnswer('What is the pool size?', passages, {
    systemPrompt: 'SYS-PROMPT-MARKER',
    conversationHistory: 'User: hi\nAssistant: hello',
    llmFn: async (prompt) => { flat = prompt; return 'x'; },
  });
  assert.equal(flat, received.system + received.user, 'llmFn prompt unchanged by the refactor');

  // a failing structured hook falls through to the extractive answer
  const degraded = await synthesizeAnswer('What is the pool size?', passages, {
    llmRequestFn: async () => { throw new Error('client refused'); },
  });
  assert.equal(degraded.mode, 'extractive');
  assert.ok(degraded.answer.includes('Based on your notes:'));
});

test('rag: askQuestion executes full retrieval and grounded synthesis', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-rag-'));
  const db = path.join(root, 'notes');
  const indexDir = path.join(root, '.mdss');
  fs.mkdirSync(db, { recursive: true });

  try {
    fs.writeFileSync(
      path.join(db, 'deploy.md'),
      '# Deployment Guide\n\n## Canary Releases\n\nCanary releases route 5 percent of traffic to the new cluster.\n'
    );

    await buildIndex({
      db,
      indexDir,
      cacheDir: root,
      modelName: 'e5-base',
      embedFn: fakeEmbed,
    });

    const result = await askQuestion({
      query: 'traffic canary release',
      indexDir,
      cacheDir: root,
      k: 3,
      embedFn: fakeEmbed,
    });

    assert.ok(result.answer.length > 0);
    assert.ok(result.citations.length >= 1);
    assert.equal(result.citations[0].file, 'deploy.md');
  } finally {
    safeRm(root);
  }
});

test('rag: chat sessions persist, list, and degrade gracefully on corruption (issue #147)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-session-'));
  const indexDir = path.join(root, '.mdss');
  fs.mkdirSync(indexDir, { recursive: true });

  try {
    // 1. Create and save session
    const s1 = {
      id: 'session-123',
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
      turns: [
        {
          id: 'turn-1',
          timestamp: '2026-08-30T00:00:00.000Z',
          query: 'hello',
          answer: 'hi',
          citations: [],
          manifest: [],
        },
      ],
    };
    saveChatSession(indexDir, s1);

    // 2. Load session
    const loaded = loadChatSession(indexDir, 'session-123');
    assert.equal(loaded.id, 'session-123');
    assert.equal(loaded.turns.length, 1);
    assert.equal(loaded.turns[0].query, 'hello');

    // 3. List sessions
    const list = listChatSessions(indexDir);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'session-123');
    assert.equal(list[0].turnsCount, 1);

    // 4. Corrupt session degrades safely
    const corruptPath = path.join(indexDir, 'sessions', 'session-corrupt.json');
    fs.writeFileSync(corruptPath, '{ not valid json', 'utf8');
    let loggedWarning = '';
    const fallback = loadChatSession(indexDir, 'session-corrupt', (msg) => { loggedWarning = msg; });
    assert.equal(fallback.id, 'session-corrupt');
    assert.equal(fallback.turns.length, 0);
    assert.ok(loggedWarning.includes('failed to parse session'));
  } finally {
    safeRm(root);
  }
});

test('rag: chat session ids cannot escape the sessions directory (issue #149)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-session-safe-'));
  const indexDir = path.join(root, '.mdss');
  fs.mkdirSync(indexDir, { recursive: true });
  const session = {
    id: '../../outside',
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
    turns: [],
  };

  try {
    assert.throws(() => saveChatSession(indexDir, session), /Invalid session ID/);
    assert.throws(() => loadChatSession(indexDir, '../../outside'), /Invalid session ID/);
    assert.equal(fs.existsSync(path.join(root, 'outside.json')), false);
    assert.equal(fs.existsSync(path.join(root, 'outside.0.tmp')), false);
  } finally {
    safeRm(root);
  }
});

test('rag: multi-turn chatTurn maintains context, saves session, and guarantees citations ⊆ manifest (issue #147)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-chat-'));
  const db = path.join(root, 'notes');
  const indexDir = path.join(root, '.mdss');
  fs.mkdirSync(db, { recursive: true });

  try {
    fs.writeFileSync(
      path.join(db, 'deploy.md'),
      '# Deployment Guide\n\n## Canary Releases\n\nCanary releases route 5 percent of traffic to the new cluster.\n'
    );
    fs.writeFileSync(
      path.join(db, 'database.md'),
      '# Database Guide\n\n## Failover\n\nDatabase failover promotes replica 2 to primary within 30 seconds.\n'
    );

    await buildIndex({
      db,
      indexDir,
      cacheDir: root,
      modelName: 'e5-base',
      embedFn: fakeEmbed,
    });

    const sessionId = 'test-session-abc';
    const session = loadChatSession(indexDir, sessionId);

    // Turn 1: Canary releases
    const turn1 = await chatTurn({
      session,
      query: 'Canary release traffic',
      indexDir,
      cacheDir: root,
      k: 3,
      embedFn: fakeEmbed,
    });

    assert.equal(turn1.session.turns.length, 1);
    assert.ok(turn1.answer.includes('Canary releases'));
    assert.ok(turn1.manifest.length >= 1);
    assert.ok(turn1.manifest[0].startLine !== undefined);
    assert.ok(turn1.manifest[0].chunkHash);

    // Citation subset check: every citation file/heading exists in manifest
    for (const c of turn1.citations) {
      assert.ok(turn1.manifest.some((m) => m.file === c.file && m.heading === c.heading));
    }

    // Turn 2: Follow-up question with context carry-over
    const turn2 = await chatTurn({
      session: turn1.session,
      query: 'What percentage?',
      indexDir,
      cacheDir: root,
      k: 3,
      embedFn: fakeEmbed,
    });

    assert.equal(turn2.session.turns.length, 2);
    assert.ok(turn2.answer.includes('5 percent'));

    // Verify session persistence on disk
    const reloaded = loadChatSession(indexDir, sessionId);
    assert.equal(reloaded.turns.length, 2);
    assert.equal(reloaded.turns[0].query, 'Canary release traffic');
    assert.equal(reloaded.turns[1].query, 'What percentage?');
  } finally {
    safeRm(root);
  }
});

test('rag: askQuestion and chatTurn propagate offline: true and custom embedFn (issue #152)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-rag-offline-'));
  const db = path.join(root, 'notes');
  const indexDir = path.join(root, '.mdss');
  fs.mkdirSync(db, { recursive: true });

  let askEmbedCalled = false;
  let chatEmbedCalled = false;

  const trackingEmbedAsk = async (texts, kind, model, cacheDir, offline) => {
    assert.equal(offline, true);
    askEmbedCalled = true;
    return fakeEmbed(texts, kind, model);
  };

  const trackingEmbedChat = async (texts, kind, model, cacheDir, offline) => {
    assert.equal(offline, true);
    chatEmbedCalled = true;
    return fakeEmbed(texts, kind, model);
  };

  try {
    fs.writeFileSync(
      path.join(db, 'airgap.md'),
      '# Air-Gapped Guide\n\n## Isolation\nAir-gapped clusters operate without any external internet connection.\n'
    );

    await buildIndex({
      db,
      indexDir,
      cacheDir: root,
      modelName: 'e5-base',
      embedFn: fakeEmbed,
    });

    // 1. askQuestion with offline: true
    const askRes = await askQuestion({
      query: 'air gap isolation',
      indexDir,
      cacheDir: root,
      k: 3,
      offline: true,
      embedFn: trackingEmbedAsk,
    });

    assert.ok(askEmbedCalled);
    assert.ok(askRes.answer.includes('Air-gapped'));

    // 2. chatTurn with offline: true
    const chatRes = await chatTurn({
      query: 'external network isolation',
      indexDir,
      cacheDir: root,
      k: 3,
      offline: true,
      embedFn: trackingEmbedChat,
    });

    assert.ok(chatEmbedCalled);
    assert.ok(chatRes.answer.includes('Air-gapped'));
  } finally {
    safeRm(root);
  }
});



test('rag: hung Ollama endpoint falls back to the extractive answer on the fetch timeout (issue #184)', async () => {
  const orig = process.env.MDSS_FETCH_TIMEOUT_MS;
  process.env.MDSS_FETCH_TIMEOUT_MS = '50';
  const blackhole = http.createServer(() => {
    /* accept the connection, never respond */
  });
  await new Promise((r) => blackhole.listen(0, '127.0.0.1', r));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-rag-hang-'));
  const db = path.join(root, 'notes');
  const indexDir = path.join(root, '.mdss');
  fs.mkdirSync(db, { recursive: true });
  try {
    fs.writeFileSync(
      path.join(db, 'deploy.md'),
      '# Deployment Guide\n\n## Canary Releases\n\nCanary releases route 5 percent of traffic to the new cluster.\n'
    );
    await buildIndex({ db, indexDir, cacheDir: root, modelName: 'e5-base', embedFn: fakeEmbed });

    const { port } = blackhole.address();
    const t0 = Date.now();
    const result = await askQuestion({
      query: 'traffic canary release',
      indexDir,
      cacheDir: root,
      k: 3,
      embedFn: fakeEmbed,
      llmEndpoint: `http://127.0.0.1:${port}`,
      llmModel: 'llama3',
    });
    assert.ok(result.answer.length > 0, 'extractive fallback answered');
    assert.ok(result.citations.length >= 1);
    assert.ok(Date.now() - t0 < 5_000, `degraded quickly, took ${Date.now() - t0}ms`);
  } finally {
    if (orig === undefined) delete process.env.MDSS_FETCH_TIMEOUT_MS;
    else process.env.MDSS_FETCH_TIMEOUT_MS = orig;
    blackhole.close();
    blackhole.closeAllConnections?.();
    safeRm(root);
  }
});

// ── issue #199: unified OpenAI-compatible chat provider + SSE streaming ──

/** Local OpenAI-compatible SSE chat server; returns { url, calls, close }. */
async function startFakeOpenAiChat(deltas) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const d of deltas) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    calls,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => { server.close(); server.closeAllConnections?.(); },
  };
}

/** Local Ollama-native NDJSON server; returns { url, calls, close }. */
async function startFakeOllamaGenerate(deltas) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      for (const d of deltas) res.write(`${JSON.stringify({ response: d, done: false })}\n`);
      res.write(`${JSON.stringify({ done: true })}\n`);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    calls,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => { server.close(); server.closeAllConnections?.(); },
  };
}

test('rag: synthesizeAnswer streams via the openai chat path by default (issue #199)', async () => {
  const fake = await startFakeOpenAiChat(['Hel', 'lo, ', 'notes']);
  try {
    const deltas = [];
    const result = await synthesizeAnswer('q', [
      { file: 'a.md', heading: 'H', title: 'T', score: 0.9, cosine: 0.9, snippet: 's' },
    ], {
      llmEndpoint: fake.url,
      llmModel: 'qwen2.5',
      onDelta: (d) => deltas.push(d),
    });
    assert.equal(result.mode, 'endpoint');
    assert.equal(result.answer, 'Hello, notes');
    assert.deepEqual(deltas, ['Hel', 'lo, ', 'notes'], 'deltas arrive before the promise settles');
    // same wire format HyDE already speaks: {base}/chat/completions + messages split
    assert.ok(fake.calls[0].url.endsWith('/chat/completions'), `got ${fake.calls[0].url}`);
    assert.equal(fake.calls[0].body.messages[0].role, 'system');
    assert.equal(fake.calls[0].body.messages[0].content, DEFAULT_RAG_SYSTEM_PROMPT);
    assert.equal(fake.calls[0].body.messages[1].role, 'user');
    assert.ok(fake.calls[0].body.messages[1].content.includes('Context:'));
    assert.ok(fake.calls[0].body.messages[1].content.includes('Question: q'));
    assert.equal(fake.calls[0].body.stream, true);
    assert.equal(fake.calls[0].body.model, 'qwen2.5');
  } finally {
    fake.close();
  }
});

test('rag: --llm-provider ollama keeps the legacy /api/generate wire format (issue #199)', async () => {
  const fake = await startFakeOllamaGenerate(['leg', 'acy']);
  try {
    const deltas = [];
    const result = await synthesizeAnswer('my question', [
      { file: 'a.md', heading: 'H', title: 'T', score: 0.9, cosine: 0.9, snippet: 's' },
    ], {
      llmEndpoint: fake.url,
      llmProvider: 'ollama',
      llmModel: 'llama3',
      onDelta: (d) => deltas.push(d),
    });
    assert.equal(result.mode, 'endpoint');
    assert.equal(result.answer, 'legacy');
    assert.deepEqual(deltas, ['leg', 'acy']);
    assert.ok(fake.calls[0].url.endsWith('/api/generate'));
    assert.equal(fake.calls[0].body.stream, true, 'upgraded from stream:false to streaming');
    assert.equal(fake.calls[0].body.model, 'llama3');
    // the single-string prompt stays byte-identical to the pre-#199 format
    const user = fake.calls[0].body.prompt;
    assert.ok(user.startsWith(DEFAULT_RAG_SYSTEM_PROMPT));
    assert.ok(user.includes('Context:'));
    assert.ok(user.includes('Question: my question'));
  } finally {
    fake.close();
  }
});

test('rag: chat endpoint failure still degrades to the extractive answer (issue #199)', async () => {
  const result = await synthesizeAnswer('rotate tokens', [
    {
      file: 'auth.md', heading: 'Tokens', title: 'Auth', score: 0.9, cosine: 0.9,
      snippet: 'API tokens must be rotated every 90 days to maintain compliance.',
    },
  ], {
    llmEndpoint: 'http://127.0.0.1:1/v1', // nothing listens there — connect fails fast
  });
  assert.equal(result.mode, 'extractive');
  assert.ok(result.answer.includes('API tokens must be rotated'));
});

test('rag: llmChat injection seam bypasses endpoint construction (issue #199)', async () => {
  const { resolveChatProvider } = await import('../dist/providers.js');
  const seen = [];
  const fake = await startFakeOpenAiChat(['injected']);
  const chat = resolveChatProvider({
    provider: 'openai', baseUrl: fake.url,
    fetchImpl: async (url) => {
      seen.push(url);
      const { ReadableStream: RS } = await import('node:stream/web');
      const enc = new TextEncoder();
      const stream = new RS({
        start(c) {
          for (const d of ['data: {"choices":[{"delta":{"content":"injected"}}]}\n\n', 'data: [DONE]\n\n']) {
            c.enqueue(enc.encode(d));
          }
          c.close();
        },
      });
      return { ok: true, status: 200, body: stream, text: async () => '' };
    },
  });
  try {
    const result = await synthesizeAnswer('q', [
      { file: 'a.md', heading: 'H', title: 'T', score: 0.9, cosine: 0.9, snippet: 's' },
    ], { llmChat: chat });
    assert.equal(result.mode, 'endpoint');
    assert.equal(result.answer, 'injected');
    assert.equal(seen.length, 1);
  } finally {
    fake.close();
  }
});

test('rag: chatTurn propagates the synthesis mode (issue #199 — CLI interrupted-fallback detection)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-rag-mode-'));
  const db = path.join(root, 'notes');
  const indexDir = path.join(root, '.mdss');
  fs.mkdirSync(db, { recursive: true });
  const fake = await startFakeOpenAiChat(['streamed ', 'answer']);
  try {
    fs.writeFileSync(path.join(db, 'deploy.md'), '# Deploy\n\n## Rollback\n\nRoll back by re-running the previous release tag.\n');
    await buildIndex({ db, indexDir, cacheDir: root, modelName: 'e5-base', embedFn: fakeEmbed });

    const res = await chatTurn({
      query: 'how to roll back',
      indexDir,
      cacheDir: root,
      k: 3,
      embedFn: fakeEmbed,
      llmEndpoint: fake.url,
    });
    assert.equal(res.mode, 'endpoint', 'chatTurn exposes mode so the CLI can tell a full stream from a fallback');
    assert.equal(res.turn.mode, 'endpoint', 'persisted turn carries the mode too');
  } finally {
    fake.close();
    safeRm(root);
  }
});

test('rag: extractUsedCitations — bracket mentions, order, exclusion of unknown files (issue #199 follow-up)', () => {
  const citations = [
    { file: 'auth.md', heading: 'Tokens', score: 0.9 },
    { file: 'auth.md', heading: 'Sessions', score: 0.8 },
    { file: 'config.md', score: 0.7 },
  ];
  const answer = [
    'Rotate keys often [auth.md#Tokens]; sessions idle out [auth.md › Sessions].',
    'See [config.md] for defaults; [unrelated.md#Nope] is not in the manifest,',
    'a [link](https://example.com) and an empty [] are ignored.',
    'Repeat [auth.md#Tokens] counts once.',
  ].join(' ');

  const used = extractUsedCitations(answer, citations);
  assert.deepEqual(used.map((c) => [c.file, c.heading ?? null]), [
    ['auth.md', 'Tokens'],
    ['auth.md', 'Sessions'],
    ['config.md', null],
  ], 'first-mention order, heading formats unified, unknown/links excluded');

  assert.deepEqual(extractUsedCitations('no citations at all', citations), []);
  assert.deepEqual(extractUsedCitations('', citations), []);
});
