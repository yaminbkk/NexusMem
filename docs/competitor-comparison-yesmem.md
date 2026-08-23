# NexusMem vs. YesMem

**Status:** written 2026-08-23, against `carsteneu/yesmem` as it existed that day (public README plus
`gh api` metadata — README/metadata depth, not the full-source-read depth of the
[projectmem comparison](competitor-comparison.md), since YesMem's Go source hasn't been cloned and read
line by line the way projectmem's Python was). Re-check before quoting this later.

YesMem is the closest architectural match to NexusMem found so far: same bet on local-first SQLite plus
RRF fusion of BM25 and vector search, no cloud, no account. It's also a real, active project — 39 stars,
active commits through mid-August — not a strawman. This document exists to check specific claims against
each project's own public state, not to declare an overall winner.

## Scale, as of 2026-08-23

| | NexusMem | YesMem |
|---|---|---|
| GitHub stars | 10 | 39 |
| Forks | 4 | 7 |
| Language | TypeScript | Go |
| License | MIT | Apache 2.0 |
| Created | 2026-08-08 | 2026-04-09 |
| Install | `npx nexusmem init` | install script / release binary |

YesMem is ahead here, roughly 4x the stars and four months older. Same disclosure as the projectmem
document: nothing below should be read as "NexusMem is winning" — it's about which specific claims hold up.

## Windows: native vs. WSL2-required

YesMem's own README is explicit about this: it runs natively on Linux and macOS, but on Windows the
documented path is installing Claude Code inside WSL2 and running the Linux binary there — its own words
are that native Windows support "is not available yet." Its daemon/proxy/hook model is built on Unix
sockets, which is why a compatibility layer is required at all on Windows.

NexusMem runs natively on Windows with no compatibility layer:

- `npx nexusmem` / `npm install` work directly — `package.json` sets no `os` restriction, and its one
  native dependency (`better-sqlite3`) ships a prebuilt Windows binary, so there's no WSL, no Linux
  binary, no second OS environment to stand up.
- This isn't just "should work" — the README's own Status line states its 701-test suite runs on
  **both** Linux and Windows, across Node 22 and 24, in CI. Windows support is continuously verified,
  not asserted.
- It goes deeper than the package installing cleanly: the shell-history collector itself was built
  Windows/PSReadLine-first (`src/shell/detect.ts`, `src/shell/paths.ts`), not bolted on after a
  Unix-first design. Bash and zsh parsing exist alongside it, but Windows was the first-class target,
  not an afterthought.

For a developer whose primary box is Windows, this is a real, current, asymmetric gap: NexusMem installs
and runs in one step; YesMem's own documentation requires setting up a second Linux environment first.
WSL2 is mature and well-supported, so this isn't a dealbreaker for most Windows developers — but it is an
extra layer YesMem's own README asks for and NexusMem's does not.

## Architecture overlap: not a differentiator either way

Both are local-first, both store in SQLite, both fuse BM25 and vector search via RRF (YesMem: 512-dim
embeddings; NexusMem: `sqlite-vec`). This was already established in an earlier check of YesMem's
README and isn't repeated here as if it were new — flagging it so this document doesn't read as if the
retrieval method were a NexusMem-only idea. It isn't, for either project.

## Decay & provenance: automatic-acting vs. automatic-suggesting

YesMem ships a 4-tier trust hierarchy plus Ebbinghaus turn-based decay plus automatic supersede chains —
fully automatic, no human step. NexusMem's 4-tier provenance (`observed` > `authored` > `recorded` >
`derived`) now runs contradiction checking automatically on every `sync`, closing the "manual trigger"
half of the earlier gap — but it only **suggests** a possible contradiction; it never auto-supersedes.

This is a disclosed design choice, not an unfinished feature: an LLM producing a false-positive
auto-supersede was judged a worse failure mode than a stale item sitting flagged for a human to review.
Automatic-acting and automatic-suggesting are different tradeoffs, not a strictly-better/worse pair —
noted honestly rather than claimed as a NexusMem win.

## Code graph: rough parity, unread depth

NexusMem's import graph now covers seven languages (JS, TS, Python, Go, Rust, Java, PHP). YesMem's
README lists six for its own `search_code_index` (Go, Python, TypeScript, Java, PHP, Rust) — call it
parity in breadth. Neither side's per-language resolver has been read against the other's the way
projectmem's `_python_relationships` was read in full for the other comparison document, so no claim is
made here about which side resolves more completely within a shared language. That would need an actual
source read, not a README count, to say honestly.

## What this document is not

Not a claim that NexusMem is ahead overall — YesMem has roughly 4x the stars, four more months of
history, and ships things NexusMem doesn't attempt at all (an OpenAI-compatible proxy, cross-device sync
via what its README calls a "live ledger"). This is a source-level record of specific, checked claims as
of one date, at README/metadata depth for YesMem specifically rather than the deeper full-source read the
projectmem comparison used. Re-verify before repeating any number here — YesMem in particular pushes
often enough that this can go stale fast.
