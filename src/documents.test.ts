import { describe, expect, test } from "bun:test";
import { createTestReviewFile } from "../test/helpers";
import { collectHunks, DEFAULT_DOCUMENT_STYLE, DOCUMENT_CHAR_LIMIT, hunkDocument, hunkLabel, queryDocument } from "./documents";
import { parsePatchHunks } from "./patch";

const [RETRY] = parsePatchHunks(
  [
    "@@ -10,3 +10,5 @@ export async function fetchUser(id: string) {",
    "   const url = `/users/${id}`;",
    "-  return fetch(url);",
    "+  for (let attempt = 0; attempt < 3; attempt++) {",
    "+",
    "+  }",
  ].join("\n"),
);

describe("hunkDocument", () => {
  test("titles the hunk by path and lists its context then changed lines", () => {
    expect(hunkDocument("src/api.ts", RETRY!)).toBe(
      [
        "title: src/api.ts | text: export async function fetchUser(id: string) {",
        "- return fetch(url);",
        "+ for (let attempt = 0; attempt < 3; attempt++) {",
        "+ }",
      ].join("\n"),
    );
  });

  test("can include context lines and drop the prompts", () => {
    const document = hunkDocument("src/api.ts", RETRY!, { ...DEFAULT_DOCUMENT_STYLE, prompts: false, contextLines: true });

    expect(document).toStartWith("src/api.ts\nexport async function fetchUser");
    expect(document).toContain("  const url = `/users/${id}`;");
  });

  test("returns null for a hunk whose changes are only blank lines", () => {
    const [blank] = parsePatchHunks("@@ -1,2 +1,3 @@ context\n a\n+\n+   \n");

    expect(hunkDocument("a.ts", blank!)).toBeNull();
  });

  test("cuts long hunks at a line boundary inside the character budget", () => {
    const longLine = `+${"x".repeat(99)}`;
    const [big] = parsePatchHunks(`@@ -1,0 +1,200 @@\n${Array(200).fill(longLine).join("\n")}\n`);
    const document = hunkDocument("big.ts", big!)!;

    expect(document.length).toBeLessThanOrEqual(DOCUMENT_CHAR_LIMIT + "title: big.ts | text: ".length);
    expect(document.endsWith("x")).toBe(true);
  });
});

describe("queryDocument", () => {
  test("wraps the trimmed question in the retrieval prompt", () => {
    expect(queryDocument("  where did retry change? ")).toBe("task: code retrieval | query: where did retry change?");
    expect(queryDocument("retry", { ...DEFAULT_DOCUMENT_STYLE, prompts: false })).toBe("retry");
  });
});

describe("hunkLabel", () => {
  test("prefers the first meaningful added line, then removed line, then the @@ context", () => {
    const [onlyPunctuation] = parsePatchHunks("@@ -1 +1,2 @@ function setup() {\n+  });\n+import {\n");

    const [deletion] = parsePatchHunks("@@ -1,2 +0,0 @@\n-const legacy = true;\n-}\n");

    expect(hunkLabel(RETRY!)).toBe("for (let attempt = 0; attempt < 3; attempt++) {");
    expect(hunkLabel(deletion!)).toBe("const legacy = true;");
    const [newFile] = parsePatchHunks(
      '@@ -0,0 +1,4 @@\n+import { useMemo } from "react";\n+import type {\n+} from "./types";\n+export function useScope() {\n',
    );

    expect(hunkLabel(onlyPunctuation!)).toBe("function setup() {");
    expect(hunkLabel(newFile!)).toBe("export function useScope() {");
    expect(hunkLabel(RETRY!, 8)).toBe("for (le…");
  });
});

describe("collectHunks", () => {
  test("collects searchable hunks in review order with jump targets and changed lines", () => {
    const file = createTestReviewFile("f1", "src/a.ts", [["first"], ["second", "third"]]);

    expect(collectHunks([file]).map((hunk) => [hunk.fileId, hunk.hunkIndex, hunk.jump, hunk.changedLines.length])).toEqual([
      ["f1", 0, { side: "new", lineNumber: 1 }, 1],
      ["f1", 1, { side: "new", lineNumber: 11 }, 2],
    ]);
  });

  test("skips binary files and files whose hunk count disagrees with Hunk's", () => {
    const binary = { id: "b", path: "logo.png", patch: "Binary files differ\n", hunks: [] };
    const mismatched = { ...createTestReviewFile("m", "src/m.ts", [["one"]]), hunks: [{}, {}] };
    const skipped: string[] = [];

    expect(collectHunks([binary, mismatched], (path, reason) => skipped.push(`${path}: ${reason}`))).toEqual([]);
    expect(skipped).toEqual(["src/m.ts: Hunk reports 2 hunks but the patch has 1"]);
  });
});
