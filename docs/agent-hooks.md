# Agent lifecycle hooks

## Managed lifecycle hook setup

Opening **Agents → Agent hook setup** detects installed agents and known profile
locations on the connected SSH host. Select an agent and profile, then choose
**Inspect setup**. Detection does not execute agents or install hooks. A found
profile is shown separately from an installed executable; manual-only adapters
cannot use managed installation.
Use manual setup for an alternate absolute profile directory. The SSH environment
can differ from a running agent's environment, so an inferred path does not prove
which profile that agent loaded. Missing profiles are not created automatically.
Installing/updating or removing requires a separate explicit action against
that inspected plan. Install or update the host companion first when the host
has an older version. Setup uses the resolved companion executable's absolute
path; the agent hook environment does not need that executable on `PATH`.
The executable's retained namespace must be owned by the current user or root
and protected from replacement through writable or symlink ancestors. Root-owned
standard binary directories are supported; shared writable source directories
are refused.

Managed setup supports Claude Code, Codex, Droid, Gemini CLI, Cursor CLI, OpenCode and Cline CLI
on the qualified Linux filesystems described below. Gemini uses the selected
`.gemini/settings.json`; Cursor uses `.cursor/hooks.json`. Select the actual
existing profile directory explicitly, including any alternate configuration
layer; detection does not establish or enable the provider's active layer.

Gemini's six native groups retain their 5000 **millisecond** deadline and preserve
`hooksConfig.enabled` and `hooksConfig.disabled` exactly. Cursor retains its
version-1 root envelope and five-second flat command groups. Explicit installation
can add a missing version-1 header; incompatible existing versions are refused.
Removal leaves the shared version header. Cursor observers retain default
fail-open behavior, without adding `failClosed` or permission-capable pre-hooks;
foreign policy and hooks are preserved. Configured entries do not establish that
global hooks are enabled, trusted, or reporting in the running provider.

The equivalent local commands are:

```sh
lazysh-agent hooks discover
lazysh-agent hooks preview --agent codex
lazysh-agent hooks status --agent codex --profile-root /home/user/.codex
lazysh-agent hooks install --agent codex --profile-root /home/user/.codex --expected-plan <installPlan>
lazysh-agent hooks remove --agent codex --profile-root /home/user/.codex --expected-plan <removePlan>
```

Discovery uses executable metadata on bounded absolute `PATH` entries and known
Codex standalone locations. It respects `CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
`GEMINI_CLI_HOME` (with `.gemini` appended), and OpenCode's
`OPENCODE_CONFIG_DIR`/XDG configuration directory, plus Cline's `CLINE_DIR` or `~/.cline`. `OPENCODE_CONFIG` names a file,
so it is not used as a hook profile directory. Invalid overrides are reported
instead of silently selecting another profile. A truncated scan is labelled;
manual selection remains available. No credential or profile contents are read
by discovery. Discovery and managed installation have separate platform limits.
Cursor hook discovery uses its [documented hook location](https://prod.cursor.com/docs/hooks), `~/.cursor/hooks.json`;
CLI configuration overrides are not assumed to relocate hooks. Use manual
selection for another verified hook layer.

`install` also updates existing owned entries. Every changed profile needs a
fresh inspection. Claude and Gemini use `settings.json`, Codex and Cursor use `hooks.json`,
and OpenCode and Cline use `plugins/lazysh.js` under the selected profile. JSON must be strict,
without comments or duplicate keys. Existing foreign JSON value bytes remain
intact; owned entry separators and whitespace may change. A foreign same-name
plugin is never overwritten. The private prepared receipt records own
templates and hashes/identities, never a copy of provider configuration.

Cline setup installs only the existing root lifecycle plugin, bound to the inspected
absolute companion. Select the `.cline` directory used by `--config`, `CLINE_DIR`,
or the workspace explicitly; discovery cannot determine a running session's layer.
Start a new Cline session with that profile to load the plugin, then start a turn.
Existing disabled-plugin settings and plugin restrictions are preserved, and setup
does not establish live reporting. See Cline's [plugin locations](https://docs.cline.bot/sdk/plugin-install)
and [plugin lifecycle](https://docs.cline.bot/sdk/plugins).

Managed writes currently support qualified local Linux filesystems without
extended access/default ACLs. Special file permission bits, unsafe links,
read-only files, unhandled ACLs and uncertain ownership are refused. Existing
ordinary file permissions and group ID are retained. macOS/Windows writes
remain unsupported; preview is available without accessing a profile. Preview
labels POSIX shell, Bun JavaScript or Cline JavaScript dialect. On Windows it returns the
existing unbound print-only templates, explicitly without an executable
binding or managed-setup support; it does not quote a Windows executable as
a POSIX command. These
limits do not disable the existing print-only configuration commands below.

Configuration is separate from live reporting. Provider disable settings,
selected-layer overrides and Codex trust review still apply. Lazysh never
accepts Codex hook trust automatically. Review the provider's trust settings,
start a new session and verify actual lifecycle reports in Agents.

A stopped operation can leave prepared metadata. Inspect again and explicitly
choose the next operation; setup never resumes, retries or rolls back a write
automatically. Partial or edited owned entries produce a conflict requiring
manual review. Foreign edits after removal can conservatively produce a
conflict too. The cooperative profile lock and final preimage checks do not
provide an atomic compare-and-swap against a noncooperating editor changing a
path after the final check, or a physical power-loss durability guarantee.

Droid requires an already-existing, admitted `.factory/hooks.json` standalone
root event map. A missing file returns `HooksDroidStandaloneRequired` without
creating configuration or ownership metadata. Use Droid's native `/hooks` UI to
prepare/review its standalone file, then inspect again. Fresh-profile creation
and migration from `settings.json` or legacy `hooks/hooks.json` are unsupported:
creating a new standalone file could shadow those foreign declarations.
Existing fallback files and trust/disable/enterprise policy remain untouched.
Wrapped settings-style documents, non-array event values and duplicate keys
are refused. Removal retains the standalone file and foreign event groups.

Other native providers retain their agent-specific print-only setup commands.
Managed installation for them remains unimplemented.

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
OpenCode events or answer its permission requests. Successful ingestion is silent. The same asset exports the native 1.19.5 server
factory and 2.2 setup definition; no version selector is required. Pending
reports retain only the latest state per session, up to 64 sessions, and
unloading clears the queue and kills/reaps its current ingest process.

OpenCode 2.2 events are server-wide. Lazysh matches the plugin directory exactly
and keeps up to 256 verified session locations, including separate child IDs.
It subscribes before requesting one initial page of at most 128 existing sessions;
inventory itself never creates agent rows. Live creation, moves and deletion win
over a delayed inventory. Its three-second wait does not cancel native SDK work;
late results are ignored. Unknown events without a verified location are ignored.
There is no background pagination or per-event lookup.

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
and the pinned [2.2 plugin API](https://github.com/anomalyco/opencode/blob/v2.2.0/packages/plugin/src/promise/plugin.ts).
Isolated native 1.19.5 and 2.2 loaders select their respective factory or setup
once from the same module. Native 1.19.5 and 2.2 root/child session deletion APIs also
verify separate completed rows in the real companion Store. OpenCode 2.2 native
session forms verify an attributed attention report; completion remains tied to
the identified session rather than its parent. Full provider turns
and authenticated sessions remain separate acceptance checks.

## Cline CLI roots

`lazysh-agent cline-plugin` prints one original JavaScript plugin as JSON with
`filename`, `content` and `scope: root-only`. Review the content and place it in a
selected project's `.cline/plugins/lazysh.js`, or use Cline's ordinary reviewed
local-plugin installation. Preserve foreign plugins and their enabled/disabled
policies. This command does not install, enable or change anything in Cline.

Support is qualified for Cline CLI 3.0.74 default worker mode with one fixed
host-session workspace. A repeated setup disables observation rather than
rebinding old callbacks to a different workspace; SDK embedding and dynamic
workspace changes within one plugin instance are unsupported.

The plugin uses the native awaited `beforeRun` and `afterRun` callbacks, not
Cline's detached file hooks. It requires the actual run, conversation and agent
IDs. Report row IDs are a bounded domain-separated SHA-256 of the native agent
and conversation pair, preserving distinct roots even if a conversation is reused.
The plugin reports working on run start, completion/stopped on completed/aborted runs,
and generic attention on failure. It sends no prompts, responses, tool arguments,
error text or approval decisions. A fixed-argv companion process has a two-second
SIGKILL deadline and is reaped; plugin disposal retires queued work and reaps its
active process. Missing companions never change the callbacks' control results.

Initial support is deliberately root-only. Delegated children can inherit the
parent plugin while using another directory, so their callbacks are ignored;
parent workspace context is never attributed to a child. Shared root-session IDs
are not native run identity. Permission/question waits remain unsupported.
Explicit Linux managed setup is available as described above. A loaded plugin is
not proof of fresh reporting, and native worker failure or a missed callback can
leave an observation stale.

Contract source: [Cline CLI 3.0.74 runtime hooks](https://github.com/cline/cline/blob/071e1b25b48f9ef5dff7fc32085e6a16f02bf02e/docs/sdk/plugins.mdx).
The official Linux CLI 3.0.74 was qualified with a private loopback provider:
one interactive root retained its exact agent/conversation IDs across two native
run IDs and reported working, done, working, done to the actual companion Store.
A fresh owned Cline 3.0.74 session also qualified the managed absolute companion
binding with a private loopback provider: working advanced to the same row's
completed done state with `Turn finished` and fixed response readback. In a
separate owned profile, an existing exact-path `disabledPlugins` setting stayed
unchanged through installation and native response readback, with no companion
rows. This negative qualifies pre-run suppression; it does not identify after-run
callback timing. Both use an isolated local source-built companion, not a public
release artifact. Root-only child omission also has plugin/ingestion regression
coverage; actual child directory binding remains unqualified. Windows and real authenticated
provider sessions require separate qualification.

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

Droid managed setup uses the same six events and five-second deadline in its
standalone event map, with the inspected companion’s quoted absolute path.
Configured hooks still require Droid’s normal active-configuration review;
installation does not establish native event delivery. The
[official hook-file contract](https://docs.factory.com/harness/hooks) distinguishes
standalone files, fallback settings and legacy configuration.

The agent-specific commands above only print configuration and require a companion executable
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

## Cursor CLI, Amp and Aider

`lazysh-agent cursor-config` prints a version-1 Cursor hook fragment. Merge only
reviewed entries with the selected configuration. Prompt and post-tool activity
report work; `stop` reports completed, interrupted or failed turns using its
native status. `sessionEnd` reports an ended session. Conversation identity
survives generation changes. Tool events use native `cwd`; other events use one
workspace root, or an explicit multi-root/no-workspace label. Hook-process cwd
is not a project identity: user and plugin hooks may execute outside the project.
Subagent termination is ignored. Permission-capable pre-hooks are deliberately
not registered because invocation precedes policy and cannot prove a human wait.
Cursor documents observer errors, timeouts and empty output as fail-open by
default for these hooks; the fragment does not enable `failClosed` or emit a decision.
These contracts follow the [Cursor hook reference](https://cursor.com/docs/hooks)
and [scope-specific working directories](https://cursor.com/docs/reference/third-party-hooks).
Authenticated Cursor execution and neutral-output acceptance remain unverified.

`lazysh-agent amp-plugin` prints the original plugin in `content`, with its
suggested filename. Place reviewed content in your selected Amp plugin directory.
It subscribes to native `ctx.thread.state` for encountered threads: `running`
reports work, `awaiting-approval` reports attention, `idle` reports completion,
and `error` reports a failed turn. It does not intercept tools or answer approvals.
Per-thread writes are ordered; while a write is pending, only the latest next
state is retained. A late initial lookup cannot overwrite a newer native state.
The fixed companion child has a three-second hard deadline and is reaped;
plugin disposal unsubscribes observers and terminates owned children. Companion
absence does not reject provider callbacks. The [generated Amp API](https://ampcode.com/docs/plugin-api)
provides these native states, subscriptions and disposal hooks; see also
[plugin setup](https://ampcode.com/docs/customize/plugins). Fixture execution uses
the actual asset and documented API shapes, not an authenticated Amp session.

`lazysh-agent aider-config` prints supported native CLI arguments, including
`--notifications-command 'lazysh-agent aider-notification'`. Apply those arguments
explicitly when launching Aider; no configuration is written automatically.
The callback reads no stdin and records only a host-wide receipt count and time
in the existing private companion store. `lazysh-agent aider-hook-status` returns
that health plus the explicit capability limits: `sessionAttribution` is
`unavailable` and `lifecycleStates` is empty. Receipt is neither authenticated
provider execution nor evidence of any particular session or completed turn.

Aider [v0.86.0's notification caller](https://github.com/Aider-AI/aider/blob/v0.86.0/aider/io.py)
runs the configured shell command without a session/state payload. It can run
before input, including before potentially automatic confirmations within a turn.
Mapping it to done or human-waiting would be incorrect. This adapter therefore
creates no Aider session rows and cannot change another agent's state. The
[notification guide](https://aider.chat/docs/usage/notifications.html) documents
the supported command; its [embedding API](https://aider.chat/docs/scripting.html)
is explicitly unsupported and is not used as a lifecycle substitute.

## Broader CLI coverage

This compatibility cohort covers ten native lifecycle integrations plus Aider
callback health for issue #603. It is not a measured ranking of active CLI users:
vendors do not publish comparable usage counts. It combines the three explicitly requested agents, established public
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
| [Gemini CLI](https://geminicli.com/docs/hooks/reference/) | BeforeAgent/BeforeTool; Notification ToolPermission; AfterAgent/SessionEnd | Native adapter, print-only fragment and explicit Linux managed setup; contract fixtures |
| [GitHub Copilot CLI](https://docs.github.com/en/copilot/reference/hooks-reference) | Prompt/post-tool aliases; attention notifications; Stop/SessionEnd | Native observer adapter and shell-free print-only fragment; CLI contract fixtures |
| [Cursor CLI](https://cursor.com/docs/hooks) | beforeSubmitPrompt/tool events; permission-capable hooks; stop/sessionEnd | Native activity/completion adapter, print-only fragment and explicit Linux managed setup; actual permission-wait detection unavailable |
| [Droid](https://docs.factory.com/harness/hooks) | UserPromptSubmit/tool events; Notification permission_prompt; Stop/SessionEnd | Native adapter, standalone printer and explicit existing-file Linux setup; contract fixtures, native runtime unverified |
| [Cline CLI](https://docs.cline.bot/sdk/plugins) | Awaited root beforeRun; afterRun completed/aborted/failed | Root-only native runtime plugin; child directory binding and permission waits unsupported |
| [Amp](https://ampcode.com/docs/plugin-api) | Native `ctx.thread.state` observable: idle, running, awaiting-approval and error | Native state-observer plugin and bounded adapter; actual asset fixtures, authenticated runtime unverified |
| [Aider](https://aider.chat/docs/usage/notifications.html) | Native input-boundary notification; [v0.86.0 caller](https://github.com/Aider-AI/aider/blob/v0.86.0/aider/io.py) also invokes it before potentially automatic confirmations | Native callback health only; no session attribution or lifecycle states; creates no session rows |
| [Kimi CLI](https://moonshotai.github.io/kimi-cli/en/customization/hooks.html) | Prompt/tool activity; permission notification; root CLI SessionEnd | Native observable callbacks and TOML fragment; unscoped per-turn completion remains unavailable; hooks are beta |

Generic schema-1 ingestion remains available for explicit integrations, but a
generic wrapper is not evidence of native parity. Ten agents have some native
lifecycle coverage; Aider has health-only callback coverage. Cursor permission
waits and Kimi per-turn completion remain unavailable. This milestone does not
close issue #603 or install hooks into any profile automatically.
