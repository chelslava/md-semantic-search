/**
 * Pure helpers for the MDSS Obsidian plugin (issue #136).
 * Free of Obsidian runtime dependencies so they can be unit-tested directly in node.
 */

export const DEFAULT_SETTINGS = {
  host: '127.0.0.1',
  port: 8747,
  apiKey: '',
  k: 6,
  semanticOnly: false,
  rerank: false,
  ann: false,
};

/**
 * Merges partial or loaded stored settings over default plugin settings,
 * sanitizing types and providing fallbacks.
 */
export function mergeSettings(stored, defaults = DEFAULT_SETTINGS) {
  const base = Object.assign({}, defaults);
  if (!stored || typeof stored !== 'object') return base;

  const merged = Object.assign({}, base, stored);

  if (typeof merged.host === 'string') {
    merged.host = merged.host.trim() || base.host;
  } else {
    merged.host = base.host;
  }

  if (typeof merged.port === 'string') {
    const p = parseInt(merged.port.trim(), 10);
    merged.port = !isNaN(p) && p > 0 && p <= 65535 ? p : base.port;
  } else if (typeof merged.port !== 'number' || isNaN(merged.port) || merged.port <= 0 || merged.port > 65535) {
    merged.port = base.port;
  }

  if (typeof merged.apiKey === 'string') {
    merged.apiKey = merged.apiKey.trim();
  } else {
    merged.apiKey = base.apiKey;
  }

  if (typeof merged.k !== 'number' || isNaN(merged.k) || merged.k <= 0) {
    merged.k = base.k;
  }

  merged.semanticOnly = Boolean(merged.semanticOnly);
  merged.rerank = Boolean(merged.rerank);
  merged.ann = Boolean(merged.ann);

  return merged;
}

/**
 * Builds the URL, headers, and body payload for a /search POST request.
 */
export function buildSearchRequest(settings, query) {
  const s = mergeSettings(settings, DEFAULT_SETTINGS);
  const q = String(query == null ? '' : query).trim();
  const url = `http://${s.host}:${s.port}/search`;
  const headers = { 'Content-Type': 'application/json' };
  if (s.apiKey) {
    headers['Authorization'] = `Bearer ${s.apiKey}`;
  }
  const body = {
    query: q,
    k: s.k,
    semanticOnly: s.semanticOnly,
    rerank: s.rerank,
    ann: s.ann,
  };
  return { url, headers, body };
}

/**
 * Builds the URL, headers, and body payload for a /related POST request.
 */
export function buildRelatedRequest(settings, file, options = {}) {
  const s = mergeSettings(settings, DEFAULT_SETTINGS);
  const target = String(file == null ? '' : file).trim();
  const url = `http://${s.host}:${s.port}/related`;
  const headers = { 'Content-Type': 'application/json' };
  if (s.apiKey) {
    headers['Authorization'] = `Bearer ${s.apiKey}`;
  }
  const body = {
    file: target,
    k: typeof options.k === 'number' && options.k > 0 ? options.k : s.k,
    direction: options.direction || 'both',
    semantic: options.semantic !== false,
  };
  return { url, headers, body };
}

/**
 * Formats the relationship reason string for friendly display.
 */
export function formatRelatedReason(reason) {
  if (!reason) return 'Related';
  const r = String(reason).toLowerCase();
  if (r.includes('bi-directional')) return 'Bi-directional link';
  if (r.includes('backlink')) return 'Backlink';
  if (r.includes('outgoing')) return 'Outgoing link';
  if (r.includes('2-hop')) return '2-hop co-citation';
  if (r.includes('semantic')) return 'Semantic similarity';
  return reason;
}

/**
 * Formats related note score for display.
 */
export function formatRelatedScore(hit) {
  const sc = typeof hit?.score === 'number' ? hit.score : 0;
  return `(score: ${sc.toFixed(2)})`;
}

/**
 * Formats the display heading path for a search hit.
 */
export function formatHitHeading(hit) {
  if (!hit) return '';
  const file = hit.file || '';
  const heading = hit.heading ? String(hit.heading).trim() : '';
  return heading ? `${file} › ${heading}` : file;
}

/**
 * Formats the Obsidian link target (file or file#heading).
 */
export function formatLinkTarget(hit) {
  if (!hit) return '';
  const file = hit.file || '';
  const heading = hit.heading ? String(hit.heading).trim() : '';
  return heading ? `${file}#${heading}` : file;
}

/**
 * Formats the cosine similarity score for display.
 */
export function formatScore(hit) {
  const cos = typeof hit?.cosine === 'number'
    ? hit.cosine
    : (typeof hit?.score === 'number' ? hit.score : 0);
  return `(cos: ${cos.toFixed(2)})`;
}

/**
 * Formats an actionable error message including daemon host/port.
 */
export function buildErrorMessage(err, settings) {
  const msg = err?.message || String(err || 'Unknown error');
  const s = mergeSettings(settings, DEFAULT_SETTINGS);
  return `Error connecting to mdss daemon at http://${s.host}:${s.port}: ${msg}. Is \`mdss serve\` running?`;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Splits text into segments marking which segments match the query terms.
 * Suitable for safe DOM text node / mark element construction (XSS-safe).
 */
export function splitMatches(text, matches) {
  if (!text) return [];
  const safeMatches = (Array.isArray(matches) ? matches : [])
    .filter((m) => typeof m === 'string' && m.trim().length > 0)
    .map((m) => m.trim());

  if (!safeMatches.length) {
    return [{ text, isMatch: false }];
  }

  const sortedMatches = [...new Set(safeMatches)].sort((a, b) => b.length - a.length);
  const pattern = new RegExp('(' + sortedMatches.map(escapeRegex).join('|') + ')', 'gi');

  const segments = [];
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index), isMatch: false });
    }
    segments.push({ text: match[0], isMatch: true });
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), isMatch: false });
  }

  return segments;
}

/**
 * Builds copyable CLI command suggestion based on current settings.
 */
export function buildServeCommand(settings, vaultPath) {
  const s = mergeSettings(settings, DEFAULT_SETTINGS);
  const parts = ['mdss', 'serve'];
  if (vaultPath) {
    parts.push('--db', `"${vaultPath}"`);
  }
  if (s.host && s.host !== '127.0.0.1') {
    parts.push('--host', s.host);
  }
  if (s.port && s.port !== 8747) {
    parts.push('--port', String(s.port));
  }
  if (s.apiKey) {
    parts.push('--api-key-file', '<key-file>');
  }
  return parts.join(' ');
}

/**
 * Probes daemon health endpoint and returns a structured status object.
 */
export async function testConnection(settings, fetchImpl = globalThis.fetch) {
  const s = mergeSettings(settings, DEFAULT_SETTINGS);
  const url = `http://${s.host}:${s.port}/health`;
  const headers = {};
  if (s.apiKey) {
    headers['Authorization'] = `Bearer ${s.apiKey}`;
  }

  try {
    const res = await fetchImpl(url, { method: 'GET', headers });
    if (res.status === 401) {
      return {
        ok: false,
        status: 401,
        message: 'Authentication failed (HTTP 401): invalid or missing API key',
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        message: `HTTP error ${res.status}: ${res.statusText || 'Unexpected response'}`,
      };
    }
    const data = await res.json();
    const chunks = typeof data?.chunks === 'number' ? data.chunks : 0;
    const model = data?.model || 'unknown model';
    return {
      ok: true,
      status: 200,
      message: `Connected: ${chunks} chunk(s) indexed · ${model}`,
      data,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      message: `Could not connect to mdss daemon at http://${s.host}:${s.port}: ${err?.message || err}. Ensure \`mdss serve\` is running.`,
    };
  }
}

