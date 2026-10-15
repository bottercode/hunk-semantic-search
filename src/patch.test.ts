import { describe, expect, test } from "bun:test";
import { landingLine, parsePatchHunks } from "./patch";

const PATCH = [
  "diff --git a/src/api.ts b/src/api.ts",
  "--- a/src/api.ts",
  "+++ b/src/api.ts",
  "@@ -10,4 +10,5 @@ export async function fetchUser(id: string) {",
  "   const url = `/users/${id}`;",
  "-  return fetch(url);",
  "+  for (let attempt = 0; attempt < 3; attempt++) {",
  "+    try { return await fetch(url); } catch {}",
  "+  }",
  " }",
  "@@ -40,2 +41,2 @@",
  "-old tail",
  "+new tail",
  "\\ No newline at end of file",
  "",
].join("\n");

describe("parsePatchHunks", () => {
  test("splits hunks in order with context text and numbered sided lines", () => {
    const hunks = parsePatchHunks(PATCH);

    expect(hunks.map((hunk) => [hunk.index, hunk.context])).toEqual([
      [0, "export async function fetchUser(id: string) {"],
      [1, ""],
    ]);
    expect(hunks[0]!.lines).toEqual([
      { kind: "context", side: "new", lineNumber: 10, text: "  const url = `/users/${id}`;" },
      { kind: "remove", side: "old", lineNumber: 11, text: "  return fetch(url);" },
      { kind: "add", side: "new", lineNumber: 11, text: "  for (let attempt = 0; attempt < 3; attempt++) {" },
      { kind: "add", side: "new", lineNumber: 12, text: "    try { return await fetch(url); } catch {}" },
      { kind: "add", side: "new", lineNumber: 13, text: "  }" },
      { kind: "context", side: "new", lineNumber: 14, text: "}" },
    ]);
  });

  test("ignores the no-newline marker and the empty string after a final newline", () => {
    const [, tail] = parsePatchHunks(PATCH);

    expect(tail!.lines).toEqual([
      { kind: "remove", side: "old", lineNumber: 40, text: "old tail" },
      { kind: "add", side: "new", lineNumber: 41, text: "new tail" },
    ]);
  });

  test("keeps an empty line inside a hunk as context", () => {
    const [hunk] = parsePatchHunks("@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n");

    expect(hunk!.lines.map((line) => [line.kind, line.lineNumber])).toEqual([
      ["context", 1],
      ["context", 2],
      ["remove", 3],
      ["add", 3],
    ]);
  });

  test("returns no hunks for a patch without any, such as a binary file", () => {
    expect(parsePatchHunks("diff --git a/x.png b/x.png\nBinary files differ\n")).toEqual([]);
  });

  test("leaves line numbers null when the header has none", () => {
    const [hunk] = parsePatchHunks("@@ malformed @@\n+added\n");

    expect(hunk!.lines).toEqual([{ kind: "add", side: "new", lineNumber: null, text: "added" }]);
    expect(landingLine(hunk!)).toBeNull();
  });
});

describe("landingLine", () => {
  test("lands on the first added line even when a removal comes first", () => {
    const [first, second] = parsePatchHunks(PATCH);

    expect(landingLine(first!)).toEqual({ side: "new", lineNumber: 11 });
    expect(landingLine(second!)).toEqual({ side: "new", lineNumber: 41 });
  });

  test("falls back to the first removed line for a hunk that only deletes", () => {
    const [deletion] = parsePatchHunks("@@ -5,3 +5,1 @@\n keep\n-gone\n-also gone\n");

    expect(landingLine(deletion!)).toEqual({ side: "old", lineNumber: 6 });
  });
});
