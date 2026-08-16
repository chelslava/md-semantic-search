/**
 * Typed YAML Frontmatter parser and metadata normalizer (issue #58).
 * Parses YAML frontmatter into a validated document metadata object without
 * unsafe executable tags. Supports scalars, inline/block lists, quotes, booleans,
 * dates, tags normalization, and canonical document identity.
 */

export interface DocumentMetadata {
  title?: string;
  aliases: string[];
  tags: string[];
  project?: string;
  type?: string;
  status?: string;
  canonical?: boolean;
  canonicalRef?: string;
  created?: string;
  updated?: string;
  custom: Record<string, string | number | boolean | string[]>;
}

export function parseFrontmatter(rawYaml?: string): DocumentMetadata {
  const metadata: DocumentMetadata = {
    aliases: [],
    tags: [],
    custom: {},
  };

  if (!rawYaml || typeof rawYaml !== 'string') {
    return metadata;
  }

  const lines = rawYaml.split(/\r?\n/);
  let currentKey: string | null = null;
  let currentBlockList: string[] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const blockListMatch = line.match(/^(\s+)-\s+(.+)$/);
    if (blockListMatch && currentKey && currentBlockList) {
      const val = parseYAMLValue(blockListMatch[2]);
      if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
        currentBlockList.push(String(val));
      }
      continue;
    }

    const kvMatch = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (kvMatch) {
      if (currentKey && currentBlockList) {
        setMetadataValue(metadata, currentKey, currentBlockList);
        currentKey = null;
        currentBlockList = null;
      }

      const key = kvMatch[1].trim();
      const rawVal = kvMatch[2].trim();

      if (rawVal === '') {
        currentKey = key;
        currentBlockList = [];
      } else {
        const val = parseYAMLValue(rawVal);
        setMetadataValue(metadata, key, val);
      }
    }
  }

  if (currentKey && currentBlockList) {
    setMetadataValue(metadata, currentKey, currentBlockList);
  }

  return metadata;
}

function parseYAMLValue(raw: string): string | number | boolean | string[] {
  const trimmed = raw.trim();

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(',')
      .map((item) => parseYAMLValue(item))
      .map((item) => (Array.isArray(item) ? item.join(' ') : String(item).trim()))
      .filter((item) => item.length > 0);
  }

  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }

  if (/^true$/i.test(trimmed)) return true;
  if (/^false$/i.test(trimmed)) return false;

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (!Number.isNaN(num)) return num;
  }

  return trimmed;
}

function setMetadataValue(
  meta: DocumentMetadata,
  key: string,
  val: string | number | boolean | string[]
): void {
  const normKey = key.toLowerCase().replace(/[-_]/g, '');

  if (normKey === 'title' && typeof val === 'string') {
    meta.title = val;
    return;
  }

  if (normKey === 'alias' || normKey === 'aliases') {
    const items = Array.isArray(val) ? val : [String(val)];
    for (const item of items) {
      const cleaned = item.trim().replace(/^["']|["']$/g, '');
      if (cleaned && !meta.aliases.includes(cleaned)) {
        meta.aliases.push(cleaned);
      }
    }
    return;
  }

  if (normKey === 'tag' || normKey === 'tags') {
    let items: string[] | (string | number | boolean)[];
    if (Array.isArray(val)) {
      items = val;
    } else if (typeof val === 'string') {
      items = val.includes(',') ? val.split(',') : [val];
    } else {
      items = [String(val)];
    }
    for (const item of items) {
      const cleaned = String(item)
        .trim()
        .replace(/^#/, '')
        .toLowerCase();
      if (cleaned && !meta.tags.includes(cleaned)) {
        meta.tags.push(cleaned);
      }
    }
    return;
  }

  if (normKey === 'project' && (typeof val === 'string' || typeof val === 'number')) {
    meta.project = String(val);
    return;
  }

  if (normKey === 'type' && typeof val === 'string') {
    meta.type = val;
    return;
  }

  if (normKey === 'status' && typeof val === 'string') {
    meta.status = val;
    return;
  }

  if (normKey === 'canonical') {
    meta.canonical = Boolean(val);
    return;
  }

  if ((normKey === 'canonicalref' || normKey === 'canonical_ref') && typeof val === 'string') {
    meta.canonicalRef = val.replace(/^\[\[(.*)\]\]$/, '$1').trim();
    return;
  }

  if (normKey === 'created') {
    meta.created = String(val);
    return;
  }

  if (normKey === 'updated') {
    meta.updated = String(val);
    return;
  }

  meta.custom[key] = val;
}
