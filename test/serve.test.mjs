import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { buildIndex } from '../dist/indexer.js';
import { createServe, DEFAULT_HOST, MAX_BODY_BYTES } from '../dist/serve.js';
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
    headers: { 'content-type': 'application/json' },
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
      const h = await fetch(`${srv.url}/health`).then(r => r.json());
      assert.equal(h.ok, true);
      assert.equal(h.chunks, 1);
      assert.equal(h.model, 'Xenova/multilingual-e5-base');

      const miss = await fetch(`${srv.url}/nope`);
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
        headers: { 'content-type': 'application/json' },
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
    fs.rmSync(dir, { recursive: true, force: true });
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
        headers: { 'content-type': 'application/json' },
        body: '{"query": "coffee", broken json',
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.ok(data.error.includes('invalid JSON'), `clear 400 message, got: ${data.error}`);
    } finally {
      await srv.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
