# Background work and session status

A session is **idle** or **done** only when its foreground turn has ended and it has no work left in the
background: a shell started with `run_in_background`, a monitor, a background sub-agent, a dynamic workflow.
The hooks alone cannot say that: `Stop` ends the turn, not the work. This page lists, per agent and per kind
of work, which signal proves the work is still open, which proves it ended, how stale evidence is bounded,
and what is unavailable. Tracked by [#2956](https://github.com/mihazs/lazysh/issues/2956).

Nothing here is guessed. A claim names where it was observed. "Not established" means no verified record
exists, so the session keeps the state its hooks reported.

## Rules

- The hook state is stored as written. The snapshot overlays `working` on a stored `done` for as long as
  recorded evidence says work is open, so when the evidence goes away the row is what the hooks said.
- Evidence that cannot end by itself is tied to something that dies with the work: the agent process. A
  dead process, a missing registry entry and an unreadable record all mean "no background work".
- Evidence that no record ends (a monitor whose end was never written) is never counted past its bound.
- Only `working`, `needs_attention` and `done` exist in the snapshot; a new value would make an older
  client reject the whole snapshot. Detail is the optional `background` object.

## The snapshot field

`lazysh-agent snapshot` rows carry an optional

```json
"background": {"agents": 2, "workflows": 1, "shells": 1}
```

Counts are positive integers, zero is omitted, and the field is absent when nothing is open.
`agents` are background sub-agents, `workflows` dynamic workflows, `shells` background shell commands and
monitors together (the agent reports their presence, not how many, so it is a lower bound). A row with the
field is `working` with the summary "Working in the background". A companion without the field behaves as
before, and a client that does not know it shows `working`.

## Claude Code (observed on 2.1.326)

| Kind | Open | Ended | Bound | Unavailable |
| --- | --- | --- | --- | --- |
| Background shell (`Bash` with `run_in_background`) | The session registry file `<config>/sessions/<pid>.json` has `status: "shell"` | The status leaves `shell`; also a `<task-notification>` record naming the task | The process: the registry entry counts only while its process lives | Which shell, how many, its output (the transcript has launches and notices, not liveness) |
| Monitor | The same `status: "shell"` (a monitor is a background shell task) | The same | The same | The same |
| Background sub-agent | The last `system/turn_duration` record of the conversation file has `pendingBackgroundAgentCount` above zero | The next turn's `turn_duration` has a lower count | 24 hours after that record, and the process | Titles and progress here; the Agent view reads them from `<task-notification>` and `task_status` records |
| Dynamic workflow | `turn_duration.pendingWorkflowCount` above zero | The next turn's count | The same | The same |

How each signal works:

- **Session registry.** Claude Code writes `<config>/sessions/<pid>.json` for every running session, where
  `<config>` is `CLAUDE_CONFIG_DIR` or `~/.claude`: `pid`, `sessionId`, `procStart`, `kind`
  (`interactive`, `bg`, `daemon`), `status` and `statusUpdatedAt`. `status` is one of `busy` (a turn is
  running), `waiting` (a dialog waits for the person), `idle` and `shell`. In the agent's own code `shell`
  is exactly "idle while at least one background shell or monitor task has not finished", the label its
  own session list shows. The file is rewritten in place, so a reader can see a torn file and must treat
  it as absent for that read. `procStart` is the process start time (on Linux the 22nd field of
  `/proc/<pid>/stat`), which makes a recycled pid detectable. The file is not documented; it is read only
  while its shape matches and ignored otherwise.
- **`turn_duration`.** A `system` record with `subtype: "turn_duration"` is written after the turn's
  `Stop` hooks, so it is not yet there when `Stop` is delivered. It carries `pendingBackgroundAgentCount`
  and `pendingWorkflowCount` (absent when zero), the agent's own count of sub-agents and workflows still
  running when the turn ended. A newer main-thread `user` or `assistant` record after it means a turn is
  running again and the record says nothing. It does not count shells or monitors.
- **Transcript launches and notices.** `work.rs` derives per-task rows from `tool_use`, `tool_result` and
  `<task-notification>` records. It is exact for the tasks it sees end and cannot prove a task is still
  open: a scan of 250 recorded sessions finds hundreds of launches with no recorded end (the person killed
  the shell, the session was resumed, the notice was never written). It feeds the Agent view's panel, not
  the status.
- **Hooks.** `SubagentStart` and `SubagentStop` exist but the managed profiles do not install them, and no
  hook fires when a shell or a monitor ends. A finished task wakes the agent for a new turn, which sends
  hooks again, but only at its first tool call or `Stop`: the registry's `busy` is the earlier signal.
- **No registry** (an older Claude Code, another `CLAUDE_CONFIG_DIR` than the companion's): only the
  `turn_duration` counts are read, and only for 15 minutes after the record's timestamp, because without
  the process nothing proves the agent is alive.

A `done` row whose summary is "Session ended" (`SessionEnd`) never gets background work: the session's
tasks end with it.

## Other agents

| Agent | Recorded signals | Background work the records can prove | Unavailable |
| --- | --- | --- | --- |
| Codex | `SubagentStart` and `SubagentStop` hooks (parent `session_id`, child `agent_id`); `SubAgentActivity` rollout items (`started`, `completed`); `agent_message` `FINAL_ANSWER` | Sub-agents, from the rollout items ([#2961](https://github.com/mihazs/lazysh/issues/2961)) | Background terminals: an item is written when the command ends, never while it runs (300 recorded sessions checked); Stop does not wait for children, and the hooks are ignored for the parent's row today |
| OpenCode | A background `task` call (`backgroundTaskId`), its `background_output` result and the `[BACKGROUND TASK COMPLETED]` user message | Background tasks, from `opencode_work.rs` | Shells and monitors (OpenCode has none); a task whose end was never recorded |
| Grok Build | `subagent_spawned`, `subagent_finished`, `task_backgrounded` and `task_completed` in `updates.jsonl` | Sub-agents and background commands, from `grok_work.rs`, fixture-pinned to the writer source | No capture of a real session; hook events tagged with a `subagentType` are not the parent's |
| Gemini CLI | `run_shell_command` with `is_background`; `invoke_agent` calls | Sub-agents from `invoke_agent`; shell launches | The end of a background shell under the default `backgroundCompletionBehavior: silent` |
| GitHub Copilot CLI | `Notification` types for a background shell, an agent completing and idle | Not established: the hook configuration omits the launch side | Launches, counts, every end |
| Kimi CLI | `SubagentStart`/`SubagentStop`; `agent_id` on permission events; the root's `Stop` arrives before the child's work | Not established: `Stop` is not completion and nothing counts children | Launches, counts, ends |
| Droid, Cursor, Amp, Cline, Aider | None verified | Not established | Everything |

Those agents keep the state their hooks reported. Vendors move from "not established" to "provable" only
with a recorded session or a pinned writer source, never by inference.

## What was checked

- Claude Code 2.1.326 on Linux: the registry statuses `busy`, `shell` and `idle` against live processes
  (the `procStart` of each matched `/proc/<pid>/stat`), three idle sessions holding monitors reading
  `shell` while their last `turn_duration` carried no pending agent, and the `turn_duration` counts across
  250 recorded conversations (agents up to 15, workflows up to 26).
- The snapshot behaviour of the Claude Code evidence is [#2958](https://github.com/mihazs/lazysh/issues/2958); the other agents are [#2961](https://github.com/mihazs/lazysh/issues/2961). Until they land, the snapshot reports the hook state as before.
- Not checked: macOS and Windows registry behaviour, Claude Code versions before 2.1.326, a real Codex,
  OpenCode, Grok or Gemini session with background work.
