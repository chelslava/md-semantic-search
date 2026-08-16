// @ts-check
/**
 * Typed YAML Frontmatter parser and metadata normalizer (issue #58).
 * Parses YAML frontmatter into a validated document metadata object without
 * unsafe executable tags. Supports scalars, inline/block lists, quotes, booleans,
 * dates, tags normalization, and canonical document identity.
 */

/**
 * @typedef {{
 *   title?: string,
 *   aliases: string[],
 *   tags: string[],
 *   project?: string,
 *   type?: string,
 *   status?: string,
 *   canonical?: boolean,
 *   canonicalRef?: string,
 *   created?: string,
 *   updated?: string,
 *   custom: Record<string, string | number | boolean | string[]>,
 * }} DocumentMetadata
 */

/**
 * Parse raw YAML frontmatter text into a typed DocumentMetadata object.
 * @param {string} rawYaml
 * @returns {DocumentMetadata}
 */
export function parseFrontmatter(rawYaml) {
  const metadata = {
    aliases: /** @type {string[]} */ ([]),
    tags: /** @type {string[]} */ ([]),
    custom: /** @type {Record<string, string | number | boolean | string[]>} */ ({}),
  };

  if (!rawYaml || typeof rawYaml !== 'string') {
    return metadata;
  }

  const lines = rawYaml.split(/\r?\n/);
  let currentKey = null;
  let currentBlockList = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // Block list item: "  - item"
    const blockListMatch = line.match(/^(\s+)-\s+(.+)$/);
    if (blockListMatch && currentKey && currentBlockList) {
      const val = parseYAMLValue(blockListMatch[2]);
      if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
        currentBlockList.push(String(val));
      }
      continue;
    }

    // Key-value pair: "key: value" or "key:"
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
        // Start of potential block list
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

/**
 * Parse a raw YAML value string (supports quotes, inline arrays, booleans, numbers).
 * @param {string} raw
 * @returns {string | number | boolean | string[]}
 */
function parseYAMLValue(raw) {
  const trimmed = raw.trim();

  // Inline array: [item1, item2]
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(',')
      .map((item) => parseYAMLValue(item))
      .map((item) => (Array.isArray(item) ? item.join(' ') : String(item).trim()))
      .filter((item) => item.length > 0);
  }

  // Quoted string
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }

  // Boolean
  if (/^true$/i.test(trimmed)) return true;
  if (/^false$/i.test(trimmed)) return false;

  // Number
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (!Number.isNaN(num)) return num;
  }

  return trimmed;
}

/**
 * Set a parsed key-value pair on the DocumentMetadata object.
 * @param {DocumentMetadata} meta
 * @param {string} key
 * @param {string | number | boolean | string[]} val
 */
function setMetadataValue(meta, key, val) {
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
    let items = [];
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

  // Store custom property
  meta.custom[key] = val;
}
