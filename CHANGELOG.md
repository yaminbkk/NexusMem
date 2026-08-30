# Changelog

Notable changes per published version. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Tags were added retroactively on 2026-08-11 and point at the exact commits the npm tarballs were
built from, matched by publish timestamp: `v0.1.0` → `67a4776`, `v0.1.1` → `809e62c`,
`v0.1.2` → `b22a3b0`.

## [Unreleased]

No unreleased changes yet.

## [0.10.1] — 2026-08-30

### Added

- `nodes.retrieved_count`/`nodes.last_retrieved_at` (schema V12): retrieval outcomes are now recorded
  instead of silently discarded. Bumped once per completed `nexusmem query`/MCP `search_memory` call,
  for every node actually packed into the returned context (both CLI and MCP share one pipeline, so
  both are covered from a single call site). Not yet folded into `rank.ts`'s score formula — every
  existing ranking factor was tuned against real dogfooded queries and validated with `npm run eval`
  before being trusted, and a new factor needs the same treatment. This release is the instrumentation
  half only; confirmed eval-neutral (MRR 0.943 / Recall@5 0.964, unchanged).

### Fixed

- `nexusmem precheck`'s "What already failed here" warning implied the failure was located in the
  flagged file, but the match is against basename word-tokens (`tokensForFile`) — a failing `npm run
  precheck` flagged every file whose name contained that word, not just the one actually responsible.
  Reworded to state what's actually true ("commands naming this file failed").
- The high-churn warning in `nexusmem precheck` was rendered as a `WARN`, the same severity as the
  dogfooded failure-correlation warning, despite `HIGH_CHURN_THRESHOLD` being an admitted, untuned
  guess. Demoted to a lower-severity `note`, explicitly labeled as an untuned heuristic, so it no
  longer reads as equally trustworthy.

## [0.10.0] — 2026-08-29

### Added

- New opt-in `github` source: `sources.github.enabled`, `nexusmem scan-github`, `sync --github`.
  Reads issue/PR threads (title, body, comments) from this repo's github.com remote via the `gh`
  CLI, one `github_thread` node per thread. First source with a real external dependency (needs `gh`
  installed and authenticated) rather than reading only what's already on disk; a missing remote or
  an unreachable `gh` is a silent no-op, matching how an unreachable Ollama degrades elsewhere.

## [0.9.1] — 2026-08-29

Three ranking/retrieval correctness fixes, found and validated against a new 28-case retrieval-quality
eval harness (`npm run eval`, dev-only, not part of the published package).

### Fixed

- `nodes_vec` (vector search) over-fetched `k` globally, then filtered by `project_id` after the join —
  a heuristic, not a guarantee. A sparse project sharing `memory.db` with a much larger one could have
  every true nearest neighbour fall outside the over-fetch window and get silently dropped (reproduced:
  495 rows in one project + 5 in another, global `k=50` surfaced 0 of the 5). Schema V11 gives `nodes_vec`
  a `PARTITION KEY` on `project_id` (`sqlite-vec` 0.1.9+), pushing the equality filter into the k-NN
  search itself so cross-project exactness is now guaranteed, not probable. Migrates existing databases
  automatically on next `sync`/`query`. `--as-of` date filtering still over-fetches — only the
  `project_id` dimension was ever a correctness guarantee.
- `MAX_PRIOR_OVERTURN` (the cap on how far a recency/signal prior may overturn relevance) raised
  `2 → 2.4`, the highest value that both improves eval MRR (0.924→0.943) and still passes every legacy
  regression test guarding against the original same-day-fix-commits bug this constant exists to bound.
- A commit's `code_diff` siblings (one node per changed file, all sharing the same `ts`) could crowd a
  packed result and bury that commit's own `git_commit` node — its answer — several ranks down. Now
  capped per commit, matching the existing `conversation_turn`/`doc_section` family cap.
- `package.json`/`tsconfig.json` diffs were ranking above more relevant results when a changed file's
  path happened to echo its commit's conventional-commit scope (title is weighted 10x body, so the scope
  word counted twice). Down-weighted as mechanical wiring, same reasoning `TEST_PATHS` already applies to
  tests. Only affects nodes ingested from here on — existing manifest/config diffs need `sync --rebuild`
  to get the corrected signal retroactively.

## [0.9.0] — 2026-08-27

Closes the three remaining mechanisms from a recurring external review (Simon Strandgaard, Agent
Memory Atlas): trust_state, bi-temporal reads, and a dismiss verb for standing suggestions. Also
fixes two real Windows-specific correctness bugs found dogfooding.

### Added

- `nodes.trust_state` (`candidate` | `verified` | `rejected`, schema V10) and `nexusmem review
  <nodeId> --verify|--reject`: a human verdict on a node, independent of the SLM contradiction
  checker. `--reject` down-weights ranking (harsher than the existing supersede penalty, since a
  human said no directly); `--verify` is a label only, no ranking boost. Both render as a tag in
  packed context. Never deletes — same demote-not-delete rule as `mark-stale`.
- `--as-of <date>` on `nexusmem query` and the MCP `search_memory` tool: restricts both the BM25
  and vector arms to nodes recorded at or before that instant via `created_at` (record time),
  independent of how old the events themselves (`ts`, event time) are. Read-only — there is no
  equivalent write, and nodes stay write-once.
- `nexusmem stale --dismiss`: silences a contradiction suggestion the user disagrees with, without
  fabricating a `supersedes` relationship. Previously a wrong `--check-contradictions` verdict had
  no way to be rejected — it re-decorated every future `stale`/`sync` run forever.
- `--prune-source`/`--prune-stale-shell` now record a `mutation_audit` row on their `--yes` path,
  matching what `forget` already did. The dry-run preview stays a pure read.

### Fixed

- `git rev-parse` failures reported as "error launching git: Access is denied." (Git for Windows'
  launcher shim failing to exec `git.exe` under handle/AV contention) were treated as git's own
  verdict instead of a transient spawn failure, turning a one-off environment hiccup into a hard
  failure. Now retried the same as the other known transient-spawn classes.
- The PowerShell prompt hook read only `$LASTEXITCODE`, which cmdlets (`Remove-Item`, `Copy-Item`,
  …) never set — every failing cmdlet was silently logged as a success, and a stale
  `$LASTEXITCODE` from an earlier native command could misattribute to later successful cmdlet
  runs. Now reads `$?` alongside `$LASTEXITCODE`, before anything else can overwrite `$?`.

## [0.8.0] — 2026-08-22

### Added

- Provenance widened from 2 tiers to a 4-tier trust hierarchy: `observed` (commits, diffs, shell
  exit codes) > `authored` (doc sections — human-written claims) > `recorded` (conversation turns —
  verbatim discourse) > `derived` (session summaries — a model's distillation). Schema V7 backfills
  existing databases by kind. The ranker decays each tier at its own rate (lower trust fades
  faster); the ordering is the design claim, the exact ratios are documented judgment calls.
- Contradiction checking now runs automatically during `sync`: at most 3 new SLM judgments per run
  (`contradictions.maxPerSync`; `contradictions.autoCheck: false` turns it off), gated on the
  embedding provider already being reachable. Every judgment — either verdict — is memoized in a new
  `contradiction_checks` table (schema V8), so a judged pair is never sent to the model again and
  repeat syncs converge to zero model calls. Measured live against this repo's own database: 5.4s
  for the first 10 judgments, 0.5s for the identical re-run. Still suggest-only: nothing ever writes
  `supersedes` automatically.
- Standing suggestions now surface everywhere without a model in the loop: plain `nexusmem stale`
  decorates flagged candidates from the memoized judgments (instant, offline), `nexusmem status`
  gains a `flagged` line, and the sync summary reports new/open suggestion counts.
- `stale --check-contradictions` reuses each candidate's stored embedding instead of re-embedding
  it, and stops after two consecutive null SLM replies so a down provider costs at most two timeouts
  rather than one per candidate.

## [0.7.0] — 2026-08-21

### Added

- `nexusmem stale --check-contradictions`: for each stale candidate, finds the most similar newer
  node (local embedding search) and asks a local SLM (Ollama, `qwen2.5:3b` by default) whether it
  actually contradicts the older one, instead of only surfacing by age. Suggest-only — nothing is
  written, same as plain `stale`. Live-dogfooded against this repo's own real database and Ollama
  instance; found and fixed a real gap along the way (below) before the feature surfaced anything
  useful.
- Import graph: bare Python imports with no leading dot (`import foo`, `from foo import bar`)
  now resolve to a same-directory sibling file too, alongside the existing relative-dot support.
  Found dogfooding two real local projects: neither used a single PEP 328 relative import, both
  relied entirely on this flat-script style. Guarded by a static list of stdlib module names so a
  bare `import os`/`import queue`/etc. is never mistaken for a same-named local file.

### Fixed

- Import graph: a Java wildcard import (`import a.b.*;`) no longer merges files from two
  unrelated packages that happen to share a directory-name suffix (e.g. two Gradle/Maven modules
  each with their own `.../foo`) — it now refuses to guess, same as the single-class-import case.
- `stale --check-contradictions`'s neighbor search now looks past same-timestamp sibling nodes
  (e.g. the many chunks one long conversation gets split into) to reach genuinely newer content.
  Found live-dogfooding against this repo's own database: the first real candidate's closest 15
  neighbors were all same-conversation siblings sharing its exact timestamp, so the original
  5-neighbor default silently found zero suggestions for every candidate, regardless of what the
  SLM would have said.

## [0.6.0] — 2026-08-20

### Added

- Ranker: `inferred` nodes (summaries, doc snapshots) now decay twice as fast as `observed` ones
  (git commits, diffs, shell commands) for retrieval purposes. A judgment call, not a measured
  optimum — see `INFERRED_HALF_LIFE_RATIO` in `src/retrieval/rank.ts`.
- `nexusmem stale`: lists aging `inferred` nodes nothing has superseded yet, as candidates for
  `mark-stale`. A heuristic on age and provenance, not real contradiction detection — writes nothing.
- `nexusmem status` now surfaces an `aging` line with the stale-candidate count when any exist.
- Import graph: Python relative imports (`from .foo import bar`, `from . import x`) now produce
  file edges too, alongside the existing JS/TS support. Absolute Python imports are still skipped —
  same "missed edge over wrong edge" reasoning as JS/TS's bare-specifier skip.
- Import graph: Go internal imports (resolved against `go.mod`'s module path, one edge per
  non-test file in the imported package) and Rust `mod foo;` declarations (2018+ edition module
  layout) now produce file edges too. External Go imports and Rust `use` paths are out of scope for
  the same reason.
- Import graph: Java imports (`import a.b.C;` / `import a.b.*;`, resolved by unambiguous suffix
  match against the tracked source tree) and `__DIR__`-anchored PHP `require`/`include` now produce
  file edges too — all six of `nexusmem scan-structure`'s tracked languages. `import static`, PHP's
  autoloaded `use Namespace\Class;`, and any unanchored PHP include are out of scope for the same
  "missed edge over wrong edge" reason as everywhere else in the import graph.

## [0.5.4] — 2026-08-20

### Added

- `nexusmem status --share`: a plain-text, no-color summary (node count, failure→fix chains
  linked, days of history) meant to be pasted somewhere, not scraped by a script.

## [0.5.3] — 2026-08-19

No functional changes to the CLI, MCP server, or published package -- a test-coverage and
CI-reliability pass.

### Verified

- **Closed 15 genuine test-coverage gaps**, found by grepping for real call sites in `tests/`
  rather than guessing from filenames (an Explore agent found the first 7; the rest by hand the
  same way). All 7 `scan-*` CLI subcommands (`scan-git`/`diff`/`shell`/`docs`/`conversation`/
  `structure`/`session`) had zero coverage -- `tests/cli-scan.test.ts`'s name was misleading, it
  only pinned `cli/format.ts`'s shared helpers. Also closed: `runStatus`'s report body beyond the
  stale-identity branch, `runQuery`, `forget --import`'s dry-run preview path, `shell/detect.ts`'s
  zsh scraping and hook-log `repoRoot` scoping, `openAllProjectSources`'s `unreadable` branch,
  `cli/context.ts`'s `loadContext`, `store/fts.ts`'s `toStrictMatchQuery`/`significantTokens`,
  `list_recent_memory`'s MCP `structuredContent` at the protocol level, `structure/resolve.ts`'s
  `.mjs`/`.cjs` rewrite, `docs/read.ts`'s `include` option, and `git/log.ts`'s `buildLogArgs`. Test
  suite: 559 → 592 tests.

### Fixed

- **A real test-isolation bug: a test could scrape a developer's actual shell history into a
  throwaway test database.** `tests/setup.ts` isolated `NEXUSMEM_HOME` (so a test `sync()` can't
  pollute the real `~/.nexusmem/projects.json` registry -- fixed 2026-08-15 for the same reason)
  but never isolated `APPDATA`/`HISTFILE_BASH`/`HISTFILE`, so any test running a real `sync()`
  scraped whatever PSReadLine/bash/zsh history actually exists on the machine running the suite.
  Observed directly: a new test here ingested 300 real `shell_command` nodes off this machine's
  own history before the fix. Now isolated the same way as the registry.
- **CI failed (deterministically, all 4 jobs) on 4 assertions that assumed adjacent words in
  colorized CLI output stay contiguous.** GitHub Actions' runners don't have `NO_COLOR` set the
  way this project's local dev shells apparently do, so `picocolors` emits real ANSI codes there --
  a regex like `/git\s+last run/` breaks when an escape sequence sits between a padded label and a
  separately-colored value. `tests/forget.test.ts` already carries a `stripAnsi()` helper for
  exactly this trap; applied the same fix to the 4 newly-added test files that had it. Verified by
  reproducing the CI failure locally with `FORCE_COLOR=1` before the fix, then re-running the full
  592-test suite under `FORCE_COLOR=1` after, to check for any other latent instance.

## [0.5.2] — 2026-08-18

### Added

- **`nexusmem mark-stale <nodeId> --supersedes <newNodeId>`, `provenance`, and manual staleness
  tracking.** A pre-Show-HN pass answering a public critique that this couldn't tell an observed
  fact from a guess, or retire a stale conclusion. Every node now carries `provenance`
  (`observed`/`inferred`, set per-collector: git commits, diffs, and shell commands are `observed`;
  conversation turns, session summaries, and doc sections are `inferred`) and an optional
  `supersedes` link. `mark-stale` writes that link; the ranker applies a flat down-weight to whatever
  it points at, but never deletes it -- the old node stays queryable, just usually loses to its
  replacement. `provenance` is shown as a `[observed]`/`[inferred]` tag on every query result (CLI
  and MCP `search_memory` share the same renderer). This is deliberately not automatic: nothing
  detects staleness on its own, a human or agent still has to notice the contradiction and run the
  command. See the README's new "Manual staleness & provenance" section.

### Verified

- **`forget` does not leak through vector search.** Checked whether `MemoryStore.forget` excludes a
  tombstoned node from `sqlite-vec` results only via a query-time filter (which every vector query
  path would need to apply consistently) or by deleting the embedding row outright. It already does
  the latter -- `dropEmbedding` runs before the node row is deleted, in the same transaction, on both
  query paths (`runHybridQuery` and `runCrossProjectQuery`, which both call the same
  `MemoryStore.vectorSearch`). No fix was needed; added a regression test
  (`tests/vector.test.ts`) that forgets an embedded node and asserts both `vectorSearch` returns
  nothing and the `nodes_vec` row count drops to zero, so this can't silently regress.
- **`forget` survives `sync --rebuild`.** This was the point of v0.5.0 and was already covered
  end-to-end in `tests/forget.test.ts`. Added a lower-level `tests/store.test.ts` case pinning the
  exact mechanism: `clearProject` (what `--rebuild` calls before re-ingesting) only touches
  `nodes`/`nodes_vec`/`sync_state`, never `deny_list`, so a re-ingest of the same content is denied
  again rather than resurrected.

## [0.5.1] — 2026-08-17

### Added

- **`nexusmem forget --export <path>` / `forget --import <path>`: carry a deny-list across a clone or
  restore.** `.nexusmem/` is gitignored by design, so `deny_list` never traveled with `git clone`/
  `git push` — confirmed live 2026-08-17 that a fresh clone of the exact same repo resurrected a value
  already forgotten elsewhere, with zero deny-list protection, because git history (what a fresh `sync`
  re-derives from) is fully portable while the deny-list that would have blocked it was not. `--export`
  writes the active entries to a plaintext JSON file (loudly warned as exactly as sensitive as the
  values it holds — never meant for git, moved through whatever secure channel the user already
  trusts); `--import` re-applies each new entry through `forget` itself, so an imported value is
  deleted from the new checkout's nodes too, not just blocked going forward. Same dry-run-by-default /
  `--yes` convention as the rest of `forget`. See `docs/forget-mechanism.md`.

## [0.5.0] — 2026-08-17

### Added

- **`nexusmem forget <value>`: permanent, value-keyed deletion.** The finer-grained complement to
  `sync --prune-source` (which only deletes at the whole-collector-source granularity): forgets one
  exact string or `--regex` pattern, deleting every node it currently matches *and* writing a
  standing deny-list entry so the value can never be re-ingested — closing the one gap an external
  source-level review flagged as its most serious finding: the append-only shell-hook log (and a
  full transcript re-read) are untouched by any prune, so `sync --rebuild` used to resurrect exactly
  what had just been deleted. Every removal leaves a hash-only tombstone (never the forgotten
  content itself — `body`/`title` are stored as sha256 only) and the whole operation writes one
  `mutation_audit` row, whether or not anything matched. Dry-run by default, matching
  `--prune-source`'s convention exactly; `--yes` confirms; `--list` shows active entries. Permanent
  in v0 — no `--remove`, matching the existing irreversible framing of `--prune-source`/`--rebuild`.
  See `docs/forget-mechanism.md`.

## [0.4.0] — 2026-08-16

### Added

- **`nexusmem status` now warns when prior project identities still hold nodes.** A renamed git
  remote can leave stale data under the old identity; status reports both the identity and node
  counts and points to `sync --prune-source <name>` instead of leaving that data discoverable only
  through a raw SQLite query.
- **`docs/competitor-comparison.md`: an honest, source-level comparison against `riponcm/projectmem`** (705
  GitHub stars vs. this project's 8, at time of writing) — a real, working competitor read in full (not
  judged from its README), covering where the two tools' failure-tracking, import-graph coverage, and
  token-savings claims genuinely differ. Cites a freshly re-run benchmark (`npm run bench`, not a stale
  table) alongside projectmem's own `pjm score` constants, read directly from its source. Linked from the
  README's `## What it costs you` section and a short website section near the existing stats.
- **`nexusmem hook git install|remove|status`: a real git pre-commit hook.** Installs a marked block into
  `.git/hooks/pre-commit` that runs `nexusmem precheck` (no `--strict`, so it can never block a commit on
  its own) before each commit — the automatic counterpart to the advisory `precheck` command. Refuses to
  touch a pre-existing foreign hook (husky, lint-staged, lefthook, ...) unless `--force` is passed, in which
  case it appends after the existing content rather than before, so the foreign hook still runs first and
  keeps deciding whatever it already decided. Idempotent (`nexusmem hook git install` twice is a no-op) and
  removable cleanly, including restoring a foreign hook to its original content if one was appended onto.
  Live-verified against a real scratch git repo on Windows: fresh install, a real `git commit` that
  triggered the hook and printed a correct precheck report, clean removal, and both the refuse-without-force
  and append-with-force foreign-hook paths.
- **`nexusmem precheck`: proactive pre-commit warnings.** Checks staged (or `--working`, or explicit `--files`)
  files against project memory and warns about unresolved past failures and high recent churn *before* you
  commit — advisory by default (always exits 0; `--strict` turns an unresolved failure into a non-zero exit).
  Matches a file's own basename tokens against still-unlinked `shell_command` failures (no
  `resolved_by:*` link from `sync --link-failures`), reusing `filterBoilerplateTokens` from the
  discussion-bridge heuristic — now exported and parameterized by node kind so it can be corpus-relative
  against `shell_command` history instead of only `conversation_turn`/`session_summary`. Churn is scoped to
  `git_commit`-kind `node_files` touches only, so it doesn't double-count the identical touches `code_diff`
  nodes also record. Deliberately does not yet install as a real git hook (see the module comment in
  `src/correlate/precheck.ts` for why capture-time `git status` diffing and past-commit correlation were both
  rejected) — that's a follow-up once this signal has been dogfooded.
- **JS/TS import-graph edges.** `nexusmem scan-structure` previews (and `sync` now ingests) file→file
  import relationships across a project's tracked `.ts`/`.tsx`/`.js`/`.jsx` files — a dependency-free
  regex extractor (`src/structure/extract.ts`) resolves relative `import`/`export ... from`/`require`/
  dynamic-`import` specifiers against the tracked-path set, correctly rewriting the common TS/ESM
  `./foo.js` specifier back to its real `foo.ts` source. Stored in a new `file_edges` table (schema
  v4), replaced wholesale on every sync since edges describe current tree state, not history. Surfaced
  as a `structure` line in `nexusmem status`; not yet wired into `query` ranking or exposed as an MCP
  tool — that's a follow-on design question, not this pass's job.

## [0.3.3] — 2026-08-16

### Added

- **`nexusmem status` now shows failure→fix chain counts** — `N/M failure(s) resolved (X retry, Y
  discussion)`, plus a hint to run `sync --link-failures` when failures remain unresolved. The
  chain feature is this project's most distinctive capability, but was previously invisible to
  anyone who didn't already know to query `node_links` directly. Backed by the new
  `getChainStats` in `src/correlate/failure-fix.ts`, which dedupes failures resolved by both
  heuristics rather than double-counting them.

### Fixed

- **Discussion-bridge heuristic (`sync --link-failures`): corpus-relative boilerplate tokens no
  longer produce false-positive failure→fix links.** Re-dogfooded at larger scale against a second
  real project's history: a command made entirely of words that saturate a project's own corpus
  (e.g. this repo's own name/verbs) could AND-match an unrelated turn that just happened to mention
  the same words, and bm25 score alone could not separate that from a true positive (measured: the
  false positive scored *stronger* than two real true positives). `filterBoilerplateTokens` in
  `src/correlate/failure-fix.ts` drops any token that appears in over 20% of a project's own
  `conversation_turn`/`session_summary` history before building the match query — measured against
  real data, not guessed — and skips the discussion-match attempt entirely (rather than falling back
  unfiltered) when every token turns out to be boilerplate, since a missed link is preferred over a
  false one for this heuristic. Below 10 discussable nodes the filter is skipped, since frequency
  isn't a meaningful signal yet on a young project.

## [0.3.2] — 2026-08-16

### Added

- **`mcpName` field in `package.json`**, required by the official MCP registry
  (registry.modelcontextprotocol.io) to verify that whoever publishes `server.json` under
  `io.github.yaminbkk/nexusmem` also controls the `nexusmem` npm package itself — the registry
  rejects a publish attempt otherwise. No behavior change for CLI/MCP users; this is purely a
  registry-ownership proof.
- **`list_recent_memory` MCP tool** — chronological listing of a repository's most recently
  remembered nodes (git commits, diffs, shell commands, docs, conversation, session summaries),
  newest first. Distinct from `search_memory`: no query, just "what has this project's memory
  recorded lately" — built for the VS Code extension's sidebar view, which lists rather than
  searches. Backed by `MemoryStore.listRecentNodes`, reusing the existing `idx_nodes_project_ts`
  index.
- **`sync --prune-source <name>` and `sync --prune-stale-shell`** — drop one source's nodes without a
  full `--rebuild`, which loses history that can't be re-read from disk (the shell tail window, older
  conversation turns). `--prune-stale-shell` is a shortcut for the three dead pre-hook shell-scrape
  sources (`shell:pwsh`, `shell:bash`, `shell:zsh`) at once. Dry-run by default — prints the matching
  count and does nothing until `--yes` is also given, since this is an irreversible full wipe of the
  named source(s), unlike `--rebuild`'s no-prompt full-project reset. Also sweeps any prior project
  identity of this same repo (the id a renamed git remote leaves behind after
  `fix(store): reconcile memory stranded by a changed git remote URL` migrates what it can) — a
  live-id-only prune could not reach nodes reconciliation deliberately left in place. Exposed on both
  the CLI and the MCP `sync_project` tool.
- **Discussion-heuristic failure→fix chains now surface**, tightened to an AND-joined significant-
  token match instead of the original OR match. Re-verified against this repo's own real database:
  5/5 discussion links correct (was ~half wrong when it shipped unsurfaced in 0.3.0). Chains now
  follow across projects in `query --all-projects` too.

### Fixed

- **`sync_project`'s summary no longer contains raw ANSI color codes on Windows.** `runInit`/`runSync`
  format their output with picocolors for terminal display, and picocolors treats `platform ===
  'win32'` as sufficient evidence of color support on its own, without checking `isTTY` — correct for
  a real terminal, wrong for the MCP JSON-RPC channel, which is piped on every platform. Found live: a
  real MCP client (the VS Code extension's Output channel) rendered the raw escape codes as literal
  text instead of color. Stripped at the MCP boundary in `syncProject`, leaving the CLI's own terminal
  output untouched.

## [0.3.1] — 2026-08-15

### Added

- **`scripts/benchmark.ts` (`npm run bench`) — a reproducible end-to-end token-saving benchmark.**
  Compares `packed.tokensUsed` against two baselines (full-file-read and `git log -p`) for the same
  files a query's packed nodes touch, over a query set derived mechanically from the corpus itself
  rather than hand-picked. Used to measure the README's `## What it costs you` numbers against both
  this repo (62 commits) and a 9,567-commit external corpus (`vitejs/vite`) — see README for the
  numbers and their methodology caveats.

### Fixed

- **A generic 2-3 letter local model title, "id" as a search token, and one node's chunks flooding a
  result set — three ranking/retrieval edge cases found by dogfooding, each verified with a red test
  before the fix.**
  - Session-summary titles: the local model sometimes wrote a role-framing line ("Role: Lead Systems
    Engineer...") instead of a summary, in Thai and English alike. The existing generic-title filter
    didn't catch either language, since it only matched English words like "summary"/"update".
  - Search: the token `id` alone was prefix-matching unrelated shell commands like
    `winget install --id ...`, because every query token was OR-ed with no floor and no stopword
    list, and bm25 gives a rare-but-generic token an inflated score purely from scarcity.
  - Packing: `conversation_turn` and `doc_section` both chunk one reply or file into several nodes
    sharing the same timestamp; up to 2 may now appear in one packed result, down from unlimited.

- **A repo's memory could silently split in two if its git remote URL ever changed** (a GitHub
  account rename, an org transfer). Project identity is derived from the remote URL on purpose — so
  the same repo re-cloned to a new path or machine keeps sharing memory — but a changed URL on the
  *same* path minted a new id and stranded every node synced under the old one, invisible to
  `status`/`query`/MCP from then on. `sync` now detects a prior id already recorded in the repo's own
  database and reconciles it forward: recomputable node kinds (session summaries, hook-sourced shell
  history) are migrated under their correct new id and deduplicated against anything already synced;
  conversation turns, whose identity can't be recomputed, are reassigned in place. Git commits,
  diffs, and doc sections are left alone — a normal sync already re-derives them completely, so
  there is nothing to migrate.

## [0.3.0] — 2026-08-13

**Upgrade note.** The first `sync` after upgrading drops every stored embedding and rebuilds it.
This is not optional and it is not a bug: embeddings now come from Ollama's `/api/embed`, which
returns L2-normalised vectors, while the previous `/api/embeddings` did not — measured norms of 1.0
and 20.7 for the same input. `nodes_vec` ranks by Euclidean distance and records no per-row
provenance, so a corpus holding both would separate by scale rather than by meaning. `sync` says
what it dropped, nodes are untouched, and BM25 keeps working while the rebuild runs. On this repo
the rebuild was 833 nodes in one pass, inside a 9-second sync.

### Added

- **Session summaries via a local model** (`sources.session`, opt-in, off by default). Each
  finished session becomes one distilled `session_summary` node — decisions and their reasons —
  alongside the raw exchanges. Runs a local Ollama chat model (`qwen2.5:3b` by default); nothing is
  downloaded automatically and no transcript leaves the machine. New `scan-session` command, with
  `--dry-run` to print the exact prompt a session would produce without calling the model.
  Bounded three ways: a session must be quiet for `settleMinutes` (default 30) before it is
  eligible, the prompt is hashed so an unchanged session never reaches the model again, and
  `maxSessions` caps how many are summarized per sync. Every exchange is redacted before the model
  sees it, and the model's own output is redacted again before it is stored.
- **`sync --embed-limit <n>`** to cap the embedding pass, for when draining the whole backlog is not
  wanted.

### Changed

- **The embedding pass drains the backlog in one `sync`** instead of stopping after 200 nodes, and
  sends texts to Ollama in batches of 32 — measured at 4.21x the throughput of one call per node
  (20.3ms → 4.8ms per node, over 96 real nodes from this repo). Leaving it uncapped is safe because
  paging walks rowids monotonically, so a node the provider failed on is passed over rather than
  retried forever, and because three consecutive dead requests end the pass: an Ollama that is not
  running now costs three requests rather than one timeout per node.
- **Embeddings carry a provider identity.** Changing the embedding model, or upgrading from a
  release that recorded no identity, drops the vectors and re-embeds rather than ranking across a
  mixture.
- **Ranking priors now share one budget instead of getting one each.** `signal` and `recency` are
  query-independent, and each was separately capped at overturning a 2× relevance gap. The score
  multiplies them, so together they could overturn 4× — which is not a corner case but a description
  of every commit made during an active working day, fresh and high-signal at once. A query about the
  PowerShell hook returned two unrelated same-day `fix:` commits at ranks 3 and 4 while the section
  that answered it sat at rank 6. The 2× budget is now the bound on the priors *jointly*, split
  between them (`signal^0.215 × recency^0.288`, down from `^0.431` and `^0.576`), and a third prior
  would re-divide the same budget rather than enlarge it. Measured on four real queries against this
  repository's memory: the answering section rose in three of them — the rationale for "why BM25
  before vector search" went from rank 4 to rank 1 — and no query's correct top hit was displaced.

### Known limitation

- Session-summary *titles* depend on the model following a fixed output format, and a 3B model often
  does not. Measured over 14 real sessions, roughly a third came back usable; the rest were
  conversational preambles, stray bullets, or a bare "Summary of the Session". Those are rejected
  and the title falls back to the first line of the question that opened the session — always
  specific, not always elegant. Compliance was worst on long sessions and on transcripts not in
  English. `sources.session.model` takes a larger model if it matters.

## [0.2.0] — 2026-08-12

**Upgrade note.** Both new sources are on by default, so the first `sync` after upgrading an
existing project ingests the patches of its 200 most recent commits and starts recording the
repository in `~/.nexusmem/projects.json`. Set `sources.diff.enabled` to `false` in
`.nexusmem/config.json` if you would rather not, and `NEXUSMEM_HOME` relocates the user-scoped
directory. Nothing existing is rewritten or lost.

### Added

- **Diff-level nodes.** Commit patches are now indexed, one node per changed file, so a question
  about *what the change looked like* reaches the lines themselves rather than the commit message
  and a `+41/-6` summary. New `code_diff` kind, `diff` source, `scan-diff` preview command, and a
  `sources.diff` config block. Read by a second `git log --patch` walk with its own cursor: folding
  it into the existing `--numstat` walk would put patch text and numstat rows in one field, where a
  diff line reading `-1\t2\tfoo` is indistinguishable from a real file entry.
  Bounded on purpose — 200 commits on a first sync, 20 files per commit, no merges (their patch
  exists only in a combined format this parser does not read), and binaries, lockfiles and build
  output skipped. Patches are redacted with the shape-matching rules only; the key/value rule that
  serves prose would rewrite `const apiKey = process.env.SERVICE_API_KEY` into a redaction marker.
- **Cross-project recall.** `query --all-projects` (and `search_memory`'s `allProjects`) searches
  every repository NexusMem has been run in on this machine, tagging each result with the repository
  it came from. Databases stay per-repository — a shared global store was rejected for giving up the
  property that deleting one repo's `.nexusmem/` removes that repo's memory and nothing else — so a
  plain index at `~/.nexusmem/projects.json`, written by `init` and refreshed by `sync`, is what
  makes the others findable. New `projects` command lists it; `--prune` forgets entries whose
  database is gone. A stale or corrupt registry degrades the query, never fails it.
  Ranking fuses each project's list by rank (RRF) instead of comparing raw BM25 costs, which are
  computed against their own corpus and are not comparable across databases. The bias this leaves —
  every project's rank-1 hit is worth the same, so recall favours breadth — is documented rather
  than hidden.
- **Query-aware diff excerpts.** A packed summary is ~320 characters and a patch is thousands, so
  the packer now picks the hunk whose tokens match the query and starts the excerpt at the changed
  line. Found by dogfooding: "what flags are passed to every git invocation" retrieved the right
  file and then spent the whole summary on a class definition seventy lines above the answer.
  Matching splits identifiers on case and underscore boundaries, because `\bretry\b` does not match
  `RETRY_DELAYS_MS` and a natural-language question otherwise never meets the code it is about.
- `CHANGELOG.md` now ships inside the npm tarball. npm's always-included list covers `package.json`,
  `README` and `LICENSE` but not the changelog, so it previously reached GitHub readers only.

### Internal

- The test suite no longer writes to the developer's real `~/.nexusmem`. `sync` records the
  repository it ingested in the project registry, and the suite syncs temporary repositories in
  several places, so a green run left seven dead entries behind — found by running `nexusmem
  projects` after the fact, not by any test. `tests/setup.ts` now points `NEXUSMEM_HOME` at a
  throwaway directory for the whole suite, and one test fails if that guard is ever removed.
- `npm run smoke` drives the *packaged* artifact: build, pack, install into a throwaway directory,
  then run the installed CLI, an end-to-end ingest/query against a fixture repository, and an
  `initialize` handshake over real stdio. It also audits the manifest `npm publish` would send,
  which is a different artifact from the tarball. Both defects that ever reached npm users passed a
  green unit suite first; each is now pinned by a check verified to fail when the defect is
  reintroduced. Runs in CI on Linux and Windows as its own job.

## [0.1.2] — 2026-08-10

### Fixed

- `nexusmem --version` printed `0.1.0` on 0.1.1. The version string in `src/cli/index.ts` was a
  literal separate from `package.json`, and the 0.1.1 bump only touched the latter. `src/mcp/server.ts`
  had the same problem in its `McpServer` constructor, so an MCP client's `initialize` handshake
  would have reported the same stale version. Both now read the real version through
  `readOwnVersion()` in `src/core/version.ts`, which resolves `package.json` via `import.meta.url`.
  Found by running the published package end to end rather than trusting `npm publish --dry-run`
  and the registry API, neither of which executes a `--version` flag.

The ingestion and retrieval pipeline was never affected — only the two places that report a version
independently of running a command.

## [0.1.1] — 2026-08-10

### Changed

- README rewritten for someone deciding whether to read the source: what it does, how retrieval
  scores, what it costs, and where it breaks. `README.md` ships inside the package, so this is a
  real change to what npm delivers — but no code changed between 0.1.0 and 0.1.1.
- Documented the ranking flaw the tool found in itself, and the fact that the conversation source
  in the sample `status` output is opt-in rather than default.
- Dropped `&&` from the quickstart, which Windows PowerShell 5.1 cannot parse.

## [0.1.0] — 2026-08-10

First public release.

### Added

- **Collectors.** Git history (commit metadata and diff stats, not diff bodies), shell commands with
  exit codes via an opt-in PowerShell hook, tracked markdown docs via `git ls-files -- '*.md'`, and
  opt-in assistant transcripts.
- **Hybrid retrieval.** SQLite FTS5 BM25 and `sqlite-vec` KNN over 768-dim embeddings, fused with
  reciprocal rank fusion, then ranked by relevance against signal and recency priors and packed into
  an explicit token budget.
- **MCP server** over stdio (`nexusmem mcp`) exposing `search_memory`, `sync_project` and
  `get_status`, for Claude Desktop, Cursor, Windsurf and other MCP clients.
- **CLI**: `init`, `sync`, `query`, `status`, `mcp`, and `hook install|remove|status`, plus four
  dry-run previews — `scan-git`, `scan-shell`, `scan-docs`, `scan-conversation` — that write nothing
  and print the nodes ingestion would create with their signal scores.
- Content-addressed node ids (`sha256(projectId + kind + naturalKey)`), so `sync` is idempotent and
  two clones of one repository share a memory namespace.
- Everything stays on the machine: one SQLite database in WAL mode under `<repo>/.nexusmem/`.

### Notes

- Requires Node **>= 22**. `better-sqlite3` 12.11.1 publishes no prebuilt binary for Node 20 — its
  prebuilds start at ABI 127 — so a lower floor would have been a promise the package could not keep.
  Do not lower it without checking upstream prebuilds first.
- Not done at this release: diff bodies are not indexed, queries are scoped to a single project,
  there is no local-model summarization pass, and the conversation collector has never been audited
  for the stale-node bug that was found and fixed in the docs collector.

[Unreleased]: https://github.com/yaminbkk/NexusMem/compare/v0.10.1...HEAD
[0.10.1]: https://github.com/yaminbkk/NexusMem/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/yaminbkk/NexusMem/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/yaminbkk/NexusMem/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/yaminbkk/NexusMem/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/yaminbkk/NexusMem/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/yaminbkk/NexusMem/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/yaminbkk/NexusMem/compare/v0.5.4...v0.6.0
[0.5.4]: https://github.com/yaminbkk/NexusMem/compare/v0.5.3...v0.5.4
[0.5.3]: https://github.com/yaminbkk/NexusMem/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/yaminbkk/NexusMem/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/yaminbkk/NexusMem/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/yaminbkk/NexusMem/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/yaminbkk/NexusMem/compare/v0.3.3...v0.4.0
[0.3.3]: https://github.com/yaminbkk/NexusMem/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/yaminbkk/NexusMem/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/yaminbkk/NexusMem/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/yaminbkk/NexusMem/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/yaminbkk/NexusMem/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/yaminbkk/NexusMem/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/yaminbkk/NexusMem/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/yaminbkk/NexusMem/releases/tag/v0.1.0
