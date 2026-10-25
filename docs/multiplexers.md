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

This is the bounded Zellij tab/pane part of Moshi's documented
[hierarchy-aware gestures](https://getmoshi.app/docs/gestures). Tmux and Herdr
navigation, workspace/session-level gestures and pane-zoom pinch bindings remain
separate work. Current Zellij exposes `switch-session`, but lazysh does not yet
use it or reconcile remembered attachment names after a host-side session switch.

Open **Sessions** on an SSH connection. lazysh discovers tmux, Herdr and Zellij independently. Attaching opens a separate PTY on the verified SSH transport, preserving the original shell. Closing an attached terminal detaches that client; the remote multiplexer owns its processes.

## tmux

The workspace tree lists real session, window and pane IDs, current commands, directories and active state. Create/rename sessions and windows, choose a project directory, select windows/panes, split panes and toggle zoom. Refresh reads current host state. Actions use exact IDs instead of injecting prefix sequences into a foreground agent.

Choose a list, accordion or grid layout; the client remembers it. Load recent projects from the host companion's real agent history, ordered by most recent event, then select a directory in the launcher. The companion remains optional: you can always enter a directory manually.

Shell quoting alone does not protect tmux arguments: tmux parses trailing semicolons and expands format strings. lazysh separately escapes those layers to preserve literal names and directories. Control characters in names/paths are rejected because the discovery protocol is tab/line delimited. A response exceeding 1 MiB or 4096 panes fails explicitly.

### In-session Jump To

A tmux terminal attached through lazysh offers **Jump To** with its session/window
tree and an exact **Current** marker. Choosing Current closes the panel without
sending a command. List, accordion and grid share the existing saved layout
preference. A successful switch remembers the destination's human session name;
numeric IDs and navigation generations are never saved for reconnect.

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
remote close acknowledgement. Idle control clients can survive a resume lock;
queued requests retain their original access lease and are discarded after
revocation. Interruption during command I/O, unexpected framing, timeout, or
server loss permanently retires that binding. Reattach to obtain a fresh binding.

The queue holds at most four requests. Bootstrap/control operations have absolute
three-second deadlines; each response/notification allowance is at most 1 MiB,
each line 64 KiB, and each command at most 4096 rows. Labels are delimiter-quoted,
with control characters displayed as `?`; labels never become commands. Older
tmux behavior is accepted only when binding and protocol validation succeed.
Local native acceptance uses tmux 3.8; the Linux CI task also exercises its actual
distro tmux. tmux 3.4/3.5a guard compatibility was source-checked, and runtime CI
results must be recorded separately. Complete kernel PID+TTY reuse and a malicious
same-UID server are outside this identity proof. Physical device lifecycle and
Herdr navigation remain separate acceptance work under issue #7.

## Herdr

List running named servers, then attach or browse one. The Herdr tree preserves server/workspace/tab/pane identity and displays reported agent states. Create and rename workspaces/tabs, focus workspaces/tabs, split and zoom exact panes, and focus reported agents. Plain panes can be selected through the terminal; Herdr's `agent focus` command only accepts agent panes.

The integration uses the [public Herdr CLI/socket snapshot contract](https://herdr.dev/docs/socket-api/), verified against Herdr **0.9.5**, protocol 22. Older or incompatible responses fail explicitly. lazysh does not install Herdr, alter its configuration, or stop existing servers.

Attached tmux and Herdr terminals also offer prefix shortcuts and numbered window/tab controls. Configure one prefix key, such as `Ctrl+b` or `F12`; it is validated with the existing terminal chord parser. The panel uses the host's default action bindings. It only appears on a terminal known to be attached to that multiplexer, so a plain shell never receives prefix input from these controls. Custom host action remappings remain available through the terminal or configurable keyboard chords.

## Zellij

List running sessions or enter a name to create/attach one. Its shortcut panel creates named tabs in a project directory, selects numbered tabs, moves between tabs, splits the focused pane and toggles fullscreen. Commands target the selected named session; focused-pane actions follow that session's current focus. Zellij does not expose the tmux/Herdr Jump To tree here.

The [public Zellij commands](https://zellij.dev/documentation/commands) were verified against **0.45.1**. Session names beginning with a dash are rejected: Zellij's attach CLI uses `--` for an initial command rather than to disambiguate that positional name.

## Native checks

With tmux, Herdr and Zellij installed on PATH:

```sh
cargo test --locked -p lazysh '::tests::real_' -- --ignored
```

The display-owned Jump To checks additionally need local OpenSSH `sshd` and tmux:

```sh
bunx turbo run test:tmux --filter=@lazysh/client
```

`LAZYSH_TEST_TMUX` optionally selects a tmux binary. These native Cargo fixtures
create only owned loopback SSH listeners, keys and temporary tmux sockets. They
cover display/server replacement and ID reuse, hostile labels, startup bytes,
queued lease revocation, partial-response cancellation, malformed/oversized
framing and a notification stream that cannot refresh the absolute deadline.

These Cargo tests create isolated temporary tmux sockets, Herdr configuration/server state and Zellij runtime/cache directories. They exercise actual lifecycle commands, tree parsing, hostile literal labels, pane splitting, focus and zoom. They never target a pre-existing user multiplexer. Vitest checks session/pane identity and action/error behavior through the actual React panels.

The client workspace handles saved tmux/Herdr attachment intents separately from these controls. Zellij restoration remains manual, matching the documented initial-attach boundary. Native device lifecycle, network-loss/reconnect and durable-process survival still require device acceptance under issue #7. Trees currently refresh explicitly.
