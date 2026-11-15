/**
 * Facet value→count maps computed from the loaded index (issue #244 daemon
 * surface, issue #273 MCP tool). The discovery layer behind filter building:
 * agents and the web UI ask "which tags/types/statuses exist" before
 * composing a `filter:` expression. Shared by `GET /facets` and the MCP
 * `facets` tool so both surfaces answer identically — one implementation,
 * one validation rule, one default/limit policy.
 */

export const FACET_FIELD_RE = /^[a-zA-Z_][a-zA-Z0-9_.-]*$/;

export const DEFAULT_FACET_FIELDS = ['tags', 'type', 'status', 'project'];
export const DEFAULT_FACET_LIMIT = 50;
export const MAX_FACET_LIMIT = 500;

export interface FacetValue {
  value: string;
  count: number;
}

export interface FacetsResult {
  fields: Record<string, FacetValue[]>;
  chunks: number;
}

/**
 * Validates raw field names into the canonical field list. Each entry may
 * carry comma-separated names (`"tags,type"`, exactly as `GET /facets`
 * accepts); an empty/undefined list falls back to the default fields.
 * Throws with the HTTP error message on invalid names so both surfaces
 * reject identically.
 */
export function validateFacetFields(raw: unknown): string[] {
  const out = new Set<string>();
  const list: unknown[] = Array.isArray(raw) ? raw : (raw === undefined || raw === null ? [] : [raw]);
  for (const entry of list) {
    if (typeof entry !== 'string') {
      throw new Error(`invalid field name: "${String(entry)}"`);
    }
    for (const f of entry.split(',')) {
      const name = f.trim();
      if (!name) continue;
      if (!FACET_FIELD_RE.test(name) || name.includes('..')) {
        throw new Error(`invalid field name: "${name}"`);
      }
      out.add(name);
    }
  }
  return out.size > 0 ? [...out] : [...DEFAULT_FACET_FIELDS];
}

/**
 * Counts facet values across the loaded chunks. `tags`/`aliases` count
 * per-array-element; typed frontmatter and `custom.<key>` count their raw
 * values. Values are filtered by the case-insensitive `prefix`, sorted by
 * count desc then value asc, and capped per field.
 */
export function computeFacets(
  chunks: any[],
  rawFields: unknown,
  prefix?: string,
  limit?: number,
): FacetsResult {
  const fields = validateFacetFields(rawFields);
  const prefixLc = (prefix || '').toLowerCase();
  const limitN = Number.isInteger(limit) && (limit as number) > 0 && (limit as number) <= MAX_FACET_LIMIT
    ? (limit as number)
    : DEFAULT_FACET_LIMIT;

  const counters = new Map<string, Map<string, number>>();
  for (const f of fields) counters.set(f, new Map());
  const bump = (field: string, rawValue: unknown): void => {
    if (rawValue === undefined || rawValue === null || rawValue === '') return;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    const counter = counters.get(field)!;
    for (const value of values) {
      const str = String(value);
      if (!str) continue;
      counter.set(str, (counter.get(str) || 0) + 1);
    }
  };
  for (const c of chunks) {
    const meta = c.meta || {};
    for (const f of fields) {
      if (f === 'tags' || f === 'aliases') bump(f, meta[f]);
      else if (f === 'type' || f === 'status' || f === 'project' || f === 'canonicalRef') bump(f, meta[f]);
      else if (f.startsWith('custom.') && meta.custom) bump(f, meta.custom[f.slice('custom.'.length)]);
      else if (meta.custom && meta.custom[f] !== undefined) bump(f, meta.custom[f]);
    }
  }
  const fieldsOut: Record<string, FacetValue[]> = {};
  for (const [f, counter] of counters) {
    fieldsOut[f] = [...counter.entries()]
      .filter(([value]) => !prefixLc || value.toLowerCase().startsWith(prefixLc))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limitN)
      .map(([value, count]) => ({ value, count }));
  }
  return { fields: fieldsOut, chunks: chunks.length };
}
