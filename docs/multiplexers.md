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

Select **tmux server** on an ordinary SSH connection and choose **Browse server**. `default` selects tmux's standard server; other names select the public `tmux -L NAME` socket-name interface. The selector is fixed on an attached terminal: its tree/actions and Jump To remain on the native attachment's server. Open another attachment from a plain SSH connection to choose another server. Names are literal 1–64 UTF-8-byte basenames: Unicode, spaces, apostrophes and shell-looking text are accepted; `/`, control characters, `.` and `..` are rejected. Socket paths (`-S`) are not accepted. Filesystem/socket-length failures remain explicit host diagnostics.

All tmux client invocations also select UTF-8 (`-u`), preserving literal metadata and tab-delimited discovery even when the remote login environment has no UTF-8 locale.

**Changed default:** every command explicitly uses `-L default` or its selected named server. Previously, bare tmux commands could inherit a different socket from the remote `TMUX` environment variable. Legacy workspaces without server metadata now consistently select the standard default server. Saved attachment intentions preserve the server plus exact human session name; Jump To changes the destination without dropping server identity. Native session context rejects conflicting action/tree requests, and the retained control channel never reconnects to a restarted server with reused IDs.

This follows documented [tmux named-server semantics](https://man.openbsd.org/tmux.1) and [upstream 3.4 socket-label construction](https://github.com/tmux/tmux/blob/3.4/tmux.c#L175-L219). Moshi help exposed `tmux:<server>`, but the exact private gateway meaning was not recovered. This is independent implementation from the public interface. Agent pane IDs alone do not establish server identity: transcript/approval identity remains explicit, and no pane-only routing is added. Notifications open their recorded existing native connection ID, never a first session-name match. Companion snapshots are host-wide: that connection is not proof of a matching agent pane/server, and this slice does not infer one. Desktop theme deep links do not attach multiplexers. Cold or warm saved-host CLI composition opens the exact requested tmux/Herdr picker through normal SSH authentication; see [launch usage](connections.md#multiplexer-picker-launches). Warm directory and actual OS GUI acceptance remain tracked in issue #86.

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

The integration uses the [public Herdr CLI/socket snapshot contract](https://herdr.dev/docs/socket-api/) and validates its response shape and exact IDs. The native acceptance below was executed against pinned Herdr **0.9.3**; it does not establish other versions. Incompatible response shapes fail explicitly. lazysh does not install Herdr, alter its configuration, or stop existing servers.

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


### Owned SSH Herdr acceptance

On a Unix host with local OpenSSH `sshd` and an absolute path to Herdr 0.9.3:

```sh
LAZYSH_TEST_HERDR=/absolute/path/to/herdr-0.9.3 cargo test \
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
is included in `bun run --cwd apps/client test:tmux`. It uses an isolated OpenSSH
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
