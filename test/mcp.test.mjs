import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MCP_TOOLS, MCP_RESOURCE_TEMPLATES, MCP_PROMPTS, handleMcpRequest } from '../dist/mcp.js';
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

test('MCP_TOOLS, MCP_RESOURCE_TEMPLATES, MCP_PROMPTS: define valid schemas and annotations', () => {
  assert.equal(Array.isArray(MCP_TOOLS), true);
  assert.equal(MCP_TOOLS.length, 7);

  const toolNames = MCP_TOOLS.map(t => t.name);
  assert.deepEqual(toolNames.sort(), ['ask_knowledge_base', 'get_chunk', 'get_lines', 'index_status', 'list_files', 'related_notes', 'search_markdown']);

  for (const tool of MCP_TOOLS) {
    assert.equal(typeof tool.name, 'string');
    assert.equal(typeof tool.description, 'string');
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.annotations?.readOnly, true);
    assert.equal(tool.annotations?.idempotent, true);
  }

  assert.equal(Array.isArray(MCP_RESOURCE_TEMPLATES), true);
  assert.ok(MCP_RESOURCE_TEMPLATES.some(t => t.name === 'note'));
  assert.ok(MCP_RESOURCE_TEMPLATES.some(t => t.name === 'status'));

  assert.equal(Array.isArray(MCP_PROMPTS), true);
  assert.ok(MCP_PROMPTS.some(p => p.name === 'search-and-cite'));
  assert.ok(MCP_PROMPTS.some(p => p.name === 'summarize-note'));
});

test('handleMcpRequest: handles initialize with tools, resources, and prompts capabilities', async () => {
  const { loaded, dir } = await makeIndex();
  try {
    const state = { loaded, cacheDir: dir, offline: true, embedFn: fakeEmbed };

    // 1. initialize
    const initRes = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' }, state);
    assert.equal(initRes.id, 1);
    assert.equal(initRes.result.serverInfo.name, 'md-semantic-search');
    assert.ok(initRes.result.capabilities.tools);
    assert.ok(initRes.result.capabilities.resources);
    assert.ok(initRes.result.capabilities.prompts);

    // 2. tools/list
    const listRes = await handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, state);
    assert.equal(listRes.id, 2);
    assert.equal(listRes.result.tools.length, 7);
  } finally {
    safeRm(dir);
  }
});

test('handleMcpRequest: handles resources/list, resources/templates/list, and resources/read (issue #146)', async () => {
  const { loaded, dir } = await makeIndex();
  try {
    const state = { loaded, cacheDir: dir, offline: true, embedFn: fakeEmbed };

    // 1. resources/list
    const listRes = await handleMcpRequest({ jsonrpc: '2.0', id: 20, method: 'resources/list' }, state);
    assert.equal(listRes.id, 20);
    const resources = listRes.result.resources;
    assert.ok(Array.isArray(resources));
    assert.ok(resources.some(r => r.uri.includes('guide.md')));
    assert.ok(resources.some(r => r.uri === 'mdss://status'));

    // 2. resources/templates/list
    const tplRes = await handleMcpRequest({ jsonrpc: '2.0', id: 21, method: 'resources/templates/list' }, state);
    assert.equal(tplRes.id, 21);
    assert.ok(tplRes.result.resourceTemplates.length >= 3);

    // 3. resources/read mdss://status
    const statusRes = await handleMcpRequest({
      jsonrpc: '2.0', id: 22, method: 'resources/read', params: { uri: 'mdss://status' },
    }, state);
    assert.equal(statusRes.id, 22);
    assert.equal(statusRes.result.contents[0].mimeType, 'application/json');
    const statusObj = JSON.parse(statusRes.result.contents[0].text);
    assert.equal(statusObj.ok, true);

    // 4. resources/read mdss://note/guide.md
    const noteRes = await handleMcpRequest({
      jsonrpc: '2.0', id: 23, method: 'resources/read', params: { uri: 'mdss://note/guide.md' },
    }, state);
    assert.equal(noteRes.id, 23);
    assert.equal(noteRes.result.contents[0].mimeType, 'text/markdown');
    assert.ok(noteRes.result.contents[0].text.includes('# Guide'));

    // 5. resources/read mdss://note/guide.md?fromLine=1&maxLines=2
    const linesRes = await handleMcpRequest({
      jsonrpc: '2.0', id: 24, method: 'resources/read', params: { uri: 'mdss://note/guide.md?fromLine=1&maxLines=2' },
    }, state);
    assert.equal(linesRes.id, 24);
    assert.equal(linesRes.result.contents[0].mimeType, 'text/markdown');
    assert.ok(linesRes.result.contents[0].text.includes('# Guide'));

    // 6. resources/read unknown URI
    const unkRes = await handleMcpRequest({
      jsonrpc: '2.0', id: 25, method: 'resources/read', params: { uri: 'mdss://unknown/item' },
    }, state);
    assert.equal(unkRes.error.code, -32602);
  } finally {
    safeRm(dir);
  }
});

test('handleMcpRequest: handles prompts/list and prompts/get (issue #146)', async () => {
  const { loaded, dir } = await makeIndex();
  try {
    const state = { loaded, cacheDir: dir, offline: true, embedFn: fakeEmbed };

    // 1. prompts/list
    const listRes = await handleMcpRequest({ jsonrpc: '2.0', id: 30, method: 'prompts/list' }, state);
    assert.equal(listRes.id, 30);
    assert.ok(listRes.result.prompts.length >= 5);

    // 2. prompts/get search-and-cite
    const p1 = await handleMcpRequest({
      jsonrpc: '2.0', id: 31, method: 'prompts/get', params: { name: 'search-and-cite', arguments: { query: 'auth' } },
    }, state);
    assert.equal(p1.id, 31);
    assert.ok(p1.result.messages[0].content.text.includes('auth'));
    assert.ok(p1.result.messages[0].content.text.includes('mdss://note/{path}'));

    // 3. prompts/get summarize-note
    const p2 = await handleMcpRequest({
      jsonrpc: '2.0', id: 32, method: 'prompts/get', params: { name: 'summarize-note', arguments: { note: 'guide.md' } },
    }, state);
    assert.equal(p2.id, 32);
    assert.ok(p2.result.messages[0].content.text.includes('mdss://note/guide.md'));

    // 4. prompts/get unknown prompt
    const pUnk = await handleMcpRequest({
      jsonrpc: '2.0', id: 33, method: 'prompts/get', params: { name: 'unknown-prompt' },
    }, state);
    assert.equal(pUnk.error.code, -32601);
  } finally {
    safeRm(dir);
  }
});

test('handleMcpRequest: handles tools/call with structuredContent alongside text', async () => {
  const { loaded, dir } = await makeIndex();
  try {
    const state = { loaded, cacheDir: dir, offline: true, embedFn: fakeEmbed };

    // index_status
    const statusRes = await handleMcpRequest({
      jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'index_status' },
    }, state);
    assert.equal(statusRes.result.structuredContent.chunks, 2);
    assert.equal(statusRes.result.structuredContent.model, 'Xenova/multilingual-e5-base');
    const statusData = JSON.parse(statusRes.result.content[0].text);
    assert.equal(statusData.chunks, 2);

    // list_files
    const filesRes = await handleMcpRequest({
      jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'list_files' },
    }, state);
    assert.equal(filesRes.result.structuredContent.length, 2);

    // get_chunk
    const chunkRes = await handleMcpRequest({
      jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'get_chunk', arguments: { file: 'guide.md', heading: 'Intro' } },
    }, state);
    assert.equal(chunkRes.result.structuredContent.length, 1);
    assert.equal(chunkRes.result.structuredContent[0].heading, 'Intro');

    // get_lines (issue #140)
    const linesRes = await handleMcpRequest({
      jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'get_lines', arguments: { file: 'guide.md', fromLine: 1, maxLines: 3 } },
    }, state);
    assert.equal(linesRes.result.structuredContent.file, 'guide.md');
    assert.equal(linesRes.result.structuredContent.fromLine, 1);
    assert.equal(linesRes.result.structuredContent.toLine, 3);

    // related_notes (issue #141)
    const relRes = await handleMcpRequest({
      jsonrpc: '2.0', id: 15, method: 'tools/call', params: { name: 'related_notes', arguments: { file: 'guide.md' } },
    }, state);
    assert.equal(relRes.result.structuredContent.resolvedFile, 'guide.md');
    assert.ok(Array.isArray(relRes.result.structuredContent.results));

    // search_markdown
    const searchRes = await handleMcpRequest({
      jsonrpc: '2.0', id: 16, method: 'tools/call', params: { name: 'search_markdown', arguments: { query: 'guide' } },
    }, state);
    assert.equal(Array.isArray(searchRes.result.structuredContent), true);
    assert.equal(searchRes.result.structuredContent.length > 0, true);

    // ask_knowledge_base with sessionId (issue #147)
    const askSess1 = await handleMcpRequest({
      jsonrpc: '2.0', id: 18, method: 'tools/call', params: { name: 'ask_knowledge_base', arguments: { query: 'guide', sessionId: 'mcp-sess-1' } },
    }, state);
    assert.ok(askSess1.result.structuredContent.answer);
    assert.equal(askSess1.result.structuredContent.sessionId, 'mcp-sess-1');
    assert.equal(askSess1.result.structuredContent.turnsCount, 1);
    assert.ok(Array.isArray(askSess1.result.structuredContent.manifest));

    // follow-up turn in same session
    const askSess2 = await handleMcpRequest({
      jsonrpc: '2.0', id: 19, method: 'tools/call', params: { name: 'ask_knowledge_base', arguments: { query: 'intro', sessionId: 'mcp-sess-1' } },
    }, state);
    assert.equal(askSess2.result.structuredContent.turnsCount, 2);
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
  assert.equal(json.some(t => t.name === 'get_lines'), true);
  assert.equal(json.some(t => t.name === 'related_notes'), true);
  assert.equal(json.some(t => t.name === 'ask_knowledge_base'), true);
});


