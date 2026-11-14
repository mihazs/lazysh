# Agent view load performance

Status: **baseline measured on one desktop host; nothing is measured on a phone yet.** Tracked by
[#1459](https://github.com/mihazs/lazysh/issues/1459). This page records the method, the fixture, the baseline and, after each
fix, the new numbers. It never states a number that was not measured: a missing measurement says so.

The question it answers: how long from tapping the Agent view to the latest messages on screen, and what costs that time.

## Budgets

| Budget | Where it is measured | Status |
| --- | --- | --- |
| First meaningful content (the latest messages) under 1 s on a LAN link after tapping the Agent view | Modelled SSH link, production bundle (below) | see [Results](#results) |
| Last-known content shown instantly (under 100 ms) while the refresh runs | Production bundle | not yet |
| No main-thread task above 50 ms during load | Chromium long tasks; 4x CPU throttle as a phone proxy (under 200 ms) | see [Results](#results) |
| 60 fps scrolling | Chromium frame intervals | see [Results](#results) |
| A streaming update costs O(changed rows) | React render counts | see [Results](#results) |
| Host read of a long session is O(window), not O(file) | Companion timings on the fixtures | not yet |

A real phone number is **still needed**: the WebView, the radio and the CPU of the device are not represented by a desktop Chromium
with a CPU throttle.

## Method

Every stage is timed separately so a regression can be attributed.

| # | Stage | How it is measured | Where it is recorded |
| --- | --- | --- | --- |
| 1 | Host read and projection (`transcript --view conversation`, `herdr-conversation`, `transcript-watch`) | Release `lazysh-agent` on the fixture files: wall, user and system CPU, peak RSS, median of 5 runs. Phase timings come from temporary instrumentation of `project_claude_bounded` (not committed). | [Host](#host-companion) |
| 2 | SSH exec cost and count | Real OpenSSH `sshd` on a private port with throwaway keys, one multiplexed connection, behind a delay proxy (0, 15 and 40 ms one way). The commands are the exact `sh -c` wrappers the client sends (`companion/resolve.rs`). The number of execs per native command is counted from the Rust command paths and, from the transport slice on, asserted by an owned-sshd test. | [SSH](#ssh-exec) |
| 3 | Payload | Bytes on stdout of the page and of the first watch frames. | [Host](#host-companion) |
| 4 | Client parse, normalise, render, markdown | The real `AgentView` in a production bundle (`bench/agent-view-bench.html`), CPU profile (CDP `Profiler`) of an unminified build, React `Profiler` commit counts from React's profiling build. | [Client](#client) |
| 5 | Layout, paint, scroll | Chromium frame intervals over a scripted scroll; long tasks. | [Client](#client) |
| 6 | Tap to first content | Mount of the view to the frame that paints the first message bubble, with a modelled host: every native command answers after the delay its SSH cost implies. | [Results](#results) |
| 7 | Real WebView | Not measured. Needs a phone or the Waydroid procedure. | n/a |

The modelled host answers with the page the **real companion** produced for the fixture, so the shape and the size of the page are
the companion's own. Only the time of a native command is modelled: `execs x execMs` plus the host projection time for the
commands that read the transcript. `execMs` comes from stage 2 (8 ms locally, 70 ms for a 30 ms round trip, 172 ms for an 80 ms
round trip: an exec costs a little more than two round trips because the channel open, the command and the close each wait).

### Fixture

`apps/client/bench/agentFixture.ts` generates a seeded Claude Code JSONL transcript. Only the record types, key sets and size
distributions of real sessions are copied (user and assistant turns, `tool_use`/`tool_result` with Bash, Read, Edit with a
structured patch, Write, Grep, Agent and TodoWrite, thinking, base64 images, attachments, system, queue-operation,
file-history-snapshot, last-prompt, permission-mode records). Every word comes from a PRNG, so the fixture holds no private content
and is byte-identical for a seed. Long markdown (headings, lists, tables, fenced code in several languages) and heavy tool output
(1.5-2.6k line dumps) are part of the mix.

| Fixture | Command | Records | Conversation records | Size |
| --- | --- | ---: | ---: | ---: |
| small | `bun bench/agentFixture.ts small.jsonl 120 1 0.02` | 1,794 | 1,411 | 3.4 MB |
| medium | `... medium.jsonl 400 1 0.03` | 5,834 | 4,626 | 11.3 MB |
| large | `... large.jsonl 700 1 0.03` | 10,610 | 8,367 | 21.1 MB |
| huge | `... huge.jsonl 1900 2 0.04` | 28,712 | 22,612 | 61.1 MB |

`bench/recordAgentPages.ts` runs the companion on two seeded transcripts and stores the pages it returns
(`bench/fixtures/agent-page-*.json`): `typical` is the newest 100 messages of an ordinary session (255 KB), `heavy` is the
companion's page cap of tool output, diffs and long markdown (522 KB, 43 messages).

### Procedure

```sh
# Host (needs a release lazysh-agent: cargo build --release -p lazysh-agent)
bun bench/agentFixture.ts /tmp/medium.jsonl 400 1 0.03
lazysh-agent transcript --agent claude --path /tmp/medium.jsonl --view conversation --limit 100 > /tmp/page.json

# Client: production bundle, modelled SSH host, 5 runs per scenario
cd apps/client
LAZYSH_BENCH_RUNS=5 LAZYSH_BENCH_OUT=/tmp/agent-view.json bun run bench:agent-view
# Render counts need React's profiling build (it adds overhead of its own, so timings come from the plain build):
LAZYSH_BENCH_PROFILING=1 LAZYSH_BENCH_RUNS=1 bun run bench:agent-view
# CPU profile of one scenario (unminified so frames have names): .cpuprofile files open in Chromium DevTools
LAZYSH_BENCH_UNMINIFIED=1 LAZYSH_BENCH_PROFILE=/tmp/profiles bun run bench:agent-view -g "4x CPU"
```

Run the heavy commands through the machine's heavy-job wrapper, one at a time. Without `LAZYSH_BENCH=agent-view` (the default e2e
run) the spec is a smoke test: one scenario, one run, no timing threshold.

## Baseline

Hardware: AMD Ryzen 9 5900X (12 cores, 24 threads), 31 GiB RAM, Linux 7.3.3 (CachyOS), Chromium from Playwright 1.64.1, Bun 1.3.14,
Rust 1.99 release build of `lazysh-agent` 1.52.0, commit `9d0da93e` plus the benchmark files. A desktop part is roughly three to
five times faster than a mid-range phone core, so desktop numbers are a lower bound.

### Host (companion)

`lazysh-agent transcript --agent claude --view conversation --limit 100` (newest 100 messages), median of 5 runs:

| Fixture | Wall | User | Sys | Peak RSS | Page bytes | Outcome |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| small (3.4 MB, 1.4k records) | 27 ms | 18 ms | 8 ms | 22 MiB | 139 KB | ok |
| medium (11.3 MB, 4.6k records) | 88 ms | 64 ms | 22 ms | 57 MiB | 185 KB | ok |
| large (21.1 MB) | 1 ms | n/a | n/a | 13 MiB | 0 | **fails: `InvalidArgument`** |
| huge (61.1 MB) | 1 ms | n/a | n/a | 13 MiB | 0 | **fails: `InvalidArgument`** |

Phases for medium (ms): capture 6, JSON parse of every line 35, uuid de-duplication 4, active chain 10, activity, tasks and session 5,
normalise **every** chain record 22, select the newest 100 and serialise 4. The projection reads and normalises the whole file to
return 100 messages: cost is O(file).

Findings:

1. **A transcript over 16 MiB cannot be opened.** `MAX_SNAPSHOT` (16 MiB) rejects the file, and the client shows a generic failure.
   Of five real local Claude Code sessions between 9 and 36 MB, two exceed 16 MiB, two more hold lines over 256 KiB, and one opens.
2. **A single record line over 256 KiB cannot be opened.** `MAX_LINE` (256 KiB) rejects the whole session with `InvalidEvent`; a
   base64 image or one large tool result is enough.
3. **The live stream re-projects the whole file on every change.** `transcript-watch` on the medium fixture with one record
   appended every 100 ms used 1.48 s CPU in 9.6 s: **18 % of a core** on the host, in competition with the agent it watches.

### SSH exec

Private `sshd` (OpenSSH), one multiplexed connection, median of 7:

| One-way delay | Bare exec | Positive-Unix probe | `snapshot` (wrapped) | `transcript` of medium (wrapped, 185 KB) |
| --- | ---: | ---: | ---: | ---: |
| 0 ms | 5 ms | 8 ms | 12 ms | 109 ms |
| 15 ms (30 ms RTT) | 67 ms | 70 ms | 75 ms | 175 ms |
| 40 ms (80 ms RTT) | 168 ms | 172 ms | 175 ms | 275 ms |

Every companion command runs **two** execs: `companion::command` first runs the positive-Unix probe (`uname`, `id`, `pwd`),
uncached, then the command itself. Execs per native command, counted from the code:

| Native command | Execs (sequential) |
| --- | ---: |
| `agent_snapshot`, `agent_reported_history`, `agent_transcript` | 2 each (probe + command) |
| `multiplexer_sessions` (Herdr), `herdr_tree` | 1 each (the Herdr navigation read runs them one after the other, every 3 s) |
| `agent_herdr_conversation` | 4 (Herdr tree, probe, conversation, Herdr tree again) |
| `agent_watch_start` | 2 (probe, then the long-lived `transcript-watch`; Herdr adds a tree read) |
| `tmux_chat` snapshot | a tmux control round trip, no exec |

Opening a conversation bound by hook reports (tmux, Zellij) therefore runs, one after another: the bind (`agent_snapshot`,
`tmux_chat`, `agent_reported_history`), the pre-read validation (the same three), `agent_transcript`, and the post-read validation
(the same three again): **11 native calls and 14 execs one after another (plus 3 tmux control round trips) before the first message is shown.** The stream starts only after that.

### Client

Production bundle of the real `AgentView`, newest 100 messages (`typical` page), desktop Chromium:

| Measure | 1x CPU | 4x CPU |
| --- | ---: | ---: |
| Main-thread script during load | 55 ms | 205 ms |
| Longest task during load | 0-70 ms | 171-184 ms (340 ms with the `heavy` page) |
| React commits during load | 9-10 (one mount) | 9 |
| Longest commit | 49 ms | 168 ms |
| DOM nodes after load | 1,489 (68 bubbles) | same |
| Scroll frame p95 over the loaded window | 16.7 ms | 16.7 ms |
| Streaming: 40 deltas on the newest message, p95 delta to paint | 20 ms | 34 ms |

CPU profile of the 4x run (inclusive, unminified): React render 380 ms of 480 ms of script; **markdown parsing (react-markdown /
micromark) 112 ms (23 %)**; i18n `t()` 52 ms (11 %); `formatRelativeTime` 30 ms (6 %); `AgentToolCard` 26 ms. Finished turns fold their
tool activity into a closed `<details>`, but its rows are still rendered. Scrolling and streaming are not bottlenecks on this fixture.

## Results

Tap to first content, median of 5 runs (`bun run bench:agent-view`), desktop Chromium, modelled SSH link:

| Scenario | First content | Sequential native calls before it | Longest load task |
| --- | ---: | ---: | ---: |
| tmux, local link (exec 8 ms) | 273 ms | 11 | 0 ms |
| tmux, LAN (30 ms RTT, exec 70 ms) | **1,236 ms** | 11 | 0 ms |
| tmux, mobile (80 ms RTT, exec 172 ms) | **2,809 ms** | 11 | 0 ms |
| tmux, LAN, 4x CPU | 1,373 ms | 11 | 184 ms |
| tmux, mobile, 4x CPU | 2,970 ms | 11 | 171 ms |
| tmux, LAN, 4x CPU, heavy page | 1,360 ms | 11 | 340 ms |
| tmux, LAN, host without the stream (polling) | 1,391 ms | 11 | 196 ms |
| Herdr, local link | 192 ms | 3 | 0 ms |
| Herdr, LAN | 568 ms | 3 | 0 ms |
| Herdr, mobile | 1,190 ms | 3 | 56 ms |
| Herdr, mobile, 4x CPU | 1,349 ms | 3 | 179 ms |

### Where the time goes (ranked by measured impact)

1. **The sequential native calls (14 execs in a row for tmux, 6 for Herdr: server list, tree, then the 4 of the conversation read).** On LAN 1,236 ms of the 1,236 ms are waiting; the client's own
   work is 55 ms. A single repeated probe exec is 44 % of the tmux execs. This is the biggest cost and it grows with the link.
2. **Client main thread at phone speed.** 205 ms of script and a 184 ms task at 4x CPU, of which markdown parsing and rows folded
   inside closed `<details>` are the largest parts. It breaks the 50 ms task budget as soon as the CPU is slow.
3. **Host projection.** 88 ms for 11 MB, O(file), twice per open (page and stream snapshot), 18 % of a host core while streaming, and a
   hard failure above 16 MiB or with one line over 256 KiB.
4. Payload: 185-522 KB per page. Not a first-order cost on these links; it matters on a slow radio only.

Each fix lands as its own change; the section below is extended by the change that makes the new numbers.

## After each fix

Same bench, same hardware, 5 runs, medians. "Before" is the baseline above.

### Fewer SSH round trips

Changes: the host probe runs once per connection (it ran before every companion command), the host's reports and the tmux pane are read
together, the three reads that check a bound report run together and the first read of a conversation does not repeat the check the bind
made a moment earlier, and the Herdr pane check overlaps the conversation read. For a hook-bound tmux conversation the first message
needs **4 execs in a row (5 with the cold probe), was 14**; a Herdr conversation read needs 2 in a row, was 4. The unit tests count the
calls (`AgentView.test.tsx`, "round trips before the first message") and the owned-OpenSSH companion test asserts one exec for a later
companion command.

| Scenario | Before | After |
| --- | ---: | ---: |
| tmux, local link | 273 ms | 197 ms |
| tmux, LAN (30 ms RTT) | 1,236 ms | **503 ms** |
| tmux, mobile (80 ms RTT) | 2,809 ms | **1,009 ms** |
| tmux, LAN, 4x CPU | 1,373 ms | 772 ms (min 637) |
| tmux, mobile, 4x CPU | 2,970 ms | 1,165 ms |
| tmux, LAN, 4x CPU, heavy page | 1,360 ms | 634 ms |
| tmux, LAN, host without the stream (polling) | 1,391 ms | 493 ms |
| Herdr, local link | 192 ms | 180 ms |
| Herdr, LAN | 568 ms | 496 ms |
| Herdr, mobile | 1,190 ms | 1,009 ms |
| Herdr, mobile, 4x CPU | 1,349 ms | 1,194 ms |

Herdr gains least: its read still waits for the server list, then the tree, then the conversation and the tree again. Overlapping the
server list with the tree would save a step, but `useHerdrNavigation` never reads a tree for a server the list did not name, and its tests
pin that, so it was left alone. The benchmark model counts the cold probe for the first companion command of a connection and does not
count the probe the baseline Herdr navigation also made once (`herdr_path::admit`), so the Herdr "before" is slightly low.

### Not measured

- A real phone, the Android WebView, and the radio: needs a device number.
- The Waydroid emulator: not run for the baseline.
- Mosh and Eternal Terminal transports: the model assumes SSH exec.
- Sessions of other agents than Claude Code and Codex (no stream, records only).
