/**
 * Talks to a local Ollama server to embed text and, when the user agrees, download the model.
 *
 * The server address comes only from the `HUNK_SEMANTIC_SEARCH_URL` environment variable, never
 * from Hunk config: repository config can override extension config, so a reviewed repository
 * could otherwise point the extension at a remote server and receive the code under review.
 * Non-loopback addresses are refused unless `HUNK_SEMANTIC_SEARCH_ALLOW_REMOTE=1` is set.
 *
 * Every failure becomes an `EmbedderError` whose `kind` the UI turns into a setup instruction.
 */

export const DEFAULT_SERVER_URL = "http://127.0.0.1:11434";
export const DEFAULT_MODEL = "embeddinggemma";
export const EMBED_BATCH_SIZE = 32;

export type EmbedderErrorKind = "unreachable" | "model-missing" | "remote-refused" | "invalid-config" | "server";

export class EmbedderError extends Error {
  constructor(
    readonly kind: EmbedderErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "EmbedderError";
  }
}

export interface PullProgress {
  status: string;
  completed?: number;
  total?: number;
}

/** Produces one vector per input text; the seam a different runtime can implement later. */
export interface Embedder {
  readonly model: string;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]>;
  hasModel(signal?: AbortSignal): Promise<boolean>;
  pullModel(onProgress: (progress: PullProgress) => void, signal?: AbortSignal): Promise<void>;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface OllamaEmbedderOptions {
  url: URL;
  model: string;
  fetch?: Fetch;
  batchSize?: number;
}

/** Resolve the server URL from the environment, refusing remote hosts unless explicitly allowed. */
export function resolveServerUrl(env: Record<string, string | undefined>) {
  const raw = env.HUNK_SEMANTIC_SEARCH_URL?.trim() || DEFAULT_SERVER_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EmbedderError("invalid-config", `HUNK_SEMANTIC_SEARCH_URL is not a URL: ${raw}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new EmbedderError("invalid-config", `HUNK_SEMANTIC_SEARCH_URL must use http or https: ${raw}`);
  }

  if (!isLoopback(url.hostname) && env.HUNK_SEMANTIC_SEARCH_ALLOW_REMOTE !== "1") {
    throw new EmbedderError(
      "remote-refused",
      `Refusing to send code to ${url.host}. Set HUNK_SEMANTIC_SEARCH_ALLOW_REMOTE=1 to allow a non-local server.`,
    );
  }

  return url;
}

/** Read the model name from extension config, falling back to the default. */
export function resolveModel(config: Record<string, unknown>) {
  const model = config.model;
  if (model === undefined) return DEFAULT_MODEL;
  if (typeof model !== "string" || !/^[\w.:/-]{1,128}$/.test(model)) {
    throw new EmbedderError("invalid-config", "[extension.hunk-semantic-search] model must be an Ollama model name.");
  }
  return model;
}

/** True for `localhost`, any `127.x.x.x`, and `::1`. */
export function isLoopback(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** Create an embedder backed by Ollama's `/api/embed`, `/api/show`, and `/api/pull`. */
export function createOllamaEmbedder(options: OllamaEmbedderOptions): Embedder {
  const fetchImpl: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const batchSize = options.batchSize ?? EMBED_BATCH_SIZE;
  const { model } = options;

  /** POST JSON to one endpoint, mapping connection failures to `unreachable`. */
  async function post(path: string, body: unknown, signal?: AbortSignal) {
    try {
      return await fetchImpl(new URL(path, options.url).toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new EmbedderError(
        "unreachable",
        `Ollama is not reachable at ${options.url.host}. Start it with \`ollama serve\` (or open the Ollama app).`,
      );
    }
  }

  /** Turn a non-OK response into the matching error. */
  async function fail(response: Response): Promise<never> {
    const detail = await readError(response);
    if (response.status === 404 && /not found/i.test(detail)) {
      throw new EmbedderError("model-missing", `The ${model} model is not installed. Run \`ollama pull ${model}\`.`);
    }
    throw new EmbedderError("server", `Ollama returned ${response.status}${detail ? `: ${detail}` : ""}`);
  }

  return {
    model,

    async embed(texts, signal) {
      const vectors: Float32Array[] = [];
      for (let start = 0; start < texts.length; start += batchSize) {
        const batch = texts.slice(start, start + batchSize);
        const response = await post("/api/embed", { model, input: batch }, signal);
        if (!response.ok) await fail(response);

        const body = (await response.json()) as { embeddings?: unknown };
        if (!Array.isArray(body.embeddings) || body.embeddings.length !== batch.length) {
          throw new EmbedderError("server", "Ollama returned a malformed embedding response.");
        }
        for (const vector of body.embeddings) vectors.push(Float32Array.from(vector as number[]));
      }
      return vectors;
    },

    async hasModel(signal) {
      const response = await post("/api/show", { model }, signal);
      if (response.ok) return true;
      if (response.status === 404) return false;
      return fail(response);
    },

    async pullModel(onProgress, signal) {
      const response = await post("/api/pull", { model, stream: true }, signal);
      if (!response.ok || !response.body) await fail(response);

      // The pull streams one JSON object per line; errors arrive in-stream with a 200 status.
      const decoder = new TextDecoder();
      let buffered = "";
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffered += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (line) handlePullLine(line, onProgress);
        }
      }
      if (buffered.trim()) handlePullLine(buffered.trim(), onProgress);
    },
  };
}

/** Apply one NDJSON pull line: report progress or throw the in-stream error. */
function handlePullLine(line: string, onProgress: (progress: PullProgress) => void) {
  let event: { status?: string; completed?: number; total?: number; error?: string };
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (event.error) throw new EmbedderError("server", `Download failed: ${event.error}`);
  if (event.status) onProgress({ status: event.status, completed: event.completed, total: event.total });
}

/** Read Ollama's `{ error }` body, falling back to raw text. */
async function readError(response: Response) {
  const text = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
  } catch {}
  return text.trim().slice(0, 200);
}
