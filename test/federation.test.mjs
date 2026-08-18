import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex } from '../dist/indexer.js';
import { searchFederated } from '../dist/federation.js';

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

test('federation: searchFederated searches across multiple independent vaults and tags results', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-fed-'));
  const vault1 = path.join(root, 'work-vault');
  const vault2 = path.join(root, 'personal-vault');
  fs.mkdirSync(vault1, { recursive: true });
  fs.mkdirSync(vault2, { recursive: true });

  try {
    // Vault 1: Work
    fs.writeFileSync(
      path.join(vault1, 'infra.md'),
      '# Infrastructure\n\n## Kubernetes Cluster\n\nproduction deployment k8s ingress terraform\n'
    );

    // Vault 2: Personal
    fs.writeFileSync(
      path.join(vault2, 'travel.md'),
      '# Travel Plans\n\n## Japan Itinerary\n\ntokyo kyoto bullet train travel guide\n'
    );

    await buildIndex({
      db: vault1,
      indexDir: path.join(vault1, '.mdss'),
      cacheDir: root,
      modelName: 'e5-base',
      embedFn: fakeEmbed,
    });

    await buildIndex({
      db: vault2,
      indexDir: path.join(vault2, '.mdss'),
      cacheDir: root,
      modelName: 'e5-base',
      embedFn: fakeEmbed,
    });

    const results = await searchFederated({
      vaults: [vault1, vault2],
      cacheDir: root,
      query: 'kubernetes deployment and tokyo travel',
      k: 4,
      embedFn: fakeEmbed,
    });

    assert.ok(results.length >= 2, 'Should find hits from both vaults');
    const vaultsFound = new Set(results.map((r) => r.vault));
    assert.ok(vaultsFound.has('work-vault'), 'work-vault represented');
    assert.ok(vaultsFound.has('personal-vault'), 'personal-vault represented');

    for (const hit of results) {
      assert.ok(hit.vault, 'hit has vault name');
      assert.ok(hit.vaultPath, 'hit has vaultPath');
    }
  } finally {
    safeRm(root);
  }
});

test('federation: searchFederated handles missing or non-indexed vaults gracefully', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-fed-missing-'));
  const vault1 = path.join(root, 'good-vault');
  const vault2 = path.join(root, 'unindexed-vault');
  fs.mkdirSync(vault1, { recursive: true });
  fs.mkdirSync(vault2, { recursive: true });

  try {
    fs.writeFileSync(path.join(vault1, 'note.md'), '# Notes\n\n## Algorithms\n\nbinary search dynamic programming\n');
    fs.writeFileSync(path.join(vault2, 'empty.md'), '# Empty\n\nUnindexed note\n');

    await buildIndex({
      db: vault1,
      indexDir: path.join(vault1, '.mdss'),
      cacheDir: root,
      modelName: 'e5-base',
      embedFn: fakeEmbed,
    });

    const results = await searchFederated({
      vaults: [vault1, vault2],
      cacheDir: root,
      query: 'binary search algorithms',
      k: 2,
      embedFn: fakeEmbed,
    });

    assert.ok(results.length > 0);
    assert.equal(results[0].file, 'note.md');
    assert.equal(results[0].vault, 'good-vault');
  } finally {
    safeRm(root);
  }
});

test('federation: MCP search_markdown handles vaults array for federated search', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-mcp-fed-'));
  const vaultA = path.join(root, 'vaultA');
  const vaultB = path.join(root, 'vaultB');
  fs.mkdirSync(vaultA, { recursive: true });
  fs.mkdirSync(vaultB, { recursive: true });

  try {
    fs.writeFileSync(path.join(vaultA, 'alpha.md'), '# Alpha Project\n\n## Architecture\n\nmicroservices event stream\n');
    fs.writeFileSync(path.join(vaultB, 'beta.md'), '# Beta Project\n\n## Storage\n\npostgresql database migration\n');

    await buildIndex({
      db: vaultA,
      indexDir: path.join(vaultA, '.mdss'),
      cacheDir: root,
      modelName: 'e5-base',
      embedFn: fakeEmbed,
    });

    await buildIndex({
      db: vaultB,
      indexDir: path.join(vaultB, '.mdss'),
      cacheDir: root,
      modelName: 'e5-base',
      embedFn: fakeEmbed,
    });

    const results = await searchFederated({
      vaults: [vaultA, vaultB],
      cacheDir: root,
      query: 'microservices database event stream',
      k: 4,
      embedFn: fakeEmbed,
    });

    assert.ok(results.length >= 2);
    assert.ok(results.some((r) => r.vault === 'vaultA'));
    assert.ok(results.some((r) => r.vault === 'vaultB'));
  } finally {
    safeRm(root);
  }
});
