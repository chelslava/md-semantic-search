import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSseParser, openAiDeltaText, ollamaDeltaText, resolveChatProvider,
} from '../dist/providers.js';

/** The unref'd timeout guards (idle guard, AbortSignal.timeout, sampling
 * timer) fire only while the event loop is alive; injected fetch stubs hold
 * no handles, so the loop can drain before the guard fires — the node:test
 * runner holds it on some versions (24) and drains it on others (22).
 * Tests that WAIT on such a guard hold a refed keepalive timer for their
 * duration; production behavior is untouched. */
function withLoopKeepalive(ms, fn) {
  return async (...args) => {
    const keep = setTimeout(() => {}, ms);
    try {
      return await fn(...args);
    } finally {
      clearTimeout(keep);
    }
  };
}


/** Collect SSE parser output for a scripted sequence of raw chunks. */
function feed(chunks) {
  const out = [];
  const p = createSseParser((d) => out.push(d));
  for (const c of chunks) p.push(c);
  p.end();
  return out;
}

test('chat: sse parser — frames, CRLF, comments, multi-line data (issue #199)', () => {
  assert.deepEqual(feed(['data: a\n\n']), ['a']);
  assert.deepEqual(feed(['data: a\r\n\r\n']), ['a'], 'CRLF line + CRLF frame end');
  assert.deepEqual(
    feed([': keepalive\n\ndata: x\n\n']),
    ['x'],
    'comment lines are dropped, not dispatched'
  );
  assert.deepEqual(
    feed(['data: line1\ndata: line2\n\n']),
    ['line1\nline2'],
    'multi-line data fields join with \\n'
  );
  assert.deepEqual(
    feed(['event: delta\ndata: x\n\n']),
    ['x'],
    'non-data fields are ignored, data still dispatches'
  );
  assert.deepEqual(feed(['data: x\n', 'data:']), ['x\n'], 'empty data line joins with \\n, closes the frame');
});

test('chat: sse parser — chunk boundaries never split a frame (issue #199)', () => {
  const whole = 'data: {"a":1}\n\ndata: {"b":2}\n\n';
  // one byte at a time
  assert.deepEqual(feed([...whole].map((c) => c)), ['{"a":1}', '{"b":2}']);
  // CRLF pair torn across two chunks
  assert.deepEqual(feed(['data: x\r', '\n\r', '\ndata: y\n\n']), ['x', 'y']);
  // no trailing newline: end() flushes the pending line + frame
  assert.deepEqual(feed(['data: tail']), ['tail']);
  assert.deepEqual(feed(['data: a\n\ndata: b']), ['a', 'b']);
  assert.deepEqual(feed([]), [], 'empty stream emits nothing');
});

test('chat: delta extractors — openai payloads and ollama NDJSON lines (issue #199)', () => {
  assert.equal(openAiDeltaText('{"choices":[{"delta":{"content":"hi"}}]}'), 'hi');
  assert.equal(openAiDeltaText('{"choices":[{"delta":{}}]}'), '');
  assert.equal(openAiDeltaText('{"choices":[{"delta":{"role":"assistant"}}]}'), '');
  assert.equal(openAiDeltaText('[DONE]'), '');
  assert.equal(openAiDeltaText('not json'), '');
  assert.equal(ollamaDeltaText('{"response":"tok","done":false}'), 'tok');
  assert.equal(ollamaDeltaText('{"done":true}'), '');
  assert.equal(ollamaDeltaText(''), '');
  assert.equal(ollamaDeltaText('garbage'), '');
});

/** Minimal Response-like object streaming an async-iterable body. */
function sseResponse(chunks, { status = 200 } = {}) {
  async function* body() {
    for (const c of chunks) yield c;
  }
  return { ok: status >= 200 && status < 300, status, body: body(), text: async () => '' };
}

/** fetch stub that records calls and answers per-URL. */
function stubFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, headers: init?.headers || {}, body: JSON.parse(init.body) });
    return handler(url, JSON.parse(init.body), init);
  };
  fn.calls = calls;
  return fn;
}

test('chat: openai provider — SSE deltas stream in order, bearer auth, model, stream flag (issue #199)', async () => {
  const f = stubFetch((url, body, init) => {
    assert.equal(url, 'http://llm.test/v1/chat/completions');
    assert.deepEqual(body.messages, [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
    assert.equal(body.stream, true);
    assert.equal(body.model, 'qwen2.5');
    assert.equal(init.headers.authorization, 'Bearer sk-file-key');
    return sseResponse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: [DONE]\n\n',
    ]);
  });
  const chat = resolveChatProvider({
    provider: 'openai', model: 'qwen2.5', baseUrl: 'http://llm.test/v1',
    keyFile: testKeyFile('sk-file-key'), fetchImpl: f,
  });
  const deltas = [];
  const full = await chat.complete({ system: 'sys', user: 'usr', onDelta: (d) => deltas.push(d) });
  assert.equal(full, 'Hello');
  assert.deepEqual(deltas, ['Hel', 'lo'], 'deltas stream before the promise resolves');
});

test('chat: ollama provider — legacy /api/generate wire format, NDJSON deltas (issue #199)', async () => {
  const f = stubFetch((url, body) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/generate');
    assert.equal(body.stream, true);
    assert.equal(body.model, 'llama3', 'legacy default model kept');
    assert.equal(body.prompt, 'sysusr', 'single prompt string, byte-identical to pre-#199');
    return sseResponse([
      '{"response":"He","done":false}\n',
      '{"response":"y","done":false}\n',
      '{"done":true}\n',
    ]);
  });
  const chat = resolveChatProvider({ provider: 'ollama', fetchImpl: f });
  const deltas = [];
  const full = await chat.complete({ system: 'sys', user: 'usr', onDelta: (d) => deltas.push(d) });
  assert.equal(full, 'Hey');
  assert.deepEqual(deltas, ['He', 'y']);
});

test('chat: openai provider falls back to /api/generate once on 404 (issue #199)', async () => {
  const f = stubFetch((url) => {
    if (url.endsWith('/chat/completions')) {
      return sseResponse([], { status: 404 });
    }
    assert.equal(url, 'http://ollamabox.test/api/generate');
    return sseResponse(['{"response":"legacy","done":true}\n']);
  });
  const chat = resolveChatProvider({ provider: 'openai', model: 'm', baseUrl: 'http://ollamabox.test', fetchImpl: f });
  const full = await chat.complete({ system: 's', user: 'u' });
  assert.equal(full, 'legacy');
  assert.equal(f.calls.length, 2, 'exactly one fallback attempt');
});

test('chat: openai provider does NOT fall back on auth/server errors (issue #199)', async () => {
  const f = stubFetch((url) => sseResponse([], { status: url.endsWith('/chat/completions') ? 401 : 200 }));
  const chat = resolveChatProvider({ provider: 'openai', baseUrl: 'http://x.test', fetchImpl: f });
  await assert.rejects(() => chat.complete({ system: 's', user: 'u' }), /HTTP 401/);
  assert.equal(f.calls.length, 1, 'no /api/generate retry after a 401');

  const f5 = stubFetch(() => sseResponse([], { status: 500 }));
  const chat5 = resolveChatProvider({ provider: 'openai', baseUrl: 'http://x.test', fetchImpl: f5 });
  await assert.rejects(() => chat5.complete({ system: 's', user: 'u' }), /HTTP 500/);
  assert.equal(f5.calls.length, 1);
});

/** Body stub that hangs until the guard's abort signal tears it down —
 * mirrors undici, where an aborted request errors the stream. The rejection
 * promise is created BEFORE the first yield so a synchronous abort (external
 * signal fired from inside a delta callback) is not missed. */
function hangingBody(init, prelude = '') {
  const teardown = new Promise((_, reject) => {
    if (init.signal.aborted) reject(init.signal.reason);
    else init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });
  async function* body() {
    if (prelude) yield prelude;
    await teardown;
  }
  return body();
}

test('chat: hung streaming endpoint aborts on the IDLE timeout, not a whole-request deadline (issue #199 x #184)', withLoopKeepalive(5_000, async () => {
  const orig = process.env.MDSS_FETCH_TIMEOUT_MS;
  process.env.MDSS_FETCH_TIMEOUT_MS = '60';
  try {
    // streams one chunk fast, then hangs until the guard's abort tears the
    // body down — exactly how a stalled upstream looks on a real socket
    const f = async (url, init) => ({
      ok: true,
      status: 200,
      body: hangingBody(init, 'data: {"choices":[{"delta":{"content":"first"}}]}\n\n'),
      text: async () => '',
    });
    const chat = resolveChatProvider({ provider: 'openai', baseUrl: 'http://slow.test', fetchImpl: f });
    const t0 = Date.now();
    await assert.rejects(
      () => chat.complete({ system: 's', user: 'u' }),
      (err) => err.name === 'TimeoutError'
    );
    assert.ok(Date.now() - t0 < 5_000, `idle abort fired quickly, took ${Date.now() - t0}ms`);

    // hung CONNECT (headers never arrive) fails on the same guard
    const never = (url, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal.reason));
      });
    const chat2 = resolveChatProvider({ provider: 'openai', baseUrl: 'http://blackhole.test', fetchImpl: never });
    await assert.rejects(() => chat2.complete({ system: 's', user: 'u' }), (err) => err.name === 'TimeoutError');
  } finally {
    if (orig === undefined) delete process.env.MDSS_FETCH_TIMEOUT_MS;
    else process.env.MDSS_FETCH_TIMEOUT_MS = orig;
  }
}));

test('chat: external signal cancels an in-flight stream (serve client disconnect)', async () => {
  const f = async (url, init) => ({
    ok: true,
    status: 200,
    body: hangingBody(init, 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
    text: async () => '',
  });
  const chat = resolveChatProvider({ provider: 'openai', baseUrl: 'http://x.test', fetchImpl: f });
  const ac = new AbortController();
  const p = chat.complete({
    system: 's', user: 'u',
    onDelta: () => ac.abort(new Error('client went away')),
    signal: ac.signal,
  });
  await assert.rejects(() => p, /client went away/);
});

test('chat: default endpoints — openai api base and OLLAMA_HOST (issue #199)', async () => {
  const f = stubFetch((_url) => sseResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n']));
  const openai = resolveChatProvider({ provider: 'openai', fetchImpl: f });
  await openai.complete({ system: 's', user: 'u' });
  assert.equal(f.calls[0].url, 'https://api.openai.com/v1/chat/completions');

  const orig = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = 'http://hostbox.test:1234';
  try {
    const f2 = stubFetch((_url) => sseResponse(['{"response":"ok","done":true}\n']));
    const ollama = resolveChatProvider({ provider: 'ollama', fetchImpl: f2 });
    await ollama.complete({ system: 's', user: 'u' });
    assert.equal(f2.calls[0].url, 'http://hostbox.test:1234/api/generate');
  } finally {
    if (orig === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = orig;
  }
});

// ── helpers ────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Write a key file (loadApiKeyFile chmod-checks on POSIX). */
function testKeyFile(key) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-chatkey-'));
  const file = path.join(dir, 'k.txt');
  fs.writeFileSync(file, `${key}\n`);
  return file;
}
