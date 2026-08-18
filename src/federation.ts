/**
 * Multi-Vault & Multi-Repository Search Federation (issue #97).
 *
 * Coordinates querying across multiple independent vaults / repositories,
 * executing per-vault index loads in parallel and merging candidates with
 * calibrated reciprocal rank fusion (RRF) and vault attribution.
 */
import path from 'node:path';
import fs from 'node:fs';
import { loadIndex, searchIndex, LoadedIndex, SearchOptions, SearchResultHit } from './search.js';

export interface VaultConfig {
  name?: string;
  path: string;
  indexDir?: string;
}

export interface FederatedSearchOptions extends Omit<SearchOptions, 'loaded' | 'cacheDir'> {
  vaults: Array<string | VaultConfig>;
  cacheDir?: string;
}

export interface FederatedSearchResultHit extends SearchResultHit {
  vault: string;
  vaultPath: string;
}

export async function searchFederated(opts: FederatedSearchOptions): Promise<FederatedSearchResultHit[]> {
  const { vaults, k = 10, cacheDir = '', ...searchOpts } = opts;
  if (!vaults || vaults.length === 0) {
    throw new Error('Federated search requires at least one vault specified');
  }

  const normalizedVaults: VaultConfig[] = vaults.map((v) => {
    if (typeof v === 'string') {
      const absPath = path.resolve(v);
      const name = path.basename(absPath);
      return { name, path: absPath };
    }
    const absPath = path.resolve(v.path);
    const name = v.name || path.basename(absPath);
    return { name, path: absPath, indexDir: v.indexDir };
  });

  // Load and query each vault concurrently
  const perVaultResults = await Promise.all(
    normalizedVaults.map(async (vault) => {
      const indexDir = vault.indexDir || path.join(vault.path, '.mdss');
      if (!fs.existsSync(indexDir)) {
        return { vault, hits: [] as SearchResultHit[], error: `No index at ${indexDir}` };
      }

      let loaded: LoadedIndex;
      try {
        loaded = loadIndex(indexDir);
      } catch (err: any) {
        return { vault, hits: [] as SearchResultHit[], error: err.message };
      }

      try {
        // Query vault index with a slightly larger pool to ensure healthy global fusion
        const poolK = Math.max(k * 2, 20);
        const resolvedCache = cacheDir || path.join(vault.path, '.cache');
        const hits = await searchIndex({
          ...searchOpts,
          cacheDir: resolvedCache,
          loaded,
          k: poolK,
        });
        return { vault, hits, error: null };
      } catch (err: any) {
        return { vault, hits: [] as SearchResultHit[], error: err.message };
      }
    })
  );

  // If single vault, return directly with attribution
  if (normalizedVaults.length === 1) {
    const { vault, hits } = perVaultResults[0];
    return hits.slice(0, k).map((h) => ({
      ...h,
      vault: vault.name || path.basename(vault.path),
      vaultPath: vault.path,
    }));
  }

  // Multi-vault reciprocal rank fusion (RRF)
  // Collect all hits across vaults
  const hitKeys = new Map<string, { hit: SearchResultHit; vault: VaultConfig; rrfSum: number }>();

  for (const { vault, hits } of perVaultResults) {
    hits.forEach((hit, rank) => {
      const key = `${vault.path}::${hit.file}::${hit.heading || ''}`;
      const rrfScore = 1.0 / (60 + rank + 1);
      const existing = hitKeys.get(key);
      if (!existing) {
        hitKeys.set(key, { hit, vault, rrfSum: rrfScore });
      } else {
        existing.rrfSum += rrfScore;
      }
    });
  }

  // Sort fused hits by combined rrfSum (or fallback to score)
  const fused = Array.from(hitKeys.values())
    .sort((a, b) => {
      if (b.rrfSum !== a.rrfSum) return b.rrfSum - a.rrfSum;
      return b.hit.score - a.hit.score;
    })
    .slice(0, k);

  return fused.map(({ hit, vault, rrfSum }) => ({
    ...hit,
    score: rrfSum,
    vault: vault.name || path.basename(vault.path),
    vaultPath: vault.path,
  }));
}
