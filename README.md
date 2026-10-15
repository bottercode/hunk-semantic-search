# hunk-semantic-search

Search a [Hunk](https://hunk.dev) review **by meaning**. Ask "what happens now when the network request fails?" and jump to the retry loop, even though the word "retry" isn't in your question.

```text
╭──────────────────────────────────────────────────────────────────────╮
│ Hunks about "what happens now when the network request fails"  [Esc] │
│                                                                      │
│ › 1. src/api.ts:2 · for (let attempt = 0; attempt < … · 0.33         │
│   2. src/auth.ts:2 · return user.role === 'admin' ||… · 0.18         │
│   3. README.md:3 · A small demo app that lists users… · 0.12         │
╰──────────────────────────────────────────────────────────────────────╯

 ≈ "what happens now when the network request fails" · 1/3 · src/api.ts
```

Hunk's built-in `/` finds the text you type. This finds the hunks that answer a question, which helps most in a large changeset from a coding agent when you don't know what the code calls things. It runs entirely on your machine, using Google's [EmbeddingGemma](https://ai.google.dev/gemma/docs/embeddinggemma) model through [Ollama](https://ollama.com).

## Install

Requires Hunk 0.23 or newer and Ollama.

1. **Install Ollama:** `brew install ollama`, or the installer from [ollama.com](https://ollama.com). The Ollama app keeps the server running; without it, run `ollama serve`.
2. **Install the extension:**

   ```sh
   hunk extension install bottercode/hunk-semantic-search
   ```

3. **Get the model:** the first time you search, Hunk asks whether to download `embeddinggemma` (about 620 MB) and shows progress on the status line. You can also download it yourself beforehand with `ollama pull embeddinggemma`.

## Use

| Key | Action |
| --- | --- |
| `S` | Ask a question. The prompt reopens on your last question; submit an empty prompt to clear the results. |
| `↑`/`↓` and Enter, or a click | Pick a result from the list. Hunk jumps to its first changed line and marks the hunk's changed lines. |
| unbound by default | Next and previous result (`n`/`N` belong to `/`). |

When a review opens, the extension indexes its hunks in the background and shows `≈ indexing 64/123` on the status line, then `≈ ready`. Searches only rank the files currently visible, so the file filter (Tab) narrows them too.

To step through results from the keyboard, bind the commands in your Hunk config:

```toml
[keybindings]
"hunk-semantic-search.next" = "ctrl+n"
"hunk-semantic-search.previous" = "ctrl+p"
```

Both commands are also in the **Extensions** menu.

## How it works

1. **Index:** each hunk becomes one document: its file path, the `@@` context (usually the enclosing function), and its added and removed lines, cut to fit the model's 2,048-token context. Unchanged lines are left out, since they made results worse in testing. Binary files and renames without content changes are skipped.
2. **Embed:** Ollama turns each document into a vector, 32 at a time, in the background. Vectors are cached by a hash of the document text, so a reload or refilter only embeds hunks whose text changed. Loading a new changeset cancels any indexing still running.
3. **Ask:** your question is embedded with EmbeddingGemma's retrieval prompt (`task: code retrieval | query: …`), and the visible hunks are ranked by cosine similarity.

## Privacy

- Code is sent only to the Ollama server, which by default is `http://127.0.0.1:11434` on your own machine. Nothing else makes network requests.
- The server address comes **only** from the `HUNK_SEMANTIC_SEARCH_URL` environment variable, never from Hunk config. A repository can override extension config, so a repository you review could otherwise send your code to someone else's server.
- Non-local addresses are refused unless you also set `HUNK_SEMANTIC_SEARCH_ALLOW_REMOTE=1`.
- Embeddings are kept in memory only and are gone when Hunk exits.

## How well does it work?

[`scripts/eval.ts`](scripts/eval.ts) asks 16 hand-written questions about 4 real Hunk commits (175 hunks) and checks whether the hunk that answers each one ranks first, or in the top 3:

| Document style | Top 1 | Top 3 |
| --- | --- | --- |
| **Retrieval prompts, `code retrieval` task (default)** | 69% | **81%** |
| Retrieval prompts, `search result` task | 69% | 75% |
| Prompts plus unchanged lines | 63% | 63% |
| No prompts | 50% | 69% |

I wrote the questions myself and the set is small, so treat these as rough numbers. Some misses are reasonable answers that the eval doesn't count, such as the docs page for a question about help text. On an M2 Mac with 8 GB of memory, a 123-hunk commit indexes in about 7 seconds and each question takes about 0.25 seconds.

```sh
bun scripts/eval.ts --misses          # rerun it; needs a Hunk checkout at ~/Developer/hunk or --repo
bun scripts/eval.ts --list <commit>   # print a commit's hunks to write new questions from
```

## Limitations

- **Ollama only** for now. The embedder is behind a small interface, so a built-in runtime could replace it later.
- **Questions work best when they describe behavior** ("what happens when the request fails"). For exact names, `/` is faster and exact.
- **Scores are relative.** When the top scores are all close together, the question probably has no strong match in this change.
- Results belong to the review they were found in, and a reload clears them.

## Configuration

| Setting | Effect |
| --- | --- |
| `model` in `[extension.hunk-semantic-search]` | Ollama embedding model to use (default `embeddinggemma`) |
| `HUNK_SEMANTIC_SEARCH_URL` | Ollama server address (default `http://127.0.0.1:11434`) |
| `HUNK_SEMANTIC_SEARCH_ALLOW_REMOTE=1` | Allow a server that isn't on this machine |

## Development

```sh
bun install
bun test                              # unit tests, with a fake embedder
bun run typecheck
HUNK_SEMANTIC_SMOKE=1 bun test        # adds real-model and real-terminal checks (needs Ollama and hunk)
hunk --extension . diff               # run your checkout without installing it
```

## License

[MIT](LICENSE)
