/**
 * Wikilink and backlink relationship extraction and resolution (issue #61).
 * Supports Obsidian wikilinks [[note]], [[note#heading|alias]], and relative Markdown links.
 */
import { DocumentMetadata } from './frontmatter.js';

export interface RawLink {
  type: 'wikilink' | 'markdown';
  target: string;
  anchor?: string;
  label?: string;
  raw: string;
  line: number;
}

export interface ResolvedLink {
  raw: string;
  target: string;
  resolvedFile?: string;
  status: 'resolved' | 'broken' | 'ambiguous';
  line: number;
}

export interface LinkDoc {
  file: string;
  title?: string;
  meta?: DocumentMetadata;
  text?: string;
}

export function extractLinks(text?: string): RawLink[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const links: RawLink[] = [];

  const wikiRegex = /\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;
  const mdLinkRegex = /\[([^\]]+)\]\(([^)]+\.md)(?:#([^)]+))?\)/g;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i];

    let match: RegExpExecArray | null;
    wikiRegex.lastIndex = 0;
    while ((match = wikiRegex.exec(line)) !== null) {
      links.push({
        type: 'wikilink',
        target: match[1].trim(),
        anchor: match[2]?.trim(),
        label: match[3]?.trim(),
        raw: match[0],
        line: lineNum,
      });
    }

    mdLinkRegex.lastIndex = 0;
    while ((match = mdLinkRegex.exec(line)) !== null) {
      const rawTarget = match[2].trim();
      if (!rawTarget.startsWith('http://') && !rawTarget.startsWith('https://')) {
        links.push({
          type: 'markdown',
          target: rawTarget,
          anchor: match[3]?.trim(),
          label: match[1]?.trim(),
          raw: match[0],
          line: lineNum,
        });
      }
    }
  }

  return links;
}

export function resolveLinks(
  rawLinks: RawLink[],
  currentFile: string,
  docs: LinkDoc[]
): ResolvedLink[] {
  if (!rawLinks || rawLinks.length === 0) return [];

  const pathMap = new Map<string, string>();
  const titleMap = new Map<string, string[]>();
  const aliasMap = new Map<string, string[]>();

  for (const doc of docs) {
    const relFile = doc.file;
    pathMap.set(relFile.toLowerCase(), relFile);
    const basename = relFile.replace(/\.md$/i, '').split('/').pop()?.toLowerCase();
    if (basename && !pathMap.has(basename)) {
      pathMap.set(basename, relFile);
    }

    if (doc.title) {
      const titleKey = doc.title.toLowerCase();
      const existing = titleMap.get(titleKey) || [];
      existing.push(relFile);
      titleMap.set(titleKey, existing);
    }

    if (doc.meta?.aliases) {
      for (const alias of doc.meta.aliases) {
        const aliasKey = alias.toLowerCase();
        const existing = aliasMap.get(aliasKey) || [];
        existing.push(relFile);
        aliasMap.set(aliasKey, existing);
      }
    }
  }

  return rawLinks.map((link) => {
    const targetKey = link.target.toLowerCase().replace(/\.md$/i, '');
    let matches: string[] = [];

    if (pathMap.has(targetKey)) {
      const found = pathMap.get(targetKey);
      if (found) matches.push(found);
    } else if (titleMap.has(targetKey)) {
      matches = titleMap.get(targetKey) || [];
    } else if (aliasMap.has(targetKey)) {
      matches = aliasMap.get(targetKey) || [];
    }

    matches = [...new Set(matches)];

    if (matches.length === 1) {
      return {
        raw: link.raw,
        target: link.target,
        resolvedFile: matches[0],
        status: 'resolved',
        line: link.line,
      };
    } else if (matches.length > 1) {
      return {
        raw: link.raw,
        target: link.target,
        status: 'ambiguous',
        line: link.line,
      };
    } else {
      return {
        raw: link.raw,
        target: link.target,
        status: 'broken',
        line: link.line,
      };
    }
  });
}

export interface GraphEdge {
  file: string;
  raw: string;
  line: number;
}

export interface RelationshipGraph {
  outgoing: Map<string, GraphEdge[]>;
  backlinks: Map<string, GraphEdge[]>;
}

export function buildRelationshipGraph(docs: LinkDoc[]): RelationshipGraph {
  const outgoing = new Map<string, GraphEdge[]>();
  const backlinks = new Map<string, GraphEdge[]>();

  for (const doc of docs) {
    if (!outgoing.has(doc.file)) outgoing.set(doc.file, []);
    if (!backlinks.has(doc.file)) backlinks.set(doc.file, []);
  }

  for (const doc of docs) {
    const rawLinks = extractLinks(doc.text);
    const resolved = resolveLinks(rawLinks, doc.file, docs);

    const docOutgoing = outgoing.get(doc.file) || [];
    for (const r of resolved) {
      if (r.status === 'resolved' && r.resolvedFile && r.resolvedFile !== doc.file) {
        docOutgoing.push({ file: r.resolvedFile, raw: r.raw, line: r.line });
        const targetBacklinks = backlinks.get(r.resolvedFile) || [];
        targetBacklinks.push({ file: doc.file, raw: r.raw, line: r.line });
        backlinks.set(r.resolvedFile, targetBacklinks);
      }
    }
    outgoing.set(doc.file, docOutgoing);
  }

  return { outgoing, backlinks };
}

export interface RelatedNote {
  file: string;
  distance: number;
  direction: string;
}

export function getRelatedNotes(
  graph: RelationshipGraph,
  targetFile: string,
  opts: { direction?: 'both' | 'outgoing' | 'backlinks'; depth?: number } = {}
): RelatedNote[] {
  const direction = opts.direction || 'both';
  const maxDepth = opts.depth || 1;

  const visited = new Set<string>([targetFile]);
  const results: RelatedNote[] = [];

  const queue: Array<{ file: string; depth: number }> = [{ file: targetFile, depth: 0 }];

  while (queue.length > 0) {
    const curr = queue.shift();
    if (!curr) continue;

    if (curr.depth >= maxDepth) continue;

    const nextNodes: Array<{ file: string; depth: number }> = [];

    if (direction === 'both' || direction === 'outgoing') {
      const outList = graph.outgoing.get(curr.file) || [];
      for (const item of outList) {
        if (!visited.has(item.file)) {
          visited.add(item.file);
          results.push({ file: item.file, distance: curr.depth + 1, direction: 'outgoing' });
          nextNodes.push({ file: item.file, depth: curr.depth + 1 });
        }
      }
    }

    if (direction === 'both' || direction === 'backlinks') {
      const backList = graph.backlinks.get(curr.file) || [];
      for (const item of backList) {
        if (!visited.has(item.file)) {
          visited.add(item.file);
          results.push({ file: item.file, distance: curr.depth + 1, direction: 'backlink' });
          nextNodes.push({ file: item.file, depth: curr.depth + 1 });
        }
      }
    }

    queue.push(...nextNodes);
  }

  return results;
}

export interface PageRankOptions {
  damping?: number;
  maxIterations?: number;
  tolerance?: number;
}

/**
 * Computes in-memory PageRank centrality scores for all nodes in the RelationshipGraph.
 * Handles dangling nodes (nodes with 0 out-degree) and normalizes scores.
 */
export function computePageRank(
  graph: RelationshipGraph,
  opts: PageRankOptions = {}
): Map<string, number> {
  const damping = opts.damping ?? 0.85;
  const maxIterations = opts.maxIterations ?? 30;
  const tolerance = opts.tolerance ?? 1e-6;

  const nodes = new Set<string>();
  for (const node of graph.outgoing.keys()) nodes.add(node);
  for (const node of graph.backlinks.keys()) nodes.add(node);

  const nodeList = Array.from(nodes);
  const n = nodeList.length;
  const rankMap = new Map<string, number>();
  if (n === 0) return rankMap;
  if (n === 1) {
    rankMap.set(nodeList[0], 1.0);
    return rankMap;
  }

  const outNeighbors = new Map<string, Set<string>>();
  for (const node of nodeList) {
    const edges = graph.outgoing.get(node) || [];
    const targets = new Set<string>();
    for (const e of edges) {
      if (nodes.has(e.file) && e.file !== node) {
        targets.add(e.file);
      }
    }
    outNeighbors.set(node, targets);
  }

  const inNeighbors = new Map<string, Set<string>>();
  for (const node of nodeList) {
    inNeighbors.set(node, new Set<string>());
  }
  for (const [src, targets] of outNeighbors.entries()) {
    for (const tgt of targets) {
      inNeighbors.get(tgt)?.add(src);
    }
  }

  let ranks = new Map<string, number>();
  const initialRank = 1.0 / n;
  for (const node of nodeList) {
    ranks.set(node, initialRank);
  }

  for (let iter = 0; iter < maxIterations; iter++) {
    const nextRanks = new Map<string, number>();

    let danglingSum = 0;
    for (const node of nodeList) {
      const outDeg = outNeighbors.get(node)?.size || 0;
      if (outDeg === 0) {
        danglingSum += ranks.get(node) || 0;
      }
    }

    let maxDiff = 0;
    const baseRank = (1.0 - damping) / n + (damping * danglingSum) / n;

    for (const node of nodeList) {
      let inSum = 0;
      const inNodes = inNeighbors.get(node) || new Set();
      for (const inNode of inNodes) {
        const outDeg = outNeighbors.get(inNode)?.size || 1;
        inSum += (ranks.get(inNode) || 0) / outDeg;
      }

      const newRank = baseRank + damping * inSum;
      nextRanks.set(node, newRank);

      const diff = Math.abs(newRank - (ranks.get(node) || 0));
      if (diff > maxDiff) maxDiff = diff;
    }

    ranks = nextRanks;
    if (maxDiff < tolerance) break;
  }

  return ranks;
}

export interface GraphExpansionOptions {
  maxDepth?: number;
  decay?: number;
  topSeeds?: number;
}

/**
 * 2-hop neighborhood expansion: propagates relevance scores across graph links.
 */
export function expandGraphNeighborhood(
  graph: RelationshipGraph,
  seedFiles: Array<{ file: string; score: number }>,
  opts: GraphExpansionOptions = {}
): Map<string, number> {
  const maxDepth = opts.maxDepth ?? 2;
  const decay = opts.decay ?? 0.5;
  const topSeeds = opts.topSeeds ?? 10;

  const propagationScores = new Map<string, number>();
  const sortedSeeds = [...seedFiles].sort((a, b) => b.score - a.score).slice(0, topSeeds);

  for (const seed of sortedSeeds) {
    if (seed.score <= 0) continue;
    const related = getRelatedNotes(graph, seed.file, { direction: 'both', depth: maxDepth });
    for (const rel of related) {
      const weight = seed.score * Math.pow(decay, rel.distance);
      const current = propagationScores.get(rel.file) || 0;
      if (weight > current) {
        propagationScores.set(rel.file, weight);
      }
    }
  }

  return propagationScores;
}

