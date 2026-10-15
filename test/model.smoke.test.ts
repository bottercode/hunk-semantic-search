/**
 * Checks ranking with the real model through a running Ollama. Opt in with
 * `HUNK_SEMANTIC_SMOKE=1 bun test`; it needs `ollama serve` and `ollama pull embeddinggemma`.
 */
import { expect, test } from "bun:test";
import { createOllamaEmbedder, resolveModel, resolveServerUrl } from "../src/embedder";
import { createSearchIndex } from "../src/store";
import { createTestRetryRepo, testGit } from "./fixture";

const smoke = process.env.HUNK_SEMANTIC_SMOKE === "1" ? test : test.skip;

smoke("embeddinggemma ranks the retry loop first for a question that never says retry", async () => {
  const repo = createTestRetryRepo();
  try {
    const files = testGit(repo.root, ["show", "--format=", "--no-color", "HEAD"])
      .split(/^(?=diff --git )/m)
      .map((patch, i) => ({ id: `f${i}`, path: /^\+\+\+ b\/(.+)$/m.exec(patch)![1]!, patch }));
    const embedder = createOllamaEmbedder({ url: resolveServerUrl(process.env), model: resolveModel({}) });
    const index = createSearchIndex({ embedder });

    const results = await index.search("what happens now when the network request fails", files, 3);

    expect(results.map((result) => result.hunk.path)).toEqual(["src/api.ts", expect.any(String), expect.any(String)]);
  } finally {
    repo.cleanup();
  }
}, 60_000);
