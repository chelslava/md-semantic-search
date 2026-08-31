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
import { askQuestion, chatTurn, loadChatSession } from './rag.js';
import { assertSafePath, globToRegExp, getDocLines } from './core.js';
import { findRelatedNotes } from './wikilinks.js';

/**
 * Package version reported via MCP initialize → serverInfo.
 * Single source of truth: package.json (resolved relative to dist/mcp.js).
 */
const MCP_VERSION: string = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

export const MCP_TOOLS = [
  {
    name: 'search_markdown',
    description: 'Search local Markdown knowledge base by meaning and hybrid BM25 lexical ranking',
    annotations: { readOnly: true, idempotent: true },
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
    annotations: { readOnly: true, idempotent: true },
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
    name: 'get_lines',
    description: 'Retrieve an exact range of lines from an indexed Markdown document by file path and line span',
    annotations: { readOnly: true, idempotent: true },
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Relative file path (e.g. "guides/api.md")' },
        fromLine: { type: 'number', description: '1-based starting line number (default: 1)' },
        maxLines: { type: 'number', description: 'Optional maximum number of lines to return' },
      },
      required: ['file'],
    },
  },
  {
    name: 'related_notes',
    description: 'Find notes related to a specific document via backlinks, outgoing links, 2-hop graph neighborhood, and semantic similarity',
    annotations: { readOnly: true, idempotent: true },
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File path, title, or alias of the target note' },
        k: { type: 'number', description: 'Number of related notes to retrieve (default: 6)' },
        direction: { type: 'string', enum: ['both', 'outgoing', 'backlinks'], description: 'Graph link direction (default: "both")' },
        semantic: { type: 'boolean', description: 'Include dense semantic similarity alongside graph links (default: true)' },
      },
      required: ['file'],
    },
  },
  {
    name: 'list_files',
    description: 'List all indexed Markdown files and their chunk counts',
    annotations: { readOnly: true, idempotent: true },
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
    annotations: { readOnly: true, idempotent: true },
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'ask_knowledge_base',
    description: 'Synthesize a grounded direct answer with citations from the local Markdown knowledge base',
    annotations: { readOnly: true, idempotent: true },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Question to ask the knowledge base' },
        k: { type: 'number', description: 'Number of candidate passages to retrieve (default: 5)' },
        sessionId: { type: 'string', description: 'Optional conversation session ID for persistent multi-turn context' },
      },
      required: ['query'],
    },
  },
];

export const MCP_RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'mdss://note/{path}',
    name: 'note',
    description: 'Read the full content of an indexed Markdown note',
    mimeType: 'text/markdown',
  },
  {
    uriTemplate: 'mdss://note/{path}{?fromLine,maxLines}',
    name: 'note_lines',
    description: 'Read a specific line range from an indexed Markdown note',
    mimeType: 'text/markdown',
  },
  {
    uriTemplate: 'mdss://vault/{vault}',
    name: 'vault',
    description: 'List all indexed notes in the specified vault',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'mdss://status',
    name: 'status',
    description: 'Retrieve current index status, model metadata, and chunk statistics',
    mimeType: 'application/json',
  },
];

export const MCP_PROMPTS = [
  {
    name: 'search-and-cite',
    description: 'Search the local knowledge base and synthesize a grounded answer with resource citations',
    arguments: [
      {
        name: 'query',
        description: 'Natural language question or search topic',
        required: true,
      },
    ],
  },
  {
    name: 'summarize-note',
    description: 'Read an indexed note and produce a concise summary of its key takeaways and actionable points',
    arguments: [
      {
        name: 'note',
        description: 'Relative path, title, or alias of the note to summarize',
        required: true,
      },
    ],
  },
  {
    name: 'compare-notes',
    description: 'Compare and contrast architectural decisions, concepts, or details across two notes',
    arguments: [
      {
        name: 'note1',
        description: 'First note relative path or title',
        required: true,
      },
      {
        name: 'note2',
        description: 'Second note relative path or title',
        required: true,
      },
    ],
  },
  {
    name: 'find-contradictions',
    description: 'Analyze knowledge base notes for conflicting or contradicting statements on a given topic',
    arguments: [
      {
        name: 'topic',
        description: 'Topic, claim, or architectural decision to audit for contradictions',
        required: true,
      },
    ],
  },
  {
    name: 'timeline',
    description: 'Extract a chronological timeline of events, ADRs, releases, or milestones from notes',
    arguments: [
      {
        name: 'topic',
        description: 'Project name, feature, or domain to build a timeline for',
        required: true,
      },
    ],
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
          tools: {
            listChanged: false,
          },
          resources: {
            subscribe: false,
            listChanged: false,
          },
          prompts: {
            listChanged: false,
          },
        },
        serverInfo: {
          name: 'md-semantic-search',
          version: MCP_VERSION,
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

  if (method === 'resources/list') {
    const fileTitles = new Map<string, string>();
    for (const c of state.loaded.index.chunks) {
      if (!fileTitles.has(c.file)) {
        fileTitles.set(c.file, c.title || c.file);
      }
    }
    const resources = [
      ...[...fileTitles.entries()].map(([file, title]) => ({
        uri: `mdss://note/${encodeURI(file)}`,
        name: file,
        description: title !== file ? `${title} (${file})` : file,
        mimeType: 'text/markdown',
      })),
      {
        uri: 'mdss://status',
        name: 'status',
        description: 'Index status and statistics',
        mimeType: 'application/json',
      },
    ];
    return {
      jsonrpc: '2.0',
      id,
      result: {
        resources,
      },
    };
  }

  if (method === 'resources/templates/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        resourceTemplates: MCP_RESOURCE_TEMPLATES,
      },
    };
  }

  if (method === 'resources/read') {
    const uri = params?.uri;
    if (!uri || typeof uri !== 'string') {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: 'Invalid params: missing "uri"' },
      };
    }

    if (uri === 'mdss://status') {
      const info = {
        ok: true,
        chunks: state.loaded.index.chunks.length,
        model: state.loaded.model.id,
        dim: state.loaded.index.dim || state.loaded.model.dim || 0,
        built: state.loaded.index.built || null,
        db: state.loaded.index.db || null,
      };
      return {
        jsonrpc: '2.0',
        id,
        result: {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify(info, null, 2),
            },
          ],
        },
      };
    }

    if (uri.startsWith('mdss://vault')) {
      const fileCounts = new Map<string, number>();
      for (const c of state.loaded.index.chunks) {
        fileCounts.set(c.file, (fileCounts.get(c.file) || 0) + 1);
      }
      const files = [...fileCounts.entries()].map(([file, count]) => ({ file, chunksCount: count }));
      return {
        jsonrpc: '2.0',
        id,
        result: {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify(files, null, 2),
            },
          ],
        },
      };
    }

    if (uri.startsWith('mdss://note/')) {
      const rawTarget = uri.slice('mdss://note/'.length);
      const [pathPart, queryPart] = rawTarget.split('?');
      const file = decodeURIComponent(pathPart);
      let fromLine: number | undefined;
      let maxLines: number | undefined;

      if (queryPart) {
        const searchParams = new URLSearchParams(queryPart);
        const fl = searchParams.get('fromLine');
        if (fl) fromLine = parseInt(fl, 10);
        const ml = searchParams.get('maxLines') || searchParams.get('lines');
        if (ml) maxLines = parseInt(ml, 10);
      }

      try {
        let text: string;
        if (fromLine !== undefined || maxLines !== undefined) {
          const linesRes = getDocLines({
            file,
            fromLine: fromLine && !isNaN(fromLine) ? fromLine : 1,
            maxLines: maxLines && !isNaN(maxLines) ? maxLines : undefined,
            dbDir: state.loaded.index.db,
            chunks: state.loaded.index.chunks,
          });
          text = linesRes.text;
        } else {
          // Read entire document
          let fullText: string | null = null;
          if (state.loaded.index.db) {
            const absPath = assertSafePath(path.resolve(state.loaded.index.db, file), [state.loaded.index.db]);
            try {
              if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
                fullText = fs.readFileSync(absPath, 'utf8');
              }
            } catch {}
          }
          if (fullText === null) {
            const linesRes = getDocLines({
              file,
              fromLine: 1,
              maxLines: undefined,
              dbDir: state.loaded.index.db,
              chunks: state.loaded.index.chunks,
            });
            fullText = linesRes.text;
          }
          text = fullText;
        }

        return {
          jsonrpc: '2.0',
          id,
          result: {
            contents: [
              {
                uri,
                mimeType: 'text/markdown',
                text,
              },
            ],
          },
        };
      } catch (e: any) {
        if (/path traversal guard|Forbidden path/i.test(e.message || '')) {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: e.message },
          };
        }
        return {
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [{ type: 'text', text: `Error reading resource: ${e.message}` }],
          },
        };
      }
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32602, message: `Unknown resource URI: ${uri}` },
    };
  }

  if (method === 'prompts/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        prompts: MCP_PROMPTS,
      },
    };
  }

  if (method === 'prompts/get') {
    const name = params?.name;
    const args = params?.arguments || {};

    if (name === 'search-and-cite') {
      const query = args.query || '';
      return {
        jsonrpc: '2.0',
        id,
        result: {
          description: 'Search the local knowledge base and synthesize a grounded answer with resource citations',
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Search the knowledge base for "${query}" using the \`search_markdown\` tool. Synthesize a comprehensive, grounded answer citing specific notes with \`mdss://note/{path}\` resource URIs.`,
              },
            },
          ],
        },
      };
    }

    if (name === 'summarize-note') {
      const note = args.note || '';
      return {
        jsonrpc: '2.0',
        id,
        result: {
          description: 'Read an indexed note and produce a concise summary of its key takeaways and actionable points',
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Read note \`mdss://note/${encodeURI(note)}\` and summarize its core concepts, key takeaways, and relevant linked documents.`,
              },
            },
          ],
        },
      };
    }

    if (name === 'compare-notes') {
      const note1 = args.note1 || '';
      const note2 = args.note2 || '';
      return {
        jsonrpc: '2.0',
        id,
        result: {
          description: 'Compare and contrast architectural decisions, concepts, or details across two notes',
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Read notes \`mdss://note/${encodeURI(note1)}\` and \`mdss://note/${encodeURI(note2)}\`. Compare and contrast their topics, identifying agreements, divergences, and complementary insights.`,
              },
            },
          ],
        },
      };
    }

    if (name === 'find-contradictions') {
      const topic = args.topic || '';
      return {
        jsonrpc: '2.0',
        id,
        result: {
          description: 'Analyze knowledge base notes for conflicting or contradicting statements on a given topic',
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Search the knowledge base for notes related to "${topic}". Identify any contradictory claims, conflicting dates, or conflicting architectural directives across documents, citing sources with \`mdss://note/{path}\`.`,
              },
            },
          ],
        },
      };
    }

    if (name === 'timeline') {
      const topic = args.topic || '';
      return {
        jsonrpc: '2.0',
        id,
        result: {
          description: 'Extract a chronological timeline of events, ADRs, releases, or milestones from notes',
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Analyze notes related to "${topic}" and construct a chronological timeline of key events, releases, ADRs, or milestone decisions with citations to \`mdss://note/{path}\`.`,
              },
            },
          ],
        },
      };
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Unknown prompt: ${name}` },
    };
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};

    try {
      let rawResult: any;
      if (name === 'search_markdown') {
        const query = typeof args.query === 'string' ? args.query : '';
        const k = Number.isInteger(args.k) && args.k > 0 ? args.k : 6;
        if (Array.isArray(args.vaults) && args.vaults.length > 0) {
          rawResult = await searchFederated({
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
          rawResult = await searchIndex({
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
      } else if (name === 'get_chunk') {
        const file = args.file;
        const heading = args.heading;
        rawResult = state.loaded.index.chunks.filter((c: any) => {
          if (c.file !== file) return false;
          if (heading && c.heading.toLowerCase() !== heading.toLowerCase()) return false;
          return true;
        });
      } else if (name === 'get_lines') {
        const file = args.file;
        if (!file || typeof file !== 'string') {
          throw new Error('missing "file" argument');
        }
        const fromLine = typeof args.fromLine === 'number' ? args.fromLine : 1;
        const maxLines = typeof args.maxLines === 'number' ? args.maxLines : undefined;
        rawResult = getDocLines({
          file,
          fromLine,
          maxLines,
          dbDir: state.loaded.index.db,
          chunks: state.loaded.index.chunks,
        });
      } else if (name === 'related_notes' || name === 'related_documents') {
        const file = args.file || args.note || args.target;
        if (!file || typeof file !== 'string') {
          throw new Error('missing "file" argument');
        }
        const k = typeof args.k === 'number' ? args.k : 6;
        const direction = args.direction || 'both';
        const semantic = args.semantic !== false;
        rawResult = findRelatedNotes({
          loaded: state.loaded,
          target: file,
          k,
          direction,
          semantic,
        });
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
        rawResult = files;
      } else if (name === 'index_status') {
        rawResult = {
          ok: true,
          chunks: state.loaded.index.chunks.length,
          model: state.loaded.model.id,
          dim: state.loaded.index.dim || state.loaded.model.dim || 0,
          built: state.loaded.index.built || null,
        };
      } else if (name === 'ask_knowledge_base') {
        const query = args.query;
        const k = typeof args.k === 'number' ? args.k : 5;
        const sessionId = args.sessionId || args.session_id;
        if (sessionId && typeof sessionId === 'string') {
          const indexDir = state.loaded.indexDir || (state.loaded.index?.db ? path.join(state.loaded.index.db, '.mdss') : state.cacheDir);
          const session = loadChatSession(indexDir, sessionId);
          const turnResult = await chatTurn({
            session,
            query,
            loaded: state.loaded,
            indexDir,
            cacheDir: state.cacheDir,
            k,
            embedFn: state.embedFn,
          });
          rawResult = {
            answer: turnResult.answer,
            citations: turnResult.citations,
            manifest: turnResult.manifest,
            sessionId: turnResult.session.id,
            turnsCount: turnResult.session.turns.length,
          };
        } else {
          rawResult = await askQuestion({
            loaded: state.loaded,
            cacheDir: state.cacheDir,
            query,
            k,
            embedFn: state.embedFn,
          });
        }
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
        result: {
          content: [{ type: 'text', text: JSON.stringify(rawResult, null, 2) }],
          structuredContent: rawResult,
        },
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
