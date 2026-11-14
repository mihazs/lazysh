# Durable workspaces

In Preferences → Terminal touch gestures, body and two-finger gestures can be
assigned **Next Zellij tab**, **Previous Zellij tab**, **Next Zellij pane** or
**Previous Zellij pane**. No defaults change. The terminal must be connected and
known to be attached to Zellij through lazysh. Plain shells, local terminals,
tmux and Herdr are rejected rather than receiving terminal key sequences.
Selection, IME composition and inactive terminal views take priority; a second
navigation gesture is ignored while the first command is pending.

These actions use Zellij's named-session focused view, matching its existing
shortcut panel; they do not identify a separate client in a shared session.
They reuse `go-to-next-tab` / `go-to-previous-tab` and the documented
`focus-next-pane` / `focus-previous-pane` commands from the
[official CLI interface](https://zellij.dev/documentation/cli-actions).
An isolated native Cargo fixture with an attached PTY client checks actual tab
and pane focus (verified with installed Zellij 0.45.1). Its temporary config
disables Zellij's first-run tips and release-note overlays so focus is observable;
this does not establish gesture behavior while those popups are open. Frontend
tests check gesture routing, rejection and settings
round-trips. Physical touch and mobile lifecycle acceptance remain open.

This is the Zellij-only part of the reference client's documented
hierarchy-aware gestures (source URL omitted). The level-aware defaults and the
**Next / previous multiplexer tab or window**, **Next / previous multiplexer
pane** and **Zoom multiplexer pane** actions (the pane-zoom pinch) cover tmux and
Herdr as well; see
[Multiplexer gestures](shortcuts.md#multiplexer-gestures-header-pulls-and-long-press-keys).
No gesture switches Herdr workspaces: use the [tab strip](#tab-strip) or the
Workspaces screen. Current Zellij exposes `switch-session`, but lazysh does not
yet use it or reconcile remembered attachment names after a host-side session
switch.

Open **Sessions** on an SSH connection. lazysh discovers tmux, Herdr and Zellij independently. Attaching opens a separate PTY on the verified SSH transport, preserving the original shell. Closing an attached terminal detaches that client; the remote multiplexer owns its processes.

## tmux

Select **tmux server** on an ordinary SSH connection and choose **Browse server**. `default` selects tmux's standard server; other names select the public `tmux -L NAME` socket-name interface. The selector is fixed on an attached terminal: its tree/actions and Jump To remain on the native attachment's server. Open another attachment from a plain SSH connection to choose another server. Names are literal 1–64 UTF-8-byte basenames: Unicode, spaces, apostrophes and shell-looking text are accepted; `/`, control characters, `.` and `..` are rejected. Socket paths (`-S`) are not accepted. Filesystem/socket-length failures remain explicit host diagnostics.

All tmux client invocations also select UTF-8 (`-u`), preserving literal metadata and tab-delimited discovery even when the remote login environment has no UTF-8 locale.

**Changed default:** every command explicitly uses `-L default` or its selected named server. Previously, bare tmux commands could inherit a different socket from the remote `TMUX` environment variable. Legacy workspaces without server metadata now consistently select the standard default server. Saved attachment intentions preserve the server plus exact human session name; Jump To changes the destination without dropping server identity. Native session context rejects conflicting action/tree requests, and the retained control channel never reconnects to a restarted server with reused IDs.

This follows documented [tmux named-server semantics](https://man.openbsd.org/tmux.1) and [upstream 3.4 socket-label construction](https://github.com/tmux/tmux/blob/3.4/tmux.c#L175-L219). The reference client help exposed `tmux:<server>`, but the exact private gateway meaning was not recovered. This is independent implementation from the public interface. Agent pane IDs alone do not establish server identity: transcript/approval identity remains explicit, and no pane-only routing is added. Notifications open their recorded existing native connection ID, never a first session-name match. Companion snapshots are host-wide: that connection is not proof of a matching agent pane/server, and this slice does not infer one. Desktop theme deep links do not attach multiplexers. Cold or warm saved-host CLI composition opens the exact requested tmux/Herdr picker through normal SSH authentication; see [launch usage](connections.md#multiplexer-picker-launches). Actual OS GUI acceptance remains tracked in issue #86.

The workspace tree lists real session, window and pane IDs, current commands, directories and active state. Create/rename sessions and windows, choose a project directory, select windows/panes, split panes and toggle zoom. Refresh reads current host state. Actions use exact IDs instead of injecting prefix sequences into a foreground agent.

Choose a list, accordion or grid layout; the client remembers it. Load recent projects from the host companion's real agent history, ordered by most recent event, then select a directory in the launcher. The companion remains optional: you can always enter a directory manually.

Shell quoting alone does not protect tmux arguments: tmux parses trailing semicolons and expands format strings. lazysh separately escapes those layers to preserve literal names and directories. Control characters in names/paths are rejected because the discovery protocol is tab/line delimited. A response exceeding 1 MiB or 4096 panes fails explicitly.

### In-session Jump To

A tmux terminal attached through lazysh offers **Jump To** with its session/window
tree and an exact **Current** marker. Choosing Current closes the panel without
sending a command. List, accordion and grid share the existing saved layout
preference. A successful switch remembers the destination's human session name;
numeric IDs and navigation generations are never saved for reconnect.

Display labels are separate from exact restoration names. Only a native-validated,
control-free name of at most 200 UTF-8 bytes is saved. Unsupported destinations
remain live and navigable with an explicit notice, and their entire restoration
intent is omitted; a sanitized label or the previous target is never substituted.
Host-side session switches/renames are not automatically reflected in saved
intent; a successful lazysh jump or a new attachment refreshes it.

lazysh captures PID/TTY metadata on its own SSH attach channel immediately before
`exec tmux`, retaining other startup banners and terminal bytes. A separate,
verified SSH control channel confirms that exact attached normal client. Every
jump uses its captured generation and exact session/window IDs with a synchronous
server-side client guard. It never reopens a control connection to follow a
restarted server with reused IDs. Plain shells, externally attached/unbound
terminals and Zellij do not gain this tmux tree. An absent or malformed handshake
leaves the terminal usable and navigation unavailable rather than guessing.

The extra `no-output,ignore-size` control client affects attached/client counts
and may trigger configured tmux hooks. Switching a window changes the destination
session's **shared** current window, which other clients in that session may see.
Closing the local display revokes navigation immediately, independently of the
remote close acknowledgement. Cancelling attachment setup requests close of its
unpublished display channel during handshake or control preparation, while
preserving the verified parent SSH transport. Idle control clients can survive a resume lock;
queued requests retain their original access lease and are discarded after
revocation. Interruption during command I/O, unexpected framing, timeout, or
server loss permanently retires that binding. Reattach to obtain a fresh binding.

The queue holds at most four requests. Bootstrap/control operations have absolute
three-second deadlines; each response/notification allowance is at most 1 MiB,
each line 64 KiB, and each command at most 4096 rows. Labels are delimiter-quoted,
with control characters displayed as `?`; labels never become commands. Older
tmux behavior is accepted only when binding and protocol validation succeed.
Preparation positively checks the exact registered client through both client and
session loops before publishing navigation or guarded Chat input. Every action
requires the entire loop result to equal `1`; unknown modifier text is rejected.
tmux 3.2a lacks client loops and keeps ordinary terminal access without these
advanced bindings. The client-loop capability was introduced in tmux 3.4; version
strings alone never grant a binding.

The Sessions panel shows each detected multiplexer's version with a **Supported**
or **Limited** badge. Discovery reads `tmux -V`, `zellij --version` and
`herdr --version`, none of which starts a server, and one table maps the version
to what lazysh supports: tmux 3.4 or newer, Zellij 0.45.1 and Herdr 0.9.3 to
0.9.5 are supported, and any other version is limited with a notice naming what
it lacks. After a host reports tmux older than 3.4, Jump To is no longer offered
for its tmux terminals. The badge is guidance; the client-loop check above still
decides every binding. A host whose login shell is not POSIX `sh` (PowerShell or
cmd on Windows OpenSSH) is reported as `unsupported_host_shell`.

All application SSH session/direct-TCP channel openings retain ownership while awaiting SSH open
confirmation, even if the caller locks or times out. Late confirmations are
closed before PTY or command dispatch. At most four pending opens per verified
transport hold capacity until confirmation, failure or the last local transport
owner disappears. A live peer that never confirms can occupy all four slots;
further channel opens fail explicitly until the peer responds or the transport
is disconnected. Existing SSH sessions are not torn down on a caller deadline.
Pending workers retain only the inner client, and last-owner shutdown stops
them; they cannot keep the outer transport owner alive themselves. The shared
four-slot pool now includes exec, SFTP setup, preview relay/probes, bastion routes,
Mosh/ET bootstrap and device streams, as well as terminal/control openings.
Existing per-operation deadlines and security validation remain in place. Once a
confirmed SFTP/forwarding channel becomes a stream, russh's existing
`ChannelCloseOnDrop` owns it; no separate post-open SFTP leak is asserted.
Native peer regressions hold each caller's confirmation, revoke its original
lease, reauthorize, then verify late close and a usable parent SSH transport.
Physical-device execution of these cancellation races remains unverified.

Local native acceptance uses upstream tmux 3.4 and tmux 3.8; the Linux CI task also
exercises its actual distro tmux. The retained parser accepts the official typed
session/window-change notification; unknown events still retire navigation.
tmux 3.5a guard compatibility remains source-checked only, and runtime CI results
must be recorded separately. Complete kernel PID+TTY reuse and a malicious
same-UID server are outside this identity proof. Physical device lifecycle and
Herdr navigation remain separate acceptance work under issue #7.

## Herdr

List running named servers, then attach or browse one. The Herdr tree preserves server/workspace/tab/pane identity and displays reported agent states. Create and rename workspaces/tabs, focus workspaces/tabs, split and zoom exact panes, and focus reported agents. Plain panes can be selected through the terminal; Herdr's `agent focus` command only accepts agent panes.

The integration uses the [public Herdr CLI/socket snapshot contract](https://herdr.dev/docs/socket-api/) and validates its response shape and exact IDs. Incompatible response shapes fail explicitly. lazysh does not install Herdr, alter its configuration, or stop existing servers.

Supported Herdr versions are **0.9.3 through 0.9.5**. CI builds stock and guarded Herdr 0.9.5 from the pinned source and runs the native and Android Herdr suites against them. lazysh uses only commands, exact IDs, snapshot fields and error codes that 0.9.3 and 0.9.5 share, so hosts still on 0.9.3 keep working. What changed in Herdr 0.9.4 and 0.9.5:

- If a workspace, tab or pane was closed on the host after the tree loaded, Herdr answers `workspace_not_found`, `tab_not_found`, `pane_not_found` or `agent_not_found`. lazysh shows "The selected connection or destination changed" instead of Herdr's raw JSON. Exact pane navigation goes through the companion, which reports `pane_not_found` as `HerdrFocusMissing`; an older companion still shows its generic failure. Since 0.9.4, an out-of-range workspace number also returns `workspace_not_found` instead of crashing the server.
- Since 0.9.4, closing the shell that started Herdr no longer stops the server on Linux and macOS. Stop a server with `herdr server stop` or SIGTERM, not SIGHUP. lazysh never stops servers, and its test fixtures use `server stop`, SIGTERM or SIGKILL.
- Herdr 0.9.4 asks before closing a workspace's only pane from its own keys or menu (`ui.confirm_close`). lazysh has no close action, and CLI/API closes stay immediate.
- Herdr 0.9.5 reads Codex status from the screen again instead of turn hooks. lazysh shows whatever state Herdr reports.

Agents initially reads the attached Herdr session when discovery lists that exact
name, including when several servers are running. Choosing another server overrides
that initial selection. If the attached session is absent, choose a server explicitly;
lazysh does not substitute another one. Plain terminals automatically select a sole
running server and require a choice when several are available. Discovery reads one
server per refresh and does not grant terminal input or approval authority.

### Create workspaces, worktrees and agents

Agent view lists live agents from the attached Herdr server, including stock
0.9.3. Select a running Claude Code or Codex session to open the conversation matching its reported session ID, or enter its exact
Herdr pane. Herdr reports can be stale and do not prove that conversation belongs
to the pane. Selecting a session does not grant terminal input authority. Conversation reading requires
the matching updated lazysh companion on the host.

Finger swipes inside Herdr request retained pane history without sending wheel
events or arrow keys to its program. This needs the optional guarded host's
`lazysh.guard.observe` and `lazysh.guard.scroll_history` methods. Each request
checks the original attached client, pane runtime and visible viewport. The
first implementation supports its focused pane; other panes of a guarded host
report unavailable rather than changing an agent's selected option. A host
that cannot serve guarded history at all, such as stock Herdr or an older
guarded server that is still running, takes swipes as wheel input like before
1.29.1 after the first swipe of a session: scrolling works with no error, but a
swipe over an open agent question can still move its selected option. Mouse wheels
keep their ordinary terminal behavior. Updating a host binary does not upgrade
an already-running server; lazysh does not restart it automatically.

The Agent view composer works on stock Herdr too. Where the guard is not
available, Send runs `herdr --session NAME agent prompt PANE TEXT` over the
host connection (Stop runs `agent send-keys PANE esc`). Herdr itself wraps the
text in bracketed paste, presses Enter and refuses an agent that is waiting for
an answer. lazysh first re-reads `herdr api snapshot` and sends only when exactly
one live agent row carries the conversation's session id in the exact pane and
terminal the conversation was opened from; no focus is involved and no companion
is needed. The message is confirmed by the conversation showing it, and a failure
after the command started is never resent. A guarded host keeps using the guarded
input.

Herdr **Spaces** offers **New workspace** above the workspace tree, and a
**New worktree from …** button on each workspace that reports a pane directory.

- **New workspace** asks for a label and an absolute directory. Type it, pick
  one of the known directories (current Herdr pane directories and companion
  project reports), or browse host folders over SFTP.
- **New worktree** reads the Git repository that contains the workspace's first
  reported pane directory. It suggests a branch derived from the workspace label,
  the repository's current HEAD as the base, and a path. If every existing linked
  worktree shares one parent directory, the path uses that parent; otherwise it is
  the sibling `<repo>-worktrees/<branch>` with `/` replaced by `-`. All three are
  editable. The new workspace is labelled with the branch name.

Both dialogs ask **Start an agent in it?** and default to not starting one.
Choosing yes requires selecting an agent from the supported Herdr agent kinds
whose executable `command -v` finds on the host; nothing is offered when none is
found. Codex and Claude Code accept an optional single-line initial prompt as
their positional argument; other agents start without one.

**Review commands** shows every command that will run, exactly as quoted. Nothing
runs until you confirm. In order, the host runs:

```sh
command -v -- <agent executable>                                      # agent only
git -C <repository> worktree add -b <branch> -- <path> <base>        # worktree only
herdr --session <server> workspace create --no-focus --label <label> --cwd <directory>
herdr --session <server> agent start <name> --kind <kind> --pane <new root pane> --timeout 60000 [-- <prompt>]
```

The shown commands are POSIX `sh` syntax, and each one runs under `sh` with
exactly those arguments. The SSH exec channel passes its command string to your
login shell, so lazysh sends a fixed `sh -c '"$@" …' sh` wrapper followed by
each argument as its own single-quoted word, with `'` and `\` written as `"'"`
and `"\\"`. POSIX login shells (such as sh, dash, bash, zsh and ksh) and fish read every
such word literally, so quotes, `;`, `$(…)` and backticks in labels, paths,
branches or prompts, including directory names reported by the host, are never
run as shell syntax. Other login shells, such as csh, tcsh or nushell, are not
covered. Branch names follow `git check-ref-format --branch`
rules; labels, paths and prompts must be one line without backslashes, paths must
be absolute without `.` or `..` segments, and a base or prompt cannot start with
`-`. The agent starts only through Herdr's `agent start` in the new workspace's
root pane, which waits for Herdr to detect the agent as ready. No keystrokes are
sent to an existing pane. On success, lazysh opens the new workspace.

Host errors are shown verbatim, limited to 2,000 characters with terminal
control characters removed. When the agent check, the worktree step or (without
a worktree) the workspace step fails, nothing was created.
When a later step fails (for example the worktree was created but `herdr
workspace create` or the agent start failed), the dialog lists what already
exists and offers to open the workspace. Nothing is rolled back: remove an unwanted
worktree with `git worktree remove` and its branch with `git branch -d`.

`command -v` runs in the SSH command environment. An agent that is only on the
PATH of an interactive shell may be missing from the list, and `herdr agent
start` resolves the executable in the new pane's shell.

Attached tmux and Herdr terminals also offer prefix shortcuts and numbered window/tab controls. Configure one prefix key, such as `Ctrl+b` or `F12`; it is validated with the existing terminal chord parser. The panel uses the host's default action bindings. It only appears on a terminal known to be attached to that multiplexer, so a plain shell never receives prefix input from these controls. Custom host action remappings remain available through the terminal or configurable keyboard chords.

## Zellij

List running sessions or enter a name to create/attach one. Its shortcut panel creates named tabs in a project directory, selects numbered tabs, moves between tabs, splits the focused pane and toggles fullscreen. Commands target the selected named session; focused-pane actions follow that session's current focus. Zellij does not expose the tmux/Herdr Jump To tree here.

The Zellij panel includes a tab 1–20 quick-access row alongside the existing manual
tab-number form. These are explicit shortcuts, not a discovered tab list or a
current-tab indicator. Each button sends the existing typed `goToTab` action to
the original named session over its original access lease; it does not type a
prefix or decimal digits into a terminal. The host's error remains visible if a
tab is unavailable. Only one action runs at a time; language changes preserve
drafts and do not dispatch actions, and retired owners cannot publish late results.
The manual 1–1000 native index bound is unchanged. This implements the documented
reference client numbered selector affordance (source URL omitted)
without inheriting its documented multi-digit chord timing dependency. It does
not establish current tabs, exact-client binding, automatic restoration, or physical
device/runtime acceptance. Hiding/persisting this row remains separate work.

The [public Zellij commands](https://zellij.dev/documentation/commands) were verified against **0.45.1**. Session names beginning with a dash are rejected: Zellij's attach CLI uses `--` for an initial command rather than to disambiguate that positional name.

## Launch an agent in a tmux window or a Zellij pane

`multiplexer_launch_plan` and `multiplexer_launch` (the commands behind the launcher of
[#1128](https://github.com/mihazs/lazysh/issues/1128)) generalise the Herdr creation plan above:
the same agent table, the same `command -v` check and the same literal argv, started in the
session a terminal is attached to. They take the connection's typed multiplexer entry (kind,
session name and, for tmux, the server label), never a command string, and refuse an entry
that asks to create the session. The renderer shows `multiplexer_launch_plan` first and runs
`multiplexer_launch` only after the user confirmed it.

```sh
command -v -- <agent>                                                    # missing agent: nothing is created
git -C <repository> worktree add -b <branch> -- <path> <base>            # worktree only
tmux -u -L <server> new-window -d -P -F '#{pane_id}' -t =<session>: -n <label> -c <directory> -- <agent> [<prompt>]
zellij --session=<session> run --cwd=<directory> --name=<label> -- <agent> [<prompt>]
```

The agent is the executable's own argv, `<agent> [<prompt>]`, so nothing is parsed by a shell:
tmux and Zellij both `exec` it directly. A prompt may hold quotes, `$(…)`, backticks, tabs and
line breaks and reaches the agent byte for byte. Only the codex and claude entries of the table take
an initial prompt; the prompt cannot start with `-`, contain a backslash or other control
characters, or exceed 2000 bytes. (Herdr's `agent start` still takes one line.) tmux parses an
argument that ends in `;` as a command separator and expands formats in window names and
directories, so those layers are escaped separately from the shell's (`\;`, `##`).
The new pane's ID (tmux `%<n>`, Zellij `terminal_<n>`) is read back from the command's output and
returned as `paneId`; a reply that is not exactly that ID is a failure, never trusted. tmux
creates the window with `-d`, so the attached client stays where it is; Zellij focuses the new pane.

A failure before the worktree exists is an error and creates nothing: a missing agent stops the
plan at the `command -v` step, and a session that does not exist fails at the window or pane
step. A later failure (the worktree was created and the window or pane was not) is returned with
what already exists, which is kept: nothing is removed automatically.

The agent runs in the multiplexer server's environment, not in the SSH command's: the
`command -v` check looks in the SSH login shell's `PATH`, while tmux or Zellij starts the
agent with the `PATH` the server itself was started with. An agent that only an interactive
shell's startup file puts on `PATH` can pass the check and still not start. Creating the
session, splitting an existing pane instead of opening a window, a Zellij tab, and rmux (which
needs [#1140](https://github.com/mihazs/lazysh/issues/1140), tracked in [#1679](https://github.com/mihazs/lazysh/issues/1679)) are not part of this primitive yet,
and no screen calls it yet.

## Tab strip

An attached tmux, Herdr or Zellij terminal shows its tabs in one native row above the terminal (`MultiplexerTabStrip`). One backend-agnostic model feeds it (`multiplexerTabs.ts`: title, active, needs attention, agent state, and the guarded command a chip runs), read by `useMultiplexerStrip`:

| Multiplexer | Reads | Leading chip | Chip tap runs |
| --- | --- | --- | --- |
| Herdr | `useHerdrNavigation` (`herdr_tree`, every 5 s while the terminal is shown) | The focused workspace; opens the list of workspaces, each with its agent state, and flags another workspace that needs attention | A fresh `herdr_tree`, then `herdr_action` `focusTab` / `focusWorkspace` only if the target still exists |
| Zellij | `zellij_tabs` (`zellij action list-tabs --json`, Zellij 0.45 or newer; every 5 s) | The session name | `zellij_action` `goToTab` with the 1-based position |
| tmux | The Jump To snapshot of the attached control stream (every 5 s) | The session name | `tmux_jump` with the snapshot's generation, so a stale list is refused |

A selection is never typed into the terminal, never focuses an input (the soft keyboard stays as it was) and never resizes the terminal beyond the strip's own row. Chips are buttons in a labelled group, not `role="tab"`: session tabs are the workspace's only tabs. **Preferences > Keyboard and gestures > Show tab strip** (device-local): **Auto** shows the strip on phones when the session has more than one tab (Herdr: more than one tab or workspace) and the key toolbar is shown; **Always** shows it whenever the terminal is attached, on any screen; **Never** removes it and stops the reads. A multiplexer that cannot list its tabs (an older Zellij, a tmux terminal without the control stream) shows no strip. Not in this version: close, a Zellij rename (the command layer has neither) and the Herdr panes level.

### New tab and rename

The strip also changes tabs, only through the multiplexer's existing typed commands and only where the command layer has them:

| Multiplexer | **+** (end of the row) runs | Long press, right click or the context-menu key runs |
| --- | --- | --- |
| Herdr | `herdr_action` `createTab` in the focused workspace, starting in the directory of that workspace's first reported pane (`.` when none is reported); the new tab is then focused | `renameTab` on a tab; `renameWorkspace` on a workspace of the leading chip's list |
| Zellij | `zellij_action` `newTab` (Zellij focuses the new tab itself) | Nothing: there is no typed `rename-tab` |
| tmux | `tmux_action` `createWindow` in the attached session, on the attached tmux server; the new window is then selected with `tmux_jump` | `renameWindow` |

Either drops a small prompt over the terminal (it takes no layout space): a name, and for a new tab a directory (`.` is the shell's own start directory, as in the Spaces and tmux panels). The prompt is the one thing in the strip that opens the soft keyboard, on purpose, because the user is typing a name. A Herdr workspace or tab that has gone since the strip last read is refused, as a focus is, never renamed by guess. A failed command is reported and keeps the prompt open. A half-typed name ends only with Escape, Cancel or Save, so a stray tap on the terminal does not lose it. The long press is 0.5 s without moving more than 10 px; the tap that ends it does not also select the chip.


## Native checks

With tmux, Herdr and Zellij installed on PATH:

```sh
bun run test:multiplexers
```

The `native-linux-runtimes` CI job runs this with Ubuntu's tmux, the same-run stock Herdr build and the checksum-verified official Zellij 0.45.1 release. The Zellij case waits for the attached client's first render before it probes `list-sessions`: Zellij 0.45.1's server panics when a probe disconnects before its first client has created the session, and each later action is observed until its tab or pane state appears, because Zellij applies CLI actions asynchronously.

The display-owned Jump To checks additionally need local OpenSSH `sshd` and tmux:

```sh
bunx moon run client-native:test-tmux
```

`LAZYSH_TEST_TMUX` optionally selects a tmux binary. These native Cargo fixtures
create only owned loopback SSH listeners, keys and temporary tmux sockets. They
cover display/server replacement and ID reuse, hostile labels, startup bytes,
queued lease revocation, partial-response cancellation, malformed/oversized
framing and a notification stream that cannot refresh the absolute deadline.

The Herdr creation case (`herdr_create::tests::real_herdr_worktree_workspace_and_agent`)
also needs `git`. It creates a temporary repository, runs each step through the same
`sh -c` command strings the SSH channel uses, and checks that `git worktree list`
shows the new worktree, the Herdr snapshot shows a workspace labelled with the branch
whose pane directory is the worktree, and a stub `codex` on `PATH` started in that
pane with the literal prompt. Hostile but valid branch names and prompts containing
`$(…)` and quotes stay literal; a duplicate branch or a missing agent creates
nothing. The real SSH channel itself is covered by the existing OpenSSH fixtures, not
by this case. `herdr_create::tests::login_shells_read_each_argv_word_literally` and
the agent detection test run the generated command strings as `<shell> -c` under
`/bin/sh` and every installed bash, zsh and fish, with values containing `'`, `\`,
`;`, `$(…)` and backticks, and assert the argv arrives literally and nothing is
created. Fish is skipped with a message when absent; CI installs it in
`native-linux-runtimes` and sets `LAZYSH_REQUIRE_FISH=1` so it cannot be skipped there.

The launch cases (`herdr_create::tests::real_tmux_agent_window` and `real_zellij_agent_pane`)
run the confirmed plans through the same `sh -c` command strings against a private tmux server
and a private background Zellij session, with a stub `codex` on the server's `PATH` that records
its directory and argv. They launch into a directory whose name holds `'`, `$(…)`, `#{…}` and a
trailing `;` and into a new worktree with a hostile branch name, and assert that the pane exists
in the directory (or worktree) `list-panes` reports, that the stub's argv is the prompt
byte for byte (quotes, `$(…)`, a line break and a trailing `;`), that `git worktree list`
shows the worktree, and that a missing agent or a missing session creates no pane, worktree or
branch. Zellij runs against the pinned 0.45.1; the same case also passed on 0.46.0. An rmux case
waits for rmux support (#1679, after #1140). The plan builders have platform-neutral unit tests that also
run on macOS and Windows.

These Cargo tests create isolated temporary tmux sockets, Herdr configuration/server state and Zellij runtime/cache directories. They exercise actual lifecycle commands, tree parsing, hostile literal labels, pane splitting, focus and zoom. They never target a pre-existing user multiplexer. Vitest checks session/pane identity and action/error behavior through the actual React panels.

The client workspace handles saved tmux/Herdr attachment intents separately from these controls. Zellij restoration remains manual, matching the documented initial-attach boundary. Native device lifecycle, network-loss/reconnect and durable-process survival still require device acceptance under issue #7. Trees currently refresh explicitly.


### Owned SSH Herdr acceptance

On a Unix host with local OpenSSH `sshd` and an absolute path to a supported Herdr (0.9.3 to 0.9.5):

```sh
LAZYSH_TEST_HERDR=/absolute/path/to/herdr cargo test \
  --manifest-path apps/client/src-tauri/Cargo.toml --locked --lib \
  ssh::tmux_jump_fixture::real_herdr_ssh_child_pty_preserves_source_and_durable_session \
  -- --ignored --exact --nocapture
```

The fixture checks the actual binary version with a bounded owned subprocess.
The retained Linux run used Herdr 0.9.3, SHA256
`18a8dc65f1c2fa485884344356dea1cfd911c6f06cf46fa78e193f4087f4dba7`.
It creates private home/config/state/runtime directories, two owned named Herdr
servers and an owned loopback OpenSSH listener/key. No existing session is used.
Named headless servers initially have no panes; the fixture creates its own
workspace/workload explicitly before testing selection. The stopped default
registry row is excluded by the normal running-session discovery path.

The Rust host/Herdr intent selects the non-first observed running row explicitly.
Its exact workspace marker appears in the native SSH child TUI, while independent
source foreground markers continue to round-trip. Closing the adopted child
preserves that pane's advancing workload. A second, unadopted child finishes when
its original lease is revoked; the adopted source retains its existing lock
policy. Already-buffered pre-lock output is allowed, the generic Closed notice
waits for normal unlock, and the pending retirement record then drains. A stale
attach produces no callback, and the spent launch receipt cannot replay. Teardown
checks both server exits, the stopped workload and the closed owned SSH listener.

The fixture manually constructs the native source session over its freshly
verified owned SSH transport. It establishes the native Herdr child/durability
path, not OS CLI delivery, actual GUI startup or physical biometric prompts.
Those and mobile/device lifecycle acceptance remain separate. This ignored
external-tool fixture executes when explicitly requested; ordinary native test
runs compile it without executing it.

### Fresh verified SSH restoration acceptance

The owned Cargo fixture
`ssh::tmux_jump_fixture::real_tmux_jump_fresh_ssh_restores_same_durable_named_pane`
is included in `bunx moon run client-native:test-tmux`. It uses an isolated OpenSSH
listener, ephemeral keys, private `TMUX_TMPDIR`, and two named servers with
colliding session/window/pane IDs. It closes the original SSH transport, waits
for native sessions and retained connection handles to retire, then uses a fresh
`AppState` and host-key-verified authentication to reattach the saved literal
server/session name. Native display output must contain the selected server's random token and actual
pane-process PID, and exclude the other server's distinct token/PID. Unchanged
server/pane/process identity establishes that the same workload survives and
resumes; the second
server's identity remains unchanged. Both native lifetimes and owned servers are
cleaned up.

This is transport retirement and fresh authentication within one Rust test
process. It does not establish application-process death, GUI startup, OS-vault
prompts, physical mobile lifecycle, or network roaming behavior.

For #248 teardown diagnosis, Linux takes a bounded client snapshot while each
SSH lifetime is still active, using the same existing observer and its limits.
Only a unique verified control-client identity is retained; the fresh snapshot
excludes the identified initial client. Failed or ambiguous samples remain
unknown. The existing failure-only receipt appends `lifetime=Some(0)` for the
initial control client, `Some(1)` for fresh, or `None` for unknown. PID/start
identities stay internal; reused or missing processes are not attributed.
The snapshots add two observations, not an exit assertion, retry or cleanup
action, and leave the existing three-second retirement/teardown budgets intact.
This identifies which observed control lifetime remains when possible; it does
not establish remote command exit, pending-buffer sizes or the failure cause.

### Application restart restoration acceptance

The Linux native GUI case `native-e2e/restore.spec.ts` runs the bundled app against an owned OpenSSH server whose tmux uses a private `TMUX_TMPDIR` inside the server's PID namespace. It saves the key in a disposable Secret Service, enters a saved tmux default and records the pane's `TMUX_PANE` and shell PID. After WebKit has written the workspace descriptor to the private on-disk profile, the test sends `SIGKILL` to the app and starts it again on the same profile. The relaunched app only offers **Restore previous workspace**: no terminal opens and no tmux client attaches until the click. Restoring uses the saved credentials and reattaches the same named session; the display must show the output written before the kill, and the same pane ID and shell PID. The credential item is unchanged.

This case covers process death and GUI relaunch on Linux. It does not cover Herdr, Android process death, OS-vault prompts or network changes. The mocked Playwright case `e2e/workspace-relaunch.spec.ts` checks the restore order for tmux, Herdr, Zellij and plain-shell descriptors in both projects.
