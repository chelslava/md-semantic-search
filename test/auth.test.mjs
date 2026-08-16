import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServe, isAuthorizedToken } from '../dist/serve.js';
import { buildIndex } from '../dist/indexer.js';

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

function request(url, opts = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: opts.method || 'GET',
        headers: opts.headers || {},
      },
      (res) => {
        let resBody = '';
        res.on('data', (chunk) => (resBody += chunk));
        res.on('end', () => {
          let data;
          try {
            data = JSON.parse(resBody);
          } catch {
            data = resBody;
          }
          resolve({ status: res.statusCode, headers: res.headers, data });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

test('auth: isAuthorizedToken performs secure comparison', () => {
  assert.equal(isAuthorizedToken('secret-token-123', 'secret-token-123'), true);
  assert.equal(isAuthorizedToken('wrong-token', 'secret-token-123'), false);
  assert.equal(isAuthorizedToken('short', 'secret-token-123'), false);
  assert.equal(isAuthorizedToken('', 'secret-token-123'), false);
  assert.equal(isAuthorizedToken(null, 'secret-token-123'), false);
});

test('auth: serve without apiKey permits unauthenticated requests', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-auth-free-'));
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# Coffee Guide\n\n## Brewing\n\ncoffee guide beans roasted\n');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, embedFn: fakeEmbed });

    const { server, close } = await createServe({
      indexDir: idx, cacheDir: dir, db: dir, embedFn: fakeEmbed,
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    const health = await request(`${baseUrl}/health`);
    assert.equal(health.status, 200);

    const searchRes = await request(`${baseUrl}/search`, { method: 'POST' }, { query: 'coffee' });
    assert.equal(searchRes.status, 200);

    await close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('auth: serve with apiKey enforces Bearer authentication', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-auth-key-'));
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# Coffee Guide\n\n## Brewing\n\ncoffee guide beans roasted ground\n');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });

    const { server, close } = await createServe({
      indexDir: idx, cacheDir: dir, db: dir, embedFn: fakeEmbed,
      apiKey: 'secret-token-42',
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    // 1. Missing Auth header -> 401
    const unauthSearch = await request(`${baseUrl}/search`, { method: 'POST' }, { query: 'coffee' });
    assert.equal(unauthSearch.status, 401);
    assert.equal(unauthSearch.data.error, 'unauthorized');

    // 2. Wrong token -> 401
    const badTokenSearch = await request(
      `${baseUrl}/search`,
      { method: 'POST', headers: { Authorization: 'Bearer wrong-key' } },
      { query: 'coffee' }
    );
    assert.equal(badTokenSearch.status, 401);

    // 3. Correct token -> 200
    const validSearch = await request(
      `${baseUrl}/search`,
      { method: 'POST', headers: { Authorization: 'Bearer secret-token-42' } },
      { query: 'coffee' }
    );
    assert.equal(validSearch.status, 200);
    assert.equal(validSearch.data.results.length > 0, true);

    await close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('auth: healthPublic option permits /health unauthenticated while requiring auth for /search', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-auth-health-'));
  const idx = path.join(dir, '.mdss');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '# Coffee Guide\n\n## Brewing\n\ncoffee guide beans roasted\n');
    await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, embedFn: fakeEmbed });

    const { server, close } = await createServe({
      indexDir: idx, cacheDir: dir, db: dir, embedFn: fakeEmbed,
      apiKey: 'my-api-key', healthPublic: true,
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    // /health works without auth header when healthPublic is true
    const health = await request(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.data.ok, true);

    // /search still requires auth
    const searchNoAuth = await request(`${baseUrl}/search`, { method: 'POST' }, { query: 'coffee' });
    assert.equal(searchNoAuth.status, 401);

    const searchAuth = await request(
      `${baseUrl}/search`,
      { method: 'POST', headers: { Authorization: 'Bearer my-api-key' } },
      { query: 'coffee' }
    );
    assert.equal(searchAuth.status, 200);

    await close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
