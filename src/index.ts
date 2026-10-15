/**
 * Registers semantic search on `S`: ask a question about the change and jump to the hunks that
 * answer it, even when they share no words with the question.
 *
 * Opening a review and every reload index the changeset in the background, with progress on
 * the status line. `S` opens a status-line prompt that reopens on the last question; Enter ranks
 * the visible hunks (so the file filter applies) and lists the best eight in a dialog. Choosing
 * one reveals its first changed line, marks its changed lines, and reports the position on the
 * status line; `next` and `previous` step through the same ranked list. They ship unbound
 * because `n`/`N` belong to Hunk's `/` search.
 *
 * Hunk owns navigation, marks, prompts, and dialogs; this module owns the question, the ranked
 * results, and the cursor into them. Results are dropped on reload because their file ids
 * belong to the review that produced them. Embeddings come from a local Ollama server; when the
 * model is missing, the first search offers to download it.
 */

import type {
  ExtensionCommandContext,
  ExtensionEventContext,
  ExtensionLineHighlight,
  ExtensionReviewNavigation,
  ExtensionStatusLineControls,
  ExtensionStatusSpan,
  HunkExtensionAPI,
} from "hunkdiff/extension";
import type { ReviewFile } from "./documents";
import {
  createOllamaEmbedder,
  EmbedderError,
  resolveModel,
  resolveServerUrl,
  type Embedder,
  type PullProgress,
} from "./embedder";
import { createSearchIndex, type IndexProgress, type SearchIndex, type SearchResult } from "./store";

export const SEARCH_COMMAND_ID = "search";
export const NEXT_COMMAND_ID = "next";
export const PREVIOUS_COMMAND_ID = "previous";
export const HIGHLIGHTER_ID = "marks";
export const STATUS_ITEM_ID = "status";
export const RESULT_COUNT = 8;

/** How long a transient status (ready, a background failure) stays before freeing the row. */
const TRANSIENT_STATUS_MS = 4000;
const PREFIX = "≈ ";

export interface SemanticSearchDependencies {
  /** Build the embedder; throwing an `EmbedderError` reports a setup problem on first use. */
  createEmbedder(config: Record<string, unknown>): Embedder;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

const defaultDependencies: SemanticSearchDependencies = {
  createEmbedder: (config) =>
    createOllamaEmbedder({ url: resolveServerUrl(process.env), model: resolveModel(config) }),
};

/** Build the extension factory over injectable dependencies. */
export function createSemanticSearch(deps: SemanticSearchDependencies = defaultDependencies) {
  const schedule = deps.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const cancel = deps.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  return function semanticSearch(hunk: HunkExtensionAPI) {
    let embedder: Embedder | null = null;
    let index: SearchIndex | null = null;
    let setupError: unknown = null;
    try {
      embedder = deps.createEmbedder(hunk.config);
      index = createSearchIndex({
        embedder,
        onProgress: (progress) => showProgress(progress),
        onSkip: (path, reason) => hunk.log(`skipped ${path}: ${reason}`),
      });
    } catch (error) {
      setupError = error;
    }

    // Handlers hand out status controls scoped to the current review; progress arrives
    // asynchronously, so it writes through the most recent ones.
    let statusLine: ExtensionStatusLineControls | null = null;
    let transientTimer: unknown = null;
    let showingProgress = false;
    let changesetFiles: readonly ReviewFile[] = [];
    let generation = 0;
    let lastQuery: string | null = null;
    let results: SearchResult[] = [];
    let position = -1;

    /** Write the status item, optionally clearing it after a moment. */
    function setStatus(spans: ExtensionStatusSpan[], transient = false) {
      if (transientTimer !== null) cancel(transientTimer);
      transientTimer = null;
      statusLine?.set({ id: STATUS_ITEM_ID, spans: [{ text: PREFIX, tone: "accent" }, ...spans], priority: 1 });
      if (transient) {
        transientTimer = schedule(() => {
          transientTimer = null;
          if (position < 0) statusLine?.clear(STATUS_ITEM_ID);
        }, TRANSIENT_STATUS_MS);
      }
    }

    /** Report background indexing, unless a result is on screen and owns the row. */
    function showProgress(progress: IndexProgress) {
      const wasIndexing = showingProgress;
      showingProgress = false;
      if (progress.state === "failed") hunk.log(`indexing failed: ${describeError(progress.error)}`);
      if (position >= 0) return;

      if (progress.state === "indexing") {
        // A reload whose hunks are all cached embeds nothing, so it never takes the row.
        if (progress.total === 0) return;
        showingProgress = true;
        setStatus([{ text: `indexing ${progress.done}/${progress.total}`, tone: "muted" }]);
      } else if (progress.state === "ready") {
        if (wasIndexing) setStatus([{ text: "ready · press S to ask", tone: "muted" }], true);
      } else {
        setStatus([{ text: backgroundFailureText(progress.error), tone: "removed" }], true);
      }
    }

    /** Status spans for the current result. */
    function resultSpans(): ExtensionStatusSpan[] {
      const current = results[position]!;
      return [
        { text: `"${lastQuery}"` },
        { text: ` · ${position + 1}/${results.length} · `, tone: "muted" },
        { text: current.hunk.path, tone: "accent-muted" },
      ];
    }

    /** Jump to the current result, refresh its marks, and report it. */
    function deliver(ctx: ExtensionCommandContext) {
      const current = results[position];
      if (current) jumpTo(ctx.navigation, current);
      ctx.highlights.refresh(HIGHLIGHTER_ID);
      if (current) setStatus(resultSpans());
    }

    /** Forget results and marks, keeping the question for the next prompt. */
    function clearResults(ctx?: ExtensionCommandContext) {
      results = [];
      position = -1;
      ctx?.highlights.refresh(HIGHLIGHTER_ID);
    }

    /** Report a search-time failure on the status line and as a notice with the fix. */
    function reportError(ctx: ExtensionCommandContext, error: unknown) {
      const message = describeError(error);
      hunk.log(`search failed: ${message}`);
      ctx.notify(message, "error");
      setStatus([{ text: backgroundFailureText(error), tone: "removed" }], true);
    }

    /** Make sure the model is installed, offering to download it. Resolves false to stop. */
    async function ensureModel(ctx: ExtensionCommandContext, active: Embedder) {
      if (await active.hasModel()) return true;

      const accepted = await ctx.dialogs.confirm({
        title: `Download ${active.model}?`,
        body: `Semantic search needs the ${active.model} embedding model (about 620 MB for embeddinggemma). Ollama downloads it once and keeps it on this machine.`,
        confirmLabel: "download",
        cancelLabel: "not now",
      });
      if (!accepted) {
        ctx.notify(`Run \`ollama pull ${active.model}\` to enable semantic search.`, "info");
        return false;
      }

      let lastPercent = -1;
      setStatus([{ text: `downloading ${active.model}…`, tone: "muted" }]);
      await active.pullModel((progress: PullProgress) => {
        const percent = progress.total ? Math.floor((100 * (progress.completed ?? 0)) / progress.total) : null;
        if (percent === null || percent === lastPercent) return;
        lastPercent = percent;
        setStatus([{ text: `downloading ${active.model} ${percent}%`, tone: "muted" }]);
      });
      ctx.notify(`Downloaded ${active.model}.`, "info");
      // Background indexing failed without the model, so start it again now that it exists.
      void index?.index(changesetFiles);
      return true;
    }

    hunk.registerLineHighlighter({
      id: HIGHLIGHTER_ID,
      highlight: ({ file }) => {
        const current = results[position];
        if (!current || current.hunk.fileId !== file.id) return null;
        return current.hunk.changedLines.map(
          (line): ExtensionLineHighlight => ({
            side: line.side,
            line: line.lineNumber,
            range: [0, line.length],
            tone: "current",
          }),
        );
      },
    });

    hunk.on("changeset_loaded", ({ changeset }, ctx: ExtensionEventContext) => {
      statusLine = ctx.statusLine;
      changesetFiles = changeset.files;
      generation += 1;
      if (position >= 0) {
        // The old results point into the review this reload replaced.
        clearResults();
        statusLine.clear(STATUS_ITEM_ID);
      }
      void index?.index(changeset.files);
    });

    hunk.on("shutdown", () => {
      index?.dispose();
      if (transientTimer !== null) cancel(transientTimer);
    });

    hunk.registerCommand({ id: SEARCH_COMMAND_ID, title: "Search by meaning", key: "S" }, async (ctx) => {
      statusLine = ctx.statusLine;
      if (!embedder || !index) {
        reportError(ctx, setupError);
        return;
      }

      // Hunk paints a space after the prefix itself.
      const query = await ctx.prompts.line({ prefix: PREFIX.trim(), placeholder: "ask about this change", initial: lastQuery ?? "" });
      if (query === null) return;
      if (query.trim().length === 0) {
        // Submitting an emptied prompt is the way out: marks and status go with the question.
        lastQuery = null;
        clearResults(ctx);
        ctx.statusLine.clear(STATUS_ITEM_ID);
        return;
      }

      lastQuery = query.trim();
      const startedIn = generation;
      let ranked: SearchResult[];
      try {
        if (!(await ensureModel(ctx, embedder))) return;
        setStatus([{ text: `searching "${lastQuery}"…`, tone: "muted" }]);
        ranked = await index.search(lastQuery, ctx.selection.files, RESULT_COUNT);
      } catch (error) {
        reportError(ctx, error);
        return;
      }

      if (startedIn !== generation) {
        setStatus([{ text: "the review reloaded · press S to ask again", tone: "muted" }], true);
        return;
      }
      if (ranked.length === 0) {
        clearResults(ctx);
        setStatus([{ text: `"${lastQuery}" · no hunks to search`, tone: "muted" }], true);
        return;
      }

      const labels = ranked.map(resultLabel);
      const choice = await ctx.dialogs.select({ title: `Hunks about "${lastQuery}"`, options: labels });
      if (startedIn !== generation) return;

      results = ranked;
      // Labels are unique by their leading number; a cancelled list keeps the results for `next`.
      position = choice === null ? -1 : labels.indexOf(choice);
      if (position < 0) {
        ctx.highlights.refresh(HIGHLIGHTER_ID);
        setStatus([{ text: `"${lastQuery}" · ${results.length} results`, tone: "muted" }]);
        return;
      }
      deliver(ctx);
    });

    /** Step through the ranked results, wrapping at either end. */
    const step = (direction: 1 | -1) => (ctx: ExtensionCommandContext) => {
      statusLine = ctx.statusLine;
      if (results.length === 0) {
        setStatus([{ text: "no results · press S to ask", tone: "muted" }], true);
        return;
      }
      const start = position < 0 ? (direction === 1 ? -1 : 0) : position;
      position = (start + direction + results.length) % results.length;
      deliver(ctx);
    };

    hunk.registerCommand({ id: NEXT_COMMAND_ID, title: "Next semantic result" }, step(1));
    hunk.registerCommand({ id: PREVIOUS_COMMAND_ID, title: "Previous semantic result" }, step(-1));
  };
}

/** Columns a result label may use; Hunk's select dialog leaves about 60 beside its marker. */
const LABEL_WIDTH = 58;
/** The fewest columns of hunk text worth showing before the path gives up segments. */
const MIN_TEXT_WIDTH = 16;

/**
 * Format one result for the select dialog, e.g. `1. panes/DiffPane.tsx:142 · const visible… · 0.52`.
 *
 * The path shortens to its last two segments, then to the file name, until the hunk text has
 * room; the text absorbs the rest of the budget so the score is never cut off. The leading number
 * keeps labels unique, since `select` answers with the chosen label.
 */
export function resultLabel(result: SearchResult, index: number) {
  const { hunk } = result;
  const parts = hunk.path.split("/");
  const line = hunk.jump ? `:${hunk.jump.lineNumber}` : "";
  const tail = ` · ${result.score.toFixed(2)}`;
  const candidates = [hunk.path, parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : hunk.path, parts.at(-1)!];

  let location = "";
  for (const path of candidates) {
    location = `${index + 1}. ${path}${line}`;
    if (location.length + 3 + MIN_TEXT_WIDTH + tail.length <= LABEL_WIDTH) break;
  }
  // Even a file name can be too long; it still leaves a few columns of hunk text.
  location = fit(location, LABEL_WIDTH - tail.length - 3 - 6);
  return `${location} · ${fit(hunk.label, LABEL_WIDTH - location.length - 3 - tail.length)}${tail}`;
}

/** Cut text to `width` columns with an ellipsis. */
function fit(text: string, width: number) {
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
}

/** Jump to a result's first changed line, or select its hunk when the line is unknown. */
function jumpTo(navigation: ExtensionReviewNavigation, result: SearchResult) {
  const { hunk } = result;
  if (hunk.jump === null) {
    navigation.selectHunk(hunk.fileId, hunk.hunkIndex);
    return;
  }
  navigation.revealLine(hunk.fileId, hunk.jump.side, hunk.jump.lineNumber);
}

/** A one-line status for a failure, pointing at the fix. */
function backgroundFailureText(error: unknown) {
  if (error instanceof EmbedderError) {
    switch (error.kind) {
      case "unreachable":
        return "Ollama is not running · start it with `ollama serve`";
      case "model-missing":
        return "model missing · press S to download it";
      case "remote-refused":
        return "remote server refused · see HUNK_SEMANTIC_SEARCH_ALLOW_REMOTE";
      case "invalid-config":
        return "configuration error · see the notice";
      case "server":
        return "Ollama error · see the notice";
    }
  }
  return "semantic search failed · see the notice";
}

/** The full message for a failure. */
function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export default createSemanticSearch();
