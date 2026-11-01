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

/**
 * Protocol versions this server can speak (issue #197), newest first.
 * `initialize` echoes the client's requested version when we support it,
 * otherwise answers with MCP_SUPPORTED_VERSIONS[0].
 */
export const MCP_SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/**
 * Resolves the protocol version to answer an `initialize` with: the client's
 * exact request when supported, else the newest version we speak (the spec's
 * "respond with another protocol version you support" branch).
 */
export function negotiateProtocolVersion(requested?: unknown): string {
  const v = typeof requested === 'string' ? requested : '';
  return MCP_SUPPORTED_VERSIONS.includes(v) ? v : MCP_SUPPORTED_VERSIONS[0];
}

export interface McpClientChannelRequestOptions {
  timeoutMs?: number;
}

/**
 * Reverse channel for server→client JSON-RPC requests (issue #197) — today
 * only `sampling/createMessage`. Both transports build one: stdio writes
 * requests to its stdout and matches response lines by id; HTTP pushes them
 * onto the GET /mcp SSE stream and matches POSTed responses by id.
 */
export interface McpClientChannel {
  request(method: string, params?: any, opts?: McpClientChannelRequestOptions): Promise<any>;
  /**
   * Feeds a client message in. Returns true when it resolved a pending
   * request; false means the message is a client request/notification and
   * belongs to the normal handler.
   */
  handleResponse(msg: any): boolean;
}

/** Server→client requests that outlive this wait degrade, not hang (issue #197). */
export const DEFAULT_SAMPLING_TIMEOUT_MS = 60_000;
/** `sampling/createMessage` requires maxTokens — a grounded citation answer fits comfortably. */
export const DEFAULT_SAMPLING_MAX_TOKENS = 1024;

export function samplingTimeoutMs(envValue?: string): number {
  const raw = Number(envValue ?? process.env.MDSS_SAMPLING_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SAMPLING_TIMEOUT_MS;
}

/**
 * Builds a client channel over a raw sink. Ids are prefixed `mdss-srv-` so
 * they can never collide with the client's own request ids in either
 * direction's logs or pending maps.
 */
export function createClientChannel(send: (msg: any) => void): McpClientChannel {
  const pending = new Map<any, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  let nextId = 0;
  return {
    request(method: string, params: any = {}, opts: McpClientChannelRequestOptions = {}): Promise<any> {
      const timeoutMs = opts.timeoutMs ?? DEFAULT_SAMPLING_TIMEOUT_MS;
      const id = `mdss-srv-${++nextId}`;
      return new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method}: client did not respond within ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, { resolve, reject, timer });
        try {
          send({ jsonrpc: '2.0', id, method, params });
        } catch (e: any) {
          clearTimeout(timer);
          pending.delete(id);
          reject(new Error(`${method}: ${e?.message || String(e)}`));
        }
      });
    },
    handleResponse(msg: any): boolean {
      if (!msg || typeof msg !== 'object' || msg.method !== undefined) return false;
      const entry = pending.get(msg.id);
      if (!entry) return false;
      clearTimeout(entry.timer);
      pending.delete(msg.id);
      if (msg.error) {
        entry.reject(new Error(msg.error.message || `client error ${msg.error.code ?? ''}`));
      } else {
        entry.resolve(msg.result);
      }
      return true;
    },
  };
}

/**
 * A sampling-backed synthesis hook for the RAG layer (issue #197): returns
 * null unless the client both declared the `sampling` capability at
 * initialize AND a reverse channel exists — otherwise ask_knowledge_base goes
 * straight to the local extractive answer. Any in-flight failure (client
 * refusal, timeout, non-text content) throws and degrades the same way.
 */
export function createSamplingSynthesizer(state: {
  channel?: McpClientChannel;
  clientCapabilities?: any;
}): { fn: (req: { system: string; user: string }) => Promise<string>; used: () => boolean } | null {
  if (!state.channel || !state.clientCapabilities?.sampling) return null;
  let used = false;
  const channel = state.channel;
  return {
    used: () => used,
    fn: async ({ system, user }) => {
      const result = await channel.request(
        'sampling/createMessage',
        {
          messages: [{ role: 'user', content: { type: 'text', text: user } }],
          systemPrompt: system,
          includeContext: 'thisServer',
          maxTokens: DEFAULT_SAMPLING_MAX_TOKENS,
        },
        { timeoutMs: samplingTimeoutMs() },
      );
      const text = result?.content?.text;
      if (typeof text !== 'string' || !text.trim()) {
        throw new Error('sampling/createMessage returned no text content');
      }
      used = true;
      return text;
    },
  };
}

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

/**
 * Shared state for both MCP transports (stdio + Streamable HTTP): the
 * transports own the extras — `channel` (server→client requests, issue #197),
 * `clientCapabilities` (recorded at initialize), `output` (stdio sink, test seam).
 */
export interface McpHandlerState {
  loaded: any;
  cacheDir: string;
  offline: boolean;
  embedFn?: any;
  channel?: McpClientChannel;
  clientCapabilities?: any;
  output?: { write(chunk: string): void };
}

export async function handleMcpRequest(req: any, state: McpHandlerState): Promise<any | null> {
  if (!req || typeof req !== 'object') return null;
  const { id, method, params } = req;

  if (id === undefined || id === null) {
    return null;
  }

  // A JSON-RPC *response* to one of our server→client requests carries an id
  // but no method — the transport's channel correlation already consumed any
  // that matched; replying to the leftovers would be nonsense.
  if (typeof method !== 'string') {
    return null;
  }

  if (method === 'initialize') {
    // issue #197: remember what the client can do — `sampling` opens the
    // ask_knowledge_base LLM path — and answer with the negotiated version.
    state.clientCapabilities = params?.capabilities ?? {};
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
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

  // issue #197: liveness probe per the 2025-11-25 spec — answer promptly with
  // an empty result, regardless of initialization state.
  if (method === 'ping') {
    return {
      jsonrpc: '2.0',
      id,
      result: {},
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
          error: {
            code: e.message?.includes('not found') ? -32602 : -32603,
            message: `Error reading resource: ${e.message}`,
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
          // issue #179: the vaults argument must never name an arbitrary
          // directory (silent index read + query-cache write outside the
          // vault). Pin federated roots to the daemon's own trust domain —
          // the indexed vault root, widened only via MDSS_ROOT_GUARD.
          const vaultRoots = [
            state.loaded.index.db,
            ...(process.env.MDSS_ROOT_GUARD
              ? process.env.MDSS_ROOT_GUARD.split(path.delimiter).map((p) => p.trim()).filter(Boolean)
              : []),
          ].filter(Boolean);
          const fed = await searchFederated({
            vaults: args.vaults,
            allowedRoots: vaultRoots,
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
          // issue #189: broken vaults surface in the tool payload instead of
          // masquerading as "no results"
          rawResult = { results: fed.hits, vaultErrors: fed.vaultErrors };
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
        // issue #197: with a sampling-capable client, hand the synthesis to
        // the client's own LLM via sampling/createMessage — no local model,
        // no user-side LLM config. Any failure (capability absent, client
        // refusal, timeout) degrades to the extractive answer as before.
        const sampling = createSamplingSynthesizer(state);
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
            llmRequestFn: sampling?.fn,
          });
          rawResult = {
            answer: turnResult.answer,
            citations: turnResult.citations,
            manifest: turnResult.manifest,
            sessionId: turnResult.session.id,
            turnsCount: turnResult.session.turns.length,
            answerMode: sampling?.used() ? 'sampling' : 'extractive',
          };
        } else {
          const synth = await askQuestion({
            loaded: state.loaded,
            cacheDir: state.cacheDir,
            query,
            k,
            embedFn: state.embedFn,
            llmRequestFn: sampling?.fn,
          });
          rawResult = {
            ...synth,
            answerMode: sampling?.used() ? 'sampling' : 'extractive',
          };
        }
      } else {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Unknown tool: ${name}` },
        };
      }

      // issue #205: the MCP spec requires structuredContent to be an OBJECT
      // when present — strict clients reject bare arrays outright. Text content
      // keeps the raw result verbatim for clients reading content[0].text.
      const structured =
        Array.isArray(rawResult)
          ? name === 'list_files'
            ? { files: rawResult }
            : name === 'get_chunk'
              ? { chunks: rawResult }
              : { results: rawResult }
          : rawResult;

      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(rawResult, null, 2) }],
          structuredContent: structured,
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
  /** Stdio source (default process.stdin) — test/embedding seam (issue #197). */
  input?: NodeJS.ReadableStream;
  /** Stdio sink (default process.stdout) — test/embedding seam (issue #197). */
  output?: { write(chunk: string): void };
  log?: (msg: string) => void;
}

export async function startMcpServer(opts: StartMcpServerOptions): Promise<{ state: McpHandlerState; rl: readline.Interface }> {
  const {
    indexDir,
    cacheDir,
    db,
    modelName = 'e5-base',
    ignore = [],
    offline = false,
    embedFn,
    input = process.stdin,
    output = process.stdout,
    log = () => {},
  } = opts;

  fs.mkdirSync(indexDir, { recursive: true });
  if (!fs.existsSync(path.join(indexDir, 'vectors.json'))) {
    if (!db) throw new Error('mcp: no index found and no --db given to build one');
    log(`Building index at ${indexDir} from ${db}…`);
    await buildIndex({ db, indexDir, cacheDir, modelName, ignore, offline, log, embedFn });
  }

  const state: McpHandlerState = {
    loaded: loadIndex(indexDir),
    cacheDir,
    offline,
    embedFn,
    output,
  };

  // issue #197: over stdio the reverse channel is the transport itself —
  // server→client requests (sampling) go out as JSON-RPC lines on stdout and
  // the client answers with plain response lines on stdin.
  const channel = createClientChannel((msg) => output.write(JSON.stringify(msg) + '\n'));
  state.channel = channel;

  const rl = readline.createInterface({
    input,
    terminal: false,
  });

  // issue #185: an async 'line' handler drops its promise — any rejection
  // outside the per-tool try/catch (e.g. a primitive `params` reaching
  // prompts/get) would crash the whole process (unhandled rejection, Node ≥15),
  // and handling lines in parallel can reorder responses. Route every line
  // through one guarded, serialized handler.
  let tail: Promise<void> = Promise.resolve();
  rl.on('line', (line: string) => {
    // issue #197: a response line resolves a pending server→client request
    // immediately — the serialized chain below is blocked awaiting exactly
    // that request (sampling), so queueing the answer behind itself would
    // deadlock. Only client requests/notifications join the chain.
    const trimmed = line.trim();
    if (trimmed) {
      try {
        const msg = JSON.parse(trimmed);
        if (
          msg &&
          typeof msg === 'object' &&
          msg.method === undefined &&
          (msg.result !== undefined || msg.error !== undefined) &&
          channel.handleResponse(msg)
        ) {
          return;
        }
      } catch {
        /* not JSON — handleStdioLine turns it into -32700 */
      }
    }
    tail = tail
      .then(() => handleStdioLine(line, state))
      .catch(() => {
        /* handleStdioLine guards everything — keep the chain alive regardless */
      });
  });

  return { state, rl };
}

/**
 * One guarded, in-order stdio JSON-RPC exchange (issues #180/#185): caps the
 * line length, turns JSON parse failures into `-32700`, and converts ANY
 * handler escape into a `-32603` response instead of an unhandled rejection
 * that would kill the daemon.
 */
export const MAX_STDIO_LINE_CHARS = 1024 * 1024;

export async function handleStdioLine(
  line: string,
  state: McpHandlerState,
): Promise<void> {
  const out = state.output ?? process.stdout;
  if (line.length > MAX_STDIO_LINE_CHARS) {
    out.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32600,
          message: `Request too large (max ${MAX_STDIO_LINE_CHARS} chars per line)`,
        },
      }) + '\n'
    );
    return;
  }
  const trimmed = line.trim();
  if (!trimmed) return;
  let req: any;
  try {
    req = JSON.parse(trimmed);
  } catch {
    out.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: invalid JSON' },
      }) + '\n'
    );
    return;
  }

  let res: any;
  try {
    res = await handleMcpRequest(req, state);
  } catch (e: any) {
    res = {
      jsonrpc: '2.0',
      id: req && typeof req === 'object' && 'id' in req ? req.id : null,
      error: { code: -32603, message: `Internal error: ${e?.message || String(e)}` },
    };
  }
  if (res) {
    out.write(JSON.stringify(res) + '\n');
  }
}
