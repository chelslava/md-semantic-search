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
