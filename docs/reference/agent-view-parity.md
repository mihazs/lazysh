# Agent view parity: screen elements, reference apps and gaps

Status: reference, audited 2026-11-11 against `main` at `7f16dcee`. Tracked by
[#1217](https://github.com/mihazs/lazysh/issues/1217), under the Agent view epic
[#1119](https://github.com/mihazs/lazysh/issues/1119). The design the gaps are measured
against is the [Agent view specification](../agent-view.md); this page does not change it.

The Agent view should show what the agent's own screen shows, as it happens, and be at least
as good to read on a phone as the best mobile agent clients. This page lists every kind of
screen element the Claude Code and Codex terminal UIs show, where each is recorded, how the
reference apps present it, what the Agent view does today, and which issue closes the gap.

## How the inventory was made

- **Agent screens**: the public documentation of each agent ([Claude Code interactive mode and
  status line](https://code.claude.com/docs/en/interactive-mode), [Codex CLI](https://learn.chatgpt.com/docs/codex/cli)),
  combined with the record **types** present in locally stored Claude Code and Codex session
  files, to learn which elements leave a trace in a transcript at all. Only type names were
  read. No prompt, path, output or other session content appears in this page, in the issues
  or in any test; fixtures for every gap are synthetic.
- **Reference apps**: public material only, collected in the two reference studies on the
  umbrella issue ([part 1, Herdr mobile clients](https://github.com/mihazs/lazysh/issues/1217#issuecomment-6798068186),
  [part 2, Claude, Codex, Perplexity, Grok, GitHub Copilot, Cursor and Happy](https://github.com/mihazs/lazysh/issues/1217#issuecomment-6798518905)).
  Behaviour is described in our own words; nothing was copied. "n/d" means not documented
  publicly, not absent.
- **Agent view today**: the client code on `main` (`AgentView.tsx`, `ChatPanel.tsx`,
  `ChatInteraction.tsx`, `chatInjected.ts`) and the companion's conversation readers.
- Transcript formats are the agents' own and not a public contract. The adapters tolerate
  record types they do not know, and each new element ships only with synthetic fixtures for
  the shapes it relies on.

Status words: **shipped** (works on `main`), **partial** (part exists, the cell says what is
missing), **missing**, **in flight** (a PR is open). Gap numbers are GitHub issues.

## Elements of the agent screens

| Element | Recorded in the transcript as | Reference apps | Agent view today | Gap |
| --- | --- | --- | --- | --- |
| **Working line**: spinner or verb, elapsed time, token counts, interrupt hint | Not as a line. Claude Code: `system` `turn_duration` at the end, `assistant` `message.usage`, timestamps; hooks give working and idle edges. Codex: `task_started`, `task_complete`, `token_count`, `turn_aborted` | Cursor (timed "Worked" row), Happy (live thinking indicator), Copilot (four states), Claude and Codex apps (turn state reported wrong at times) | Partial: the hook-reported state as a dot and a word in the header, and the recorded turn state as **Agent is working** or **Agent is waiting for your answer** at the end of the thread, updated by the live stream ([#1276](https://github.com/mihazs/lazysh/pull/1276)); no elapsed time while a turn runs (only a per-turn duration once messages exist), no token counts | [#1223](https://github.com/mihazs/lazysh/issues/1223) |
| **Todo or plan list** | Claude Code: `TodoWrite` tool calls. Codex: `update_plan` calls | Perplexity, Grok Build CLI, Copilot, Cursor (desktop) | Partial: display-only card inside the folded activity of the turn that wrote it; no pin, no progress count, each update is a new card | [#1227](https://github.com/mihazs/lazysh/issues/1227) (of [#1122](https://github.com/mihazs/lazysh/issues/1122)) |
| **Tool call and result**: Bash, Read, Grep, Glob, MCP tools | `tool_use` and `tool_result` blocks; Codex `function_call`, `custom_tool_call` and their outputs, `item_completed` command items | All studied clients: one truncated row per call that opens on tap | Partial: collapsed block with the tool name, a recorded status and the raw JSON input; the result is a separate block | [#1225](https://github.com/mihazs/lazysh/issues/1225) |
| **File edit and diff**: Edit, MultiEdit, Write, `apply_patch` | The edit tool's input (old and new text, or a patch); `edited_text_file` attachments | Claude (Changes card), Codex (summary, file, source), Cursor (diff-only review), Happy | Missing: the edit renders as its raw JSON input | [#1226](https://github.com/mihazs/lazysh/issues/1226) |
| **Shell output**, including background commands | `tool_result` text; `run_in_background` calls; Codex exec items | Codex (pill with view and stop), Happy (Bash for all agents) | Partial: output inside the result block; nothing for a command still running in the background | [#1225](https://github.com/mihazs/lazysh/issues/1225), [#1230](https://github.com/mihazs/lazysh/issues/1230) |
| **Thinking or reasoning** | `thinking` blocks; Codex `reasoning` summaries | Grok ("Thought for N s"), Cursor, Copilot log | Partial: a closed block of raw text per message; redacted empty thinking is hidden | [#1228](https://github.com/mihazs/lazysh/issues/1228) |
| **Sub-agent and task progress** | Claude Code: `Agent` calls, sidechain records, `task_status` attachments. Codex: `spawn_agent`, `wait_agent`, `followup_task` and related calls | Codex (open the child), Cursor (child transcript, parent status), Claude (running sub-agents on connect) | Missing: sidechain records are filtered out and the call is a generic tool block | [#1229](https://github.com/mihazs/lazysh/issues/1229) (of [#1122](https://github.com/mihazs/lazysh/issues/1122)) |
| **Background tasks** | Claude Code: background Bash, `Monitor`, `TaskStop`, `task_status`; Codex background terminals | Codex (pill), Claude (reported "ready for review" while jobs run) | Missing | [#1230](https://github.com/mihazs/lazysh/issues/1230) |
| **Permission or approval prompt** | Not in the transcript. Claude Code: the `PermissionRequest` hook (the existing [approvals](../approvals.md)); `permission_retry` and `command_permissions` records. Codex: not recorded | Codex (four outcomes), Happy (exact operation, remember for the session), Cursor, Copilot, Perplexity | Partial: Claude permission decisions work from the separate Approvals panel; the Agent view cannot answer and does not name the pending prompt | [#1121](https://github.com/mihazs/lazysh/issues/1121), [#1237](https://github.com/mihazs/lazysh/issues/1237) |
| **Structured question** | Claude Code `AskUserQuestion`; Codex `request_user_input` calls, later a matching output | Perplexity (in the input box), Cursor ("Input Needed"), Happy, Codex (persist after the turn) | Partial: a display-only card with its options and an "answer in the terminal" note | [#1121](https://github.com/mihazs/lazysh/issues/1121), [#1237](https://github.com/mihazs/lazysh/issues/1237) |
| **Plan approval** | Claude Code `ExitPlanMode`; Codex proposed plan items | Perplexity, Grok Build CLI, Copilot | Partial: a display-only proposed-plan card | [#1121](https://github.com/mihazs/lazysh/issues/1121), [#1227](https://github.com/mihazs/lazysh/issues/1227) |
| **Slash command echo and output** | `user` records with command tags; `system` `local_command` | Claude (typed `/model`, `/usage`), Perplexity (`/ask`) | Partial: the command reads as typed and its output is one muted line ([#1210](https://github.com/mihazs/lazysh/pull/1210)); no palette and nothing sends a command | [#1123](https://github.com/mihazs/lazysh/issues/1123) |
| **Compaction notice** | Claude Code `system` `compact_boundary`, the continued-session summary; Codex `compacted` | Claude app ("Catching up", a compaction row), Perplexity ("condense context?") | Partial: Claude Code shows a muted event line; Codex shows no notice | [#1236](https://github.com/mihazs/lazysh/issues/1236) |
| **Queued messages** | Claude Code `queue-operation` records and `queued_command` attachments | Claude, Codex, Cursor, Copilot, Perplexity (queue and steer, remove, send now) | Missing | [#1231](https://github.com/mihazs/lazysh/issues/1231), [#1123](https://github.com/mihazs/lazysh/issues/1123) |
| **Errors**: API, usage limit, tool, hook | `tool_result` with `is_error`; `system` records; Codex `turn_aborted`, `token_count` rate limits; hook failure attachments | Cursor (what to do next), Codex (usage limit and reset time in chat) | Partial: a failed-call count in the folded row and an error mark on the block; other failures render as plain text or not at all | [#1232](https://github.com/mihazs/lazysh/issues/1232) |
| **Interrupt** | A "request interrupted" user record; Codex `turn_aborted` | Copilot (Stop session), Happy (Stop works during a question), Perplexity (stop one sub-agent) | Partial: the marker is a muted line; the guarded Escape exists in the composer; no visible Stop with a receipt | [#1123](https://github.com/mihazs/lazysh/issues/1123) |
| **Images** | `image` blocks (Claude Code), `input_image` (Codex) | All studied clients | Partial: the placeholder "view in the host agent terminal"; bounded previews exist in Chat but are not requested here | [#1233](https://github.com/mihazs/lazysh/issues/1233) |
| **Web search and fetch** | `WebSearch` and `WebFetch` calls; Codex web search items | Perplexity and Grok (sources as chips) | Partial: a generic tool block | [#1225](https://github.com/mihazs/lazysh/issues/1225) |
| **Model, mode, context remaining, cost** | Claude Code: `message.model`, `permission-mode`, `mode`, `model` and `plan_mode` attachments, `usage`, `cost-state`. Codex: `turn_context`, `thread_settings_applied`, `token_count` with window and rate limits | Codex (context indicator), Claude (typed commands), Happy (context pill requested), Perplexity (model picker) | Missing in the view; the token counters of the latest response sit behind its options button | [#1224](https://github.com/mihazs/lazysh/issues/1224) |
| **Goal, recap, hook and skill events** | Claude Code `goal_status`, `plan_mode_exit`, `away_summary`, `hook_success`, `stop_hook_summary`, `invoked_skills`; Codex `thread_goal_updated` | n/d | Missing (hook success records must stay hidden) | [#1236](https://github.com/mihazs/lazysh/issues/1236) |
| **Session list and "needs you"** | Hook reports; Herdr live agent status | Claude ("Waiting for you"), Codex (Activity view), Cursor (count), Copilot, Paseo (Ready, Working, Done) | Partial: the live Herdr list with status ([#1189](https://github.com/mihazs/lazysh/issues/1189), shipped) and hook reports; linking the view to the pane's agent is in flight in [#1219](https://github.com/mihazs/lazysh/pull/1219); no count or blocker kind | [#1237](https://github.com/mihazs/lazysh/issues/1237) |
| **Notifications** | Hook events | Claude, Codex, Cursor, Copilot, Happy (needs-you and done only, deep link) | Shipped for hook-reported events ([notifications](../notifications.md)); no deep link to the pending card | [#1237](https://github.com/mihazs/lazysh/issues/1237) |
| **Reading**: follow the tail, Jump to latest, hold position, older history, copy, search | n/a | Cursor (older pages keep the position, new prompt pinned), Herdr clients (copy, search, Conversation and Full history) | Follow and **Jump to latest** shipped; a live stream patches the thread in place and the turn at the top of the view keeps its position ([#1276](https://github.com/mihazs/lazysh/pull/1276)), while the polling fallback still replaces the page; only the last 50 messages; no copy, search or mode switch | [#1124](https://github.com/mihazs/lazysh/issues/1124), [#1234](https://github.com/mihazs/lazysh/issues/1234), [#1235](https://github.com/mihazs/lazysh/issues/1235) |
| **Real time, reconnect, stale** | The file changes as the agent writes | Cursor (cache-first, "Reconnecting"), Claude ("Catching up"), Codex (Retry), tuan3w/herdr-mobile (stale marker) | Partial: Claude Code and Codex conversations stream over one SSH channel (host command [#1222](https://github.com/mihazs/lazysh/pull/1222), merged; client [#1276](https://github.com/mihazs/lazysh/pull/1276)), with polling as the fallback, a delayed hint, a stale marker and an update message for an older companion; no partial text, because the agents record completed messages only; the Codex app-server daemon and other agents are not covered | [#1124](https://github.com/mihazs/lazysh/issues/1124) |
| **Composer**: send, attachments, drafts | n/a | All studied clients | Partial: confirmed send of text and the Escape stop on native tmux and guarded Herdr, **Stage in terminal**, attachment upload; no receipts, no queue or steer choice, no slash palette | [#1123](https://github.com/mihazs/lazysh/issues/1123) |

Not a gap: **token streaming**. Claude Code and Codex record completed items, so no client
that wraps them shows partial text, and lazysh does not promise it. "Real time" here means a
completed record on screen within a fraction of a second, plus a visible working state.
Agents with a live protocol (the Codex app-server daemon) are the exception the spec
already describes under [#1124](https://github.com/mihazs/lazysh/issues/1124).

## Prioritized gaps

Priority follows what a person watching the agent from a phone needs first: knowing it is
alive and what it waits for, then seeing what it did, then reading comfort. Each row is one
small PR.

| Priority | Issue | Closes | Needs |
| --- | --- | --- | --- |
| P0 | [#1124](https://github.com/mihazs/lazysh/issues/1124) Live updates | Real time, reconnect, stale, the delayed fallback | Host command [#1222](https://github.com/mihazs/lazysh/pull/1222) (merged), client [#1276](https://github.com/mihazs/lazysh/pull/1276) |
| P0 | [#1223](https://github.com/mihazs/lazysh/issues/1223) Working state, elapsed time, tokens | Working line | Live status from #1124 |
| P0 | [#1237](https://github.com/mihazs/lazysh/issues/1237) What the agent waits for | Waiting state by kind, count, deep link | Answering is [#1121](https://github.com/mihazs/lazysh/issues/1121) |
| P0 | [#1224](https://github.com/mihazs/lazysh/issues/1224) Model, mode, context, cost | Status line items | Companion `session` field |
| P0 | [#1225](https://github.com/mihazs/lazysh/issues/1225) Typed tool cards | Tool calls, shell output, search and fetch | Companion schema 2 call kinds |
| P0 | [#1226](https://github.com/mihazs/lazysh/issues/1226) Diff cards | File edits | Companion `edit` kind |
| P0 | [#1227](https://github.com/mihazs/lazysh/issues/1227) Pinned plan and todo | Todo or plan list | none |
| P1 | [#1121](https://github.com/mihazs/lazysh/issues/1121) Answer questions and approvals | Questions, approvals, plan approval | Guarded `select` input |
| P1 | [#1123](https://github.com/mihazs/lazysh/issues/1123) Prompts, slash commands, interrupts | Composer, queue and steer, interrupt | Guarded input |
| P1 | [#1228](https://github.com/mihazs/lazysh/issues/1228) Thinking row | Thinking | none |
| P1 | [#1229](https://github.com/mihazs/lazysh/issues/1229) Sub-agent progress | Sub-agents | Companion `task` kind |
| P1 | [#1230](https://github.com/mihazs/lazysh/issues/1230) Background tasks pill | Background tasks | Companion records |
| P1 | [#1231](https://github.com/mihazs/lazysh/issues/1231) Queued messages | Queue display | Companion records |
| P1 | [#1232](https://github.com/mihazs/lazysh/issues/1232) Error cards | Errors | Synthetic fixtures per shape |
| P2 | [#1233](https://github.com/mihazs/lazysh/issues/1233) Image previews | Images | Existing bounded previews |
| P2 | [#1234](https://github.com/mihazs/lazysh/issues/1234) Copy, search, Full history | Reading tools | none |
| P2 | [#1235](https://github.com/mihazs/lazysh/issues/1235) Older messages | Older history | Companion cursor |
| P2 | [#1236](https://github.com/mihazs/lazysh/issues/1236) Goal, recap and hook events | Event lines | Fixtures per event |

Other agents (OpenCode, Grok Build, Gemini CLI) follow in [#1125](https://github.com/mihazs/lazysh/issues/1125)
once these elements exist for Claude Code and Codex. The opaque transcript reference of
[#1152](https://github.com/mihazs/lazysh/issues/1152) applies to every row that reads a
transcript. Keeping the compact chrome of [#1210](https://github.com/mihazs/lazysh/pull/1210)
is a constraint on every row: the chat gets the screen, and no element adds a permanent row
of header height without removing another.

## Where the elements come from

The sources and authority order of the [Agent view specification](../agent-view.md#sources-and-authority)
apply unchanged: a live protocol outranks the transcript, the transcript outranks hooks, and
the terminal screen is used only for what nothing above shows and never grants authority.
The working state, the waiting state and the model and mode each name their source in the
view, because the apps studied show that a state taken from the wrong source is the most
common way a mobile client misleads (a turn shown finished while it runs, "ready for review"
with background work, a send arrow stuck disabled).
