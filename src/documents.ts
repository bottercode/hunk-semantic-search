/**
 * Turns hunks and questions into the text the embedding model sees.
 *
 * EmbeddingGemma is trained with task prompts: documents as `title: … | text: …` and queries as
 * `task: <task> | query: …`. A hunk document carries its file path as the title, then the `@@`
 * context (usually the enclosing function) and the changed lines with their `+`/`-` markers, so
 * both what changed and where it changed can match. Text is cut at a character budget that keeps
 * the document inside the model's 2,048-token context.
 */

import { changedLinesInReadingOrder, landingLine, parsePatchHunks, type FileSide, type PatchHunk } from "./patch";

/** Roughly 1,500 tokens of code, leaving headroom inside the 2,048-token context. */
export const DOCUMENT_CHAR_LIMIT = 6000;

export interface DocumentStyle {
  /** Wrap text in EmbeddingGemma's task prompts. */
  prompts: boolean;
  /** Include unchanged context lines alongside the changed ones. */
  contextLines: boolean;
  /** The query task name, e.g. "code retrieval" or "search result". */
  queryTask: string;
}

export const DEFAULT_DOCUMENT_STYLE: DocumentStyle = {
  prompts: true,
  contextLines: false,
  // Scored best on scripts/eval.ts: 81% top-3 against 75% for "search result".
  queryTask: "code retrieval",
};

/** Build one hunk's embedding text, or `null` when it has nothing to search. */
export function hunkDocument(path: string, hunk: PatchHunk, style: DocumentStyle = DEFAULT_DOCUMENT_STYLE) {
  const body: string[] = [];
  for (const line of hunk.lines) {
    if (line.kind === "context" && !style.contextLines) continue;
    const text = line.text.trim();
    if (text.length === 0) continue;
    body.push(`${line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "} ${text}`);
  }

  if (!body.some((line) => !line.startsWith(" "))) {
    return null;
  }

  const text = truncate([hunk.context, ...body].filter(Boolean).join("\n"), DOCUMENT_CHAR_LIMIT);
  return style.prompts ? `title: ${path} | text: ${text}` : `${path}\n${text}`;
}

/** Build the embedding text for one question. */
export function queryDocument(query: string, style: DocumentStyle = DEFAULT_DOCUMENT_STYLE) {
  const text = query.trim();
  return style.prompts ? `task: ${style.queryTask} | query: ${text}` : text;
}

/**
 * A short human label for a hunk: its first meaningful added line, else removed line, else its
 * `@@` context.
 *
 * Several hunks of one function share the same `@@` context, so the changed text is what tells
 * results apart. Lines that are only punctuation, and imports (a new file's first lines), say
 * nothing about the change and are skipped.
 */
export function hunkLabel(hunk: PatchHunk, maxLength = 80) {
  const meaningful = changedLinesInReadingOrder(hunk).find((line) => isMeaningful(line.text));
  const label = meaningful?.text.trim() || hunk.context || hunk.header;
  return label.length > maxLength ? `${label.slice(0, maxLength - 1)}…` : label;
}

/** True when a line has more to say than punctuation, one keyword, or an import. */
function isMeaningful(text: string) {
  const trimmed = text.trim();
  if (/^(import\b|export\s+(\*|\{[^}]*\})\s+from\b|[}\])]*\s*from\s+["'])/.test(trimmed)) return false;
  return (trimmed.match(/\w+/g) ?? []).length >= 2;
}

/** The fields of Hunk's `ExtensionDiffFile` this extension reads. */
export interface ReviewFile {
  id: string;
  path: string;
  patch: string;
  hunks?: readonly unknown[];
}

/** One searchable hunk: where it is, how to jump to it, and the text the model embeds. */
export interface SearchableHunk {
  fileId: string;
  path: string;
  hunkIndex: number;
  label: string;
  /** Where a jump lands, or `null` to fall back to selecting the hunk. */
  jump: { side: FileSide; lineNumber: number } | null;
  /** The changed lines a result marks in the diff. */
  changedLines: { side: FileSide; lineNumber: number; length: number }[];
  document: string;
}

/**
 * Collect the searchable hunks of the given files, in review order.
 *
 * Files with no hunks (binary files, pure renames) contribute nothing. A file whose patch parses
 * into a different number of hunks than Hunk reports is skipped and reported through `onSkip`,
 * since a misaligned index would jump to the wrong hunk.
 */
export function collectHunks(
  files: readonly ReviewFile[],
  onSkip: (path: string, reason: string) => void = () => {},
  style: DocumentStyle = DEFAULT_DOCUMENT_STYLE,
) {
  const hunks: SearchableHunk[] = [];
  for (const file of files) {
    const parsed = parsePatchHunks(file.patch);
    if (file.hunks !== undefined && file.hunks.length !== parsed.length) {
      onSkip(file.path, `Hunk reports ${file.hunks.length} hunks but the patch has ${parsed.length}`);
      continue;
    }

    for (const hunk of parsed) {
      const document = hunkDocument(file.path, hunk, style);
      if (document === null) continue;
      hunks.push({
        fileId: file.id,
        path: file.path,
        hunkIndex: hunk.index,
        label: hunkLabel(hunk),
        jump: landingLine(hunk),
        changedLines: hunk.lines.flatMap((line) =>
          line.kind === "context" || line.lineNumber === null
            ? []
            : [{ side: line.side, lineNumber: line.lineNumber, length: line.text.length }],
        ),
        document,
      });
    }
  }
  return hunks;
}

/** Cut text at a line boundary within `limit` characters. */
function truncate(text: string, limit: number) {
  if (text.length <= limit) return text;
  const cut = text.lastIndexOf("\n", limit);
  return text.slice(0, cut > 0 ? cut : limit);
}
