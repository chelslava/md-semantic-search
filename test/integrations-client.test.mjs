import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSearchClient, SEARCH_HIT_FIELDS } from '../integrations/shared/search-client.mjs';

/** fetch stub returning a canned response. */
function stubFetch(body, { status = 200 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init: init || null });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
  fn.calls = calls;
  return fn;
}

const ENVELOPE = {
  query: 'rotate api token',
  results: [
    { file: 'ops/keys.md', title: 'Keys', heading: 'Rotate', cosine: 0.9, score: 1.2,
      snippet: 'rotate the api token', startLine: 12, endLine: 20 },
    { file: 'ops/db.md', title: 'DB', heading: '', cosine: 0.5, score: 0.8,
      snippet: 'backup first', startLine: 3, endLine: 9 },
  ],
};

test('integrations client: search posts the canonical body and unwraps the envelope (issue #112)', async () => {
  const f = stubFetch(ENVELOPE);
  const client = createSearchClient({ baseUrl: 'http://127.0.0.1:8747/', fetchImpl: f });
  const hits = await client.search('rotate api token', { k: 5 });

  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'http://127.0.0.1:8747/search');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { query: 'rotate api token', k: 5 });
  assert.equal(hits.length, 2, 'envelope {results:[...]} unwrapped');
  assert.equal(hits[0].file, 'ops/keys.md');
  for (const field of SEARCH_HIT_FIELDS) {
    assert.ok(field in hits[0], `hit carries contract field ${field}`);
  }
});

test('integrations client: legacy bare-array daemon shape still works (issue #112)', async () => {
  // integrations/vscode historically expected this shape; the shared client
  // tolerates it so old daemons keep working with new clients.
  const f = stubFetch(ENVELOPE.results);
  const client = createSearchClient({ fetchImpl: f });
  const hits = await client.search('x');
  assert.equal(hits.length, 2);
});

test('integrations client: non-2xx becomes a thrown error with status (issue #112)', async () => {
  const client = createSearchClient({ fetchImpl: stubFetch({ error: 'rate limit exceeded' }, { status: 429 }) });
  await assert.rejects(() => client.search('x'), /HTTP 429/);

  const healthFail = createSearchClient({ fetchImpl: stubFetch({}, { status: 503 }) });
  await assert.rejects(() => healthFail.health(), /HTTP 503/);
});

test('integrations client: health probes GET /health and returns parsed body (issue #112)', async () => {
  const f = stubFetch({ ok: true, chunks: 42 });
  const client = createSearchClient({ baseUrl: 'http://localhost:9999', fetchImpl: f });
  const h = await client.health();
  assert.equal(f.calls[0].url, 'http://localhost:9999/health');
  assert.equal(f.calls[0].init, null, 'health is a plain GET');
  assert.equal(h.chunks, 42);
});

// ── issue #199: shared ask() streaming client + SSE frame splitter ──
import { extractSseFrames } from '../integrations/shared/search-client.mjs';

/** fetch stub streaming an SSE body chunk-by-chunk over a web ReadableStream. */
import { ReadableStream } from 'node:stream/web';
function sseStub(chunks, { status = 200, body = null } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init: init || null });
    if (status >= 400) return { ok: false, status, json: async () => body ?? { error: `boom ${status}` } };
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    return { ok: true, status, body: stream, json: async () => ({}) };
  };
  fn.calls = calls;
  return fn;
}

test('integrations client: extractSseFrames — frames, CR normalization, partial remainder', () => {
  const { frames, rest } = extractSseFrames('event: delta\r\ndata: {"t":"a"}\r\n\r\nnext-even');
  assert.deepEqual(frames, [{ event: 'delta', data: '{"t":"a"}' }]);
  assert.equal(rest, 'next-even');
  assert.deepEqual(extractSseFrames(': keepalive\n\n').frames, [], 'comment-only frames drop');
});

test('integrations client: ask streams frames, carries auth/session, resolves with done (issue #199)', async () => {
  const f = sseStub([
    'event: session\ndata: {"id":"s1","turns":1}\n\n',
    'event: delta\ndata: {"text":"Hel"}\n\n',
    'event: delta\ndata: {"text":"lo"}\n\nevent: done\nda',
    'ta: {"answer":"Hello","mode":"endpoint","sessionId":"s1"}\n\n',
  ]);
  const client = createSearchClient({ baseUrl: 'http://d.test', apiKey: 'sk', fetchImpl: f });
  const frames = [];
  const done = await client.ask('next question', {
    sessionId: 's1',
    onFrame: (event, obj) => frames.push([event, obj]),
  });

  assert.equal(f.calls[0].url, 'http://d.test/ask');
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer sk');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { query: 'next question', k: 5, sessionId: 's1' });

  assert.deepEqual(frames.map((fr) => fr[0]), ['session', 'delta', 'delta', 'done'], 'all frames delivered in order');
  assert.deepEqual(frames[1][1], { text: 'Hel' });
  assert.equal(done.answer, 'Hello', 'promise resolves with the done payload');
  assert.equal(done.sessionId, 's1');
});

test('integrations client: ask body shapes — chat flag vs one-shot, error detail surfaces (issue #199)', async () => {
  const f = sseStub(['event: done\ndata: {"answer":"a"}\n\n']);
  const client = createSearchClient({ baseUrl: 'http://d.test', fetchImpl: f });
  await client.ask('q', { chat: true });
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { query: 'q', k: 5, chat: true });
  await client.ask('q');
  assert.deepEqual(JSON.parse(f.calls[1].init.body), { query: 'q', k: 5 }, 'one-shot sends neither sessionId nor chat');

  const bad = createSearchClient({ baseUrl: 'http://d.test', fetchImpl: sseStub([], { status: 400, body: { error: 'POST /ask requires an LLM chat endpoint' } }) });
  await assert.rejects(() => bad.ask('q'), /requires an LLM chat endpoint/, 'daemon 400 detail is preserved');
});
