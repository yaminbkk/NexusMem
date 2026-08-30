# NexusMem for VS Code

Search a [NexusMem](https://github.com/yaminbkk/NexusMem)-tracked repository's remembered history —
git commits, code diffs, shell commands (with exit codes), tracked docs, (if enabled) conversation
transcripts, and (if enabled) github.com issue/PR threads — from the command palette, without leaving
the editor.

This is an early, minimal surface: a search command, a read-only results panel, a sidebar list of
what's been remembered lately, a review queue for AI-flagged contradictions, a sync command, a proactive
check when a terminal command fails, and an `@nexusmem` participant in Copilot Chat. It talks to the same
MCP server ([`nexusmem mcp`](../README.md)) that Claude Desktop, Cursor and Windsurf already use against
this codebase — no new server-side surface for search, sync or live detection, just a client for the
existing one (plus three new tools: `list_recent_memory` for the sidebar, and
`list_stale_suggestions`/`resolve_stale_suggestion` for the review queue).

![A command fails in the integrated terminal; NexusMem recognizes it and notifies "NexusMem has seen \"npm whoami\" fail before."](screenshot-notification.png)

*Live terminal-failure detection: `npm whoami` fails, and NexusMem — recognizing this exact command
has failed and later been fixed before, from this repository's own history — says so immediately.*

## Requirements

- [NexusMem](https://www.npmjs.com/package/nexusmem) installed and on `PATH`:

  ```bash
  npm install -g nexusmem
  ```

- The repository needs to be initialized and synced at least once before there's anything to search or
  list — either from a terminal (`nexusmem init && nexusmem sync`) or with **NexusMem: Sync Memory**
  below, which does both.

## Usage

1. Open a folder that is a NexusMem-tracked git repository.
2. Run **NexusMem: Search Memory** from the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
3. Type a free-text query (e.g. `why did npm whoami fail`). Results open in a panel beside the editor:
   the packed, token-budgeted context block NexusMem would hand an agent, plus match/token stats.

![Search results panel for the query "why did npm whoami fail," showing match/token stats and the packed context block, including the earlier README/source-file usage sections that reference the same query.](screenshot-search.png)

### Sync

**NexusMem: Sync Memory** (command palette, or the ↻-adjacent sync button in the sidebar's title bar)
ingests new git/diff/shell/docs (and, if enabled, conversation and github.com issue/PR) history and
embeds it — the same as running `nexusmem sync` in a terminal, without leaving the editor. Initializes
the repository first if it hasn't been already. The
summary goes to the **NexusMem** output channel (a toast offers to open it); the sidebar refreshes
itself afterward automatically.

### Recent Memory sidebar

The Explorer view (`Ctrl+Shift+E` / `Cmd+Shift+E`) gains a **NexusMem: Recent Memory** panel: the most
recently remembered items for the open repository, newest first — chronology, not a search. Click a
row to search for it (pre-fills the query above with that item's title). Refresh with the ↻ button in
the panel's title bar; it also loads once automatically when the extension activates.

### Memory Review sidebar

A second Explorer view, **NexusMem: Memory Review**, lists open contradiction suggestions — cases where
`nexusmem stale --check-contradictions` (or a normal sync's own automatic leg) found a newer node the
local SLM judged as contradicting an older one. Each row shows both nodes and the model's reason, with
two inline buttons: a checkmark to **accept** (writes the same supersede link `nexusmem mark-stale`
would — the ranker down-weights the old node but never deletes it) and an **✕** to dismiss (silences the
suggestion without touching ranking). Refresh with the ↻ button in the panel's title bar.

### Chat Participant

Ask about this repository's remembered history directly in Copilot Chat (or any client implementing VS
Code's chat participant API) — type `@nexusmem` followed by a question, no command palette or MCP setup
required. Retrieves the same packed context block **NexusMem: Search Memory** uses, then asks the chat
panel's own currently-selected model to answer your actual question from it, streamed back as a real
synthesized answer rather than the raw retrieved block.

### Live terminal-failure detection

When a command in an integrated terminal exits non-zero, NexusMem checks its memory for that command in
the background. If there's a match (e.g. a past run of the same command that later succeeded, or a
related fix), a notification offers **Show details**, which opens the same results panel as a manual
search. Silent when there's no match — this is meant to surface something genuinely useful, not to
comment on every failed command.

Depends on [VS Code's terminal shell integration](https://code.visualstudio.com/docs/terminal/shell-integration)
actually being active for your shell (the status bar / a colored bar next to the prompt is the usual
tell). If it isn't, this feature quietly does nothing rather than erroring — everything else in this
extension still works.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `nexusmem.cliPath` | `nexusmem` | Executable used to launch the MCP server (`<cliPath> mcp`). Set to an absolute path if `nexusmem` isn't on `PATH` (e.g. a local build). |
| `nexusmem.liveFailureDetection.enabled` | `true` | Check NexusMem's memory when a terminal command fails, and notify if it finds something. |

## Development

```bash
npm install
npm run typecheck
npm run compile   # -> dist/extension.js
npm test          # vitest; the stdio integration test builds the root NexusMem CLI first
```

Then, from VS Code, open this folder and press `F5` to launch an Extension Development Host.
