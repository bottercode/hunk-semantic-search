import { describe, expect, test } from "bun:test";
import { createTestEmbedder, createTestReviewFile } from "../test/helpers";
import { createSearchIndex, LruCache, type IndexProgress } from "./store";

const API = createTestReviewFile("f1", "src/api.ts", [["retry the request"], ["parse the payload"]]);
const AUTH = createTestReviewFile("f2", "src/auth.ts", [["check the token"]]);

describe("createSearchIndex", () => {
  test("ranks hunks by similarity and reports where to jump", async () => {
    const embedder = createTestEmbedder(["retry", "parse", "token"]);
    const index = createSearchIndex({ embedder });

    const results = await index.search("retry", [API, AUTH], 2);

    expect(results.map((result) => [result.hunk.path, result.hunk.hunkIndex])).toEqual([
      ["src/api.ts", 0],
      ["src/api.ts", 1],
    ]);
    expect(results[0]!.hunk.jump).toEqual({ side: "new", lineNumber: 1 });
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  test("embeds in batches and reports progress, then ready", async () => {
    const embedder = createTestEmbedder(["retry"]);
    const progress: IndexProgress[] = [];
    const index = createSearchIndex({ embedder, batchSize: 2, onProgress: (p) => progress.push(p) });

    await index.index([API, AUTH]);

    expect(embedder.calls.map((call) => call.length)).toEqual([2, 1]);
    expect(progress).toEqual([
      { state: "indexing", done: 0, total: 3 },
      { state: "indexing", done: 2, total: 3 },
      { state: "indexing", done: 3, total: 3 },
      { state: "ready", total: 3 },
    ]);
  });

  test("reuses cached vectors across reloads and only embeds changed hunks", async () => {
    const embedder = createTestEmbedder(["retry"]);
    const index = createSearchIndex({ embedder });
    await index.index([API, AUTH]);

    const changedAuth = createTestReviewFile("f2", "src/auth.ts", [["check the token twice"]]);
    await index.index([API, changedAuth]);

    expect(embedder.calls.at(-1)).toEqual([expect.stringContaining("check the token twice")]);
    // The search embeds only the question: every hunk is already cached.
    await index.search("retry", [API, changedAuth], 3);
    expect(embedder.calls.at(-1)).toEqual(["task: code retrieval | query: retry"]);
  });

  test("cancels a running index when a new changeset loads, and only the latest reports", async () => {
    const embedder = createTestEmbedder(["retry"]);
    const progress: IndexProgress[] = [];
    const index = createSearchIndex({ embedder, onProgress: (p) => progress.push(p) });

    const release = embedder.hold();
    const stale = index.index([API]);
    const fresh = index.index([AUTH]);
    release();
    await Promise.all([stale, fresh]);

    expect(progress.filter((p) => p.state !== "indexing")).toEqual([{ state: "ready", total: 1 }]);
    expect(progress.some((p) => p.state === "failed")).toBe(false);
    // The cancelled run's vectors were never stored.
    expect(index.cacheSize).toBe(1);
  });

  test("a search waits for indexing, then only ranks the files it was given", async () => {
    const embedder = createTestEmbedder(["retry", "token"]);
    const index = createSearchIndex({ embedder });
    const release = embedder.hold();
    void index.index([API, AUTH]);

    const pending = index.search("token", [AUTH], 5);
    release();
    const results = await pending;

    expect(results.map((result) => result.hunk.path)).toEqual(["src/auth.ts"]);
  });

  test("reports a background failure and lets the search surface it", async () => {
    const embedder = createTestEmbedder(["retry"]);
    const progress: IndexProgress[] = [];
    const index = createSearchIndex({ embedder, onProgress: (p) => progress.push(p) });
    const failure = new Error("Ollama is not reachable");
    embedder.fail(failure);

    await index.index([API]);

    expect(progress.at(-1)).toEqual({ state: "failed", error: failure });
    await expect(index.search("retry", [API], 3)).rejects.toBe(failure);
  });

  test("dispose aborts running work without reporting a failure", async () => {
    const embedder = createTestEmbedder(["retry"]);
    const progress: IndexProgress[] = [];
    const index = createSearchIndex({ embedder, onProgress: (p) => progress.push(p) });
    const release = embedder.hold();

    const run = index.index([API]);
    index.dispose();
    release();
    await run;

    expect(progress.filter((p) => p.state !== "indexing")).toEqual([]);
    expect(index.cacheSize).toBe(0);
  });

  test("ranks more hunks than the cache can hold", async () => {
    const embedder = createTestEmbedder(["retry", "parse", "token"]);
    const index = createSearchIndex({ embedder, cacheSize: 1 });

    const results = await index.search("token", [API, AUTH], 1);

    expect(results.map((result) => result.hunk.path)).toEqual(["src/auth.ts"]);
  });
});

describe("LruCache", () => {
  test("evicts the least recently used entry", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);

    expect([cache.has("a"), cache.has("b"), cache.has("c")]).toEqual([true, false, true]);
  });
});
