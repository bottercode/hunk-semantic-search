/**
 * Splits a unified-diff patch into hunks with numbered, sided lines.
 *
 * Adapted from `parsePatchLines` / `readHunkStarts` in Hunk's bundled `/` search
 * (packages/hunk/src/extensions/default/ui/search/search.ts, MIT), since extensions cannot
 * import Hunk internals. Hunk order is patch order, which is the render order Hunk's
 * `ExtensionDiffFile.hunks[].index` uses, so `PatchHunk.index` addresses the same hunk.
 */

export type FileSide = "old" | "new";

export interface PatchLine {
  kind: "add" | "remove" | "context";
  /** Removed lines live on the old side; added and context lines use the new side. */
  side: FileSide;
  /** One-based line number on `side`, or `null` when the `@@` header had no numbers. */
  lineNumber: number | null;
  text: string;
}

export interface PatchHunk {
  index: number;
  /** The whole `@@ … @@ …` header line. */
  header: string;
  /** The text after the closing `@@`, usually the enclosing function or class. */
  context: string;
  lines: PatchLine[];
}

/** Parse one patch into its hunks, in render order. */
export function parsePatchHunks(patch: string): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | null = null;
  let oldLine: number | null = null;
  let newLine: number | null = null;
  const rows = patch.split("\n");

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i]!;
    if (raw.startsWith("@@")) {
      const header = readHunkHeader(raw);
      current = { index: hunks.length, header: raw, context: header.context, lines: [] };
      hunks.push(current);
      oldLine = header.oldStart;
      newLine = header.newStart;
      continue;
    }

    // Everything before the first `@@` is file header noise, `\ No newline at end of file` is a
    // marker rather than content, and the empty string after a final newline is not a line.
    if (current === null || raw.startsWith("\\") || (raw === "" && i === rows.length - 1)) {
      continue;
    }

    const marker = raw[0];
    const text = raw.slice(1);

    if (marker === "-") {
      current.lines.push({ kind: "remove", side: "old", lineNumber: oldLine, text });
      if (oldLine !== null) oldLine += 1;
    } else if (marker === "+") {
      current.lines.push({ kind: "add", side: "new", lineNumber: newLine, text });
      if (newLine !== null) newLine += 1;
    } else if (marker === " " || marker === undefined) {
      // An empty line in a patch is an unmarked context line.
      current.lines.push({ kind: "context", side: "new", lineNumber: newLine, text });
      if (oldLine !== null) oldLine += 1;
      if (newLine !== null) newLine += 1;
    }
    // Anything else is a stray header inside patch text: skip without advancing either counter.
  }

  return hunks;
}

/**
 * Where a jump to this hunk should land: its first added line, or its first removed line when
 * the hunk only deletes. The new code is what a reviewer reads first, so additions win even when
 * the patch lists a removal before them. `null` when no changed line has a number.
 */
export function landingLine(hunk: PatchHunk): { side: FileSide; lineNumber: number } | null {
  const line = changedLinesInReadingOrder(hunk).find((candidate) => candidate.lineNumber !== null);
  return line ? { side: line.side, lineNumber: line.lineNumber! } : null;
}

/** A hunk's added lines, then its removed lines, each in patch order. */
export function changedLinesInReadingOrder(hunk: PatchHunk) {
  return [...hunk.lines.filter((line) => line.kind === "add"), ...hunk.lines.filter((line) => line.kind === "remove")];
}

/** Read the starting line numbers and trailing context out of an `@@` header. */
function readHunkHeader(header: string) {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(header);
  if (!match) {
    return { oldStart: null, newStart: null, context: "" };
  }

  return { oldStart: Number(match[1]), newStart: Number(match[2]), context: match[3]!.trim() };
}
