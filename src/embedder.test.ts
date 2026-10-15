import { describe, expect, test } from "bun:test";
import { createOllamaEmbedder, EmbedderError, isLoopback, resolveModel, resolveServerUrl, type PullProgress } from "./embedder";

const LOCAL = new URL("http://127.0.0.1:11434");

/** A fake fetch that records requests and answers from a handler. */
function createTestFetch(handler: (path: string, body: any) => Response | Promise<Response>) {
  const requests: { path: string; body: any }[] = [];
  const fetch = async (input: string, init: RequestInit) => {
    const path = new URL(input).pathname;
    const body = JSON.parse(String(init.body));
    requests.push({ path, body });
    return handler(path, body);
  };
  return { fetch, requests };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("resolveServerUrl", () => {
  test("defaults to the local Ollama port", () => {
    expect(resolveServerUrl({}).toString()).toBe("http://127.0.0.1:11434/");
  });

  test("accepts loopback overrides", () => {
    expect(resolveServerUrl({ HUNK_SEMANTIC_SEARCH_URL: "http://localhost:9999" }).host).toBe("localhost:9999");
    expect(resolveServerUrl({ HUNK_SEMANTIC_SEARCH_URL: "http://[::1]:11434" }).hostname).toBe("[::1]");
  });

  test("refuses a remote host unless explicitly allowed", () => {
    const remote = { HUNK_SEMANTIC_SEARCH_URL: "https://embed.example.com" };

    expect(() => resolveServerUrl(remote)).toThrow(expect.objectContaining({ kind: "remote-refused" }));
    expect(resolveServerUrl({ ...remote, HUNK_SEMANTIC_SEARCH_ALLOW_REMOTE: "1" }).host).toBe("embed.example.com");
  });

  test("rejects malformed and non-http URLs", () => {
    expect(() => resolveServerUrl({ HUNK_SEMANTIC_SEARCH_URL: "not a url" })).toThrow(EmbedderError);
    expect(() => resolveServerUrl({ HUNK_SEMANTIC_SEARCH_URL: "file:///tmp/x" })).toThrow(
      expect.objectContaining({ kind: "invalid-config" }),
    );
  });
});

describe("isLoopback", () => {
  test("matches only loopback hosts", () => {
    expect(["localhost", "127.0.0.1", "127.8.9.10", "::1", "[::1]"].every(isLoopback)).toBe(true);
    expect(["127.0.0.1.evil.com", "128.0.0.1", "0.0.0.0", "example.com", "10.0.0.1"].some(isLoopback)).toBe(false);
  });
});

describe("resolveModel", () => {
  test("defaults to embeddinggemma and validates names", () => {
    expect(resolveModel({})).toBe("embeddinggemma");
    expect(resolveModel({ model: "embeddinggemma:300m" })).toBe("embeddinggemma:300m");
    expect(() => resolveModel({ model: "bad name; rm -rf" })).toThrow(EmbedderError);
    expect(() => resolveModel({ model: 42 })).toThrow(EmbedderError);
  });
});

describe("createOllamaEmbedder", () => {
  test("embeds in batches and keeps input order", async () => {
    const { fetch, requests } = createTestFetch((_, body) =>
      json({ embeddings: body.input.map((text: string) => [text.length, 1]) }),
    );
    const embedder = createOllamaEmbedder({ url: LOCAL, model: "m", fetch, batchSize: 2 });

    const vectors = await embedder.embed(["a", "bb", "ccc"]);

    expect(requests.map((r) => [r.path, r.body.model, r.body.input])).toEqual([
      ["/api/embed", "m", ["a", "bb"]],
      ["/api/embed", "m", ["ccc"]],
    ]);
    expect(vectors.map((v) => [...v])).toEqual([[1, 1], [2, 1], [3, 1]]);
  });

  test("maps a refused connection to setup instructions", async () => {
    const embedder = createOllamaEmbedder({
      url: LOCAL,
      model: "m",
      fetch: async () => {
        throw new TypeError("Unable to connect");
      },
    });

    const error = await embedder.embed(["x"]).catch((e) => e);
    expect(error).toMatchObject({ kind: "unreachable" });
    expect(error.message).toContain("ollama serve");
  });

  test("maps a missing model to the pull command", async () => {
    const { fetch } = createTestFetch(() => json({ error: 'model "m" not found, try pulling it first' }, 404));
    const embedder = createOllamaEmbedder({ url: LOCAL, model: "m", fetch });

    const error = await embedder.embed(["x"]).catch((e) => e);
    expect(error).toMatchObject({ kind: "model-missing" });
    expect(error.message).toContain("ollama pull m");
    expect(await embedder.hasModel()).toBe(false);
  });

  test("reports other server errors with their status", async () => {
    const { fetch } = createTestFetch(() => json({ error: "out of memory" }, 500));
    const embedder = createOllamaEmbedder({ url: LOCAL, model: "m", fetch });

    await expect(embedder.embed(["x"])).rejects.toMatchObject({ kind: "server", message: "Ollama returned 500: out of memory" });
  });

  test("rejects a response with the wrong number of embeddings", async () => {
    const { fetch } = createTestFetch(() => json({ embeddings: [] }));
    const embedder = createOllamaEmbedder({ url: LOCAL, model: "m", fetch });

    await expect(embedder.embed(["x"])).rejects.toMatchObject({ kind: "server" });
  });

  test("passes an abort through instead of calling it unreachable", async () => {
    const controller = new AbortController();
    controller.abort();
    const embedder = createOllamaEmbedder({
      url: LOCAL,
      model: "m",
      fetch: async (_, init) => {
        init.signal?.throwIfAborted();
        return json({});
      },
    });

    const error = await embedder.embed(["x"], controller.signal).catch((e) => e);
    expect(error).not.toBeInstanceOf(EmbedderError);
    expect(error.name).toBe("AbortError");
  });

  test("streams pull progress across chunk boundaries and throws in-stream errors", async () => {
    const lines = ['{"status":"pulling manifest"}\n{"status":"pulling', ' abc","completed":5,"total":10}\n{"status":"success"}'];
    const { fetch } = createTestFetch(() => new Response(new Blob(lines).stream()));
    const embedder = createOllamaEmbedder({ url: LOCAL, model: "m", fetch });
    const progress: PullProgress[] = [];

    await embedder.pullModel((p) => progress.push(p));

    expect(progress).toEqual([
      { status: "pulling manifest", completed: undefined, total: undefined },
      { status: "pulling abc", completed: 5, total: 10 },
      { status: "success", completed: undefined, total: undefined },
    ]);

    const failing = createOllamaEmbedder({
      url: LOCAL,
      model: "m",
      fetch: createTestFetch(() => new Response('{"status":"pulling manifest"}\n{"error":"file does not exist"}\n')).fetch,
    });
    await expect(failing.pullModel(() => {})).rejects.toMatchObject({ message: "Download failed: file does not exist" });
  });
});
