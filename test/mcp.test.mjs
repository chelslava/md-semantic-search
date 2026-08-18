import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MCP_TOOLS, handleMcpRequest } from '../dist/mcp.js';
import { buildIndex } from '../dist/indexer.js';
import { loadIndex } from '../dist/search.js';

const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));

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

async function makeIndex() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-mcp-'));
  const idx = path.join(dir, '.mdss');
  fs.writeFileSync(path.join(dir, 'guide.md'), '# Guide\n\n## Intro\n\nWelcome to mdss search guide\n');
  fs.writeFileSync(path.join(dir, 'api.md'), '# API\n\n## Endpoints\n\nGET /health endpoint description\n');
  await buildIndex({ db: dir, indexDir: idx, cacheDir: dir, modelName: 'e5-base', embedFn: fakeEmbed });
  const loaded = loadIndex(idx);
  return { dir, idx, loaded };
}

test('MCP_TOOLS: defines mandatory tools and valid schemas', () => {
  assert.equal(Array.isArray(MCP_TOOLS), true);
  assert.equal(MCP_TOOLS.length, 4);

  const toolNames = MCP_TOOLS.map(t => t.name);
  assert.deepEqual(toolNames.sort(), ['get_chunk', 'index_status', 'list_files', 'search_markdown']);

  for (const tool of MCP_TOOLS) {
    assert.equal(typeof tool.name, 'string');
    assert.equal(typeof tool.description, 'string');
    assert.equal(tool.inputSchema.type, 'object');
  }
});

test('handleMcpRequest: handles initialize and tools/list', async () => {
  const { loaded, dir } = await makeIndex();
  try {
    const state = { loaded, cacheDir: dir, offline: true, embedFn: fakeEmbed };

    // 1. initialize
    const initRes = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' }, state);
    assert.equal(initRes.id, 1);
    assert.equal(initRes.result.serverInfo.name, 'md-semantic-search');

    // 2. tools/list
    const listRes = await handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, state);
    assert.equal(listRes.id, 2);
    assert.equal(listRes.result.tools.length, 4);
  } finally {
    safeRm(dir);
  }
});

test('handleMcpRequest: handles tools/call index_status, list_files, get_chunk, search_markdown', async () => {
  const { loaded, dir } = await makeIndex();
  try {
    const state = { loaded, cacheDir: dir, offline: true, embedFn: fakeEmbed };

    // index_status
    const statusRes = await handleMcpRequest({
      jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'index_status' },
    }, state);
    const statusData = JSON.parse(statusRes.result.content[0].text);
    assert.equal(statusData.chunks, 2);
    assert.equal(statusData.model, 'Xenova/multilingual-e5-base');

    // list_files
    const filesRes = await handleMcpRequest({
      jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'list_files' },
    }, state);
    const filesData = JSON.parse(filesRes.result.content[0].text);
    assert.equal(filesData.length, 2);

    // get_chunk
    const chunkRes = await handleMcpRequest({
      jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'get_chunk', arguments: { file: 'guide.md', heading: 'Intro' } },
    }, state);
    const chunkData = JSON.parse(chunkRes.result.content[0].text);
    assert.equal(chunkData.length, 1);
    assert.equal(chunkData[0].heading, 'Intro');

    // search_markdown
    const searchRes = await handleMcpRequest({
      jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'search_markdown', arguments: { query: 'guide' } },
    }, state);
    const searchData = JSON.parse(searchRes.result.content[0].text);
    assert.equal(Array.isArray(searchData), true);
    assert.equal(searchData.length > 0, true);
  } finally {
    safeRm(dir);
  }
});

test('cli: mdss mcp --list-tools outputs tool JSON definitions', () => {
  const r = spawnSync(process.execPath, [CLI, 'mcp', '--list-tools']);
  assert.equal(r.status, 0);
  const json = JSON.parse(r.stdout.toString('utf8'));
  assert.equal(Array.isArray(json), true);
  assert.equal(json.some(t => t.name === 'search_markdown'), true);
});
