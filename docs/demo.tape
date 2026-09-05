# Recording script for the README/website demo GIF.
#
#   vhs docs/demo.tape          # needs vhs + ttyd + ffmpeg (WSL / Linux / macOS)
#
# Runs against a throwaway database so the recording never touches a real index.

Output docs/demo.gif

# --- Frame ------------------------------------------------------------------
# The window bar and the inset margin are what separate this from a screen
# capture: the GIF reads as a picture of a terminal rather than a piece of one.
Set WindowBar Colorful
Set WindowBarSize 40
Set BorderRadius 12
Set Margin 60
Set MarginFill "#171320"
Set Padding 28

# --- Type -------------------------------------------------------------------
# FontFamily is a request, not a guarantee: VHS falls back silently to whatever
# the recording box has, so install the font there or the GIF ships in DejaVu.
Set FontFamily "JetBrains Mono"
Set FontSize 20
Set LineHeight 1.4
Set Theme "Catppuccin Mocha"

# --- Motion -----------------------------------------------------------------
# A blinking cursor costs frames all through the idle Sleeps and buys nothing.
#
# The recorder has a hard ~30s ceiling (750 frames at the 25fps it renders
# GIFs at) that isn't documented anywhere -- the tape simply stops mid-action
# once it's hit, with no warning. Every Sleep below is sized so the whole
# script finishes with room to spare, payoff included.
Set TypingSpeed 35ms
Set CursorBlink false
Set Width 1200
Set Height 760

# No LoopOffset: GitHub plays a README GIF from frame one on first view, and
# that first view is the only one that matters. Shifting the loop boundary
# for a nicer *repeat* (tried at 85% here before) means the first thing a
# visitor sees is the query answer with no context -- worse, not better.
# Start at `nexusmem init` like the tape does.

# --- Story --------------------------------------------------------------
# The 7-beat pitch this recording tells, and which real command carries each
# beat (there's no separate "open Claude Code" shot -- Claude Code calls the
# same sync_project/search_memory MCP tools that `nexusmem sync`/`query` wrap,
# so the CLI output IS what the agent would see):
#   1-2. clone + install NexusMem  -> hidden setup below, narrated not shown
#   3.   sync_project              -> `nexusmem sync --github` (real, live)
#   4-6. ask about the past,
#        NexusMem retrieves context -> `nexusmem query ...` (real, live)
#   7.   the agent answers          -> that query's own printed output

# Setup is recorded but not shown: clean db, quiet prompt, no git noise.
# The prompt is hardcoded rather than starship on purpose -- a prompt that
# renders the current branch makes the recording differ run to run.
Hide
Type "export PATH=$HOME/bin:$HOME/npm-global/bin:$PATH" Enter
Type "export NEXUSMEM_HOME=$(mktemp -d)" Enter
Type `export PS1='\[\e[38;5;141m\]❯\[\e[0m\] '` Enter
# NEXUSMEM_HOME only redirects the user-scoped registry (~/.nexusmem); the
# per-repo state `init`/`sync` actually write lives in ./.nexusmem next to
# whatever's checked out, independent of that env var. If a clone this tape
# runs against already has one -- e.g. copied in alongside a real working
# tree -- `init` prints "already initialized" instead of creating one, which
# breaks the first-run story this recording is telling. Force it clean.
Type "rm -rf .nexusmem" Enter
Type "clear" Enter
Show

Sleep 0.6s

# Beats 1-2 (clone + install) already happened in the hidden setup above --
# narrated here rather than replayed live: a real `git clone` + `npm install
# -g nexusmem` cost 10-20s of real network/registry time on their own, which
# leaves no budget left for the two beats that are actually the payoff.
Type `# 1-2. clone + install NexusMem` Sleep 300ms Enter
Sleep 300ms

Type "nexusmem init" Sleep 300ms Enter
Sleep 0.8s

# Sync is real, not staged -- whatever it prints here is this repo's own
# history, indexed live during the recording. --github pulls this repo's own
# real issue/PR threads via the `gh` CLI (v0.10.0's new opt-in source) --
# the "14 github thread(s)" in the summary line is real, not a mock count.
Type `# 3. sync_project -- real history` Sleep 300ms Enter
Sleep 300ms
Type "nexusmem sync --github" Sleep 300ms Enter
Sleep 7.5s

# A typed comment, not a caption burned into the frame -- it stays honest
# about being a real terminal and still tells the viewer what to expect
# from the next line before they read its output. Kept short: every typed
# character eats into the ~30s budget above.
#
# Deliberately avoids echoing the query's own words here: this tape's own
# diff becomes a real commit in this repo once pushed, and a comment
# containing the query's own keywords turns this recording into one of its
# own search results the next time someone re-records it. Learned that the
# hard way -- an earlier take of a different query put docs/demo.tape itself
# into the answer below.
Type `# ask about the past -- a real issue + PR it shipped` Sleep 300ms Enter
Sleep 300ms

# This specific query is the payoff: it's a genuine issue this project's own
# maintainer opened, picked up and closed by PR #14 -- from an actual outside
# contributor (@Amir-A664), not the maintainer. One query, one ranked answer,
# spanning a github_thread issue, a github_thread PR, two commits and the
# CHANGELOG entry they landed -- four different sources, one story.
# The printed answer below is beat 7 -- there's no separate "agent answers"
# shot, this output is what an agent grounds its answer in.
Type `nexusmem query "warn about stale project identities" --budget 550` Sleep 300ms Enter
Sleep 7s

Sleep 0.6s
