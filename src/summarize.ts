/**
 * Automated Note Summarization & Semantic Keyword Tagging Pipeline (issue #103).
 *
 * Implements zero-dependency, deterministic extractive summarization and keyphrase
 * tag extraction to enrich note chunks with discoverable semantic metadata.
 */
import { tokenize } from './lexical.js';

export interface NoteAnalysis {
  tags: string[];
  summary: string;
}

/**
 * Extracts salient topical tags from Markdown text using term frequency and position weighting.
 */
export function extractKeyphraseTags(text: string, maxTags: number = 5): string[] {
  if (!text || !text.trim()) return [];

  const lines = text.split('\n');
  const termScores = new Map<string, number>();

  lines.forEach((line, lineIdx) => {
    const isHeading = /^#{1,6}\s+/.test(line);
    const weight = isHeading ? 3.0 : lineIdx < 3 ? 1.5 : 1.0;
    const tokens = tokenize(line);

    for (const tok of tokens) {
      if (tok.length < 3) continue;
      // Skip purely numeric tokens
      if (/^\d+$/.test(tok)) continue;

      const current = termScores.get(tok) || 0;
      termScores.set(tok, current + weight);
    }
  });

  const sorted = Array.from(termScores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTags)
    .map(([term]) => term);

  return sorted;
}

/**
 * Generates a concise extractive summary (1-2 sentences) representing the salient points of a note.
 */
export function summarizePassage(text: string, maxSentences: number = 2): string {
  if (!text || !text.trim()) return '';

  // Clean Markdown formatting
  const clean = text
    .replace(/^#{1,6}\s+.*$/gm, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .trim();

  const sentences = clean
    .split(/(?<=[.?!])\s+|\n\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20 && s.length <= 300);

  if (sentences.length <= maxSentences) {
    return sentences.join(' ');
  }

  const salientTags = new Set(extractKeyphraseTags(clean, 8));

  const scored = sentences.map((sent, index) => {
    const tokens = tokenize(sent);
    let tagMatches = 0;
    for (const t of tokens) {
      if (salientTags.has(t)) tagMatches++;
    }
    // Favor earlier sentences and sentences containing salient keywords
    const posScore = 1.0 / (index + 1);
    const salienceScore = tagMatches / (tokens.length + 1);
    const score = posScore * 0.4 + salienceScore * 0.6;
    return { sent, score, index };
  });

  scored.sort((a, b) => b.score - a.score);
  const selected = scored.slice(0, maxSentences).sort((a, b) => a.index - b.index);

  return selected.map((s) => s.sent).join(' ');
}

/**
 * Analyzes a Markdown note to produce automated semantic tags and summary.
 */
export function analyzeNote(text: string): NoteAnalysis {
  return {
    tags: extractKeyphraseTags(text),
    summary: summarizePassage(text),
  };
}
