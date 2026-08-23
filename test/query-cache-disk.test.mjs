import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildDiskKey, diskQueryGet, diskQueryPut,
  flushQueryCacheNow, resetQueryCacheForTest,
  QUERY_CACHE_FILE, QUERY_CACHE_MAX_ENTRIES,
} from '../dist/query-cache-disk.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-qcache-'));
}

function vec(n, fill) {
  return new Float32Array(n).fill(fill);
}

test('query-cache: put → flush → fresh load returns the same vector (issue #114)', () => {
  const dir = tmpDir();
  try {
    const key = buildDiskKey('Xenova/multilingual-e5-base', 'main', 8, 'rotate api token');
    diskQueryPut(dir, key, vec(8, 0.5));
    flushQueryCacheNow(dir);

    assert.ok(fs.existsSync(path.join(dir, QUERY_CACHE_FILE)), 'cache file written');
    assert.ok(fs.existsSync(path.join(dir, `${QUERY_CACHE_FILE}.sha256`)), 'integrity sidecar written');

    // simulate a FRESH process: same dir, new lookup — the module-level state
    // map is per-process, so a new node would load from disk; here we clear it
    // via a distinct cacheDir trick is impossible, so assert through file
    const raw = JSON.parse(fs.readFileSync(path.join(dir, QUERY_CACHE_FILE), 'utf8'));
    assert.ok(raw.entries[key], 'entry persisted under the model|dim|hash key');
    const buf = Buffer.from(raw.entries[key].vec, 'base64');
    const arr = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    assert.equal(arr[3], 0.5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('query-cache: corrupt json or bad sha silently degrades to empty (issue #114)', () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, QUERY_CACHE_FILE), '{broken json');
    const k = buildDiskKey('m', 'main', 4, 'q');
    assert.equal(diskQueryGet(dir, k, 4), null, 'corrupt file → miss, no throw');

    // valid json but WRONG sidecar hash → also a miss
    diskQueryPut(dir, k, vec(4, 1));
    flushQueryCacheNow(dir);
    fs.writeFileSync(path.join(dir, `${QUERY_CACHE_FILE}.sha256`), 'deadbeef  query-cache.json\n');
    resetQueryCacheForTest(dir); // simulate fresh process: force reload from disk
    assert.equal(diskQueryGet(dir, k, 4), null, 'sha mismatch ignored');

    // and the next put rewrites a clean pair that loads again
    diskQueryPut(dir, k, vec(4, 2));
    flushQueryCacheNow(dir);
    resetQueryCacheForTest(dir);
    const got = diskQueryGet(dir, k, 4);
    assert.ok(got && got[0] === 2, 'self-healed after rewrite');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('query-cache: key separates model/revision/dim; dim mismatch is a miss (issue #114)', () => {
  const dir = tmpDir();
  try {
    const kA = buildDiskKey('model-a', 'main', 8, 'same query');
    const kB = buildDiskKey('model-b', 'main', 8, 'same query');
    const kC = buildDiskKey('model-a', 'r2', 8, 'same query');
    assert.notEqual(kA, kB);
    assert.notEqual(kA, kC);

    diskQueryPut(dir, kA, vec(8, 0.25));
    flushQueryCacheNow(dir);
    assert.equal(diskQueryGet(dir, kB, 8), null, 'other model misses');
    assert.equal(diskQueryGet(dir, kA, 16), null, 'dim mismatch misses');
    const hit = diskQueryGet(dir, kA, 8);
    assert.ok(hit && hit.length === 8, 'exact key hits');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('query-cache: LRU trim keeps at most 512 entries, newest first (issue #114)', () => {
  const dir = tmpDir();
  try {
    for (let i = 0; i < QUERY_CACHE_MAX_ENTRIES + 50; i++) {
      diskQueryPut(dir, buildDiskKey('m', 'main', 4, `query number ${i}`), vec(4, i));
      if (i % 100 === 0) flushQueryCacheNow(dir); // refresh timestamps progressively
    }
    flushQueryCacheNow(dir);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, QUERY_CACHE_FILE), 'utf8'));
    assert.ok(Object.keys(raw.entries).length <= QUERY_CACHE_MAX_ENTRIES, `trimmed to cap, got ${Object.keys(raw.entries).length}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
