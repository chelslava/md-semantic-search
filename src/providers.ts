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

  return {
    id: cfg.embedder,
    model: cfg.model,
    embedFn,
    descriptor: () => descriptorPromise,
  };
}
