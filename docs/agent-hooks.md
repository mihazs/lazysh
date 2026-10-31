# Agent lifecycle hooks

Companion lifecycle reports describe observed activity. They do not grant terminal
input access, answer permission prompts, install an agent or discover processes
that have not emitted a report. Transcript readers are separate from lifecycle
adapters. Reports contain bounded session identity, agent name, project path,
status, a generic summary and the inherited tmux pane hint, when available.
Prompts, tool arguments, transcript paths and provider credentials are discarded.

## Claude Code, Codex and OpenCode

`lazysh-agent claude-config` prints the existing Claude configuration fragment.
`lazysh-agent codex-config` prints a fragment for Codex `hooks.json`. Merge a
reviewed fragment with existing settings; do not replace unrelated hooks. Codex
requires its normal hook trust review before non-managed hooks run. Lazysh does
not modify trust records or bypass that review. The companion executable must
be available to the agent's hook environment.

`lazysh-agent opencode-plugin` prints JSON containing the exact `filename` and
`content` of the OpenCode plugin asset. Place reviewed content in the selected
OpenCode plugin directory, preserving other plugins. The native plugin uses
OpenCode's Bun runtime and invokes the companion with a fixed argv and a
three-second deadline that kills and reaps the owned ingest process. Missing or unavailable companions do not reject
OpenCode events or answer its permission requests. Successful ingestion is silent.

Codex reports main-thread prompt/tool activity as working, permission requests as
needing attention and Stop, Interrupt or SessionEnd as completed. SessionStart
does not imply an active turn. Codex subagent hooks use the parent's session ID;
SubagentStart and SubagentStop are deliberately ignored so child completion
cannot finish the parent's row. A Stop report is an observation; another hook can
continue the turn and subsequent activity updates its state again.

OpenCode reports busy/retry as working, permission/question requests and identified
session errors as needing attention, and idle/deletion as completed. Replies to
questions or permissions do not imply completion. The plugin listens to
`session.status`, avoiding duplicate completion reports from OpenCode's additional
`session.idle` event. Only identifiers, a closed status value and the plugin's
directory are passed to the companion. Events without session attribution are
ignored. Hook metadata never supplies live input authority.

The Codex contract was checked against the installed CLI 0.166.0 and current
[official hook reference](https://learn.chatgpt.com/docs/hooks). OpenCode payloads
were checked against release
[v1.19.5 generated SDK types](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/sdk/js/src/v2/gen/types.gen.ts)
and its [native plugin API](https://opencode.ai/docs/plugins/).
Automated fixtures exercise these contracts; real authenticated agent sessions
remain a separate acceptance check.

## Broader CLI coverage

This ten-agent cohort is the compatibility target for issue #603. It is not a
measured ranking of active CLI users: vendors do not publish comparable usage
counts. It combines the three explicitly requested agents, established public
CLI projects and commercial terminal agents with documented extension surfaces.
As a public adoption cross-check on 2026-10-31, GitHub repository stars were
OpenCode 223,379, Claude Code 153,994, Codex 132,149, Gemini CLI 108,640, Aider
49,834 and Kimi CLI 11,422. Stars measure repository interest, not installed CLI
usage; commercial issue trackers and action repositories are not comparable.

| Agent | Native working / attention / completion surface | Lazysh lifecycle coverage |
| --- | --- | --- |
| [Claude Code](https://code.claude.com/docs/en/hooks) | UserPromptSubmit/tool events; PermissionRequest and attention notifications; Stop/SessionEnd | Existing native adapter; lifecycle fixture coverage |
| [Codex](https://learn.chatgpt.com/docs/hooks) | UserPromptSubmit/tool events; PermissionRequest; Stop/Interrupt/SessionEnd | Native adapter and print-only configuration; contract fixtures |
| [OpenCode](https://opencode.ai/docs/plugins/) | session.status busy/retry; permission.asked/question.asked; status idle/session.deleted | Native plugin and adapter; contract fixtures |
| [Gemini CLI](https://geminicli.com/docs/hooks/reference/) | BeforeAgent/BeforeTool; Notification ToolPermission; AfterAgent/SessionEnd | Pending native adapter; JSON hook output must respect Gemini's contract |
| [GitHub Copilot CLI](https://docs.github.com/en/copilot/reference/hooks-reference) | userPromptSubmitted/preToolUse; permissionRequest/notification; agentStop/sessionEnd | Pending native adapter; CLI and cloud event availability differ |
| [Cursor CLI](https://cursor.com/docs/hooks) | beforeSubmitPrompt/tool events; permission-capable hooks; stop/sessionEnd | Pending native adapter; pre-tool invocation alone does not prove a waiting human prompt |
| [Droid](https://docs.factory.com/harness/hooks) | UserPromptSubmit/tool events; Notification permission_prompt; Stop/SessionEnd | Pending native adapter |
| [Amp](https://ampcode.com/docs/customize/plugins) | agent.start/tool.call; plugin UI confirmations; agent.end | Pending native plugin; no documented general waiting-for-permission event or session.end in this reference |
| [Aider](https://aider.chat/docs/usage/notifications.html) | Custom notification command when response finishes | Completion-only native notification surface identified; full turn/attention integration still needs a separate supported contract |
| [Kimi CLI](https://moonshotai.github.io/kimi-cli/en/customization/hooks.html) | UserPromptSubmit/tool events; Notification; Stop/StopFailure/SessionEnd | Pending native adapter; documented hooks are beta |

Generic schema-1 ingestion remains available for explicit integrations, but a
generic wrapper is not evidence that these pending native adapters work. This
milestone does not close the ten-agent acceptance requirement or install hooks
into any profile automatically.
