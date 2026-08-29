import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex } from '../dist/indexer.js';
import {
  askQuestion, synthesizeAnswer, extractAnswerFallback,
  chatTurn, saveChatSession, loadChatSession, listChatSessions,
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

