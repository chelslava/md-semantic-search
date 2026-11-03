import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { searchIndex, loadIndex, LoadedIndex, SearchResultHit } from './search.js';
import { tokenize } from './lexical.js';
import { ChatProviderId, ResolvedChat, resolveChatProvider } from './providers.js';

export interface Citation {
  file: string;
  heading?: string;
  score: number;
}

export interface SynthesisResult {
  answer: string;
  citations: Citation[];
  /**
   * issue #199 follow-up: citations the answer actually mentions (bracket
   * formats `[file#heading]` / `[file › heading]` / `[file]`), in order of
   * first mention. Deterministic post-processing of the LLM text — a subset
   * of `citations`, which stays the full retrieval manifest for compatibility.
   */
  citationsUsed?: Citation[];
  passages: SearchResultHit[];
  /** Which synthesis stage produced the answer (issue #197 observability). */
  mode?: 'llm' | 'endpoint' | 'extractive';
}

/**
 * System/user split for transports that keep the two apart on the wire —
 * MCP `sampling/createMessage` (issue #197) carries a `systemPrompt` field
 * and a message list, unlike the single-string local LLM bridge.
 */
export interface LlmStructuredRequest {
  system: string;
  user: string;
}

export interface ChatSourceManifestItem {
  file: string;
  heading?: string;
  headingPath?: string[];
  startLine?: number;
  endLine?: number;
  chunkHash?: string;
  score: number;
}

export interface ChatTurn {
  id: string;
  timestamp: string;
  query: string;
  answer: string;
  citations: Citation[];
  manifest: ChatSourceManifestItem[];
  /** Which synthesis stage produced the answer (issue #199; optional in persisted sessions). */
  mode?: SynthesisResult['mode'];
}

export interface ChatSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  db?: string;
  model?: string;
  turns: ChatTurn[];
}

export interface AskOptions {
  query: string;
  loaded?: LoadedIndex;
  indexDir?: string;
  cacheDir?: string;
  db?: string;
  k?: number;
  offline?: boolean;
  llmEndpoint?: string;
  llmModel?: string;
  /** issue #199: chat wire format for llmEndpoint — 'openai' (default) or 'ollama'. */
  llmProvider?: ChatProviderId;
  llmFn?: (prompt: string) => Promise<string>;
  llmRequestFn?: (req: LlmStructuredRequest) => Promise<string>;
  /** issue #199: incremental render hook — fires per token chunk while the LLM streams. */
  onDelta?: (delta: string) => void;
  /** issue #199: injection seam for tests/serve; built from llmEndpoint when absent. */
  llmChat?: ResolvedChat;
  systemPrompt?: string;
  embedFn?: any;
}

export interface ChatTurnOptions {
  session?: ChatSession;
  query: string;
  loaded?: LoadedIndex;
  indexDir?: string;
  cacheDir?: string;
  db?: string;
  k?: number;
  offline?: boolean;
  llmEndpoint?: string;
  llmModel?: string;
  /** issue #199: chat wire format for llmEndpoint — 'openai' (default) or 'ollama'. */
  llmProvider?: ChatProviderId;
  llmFn?: (prompt: string) => Promise<string>;
  llmRequestFn?: (req: LlmStructuredRequest) => Promise<string>;
  /** issue #199: incremental render hook — fires per token chunk while the LLM streams. */
  onDelta?: (delta: string) => void;
  /** issue #199: injection seam for tests/serve; built from llmEndpoint when absent. */
  llmChat?: ResolvedChat;
  systemPrompt?: string;
  embedFn?: any;
  log?: (msg: string) => void;
}

export const DEFAULT_RAG_SYSTEM_PROMPT =
  'You are a helpful assistant answering questions using only the provided Markdown notes. ' +
  'Always cite your sources using [file#heading] format. ' +
  'If the context does not contain the answer, say that the notes do not have enough information.';

/**
 * Returns the directory where chat sessions are persisted.
 */
export function getSessionsDir(indexDir: string): string {
  return path.join(indexDir, 'sessions');
}

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Validates a session id before it is used as a filesystem path component.
 */
export function assertSafeSessionId(id: string): string {
  if (!SESSION_ID_PATTERN.test(id)) {
    throw new Error('Invalid session ID: expected 1-64 letters, numbers, hyphens, or underscores');
  }
  return id;
}

/**
 * Atomically saves a ChatSession to disk (<indexDir>/sessions/<id>.json).
 */
export function saveChatSession(indexDir: string, session: ChatSession): string {
  assertSafeSessionId(session.id);
  const dir = getSessionsDir(indexDir);
  fs.mkdirSync(dir, { recursive: true });
  const targetPath = path.join(dir, `${session.id}.json`);
  const tmpPath = path.join(dir, `${session.id}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify(session, null, 2), 'utf8');
  fs.renameSync(tmpPath, targetPath);
  return targetPath;
}

/**
 * Loads a ChatSession by id or creates a new one. Degrades safely if corrupt.
 */
export function loadChatSession(
  indexDir: string,
  id: string,
  log: (msg: string) => void = () => {}
): ChatSession {
  assertSafeSessionId(id);
  const sessionPath = path.join(getSessionsDir(indexDir), `${id}.json`);
  if (fs.existsSync(sessionPath)) {
    try {
      const raw = fs.readFileSync(sessionPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.id === 'string' && Array.isArray(parsed.turns)) {
        return parsed as ChatSession;
      }
      log(`warning: session ${id} is malformed; starting a fresh session.`);
    } catch (e: any) {
      log(`warning: failed to parse session ${id} (${e.message}); starting fresh.`);
    }
  }

  const now = new Date().toISOString();
  return {
    id,
    createdAt: now,
    updatedAt: now,
    turns: [],
  };
}

/**
 * Lists all existing ChatSessions in the indexDir, sorted by updatedAt descending.
 */
export function listChatSessions(
  indexDir: string
): Array<{ id: string; createdAt: string; updatedAt: string; turnsCount: number }> {
  const dir = getSessionsDir(indexDir);
  if (!fs.existsSync(dir)) return [];

  const out: Array<{ id: string; createdAt: string; updatedAt: string; turnsCount: number }> = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }

  for (const file of entries) {
    if (!file.endsWith('.json')) continue;
    const p = path.join(dir, file);
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const s = JSON.parse(raw);
      if (s && typeof s.id === 'string' && Array.isArray(s.turns)) {
        out.push({
          id: s.id,
          createdAt: s.createdAt || s.updatedAt || '',
          updatedAt: s.updatedAt || s.createdAt || '',
          turnsCount: s.turns.length,
        });
      }
    } catch {}
  }

  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Built-in extractive answer synthesizer for fully offline, zero-dependency QA.
 */
export function extractAnswerFallback(query: string, passages: SearchResultHit[]): string {
  if (passages.length === 0) {
    return 'No relevant passages found in the notes to answer the question.';
  }

  const queryTokens = new Set(tokenize(query));
  const candidateSentences: Array<{ sentence: string; score: number; citation: string }> = [];

  for (const hit of passages) {
    const text = hit.snippet || '';
    const cite = hit.heading ? `[${hit.file} › ${hit.heading}]` : `[${hit.file}]`;
    // Split into sentences
    const sentences = text
      .split(/(?<=[.?!])\s+|\n+/)
      .map((s: string) => s.trim())
      .filter((s: string) => s.length > 15);

    for (const sent of sentences) {
      const sentTokens = tokenize(sent);
      let matchCount = 0;
      for (const tok of sentTokens) {
        if (queryTokens.has(tok)) matchCount++;
      }
      if (matchCount > 0) {
        const score = (matchCount / (sentTokens.length + 1)) * (hit.score || 1);
        candidateSentences.push({ sentence: sent, score, citation: cite });
      }
    }
  }

  if (candidateSentences.length === 0) {
    // Return top snippets directly
    const top = passages.slice(0, 2).map((p) => {
      const cite = p.heading ? `[${p.file} › ${p.heading}]` : `[${p.file}]`;
      return `${cite}: ${p.snippet.slice(0, 200)}…`;
    });
    return `Relevant excerpts from notes:\n\n${top.join('\n\n')}`;
  }

  candidateSentences.sort((a, b) => b.score - a.score);
  const selected = candidateSentences.slice(0, 3);
  const body = selected.map((s) => `${s.sentence} ${s.citation}`).join('\n\n');

  return `Based on your notes:\n\n${body}`;
}

const CITATION_MENTION_RE = /\[([^\]\n]{1,200})\]/g;

/** `[file]` | `[file#heading]` | `[file › heading]` → {file, heading?}; null for non-citations. */
function parseCitationMention(text: string): { file: string; heading?: string } | null {
  const t = text.trim();
  if (!t) return null;
  let file: string;
  let heading: string | undefined;
  const hash = t.indexOf('#');
  const sep = t.indexOf('›');
  if (hash > 0) {
    file = t.slice(0, hash).trim();
    heading = t.slice(hash + 1).trim();
  } else if (sep > 0) {
    file = t.slice(0, sep).trim();
    heading = t.slice(sep + 1).trim();
  } else {
    file = t;
  }
  // markdown links, footnote refs, and empty brackets are not citations
  if (!file || /https?:\/\//i.test(file)) return null;
  return { file, heading: heading || undefined };
}

/**
 * issue #199 follow-up: which of the retrieved citations the answer text
 * actually cites. Bracket-only scan (the exact formats the system prompt and
 * the extractive fallback emit), exact file/heading match against the
 * retrieval manifest, order of first mention. No mention → [].
 */
export function extractUsedCitations(answer: string, citations: Citation[]): Citation[] {
  const used: Citation[] = [];
  const seen = new Set<string>();
  for (const m of answer.matchAll(CITATION_MENTION_RE)) {
    const mention = parseCitationMention(m[1]);
    if (!mention) continue;
    const hit = citations.find(
      (c) => c.file === mention.file && (mention.heading === undefined || c.heading === mention.heading)
    );
    if (!hit) continue;
    const key = `${hit.file}\u0000${hit.heading ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      used.push(hit);
    }
  }
  return used;
}

/**
 * Synthesizes an answer from retrieved passages using an LLM or fallback.
 */
export async function synthesizeAnswer(
  query: string,
  passages: SearchResultHit[],
  options: {
    llmFn?: (prompt: string) => Promise<string>;
    llmRequestFn?: (req: LlmStructuredRequest) => Promise<string>;
    llmEndpoint?: string;
    llmModel?: string;
    /** issue #199: chat wire format for llmEndpoint — 'openai' (default) or 'ollama'. */
    llmProvider?: ChatProviderId;
    llmChat?: ResolvedChat;
    /** issue #199: incremental render hook — fires per token chunk while the LLM streams. */
    onDelta?: (delta: string) => void;
    /** Cooperative cancel (serve /ask: client disconnected mid-stream). */
    signal?: AbortSignal;
    systemPrompt?: string;
    conversationHistory?: string;
  } = {}
): Promise<SynthesisResult> {
  const citations: Citation[] = passages.map((p) => ({
    file: p.file,
    heading: p.heading,
    score: p.score,
  }));

  // One prompt assembly for every stage: `system + user` reproduces the
  // historical single-string prompt byte-for-byte; the split serves the
  // structured transports (MCP sampling, issue #197).
  const system = options.systemPrompt || DEFAULT_RAG_SYSTEM_PROMPT;
  const historyHeader = options.conversationHistory ? `\nConversation History:\n${options.conversationHistory}\n` : '';
  const contextBlocks = passages
    .map((p, i) => {
      const header = p.heading ? `${p.file} › ${p.heading}` : p.file;
      return `[Source ${i + 1}: ${header}]\n${p.snippet}`;
    })
    .join('\n\n---\n\n');
  const user = `${historyHeader}\n\nContext:\n${contextBlocks}\n\nQuestion: ${query}\n\nAnswer:`;

  // every stage returns through one shape so citationsUsed stays consistent
  const finish = (answer: string, mode: SynthesisResult['mode']): SynthesisResult => ({
    answer,
    citations,
    citationsUsed: extractUsedCitations(answer, citations),
    passages,
    mode,
  });

  // issue #197: structured hook (MCP sampling). Best-effort like the endpoint
  // path — a refusal or timeout falls through to the extractive answer.
  if (options.llmRequestFn) {
    try {
      const answer = await options.llmRequestFn({ system, user });
      if (answer) return finish(answer, 'llm');
    } catch {
      // Fall through to extractive.
    }
  }

  if (options.llmFn) {
    const answer = await options.llmFn(system + user);
    return finish(answer, 'llm');
  }

  // issue #199: unified chat provider path. `/chat/completions` by default
  // (same wire format HyDE uses — llama.cpp, LM Studio, vLLM, Ollama /v1 all
  // speak it), Ollama-native `/api/generate` under `--llm-provider ollama`.
  // Streaming deltas flow to onDelta; the full text is assembled for the
  // returned result. Best-effort like the old endpoint path — a refusal or
  // idle timeout falls through to the extractive answer.
  if (options.llmChat || options.llmEndpoint) {
    const chat =
      options.llmChat ??
      resolveChatProvider({
        provider: options.llmProvider ?? 'openai',
        model: options.llmModel,
        baseUrl: options.llmEndpoint,
      });
    try {
      const answer = await chat.complete({
        system,
        user,
        ...(options.onDelta ? { onDelta: options.onDelta } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (answer) return finish(answer, 'endpoint');
    } catch {
      // Fall through to extractive.
    }
  }

  const answer = extractAnswerFallback(query, passages);
  return finish(answer, 'extractive');
}

/**
 * End-to-end question answering against a Markdown index.
 */
export async function askQuestion(opts: AskOptions): Promise<SynthesisResult> {
  const {
    query,
    loaded: inputLoaded,
    indexDir,
    cacheDir = '',
    k = 5,
    llmFn,
    llmRequestFn,
    llmEndpoint,
    llmModel,
    llmProvider,
    llmChat,
    onDelta,
    systemPrompt,
    embedFn,
  } = opts;

  let loaded = inputLoaded;
  if (!loaded) {
    if (!indexDir) throw new Error('askQuestion requires either loaded index or indexDir');
    loaded = loadIndex(indexDir);
  }

  const passages = await searchIndex({
    loaded,
    cacheDir,
    query,
    k,
    embedFn,
    offline: opts.offline,
  });

  return synthesizeAnswer(query, passages, {
    llmFn,
    llmRequestFn,
    llmEndpoint,
    llmModel,
    llmProvider,
    llmChat,
    onDelta,
    systemPrompt,
  });
}

/**
 * Executes a single conversational turn in a ChatSession with context carry-over and source manifest.
 */
export async function chatTurn(opts: ChatTurnOptions): Promise<{
  session: ChatSession;
  turn: ChatTurn;
  answer: string;
  citations: Citation[];
  manifest: ChatSourceManifestItem[];
  /** Which synthesis stage produced the answer ('llm'/'endpoint'/'extractive'). */
  mode: SynthesisResult['mode'];
  /** Citations the answer text actually mentions (issue #199 follow-up). */
  citationsUsed: Citation[];
}> {
  const {
    query,
    loaded: inputLoaded,
    indexDir,
    cacheDir = '',
    k = 5,
    llmFn,
    llmRequestFn,
    llmEndpoint,
    llmModel,
    llmProvider,
    llmChat,
    onDelta,
    systemPrompt,
    embedFn,
    log = () => {},
  } = opts;

  let loaded = inputLoaded;
  if (!loaded) {
    if (!indexDir) throw new Error('chatTurn requires either loaded index or indexDir');
    loaded = loadIndex(indexDir);
  }

  let session = opts.session;
  if (!session) {
    const newId = crypto.randomUUID().slice(0, 8);
    session = indexDir ? loadChatSession(indexDir, newId, log) : {
      id: newId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      turns: [],
    };
  }

  // 1. Build contextual retrieval query for follow-up questions
  let retrievalQuery = query;
  if (session.turns.length > 0) {
    const prevTurn = session.turns[session.turns.length - 1];
    const prevTokens = tokenize(prevTurn.query).filter((t) => t.length > 3).slice(0, 4);
    if (prevTokens.length > 0) {
      retrievalQuery = `${query} ${prevTokens.join(' ')}`.trim();
    }
  }

  // 2. Search index
  const passages = await searchIndex({
    loaded,
    cacheDir,
    query: retrievalQuery,
    k,
    embedFn,
    offline: opts.offline,
  });

  // 3. Construct source manifest from retrieved chunks
  const manifest: ChatSourceManifestItem[] = passages.map((p) => {
    const chunk = loaded.index?.chunks?.find(
      (c: any) => c.file === p.file && (c.heading === p.heading || (!c.heading && !p.heading))
    );
    return {
      file: p.file,
      heading: p.heading,
      headingPath: chunk?.headingPath,
      startLine: chunk?.startLine,
      endLine: chunk?.endLine,
      chunkHash: chunk?.chunkHash,
      score: p.score,
    };
  });

  // 4. Conversation history string for LLM prompt
  let conversationHistory = '';
  if (session.turns.length > 0) {
    conversationHistory = session.turns
      .slice(-3)
      .map((t) => `User: ${t.query}\nAssistant: ${t.answer}`)
      .join('\n\n');
  }

  // 5. Synthesize answer
  const synth = await synthesizeAnswer(query, passages, {
    llmFn,
    llmRequestFn,
    llmEndpoint,
    llmModel,
    llmProvider,
    llmChat,
    onDelta,
    systemPrompt,
    conversationHistory,
  });

  // 6. Append turn to session
  const turn: ChatTurn = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    query,
    answer: synth.answer,
    citations: synth.citations,
    manifest,
    mode: synth.mode,
  };

  session.turns.push(turn);
  session.updatedAt = turn.timestamp;
  if (loaded.index?.db) session.db = loaded.index.db;
  if (loaded.model?.id) session.model = loaded.model.id;

  if (indexDir) {
    try {
      saveChatSession(indexDir, session);
    } catch (e: any) {
      log(`warning: failed to save chat session ${session.id}: ${e.message}`);
    }
  }

  return {
    session,
    turn,
    answer: turn.answer,
    citations: turn.citations,
    manifest: turn.manifest,
    mode: turn.mode ?? 'extractive',
    citationsUsed: extractUsedCitations(turn.answer, turn.citations),
  };
}

