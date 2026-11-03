/**
 * Pluggable embedding providers (issue #124): Ollama and OpenAI-compatible
 * endpoints beside the built-in local transformers.js path.
 *
 * Design: a provider produces (a) an async embedFn with the SAME signature as
 * core.embed(texts, role, model, cacheDir, offline) and (b) a synthetic
 * ModelAdapter descriptor. The descriptor flows through the EXISTING machinery
 * (adapter fingerprint, dim validation, index metadata) so switching providers
 * invalidates vectors exactly like switching local models — no special cases.
 *
 * Local transformers.js stays the zero-config default and the only fully
 * offline path; providers are opt-in via explicit flags.
 */
import { loadApiKeyFile } from './serve.js';
import { ModelAdapter } from './models.js';
import { fetchTimeoutMs } from './core.js';

export type EmbedderRole = 'query' | 'passage';
export type ExternalEmbedFn = (
  texts: string[],
  role: EmbedderRole,
  model: ModelAdapter,
  cacheDir: string,
  offline: boolean,
) => Promise<number[][]>;

export interface ProviderConfig {
  embedder: 'ollama' | 'openai';
  /** Provider-side model name, e.g. `nomic-embed-text` or `text-embedding-3-small`. */
  model: string;
  baseUrl?: string;
  keyFile?: string;
  /** Injected fetch for tests; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export interface ResolvedEmbedder {
  id: string;
  model: string;
  embedFn: ExternalEmbedFn;
  /** Synthetic adapter (probes the endpoint once for dim). Await before indexing. */
  descriptor(): Promise<ModelAdapter>;
}

function baseOf(cfg: ProviderConfig): string {
  const raw =
    cfg.baseUrl ||
    (cfg.embedder === 'ollama' ? process.env.OLLAMA_HOST || 'http://127.0.0.1:11434' : 'https://api.openai.com/v1');
  return raw.replace(/\/$/, '');
}

function bearerKey(cfg: ProviderConfig): string | undefined {
  if (cfg.embedder !== 'openai') return undefined;
  if (cfg.keyFile) return loadApiKeyFile(cfg.keyFile);
  return process.env.OPENAI_API_KEY || undefined;
}

async function postJson(fetchImpl: typeof fetch, url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    // issue #184: a hung embedder endpoint must fail into the retry path,
    // not hold an index run / serve slot for undici's ~300s default
    signal: AbortSignal.timeout(fetchTimeoutMs()),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`embedder ${url} -> HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  return res.json();
}

/** Build an external embedder; dim is probed once on first use and cached. */
export function resolveExternalEmbedder(cfg: ProviderConfig): ResolvedEmbedder {
  const fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('embedder: no fetch implementation available');
  let cachedDim = 0;

  const embedOneBatch = async (texts: string[]): Promise<number[][]> => {
    if (cfg.embedder === 'ollama') {
      const data = await postJson(fetchImpl, `${baseOf(cfg)}/api/embed`, {}, { model: cfg.model, input: texts });
      const embs = data?.embeddings;
      if (!Array.isArray(embs) || embs.length !== texts.length) {
        throw new Error('ollama /api/embed returned unexpected shape');
      }
      return embs;
    }
    // OpenAI-compatible
    const headers: Record<string, string> = {};
    const key = bearerKey(cfg);
    if (key) headers.authorization = `Bearer ${key}`;
    const data = await postJson(fetchImpl, `${baseOf(cfg)}/embeddings`, headers, {
      model: cfg.model,
      input: texts,
    });
    const rows = data?.data;
    if (!Array.isArray(rows) || rows.length !== texts.length) {
      throw new Error('openai /embeddings returned unexpected shape');
    }
    return rows
      .slice()
      .sort((a: any, b: any) => a.index - b.index)
      .map((r: any) => r.embedding);
  };

  const embedFn: ExternalEmbedFn = async (texts, _role) => {
    if (texts.length === 0) return [];
    const out = await embedOneBatch(texts);
    if (cachedDim === 0 && out[0]?.length) cachedDim = out[0].length;
    return out;
  };

  // Dim probing: one tiny request at resolve time keeps index metadata honest
  // without hardcoding per-model tables.
  const descriptorPromise = (async (): Promise<ModelAdapter> => {
    const probe = await embedOneBatch(['dim probe']);
    cachedDim = probe[0]?.length ?? 0;
    if (!cachedDim) throw new Error(`embedder ${cfg.embedder}:${cfg.model} returned an empty embedding`);
    return {
      id: `${cfg.embedder}/${cfg.model}`,
      nativeDim: cachedDim,
      dim: cachedDim,
      queryPrefix: '',
      passagePrefix: '',
      pooling: 'mean',
      normalize: false, // never assume; cosine still works on unnormalized vectors
      family: cfg.embedder,
    };
  })();
  // The probe starts eagerly; callers that only ever use embedFn never await
  // it, so its rejection (e.g. the issue #184 fetch timeout) must not become
  // an unhandled one. descriptor() re-surfaces the same rejection to awaiters.
  descriptorPromise.catch(() => {});

  return {
    id: cfg.embedder,
    model: cfg.model,
    embedFn,
    descriptor: () => descriptorPromise,
  };
}

/**
 * Chat provider (issue #199): one OpenAI-compatible `/chat/completions` path
 * for answer synthesis — the same lingua franca HyDE already speaks — with an
 * Ollama-native `/api/generate` legacy path (`--llm-provider ollama`) that
 * preserves the pre-#199 wire format for existing setups.
 */
export type ChatProviderId = 'openai' | 'ollama';

export interface ChatProviderConfig {
  provider: ChatProviderId;
  /** Provider-side model name; omitted bodies let the server pick its default. */
  model?: string;
  baseUrl?: string;
  keyFile?: string;
  /** Injected fetch for tests; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export interface ChatRequest {
  system: string;
  user: string;
  /** Streaming render hook; fires once per token chunk when the wire streams. */
  onDelta?: (delta: string) => void;
  /** Cooperative cancel (serve: client disconnected mid-stream). */
  signal?: AbortSignal;
}

export interface ResolvedChat {
  id: ChatProviderId;
  model: string;
  /** Streams one completion; resolves to the assembled full text. */
  complete(req: ChatRequest): Promise<string>;
}

/**
 * Incremental SSE frame parser (issue #199): feed it raw network chunks, it
 * emits one `data:` payload per complete event. Handles CRLF, LF-only streams,
 * multi-line `data:` fields (joined with \n per the WHATWG spec), comment
 * keep-alive lines (`: ping`), and chunks that split a line or a CRLF pair
 * across the boundary. Non-`data` fields (event/id/retry) are irrelevant to
 * the chat delta stream and dropped.
 */
export function createSseParser(onData: (data: string) => void): { push(chunk: string): void; end(): void } {
  let buf = '';
  let dataLines: string[] = [];
  const dispatch = () => {
    if (dataLines.length > 0) {
      const payload = dataLines.join('\n');
      dataLines = [];
      onData(payload);
    }
  };
  const consumeLine = (rawLine: string) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return; // comment / keep-alive
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  };
  return {
    push(chunk: string) {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        consumeLine(line);
      }
    },
    end() {
      if (buf !== '') {
        consumeLine(buf);
        buf = '';
      }
      dispatch();
    },
  };
}

/** `data:` payload of an OpenAI streaming chunk → delta text ('' when none). */
export function openAiDeltaText(payload: string): string {
  if (payload === '[DONE]') return '';
  try {
    const json: any = JSON.parse(payload);
    const text = json?.choices?.[0]?.delta?.content;
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}

/** One Ollama NDJSON streaming line → delta text ('' when none). */
export function ollamaDeltaText(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return '';
  try {
    const json: any = JSON.parse(trimmed);
    const text = json?.response;
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}

function chatBaseOf(cfg: ChatProviderConfig): string {
  const raw =
    cfg.baseUrl ||
    (cfg.provider === 'ollama' ? process.env.OLLAMA_HOST || 'http://127.0.0.1:11434' : 'https://api.openai.com/v1');
  return raw.replace(/\/+$/, '');
}

function chatBearerKey(cfg: ChatProviderConfig): string | undefined {
  if (cfg.provider !== 'openai') return undefined;
  if (cfg.keyFile) return loadApiKeyFile(cfg.keyFile);
  return process.env.OPENAI_API_KEY || undefined;
}

const IDLE_ABORT_REASON = () =>
  new DOMException('The operation was aborted due to timeout', 'TimeoutError');

/**
 * Streams one completion with an IDLE timeout (issue #199 × #184): the
 * abort timer arms before connect and resets on every received chunk, so a
 * hung endpoint fails fast while a long streaming generation is never killed
 * mid-answer the way a whole-request `AbortSignal.timeout` would. An external
 * `signal` (serve: client disconnected mid-stream) aborts immediately.
 */
function makeIdleGuard(external?: AbortSignal) {
  const controller = new AbortController();
  const idleMs = fetchTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => controller.abort(IDLE_ABORT_REASON()), idleMs);
  (timer as any)?.unref?.();
  const onExternalAbort = () => controller.abort(external!.reason);
  if (external) {
    if (external.aborted) onExternalAbort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }
  return {
    signal: controller.signal,
    /** Reset the idle window (after connect, after every chunk). */
    arm() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => controller.abort(IDLE_ABORT_REASON()), idleMs);
      (timer as any)?.unref?.();
    },
    done() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      external?.removeEventListener('abort', onExternalAbort);
    },
  };
}

/** Line-splitting over arbitrary network chunks (Ollama NDJSON). */
function createLineParser(onLine: (line: string) => void): { push(chunk: string): void; end(): void } {
  let buf = '';
  return {
    push(chunk: string) {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        onLine(line);
      }
    },
    end() {
      if (buf !== '') {
        onLine(buf.replace(/\r$/, ''));
        buf = '';
      }
    },
  };
}

function isLegacyFallbackEligible(err: unknown): boolean {
  // Only a clearly OpenAI-incompatible shape (no such route) justifies trying
  // the Ollama-native endpoint; auth/4xx/5xx errors must surface as-is.
  return /HTTP 40[45]\b/.test(String((err as any)?.message || ''));
}

/**
 * Build a chat completion provider over HTTP streaming (issue #199).
 * `openai` → POST {base}/chat/completions with `stream:true`, SSE deltas.
 * `ollama` → POST {base}/api/generate with `stream:true`, NDJSON deltas —
 * the pre-#199 endpoint, upgraded from `stream:false` to streaming. The
 * openai path additionally falls back to /api/generate once when the endpoint
 * answers 404/405 (not OpenAI-shaped), so an Ollama root URL keeps working
 * with default flags.
 */
export function resolveChatProvider(cfg: ChatProviderConfig): ResolvedChat {
  const fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('chat: no fetch implementation available');
  const base = chatBaseOf(cfg);

  const streamOllamaGenerate = async (
    system: string,
    user: string,
    onDelta: ((d: string) => void) | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string> => {
    const guard = makeIdleGuard(signal);
    let res: Response;
    try {
      res = await fetchImpl(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: guard.signal,
        body: JSON.stringify({
          model: cfg.model || 'llama3',
          // legacy wire format: one prompt string, byte-identical to the
          // pre-#199 single-string synthesis prompt
          prompt: system + user,
          stream: true,
        }),
      });
    } catch (e) {
      guard.done();
      throw e;
    }
    if (!res.ok) {
      guard.done();
      const text = await res.text().catch(() => '');
      throw new Error(`chat ${base}/api/generate -> HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    let full = '';
    const parser = createLineParser((line) => {
      const delta = ollamaDeltaText(line);
      if (delta) {
        full += delta;
        onDelta?.(delta);
      }
    });
    const decoder = new TextDecoder();
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array | string>) {
        parser.push(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
        guard.arm();
      }
      parser.push(decoder.decode());
      parser.end();
    } finally {
      guard.done();
    }
    return full;
  };

  const streamOpenAiChat = async (
    system: string,
    user: string,
    onDelta: ((d: string) => void) | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string> => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const key = chatBearerKey(cfg);
    if (key) headers.authorization = `Bearer ${key}`;
    const guard = makeIdleGuard(signal);
    let res: Response;
    try {
      res = await fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        headers,
        signal: guard.signal,
        body: JSON.stringify({
          ...(cfg.model ? { model: cfg.model } : {}),
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          stream: true,
        }),
      });
    } catch (e) {
      guard.done();
      throw e;
    }
    if (!res.ok) {
      guard.done();
      const text = await res.text().catch(() => '');
      throw new Error(`chat ${base}/chat/completions -> HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    let full = '';
    let wireDone = false;
    const parser = createSseParser((payload) => {
      if (payload === '[DONE]') {
        wireDone = true;
        return;
      }
      const delta = openAiDeltaText(payload);
      if (delta) {
        full += delta;
        onDelta?.(delta);
      }
    });
    const decoder = new TextDecoder();
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array | string>) {
        parser.push(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
        guard.arm();
        // leaving the for-await on [DONE] cancels the stream through the
        // iterator's return() — a manual cancel() here would just reject
        // with "ReadableStream is locked"
        if (wireDone) break;
      }
      if (!wireDone) {
        parser.push(decoder.decode());
        parser.end();
      }
    } finally {
      guard.done();
    }
    return full;
  };

  return {
    id: cfg.provider,
    model: cfg.model || '',
    async complete(req) {
      if (cfg.provider === 'ollama') {
        return streamOllamaGenerate(req.system, req.user, req.onDelta, req.signal);
      }
      try {
        return await streamOpenAiChat(req.system, req.user, req.onDelta, req.signal);
      } catch (e) {
        if (isLegacyFallbackEligible(e)) {
          return streamOllamaGenerate(req.system, req.user, req.onDelta, req.signal);
        }
        throw e;
      }
    },
  };
}
