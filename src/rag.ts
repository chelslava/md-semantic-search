/**
 * Offline QA & Local RAG Answer Synthesis (issue #101).
 *
 * Implements grounded question answering with strict provenance citations ([file#heading]),
 * supporting local LLM bridges (Ollama / LocalAI / OpenAI-compatible endpoint) and a
 * fast built-in zero-dependency extractive synthesis fallback.
 */
import { searchIndex, loadIndex, LoadedIndex, SearchResultHit } from './search.js';
import { tokenize } from './lexical.js';

export interface Citation {
  file: string;
  heading?: string;
  score: number;
}

export interface SynthesisResult {
  answer: string;
  citations: Citation[];
  passages: SearchResultHit[];
}

export interface AskOptions {
  query: string;
  loaded?: LoadedIndex;
  indexDir?: string;
  cacheDir?: string;
  db?: string;
  k?: number;
  llmEndpoint?: string;
  llmModel?: string;
  llmFn?: (prompt: string) => Promise<string>;
  systemPrompt?: string;
  embedFn?: any;
}

export const DEFAULT_RAG_SYSTEM_PROMPT =
  'You are a helpful assistant answering questions using only the provided Markdown notes. ' +
  'Always cite your sources using [file#heading] format. ' +
  'If the context does not contain the answer, say that the notes do not have enough information.';

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

/**
 * Synthesizes an answer from retrieved passages using an LLM or fallback.
 */
export async function synthesizeAnswer(
  query: string,
  passages: SearchResultHit[],
  options: {
    llmFn?: (prompt: string) => Promise<string>;
    llmEndpoint?: string;
    llmModel?: string;
    systemPrompt?: string;
  } = {}
): Promise<SynthesisResult> {
  const citations: Citation[] = passages.map((p) => ({
    file: p.file,
    heading: p.heading,
    score: p.score,
  }));

  if (options.llmFn) {
    const contextBlocks = passages.map((p, i) => {
      const header = p.heading ? `${p.file} › ${p.heading}` : p.file;
      return `[Source ${i + 1}: ${header}]\n${p.snippet}`;
    }).join('\n\n---\n\n');

    const prompt = `${options.systemPrompt || DEFAULT_RAG_SYSTEM_PROMPT}\n\nContext:\n${contextBlocks}\n\nQuestion: ${query}\n\nAnswer:`;
    const answer = await options.llmFn(prompt);
    return { answer, citations, passages };
  }

  if (options.llmEndpoint) {
    const contextBlocks = passages.map((p, i) => {
      const header = p.heading ? `${p.file} › ${p.heading}` : p.file;
      return `[Source ${i + 1}: ${header}]\n${p.snippet}`;
    }).join('\n\n---\n\n');

    const prompt = `${options.systemPrompt || DEFAULT_RAG_SYSTEM_PROMPT}\n\nContext:\n${contextBlocks}\n\nQuestion: ${query}\n\nAnswer:`;
    try {
      const resp = await fetch(`${options.llmEndpoint}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: options.llmModel || 'llama3',
          prompt,
          stream: false,
        }),
      });
      if (resp.ok) {
        const data: any = await resp.json();
        const answer = data.response || data.text || '';
        if (answer) return { answer, citations, passages };
      }
    } catch {
      // Fallback to extractive
    }
  }

  const answer = extractAnswerFallback(query, passages);
  return { answer, citations, passages };
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
    llmEndpoint,
    llmModel,
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
  });

  return synthesizeAnswer(query, passages, {
    llmFn,
    llmEndpoint,
    llmModel,
    systemPrompt,
  });
}
