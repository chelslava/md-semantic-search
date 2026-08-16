// @ts-check
/**
 * Wikilink and backlink relationship extraction and resolution (issue #61).
 * Supports Obsidian wikilinks [[note]], [[note#heading|alias]], and relative Markdown links.
 */

/**
 * @typedef {Object} RawLink
 * @property {'wikilink'|'markdown'} type
 * @property {string} target
 * @property {string} [anchor]
 * @property {string} [label]
 * @property {string} raw
 * @property {number} line
 */

/**
 * @typedef {Object} ResolvedLink
 * @property {string} raw
 * @property {string} target
 * @property {string} [resolvedFile]
 * @property {'resolved'|'broken'|'ambiguous'} status
 * @property {number} line
 */

/**
 * Extract wikilinks and relative Markdown links from Markdown content.
 * @param {string} text
 * @returns {RawLink[]}
 */
export function extractLinks(text) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const links = [];

  // Match [[target#anchor|label]] or [[target|label]] or [[target]]
  const wikiRegex = /\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;
  // Match relative Markdown links [label](./path/to/file.md) or [label](../path.md)
  const mdLinkRegex = /\[([^\]]+)\]\(([^)]+\.md)(?:#([^)]+))?\)/g;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i];

    let match;
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

/**
 * Resolve extracted links against a map of documents (keyed by relative path/file).
 * @param {RawLink[]} rawLinks
 * @param {string} currentFile
 * @param {Array<{file:string, title?:string, meta?:import('./frontmatter.mjs').DocumentMetadata}>} docs
 * @returns {ResolvedLink[]}
 */
export function resolveLinks(rawLinks, currentFile, docs) {
  if (!rawLinks || rawLinks.length === 0) return [];

  // Build lookups: titleMap, aliasMap, pathMap
  const pathMap = new Map();
  const titleMap = new Map();
  const aliasMap = new Map();

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

  return rawLinks.map(link => {
    const targetKey = link.target.toLowerCase().replace(/\.md$/i, '');
    let matches = [];

    if (pathMap.has(targetKey)) {
      matches.push(pathMap.get(targetKey));
    } else if (titleMap.has(targetKey)) {
      matches = titleMap.get(targetKey);
    } else if (aliasMap.has(targetKey)) {
      matches = aliasMap.get(targetKey);
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

/**
 * Build graph of outgoing links and backlinks across documents.
 * @param {Array<{file:string, title?:string, text:string, meta?:import('./frontmatter.mjs').DocumentMetadata}>} docs
 */
export function buildRelationshipGraph(docs) {
  const outgoing = new Map();
  const backlinks = new Map();

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

/**
 * Traverse graph to find related notes.
 * @param {{outgoing: Map<string, Array<{file:string}>>, backlinks: Map<string, Array<{file:string}>>}} graph
 * @param {string} targetFile
 * @param {object} [opts]
 * @param {'both'|'outgoing'|'backlinks'} [opts.direction='both']
 * @param {number} [opts.depth=1]
 * @returns {Array<{file:string, distance:number, direction:string}>}
 */
export function getRelatedNotes(graph, targetFile, opts = {}) {
  const direction = opts.direction || 'both';
  const maxDepth = opts.depth || 1;

  const visited = new Set([targetFile]);
  const results = [];

  const queue = [{ file: targetFile, depth: 0 }];

  while (queue.length > 0) {
    const curr = queue.shift();
    if (!curr) continue;

    if (curr.depth >= maxDepth) continue;

    const nextNodes = [];

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
