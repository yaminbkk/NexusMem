# Changelog

Notable changes to the NexusMem VS Code extension. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-08-30

### Added

- **NexusMem: Memory Review sidebar** — lists open contradiction suggestions (from
  `nexusmem stale --check-contradictions`, or sync's own automatic leg) that nothing has acted on yet.
  Each row shows the older, likely-stale memory and which newer node the local SLM judged as
  contradicting it, with two inline buttons: a checkmark to accept (writes the same supersede link
  `nexusmem mark-stale` would) and an X to dismiss (silences the suggestion without touching ranking).
  Backed by two new MCP tools, `list_stale_suggestions` and `resolve_stale_suggestion`, on the root
  project's server. Accepting refreshes the Recent Memory sidebar too, since ranking just changed.

## [0.1.1] — 2026-08-29

No functional changes. `package.json`'s description, `README.md` and a `mcpClient.ts` doc comment
updated to mention the root project's new (opt-in) `github` issue/PR source, matching NexusMem
`v0.10.0`; the icon-coverage test's node-kind list was missing the new `github_thread` kind too.

## [0.1.0] — 2026-08-15

First real version. Every piece of the extension's original MVP plan, built and live-verified against
a real NexusMem-tracked repository in an actual VS Code window — not just unit tests below the
`vscode` API boundary.

### Added

- **NexusMem: Search Memory** — free-text search over a repository's remembered history (git commits,
  diffs, shell commands, docs, conversations), from the command palette. Results open in a read-only
  webview panel: the same packed, token-budgeted context block NexusMem would hand an agent.
- **Recent Memory sidebar** — an Explorer view listing the most recently remembered items for the open
  repository, newest first. Click a row to search for it. Backed by a new `list_recent_memory` MCP
  tool on the server side.
- **Live terminal-failure detection** — when a command in an integrated terminal fails, checks
  NexusMem's memory in the background and, if it finds a past failure/fix for that exact command,
  shows a notification. Silent when there's no match. Depends on VS Code's terminal shell integration
  being active for your shell.
- **NexusMem: Sync Memory** — ingest new history and embed it from within the editor, without a
  terminal. Reachable from the command palette or a button in the sidebar's title bar; refreshes the
  sidebar automatically afterward.

### Fixed

- `sync_project`'s summary no longer contains raw ANSI color codes on Windows — found live via this
  extension's own Output channel, fixed at the source in NexusMem's MCP server (affects every MCP
  client, not just this extension).
