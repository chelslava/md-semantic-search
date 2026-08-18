/**
 * MCP (Model Context Protocol) server mode (issue #62).
 * Exposes local semantic search to IDEs and LLM agents (Cursor, Claude Desktop, Copilot)
 * via a zero-dependency JSON-RPC 2.0 stdio transport per the MCP specification.
 */
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { buildIndex } from './indexer.js';
import { loadIndex, searchIndex } from './search.js';
import { searchFederated } from './federation.js';
import { globToRegExp } from './core.js';

export const MCP_TOOLS = [
  {
    name: 'search_markdown',
    description: 'Search local Markdown knowledge base by meaning and hybrid BM25 lexical ranking',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search query' },
        k: { type: 'number', description: 'Number of top results to return (default: 6)' },
        path: { type: 'string', description: 'Optional path glob filter (e.g. "docs/**")' },
        vaults: { type: 'array', items: { type: 'string' }, description: 'Optional list of vault directories for federated search' },
        tag: { type: 'array', items: { type: 'string' }, description: 'Optional frontmatter tag filters' },
        filter: { type: 'string', description: 'Optional rich boolean filter expression (e.g. "tag:engineering AND status != archived")' },
        graphBoost: { type: 'number', description: 'Optional boost weight for graph PageRank / wikilinks (0.0 to 1.0)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_chunk',
    description: 'Retrieve a specific chunk or section by file path and optional heading label',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Relative file path (e.g. "guides/api.md")' },
        heading: { type: 'string', description: 'Heading title (e.g. "Authentication")' },
      },
      required: ['file'],
    },
  },
  {
    name: 'list_files',
    description: 'List all indexed Markdown files and their chunk counts',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional glob filter to match file paths' },
      },
    },
  },
  {
    name: 'index_status',
    description: 'Get current index status, model metadata, chunk count, and build timestamp',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

export async function handleMcpRequest(req: any, state: { loaded: any; cacheDir: string; offline: boolean; embedFn?: any }): Promise<any | null> {
  if (!req || typeof req !== 'object') return null;
  const { id, method, params } = req;

  if (id === undefined || id === null) {
    return null;
  }

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'md-semantic-search',
          version: '0.8.0',
        },
      },
    };
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: MCP_TOOLS,
      },
    };
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};

    try {
      let content: Array<{ type: string; text: string }> = [];
      if (name === 'search_markdown') {
        const query = typeof args.query === 'string' ? args.query : '';
        const k = Number.isInteger(args.k) && args.k > 0 ? args.k : 6;
        let results: any[];
        if (Array.isArray(args.vaults) && args.vaults.length > 0) {
          results = await searchFederated({
            vaults: args.vaults,
            cacheDir: state.cacheDir,
            query,
            k,
            path: args.path,
            tag: args.tag,
            filter: typeof args.filter === 'string' ? args.filter : undefined,
            graphBoost: typeof args.graphBoost === 'number' ? args.graphBoost : undefined,
            offline: state.offline,
            embedFn: state.embedFn,
          });
        } else {
          results = await searchIndex({
            loaded: state.loaded,
            cacheDir: state.cacheDir,
            query,
            k,
            path: args.path,
            tag: args.tag,
            filter: typeof args.filter === 'string' ? args.filter : undefined,
            graphBoost: typeof args.graphBoost === 'number' ? args.graphBoost : undefined,
            offline: state.offline,
            embedFn: state.embedFn,
          });
        }
        content = [{ type: 'text', text: JSON.stringify(results, null, 2) }];
      } else if (name === 'get_chunk') {
        const file = args.file;
        const heading = args.heading;
        const chunks = state.loaded.index.chunks.filter((c: any) => {
          if (c.file !== file) return false;
          if (heading && c.heading.toLowerCase() !== heading.toLowerCase()) return false;
          return true;
        });
        content = [{ type: 'text', text: JSON.stringify(chunks, null, 2) }];
      } else if (name === 'list_files') {
        const fileCounts = new Map<string, number>();
        for (const c of state.loaded.index.chunks) {
          fileCounts.set(c.file, (fileCounts.get(c.file) || 0) + 1);
        }
        let files = [...fileCounts.entries()].map(([file, count]) => ({ file, chunksCount: count }));
        if (args.path) {
          const re = globToRegExp(args.path);
          files = files.filter((f) => re.test(f.file));
        }
        content = [{ type: 'text', text: JSON.stringify(files, null, 2) }];
      } else if (name === 'index_status') {
        const info = {
          ok: true,
          chunks: state.loaded.index.chunks.length,
          model: state.loaded.model.id,
          dim: state.loaded.index.dim || state.loaded.model.dim || 0,
          built: state.loaded.index.built || null,
        };
        content = [{ type: 'text', text: JSON.stringify(info, null, 2) }];
      } else {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Unknown tool: ${name}` },
        };
      }

      return {
        jsonrpc: '2.0',
        id,
        result: { content },
      };
    } catch (e: any) {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          isError: true,
          content: [{ type: 'text', text: `Error: ${e.message}` }],
        },
      };
    }
  }

  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

export interface StartMcpServerOptions {
  indexDir: string;
  cacheDir: string;
  db?: string;
  modelName?: string;
  ignore?: string[];
  offline?: boolean;
  embedFn?: any;
  log?: (msg: string) => void;
}

export async function startMcpServer(opts: StartMcpServerOptions): Promise<{ state: any; rl: readline.Interface }> {
  const {
    indexDir,
    cacheDir,
    db,
    modelName = 'e5-base',
    ignore = [],
    offline = false,
    embedFn,
    log = () => {},
  } = opts;

  fs.mkdirSync(indexDir, { recursive: true });
  if (!fs.existsSync(path.join(indexDir, 'vectors.json'))) {
    if (!db) throw new Error('mcp: no index found and no --db given to build one');
    log(`Building index at ${indexDir} from ${db}…`);
    await buildIndex({ db, indexDir, cacheDir, modelName, ignore, offline, log, embedFn });
  }

  const state = {
    loaded: loadIndex(indexDir),
    cacheDir,
    offline,
    embedFn,
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: any;
    try {
      req = JSON.parse(trimmed);
    } catch {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error: invalid JSON' },
        }) + '\n'
      );
      return;
    }

    const res = await handleMcpRequest(req, state);
    if (res) {
      process.stdout.write(JSON.stringify(res) + '\n');
    }
  });

  return { state, rl };
}
