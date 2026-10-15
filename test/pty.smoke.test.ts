/**
 * Drives a real `hunk` in a pseudo-terminal with this extension loaded. Opt in with
 * `HUNK_SEMANTIC_SMOKE=1 bun test`; it needs `hunk` on PATH (or `HUNK_SEMANTIC_HUNK=/path/to/hunk`)
 * and, for the search case, Ollama with embeddinggemma. Unix-only, like Hunk's own PTY tests.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PersistentTerminal } from "ghostty-opentui";
import { createTestRetryRepo } from "./fixture";

const smoke = process.env.HUNK_SEMANTIC_SMOKE === "1" && process.platform !== "win32" ? test : test.skip;
const extensionRoot = path.resolve(import.meta.dir, "..");

/** Open `hunk show HEAD` on the retry fixture in a pseudo-terminal. */
function launchTestHunk(env: Record<string, string> = {}) {
  const repo = createTestRetryRepo();
  const config = mkdtempSync(path.join(os.tmpdir(), "hunk-semantic-search-config-"));
  mkdirSync(path.join(config, "hunk"), { recursive: true });
  writeFileSync(path.join(config, "hunk", "config.toml"), "watch = false\n");

  const screen = new PersistentTerminal({ cols: 140, rows: 32 });
  const terminal = new Bun.Terminal({
    cols: 140,
    rows: 32,
    name: "xterm-truecolor",
    data(_pty, bytes) {
      screen.feed(bytes);
    },
  });
  const child = Bun.spawn([process.env.HUNK_SEMANTIC_HUNK ?? "hunk", "--extension", extensionRoot, "show", "HEAD"], {
    cwd: repo.root,
    terminal,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: config,
      HUNK_DISABLE_UPDATE_NOTICE: "1",
      HUNK_MCP_DISABLE: "1",
      TERM: "xterm-truecolor",
      ...env,
    },
  });

  return {
    screen,
    terminal,
    child,
    /** The bottom row, where the status line sits. */
    statusRow: () => screen.getText().trimEnd().split("\n").at(-1)!.trim(),
    /** Wait until the screen contains `text`, failing with the screen when it never does. */
    async waitFor(text: string, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (!screen.getText().includes(text)) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${JSON.stringify(text)}. Screen:\n${screen.getText()}`);
        await Bun.sleep(50);
      }
    },
    async close() {
      child.kill();
      await child.exited;
      terminal.close();
      repo.cleanup();
      rmSync(config, { recursive: true, force: true });
    },
  };
}

smoke("S, a question, and Enter land on the hunk that answers it", async () => {
  const hunk = launchTestHunk();
  try {
    await hunk.waitFor("File  View");
    await hunk.waitFor("ready · press S to ask", 60_000);

    hunk.terminal.write("S");
    await hunk.waitFor("ask about this change");
    hunk.terminal.write("what happens now when the network request fails");
    await Bun.sleep(100);
    hunk.terminal.write("\r");
    await hunk.waitFor('Hunks about "what happens now');
    expect(hunk.screen.getText()).toMatch(/1\. src\/api\.ts:\d+ · /);

    hunk.terminal.write("\r");
    await hunk.waitFor("· 1/3 · src/api.ts");
    expect(hunk.statusRow()).toBe('≈ "what happens now when the network request fails" · 1/3 · src/api.ts');
    // The landed hunk is on screen and no extension warning or error notice appeared.
    expect(hunk.screen.getText()).toContain("for (let attempt = 0; attempt < 3; attempt++) {");
    expect(hunk.screen.getText()).not.toMatch(/ext hunk-semantic-search|cannot write|Ollama is not/);
  } finally {
    await hunk.close();
  }
}, 120_000);

smoke("with Ollama unreachable, the review still opens and S names the command to run", async () => {
  // Port 9 (discard) is closed on a normal machine, so this never touches a running Ollama.
  const hunk = launchTestHunk({ HUNK_SEMANTIC_SEARCH_URL: "http://127.0.0.1:9" });
  try {
    await hunk.waitFor("File  View");
    await hunk.waitFor("Ollama is not running · start it with `ollama serve`");

    hunk.terminal.write("S");
    await hunk.waitFor("ask about this change");
    hunk.terminal.write("retry\r");
    await hunk.waitFor("Start it with `ollama serve`");

    // Hunk keeps running and still navigates.
    expect(hunk.child.exitCode).toBeNull();
    hunk.terminal.write("]");
    await Bun.sleep(300);
    expect(hunk.child.exitCode).toBeNull();
  } finally {
    await hunk.close();
  }
}, 60_000);
