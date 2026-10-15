/**
 * Keeps the review's hunk embeddings ready so a question only has to embed itself.
 *
 * Opening a review and every reload start a new indexing run over the changeset; starting one
 * aborts the previous run, so a stale changeset never keeps the model busy. Vectors are cached
 * by a hash of the exact document text, so a reload, a refilter, or a rebased review embeds only
 * hunks whose text actually changed. The cache is a bounded LRU owned by one index, and an index
 * has one embedder, so vectors from different models never mix.
 *
 * A search waits for the latest run, embeds any of the asked-about hunks still missing (a run
 * that failed or was cancelled), then ranks them. Failures surface to the caller of `search`;
 * a background run only reports them through `onProgress`.
 */

import { createHash } from "node:crypto";
import { collectHunks, queryDocument, type ReviewFile, type SearchableHunk } from "./documents";
import { EMBED_BATCH_SIZE, type Embedder } from "./embedder";
import { topK } from "./rank";

export const DEFAULT_CACHE_SIZE = 5000;

export type IndexProgress =
  | { state: "indexing"; done: number; total: number }
  | { state: "ready"; total: number }
  | { state: "failed"; error: unknown };

export interface SearchResult {
  hunk: SearchableHunk;
  score: number;
}

export interface SearchIndexOptions {
  embedder: Embedder;
  cacheSize?: number;
  batchSize?: number;
  onProgress?: (progress: IndexProgress) => void;
  onSkip?: (path: string, reason: string) => void;
}

export interface SearchIndex {
  /** Start indexing a changeset in the background, cancelling any earlier run. */
  index(files: readonly ReviewFile[]): Promise<void>;
  /** Rank the hunks of `files` against a question, best first. */
  search(query: string, files: readonly ReviewFile[], k: number, signal?: AbortSignal): Promise<SearchResult[]>;
  /** Cancel any running work. */
  dispose(): void;
  /** Number of cached vectors, for tests and diagnostics. */
  readonly cacheSize: number;
}

/** Create a search index over one embedder. */
export function createSearchIndex(options: SearchIndexOptions): SearchIndex {
  const { embedder } = options;
  const cache = new LruCache<string, Float32Array>(options.cacheSize ?? DEFAULT_CACHE_SIZE);
  const batchSize = options.batchSize ?? EMBED_BATCH_SIZE;
  let generation = 0;
  let controller: AbortController | null = null;
  let latestRun: Promise<void> = Promise.resolve();

  /** The cache key for one document. */
  const keyOf = (document: string) => createHash("sha256").update(document).digest("hex");

  /**
   * Embed every uncached document among `hunks`, one batch at a time, reporting progress.
   *
   * Returns each document's vector by key, so a caller can rank more hunks than the cache holds.
   */
  async function fill(hunks: readonly SearchableHunk[], signal: AbortSignal, onBatch?: (done: number, total: number) => void) {
    const vectors = new Map<string, Float32Array>();
    const missing = new Map<string, string>();
    for (const hunk of hunks) {
      const key = keyOf(hunk.document);
      const cached = cache.get(key);
      if (cached) vectors.set(key, cached);
      else missing.set(key, hunk.document);
    }

    const entries = [...missing];
    onBatch?.(0, entries.length);
    for (let start = 0; start < entries.length; start += batchSize) {
      signal.throwIfAborted();
      const batch = entries.slice(start, start + batchSize);
      const embedded = await embedder.embed(
        batch.map(([, document]) => document),
        signal,
      );
      batch.forEach(([key], i) => {
        cache.set(key, embedded[i]!);
        vectors.set(key, embedded[i]!);
      });
      onBatch?.(Math.min(start + batchSize, entries.length), entries.length);
    }
    return vectors;
  }

  /** Wait until no newer run has started behind the one awaited. */
  async function settled() {
    let awaited: Promise<void>;
    do {
      awaited = latestRun;
      await awaited;
    } while (awaited !== latestRun);
  }

  return {
    index(files) {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      const runGeneration = ++generation;
      const hunks = collectHunks(files, options.onSkip);

      const run = fill(hunks, current.signal, (done, total) => {
        if (runGeneration === generation) options.onProgress?.({ state: "indexing", done, total });
      }).then(
        () => {
          if (runGeneration === generation) options.onProgress?.({ state: "ready", total: hunks.length });
        },
        (error: unknown) => {
          // A cancelled run was replaced on purpose; only the latest run's failure is news.
          if (runGeneration === generation && !current.signal.aborted) options.onProgress?.({ state: "failed", error });
        },
      );
      latestRun = run;
      return run;
    },

    async search(query, files, k, signal = new AbortController().signal) {
      await settled();
      const hunks = collectHunks(files, options.onSkip);
      const vectors = await fill(hunks, signal);

      const [queryVector] = await embedder.embed([queryDocument(query)], signal);
      const ranked = topK(queryVector!, hunks, (hunk) => vectors.get(keyOf(hunk.document))!, k);
      return ranked.map(({ item, score }) => ({ hunk: item, score }));
    },

    dispose() {
      generation += 1;
      controller?.abort();
      controller = null;
    },

    get cacheSize() {
      return cache.size;
    },
  };
}

/** A Map-backed least-recently-used cache. */
export class LruCache<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(private readonly limit: number) {}

  get size() {
    return this.entries.size;
  }

  has(key: K) {
    return this.entries.has(key);
  }

  get(key: K) {
    const value = this.entries.get(key);
    if (value !== undefined) {
      // Re-inserting moves the key to the most recently used end.
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: K, value: V) {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.limit) {
      this.entries.delete(this.entries.keys().next().value as K);
    }
  }
}
