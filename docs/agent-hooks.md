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
on the qualified Linux and macOS filesystems described below. Explicit version-2 discovery
also enables managed GitHub Copilot CLI setup; explicit version-3 discovery adds
managed Amp setup, and explicit version-4 discovery adds managed Kimi Code 2.4
setup, each preserving every older mapping. Gemini uses the selected
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

A hook group for the same event that differs from the managed one only in the companion path (the bare
`lazysh-agent ingest --agent claude` of a printed fragment, or `.../lazysh-agent` of an older install) is a
legacy duplicate: it would ingest every event a second time into the same store, and an older companion rejects
newer events. `status` lists each one in `legacyDuplicates` (`event` and `command`), and `install` removes exactly
those groups together with the managed update, also when setup was never installed. A group that adds a matcher or
another field, another executable name, or extra arguments is a foreign hook and is never touched, and `remove`
only removes the managed entries. Providers whose hook is a file or a TOML suffix report none.

The receipt is bound to the agent and the physical profile path. It is also checked against the
profile directory's device and inode when a plan is applied, but not when it is read: a profile that
was copied, restored or remounted (a btrfs subvolume gets a new device number after a reboot) keeps
working and is rebound by the next write. A receipt written for another folder or agent is never
used: `status` answers `supported: false` with reason `HooksForeignRecord`, `install` and `remove`
refuse, and nothing is changed. Delete the `.lazysh-hooks-*.json` file in the profile to start over.

Cline setup installs only the existing root lifecycle plugin, bound to the inspected
absolute companion. Select the `.cline` directory used by `--config`, `CLINE_DIR`,
or the workspace explicitly; discovery cannot determine a running session's layer.
Start a new Cline session with that profile to load the plugin, then start a turn.
Existing disabled-plugin settings and plugin restrictions are preserved, and setup
does not establish live reporting. See Cline's [plugin locations](https://docs.cline.bot/sdk/plugin-install)
and [plugin lifecycle](https://docs.cline.bot/sdk/plugins).

Managed writes support qualified local Linux and macOS filesystems without
extended ACLs: POSIX access or default ACLs on Linux, and any extended ACL entry
on macOS (`chmod +a`). Special file permission bits, unsafe links, read-only
files, unhandled ACLs, uncertain ownership and a filesystem that cannot report
its ACLs are refused before anything is written. Existing ordinary file
permissions and group ID are retained. On macOS the same ownership, preimage,
cooperative-lock and commit-boundary checks run through `openat`, `renameatx_np`
and `fstatat` instead of Linux's `renameat2` and `O_PATH`. They are exercised by
the managed-setup tests on a hosted macOS runner (extended ACL entries,
inherited ACL entries, links and replacement races), and the `native-desktop`
job runs them on every push to `main`. The run recorded for this support passed
41 cases with one ignored (it needs an explicit supplementary group) on macOS
26.7 for Apple silicon, on the runner's local APFS volume; no other macOS
version, no Intel Mac, no Apple hardware, and no HFS+, network or other volume
was exercised, and those are admitted only by the existing local-filesystem
check. A companion reached through a symbolic link is refused, and on macOS
`/tmp`, `/var` and `/etc` are symbolic links (the first hosted run failed on
exactly this with a temporary directory); install the companion under a
physical path such as your home directory or `/usr/local/bin`.
On a Windows host only the OpenCode, Cline and Amp plugins are managed (see
below); every other agent's writes remain unsupported and its preview returns the
existing unbound print-only templates, without an executable binding, and does
not quote a Windows executable as a POSIX command. Preview labels POSIX shell,
Bun JavaScript or Cline JavaScript dialect. These limits do not disable the existing
print-only configuration commands below.

### Windows hosts

On a Windows host `lazysh-agent hooks status`, `install` and `remove` manage only the
three providers whose hook is a JavaScript plugin that spawns the companion as an argument
vector: OpenCode, Cline and Amp. The plugin holds the absolute `lazysh-agent.exe` path as a
JSON string literal, so no shell dialect quotes it, and `hooks preview` reports
`binaryBinding: currentExecutable` for these three. Every other provider (Claude Code,
Codex, Droid, Gemini CLI, Cursor CLI, GitHub Copilot CLI) keeps the unbound print-only
template (`binaryBinding: unboundTemplate`, `managedSetupSupported: false`), `hooks status`
answers `HooksAclUnsupported` and `install` and `remove` refuse: a Windows path is never
quoted as a POSIX command, and no launcher of those providers has been shown to run a path
with spaces yet (tracked in #1959 and #1960). The additive `readiness` of `hooks status` reports its
local-event fact as `notChecked` on Windows: the event store has no owner or link-count
admission there, so it is not read.

The same admission and commit rules as on Linux hold, expressed in Windows terms, on a local
NTFS volume (another volume answers `HooksAclUnsupported`):

- The profile directory is retained by a handle that denies rename and deletion, so neither
  it nor an ancestor can be moved or replaced while a setup runs, and every path component
  is checked for a symbolic link, junction or other reparse point, an alternate data stream
  name (`name:stream`), a device name (`NUL`, `COM1`) and a trailing dot or space.
- The profile directory, the provider file and the companion executable are admitted by owner
  SID and DACL: the owner is the current user or an administrator, and no other account holds
  a right that changes the object. The record and the lock file are private: no other account
  has any access. A foreign owner, an Everyone-writable file, a hard link, a reparse point or
  an ACL that cannot be read refuses the setup before anything is written. A staged file is
  created with a private DACL, and a replaced provider file keeps the DACL it had.
- The plugin is published by an exclusive rename that never replaces an existing name, or by
  a replacing rename of the staged file when the previous plugin is the one lazysh owns. A
  provider created between inspection and commit is preserved and reported as uncertain.
- The companion must be a `.exe` regular file with one link, at most 64 MiB, in a directory
  that other accounts cannot change.

Qualified by `apps/agent/tests/hook_setup_windows.rs` on a hosted Windows runner (`windows-latest`,
x86_64, NTFS, elevated), with the real `lazysh-agent.exe` and the real Bun launcher on a path
with spaces, an apostrophe and non-ASCII characters. Not exercised: the real OpenCode, Cline
and Amp CLIs on Windows (Bun stands for the plugin host), a non-elevated user, ReFS, FAT, a
network drive, 32-bit and ARM64 Windows, and a Windows host reached from the app, which cannot
discover or offer Windows profiles yet (#1961). A directory handle has no durability barrier on
Windows, so the same no-atomic-compare-and-swap and no power-loss limits below apply.

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

### Setup readiness

Configured hook files do not show that an agent reports. `lazysh-agent hooks status`
therefore adds a `readiness` object (`schemaVersion` 1) to every supported status,
and the setup panel lists it as seven separate steps after **Inspect setup**. The
existing `reporting` and `trust` fields keep their `notChecked` value; no existing
field changes.

| Step | Where it comes from |
| --- | --- |
| Companion installed | The status itself: the companion answered. |
| Hook files configured | The existing `state`: `configured`, `conflict` or not configured. |
| Provider reloaded after the change | `providerReloaded`, always `notChecked`: no provider process is inspected and none is restarted. Start a new session. |
| Project trusted by the provider | `projectTrusted`, always `notChecked`: provider trust records (Codex hook review, Gemini folder trust and similar) are never read, written or bypassed, and Codex hook trust is never accepted automatically. |
| Lifecycle event received on this host | `localEvent`, below. |
| Current pane bound to the session | `paneBound`, always `notChecked`: the status does not know which pane you mean, and a script notification that carries a terminal location never binds a pane. |
| Remote delivery and approval | `remoteDelivery`, always `notChecked`: a local event does not prove a remote push or an accepted answer, and a provider that reports lifecycle (Amp) need not support approvals. |

`localEvent` is the only probe. It reads the companion's own session store without
opening it for writing: `{"state":"received","lastEventAt":"…"}` when a lifecycle
event of that agent is retained, `{"state":"none"}` when this host's store has none
(or no store exists yet, which `status` never creates), and `{"state":"notChecked"}`
when the store cannot be read safely (not a database, a link, owned by someone
else, locked or still being created). The match is by agent, not by profile: two
profiles of one agent share it. The time is the latest event, not a sign that the
agent is alive, and the store keeps seven days and 100 sessions, so `none` means no
retained event on the host's own state directory (`LAZYSH_STATE_DIR`, else the
user state directory); a hook run with a different state directory records
elsewhere. When the hook files are configured and `localEvent` is `none`, the panel
says the host has recorded no event from that agent and what to do next.

The store is opened through a read-only file system layer: every file is opened
without write or create rights, every delete is refused and the write-ahead index is
mapped read-only, so `status` never creates, changes or removes the store, its log or
its index, even when another process removes one while it reads (the read then fails
and the state is `notChecked`). A store whose log or index is missing reads as
`notChecked` rather than being repaired.

The report is additive in both directions. A client that predates it ignores
`readiness`; a client that has it shows every step as not checked when an older
companion sends none, and ignores a report with another `schemaVersion` or a
malformed `localEvent` instead of failing the status.

### A busy store does not lose the event

An `ingest` waits at most three seconds for the store's write lock, which is inside every provider's hook
deadline (Codex allows three, Claude Code five). Under sustained load (many agent sessions, a slow or full disk)
that wait can run out. The hook then still fails with `StorageError: operation failed (sqlite_code=5)`, but the
event is no longer lost: the companion keeps it as a small file in `pending-ingest` beside the store and the next
`ingest` records it first, oldest first, then its own event. A kept event older than ten minutes is dropped
instead of replayed, because the next report supersedes it. At most 256 events are kept; past that, and when the
disk will not take the file, the event is lost as before. Only plain events are kept; a reported-history source
and a Kimi approval still fail without a copy.

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

Claude Code sends no hook when the person rejects a permission dialog (No or Esc): no `PostToolUse`,
`PostToolUseFailure` or `Stop`, and its `PermissionDenied` hook covers only the auto mode classifier. A row
left at an approval, a question or a plan would wait until the next prompt. So `lazysh-agent snapshot` reads
the end of the session's conversation file (`projects/<project>/<session id>.jsonl` under `CLAUDE_CONFIG_DIR`,
else `~/.claude`) for each such Claude Code row and marks it done, summary "Turn interrupted" as for Codex's
`Interrupt`, when the last conversation record is Claude Code's interruption marker written after the wait
began. A message or tool call after the marker, or a rejection older than the wait, settles nothing. Only the
marker and its time are read; nothing from the file is stored or reported. When the companion cannot find the
file, for example because `CLAUDE_CONFIG_DIR` is set in the agent's terminal but not in the environment of the
snapshot (the Agent view's conversation list has the same limit), the row stays as the hooks left it until the
next prompt or `SessionEnd`. A row nobody reads stays as it is until the next snapshot.

A turn's end is not the end of its background work (a shell, a monitor, a sub-agent, a workflow): see
[Background work and session status](reference/agent-background-work.md) for what each agent proves.

Esc on a running Claude Code turn sends no hook either ([#1956](https://github.com/mihazs/lazysh/issues/1956)),
so the row would report `working` until the next prompt. The same snapshot read marks a `working` Claude Code
row done, summary "Turn interrupted", when the last main-thread record of its conversation file is the
interruption marker written after the row's last report. A newer prompt or tool call, a sub-agent's records
and a marker older than the last report settle nothing; a turn a background agent keeps running after the
marker is therefore also shown as done until its next report.

Codex reports main-thread prompt/tool activity as working, permission requests as
needing attention and Stop, Interrupt or SessionEnd as completed. SessionStart
does not imply an active turn. Codex subagent hooks use the parent's session ID;
SubagentStart and SubagentStop are deliberately ignored so child completion
cannot finish the parent's row. A Stop report is an observation; another hook can
continue the turn and subsequent activity updates its state again.

Answering a Codex permission request from the app is a separate, opt-in hook,
`lazysh-agent approval-config --agent codex`; see [Remote decisions](approvals.md#codex).
The `ingest` hook above only observes the request.

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

`lazysh-agent kimi-config` retains the legacy Kimi CLI **1.52.0** contract and
prints the same JSON containing a TOML fragment in `content` for its `[[hooks]]`
entries. It does not configure or qualify Kimi Code 2.4.1. Legacy prompt/tool
activity indicates work, including
failed tools while the agent continues. Only the documented permission_prompt
notification is treated as a permission wait. SessionStart and child lifecycle
notifications do not finish a parent or create a fictitious working turn.

Hook discovery reports separate metadata candidates for current Kimi Code 2.4.1
(`KIMI_CODE_HOME`, otherwise `~/.kimi-code`) and legacy Kimi CLI 1.52.0
(`KIMI_SHARE_DIR`, otherwise `~/.kimi`), in that order. Nonempty overrides are
used literally: discovery does not trim whitespace, expand `~`, or resolve
relative paths. Paths outside its absolute-path admission are labelled invalid;
an invalid override does not fall back to the default for that dialect. Empty
overrides use the default. The other dialect remains a separate candidate, not a
fallback or automatic selection. Identical unresolved HOME diagnostics appear
once. Discovery reads directory metadata only: it
does not execute Kimi, open/create configuration, migrate profiles, or identify
the installed version. Kimi remains manual-only in discovery schemas 1 to 3, so
shipped clients keep working; only explicit schema 4 offers the current Kimi Code
profile for [managed setup](#managed-kimi-code-setup). The legacy profile stays
metadata, and the seven managed providers and existing printer/ingestion behavior
are unchanged.

Kimi Code 2.4.1 hooks were observed natively, but lazysh does not ingest or
install them. The official Linux x64 release (SHA-256 `f4a225fb...d738de`) ran in a
network-less sandbox against a synthetic OpenAI-compatible endpoint with recording
hooks; the [harness and redacted receipts](reference/kimi-code-qualification/README.md)
repeat it. Observed:

- A strict `[[hooks]]` entry loads and records `SessionStart`. An unknown field, an
  unknown event or a `timeout` above 600 makes Kimi ignore the **whole** `hooks`
  section with a warning, foreign hooks included, while the CLI keeps running.
- `kimi -p` runs in Auto permission mode: tool events, no approval events and no
  `SessionEnd`. Interactive manual mode adds `PermissionRequest` and
  `PermissionResult` (`decision` approved or rejected, same `id`, `turn_id` and
  `tool_call_id`) and a `SessionEnd` with reason `exit`. A rejected tool gives
  `PostToolUseFailure` and the turn still ends with `Stop`.
- `PermissionRequest` and `PermissionResult` carry `agent_id`: `main` for the root,
  `agent-0` for a sub-agent. `TurnStarted`, the tool events, `Stop`, `StopFailure` and
  `Interrupt` carried none. A sub-agent's turn start has `origin_kind=system_trigger`,
  `origin_name=subagent` and reuses `turn_id` 0; its `Stop` is identical to the
  root's and arrives before `SubagentStop`.
- With a background sub-agent (slowed by the mock) the root's `Stop` came before the
  child's tool use and approval, so a `Stop` cannot mean that everything finished.
- A foreign `Stop` hook that blocks once continues the turn with a second model call
  and no further `Stop`: `Stop` is not completion, and a blocked turn has no
  completion event at all. `Interrupt` and `StopFailure` replace `Stop`;
  `StopFailure` carries the raw provider error text.
- Observers are fire-and-forget and unordered: with only the `PermissionRequest`
  observer delayed two seconds, `PermissionResult`, `PostToolUse` and `Stop` were
  recorded before the request.

So a root `Working`/`Done` from identity-less events, `Stop` as completion and a
request as confirmed waiting stay unsupported until a contract decides them;
`PermissionRequest` only observes that approval was requested. Not covered: lazysh
ingestion of these payloads (so how it must treat a late request is still open), a
real provider, macOS and Windows, and later releases (2.6.2 delivered no `Stop` in the same harness, cause not
diagnosed). Metadata presence alone still does not establish hook loading. See
[#696](https://github.com/mihazs/lazysh/issues/696).
The path contracts are pinned to [Kimi Code 2.4.1](https://github.com/MoonshotAI/kimi-code/blob/2c73f3f50af4fa7f2540ca0d2e33b07a1408e3a7/apps/kimi-code/src/utils/paths.ts#L35)
and [Kimi CLI 1.52.0](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/share.py#L7);
the current event limits follow the [2.4.1 emitters](https://github.com/MoonshotAI/kimi-code/blob/2c73f3f50af4fa7f2540ca0d2e33b07a1408e3a7/packages/agent-core-v2/src/features/externalHooks/agent/agentExternalHooksService.ts#L178).

Kimi 1.52.0 shares the parent's session and hook engine with child souls. Both
root and child turns emit identical unscoped Stop/StopFailure payloads, so those
events are deliberately omitted and ignored. This avoids finishing or faulting
a parent when only a child stopped. Per-turn completion is unavailable through
this hook contract; the last observed working state can remain during idle time.
SessionEnd reports the root CLI-instance/session-owner boundary, including a
reload, rather than completion of each turn. This capability gap remains open.

`lazysh-agent kimi-config --dialect kimi-code-2.4` prints a separate, opt-in
fragment for Kimi Code **2.4.1** (`legacy-1.52` is the default and its output is
unchanged). It subscribes to `PermissionRequest`, `PermissionResult` and
`SessionEnd`, each running `lazysh-agent ingest --agent kimi-code` with a
five-second deadline, and it reports one fact: **the root agent requested
approval**. The row appears as "Kimi Code", needs attention, waiting for an
approval, with the summary "Approval requested": a request, not proof that Kimi
still waits. Nothing is installed; paste the fragment into the profile's
`config.toml` yourself. Kimi ignores the whole `hooks` section when any entry has
a field other than `event`, `matcher`, `command` and `timeout` (1 to 600), or an
unknown event, so edit it with care.

- Only an event with `agent_id` equal to `main` and a complete session, request,
  turn and tool-call identity counts. A sub-agent, a missing or empty agent and every
  event that names no agent are ignored, and a root event missing part of its
  identity is refused. Turn, tool, `Stop`, `StopFailure` and `Interrupt` events name no
  agent, so they never report working or done: `Stop` is blockable and runs before
  completion, and a sub-agent's `Stop` is identical to the root's.
- Kimi's observers are fire-and-forget and unordered. Each request is remembered
  by id, so a result that arrives first leaves a one-hour tombstone and the late
  request does not reopen attention; two open requests keep the row until both are
  answered. Once none is open the row is removed, because nothing true is known about
  what the agent does next. `SessionEnd` retires the open requests of its session.
- Checked against the real CLI: the official 2.4.1 Linux x64 release (SHA-256
  `f4a225fb...d738de`), in a network-less sandbox against a synthetic endpoint,
  loaded this fragment and drove `lazysh-agent`. An approved and a rejected request each showed
  one row and removed it; Esc and Ctrl+C at the prompt both answer the request as
  rejected, so they remove it too; a result delayed past its request left no row; a
  sub-agent's approval was delivered and reported nothing; `SessionEnd` left no row.
- No decision: a hook cannot answer the prompt (the observers are not read and `PreToolUse` can only
  block), so a Kimi prompt stays in the terminal; see [Remote decisions](approvals.md#kimi-code).
- Not covered: Kimi's source (not observed in a run) sends no `PermissionResult`
  when the turn is aborted while an approval waits ([`isUserCancellation`](https://github.com/MoonshotAI/kimi-code/blob/2c73f3f50af4fa7f2540ca0d2e33b07a1408e3a7/packages/agent-core-v2/src/agent/toolApproval/toolApprovalService.ts#L170)),
  and `Interrupt` cannot say whose turn it ended, so such a report would stay until
  `SessionEnd` or the seven-day retention. A request delivered after `SessionEnd`
  is reported again. A `Stop` cannot retire a request, because a sub-agent's `Stop`
  is identical to the root's. Release 2.6.2, a real provider, macOS and Windows are not covered.

### Managed Kimi Code setup

Use `lazysh-agent hooks discover --schema-version 4` to discover the current Kimi Code
profile (`KIMI_CODE_HOME`, otherwise `~/.kimi-code`) and its managed capability. The app
asks for version 4 first and falls back one version at a time only when an older companion
rejects the schema; a malformed or failed answer never negotiates again, and a fallback
version labels Kimi manual. Select the existing profile, then inspect and separately
install, update or remove its exact plan with `--agent kimi-code`;
`lazysh-agent hooks preview --agent kimi-code` prints the block without touching a profile.
Legacy Kimi CLI 1.52.0 (`~/.kimi`) and a custom config path stay manual.

The companion edits one foreign, secret-bearing file, so it only appends:

- `config.toml` must already exist. A missing file is refused (`HooksKimiConfigRequired`)
  and never created. Ownership is recorded in the private manifest
  `.lazysh-hooks-kimi-code.json`, not in a field of the file: Kimi ignores the whole `hooks`
  section when an entry has a fifth field.
- The owned block is three `[[hooks]]` entries at the end of the file, the events of the
  printed fragment (`PermissionRequest`, `PermissionResult`, `SessionEnd`) with `event`,
  `command` and `timeout = 5` only. It is deterministic for the inspected companion, so it
  can be found again at the end of the file.
- Every earlier byte is kept as is: comments, secrets, CRLF line endings, a missing
  final newline, foreign hooks and the file's mode. The text is parsed with `toml_edit`
  before and after, so a result that is not valid TOML, or in which the owned entries are
  not exactly the last hooks, is never written. A UTF-8 BOM is refused without rewriting:
  Kimi Code 2.4.1 rejects it even when the remaining TOML is valid. Update and remove also
  refuse a BOM-bearing managed file; resolve it manually before retrying.
- Update and remove act only when the file ends with exactly the recorded block. A foreign
  line after it, an edit inside it or the block moved elsewhere is a conflict and the file
  is not rewritten; an edit before the block does not prevent removal, which only cuts the
  block. Install is also refused when the file already has `hooks = [...]` inline, a
  `[hooks]` table, invalid TOML or a foreign hook with the same event and command.
- A crash is classified by the same private manifest: configured only for the exact
  end-of-file block, never resumed or rolled back automatically.

Restart Kimi Code afterwards; configuring the hooks does not prove they were loaded or
that they report. Tests drive the real `lazysh-agent hooks` command against a temporary
profile (byte-exact install and removal, tampering, interrupted writes, the quoted
absolute command running the companion) and the client against schema fallback. The
official Kimi Code 2.4.1 `kimi doctor`, run in a network-less sandbox, accepted a profile
with a foreign hook followed by the owned block, and reports a hook with `timeout = 601` as an
error; that one-off run is not part of CI. macOS filesystem qualification
([#1527](https://github.com/mihazs/lazysh/issues/1527)), Windows, Release 2.6.2 and a real
authenticated session are not covered.

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

### Explicit managed setup

Use `lazysh-agent hooks discover --schema-version 2` to discover the selected
Copilot profile and its managed capability. The app requests this version when
hook setup is explicitly opened. Default discovery and `--schema-version 1`
retain the original seven managed providers and label Copilot manual, preserving
released clients. An older companion must be updated before Copilot setup;
the original seven providers still permit manual profile inspection when
detection is unavailable.

Select an existing absolute profile, then inspect and separately install/update
or remove its exact plan using `--agent copilot`. The companion owns only
`hooks/lazysh.json` and `.lazysh-hooks-copilot.json` in that profile. It binds the
six shell-free handlers to its inspected absolute executable. A foreign or
manually installed `hooks/lazysh.json` is a conflict, even if its content matches
the printed template; it is never adopted or overwritten. Other hook files,
opaque JSONC/configuration, providers, settings, trust and disabled-hook policy
remain unchanged. Removal leaves unrelated files and the hooks directory.
Remove owned hooks with the current companion before downgrading to an older
companion that does not understand the Copilot ownership record.

Copilot 1.0.105's shipped resolver preserves nonempty `COPILOT_HOME` literally,
including trailing whitespace; only empty/unset values fall back to `~/.copilot`.
Unsafe or relative overrides are reported invalid, never replaced with a guessed
default. The deprecated `--config-dir` can select a different profile that SSH
environment metadata cannot identify. Start a new Copilot session with the
selected profile and review `/hooks` under normal policy; installation alone
does not verify that hooks are enabled, loaded or reporting.

### Manual hooks and lifecycle qualification

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
returned. Answering a Copilot permission request from the app is a separate,
opt-in hook, `lazysh-agent approval-config --agent copilot`; see
[Remote decisions](approvals.md#copilot-cli). This targets Copilot CLI; notification and shell-free execution
support differ in the cloud agent. Contracts follow the current
[official hook reference](https://docs.github.com/en/copilot/reference/hooks-reference).

On Linux, CLI **1.0.105** loaded the manually placed printed hooks with a local
companion built from [`91d6f8ba`](https://github.com/mihazs/lazysh/commit/91d6f8ba7f800170939a1946dae18322c5569ac9).
Isolated mock-provider turns verified root `working` → `done` with `Turn finished`
and native response readback, and root `working` → `needs_attention` while an
elicitation question and both choices remained visible and unanswered. The latter
is an attention notice, not a valid actionable approval. Each case used one
provider request and ordinary session-only folder consent; no question answer or
tool approval was sent. [Issue #704](https://github.com/mihazs/lazysh/issues/704)
retains binary/source bindings, receipt hashes and earlier failed attempts.

A separate Linux 1.0.105 no-tools child probe used a passive producer observer
and a local companion from [`2435d50c`](https://github.com/mihazs/lazysh/commit/2435d50ca61709940a583874b4ee0089d2ebd7d7)
to verify child `done` before the parent's final response, while the parent stayed
`working`. Tagged completion requires `session_id == agent_id` and a valid,
distinct `parent_agent_id`; shared-parent callbacks remain ignored. Native child
`Stop` was exercised; child `SessionEnd` has CLI contract coverage. See
[#713](https://github.com/mihazs/lazysh/issues/713) for the preserved stale-child
baseline and candidate replay.

Those earlier checks used manually loaded files. Separately, a local **1.5.4**
companion built from [`3ea4ef20`](https://github.com/mihazs/lazysh/commit/3ea4ef20369905601bc7636f7c0000d249b42a84)
installed the six absolute-executable hooks using an inspected managed plan.
Fresh Linux CLI **1.0.105** sessions then verified the same root completion,
unanswered attention and no-tools child behavior with isolated mock providers.
The child case retained its separately labeled passive producer observer. Hook,
ownership-receipt and provider files remained unchanged; process, socket and
terminal cleanup passed. [Issue #717](https://github.com/mihazs/lazysh/issues/717)
retains the source/binary bindings and separate case receipts. Other child
configurations, real-provider/account behavior, public companion artifacts and
Android delivery remain unqualified.

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

Managed Amp setup requires explicit `hooks discover --schema-version 3`. The
app requests V3 when setup is opened; only a native remote-command rejection
allows one V2 metadata request for older Copilot-capable companions. Malformed
responses, unsupported capability, access changes and source loss do not trigger
fallback. Default V1 and explicit V2 continue to label Amp manual.

Select the existing system profile `<configuration-base>/amp`; a nonempty
`XDG_CONFIG_HOME` is used literally without trimming and must be a safe absolute
path. Empty/unset values use `~/.config`; unsafe explicit values never fall back.
The inspected installer owns only `plugins/lazysh.js` and
`.lazysh-hooks-amp.json`, binding the observer's one spawn executable to the
absolute companion. It preserves settings, other plugins, trust and policy.
Foreign `lazysh.ts` or `lazysh` entries (including links) block installation and
updates. Exact-owned JS removal remains available through a freshly inspected
remove plan; it preserves those foreign entries. Shadow metadata changes retire
old plans and are checked again at the existing write boundaries. The cooperative
lock does not make absence atomic against other same-user writers after the last
check, and a workspace plugin can still mask the system plugin. Configured status
therefore retains `reporting:notChecked` and `trust:notChecked`. Start a new Amp
session with that configuration and review its normal plugin policy; loading,
native ordering and root/child attribution require separate qualification. Use
the newer companion to remove owned Amp hooks before downgrading to a companion
that cannot read its Amp ownership record.

`lazysh-agent amp-plugin` prints the original plugin in `content`, with its
suggested filename. Place reviewed content in your selected Amp plugin directory.
It subscribes to native `ctx.thread.state` for encountered threads: `running`
reports work, `awaiting-approval` reports attention, `idle` after observed running reports completion,
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

## Native runtime qualification status

Fixture and contract coverage is not native acceptance. This table lists only
what an unchanged official CLI was observed to do, with a private HOME and a
loopback-only endpoint, and what no run has established yet. Every claim is bound
to the CLI version named; the run receipts are issue comments on
[#603](https://github.com/mihazs/lazysh/issues/603),
[#704](https://github.com/mihazs/lazysh/issues/704),
[#624](https://github.com/mihazs/lazysh/issues/624) and
[#1527](https://github.com/mihazs/lazysh/issues/1527). Where a vendor login is
required, the case is documented as blocked and is not simulated. The
Claude Code and Codex interactive runs used a private tmux server, a private HOME
and state directory and a loopback endpoint that answered with scripted tool
calls; no network namespace was used, so traffic to other hosts was neither
blocked nor measured (the endpoint saw no request it did not expect). The
companion was a release build of this repository's `lazysh-agent` 1.62.0.
Remaining work is tracked in [#1527](https://github.com/mihazs/lazysh/issues/1527).

| Agent | Observed natively | Not established | Blocked on |
| --- | --- | --- | --- |
| Claude Code | 2.1.316: one print turn against a local Anthropic-format mock, `working` then `done`. 2.1.322, private HOME, loopback mock, managed profile, `--permission-mode default`: a print turn with a `Read` and a background `Agent` child kept one session row and shared it with the child's own `Read` hooks, which arrived before the parent's `Stop` in one of two runs and after it in the other (the row went `done`, then `working` again); the child's completion then resumed the parent turn, `working` then `done`. In the normal TUI (folder trusted through the ordinary dialog) a `Write` that needs permission gave `needs_attention` with an approval wait, and after approval `working` then `done`. Rejecting the dialog (No or Esc) sent no hook, so the row stayed `needs_attention` until `SessionEnd` ([#1795](https://github.com/mihazs/lazysh/issues/1795)); the snapshot now settles it from the conversation file (same version, with the hook entries of `claude-config` and the built companion on `PATH` instead of `hooks install`, and `lazysh-agent snapshot` run with the profile's `HOME`: `done`, "Turn interrupted", for No and for Esc, while a later dialog of the same session kept waiting, and approving gave `working` then `done`) | Which events carry a child identity (the run read the store, not the hook payloads), plan and auto permission modes, an elicitation question | Nothing account-bound |
| Codex | 0.166.0, normal TUI with ordinary hook review: nothing delivered before review, `working` then `done` after it, nothing when disabled or after a changed definition, one parent with one child that kept the parent `working` until its own `Stop`. 0.167.0 (`--no-daemon -a on-request -s read-only`, hooks trusted through the review screen): a command that needs approval gave `working`, then `needs_attention` with an approval wait, then `working` and `done` after approval and the command ran; Esc on the dialog delivered `Interrupt` and the row became `done` ("Turn interrupted") | Child events on 0.167.0, other approval kinds (patches, network, permission profiles) | Nothing account-bound |
| OpenCode | 1.19.5 and 2.2 loaders, root and child session deletion, and an attributed attention report | A full provider turn and an authenticated session | A provider account for the authenticated session |
| Gemini CLI | 0.66.0, headless with a loopback endpoint: `working` then `done`; nothing when hooks are disabled or the folder is untrusted | Interactive readiness (the owned terminal stalled at theme selection), root and child attribution, authenticated Google behaviour | A Google account for the authenticated part |
| Cursor CLI | Nothing: fixture and documented-contract coverage only | Authenticated execution and neutral-output acceptance | A Cursor account |
| Droid | 1.1.0, accountless `exec` with a custom loopback model: `Stop` then `SessionEnd`, one `done` row | Prompt-start and `working` delivery; the interactive UI stops at the Factory login | A Factory account |
| Amp | Nothing: the plugin runs against the generated API types and documented shapes only | Native plugin loading, ordering, and root and child attribution | An Amp account |
| GitHub Copilot CLI | 1.0.105 on Linux, manual and managed hooks: root `working` then `done`, an unanswered elicitation as `needs_attention`, a no-tools child | Other child configurations; a real provider | A GitHub Copilot account for a real provider |
| Cline CLI | 3.0.74 on Linux: two root turns, a managed binding, a disabled plugin | Child directory binding; a real provider | A Cline provider account |
| Aider | 0.86.0: the notification callback was counted once, with no session row | Anything beyond callback health, by design | Not applicable |
| Kimi CLI | Fixtures against the 1.52.0 contract | Native lifecycle of 1.52.0 and of Kimi Code 2.4.1 ([#696](https://github.com/mihazs/lazysh/issues/696)) | Tracked in #696 |

Managed setup has its own platform qualification, described at the top of this
guide. A row above says nothing about it.

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
| [GitHub Copilot CLI](https://docs.github.com/en/copilot/reference/hooks-reference) | Prompt/post-tool aliases; attention notifications; Stop/SessionEnd | Explicit V2 managed setup and manual shell-free hooks; scoped Linux 1.0.105 root/attention/no-tools child qualification |
| [Cursor CLI](https://cursor.com/docs/hooks) | beforeSubmitPrompt/tool events; permission-capable hooks; stop/sessionEnd | Native activity/completion adapter, print-only fragment and explicit Linux managed setup; actual permission-wait detection unavailable |
| [Droid](https://docs.factory.com/harness/hooks) | UserPromptSubmit/tool events; Notification permission_prompt; Stop/SessionEnd | Native adapter, standalone printer and explicit existing-file Linux setup; contract fixtures, native runtime unverified |
| [Cline CLI](https://docs.cline.bot/sdk/plugins) | Awaited root beforeRun; afterRun completed/aborted/failed | Root-only native runtime plugin; child directory binding and permission waits unsupported |
| [Amp](https://ampcode.com/docs/plugin-api) | Native `ctx.thread.state` observable: idle, running, awaiting-approval and error | Explicit V3 managed system plugin and bounded observer; actual asset fixtures, native loading/order and authenticated runtime unverified |
| [Aider](https://aider.chat/docs/usage/notifications.html) | Native input-boundary notification; [v0.86.0 caller](https://github.com/Aider-AI/aider/blob/v0.86.0/aider/io.py) also invokes it before potentially automatic confirmations | Native callback health only; no session attribution or lifecycle states; creates no session rows |
| [Kimi Code](https://moonshotai.github.io/kimi-code/) | `PermissionRequest`/`PermissionResult` for the root agent; `SessionEnd` | Opt-in 2.4 fragment and explicit V4 managed end-of-file block; root approval requests only, synthetic endpoint and `kimi doctor` qualification of 2.4.1 |
| [Kimi CLI](https://moonshotai.github.io/kimi-cli/en/customization/hooks.html) | Prompt/tool activity; permission notification; root CLI SessionEnd | Native observable callbacks and TOML fragment; unscoped per-turn completion remains unavailable; hooks are beta |

Generic schema-1 ingestion remains available for explicit integrations, but a
generic wrapper is not evidence of native parity. Ten agents have some native
lifecycle coverage; Aider has health-only callback coverage. Cursor permission
waits and Kimi per-turn completion remain unavailable. This milestone does not
close issue #603 or install hooks into any profile automatically.
