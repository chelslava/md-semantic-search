/**
 * Wikilink and backlink relationship extraction and resolution (issue #61).
 * Supports Obsidian wikilinks [[note]], [[note#heading|alias]], and relative Markdown links.
 */
import { DocumentMetadata } from './frontmatter.js';
import { cosine, decodeVec } from './core.js';
import { dequantizeFromInt8 } from './quantization.js';

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
    const basename = relFile.replace(/\.md$/i, '').split(/[/\\]/).pop()?.toLowerCase();
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

export interface FindRelatedNotesOptions {
  loaded: { index: any; model?: any };
  target: string;
  k?: number;
  direction?: 'both' | 'outgoing' | 'backlinks';
  maxDepth?: number;
  semantic?: boolean;
  minScore?: number;
}

export interface RelatedNoteHit {
  file: string;
  title: string;
  score: number;
  reason: string;
  distance?: number;
  cosine?: number;
}

export interface RelatedNoteResult {
  target: string;
  resolvedFile: string;
  results: RelatedNoteHit[];
  total: number;
}

/**
 * Finds notes related to a target note via graph links (outgoing, backlinks, 2-hop)
 * and semantic similarity (issue #141).
 */
export function findRelatedNotes(opts: FindRelatedNotesOptions): RelatedNoteResult {
  const { loaded, target, k = 10, direction = 'both', maxDepth = 2, semantic = true } = opts;
  if (!target || typeof target !== 'string') {
    throw new Error('findRelatedNotes: "target" parameter is required');
  }

  const chunks = loaded.index?.chunks || [];
  if (chunks.length === 0) {
    throw new Error('Index has no chunks');
  }

  // 1. Group chunks by file to construct LinkDoc list and index metadata
  const docMap = new Map<string, { title: string; meta?: DocumentMetadata; texts: string[]; vecs: Float32Array[] }>();
  for (const c of chunks) {
    const existing = docMap.get(c.file);
    let v: Float32Array | null = null;
    if (c.vec) {
      if (c.vec instanceof Float32Array) {
        v = c.vec;
      } else if (Array.isArray(c.vec)) {
        v = Float32Array.from(c.vec);
      } else if (typeof c.vec === 'string') {
        try {
          v = decodeVec(c.vec);
        } catch {
          v = null;
        }
      } else if (c.vec instanceof Int8Array) {
        v = dequantizeFromInt8(c.vec);
      }
    }
    if (existing) {
      existing.texts.push(c.text || '');
      if (v) existing.vecs.push(v);
    } else {
      docMap.set(c.file, {
        title: c.title || '',
        meta: c.meta,
        texts: [c.text || ''],
        vecs: v ? [v] : [],
      });
    }
  }

  const docs: LinkDoc[] = Array.from(docMap.entries()).map(([file, d]) => ({
    file,
    title: d.title,
    meta: d.meta,
    text: d.texts.join('\n\n'),
  }));

  // 2. Resolve target note
  const rawTarget = target.trim();
  const normalizedTarget = rawTarget.toLowerCase().replace(/\.md$/i, '').split(/[#|]/)[0].trim();
  let targetFile: string | null = null;

  for (const [file, d] of docMap.entries()) {
    const normFile = file.toLowerCase().replace(/\.md$/i, '');
    const basename = normFile.split(/[/\\]/).pop() || '';
    const normTitle = (d.title || '').toLowerCase();
    const aliases = (d.meta?.aliases || []).map((a: string) => a.toLowerCase());

    if (
      file.toLowerCase() === rawTarget.toLowerCase() ||
      normFile === normalizedTarget ||
      basename === normalizedTarget ||
      normTitle === normalizedTarget ||
      aliases.includes(normalizedTarget)
    ) {
      targetFile = file;
      break;
    }
  }

  if (!targetFile) {
    throw new Error(`Note not found: "${target}"`);
  }

  // 3. Build graph & find graph relationships
  const graph = buildRelationshipGraph(docs);
  const graphRelated = getRelatedNotes(graph, targetFile, { direction, depth: maxDepth });

  const hitsMap = new Map<string, RelatedNoteHit>();

  const outgoingSet = new Set((graph.outgoing.get(targetFile) || []).map((e) => e.file));
  const backlinkSet = new Set((graph.backlinks.get(targetFile) || []).map((e) => e.file));

  for (const rel of graphRelated) {
    if (rel.file === targetFile) continue;
    const d = docMap.get(rel.file);
    const title = d?.title || rel.file;

    let reason = '';
    let score = 0;

    if (rel.distance === 1) {
      const isOut = outgoingSet.has(rel.file);
      const isBack = backlinkSet.has(rel.file);
      if (isOut && isBack) {
        reason = 'bi-directional link';
        score = 1.5;
      } else if (isOut) {
        reason = 'outgoing link';
        score = 1.0;
      } else {
        reason = 'backlink';
        score = 1.0;
      }
    } else {
      reason = `${rel.distance}-hop connection`;
      score = Math.max(0.1, 1.0 / rel.distance);
    }

    hitsMap.set(rel.file, {
      file: rel.file,
      title,
      score,
      reason,
      distance: rel.distance,
    });
  }

  // 4. Semantic similarity (if enabled or if graph has 0 links)
  const targetData = docMap.get(targetFile);
  const targetVecs = targetData?.vecs || [];

  if (semantic && targetVecs.length > 0) {
    // Compute target centroid
    const dim = targetVecs[0].length;
    const centroid = new Float32Array(dim);
    for (const tv of targetVecs) {
      for (let i = 0; i < dim; i++) centroid[i] += tv[i];
    }
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += centroid[i] * centroid[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i++) centroid[i] /= norm;

    // Compare against every other note's centroid or max chunk cosine
    for (const [file, d] of docMap.entries()) {
      if (file === targetFile || d.vecs.length === 0) continue;
      let maxCos = -1;
      for (const cv of d.vecs) {
        if (cv.length === dim) {
          const cos = cosine(centroid, cv);
          if (cos > maxCos) maxCos = cos;
        }
      }

      if (maxCos > 0.3) {
        const existing = hitsMap.get(file);
        if (existing) {
          existing.score += maxCos * 0.5;
          existing.reason += ` + semantic (cos: ${maxCos.toFixed(2)})`;
          existing.cosine = maxCos;
        } else {
          hitsMap.set(file, {
            file,
            title: d.title || file,
            score: maxCos,
            reason: `semantic similarity (cos: ${maxCos.toFixed(2)})`,
            cosine: maxCos,
          });
        }
      }
    }
  }

  // 5. Deterministic sorting: by score descending, ties broken by file ascending
  const sortedHits = Array.from(hitsMap.values()).sort((a, b) => {
    if (Math.abs(b.score - a.score) > 1e-6) {
      return b.score - a.score;
    }
    return a.file.localeCompare(b.file);
  });

  const finalHits = sortedHits.slice(0, k);

  return {
    target: rawTarget,
    resolvedFile: targetFile,
    results: finalHits,
    total: finalHits.length,
  };
}


