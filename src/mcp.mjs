// @ts-check
/**
 * MCP (Model Context Protocol) server mode (issue #62).
 * Exposes local semantic search to IDEs and LLM agents (Cursor, Claude Desktop, Copilot)
 * via a zero-dependency JSON-RPC 2.0 stdio transport per the MCP specification.
 */
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { buildIndex } from './indexer.mjs';
import { loadIndex, searchIndex } from './search.mjs';

/**
 * MCP Tool definitions exported for JSON schema inspection (`mdss mcp --list-tools --json`)
 * and JSON-RPC `tools/list` requests.
 */
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
        tag: { type: 'array', items: { type: 'string' }, description: 'Optional frontmatter tag filters' },
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

/**
 * Handle an incoming JSON-RPC 2.0 request message against the warm runtime state.
 * @param {any} req - parsed JSON-RPC request object
 * @param {{ loaded: ReturnType<typeof loadIndex>, cacheDir: string, offline: boolean, embedFn?: Function }} state
 * @returns {Promise<any|null>} JSON-RPC 2.0 response object, or null if notification
 */
export async function handleMcpRequest(req, state) {
  if (!req || typeof req !== 'object') return null;
  const { id, method, params } = req;

  // JSON-RPC 2.0 Notifications (no response expected)
  if (id === undefined || id === null) {
    return null;
  }

  // Handle MCP Protocol methods
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
          version: '0.4.0',
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
      let content = [];
      if (name === 'search_markdown') {
        const query = typeof args.query === 'string' ? args.query : '';
        const k = Number.isInteger(args.k) && args.k > 0 ? args.k : 6;
        const results = await searchIndex({
          loaded: state.loaded,
          cacheDir: state.cacheDir,
          query,
          k,
          path: args.path,
          tag: args.tag,
          offline: state.offline,
          embedFn: state.embedFn,
        });
        content = [{ type: 'text', text: JSON.stringify(results, null, 2) }];
      } else if (name === 'get_chunk') {
        const file = args.file;
        const heading = args.heading;
        const chunks = state.loaded.index.chunks.filter(c => {
          if (c.file !== file) return false;
          if (heading && c.heading.toLowerCase() !== heading.toLowerCase()) return false;
          return true;
        });
        content = [{ type: 'text', text: JSON.stringify(chunks, null, 2) }];
      } else if (name === 'list_files') {
        const fileCounts = new Map();
        for (const c of state.loaded.index.chunks) {
          fileCounts.set(c.file, (fileCounts.get(c.file) || 0) + 1);
        }
        let files = [...fileCounts.entries()].map(([file, count]) => ({ file, chunksCount: count }));
        if (args.path) {
          const { globToRegExp } = await import('./core.mjs');
          const re = globToRegExp(args.path);
          files = files.filter(f => re.test(f.file));
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
    } catch (e) {
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

  // Fallback for unknown methods
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

/**
 * Start the stdio MCP server loop.
 * Reads JSON-RPC 2.0 lines from stdin and writes responses to stdout.
 * @param {object} opts
 * @param {string} opts.indexDir
 * @param {string} opts.cacheDir
 * @param {string} [opts.db]
 * @param {string} [opts.modelName='e5-base']
 * @param {string[]} [opts.ignore=[]]
 * @param {boolean} [opts.offline=false]
 * @param {Function} [opts.embedFn]
 * @param {(msg:string)=>void} [opts.log]
 */
export async function startMcpServer(opts) {
  const {
    indexDir, cacheDir, db, modelName = 'e5-base', ignore = [],
    offline = false, embedFn, log = () => {},
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
    let req;
    try {
      req = JSON.parse(trimmed);
    } catch {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: invalid JSON' },
      }) + '\n');
      return;
    }

    const res = await handleMcpRequest(req, state);
    if (res) {
      process.stdout.write(JSON.stringify(res) + '\n');
    }
  });

  return { state, rl };
}
