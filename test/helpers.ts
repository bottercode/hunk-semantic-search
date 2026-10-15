import type { Embedder } from "../src/embedder";

/**
 * Build a fake embedder that turns each text into a vector of keyword hits, so tests can
 * reason about ranking. Records every call so batching and caching are observable.
 */
export function createTestEmbedder(keywords: readonly string[], options: { model?: string; installed?: boolean } = {}) {
  const calls: string[][] = [];
  const pulls: string[] = [];
  let installed = options.installed ?? true;
  let failWith: unknown = null;
  let gate: Promise<void> | null = null;

  const embedder: Embedder & { calls: string[][]; pulls: string[]; fail(error: unknown): void; hold(): () => void } = {
    model: options.model ?? "test-model",
    calls,
    pulls,
    async embed(texts, signal) {
      calls.push([...texts]);
      if (gate) await gate;
      signal?.throwIfAborted();
      if (failWith) throw failWith;
      return texts.map((text) => Float32Array.from(keywords.map((word) => (text.toLowerCase().includes(word) ? 1 : 0.01))));
    },
    async hasModel() {
      if (failWith) throw failWith;
      return installed;
    },
    async pullModel(onProgress) {
      pulls.push(embedder.model);
      onProgress({ status: "pulling", completed: 50, total: 100 });
      onProgress({ status: "success" });
      installed = true;
    },
    fail(error) {
      failWith = error;
    },
    /** Hold every embed call until the returned release function runs. */
    hold() {
      let release!: () => void;
      gate = new Promise((resolve) => (release = resolve));
      return () => {
        gate = null;
        release();
      };
    },
  };
  return embedder;
}

/** Build a one-file review fixture whose hunks each add the given lines. */
export function createTestReviewFile(id: string, path: string, hunkBodies: readonly string[][]) {
  const patch = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    ...hunkBodies.flatMap((lines, i) => [`@@ -${i * 10 + 1},0 +${i * 10 + 1},${lines.length} @@`, ...lines.map((line) => `+${line}`)]),
    "",
  ].join("\n");
  return { id, path, patch, hunks: hunkBodies.map((_, index) => ({ index })) };
}

/** A recorded call on one of the fake host controls. */
export type TestHostCall = [string, ...unknown[]];

/**
 * Build a fake Hunk host: it records registrations, and builds command and event contexts whose
 * prompts and dialogs answer from queues and whose controls log every call.
 */
export function createTestHost(config: Record<string, unknown> = {}) {
  const commands = new Map<string, { command: any; handler: (ctx: any) => unknown }>();
  const events = new Map<string, ((payload: any, ctx: any) => unknown)[]>();
  const highlighters = new Map<string, any>();
  const calls: TestHostCall[] = [];
  const logs: string[] = [];
  const status = new Map<string, string>();
  const answers = { prompts: [] as (string | null)[], selects: [] as (number | null)[], confirms: [] as boolean[] };
  const dialogs: { title: string; options?: readonly string[]; statusWhileOpen?: string }[] = [];

  const statusLine = {
    set: (item: { id: string; spans: { text: string }[] }) => status.set(item.id, item.spans.map((s) => s.text).join("")),
    clear: (id: string) => status.delete(id),
  };

  const api = {
    apiVersion: 28,
    config,
    log: (message: string) => logs.push(message),
    registerCommand: (command: any, handler: any) => commands.set(command.id, { command, handler }),
    registerLineHighlighter: (highlighter: any) => highlighters.set(highlighter.id, highlighter),
    on: (event: string, handler: any) => events.set(event, [...(events.get(event) ?? []), handler]),
  };

  function commandContext(files: readonly unknown[]) {
    return {
      cwd: "/repo",
      notify: (message: string, type?: string) => calls.push(["notify", message, type ?? "info"]),
      selection: { file: null, hunkIndex: null, currentLine: null, files },
      navigation: {
        revealLine: (...args: unknown[]) => calls.push(["revealLine", ...args]),
        selectHunk: (...args: unknown[]) => calls.push(["selectHunk", ...args]),
      },
      highlights: { refresh: (id: string) => calls.push(["refresh", id]) },
      statusLine,
      prompts: {
        line: async (options: { initial?: string }) => {
          calls.push(["prompt", options.initial ?? ""]);
          return answers.prompts.shift() ?? null;
        },
      },
      dialogs: {
        select: async (options: { title: string; options: readonly string[] }) => {
          dialogs.push({ ...options, statusWhileOpen: status.get("status") });
          const pick = answers.selects.shift();
          return pick === null || pick === undefined ? null : options.options[pick]!;
        },
        confirm: async (options: { title: string }) => {
          dialogs.push(options);
          return answers.confirms.shift() ?? false;
        },
      },
    };
  }

  return {
    api: api as any,
    calls,
    logs,
    status,
    answers,
    dialogs,
    commands,
    /** Deliver `changeset_loaded` and return once every handler ran. */
    async loadChangeset(files: readonly unknown[]) {
      for (const handler of events.get("changeset_loaded") ?? []) {
        await handler({ changeset: { files } }, { cwd: "/repo", notify: () => {}, statusLine });
      }
    },
    async emit(event: string) {
      for (const handler of events.get(event) ?? []) await handler({}, {});
    },
    /** Run one command with a context over the given visible files. */
    async run(id: string, files: readonly unknown[]) {
      await commands.get(id)!.handler(commandContext(files));
    },
    highlight(file: { id: string }) {
      return highlighters.get("marks").highlight({ file });
    },
  };
}
