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

## Gemini CLI, Droid and Kimi CLI

`lazysh-agent gemini-config` prints a Gemini `settings.json` fragment. Its
`hooks` wrapper contains BeforeAgent, BeforeTool, AfterTool, Notification,
AfterAgent and SessionEnd. Gemini deadlines are milliseconds: the fragment uses
5000, while Droid and Kimi use five seconds. Gemini ToolPermission notifications
indicate attention; successful final responses indicate completion. A model
response chunk or SessionStart does not imply a new working turn.

`lazysh-agent droid-config` prints the standalone event map for Factory
`hooks.json`, without a `hooks` wrapper. Settings-file declarations use a
wrapper instead; preserve existing settings when merging. Droid prompt/tool
activity indicates work; permission, idle and elicitation notifications indicate
attention. Droid also emits an idle notification after cancellation, so a
canceled turn is not reported as a successful final response.

`lazysh-agent kimi-config` prints JSON containing a TOML fragment in `content`
for Kimi's `[[hooks]]` entries. Kimi prompt/tool activity indicates work, including
failed tools while the agent continues. Only the documented permission_prompt
notification is treated as a permission wait. SessionStart and child lifecycle
notifications do not finish a parent or create a fictitious working turn.

Kimi 1.52.0 shares the parent's session and hook engine with child souls. Both
root and child turns emit identical unscoped Stop/StopFailure payloads, so those
events are deliberately omitted and ignored. This avoids finishing or faulting
a parent when only a child stopped. Per-turn completion is unavailable through
this hook contract; the last observed working state can remain during idle time.
SessionEnd reports the root CLI-instance/session-owner boundary, including a
reload, rather than completion of each turn. This capability gap remains open.

These commands only print configuration and require a companion executable
available in the hook environment. Factory recommends absolute command paths;
replace the printed executable with its verified installed absolute path when
configuring Droid. No command writes an agent profile, overwrites unrelated
hooks, grants permissions or installs software. Captured metadata has the same
bounds and privacy projection as other lifecycle adapters.

Gemini contracts were checked against release
[v0.66.0 hook types](https://github.com/google-gemini/gemini-cli/blob/v0.66.0/packages/core/src/hooks/types.ts)
and [runner](https://github.com/google-gemini/gemini-cli/blob/v0.66.0/packages/core/src/hooks/hookRunner.ts).
Gemini's [outermost client completion guard](https://github.com/google-gemini/gemini-cli/blob/v0.66.0/packages/core/src/core/client.ts)
and [direct child chat executor](https://github.com/google-gemini/gemini-cli/blob/v0.66.0/packages/core/src/agents/local-executor.ts)
qualify AfterAgent as the outer client boundary rather than child completion in
that release. Droid was checked against its [hook reference](https://docs.factory.com/harness/hooks), and
Kimi against release [1.52.0 event constructors](https://github.com/MoonshotAI/kimi-cli/blob/1.52.0/src/kimi_cli/hooks/events.py)
and [configuration model](https://github.com/MoonshotAI/kimi-cli/blob/1.52.0/src/kimi_cli/hooks/config.py).
Kimi's attribution limit follows the [shared child runtime](https://github.com/MoonshotAI/kimi-cli/blob/1.52.0/src/kimi_cli/soul/agent.py),
[propagated child hook engine](https://github.com/MoonshotAI/kimi-cli/blob/1.52.0/src/kimi_cli/subagents/runner.py),
[unscoped terminal events](https://github.com/MoonshotAI/kimi-cli/blob/1.52.0/src/kimi_cli/soul/kimisoul.py)
and [root CLI SessionEnd owner](https://github.com/MoonshotAI/kimi-cli/blob/1.52.0/src/kimi_cli/cli/__init__.py).
Tests invoke the actual companion CLI with synthetic native payloads and parse
the printed TOML with Bun. Real authenticated agent sessions remain unverified.

## GitHub Copilot CLI

`lazysh-agent copilot-config` prints a version-1 hook file for the selected
Copilot CLI hook scope. It uses shell-free `exec` and fixed `args`, with a
five-second `timeoutSec`. PascalCase compatible events provide the explicit
hook name and snake_case session identity for prompt submission, post-tool
activity and main-turn/session completion. The native lowercase `notification`
event instead has `hook_event_name: "Notification"` and camelCase `sessionId`;
the adapter reads that exact field rather than guessing from another identity.

Only permission_prompt and elicitation_dialog notifications indicate attention.
Background shell completion, agent completion and agent_idle notifications do
not finish or change the parent report. Stop/SessionEnd payloads explicitly
attributed to a subagent likewise cannot finish the parent row. The configuration deliberately omits
preToolUse because observational failures there can deny a tool. It also omits
permissionRequest because that fires before automatic rules and does not prove
that a human prompt is waiting. No approval decision or additional context is
returned. This targets Copilot CLI; notification and shell-free execution
support differ in the cloud agent. Contracts follow the current
[official hook reference](https://docs.github.com/en/copilot/reference/hooks-reference);
authenticated Copilot CLI acceptance remains unverified.

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
| [Gemini CLI](https://geminicli.com/docs/hooks/reference/) | BeforeAgent/BeforeTool; Notification ToolPermission; AfterAgent/SessionEnd | Native adapter and print-only settings fragment; contract fixtures |
| [GitHub Copilot CLI](https://docs.github.com/en/copilot/reference/hooks-reference) | Prompt/post-tool aliases; attention notifications; Stop/SessionEnd | Native observer adapter and shell-free print-only fragment; CLI contract fixtures |
| [Cursor CLI](https://cursor.com/docs/hooks) | beforeSubmitPrompt/tool events; permission-capable hooks; stop/sessionEnd | Pending native adapter; pre-tool invocation alone does not prove a waiting human prompt |
| [Droid](https://docs.factory.com/harness/hooks) | UserPromptSubmit/tool events; Notification permission_prompt; Stop/SessionEnd | Native adapter and print-only standalone hook map; contract fixtures |
| [Amp](https://ampcode.com/docs/plugin-api) | Native `ctx.thread.state` observable: idle, running, awaiting-approval and error | Pending native plugin; generated provider interface confirmed, runtime integration unverified |
| [Aider](https://aider.chat/docs/usage/notifications.html) | Native input-boundary notification; [v0.86.0 caller](https://github.com/Aider-AI/aider/blob/v0.86.0/aider/io.py) also invokes it before potentially automatic confirmations | Pending adapter; callback provides no state or session identity and does not prove turn completion or a waiting human |
| [Kimi CLI](https://moonshotai.github.io/kimi-cli/en/customization/hooks.html) | Prompt/tool activity; permission notification; root CLI SessionEnd | Native observable callbacks and TOML fragment; unscoped per-turn completion remains unavailable; hooks are beta |

Generic schema-1 ingestion remains available for explicit integrations, but a
generic wrapper is not evidence that these pending native adapters work. This
milestone does not close the ten-agent acceptance requirement or install hooks
into any profile automatically.
