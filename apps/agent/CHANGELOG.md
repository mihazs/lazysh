# @lazysh/agent

## 1.56.1

### Patch Changes

- @lazysh/account-usage@1.56.1
  - @lazysh/common@1.56.1
  - @lazysh/notification-client@1.56.1

## 1.56.0

### Minor Changes

- 00c3e7d: Show Claude Code goal, plan-mode, recap and hook-failure records and Codex goal and compaction records as compact event lines in the Agent view.
- 87bb9c3: Offer the permission updates Claude Code suggests (allow and remember a rule, switch mode, add folders) in the approval card and the Agent view, each behind a confirmation that shows the exact rule and where it is kept, and let a denial carry a message the agent reads.

### Patch Changes

- @lazysh/account-usage@1.56.0
  - @lazysh/common@1.56.0
  - @lazysh/notification-client@1.56.0

## 1.55.0

### Patch Changes

- @lazysh/account-usage@1.55.0
  - @lazysh/common@1.55.0
  - @lazysh/notification-client@1.55.0

## 1.54.1

### Patch Changes

- @lazysh/account-usage@1.54.1
  - @lazysh/common@1.54.1
  - @lazysh/notification-client@1.54.1

## 1.54.0

### Minor Changes

- e74bd92: List the earlier Claude Code and Codex sessions of a folder in the Agent view and open one read-only, with a **Resume in the terminal** action that stages the agent's own resume command for review, through a new `lazysh-agent history` companion command and `agent_history` app command.
- 95224be: Open a Claude Code sub-agent's own conversation from the Agent view, read from its files under the session directory.
- 95224be: Show Claude Code dynamic workflows in the Agent view as a live progress tree: the companion reads each run's summary and journal files, the view draws its phases with each agent's state, tokens and tool calls, and opens any agent's own conversation.

### Patch Changes

- @lazysh/account-usage@1.54.0
  - @lazysh/common@1.54.0
  - @lazysh/notification-client@1.54.0

## 1.53.0

### Patch Changes

- @lazysh/account-usage@1.53.0
  - @lazysh/common@1.53.0
  - @lazysh/notification-client@1.53.0

## 1.52.0

### Minor Changes

- fc4e7e8: Report the files a Codex session changed as `apply_patch` calls with their outcome in the conversation view.

### Patch Changes

- @lazysh/account-usage@1.52.0
  - @lazysh/common@1.52.0
  - @lazysh/notification-client@1.52.0

## 1.51.0

### Minor Changes

- 587b2c7: Send from the Agent view to an agent that runs in a Zellij pane. The updated companion reports the Zellij session and pane of an agent's hooks, the Agent view of a terminal attached to that session follows (or lists) the agents that name one of its panes, and Send and Stop write to that exact pane through Zellij's own commands, only while it still runs the agent. Needs Zellij 0.45.1 or newer.

### Patch Changes

- @lazysh/account-usage@1.51.0
  - @lazysh/common@1.51.0
  - @lazysh/notification-client@1.51.0

## 1.50.0

### Minor Changes

- 9d7fb30: Show a failed Claude Code API call (usage limit, unreachable API, refused request) as an error card that says what to do next, from the recorded `isApiErrorMessage` assistant record.

### Patch Changes

- @lazysh/account-usage@1.50.0
  - @lazysh/common@1.50.0
  - @lazysh/notification-client@1.50.0

## 1.49.0

### Minor Changes

- 4f882e7: Show the agent's model, permission mode, context left, git branch and worktree in the Agent view header, from a new additive `session` object of the Claude Code and Codex conversation pages and watch frames.

### Patch Changes

- @lazysh/account-usage@1.49.0
  - @lazysh/common@1.49.0
  - @lazysh/notification-client@1.49.0

## 1.48.0

### Minor Changes

- 16c4800: Read the Agent view's background work (sub-agents, background commands, monitors, workflows) from the host companion so the panel covers the whole conversation, shows a shell or monitor's output and flags launches with no recorded end as not confirmed.

### Patch Changes

- @lazysh/account-usage@1.48.0
  - @lazysh/common@1.48.0
  - @lazysh/notification-client@1.48.0

## 1.47.0

### Patch Changes

- @lazysh/account-usage@1.47.0
  - @lazysh/common@1.47.0
  - @lazysh/notification-client@1.47.0

## 1.46.0

### Minor Changes

- 6ebb3d8: Show the PNG and JPEG images a user attached as a bounded preview control in the Agent view bubble, for Claude Code and (new in the companion) Codex conversations.

### Patch Changes

- @lazysh/account-usage@1.46.0
  - @lazysh/common@1.46.0
  - @lazysh/notification-client@1.46.0

## 1.45.0

### Patch Changes

- @lazysh/account-usage@1.45.0
  - @lazysh/common@1.45.0
  - @lazysh/notification-client@1.45.0

## 1.44.0

### Patch Changes

- @lazysh/account-usage@1.44.0
  - @lazysh/common@1.44.0
  - @lazysh/notification-client@1.44.0

## 1.43.0

### Patch Changes

- @lazysh/account-usage@1.43.0
  - @lazysh/common@1.43.0
  - @lazysh/notification-client@1.43.0

## 1.42.0

### Minor Changes

- d356489: Let `lazysh-agent transcript --view conversation` and `lazysh-agent herdr-conversation` read a session from its first message: `--before ID`, `--after ID` and `--from-start` cut the recorded branch at a message, pages report `hasNewer`, Claude Code conversations now continue across compactions, and sessions of more than 10,000 records are readable for Claude Code, Codex and OpenCode. Changed: a Claude Code conversation page now includes the messages before a compaction, above its summary.

### Patch Changes

- @lazysh/account-usage@1.42.0
  - @lazysh/common@1.42.0
  - @lazysh/notification-client@1.42.0

## 1.41.0

### Patch Changes

- @lazysh/account-usage@1.41.0
  - @lazysh/common@1.41.0
  - @lazysh/notification-client@1.41.0

## 1.40.0

### Minor Changes

- 65eaa38: Show the prompts typed while Claude Code works as read-only Queued cards in the Agent view, from a new bounded `queued` list in the companion's Claude conversation page and transcript-watch frames.

### Patch Changes

- @lazysh/account-usage@1.40.0
  - @lazysh/common@1.40.0
  - @lazysh/notification-client@1.40.0

## 1.39.0

### Patch Changes

- @lazysh/account-usage@1.39.0
  - @lazysh/common@1.39.0
  - @lazysh/notification-client@1.39.0

## 1.38.0

### Patch Changes

- @lazysh/account-usage@1.38.0
  - @lazysh/common@1.38.0
  - @lazysh/notification-client@1.38.0

## 1.37.0

### Minor Changes

- 20f02cc: Name what an agent waits for (approval, question, plan decision or unknown) and since when: the companion records it from hook payloads, and the Agent view shows it in its header and session list, lists waiting sessions first and opens from a needs-you notification.

### Patch Changes

- @lazysh/account-usage@1.37.0
  - @lazysh/common@1.37.0
  - @lazysh/notification-client@1.37.0

## 1.36.0

### Patch Changes

- 848a370: Add a developer-only prototype of the host browser: a hidden companion command that starts a throwaway Chrome-family browser on the host and a viewer page that only the Vite development server serves, with a real-browser CI test and a protocol-client unit test. It is off by default, absent from release builds and changes no default.
- @lazysh/account-usage@1.36.0
  - @lazysh/common@1.36.0
  - @lazysh/notification-client@1.36.0

## 1.35.0

### Patch Changes

- @lazysh/account-usage@1.35.0
  - @lazysh/common@1.35.0
  - @lazysh/notification-client@1.35.0

## 1.34.0

### Minor Changes

- 95968a2: Add the `lazysh-agent transcript-watch` companion command: one long-lived stream of upserts for a Claude Code or Codex conversation, checked every 250 ms on the host, for the Agent view's live updates.

### Patch Changes

- @lazysh/account-usage@1.34.0
  - @lazysh/common@1.34.0
  - @lazysh/notification-client@1.34.0

## 1.33.4

### Patch Changes

- @lazysh/account-usage@1.33.4
  - @lazysh/common@1.33.4
  - @lazysh/notification-client@1.33.4

## 1.33.3

### Patch Changes

- @lazysh/account-usage@1.33.3
  - @lazysh/common@1.33.3
  - @lazysh/notification-client@1.33.3

## 1.33.2

### Patch Changes

- @lazysh/account-usage@1.33.2
  - @lazysh/common@1.33.2
  - @lazysh/notification-client@1.33.2

## 1.33.1

### Patch Changes

- @lazysh/account-usage@1.33.1
  - @lazysh/common@1.33.1
  - @lazysh/notification-client@1.33.1

## 1.33.0

### Patch Changes

- @lazysh/account-usage@1.33.0
  - @lazysh/common@1.33.0
  - @lazysh/notification-client@1.33.0

## 1.32.0

### Patch Changes

- @lazysh/account-usage@1.32.0
  - @lazysh/common@1.32.0
  - @lazysh/notification-client@1.32.0

## 1.31.2

### Patch Changes

- @lazysh/account-usage@1.31.2
  - @lazysh/common@1.31.2
  - @lazysh/notification-client@1.31.2

## 1.31.1

### Patch Changes

- @lazysh/account-usage@1.31.1
  - @lazysh/common@1.31.1
  - @lazysh/notification-client@1.31.1

## 1.31.0

### Patch Changes

- @lazysh/account-usage@1.31.0
  - @lazysh/common@1.31.0
  - @lazysh/notification-client@1.31.0

## 1.30.5

### Patch Changes

- @lazysh/account-usage@1.30.5
  - @lazysh/common@1.30.5
  - @lazysh/notification-client@1.30.5

## 1.30.4

### Patch Changes

- @lazysh/account-usage@1.30.4
  - @lazysh/common@1.30.4
  - @lazysh/notification-client@1.30.4

## 1.30.3

### Patch Changes

- @lazysh/account-usage@1.30.3
  - @lazysh/common@1.30.3
  - @lazysh/notification-client@1.30.3

## 1.30.2

### Patch Changes

- @lazysh/account-usage@1.30.2
  - @lazysh/common@1.30.2
  - @lazysh/notification-client@1.30.2

## 1.30.1

### Patch Changes

- @lazysh/account-usage@1.30.1
  - @lazysh/common@1.30.1
  - @lazysh/notification-client@1.30.1

## 1.30.0

### Patch Changes

- @lazysh/account-usage@1.30.0
  - @lazysh/common@1.30.0
  - @lazysh/notification-client@1.30.0

## 1.29.3

### Patch Changes

- @lazysh/account-usage@1.29.3
  - @lazysh/common@1.29.3
  - @lazysh/notification-client@1.29.3

## 1.29.2

### Patch Changes

- @lazysh/account-usage@1.29.2
  - @lazysh/common@1.29.2
  - @lazysh/notification-client@1.29.2

## 1.29.1

### Patch Changes

- @lazysh/account-usage@1.29.1
  - @lazysh/common@1.29.1
  - @lazysh/notification-client@1.29.1

## 1.29.0

### Patch Changes

- @lazysh/account-usage@1.29.0
  - @lazysh/common@1.29.0
  - @lazysh/notification-client@1.29.0

## 1.28.2

### Patch Changes

- @lazysh/account-usage@1.28.2
  - @lazysh/common@1.28.2
  - @lazysh/notification-client@1.28.2

## 1.28.1

### Patch Changes

- @lazysh/account-usage@1.28.1
  - @lazysh/common@1.28.1
  - @lazysh/notification-client@1.28.1

## 1.28.0

### Minor Changes

- 94b17c9: Switch a session between its terminal and a live Agent view, with Both side by side on wide desktop layouts; Codex hooks can report their conversation for automatic binding.

### Patch Changes

- @lazysh/account-usage@1.28.0
  - @lazysh/common@1.28.0
  - @lazysh/notification-client@1.28.0

## 1.27.1

### Patch Changes

- ac467c1: Support Herdr 0.9.3 through 0.9.5, and explain a Herdr workspace, tab or pane that was closed on the host instead of showing Herdr's raw error.
- @lazysh/account-usage@1.27.1
  - @lazysh/common@1.27.1
  - @lazysh/notification-client@1.27.1

## 1.27.0

### Patch Changes

- @lazysh/account-usage@1.27.0
  - @lazysh/common@1.27.0
  - @lazysh/notification-client@1.27.0

## 1.26.1

### Patch Changes

- @lazysh/account-usage@1.26.1
  - @lazysh/common@1.26.1
  - @lazysh/notification-client@1.26.1

## 1.26.0

### Patch Changes

- @lazysh/account-usage@1.26.0
  - @lazysh/common@1.26.0
  - @lazysh/notification-client@1.26.0

## 1.25.1

### Patch Changes

- @lazysh/account-usage@1.25.1
  - @lazysh/common@1.25.1
  - @lazysh/notification-client@1.25.1

## 1.25.0

### Patch Changes

- Updated dependencies [a89a721]
  - @lazysh/notification-client@1.25.0
  - @lazysh/account-usage@1.25.0
  - @lazysh/common@1.25.0

## 1.24.0

### Patch Changes

- @lazysh/account-usage@1.24.0
  - @lazysh/common@1.24.0
  - @lazysh/notification-client@1.24.0

## 1.23.0

### Patch Changes

- @lazysh/account-usage@1.23.0
  - @lazysh/common@1.23.0
  - @lazysh/notification-client@1.23.0

## 1.22.0

### Patch Changes

- @lazysh/account-usage@1.22.0
  - @lazysh/common@1.22.0
  - @lazysh/notification-client@1.22.0

## 1.21.0

### Patch Changes

- @lazysh/account-usage@1.21.0
  - @lazysh/common@1.21.0
  - @lazysh/notification-client@1.21.0

## 1.20.0

### Patch Changes

- 4299001: Fix intermittent Windows release failures in the companion storage contention cases (SQLite code 5 at `ingest_begin`). Each sixteen-writer burst now runs alone instead of beside other companion runs in the same test process, and a Linux check replays the CLI suite beside a simulated slow shared volume. Companion storage, FULL durability and the 3-second wait budget are unchanged.
- @lazysh/account-usage@1.20.0
  - @lazysh/common@1.20.0
  - @lazysh/notification-client@1.20.0

## 1.19.0

### Patch Changes

- @lazysh/account-usage@1.19.0
  - @lazysh/common@1.19.0
  - @lazysh/notification-client@1.19.0

## 1.18.2

### Patch Changes

- @lazysh/account-usage@1.18.2
  - @lazysh/common@1.18.2
  - @lazysh/notification-client@1.18.2

## 1.18.1

### Patch Changes

- @lazysh/account-usage@1.18.1
  - @lazysh/common@1.18.1
  - @lazysh/notification-client@1.18.1

## 1.18.0

### Patch Changes

- @lazysh/account-usage@1.18.0
  - @lazysh/common@1.18.0
  - @lazysh/notification-client@1.18.0

## 1.17.1

### Patch Changes

- @lazysh/account-usage@1.17.1
  - @lazysh/common@1.17.1
  - @lazysh/notification-client@1.17.1

## 1.17.0

### Patch Changes

- @lazysh/account-usage@1.17.0
  - @lazysh/common@1.17.0
  - @lazysh/notification-client@1.17.0

## 1.16.0

### Patch Changes

- @lazysh/account-usage@1.16.0
  - @lazysh/common@1.16.0
  - @lazysh/notification-client@1.16.0

## 1.15.0

### Patch Changes

- @lazysh/account-usage@1.15.0
  - @lazysh/common@1.15.0
  - @lazysh/notification-client@1.15.0

## 1.14.0

### Patch Changes

- 5cead04: Fix companion hook events failing on Windows with SQLite code 5 when many hooks open the store at once. Opening an initialized store now holds the bootstrap lock shared, so warm opens no longer queue behind each other or behind durable commits; only creating or upgrading the store takes it exclusively. WAL mode, FULL durability, sidecar checks and the 3-second wait budget are unchanged.
- @lazysh/account-usage@1.14.0
  - @lazysh/common@1.14.0
  - @lazysh/notification-client@1.14.0

## 1.13.0

### Patch Changes

- @lazysh/account-usage@1.13.0
  - @lazysh/common@1.13.0
  - @lazysh/notification-client@1.13.0

## 1.12.0

### Minor Changes

- 86e89e4: Show plan, question and turn-state cards in native Chat. The companion projects recorded Claude Code `TodoWrite`, `AskUserQuestion` and `ExitPlanMode` calls, Codex `update_plan`, `request_user_input` and plan-mode items, and OpenCode `todowrite` and `question` parts into display-only cards. Conversation views for Claude Code, Codex and OpenCode V1 report a working, waiting, idle or stopped turn derived from recorded lifecycle records; anything else stays unknown. Question cards list the options and send the user to the terminal to answer, because Chat cannot choose options in an agent prompt. Existing tool cards, cursors and prompt targets are unchanged.

### Patch Changes

- Updated dependencies [5406843]
- Updated dependencies [816f09b]
  - @lazysh/account-usage@1.12.0
  - @lazysh/common@1.12.0
  - @lazysh/notification-client@1.12.0

## 1.11.0

### Minor Changes

- aa1e2f3: Add explicitly selected OpenCode recorded conversations with current projection refresh and unchanged confirmed terminal input boundaries.

### Patch Changes

- @lazysh/account-usage@1.11.0
  - @lazysh/common@1.11.0
  - @lazysh/notification-client@1.11.0

## 1.10.4

### Patch Changes

- @lazysh/account-usage@1.10.4
  - @lazysh/common@1.10.4
  - @lazysh/notification-client@1.10.4

## 1.10.3

### Patch Changes

- @lazysh/account-usage@1.10.3
  - @lazysh/common@1.10.3
  - @lazysh/notification-client@1.10.3

## 1.10.2

### Patch Changes

- @lazysh/account-usage@1.10.2
  - @lazysh/common@1.10.2
  - @lazysh/notification-client@1.10.2

## 1.10.1

### Patch Changes

- @lazysh/account-usage@1.10.1
  - @lazysh/common@1.10.1
  - @lazysh/notification-client@1.10.1

## 1.10.0

### Minor Changes

- f1d7feb: Add a recorded Codex Conversation reader with mode-aware turn replay, bounded protected fork/revert prefixes, explicit refresh and opt-in Follow. Records remains the default; recorded history does not establish a live agent or authorize requests.

### Patch Changes

- @lazysh/account-usage@1.10.0
  - @lazysh/common@1.10.0
  - @lazysh/notification-client@1.10.0

## 1.9.11

### Patch Changes

- @lazysh/account-usage@1.9.11
  - @lazysh/common@1.9.11
  - @lazysh/notification-client@1.9.11

## 1.9.10

### Patch Changes

- @lazysh/account-usage@1.9.10
  - @lazysh/common@1.9.10
  - @lazysh/notification-client@1.9.10

## 1.9.9

### Patch Changes

- @lazysh/account-usage@1.9.9
  - @lazysh/common@1.9.9
  - @lazysh/notification-client@1.9.9

## 1.9.8

### Patch Changes

- @lazysh/account-usage@1.9.8
  - @lazysh/common@1.9.8
  - @lazysh/notification-client@1.9.8

## 1.9.7

### Patch Changes

- @lazysh/account-usage@1.9.7
  - @lazysh/common@1.9.7
  - @lazysh/notification-client@1.9.7

## 1.9.6

### Patch Changes

- @lazysh/account-usage@1.9.6
  - @lazysh/common@1.9.6
  - @lazysh/notification-client@1.9.6

## 1.9.5

### Patch Changes

- @lazysh/account-usage@1.9.5
  - @lazysh/common@1.9.5
  - @lazysh/notification-client@1.9.5

## 1.9.4

### Patch Changes

- 0eb395e: Retain closed failure-only stages from the owned WAL crash-recovery fixture while preserving the original panic, child cleanup and storage acceptance limits.
- @lazysh/account-usage@1.9.4
  - @lazysh/common@1.9.4
  - @lazysh/notification-client@1.9.4

## 1.9.3

### Patch Changes

- @lazysh/account-usage@1.9.3
  - @lazysh/common@1.9.3
  - @lazysh/notification-client@1.9.3

## 1.9.2

### Patch Changes

- @lazysh/account-usage@1.9.2
  - @lazysh/common@1.9.2
  - @lazysh/notification-client@1.9.2

## 1.9.1

### Patch Changes

- @lazysh/account-usage@1.9.1
  - @lazysh/common@1.9.1
  - @lazysh/notification-client@1.9.1

## 1.9.0

### Patch Changes

- @lazysh/account-usage@1.9.0
  - @lazysh/common@1.9.0
  - @lazysh/notification-client@1.9.0

## 1.8.4

### Patch Changes

- @lazysh/account-usage@1.8.4
  - @lazysh/common@1.8.4
  - @lazysh/notification-client@1.8.4

## 1.8.3

### Patch Changes

- @lazysh/account-usage@1.8.3
  - @lazysh/common@1.8.3
  - @lazysh/notification-client@1.8.3

## 1.8.2

### Patch Changes

- 9ce9d81: Correlate opt-in concurrent-hook fixture SQL failure phases with their exact owned child workers without changing storage behavior or acceptance gates.
- @lazysh/account-usage@1.8.2
  - @lazysh/common@1.8.2
  - @lazysh/notification-client@1.8.2

## 1.8.1

### Patch Changes

- @lazysh/account-usage@1.8.1
  - @lazysh/common@1.8.1
  - @lazysh/notification-client@1.8.1

## 1.8.0

### Patch Changes

- @lazysh/account-usage@1.8.0
  - @lazysh/common@1.8.0
  - @lazysh/notification-client@1.8.0

## 1.7.8

### Patch Changes

- @lazysh/account-usage@1.7.8
  - @lazysh/common@1.7.8
  - @lazysh/notification-client@1.7.8

## 1.7.7

### Patch Changes

- @lazysh/account-usage@1.7.7
  - @lazysh/common@1.7.7
  - @lazysh/notification-client@1.7.7

## 1.7.6

### Patch Changes

- @lazysh/account-usage@1.7.6
  - @lazysh/common@1.7.6
  - @lazysh/notification-client@1.7.6

## 1.7.5

### Patch Changes

- @lazysh/account-usage@1.7.5
  - @lazysh/common@1.7.5
  - @lazysh/notification-client@1.7.5

## 1.7.4

### Patch Changes

- @lazysh/account-usage@1.7.4
  - @lazysh/common@1.7.4
  - @lazysh/notification-client@1.7.4

## 1.7.3

### Patch Changes

- @lazysh/account-usage@1.7.3
  - @lazysh/common@1.7.3
  - @lazysh/notification-client@1.7.3

## 1.7.2

### Patch Changes

- @lazysh/account-usage@1.7.2
  - @lazysh/common@1.7.2
  - @lazysh/notification-client@1.7.2

## 1.7.1

### Patch Changes

- @lazysh/account-usage@1.7.1
  - @lazysh/common@1.7.1
  - @lazysh/notification-client@1.7.1

## 1.7.0

### Minor Changes

- bcc7feb: Add opt-in V3 managed Amp system-plugin setup with protected ownership, shadow-aware removal and bounded V2 metadata compatibility.

### Patch Changes

- @lazysh/account-usage@1.7.0
  - @lazysh/common@1.7.0
  - @lazysh/notification-client@1.7.0

## 1.6.0

### Minor Changes

- aad0990: Add opt-in version-2 hook discovery and inspected, profile-scoped Copilot hook setup while preserving version-1 compatibility, foreign settings and provider trust.

### Patch Changes

- 99d1b8e: Avoid reporting a completed Amp turn from an initially idle thread. The updated manual plugin reports idle only after observing that thread running, and does not treat an error followed by idle as recovery. Replace previously copied Amp plugin files to receive this fix; existing historical reports are unchanged.
- @lazysh/account-usage@1.6.0
  - @lazysh/common@1.6.0
  - @lazysh/notification-client@1.6.0

## 1.5.5

### Patch Changes

- @lazysh/account-usage@1.5.5
  - @lazysh/common@1.5.5
  - @lazysh/notification-client@1.5.5

## 1.5.4

### Patch Changes

- 9bb174c: Finish Copilot child reports with a separate validated session identity while preserving parent state and shared-session completion guards.
- @lazysh/account-usage@1.5.4
  - @lazysh/common@1.5.4
  - @lazysh/notification-client@1.5.4

## 1.5.3

### Patch Changes

- b98d878: Document Linux Copilot CLI 1.0.105 manual-hook qualification for completed root turns and unanswered elicitation attention, including remaining runtime limits.
- @lazysh/account-usage@1.5.3
  - @lazysh/common@1.5.3
  - @lazysh/notification-client@1.5.3

## 1.5.2

### Patch Changes

- dbd55aa: Discover current and legacy Kimi profile metadata while retaining manual-only setup and the legacy 1.52 hook printer contract.
- @lazysh/account-usage@1.5.2
  - @lazysh/common@1.5.2
  - @lazysh/notification-client@1.5.2

## 1.5.1

### Patch Changes

- c630f74: Correct the packaged reporting skill to describe installed-agent discovery and managed Cline setup while preserving explicit selection, inspected plans and plugin policy.
- @lazysh/account-usage@1.5.1
  - @lazysh/common@1.5.1
  - @lazysh/notification-client@1.5.1

## 1.5.0

### Minor Changes

- 8db8a98: Detect installed host agents and known profile locations before explicit hook setup. Let users select a target while preserving inspected installation plans, manual profile selection and provider trust decisions. Discovery never installs hooks or creates missing profiles.
- afc27ec: Add explicit managed Cline root lifecycle plugin setup and profile discovery. Preserve existing plugin restrictions and require inspected install/remove plans; configuration does not establish live reporting.

### Patch Changes

- @lazysh/account-usage@1.5.0
  - @lazysh/common@1.5.0
  - @lazysh/notification-client@1.5.0

## 1.4.2

### Patch Changes

- @lazysh/account-usage@1.4.2
  - @lazysh/common@1.4.2
  - @lazysh/notification-client@1.4.2

## 1.4.1

### Patch Changes

- @lazysh/account-usage@1.4.1
  - @lazysh/common@1.4.1
  - @lazysh/notification-client@1.4.1

## 1.4.0

### Minor Changes

- 3674b0e: Add native Gemini CLI, Droid, Kimi CLI and GitHub Copilot CLI lifecycle reporting with print-only agent-specific configuration fragments.

  Kimi ignores unscoped Stop/StopFailure events to preserve parent state; its hook contract cannot identify per-turn completion.
- 564f7f9: Add a print-only Cline root lifecycle plugin with exact native run identities, bounded companion writes and disposal cleanup. Child runs, permission waits and managed installation remain unsupported; profiles and approval policy are unchanged.
- 54796e0: Browse Herdr spaces and live agent panes from workspace navigation. Reuse or explicitly attach the exact server display, then use stock shared workspace/tab focus or the companion's exact shell/agent pane focus. Disclose shared focus and require fresh Chat confirmation after navigation.
- 0be60d8: Package original host-setup and lifecycle-reporting skills with explicit preview,
  profile status, owned installation/update and removal commands. Preserve agent
  configuration and reject foreign or edited skills; no automatic installation.
- 730cb2a: Add explicit inspected-plan lifecycle hook setup for Claude Code, Codex and OpenCode, with an SSH-connected Agents setup flow and companion CLI.

  Preserve foreign profile values and ordinary file mode/group metadata, refuse unhandled ACLs or ownership conflicts, and keep configured state distinct from trust and live reporting. Managed writes initially support qualified Linux filesystems; other platforms retain preview-only capability.
- 7218f34: Add inspected-profile managed Droid hooks for an already-existing standalone hooks.json, including the connected Agents selector.

  Preserve foreign groups and fallback policy; refuse absent configuration rather than shadowing settings/legacy declarations. No automatic trust changes, fresh-profile migration or native Droid lifecycle claim.
- 7477209: Extend explicit inspected-profile lifecycle hook setup to Gemini CLI and Cursor CLI, including the SSH-connected Agents setup selector.

  Preserve Gemini millisecond deadlines and disable flags, Cursor version-1/fail-open observer semantics, foreign policy and the existing retained filesystem transaction. Other managed providers, macOS writes and actual provider-trusted reporting remain separate gaps.
- 672b24b: Add native Codex lifecycle ingestion and a bounded OpenCode lifecycle plugin with print-only configuration assets.
- e542d41: Add native Cursor activity/completion reporting, an Amp thread-state observer
  plugin and truthful host-wide Aider notification health. Print reviewed assets
  and arguments without changing profiles or permission policy. Aider callbacks
  have no session attribution or lifecycle states and never create session rows.

### Patch Changes

- bc6c84d: Recover built-in account quotas from empty external reports and offer companion setup when a remote usage command is missing or outdated.
- 4f4d872: Initialize companion schema tables and indexes in one deferred transaction, retaining full durability and existing storage wait budgets while rolling back partial schema creation on failure.
- 1cddb34: Support native OpenCode 2.2 and 1.19.5 loading from one reviewed lifecycle plugin asset, with bounded ordered delivery and cleanup on unload. Hook installation and trust remain explicit.
- Updated dependencies [bc6c84d]
  - @lazysh/account-usage@1.4.0
  - @lazysh/common@1.4.0
  - @lazysh/notification-client@1.4.0

## 1.3.3

### Patch Changes

- @lazysh/account-usage@1.3.3
  - @lazysh/common@1.3.3
  - @lazysh/notification-client@1.3.3

## 1.3.2

### Patch Changes

- @lazysh/account-usage@1.3.2
  - @lazysh/common@1.3.2
  - @lazysh/notification-client@1.3.2

## 1.3.1

### Patch Changes

- @lazysh/account-usage@1.3.1
  - @lazysh/common@1.3.1
  - @lazysh/notification-client@1.3.1

## 1.3.0

### Minor Changes

- 9565f8a: Add compact AI account quotas and built-in host collectors when ai-usagebar is unavailable, keeping credentials on the session machine.

### Patch Changes

- Updated dependencies [9565f8a]
  - @lazysh/account-usage@1.3.0
  - @lazysh/common@1.3.0
  - @lazysh/notification-client@1.3.0

## 1.2.0

### Patch Changes

- @lazysh/common@1.2.0
  - @lazysh/notification-client@1.2.0

## 1.1.7

### Patch Changes

- @lazysh/common@1.1.7
  - @lazysh/notification-client@1.1.7

## 1.1.6

### Patch Changes

- @lazysh/common@1.1.6
  - @lazysh/notification-client@1.1.6

## 1.1.5

### Patch Changes

- @lazysh/common@1.1.5
  - @lazysh/notification-client@1.1.5

## 1.1.4

### Patch Changes

- @lazysh/common@1.1.4
  - @lazysh/notification-client@1.1.4

## 1.1.3

### Patch Changes

- @lazysh/common@1.1.3
  - @lazysh/notification-client@1.1.3

## 1.1.2

### Patch Changes

- @lazysh/common@1.1.2
  - @lazysh/notification-client@1.1.2

## 1.1.1

### Patch Changes

- @lazysh/common@1.1.1
  - @lazysh/notification-client@1.1.1

## 1.1.0

### Patch Changes

- @lazysh/common@1.1.0
  - @lazysh/notification-client@1.1.0

## 1.0.2

### Patch Changes

- @lazysh/common@1.0.2
  - @lazysh/notification-client@1.0.2

## 1.0.1

### Patch Changes

- @lazysh/common@1.0.1
  - @lazysh/notification-client@1.0.1

## 1.0.0

### Minor Changes

- 58b3c9f: Add explicit preview-bound Unix companion installation with verified source bytes, a fixed private user namespace and kernel-locked atomic replacement. Windows installation remains explicitly unsupported; existing runtime and data defaults are unchanged.
- e61e477: Publish verified companion executables for Linux x64/ARM64, macOS Intel/ARM64 and Windows x64 in future complete releases, with native staged-byte CLI/storage acceptance and existing source-bound receipts. Existing companion behavior and storage defaults are unchanged.

### Patch Changes

- @lazysh/common@1.0.0
  - @lazysh/notification-client@1.0.0

## 0.23.0

### Patch Changes

- @lazysh/common@0.23.0
  - @lazysh/notification-client@0.23.0

## 0.22.0

### Patch Changes

- @lazysh/common@0.22.0
  - @lazysh/notification-client@0.22.0

## 0.21.0

### Patch Changes

- @lazysh/common@0.21.0
  - @lazysh/notification-client@0.21.0

## 0.20.0

### Patch Changes

- @lazysh/common@0.20.0
  - @lazysh/notification-client@0.20.0

## 0.19.0

### Patch Changes

- @lazysh/common@0.19.0
  - @lazysh/notification-client@0.19.0

## 0.18.0

### Patch Changes

- @lazysh/common@0.18.0
  - @lazysh/notification-client@0.18.0

## 0.17.2

### Patch Changes

- @lazysh/common@0.17.2
  - @lazysh/notification-client@0.17.2

## 0.17.1

### Patch Changes

- @lazysh/common@0.17.1
  - @lazysh/notification-client@0.17.1

## 0.17.0

### Patch Changes

- @lazysh/common@0.17.0
  - @lazysh/notification-client@0.17.0

## 0.16.0

### Patch Changes

- @lazysh/common@0.16.0
  - @lazysh/notification-client@0.16.0

## 0.15.0

### Patch Changes

- @lazysh/common@0.15.0
  - @lazysh/notification-client@0.15.0

## 0.14.0

### Patch Changes

- @lazysh/common@0.14.0
  - @lazysh/notification-client@0.14.0

## 0.13.0

### Patch Changes

- @lazysh/common@0.13.0
  - @lazysh/notification-client@0.13.0

## 0.12.2

### Patch Changes

- @lazysh/common@0.12.2
  - @lazysh/notification-client@0.12.2

## 0.12.1

### Patch Changes

- @lazysh/common@0.12.1
  - @lazysh/notification-client@0.12.1

## 0.12.0

### Patch Changes

- @lazysh/common@0.12.0
  - @lazysh/notification-client@0.12.0

## 0.11.0

### Patch Changes

- @lazysh/common@0.11.0
  - @lazysh/notification-client@0.11.0

## 0.10.1

### Patch Changes

- 3ec508c: Preserve explicit Pi tool-result error booleans in recorded chat and reuse the recorded-error badge without inferring live state or changing other adapters.
- @lazysh/common@0.10.1
  - @lazysh/notification-client@0.10.1

## 0.10.0

### Patch Changes

- @lazysh/common@0.10.0
  - @lazysh/notification-client@0.10.0

## 0.9.1

### Patch Changes

- @lazysh/common@0.9.1
  - @lazysh/notification-client@0.9.1

## 0.9.0

### Patch Changes

- @lazysh/common@0.9.0
  - @lazysh/notification-client@0.9.0

## 0.8.0

### Patch Changes

- @lazysh/common@0.8.0
  - @lazysh/notification-client@0.8.0

## 0.7.1

### Patch Changes

- @lazysh/common@0.7.1
  - @lazysh/notification-client@0.7.1

## 0.7.0

### Patch Changes

- @lazysh/common@0.7.0
  - @lazysh/notification-client@0.7.0

## 0.6.0

### Patch Changes

- @lazysh/common@0.6.0
  - @lazysh/notification-client@0.6.0

## 0.5.0

### Patch Changes

- @lazysh/common@0.5.0
  - @lazysh/notification-client@0.5.0

## 0.4.0

### Patch Changes

- @lazysh/common@0.4.0
  - @lazysh/notification-client@0.4.0

## 0.3.0

### Minor Changes

- c997e5f: Add explicitly opted-in Claude reported-history metadata and a selected-row shortcut into Chat. Source files remain unread until Open transcript; reported history does not verify a running agent or enable direct Send/Stop. Existing capture, image and Follow defaults remain off.

### Patch Changes

- @lazysh/common@0.3.0
  - @lazysh/notification-client@0.3.0

## 0.2.1

### Patch Changes

- @lazysh/common@0.2.1
  - @lazysh/notification-client@0.2.1

## 0.2.0

### Patch Changes

- @lazysh/common@0.2.0
  - @lazysh/notification-client@0.2.0
