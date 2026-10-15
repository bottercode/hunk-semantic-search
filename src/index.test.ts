import { describe, expect, test } from "bun:test";
import { createTestEmbedder, createTestHost, createTestReviewFile } from "../test/helpers";
import { EmbedderError } from "./embedder";
import { createSemanticSearch, NEXT_COMMAND_ID, PREVIOUS_COMMAND_ID, resultLabel, SEARCH_COMMAND_ID, STATUS_ITEM_ID } from "./index";
import type { SearchResult } from "./store";

const API = createTestReviewFile("f1", "src/api.ts", [["parse the payload"], ["retry the request three times"]]);
const AUTH = createTestReviewFile("f2", "src/auth.ts", [["retry the token check"]]);
const FILES = [API, AUTH];

/** Load the extension over a fake embedder and fake timers. */
function setup(options: { installed?: boolean; createEmbedder?: () => never } = {}) {
  const embedder = createTestEmbedder(["retry", "request", "token", "payload"], { installed: options.installed });
  const timers: (() => void)[] = [];
  const host = createTestHost();
  createSemanticSearch({
    createEmbedder: options.createEmbedder ?? (() => embedder),
    setTimeout: (callback) => timers.push(callback),
    clearTimeout: () => {},
  })(host.api);
  return { host, embedder, timers };
}

/** Let background indexing promises settle. */
async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("semantic search command", () => {
  test("lists ranked hunks, jumps to the chosen one, marks it, and reports it", async () => {
    const { host } = setup();
    await host.loadChangeset(FILES);
    host.answers.prompts.push("retry request");
    host.answers.selects.push(0);

    await host.run(SEARCH_COMMAND_ID, FILES);

    expect(host.dialogs[0]!.title).toBe('Hunks about "retry request"');
    expect(host.dialogs[0]!.statusWhileOpen).toBe('≈ "retry request" · 3 results · choose one');
    expect(host.dialogs[0]!.options).toEqual([
      expect.stringMatching(/^1\. src\/api\.ts:11 · retry the request three times · \d\.\d\d$/),
      expect.stringMatching(/^2\. src\/auth\.ts:1 · retry the token check · /),
      expect.stringMatching(/^3\. src\/api\.ts:1 · parse the payload · /),
    ]);
    expect(host.calls).toContainEqual(["revealLine", "f1", "new", 11]);
    expect(host.calls).toContainEqual(["refresh", "marks"]);
    expect(host.highlight({ id: "f1" })).toEqual([{ side: "new", line: 11, range: [0, 29], tone: "current" }]);
    expect(host.highlight({ id: "f2" })).toBeNull();
    expect(host.status.get(STATUS_ITEM_ID)).toBe('≈ "retry request" · 1/3 · src/api.ts');
  });

  test("ranks only the visible files, so the file filter applies", async () => {
    const { host } = setup();
    await host.loadChangeset(FILES);
    host.answers.prompts.push("retry");

    await host.run(SEARCH_COMMAND_ID, [AUTH]);

    expect(host.dialogs[0]!.options).toEqual([expect.stringMatching(/^1\. src\/auth\.ts:1 /)]);
  });

  test("next and previous step through results and wrap, and ship unbound", async () => {
    const { host } = setup();
    await host.loadChangeset(FILES);
    host.answers.prompts.push("retry request");
    host.answers.selects.push(0);
    await host.run(SEARCH_COMMAND_ID, FILES);

    await host.run(NEXT_COMMAND_ID, FILES);
    expect(host.status.get(STATUS_ITEM_ID)).toBe('≈ "retry request" · 2/3 · src/auth.ts');
    await host.run(PREVIOUS_COMMAND_ID, FILES);
    await host.run(PREVIOUS_COMMAND_ID, FILES);
    expect(host.status.get(STATUS_ITEM_ID)).toBe('≈ "retry request" · 3/3 · src/api.ts');
    expect(host.calls.filter((call) => call[0] === "revealLine").at(-1)).toEqual(["revealLine", "f1", "new", 1]);

    expect(host.commands.get(SEARCH_COMMAND_ID)!.command.key).toBe("S");
    expect(host.commands.get(NEXT_COMMAND_ID)!.command.key).toBeUndefined();
    expect(host.commands.get(PREVIOUS_COMMAND_ID)!.command.key).toBeUndefined();
  });

  test("a cancelled list keeps the results so next starts at the best one", async () => {
    const { host } = setup();
    await host.loadChangeset(FILES);
    host.answers.prompts.push("retry request");
    host.answers.selects.push(null);
    await host.run(SEARCH_COMMAND_ID, FILES);

    expect(host.calls.some((call) => call[0] === "revealLine")).toBe(false);
    expect(host.status.get(STATUS_ITEM_ID)).toBe('≈ "retry request" · 3 results');

    await host.run(NEXT_COMMAND_ID, FILES);
    expect(host.status.get(STATUS_ITEM_ID)).toBe('≈ "retry request" · 1/3 · src/api.ts');
  });

  test("reopens on the last question, and an emptied prompt clears results and status", async () => {
    const { host } = setup();
    await host.loadChangeset(FILES);
    host.answers.prompts.push("retry", "");
    host.answers.selects.push(0);
    await host.run(SEARCH_COMMAND_ID, FILES);

    await host.run(SEARCH_COMMAND_ID, FILES);

    expect(host.calls.filter((call) => call[0] === "prompt")).toEqual([
      ["prompt", ""],
      ["prompt", "retry"],
    ]);
    expect(host.status.has(STATUS_ITEM_ID)).toBe(false);
    expect(host.highlight({ id: "f1" })).toBeNull();
  });

  test("a reload drops results that point into the old review", async () => {
    const { host } = setup();
    await host.loadChangeset(FILES);
    host.answers.prompts.push("retry");
    host.answers.selects.push(0);
    await host.run(SEARCH_COMMAND_ID, FILES);

    await host.loadChangeset(FILES);

    expect(host.highlight({ id: "f1" })).toBeNull();
    expect(host.status.has(STATUS_ITEM_ID)).toBe(false);
    await host.run(NEXT_COMMAND_ID, FILES);
    expect(host.status.get(STATUS_ITEM_ID)).toBe("≈ no results · press S to ask");
  });
});

describe("indexing status", () => {
  test("shows progress, then a transient ready that clears itself", async () => {
    const { host, timers } = setup();
    await host.loadChangeset(FILES);
    await flush();

    expect(host.status.get(STATUS_ITEM_ID)).toBe("≈ ready · press S to ask");
    timers.shift()!();
    expect(host.status.has(STATUS_ITEM_ID)).toBe(false);
  });

  test("a reload with every hunk cached does not take the status row", async () => {
    const { host, timers } = setup();
    await host.loadChangeset(FILES);
    await flush();
    timers.shift()!();

    await host.loadChangeset(FILES);
    await flush();

    expect(host.status.has(STATUS_ITEM_ID)).toBe(false);
  });

  test("a background failure names the fix and is logged", async () => {
    const { host, embedder } = setup();
    embedder.fail(new EmbedderError("unreachable", "Ollama is not reachable at 127.0.0.1:11434."));
    await host.loadChangeset(FILES);
    await flush();

    expect(host.status.get(STATUS_ITEM_ID)).toBe("≈ Ollama is not running · start it with `ollama serve`");
    expect(host.logs).toEqual(["indexing failed: Ollama is not reachable at 127.0.0.1:11434."]);
  });
});

describe("setup problems", () => {
  test("an unreachable server is a notice with the command to run, not a crash", async () => {
    const { host, embedder } = setup();
    await host.loadChangeset(FILES);
    await flush();
    embedder.fail(new EmbedderError("unreachable", "Ollama is not reachable. Start it with `ollama serve`."));
    host.answers.prompts.push("retry");

    await host.run(SEARCH_COMMAND_ID, FILES);

    expect(host.calls).toContainEqual(["notify", "Ollama is not reachable. Start it with `ollama serve`.", "error"]);
    expect(host.dialogs).toEqual([]);
  });

  test("a refused remote URL is reported when the user searches", async () => {
    const { host } = setup({
      createEmbedder: () => {
        throw new EmbedderError("remote-refused", "Refusing to send code to example.com.");
      },
    });
    await host.loadChangeset(FILES);

    await host.run(SEARCH_COMMAND_ID, FILES);

    expect(host.calls).toEqual([["notify", "Refusing to send code to example.com.", "error"]]);
    expect(host.status.get(STATUS_ITEM_ID)).toBe("≈ remote server refused · see HUNK_SEMANTIC_SEARCH_ALLOW_REMOTE");
  });

  test("a missing model asks first, and declining shows the manual command", async () => {
    const { host, embedder } = setup({ installed: false });
    await host.loadChangeset(FILES);
    host.answers.prompts.push("retry");
    host.answers.confirms.push(false);

    await host.run(SEARCH_COMMAND_ID, FILES);

    expect(host.dialogs).toEqual([expect.objectContaining({ title: "Download test-model?" })]);
    expect(embedder.pulls).toEqual([]);
    expect(host.calls).toContainEqual(["notify", "Run `ollama pull test-model` to enable semantic search.", "info"]);
  });

  test("accepting the download pulls the model, then searches", async () => {
    const { host, embedder } = setup({ installed: false });
    await host.loadChangeset(FILES);
    host.answers.prompts.push("retry");
    host.answers.confirms.push(true);
    host.answers.selects.push(0);

    await host.run(SEARCH_COMMAND_ID, FILES);

    expect(embedder.pulls).toEqual(["test-model"]);
    expect(host.calls).toContainEqual(["notify", "Downloaded test-model.", "info"]);
    expect(host.calls.some((call) => call[0] === "revealLine")).toBe(true);
  });
});

describe("resultLabel", () => {
  const result = (path: string, label: string): SearchResult =>
    ({ hunk: { path, label, jump: { side: "new", lineNumber: 142 } }, score: 0.523 }) as SearchResult;

  test("keeps short paths and labels whole, with the line", () => {
    expect(resultLabel(result("src/api.ts", "fetchUser"), 0)).toBe("1. src/api.ts:142 · fetchUser · 0.52");
  });

  test("shortens long paths and truncates the text so the score always fits", () => {
    const label = resultLabel(result("packages/hunk/src/ui/components/panes/DiffSection.tsx", "x".repeat(80)), 7);

    expect(label).toStartWith("8. …/panes/DiffSection.tsx:142 · xxx");
    expect(label).toEndWith("x… · 0.52");
    expect(label.length).toBe(58);
  });

  test("falls back to the file name, then cuts it, for very long names", () => {
    const named = resultLabel(result("packages/hunk/src/ui/components/panes/ExtensionPane.presentation-scope.test.tsx", "text"), 1);
    const huge = resultLabel(result(`src/${"y".repeat(90)}.ts`, "text"), 2);

    expect(named).toBe("2. ExtensionPane.presentation-scope.test.… · text · 0.52");
    expect(huge).toBe(`3. ${"y".repeat(38)}… · text · 0.52`);
  });
});
