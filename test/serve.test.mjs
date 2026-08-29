import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { buildIndex } from '../dist/indexer.js';
import { createServe, DEFAULT_HOST, MAX_BODY_BYTES, isLoopbackHost, validateBindSecurity, loadApiKeyFile, TokenBucket } from '../dist/serve.js';

/** Fixed epoch for deterministic limiter tests. */
const T0 = 1_700_000_000_000;
import { searchIndex } from '../dist/search.js';
import { acquireIndexLock, releaseIndexLock } from '../dist/core.js';

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
  return fs.mkdtempSync(path.join(os.tmpdir(), `mdss-${prefix}-`));
}

function safeRm(p) {
  if (!p) return;
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {}
}

/** Start a server on an ephemeral port; returns {url, close}. */
async function startServe(opts) {
  const svc = await createServe(opts);
  await new Promise((resolve) => svc.server.listen(0, resolve));
  const { port } = svc.server.address();
  return {
    svc,
    url: `http://127.0.0.1:${port}`,
    close: async () => { await svc.close(); },
  };
}

async function post(url, body) {
  const res = await fetch(`${url}/search`, {
    method: 'POST',
    // 'connection: close' stops undici holding the keep-alive pool socket open
    // after the test server is closed. On Node 18 this would block process exit.
    headers: { 'content-type': 'application/json', 'connection': 'close' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

test('serve: real production path — /search without injected embedFn never says "embedFn is not a function" (issue #23)', async () => {
  const dir = tempDir('serve23');
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# Coffee\n\ncoffee guide beans roasted ground notes here\n');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    // Production path: NO embedFn/rerankFn overrides. offline:true makes the
    // real embed() fail fast on the (empty) temp cache instead of downloading
    // 280MB — the point is that the error is a model-load error, NOT
    // "embedFn is not a function" (the #23 regression).
    const srv = await startServe({ indexDir: idx, cacheDir: dir, offline: true });
    try {
      assert.equal(srv.svc.state.embedFn, undefined, 'embedFn stays undefined (not null)');
      assert.equal(srv.svc.state.rerankFn, undefined, 'rerankFn stays undefined (not null)');

      const res = await post(srv.url, { query: 'coffee', k: 3 });
      assert.equal(res.status, 500, 'offline + empty cache → model load error');
      assert.ok(
        !String(res.data?.error || '').includes('embedFn is not a function'),
        'must not crash on null embedFn — real embed() is used instead',
      );
    } finally {
      await srv.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('serve: /search returns results; second query reuses loaded index (issue #12)', async () => {
  const dir = tempDir('serve');
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# Coffee\n\ncoffee guide beans roasted ground notes\n');
    fs.writeFileSync(path.join(dir, 'b.md'), '# Hockey\n\nhockey match puck arena guide\n');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    const srv = await startServe({ indexDir: idx, cacheDir: dir, embedFn: fakeEmbed });
    try {
      const q1 = await post(srv.url, { query: 'coffee', k: 3 });
      assert.equal(q1.status, 200);
      assert.equal(q1.data.results[0].file, 'a.md', 'coffee query ranks a.md first');
      assert.ok(q1.data.count >= 1);

      const q2 = await post(srv.url, { query: 'hockey', k: 3 });
      assert.equal(q2.status, 200);
      assert.equal(q2.data.results[0].file, 'b.md', 'hockey ranks b.md first');

      // the loaded index object is NOT re-created between queries (issue #2)
      const before = srv.svc.state.loaded.index;
      await post(srv.url, { query: 'coffee', k: 1 });
      assert.equal(srv.svc.state.loaded.index, before, 'index parsed exactly once');
    } finally {
      await srv.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('serve: /search validation — missing query → 400 (issue #12)', async () => {
  const dir = tempDir('serve400');
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# Coffee\n\ncoffee beans roasted ground notes here\n');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    const srv = await startServe({ indexDir: idx, cacheDir: dir, embedFn: fakeEmbed });
    try {
      const bad = await post(srv.url, { k: 3 }); // no query
      assert.equal(bad.status, 400);
      assert.ok(bad.data.error.includes('query'), 'clear 400 message');
    } finally {
      await srv.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('serve: /health reports index + model; unknown route → 404 (issue #12)', async () => {
  const dir = tempDir('servehealth');
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# Coffee\n\ncoffee beans roasted ground notes here\n');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    const srv = await startServe({ indexDir: idx, cacheDir: dir, embedFn: fakeEmbed });
    try {
      const h = await fetch(`${srv.url}/health`, { headers: { 'connection': 'close' } }).then(r => r.json());
      assert.equal(h.ok, true);
      assert.equal(h.chunks, 1);
      assert.equal(h.model, 'Xenova/multilingual-e5-base');

      const miss = await fetch(`${srv.url}/nope`, { headers: { 'connection': 'close' } });
      assert.equal(miss.status, 404);
    } finally {
      await srv.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('serve: --watch re-indexes incrementally on file change (issue #12)', async () => {
  const dir = tempDir('servewatch');
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# Coffee\n\ncoffee beans roasted ground notes\n');
    fs.writeFileSync(path.join(dir, 'b.md'), '# Hockey\n\nhockey match puck arena notes\n');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    const srv = await startServe({
      db: dir, indexDir: idx, cacheDir: dir, embedFn: fakeEmbed,
      watch: true, watchInterval: 60, watchDelay: 150, // fast poll + short settle for the test
      rateLimit: 0, // this test hammers /search in a tight poll loop (issue #119 fairness would 429 it)
    });
    try {
      const before = await post(srv.url, { query: 'coffee', k: 5 });
      assert.equal(before.data.results.length, 1, 'only a.md matches before the change');

      // append a coffee mention to b.md and wait for the watcher to re-index
      fs.appendFileSync(path.join(dir, 'b.md'), '\nmore coffee notes\n');
      const deadline = Date.now() + 5000;
      let after;
      for (;;) {
        after = await post(srv.url, { query: 'coffee', k: 5 });
        if (after.data.results.length >= 2) break;
        if (Date.now() > deadline) break;
        await new Promise(r => setTimeout(r, 100));
      }
      assert.equal(after.data.results.length, 2, 'watcher picked up the change');
      const files = after.data.results.map(r => r.file).sort();
      assert.deepEqual(files, ['a.md', 'b.md']);
    } finally {
      await srv.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('serve: --watch ignores a no-op touch (mtime moves, content identical) (issue #42)', async () => {
  const dir = tempDir('servewatch-noop');
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# Coffee\n\ncoffee beans roasted ground notes\n');
    fs.writeFileSync(path.join(dir, 'b.md'), '# Hockey\n\nhockey match puck arena notes\n');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    const srv = await createServe({
      db: dir, indexDir: idx, cacheDir: dir, embedFn: fakeEmbed,
      watch: true, watchInterval: 40, watchDelay: 120,
    });
    // server is not listened on — access state through srv.state
    await new Promise(r => srv.server.listen(0, '127.0.0.1', r));
    try {
      // no-op: bump b.md's mtime a full minute into the future, same content
      const f = path.join(dir, 'b.md');
      const future = new Date(Date.now() + 60e3);
      fs.utimesSync(f, future, future);
      await new Promise(r => setTimeout(r, 120 + 40 * 10)); // settle delay + several polls
      assert.equal(srv.state.reindexCount ?? 0, 0,
        'no-op write must NOT trigger a re-index (md5-confirm filters it)');
    } finally {
      await srv.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('serve: --watch coalesces a rapid save-burst into ONE re-index (issue #42)', async () => {
  const dir = tempDir('servewatch-debounce');
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# Coffee\n\ncoffee beans roasted ground notes\n');
    fs.writeFileSync(path.join(dir, 'b.md'), '# Hockey\n\nhockey match puck arena notes\n');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    const srv = await createServe({
      db: dir, indexDir: idx, cacheDir: dir, embedFn: fakeEmbed,
      watch: true, watchInterval: 40, watchDelay: 120,
    });
    await new Promise(r => srv.server.listen(0, '127.0.0.1', r));
    try {
      // burst: three quick successive edits to the SAME file (each ~45ms
      // apart — never a full quiet poll between them)
      for (let i = 1; i <= 3; i++) {
        fs.appendFileSync(path.join(dir, 'b.md'), '\nburst edit ' + i + '\n');
        await new Promise(r => setTimeout(r, 45));
      }
      // let the debounce flush
      const deadline = Date.now() + 5000;
      while ((srv.state.reindexCount ?? 0) < 1) {
        if (Date.now() > deadline) break;
        await new Promise(r => setTimeout(r, 50));
      }
      assert.equal(srv.state.reindexCount, 1,
        'three rapid edits → exactly one re-index (debounce)');
      // and the latest content must be in the index
      const a = await searchIndex({ loaded: srv.state.loaded, cacheDir: dir,
        query: 'burst edit', k: 5, embedFn: fakeEmbed });
      assert.ok(a.some(r => r.file === 'b.md'), 'final burst content is what got indexed');
    } finally {
      await srv.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('serve: --watch defers re-indexing while another process holds the index lock (issue #37)', async () => {
  const dir = tempDir('servewatch-lock');
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# Tea\n\ngreen tea leaves steeped hot water\n');
    // Build the initial index OUTSIDE the test's lock so it exists before serve starts.
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    const logs = [];
    const srv = await createServe({
      db: dir, indexDir: idx, cacheDir: dir, embedFn: fakeEmbed,
      watch: true, watchInterval: 40, watchDelay: 120,
      log: (m) => logs.push(String(m)),
    });
    await new Promise(r => srv.server.listen(0, '127.0.0.1', r));
    try {
      // Capture the ORIGINAL embedded text of a.md — the deferral must keep the
      // SERVER index pinned to exactly this (a re-index would fold the appended
      // oolong line into the same single chunk's text).
      const origText = srv.state.loaded.index.chunks
        .filter(c => c.file === 'a.md').map(c => c.text).join('\n---\n');
      assert.ok(!/oolong/i.test(origText), 'fixture: original index predates the edit');

      // Another process is mid-index: take the lock and hold it.
      const held = acquireIndexLock(idx);
      assert.equal(held.acquired, true, 'fixture: we hold the lock as the foreign writer');

      // Edit the file — the watcher WILL want to re-index, but the held lock
      // must DEFER it (no corruption, polite yield).
      fs.appendFileSync(path.join(dir, 'a.md'), '\nmore words about oolong tea\n');
      await new Promise(r => setTimeout(r, 120 + 40 * 8)); // settle window + several polls
      assert.equal(srv.state.reindexCount ?? 0, 0,
        're-index is deferred while the foreign lock is held');
      assert.ok(logs.some(l => /deferred|being written/i.test(l)),
        'the deferral is logged, not silent');
      const mid = srv.state.loaded.index.chunks
        .filter(c => c.file === 'a.md').map(c => c.text).join('\n---\n');
      assert.equal(mid, origText,
        'while locked, the LIVE index is still the pre-edit one (no torn swap)');

      // Release — the next quiet window retried and the edit lands.
      releaseIndexLock(idx);
      const deadline = Date.now() + 5000;
      while ((srv.state.reindexCount ?? 0) < 1) {
        if (Date.now() > deadline) break;
        await new Promise(r => setTimeout(r, 60));
      }
      assert.equal(srv.state.reindexCount, 1,
        'once the lock frees, the deferred re-index runs');
      const after = srv.state.loaded.index.chunks
        .filter(c => c.file === 'a.md').map(c => c.text).join('\n---\n');
      assert.match(after, /oolong/, 'post-release index contains the edit');
    } finally {
      await srv.close();
    }
  } finally {
    safeRm(dir);
  }
});

test('serve: binds to loopback by default (DEFAULT_HOST, issue #16)', async () => {
  const dir = tempDir('servehost');
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# Coffee\n\ncoffee beans roasted ground notes here\n');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    const svc = await createServe({ indexDir: idx, cacheDir: dir, embedFn: fakeEmbed });
    try {
      // The production default: listen on DEFAULT_HOST (issue #16). The bound
      // address must be loopback (127.0.0.1 / ::1), NOT 0.0.0.0 / ::.
      await new Promise((resolve, reject) => {
        svc.server.listen(0, DEFAULT_HOST, (e) => e ? reject(e) : resolve());
      });
      const addr = svc.server.address();
      assert.ok(
        addr.address === '127.0.0.1' || addr.address === '::1' || addr.address === '::ffff:127.0.0.1',
        `bound address is loopback, got ${addr.address}`,
      );
    } finally {
      await svc.close();
    }
  } finally {
    safeRm(dir);
  }
});

test('serve: --host 0.0.0.0 opts into network exposure (issue #16)', async () => {
  const dir = tempDir('servehost0');
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# Coffee\n\ncoffee beans roasted ground notes here\n');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    const svc = await createServe({ indexDir: idx, cacheDir: dir, embedFn: fakeEmbed });
    try {
      await new Promise((resolve, reject) => {
        svc.server.listen(0, '0.0.0.0', (e) => e ? reject(e) : resolve());
      });
      const addr = svc.server.address();
      assert.equal(addr.address, '0.0.0.0', 'explicit --host 0.0.0.0 binds all interfaces');
    } finally {
      await svc.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('serve: oversized /search body → 413, connection not half-open (issue #16)', async () => {
  const dir = tempDir('serve413');
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# Coffee\n\ncoffee beans roasted ground notes here\n');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    const srv = await startServe({ indexDir: idx, cacheDir: dir, embedFn: fakeEmbed });
    try {
      // streamed body way over the 64KB cap, no Content-Length declared
      const big = 'x'.repeat(MAX_BODY_BYTES * 2);
      const res = await fetch(`${srv.url}/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'connection': 'close' },
        body: big,
      });
      assert.equal(res.status, 413, 'streamed oversized body rejected');
      assert.ok(String((await res.json()).error).includes('too large'), 'clear 413 message');

      // declared Content-Length over the cap → rejected before reading. fetch
      // (undici) validates content-length client-side, so use raw http.request
      // to prove the SERVER rejects it.
      const declared413 = await new Promise((resolve, reject) => {
        const u = new URL(`${srv.url}/search`);
        const req = http.request({
          hostname: u.hostname, port: u.port, path: '/search', method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': String(MAX_BODY_BYTES + 1),
          },
        }, (res) => {
          let d = '';
          res.on('data', (c) => { d += c; });
          res.on('end', () => resolve({ status: res.statusCode, body: d }));
        });
        req.on('error', reject);
        req.end('{"query":"coffee"}');
      });
      assert.equal(declared413.status, 413, 'declared oversized Content-Length rejected');
      assert.ok(declared413.body.includes('too large'), 'clear 413 message');

      // the connection stays usable for a normal request afterwards
      const ok = await post(srv.url, { query: 'coffee', k: 3 });
      assert.equal(ok.status, 200, 'same connection serves a normal request after 413');
    } finally {
      await srv.close();
    }
  } finally {
    safeRm(dir);
  }
});

test('serve: malformed JSON body → 400 with the parse error (issue #16)', async () => {
  const dir = tempDir('servebadjson');
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# Coffee\n\ncoffee beans roasted ground notes here\n');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    const srv = await startServe({ indexDir: idx, cacheDir: dir, embedFn: fakeEmbed });
    try {
      const res = await fetch(`${srv.url}/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'connection': 'close' },
        body: '{"query": "coffee", broken json',
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.ok(data.error.includes('invalid JSON'), `clear 400 message, got: ${data.error}`);
    } finally {
      await srv.close();
    }
  } finally {
    safeRm(dir);
  }
});

// ---------------------------------------------------------------------------
// Issue #121 — guard non-loopback binds without authentication; api-key-file
// ---------------------------------------------------------------------------

test('serve: isLoopbackHost classifies bind addresses (issue #121)', () => {
  assert.equal(isLoopbackHost(undefined), true, 'no host → loopback default');
  assert.equal(isLoopbackHost(''), true);
  for (const h of ['127.0.0.1', '::1', '[::1]', 'localhost', 'LOCALHOST', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackHost(h), true, `${h} is loopback`);
  }
  for (const h of ['0.0.0.0', '::', '192.168.1.10', '10.0.0.5', 'mdss.example.com', '127.0.0.2']) {
    assert.equal(isLoopbackHost(h), false, `${h} is NOT loopback`);
  }
});

test('serve: non-loopback + no key + no opt-in refuses to start (issue #121)', () => {
  // refusal with an actionable message
  let threw;
  try {
    validateBindSecurity({ host: '0.0.0.0', hasApiKey: false });
  } catch (e) {
    threw = e;
  }
  assert.ok(threw instanceof Error, 'throws on unsecured non-loopback bind');
  const msg = String(threw?.message || '');
  assert.ok(msg.includes('--api-key'), 'message suggests --api-key');
  assert.ok(msg.includes('--api-key-file'), 'message suggests --api-key-file');
  assert.ok(msg.includes('--allow-unsecured'), 'message suggests --allow-unsecured');

  // every escape hatch works
  assert.doesNotThrow(() => validateBindSecurity({ host: '0.0.0.0', hasApiKey: true }), 'with api key');
  assert.doesNotThrow(() => validateBindSecurity({ host: '0.0.0.0', hasApiKey: false, allowUnsecured: true }), 'with explicit opt-in');
  assert.doesNotThrow(() => validateBindSecurity({ host: '127.0.0.1', hasApiKey: false }), 'loopback never needs a key');
});

test('serve: loadApiKeyFile trims trailing newlines; missing/empty file errors (issue #121)', () => {
  const dir = tempDir('keyfile');
  try {
    const p = path.join(dir, 'key.txt');
    fs.writeFileSync(p, 's3cret\n');
    assert.equal(loadApiKeyFile(p), 's3cret', 'LF newline trimmed');
    fs.writeFileSync(p, 's3cret\r\n');
    assert.equal(loadApiKeyFile(p), 's3cret', 'CRLF newline trimmed');
    fs.writeFileSync(p, 's3cret\n\n\n');
    assert.equal(loadApiKeyFile(p), 's3cret', 'multiple trailing newlines trimmed');

    assert.throws(() => loadApiKeyFile(path.join(dir, 'nope.txt')), /cannot read/, 'missing file → clear error');
    fs.writeFileSync(p, '\n');
    assert.throws(() => loadApiKeyFile(p), /contains no key/, 'newline-only file → clear error');
  } finally {
    safeRm(dir);
  }
});

// ---------------------------------------------------------------------------
// Issue #120 — DNS-rebinding protection (Host allowlist), security headers,
// opt-in CORS
// ---------------------------------------------------------------------------

/** Raw request with full header control (undici always sets a loopback Host). */
function rawRequest(url, { method = 'GET', path: p = '/', headers = {} }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: p, method, headers },
      (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function startSecuredServe(extra = {}) {
  const dir = tempDir('serve120');
  const idx = path.join(dir, '.mdss');
  fs.writeFileSync(path.join(dir, 'a.md'), '# Coffee\n\ncoffee beans roasted ground notes here\n');
  await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
  const svc = await createServe({ indexDir: idx, cacheDir: dir, embedFn: fakeEmbed, ...extra });
  await new Promise((r) => svc.server.listen(0, r));
  const url = `http://127.0.0.1:${svc.server.address().port}`;
  return {
    url,
    close: async () => { await svc.close(); safeRm(dir); },
  };
}

test('serve: DNS-rebinding simulation — Host: evil.com rejected with 403 (issue #120)', async () => {
  const srv = await startSecuredServe();
  try {
    const evil = await rawRequest(srv.url, { path: '/search', method: 'POST', headers: { host: 'evil.com' } });
    assert.equal(evil.status, 403, 'rebound Host is rejected');
    assert.ok(evil.body.includes('untrusted Host'), 'clear 403 message');

    // A request with NO Host header at all (HTTP/1.0 over a raw socket) is
    // rejected too — there is no origin the server can vouch for.
    const port = new URL(srv.url).port;
    const noHost = await new Promise((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1', () => s.write('GET /health HTTP/1.0\r\n\r\n'));
      let d = '';
      s.on('data', (c) => { d += c; });
      s.on('end', () => resolve({ status: Number(d.match(/^HTTP\/[\d.]+ (\d{3})/)?.[1]), body: d }));
      s.on('error', reject);
    });
    assert.equal(noHost.status, 403, 'missing Host also rejected');
    assert.ok(noHost.body.includes('untrusted Host'), 'clear 403 message for missing Host');

    // the standard loopback spellings all pass
    for (const h of [`localhost:${new URL(srv.url).port}`, `127.0.0.1:${new URL(srv.url).port}`, `[::1]:${new URL(srv.url).port}`]) {
      const ok = await rawRequest(srv.url, { path: '/health', headers: { host: h } });
      assert.equal(ok.status, 200, `Host ${h} is accepted`);
    }
  } finally {
    await srv.close();
  }
});

test('serve: --allowed-host adds a trusted hostname to the allowlist (issue #120)', async () => {
  const srv = await startSecuredServe({ allowedHosts: ['wiki.corp.internal'] });
  try {
    const custom = await rawRequest(srv.url, { path: '/health', headers: { host: 'wiki.corp.internal' } });
    assert.equal(custom.status, 200, 'configured hostname accepted');

    const other = await rawRequest(srv.url, { path: '/health', headers: { host: 'other.corp.internal' } });
    assert.equal(other.status, 403, 'any other hostname still rejected');
  } finally {
    await srv.close();
  }
});

test('serve: security headers nosniff + no-store on every response (issue #120)', async () => {
  const srv = await startSecuredServe();
  try {
    const cases = [
      ['GET', '/health'],
      ['GET', '/nope'],                                   // 404
      ['POST', '/search', '{"query": ""}'],               // 400
      ['POST', '/search', '{"query": "coffee"}'],         // 200
    ];
    for (const [method, p, body] of cases) {
      const r = await rawRequest(srv.url, {
        method, path: p,
        headers: body ? { 'content-type': 'application/json' } : {},
      });
      if (body) r.reqBody = body;
      assert.equal(r.headers['x-content-type-options'], 'nosniff', `nosniff on ${method} ${p}`);
      assert.equal(r.headers['cache-control'], 'no-store', `no-store on ${method} ${p}`);
    }
  } finally {
    await srv.close();
  }
});

test('serve: CORS is OFF by default — no ACAO anywhere, OPTIONS → 405 (issue #120)', async () => {
  const srv = await startSecuredServe();
  try {
    const r = await rawRequest(srv.url, {
      path: '/search', method: 'POST',
      headers: { host: `localhost:${new URL(srv.url).port}`, origin: 'https://evil.example' },
    });
    assert.equal(r.headers['access-control-allow-origin'], undefined, 'no ACAO without opt-in');
    assert.equal(r.headers['vary'], undefined, 'no Vary without opt-in');

    const pre = await rawRequest(srv.url, { method: 'OPTIONS', path: '/search' });
    assert.equal(pre.status, 405, 'preflight refused while CORS disabled');
  } finally {
    await srv.close();
  }
});

test('serve: --cors-origin reflects ONLY exact matches, sends Vary: Origin (issue #120)', async () => {
  const srv = await startSecuredServe({ corsOrigins: ['https://notes.app'] });
  try {
    const port = new URL(srv.url).port;
    const good = await rawRequest(srv.url, {
      path: '/health', headers: { host: `localhost:${port}`, origin: 'https://notes.app' },
    });
    assert.equal(good.headers['access-control-allow-origin'], 'https://notes.app', 'exact origin reflected verbatim');
    assert.equal(good.headers['vary'], 'Origin', 'Vary: Origin set');

    const bad = await rawRequest(srv.url, {
      path: '/health', headers: { host: `localhost:${port}`, origin: 'https://evil.example' },
    });
    assert.equal(bad.headers['access-control-allow-origin'], undefined, 'non-exact origin NOT reflected');
    assert.equal(bad.headers['vary'], 'Origin', 'Vary: Origin still present for caches');

    const prefix = await rawRequest(srv.url, {
      path: '/health', headers: { host: `localhost:${port}`, origin: 'https://notes.app.evil.example' },
    });
    assert.equal(prefix.headers['access-control-allow-origin'], undefined, 'suffix-spoofed origin NOT reflected');

    const pre = await rawRequest(srv.url, {
      method: 'OPTIONS', path: '/search',
      headers: { host: `localhost:${port}`, origin: 'https://notes.app' },
    });
    assert.equal(pre.status, 204, 'preflight answered 204');
    assert.equal(pre.headers['access-control-allow-origin'], 'https://notes.app');
    assert.match(pre.headers['access-control-allow-methods'] || '', /POST/, 'methods advertised');
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// Issue #119 — rate limiting (token bucket) + concurrency caps for /search
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('serve: TokenBucket refills over time and reports Retry-After (issue #119)', () => {
  const b = new TokenBucket(60, 10); // 60/min = 1 token/sec
  b.lastTouched = T0; // pin the clock; take(now) below time-travels deterministically
  let t = T0;
  for (let i = 0; i < 10; i++) {
    assert.equal(b.take(t).ok, true, `burst token ${i + 1} available`);
  }
  const empty = b.take(t);
  assert.equal(empty.ok, false, 'burst exhausted');
  assert.ok(empty.retryAfterSec >= 1 && empty.retryAfterSec <= 60, `sane retry-after: ${empty.retryAfterSec}`);

  // refill: 1 token per second at 60/min
  assert.equal(b.take((t += 500)).ok, false, 'half a second is not enough');
  assert.equal(b.take((t += 500)).ok, true, 'a full second grants one token');
  assert.equal(b.take(t).ok, false, 'and only one');

  // tokens never exceed burst even after a long idle
  const b2 = new TokenBucket(60, 3);
  b2.lastTouched = T0;
  for (let i = 0; i < 3; i++) b2.take(T0);
  const longIdle = b2.take(T0 + 3_600_000);
  assert.equal(longIdle.ok, true, 'long idle refills up to burst');
});

test('serve: burst above rate limit gets 429 + Retry-After; legit traffic unaffected (issue #119)', async () => {
  const dir = tempDir('serve429');
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# Coffee\n\ncoffee beans roasted ground notes here\n');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    const srv = await startServe({ indexDir: idx, cacheDir: dir, embedFn: fakeEmbed, rateLimit: 5 });
    try {
      const statuses = [];
      let firstLimited = null;
      for (let i = 0; i < 8; i++) {
        const r = await post(srv.url, { query: 'coffee', k: 1 });
        statuses.push(r.status);
        if (r.status === 429 && !firstLimited) {
          firstLimited = await fetch(`${srv.url}/search`, {
            method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
            body: JSON.stringify({ query: 'coffee' }),
          });
        }
      }
      assert.deepEqual(statuses.slice(0, 5), [200, 200, 200, 200, 200], 'burst within limit passes');
      assert.ok(statuses.slice(5).every((s) => s === 429), 'overflow rejected with 429');

      const headers = Object.fromEntries(firstLimited.headers);
      assert.ok(Number(headers['retry-after']) >= 1, `Retry-After header present: ${headers['retry-after']}`);

      const h = await fetch(`${srv.url}/health`, { headers: { connection: 'close' } }).then((x) => x.json());
      assert.ok(h.rejected_total >= 3, `rejected_total counted: ${h.rejected_total}`);
    } finally {
      await srv.close();
    }
  } finally {
    safeRm(dir);
  }
});

test('serve: rateLimit=0 disables limiting — trusted setups unaffected (issue #119)', async () => {
  const dir = tempDir('serve429off');
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# Coffee\n\ncoffee beans roasted ground notes here\n');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    const srv = await startServe({ indexDir: idx, cacheDir: dir, embedFn: fakeEmbed, rateLimit: 0 });
    try {
      for (let i = 0; i < 25; i++) {
        const r = await post(srv.url, { query: 'coffee', k: 1 });
        if (r.status !== 200) throw new Error(`request ${i + 1} got ${r.status} — limiter should be OFF`);
      }
      const h = await fetch(`${srv.url}/health`, { headers: { connection: 'close' } }).then((x) => x.json());
      assert.equal(h.rate_limit_per_min, null, 'health reports limiter disabled');
    } finally {
      await srv.close();
    }
  } finally {
    safeRm(dir);
  }
});

test('serve: concurrency cap queues searches; queue overflow sheds with 503 (issue #119)', async () => {
  const dir = tempDir('serveconc');
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# Coffee\n\ncoffee beans roasted ground notes here\n');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    const slowEmbed = async (texts, kind, model) => {
      await sleep(120);
      return fakeEmbed(texts, kind, model);
    };
    // 1 slot + queue cap max(2*1, 4)=4 → requests 6..8 of an 8-burst get 503
    const srv = await startServe({
      indexDir: idx, cacheDir: dir, embedFn: slowEmbed,
      maxConcurrency: 1, rateLimit: 0,
    });
    try {
      const responses = await Promise.all(
        Array.from({ length: 8 }, () =>
          fetch(`${srv.url}/search`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', connection: 'close' },
            body: JSON.stringify({ query: 'coffee', k: 1 }),
          }).then(async (r) => ({ status: r.status, retryAfter: r.headers.get('retry-after') })),
        ),
      );
      const okCount = responses.filter((r) => r.status === 200).length;
      const busyCount = responses.filter((r) => r.status === 503).length;
      assert.equal(okCount, 5, `1 in flight + 4 queued succeed, got ${okCount}`);
      assert.equal(busyCount, 3, `queue overflow sheds with 503, got ${busyCount}`);
      assert.ok(responses.filter((r) => r.status === 503).every((r) => Number(r.retryAfter) >= 1),
        '503 carries Retry-After');

      // counters settle back once the storm drains
      await sleep(50);
      const h = await fetch(`${srv.url}/health`, { headers: { connection: 'close' } }).then((x) => x.json());
      assert.equal(h.in_flight, 0, 'in_flight returns to zero');
      assert.ok(h.rejected_total >= 3, `rejected_total counts 503s: ${h.rejected_total}`);
      assert.equal(h.max_concurrency, 1);
    } finally {
      await srv.close();
    }
  } finally {
    safeRm(dir);
  }
});

test('serve: GET /doc retrieves exact line span with EOF clamping (issue #140)', async () => {
  const dir = tempDir('serve-doc');
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(
      path.join(dir, 'manual.md'),
      '# Manual\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10\n'
    );
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    const srv = await startServe({ indexDir: idx, cacheDir: dir, embedFn: fakeEmbed });
    try {
      // 1. Missing file param -> 400
      const noFile = await fetch(`${srv.url}/doc`, { headers: { connection: 'close' } });
      assert.equal(noFile.status, 400);

      // 2. Normal span fromLine=2, maxLines=3
      const spanRes = await fetch(`${srv.url}/doc?file=manual.md&fromLine=2&maxLines=3`, { headers: { connection: 'close' } });
      assert.equal(spanRes.status, 200);
      const span = await spanRes.json();
      assert.equal(span.file, 'manual.md');
      assert.equal(span.fromLine, 2);
      assert.equal(span.toLine, 4);
      assert.equal(span.lineCount, 3);
      assert.equal(span.text, 'Line 2\nLine 3\nLine 4');

      // 3. Beyond EOF clamps to last line
      const eofRes = await fetch(`${srv.url}/doc?file=manual.md&fromLine=100`, { headers: { connection: 'close' } });
      assert.equal(eofRes.status, 200);
      const eof = await eofRes.json();
      assert.equal(eof.fromLine, eof.totalLines);
      assert.equal(eof.toLine, eof.totalLines);

      // 4. Non-existent file -> 404
      const missing = await fetch(`${srv.url}/doc?file=not-found.md`, { headers: { connection: 'close' } });
      assert.equal(missing.status, 404);
    } finally {
      await srv.close();
    }
  } finally {
    safeRm(dir);
  }
});

test('serve: POST /related & GET /related return ranked related notes (issue #141)', async () => {
  const dir = tempDir('serve-related');
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(path.join(dir, 'core.md'), '# Core\nCheck out the [[plugins.md]] architecture and [[api.md]] documentation.\n');
    fs.writeFileSync(path.join(dir, 'plugins.md'), '# Plugins\nPlugin module that extends the [[core.md]] framework with hooks.\n');
    fs.writeFileSync(path.join(dir, 'api.md'), '# API\nREST API and endpoints documentation for all services.\n');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
    const srv = await startServe({ indexDir: idx, cacheDir: dir, embedFn: fakeEmbed });
    try {
      // 1. POST /related
      const postRes = await fetch(`${srv.url}/related`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', connection: 'close' },
        body: JSON.stringify({ file: 'core.md', k: 5 }),
      });
      assert.equal(postRes.status, 200);
      const postData = await postRes.json();
      assert.equal(postData.resolvedFile, 'core.md');
      assert.ok(postData.results.length >= 2);

      // plugins.md is bi-directional
      const pluginsHit = postData.results.find((r) => r.file === 'plugins.md');
      assert.ok(pluginsHit);
      assert.ok(pluginsHit.reason.includes('bi-directional'));

      // 2. GET /related
      const getRes = await fetch(`${srv.url}/related?file=core.md&k=5`, {
        headers: { connection: 'close' },
      });
      assert.equal(getRes.status, 200);
      const getData = await getRes.json();
      assert.equal(getData.resolvedFile, 'core.md');

      // 3. 404 for unknown note
      const missingRes = await fetch(`${srv.url}/related?file=unknown-note.md`, {
        headers: { connection: 'close' },
      });
      assert.equal(missingRes.status, 404);
    } finally {
      await srv.close();
    }
  } finally {
    safeRm(dir);
  }
});


