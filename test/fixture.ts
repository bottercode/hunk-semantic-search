import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Run git in a test repository and return trimmed stdout, throwing on failure. */
export function testGit(cwd: string, args: string[]) {
  const result = Bun.spawnSync(["git", "-c", "user.email=t@test", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

/**
 * Create a repository whose last commit changes a retry loop, an auth check, and the README,
 * so a question about retries has exactly one right answer. Returns the root and a cleanup.
 */
export function createTestRetryRepo() {
  // realpath keeps paths comparable with git's output on macOS, where /var links to /private/var.
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "hunk-semantic-search-test-")));
  const write = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };

  testGit(root, ["init", "-q"]);
  write("src/api.ts", "export async function fetchUser(id: string) {\n  return fetch(`/users/${id}`);\n}\n");
  write("src/auth.ts", "export function canEdit(user: User) {\n  return user.role === 'admin';\n}\n");
  write("README.md", "# Demo\n\nA small demo app.\n");
  testGit(root, ["add", "."]);
  testGit(root, ["commit", "-qm", "initial"]);

  write(
    "src/api.ts",
    [
      "export async function fetchUser(id: string) {",
      "  for (let attempt = 0; attempt < 3; attempt++) {",
      "    try {",
      "      return await fetch(`/users/${id}`);",
      "    } catch (error) {",
      "      await sleep(2 ** attempt * 100);",
      "    }",
      "  }",
      "  throw new Error(`fetchUser(${id}) failed`);",
      "}",
      "",
    ].join("\n"),
  );
  write("src/auth.ts", "export function canEdit(user: User) {\n  return user.role === 'admin' || user.role === 'owner';\n}\n");
  write("README.md", "# Demo\n\nA small demo app that lists users and their profiles.\n");
  testGit(root, ["add", "."]);
  testGit(root, ["commit", "-qm", "change things"]);

  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
