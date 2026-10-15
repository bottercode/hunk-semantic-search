/**
 * Measures how often semantic search puts the right hunk at the top, on real Hunk commits.
 *
 * Each case is a question a reviewer might ask about one commit, plus the hunk(s) that answer
 * it, identified by file path and a snippet that appears in the hunk. The script embeds every
 * hunk of each commit with the real model, ranks them for each question, and prints top-1 and
 * top-3 hit rates for several document styles, so prompt and document changes are judged on
 * numbers instead of impressions.
 *
 *   bun scripts/eval.ts [--repo ~/Developer/hunk]   # run the cases
 *   bun scripts/eval.ts --list <commit>             # print a commit's hunks to write cases from
 */

import os from "node:os";
import path from "node:path";
import { DEFAULT_DOCUMENT_STYLE, hunkDocument, hunkLabel, queryDocument, type DocumentStyle } from "../src/documents";
import { createOllamaEmbedder, resolveModel, resolveServerUrl } from "../src/embedder";
import { parsePatchHunks, type PatchHunk } from "../src/patch";
import { topK } from "../src/rank";

interface EvalCase {
  commit: string;
  query: string;
  /** Any of these hunks counts as a hit. */
  targets: { path: string; contains: string }[];
}

interface EvalHunk {
  path: string;
  hunk: PatchHunk;
  raw: string;
}

// Questions avoid the identifiers in the target hunk where they can, so a hit has to come from
// meaning rather than shared words. An empty `contains` accepts any hunk in that file.
const CASES: EvalCase[] = [
  // f3e78cb6 fix: store persistent state under XDG state directory (39 hunks)
  {
    commit: "f3e78cb6",
    query: "where does it carry over the old settings file the first time after an upgrade",
    targets: [{ path: "packages/hunk/src/core/process/appStateLocation.ts", contains: "" }],
  },
  {
    commit: "f3e78cb6",
    query: "which function picks the folder for saved state and ignores relative environment paths",
    targets: [{ path: "packages/hunk/src/core/run/paths.ts", contains: "resolveUserStateDir" }],
  },
  {
    commit: "f3e78cb6",
    query: "tests that a repository the user already trusted stays trusted after upgrading",
    targets: [
      { path: "packages/hunk/src/extensions/trust.test.ts", contains: "keeps trust decisions" },
      { path: "test/pty/extensions-integration.test.ts", contains: "upgrading migrates remembered trust" },
    ],
  },
  {
    commit: "f3e78cb6",
    query: "error message when the home directory cannot be found",
    targets: [{ path: "packages/hunk/src/extensions/trust.ts", contains: "is unset" }],
  },
  {
    commit: "f3e78cb6",
    query: "flaky click test that has to wait for the screen to repaint",
    targets: [{ path: "test/pty/comment-target.test.ts", contains: "" }],
  },
  // 529f1109 fix(ui): release stdin before launching terminal editors (35 hunks)
  {
    commit: "529f1109",
    query: "where is the full-screen UI paused and brought back around launching vim",
    targets: [{ path: "packages/hunk/src/ui/lib/openInEditor.ts", contains: "renderer.suspend()" }],
  },
  {
    commit: "529f1109",
    query: "test that keyboard input is handed back before the editor starts",
    targets: [{ path: "packages/hunk/src/ui/lib/openInEditor.test.ts", contains: "paused stdin reader" }],
  },
  {
    commit: "529f1109",
    query: "skip work once the app has already been torn down",
    targets: [{ path: "packages/hunk/src/ui/App.tsx", contains: "isDestroyed" }],
  },
  {
    commit: "529f1109",
    query: "stop a second editor from opening while one is still running",
    targets: [{ path: "packages/hunk/src/ui/lib/openInEditor.ts", contains: "activeEditors" }],
  },
  // 9566e33d fix(theme): refresh terminal colors via direct OSC probe (23 hunks)
  {
    commit: "9566e33d",
    query: "how long to wait for the terminal to answer before giving up",
    targets: [{ path: "packages/hunk/src/ui/theme/terminalColorWatcher.ts", contains: "PROBE_TIMEOUT_MS" }],
  },
  {
    commit: "9566e33d",
    query: "combine partial answers about the palette into one result",
    targets: [{ path: "packages/hunk/src/ui/theme/terminalColorWatcher.ts", contains: "mergeTerminalColors" }],
  },
  {
    commit: "9566e33d",
    query: "cleanup when the watcher is stopped",
    targets: [{ path: "packages/hunk/src/ui/theme/terminalColorWatcher.ts", contains: 'renderer.off("theme_mode"' }],
  },
  {
    commit: "9566e33d",
    query: "documentation on how quickly colors update after switching to dark mode",
    targets: [
      { path: "docs/themes.md", contains: "" },
      { path: "website/src/content/docs/docs/configure/themes.md", contains: "" },
    ],
  },
  // f0aa9af1 feat(extensions): support managed npm package sources (72 hunks)
  {
    commit: "f0aa9af1",
    query: "help text for installing plugins from the package registry",
    targets: [
      { path: "packages/hunk/src/app/cli.ts", contains: "" },
      { path: "docs/extensions.md", contains: "npm:" },
    ],
  },
  {
    commit: "f0aa9af1",
    query: "safer check for whether something is already installed, ignoring inherited properties",
    targets: [{ path: "packages/hunk/src/extensions/manage/install.ts", contains: "Object.hasOwn" }],
  },
  {
    commit: "f0aa9af1",
    query: "print a package version instead of a shortened commit hash",
    targets: [{ path: "packages/hunk/src/extensions/manage/cli.ts", contains: "formatRevision" }],
  },
];

const STYLES: Record<string, DocumentStyle> = {
  "prompts (code retrieval)": DEFAULT_DOCUMENT_STYLE,
  "prompts (search result)": { ...DEFAULT_DOCUMENT_STYLE, queryTask: "search result" },
  "prompts + context lines": { ...DEFAULT_DOCUMENT_STYLE, contextLines: true },
  "no prompts": { ...DEFAULT_DOCUMENT_STYLE, prompts: false },
};

const args = process.argv.slice(2);
const repo = readFlag("--repo") ?? path.join(os.homedir(), "Developer", "hunk");
const listCommit = readFlag("--list");

if (listCommit) {
  for (const [i, { path: file, hunk }] of readCommitHunks(listCommit).entries()) {
    const changed = hunk.lines.filter((line) => line.kind !== "context").slice(0, 4);
    console.log(`#${i} ${file} [${hunk.index}] ${hunkLabel(hunk, 70)}`);
    for (const line of changed) console.log(`    ${line.kind === "add" ? "+" : "-"} ${line.text.trim().slice(0, 110)}`);
  }
  process.exit(0);
}

await runEval();

/** Embed each commit once per style, then score every case. */
async function runEval() {
  const embedder = createOllamaEmbedder({ url: resolveServerUrl(process.env), model: resolveModel({}) });
  const commits = [...new Set(CASES.map((c) => c.commit))];
  const hunksByCommit = new Map(commits.map((commit) => [commit, readCommitHunks(commit)]));
  console.log(`${CASES.length} cases over ${commits.length} commits (${[...hunksByCommit.values()].reduce((n, h) => n + h.length, 0)} hunks)\n`);

  for (const [name, style] of Object.entries(STYLES)) {
    let top1 = 0;
    let top3 = 0;
    const misses: string[] = [];

    for (const commit of commits) {
      const hunks = hunksByCommit.get(commit)!;
      const indexed = hunks
        .map((entry) => ({ entry, document: hunkDocument(entry.path, entry.hunk, style) }))
        .filter((item): item is { entry: EvalHunk; document: string } => item.document !== null);
      const vectors = await embedder.embed(indexed.map((item) => item.document));
      const items = indexed.map((item, i) => ({ ...item, vector: vectors[i]! }));

      for (const evalCase of CASES.filter((c) => c.commit === commit)) {
        assertTargetsExist(evalCase, hunks);
        const [queryVector] = await embedder.embed([queryDocument(evalCase.query, style)]);
        const ranked = topK(queryVector!, items, (item) => item.vector, 3);
        const rank = ranked.findIndex(({ item }) => isTarget(evalCase, item.entry));
        if (rank === 0) top1 += 1;
        if (rank >= 0) top3 += 1;
        else misses.push(`  miss: "${evalCase.query}" → ${ranked.map(({ item, score }) => `${item.entry.path} ${hunkLabel(item.entry.hunk, 30)} (${score.toFixed(2)})`).join("; ")}`);
      }
    }

    console.log(`${name.padEnd(26)} top-1 ${pct(top1)}  top-3 ${pct(top3)}`);
    if (args.includes("--misses")) for (const miss of misses) console.log(miss);
  }
}

/** True when one indexed hunk is among a case's targets. */
function isTarget(evalCase: EvalCase, entry: EvalHunk) {
  return evalCase.targets.some((target) => entry.path === target.path && entry.raw.includes(target.contains));
}

/** Fail loudly when a case names a hunk that does not exist, so a typo cannot read as a miss. */
function assertTargetsExist(evalCase: EvalCase, hunks: EvalHunk[]) {
  if (!hunks.some((entry) => isTarget(evalCase, entry))) {
    throw new Error(`No hunk matches the targets of "${evalCase.query}" in ${evalCase.commit}`);
  }
}

/** Read every hunk of one commit, split per file. */
function readCommitHunks(commit: string): EvalHunk[] {
  const result = Bun.spawnSync(["git", "show", "--format=", "--no-color", "--no-ext-diff", commit], { cwd: repo });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());

  const hunks: EvalHunk[] = [];
  for (const filePatch of result.stdout.toString().split(/^(?=diff --git )/m)) {
    const file = /^\+\+\+ b\/(.+)$/m.exec(filePatch)?.[1] ?? /^--- a\/(.+)$/m.exec(filePatch)?.[1];
    if (!file) continue;
    for (const hunk of parsePatchHunks(filePatch)) {
      hunks.push({ path: file, hunk, raw: hunk.lines.map((line) => line.text).join("\n") });
    }
  }
  return hunks;
}

function pct(n: number) {
  return `${n}/${CASES.length} (${Math.round((100 * n) / CASES.length)}%)`;
}

function readFlag(name: string) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
