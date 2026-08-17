# Library API Reference

`md-semantic-search` exposes a fully typed TypeScript API for Node.js applications and tools.

```ts
import {
  buildIndex,
  search,
  loadIndex,
  searchIndex,
  trainIVF,
  searchIVFCandidates,
  buildRelationshipGraph,
} from 'md-semantic-search';
```

---

## `buildIndex(options)`

Builds or incrementally updates a semantic vector and BM25 index.

```ts
interface BuildIndexOptions {
  db: string;
  indexDir?: string;
  cacheDir?: string;
  modelName?: string | CustomModelDescriptor;
  ignore?: string[];
  offline?: boolean;
  maxRetries?: number;
  workers?: number;
  ann?: boolean;
  onProgress?: (done: number, total: number, chunksPerSec: number) => void;
}

const result = await buildIndex({
  db: './notes',
  indexDir: './.mdss',
  workers: 4,
  onProgress: (done, total, rate) => console.log(`${done}/${total} @ ${rate} chunks/sec`),
});
```

---

## `search(options)`

Convenience helper to load index, embed query, and rank results in one call.

```ts
interface SearchOptions {
  indexDir?: string;
  cacheDir?: string;
  query: string;
  k?: number;
  semanticOnly?: boolean;
  rerank?: boolean;
  ann?: boolean;
  nprobe?: number;
  path?: string;
  since?: string;
}

const hits = await search({
  indexDir: './.mdss',
  query: 'distributed consensus algorithms',
  k: 5,
  rerank: true,
});
```

---

## `loadIndex(indexDir)` & `searchIndex(options)`

For high-throughput servers (e.g. `mdss serve`), load the index into memory once and execute concurrent searches without disk re-reads.

```ts
const loaded = loadIndex('./.mdss');

const hits = await searchIndex({
  loaded,
  query: 'cache eviction policies',
  k: 10,
});
```
